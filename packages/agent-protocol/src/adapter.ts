import type { AgentId, ApprovalId, UserInputId } from '@chorus/shared'
import type { ApprovalDecision } from './approval.js'
import type { UserInputResponse } from './user-input.js'
import type { AgentEvent } from './events.js'

/**
 * Declared, never assumed. The UI hides a Steer button for an agent that cannot
 * steer rather than discovering it at runtime (plan §4.1).
 */
export interface AgentCapabilities {
  readonly interrupt: boolean
  readonly steer: boolean
  readonly fork: boolean
  readonly reasoningStream: boolean
  readonly planStream: boolean
  /** True when the provider emits an aggregate turn diff; false means we derive it from git. */
  readonly aggregateDiff: boolean
  readonly modelSwitchMidSession: boolean
  readonly sandboxPolicy: 'native' | 'emulated' | 'none'
}

export interface SandboxPolicy {
  readonly mode: 'readOnly' | 'workspaceWrite' | 'fullAccess'
  readonly writableRoots: readonly string[]
  readonly networkAccess: boolean
}

export interface SessionOpts {
  readonly cwd: string
  readonly model?: string
  readonly sandbox: SandboxPolicy
}

export interface AgentInput {
  readonly text: string
  readonly attachments?: readonly { readonly path: string }[]
}

export type HealthStatus =
  | { readonly state: 'ready'; readonly version: string }
  | { readonly state: 'unauthenticated'; readonly hint: string }
  | { readonly state: 'unavailable'; readonly reason: string }

export interface AgentSession {
  /** Provider-native id — a Codex threadId or a Claude sessionId. */
  readonly sessionRef: string
  /** Starts a turn, or steers the in-flight one when the agent supports it. */
  send(input: AgentInput): Promise<void>
  interrupt(): Promise<void>
  /** Normalized, ordered, at-least-once. */
  readonly events: AsyncIterable<AgentEvent>
  respondToApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void>
  /**
   * Answers a question set. Separate from `respondToApproval` because the two
   * are different acts: an approval is settled by a verdict, a question by
   * content. Sharing one method would mean a decision type that is a verdict
   * *or* a payload, and every caller branching on which.
   */
  respondToUserInput(id: UserInputId, response: UserInputResponse): Promise<void>
  setModel?(model: string): Promise<void>
  close(): Promise<void>
}

/**
 * The port every provider difference is absorbed behind. If this is right,
 * adding a third agent is a package rather than a refactor.
 */
export interface AgentAdapter {
  readonly id: AgentId
  readonly capabilities: AgentCapabilities
  start(opts: SessionOpts): Promise<AgentSession>
  resume(sessionRef: string, opts: SessionOpts): Promise<AgentSession>
  /** Also reports the underlying CLI version, which is recorded on session.started (plan §2.5). */
  health(): Promise<HealthStatus>
  dispose(): Promise<void>
}
