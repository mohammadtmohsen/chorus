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
  ModelChoice,
  ProviderPermissionMode,
  McpServerHealth,
  SlashCommandInfo,
  AgentCapabilities,
  AgentEvent,
  AgentInput,
  AgentSession,
  ApprovalDecision,
  HealthStatus,
  SessionOpts,
  UserInputResponse,
} from '@chorus/agent-protocol'
import {
  AsyncQueue,
  newApprovalId,
  newUserInputId,
  type AgentId,
  type ApprovalId,
  type UserInputId,
} from '@chorus/shared'
import {
  mapContextUsage,
  mapPlanUsage,
  mapSdkMessage,
  mapToolPermission,
  mapUserInputRequest,
  toClaudeUserInputResult,
  trackBashTools,
  trackStreamMessage,
} from './mapping.js'

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

/*
 * Three of these described the SDK's abilities rather than the adapter's, which
 * made them claims Chorus could not honour:
 *
 *  - `fork`: `AgentSession` has no fork method and no IPC channel reaches one.
 *    `conversation:restart` makes a *new* conversation, which is not a fork.
 *  - `planStream`: `plan.updated` is emitted only by the Codex adapter. Nothing
 *    in this package produces one.
 *  - `modelSwitchMidSession`: false again, and this one has been both. It was
 *    true while a card carried a per-conversation picker; that picker is gone —
 *    the model is chosen once, in settings, and reaches a session as
 *    `SessionOpts.model` at construction. `setModel` is still implemented, so a
 *    future caller costs nothing, but the flag describes what Chorus does rather
 *    than what the adapter could.
 *
 * Each flips back to true in the phase that gives it an implementation, not
 * before. A capability is a promise to the orchestrator, not a wish.
 */
export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  interrupt: true,
  steer: true,
  fork: false,
  reasoningStream: true,
  planStream: false,
  // Claude has no aggregate turn diff; the workspace service derives one (§4.2).
  aggregateDiff: false,
  modelSwitchMidSession: false,
  sandboxPolicy: 'emulated',
}

export interface ClaudeAdapterOptions {
  readonly command?: string
  readonly executablePath?: string
  /**
   * Finds the binary when the usual places do not have it.
   *
   * Asked once, lazily, for the same reason Codex's is: a packaged app has no
   * terminal PATH, and the SDK's own failure for a missing binary blames the
   * architecture rather than the lookup.
   */
  readonly resolveExecutablePath?: () => Promise<string | null>
  readonly approvalTtlMs?: number
  readonly now?: () => number
  /** Injected in tests so no real CLI is spawned. */
  readonly createQuery?: (options: Options, prompt: AsyncIterable<unknown>) => Query
}

/**
 * The third argument to `canUseTool`, which this adapter used to ignore.
 *
 * Typed here rather than imported: the SDK's own type is an inline object
 * literal on the `CanUseTool` alias with no exported name, and the alternative
 * is a structural any at every call site.
 */
type CanUseToolOptions = Parameters<NonNullable<Options['canUseTool']>>[2]

/** An unknown status reads as pending, which is the one that claims least. */
const KNOWN_STATUS = new Set(['connected', 'failed', 'needs-auth', 'pending', 'disabled'])

interface PendingApproval {
  resolve: (result: PermissionResult) => void
  toolName: string
  input: Record<string, unknown>
  /**
   * The provider's own "you will not be asked again" rules.
   *
   * Held rather than mapped because they are opaque to Chorus: they are the
   * CLI's rule objects, and the only correct thing to do with them is hand the
   * whole set back as `updatedPermissions` when the user says always. Reading
   * or rewriting them would be inventing policy the CLI did not offer.
   */
  suggestions?: unknown[]
}

export class ClaudeSession implements AgentSession {
  private readonly queue = new AsyncQueue<AgentEvent>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  /**
   * Open question sets. Holds the original input because the answer goes back
   * as `updatedInput`, which the CLI matches against what it sent.
   */
  private readonly pendingUserInputs = new Map<
    string,
    { resolve: (result: PermissionResult) => void; input: Record<string, unknown> }
  >()
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
    const receipt = await this.q.interrupt()

