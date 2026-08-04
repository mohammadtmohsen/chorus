import { describe, expect, it } from 'vitest'
import { isSafeHref, parseInline, parseMarkdown, splitBlocks } from './markdown.js'

describe('block parsing', () => {
  it('splits paragraphs on blank lines', () => {
    const blocks = parseMarkdown('one\nstill one\n\ntwo')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.kind).toBe('paragraph')
  })

  it('parses a fenced code block with its language', () => {
    const blocks = parseMarkdown('before\n\n```ts\nconst a = 1\n```\n\nafter')
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'code', 'paragraph'])
    expect(blocks[1]).toMatchObject({ language: 'ts', text: 'const a = 1' })
  })

  it('renders an unterminated fence rather than swallowing the rest', () => {
    // This is what an interrupted stream looks like mid-code-block, and it must
    // still show what arrived.
    const blocks = parseMarkdown('```js\nconst partial = ')
    expect(blocks[0]).toMatchObject({ kind: 'code', text: 'const partial = ' })
  })

  it('leaves markdown inside a code block untouched', () => {
    const blocks = parseMarkdown('```\n**not bold** and `not code`\n```')
    expect(blocks[0]).toMatchObject({ text: '**not bold** and `not code`' })
  })

  it('parses headings up to level three', () => {
    const blocks = parseMarkdown('# One\n## Two\n#### Four')
    expect(blocks.map((b) => (b.kind === 'heading' ? b.level : null))).toEqual([1, 2, 3])
  })

  it('groups consecutive bullets into one list', () => {
    const blocks = parseMarkdown('- a\n- b\n- c')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false })
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(3)
  })

  it('distinguishes ordered lists', () => {
    expect(parseMarkdown('1. first\n2. second')[0]).toMatchObject({ ordered: true })
  })

  it('joins consecutive quote lines', () => {
    const blocks = parseMarkdown('> line one\n> line two')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe('quote')
  })
})

describe('inline parsing', () => {
  it('parses code, strong and emphasis', () => {
    expect(parseInline('a `b` **c** *d*').map((i) => i.kind)).toEqual([
      'text',
      'code',
      'text',
      'strong',
      'text',
      'em',
    ])
  })

  it('keeps plain text intact when nothing matches', () => {
    expect(parseInline('just words')).toEqual([{ kind: 'text', text: 'just words' }])
  })

  it('parses a safe link', () => {
    expect(parseInline('see [docs](https://example.com)').at(-1)).toMatchObject({
      kind: 'link',
      text: 'docs',
      href: 'https://example.com',
    })
  })
})

describe('link safety', () => {
  it('accepts only http, https and mailto', () => {
    expect(isSafeHref('https://example.com')).toBe(true)
    expect(isSafeHref('http://example.com')).toBe(true)
    expect(isSafeHref('mailto:a@b.c')).toBe(true)
  })

  it.each(['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'vbscript:x'])(
    'rejects %s',
    (href) => {
      expect(isSafeHref(href)).toBe(false)
    }
  )

  it('degrades an unsafe link to literal text rather than dropping it', () => {
    // Silently deleting it would hide what the model tried to do; rendering it
    // inert shows the user exactly that.
    const parsed = parseInline('[click](javascript:alert(1))')
    expect(parsed).toEqual([{ kind: 'text', text: '[click](javascript:alert(1))' }])
  })
})

describe('injection safety', () => {
  it('never produces markup — raw HTML stays text', () => {
    // The parser has no HTML output path at all; this proves the tags survive as
    // literal characters for React to escape.
    const blocks = parseMarkdown('<script>alert(1)</script>')
    expect(blocks[0]).toMatchObject({
      kind: 'paragraph',
      content: [{ kind: 'text', text: '<script>alert(1)</script>' }],
    })
  })

  it('treats an img onerror payload as text', () => {
    const blocks = parseMarkdown('<img src=x onerror="alert(1)">')
    const content = (blocks[0] as { content: { kind: string }[] }).content
    expect(content.every((i) => i.kind === 'text')).toBe(true)
  })
})

describe('splitBlocks', () => {
  it('splits on blank lines', () => {
    expect(splitBlocks('one\n\ntwo\n\nthree')).toEqual(['one', 'two', 'three'])
  })

  it('keeps a fenced block whole, blank lines included', () => {
    // Splitting inside a fence would render an unterminated fence as prose.
    const blocks = splitBlocks('intro\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter')
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toContain('const b = 2')
  })

  it('keeps an unterminated fence in one block', () => {
    const blocks = splitBlocks('intro\n\n```ts\nconst a = 1\n\nstill inside')
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toContain('still inside')
  })

  it('returns one block when there are no blank lines', () => {
    expect(splitBlocks('just one paragraph')).toEqual(['just one paragraph'])
  })

  it('drops nothing — the blocks reparse to the same result', () => {
    // The split is a performance detail; it must not change what renders.
    for (const source of [
      'a\n\nb\n\nc',
      '# h\n\n- one\n- two\n\ntail',
      '```\nx\n\ny\n```\n\nafter',
    ]) {
      const viaSplit = splitBlocks(source).flatMap((b) => parseMarkdown(b))
      expect(viaSplit).toEqual(parseMarkdown(source))
    }
  })
})
