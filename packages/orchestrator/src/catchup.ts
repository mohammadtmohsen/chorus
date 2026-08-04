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
 * Two kinds of thing are replayed:
 *
 *  - **Speech** — user messages and other agents' completed replies.
 *  - **Activity** — what another agent actually did: commands it ran and how
 *    they exited, files it changed, errors it hit. Speech alone left this too
 *    thin: an agent's summary of a failing test run is not the failing test run,
 *    and "why did that fail" is exactly the question the other agent gets asked.
 *
 * Activity is one line each, never a replay of the other agent's whole session.
 * Reasoning stays out — it is the agent's private working, and it is enormous.
 * Command output appears only when the command failed, which is the only time
 * anyone asks about it.
 *
 * When the budget binds, activity is dropped before speech: losing "claude ran
 * the tests" costs less than losing what claude said about them.
 */

/** Big enough for a real exchange, small enough not to dominate a turn. */
const MAX_TOTAL_CHARS = 12_000
const MAX_MESSAGE_CHARS = 1_500
/** Activity is supporting detail, so it may not crowd out what was said. */
const ACTIVITY_SHARE = 0.4
const MAX_COMMAND_CHARS = 160
const MAX_OUTPUT_CHARS = 400

export interface CatchupInput {
  /** The agent about to be addressed. Its own events are already its context. */
  readonly recipient: AgentId
  /** Everything in the conversation the recipient has not seen, in `seq` order. */
  readonly events: readonly StoredEvent[]
  /** Who else is in the room, for the line that explains the format. */
  readonly participants: readonly AgentId[]
  readonly maxTotalChars?: number
  readonly maxMessageChars?: number
}

interface Line {
  readonly seq: number
  readonly kind: 'speech' | 'activity'
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
  const budget = input.maxTotalChars ?? MAX_TOTAL_CHARS
  const lines = collect(input.events, input.recipient, input.maxMessageChars ?? MAX_MESSAGE_CHARS)
  if (lines.length === 0) return null

  const { kept, dropped } = fitToBudget(lines, budget)
  const others = input.participants.filter((id) => id !== input.recipient)

  return [
    `[Chorus] You are "${input.recipient}" in a shared conversation with the user` +
      `${others.length === 0 ? '' : ` and ${others.join(' and ')}`}. ` +
      'Everyone reads one transcript, but each of you is only addressed by name. ' +
      'Here is what happened while you were not addressed — context only, ' +
      'already handled by whoever it was addressed to. Lines starting with · are ' +
      'actions another agent took, not requests to you.',
    '',
    '--- transcript ---',
    ...(dropped === 0 ? [] : [`(${String(dropped)} earlier entries omitted)`]),
    ...kept.map((line) => line.text),
    '--- end transcript ---',
  ].join('\n')
}

/** Tracks a command from `started` to `completed`, which is where it renders. */
interface RunningCommand {
  readonly seq: number
  readonly actor: string
  readonly command: string
  output: string
}

