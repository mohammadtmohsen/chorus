import { describe, expect, it } from 'vitest'
import { containsPassage, plainTextOf } from './plain-text.js'

/**
 * What a selection can contain, and therefore what `openAside` must recognise.
 *
 * These are not hypotheticals: both of the first two were reproduced against the
 * running app and both were refused with "That passage is not part of that
 * reply" (C-024).
 */

describe('markdown as the transcript reads', () => {
  it('drops the backticks around inline code, as the DOM does', () => {
    // The reported case, verbatim from the reproduction.
    const said = '`docs/plan.md` — created in my last turn.'
    expect(plainTextOf(said)).toContain('docs/plan.md — created in my last turn.')
  })

  it('turns a line break inside a paragraph into a space', () => {
    /*
     * `.md-p` inherits `white-space: normal`, so the browser collapses the
     * newline the parser kept — and `selection.toString()` returns what is
     * rendered, not what was parsed.
     */
    const said = 'The projection lags behind the log and\nthat is the whole problem here.'
    expect(plainTextOf(said)).toContain(
      'The projection lags behind the log and that is the whole problem here.'
    )
  })

  it('keeps the newlines inside a fenced code block', () => {
    // A `<pre>` does not collapse them, so a selection there carries them.
    const said = '```\nconst a = 1\nconst b = 2\n```'
    expect(plainTextOf(said)).toContain('const a = 1\nconst b = 2')
  })

  it('reads emphasis and links as their text', () => {
    expect(plainTextOf('a **bold** word')).toContain('a bold word')
    expect(plainTextOf('see [the plan](https://example.com/x) now')).toContain('see the plan now')
  })

  it('does not leak a link target, which is never on screen to select', () => {
    expect(plainTextOf('see [the plan](https://example.com/secret)')).not.toContain('secret')
  })

  it('reads a list as its items', () => {
    expect(plainTextOf('- first thing\n- second thing')).toContain('first thing')
  })

  it('reads a table cell without its pipes', () => {
    const said = '| Server | What it does |\n|---|---|\n| **github** | Repos and PRs |'
    expect(plainTextOf(said)).toContain('github Repos and PRs')
  })

  it('invents nothing: text with no markup survives unchanged', () => {
    expect(plainTextOf('Just a plain sentence.')).toBe('Just a plain sentence.')
  })
})

/**
 * Every string on the left of these is what Chromium actually returned for that
 * selection, read off the entry's own markup in a real browser rather than
 * guessed. Each one was refused before this.
 */
describe('a selection the DOM produced is recognised as the reply', () => {
  const said = [
    'First paragraph line one',
    'and its wrapped line two.',
    '',
    'Second paragraph mentions `docs/plan.md` here.',
    '',
    '### A heading',
    '',
    '- first item',
    '- second item',
    '',
    '```ts',
    'const a = 1',
    'const b = 2',
    '```',
    '',
    '| Col A | Col B |',
    '|---|---|',
    '| one | two |',
  ].join('\n')

  it('accepts a drag across two paragraphs, blank line and all', () => {
    /*
     * The one that made this worth fixing. Adjacent `<p>` blocks serialize with
     * an empty line, so *any* selection over more than one paragraph carried a
     * `\n\n` the projection joined with a single `\n` — which is what selecting
     * an answer normally is.
     */
    const selected =
      'First paragraph line one and its wrapped line two.\n\nSecond paragraph mentions docs/plan.md here.'
    expect(containsPassage({ said, excerpt: selected })).toBe(true)
  })

  it('accepts a heading, which the stylesheet renders in capitals', () => {
    // `text-transform: uppercase` on `.md-h`, and the serializer applies it.
    expect(containsPassage({ said, excerpt: 'A HEADING' })).toBe(true)
  })

  it('accepts a table, whose cells serialize tab-separated', () => {
    expect(containsPassage({ said, excerpt: 'Col A\tCol B\none\ttwo' })).toBe(true)
  })

  it('accepts a whole reply selected at once', () => {
    const selected =
      'First paragraph line one and its wrapped line two.\n\n' +
      'Second paragraph mentions docs/plan.md here.\n\n' +
      'A HEADING\nfirst item\nsecond item\nconst a = 1\nconst b = 2\nCol A\tCol B\none\ttwo'
    expect(containsPassage({ said, excerpt: selected })).toBe(true)
  })

  it('still accepts a fenced block matched against the source itself', () => {
    expect(containsPassage({ said, excerpt: 'const a = 1\nconst b = 2' })).toBe(true)
  })

  it('refuses words the agent did not say', () => {
    expect(containsPassage({ said, excerpt: 'Third paragraph mentions docs/plan.md' })).toBe(false)
    expect(containsPassage({ said, excerpt: 'and its wrapped line three.' })).toBe(false)
  })

  it('refuses an empty selection, and one that is only whitespace', () => {
    expect(containsPassage({ said, excerpt: '' })).toBe(false)
    expect(containsPassage({ said, excerpt: '  \n\t ' })).toBe(false)
  })

  it('refuses a reordering, which ignoring whitespace must not smuggle in', () => {
    expect(containsPassage({ said, excerpt: 'second item\nfirst item' })).toBe(false)
  })

  it('keeps case significant outside CSS-transformed headings', () => {
    expect(containsPassage({ said: 'Use the identifier `Foo`.', excerpt: 'identifier foo' })).toBe(
      false
    )
  })
})
