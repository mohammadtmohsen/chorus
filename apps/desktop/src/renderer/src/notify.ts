import type { TranscriptEvent } from '../../shared/ipc.js'

/**
 * What is worth interrupting someone for.
 *
 * Pure, and separate from the code that raises a banner, because the hard part
 * is not the API — it is the judgement about which of the hundred events a turn
 * produces deserves to pull attention out of another window. Kept testable so
 * that judgement can be argued with.
 *
 * Deliberately in the renderer rather than the main process. Main knows whether
 * the window is focused, which is only half the condition: a conversation in a
 * background tab is unseen even when Chorus is frontmost, and only the renderer
 * knows which tab that is. It is also the only side with a translator.
 */

/** In ascending urgency, which is how a batch collapses to one notice. */
export type NoticeKind = 'done' | 'failed' | 'waiting'

const URGENCY: Record<NoticeKind, number> = { done: 1, failed: 2, waiting: 3 }

export interface Notice {
  readonly conversationId: string
  /** Which agent, so a shared conversation says who. */
  readonly actor: string
  readonly kind: NoticeKind
}

/**
 * The one thing each conversation in this batch is worth saying.
 *
 * Collapsed per conversation because a finished turn usually arrives in the same
 * push as the usage and lifecycle events around it, and three banners for one
 * moment is how people turn notifications off. The most urgent reason wins:
 * "needs you" outranks "failed" outranks "finished".
 */
export function noticesFrom(events: readonly TranscriptEvent[]): Notice[] {
  const best = new Map<string, Notice>()

  for (const event of events) {
    const kind = kindOf(event)
    if (kind === null) continue
    const candidate: Notice = {
      conversationId: event.conversationId,
      actor: event.actor,
      kind,
    }
    const held = best.get(event.conversationId)
    if (held === undefined || URGENCY[kind] > URGENCY[held.kind]) {
      best.set(event.conversationId, candidate)
    }
  }

  return [...best.values()]
}

function kindOf(event: TranscriptEvent): NoticeKind | null {
  const p = event.payload

  switch (event.type) {
    // Blocking on a person. The only kind that is urgent rather than merely
    // interesting, because the agent has stopped until it is answered.
    case 'approval.requested':
    case 'userinput.requested':
      return 'waiting'

    case 'turn.completed':
      /*
       * An interrupt is not news: you pressed the button. Reporting it back
       * would notify you about your own action, which is the fastest way to
       * teach someone that these banners are noise.
       */
      if (p['status'] === 'interrupted') return null
      return p['status'] === 'completed' ? 'done' : 'failed'

    // A restart is recoverable and the supervisor handles it; a failure that
    // stuck is why the room went quiet.
    case 'error.raised':
      return p['recoverable'] === true ? null : 'failed'

    default:
      return null
  }
}

/**
 * Whether a notice should actually be raised.
 *
 * The condition is "you cannot see this", not "Chorus is in the background". A
 * conversation sitting in an inactive tab is unseen while you read another one,
 * and that is precisely the case the whole feature exists for — four projects
 * running, one of them on screen.
 */
export function shouldRaise(
  notice: Notice,
  state: { readonly windowFocused: boolean; readonly visibleConversationIds: readonly string[] }
): boolean {
  if (!state.windowFocused) return true
  return !state.visibleConversationIds.includes(notice.conversationId)
}

/** How many rooms are blocked on a person, which is what a dock badge answers. */
export function roomsWaiting(pending: Readonly<Record<string, readonly string[]>>): number {
  return Object.values(pending).filter((ids) => ids.length > 0).length
}

/**
 * Which approvals and questions are still unanswered, per conversation.
 *
 * Tracked by id rather than counted, because the requests and their answers
 * arrive in separate pushes and a counter cannot tell a second question from a
 * repeat of the first.
 */
export function trackPending(
  pending: Readonly<Record<string, readonly string[]>>,
  events: readonly TranscriptEvent[]
): Readonly<Record<string, readonly string[]>> {
  let next = pending
  const edit = (conversationId: string, change: (ids: readonly string[]) => readonly string[]) => {
    const before = next[conversationId] ?? []
    const after = change(before)
    if (after === before) return
    next = { ...next, [conversationId]: after }
  }

  for (const event of events) {
    const p = event.payload
    const approvalId = typeof p['approvalId'] === 'string' ? `a:${p['approvalId']}` : null
    const questionId = typeof p['userInputId'] === 'string' ? `q:${p['userInputId']}` : null

    switch (event.type) {
      case 'approval.requested':
      case 'userinput.requested': {
        const id = approvalId ?? questionId
        if (id === null) break
        edit(event.conversationId, (ids) => (ids.includes(id) ? ids : [...ids, id]))
        break
      }
      case 'approval.decided':
      case 'userinput.answered': {
        const id = approvalId ?? questionId
        if (id === null) break
        edit(event.conversationId, (ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids))
        break
      }
      default:
        break
    }
  }

  return next
}
