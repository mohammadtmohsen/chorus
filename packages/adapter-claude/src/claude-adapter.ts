import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import {
  query,
  type Options,
  type PermissionResult,
  type Query,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentInput,
  AgentSession,
  ApprovalDecision,
  HealthStatus,
  SessionOpts,
} from '@chorus/agent-protocol'
import { AsyncQueue, newApprovalId, type AgentId, type ApprovalId } from '@chorus/shared'
import { mapSdkMessage, mapToolPermission, trackBashTools, trackStreamMessage } from './mapping.js'

const run = promisify(execFile)

/**
 * `AgentAdapter` over `@anthropic-ai/claude-agent-sdk`.
 *
 * Two decisions from plan §2.5 and §2.6 are load-bearing here:
 *
 *  - `pathToClaudeCodeExecutable` points at the user's installed `claude`, and
 *    the SDK's per-platform binary is excluded from the workspace. It unpacks to
 *    ~257 MB and we do not ship it.
 *  - `settingSources` is deliberately **omitted**, so agents inherit the user's
 *    full config and behave exactly as they do in a terminal. The cost is that
 *    inherited MCP servers can take outward-facing actions, which is why
 *    `mcpToolCall` is a first-class approval kind.
 */

export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  interrupt: true,
  steer: true,
  fork: true,
  reasoningStream: true,
  planStream: true,
  // Claude has no aggregate turn diff; the workspace service derives one (§4.2).
  aggregateDiff: false,
  modelSwitchMidSession: true,
  sandboxPolicy: 'emulated',
}

export interface ClaudeAdapterOptions {
  readonly command?: string
  readonly executablePath?: string
  readonly approvalTtlMs?: number
  readonly now?: () => number
  /** Injected in tests so no real CLI is spawned. */
  readonly createQuery?: (options: Options, prompt: AsyncIterable<unknown>) => Query
}

interface PendingApproval {
  resolve: (result: PermissionResult) => void
  toolName: string
  input: Record<string, unknown>
}

export class ClaudeSession implements AgentSession {
  private readonly queue = new AsyncQueue<AgentEvent>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private seq = 0
  private resolvedSessionRef: string
  private closed = false
  /**
   * Claude reports a user-initiated stop as `error_during_execution` with no
   * distinct status (S3b), so only we know the difference.
   */
  private interruptRequested = false
  /** Id of the message currently streaming, from its `message_start`. */
  private streamMessageRef: string | null = null
  /** `tool_use` ids that were Bash calls, so their results read as commands. */
  private bashToolIds: ReadonlySet<string> = new Set()
  /** Running totals, so usage means the same thing here as it does for Codex. */
  private readonly usageSoFar = { inputTokens: 0, outputTokens: 0 }

  constructor(
    sessionRef: string,
    private readonly q: Query,
    /** The same queue the SDK drains as its prompt — `send` pushes onto it. */
    private readonly inbox: AsyncQueue<unknown>,
    private readonly approvalTtlMs: number,
    private readonly now: () => number
  ) {
    this.resolvedSessionRef = sessionRef
    void this.pump()
  }

  get sessionRef(): string {
    return this.resolvedSessionRef
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.queue
  }

