import { describe, expect, it } from 'vitest'
import { issueHref, linkifyIssues, TRACKER, type Tracker } from './issue-links.js'
import { isSafeHref, parseInline, parseMarkdown, type Inline } from './markdown.js'

const text = (s: string) => ({ kind: 'text' as const, text: s })
const issue = (key: string) => ({
  kind: 'link' as const,
  href: issueHref(key),
  content: [text(key)],
})

describe('linkifyIssues', () => {
  it('turns a key into a link and leaves the rest as text', () => {
    expect(linkifyIssues([text('ACME-383 has the wrong parent')])).toEqual([
      { kind: 'link', href: `${TRACKER.baseUrl}/browse/ACME-383`, content: [text('ACME-383')] },
      text(' has the wrong parent'),
    ])
  })

  it('keeps the sentence punctuation outside the link', () => {
    const out = linkifyIssues([text('See ACME-383.')])
    expect(out).toEqual([text('See '), issue('ACME-383'), text('.')])
  })

  it('links every key in a run of prose', () => {
    const out = linkifyIssues([text('ACME-1 blocks ACME-22 and ACME-333')])
    expect(out.filter((n) => n.kind === 'link')).toEqual([
      issue('ACME-1'),
      issue('ACME-22'),
      issue('ACME-333'),
    ])
  })

  /*
   * The whole reason this matches a key list rather than a pattern. Every one of
   * these matches the obvious `[A-Z]+-\d+` rule, and every one of them turns up
   * in a transcript about code.
   */
  it.each(['UTF-8', 'ISO-8601', 'SHA-256', 'RFC-2119', 'COVID-19', 'HTTP-2'])(
    'does not linkify %s',
    (token) => {
      expect(linkifyIssues([text(`encoded as ${token} here`)])).toEqual([
        text(`encoded as ${token} here`),
      ])
    }
  )

  it('does not match a key glued to a longer word', () => {
    expect(linkifyIssues([text('XTPA-383 and TPAX-9')])).toEqual([text('XTPA-383 and TPAX-9')])
  })

  it('does not match a lower-case lookalike', () => {
    // A key is upper case; matching loosely would catch ordinary words.
    expect(linkifyIssues([text('tpa-383')])).toEqual([text('tpa-383')])
  })

  it('leaves non-text nodes alone', () => {
    const nodes: Inline[] = [
      { kind: 'code', text: 'ACME-383' },
      { kind: 'link', href: 'https://example.com', content: [text('ACME-383')] },
      { kind: 'strong', content: [text('ACME-383')] },
      { kind: 'image', href: 'https://example.com/ACME-383.png', alt: 'ACME-383' },
    ]
    expect(linkifyIssues(nodes)).toEqual(nodes)
  })

  it('does nothing when no keys are configured', () => {
    const none: Tracker = { baseUrl: 'https://x.example', keys: [] }
    expect(linkifyIssues([text('ACME-383')], none)).toEqual([text('ACME-383')])
  })

  it('treats a configured key as a literal, not a pattern', () => {
    const odd: Tracker = { baseUrl: 'https://x.example', keys: ['A.C'] }
    // `.` must not match 'B'.
    expect(linkifyIssues([text('ABC-1')], odd)).toEqual([text('ABC-1')])
    expect(linkifyIssues([text('A.C-1')], odd)[0]).toMatchObject({ kind: 'link' })
  })

  it('produces an href the renderer will actually open', () => {
    // `MarkdownView` renders links with target=_blank and `security.ts` only
    // hands https to the browser, so an unsafe scheme here would silently do
    // nothing.
    expect(isSafeHref(issueHref('ACME-383'))).toBe(true)
    expect(issueHref('ACME-383')).toBe('https://acme.example/browse/ACME-383')
  })
})

describe('through the markdown parser', () => {
  it('links a key in ordinary prose', () => {
    const nodes = parseInline('ACME-383 has the wrong parent')
    expect(nodes[0]).toMatchObject({
      kind: 'link',
      href: issueHref('ACME-383'),
      content: [{ kind: 'text', text: 'ACME-383' }],
    })
  })

  it('leaves a key inside a code span as code', () => {
    const nodes = parseInline('the ticket `ACME-383` is wrong')
    expect(nodes.some((n) => n.kind === 'link')).toBe(false)
    expect(nodes.some((n) => n.kind === 'code' && n.text === 'ACME-383')).toBe(true)
  })

  it('does not rewrite a key that is already an explicit link', () => {
    const nodes = parseInline('[ACME-383](https://example.com/x)')
    const links = nodes.filter((n) => n.kind === 'link')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ href: 'https://example.com/x' })
  })

  it('leaves a fenced code block untouched', () => {
    const blocks = parseMarkdown('```\nTPA-383\n```')
    expect(blocks[0]?.kind).toBe('code')
  })

  it('links a key inside a list item', () => {
    const blocks = parseMarkdown('- ACME-383 has the wrong parent')
    const list = blocks[0]
    expect(list?.kind).toBe('list')
    const items = list?.kind === 'list' ? list.items : []
    expect(items[0]?.content.some((n) => n.kind === 'link')).toBe(true)
  })
})
