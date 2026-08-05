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
  readonly kind: 'message' | 'reasoning' | 'command' | 'notice' | 'handoff'
  readonly text: string
  readonly status: 'streaming' | 'complete'
  /** The log event this came from — what a handoff selects. */
  readonly eventId: string
  /** Set on a handoff card: who it went to. */
  readonly handoffTo?: TranscriptEvent['actor']
}

export interface PendingApproval {
  readonly approvalId: string
  /** Which agent asked — several can be waiting at once in a shared conversation. */
  readonly agentId: TranscriptEvent['actor']
  readonly kind: string
  readonly summary: string
  readonly detail: string | null
  readonly expiresAt: number
}

/** What this conversation has cost so far, as the agents reported it. */
export interface Spend {
  readonly inputTokens: number
  readonly outputTokens: number
  /** Null when no agent reported a price; a zero would be a claim we cannot make. */
  readonly costUsd: number | null
}

export interface TranscriptView {
  readonly messages: readonly TranscriptMessage[]
  readonly approvals: readonly PendingApproval[]
  /** Agents currently mid-turn. Drives the live indicator on each voice. */
  readonly working: readonly TranscriptEvent['actor'][]
  readonly busy: boolean
  readonly lastSeq: number
  readonly spend: Spend
  /** The latest total each agent reported, which `spend` is the sum of. */
  readonly usageByActor: Readonly<Record<string, Spend>>
}

export const EMPTY_VIEW: TranscriptView = {
  messages: [],
  approvals: [],
  working: [],
  busy: false,
  lastSeq: 0,
  spend: { inputTokens: 0, outputTokens: 0, costUsd: null },
  usageByActor: {},
}

interface Mutable {
  spend: Spend
  usageByActor: Record<string, Spend>
  messages: TranscriptMessage[]
  approvals: PendingApproval[]
  working: TranscriptEvent['actor'][]
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
    working: [...view.working],
    busy: view.busy,
    lastSeq: view.lastSeq,
    spend: view.spend,
    usageByActor: { ...view.usageByActor },
  }

  for (const event of events) {
    // Pushes and history replays can overlap; the log's ordering makes
    // deduplication a comparison rather than a guess.
    if (event.seq <= next.lastSeq) continue
    next.lastSeq = event.seq
    apply(next, event)
  }

  next.busy = next.working.length > 0
  return next
}

