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
 *   4. Explicit `ask` rules, which outrank a later allow.
 *   5. Allow rules from the profile.
 *   6. Otherwise ask.
 *
 * Denies are evaluated before grants on purpose: "allow for session" should
 * widen what the profile permits, never reach past what it forbids.
 *
 * Grants sit above `ask` rules rather than below them. A rule outranking an
 * allow is a profile qualifying its own permissiveness; a rule outranking a
 * *grant* is the app ignoring an answer the user already gave, which is what
 * made "allow always" mean "ask me every time".
 */

export type PolicyDecision =
  | {
      readonly decision: 'allow'
      readonly ruleId: string
      readonly scope: 'once' | 'session' | 'always'
    }
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

export interface RememberedGrants {
  /** Keys from a previous run, so an answer survives a restart. */
  readonly keys?: readonly string[]
  /** Called with the full set whenever it grows, for whoever persists it. */
  readonly onRemember?: (keys: readonly string[]) => void
}

export class SessionGrants {
  private readonly granted = new Map<string, SessionGrant>()
  /**
   * Answers that outlive the window they were given in.
   *
   * Separate from `granted` rather than a flag on it, because the two have
   * different rules: a session grant refuses the kinds that may never be
   * auto-decided, and a remembered one is the user having decided anyway. Only
   * a person can put a key in here.
   */
  private readonly rememberedKeys: Set<string>
  private readonly onRemember: ((keys: readonly string[]) => void) | undefined

  constructor(remembered: RememberedGrants = {}) {
    this.rememberedKeys = new Set(remembered.keys ?? [])
    this.onRemember = remembered.onRemember
  }

  /** Returns false for kinds that may never be granted ahead of time. */
  add(request: ApprovalRequest): boolean {
    if (requiresExplicitUserDecision(request.kind)) return false
    const key = grantKey(request)
    this.granted.set(key, { key, describe: describeRequest(request) })
    return true
  }

  /**
   * Remembers an answer past this run, for any kind.
   *
   * Deliberately not refusing outward-facing kinds the way `add` does. That
   * refusal protects the user from a *profile* deciding for them; this is the
   * user deciding, and the button that reaches here is only ever pressed by
   * someone reading the request.
   */
  addAlways(request: ApprovalRequest): void {
    this.rememberedKeys.add(grantKey(request))
    this.onRemember?.([...this.rememberedKeys])
  }

  isRemembered(request: ApprovalRequest): boolean {
    return this.rememberedKeys.has(grantKey(request))
  }

  remembered(): string[] {
    return [...this.rememberedKeys]
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
  /*
   * 1. Denies are absolute, and now genuinely first.
   *
   * They used to sit behind the outward-facing check, which was harmless while
   * that check could only ever return `ask` — a deny and an ask are both
   * refusals. It stops being harmless the moment anything above it can return
   * `allow`, so the order is now what the invariant says: nothing reaches past
   * what the profile forbids. A test asserts it, and caught this in the version
   * of the change where the remembered grant went first.
   */
  const denial = firstMatch(profile.rules, request, 'deny')
  if (denial !== undefined) {
    return { decision: 'deny', ruleId: denial.id, reason: denial.describe }
  }

  /*
   * 2. An answer the user already gave permanently.
   *
   * Above the outward-facing check on purpose, and this is the one place that
   * check can be passed. A sent Slack message is not recoverable the way a file
   * edit is (plan §2.6), which is why no profile and no tool annotation may
   * allow one — but "the user said yes to this exact tool, permanently" is not
   * the app deciding for them.
   *
   * The flaw it fixes, measured: an MCP call may never be auto-decided, so
   * "allow for this session" on one was silently refused and the same tool asked
   * again on every call, in every session, forever. On this machine that is 118
   * tools across seven servers, `github: search_repositories` — a read — among
   * them. Nothing can put a key in that set except a person pressing the button.
   */
  if (grants?.isRemembered(request) === true) {
    return { decision: 'allow', ruleId: 'remembered-grant', scope: 'always' }
  }

  // 3. Otherwise an outward-facing action is never decided for the user.
  if (requiresExplicitUserDecision(request.kind)) {
    return { decision: 'ask', reason: 'Outward-facing actions always need a person' }
  }

  /*
   * 3. Something the user already allowed for this session.
   *
   * Ahead of `ask` rules, which is a deliberate change from how this read
   * first. An ask rule outranks a later *allow* — that is how a profile carves
   * an exception out of its own permissiveness, and it still does. But a grant
   * is not a rule; it is the user having already answered this exact question
   * for this exact command. Ranking the rule above the answer made "allow
   * always" mean "ask me every time", which is not a promise the button can be
   * allowed to break.
   *
   * Still below denies, so the original invariant holds: a grant widens what
   * the profile permits and never reaches past what it forbids. And
   * `SessionGrants.add` refuses the kinds that may never be granted ahead of
   * time, so the step above cannot be bought out from under.
   */
  if (grants?.has(request) === true) {
    return { decision: 'allow', ruleId: 'session-grant', scope: 'session' }
  }

  // 4. An explicit `ask` rule outranks a later allow — it is how a profile
  //    carves an exception out of its own permissiveness.
  const asked = firstMatch(profile.rules, request, 'ask')
  if (asked !== undefined) {
    return { decision: 'ask', reason: asked.describe }
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
