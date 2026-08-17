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
/**
 * One thing said in an aside, by one of the two people in it.
 *
 * The card used to keep only what the agent said, joined end to end, and the
 * shape is what limited it to one exchange: a merged string cannot show a second
 * question, so a follow-up appeared to overwrite the answer it followed. Asked
 * for as _"make the aside always two way chat"_ — the reply is not a footnote
 * once you have answered it twice.
 */
export interface AsideTurn {
  readonly key: string
  /** `agent` rather than the agent's name: a card has one, and it is in the header. */
  readonly actor: 'user' | 'agent'
  readonly text: string
  /** Mid-stream, so the card can show the caret where the main transcript does. */
  readonly streaming: boolean
}

export interface AsideState {
  /**
   * The exchange, oldest first — both sides, in the order they were said.
   *
   * What is dropped is unchanged and still deliberate: reasoning, tool calls and
   * commands never reach here, because a card anchored to a passage has no room
   * to narrate an agent's working. Two-way is about *who* is shown, not about
   * lifting the limit on what.
   */
  readonly turns: readonly AsideTurn[]
  /**
   * Everything the agent has said so far, streaming or complete.
   *
   * Kept alongside `turns` rather than derived at each call site because
   * `promotion` seeds a real conversation from it, and that seed should be the
   * answer rather than a transcript of how it was reached.
   */
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
  turns: [],
  answer: '',
  working: false,
  failed: null,
  answered: false,
}

