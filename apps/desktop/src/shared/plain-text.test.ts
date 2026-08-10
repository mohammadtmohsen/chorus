import { describe, expect, it } from 'vitest'
import { plainTextOf } from './plain-text.js'

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
