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
} from '@chorus/agent-protocol'
import type { AgentId, ApprovalId } from '@chorus/shared'
import { mapApprovalRequest, mapNotification, toCodexDecision, type ThreadItem } from './mapping.js'
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

  get events(): AsyncIterable<AgentEvent> {
    return { [Symbol.asyncIterator]: () => this.iterate() }
  }

  close(): Promise<void> {
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

  private readonly command: string
  private readonly approvalTtlMs: number
  private readonly createTransport: () => Transport
  private readonly now: () => number
  private readonly sessions: CodexSession[] = []

  constructor(options: CodexAdapterOptions = {}) {
    this.command = options.command ?? 'codex'
    this.approvalTtlMs = options.approvalTtlMs ?? 5 * 60_000
    this.now = options.now ?? (() => Date.now())
    this.createTransport =
      options.createTransport ?? (() => createStdioTransport({ command: this.command }))
  }

  async health(): Promise<HealthStatus> {
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

    return this.track(new CodexSession(started.thread.id, rpc, this.approvalTtlMs, this.now))
  }

  async resume(sessionRef: string, opts: SessionOpts): Promise<AgentSession> {
    const rpc = await this.handshake()
    await rpc.request('thread/resume', {
      threadId: sessionRef,
      cwd: opts.cwd,
      approvalPolicy: 'on-request',
      sandbox: toSandboxMode(opts.sandbox),
    })
    return this.track(new CodexSession(sessionRef, rpc, this.approvalTtlMs, this.now))
  }

  async dispose(): Promise<void> {
    await Promise.all(this.sessions.map((s) => s.close()))
    this.sessions.length = 0
  }

  private async handshake(): Promise<JsonRpcClient> {
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
