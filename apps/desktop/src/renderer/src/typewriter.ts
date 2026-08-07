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
 * Never slower than this, or a long reply would still be typing minutes later.
 *
 * Raised from 160 once the rate was measured rather than assumed: what a reader
 * notices is not the pace but the gap between an agent finishing and the last
 * word landing, and 160 spent most of a second on it.
 */
export const MIN_CHARS_PER_SECOND = 320

/**
 * How long a fresh backlog should take to clear.
 *
 * This is the lag, near enough: whatever arrives in the final delta is still
 * being drawn for this long after the turn is over. Measured at 500 it was a
 * 399ms tail on a four-sentence reply — small enough to sound harmless, long
 * enough to read as the app being behind the agent.
 */
export const DRAIN_MS = 140

/**
 * The rate to clear `remaining` within the drain window.
 *
 * Chosen once when text arrives and then held, rather than recomputed from what
 * is left. Recomputing looks reasonable and is not: the backlog shrinks as it
 * drains, so the rate shrinks with it and the tail crawls — an exponential
 * approach that clears about two thirds of the window and then dawdles. A rate
 * fixed at the moment of arrival is linear, finishes when it says it will, and
 * is the one that can be reasoned about.
 */
export function paceFor(remaining: number): number {
  return Math.max(MIN_CHARS_PER_SECOND, (remaining * 1000) / DRAIN_MS)
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
