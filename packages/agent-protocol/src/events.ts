import type { AgentId } from '@chorus/shared'
import type { ApprovalRequest } from './approval.js'

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

export interface UsageUpdated extends AgentEventBase {
  readonly type: 'usage.updated'
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd?: number
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
  | TurnStarted
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
  | UsageUpdated
  | TurnCompleted
  | AgentError

export type AgentEventType = AgentEvent['type']

/**
 * Events that must never be dropped under backpressure. Text deltas may be
 * coalesced; lifecycle and approvals may not (plan §4.6).
 */
const UNDROPPABLE = new Set<AgentEventType>([
  'turn.started',
  'turn.completed',
  'approval.requested',
  'command.started',
  'command.completed',
  'file.change.proposed',
  'error',
])

export function isCoalescable(type: AgentEventType): boolean {
  return !UNDROPPABLE.has(type)
}
