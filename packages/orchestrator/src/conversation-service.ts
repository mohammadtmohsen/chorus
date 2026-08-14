import {
  redactAnswers,
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  type ApprovalDecision,
  type BackgroundTask,
  type HealthStatus,
  type SessionOpts,
  type UsageWindow,
  type UserInputRequest,
  type UserInputResponse,
} from '@chorus/agent-protocol'
import type { ApprovalId } from '@chorus/shared'
import type { AppendInput, ChorusEventPayload, EventStore } from '@chorus/event-store'
import { DeltaBuffer, realScheduler, type Scheduler } from './delta-buffer.js'
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
  /** Told how full the agent's context window is. Not persisted, for the same reason. */
  readonly onContextUsage?: (usage: ContextWindow) => void
  /** Told what the agent has left running. Not persisted, for the same reason. */
  readonly onTasks?: (tasks: readonly BackgroundTask[]) => void
  /** Told when an approved plan returned the session to ordinary permissions. */
  readonly onPlanExited?: () => void
  /**
   * Nothing here may stop and wait for a person. Set for asides.
   *
   * An aside is a small card anchored to a passage, not a session: it has no
   * room for an approval card, and a card that can raise one is a modal dialog
   * wearing a tooltip's clothes. Worse, an aside nobody is watching would sit on
   * an unanswered approval until its deadline — a fork wedged on a question the
   * user never saw.
   *
   * So an `ask` verdict becomes a deny here rather than a card. `evaluate` still
   * runs first and unchanged, so whatever the profile allows outright still goes
   * through — for an aside that is the read-only profile's safe reads, which is
   * how it can go and look something up.
   *
   * What must **not** be handed to a service in this mode is a populated
   * `SessionGrants`. A grant outranks an `ask`, and a caller that never asks
   * turns every past "always allow" into silent permission to act inside a fork
   * nobody is watching. The caller owns that decision; this flag only removes
   * the card.
   */
  readonly neverAsks?: boolean
}

/** How full an agent's context window is, as last measured. */
export interface ContextWindow {
  readonly usedTokens: number
  readonly maxTokens: number
  /** 0-100. */
  readonly percentUsed: number
}

/**
 * How long a genuine gesture buys.
 *
 * Two minutes, from the data rather than rounded to it: the median successful
 * answer took 55 seconds and the slowest took 255. Two minutes is comfortably
 * more than a typical answer from a standing start, so someone still working
 * keeps buying time with each thing they do, and someone who has walked away
 * loses it once.
 */
const ENGAGED_GRACE_MS = 120_000

/**
 * The furthest a deadline may ever be pushed, from when the question was asked.
 *
 * Not a limit on the person — if gestures keep arriving they are there, and the
 * turn is not wedged. It bounds the case the deadline exists for: a renderer
 * that reports engagement it does not have. Half an hour is far beyond any
 * answer ever observed here and still finite.
 */
const MAX_EXTENSION_MS = 30 * 60_000

export class ConversationService {
  private readonly store: EventStore
  private readonly conversationId: string
  private readonly adapter: AgentAdapter
  private readonly buffer: DeltaBuffer<DeltaMeta>
  private profile: PermissionProfile
  /** Asides answer their own approvals — see `ConversationServiceOptions.neverAsks`. */
  private readonly neverAsks: boolean
  private readonly grants: SessionGrants
  private readonly queue: ApprovalQueue
  private readonly onLimits: ((windows: readonly UsageWindow[]) => void) | undefined
  private readonly onContextUsage: ((usage: ContextWindow) => void) | undefined
  private readonly onTasks: ((tasks: readonly BackgroundTask[]) => void) | undefined
  private readonly onPlanExited: (() => void) | undefined
  /**
   * Question sets waiting on the user, kept so an answer can be checked against
   * the questions that produced it — which is what redaction needs to know
   * which values are secret.
   *
   * Each carries its own deadline timer. Neither provider imposes one, so an
   * unanswered question would otherwise hold the turn open forever — the same
   * reasoning that gives approvals a TTL (plan §4.4), and the same failure:
   * a closed laptop wedges the session.
   */
  private readonly pendingUserInput = new Map<
    string,
    {
      request: UserInputRequest
      timer: unknown
      /** The deadline in force, which is not the request's after an extension. */
      expiresAt: number
      /** The furthest it may ever be pushed. See `extendUserInput`. */
      ceiling: number
    }
  >()
  private readonly scheduler: Scheduler
  private session: AgentSession | null = null
  private pump: Promise<void> | null = null
  /** Set when *we* asked to stop, so an interrupt is not reported as a failure. */
  private interruptRequested = false

