/**
 * Revealing streamed text at a readable pace.
 *
 * Agents send text far faster and lumpier than anyone reads it, and the event
 * log makes that worse on purpose: deltas are coalesced before they are
 * persisted, because writing the log per token would cost a disk write for every
 * few characters. What arrives is therefore a paragraph every quarter-second —
 * accurate, and nothing like watching something be written.
 *
 * So the pacing lives here, in the renderer, where it is presentation and costs
 * nothing durable. Nothing is invented and nothing is held back for long: this
 * only decides how much of what has *already arrived* is on screen yet.
 */

/**
 * The pace text is written at, in characters a second.
 *
 * **This is the rate, not a floor**, and that is the whole of the change made on
 * 2026-08-18. It used to be a floor of 320 under a rule that cleared whatever
 * had arrived within 80ms, which meant the floor almost never bound: a coalesced
 * paragraph of 300 characters was revealed at 3,750 a second, so what you saw
 * was a paragraph appearing every quarter-second. Every individual number was
 * defensible and the result was not writing — it was blocks, which is what the
 * pacing exists to avoid.
 *
 * 200 is picked to be read rather than watched. At a 60Hz frame that is a little
 * over three characters, which is fast typing rather than a cursor crawling, and
 * a reply arrives faster than it is generated for anything an agent takes more
 * than a few seconds to write — so the text keeps moving for the whole turn
 * instead of stopping and jumping.
 */
export const TYPING_CHARS_PER_SECOND = 200

/**
 * How far behind the arrived text the display may fall before it speeds up.
 *
 * The safety valve, and the reason a steady rate is safe to want. An agent can
 * deliver faster than anyone reads — a cached reply, a tool result summarised in
 * one delta, a whole message at once from a provider that does not stream — and
 * a strict 200 a second would then be minutes behind by the end.
 *
 * So the pace is the typing rate *or* whatever clears the backlog inside this
 * window, whichever is faster. In normal streaming the backlog is a line or two
 * and this never binds; it only takes over when something arrives in a lump,
 * which is exactly when nobody is watching it be written anyway.
 */
export const MAX_LAG_MS = 1_200

/**
 * The same, once the message has finished arriving.
 *
 * The tail still types — that is the point of the change, and a message that
 * jumps to its last paragraph is the block this is here to remove — but there is
 * no longer any reason to stay a second behind an agent that has stopped. A
 * tighter window keeps the ending prompt without making it a cut.
 */
export const FINISH_LAG_MS = 500

/**
 * The rate to clear `remaining` at.
 *
 * Chosen once when text arrives and then held, rather than recomputed from what
 * is left. Recomputing looks reasonable and is not: the backlog shrinks as it
 * drains, so the rate shrinks with it and the tail crawls — an exponential
 * approach that clears about two thirds of the window and then dawdles. A rate
 * fixed at the moment of arrival is linear, finishes when it says it will, and
 * is the one that can be reasoned about.
 */
export function paceFor(remaining: number, complete = false): number {
  const window = complete ? FINISH_LAG_MS : MAX_LAG_MS
  return Math.max(TYPING_CHARS_PER_SECOND, (remaining * 1000) / window)
}

/**
 * How far through `total` the reveal should be after `elapsedMs` more.
 *
 * Fractional, and the caller keeps it that way between frames — only the
 * display rounds down. The previous version rounded here, which quietly made
 * the rate a function of the display: at 160 a second, a 60Hz frame is 2.67
 * characters and a 120Hz frame is 1.33. Rounding those gives 3 and 1 — 180 a
 * second on one machine and 125 on another, and the floor this constant
 * promises on neither. The remainder is worth a character or two per frame and
 * a fifth of the rate over a reply.
 */
export function nextShown(
  shown: number,
  total: number,
  elapsedMs: number,
  perSecond: number
): number {
  // A message replaced by a shorter one — clamp rather than run off the end.
  const from = Math.min(Math.max(shown, 0), total)
  if (from >= total) return total

  // No guaranteed minimum step: with the remainder carried, any real frame
  // advances, and forcing a whole character per frame was the cap as well as
  // the floor.
  const step = (perSecond * Math.max(elapsedMs, 0)) / 1000
  return Math.min(total, from + step)
}
