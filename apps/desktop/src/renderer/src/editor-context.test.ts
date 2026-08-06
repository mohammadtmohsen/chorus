import { describe, expect, it } from 'vitest'
import {
  fenceFor,
  formatContextBlock,
  formatReference,
  safeLanguageId,
  withEditorContext,
  type EditorBlock,
} from './editor-context.js'

const labels = { heading: 'VS Code context', unsaved: 'unsaved buffer' }

function block(overrides: Partial<EditorBlock> = {}): EditorBlock {
  return {
    relativePath: 'src/a.ts',
    startLine: 12,
    endLine: 18,
    isEmpty: false,
    text: 'const a = 1',
    languageId: 'typescript',
    isDirty: false,
    ...overrides,
  }
}

describe('formatReference', () => {
  it('formats a range', () => {
    expect(formatReference(block())).toBe('src/a.ts:12-18')
  })

  /* `12-12` reads like a mistake. */
  it('collapses a single-line range', () => {
    expect(formatReference(block({ startLine: 12, endLine: 12 }))).toBe('src/a.ts:12')
  })

  it('formats a bare cursor as one line', () => {
    expect(formatReference(block({ isEmpty: true, startLine: 5, endLine: 5 }))).toBe('src/a.ts:5')
  })
})

describe('fenceFor', () => {
  it('uses three backticks for ordinary code', () => {
    expect(fenceFor('const a = 1')).toBe('```')
  })

  /* Selected code very often contains a Markdown sample, and a three-backtick
     fence around three backticks closes early — the agent then gets half the
     selection as code and the rest as prose. */
  it('outgrows a fence inside the selection', () => {
    expect(fenceFor('```ts\nx\n```')).toBe('````')
  })

  it('outgrows the longest run, not the first', () => {
    expect(fenceFor('`a` and ````b````')).toBe('`````')
  })

  it('handles a selection that is only backticks', () => {
    expect(fenceFor('`````')).toBe('``````')
  })
})

describe('safeLanguageId', () => {
  it('passes ordinary ids through', () => {
    expect(safeLanguageId('typescriptreact')).toBe('typescriptreact')
    expect(safeLanguageId('c++')).toBe('c++')
    expect(safeLanguageId('objective-c')).toBe('objective-c')
  })

  /* A newline in the id would break out of the fence entirely, and a backtick
     would close it. Both are dropped rather than escaped: an unrestricted id
     costs only syntax highlighting. */
  it('strips anything that could escape the fence', () => {
    expect(safeLanguageId('ts\n```\nrm -rf /')).toBe('tsrm-rf')
    expect(safeLanguageId('ts ```')).toBe('ts')
    expect(safeLanguageId('```')).toBe('')
  })

  it('bounds the length', () => {
    expect(safeLanguageId('a'.repeat(100))).toHaveLength(24)
  })
})

describe('formatContextBlock', () => {
  it('leads with the reference and fences the code', () => {
    expect(formatContextBlock(block(), labels)).toBe(
      'VS Code context: `src/a.ts:12-18`\n\n```typescript\nconst a = 1\n```'
    )
  })

  /* Indentation is syntax. `asQuote` would have trimmed this. */
  it('preserves leading indentation exactly', () => {
    const indented = block({ text: '    if (x) {\n      return 1\n    }' })
    expect(formatContextBlock(indented, labels)).toContain(
      '\n    if (x) {\n      return 1\n    }\n'
    )
  })

  it('preserves trailing whitespace inside the selection', () => {
    expect(formatContextBlock(block({ text: 'x  ' }), labels)).toContain('\nx  \n')
  })

  /* The agent reads from disk, and for an unsaved file that is not what the
     user is looking at. */
  it('says when the buffer is unsaved', () => {
    expect(formatContextBlock(block({ isDirty: true }), labels)).toContain(
      '`src/a.ts:12-18` (unsaved buffer)'
    )
  })

  /* Pasting a line the agent can fetch itself is both costlier and less
     accurate than telling it where to look. */
  it('sends no code for a bare cursor', () => {
    const cursor = block({ isEmpty: true, startLine: 5, endLine: 5, text: '' })
    expect(formatContextBlock(cursor, labels)).toBe('VS Code context: `src/a.ts:5`')
  })

  it('survives a selection that is itself a fenced block', () => {
    const nested = block({ text: '```js\nconst a = 1\n```', languageId: 'markdown' })
    const out = formatContextBlock(nested, labels)
    expect(out).toContain('````markdown\n```js')
    expect(out.endsWith('```\n````')).toBe(true)
  })
})

describe('withEditorContext', () => {
  it('puts the block above an empty draft and leaves room to type', () => {
    expect(withEditorContext('', 'BLOCK')).toBe('BLOCK\n\n')
  })

  it('puts the block above what was already typed', () => {
    expect(withEditorContext('why is this slow?', 'BLOCK')).toBe('BLOCK\n\nwhy is this slow?')
  })

  it('adds nothing when there is no context', () => {
    expect(withEditorContext('hello', '')).toBe('hello')
  })
})
