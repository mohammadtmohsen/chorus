import { describe, expect, it } from 'vitest'
import { offsetForActor, thinkingWord, THINKING_WORD_MS } from './thinking-word.js'

const WORDS = ['thinking', 'reading', 'considering']

describe('thinkingWord', () => {
  it('holds each word for its full interval', () => {
    expect(thinkingWord(WORDS, 0)).toBe('thinking')
    expect(thinkingWord(WORDS, THINKING_WORD_MS - 1)).toBe('thinking')
    expect(thinkingWord(WORDS, THINKING_WORD_MS)).toBe('reading')
  })

  it('wraps rather than sticking on the last word', () => {
    expect(thinkingWord(WORDS, THINKING_WORD_MS * 3)).toBe('thinking')
    expect(thinkingWord(WORDS, THINKING_WORD_MS * 100)).toBe('reading')
  })

  /*
   * The row is mounted the moment a turn starts and unmounted on the first
   * token, so a clock that has not advanced is the common case rather than an
   * edge one — and a negative one is what a system clock change looks like.
   */
  it('shows the first word at zero and survives a clock going backwards', () => {
    expect(thinkingWord(WORDS, 0)).toBe('thinking')
    expect(thinkingWord(WORDS, -5_000)).toBe('thinking')
  })

  /* An empty list means the translation is missing. Better an empty word than a
     crash in the one row that exists to say things are fine. */
  it('is empty rather than throwing on an empty list', () => {
    expect(thinkingWord([], 1_000)).toBe('')
  })

  it('puts two actors out of step at the same instant', () => {
    const a = thinkingWord(WORDS, 0, offsetForActor('claude'))
    const b = thinkingWord(WORDS, 0, offsetForActor('codex'))
    expect(a).not.toBe(b)
  })
})

describe('offsetForActor', () => {
  it('is stable for the same actor', () => {
    expect(offsetForActor('claude')).toBe(offsetForActor('claude'))
  })

  /*
   * Derived from the name, not from a position in `participants` — that list is
   * `AgentId[]` while `view.working` carries `TranscriptEvent['actor']`, which
   * also holds `user` and `system`. Indexing one by the other was a type error;
   * with looser types it would have been a silent -1 for every actor.
   */
  it('accepts any actor, including ones that are not agents', () => {
    expect(offsetForActor('system')).toBeGreaterThan(0)
    expect(offsetForActor('')).toBe(0)
  })
})
