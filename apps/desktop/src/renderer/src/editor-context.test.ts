import { describe, expect, it } from 'vitest'
import {
  fenceFor,
  formatContextBlock,
  formatReference,
  markFor,
  safeLanguageId,
  shortSha,
  versionFor,
  withEditorContext,
  type EditorBlock,
} from './editor-context.js'

/** The working-tree case: no version to qualify, so the label is empty. */
const labels = { heading: 'VS Code context', unsaved: 'unsaved buffer', version: '' }

function block(overrides: Partial<EditorBlock> = {}): EditorBlock {
  return {
    relativePath: 'src/a.ts',
    startLine: 12,
    endLine: 18,
    isEmpty: false,
    text: 'const a = 1',
    languageId: 'typescript',
    isDirty: false,
    provenance: { kind: 'worktree' },
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

  /*
   * The rule inverts once the document is not the working tree. `attach.ts`
   * says Chorus hands agents paths, not attachments — but the path is no longer
   * where these lines live, so the quoted text is the only true copy of what
   * the user is looking at.
   */
  it('always carries the code for a merge request selection, saved or not', () => {
    const review = block({ provenance: { kind: 'review', commit: 'a1b2c3d4e5' } })
    const out = formatContextBlock(review, { ...labels, version: 'from commit a1b2c3d' })
    expect(out).toBe(
      'VS Code context: `src/a.ts:12-18` (from commit a1b2c3d)\n\n```typescript\nconst a = 1\n```'
    )
  })

  it('always carries the code for a git ref', () => {
    const head = block({ provenance: { kind: 'ref', ref: 'HEAD' } })
    expect(formatContextBlock(head, { ...labels, version: 'from HEAD' })).toContain(
      '```typescript\nconst a = 1\n```'
    )
  })

  /*
   * An unsaved buffer and a diff pane are different problems — newer content
   * versus a different version — and only one can be true of a document. The
   * unsaved note wins because a `gl-review` document is read-only and cannot be
   * dirty in the first place.
   */
  it('does not stack both qualifiers', () => {
    const both = block({ isDirty: true, provenance: { kind: 'ref', ref: 'HEAD' } })
    expect(formatContextBlock(both, { ...labels, version: 'from HEAD' })).toContain(
      '`src/a.ts:12-18` (unsaved buffer)'
    )
  })

  it('still sends nothing but a reference for a bare cursor in a diff', () => {
    const cursor = block({
      isEmpty: true,
      startLine: 5,
      endLine: 5,
      text: '',
      provenance: { kind: 'review', commit: 'a1b2c3d4e5' },
    })
    expect(formatContextBlock(cursor, { ...labels, version: 'from commit a1b2c3d' })).toBe(
      'VS Code context: `src/a.ts:5` (from commit a1b2c3d)'
    )
  })
})

describe('shortSha', () => {
  it('shortens a sha to what every git UI shows', () => {
    expect(shortSha('a1b2c3d4e5f6a7b8')).toBe('a1b2c3d')
  })

  /* A branch name is not a sha and must not be truncated into a different one. */
  it('leaves a ref name alone', () => {
    expect(shortSha('HEAD')).toBe('HEAD')
    expect(shortSha('feature/long-branch-name')).toBe('feature/long-branch-name')
  })
})

describe('markFor', () => {
  it('says nothing for the working tree, where the path already does', () => {
    expect(markFor({ kind: 'worktree' })).toBeNull()
  })

  it('names HEAD and the index in words rather than git syntax', () => {
    expect(markFor({ kind: 'ref', ref: 'HEAD' })?.key).toBe('ide.mark.head')
    expect(markFor({ kind: 'ref', ref: '~' })?.key).toBe('ide.mark.index')
  })

  it('shortens a commit for the pill', () => {
    expect(markFor({ kind: 'review', commit: 'a1b2c3d4e5f6' })).toEqual({
      key: 'ide.mark.review',
      params: { commit: 'a1b2c3d' },
    })
  })
})

describe('versionFor', () => {
  it('has nothing to qualify for the working tree', () => {
    expect(versionFor({ kind: 'worktree' }, 'src/a.ts')).toBeNull()
  })

  /*
   * The full sha, not the short one: this string is handed to an agent to run,
   * and while git resolves a short sha, the message is also the record of which
   * commit it was.
   */
  it('gives the agent the command that reproduces the lines', () => {
    expect(versionFor({ kind: 'review', commit: 'a1b2c3d4e5f6' }, 'src/a.ts')).toEqual({
      key: 'ide.version.review',
      params: { commit: 'a1b2c3d4e5f6', path: 'src/a.ts' },
    })
  })

  it('separates HEAD from an arbitrary ref', () => {
    expect(versionFor({ kind: 'ref', ref: 'HEAD' }, 'src/a.ts')?.key).toBe('ide.version.head')
    expect(versionFor({ kind: 'ref', ref: '9f1c2ab' }, 'src/a.ts')?.key).toBe('ide.version.ref')
  })

  /* `git show :file` is the index's syntax, and a colon-prefixed path in a
     sentence invites being typed as a ref. */
  it('offers no command for the index', () => {
    expect(versionFor({ kind: 'ref', ref: '~' }, 'src/a.ts')).toEqual({
      key: 'ide.version.index',
      params: {},
    })
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
