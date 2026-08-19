/**
 * A question set, normalized once and rendered the same way on both sides.
 *
 * This exists because of a guard rather than for tidiness. `openAside` refuses
 * an excerpt it cannot find in the log — the renderer is the least trustworthy
 * thing in the process tree, and a caller that could name any event and any
 * text could put words in an agent's mouth and have them quoted back as its
 * own. Asking about a *question card* means main has to be able to re-derive
 * that card's words from the logged `userinput.requested` payload and find the
 * renderer's excerpt inside them.
 *
 * Two renderings of the same payload would be a new way to be wrong, and the
 * disagreements would be exactly the questions nobody could ask about — the
 * same failure `plain-text.ts` was written for, one event type along. So the
 * normalizer and the projection live here, main and the renderer both import
 * them, and there is nothing to keep in step.
 *
 * `containsPassage` collapses whitespace, so the separators below need only be
 * *some* whitespace. What must match exactly is the order of the fields and the
 * punctuation between a label and its description — which is why that is here
 * and not written out at either call site.
 */

export interface QuestionOption {
  readonly label: string
  readonly description: string
}

export interface QuestionField {
  readonly id: string
  readonly header: string
  readonly question: string
  /** Empty means free text: the provider is asking you to type, not to choose. */
  readonly options: readonly QuestionOption[]
  readonly multiSelect: boolean
  readonly allowOther: boolean
  /** The answer is a credential: never echoed on screen, never written down. */
  readonly isSecret: boolean
}

/**
 * The questions in a `userinput.requested` payload, read defensively.
 *
 * Lifted verbatim out of `transcript.ts`, which held the only copy and is now a
 * caller. Defensive because the payload is `z.unknown()` in the event store: the
 * normalized request is logged whole rather than re-validated field by field, so
 * this is the boundary where an unreadable one becomes an empty list instead of
 * a crash mid-render.
 *
 * The capability flags are copied exactly and never inferred. `options: []`
 * means the provider asked for typed text; adding a synthetic option would put
 * an answer in front of the user that their agent cannot accept back.
 */
export function questionFields(request: unknown): QuestionField[] {
  if (typeof request !== 'object' || request === null) return []
  const asked = (request as { questions?: unknown }).questions
  if (!Array.isArray(asked)) return []

  return asked
    .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
    .map((q, index) => {
      const options = Array.isArray(q['options']) ? q['options'] : []
      return {
        // Position is a usable fallback: Claude's questions carry no id of their
        // own, and the adapter already keys them this way on the wire.
        id: typeof q['id'] === 'string' ? q['id'] : String(index),
        header: typeof q['header'] === 'string' ? q['header'] : '',
        question: typeof q['question'] === 'string' ? q['question'] : '',
        options: options
          .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
          .map((o) => ({
            label: typeof o['label'] === 'string' ? o['label'] : '',
            description: typeof o['description'] === 'string' ? o['description'] : '',
          }))
          .filter((o) => o.label !== ''),
        multiSelect: q['multiSelect'] === true,
        allowOther: q['allowOther'] === true,
        // Fails closed: an unreadable flag is treated as a secret, because
        // showing a credential once cannot be undone by fixing this later.
        isSecret: q['isSecret'] !== false,
      }
    })
    .filter((q) => q.question !== '' || q.header !== '')
}

/**
 * One question as words — the header, the prompt, and every option.
 *
 * The options are included because they are most of what is hard to read. The
 * card in the report that prompted this asked which of three data models to
 * hand to the backend, and the prompt was one sentence while the choices were
 * nine lines of `status` versus `activeFilter` versus `versionWindow`. An
 * explanation of the sentence alone would have explained the easy part.
 *
 * A secret question is rendered without its prompt on purpose — see
 * `askableQuestion`, which refuses it outright. This still returns the header so
 * that main's `said` covers every field and containment is decided by the
 * caller's own guard rather than by a gap in this string.
 */
export function questionText(field: QuestionField): string {
  const parts: string[] = []
  if (field.header !== '') parts.push(field.header)
  if (field.question !== '') parts.push(field.question)
  for (const option of field.options) {
    parts.push(option.description === '' ? option.label : `${option.label}: ${option.description}`)
  }
  return parts.join('\n')
}

/**
 * Every question in the set, which is what main compares an excerpt against.
 *
 * All of them rather than the one the card happens to be showing: a set can hold
 * four, the card steps through them, and main has no idea which step the person
 * was looking at. Concatenating means one containment check covers each of them
 * without the renderer having to say — and without main trusting it if it did.
 */
export function questionSetText(request: unknown): string {
  return questionFields(request).map(questionText).join('\n')
}

/**
 * Whether this question may be asked about, explained or translated.
 *
 * A secret is the one refusal, and it is not about the guard. The whole point of
 * `isSecret` is that the answer never reaches the log and never reaches a second
 * agent; sending the prompt to a fork is a smaller leak than the answer would be
 * but it is the same kind, and a credential prompt is not the sort of thing
 * anyone needs translated.
 *
 * An empty rendering is refused too, because `aside:open` requires a non-empty
 * excerpt and a card with neither header nor prompt has nothing to ask about.
 */
export function askableQuestion(field: QuestionField): boolean {
  return !field.isSecret && questionText(field).trim() !== ''
}
