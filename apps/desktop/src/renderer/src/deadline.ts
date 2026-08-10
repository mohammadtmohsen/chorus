/**
 * How long a card has left, and whether that is worth saying yet.
 *
 * A question set carries a wall-clock deadline that nothing on screen mentioned:
 * measured over the real log, **10 of 25 question sets died at exactly 300.0
 * seconds** — 40%, every one of them a timeout rather than a dismissal, and the
 * first sign a deadline existed was the card's absence. See
 * `docs/plans/question-deadline-2026-08-10/plan.md`.
 *
 * Pure and exported for tests, like the other judgement in this renderer: the
 * component is plumbing, and *when to warn* is the part worth pinning down.
 */

/**
 * How close to the end the warning appears.
 *
 * One minute, chosen from the data rather than rounded to it: the **median
 * successful answer took 55 seconds**. A minute is therefore enough to finish a
 * typical answer from a standing start, which is the only useful test of this
 * number — a warning that arrives with less time than an answer takes is just
 * notice of a loss.
 *
 * Deliberately not the whole window. Five minutes of visible counting on a
 * seventeen-second answer is pressure applied to someone who was never at risk,
 * and a timer that is always on is a timer nobody reads.
 */
export const WARN_WITHIN_MS = 60_000

export interface DeadlineState {
  /** Whether the card should say anything at all. */
  readonly warn: boolean
  /** Whole seconds remaining, floored at zero. */
  readonly secondsLeft: number
  /** When to next re-render: the warning's start, the next tick, or never. */
  readonly nextChangeInMs: number | null
}

/**
 * What a card should show, given a deadline and the current time.
 *
 * `nextChangeInMs` is returned rather than left to the caller so the component
 * does not have to run a 1Hz interval for five minutes to notice one moment. It
 * is `null` once there is nothing further to say.
 */
export function deadlineState(
  deadline: number,
  now: number,
  within: number = WARN_WITHIN_MS
): DeadlineState {
  const remaining = deadline - now
  if (remaining <= 0) return { warn: false, secondsLeft: 0, nextChangeInMs: null }

  if (remaining > within) {
    return {
      warn: false,
      secondsLeft: Math.ceil(remaining / 1000),
      // Wake once, when the warning is due, rather than ticking until then.
      nextChangeInMs: remaining - within,
    }
  }

  /*
   * Ceil, not floor, so the last second is shown as "1" for its whole duration
   * and the card never reads "0:00" while it is still answerable. Flooring makes
   * the number reach zero a second before the deadline does, which is a card
   * that lies at exactly the moment it is being read most carefully.
   */
  const secondsLeft = Math.ceil(remaining / 1000)
  return {
    warn: true,
    secondsLeft,
    // The instant this second's display becomes wrong.
    nextChangeInMs: remaining - (secondsLeft - 1) * 1000,
  }
}

/**
 * `m:ss`, or `0:07` under a minute.
 *
 * Separate from `compactRemaining` in `ActivityBar`, which speaks in days and
 * hours for a plan window. This one never exceeds a minute in practice and needs
 * the seconds, which that one deliberately drops.
 */
export function formatCountdown(secondsLeft: number): string {
  const safe = Math.max(0, Math.floor(secondsLeft))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`
}
