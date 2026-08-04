import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  HealthStatus,
  SessionOpts,
  UsageWindow,
} from '@chorus/agent-protocol'
import type { ApprovalId } from '@chorus/shared'
import type { AppendInput, ChorusEventPayload, EventStore } from '@chorus/event-store'
import { DeltaBuffer, type Scheduler } from './delta-buffer.js'
import { describeRequest, evaluate, SessionGrants } from './policy/engine.js'
import { ApprovalQueue } from './policy/queue.js'
import { DEFAULT_PROFILE_ID, profileById, type PermissionProfile } from './policy/rules.js'

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
  /** Defaults to read-only. Starting permissive is how permissive defaults ship. */
  readonly profile?: PermissionProfile
  /** Shared across agents in a conversation, so a grant is not re-asked per agent. */
  readonly grants?: SessionGrants
  /** Told when the provider reports its account limits. Not persisted. */
  readonly onLimits?: (windows: readonly UsageWindow[]) => void
}

export class ConversationService {
  private readonly store: EventStore
  private readonly conversationId: string
  private readonly adapter: AgentAdapter
  private readonly buffer: DeltaBuffer<DeltaMeta>
  private profile: PermissionProfile
  private readonly grants: SessionGrants
  private readonly queue: ApprovalQueue
  private readonly onLimits: ((windows: readonly UsageWindow[]) => void) | undefined
  private session: AgentSession | null = null
  private pump: Promise<void> | null = null
  /** Set when *we* asked to stop, so an interrupt is not reported as a failure. */
  private interruptRequested = false

  constructor(options: ConversationServiceOptions) {
    this.store = options.store
    this.conversationId = options.conversationId
    this.adapter = options.adapter
    this.profile = options.profile ?? profileById(DEFAULT_PROFILE_ID)
    this.grants = options.grants ?? new SessionGrants()
    this.onLimits = options.onLimits
    this.queue = new ApprovalQueue({
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      onResolved: (entry, decision, decidedBy) =>
        this.recordAndAnswer(entry.request.id, decision, decidedBy, null),
    })
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
  attach(
    session: AgentSession,
    opts: SessionOpts,
    health: HealthStatus,
    /** Set when the app is reopening this, not when an agent is joining. */
    resumed = false
  ): Promise<void> {
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
        resumed,
      },
    })
    this.pump = this.consume(session)
    return Promise.resolve()
  }

  /**
   * Logs the message and delivers it. Only correct when this service is the
   * conversation's sole agent — with several, the runtime logs once and calls
   * `deliver` on each recipient, or the transcript shows the user repeating
   * themselves once per agent.
   */
  async sendUserMessage(text: string): Promise<void> {
    this.appendOne({ actor: 'user', payload: { type: 'user.message', text } })
    await this.deliver(text)
  }

  /** Delivers without logging — the shared-conversation path. */
  async deliver(text: string): Promise<void> {
    await this.session?.send({ text })
  }

  /**
   * Re-points this session at another profile.
   *
   * Only affects approvals asked *after* it: a request already on screen was
   * evaluated under the old rules and is the user's to settle either way.
   * Session grants survive too — they were given deliberately, and a profile
   * change is not a reason to re-ask for something already allowed.
   */
  setProfile(profile: PermissionProfile): void {
    this.profile = profile
  }

  profileId(): string {
    return this.profile.id
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
    decidedBy: 'user' | 'policy' | 'system' = 'user'
  ): Promise<void> {
    // "Allow for session" is remembered before the queue forgets the request,
    // so the same action does not ask again. Outward-facing kinds refuse to be
    // remembered — `SessionGrants.add` returns false for them (plan §2.6).
    const entry = this.queue.get(approvalId)
    if (entry !== undefined && decision.outcome === 'allow' && decision.scope === 'session') {
      this.grants.add(entry.request)
    }

    const handled = await this.queue.resolve(approvalId, decision, decidedBy)
    if (!handled) {
      // Not queued — an auto-decided or already-settled approval. Still log it.
      await this.recordAndAnswer(approvalId, decision, decidedBy, null)
    }
  }

  /** Everything a person or a rule may grant this session, for the audit view. */
  sessionGrants(): { key: string; describe: string }[] {
    return this.grants.list()
  }

  pendingApprovals(): { id: string; describe: string; expiresAt: number }[] {
    return this.queue.list().map((e) => ({
      id: e.request.id,
      describe: describeRequest(e.request),
      expiresAt: e.request.expiresAt,
    }))
  }

  /** The single place a decision becomes both a log entry and a wire response. */
  private async recordAndAnswer(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: 'user' | 'policy' | 'system',
    policyRuleId: string | null
  ): Promise<void> {
    this.lifecycle({
      type: 'approval.decided',
      approvalId,
      outcome: decision.outcome,
      scope: decision.outcome === 'allow' ? decision.scope : null,
      decidedBy,
      policyRuleId,
    })
    // A timeout is a denial on the wire; the log keeps the distinction.
    const answer: ApprovalDecision =
      decision.outcome === 'timeout'
        ? { outcome: 'deny', message: 'Timed out waiting for a decision' }
        : decision
    await this.session?.respondToApproval(approvalId as ApprovalId, answer)
  }

  /** Resolves once the event stream has ended and everything is durable. */
  async drain(): Promise<void> {
    await this.pump
    this.buffer.flushAll()
  }

  async close(reason: 'closed' | 'crashed' | 'replaced' | 'shutdown' = 'closed'): Promise<void> {
    // Anything still waiting is denied, or the agent blocks on a prompt nobody
    // will ever see.
    await this.queue.drain('Session closed')
    this.buffer.flushAll()
    const ref = this.session?.sessionRef
    await this.session?.close()
    await this.pump
    this.buffer.flushAll()
    this.buffer.dispose()
    this.queue.dispose()
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

      case 'approval.requested': {
        this.lifecycle({
          type: 'approval.requested',
          approvalId: event.request.id,
          kind: event.request.kind,
          request: event.request,
          expiresAt: event.request.expiresAt,
        })

        /*
         * Policy decides before the user ever sees a card. An auto-decision is
         * logged with the rule that made it — an allow nobody can trace back to
         * a rule is indistinguishable from no policy at all (plan §4.4).
         */
        const verdict = evaluate(event.request, this.profile, this.grants)
        if (verdict.decision === 'allow') {
          void this.recordAndAnswer(
            event.request.id,
            { outcome: 'allow', scope: verdict.scope },
            'policy',
            verdict.ruleId
          )
          return
        }
        if (verdict.decision === 'deny') {
          void this.recordAndAnswer(
            event.request.id,
            { outcome: 'deny', message: verdict.reason },
            'policy',
            verdict.ruleId
          )
          return
        }

        // Nobody but a person can settle this one; the queue owns its deadline.
        this.queue.add(this.conversationId, event.request)
        return
      }

      /*
       * Handed on, never written down.
       *
       * The log records what happened in a conversation; how full an account's
       * weekly window is happened to the account, and reading it back a week
       * later would be worse than not having it. It goes straight to whoever
       * asked to be told.
       */
      case 'limits':
        this.onLimits?.(event.windows)
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
