/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { READ_PREVIEW_SELECTION } from './preview-selection.js'

const source = 'vscode-remote://localhost/Users/person/project/docs/readme.md'

function read(): unknown {
  const result: unknown = window.eval(READ_PREVIEW_SELECTION)
  return result
}

function preview(html: string, lineCount: number) {
  const frame = document.createElement('iframe')
  frame.id = 'active-frame'
  document.body.replaceChildren(frame)
  const doc = frame.contentDocument
  const win = frame.contentWindow
  if (doc === null || win === null) throw new Error('Missing preview fixture document')
  const data = doc.createElement('meta')
  data.id = 'vscode-markdown-preview-data'
  data.setAttribute('data-settings', JSON.stringify({ source }))
  doc.head.replaceChildren(data)
  doc.body.innerHTML = html
  const sentinel = doc.createElement('div')
  sentinel.className = 'code-line'
  sentinel.setAttribute('data-line', String(lineCount))
  doc.body.appendChild(sentinel)
  const markers = Array.from(doc.querySelectorAll('.code-line[data-line]'))
  for (const [index, marker] of markers.entries()) {
    vi.spyOn(marker, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 100, 100, 20))
  }
  const element = (selector: string): Element => {
    const found = doc.querySelector(selector)
    if (found === null) throw new Error('Missing preview fixture element')
    return found
  }
  const text = (selector: string): Text => {
    const node = element(selector).firstChild
    if (node?.nodeType !== 3) throw new Error('Missing preview fixture text')
    return node as Text
  }
  const select = (start: Node, from: number, end: Node, to: number): string => {
    const range = doc.createRange()
    range.setStart(start, from)
    range.setEnd(end, to)
    const selection = win.getSelection()
    if (selection === null) throw new Error('Missing preview fixture selection')
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  }
  return { doc, element, text, select, sentinel }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('Markdown preview selection', () => {
  it('returns null when the active frame is absent', () => {
    expect(read()).toBeNull()
  })

  it('returns null for a webview without Markdown preview metadata', () => {
    const fixture = preview('<p>Other content</p>', 1)
    fixture.doc.head.replaceChildren()
    expect(read()).toBeNull()
  })

  it('keeps the parent line when a parent list item and its nested child are selected', () => {
    const fixture = preview(
      '<ul class="code-line" data-line="0"><li id="parent" class="code-line" data-line="0">Parent<ul class="code-line" data-line="1"><li id="child" class="code-line" data-line="1">Child</li></ul></li></ul><p class="code-line" data-line="3">Later</p>',
      4
    )
    const text = fixture.select(fixture.text('#parent'), 0, fixture.text('#child'), 5)
    expect(read()).toEqual({ source, text, startLine: 1, endLine: 3 })
  })

  it('maps a nested child selection to the child block', () => {
    const fixture = preview(
      '<ul class="code-line" data-line="0"><li class="code-line" data-line="0">Parent<ul class="code-line" data-line="1"><li id="child" class="code-line" data-line="1">Child</li></ul></li></ul><p class="code-line" data-line="3">Later</p>',
      4
    )
    const text = fixture.select(fixture.text('#child'), 0, fixture.text('#child'), 5)
    expect(read()).toEqual({ source, text, startLine: 2, endLine: 3 })
  })

  it('excludes a following block when a selection ends at its element offset zero', () => {
    const fixture = preview(
      '<p id="first" class="code-line" data-line="0">First</p><p id="next" class="code-line" data-line="2">Next</p>',
      3
    )
    const text = fixture.select(fixture.text('#first'), 0, fixture.element('#next'), 0)
    expect(read()).toEqual({ source, text, startLine: 1, endLine: 2 })
  })

  it('excludes a following block when a selection ends at its text-node offset zero', () => {
    const fixture = preview(
      '<p id="first" class="code-line" data-line="0">First</p><p id="next" class="code-line" data-line="2">Next</p>',
      3
    )
    const text = fixture.select(fixture.text('#first'), 0, fixture.text('#next'), 0)
    expect(read()).toEqual({ source, text, startLine: 1, endLine: 2 })
  })

  it('uses the empty preceding source marker for rendered raw HTML', () => {
    const fixture = preview(
      '<p class="code-line" data-line="0">Before</p><div class="code-line" data-line="4"></div><section id="raw">Raw <strong id="strong">HTML</strong></section><p class="code-line" data-line="7">Later</p>',
      8
    )
    const text = fixture.select(fixture.text('#raw'), 0, fixture.text('#strong'), 4)
    expect(read()).toEqual({ source, text, startLine: 5, endLine: 7 })
  })

  it('maps rendered front matter before the first marker to the beginning of the file', () => {
    const fixture = preview(
      '<table class="frontmatter"><tbody><tr><th>title</th><td id="front">A title</td></tr></tbody></table><h1 class="code-line" data-line="5">Heading</h1>',
      7
    )
    const text = fixture.select(fixture.text('#front'), 0, fixture.text('#front'), 7)
    expect(read()).toEqual({ source, text, startLine: 1, endLine: 5 })
  })

  it('maps selected table cells to their own rows', () => {
    const fixture = preview(
      '<table class="code-line" data-line="3"><thead class="code-line" data-line="3"><tr class="code-line" data-line="3"><th id="header">Header</th></tr></thead><tbody class="code-line" data-line="5"><tr class="code-line" data-line="5"><td id="cell">Cell</td></tr></tbody></table><p class="code-line" data-line="7">Later</p>',
      8
    )
    const text = fixture.select(fixture.text('#header'), 0, fixture.text('#cell'), 4)
    expect(read()).toEqual({ source, text, startLine: 4, endLine: 7 })
  })

  it('uses the sentinel as the end of the final selected block', () => {
    const fixture = preview('<p id="last" class="code-line" data-line="4">Last</p>', 8)
    const text = fixture.select(fixture.text('#last'), 0, fixture.sentinel, 0)
    expect(read()).toEqual({ source, text, startLine: 5, endLine: 8 })
  })

  it('reports the nested block at the viewport top when there is no selection', () => {
    const fixture = preview(
      '<ul class="code-line" data-line="0"><li id="old" class="code-line" data-line="0">Old</li><li id="visible" class="code-line" data-line="5">Visible</li></ul><p class="code-line" data-line="8">Later</p>',
      10
    )
    vi.spyOn(fixture.element('ul'), 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, -100, 100, 200)
    )
    vi.spyOn(fixture.element('#old'), 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, -100, 100, 20)
    )
    vi.spyOn(fixture.element('#visible'), 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, -5, 100, 20)
    )
    expect(read()).toEqual({ source, text: '', startLine: 6, endLine: 6 })
  })

  it('clamps a visible sentinel to the final source line', () => {
    const fixture = preview('<p class="code-line" data-line="4">Last</p>', 8)
    vi.spyOn(fixture.sentinel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -1, 100, 0))
    expect(read()).toEqual({ source, text: '', startLine: 8, endLine: 8 })
  })

  it('reports line one when front matter fills the viewport without a selection', () => {
    const fixture = preview(
      '<table class="frontmatter"><tbody><tr><th>title</th><td>A title</td></tr></tbody></table><h1 class="code-line" data-line="5">Heading</h1>',
      7
    )
    vi.spyOn(fixture.element('h1'), 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 500, 100, 20)
    )
    expect(read()).toEqual({ source, text: '', startLine: 1, endLine: 1 })
  })
})
