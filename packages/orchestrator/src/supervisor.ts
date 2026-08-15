import type {
  AccountSummary,
  ModelChoice,
  McpServerHealth,
  SlashCommandInfo,
  ProviderPermissionMode,
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentSession,
  ApprovalDecision,
  ForkOpts,
  SessionOpts,
  UserInputResponse,
} from '@chorus/agent-protocol'
import { AsyncQueue, type ApprovalId, type UserInputId } from '@chorus/shared'
import { realScheduler, type Scheduler } from './delta-buffer.js'

/**
 * Keeps an agent session alive across process death.
 *
 * It implements `AgentSession` itself, so `ConversationService` and everything
 * above it never learn that restarts happen — the event stream simply continues.
 * S3a proved the underlying capability: after a SIGKILL, `thread/resume` brings
 * the thread back with context intact. What it cannot bring back is partial
 * assistant output, which is why the event log records deltas as they arrive.
 *
 * A crash is inferred from the underlying event stream ending when we did not
 * ask it to. Providers do not announce their own death.
 */

export interface SupervisorPolicy {
  /** Restarts allowed inside `windowMs` before we stop trying. */
  readonly maxRestarts: number
  readonly windowMs: number
  readonly baseBackoffMs: number
  readonly maxBackoffMs: number
  /**
   * How long a resume waits to hear that it failed.
   *
   * A provider thread that is gone says so promptly and unprompted — Claude
   * answers `No conversation found with session ID …` within a moment of being
   * asked to rejoin. A thread that is *fine* says nothing at all until someone
   * prompts it. So there is no event that means "resumed successfully", and this
   * window cannot be a wait for one; it is a wait for the failure, after which
   * silence is taken as success.
   *
   * 2s is generous against a local process answering in tens of milliseconds,
   * and it is only ever spent on startup for conversations being rejoined.
   */
  readonly resumeVerdictMs: number
}

export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = {
  maxRestarts: 5,
  windowMs: 60_000,
  baseBackoffMs: 500,
  maxBackoffMs: 15_000,
  resumeVerdictMs: 2_000,
}

export interface SupervisedSessionDeps {
  readonly scheduler?: Scheduler
  readonly random?: () => number
}

export interface SupervisorStats {
  readonly restarts: number
  readonly givenUp: boolean
}

export class SupervisedSession implements AgentSession {
  private readonly queue = new AsyncQueue<AgentEvent>()
  private readonly policy: SupervisorPolicy
  private readonly scheduler: Scheduler
  private readonly random: () => number
  private readonly restartTimes: number[] = []

  private current: AgentSession
  /** The model the user picked, so a restart does not quietly undo it. */
  private chosenModel: string | undefined
  /** Likewise the effort level — same hazard, same fix. */
  private chosenEffort: string | undefined
  /** And the handover of edit decisions, which a restart would quietly revoke. */
  private chosenPermissionMode: ProviderPermissionMode | undefined
  private closing = false
  private givenUp = false
  /** Set when the adapter reported a failure it says retrying cannot fix. */
  private fatal: string | null = null
  private seq = 0
  private pump: Promise<void>

  private constructor(
    private readonly adapter: AgentAdapter,
    private readonly opts: SessionOpts,
    first: AgentSession,
    policy: SupervisorPolicy,
    deps: SupervisedSessionDeps
  ) {
    this.current = first
    this.policy = policy
    this.scheduler = deps.scheduler ?? realScheduler
    this.random = deps.random ?? Math.random
    this.pump = this.consume(first)
  }

  static async start(
    adapter: AgentAdapter,
    opts: SessionOpts,
    policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY,
    deps: SupervisedSessionDeps = {}
  ): Promise<SupervisedSession> {
    const first = await adapter.start(opts)
    return new SupervisedSession(adapter, opts, first, policy, deps)
  }

  /**
   * Rejoins a provider thread from a previous run of the app.
   *
   * The same call the supervisor makes after a crash — the difference is only
   * how long the gap was. S3a proved the capability: after a SIGKILL,
   * `thread/resume` brings the thread back with its context intact.
   */
  static async resume(
    adapter: AgentAdapter,
    sessionRef: string,
    opts: SessionOpts,
    policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY,
    deps: SupervisedSessionDeps = {}
  ): Promise<SupervisedSession> {
    const first = await adapter.resume(sessionRef, opts)
    /*
     * Rejecting here is what makes a dead thread recoverable.
     *
     * `adapter.resume` returns as soon as the process is spawned; whether the
     * provider actually *found* the thread arrives later, on the event stream.
     * So this resolved happily for a session whose transcript had been deleted,
     * the caller recorded a successful resume, and the failure turned up
     * afterwards as an error in the transcript. `runtime.ts` has always carried
     * a `catch` around this call that falls back to a fresh session — it simply
     * never ran, because nothing ever threw.
     *
     * `verdictOf` gives the failure a bounded moment to arrive and turns it into
     * a rejection, which is the shape that `catch` was written for.
     */
    const verdict = await verdictOf(first, policy.resumeVerdictMs, deps)
    if (verdict.failed !== null) {
      /* Close what was spawned before rejecting. The caller is about to start a
         fresh session, and a refused resume still left a live process behind. */
      await first.close()
      throw new Error(verdict.failed)
    }
    return new SupervisedSession(adapter, opts, verdict.session, policy, deps)
  }

