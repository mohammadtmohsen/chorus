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
  'error',
  // A dropped start leaves a row that never appears; a dropped completion
  // leaves one spinning forever. `tool.progress` is the only part that repeats.
  'tool.started',
  'tool.completed',
])

export function isCoalescable(type: AgentEventType): boolean {
  return !UNDROPPABLE.has(type)
}
