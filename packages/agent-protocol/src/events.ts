import type { AgentId } from '@chorus/shared'
import type { ApprovalRequest } from './approval.js'
import type { UserInputRequest } from './user-input.js'

/**
 * The normalized event union both providers project onto (plan §4.2).
 *
 * PRE-SPIKE: this shape is derived from the Codex app-server protocol reference
 * and the Claude Agent SDK `.d.ts`, but spikes S1–S3 may still move it. Treat it
 * as the target, not as settled.
 *
 * Nothing provider-specific may leak past the adapter boundary except `raw`,
 * which exists only for debugging and replay.
 */
interface AgentEventBase {
  readonly agentId: AgentId
  /** Monotonic per session. The orchestrator assigns the global order on append. */
  readonly seq: number
  readonly at: number
  /** Opaque provider payload. Never branch on this outside the adapter that made it. */
  readonly raw?: unknown
}

export interface TurnStarted extends AgentEventBase {
  readonly type: 'turn.started'
  readonly turnRef: string
}

export interface MessageDelta extends AgentEventBase {
  readonly type: 'message.delta'
  readonly itemRef: string
  readonly text: string
}

export interface MessageCompleted extends AgentEventBase {
  readonly type: 'message.completed'
  readonly itemRef: string
  readonly text: string
}

export interface ReasoningDelta extends AgentEventBase {
  readonly type: 'reasoning.delta'
  readonly itemRef: string
  readonly text: string
}

export interface PlanUpdated extends AgentEventBase {
  readonly type: 'plan.updated'
  readonly steps: readonly { readonly text: string; readonly done: boolean }[]
}

export interface CommandStarted extends AgentEventBase {
  readonly type: 'command.started'
  readonly itemRef: string
  readonly command: readonly string[]
  readonly cwd: string
}

export interface CommandOutput extends AgentEventBase {
  readonly type: 'command.output'
  readonly itemRef: string
  readonly stream: 'stdout' | 'stderr'
  readonly chunk: string
}

export interface CommandCompleted extends AgentEventBase {
  readonly type: 'command.completed'
  readonly itemRef: string
  readonly exitCode: number | null
}

export interface FileChangeProposed extends AgentEventBase {
  readonly type: 'file.change.proposed'
  readonly itemRef: string
  readonly files: readonly { readonly path: string; readonly patch: string }[]
}

/**
 * What a file operation actually did, as opposed to what it offered to do.
 *
 * `file.change.proposed` is raised when the operation *starts*, so a patch the
 * user declined or one that failed to apply looks exactly like one that landed.
 * Anything claiming to show what a turn changed has to read this instead.
 *
 * **The counts are computed in the adapter, and the patch is normalized there
 * too.** Codex's own `diff` field is not uniformly a diff — an `add` and a
 * `delete` carry the raw file, and only an `update` carries hunks, without the
 * `diff --git` header `parseDiff` needs. Parsed downstream it yields nothing at
 * all: no files, no counts, an empty card. So the adapter does the arithmetic
 * and hands on a patch that is git-format by construction, which is what lets
 * one renderer draw both providers' edits.
 *
 * `change` is provider-neutral for the same reason `kind` does not appear here:
 * Codex's `PatchChangeKind` is a tagged object carrying `move_path`, and letting
 * it through would put one provider's spelling of "rename" in everyone's types.
 */
export interface FileChangeCompleted extends AgentEventBase {
  readonly type: 'file.change.completed'
  readonly itemRef: string
  readonly files: readonly {
    readonly path: string
    /** Set only for a rename: where the file was before it moved. */
    readonly oldPath?: string
    readonly change: 'added' | 'removed' | 'modified' | 'renamed'
    readonly added: number
    readonly removed: number
    /** git-format, so one parser reads every provider's edits. */
    readonly patch: string
    /** Lines left out of `patch` to keep a whole added or deleted file bounded. */
    readonly omittedLines?: number
  }[]
  /**
   * `failed` and `declined` are kept apart deliberately. A patch the user
   * refused and one that broke are the same to a card that draws neither, and
   * completely different to anyone asking why the file is unchanged.
   */
  readonly outcome: 'applied' | 'failed' | 'declined'
}

