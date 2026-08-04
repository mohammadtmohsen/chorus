import type { AgentId } from '@chorus/shared'

/**
 * Decides which agent a message is addressed to.
 *
 * This is the routing rule for the shared conversation: one transcript, several
 * agents, each with its own context. Getting it wrong is expensive in both
 * directions — a message sent to nobody looks like the app hung, and a message
 * broadcast to everyone doubles the cost and produces two agents talking past
 * each other.
 */

export interface MentionRoute {
  /** Agents that should receive this turn. Never empty when participants exist. */
  readonly targets: readonly AgentId[]
  /** The message with its leading mentions removed, as the agent should see it. */
  readonly text: string
  /** True when the user named the recipients rather than us inferring them. */
  readonly explicit: boolean
}

export interface RouteContext {
  /** Agents with a live session in this conversation. */
  readonly participants: readonly AgentId[]
  /** Who the user last addressed, used when a message names nobody. */
  readonly lastAddressed?: AgentId | undefined
}

/** `@codex`, `@claude` — word-boundary anchored so `email@codex.dev` is not a mention. */
const MENTION = /(?:^|\s)@([a-z][a-z0-9-]*)\b/gi

export function parseMentions(text: string, context: RouteContext): MentionRoute {
  const known = new Set(context.participants)
  const named: AgentId[] = []

  for (const match of text.matchAll(MENTION)) {
    const name = match[1]?.toLowerCase()
    if (name === undefined) continue
    if (known.has(name as AgentId) && !named.includes(name as AgentId)) {
      named.push(name as AgentId)
    }
  }

  if (named.length > 0) {
    return { targets: named, text: stripLeadingMentions(text, named), explicit: true }
  }

  return { targets: inferTarget(context), text: text.trim(), explicit: false }
}

/**
 * With nobody named, prefer whoever the user last addressed. A conversation
 * naturally continues with the same agent, and silently switching would send
 * a follow-up to an agent that never saw what it follows.
 */
function inferTarget(context: RouteContext): readonly AgentId[] {
  const { participants, lastAddressed } = context
  if (participants.length === 0) return []
  if (lastAddressed !== undefined && participants.includes(lastAddressed)) return [lastAddressed]
  const first = participants[0]
  return first === undefined ? [] : [first]
}

/**
 * Strips mentions only from the start of the message.
 *
 * A mid-sentence mention is usually meaningful content — "ask @codex to review
 * this" — and removing it would change what the agent reads.
 */
function stripLeadingMentions(text: string, named: readonly AgentId[]): string {
  let rest = text.trimStart()
  for (;;) {
    const match = /^@([a-z][a-z0-9-]*)\b[,:]?\s*/i.exec(rest)
    const name = match?.[1]?.toLowerCase()
    if (match === null || name === undefined) break
    if (!named.includes(name as AgentId)) break
    rest = rest.slice(match[0].length)
  }
  return rest.trim()
}

/** Renders a route for a log line or a UI hint. */
export function describeRoute(route: MentionRoute): string {
  if (route.targets.length === 0) return 'nobody'
  return route.targets.join(' and ')
}
