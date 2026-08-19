import { describe, expect, it } from 'vitest'
import {
  askableQuestion,
  questionFields,
  questionSetText,
  questionText,
  type QuestionField,
} from './question-text.js'

/**
 * The projection two processes have to agree on.
 *
 * These are not tests of a formatter. `openAside` decides whether an excerpt is
 * genuinely part of a logged question by re-rendering that question in main and
 * looking for the renderer's text inside it — so a disagreement between the two
 * sides is not a cosmetic bug, it is a question nobody can ask about. The
 * containment assertions below are the ones that matter; the rest describe the
 * shape they depend on.
 */

const field = (over: Partial<QuestionField> = {}): QuestionField => ({
  id: 'q1',
  header: 'Model',
  question: 'Which model do we hand to BE?',
  options: [
    { label: 'Two keys, one axis each', description: '`status` replaces `active`.' },
    { label: 'Literally one `status` key', description: '' },
  ],
  multiSelect: false,
  allowOther: false,
  isSecret: false,
  ...over,
})

describe('questionText', () => {
  it('carries the header, the prompt and every option', () => {
    const text = questionText(field())
    expect(text).toContain('Model')
    expect(text).toContain('Which model do we hand to BE?')
    // The options are most of what is hard to read — an explanation of the
    // prompt alone would explain the easy part.
    expect(text).toContain('Two keys, one axis each: `status` replaces `active`.')
    // No dangling separator when a choice has no description.
    expect(text).toContain('Literally one `status` key')
    expect(text).not.toContain('`status` key:')
  })

  it('leaves out a part the question does not have', () => {
    expect(questionText(field({ header: '', options: [] }))).toBe('Which model do we hand to BE?')
  })
})

/**
 * The property the guard actually rests on.
 *
 * Main compares against every question in the set because it has no idea which
 * one the card was showing. Each field's own rendering must therefore appear
 * *contiguously* inside that concatenation — which is what fails the moment the
 * two sides build their strings differently.
 */
describe('questionSetText', () => {
  const request = {
    questions: [
      { id: 'a', header: 'Model', question: 'Which one?', options: [{ label: 'First' }] },
      { id: 'b', header: 'Scope', question: 'How far?', options: [{ label: 'Second' }] },
    ],
  }

  it('contains each question whole, so containment can find it', () => {
    const said = questionSetText(request)
    for (const one of questionFields(request)) {
      expect(said).toContain(questionText(one))
    }
  })

  it('is empty for a payload it cannot read', () => {
    for (const junk of [null, undefined, 42, {}, { questions: 'no' }])
      expect(questionSetText(junk)).toBe('')
  })
})

describe('questionFields', () => {
  it('falls back to position when the provider sends no id', () => {
    // Claude's questions carry no id of their own, and the adapter keys them
    // this way on the wire.
    const [first, second] = questionFields({
      questions: [{ question: 'a' }, { question: 'b' }],
    })
    expect([first?.id, second?.id]).toEqual(['0', '1'])
  })

  it('drops an option with no label and a question with no words', () => {
    const [only] = questionFields({
      questions: [
        { question: 'real', options: [{ label: '' }, { label: 'kept' }] },
        { question: '', header: '' },
      ],
    })
    expect(questionFields({ questions: [{ question: '', header: '' }] })).toEqual([])
    expect(only?.options.map((o) => o.label)).toEqual(['kept'])
  })

  /* Fails closed: showing a credential once cannot be undone by fixing this. */
  it('treats an unreadable secret flag as a secret', () => {
    const [unknown] = questionFields({ questions: [{ question: 'token?' }] })
    expect(unknown?.isSecret).toBe(true)
  })
})

describe('askableQuestion', () => {
  it('refuses a secret', () => {
    // Not the guard's doing. Handing a credential prompt to a fork is the same
    // kind of leak as logging it, which `isSecret` exists to prevent.
    expect(askableQuestion(field({ isSecret: true }))).toBe(false)
  })

  it('refuses a question with nothing to ask about', () => {
    expect(askableQuestion(field({ header: '', question: '', options: [] }))).toBe(false)
  })

  it('allows an ordinary question', () => {
    expect(askableQuestion(field())).toBe(true)
  })
})
