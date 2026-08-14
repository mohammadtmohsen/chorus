import { describe, expect, it } from 'vitest'
import {
  isSafeHref,
  parseInline,
  parseMarkdown,
  splitBlocks,
  trailingSummary,
  type Block,
  type Inline,
} from './markdown.js'

/** Narrowed rather than cast: asserting across the union hides real mistakes. */
const only = <K extends Block['kind']>(source: string, kind: K): Extract<Block, { kind: K }> => {
  const block = parseMarkdown(source)[0]
  expect(block?.kind).toBe(kind)
  return block as Extract<Block, { kind: K }>
}

/** Flattens an inline tree to its visible text, so nesting is easy to assert. */
const textOf = (nodes: readonly Inline[]): string =>
  nodes
    .map((n) => {
      switch (n.kind) {
        case 'text':
        case 'code':
          return n.text
        case 'image':
          return n.alt
        case 'link':
        case 'strong':
        case 'em':
        case 'del':
          return textOf(n.content)
      }
    })
    .join('')

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

  it('accepts a tilde fence and an info string past the language', () => {
    expect(only('~~~python title="x"\nprint(1)\n~~~', 'code')).toMatchObject({
      language: 'python',
      text: 'print(1)',
    })
  })

  it('parses headings up to level three', () => {
    const blocks = parseMarkdown('# One\n## Two\n#### Four')
    expect(blocks.map((b) => (b.kind === 'heading' ? b.level : null))).toEqual([1, 2, 3])
  })

  it('drops a heading closing sequence', () => {
    expect(textOf(only('## Two ##', 'heading').content)).toBe('Two')
  })

  it('parses setext headings from the line underneath', () => {
    expect(only('Title\n=====', 'heading')).toMatchObject({ level: 1 })
    expect(only('Title\n-----', 'heading')).toMatchObject({ level: 2 })
  })

  it('parses a thematic break, but not a setext underline', () => {
    expect(parseMarkdown('one\n\n---\n\ntwo').map((b) => b.kind)).toEqual([
      'paragraph',
      'rule',
      'paragraph',
    ])
    expect(only('***', 'rule')).toBeDefined()
  })

  it('parses an indented code block only where one can start', () => {
    expect(only('    const a = 1', 'code')).toMatchObject({ language: null, text: 'const a = 1' })
    // Four spaces under an open paragraph is a wrapped sentence, not code.
    expect(only('prose\n    still prose', 'paragraph')).toBeDefined()
  })

  it('groups consecutive bullets into one list', () => {
    const list = only('- a\n- b\n- c', 'list')
    expect(list.ordered).toBe(false)
    expect(list.items).toHaveLength(3)
    expect(list.items.map((i) => textOf(i.content))).toEqual(['a', 'b', 'c'])
  })

  it('distinguishes ordered lists and keeps their first number', () => {
    expect(only('1. first\n2. second', 'list')).toMatchObject({ ordered: true, start: 1 })
    expect(only('3. third\n4. fourth', 'list')).toMatchObject({ start: 3 })
  })

  it('nests an indented list under the item above it', () => {
    const list = only('- outer\n  - inner\n  - also inner\n- second', 'list')
    expect(list.items).toHaveLength(2)
    const nested = list.items[0]?.children[0]
    expect(nested?.kind).toBe('list')
    expect(nested?.kind === 'list' ? nested.items : []).toHaveLength(2)
  })

  it('keeps a code block that belongs to a list item inside it', () => {
    const list = only('- run this:\n\n  ```sh\n  npm test\n  ```\n', 'list')
    expect(list.items[0]?.children.map((b) => b.kind)).toEqual(['code'])
  })

  it('reads task list checkboxes', () => {
    const list = only('- [ ] todo\n- [x] done\n- plain', 'list')
    expect(list.items.map((i) => i.checked)).toEqual([false, true, null])
    // The marker is consumed, not left in the text.
    expect(list.items.map((i) => textOf(i.content))).toEqual(['todo', 'done', 'plain'])
  })

  it('does not read emphasis or a decimal as a bullet', () => {
    expect(only('*bold text*', 'paragraph')).toBeDefined()
    expect(only('1.5x faster', 'paragraph')).toBeDefined()
  })

  it('joins consecutive quote lines', () => {
    const quote = only('> line one\n> line two', 'quote')
    expect(quote.blocks.map((b) => b.kind)).toEqual(['paragraph'])
  })

  it('parses blocks inside a quote as blocks', () => {
    const quote = only('> - one\n> - two\n>\n> tail', 'quote')
    expect(quote.blocks.map((b) => b.kind)).toEqual(['list', 'paragraph'])
  })

  it('survives absurd nesting instead of overflowing the stack', () => {
    // Untrusted input: `>` repeated is one stack frame per level in a naive
    // parser, and taking the renderer down is a denial of service.
    expect(() => parseMarkdown(`${'> '.repeat(5000)}deep`)).not.toThrow()
  })
})

