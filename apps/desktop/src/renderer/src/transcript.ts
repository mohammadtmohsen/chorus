import type { TranscriptEvent } from '../../shared/ipc.js'

/**
 * Folds the event log into something renderable.
 *
 * The log is the source of truth (S3), so this is a pure reduction over it —
 * the same events replayed from `conversation:history` after a restart produce
 * the same view as the live push stream.
 */

export interface TranscriptMessage {
  readonly key: string
  readonly actor: TranscriptEvent['actor']
  readonly kind: 'message' | 'reasoning' | 'command' | 'notice'
  readonly text: string
  readonly status: 'streaming' | 'complete'
}

export interface PendingApproval {
  readonly approvalId: string
  readonly kind: string
  readonly summary: string
  readonly expiresAt: number
}

export interface TranscriptView {
  readonly messages: readonly TranscriptMessage[]
  readonly approvals: readonly PendingApproval[]
  readonly busy: boolean
  readonly lastSeq: number
}

export const EMPTY_VIEW: TranscriptView = {
  messages: [],
  approvals: [],
  busy: false,
  lastSeq: 0,
}

interface Mutable {
  messages: TranscriptMessage[]
  approvals: PendingApproval[]
  busy: boolean
  lastSeq: number
}

export function reduceEvents(
  view: TranscriptView,
  events: readonly TranscriptEvent[]
): TranscriptView {
  const next: Mutable = {
    messages: [...view.messages],
    approvals: [...view.approvals],
    busy: view.busy,
    lastSeq: view.lastSeq,
  }

  for (const event of events) {
    // Pushes and history replays can overlap; the log's ordering makes
    // deduplication a comparison rather than a guess.
    if (event.seq <= next.lastSeq) continue
    next.lastSeq = event.seq
    apply(next, event)
  }

  return next
}

function apply(view: Mutable, event: TranscriptEvent): void {
  const p = event.payload
  const str = (key: string): string => (typeof p[key] === 'string' ? p[key] : '')

  switch (event.type) {
    case 'user.message':
      view.messages.push({
        key: event.id,
        actor: 'user',
        kind: 'message',
        text: str('text'),
        status: 'complete',
      })
      return

    case 'agent.message.delta':
      appendStreamed(view, event, 'message', str('itemRef'), str('text'))
      return

    case 'agent.reasoning.delta':
      appendStreamed(view, event, 'reasoning', `reasoning:${str('itemRef')}`, str('text'))
      return

    case 'agent.message.completed': {
      const key = str('itemRef')
      const existing = view.messages.findIndex((m) => m.key === key)
      const message: TranscriptMessage = {
        key,
        actor: event.actor,
        kind: 'message',
        text: str('text'),
        status: 'complete',
      }
      if (existing === -1) view.messages.push(message)
      else view.messages[existing] = message
      return
    }

    case 'command.started':
      view.messages.push({
        key: event.id,
        actor: event.actor,
        kind: 'command',
        text: `$ ${(Array.isArray(p['command']) ? p['command'] : []).join(' ')}`,
        status: 'complete',
      })
      return

    case 'turn.started':
      view.busy = true
      return

    case 'turn.completed':
      view.busy = false
      if (p['status'] === 'interrupted') {
        view.messages.push({
          key: event.id,
          actor: 'system',
          kind: 'notice',
          text: p['userInitiated'] === true ? 'Stopped.' : 'Interrupted.',
          status: 'complete',
        })
      }
      return

    case 'approval.requested':
      view.approvals.push({
        approvalId: str('approvalId'),
        kind: str('kind'),
        summary: summarize(p),
        expiresAt: typeof p['expiresAt'] === 'number' ? p['expiresAt'] : 0,
      })
      return

    case 'approval.decided':
      view.approvals = view.approvals.filter((a) => a.approvalId !== str('approvalId'))
      return

    case 'error.raised':
      view.messages.push({
        key: event.id,
        actor: 'system',
        kind: 'notice',
        text: str('message'),
        status: 'complete',
      })
      return

    default:
      return
  }
}

function appendStreamed(
  view: Mutable,
  event: TranscriptEvent,
  kind: TranscriptMessage['kind'],
  key: string,
  text: string
): void {
  const index = view.messages.findIndex((m) => m.key === key)
  if (index === -1) {
    view.messages.push({ key, actor: event.actor, kind, text, status: 'streaming' })
    return
  }
  const previous = view.messages[index]
  if (previous === undefined) return
  // A completed message is authoritative; a late delta must not append to it.
  if (previous.status === 'complete') return
  view.messages[index] = { ...previous, text: previous.text + text }
}

function summarize(payload: Record<string, unknown>): string {
  const kind = typeof payload['kind'] === 'string' ? payload['kind'] : 'approval'
  const request = payload['request']
  if (typeof request !== 'object' || request === null) return kind
  const r = request as Record<string, unknown>

  if (Array.isArray(r['command'])) return `$ ${r['command'].join(' ')}`
  if (Array.isArray(r['files'])) {
    const paths = r['files']
      .map((f) =>
        typeof f === 'object' && f !== null ? String((f as { path?: string }).path) : ''
      )
      .filter(Boolean)
    return `Edit ${paths.join(', ')}`
  }
  if (typeof r['toolName'] === 'string') {
    const server = typeof r['serverName'] === 'string' ? r['serverName'] : 'mcp'
    return `${server}: ${r['toolName']}`
  }
  return kind
}
