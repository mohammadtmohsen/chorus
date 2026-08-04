import { requiresExplicitUserDecision, type ApprovalRequest } from '@chorus/agent-protocol'
import { matches, subjectOf, type PermissionProfile, type Rule } from './rules.js'

/**
 * Decides an approval before it ever reaches the user.
 *
 * This is the security boundary (plan §8), so the ordering below is the whole
 * design and is deliberately rigid:
 *
 *   1. Kinds that may never be auto-decided — no profile and no grant can
 *      override them.
 *   2. Deny rules. A deny is absolute; nothing later can un-deny.
 *   3. Session grants the user made themselves.
 *   4. Allow rules from the profile.
 *   5. Otherwise ask.
 *
 * Denies are evaluated before grants on purpose: "allow for session" should
 * widen what the profile permits, never reach past what it forbids.
 */

export type PolicyDecision =
  | { readonly decision: 'allow'; readonly ruleId: string; readonly scope: 'once' | 'session' }
  | { readonly decision: 'deny'; readonly ruleId: string; readonly reason: string }
  | { readonly decision: 'ask'; readonly reason: string }

/**
 * A grant the user made with "allow for session".
 *
 * Keyed by kind plus subject so it applies to the same action again, not to
 * everything that agent might later do. Grants live in memory only — a session
 * grant that outlived the window it was made in would be a permission the user
 * never knowingly gave.
 */
export interface SessionGrant {
  readonly key: string
  readonly describe: string
}

export function grantKey(request: ApprovalRequest): string {
  const { command, paths } = subjectOf(request)
  const subject = command !== '' ? command : paths.join(',')
  return `${request.agentId}:${request.kind}:${subject}`
}

export class SessionGrants {
  private readonly granted = new Map<string, SessionGrant>()

  /** Returns false for kinds that may never be granted ahead of time. */
  add(request: ApprovalRequest): boolean {
    if (requiresExplicitUserDecision(request.kind)) return false
    const key = grantKey(request)
    this.granted.set(key, { key, describe: describeRequest(request) })
    return true
  }

  has(request: ApprovalRequest): boolean {
    return this.granted.has(grantKey(request))
  }

  list(): SessionGrant[] {
    return [...this.granted.values()]
  }

  clear(): void {
    this.granted.clear()
  }
}

export function evaluate(
  request: ApprovalRequest,
  profile: PermissionProfile,
  grants?: SessionGrants
): PolicyDecision {
  // 1. Outward-facing actions are never decided for the user. A sent Slack
  //    message is not recoverable the way a file edit is (plan §2.6).
  if (requiresExplicitUserDecision(request.kind)) {
    return { decision: 'ask', reason: 'Outward-facing actions always need a person' }
  }

  // 2. Denies are absolute.
  const denial = firstMatch(profile.rules, request, 'deny')
  if (denial !== undefined) {
    return { decision: 'deny', ruleId: denial.id, reason: denial.describe }
  }

  // An explicit `ask` rule outranks a later allow — it is how a profile carves
  // an exception out of its own permissiveness.
  const asked = firstMatch(profile.rules, request, 'ask')
  if (asked !== undefined) {
    return { decision: 'ask', reason: asked.describe }
  }

  // 3. Something the user already allowed for this session.
  if (grants?.has(request) === true) {
    return { decision: 'allow', ruleId: 'session-grant', scope: 'session' }
  }

  // 4. The profile's own allowances.
  const allowed = firstMatch(profile.rules, request, 'allow')
  if (allowed !== undefined) {
    return { decision: 'allow', ruleId: allowed.id, scope: allowed.scope ?? 'once' }
  }

  return { decision: 'ask', reason: `${profile.name} does not cover this` }
}

function firstMatch(
  rules: readonly Rule[],
  request: ApprovalRequest,
  effect: Rule['effect']
): Rule | undefined {
  return rules.find((rule) => rule.effect === effect && matches(rule, request))
}

/** A short human description, used in the grant list and the audit trail. */
export function describeRequest(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'command':
      return request.command.join(' ')
    case 'fileChange':
      return request.files.map((f) => f.path).join(', ')
    case 'permissionGrant':
      return [
        ...(request.requested.filesystem ?? []),
        ...(request.requested.network === true ? ['network'] : []),
      ].join(', ')
    case 'mcpToolCall':
      return `${request.serverName}: ${request.toolName}`
  }
}