  constructor(options: ConversationServiceOptions) {
    this.store = options.store
    this.conversationId = options.conversationId
    this.adapter = options.adapter
    this.profile = options.profile ?? profileById(DEFAULT_PROFILE_ID)
    this.neverAsks = options.neverAsks ?? false
    this.grants = options.grants ?? new SessionGrants()
    this.onLimits = options.onLimits
    this.onContextUsage = options.onContextUsage
    this.onTasks = options.onTasks
    this.onPlanExited = options.onPlanExited
    this.scheduler = options.scheduler ?? realScheduler
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
  async sendUserMessage(text: string, delivered: string = text): Promise<void> {
    /*
     * The two can differ, and for an aside they do. What is logged is the
     * question as it was typed; what is delivered carries the quoted passage and
     * the instruction not to work, which is scaffolding rather than something
     * the user said. Logging the wrapper would put words in their mouth in their
     * own transcript.
     */
    this.appendOne({ actor: 'user', payload: { type: 'user.message', text } })
    await this.deliver(delivered)
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

  /**
   * Asks the provider to re-read its account windows, if it can be asked.
   *
   * Silent when the session is not up or the provider has no such notion — the
   * caller is a button, and a button that reports "this agent does not meter"
   * is noise rather than news.
   */
  async refreshLimits(): Promise<void> {
    await this.session?.readLimits?.()
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
    /*
     * "Always" is remembered past this run; "session" only until it ends.
     *
     * Both are recorded before the queue forgets the request, and only `always`
     * may answer for a kind that can never be auto-decided — because that is the
     * user having decided, not a profile deciding for them.
     */
    if (entry !== undefined && decision.outcome === 'allow' && decision.scope === 'always') {
      this.grants.addAlways(entry.request)
    }
    if (entry !== undefined && decision.outcome === 'allow' && decision.scope === 'session') {
      this.grants.add(entry.request)

      /*
       * "Always" on an edit means always, not "always this file".
       *
       * A grant is keyed on its subject, which for a file change is the paths
       * it touched — so on its own it answers for `src/a.ts` and asks again for
       * `src/b.ts`. That is right for a command, where the subject *is* the
       * action, and wrong for editing, where the next file is the same act.
       *
       * So the decision is handed to the provider, which is also where it
       * belongs once it has been made: the CLI accepts edits itself, with no
       * round trip through here at all.
       *
       * The cost is real and is why this needs an explicit "always" rather than
       * a profile or a setting. From here to the end of the session the CLI
       * stops calling the permission callback for edits, so no `fileChange`
       * rule sees them — including the credential one. That is the user
       * choosing it, once, knowingly; it is not a default, and it was a default
       * until very recently.
       */
      if (entry.request.kind === 'fileChange') {
        void this.acceptEditsFromNowOn()
      }
    }

    /*
     * Approving a plan is what ends plan mode.
     *
     * `ExitPlanMode` is the agent saying it has finished reasoning and would
     * like to act, and it arrives as an ordinary permission request. Answering
     * yes to the plan and separately having to leave the mode would be two
     * decisions for one intention — and the second one is easy to forget, which
     * leaves an approved plan that never runs.
     *
     * Only on allow. A rejected plan means keep planning.
     */
    if (
      entry !== undefined &&
      decision.outcome === 'allow' &&
      entry.request.kind === 'permissionGrant' &&
      entry.request.toolName === 'ExitPlanMode'
    ) {
      void this.leavePlanMode()
    }

    const handled = await this.queue.resolve(approvalId, decision, decidedBy)
    if (!handled) {
      // Not queued — an auto-decided or already-settled approval. Still log it.
      await this.recordAndAnswer(approvalId, decision, decidedBy, null)
    }
  }

  /**
   * Answers a question set and lets the agent's turn continue.
   *
   * The log entry is written before the provider is told, and the answers are
   * redacted on the way into it. Ordering matters: if the wire call throws, the
   * record of what the user chose still exists.
   */
  async answerUserInput(
    userInputId: string,
    response: UserInputResponse,
    answeredBy: 'user' | 'system' = 'user'
  ): Promise<void> {
    const pending = this.pendingUserInput.get(userInputId)
    // Already answered, timed out, or never ours. Answering twice is harmless
    // by design — a double-submit from the UI must not throw at the user.
    if (pending === undefined) return
    const { request } = pending

    /*
     * The answers must name the questions that were actually asked, checked
     * before anything is written down.
     *
     * The log entry is deliberately written before the provider is told, so an
     * unvalidated response becomes a permanent `answered` record for an answer
     * the provider may reject — which is precisely how C-018 stayed invisible
     * for weeks. A renderer left open across a new request, or an id regression,
     * produces exactly that.
     *
     * Left pending rather than resolved: the card stays up, the user can answer
     * again, and the deadline still bounds it. Recording a `cancel` the user did
     * not ask for would be its own lie.
     */
    if (response.outcome === 'answered') {
      const asked = new Set(request.questions.map((q) => q.id))
      const answered = new Set(response.answers.map((a) => a.questionId))
      const matches = asked.size === answered.size && [...asked].every((id) => answered.has(id))
      // No logger on this class, and a `notice` would put a line in the
      // transcript for what is a caller bug rather than something the
      // conversation did. Returning is the behaviour; the test is the record.
      if (!matches) return
    }

    this.scheduler.clearTimeout(pending.timer)
    this.pendingUserInput.delete(userInputId)

    this.lifecycle({
      type: 'userinput.answered',
      userInputId,
      outcome: response.outcome,
      answers:
        response.outcome === 'answered'
          ? redactAnswers(request, response.answers).map((a) => ({
              questionId: a.questionId,
              values: a.values === null ? null : [...a.values],
            }))
          : null,
      answeredBy,
    })

    await this.session?.respondToUserInput(request.id, response)
  }

  /**
   * Arms the deadline, and re-checks it when it fires.
   *
   * The re-check is the point. A `setTimeout` already queued cannot be
   * un-queued, so an extension arriving in the same tick as the expiry would
   * otherwise lose the race silently — which is this bug again with extra steps.
   */
  private armUserInputTimer(userInputId: string, at: number): unknown {
    return this.scheduler.setTimeout(
      () => {
        const pending = this.pendingUserInput.get(userInputId)
        if (pending === undefined) return
        if (pending.expiresAt !== at) {
          /*
           * Extended after this timer was armed. Re-arm for the deadline that is
           * now in force rather than resolving against one that has moved.
           *
           * Compared against the time this timer was armed *for*, not against
           * the clock: a queued callback cannot be un-queued, so the race is
           * real — and a wall-clock test would also depend on the scheduler
           * advancing, which the fake one deliberately does not.
           */
          pending.timer = this.armUserInputTimer(userInputId, pending.expiresAt)
          return
        }
        // Never fabricates an answer: `timeout` tells the provider nothing was
        // chosen, which is recoverable. A guessed answer is not.
        void this.answerUserInput(userInputId, { outcome: 'timeout' }, 'system')
      },
      Math.max(0, at - this.scheduler.now())
    )
  }

  /**
   * Pushes a question's deadline out, or just reports it.
   *
   * The clock measured time since the *agent asked*; nothing restarted it, and
   * answering was not an input to it — so a card could be on screen, focused and
   * half-filled, and still expire. Measured over the real log, 10 of 25 question
   * sets died at exactly 300.0s.
   *
   * `engaged` must mean a gesture the app cannot manufacture. The card focuses
   * itself on mount, so focus is not evidence; a remounting card asks with
   * `engaged: false`, which reads the deadline and changes nothing.
   */
  extendUserInput(userInputId: string, engaged: boolean): number | null {
    const pending = this.pendingUserInput.get(userInputId)
    if (pending === undefined) return null
    if (!engaged) return pending.expiresAt

    const next = Math.min(this.scheduler.now() + ENGAGED_GRACE_MS, pending.ceiling)
    // Never shortens: a gesture late in a long grace period must not pull the
    // deadline back towards now.
    if (next <= pending.expiresAt) return pending.expiresAt

    pending.expiresAt = next
    this.scheduler.clearTimeout(pending.timer)
    pending.timer = this.armUserInputTimer(userInputId, next)
    return next
  }

  /** Question sets still waiting on the user, for the UI to draw after a replay. */
  pendingQuestions(): UserInputRequest[] {
    return [...this.pendingUserInput.values()].map((p) => p.request)
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
    // Questions the same way: the card is going away, so anything still open
    // has to be settled rather than left holding the turn.
    for (const id of [...this.pendingUserInput.keys()]) {
      await this.answerUserInput(id, { outcome: 'cancel' }, 'system')
    }
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

      case 'file.change.completed':
        this.lifecycle({
          type: 'file.change.completed',
          itemRef: event.itemRef,
          files: event.files.map((f) => ({
            path: f.path,
            ...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }),
            change: f.change,
            added: f.added,
            removed: f.removed,
            patch: f.patch,
            ...(f.omittedLines === undefined ? {} : { omittedLines: f.omittedLines }),
          })),
          outcome: event.outcome,
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

        /*
         * An aside has nobody to ask, so it answers for itself.
         *
         * Denied rather than allowed, and denied *immediately* rather than left
         * to the queue's deadline: an unattended fork holding an approval open
         * is a wedged turn, which is the failure this whole branch exists to
         * avoid.
         *
         * The message goes to the *provider*, not to the log — `approval.decided`
         * records a verdict, a scope and a rule, and carries no text. So the
         * agent learns why and can say so in its answer; a card wanting to
         * explain the refusal has to supply its own words.
         */
        if (this.neverAsks) {
          void this.recordAndAnswer(
            event.request.id,
            { outcome: 'deny', message: 'An aside may explain, not act.' },
            'policy',
            null
          )
          return
        }

        // Nobody but a person can settle this one; the queue owns its deadline.
        this.queue.add(this.conversationId, event.request)
        return
      }

      /*
       * Logged and held, never auto-answered.
       *
       * Deliberately does not go past `evaluate()`. A permission profile decides
       * whether an action is allowed, which is a question it can be given rules
       * about; what the user *wants* is not. An auto-answered question would put
       * words in their mouth and the agent would have no way to tell.
       */
      case 'userinput.requested': {
        this.lifecycle({
          type: 'userinput.requested',
          userInputId: event.request.id,
          request: event.request,
          expiresAt: event.request.expiresAt,
        })
        /*
         * Same reasoning as an approval, one step further: an aside cannot host
         * a question set either, and waiting out its deadline in a card nobody
         * is looking at is the wedge again. `timeout` rather than a fabricated
         * choice — the provider is told nothing was chosen, which it can recover
         * from; an invented answer it cannot.
         */
        /*
         * The ceiling, fixed when the question arrives.
         *
         * Engagement may push the deadline out but never past this, so a
         * renderer that reported interest forever could not hold a turn open
         * forever. A provider's own deadline wins where it exists — Codex
         * declares one in principle and never in practice, so this costs
         * nothing today and is correct on the day it does.
         */
        const ceiling = Math.min(
          event.request.expiresAt + MAX_EXTENSION_MS,
          event.request.autoResolvesAt ?? Number.MAX_SAFE_INTEGER
        )
        this.pendingUserInput.set(event.request.id, {
          request: event.request,
          timer: this.armUserInputTimer(event.request.id, event.request.expiresAt),
          expiresAt: event.request.expiresAt,
          ceiling,
        })

        /*
         * Answered *after* being registered, which is the whole point of the
         * ordering.
         *
         * `answerUserInput` looks the request up in `pendingUserInput` and
         * returns silently when it is not there — a deliberate guard against
         * double-submits. Called before the `set` above, as this was, it hit
         * that guard every time: the provider was never told, and the turn this
         * branch exists to unblock stayed blocked forever. The timer is set and
         * immediately cleared by the answer, which costs nothing and keeps one
         * path through this case rather than two.
         */
        if (this.neverAsks) {
          void this.answerUserInput(event.request.id, { outcome: 'timeout' }, 'system')
        }
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

      /*
       * Pushed, not appended — the same treatment as `limits`, and for the
       * reason given on the event: it is the agent's current state rather than
       * something that happened in the conversation, and compaction resets it.
       */
      case 'context.usage':
        this.onContextUsage?.({
          usedTokens: event.usedTokens,
          maxTokens: event.maxTokens,
          percentUsed: event.percentUsed,
        })
        return

      /*
       * Pushed like the two above, and for the same reason: a list of processes
       * that stop existing when the session does is state, not history.
       *
       * Passed on whole every time, including when it is empty. The provider's
       * payload replaces rather than merges, so an empty list is not "no news" —
       * it is the only way anyone learns the last task finished.
       */
      case 'tasks.changed':
        this.onTasks?.(event.tasks)
        return

      case 'usage.updated':
        this.lifecycle({
          type: 'usage.updated',
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd ?? null,
        })
        return

      /*
       * Recorded, not merely shown: the moment an agent stopped holding the
       * whole conversation is a fact about that conversation, and one you would
       * want when reading the log back and wondering why it forgot something.
       */
      case 'context.compacted':
        this.lifecycle({ type: 'context.compacted' })
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

      case 'tool.started':
        this.lifecycle({
          type: 'tool.started',
          itemRef: event.itemRef,
          name: event.name,
          parentRef: event.parentRef ?? null,
          detail: event.detail ?? null,
        })
        return

      case 'tool.progress':
        this.lifecycle({
          type: 'tool.progress',
          itemRef: event.itemRef,
          note: event.note ?? null,
          elapsedMs: event.elapsedMs ?? null,
        })
        return

      case 'tool.completed':
        this.lifecycle({
          type: 'tool.completed',
          itemRef: event.itemRef,
          status: event.status,
          summary: event.summary ?? null,
          patch: event.patch ?? null,
          omittedLines: event.omittedLines ?? null,
        })
        return

      case 'notice':
        this.lifecycle({
          type: 'notice.raised',
          level: event.level,
          source: event.source,
          text: event.text,
          detail: event.detail ?? null,
        })
        return
    }
  }

  /**
   * Tells the provider to accept edits from now on.
   *
   * Best effort by design: a provider that cannot be told simply keeps asking,
   * which is a worse experience and not a broken one. Failing the decision the
   * user just made because a preference could not be forwarded would be the
   * wrong trade.
   */
  /**
   * Returns the session to ordinary permissions once a plan is approved.
   *
   * Told upward as well as forwarded down, because the mode belongs to the
   * conversation and something has to keep the control that turned it on
   * honest.
   */
  private async leavePlanMode(): Promise<void> {
    try {
      await this.session?.setPermissionMode?.('default')
      this.onPlanExited?.()
    } catch {
      // The turn is already approved; a mode that failed to change is a worse
      // experience than a failed decision, not a broken one.
    }
  }

  private async acceptEditsFromNowOn(): Promise<void> {
    try {
      await this.session?.setPermissionMode?.('acceptEdits')
    } catch {
      // Nothing to report: the edits keep being asked about, which is safe.
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
