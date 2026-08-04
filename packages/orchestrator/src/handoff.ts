import type { AgentId } from '@chorus/shared'

/**
 * Composing what crosses from one agent to another.
 *
 * Agents keep separate contexts — that is the point of the shared conversation
 * (plan §1). A handoff is the only path between them, so what it contains *is*
 * the cross-agent context, and inventing that silently would break the
 * "explicit context sharing" principle. Composition is pure and the result is
 * shown to the user before anything is sent (§4.5).
 */

export type HandoffIntent = 'implement' | 'review' | 'discuss'

export interface HandoffSource {
  readonly eventId: string
  readonly actor: AgentId | 'user' | 'system'
  readonly text: string
}

export interface ComposeHandoffInput {
  readonly from: AgentId
  readonly to: AgentId
  readonly intent: HandoffIntent
  readonly sources: readonly HandoffSource[]
  readonly cwd: string
  /** Present only when the user chose to include it. */
  readonly diff?: string | undefined
  /** Anything the user typed alongside the handoff. */
  readonly note?: string | undefined
}

/**
 * The instruction that frames what the receiving agent is being asked for.
 *
 * Without it a handoff reads as an unattributed wall of text, and the receiving
 * agent has to guess whether it is being asked to critique, implement, or
 * continue. Naming the source matters too: an agent told "implement this"
 * behaves differently from one told "implement this analysis from Codex".
 */
const FRAMING: Record<HandoffIntent, (from: AgentId, to: AgentId) => string> = {
  implement: (from) =>
    `You are receiving analysis from ${label(from)}. Implement what it describes. ` +
    `Ask before doing anything it does not cover.`,
  review: (from) =>
    `You are receiving work from ${label(from)}. Review it and report what is actually wrong — ` +
    `correctness first, then anything that would bite later. Say so plainly if it looks right.`,
  discuss: (from) =>
    `You are receiving a message from ${label(from)} in a shared conversation. ` +
    `Respond to it directly.`,
}

export function composeBrief(input: ComposeHandoffInput): string {
  const parts: string[] = [FRAMING[input.intent](input.from, input.to), '']

  parts.push(`Project: ${input.cwd}`, '')

  if (input.note !== undefined && input.note.trim() !== '') {
    parts.push(input.note.trim(), '')
  }

  for (const source of input.sources) {
    parts.push(`--- From ${label(source.actor)} ---`, source.text.trim(), '')
  }

  if (input.diff !== undefined && input.diff.trim() !== '') {
    parts.push('--- Current diff ---', '```diff', input.diff.trim(), '```', '')
  }

  return parts.join('\n').trimEnd()
}

/**
 * The default intent when handing from one agent to another.
 *
 * Handing work *to* the agent that produced it makes no sense, so that case is
 * rejected by the caller rather than guessed at here.
 */
export function defaultIntent(from: AgentId, to: AgentId): HandoffIntent {
  if (from === to) return 'discuss'
  // The README's loop is analyse → implement → review, so a handoff from the
  // agent that just wrote code defaults to asking for a review of it.
  return 'implement'
}

function label(actor: AgentId | 'user' | 'system'): string {
  switch (actor) {
    case 'codex':
      return 'Codex'
    case 'claude':
      return 'Claude'
    case 'user':
      return 'the developer'
    case 'system':
      return 'the system'
  }
}

/** A one-line summary for the handoff card in the transcript. */
export function summariseHandoff(input: {
  from: AgentId
  to: AgentId
  intent: HandoffIntent
  sourceCount: number
  includesDiff: boolean
}): string {
  const what =
    input.intent === 'review'
      ? 'to review'
      : input.intent === 'implement'
        ? 'to implement'
        : 'to read'
  const bits = [`${String(input.sourceCount)} message${input.sourceCount === 1 ? '' : 's'}`]
  if (input.includesDiff) bits.push('the current diff')
  return `${label(input.from)} → ${label(input.to)}, ${what}: ${bits.join(' and ')}`
}
