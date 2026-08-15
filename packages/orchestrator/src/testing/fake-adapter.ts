import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentInput,
  AgentSession,
  ApprovalDecision,
  ForkOpts,
  HealthStatus,
  ModelChoice,
  SessionOpts,
  UserInputResponse,
} from '@chorus/agent-protocol'
import type { AgentId, ApprovalId, UserInputId } from '@chorus/shared'

/**
 * An in-memory `AgentAdapter` that emits a scripted event sequence.
 *
 * This is what lets the domain be tested in milliseconds with no provider, no
 * network, and no Electron (plan §3.2). It is also the harness the shared
 * adapter conformance suite will run against in M2/M3 — if the real adapters
 * cannot pass the same tests this one does, they are not interchangeable.
 */

export interface FakeAdapterOptions {
  readonly id?: AgentId
  readonly capabilities?: Partial<AgentCapabilities>
  readonly version?: string
  /**
   * What `supportedModels` does: answer with these, or fail.
   *
   * An `Error` rather than a boolean because the distinction being tested is
   * precisely "asked and it broke" against "asked and it offered nothing", and
   * a fake that can only do the second cannot cover the first. It could not,
   * which is how a `failed` state shipped that no production adapter reached.
   */
  readonly models?: readonly ModelChoice[] | Error
}

