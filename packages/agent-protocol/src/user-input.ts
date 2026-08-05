import type { AgentId, UserInputId } from '@chorus/shared'

/**
 * Structured questions an agent asks the user mid-turn (plan §4.2).
 *
 * Separate from `ApprovalRequest` on purpose. An approval is a yes/no about an
 * action the agent has already decided to take; a question is the agent not
 * knowing something. They share a queue in the UI and nothing else — collapsing
 * them would mean a "Deny" button on a question, which answers nothing.
 *
 * Both providers send a whole set at once and expect a whole set back, so the
 * set is the unit of identity and of answering. The wizard's "Question 2 of 3"
 * is local navigation, not a round trip.
 */

/** One selectable answer. Both providers agree on exactly this much. */
export interface UserInputOption {
  readonly label: string
  /** Why you would pick it. Codex always sends one; may be empty. */
  readonly description: string
}

/**
 * One question, as the superset of what either provider can express.
 *
 * The capability flags are the whole reason this type exists. Codex and Claude
 * disagree about what a question *is*:
 *
 *  - Codex marks `isOther`/`isSecret` per question and signals free text by
 *    sending no options. It has no multi-select flag — an array of answers is
 *    how it expresses one.
 *  - Claude marks `multiSelect` per question, always sends options, and has no
 *    concept of a secret or of free text.
 *
 * So every field a given provider cannot express is optional here, and the
 * adapter that built the request is the only thing that knows which. The
 * renderer must read these flags rather than assume, and must not invent a
 * capability the provider will not accept back.
 */
export interface UserInputQuestion {
  /** The provider's own id. Answers are keyed by it on the way back. */
  readonly id: string
  /** Short label for the question, e.g. "Auth method". */
  readonly header: string
  readonly question: string
  /**
   * Empty means free text — the user types instead of choosing.
   *
   * Codex says this with `options: null`; Claude cannot say it at all, so a
   * Claude question always arrives with options.
   */
  readonly options: readonly UserInputOption[]
  /** More than one option may be chosen. */
  readonly multiSelect: boolean
  /** An escape hatch for "none of these" that takes typed text. */
  readonly allowOther: boolean
  /**
   * The answer is a credential and must never be persisted or logged.
   *
   * Codex-only today. Redaction is enforced at the orchestrator boundary rather
   * than trusted to callers, because an answer that reaches disk once cannot be
   * unwritten by fixing the code later.
   */
  readonly isSecret: boolean
}

export interface UserInputRequest {
  readonly id: UserInputId
  readonly agentId: AgentId
  readonly questions: readonly UserInputQuestion[]
  /**
   * Wall-clock deadline, as with approvals: Chorus owns it because a blocked
   * agent behind a closed laptop is otherwise wedged forever.
   *
   * Codex additionally sends `autoResolutionMs`, which is its own shorter
   * deadline after which it stops waiting. When present, whichever comes first
   * wins, and the answer we send after that point is ignored by the provider.
   */
  readonly expiresAt: number
  /** Codex's `autoResolutionMs`, absolute. Undefined when the provider sets none. */
  readonly autoResolvesAt?: number
}

/**
 * One question's answer.
 *
 * Always an array, even for a single choice, because that is what Codex's wire
 * format is and flattening it would lose multi-select on the way back.
 * `values` holds option labels; a free-text or Other answer holds the typed
 * string.
 */
export interface UserInputAnswer {
  readonly questionId: string
  readonly values: readonly string[]
}

export type UserInputResponse =
  | { readonly outcome: 'answered'; readonly answers: readonly UserInputAnswer[] }
  /** The user dismissed it. Providers are told nothing was chosen. */
  | { readonly outcome: 'cancel' }
  /** Deadline passed. Never fabricates an answer (plan §4.4). */
  | { readonly outcome: 'timeout' }

/** An answer on its way to the event log: secret values stripped, not omitted. */
export interface RedactedAnswer {
  readonly questionId: string
  /** Null means "answered, deliberately not recorded" — not "unanswered". */
  readonly values: readonly string[] | null
}

/**
 * Strips secret answers before anything is written down.
 *
 * Enforced here, at the boundary, rather than trusted to each caller: an answer
 * that reaches disk once cannot be unwritten by fixing the code afterwards, so
 * the redaction has to sit on the single path to the store rather than at every
 * place that might take one.
 *
 * A question we no longer recognise is treated as secret. Failing closed costs
 * a line of audit detail; failing open costs a credential.
 */
export function redactAnswers(
  request: UserInputRequest,
  answers: readonly UserInputAnswer[]
): readonly RedactedAnswer[] {
  return answers.map((a) => {
    const question = request.questions.find((q) => q.id === a.questionId)
    return question === undefined || question.isSecret
      ? { questionId: a.questionId, values: null }
      : { questionId: a.questionId, values: [...a.values] }
  })
}

/** True when the question cannot be answered by picking, so the UI needs a field. */
export function isFreeText(question: UserInputQuestion): boolean {
  return question.options.length === 0
}

/**
 * Whether a set of answers is complete enough to send.
 *
 * Every question must have at least one value: both providers key their
 * response by question id, and a missing key is not "skipped", it is malformed.
 */
export function isComplete(
  request: UserInputRequest,
  answers: readonly UserInputAnswer[]
): boolean {
  return request.questions.every((q) => {
    const answer = answers.find((a) => a.questionId === q.id)
    return answer?.values.some((v) => v.trim() !== '') === true
  })
}
