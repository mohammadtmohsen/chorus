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

/** Never slower than this, or a long reply would still be typing minutes later. */
export const MIN_CHARS_PER_SECOND = 160

/** How long a fresh backlog should take to clear. */
export const DRAIN_MS = 500

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

/** How many characters of `total` should be visible after `elapsedMs` more. */
export function nextShown(
  shown: number,
  total: number,
  elapsedMs: number,
  perSecond: number
): number {
  // A message replaced by a shorter one — clamp rather than run off the end.
  const from = Math.min(Math.max(shown, 0), total)
  if (from >= total) return total

  const step = Math.max(1, Math.round((perSecond * Math.max(elapsedMs, 0)) / 1000))
  return Math.min(total, from + step)
}
