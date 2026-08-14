import type { AgentId } from '@chorus/shared'
import type { SessionInfo } from '../Session.js'

/**
 * What a rail shortcut and a drawer row are allowed to know.
 *
 * The point of a pure projection here is not tidiness. The old card read the
 * whole `SessionPulse` — `lastSeq` included — so a text delta that changed
 * nothing visible still re-rendered every card in the list. Deciding what a row
 * shows in a function that cannot see `lastSeq` is what makes that impossible
 * rather than merely unlikely, and it is why this file has no React in it.
 */

/**
 * Five states, in the order they outrank each other.
 *
 * The two requests come first, because a request is worth more of the row than
 * a report — something sitting unanswered outranks the fact that something else
 * is also running. Failed outranks idle so a turn that ended badly does not read
 * as a session at rest.
 *
 * `waiting` used to be one state covering both requests, and the pulse has
 * always carried them apart — `approvalIds` and `questionIds` were summed in
 * `hooks.ts` and the difference thrown away one line later. They are not the
 * same interruption: an approval is an agent **blocked** mid-turn holding a tool
 * it cannot run, and answering it is unblocking. A question is an agent that has
 * finished thinking and wants a person's input. One is stalled work, the other
 * is a conversation, and telling them apart at a glance is the whole reason a
 * rail exists.
 */
export type SessionState = 'approval' | 'question' | 'working' | 'failed' | 'idle'

/** Where the session is, which is about the workspace rather than the agent. */
export type SessionPlacement = 'active' | 'open' | 'offscreen'

/** The narrow slice of a pulse a row subscribes to. Nothing invisible is here. */
export interface SessionRowState {
  /** Tool calls held pending a decision. An agent is blocked on each of these. */
  readonly approvals: number
  /** Questions asked of a person. Nothing is blocked; something was asked. */
  readonly questions: number
  readonly working: readonly AgentId[]
  readonly unread: number
  readonly failed: boolean
}

export interface SessionRowFacts {
  readonly conversationId: string
  readonly title: string
  readonly monogram: string
  readonly state: SessionState
  readonly placement: SessionPlacement
  readonly participants: readonly AgentId[]
  /**
   * One number, or zero for none.
   *
   * Waiting and unread are never both shown: a session that is waiting on you
   * has something more specific to say than "there are things you have not
   * read", and two counts on a 44px row is two things to compare.
   */
  readonly count: number
  /** Which agent is working, when exactly one is. Null when none or several. */
  readonly voice: AgentId | null
}

/*
 * Approval before question, because it is the one holding something up.
 *
 * A session with both is reported as needing an approval: answering that
 * unblocks an agent mid-turn, and the question will still be there afterwards.
 * The reverse order would leave a tool call held while a person replied to
 * something that was not blocking anything.
 */
export function stateOf(row: SessionRowState): SessionState {
  if (row.approvals > 0) return 'approval'
  if (row.questions > 0) return 'question'
  if (row.working.length > 0) return 'working'
  if (row.failed) return 'failed'
  return 'idle'
}

export function projectRow(
  session: SessionInfo,
  row: SessionRowState,
  placement: SessionPlacement,
  monogram: string
): SessionRowFacts {
  const state = stateOf(row)
  return {
    conversationId: session.conversationId,
    title: session.title,
    monogram,
    state,
    placement,
    participants: session.participants,
    /* The count belongs to whichever request is being reported, not to both:
       a row showing "3" while two of them are questions and one an approval
       would be a number for a state it is not in. */
    count: state === 'approval' ? row.approvals : state === 'question' ? row.questions : row.unread,
    voice: row.working.length === 1 ? (row.working[0] ?? null) : null,
  }
}

/**
 * Two letters that stand for a title at 44px.
 *
 * Initials of the first two words where there are two — `Fix login` is `FL`,
 * which is far easier to tell from `Refactor API` than the first two letters of
 * either would be. One word falls back to its first two characters, and
 * anything with no letters or digits at all falls back to a bullet rather than
 * to an empty box.
 */
export function monogramOf(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '')
  const first = words[0]
  if (first === undefined) return '··'
  const second = words[1]
  if (second !== undefined) {
    return `${first.slice(0, 1)}${second.slice(0, 1)}`.toLocaleUpperCase()
  }
  return first.slice(0, 2).toLocaleUpperCase().padEnd(2, first.slice(0, 1).toLocaleUpperCase())
}

/**
 * Monograms for a whole list, with collisions resolved by position.
 *
 * Two letters collide often — a machine with `chorus-web` and `chorus-worker`
 * open produces `CW` twice — and the plan's own risk list names it. The second
 * one gets a `2`, the third a `3`, appended rather than substituted so the
 * first two characters still mean what they meant.
 *
 * Deterministic on list order rather than on a hash: the same list always
 * produces the same suffixes, and a session that has not moved never changes
 * the mark you learned for it. Renaming or closing an earlier session can
 * renumber a later one, which is the price of not inventing an identifier —
 * and the accessible name is the full title either way.
 */
export function monogramsFor(sessions: readonly SessionInfo[]): ReadonlyMap<string, string> {
  const seen = new Map<string, number>()
  const marks = new Map<string, string>()
  for (const session of sessions) {
    const base = monogramOf(session.title)
    const taken = seen.get(base) ?? 0
    seen.set(base, taken + 1)
    marks.set(session.conversationId, taken === 0 ? base : `${base}${String(taken + 1)}`)
  }
  return marks
}

/**
 * The list, reordered by moving one session to a gap index.
 *
 * A gap index — 0 is before everything, `length` is after everything — because
 * that is what a drop between two rows describes and what the tab strip already
 * reorders by. Moving down past your own position has to discount the hole you
 * left behind, which is the `from < to` adjustment and the whole reason this is
 * a function rather than two lines at a call site.
 *
 * Returns the same array identity when nothing moves, so a caller can refuse to
 * persist a no-op.
 */
export function reorderSessions(
  order: readonly string[],
  conversationId: string,
  slotBefore: number
): readonly string[] {
  const from = order.indexOf(conversationId)
  if (from < 0) return order
  const slot = Math.max(0, Math.min(slotBefore, order.length))
  const to = from < slot ? slot - 1 : slot
  if (to === from) return order
  const next = [...order]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return order
  next.splice(to, 0, moved)
  return next
}

/** One step up or down, expressed as the gap index `reorderSessions` wants. */
export function stepSlot(
  order: readonly string[],
  conversationId: string,
  direction: 'up' | 'down'
): number | null {
  const from = order.indexOf(conversationId)
  if (from < 0) return null
  if (direction === 'up') return from === 0 ? null : from - 1
  return from === order.length - 1 ? null : from + 2
}
