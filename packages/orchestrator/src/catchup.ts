import type { StoredEvent } from '@chorus/event-store'
import type { AgentId } from '@chorus/shared'

/**
 * Lets an agent read what it missed while somebody else was talking.
 *
 * Chorus routes each message to the agent it was addressed to, which keeps cost
 * and duplicate answers down — but on its own it produces a conversation that
 * only looks shared. Ask Codex about something Claude just said and it has never
 * seen it: observed live, Codex answered "what i asked claude" by grepping
 * `~/.claude` off disk, because the transcript on screen was not in its context.
 *
 * So before an agent is asked to answer, it is handed the part of the shared
 * thread it has not seen. Delivering the message is what starts a turn, so the
 * catch-up rides along with it: no extra turn, no extra cost when nothing was
 * missed, and no second agent woken up to listen.
 *
 * Only what was *said* is replayed — user messages and other agents' completed
 * replies. Commands, reasoning and approvals belong to the agent that ran them,
 * and replaying them would drown the conversation in another agent's mechanics.
 */

/** Big enough for a real exchange, small enough not to dominate a turn. */
const MAX_TOTAL_CHARS = 8_000
const MAX_MESSAGE_CHARS = 1_500

export interface CatchupInput {
  /** The agent about to be addressed. Its own messages are already its context. */
  readonly recipient: AgentId
  /** Everything in the conversation the recipient has not seen, in `seq` order. */
  readonly events: readonly StoredEvent[]
  /** Who else is in the room, for the line that explains the format. */
  readonly participants: readonly AgentId[]
  readonly maxTotalChars?: number
  readonly maxMessageChars?: number
}

interface Line {
  readonly speaker: string
  readonly text: string
}

/**
 * Returns the message to deliver: the catch-up plus `message`, or `message`
 * unchanged when nothing was missed.
 */
export function withCatchup(input: CatchupInput, message: string): string {
  const preamble = composeCatchup(input)
  return preamble === null ? message : `${preamble}\n\nThe user now says to you:\n${message}`
}

/** The catch-up block alone, or `null` when the recipient is already current. */
export function composeCatchup(input: CatchupInput): string | null {
  const maxMessage = input.maxMessageChars ?? MAX_MESSAGE_CHARS
  const lines = input.events.flatMap((event) => toLine(event, input.recipient, maxMessage))
  if (lines.length === 0) return null

  const { kept, dropped } = fitToBudget(lines, input.maxTotalChars ?? MAX_TOTAL_CHARS)
  const others = input.participants.filter((id) => id !== input.recipient)

  return [
    `[Chorus] You are "${input.recipient}" in a shared conversation with the user` +
      `${others.length === 0 ? '' : ` and ${others.join(' and ')}`}. ` +
      'Everyone reads one transcript, but each of you is only addressed by name. ' +
      'Here is what was said while you were not addressed — context only, ' +
      'already answered by whoever it was addressed to.',
    '',
    '--- transcript ---',
    ...(dropped === 0 ? [] : [`(${String(dropped)} earlier messages omitted)`]),
    ...kept.map((line) => `${line.speaker}: ${line.text}`),
    '--- end transcript ---',
  ].join('\n')
}

function toLine(event: StoredEvent, recipient: AgentId, maxMessage: number): Line[] {
  // The recipient's own turns are already in its context; replaying them would
  // pay twice for the same words.
  if (event.actor === recipient) return []

  if (event.payload.type === 'user.message') {
    return [{ speaker: 'user', text: truncate(event.payload.text, maxMessage) }]
  }
  if (event.payload.type === 'agent.message.completed' && event.actor !== 'system') {
    return [{ speaker: event.actor, text: truncate(event.payload.text, maxMessage) }]
  }
  return []
}

/**
 * Keeps the most recent lines that fit.
 *
 * Oldest-first is the right thing to drop: the tail is what the next message
 * actually follows on from.
 */
function fitToBudget(lines: readonly Line[], budget: number): { kept: Line[]; dropped: number } {
  const kept: Line[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined) continue
    const cost = line.speaker.length + line.text.length + 2
    if (used + cost > budget && kept.length > 0) return { kept, dropped: i + 1 }
    used += cost
    kept.unshift(line)
  }
  return { kept, dropped: 0 }
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  // Both ends: the opening says what it is about, the close usually carries the
  // conclusion or the question.
  const half = Math.floor((limit - 20) / 2)
  return `${trimmed.slice(0, half)}\n… [trimmed] …\n${trimmed.slice(-half)}`
}
