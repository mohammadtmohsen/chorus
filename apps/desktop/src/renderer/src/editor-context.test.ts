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
  /* The reference does the work: the agent opens the file and reads around the
     lines, which no quotation could have carried. Pasting them as well is
     decoration — and for a short selection, a fenced block around one bracket. */
  it('sends the reference alone for a saved file', () => {
    expect(formatContextBlock(block(), labels)).toBe('VS Code context: `src/a.ts:12-18`')
  })

  it('sends no code for a bare cursor', () => {
    const cursor = block({ isEmpty: true, startLine: 5, endLine: 5, text: '' })
    expect(formatContextBlock(cursor, labels)).toBe('VS Code context: `src/a.ts:5`')
  })

  /* The one exception, and not a preference: the agent reads from disk, so for
     an unsaved buffer the text is the only way it can see the version being
     asked about. */
  it('carries the code when the buffer is unsaved', () => {
    const dirty = block({ isDirty: true })
    expect(formatContextBlock(dirty, labels)).toBe(
      'VS Code context: `src/a.ts:12-18` (unsaved buffer)\n\n```typescript\nconst a = 1\n```'
    )
  })

  /* Indentation is syntax. `asQuote` would have trimmed this. */
  it('preserves leading indentation exactly', () => {
    const indented = block({ isDirty: true, text: '    if (x) {\n      return 1\n    }' })
    expect(formatContextBlock(indented, labels)).toContain(
      '\n    if (x) {\n      return 1\n    }\n'
    )
  })

  it('preserves trailing whitespace inside the selection', () => {
    expect(formatContextBlock(block({ isDirty: true, text: 'x  ' }), labels)).toContain('\nx  \n')
  })

  it('survives a selection that is itself a fenced block', () => {
    const nested = block({
      isDirty: true,
      text: '```js\nconst a = 1\n```',
      languageId: 'markdown',
    })
    const out = formatContextBlock(nested, labels)
    expect(out).toContain('````markdown\n```js')
    expect(out.endsWith('```\n````')).toBe(true)
  })

  /* An unsaved file with nothing selected has no text to carry, and the cursor
     line is enough to point at. */
  it('sends no code for a bare cursor even when unsaved', () => {
    const cursor = block({ isEmpty: true, isDirty: true, startLine: 5, endLine: 5, text: '' })
    expect(formatContextBlock(cursor, labels)).toBe(
      'VS Code context: `src/a.ts:5` (unsaved buffer)'
    )
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
