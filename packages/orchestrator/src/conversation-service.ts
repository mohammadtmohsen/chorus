import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  HealthStatus,
  SessionOpts,
} from '@chorus/agent-protocol'
import type { ApprovalId } from '@chorus/shared'
import type { AppendInput, ChorusEventPayload, EventStore } from '@chorus/event-store'
import { DeltaBuffer, type Scheduler } from './delta-buffer.js'

/**
 * Drives one agent session and turns its normalized `AgentEvent` stream into
 * durable `ChorusEvent`s.
 *
 * Two rules govern everything here, both from the S3 spike:
 *
 *  1. Streamed text is persisted as it arrives, coalesced by `DeltaBuffer`,
 *     because Codex discards partial output on interruption and we cannot ask
 *     for it back.
 *  2. Pending deltas are flushed **before** any lifecycle event is appended, so
 *     the log's order matches what actually happened. Without this a command
 *     would appear in the transcript ahead of the sentence introducing it.
 */

interface DeltaMeta {
  readonly kind: 'message' | 'reasoning'
  readonly itemRef: string
}

export interface ConversationServiceOptions {
  readonly store: EventStore
  readonly conversationId: string
  readonly adapter: AgentAdapter
  readonly scheduler?: Scheduler
  readonly maxChars?: number
  readonly maxAgeMs?: number
}

export class ConversationService {
  private readonly store: EventStore
  private readonly conversationId: string
  private readonly adapter: AgentAdapter
  private readonly buffer: DeltaBuffer<DeltaMeta>
  private session: AgentSession | null = null
  private pump: Promise<void> | null = null
  /** Set when *we* asked to stop, so an interrupt is not reported as a failure. */
  private interruptRequested = false

  constructor(options: ConversationServiceOptions) {
    this.store = options.store
    this.conversationId = options.conversationId
    this.adapter = options.adapter
    this.buffer = new DeltaBuffer<DeltaMeta>({
      ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
      ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      onFlush: (entries) => {
        this.append(
          entries.map((e) => ({
            actor: this.adapter.id,
            payload:
              e.meta.kind === 'message'
                ? { type: 'agent.message.delta' as const, itemRef: e.meta.itemRef, text: e.text }
                : { type: 'agent.reasoning.delta' as const, itemRef: e.meta.itemRef, text: e.text },
          }))
        )
      },
    })
  }

  /** Starts a session on the adapter and consumes it. */
  async start(opts: SessionOpts): Promise<AgentSession> {
    const health = await this.adapter.health()
    const session = await this.adapter.start(opts)
    await this.attach(session, opts, health)
    return session
  }

  /**
   * Consumes a session someone else created — in practice a `SupervisedSession`,
   * which transparently restarts the provider underneath. This service is
   * deliberately unaware of that: a restart shows up as an ordinary `error`
   * event in the stream, and the transcript keeps going.
   */
  attach(session: AgentSession, opts: SessionOpts, health: HealthStatus): Promise<void> {
    this.session = session
    this.appendOne({
      actor: 'system',
      payload: {
        type: 'session.started',
        agentId: this.adapter.id,
        sessionRef: session.sessionRef,
        cwd: opts.cwd,
        model: opts.model ?? null,
        // Recorded because Chorus drives the user's installed CLIs, which
        // self-update (plan §2.5).
        cliVersion: health.state === 'ready' ? health.version : null,
      },
    })
    this.pump = this.consume(session)
    return Promise.resolve()
  }

  async sendUserMessage(text: string): Promise<void> {
    this.appendOne({ actor: 'user', payload: { type: 'user.message', text } })
    await this.session?.send({ text })
  }

  async interrupt(): Promise<void> {
    this.interruptRequested = true
    await this.session?.interrupt()
  }

