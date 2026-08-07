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
    expect(html).toContain('<th><span>Check</span></th>')
    expect(html).toContain('<td><span>HTTP 200</span></td>')
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
      '<ul class="md-list"><li><span>outer</span>' +
        '<ul class="md-list"><li><span>inner</span></li></ul></li></ul>'
    )
    const tasks = render('- [x] done\n- [ ] todo')
    expect(tasks).toContain('checked=""')
    expect(tasks).toContain('disabled=""')
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
    expect(render('# **bold** title')).toContain('<h3 class="md-h"><strong>')
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