function collect(events: readonly StoredEvent[], recipient: AgentId, maxMessage: number): Line[] {
  const lines: Line[] = []
  const running = new Map<string, RunningCommand>()

  for (const event of events) {
    // The recipient's own events are already in its context; replaying them
    // would pay twice for the same words.
    if (event.actor === recipient) continue
    const payload = event.payload
    const who = event.actor

    switch (payload.type) {
      case 'user.message':
        lines.push({
          seq: event.seq,
          kind: 'speech',
          text: `user: ${trim(payload.text, maxMessage)}`,
        })
        break

      case 'agent.message.completed':
        if (who !== 'system') {
          lines.push({
            seq: event.seq,
            kind: 'speech',
            text: `${who}: ${trim(payload.text, maxMessage)}`,
          })
        }
        break

      case 'command.started':
        running.set(payload.itemRef, {
          seq: event.seq,
          actor: who,
          command: trim(payload.command.join(' '), MAX_COMMAND_CHARS),
          output: '',
        })
        break

      case 'command.output': {
        const found = running.get(payload.itemRef)
        // Only the tail is kept: a build log's interesting part is the end, and
        // holding the whole thing to throw it away is pointless.
        if (found !== undefined) {
          found.output = (found.output + payload.chunk).slice(-MAX_OUTPUT_CHARS)
        }
        break
      }

      case 'command.completed': {
        const found = running.get(payload.itemRef)
        if (found === undefined) break
        running.delete(payload.itemRef)
        lines.push({
          seq: event.seq,
          kind: 'activity',
          text: renderCommand(found, payload.exitCode),
        })
        break
      }

      case 'file.change.proposed':
        lines.push({
          seq: event.seq,
          kind: 'activity',
          text: `· ${who} changed ${describeFiles(payload.files.map((f) => f.path))}`,
        })
        break

      case 'error.raised':
        // A restart notice is recoverable and is noise to everyone else; a
        // failure that stuck is why the other agent went quiet.
        if (!payload.recoverable) {
          lines.push({
            seq: event.seq,
            kind: 'activity',
            text: `· ${who} hit an error: ${trim(payload.message, 300)}`,
          })
        }
        break

      /*
       * Listed rather than defaulted, so a new event type has to be considered
       * here instead of silently vanishing from the shared conversation.
       *
       * Deltas are superseded by the completed message. Reasoning is the agent's
       * private working, and it is enormous. `diff.updated` is the cumulative
       * diff, already covered one change at a time. The rest is Chorus's own
       * bookkeeping, or — for a handoff — context the recipient was handed in
       * full at the time.
       */
      case 'conversation.created':
      case 'session.started':
      case 'session.ended':
      case 'turn.started':
      case 'turn.completed':
      case 'agent.message.delta':
      case 'agent.reasoning.delta':
      case 'diff.updated':
      case 'approval.requested':
      case 'approval.decided':
      case 'handoff.created':
      case 'usage.updated':
        break
    }
  }

  // A command with no `completed` was interrupted or the session ended under it.
  // Silence would read as "never ran", which is the wrong thing to believe.
  for (const found of running.values()) {
    lines.push({
      seq: found.seq,
      kind: 'activity',
      text: `· ${found.actor} ran \`${found.command}\` (no result recorded)`,
    })
  }

  return lines.sort((a, b) => a.seq - b.seq)
}

function renderCommand(found: RunningCommand, exitCode: number | null): string {
  const head = `· ${found.actor} ran \`${found.command}\``
  if (exitCode === null) return `${head} (no exit code)`
  if (exitCode === 0) return `${head} → ok`

  const tail = found.output.trim()
  return tail === ''
    ? `${head} → failed (exit ${String(exitCode)})`
    : `${head} → failed (exit ${String(exitCode)})\n  output: ${tail.replaceAll('\n', '\n  ')}`
}

/** Three names is a list; ten is a wall, and the count is what matters by then. */
function describeFiles(paths: readonly string[]): string {
  if (paths.length <= 3) return paths.join(', ')
  return `${paths.slice(0, 3).join(', ')} and ${String(paths.length - 3)} more`
}

/**
 * Keeps the most recent lines that fit, shedding activity before speech.
 *
 * Oldest-first is the right thing to drop within each kind: the tail is what the
 * next message actually follows on from.
 */
function fitToBudget(lines: readonly Line[], budget: number): { kept: Line[]; dropped: number } {
  const cost = (line: Line): number => line.text.length + 1
  const activityBudget = Math.floor(budget * ACTIVITY_SHARE)

  // Pass one: cap activity on its own, so a chatty tool loop cannot evict the
  // conversation it was supporting.
  const trimmed: Line[] = []
  let activityUsed = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined) continue
    if (line.kind === 'activity') {
      if (activityUsed + cost(line) > activityBudget) continue
      activityUsed += cost(line)
    }
    trimmed.unshift(line)
  }

  // Pass two: the overall budget, newest first, whatever the kind.
  const kept: Line[] = []
  let used = 0
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const line = trimmed[i]
    if (line === undefined) continue
    if (used + cost(line) > budget && kept.length > 0) break
    used += cost(line)
    kept.unshift(line)
  }

  return { kept, dropped: lines.length - kept.length }
}

function trim(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  // Both ends: the opening says what it is about, the close usually carries the
  // conclusion or the question.
  const half = Math.floor((limit - 20) / 2)
  return `${trimmed.slice(0, half)}\n… [trimmed] …\n${trimmed.slice(-half)}`
}