  /**
   * A branch, supervised like any other session.
   *
   * `AgentAdapter.fork` returns a raw session, which is right for an aside — it
   * is thrown away with its question, and a crash mid-answer costs nothing worth
   * restarting. A persistent fork becomes a conversation someone works in, so
   * losing it to a provider crash is the same failure as losing a room.
   *
   * The restart path resumes `sessionRef`, which is why `ForkOpts.persist`
   * requires the returned session to already carry the *child's* id: a fork
   * still reporting its parent's would, on the first crash, quietly restart the
   * user into the conversation they branched away from.
   */
  static async fork(
    adapter: AgentAdapter,
    sessionRef: string,
    opts: ForkOpts,
    policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY,
    deps: SupervisedSessionDeps = {}
  ): Promise<SupervisedSession> {
    if (adapter.fork === undefined) throw new Error(`${adapter.id} cannot be forked`)
    const first = await adapter.fork(sessionRef, opts)
    if (first.sessionRef === sessionRef) {
      throw new Error('A persistent fork must report its own id, not its parent’s')
    }
    return new SupervisedSession(adapter, opts, first, policy, deps)
  }

  /** Stable across restarts — `resume` reattaches to the same provider thread. */
  get sessionRef(): string {
    return this.current.sessionRef
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.queue
  }

  stats(): SupervisorStats {
    return { restarts: this.restartTimes.length, givenUp: this.givenUp }
  }

  send(input: AgentInput): Promise<void> {
    return this.current.send(input)
  }

  interrupt(): Promise<void> {
    return this.current.interrupt()
  }

  respondToApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void> {
    return this.current.respondToApproval(id, decision)
  }

  respondToUserInput(id: UserInputId, response: UserInputResponse): Promise<void> {
    return this.current.respondToUserInput(id, response)
  }

  supportedModels(): Promise<readonly ModelChoice[]> {
    return this.current.supportedModels?.() ?? Promise.resolve([])
  }

  supportedCommands(): Promise<readonly SlashCommandInfo[]> {
    return this.current.supportedCommands?.() ?? Promise.resolve([])
  }

  mcpServerStatus(): Promise<readonly McpServerHealth[]> {
    return this.current.mcpServerStatus?.() ?? Promise.resolve([])
  }

  accountInfo(): Promise<AccountSummary | null> {
    return this.current.accountInfo?.() ?? Promise.resolve(null)
  }

  stopTask(taskId: string): Promise<void> {
    return this.current.stopTask?.(taskId) ?? Promise.resolve()
  }

  /**
   * Remembered, not merely forwarded.
   *
   * A supervised session can be replaced under the caller after a crash, and a
   * model chosen before that would silently revert — the user would see their
   * choice still selected while the agent answered as something else. Held here
   * and re-applied to whatever session comes back.
   */
  async setModel(model: string): Promise<void> {
    this.chosenModel = model
    await this.current.setModel?.(model)
  }

  /** Remembered for the same reason the model is: a restart would undo it. */
  async setEffort(level: string): Promise<void> {
    this.chosenEffort = level
    await this.current.setEffort?.(level)
  }

  /**
   * Remembered, and for a sharper reason than the other two.
   *
   * A crash would put the replacement back on `default`, so a user who said
   * "always" to edits an hour ago would start being asked again with no event
   * to explain it. Silently *widening* on a restart would be the dangerous
   * direction; this is the safe one, and still wrong.
   */
  async setPermissionMode(mode: ProviderPermissionMode): Promise<void> {
    this.chosenPermissionMode = mode
    await this.current.setPermissionMode?.(mode)
  }

  async close(): Promise<void> {
    // Set first: this is what distinguishes a clean shutdown from a crash.
    this.closing = true
    await this.current.close()
    await this.pump
    this.queue.close()
  }

  /**
   * Drains one underlying session. Returning means that session's stream ended;
   * whether that was a crash depends on `closing`.
   */
  private async consume(session: AgentSession): Promise<void> {
    for await (const event of session.events) {
      /*
       * An adapter that reports `recoverable: false` is telling us retrying
       * cannot help — a missing working directory, a binary that will not
       * launch. Restarting anyway produced six identical failures in a row and
       * buried the real message in the transcript.
       */
      if (event.type === 'error' && !event.recoverable) this.fatal = event.message
      this.queue.push({ ...event, seq: ++this.seq })
    }
    if (this.closing || this.givenUp) return

    if (this.fatal !== null) {
      this.givenUp = true
      this.queue.close()
      return
    }
    await this.handleCrash()
  }

