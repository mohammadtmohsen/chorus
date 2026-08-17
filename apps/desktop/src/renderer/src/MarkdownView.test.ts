import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownView } from './MarkdownView.js'

/**
 * The parser's tests prove the tree; these prove the elements.
 *
 * Worth having separately because the bug that prompted all of this was visible
 * only in the output — a table parsed correctly but rendered through the
 * paragraph case would still have looked exactly like the screenshot.
 *
 * `renderToStaticMarkup` rather than a DOM: no jsdom, no test-library, and the
 * assertion is about the markup, which is the thing under test.
 */
const render = (source: string): string =>
  renderToStaticMarkup(createElement(MarkdownView, { source }))

describe('MarkdownView', () => {
  it('renders a pipe table as a real table', () => {
    const html = render('| Check | Before | After |\n|---|---|---|\n| /login | none | HTTP 200 |')
    expect(html).toContain('<table class="md-table">')
    // `dir="auto"` on every cell: a table can hold a right-to-left phrase in one
    // column and an English identifier in the next.
    expect(html).toContain('<th dir="auto"><span>Check</span></th>')
    expect(html).toContain('<td dir="auto"><span>HTTP 200</span></td>')
    // The delimiter row was the visible symptom of the old behaviour.
    expect(html).not.toContain('---')
    expect(html).not.toContain('|')
  })

  it('carries table alignment onto the cells', () => {
    const html = render('| a | b |\n| :-: | --: |\n| 1 | 2 |')
    expect(html).toContain('text-align:center')
    expect(html).toContain('text-align:right')
  })

  it('renders nested and task lists', () => {
    expect(render('- outer\n  - inner')).toBe(
      '<ul class="md-list"><li dir="auto"><span>outer</span>' +
        '<ul class="md-list"><li dir="auto"><span>inner</span></li></ul></li></ul>'
    )
    const tasks = render('- [x] done\n- [ ] todo')
    expect(tasks).toContain('checked=""')
    expect(tasks).toContain('disabled=""')
  })

  /**
   * Direction is a property of the text, and the markup is what carries it.
   *
   * An agent answering in Arabic produces right-to-left paragraphs; laid out
   * left-to-right the sentence reads but its punctuation sits on the wrong end.
   * `auto` takes the direction from each block's own first strong character,
   * which is the only rule that works when the language is free text somebody
   * typed into a settings field.
   */
  it('lets every block of prose decide its own direction', () => {
    expect(render('مرحبا')).toContain('<p class="md-p" dir="auto">')
    expect(render('> quoted')).toContain('<blockquote class="md-quote" dir="auto">')
  })

  /*
   * The exception, and it is not a preference. A fenced block that inherited a
   * right-to-left direction moves its own punctuation — `);` to the left of the
   * line, a diff's leading `-` to the right — which is code that no longer says
   * what it says.
   */
  it('pins a fenced block left-to-right, whatever surrounds it', () => {
    expect(render('```ts\nconst a = 1\n```')).toContain('<pre class="md-code" dir="ltr">')
  })

  it('keeps an ordered list on its own numbering', () => {
    expect(render('3. third\n4. fourth')).toContain('<ol class="md-list" start="3">')
  })

  it('renders a thematic break and strikethrough', () => {
    expect(render('---')).toContain('<hr class="md-hr"/>')
    expect(render('~~gone~~')).toContain('<del>')
  })

  it('renders nested emphasis inside a link and a heading', () => {
    expect(render('[see `x`](https://example.com)')).toContain(
      '<code class="md-inline-code">x</code></a>'
    )
    expect(render('# **bold** title')).toContain('<h3 class="md-h" dir="auto"><strong>')
  })

  it('renders an image as a link, never an img element', () => {
    // `security.ts` sets `img-src 'self' data:`, and an agent-chosen image url is
    // a tracking beacon; the link keeps the reference usable instead.
    const html = render('![a shot](https://example.com/x.png)')
    expect(html).toContain('class="md-image"')
    expect(html).not.toContain('<img')
  })

  it('escapes everything — no markup survives from the source', () => {
    const html = render('<script>alert(1)</script>\n\n| <b>x</b> |\n| - |\n| y |')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('opens links in the OS browser, never in the renderer', () => {
    // `security.ts` turns target=_blank into `shell.openExternal`; without rel
    // the opened page would get a handle on this window.
    const html = render('see https://example.com')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('target="_blank"')
  })
})
