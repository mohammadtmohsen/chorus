import { EMPTY_VIEW } from './transcript.js'
import type { TranscriptMessage } from './transcript.js'
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

/**
 * Stops counting at the budget: a long transcript should not cost a long scan.
 *
 * **Messages are not the whole view, and a review caught that.** A carry with no
 * messages at all can still hold a blocked approval whose `detail` is the entire
 * command being asked about, or a question set with long options — and trimming
 * throws the view away wholesale, so anything the view retains has to be
 * weighed or the trim never fires on it. Approvals and questions are counted
 * first because there are only ever a handful of them: reaching the budget there
 * settles the question before the message walk starts.
 *
 * **This is an estimate that errs low, not an accounting of every byte.** It
 * counts the fields that can be large — the ones that actually decide whether a
 * background tab is holding a megabyte — and skips a long tail that cannot:
 * `toolRef`, `parentRef`, `noticeSource`, `handoffTo`, the `usageByActor` and
 * `openChanges` maps, and the numeric and boolean fields throughout. Adding them
 * would move the total by a fraction of a percent and cost a field-by-field walk
 * on every backgrounding.
 *
 * The direction of the error is the part worth stating: undercounting means the
 * trim fires slightly *later* than a perfect measure would, never earlier — so
 * the failure mode is holding a little more than intended, not throwing away a
 * transcript that fitted.
 */
export function withinBudget(carry: SessionCarry): boolean {
  let chars = 0

  for (const approval of carry.view.approvals) {
    chars += approval.summary.length + (approval.detail?.length ?? 0) + approval.kind.length
    if (chars > CARRY_BUDGET_CHARS) return false
  }
  for (const question of carry.view.questions) {
    for (const field of question.questions) {
      chars += field.header.length + field.question.length
      for (const option of field.options) {
        chars += option.label.length + option.description.length
        if (chars > CARRY_BUDGET_CHARS) return false
      }
      if (chars > CARRY_BUDGET_CHARS) return false
    }
  }
  for (const message of carry.view.messages) {
    chars += weigh(message, CARRY_BUDGET_CHARS - chars)
    if (chars > CARRY_BUDGET_CHARS) return false
  }

  return true
}

/**
 * What one row actually holds, not what it displays.
 *
 * `text` is the one-line summary — deliberately, because a row stays one line
 * until asked otherwise. So counting only `text` measured the smallest field on
 * the message and ignored every large one: a hook notice's `detail`, a tool's
 * `patch`, the diffs under a `changes` card, and the whole `folded` run a single
 * notice row stands for. A conversation could hold megabytes of those and weigh
 * a few hundred characters, which is exactly why the trim never fired on the
 * transcripts that most needed it.
 *
 * **`remaining` is the short-circuit, and it has to reach in here.** The budget's
 * contract is that a long transcript does not cost a long scan; leaving the
 * early exit in the caller would have kept that at the message level and lost it
 * inside — one `changes` card can carry hundreds of patches, and summing them
 * all only to be told the total was over would have turned a memory fix into a
 * CPU one. Every loop below checks, so the walk stops at the first row that
 * settles the question.
 */
function weigh(message: TranscriptMessage, remaining: number): number {
  let chars =
    message.text.length +
    (message.detail?.length ?? 0) +
    (message.patch?.length ?? 0) +
    // Small individually, but there is one per row and a long transcript is
    // mostly rows: at 4,280 of them these are tens of kilobytes on their own.
    (message.path?.length ?? 0) +
    message.key.length +
    message.eventId.length
  if (chars > remaining) return chars

  for (const line of message.summary ?? []) {
    chars += line.length
    if (chars > remaining) return chars
  }
  for (const fold of message.folded ?? []) {
    chars += fold.text.length + (fold.detail?.length ?? 0)
    if (chars > remaining) return chars
  }
  for (const file of message.changes ?? []) {
    chars += file.path.length + (file.oldPath?.length ?? 0) + (file.patch?.length ?? 0)
    if (chars > remaining) return chars
  }
  return chars
}