/**
 * Codex emits an aggregate turn diff natively; for Claude the workspace service
 * derives it from git. Same event either way (plan §4.2).
 */
export interface DiffUpdated extends AgentEventBase {
  readonly type: 'diff.updated'
  readonly unifiedDiff: string
}

export interface ApprovalRequested extends AgentEventBase {
  readonly type: 'approval.requested'
  readonly request: ApprovalRequest
}

/**
 * The agent is asking, not proposing. Blocks the turn exactly like an approval,
 * which is why it shares the queue and the undroppable list.
 */
export interface UserInputRequested extends AgentEventBase {
  readonly type: 'userinput.requested'
  readonly request: UserInputRequest
}

export interface UsageUpdated extends AgentEventBase {
  readonly type: 'usage.updated'
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd?: number
}

/**
 * The agent summarised its own history to stay inside the context window.
 *
 * Worth recording because it is the one moment the transcript and the agent
 * stop agreeing. Everything above stays on screen and reads as shared history,
 * while the agent now holds a summary of it — so a message you can still point
 * at is not necessarily one it can still recall. Both CLIs do this on their own
 * schedule; all we can do is say when.
 */
export interface ContextCompacted extends AgentEventBase {
  readonly type: 'context.compacted'
}

export interface TurnCompleted extends AgentEventBase {
  readonly type: 'turn.completed'
  readonly turnRef: string
  readonly status: 'completed' | 'interrupted' | 'failed'
}

export interface AgentError extends AgentEventBase {
  readonly type: 'error'
  readonly message: string
  readonly recoverable: boolean
}

/**
 * A tool call that is not a shell command.
 *
 * `command.*` keeps Bash, because stdout, stderr and an exit code are real
 * there and nowhere else. Everything else — a file read, a search, a subagent —
 * has a name, maybe a one-line subject, and an outcome, which is this.
 *
 * A subagent needs no family of its own: `Task` *is* a tool call, and the
 * provider reports its progress against the same id, so nesting is `parentRef`
 * rather than a second set of events to keep in step with this one.
 */
export interface ToolStarted extends AgentEventBase {
  readonly type: 'tool.started'
  readonly itemRef: string
  readonly name: string
  /** The enclosing tool call, when this one happened inside a subagent. */
  readonly parentRef?: string
  /** One line: the path read, the pattern searched, the subagent's brief. */
  readonly detail?: string
  /**
   * The file this call is about, when it is about one.
   *
   * **Separate from `detail`, which is a display string and cannot be used.**
   * `detail` is whichever input field best identifies the call — a pattern, a
   * URL, a subagent's brief — and it is truncated to a line before it is ever
   * stored. Clicking a row to open what it names therefore needs the path as
   * data: untruncated, and present only when the row really does name a file.
   *
   * As the provider gave it, absolute or relative. Nothing here resolves it;
   * main does, against the conversation's own directory, because a path from a
   * renderer is not something to hand to a process untested.
   */
  readonly path?: string
}

export interface ToolProgress extends AgentEventBase {
  readonly type: 'tool.progress'
  readonly itemRef: string
  readonly note?: string
  readonly elapsedMs?: number
}

export interface ToolCompleted extends AgentEventBase {
  readonly type: 'tool.completed'
  readonly itemRef: string
  readonly status: 'ok' | 'error'
  readonly summary?: string
  /**
   * A unified diff of what a file-mutating tool actually changed.
   *
   * It rides on the *result*, not on `tool.started`, because a patch on the call
   * would record a change the agent proposed — a denied or failed edit would
   * leave a durable diff of something that never happened. Here it describes
   * what the file became.
   *
   * A string rather than structured hunks, and named `patch`, so it passes
   * through `redactPayload`'s TEXT_FIELDS on the way to disk. Structured hunks
   * would sit under a key called `lines`, redaction would never fire, and a
   * secret an agent edited would be written into the log verbatim.
   */
  readonly patch?: string
  /**
   * Lines dropped from `patch` to keep it bounded, or absent when it is whole.
   *
   * A count rather than a marker inside the diff text: the log is durable and
   * has no translator, so the renderer is what turns this into words.
   */
  readonly omittedLines?: number
}