describe('tables', () => {
  const SIMPLE = '| Check | Before | After |\n|---|---|---|\n| next start | none | HTTP 200 |'

  it('parses a pipe table into head and rows', () => {
    const table = only(SIMPLE, 'table')
    expect(table.head.map(textOf)).toEqual(['Check', 'Before', 'After'])
    expect(table.rows.map((r) => r.map(textOf))).toEqual([['next start', 'none', 'HTTP 200']])
  })

  it('reads alignment from the delimiter row', () => {
    const table = only('| a | b | c | d |\n| :- | -: | :-: | - |\n| 1 | 2 | 3 | 4 |', 'table')
    expect(table.align).toEqual(['left', 'right', 'center', null])
  })

  it('parses cells as markdown', () => {
    const table = only('| a |\n| - |\n| `code` and **bold** |', 'table')
    expect(table.rows[0]?.[0]?.map((n) => n.kind)).toEqual(['code', 'text', 'strong'])
  })

  it('keeps a pipe inside a code span in one cell', () => {
    const table = only('| a | b |\n| - | - |\n| `x|y` | z |', 'table')
    expect(table.rows[0]?.map(textOf)).toEqual(['x|y', 'z'])
  })

  it('honours an escaped pipe as content', () => {
    const table = only('| a | b |\n| - | - |\n| x \\| y | z |', 'table')
    expect(table.rows[0]?.map(textOf)).toEqual(['x | y', 'z'])
  })

  it('pads short rows and truncates long ones so the table stays rectangular', () => {
    const table = only('| a | b | c |\n| - | - | - |\n| 1 |\n| 1 | 2 | 3 | 4 |', 'table')
    expect(table.rows.map((r) => r.length)).toEqual([3, 3])
    expect(table.rows[0]?.map(textOf)).toEqual(['1', '', ''])
  })

  it('works without outer pipes', () => {
    const table = only('a | b\n- | -\n1 | 2', 'table')
    expect(table.head.map(textOf)).toEqual(['a', 'b'])
  })

  it('starts directly under a paragraph line', () => {
    expect(parseMarkdown(`intro\n${SIMPLE}`).map((b) => b.kind)).toEqual(['paragraph', 'table'])
  })

  it('ends at a blank line or a line with no pipes', () => {
    const blocks = parseMarkdown(`${SIMPLE}\ntail with no pipes`)
    expect(blocks.map((b) => b.kind)).toEqual(['table', 'paragraph'])
  })

  it('needs a delimiter row — prose containing a pipe stays prose', () => {
    expect(only('use a | b for alternatives', 'paragraph')).toBeDefined()
    // Cell counts that disagree are not a table either.
    expect(only('| a | b |\n| --- |', 'paragraph')).toBeDefined()
  })

  it('does not leave the delimiter row visible, which was the bug', () => {
    const rendered = parseMarkdown(SIMPLE)
      .map((b) => (b.kind === 'paragraph' ? textOf(b.content) : ''))
      .join('')
    expect(rendered).not.toContain('---')
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

  it('parses nested inline markup', () => {
    const [node] = parseInline('**bold with `code` inside**')
    expect(node?.kind).toBe('strong')
    expect(node?.kind === 'strong' ? node.content.map((n) => n.kind) : []).toEqual([
      'text',
      'code',
      'text',
    ])
  })

  it('parses a triple run as both, with no stray marker', () => {
    const [node] = parseInline('***both***')
    expect(node).toMatchObject({ kind: 'strong' })
    expect(node?.kind === 'strong' ? node.content[0]?.kind : null).toBe('em')
    expect(textOf(parseInline('***both***'))).toBe('both')
  })

  it('parses strikethrough', () => {
    expect(parseInline('~~gone~~')[0]).toMatchObject({ kind: 'del' })
    expect(parseInline('~gone~')[0]).toMatchObject({ kind: 'del' })
  })

  it('leaves underscores inside a word alone', () => {
    // `snake_case_name` is an identifier, and a transcript full of coding agents
    // is the most likely place on earth to contain one. GFM's intraword rule is
    // what protects it, and this is the case the old parser got wrong.
    expect(parseInline('snake_case_name')).toEqual([{ kind: 'text', text: 'snake_case_name' }])
    expect(parseInline('a_b_c')).toEqual([{ kind: 'text', text: 'a_b_c' }])
    expect(parseInline('_real emphasis_')[0]).toMatchObject({ kind: 'em' })
  })

  it('does not read arithmetic as emphasis', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }])
  })

  it('honours backslash escapes', () => {
    expect(parseInline('\\*not emphasis\\*')).toEqual([{ kind: 'text', text: '*not emphasis*' }])
  })

  it('parses a code span containing backticks', () => {
    expect(parseInline('`` a `b` c ``')).toEqual([{ kind: 'code', text: 'a `b` c' }])
  })

  it('leaves an unterminated code span as text', () => {
    expect(parseInline('a ` b')).toEqual([{ kind: 'text', text: 'a ` b' }])
  })

  it('parses a safe link', () => {
    expect(parseInline('see [docs](https://example.com)').at(-1)).toMatchObject({
      kind: 'link',
      href: 'https://example.com',
    })
  })

  it('parses a link title and angle-bracketed href', () => {
    expect(parseInline('[x](<https://example.com/a b> "title")')[0]).toMatchObject({
      kind: 'link',
      href: 'https://example.com/a b',
    })
  })

  it('links a bare url without swallowing the sentence punctuation', () => {
    const nodes = parseInline('see https://example.com/x. next')
    expect(nodes[1]).toMatchObject({ kind: 'link', href: 'https://example.com/x' })
    expect(nodes[2]).toMatchObject({ kind: 'text', text: '. next' })
  })

  it('parses an angle autolink', () => {
    expect(parseInline('<https://example.com>')[0]).toMatchObject({
      kind: 'link',
      href: 'https://example.com',
    })
  })

  it('does not link a url that is part of a longer word', () => {
    expect(parseInline('xhttps://example.com')).toEqual([
      { kind: 'text', text: 'xhttps://example.com' },
    ])
  })

  it('carries an image as a reference rather than an element', () => {
    // The renderer's CSP blocks remote images, and an `<img>` an agent chose the
    // url for is a tracking beacon; this keeps it openable instead.
    expect(parseInline('![a shot](https://example.com/x.png)')[0]).toMatchObject({
      kind: 'image',
      alt: 'a shot',
      href: 'https://example.com/x.png',
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

  it('degrades an unsafe image the same way', () => {
    expect(parseInline('![x](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '![x](javascript:alert(1))' },
    ])
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
    const block = parseMarkdown('<img src=x onerror="alert(1)">')[0]
    expect(block?.kind).toBe('paragraph')
    const content = block?.kind === 'paragraph' ? block.content : []
    expect(content.every((i) => i.kind === 'text')).toBe(true)
  })

  it('keeps HTML in a table cell as text too', () => {
    const table = only('| a |\n| - |\n| <img src=x onerror=alert(1)> |', 'table')
    expect(table.rows[0]?.[0]?.every((n) => n.kind === 'text')).toBe(true)
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

  it('keeps a loose list in one block', () => {
    // Splitting here would turn one list into two, restarting the numbering.
    expect(splitBlocks('1. one\n\n2. two')).toHaveLength(1)
  })

  it('keeps a quote with a blank line in one block', () => {
    expect(splitBlocks('> one\n>\n> two')).toHaveLength(1)
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
      'intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\ntail',
      '- one\n\n- two\n\ntail',
      '> quoted\n>\n> more\n\nafter',
      '- outer\n  - inner\n\n    continued\n\nafter',
      'Title\n=====\n\nbody\n\n---\n\n- [x] done',
    ]) {
      const viaSplit = splitBlocks(source).flatMap((b) => parseMarkdown(b))
      expect(viaSplit).toEqual(parseMarkdown(source))
    }
  })
})

/**
 * The `Summary` card's source.
 *
 * A convention rather than a contract, so the rules are narrow on purpose: every
 * test below is a shape that *looks* like a summary and must not become a card,
 * except the two that must.
 */
describe('trailingSummary', () => {
  it('lifts a heading and its bullets off the end', () => {
    const source = 'Did the work.\n\n## Summary\n- one\n- two\n'
    const found = trailingSummary(source)
    expect(found?.items).toEqual(['one', 'two'])
    // A cut offset, not a rebuilt body: the prefix is what the agent wrote.
    expect(source.slice(0, found?.cut ?? 0)).toBe('Did the work.\n\n')
  })

  it('lifts it with a blank line between the heading and the list', () => {
    // `splitBlocks` splits on blank lines, so this and the form above are one
    // raw block and two — which is why the scanner works on offsets instead.
    const found = trailingSummary('Did the work.\n\n## Summary\n\n- one\n- two\n')
    expect(found?.items).toEqual(['one', 'two'])
  })

  it('takes the last summary when a reply has two', () => {
    const found = trailingSummary('## Summary\n- early\n\nMore words.\n\n## Summary\n- late\n')
    expect(found?.items).toEqual(['late'])
  })

  it('ignores bullets with no heading', () => {
    expect(trailingSummary('Some points:\n\n- one\n- two\n')).toBeNull()
  })

  it('ignores a summary followed by more prose', () => {
    expect(trailingSummary('## Summary\n- one\n\nAnd another thing.\n')).toBeNull()
  })

  it('ignores a numbered list, which is a different thing', () => {
    expect(trailingSummary('## Summary\n1. one\n2. two\n')).toBeNull()
  })

  it('ignores a summary inside a fenced example', () => {
    // An agent explaining this very convention would otherwise have its own
    // example lifted out of its reply and redrawn as a card.
    const source = 'Write it like this:\n\n```md\n## Summary\n- one\n```\n'
    expect(trailingSummary(source)).toBeNull()
  })

  it('matches the fence by character and length, so a nested one does not end it', () => {
    const source = ['Here:', '', '````md', '```', '## Summary', '- one', '```', '````', ''].join(
      '\n'
    )
    expect(trailingSummary(source)).toBeNull()
  })

  it('ignores a summary inside a block quote', () => {
    expect(trailingSummary('They wrote:\n\n> ## Summary\n> - one\n')).toBeNull()
  })

  it('ignores a heading indented under a list item', () => {
    // Parsing only the tail returns [heading, list] here, which is exactly why
    // the scanner requires column zero rather than trusting that parse.
    expect(trailingSummary('- Example:\n  ## Summary\n  - not a real summary\n')).toBeNull()
  })

  it('ignores a heading that only starts with the word', () => {
    expect(trailingSummary('## Summary of the day\n- one\n')).toBeNull()
  })

  it('reads any heading level, and any case', () => {
    expect(trailingSummary('#### summary\n- one\n')?.items).toEqual(['one'])
  })

  it('flattens emphasis in a bullet to the words it wrapped', () => {
    expect(trailingSummary('## Summary\n- **Throughput**: `+3.2x`\n')?.items).toEqual([
      'Throughput: +3.2x',
    ])
  })
})
