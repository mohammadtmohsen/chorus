import type { AgentId, ApprovalId } from '@chorus/shared'

/**
 * The four things an agent can ask permission for. Both providers' native
 * approval shapes collapse onto this so one card renders all of them (plan §4.2).
 */
export type ApprovalKind = 'command' | 'fileChange' | 'permissionGrant' | 'mcpToolCall'

export interface ApprovalRequestBase {
  readonly id: ApprovalId
  readonly agentId: AgentId
  readonly kind: ApprovalKind
  readonly reason?: string
  /** Wall-clock deadline. Chorus owns this — neither provider imposes one (plan §2.2). */
  readonly expiresAt: number
}

export interface CommandApproval extends ApprovalRequestBase {
  readonly kind: 'command'
  readonly command: readonly string[]
  readonly cwd: string
  readonly withNetwork: boolean
}

export interface FileChangeApproval extends ApprovalRequestBase {
  readonly kind: 'fileChange'
  readonly files: readonly { readonly path: string; readonly patch: string }[]
}

export interface PermissionGrantApproval extends ApprovalRequestBase {
  readonly kind: 'permissionGrant'
  readonly cwd: string
  readonly requested: {
    readonly filesystem?: readonly string[]
    readonly network?: boolean
  }
}

/**
 * Outward-facing by nature — Slack, Jira, GitHub. Unlike a file edit, these are
 * not recoverable with `git checkout`, which is why a permission profile may
 * never auto-allow one (plan §2.6).
 */
export interface McpToolCallApproval extends ApprovalRequestBase {
  readonly kind: 'mcpToolCall'
  readonly serverName: string
  readonly toolName: string
  /** Human-readable target: "#engineering", "ACME-1234", "owner/repo#42". */
  readonly target?: string
  readonly input: Readonly<Record<string, unknown>>
}

export type ApprovalRequest =
  CommandApproval | FileChangeApproval | PermissionGrantApproval | McpToolCallApproval

export type ApprovalScope = 'once' | 'session'

export type ApprovalDecision =
  | {
      readonly outcome: 'allow'
      readonly scope: ApprovalScope
      readonly updatedInput?: Readonly<Record<string, unknown>>
    }
  | { readonly outcome: 'deny'; readonly message: string; readonly interrupt?: boolean }
  | { readonly outcome: 'cancel' }
  /** Deadline passed with no answer. Always denies — never auto-allows (plan §4.4). */
  | { readonly outcome: 'timeout' }

/** True for approval kinds that a permission profile is forbidden from auto-allowing. */
export function requiresExplicitUserDecision(kind: ApprovalKind): boolean {
  return kind === 'mcpToolCall'
}
