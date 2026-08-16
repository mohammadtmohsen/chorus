import { describe, expect, it } from 'vitest'
import { issueHref, linkifyIssues, type Tracker } from './issue-links.js'
import { isSafeHref, parseInline, parseMarkdown, type Inline } from './markdown.js'

/*
 * Every test supplies its own tracker, because the shipped default is empty.
 *
 * A tracker's host names a company and its keys name that company's projects,
 * so there is no default worth shipping and none worth asserting here either. A
 * fake one under `.example` — the RFC 2606 reserved TLD, which can never resolve
 * — keeps these tests about the matching rules rather than about one workspace.
 */
const ACME: Tracker = { baseUrl: 'https://acme.example', keys: ['ACME'] }

const text = (s: string) => ({ kind: 'text' as const, text: s })
const issue = (key: string) => ({
  kind: 'link' as const,
  href: issueHref(key, ACME),
  content: [text(key)],
})

describe('linkifyIssues', () => {
  it('turns a key into a link and leaves the rest as text', () => {
    expect(linkifyIssues([text('ACME-383 has the wrong parent')], ACME)).toEqual([
      { kind: 'link', href: `${ACME.baseUrl}/browse/ACME-383`, content: [text('ACME-383')] },
      text(' has the wrong parent'),
    ])
  })

  it('keeps the sentence punctuation outside the link', () => {
    const out = linkifyIssues([text('See ACME-383.')], ACME)
    expect(out).toEqual([text('See '), issue('ACME-383'), text('.')])
  })

  it('links every key in a run of prose', () => {
    const out = linkifyIssues([text('ACME-1 blocks ACME-22 and ACME-333')], ACME)
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
      expect(linkifyIssues([text(`encoded as ${token} here`)], ACME)).toEqual([
        text(`encoded as ${token} here`),
      ])
    }
  )

  it('does not match a key glued to a longer word', () => {
    expect(linkifyIssues([text('XACME-383 and ACMEX-9')], ACME)).toEqual([
      text('XACME-383 and ACMEX-9'),
    ])
  })

  it('does not match a lower-case lookalike', () => {
    // A key is upper case; matching loosely would catch ordinary words.
    expect(linkifyIssues([text('acme-383')], ACME)).toEqual([text('acme-383')])
  })

  it('leaves non-text nodes alone', () => {
    const nodes: Inline[] = [
      { kind: 'code', text: 'ACME-383' },
      { kind: 'link', href: 'https://example.com', content: [text('ACME-383')] },
      { kind: 'strong', content: [text('ACME-383')] },
      { kind: 'image', href: 'https://example.com/ACME-383.png', alt: 'ACME-383' },
    ]
    expect(linkifyIssues(nodes, ACME)).toEqual(nodes)
  })

  it('does nothing when no keys are configured', () => {
    const none: Tracker = { baseUrl: 'https://x.example', keys: [] }
    expect(linkifyIssues([text('ACME-383')], none)).toEqual([text('ACME-383')])
  })

  /*
   * The shipped default is that empty tracker, so this is the behaviour every
   * user gets until they configure one. Asserted separately from the case above
   * because it is a decision about what to ship, not a property of the matcher —
   * and a default that quietly acquired a host would have to fail something.
   */
  it('linkifies nothing by default', () => {
    expect(linkifyIssues([text('ACME-383 and WEB-1 and JIRA-9')])).toEqual([
      text('ACME-383 and WEB-1 and JIRA-9'),
    ])
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
    expect(isSafeHref(issueHref('ACME-383', ACME))).toBe(true)
    expect(issueHref('ACME-383', ACME)).toBe('https://acme.example/browse/ACME-383')
  })
})

/*
 * The parser runs `linkifyIssues` with the shipped default, which is empty and
 * therefore a pass-through, so each test here linkifies the parser's output with
 * `ACME` to see what a configured workspace would get. That second pass is
 * exactly what the parser does internally — and it is what proves the exemptions
 * are structural rather than textual: by this point a key in a code span is a
 * `code` node and a key in an explicit link is a `link` node, so neither can be
 * rewritten no matter which tracker is in force.
 */
describe('through the markdown parser', () => {
  it('links a key in ordinary prose', () => {
    const nodes = linkifyIssues(parseInline('ACME-383 has the wrong parent'), ACME)
    expect(nodes[0]).toMatchObject({
      kind: 'link',
      href: issueHref('ACME-383', ACME),
      content: [{ kind: 'text', text: 'ACME-383' }],
    })
  })

  it('leaves a key inside a code span as code', () => {
    const nodes = linkifyIssues(parseInline('the ticket `ACME-383` is wrong'), ACME)
    expect(nodes.some((n) => n.kind === 'link')).toBe(false)
    expect(nodes.some((n) => n.kind === 'code' && n.text === 'ACME-383')).toBe(true)
  })

  it('does not rewrite a key that is already an explicit link', () => {
    const nodes = linkifyIssues(parseInline('[ACME-383](https://example.com/x)'), ACME)
    const links = nodes.filter((n) => n.kind === 'link')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ href: 'https://example.com/x' })
  })

  it('leaves a fenced code block untouched', () => {
    const blocks = parseMarkdown('```\nACME-383\n```')
    expect(blocks[0]?.kind).toBe('code')
  })

  it('links a key inside a list item', () => {
    const blocks = parseMarkdown('- ACME-383 has the wrong parent')
    const list = blocks[0]
    expect(list?.kind).toBe('list')
    const items = list?.kind === 'list' ? list.items : []
    const content = linkifyIssues(items[0]?.content ?? [], ACME)
    expect(content.some((n) => n.kind === 'link')).toBe(true)
  })
})