/** Who is speaking when a notice appears. The renderer labels the row from this. */
export type NoticeSource = 'hook' | 'command' | 'retry' | 'denial' | 'system'

/**
 * Something the harness did, as opposed to something the agent said.
 *
 * One event rather than one per provider subtype. The renderer's job is
 * identical for all of them — a muted line, expandable when there is detail —
 * and providers add subtypes faster than we will add cases, so an unmapped one
 * degrades to a notice instead of to silence. Inverting that default is the
 * whole point: a hook that blocks a tool used to leave no trace at all.
 *
 * `text` holds the provider's own words and is never composed here, so the
 * renderer can put a translated label in front of it without stitching two
 * languages together.
 */
export interface Notice extends AgentEventBase {
  readonly type: 'notice'
  readonly level: 'info' | 'warn' | 'error'
  readonly source: NoticeSource
  readonly text: string
  readonly detail?: string
}

/**
 * One of an account's usage windows, as the provider reports it.
 *
 * Both providers publish this and neither calls it the same thing: Codex sends
 * `primary`/`secondary` with a duration in minutes, Claude sends `five_hour` and
 * `seven_day` with a percentage. Normalising to "how full, how long, when it
 * resets" is the whole job — the UI should not have to know whose limits it is
 * drawing.
 */
export interface UsageWindow {
  /** Stable enough to key a list on, and to tell two windows apart. */
  readonly id: string
  /** How full, 0-100. Null when the provider reports a window but not its use. */
  readonly usedPercent: number | null
  /** Length of the window in minutes, when known — 300 for five hours. */
  readonly windowMinutes: number | null
  /** Epoch milliseconds, or null when the provider did not say. */
  readonly resetsAt: number | null
}

/**
 * Epoch milliseconds, whatever the provider sent.
 *
 * Both send seconds, and both type them as bare numbers. A value that small
 * cannot be milliseconds — it would be 1970 — so the units are recoverable, and
 * recovering them here means neither adapter has to remember.
 */
export function toEpochMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
}

export interface LimitsUpdated extends AgentEventBase {
  readonly type: 'limits'
  readonly windows: readonly UsageWindow[]
}

/**
 * How full the agent's context window is right now.
 *
 * State, not history — the same category as `LimitsUpdated`, and never written
 * to the event log for the same reason. It is a measurement of the agent, not
 * something that happened in the conversation, and compaction resets it: a
 * stored series would read as a history of a number that repeatedly went
 * backwards for reasons the log does not explain.
 *
 * Worth surfacing because it is the one figure that says a compaction is
 * coming, and compaction is the moment the transcript and the agent's memory of
 * it stop agreeing (see `ContextCompacted`).
 */
export interface ContextUsage extends AgentEventBase {
  readonly type: 'context.usage'
  readonly usedTokens: number
  readonly maxTokens: number
  /** 0-100, derived here so no reader has to guess the provider's units. */
  readonly percentUsed: number
}

/** One thing the agent left running when it stopped waiting for it. */
export interface BackgroundTask {
  readonly id: string
  /** `shell`, `subagent`, and whatever else the provider grows. */
  readonly kind: string
  readonly description: string
}

/**
 * Everything the agent has running in the background, after the last change.
 *
 * State, not history, and the third member of that family after `LimitsUpdated`
 * and `ContextUsage`. A list of processes that stopped existing when the session
 * did is the clearest case of the test: read back a week later it is worse than
 * having none.
 *
 * **Replace, never merge.** The provider documents its payload as "every live
 * background task after the change", which is what makes this cheap — there is
 * no accumulation from turn zero and nothing to reconcile, so a client that
 * attaches halfway through is whole again at the next change.
 */
