import { EMPTY_VIEW } from './transcript.js'
import type { SessionCarry } from './Session.js'

/**
 * How much transcript a backgrounded session may hold, in characters.
 *
 * A character budget rather than a message count: the memory is the text, and
 * one reply that counted to seven hundred outweighs fifty short exchanges.
 * 120k is a few long turns — enough that ordinary use never pays a replay, and
 * far enough below the megabyte-per-session figure that six open sessions
 * cannot add up to something worth noticing.
 */
export const CARRY_BUDGET_CHARS = 120_000

/**
 * What a backgrounded session is allowed to keep.
 *
 * Unmounting gives back a session's CPU and, measured, almost none of its
 * memory: 0.9MB of transcript held, 0.1MB released. The DOM goes and the
 * reduced view stays, because the view is what makes coming back instant — the
 * pane redraws from it and asks only for what it missed.
 *
 * That trade is worth making for a short conversation and not for a long one,
 * and the cost scales with transcript length rather than with how many sessions
 * are open. Above the budget the view is dropped and only what cannot be
 * rebuilt is kept: the draft you typed, what you attached, where you were
 * reading. The transcript comes back from the event store, which is its source
 * of truth — `Session` asks for everything after `lastSeq`, and a carry with no
 * view means a `lastSeq` of zero and a full replay.
 */
export function trimCarry(carry: SessionCarry): SessionCarry {
  return withinBudget(carry) ? carry : { ...carry, view: EMPTY_VIEW }
}

/** Stops counting at the budget: a long transcript should not cost a long scan. */
export function withinBudget(carry: SessionCarry): boolean {
  let chars = 0
  for (const message of carry.view.messages) {
    chars += message.text.length
    if (chars > CARRY_BUDGET_CHARS) return false
  }
  return true
}