/**
 * A plain `Omit` over a discriminated union collapses to the keys every member
 * shares, which would drop `itemRef`, `turnRef` and the rest. Distributing over
 * the union keeps each variant's own fields.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type EmittableEvent = DistributiveOmit<AgentEvent, 'agentId' | 'seq' | 'at'>

const DEFAULT_CAPABILITIES: AgentCapabilities = {
  interrupt: true,
  steer: true,
  fork: true,
  reasoningStream: true,
  planStream: true,
  aggregateDiff: true,
  modelSwitchMidSession: true,
  sandboxPolicy: 'native',
}

export class FakeAgentSession implements AgentSession {
  readonly sent: AgentInput[] = []
  readonly decisions: { id: ApprovalId; decision: ApprovalDecision }[] = []
  /** Mirrors the real requirement: we must know if *we* asked to stop (S3b). */
  interruptRequested = false
  closed = false

  private readonly queue: AgentEvent[] = []
  private waiter: (() => void) | null = null
  private ended = false
  private seq = 0

  constructor(
    readonly sessionRef: string,
    private readonly agentId: AgentId,
    private readonly models?: readonly ModelChoice[] | Error | undefined
  ) {}

  send(input: AgentInput): Promise<void> {
    this.sent.push(input)
    return Promise.resolve()
  }

  interrupt(): Promise<void> {
    this.interruptRequested = true
    return Promise.resolve()
  }

  respondToApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void> {
    this.decisions.push({ id, decision })
    return Promise.resolve()
  }

  /** Recorded rather than acted on, so a test can assert what the agent was told. */
  readonly userInputResponses: { id: UserInputId; response: UserInputResponse }[] = []

  respondToUserInput(id: UserInputId, response: UserInputResponse): Promise<void> {
    this.userInputResponses.push({ id, response })
    return Promise.resolve()
  }

  /**
   * Recorded rather than acted on, so a test can assert an effort was applied.
   *
   * Present at all because the real question is whether it was applied to the
   * right agent: the preference has only ever come from Claude's list, and
   * Codex's levels differ per model.
   */
  readonly efforts: string[] = []

  setEffort(level: string): Promise<void> {
    this.efforts.push(level)
    return Promise.resolve()
  }

  /** Recorded rather than acted on, so a test can assert the handover happened. */
  readonly permissionModes: string[] = []

  setPermissionMode(mode: string): Promise<void> {
    this.permissionModes.push(mode)
    return Promise.resolve()
  }

  /** Answers with what the adapter was configured to hold, or fails. */
  supportedModels(): Promise<readonly ModelChoice[]> {
    if (this.models instanceof Error) return Promise.reject(this.models)
    return Promise.resolve(this.models ?? [])
  }

  close(): Promise<void> {
    this.closed = true
    this.end()
    return Promise.resolve()
  }

  /** Push an event as the provider would. `seq` and `at` are filled in for you. */
  emit(event: EmittableEvent): void {
    this.queue.push({
      ...event,
      agentId: this.agentId,
      seq: ++this.seq,
      at: this.seq,
    })
    this.waiter?.()
    this.waiter = null
  }

  /** Ends the event stream, as a closed session or a dead process would. */
  end(): void {
    this.ended = true
    this.waiter?.()
    this.waiter = null
  }

  get events(): AsyncIterable<AgentEvent> {
    return { [Symbol.asyncIterator]: () => this.iterate() }
  }

  private async *iterate(): AsyncGenerator<AgentEvent> {
    for (;;) {
      while (this.queue.length > 0) {
        const next = this.queue.shift()
        if (next !== undefined) yield next
      }
      if (this.ended) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

export class FakeAdapter implements AgentAdapter {
  readonly id: AgentId
  readonly capabilities: AgentCapabilities
  readonly sessions: FakeAgentSession[] = []
  private readonly version: string
  private readonly models: readonly ModelChoice[] | Error | undefined
  private counter = 0

  constructor(options: FakeAdapterOptions = {}) {
    this.id = options.id ?? 'claude'
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities }
    this.version = options.version ?? '0.0.0-fake'
    this.models = options.models
  }

  /**
   * Every `SessionOpts` this adapter was handed, in order.
   *
   * The model is the interesting field: three separate paths build one, and a
   * value from one provider's catalogue reaching another's is invisible until
   * something writes down what each was actually started with.
   */
  readonly startedOpts: SessionOpts[] = []

  start(opts: SessionOpts): Promise<AgentSession> {
    this.startedOpts.push(opts)
    const session = new FakeAgentSession(
      `fake-session-${String(++this.counter)}`,
      this.id,
      this.models
    )
    this.sessions.push(session)
    return Promise.resolve(session)
  }

  /**
   * Makes `resume` reject, so the fallback to a fresh start can be tested.
   *
   * A thread the provider has forgotten is a normal thing to find after a day
   * away, and the fallback is a *new* session — which means it should start
   * with what the settings sheet says new sessions start with. Nothing could
   * reach that path before this.
   */
  failResume = false

  /**
   * Makes `resume` succeed and *then* refuse, which is what really happens.
   *
   * `failResume` above models a rejection, and no provider does that: spawning
   * works, and the news that the thread is gone arrives on the event stream
   * afterwards. That difference is exactly why the fallback in `runtime.ts` sat
   * unreachable — every test of it used the rejecting shape.
   *
   * The message is the one Claude actually sends, so a reader of a failing test
   * can search for it.
   */
  refuseResumeOnStream = false

  resume(sessionRef: string, opts: SessionOpts): Promise<AgentSession> {
    if (this.failResume) return Promise.reject(new Error('no such thread'))
    this.startedOpts.push(opts)
    const session = new FakeAgentSession(sessionRef, this.id, this.models)
    this.sessions.push(session)
    if (this.refuseResumeOnStream) {
      queueMicrotask(() => {
        session.emit({
          type: 'error',
          message: `No conversation found with session ID: ${sessionRef}`,
          recoverable: false,
        })
      })
    }
    return Promise.resolve(session)
  }

  /**
   * A branch, and the ref proves it.
   *
   * `resume` deliberately returns a session on the *same* ref while this returns
   * a different one, so a test that expected an aside to be isolated and got a
   * rejoin fails on the ref rather than on something subtler three steps later.
   *
   * The double-declaration this method exists to prevent was real: the flag said
   * `fork: true` here, and in the Codex adapter, with no implementation behind
   * either.
   */
  /**
   * Makes `fork` return a session still carrying the parent's ref.
   *
   * The hazard `ForkOpts.persist` exists to prevent: Claude's query-based fork
   * reports the parent's id until the child announces itself, and a persistent
   * branch saved during that window resumes the parent under the child's name.
   * Nothing could reach that path before this.
   */
  forkKeepsParentRef = false

  fork(sessionRef: string, opts: ForkOpts): Promise<AgentSession> {
    if (sessionRef === '') return Promise.reject(new Error('Cannot fork a session with no id yet'))
    if (this.forkKeepsParentRef) {
      const stale = new FakeAgentSession(sessionRef, this.id, this.models)
      this.sessions.push(stale)
      return Promise.resolve(stale)
    }
    const session = new FakeAgentSession(
      `${sessionRef}-fork-${String(++this.counter)}`,
      this.id,
      this.models
    )
    this.forked.push({
      from: sessionRef,
      inherits: opts.inherits,
      persist: opts.persist === true,
      session,
    })
    this.sessions.push(session)
    return Promise.resolve(session)
  }

  /** Every fork taken, so a test can assert what was branched and how. */
  readonly forked: {
    from: string
    inherits: ForkOpts['inherits']
    persist: boolean
    session: FakeAgentSession
  }[] = []

  health(): Promise<HealthStatus> {
    return Promise.resolve({ state: 'ready', version: this.version })
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }
}