export interface TasksChanged extends AgentEventBase {
  readonly type: 'tasks.changed'
  readonly tasks: readonly BackgroundTask[]
}

/**
 * What the agent says it is doing right now, in its own terms.
 *
 * A key rather than a sentence, because nothing down here has a translator and
 * a phrase composed in an adapter would be English written into a stream the
 * renderer is supposed to word. The renderer turns these into language, the way
 * it already does for `notice.source`.
 *
 * `requesting` and `compacting` are the provider's own two, verbatim.
 * `thinking` is reported as a token count and read here as a state, because a
 * number is not what a person waiting wants. `awaitingInput` is the SDK's
 * `requires_action`, renamed only to say who is being waited on.
 */
export type AgentActivity = 'requesting' | 'compacting' | 'thinking' | 'awaitingInput'

/**
 * The fourth member of the state family, and the one that changes fastest.
 *
 * **Never logged, and this is the sharpest case of the rule.** `status` is the
 * spinner's heartbeat: written to SQLite it would append for as long as a turn
 * runs, and read back a week later "claude was requesting at 09:23" is worse
 * than nothing. It is exactly what `LimitsUpdated` and `ContextUsage` are —
 * a fact about the agent now, not about the conversation.
 *
 * `null` means the agent is working but has not said what at, which is most of
 * a turn. It clears the last word rather than leaving it standing: a line that
 * still said _compacting_ ten minutes after the compaction would be worse than
 * one that says only that work is happening.
 *
 * It says nothing about whether a turn is running. `turn.started` and
 * `turn.completed` are the boundaries and they are history; this only ever
 * refines what an already-visible working line says.
 */
export interface ActivityChanged extends AgentEventBase {
  readonly type: 'activity.changed'
  readonly activity: AgentActivity | null
}

export type AgentEvent =
  /*
   * Account-wide usage limits, not conversation history.
   *
   * Deliberately never written to the event log: the log records what happened
   * in a conversation, and how full an account's weekly window is happened to
   * the account. It is state, and stale state read back a week later would be
   * worse than none.
   */
  | LimitsUpdated
  /*
   * Also state rather than history, and also never logged. See `ContextUsage`.
   */
  | ContextUsage
  /*
   * The third of the same kind. Never logged; replaces rather than accumulates.
   */
  | TasksChanged
  /*
   * The fourth, and the one the rule was hardest to hold for: it arrives many
   * times a turn. Never logged; see `ActivityChanged`.
   */
  | ActivityChanged
  | TurnStarted
  | ContextCompacted
  | MessageDelta
  | MessageCompleted
  | ReasoningDelta
  | PlanUpdated
  | CommandStarted
  | CommandOutput
  | CommandCompleted
  | FileChangeProposed
  | FileChangeCompleted
  | DiffUpdated
  | ApprovalRequested
  | UserInputRequested
  | UsageUpdated
  | TurnCompleted
  | AgentError
  | Notice
  | ToolStarted
  | ToolProgress
  | ToolCompleted

export type AgentEventType = AgentEvent['type']

/**
 * Events that must never be dropped under backpressure. Text deltas may be
 * coalesced; lifecycle and approvals may not (plan §4.6).
 */
const UNDROPPABLE = new Set<AgentEventType>([
  'turn.started',
  'turn.completed',
  'approval.requested',
  // Dropping one wedges the turn: the agent waits for an answer to a question
  // the user was never shown.
  'userinput.requested',
  'command.started',
  'command.completed',
  'file.change.proposed',
  // The proposal is already undroppable, so dropping the result would leave the
  // one pairing worse than losing both: "about to change this file", and never
  // whether it did.
  'file.change.completed',
  'error',
  // A dropped start leaves a row that never appears; a dropped completion
  // leaves one spinning forever. `tool.progress` is the only part that repeats.
  'tool.started',
  'tool.completed',
])

export function isCoalescable(type: AgentEventType): boolean {
  return !UNDROPPABLE.has(type)
}
