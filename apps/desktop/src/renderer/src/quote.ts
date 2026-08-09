/**
 * Asking about one part of what an agent said.
 *
 * A reply can run for pages, and "the third thing you listed" is a bad way to
 * point at something — the agent has to guess, and in a shared room the *other*
 * agent has no idea what either of you meant. Quoting the passage makes the
 * subject explicit in the transcript itself, which is the same reason handoffs
 * carry a brief rather than a reference.
 *
 * Markdown blockquote rather than a copy of the text: both CLIs already read `>`
 * as quotation, so the agent sees a quote and your question as separate things
 * without Chorus inventing a convention to teach it.
 */

/**
 * The transcript entry a selection came out of, flattened to what the decision
 * needs.
 *
 * Read off the entry's own data attributes rather than passed down from the
 * reducer, because the selection is made in the DOM and the DOM is the only
 * place that knows which entry the pointer landed in. Strings rather than the
 * reducer's unions: these come back from `getAttribute`, and narrowing them here
 * — in the one function that decides — beats trusting an assertion at the edge.
 */
export interface SourceEntry {
  readonly eventId: string
  readonly actor: string
  readonly kind: string
  readonly status: string
}

/**
 * How much text may be carried into an aside.
 *
 * A limit rather than a truncation: the excerpt is what the question is *about*,
 * so half of one asks a different question than the one the user meant. Refusing
 * is honest; trimming is not.
 */
export const MAX_EXCERPT_CHARS = 2_000

/**
 * Whether a selection can be asked about, and what it would be asked about.
 *
 * Quoting works on anything. Asking does not, and the reasons are not cosmetic:
 *
 * - **One entry only.** A range crossing two messages has no single author, and
 *   an aside is routed to the author of the passage.
 * - **An agent's own words.** User, system, tool, command and reasoning rows are
 *   either not something an agent said or not something it can be asked to
 *   expand on.
 * - **Completed.** This is a provider constraint discovered by measurement, not
 *   a preference: a fork taken mid-turn inherits the session only as far as the
 *   last *completed* turn, so a fork asked about a still-streaming reply is
 *   asked about text it cannot see. It answers that no such reply exists.
 *
 * Returns the source when all of that holds, and `null` when it does not — in
 * which case the caller still offers to quote.
 */
export function askableSource(
  start: SourceEntry | null,
  end: SourceEntry | null,
  excerpt: string,
  limit: number = MAX_EXCERPT_CHARS
): SourceEntry | null {
  if (start === null || end === null) return null
  if (start.eventId === '' || start.eventId !== end.eventId) return null
  if (start.actor !== 'codex' && start.actor !== 'claude') return null
  if (start.kind !== 'message') return null
  if (start.status !== 'complete') return null

  const body = excerpt.trim()
  if (body === '' || body.length > limit) return null
  return start
}

/** The selection, as a blockquote. */
export function asQuote(selection: string): string {
  const body = selection.replace(/\r\n/g, '\n').trim()
  if (body === '') return ''
  return body
    .split('\n')
    .map((line) => {
      const text = line.trimEnd()
      // `>` alone rather than `> ` on a blank line: a trailing space in a
      // transcript is invisible and survives into the agent's context.
      return text === '' ? '>' : `> ${text}`
    })
    .join('\n')
}

/**
 * Adds the quote to a draft, above where you are about to type.
 *
 * Appended on its own block, like `withPaths` appends a path: the selection was
 * made with the pointer, which says nothing about where the caret was. The
 * trailing blank line is the point — it leaves the caret under the quote, which
 * is where the question goes.
 */
export function withQuote(draft: string, selection: string): string {
  const quote = asQuote(selection)
  if (quote === '') return draft
  if (draft.trim() === '') return `${quote}\n\n`
  return `${draft.replace(/\s+$/, '')}\n\n${quote}\n\n`
}

/**
 * The passage, in the pane's own coordinates, and nothing decided yet.
 *
 * This used to be `anchorFor`, which also chose above-or-below and clamped using
 * a hand-written guess at how wide the offer was. Two things went wrong with
 * that. The guess drifted every time a label changed — it was 96 for a
 * fourteen-character button and had to become 240 for two of them, and a
 * three-action offer would have needed a third revision nobody would remember to
 * make. And because the clamped result was what got stored, the real geometry
 * was gone by the time anything could have measured the truth.
 *
 * So this returns the passage and stops. Whoever is being positioned measures
 * itself and calls `fitCard`, which is now the only thing that decides where
 * anything goes — the offer and the card included. One positioner cannot
 * disagree with itself about which edge `top` means, which is what the two of
 * them used to do.
 *
 * `null` when the selection has no rectangle: a collapsed range, or one scrolled
 * entirely out of view.
 */
export interface SelectionAnchor {
  /** The horizontal centre of the passage. */
  readonly centreX: number
  /** Its top edge. */
  readonly top: number
  /** How tall it is, so anything dropping below it can clear it. */
  readonly height: number
}

export function anchorOf(selection: DOMRect, pane: DOMRect): SelectionAnchor | null {
  if (selection.width === 0 && selection.height === 0) return null
  return {
    centreX: selection.left + selection.width / 2 - pane.left,
    top: selection.top - pane.top,
    height: selection.height,
  }
}
