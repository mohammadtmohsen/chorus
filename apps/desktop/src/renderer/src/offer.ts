/**
 * Whether a finished reply is offering to do one thing, and waiting.
 *
 * The signal behind the `Go` action. It is a heuristic over prose, because the
 * providers give nothing structured for this case: plan mode has `ExitPlanMode`
 * and Codex has `plan.updated`, but an ordinary reply that ends "want me to?"
 * carries no event at all.
 *
 * **Every rule here was measured against the real log** — 1,276 final-of-turn
 * replies out of this machine's store — rather than imagined. The plan for this
 * feature proposed a different rule ("options *with* a recommendation are an
 * offer, options without are a question"), and the log says that distinction
 * exists in **2 replies out of 78**. The agent almost never names a preference
 * when it forks. That rule was invented and is not in this file.
 */

/**
 * The closing paragraph, which is where a reply makes its offer.
 *
 * Not the whole text: a long answer mentions "I can" a dozen times on the way
 * past, and only the last paragraph is the one still waiting for you.
 */
function closing(text: string): string {
  const whole = text.trim()
  const paragraphs = whole.split(/\n\s*\n/).filter((part) => part.trim() !== '')
  return (paragraphs.at(-1) ?? whole).replace(/\s+/g, ' ').trim()
}

/**
 * The agent offering to do something itself.
 *
 * Ordered by how often each actually appears, which is not the order anyone
 * would guess: `want me to` is 149 of them and `shall I` is 4. `let me know`
 * was in the first draft of this list on instinct and appears **zero** times.
 */
const OFFERS =
  /\b(want me to|shall i|should i|would you like me to|say the word|ready when you are|i can|i could)\b/i

/*
 * Two phrases are missing from that list on purpose, and both were in the first
 * draft. Measured over the same 1,276 replies:
 *
 * - `want that` / `want the` carried **11** verdicts and essentially all were
 *   wrong — "and I'd *want that* to be your call", "`pnpm app:install` when you
 *   *want the* terminal in it". Neither is an offer; both are ordinary prose
 *   that happens to contain the word.
 * - `I'll start` / `I'll go ahead` carried **14**, and they are the agent
 *   *announcing* it has already begun. A Go button under "I'll start by
 *   exploring the menu tree" is offering to approve something in progress.
 */

/**
 * The agent saying it is stuck, which reads like an offer and is its opposite.
 *
 * `I can` is the phrase that needs this most: it carried 28 verdicts, and they
 * split. Real offers — "I can ship 0.13.1 quickly. Your call." — sit beside
 * "there is nothing substantial left that **I can do** without one of those
 * answers" and "**I can't** size it until D-1 through D-3 are answered", which
 * are the agent reporting a block. A Go on those says nothing useful.
 *
 * Perception is the other half: "the last untested difference **I can see**" is
 * not an offer either.
 */
const NOT_AN_OFFER =
  /\bi can(not|'t)\b|\bnothing\b[^.?!]*\bi can\b|\buntil\b[^.?!]*\b(answered|decided|settled)\b|\bi can\s+(see|tell|only|confirm|find|reproduce|read|think)\b|\bneeds your call\b|\bstill needs\b[^.?!]*\bcall\b/i

/**
 * An offer whose condition is *you*.
 *
 * "**If you share** the project path, I can identify the exact changes" is not
 * something Go can accept — the agent is blocked on you, not offering to
 * proceed. Also measured, from a real reply.
 */
const NEEDS_YOU = /\bif you\b[^.?!]*\b(share|send|paste|give|tell|provide|confirm)\b/i

/**
 * Two next moves rather than one, which is the shape a single button cannot
 * serve.
 *
 * The dominant real form and the reason this function refuses more than it
 * accepts: "Want me to run the suite, **or** go straight on?" is 59 of 199
 * question-enders. Pressing one Go there does not mean "go ahead", it means
 * "you choose" — and the agent choosing silently is the failure this whole
 * detector exists to avoid.
 *
 * Bare words, deliberately — the narrowing is done by *where* this is tested
 * rather than by the pattern. It reads only the offer's own sentence, because a
 * closing paragraph mentions "the rail or the drawer" in passing constantly and
 * an anchored version ("or …?") missed every fork that ends in a full stop —
 * "Say the word and I'll open the PR — or strip the probes first."
 */
const FORK = /\bor\b|\bwhich\b|\beither\b|\brather than\b|\binstead of\b/i

/**
 * More than one thing asked, which is a fork spelled with punctuation.
 *
 * "Want me to commit the translate work — **and** should C-025 come next?" is
 * two decisions in one paragraph, and a single Go answers neither. Two question
 * marks in the closing paragraph is the cheapest reliable sign of it.
 */
const TWO_ASKS = /\?[^?]*\?/

/**
 * A second ask that never got its own question mark.
 *
 * "Want me to commit the translate work — **and should** C-025 come next?" and
 * "shall I commit this on a branch, **and do you want** C-026 next?" both read
 * as one question and are two. Measured: they survived every other rule here,
 * because the paragraph holds a single `?` and the fork lives in a conjunction.
 */
const TRAILING_ASK = /\band (should|do you|would you|which|what)\b/i

/**
 * The sentence that carries the offer, which is what the fork test must read.
 *
 * Testing the whole paragraph for `or` refuses almost everything — a closing
 * paragraph mentions "the rail or the drawer" in passing constantly. Testing
 * only the offer's own sentence is what makes a word that common usable as a
 * signal at all: "Want me to run the suite, **or** go straight on?" carries its
 * fork inside the offer, because that is what a fork *is*.
 */
function offerSentence(paragraph: string): string | null {
  const sentences = paragraph.split(/(?<=[.?!])\s+/)
  return sentences.find((sentence) => OFFERS.test(sentence)) ?? null
}

/**
 * True when there is exactly one thing to say yes to.
 *
 * **Not gated on a question mark.** 119 replies carry an offer and close with a
 * full stop — "say the word and I'll launch it" — so a punctuation rule would
 * miss every one. Measured over the whole store this shows on **140 of 1,276**
 * final-of-turn replies, about one turn in nine.
 *
 * Refusals come first and there are four of them, because the cost is asymmetric:
 * a missing chip costs one line of typing, and a wrong one sends "go ahead" at a
 * question nobody answered.
 */
export function offersToAct(text: string): boolean {
  const end = closing(text)
  if (end === '') return false
  if (TWO_ASKS.test(end) || TRAILING_ASK.test(end)) return false
  if (NEEDS_YOU.test(end)) return false
  if (NOT_AN_OFFER.test(end)) return false

  const offer = offerSentence(end)
  if (offer === null) return false
  return !FORK.test(offer)
}
