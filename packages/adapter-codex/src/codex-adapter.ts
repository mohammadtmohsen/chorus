import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
  /*
   * True and now earned. It was true for a long time while this adapter issued
   * `thread/fork` nowhere and `AgentSession` had no fork at all — a description
   * of the protocol rather than of what Chorus could do, which is exactly the
   * "wish, not a promise" the Claude adapter's own capability comment warns
   * against. `fork()` below is the implementation that makes the claim honest.
   */
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
  /**
   * The reasoning effort in force, held because Codex has nowhere to put it.
   *
   * Claude takes effort as a session-level override and keeps it. Codex takes
   * `effort` on `turn/start`, per turn — so "set the effort" here means
   * "remember it and say it every time", and a session that forgot would
   * silently revert to the model's default on the second turn.
   */
  private effort: string | null = null

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
      // Per turn, not per session — see `effort`.
      ...(this.effort === null ? {} : { effort: this.effort }),
    })) as { turn?: { id?: string } }
    this.currentTurnId = result.turn?.id ?? null
  }

  /**
   * Remembers the level; every later `turn/start` carries it.
   *
   * Deliberately does not talk to the server. There is no request that sets an
   * effort for a thread — the field lives on the turn — so the only honest
   * implementation is to hold it. Without this method at all,
   * `SupervisedSession.setEffort` optional-chains into silence and a chosen
   * effort is saved, displayed, and never sent.
   */
  setEffort(level: string): Promise<void> {
    this.effort = level === '' ? null : level
    return Promise.resolve()
  }

  /**
   * The models this account is offered, from `model/list`.
   *
   * Paginated, and the cursor has to be followed: a first page is not the
   * catalogue, and a picker built from one silently omits whatever came after.
   *
   * `hidden` models are skipped because they are hidden from the provider's own
   * picker, and offering what another client deliberately does not is a way to
   * end up recommending something unsupported.
   *
   * `value` is `Model.model`, not `Model.id`. The two come back identical from
   * the catalogue today, so no live run distinguishes them — Codex's own
   * model-override code uses `model` as the slug, which is the evidence that
   * settles it.
   */
  async supportedModels(): Promise<readonly ModelChoice[]> {
    const choices: ModelChoice[] = []
    let cursor: string | undefined

    try {
      // Bounded, because a server that always returns a cursor would otherwise
      // spin here forever. Far more pages than any real catalogue.
      for (let page = 0; page < 20; page++) {
        const result = (await this.rpc.request('model/list', {
          ...(cursor === undefined ? {} : { cursor }),
        })) as { data?: unknown; nextCursor?: unknown }

        for (const entry of Array.isArray(result.data) ? result.data : []) {
          const row = entry as {
            model?: unknown
            displayName?: unknown
            hidden?: unknown
            supportedReasoningEfforts?: unknown
          }
          if (typeof row.model !== 'string' || row.model === '') continue
          if (row.hidden === true) continue

          const efforts = (
            Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : []
          ).flatMap((option): string[] => {
            const level = (option as { reasoningEffort?: unknown }).reasoningEffort
            return typeof level === 'string' && level !== '' ? [level] : []
          })

          choices.push({
            value: row.model,
            label:
              typeof row.displayName === 'string' && row.displayName !== ''
                ? row.displayName
                : row.model,
            ...(efforts.length === 0 ? {} : { effortLevels: efforts }),
          })
        }

        const next = result.nextCursor
        if (typeof next !== 'string' || next === '') break
        cursor = next
      }
    } catch {
      // A CLI too old for `model/list`, or one that cannot answer right now.
      // Whatever pages did arrive are still a better picker than none.
    }

    return choices
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
    /*
     * `always` is Chorus's own idea, so it stops here.
     *
     * Codex knows two answers: this once, or for the rest of this run. Chorus
     * remembering the answer past a restart is bookkeeping on our side, and the
     * most the provider needs to be told is not to ask again while it is up.
     */
    const scope =
      decision.outcome !== 'allow' ? 'once' : decision.scope === 'once' ? 'once' : 'session'
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

  /**
   * A branch of a thread, which the original never learns about.
   *
   * `thread/fork` rather than `thread/resume`: resuming rejoins the same thread
   * and everything said goes into it, while forking returns a new thread whose
   * `forkedFromId` names the original and whose turns never reach it.
   *
   * `ephemeral: true` is what keeps a throwaway question from becoming a thread
   * the user finds later — the server never materialises it on disk.
   *
   * No `lastTurnId`: every fork is taken at the thread's head. Forking at an
   * older turn is possible in the protocol and deliberately unused, because
   * Chorus's own log does not record turn ids it could point at.
   *
   * **`inherits` is honoured only as `'config'`.** `ThreadForkParams` offers
   * `baseInstructions` and a `config` map, neither of which is an off switch for
   * the user's MCP servers and hooks, so `'nothing'` has nothing to map onto
   * here. Silently accepting it would make the port's most safety-relevant
   * option mean two different things per provider, which is worse than refusing.
   */
  async fork(sessionRef: string, opts: ForkOpts): Promise<AgentSession> {
    if (sessionRef === '') throw new Error('Cannot fork a thread that has no id yet')
    if (opts.inherits === 'nothing') {
      throw new Error('codex cannot fork without the user configuration')
    }
    const rpc = await this.handshake()
    const forked = (await rpc.request('thread/fork', {
      threadId: sessionRef,
      ephemeral: true,
      cwd: opts.cwd,
      approvalPolicy: 'on-request',
      sandbox: toSandboxMode(opts.sandbox),
      ...(opts.model === undefined ? {} : { model: opts.model }),
    })) as { thread: { id: string } }

    const session = new CodexSession(forked.thread.id, rpc, this.approvalTtlMs, this.now)
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