  /**
   * Answers an approval **and records the decision**.
   *
   * Routing this through the service rather than straight to the session is what
   * makes "human controlled" auditable (plan §4.4): every decision lands in the
   * log with who made it and, for an auto-decision, which rule did. Talking to
   * the session directly would answer the agent while leaving no trace — and
   * would leave the pending card on screen forever, since the UI clears it on
   * `approval.decided`.
   */
  async decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: 'user' | 'policy' | 'system' = 'user',
    policyRuleId: string | null = null
  ): Promise<void> {
    this.lifecycle({
      type: 'approval.decided',
      approvalId,
      outcome: decision.outcome,
      scope: decision.outcome === 'allow' ? decision.scope : null,
      decidedBy,
      policyRuleId,
    })
    await this.session?.respondToApproval(approvalId as ApprovalId, decision)
  }

  /** Resolves once the event stream has ended and everything is durable. */
  async drain(): Promise<void> {
    await this.pump
    this.buffer.flushAll()
  }

  async close(reason: 'closed' | 'crashed' | 'replaced' = 'closed'): Promise<void> {
    this.buffer.flushAll()
    const ref = this.session?.sessionRef
    await this.session?.close()
    await this.pump
    this.buffer.flushAll()
    this.buffer.dispose()
    if (ref !== undefined) {
      this.appendOne({
        actor: 'system',
        payload: {
          type: 'session.ended',
          agentId: this.adapter.id,
          sessionRef: ref,
          reason,
        },
      })
    }
  }

  private async consume(session: AgentSession): Promise<void> {
    for await (const event of session.events) {
      this.handle(event)
    }
  }

  private handle(event: AgentEvent): void {
    switch (event.type) {
      case 'message.delta':
        this.buffer.push(`message:${event.itemRef}`, event.text, {
          kind: 'message',
          itemRef: event.itemRef,
        })
        return

      case 'reasoning.delta':
        this.buffer.push(`reasoning:${event.itemRef}`, event.text, {
          kind: 'reasoning',
          itemRef: event.itemRef,
        })
        return

      case 'message.completed':
        // The provider's final text supersedes the buffered fragments, so drop
        // them rather than writing text that the completed event repeats.
        this.buffer.flushKey(`message:${event.itemRef}`)
        this.lifecycle({
          type: 'agent.message.completed',
          itemRef: event.itemRef,
          text: event.text,
        })
        return

      case 'turn.started':
        this.lifecycle({ type: 'turn.started', turnRef: event.turnRef })
        return

      case 'turn.completed': {
        const status =
          this.interruptRequested && event.status !== 'completed' ? 'interrupted' : event.status
        this.lifecycle({
          type: 'turn.completed',
          turnRef: event.turnRef,
          status,
          userInitiated: this.interruptRequested,
        })
        this.interruptRequested = false
        return
      }

      case 'command.started':
        this.lifecycle({
          type: 'command.started',
          itemRef: event.itemRef,
          command: [...event.command],
          cwd: event.cwd,
        })
        return

      case 'command.output':
        this.lifecycle({
          type: 'command.output',
          itemRef: event.itemRef,
          stream: event.stream,
          chunk: event.chunk,
        })
        return

      case 'command.completed':
        this.lifecycle({
          type: 'command.completed',
          itemRef: event.itemRef,
          exitCode: event.exitCode,
        })
        return

      case 'file.change.proposed':
        this.lifecycle({
          type: 'file.change.proposed',
          itemRef: event.itemRef,
          files: event.files.map((f) => ({ path: f.path, patch: f.patch })),
        })
        return

      case 'diff.updated':
        this.lifecycle({ type: 'diff.updated', unifiedDiff: event.unifiedDiff })
        return

      case 'approval.requested':
        this.lifecycle({
          type: 'approval.requested',
          approvalId: event.request.id,
          kind: event.request.kind,
          request: event.request,
          expiresAt: event.request.expiresAt,
        })
        return

      case 'usage.updated':
        this.lifecycle({
          type: 'usage.updated',
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd ?? null,
        })
        return

      case 'plan.updated':
        // No durable projection yet; the plan panel lands in M4.
        return

      case 'error':
        this.lifecycle({
          type: 'error.raised',
          message: event.message,
          recoverable: event.recoverable,
        })
        return
    }
  }

  /** Every non-delta event goes through here so the flush-first rule cannot be skipped. */
  private lifecycle(payload: ChorusEventPayload): void {
    this.buffer.flushAll()
    this.appendOne({ actor: this.adapter.id, payload })
  }

  private appendOne(input: Omit<AppendInput, 'conversationId'>): void {
    this.store.append({ ...input, conversationId: this.conversationId })
  }

  private append(inputs: readonly Omit<AppendInput, 'conversationId'>[]): void {
    if (inputs.length === 0) return
    this.store.appendMany(inputs.map((i) => ({ ...i, conversationId: this.conversationId })))
  }
}
