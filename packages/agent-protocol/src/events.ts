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

export type AgentEvent =
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
