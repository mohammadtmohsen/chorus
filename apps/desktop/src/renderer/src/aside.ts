import type { SelectionAnchor } from './quote.js'
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
 * Where something goes, given how big it turned out to be.
 *
 * The only positioner. It used to share the job with `anchorFor`, which decided
 * above-or-below from a guess at the offer's width and returned a *hanging edge*
 * rather than a corner — so the two disagreed about what `top` meant, and a card
 * that could not fit above landed squarely on the passage it was quoting.
 *
 * Everything is measured now. Prefers above, drops below when it does not fit
 * there, and is pushed inside the pane when it fits in neither: entirely visible
 * in the wrong place beats half visible in the right one. A box wider than its
 * pane is centred, because that is the only placement symmetric about an
 * overflow no arithmetic can remove.
 */
export function fitCard(
  anchor: SelectionAnchor,
  pane: { readonly width: number; readonly height: number },
  box: { readonly width: number; readonly height: number },
  gap = 8
): { left: number; top: number } {
  const margin = 4

  const centred = anchor.centreX - box.width / 2
  const left =
    pane.width < box.width + margin * 2
      ? (pane.width - box.width) / 2
      : Math.max(margin, Math.min(centred, pane.width - box.width - margin))

  const above = anchor.top - box.height - gap
  const below = anchor.top + anchor.height + gap
  const wanted = above >= margin ? above : below

  const top = Math.max(margin, Math.min(wanted, pane.height - box.height - margin))
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
