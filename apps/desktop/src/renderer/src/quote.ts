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
 * Where the button goes, in the pane's own coordinates.
 *
 * Centred on the selection and clear of it, then clamped so it cannot sit off
 * either edge of a narrow pane. Returns null when the selection has no
 * rectangle — a collapsed range, or one scrolled entirely out of view.
 *
 * `placement` rather than a computed pixel height: the button is one line of
 * text in a font this module cannot measure, so the arithmetic gives an edge to
 * hang it from and CSS decides which way it hangs. Getting this wrong is not
 * subtle — anchored by its top edge above the selection, the button sits *on
 * top of* the passage it is offering to quote.
 *
 * `width` is only ever used to clamp — CSS centres the offer itself with
 * `translate(-50%)` — so it is an estimate, and it has to be re-derived whenever
 * the actions change. The pill now holds two of them: "Quote in message" and
 * "Ask about this", 16 and 14 characters of 11px monospace (~6.6px each), each
 * inside `--step * 3` padding either side, plus a 1px divider and a 1px border:
 * (16 + 14) × 6.6 + 4 × 9 + 2 ≈ 236, rounded up. A single-action estimate left
 * the second button hanging off a narrow pane.
 */
export function anchorFor(
  selection: DOMRect,
  pane: DOMRect,
  button = { width: 240, gap: 8, room: 34 }
): { left: number; top: number; placement: 'above' | 'below' } | null {
  if (selection.width === 0 && selection.height === 0) return null

  const half = button.width / 2
  const centre = selection.left + selection.width / 2 - pane.left

  /*
   * A pane narrower than the offer gets it centred, not clamped.
   *
   * The clamp keeps the left edge on screen and, when the pill is wider than the
   * pane, pushes the right edge off it instead — measured at a 200px pane, a
   * 237px offer ran from 5 to 243. Centring is the only placement that is
   * symmetric about the overflow, and it pairs with the `max-width` in the CSS
   * so what actually renders fits. This is what the second action cost: one
   * button fitted panes where two do not.
   */
  const left =
    pane.width < button.width + 8
      ? pane.width / 2
      : Math.min(Math.max(centre, half + 4), pane.width - half - 4)

  /*
   * Below the selection when there is no room above it.
   *
   * The first line of a transcript sits against the top of the pane, so a button
   * placed above it would be clipped by the scroller — and the one selection you
   * cannot easily re-make is the one you just made.
   */
  const top = selection.top - pane.top
  if (top < button.room) {
    return { left, top: selection.bottom - pane.top + button.gap, placement: 'below' }
  }
  return { left, top: top - button.gap, placement: 'above' }
}