/** What the card needs, out of the whole view. */
export function asideState(view: TranscriptView): AsideState {
  const said = view.messages.filter((m) => m.kind === 'message' && m.actor !== 'system')

  /*
   * `system` is dropped and `user` is not, which is the whole change.
   *
   * An aside's log carries a `joined` line and, for an explanation, a first
   * question main composed rather than the user — both are already excluded by
   * kind or actor. What is left is the two of you, and showing only one half was
   * what made a follow-up look like it had replaced the previous answer.
   */
  const turns: AsideTurn[] = said.map((m) => ({
    key: m.key,
    actor: m.actor === 'user' ? 'user' : 'agent',
    text: m.text,
    streaming: m.status === 'streaming',
  }))

  const spoken = said
    .filter((m) => m.actor !== 'user')
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
    turns,
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
 * there, and is pushed inside the visible band when it fits in neither: entirely
 * visible in the wrong place beats half visible in the right one. A box wider
 * than that band is centred, because that is the only placement symmetric about
 * an overflow no arithmetic can remove.
 *
 * **`view` is a band, not a height**, and that is the part worth reading twice.
 * A box positioned inside the *pane* has a band starting at zero; one positioned
 * inside the *scrolling content* does not — there, what is on screen is a window
 * partway down a much taller box. Taking a height and assuming it began at zero
 * is what would park the offer at the top of the whole transcript.
 *
 * Both edges are the caller's to supply, in the same space as `anchor`, and the
 * honest way to get them is to subtract the origin's rect from the scroller's
 * rather than to reach for `scrollTop` and padding separately:
 *
 *     top    = scoreRect.top    - contentRect.top
 *     bottom = scoreRect.bottom - contentRect.top
 */
export function fitCard(
  anchor: SelectionAnchor,
  view: { readonly width: number; readonly top: number; readonly bottom: number },
  box: { readonly width: number; readonly height: number },
  gap = 8
): { left: number; top: number } {
  const margin = 4

  const centred = anchor.centreX - box.width / 2
  const left =
    view.width < box.width + margin * 2
      ? (view.width - box.width) / 2
      : Math.max(margin, Math.min(centred, view.width - box.width - margin))

  const above = anchor.top - box.height - gap
  const below = anchor.top + anchor.height + gap
  const wanted = above >= view.top + margin ? above : below

  const top = Math.max(view.top + margin, Math.min(wanted, view.bottom - box.height - margin))
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

/**
 * The same, for an explanation of a whole reply — which quotes no passage.
 *
 * `promotion` opens by quoting the excerpt, and that was right while the excerpt
 * was something you had dragged over: it says _which_ part of a long reply the
 * answer is about. An explanation is now asked about the reply entire, so the
 * quote would be the agent's own last message handed back to it in full — a wall
 * of text that says nothing its context does not already hold.
 *
 * What survives is the part that is load-bearing. The mention, because
 * `runtime.send` only guarantees reaching a named agent. And the sentence
 * marking the explanation as reported rather than remembered: it came from a
 * fork this session has no memory of, and an agent acting confidently on a
 * conclusion it cannot place is worse than one that asks.
 */
export function explanationPromotion(agent: string, answer: string): string {
  return [
    `@${agent} `,
    '',
    quoted(answer),
    '',
    'That is how your last reply was explained to me in an aside, which is not in',
    'this conversation — you did not write it.',
    '',
  ].join('\n')
}

/** One block of markdown quotation. Blank lines keep the block unbroken. */
function quoted(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
    .join('\n')
}

/**
 * What "take this and continue" puts in the composer, for a recap.
 *
 * Separate from `promotion` rather than `promotion` with an empty excerpt, and
 * the difference is not the missing quote. `promotion` says _you explained this
 * in an aside_ — it is handing back an answer about a passage. A recap is handing
 * back **the task**, and the sentence that matters is the instruction after it:
 * the whole point of promoting one is that the next turn starts from the board
 * instead of from the tangent the board was written to escape.
 *
 * The mention is load-bearing for the same reason it is in `promotion`:
 * `runtime.send` only guarantees reaching a named agent, and `lastAddressed` is
 * not necessarily whoever spoke last.
 *
 * And the aside is labelled as somewhere else, not spliced in silently — the
 * agent does not remember writing this, and one acting confidently on a
 * conclusion it cannot place is worse than one that asks. Same reason
 * `catchup.ts` marks its block `[Chorus]`.
 */
export function recapPromotion(agent: string, recap: string): string {
  return [
    `@${agent} `,
    '',
    quoted(recap),
    '',
    'This is a recap you wrote in an aside, which is not in this conversation.',
    'Work from it. Stay on the task it names.',
    '',
  ].join('\n')
}

/** Why an aside was opened. Widened here, and exhaustively switched on below. */
export type AsidePurpose = 'question' | 'explanation' | 'translation' | 'recap'

/**
 * What the card calls itself, as a key the renderer can translate.
 *
 * A key and its variables rather than a sentence, because the judgement is
 * testable and the words are not: this file has no translator, and composing a
 * heading here would put English in a reducer.
 *
 * **A switch, not a ternary chain.** The shape it replaced read
 * `purpose !== 'explanation' ? ask : …`, which quietly meant "everything that is
 * not an explanation is a question" — true while there were two purposes and
 * wrong the moment there were three. Written this way the compiler and
 * `switch-exhaustiveness-check` both refuse a fourth purpose that nobody
 * considered.
 *
 * Two of the three name a language, and each needs a whole sentence while that
 * language is still resolving rather than "Translating into " with a hole where
 * the answer goes. Main is authoritative about which language was used and takes
 * a moment to say so; naming the renderer's own copy meanwhile would be the
 * staleness that indirection exists to prevent, just briefer.
 */
export function asideHeading(
  purpose: AsidePurpose,
  language: string,
  agent: string
): { key: string; vars: Record<string, string> } {
  switch (purpose) {
    case 'question':
      return { key: 'aside.heading', vars: { agent } }
    case 'explanation':
      return language === ''
        ? { key: 'aside.explainingPending', vars: {} }
        : { key: 'aside.explaining', vars: { language } }
    case 'translation':
      return language === ''
        ? { key: 'aside.translatingPending', vars: {} }
        : { key: 'aside.translating', vars: { language } }
    // No language and no passage, so nothing has to resolve before the heading
    // can be written — the only purpose of the four with a heading that is the
    // same on the first frame as on the last.
    case 'recap':
      return { key: 'aside.recapping', vars: { agent } }
  }
}

/**
 * Whether the card opened with its first turn already sent.
 *
 * The distinction the UI actually turns on, and the one the old checks kept
 * spelling as `=== 'explanation'`: a question waits for you to type, while an
 * explanation, a translation and a recap are all already running by the time the
 * card appears. So the answer region shows from the first frame, focus goes to
 * the card rather than the input, and the follow-up box stays hidden until there
 * is something to follow up on.
 *
 * Written as "not a question" rather than as a list, so a fifth purpose that
 * carries its own first turn needs no edit here — and a fifth that does not is
 * a deliberate change to this line rather than a forgotten one.
 */
export function opensWithATurn(purpose: AsidePurpose): boolean {
  return purpose !== 'question'
}