function apply(view: Mutable, event: TranscriptEvent): void {
  const p = event.payload
  const str = (key: string): string => (typeof p[key] === 'string' ? p[key] : '')
  const num = (key: string): number => (typeof p[key] === 'number' ? p[key] : 0)

  switch (event.type) {
    case 'user.message':
      view.messages.push({
        key: event.id,
        eventId: event.id,
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
      appendReasoning(view, event, str('text'))
      return

    case 'agent.message.completed': {
      const key = str('itemRef')
      const existing = view.messages.findIndex((m) => m.key === key)
      const message: TranscriptMessage = {
        key,
        eventId: event.id,
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
        eventId: event.id,
        actor: event.actor,
        kind: 'command',
        text: `$ ${(Array.isArray(p['command']) ? p['command'] : []).join(' ')}`,
        status: 'complete',
      })
      return

    case 'turn.started':
      // Tracked per agent: in a shared conversation one can be thinking while
      // another is idle, and a single boolean would flatten that away.
      if (!view.working.includes(event.actor)) view.working.push(event.actor)
      return

    case 'turn.completed':
      view.working = view.working.filter((a) => a !== event.actor)
      if (p['status'] === 'interrupted') {
        view.messages.push({
          key: event.id,
          eventId: event.id,
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
        agentId: event.actor,
        kind: str('kind'),
        summary: summarize(p),
        detail: detailOf(p),
        expiresAt: typeof p['expiresAt'] === 'number' ? p['expiresAt'] : 0,
      })
      return

    case 'approval.decided': {
      const id = str('approvalId')
      view.approvals = view.approvals.filter((a) => a.approvalId !== id)

      /*
       * An auto-decision always leaves a line in the transcript. A policy that
       * works silently is indistinguishable from no policy — the user must be
       * able to see what was decided for them, and which rule did it (§4.4).
       *
       * Deliberately not conditioned on whether a card was showing: the request
       * is logged before policy evaluates, so an auto-decided approval *does*
       * briefly appear pending. Skipping the notice in that case made every
       * automatic decision invisible, which a live run caught.
       */
      if (str('decidedBy') !== 'user') {
        const rule = str('policyRuleId')
        const outcome = str('outcome')
        view.messages.push({
          key: event.id,
          eventId: event.id,
          actor: 'system',
          kind: 'notice',
          text:
            outcome === 'timeout'
              ? 'Denied — nobody answered in time.'
              : `${outcome === 'allow' ? 'Allowed' : 'Denied'} automatically${rule === '' ? '' : ` · ${rule}`}`,
          status: 'complete',
        })
      }
      return
    }

    /*
     * Widening what agents may do belongs in the transcript, above the actions
     * it permitted. A permission change that left no mark would make the log an
     * incomplete account of why something was allowed.
     */
    /*
     * Joining and leaving belong in the transcript. Without them an agent's
     * first message appears from nowhere, and its last is followed by a silence
     * with no explanation.
     */
    /*
     * Reopening the app is not somebody joining.
     *
     * Every launch closed and restarted each agent, so a conversation collected
     * a "left" and a "joined" per agent per restart — a transcript that filled
     * with the app's own lifecycle. The notices are for the cast changing, which
     * is a thing you did, so a resumed session says nothing.
     */
    case 'session.started':
      if (event.payload['resumed'] === true) return
      view.messages.push({
        key: event.id,
        eventId: event.id,
        actor: 'system',
        kind: 'notice',
        text: `${str('agentId')} joined`,
        status: 'complete',
      })
      return

    case 'session.ended':
      if (str('reason') === 'shutdown') return
      view.messages.push({
        key: event.id,
        eventId: event.id,
        actor: 'system',
        kind: 'notice',
        text: `${str('agentId')} left`,
        status: 'complete',
      })
      return

    case 'project.changed':
      view.messages.push({
        key: event.id,
        eventId: event.id,
        actor: 'system',
        kind: 'notice',
        text: `Project directory: ${str('cwd')}`,
        status: 'complete',
      })
      return

    case 'policy.changed':
      view.messages.push({
        key: event.id,
        eventId: event.id,
        actor: 'system',
        kind: 'notice',
        text: `Permissions changed: ${str('previousProfileId')} → ${str('profileId')}`,
        status: 'complete',
      })
      return

    /*
     * What it cost, accumulated rather than shown per turn.
     *
     * Agents report usage at the end of each turn; the interesting number is the
     * running total for the conversation, which is the one that decides whether
     * to keep going. Cost stays null until an agent actually reports a price —
     * Codex does not always — because a zero would be a claim we cannot make.
     */
    case 'usage.updated': {
      /*
       * Each agent reports its own running total, so the latest wins per agent
       * and the conversation is their sum. Adding every report up would count
       * the same tokens again each time one arrived.
       */
      view.usageByActor = {
        ...view.usageByActor,
        [event.actor]: {
          inputTokens: num('inputTokens'),
          outputTokens: num('outputTokens'),
          costUsd: typeof p['costUsd'] === 'number' ? p['costUsd'] : null,
        },
      }

      const totals = Object.values(view.usageByActor)
      const priced = totals.filter((t) => t.costUsd !== null)
      view.spend = {
        inputTokens: totals.reduce((sum, t) => sum + t.inputTokens, 0),
        outputTokens: totals.reduce((sum, t) => sum + t.outputTokens, 0),
        costUsd: priced.length === 0 ? null : priced.reduce((sum, t) => sum + (t.costUsd ?? 0), 0),
      }
      return
    }

    case 'error.raised':
      view.messages.push({
        key: event.id,
        eventId: event.id,
        actor: 'system',
        kind: 'notice',
        text: str('message'),
        status: 'complete',
      })
      return

    /*
     * A handoff is shown as its own entry rather than as a user message. It is
     * the moment context crosses between two agents that otherwise cannot see
     * each other, and the transcript should make that visible (plan §4.5).
     */
    case 'handoff.created':
      view.messages.push({
        key: event.id,
        eventId: event.id,
        actor: str('from') as TranscriptEvent['actor'],
        kind: 'handoff',
        handoffTo: str('to') as TranscriptEvent['actor'],
        text: str('brief'),
        status: 'complete',
      })
      return

    default:
      return
  }
}

/**
 * One block of thinking, however many items the provider split it into.
 *
 * Reasoning used to be keyed by `itemRef`, so a model that emitted its thinking
 * as several items produced several entries — several dots on the rail, several
 * "Show thinking" toggles, and the reply pushed further down each time. The
 * provider's item boundaries are an implementation detail of how it streams;
 * they are not something the reader asked to see.
 *
 * A run ends when anything else is said. Thinking, then a reply, then more
 * thinking is genuinely two blocks, and joining those would misrepresent the
 * order the agent worked in.
 */
function appendReasoning(view: Mutable, event: TranscriptEvent, text: string): void {
  const last = view.messages.at(-1)
  if (last?.kind === 'reasoning' && last.actor === event.actor) {
    view.messages[view.messages.length - 1] = { ...last, text: last.text + text }
    return
  }
  view.messages.push({
    // Keyed by the event that opened the run, so the block keeps its identity as
    // more of it arrives.
    key: `reasoning:${event.id}`,
    eventId: event.id,
    actor: event.actor,
    kind: 'reasoning',
    text,
    status: 'streaming',
  })
}

/**
 * True when this message is the reply a block of thinking led to.
 *
 * Derived from where a message sits rather than stored on it: the answer is only
 * distinguishable *because* thinking precedes it, so it is a fact about the pair
 * and not about either one. When no reasoning arrives — which is every turn both
 * CLIs currently produce — nothing is marked, which is the right answer rather
 * than a degraded one.
 */
export function answersThinking(
  previous: TranscriptMessage | undefined,
  current: TranscriptMessage
): boolean {
  if (current.kind !== 'message') return false
  if (current.actor === 'user' || current.actor === 'system') return false
  return previous?.kind === 'reasoning' && previous.actor === current.actor
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
    view.messages.push({
      key,
      eventId: event.id,
      actor: event.actor,
      kind,
      text,
      status: 'streaming',
    })
    return
  }
  const previous = view.messages[index]
  if (previous === undefined) return
  // A completed message is authoritative; a late delta must not append to it.
  if (previous.status === 'complete') return
  view.messages[index] = { ...previous, text: previous.text + text }
}

/** The diff or arguments behind an approval, shown under the summary line. */
function detailOf(payload: Record<string, unknown>): string | null {
  const request = payload['request']
  if (typeof request !== 'object' || request === null) return null
  const r = request as Record<string, unknown>

  if (Array.isArray(r['files'])) {
    const patches = r['files']
      .map((f) =>
        typeof f === 'object' && f !== null ? ((f as { patch?: string }).patch ?? '') : ''
      )
      .filter((patch) => patch !== '')
    return patches.length > 0 ? patches.join('\n') : null
  }
  if (r['input'] !== undefined) return JSON.stringify(r['input'], null, 2)
  return null
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
        typeof f === 'object' && f !== null ? ((f as { path?: string }).path ?? '') : ''
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
