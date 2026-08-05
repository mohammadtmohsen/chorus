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
 */
export function anchorFor(
  selection: DOMRect,
  pane: DOMRect,
  button = { width: 96, gap: 8, room: 34 }
): { left: number; top: number; placement: 'above' | 'below' } | null {
  if (selection.width === 0 && selection.height === 0) return null

  const half = button.width / 2
  const centre = selection.left + selection.width / 2 - pane.left
  const left = Math.min(Math.max(centre, half + 4), Math.max(pane.width - half - 4, half + 4))

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