  send(input: AgentInput): Promise<void> {
    // Streaming-input mode: messages are pushed onto the prompt iterable rather
    // than passed at construction. It is also what makes interrupt() and
    // setModel() available at all.
    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: input.text }] },
      parent_tool_use_id: null,
      session_id: this.resolvedSessionRef,
    })
    return Promise.resolve()
  }

  async interrupt(): Promise<void> {
    this.interruptRequested = true
    await this.q.interrupt()
  }

  respondToApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(id)
    if (pending === undefined) return Promise.resolve()
    this.pendingApprovals.delete(id)

    pending.resolve(
      decision.outcome === 'allow'
        ? { behavior: 'allow', updatedInput: decision.updatedInput ?? pending.input }
        : {
            behavior: 'deny',
            message: decision.outcome === 'deny' ? decision.message : 'Cancelled',
          }
    )
    return Promise.resolve()
  }

  setModel(model: string): Promise<void> {
    return this.q.setModel(model)
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    this.inbox.close()
    // Anything still waiting on a decision would otherwise block the SDK's
    // permission callback forever — it has no deadline of its own (plan §4.4).
    for (const [, pending] of this.pendingApprovals) {
      pending.resolve({ behavior: 'deny', message: 'Session closed' })
    }
    this.pendingApprovals.clear()
    this.q.close()
    this.queue.close()
    return Promise.resolve()
  }

  /** Bridges the SDK's `canUseTool` into the approval queue. */
  handlePermission(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    const id = newApprovalId()
    const request = mapToolPermission(
      toolName,
      input,
      { seq: this.seq + 1, now: this.now(), approvalTtlMs: this.approvalTtlMs },
      id
    )

    return new Promise<PermissionResult>((resolve) => {
      this.pendingApprovals.set(id, { resolve, toolName, input })
      this.emit({
        agentId: 'claude',
        seq: ++this.seq,
        at: this.now(),
        type: 'approval.requested',
        request,
      })
    })
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.q) {
        const msg = message as { session_id?: string; type?: string }
        if (typeof msg.session_id === 'string' && msg.session_id !== '') {
          this.resolvedSessionRef = msg.session_id
        }

        this.streamMessageRef = trackStreamMessage(message as never, this.streamMessageRef)
        // Tracked before mapping: the tool_use and its id arrive in the same
        // message that has to be mapped with the id already known.
        this.bashToolIds = trackBashTools(message as never, this.bashToolIds)

        for (const event of mapSdkMessage(message as never, {
          seq: this.seq + 1,
          now: this.now(),
          approvalTtlMs: this.approvalTtlMs,
          usageSoFar: this.usageSoFar,
          streamMessageRef: this.streamMessageRef,
          bashToolIds: this.bashToolIds,
        })) {
          this.emit(this.correctInterrupt(event))
        }
      }
    } catch (error) {
      this.emit({
        agentId: 'claude',
        seq: ++this.seq,
        at: this.now(),
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        recoverable: false,
      })
    }
    // The stream ending is how the supervisor detects a dead session.
    this.queue.close()
  }

  /**
   * A stop the user asked for arrives as a failure. Relabel it, or the UI shows
   * an error card for a button the user just pressed.
   */
  private correctInterrupt(event: AgentEvent): AgentEvent {
    if (event.type !== 'turn.completed') return event
    if (!this.interruptRequested || event.status === 'completed') return event
    this.interruptRequested = false
    return { ...event, status: 'interrupted' }
  }

  private emit(event: AgentEvent): void {
    this.queue.push({ ...event, seq: ++this.seq })
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id: AgentId = 'claude'
  readonly capabilities = CLAUDE_CAPABILITIES

  private readonly command: string
  private readonly executablePath: string | undefined
  private readonly approvalTtlMs: number
  private readonly now: () => number
  private readonly createQuery:
    ((options: Options, prompt: AsyncIterable<unknown>) => Query) | undefined
  private readonly sessions: ClaudeSession[] = []

  constructor(options: ClaudeAdapterOptions = {}) {
    this.command = options.command ?? 'claude'
    this.executablePath = options.executablePath
    this.approvalTtlMs = options.approvalTtlMs ?? 5 * 60_000
    this.now = options.now ?? (() => Date.now())
    this.createQuery = options.createQuery
  }

  async health(): Promise<HealthStatus> {
    try {
      const { stdout } = await run(this.executablePath ?? this.command, ['--version'], {
        timeout: 10_000,
      })
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

  start(opts: SessionOpts): Promise<AgentSession> {
    return Promise.resolve(this.spawn(opts, undefined))
  }

  resume(sessionRef: string, opts: SessionOpts): Promise<AgentSession> {
    return Promise.resolve(this.spawn(opts, sessionRef))
  }

  async dispose(): Promise<void> {
    await Promise.all(this.sessions.map((s) => s.close()))
    this.sessions.length = 0
  }

  private spawn(opts: SessionOpts, resume: string | undefined): ClaudeSession {
    /*
     * The SDK reports a spawn ENOENT as "the native binary failed to launch —
     * this usually means the binary does not match this system's libc", which
     * points at the wrong thing entirely when the real cause is a missing cwd.
     * Checking here keeps the blame where it belongs.
     */
    if (!existsSync(opts.cwd)) {
      throw new Error(`Working directory does not exist: ${opts.cwd}`)
    }

    // canUseTool has to be captured before the session exists, but the SDK
    // only invokes it once the query is running — by which point it is set.
    const holder: { session?: ClaudeSession } = {}

    const options: Options = {
      cwd: opts.cwd,
      includePartialMessages: true,
      permissionMode: opts.sandbox.mode === 'readOnly' ? 'default' : 'acceptEdits',
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(this.executablePath === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.executablePath }),
      ...(resume === undefined ? {} : { resume }),
      canUseTool: (toolName, input) => {
        const session = holder.session
        if (session === undefined) {
          // Fail closed: a permission we cannot route is a permission we deny.
          return Promise.resolve<PermissionResult>({
            behavior: 'deny',
            message: 'Session not ready',
          })
        }
        return session.handlePermission(toolName, input)
      },
    }

    const inbox = new AsyncQueue<unknown>()
    const factory =
      this.createQuery ??
      ((o: Options, prompt: AsyncIterable<unknown>) =>
        query({ prompt: prompt as never, options: o }))

    const q = factory(options, inbox)
    const session = new ClaudeSession(resume ?? '', q, inbox, this.approvalTtlMs, this.now)
    holder.session = session

    this.sessions.push(session)
    return session
  }
}
