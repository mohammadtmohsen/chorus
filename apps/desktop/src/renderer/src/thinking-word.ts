/**
 * The word a silent agent shows while it has said nothing yet.
 *
 * Between sending a message and the first token there is a gap — the provider is
 * connecting, the model is loading context, a hook is running — and the pane
 * showed one fixed word ("thinking") with three dots under it for all of it. A
 * word that never changes stops being read after the second time, and a long gap
 * then looks the same as a wedged session, which is the one thing it must not.
 *
 * So the word rotates. This is the pure part: which word, given how long has
 * passed. Kept out of the component so it can be tested without a timer, in
 * keeping with the rule that the judgement lives in the pure function and the
 * component is plumbing.
 */

/**
 * How long each word holds.
 *
 * Slow enough to be read rather than watched — anything under about two seconds
 * turns the row into a slot machine, and the point is reassurance, not motion.
 */
export const THINKING_WORD_MS = 2_600

/**
 * How long the waiting row may claim a turn is starting before it gives up.
 *
 * Every other way out of that row is an event that arrives — an agent starting,
 * a system notice, a send that rejects. A send that neither lands nor fails
 * clears none of them, and the row was then permanent: a finished reply with
 * `getting started •••` under it, seen in the field.
 *
 * Ninety seconds is chosen to be uncontroversial rather than tight. The gap this
 * row covers is a cold CLI start, which is seconds; a wait that reaches a minute
 * and a half is not a slow start, so ending it cannot cut a real one short.
 */
export const AWAITING_MAX_MS = 90_000

/**
 * Which word to show, from a list, after `elapsedMs`.
 *
 * Deterministic on elapsed time rather than random: two agents thinking side by
 * side would otherwise land on the same word by chance and look like a repeat,
 * and a test could not say what it expects. Callers offset by agent to keep two
 * rows out of step.
 *
 * Wraps rather than sticking on the last word, and returns the first word for a
 * zero-length list's caller to handle — an empty list means the translation is
 * missing, which is a bug worth showing as an empty word rather than a crash.
 */
export function thinkingWord(words: readonly string[], elapsedMs: number, offset = 0): string {
  if (words.length === 0) return ''
  const step = Math.floor(Math.max(0, elapsedMs) / THINKING_WORD_MS)
  return words[(step + offset) % words.length] ?? ''
}

/**
 * A stable offset for an actor, so two agents thinking at once say different
 * things.
 *
 * From the name rather than from a position in `participants`: `view.working`
 * carries `TranscriptEvent['actor']`, which includes `user` and `system` and is
 * not the `AgentId[]` the participant list holds. Indexing one by the other is a
 * type error today and would have been a silent `-1` if the types were looser.
 *
 * Any stable spread will do — this is presentation, not identity — so a sum of
 * character codes is enough and cannot fail on an actor nobody has added yet.
 */
export function offsetForActor(actor: string): number {
  let sum = 0
  for (let i = 0; i < actor.length; i += 1) sum += actor.charCodeAt(i)
  return sum
}