    /*
     * What the stop did not stop.
     *
     * Queued async messages outlive an interrupt by design, and the receipt is
     * the only place that says so. Discarding it left a user who pressed Stop
     * watching the agent start again on something they no longer wanted, with
     * nothing anywhere explaining why. Older CLIs resolve to `undefined`, which
     * is not a failure — it is a CLI that cannot tell us.
     */
    const queued = (receipt as { still_queued?: unknown } | undefined)?.still_queued
    if (Array.isArray(queued) && queued.length > 0) {
      this.emit({
        agentId: 'claude',
        seq: ++this.seq,
        at: this.now(),
        type: 'notice',
        level: 'warn',
        source: 'system',
        text: `${String(queued.length)} queued`,
      })
    }
  }

  respondToApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(id)
    if (pending === undefined) return Promise.resolve()
    this.pendingApprovals.delete(id)

    if (decision.outcome === 'allow') {
      /*
       * "Always" answered in the provider's own terms.
       *
       * `suggestions` is the CLI's set of rules that would stop it asking again,
       * and handing the whole set back is what the SDK asks for. Chorus keeps
       * its own session grant either way — the two answer different questions:
       * the grant is what *Chorus* will stop asking about, and these are what
       * the *CLI* will. Sending only one of them left half the system still
       * prompting.
       *
       * Only on `session`. "Just this once" must not write a rule, which is the
       * entire difference between the two buttons.
       */
      const always = decision.scope === 'session' ? pending.suggestions : undefined
      pending.resolve({
        behavior: 'allow',
        updatedInput: decision.updatedInput ?? pending.input,
        ...(always === undefined || always.length === 0
          ? {}
          : { updatedPermissions: always as never }),
        // So the CLI's own record of what happened matches what happened.
        decisionClassification: decision.scope === 'session' ? 'user_permanent' : 'user_temporary',
      })
      return Promise.resolve()
    }

    pending.resolve({
      behavior: 'deny',
      message: decision.outcome === 'deny' ? decision.message : 'Cancelled',
      decisionClassification: 'user_reject',
    })
    return Promise.resolve()
  }

  setModel(model: string): Promise<void> {
    return this.q.setModel(model)
  }

  /**
   * The commands this session accepts.
   *
   * Asked rather than compiled in, and for a sharper reason than the model
   * list: these come from the project's own `.claude/commands`, its skills and
   * its plugins, so the answer is different in every repository and changes
   * while the app is running.
   *
   * Feature-detected like the rest, so an older CLI offers no menu rather than
   * failing a session.
   */
  async supportedCommands(): Promise<readonly SlashCommandInfo[]> {
    const ask = (this.q as unknown as { supportedCommands?: () => Promise<unknown> })
      .supportedCommands
    if (typeof ask !== 'function') return []

    try {
      const commands = await ask.call(this.q)
      if (!Array.isArray(commands)) return []
      return commands.flatMap((entry): SlashCommandInfo[] => {
        const row = entry as { name?: unknown; description?: unknown; argumentHint?: unknown }
        if (typeof row.name !== 'string' || row.name === '') return []
        return [
          {
            name: row.name,
            description: typeof row.description === 'string' ? row.description : '',
            argumentHint: typeof row.argumentHint === 'string' ? row.argumentHint : '',
          },
        ]
      })
    } catch {
      return []
    }
  }

  /**
   * How the inherited MCP servers are doing.
   *
   * `settingSources` is deliberately omitted so agents get the user's full
   * config, which means the servers are theirs and their failures are theirs
   * too — and none of those failures is loud. Feature-detected like the rest.
   */
  async mcpServerStatus(): Promise<readonly McpServerHealth[]> {
    const ask = (this.q as unknown as { mcpServerStatus?: () => Promise<unknown> }).mcpServerStatus
    if (typeof ask !== 'function') return []

    try {
      const servers = await ask.call(this.q)
      if (!Array.isArray(servers)) return []
      return servers.flatMap((entry): McpServerHealth[] => {
        const row = entry as {
          name?: unknown
          status?: unknown
          error?: unknown
          tools?: unknown
        }
        if (typeof row.name !== 'string' || row.name === '') return []
        const status = KNOWN_STATUS.has(row.status as string)
          ? (row.status as McpServerHealth['status'])
          : 'pending'
        return [
          {
            name: row.name,
            status,
            ...(typeof row.error === 'string' && row.error !== '' ? { error: row.error } : {}),
            ...(Array.isArray(row.tools) ? { tools: row.tools.length } : {}),
          },
        ]
      })
    } catch {
      return []
    }
  }

  /**
   * Hands edit decisions to the CLI for the rest of the session.
   *
   * The counterpart to `permissionMode: 'default'` above: that keeps every tool
   * flowing through the policy engine, and this is the user opting one category
   * back out of it. The cost is stated where it is set — an accepted edit is no
   * longer seen by any rule, including the credential one — which is why it
   * takes a deliberate "always" and not a setting.
   */
  async setPermissionMode(mode: ProviderPermissionMode): Promise<void> {
    await this.q.setPermissionMode(mode)
  }

  /**
   * Reasoning effort, through the flag-settings layer.
   *
   * There is no `setEffort`; the CLI takes it as a setting override, and only in
   * streaming input mode — which is the mode this adapter already runs in, and
   * the same reason `setModel` and `interrupt` are available at all.
   *
   * `max` is session-scoped by the CLI's own contract: it applies for the rest
   * of the session and is never written to a settings file. Chorus's own default
   * is applied at every session start, so a level chosen once in settings is in
   * force everywhere without either side having to persist it.
   */
  async setEffort(level: string): Promise<void> {
    const apply = (
      this.q as unknown as {
        applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>
      }
    ).applyFlagSettings
    // Feature-detected like the usage reads: an older CLI simply has no such
    // control, and a session must not fail because a preference could not apply.
    if (typeof apply !== 'function') return
    await apply.call(this.q, { effortLevel: level })
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
    // Same reasoning for questions: an unanswered one holds `canUseTool` open
    // forever, and the SDK imposes no deadline of its own.
    for (const [, pending] of this.pendingUserInputs) {
      pending.resolve({ behavior: 'deny', message: 'Session closed' })
    }
    this.pendingUserInputs.clear()
    this.q.close()
    this.queue.close()
    return Promise.resolve()
  }

  respondToUserInput(id: UserInputId, response: UserInputResponse): Promise<void> {
    const pending = this.pendingUserInputs.get(id)
    if (pending === undefined) return Promise.resolve()
    this.pendingUserInputs.delete(id)
    pending.resolve(toClaudeUserInputResult(pending.input, response))
    return Promise.resolve()
  }

  /**
   * Bridges the SDK's `canUseTool` into the approval queue — or, for
   * `AskUserQuestion`, into the question queue.
   *
   * Claude routes *every* tool through this one callback, so the split has to
   * happen here. Before it existed a question was mapped as an ordinary
   * permission and rendered as "claude needs approval" with Allow/Deny; allowing
   * it returned no answer, so the agent learned nothing and the user had no way
   * to reply. The question branch returns early and the approval path below is
   * untouched, which is what keeps this from being a change to every tool.
   */
  handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    options?: CanUseToolOptions
  ): Promise<PermissionResult> {
    const ctx = { seq: this.seq + 1, now: this.now(), approvalTtlMs: this.approvalTtlMs }

    const questionId = newUserInputId()
    const question = mapUserInputRequest(toolName, input, ctx, questionId)
    if (question !== null) {
      return new Promise<PermissionResult>((resolve) => {
        this.pendingUserInputs.set(questionId, { resolve, input })
        this.emit({
          agentId: 'claude',
          seq: ++this.seq,
          at: this.now(),
          type: 'userinput.requested',
          request: question,
        })
      })
    }

    const id = newApprovalId()
    /*
     * The provider's own words for what it is about to do.
     *
     * `title` is the sentence the bridge already rendered, and `blockedPath`
     * names a path that appears nowhere in the tool's arguments — a Bash
     * command reaching outside the allowed directories has it only here. Both
     * were being dropped along with the rest of the third parameter.
     */
    const request = mapToolPermission(toolName, input, ctx, id, {
      ...(options?.title === undefined ? {} : { title: options.title }),
      ...(options?.description === undefined ? {} : { description: options.description }),
      ...(options?.blockedPath === undefined ? {} : { blockedPath: options.blockedPath }),
      ...(options?.decisionReason === undefined ? {} : { decisionReason: options.decisionReason }),
    })

    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingApproval = {
        resolve,
        toolName,
        input,
        ...(options?.suggestions === undefined ? {} : { suggestions: options.suggestions }),
      }
      this.pendingApprovals.set(id, pending)

      /*
       * The CLI can give up on a request it is still waiting for — a turn
       * abandoned, a session torn down. Without this the card stayed on screen
       * asking about work nobody is doing any more, and answering it resolved a
       * promise the CLI had stopped listening to.
       */
      options?.signal.addEventListener(
        'abort',
        () => {
          if (!this.pendingApprovals.delete(id)) return
          resolve({ behavior: 'deny', message: 'The request was withdrawn.' })
        },
        { once: true }
      )

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

        const kind = (message as { type?: string; subtype?: string }).type
        // Both moments the plan windows are worth re-reading: when a session
        // opens, and when a turn has just spent something.
        if (kind === 'system' || kind === 'result') void this.readPlanUsage()
        // Only at the end of a turn: the window cannot have moved until the
        // agent has actually said something.
        if (kind === 'result') void this.readContextUsage()

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

  /**
   * Asks for the plan's usage windows.
   *
   * `rate_limit_event` only fires once a threshold is crossed, and carries the
   * one window that tripped it — so the five-hour figure was invisible until it
   * was nearly gone. This gives both windows on demand.
   *
   * The method is explicitly experimental and may be removed without notice, so
   * its absence is a normal outcome rather than an error: the event path still
   * works and the header just says less.
   */
  /**
   * The protocol's name for it, so the UI can ask without knowing which
   * provider it is asking. Everything below already existed and ran once at
   * session start; all that was missing was a way to ask again.
   */
  async readLimits(): Promise<void> {
    await this.readPlanUsage()
  }

  /**
   * Asks until the query is awake enough to answer, then stops.
   *
   * The read on `system` was the intended moment, but this adapter runs the SDK
   * in streaming-input mode: the query is lazy, so no `system` message arrives
   * until something is sent — and the account panel therefore stayed empty
   * until the user spent a turn. Which is precisely backwards, because the
   * moment you most want to know your remaining quota is before you spend it.
   *
   * Bounded and silent: three tries over about nine seconds, stopping at the
   * first that answers. An account with no plan window never answers, and that
   * is a normal outcome rather than something to report.
   */
  primeLimits(): void {
    void this.primeLimitsLoop()
  }

  private async primeLimitsLoop(): Promise<void> {
    for (const delay of [700, 2500, 6000]) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (this.closed) return
      if (await this.readPlanUsage()) return
    }
  }

  private async readPlanUsage(): Promise<boolean> {
    const ask = (
      this.q as unknown as {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>
      }
    ).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof ask !== 'function') return false

    try {
      const usage = await ask.call(this.q)
      const events = mapPlanUsage(usage, {
        agentId: 'claude',
        seq: this.seq + 1,
        at: this.now(),
      })
      for (const event of events) this.emit(event)
      // Whether it actually said anything, which is what the priming loop
      // needs to know — a call that succeeds and reports no windows has not
      // answered the question.
      return events.length > 0
    } catch {
      // Experimental, and answered only while the query is open. Neither is
      // worth a word in the transcript.
      return false
    }
  }

  /**
   * How full the context window is, read at the end of a turn.
   *
   * Turn boundaries rather than a timer: the figure only moves when the agent
   * has said something, and a timer would poll a number that cannot have
   * changed. It is also the moment the answer is actionable — deciding whether
   * to start a fresh conversation is a between-turns decision.
   *
   * Defensive in the same way as `readPlanUsage`: a method the installed CLI is
   * too old to have is a quieter panel, not an error.
   */
  private async readContextUsage(): Promise<void> {
    const ask = (this.q as unknown as { getContextUsage?: () => Promise<unknown> }).getContextUsage
    if (typeof ask !== 'function') return

    try {
      const usage = await ask.call(this.q)
      for (const event of mapContextUsage(usage, {
        agentId: 'claude',
        seq: this.seq + 1,
        at: this.now(),
      })) {
        this.emit(event)
      }
    } catch {
      // Answered only while the query is open, so a close mid-flight lands here.
    }
  }

  /**
   * The models this CLI will accept.
   *
   * Asked rather than hardcoded: the list belongs to the installed `claude`,
   * which self-updates, so a list compiled into Chorus would be wrong the week
   * after it shipped. Defensive in the same way as the usage reads — an older
   * CLI that cannot answer offers no choice rather than failing a session.
   */
  async supportedModels(): Promise<readonly ModelChoice[]> {
    const ask = (this.q as unknown as { supportedModels?: () => Promise<unknown> }).supportedModels
    if (typeof ask !== 'function') return []

    try {
      const models = await ask.call(this.q)
      if (!Array.isArray(models)) return []
      return models.flatMap((entry): ModelChoice[] => {
        const row = entry as {
          value?: unknown
          displayName?: unknown
          supportsEffort?: unknown
          supportedEffortLevels?: unknown
        }
        if (typeof row.value !== 'string' || row.value === '') return []
        const label =
          typeof row.displayName === 'string' && row.displayName !== ''
            ? row.displayName
            : row.value
        /*
         * Taken from the model rather than assumed. Every model this CLI
         * reports today lists the same five, but the flag and the list are
         * separate fields for a reason — and offering `max` on a model that
         * silently downgrades it would be a control that lies.
         */
        const effortLevels =
          row.supportsEffort === true && Array.isArray(row.supportedEffortLevels)
            ? row.supportedEffortLevels.filter(
                (level): level is string => typeof level === 'string'
              )
            : []
        return [{ value: row.value, label, ...(effortLevels.length === 0 ? {} : { effortLevels }) }]
      })
    } catch {
      return []
    }
  }

  /** Called from the PostCompact hook, which fires outside the message stream. */
  noteCompacted(): void {
    this.emit({
      agentId: 'claude',
      seq: ++this.seq,
      at: this.now(),
      type: 'context.compacted',
    })
  }

  private emit(event: AgentEvent): void {
    this.queue.push({ ...event, seq: ++this.seq })
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id: AgentId = 'claude'
  readonly capabilities = CLAUDE_CAPABILITIES

  private readonly command: string
  private executablePath: string | undefined
  private readonly resolveExecutablePath: (() => Promise<string | null>) | undefined
  private resolving: Promise<void> | null = null
  private readonly approvalTtlMs: number
  private readonly now: () => number
  private readonly createQuery:
    ((options: Options, prompt: AsyncIterable<unknown>) => Query) | undefined
  private readonly sessions: ClaudeSession[] = []

  constructor(options: ClaudeAdapterOptions = {}) {
    this.command = options.command ?? 'claude'
    this.executablePath = options.executablePath
    this.resolveExecutablePath = options.resolveExecutablePath
    this.approvalTtlMs = options.approvalTtlMs ?? 5 * 60_000
    this.now = options.now ?? (() => Date.now())
    this.createQuery = options.createQuery
  }

  /** Asked once, and only when the usual locations came up empty. */
  /**
   * The lookup, memoised as a **promise** rather than as a boolean.
   *
   * It was a boolean, set before the await, which meant a second caller arriving
   * while the first was still looking saw "already resolved" and carried on with
   * no path. `spawn` then omitted `pathToClaudeCodeExecutable`, the SDK looked
   * for its own bundled binary — deliberately excluded in `pnpm-workspace.yaml`
   * — and reported "Native CLI binary for darwin-arm64 not found", which blames
   * the install for a race.
   *
   * The window is wide: the lookup asks the user's shell twice with a ten-second
   * timeout each. `health()` calls this too, so probing agents at launch overlaps
   * with restoring conversations almost exactly.
   */
  private resolveOnce(): Promise<void> {
    const lookup = this.resolveExecutablePath
    if (lookup === undefined) return Promise.resolve()
    this.resolving ??= lookup()
      .then((found) => {
        if (found !== null) this.executablePath = found
      })
      .catch(() => {
        // Let a later start try again rather than caching the failure forever.
        this.resolving = null
      })
    return this.resolving
  }

  async health(): Promise<HealthStatus> {
    // Health runs before any session, so this is where the lookup lands.
    await this.resolveOnce()
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

  async start(opts: SessionOpts): Promise<AgentSession> {
    await this.resolveOnce()
    return Promise.resolve(this.spawn(opts, undefined))
  }

  async resume(sessionRef: string, opts: SessionOpts): Promise<AgentSession> {
    await this.resolveOnce()
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

    /*
     * Same reasoning, one layer out.
     *
     * When the lookup ran and found nothing, `pathToClaudeCodeExecutable` is
     * omitted and the SDK falls back to hunting for its own bundled binary —
     * which `pnpm-workspace.yaml` excludes on purpose, all eight platforms of
     * it, because darwin-arm64 alone unpacks to ~257 MB. What the user is then
     * told is:
     *
     *   Native CLI binary for darwin-arm64 not found. Reinstall
     *   @anthropic-ai/claude-agent-sdk without --omit=optional…
     *
     * Both of which are the wrong thing to do: Chorus drives the installed CLI
     * by design, and reinstalling would add a quarter of a gigabyte to work
     * around a missing PATH entry. Saying so here keeps the blame where it
     * belongs.
     *
     * Only when a resolver was supplied and came back empty. An adapter
     * constructed without one — every test in this package — is asking the SDK
     * to find its own way, and that is not this error.
     */
    if (this.resolveExecutablePath !== undefined && this.executablePath === undefined) {
      throw new Error(
        'Could not find the claude CLI. Chorus runs the one you have installed rather ' +
          'than shipping its own, so `claude` needs to be on your PATH — check with ' +
          '`which claude`, and install it if it is missing.'
      )
    }

    // canUseTool has to be captured before the session exists, but the SDK
    // only invokes it once the query is running — by which point it is set.
    const holder: { session?: ClaudeSession } = {}

    const options: Options = {
      cwd: opts.cwd,
      includePartialMessages: true,
      /*
       * Hook activity, which was mapped and never arrived.
       *
       * `mapping.ts` has treated `hook_response` since the transcript-fidelity
       * work, and the events are gated on this option — so a `PreToolUse` hook
       * that blocked a tool produced exactly the silence the mapping existed to
       * end. Reading the message union told us the shape and not that nothing
       * would send it; only `Options` says that.
       *
       * Affordable because the mapping is already selective: a hook that
       * succeeded with nothing to say emits nothing, and `hook_started` and
       * `hook_progress` are quiet. What is left is a hook that failed or spoke.
       */
      includeHookEvents: true,
      /*
       * Ask for thinking to be surfaced, or none arrives.
       *
       * `adaptive` is already the default on models that support it — Claude
       * decides when and how much to think — but the *display* is not. Measured
       * over a real turn: nine `agent.message.delta` and zero
       * `agent.reasoning.delta`, so `mapping.ts`'s `delta.thinking` branch never
       * ran and the transcript's "Show thinking" block was unreachable.
       *
       * `summarized` rather than a fixed `budgetTokens`: the budget form is for
       * older models and pins a cost whether or not the turn needs thinking,
       * while adaptive spends nothing on a question that does not warrant it.
       */
      thinking: { type: 'adaptive', display: 'summarized' },
      /*
       * The one moment the transcript and the agent stop agreeing.
       *
       * Claude reports compaction through a hook rather than the message
       * stream, which is why it went unnoticed while codex's `thread/compacted`
       * notification sat unread — two different shapes for the same fact.
       *
       * It matters that both report it. A marker that appears for one agent
       * teaches you to read its absence as "nothing was compacted", which would
       * be wrong every time the other agent did the compacting — worse than
       * having no marker at all.
       *
       * The summary itself is discarded: what a reader needs is where the line
       * falls, and the summary is the agent's own words about a conversation
       * already shown in full above it.
       */
      hooks: {
        PostCompact: [
          {
            hooks: [
              () => {
                holder.session?.noteCompacted()
                return Promise.resolve({ continue: true })
              },
            ],
          },
        ],
      },
      /*
       * Always `default`, so every tool goes through `canUseTool`.
       *
       * This was `acceptEdits` for any profile above read-only, which reads
       * like a convenience and is really a hole: `acceptEdits` makes the CLI
       * auto-accept file edits *without calling the permission callback at
       * all*, so Chorus's policy engine never saw them. Every rule that matches
       * a `fileChange` was dead — including `ask-credential-files`, which meant
       * an agent could write to `.env` or `~/.ssh` with nothing evaluating it,
       * in every profile.
       *
       * Nothing about the felt experience changes, because the profiles already
       * say the same thing and now get to: `workspace-write` carries
       * `allow-file-edits` and `trusted` carries `allow-edits`, both session
       * scope, so an ordinary edit is still auto-allowed — by the rule that was
       * written to allow it, which is the difference. Read-only asks, as it
       * always did.
       *
       * The permission decision belongs to one place. Two of them, one of which
       * silently outranks the other, is how a rule ends up dead without anyone
       * noticing.
       */
      permissionMode: 'default',
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(this.executablePath === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.executablePath }),
      ...(resume === undefined ? {} : { resume }),
      canUseTool: (toolName, input, options) => {
        const session = holder.session
        if (session === undefined) {
          // Fail closed: a permission we cannot route is a permission we deny.
          return Promise.resolve<PermissionResult>({
            behavior: 'deny',
            message: 'Session not ready',
          })
        }
        return session.handlePermission(toolName, input, options)
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

    // Not awaited: the caller wants a session, not a quota. It fills the
    // account panel a few seconds later, or never, and either is fine.
    session.primeLimits()

    this.sessions.push(session)
    return session
  }
}
