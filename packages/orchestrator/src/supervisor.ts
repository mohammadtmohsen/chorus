import type {
  ModelChoice,
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentSession,
  ApprovalDecision,
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
}

export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = {
  maxRestarts: 5,
  windowMs: 60_000,
  baseBackoffMs: 500,
  maxBackoffMs: 15_000,
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
