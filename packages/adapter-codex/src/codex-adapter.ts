import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentInput,
  AgentSession,
  ApprovalDecision,
  HealthStatus,
  SandboxPolicy,
  SessionOpts,
  UserInputResponse,
} from '@chorus/agent-protocol'
import type { AgentId, ApprovalId, UserInputId } from '@chorus/shared'
import {
  mapApprovalRequest,
  mapNotification,
  mapUserInputRequest,
  toCodexDecision,
  toCodexUserInputResponse,
  type ThreadItem,
} from './mapping.js'
import { JsonRpcClient } from './rpc.js'
import { createStdioTransport, type Transport } from './transport.js'

const run = promisify(execFile)

/**
 * `AgentAdapter` over `codex app-server`.
 *
 * All the protocol's sharp edges are absorbed here (plan §4.1). In particular
 * Codex has two similarly named sandbox types — `SandboxMode`, a kebab-case
 * string enum accepted by `thread/start`, and `SandboxPolicy`, a tagged object
 * accepted by `turn/start`. Neither escapes this file.
 */

export const CODEX_CAPABILITIES: AgentCapabilities = {
  interrupt: true,
  steer: true,
  fork: true,
  reasoningStream: true,
  planStream: true,
  // Codex emits an aggregate turn diff natively; for Claude we derive one.
  aggregateDiff: true,
  modelSwitchMidSession: true,
  sandboxPolicy: 'native',
}

/** Our policy → the string enum `thread/start` wants. Verified against the bindings. */
export function toSandboxMode(
  policy: SandboxPolicy
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  switch (policy.mode) {
    case 'readOnly':
      return 'read-only'
    case 'workspaceWrite':
      return 'workspace-write'
    case 'fullAccess':
      return 'danger-full-access'
  }
}

/** Enough to cover any in-flight turn without growing without bound. */
const MAX_REMEMBERED_ITEMS = 200

export interface CodexAdapterOptions {
  readonly command?: string
  /**
   * Finds the binary when it is not simply on PATH.
   *
   * Asked once, lazily. A packaged app inherits a minimal PATH from the Finder
   * and would otherwise fail with "spawn codex ENOENT" — which reads as "not
   * installed" for something the user can run in their terminal.
   */
  readonly resolveCommand?: () => Promise<string | null>
  readonly approvalTtlMs?: number
  readonly createTransport?: () => Transport
  readonly now?: () => number
}

export class CodexSession implements AgentSession {
  private readonly queue: AgentEvent[] = []
  private waiter: (() => void) | null = null
  private ended = false
  private seq = 0
  private currentTurnId: string | null = null
  /** Approval id → the resolver that answers the server's pending request. */
  private readonly openApprovals = new Map<string, (decision: string) => void>()
  /**
   * Question sets whose server request is still open. Separate from
   * `openApprovals` because what resolves them is a payload, not a verdict.
   */
  private readonly openUserInputs = new Map<string, (response: UserInputResponse) => void>()
  /**
   * Recently streamed items, so a `fileChange` approval — which carries only an
   * itemId — can be shown with the paths it will touch. Bounded, because a long
   * session would otherwise accumulate every item it ever saw.
   */
  private readonly recentItems = new Map<string, ThreadItem>()

  constructor(
    readonly sessionRef: string,
    private readonly rpc: JsonRpcClient,
    private readonly approvalTtlMs: number,
    private readonly now: () => number
  ) {
    this.rpc.onNotification((method, params) => {
      this.ingest(method, params)
    })
    this.rpc.setServerRequestHandler((method, params) => this.handleServerRequest(method, params))
    // A dead app-server must end this stream, or the supervisor never learns the
    // session died and silently stops working.
    this.rpc.onClose(() => {
      this.end()
    })
  }

  async send(input: AgentInput): Promise<void> {
    const result = (await this.rpc.request('turn/start', {
      threadId: this.sessionRef,
      // `text_elements` is required and snake_case in an otherwise camelCase
      // API — omitting it is rejected outright.
      input: [{ type: 'text', text: input.text, text_elements: [] }],
      /*
       * Ask for the reasoning summary, or none arrives.
       *
       * The mapping for `item/reasoning/*` has been here from the start and
       * never once fired: a turn measured end to end produced four
       * `agent.message.delta` and zero reasoning events, because the summary is
       * off unless a turn asks for it. The transcript's "Show thinking" block
       * was unreachable as a result.
       *
       * `auto` rather than `detailed`: a summary is what the UI shows and what
       * the reader wants, and it is the provider's own default shape. `detailed`
       * buys length rather than insight, and every token of it is billed.
       */
      summary: 'auto',
    })) as { turn?: { id?: string } }
    this.currentTurnId = result.turn?.id ?? null
  }

  async interrupt(): Promise<void> {
    if (this.currentTurnId === null) return
    // Needs both ids; threadId alone is rejected.
    await this.rpc.request('turn/interrupt', {
      threadId: this.sessionRef,
      turnId: this.currentTurnId,
    })
  }

  respondToApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void> {
    const resolve = this.openApprovals.get(id)
    if (resolve === undefined) return Promise.resolve()
    this.openApprovals.delete(id)
    const scope = decision.outcome === 'allow' ? decision.scope : 'once'
    resolve(toCodexDecision(decision.outcome, scope))
    return Promise.resolve()
  }

  respondToUserInput(id: UserInputId, response: UserInputResponse): Promise<void> {
    const resolve = this.openUserInputs.get(id)
    // Gone means it already auto-resolved or the turn ended. Answering a
    // question nobody is waiting for is a no-op, not an error.
    if (resolve === undefined) return Promise.resolve()
    this.openUserInputs.delete(id)
    resolve(response)
    return Promise.resolve()
  }

  get events(): AsyncIterable<AgentEvent> {
    return { [Symbol.asyncIterator]: () => this.iterate() }
  }

  close(): Promise<void> {
    // Settle open questions before the transport goes, so the server request is
    // answered rather than dropped on a closing socket.
    for (const [, resolve] of this.openUserInputs) resolve({ outcome: 'cancel' })
    this.openUserInputs.clear()
    this.rpc.close('session closed')
    this.end()
    return Promise.resolve()
  }

  private ingest(method: string, params: unknown): void {
    this.rememberItem(params)
    const event = mapNotification(
      { method, params },
      { seq: this.seq + 1, now: this.now(), approvalTtlMs: this.approvalTtlMs }
    )
    if (event === null) return
    if (event.type === 'turn.started') this.currentTurnId = event.turnRef
    this.emit(event)
  }

  /**
   * Approvals arrive as requests, and the promise returned here is what holds
   * the server's request open until the user answers. Nothing times it out on
   * the Codex side, so the deadline on the emitted `ApprovalRequest` is the only
   * thing standing between a closed laptop and a wedged session (plan §4.4).
   */
  private handleServerRequest(method: string, params: unknown): Promise<unknown> {
    /*
     * Questions first, because they used to land in the fall-through below and
     * be answered with `{}` — Codex was handed an empty response and the
     * question vanished without ever reaching the user.
     */
    const question = mapUserInputRequest(method, params, {
      seq: this.seq + 1,
      now: this.now(),
      approvalTtlMs: this.approvalTtlMs,
    })
    if (question !== null) {
      return new Promise<unknown>((resolve) => {
        this.openUserInputs.set(question.id, (response) => {
          resolve(toCodexUserInputResponse(response))
        })
        this.emit({
          agentId: 'codex' satisfies AgentId,
          seq: ++this.seq,
          at: this.now(),
          type: 'userinput.requested',
          request: question,
        })
      })
    }

    const request = mapApprovalRequest(
      method,
      params,
      { seq: this.seq + 1, now: this.now(), approvalTtlMs: this.approvalTtlMs },
      (itemId) => this.recentItems.get(itemId)
    )
    if (request === null) return Promise.resolve({})

    return new Promise<unknown>((resolve) => {
      this.openApprovals.set(request.id, (decision) => {
        resolve({ decision })
      })
      this.emit({
        agentId: 'codex' satisfies AgentId,
        seq: ++this.seq,
        at: this.now(),
        type: 'approval.requested',
        request,
      })
    })
  }

  private rememberItem(params: unknown): void {
    const item = (params as { item?: ThreadItem } | undefined)?.item
    if (item === undefined || typeof item.id !== 'string') return
    this.recentItems.set(item.id, item)
    if (this.recentItems.size > MAX_REMEMBERED_ITEMS) {
      const oldest = this.recentItems.keys().next()
      if (!oldest.done) this.recentItems.delete(oldest.value)
    }
  }

  /**
   * Asks for the account's limits rather than waiting to be told.
   *
   * `account/rateLimits/updated` only arrives after a turn, so a header that
   * only listened stayed empty until you had already spent something — which is
   * exactly when it is too late to be useful. Reading once at the start fills it
   * immediately; the notification keeps it current after that.
   *
   * Failure is silence on purpose: an account with no plan window answers with
   * an error, and that is not a reason to fail a session.
   */
  async readLimits(): Promise<void> {
    try {
      /*
       * The response already carries a `rateLimits` key, exactly like the
       * notification — so it is passed through rather than wrapped. Wrapping it
       * put the snapshot one level too deep, the mapper found no windows, and
       * the header stayed empty until a turn happened to publish one. It failed
       * silently, which is why it took a probe to see.
       */
      const response = await this.rpc.request('account/rateLimits/read')
      const event = mapNotification(
        { method: 'account/rateLimits/updated', params: response },
        { seq: this.seq + 1, now: this.now(), approvalTtlMs: this.approvalTtlMs }
      )
      if (event !== null) this.emit(event)
    } catch {
      // No plan window, or not signed in. Nothing to show is the right answer.
    }
  }

  private emit(event: AgentEvent): void {
    this.queue.push({ ...event, seq: ++this.seq })
    this.waiter?.()
    this.waiter = null
  }

