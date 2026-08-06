import { describe, expect, it } from 'vitest'
import { MAX_SELECTED_BYTES } from '@chorus/ide-protocol'
import {
  isInside,
  isSupported,
  metadataFor,
  reportAll,
  reportFor,
  SelectionCache,
  type EditorLike,
  type WindowFacts,
} from './editor-context.js'

const ROOT = '/p/project'

function editor(overrides: Partial<EditorLike> = {}): EditorLike {
  return {
    uriScheme: 'file',
    filePath: `${ROOT}/src/a.ts`,
    fileUrl: `file://${ROOT}/src/a.ts`,
    languageId: 'typescript',
    documentVersion: 1,
    isDirty: false,
    selection: {
      start: { line: 10, character: 0 },
      end: { line: 12, character: 4 },
      isEmpty: false,
    },
    selectedText: 'const a = 1',
    ...overrides,
  }
}

const trusted: WindowFacts = { workspaceFolders: [ROOT], isTrusted: true }

describe('isInside', () => {
  it('accepts the root and files under it', () => {
    expect(isInside(ROOT, ROOT)).toBe(true)
    expect(isInside(ROOT, `${ROOT}/src/a.ts`)).toBe(true)
  })

  /* The sibling-prefix trap, checked on both sides of the socket. */
  it('rejects a sibling with a shared prefix', () => {
    expect(isInside(ROOT, '/p/project-old/b.ts')).toBe(false)
  })

  it('rejects a parent', () => {
    expect(isInside(ROOT, '/p/other.ts')).toBe(false)
  })
})

describe('isSupported', () => {
  it('accepts a file document', () => {
    expect(isSupported(editor())).toBe(true)
  })

  it.each(['untitled', 'output', 'comment', 'vscode-notebook-cell'])('rejects %s', (scheme) => {
    expect(isSupported(editor({ uriScheme: scheme }))).toBe(false)
  })

  it('rejects nothing at all', () => {
    expect(isSupported(null)).toBe(false)
  })
})

describe('reportFor', () => {
  it('reports ready with metadata for a file inside the root', () => {
    const report = reportFor(ROOT, trusted, editor(), 'current')
    expect(report.status).toBe('ready')
    expect(report.editor?.filePath).toBe(`${ROOT}/src/a.ts`)
    expect(report.editor?.selection.selectedBytes).toBe('const a = 1'.length)
  })

  /* Every branch below must withhold the path. A document from another project
     must not reach Chorus even as a name. */
  it('discloses no path when the root is not open here', () => {
    const report = reportFor(ROOT, { workspaceFolders: [], isTrusted: true }, editor(), 'current')
    expect(report).toEqual({ root: ROOT, status: 'unmatched', editor: null })
  })

  it('discloses no path in a restricted workspace', () => {
    const report = reportFor(ROOT, { ...trusted, isTrusted: false }, editor(), 'current')
    expect(report).toEqual({ root: ROOT, status: 'untrusted', editor: null })
  })

  it('discloses no path for a non-file document', () => {
    const report = reportFor(ROOT, trusted, editor({ uriScheme: 'untitled' }), 'current')
    expect(report).toEqual({ root: ROOT, status: 'unsupported', editor: null })
  })

  it('discloses no path for a file from another project', () => {
    const report = reportFor(ROOT, trusted, editor({ filePath: '/p/other/x.ts' }), 'current')
    expect(report).toEqual({ root: ROOT, status: 'unmatched', editor: null })
  })

  it('reports unsupported when nothing is open', () => {
    expect(reportFor(ROOT, trusted, null, 'current').status).toBe('unsupported')
  })

  /* tooLarge still names the file: the pill has to say which selection is the
     problem, and the text is not what is being withheld here. */
  it('names the file when the selection is too large', () => {
    const big = editor({ selectedText: 'a'.repeat(MAX_SELECTED_BYTES + 1) })
    const report = reportFor(ROOT, trusted, big, 'current')
    expect(report.status).toBe('tooLarge')
    expect(report.editor?.filePath).toBe(`${ROOT}/src/a.ts`)
  })

  it('counts selection size in bytes, not characters', () => {
    const metadata = metadataFor(editor({ selectedText: '中'.repeat(3) }), 'current')
    expect(metadata.selection.selectedBytes).toBe(9)
  })
})

describe('SelectionCache', () => {
  /* Focus is in Chorus every moment the user is actually reaching for the
     composer, and VS Code has no active editor then. */
  it('keeps the last eligible editor when focus leaves the editor', () => {
    const cache = new SelectionCache()
    cache.observe(editor(), [ROOT])
    const resolved = cache.resolve(null)
    expect(resolved.source).toBe('cached')
    expect(resolved.editor?.filePath).toBe(`${ROOT}/src/a.ts`)
  })

  /* An unrelated current editor must never fall back to an older in-project
     selection — that would attach the wrong file to the question. */
  it('forgets the cache when the current editor is outside the project', () => {
    const cache = new SelectionCache()
    cache.observe(editor(), [ROOT])
    cache.observe(editor({ filePath: '/p/other/x.ts' }), [ROOT])
    expect(cache.resolve(null).editor).toBeNull()
  })

  it('forgets the cache when the current editor is unsupported', () => {
    const cache = new SelectionCache()
    cache.observe(editor(), [ROOT])
    cache.observe(editor({ uriScheme: 'output' }), [ROOT])
    expect(cache.resolve(null).editor).toBeNull()
  })

  it('prefers a live editor over the cache', () => {
    const cache = new SelectionCache()
    cache.observe(editor(), [ROOT])
    const live = editor({ filePath: `${ROOT}/src/b.ts` })
    const resolved = cache.resolve(live)
    expect(resolved.source).toBe('current')
    expect(resolved.editor?.filePath).toBe(`${ROOT}/src/b.ts`)
  })
})

describe('reportAll', () => {
  it('reports every root the window was asked about', () => {
    const reports = reportAll([ROOT, '/p/other'], trusted, editor(), new SelectionCache())
    expect(reports.map((r) => `${r.root}:${r.status}`)).toEqual([
      `${ROOT}:ready`,
      '/p/other:unmatched',
    ])
  })

  it('uses the cache once the editor goes away', () => {
    const cache = new SelectionCache()
    reportAll([ROOT], trusted, editor(), cache)
    const later = reportAll([ROOT], trusted, null, cache)
    expect(later[0]?.status).toBe('ready')
    expect(later[0]?.editor?.source).toBe('cached')
  })

  it('returns nothing when Chorus has asked about no roots', () => {
    expect(reportAll([], trusted, editor(), new SelectionCache())).toEqual([])
  })
})