  private async handleCrash(): Promise<void> {
    const now = this.scheduler.now()
    this.forgetRestartsOlderThan(now - this.policy.windowMs)

    if (this.restartTimes.length >= this.policy.maxRestarts) {
      this.givenUp = true
      this.emitError(
        `agent ${this.adapter.id} crashed ${String(this.restartTimes.length + 1)} times in ` +
          `${String(Math.round(this.policy.windowMs / 1000))}s; giving up`,
        false
      )
      this.queue.close()
      return
    }

    const attempt = this.restartTimes.length
    this.restartTimes.push(now)
    this.emitError(`agent ${this.adapter.id} exited unexpectedly; restarting`, true)

    await this.backoff(attempt)
    if (this.closing) {
      this.queue.close()
      return
    }

    try {
      const resumed = await this.adapter.resume(this.sessionRef, this.opts)
      this.current = resumed
      // The replacement starts on the provider's default, so a choice made
      // before the crash has to be made again on its behalf.
      if (this.chosenModel !== undefined) await resumed.setModel?.(this.chosenModel)
      if (this.chosenEffort !== undefined) await resumed.setEffort?.(this.chosenEffort)
      if (this.chosenPermissionMode !== undefined) {
        await resumed.setPermissionMode?.(this.chosenPermissionMode)
      }
      this.pump = this.consume(resumed)
    } catch (error) {
      // A failed resume is not recoverable by trying harder — the thread may be
      // gone. Surface it rather than looping.
      this.givenUp = true
      this.emitError(
        `could not resume ${this.adapter.id}: ${error instanceof Error ? error.message : String(error)}`,
        false
      )
      this.queue.close()
    }
  }

  private backoff(attempt: number): Promise<void> {
    const ceiling = Math.min(this.policy.baseBackoffMs * 2 ** attempt, this.policy.maxBackoffMs)
    // Full jitter, same reasoning as the RPC client: a fixed delay makes every
    // supervised session retry in lockstep after a machine-wide hiccup.
    const delay = Math.floor(this.random() * ceiling)
    return new Promise((resolve) => {
      this.scheduler.setTimeout(resolve, delay)
    })
  }

  private forgetRestartsOlderThan(cutoff: number): void {
    while (this.restartTimes.length > 0 && (this.restartTimes[0] ?? 0) < cutoff) {
      this.restartTimes.shift()
    }
  }

  private emitError(message: string, recoverable: boolean): void {
    this.queue.push({
      agentId: this.adapter.id,
      seq: ++this.seq,
      at: this.scheduler.now(),
      type: 'error',
      message,
      recoverable,
    })
  }
}

/**
 * Waits briefly for a resumed session to say it failed.
 *
 * Peeking at an `AsyncIterable` consumes from it, so anything read here would be
 * lost to the consumer that follows — the events the provider sent while we were
 * deciding. The session handed back therefore replays whatever was buffered
 * before delegating to the original iterator, and the caller cannot tell the
 * difference.
 *
 * Only a non-recoverable error counts. That is the same test the supervisor's
 * own loop applies, and `mapping.ts` marks everything except `error_max_turns`
 * as non-recoverable — so a missing thread qualifies and a turn that merely ran
 * out of turns does not.
 */
async function verdictOf(
  session: AgentSession,
  windowMs: number,
  deps: SupervisedSessionDeps
): Promise<{ failed: string | null; session: AgentSession }> {
  const scheduler = deps.scheduler ?? realScheduler
  const iterator = session.events[Symbol.asyncIterator]()
  const buffered: AgentEvent[] = []

  let timer: unknown
  const expired = new Promise<'expired'>((resolve) => {
    timer = scheduler.setTimeout(() => {
      resolve('expired')
    }, windowMs)
  })

  let failed: string | null = null
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), expired])
      if (next === 'expired') break
      if (next.done === true) break
      buffered.push(next.value)
      if (next.value.type === 'error' && !next.value.recoverable) {
        failed = next.value.message
        break
      }
    }
  } finally {
    scheduler.clearTimeout(timer)
  }

  return { failed, session: replaying(session, buffered, iterator) }
}

/**
 * The same session, with the peeked events put back at the front.
 *
 * A proxy rather than `{ ...session, events }`. Every adapter's session is a
 * class instance, and a spread copies only *own* properties — so the object that
 * produced would carry the fields and none of the methods, and the first
 * `send()` after a resume would fail on a session that looked fine. Written as a
 * spread first; the runtime's own fallback test is what caught it.
 *
 * Methods are bound to the original so `this` still refers to the real session
 * rather than to the proxy.
 */
function replaying(
  session: AgentSession,
  buffered: readonly AgentEvent[],
  iterator: AsyncIterator<AgentEvent>
): AgentSession {
  const events: AsyncIterable<AgentEvent> = {
    async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
      yield* buffered
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) return
        yield next.value
      }
    },
  }
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === 'events') return events
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value
    },
  })
}