  private end(): void {
    this.ended = true
    this.waiter?.()
    this.waiter = null
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

export class CodexAdapter implements AgentAdapter {
  readonly id: AgentId = 'codex'
  readonly capabilities = CODEX_CAPABILITIES

  /** Mutable: replaced by an absolute path the first time one is found. */
  private command: string
  private readonly resolveCommand: (() => Promise<string | null>) | undefined
  private resolving: Promise<void> | null = null
  /** True once a lookup ran and came back with nothing. */
  private lookupFoundNothing = false
  /** An explicit command is the caller's business; we do not second-guess it. */
  private readonly commandWasGiven: boolean
  private readonly approvalTtlMs: number
  private readonly createTransport: () => Transport
  private readonly now: () => number
  private readonly sessions: CodexSession[] = []

  constructor(options: CodexAdapterOptions = {}) {
    this.command = options.command ?? 'codex'
    this.commandWasGiven = options.command !== undefined
    this.resolveCommand = options.resolveCommand
    this.approvalTtlMs = options.approvalTtlMs ?? 5 * 60_000
    this.now = options.now ?? (() => Date.now())
    this.createTransport =
      options.createTransport ?? (() => createStdioTransport({ command: this.command }))
  }

  async health(): Promise<HealthStatus> {
    // Health runs before any session, and it is the first thing to fail with
    // "spawn codex ENOENT" when the command has not been resolved yet.
    await this.resolveCommandOnce()
    try {
      const { stdout } = await run(this.command, ['--version'], { timeout: 10_000 })
      const version = /\d+\.\d+\.\d+[\w.-]*/.exec(stdout.trim())?.[0]
      return version === undefined
        ? { state: 'unavailable', reason: `could not parse version from "${stdout.trim()}"` }
        : { state: 'ready', version }
    } catch (error) {
      return {
        state: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async start(opts: SessionOpts): Promise<AgentSession> {
    const rpc = await this.handshake()
    const started = (await rpc.request('thread/start', {
      cwd: opts.cwd,
      approvalPolicy: 'on-request',
      sandbox: toSandboxMode(opts.sandbox),
      ...(opts.model === undefined ? {} : { model: opts.model }),
    })) as { thread: { id: string } }

    const session = new CodexSession(started.thread.id, rpc, this.approvalTtlMs, this.now)
    // Not awaited: the header can fill a moment late, but a session must not
    // wait on an account lookup to open.
    void session.readLimits()
    return this.track(session)
  }

  async resume(sessionRef: string, opts: SessionOpts): Promise<AgentSession> {
    const rpc = await this.handshake()
    await rpc.request('thread/resume', {
      threadId: sessionRef,
      cwd: opts.cwd,
      approvalPolicy: 'on-request',
      sandbox: toSandboxMode(opts.sandbox),
    })
    const session = new CodexSession(sessionRef, rpc, this.approvalTtlMs, this.now)
    void session.readLimits()
    return this.track(session)
  }

  async dispose(): Promise<void> {
    await Promise.all(this.sessions.map((s) => s.close()))
    this.sessions.length = 0
  }

  /**
   * Asked once, and only if nobody supplied an explicit command.
   *
   * Memoised as a promise, not a boolean. Set before the await, a boolean lets a
   * second caller arriving mid-lookup see "already resolved" and spawn `codex`
   * by bare name — which under a Finder launch is the ENOENT this lookup exists
   * to prevent. The claude adapter had the same bug in the same shape.
   */
  private resolveCommandOnce(): Promise<void> {
    const lookup = this.resolveCommand
    if (lookup === undefined) return Promise.resolve()
    this.resolving ??= lookup()
      .then((found) => {
        if (found !== null) this.command = found
        this.lookupFoundNothing = found === null
      })
      .catch(() => {
        // Let a later start try again rather than caching the failure forever.
        this.resolving = null
      })
    return this.resolving
  }

  private async handshake(): Promise<JsonRpcClient> {
    await this.resolveCommandOnce()

    /*
     * Say what is wrong before the spawn does it worse.
     *
     * With nothing found, `command` is still the bare name `codex`, and under a
     * Finder launch there is no PATH to find it on — which surfaces as "spawn
     * codex ENOENT", the failure this lookup exists to prevent and the one that
     * reads as "not installed" for something the user can run in a terminal.
     */
    if (this.resolveCommand !== undefined && !this.commandWasGiven && this.lookupFoundNothing) {
      throw new Error(
        'Could not find the codex CLI. Chorus runs the one you have installed rather ' +
          'than shipping its own, so `codex` needs to be on your PATH — check with ' +
          '`which codex`, and install it if it is missing.'
      )
    }

    const rpc = new JsonRpcClient({ transport: this.createTransport() })
    // The server rejects everything sent before this completes.
    await rpc.request('initialize', {
      clientInfo: { name: 'chorus', title: 'Chorus', version: '0.0.0' },
      capabilities: {},
    })
    rpc.notify('initialized', {})
    return rpc
  }

  private track(session: CodexSession): CodexSession {
    this.sessions.push(session)
    return session
  }
}
