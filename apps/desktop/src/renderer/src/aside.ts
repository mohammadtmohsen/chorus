import type { TranscriptView } from './transcript.js'

/**
 * What a quick-question card draws, reduced from an ordinary transcript.
 *
 * An aside is a conversation, so `reduceEvents` already produces its view and
 * this is a projection of that rather than a second reducer. That reuse is the
 * whole payoff of storing asides as child conversations instead of as bespoke
 * events: follow-ups, retries and a crash mid-answer all behave here because
 * they behave there.
 *
 * The card shows far less than a transcript, though, and the difference is
 * deliberate. Reasoning, tool calls and commands are dropped — a card anchored
 * to a passage has no room to narrate an agent's working, and a footnote that
 * unfolded into a task list would be the derailment the feature exists to avoid.
 * What is kept is what was asked, what came back, and whether it went wrong.
 */
export interface AsideState {
  /** Everything the agent has said so far, streaming or complete. */
  readonly answer: string
  /** Mid-turn: the card shows a pending state rather than an empty one. */
  readonly working: boolean
  /**
   * Why it stopped, when it did.
   *
   * An aside refuses anything needing new consent, so "it declined to act" is a
   * normal outcome rather than a fault — but the card has to say so, because a
   * refusal that reads as silence looks like a bug.
   */
  readonly failed: string | null
  /** True once the agent has finished and said something. */
  readonly answered: boolean
}

export const EMPTY_ASIDE: AsideState = {
  answer: '',
  working: false,
  failed: null,
  answered: false,
}

/** The four things the card needs, out of the whole view. */
export function asideState(view: TranscriptView): AsideState {
  const spoken = view.messages
    .filter((m) => m.kind === 'message' && m.actor !== 'user' && m.actor !== 'system')
    .map((m) => m.text)
    .join('\n\n')
    .trim()

  /*
   * The last error wins rather than the first. A retry that succeeded after a
   * transient failure should not keep showing the failure it recovered from —
   * and the reverse, a late failure after early output, is the one worth
   * surfacing.
   */
  const failure = view.messages.filter((m) => m.kind === 'notice' && m.level === 'error').at(-1)

  return {
    answer: spoken,
    working: view.busy,
    failed: failure?.text ?? null,
    answered: !view.busy && spoken !== '',
  }
}

/**
 * Where the card actually goes, given how big it turned out to be.
 *
 * `anchorFor` cannot do this job. It decides above-or-below by asking whether
 * there is `room: 34` above the selection — a constant sized for a one-line
 * pill, which is what it was written for. A card is ten times taller, so it
 * claims "above" almost always and then extends past the top of the pane and is
 * clipped: header, excerpt and answer gone, leaving the input and the buttons.
 * That is not hypothetical; it is what shipped and what a screenshot caught.
 *
 * So the card is measured rather than estimated, and clamped rather than hung.
 * It prefers to sit above the passage, drops below when it does not fit there,
 * and is pushed inside the pane if it fits in neither — a card that is entirely
 * visible in the wrong place beats half a card in the right one.
 *
 * Returns a top-left corner, which is why the CSS carries no `translate`: two
 * places deciding position is how the pill's own bug survived this long.
 */
export function fitCard(
  anchor: { readonly left: number; readonly top: number; readonly placement: 'above' | 'below' },
  pane: { readonly width: number; readonly height: number },
  card: { readonly width: number; readonly height: number },
  gap = 8
): { left: number; top: number } {
  const margin = 4

  // Centred on the anchor, then kept inside the pane. `Math.max` last so a card
  // wider than its pane sits at the margin rather than at a negative offset.
  const centred = anchor.left - card.width / 2
  const left = Math.max(margin, Math.min(centred, pane.width - card.width - margin))

  const above = anchor.top - card.height - gap
  const below = anchor.top + gap
  const fitsAbove = above >= margin
  const fitsBelow = below + card.height + margin <= pane.height

  const wanted =
    anchor.placement === 'above' ? (fitsAbove ? above : below) : fitsBelow ? below : above

  const top = Math.max(margin, Math.min(wanted, pane.height - card.height - margin))
  return { left, top }
}

/**
 * What "take this and continue" puts in the composer.
 *
 * Three things have to be true of it at once. It must reach the passage's
 * author, which `runtime.send` only guarantees for an explicit mention. It must
 * be self-contained, because the main agent never saw the aside. And it must not
 * pretend the answer is something the main session remembers saying.
 *
 * That last one is the subtle one. The excerpt is the agent's own words and it
 * remembers them; the answer came from a fork it has no memory of. Handing it
 * back unlabelled offers an explanation in the agent's own voice that, as far as
 * its context is concerned, it never gave — and an agent acting confidently on a
 * conclusion it cannot place is worse than one that asks. So the answer is
 * labelled as reported rather than remembered, the same way `catchup.ts` marks
 * its block `[Chorus]` instead of splicing another agent's words in silently.
 */
export function promotion(agent: string, excerpt: string, answer: string): string {
  const quoted = (text: string): string =>
    text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
      .join('\n')

  return [
    `@${agent} `,
    '',
    quoted(excerpt),
    '',
    'You explained this in an aside, which is not in this conversation:',
    '',
    quoted(answer),
    '',
  ].join('\n')
}
