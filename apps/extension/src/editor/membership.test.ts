import { describe, expect, it } from 'vitest'
import { MAX_SELECTED_BYTES } from '@chorus/ide-protocol/protocol'
import {
  contextFor,
  containingProjects,
  deepestProject,
  snapshotFor,
  type LocatedEditor,
} from './membership.js'

const project = { host: '', root: '/repo' }
const chosen = (over: Partial<LocatedEditor> = {}): LocatedEditor => ({
  editor: {
    uriScheme: 'file',
    filePath: '/repo/src/a.ts',
    fileUrl: 'file:///repo/src/a.ts',
    provenance: { kind: 'worktree' },
    languageId: 'typescript',
    documentVersion: 7,
    isDirty: true,
    selection: {
      start: { line: 2, character: 0 },
      end: { line: 4, character: 0 },
      isEmpty: false,
    },
    selectedText: 'first\nsecond\n',
  },
  location: {
    host: '',
    filePath: '/repo/src/a.ts',
    provenance: { kind: 'worktree' },
  },
  ...over,
})

describe('project context membership', () => {
  it('reports a configured local project without a VS Code workspace folder', () => {
    expect(contextFor(project, true, chosen())).toMatchObject({
      relativePath: 'src/a.ts',
      startLine: 3,
      endLine: 4,
      selectedBytes: 13,
      version: 7,
      isDirty: true,
    })
  })

  it('never includes selection text in a pushed context', () => {
    const context = contextFor(project, true, chosen())
    expect(context).not.toHaveProperty('text')
    expect(context).not.toHaveProperty('preview')
    const snapshot = snapshotFor(project, true, chosen())
    expect(snapshot).toEqual({ ...context, text: 'first\nsecond\n' })
  })

  it('discloses neither a path nor source metadata in a restricted workspace', () => {
    expect(contextFor(project, false, chosen())).toEqual({
      relativePath: null,
      provenance: { kind: 'worktree' },
      scheme: '',
      editorTypeId: '',
      reason: 'no-editor',
      startLine: null,
      endLine: null,
      isEmpty: true,
      isDirty: false,
      languageId: '',
      selectedBytes: 0,
      version: null,
    })
    expect(snapshotFor(project, false, chosen())).toBeNull()
  })

  it('refuses sibling prefixes and paths that normalize outside the project', () => {
    for (const filePath of ['/repo-old/a.ts', '/repo/../outside/a.ts']) {
      const outside = chosen({
        location: { host: '', filePath, provenance: { kind: 'worktree' } },
      })
      expect(contextFor(project, true, outside).relativePath).toBeNull()
      expect(snapshotFor(project, true, outside)).toBeNull()
    }
  })

  it('does not confuse identical paths on different hosts', () => {
    const remote = chosen({
      location: { host: 'office', filePath: '/repo/src/a.ts', provenance: { kind: 'worktree' } },
    })
    expect(snapshotFor(project, true, remote)).toBeNull()
    expect(snapshotFor({ host: 'office', root: '/repo' }, true, remote)?.relativePath).toBe(
      'src/a.ts'
    )
  })

  it('sends nested context to both projects but chooses the deepest ownership independently of order', () => {
    const nested = { host: '', root: '/repo/src' }
    const location = chosen().location
    if (location === null) throw new Error('fixture')
    expect(containingProjects([project, nested], location)).toEqual([project, nested])
    expect(contextFor(nested, true, chosen()).relativePath).toBe('a.ts')
    expect(deepestProject([project, nested], location)).toBe(nested)
    expect(deepestProject([nested, project], location)).toBe(nested)
  })

  it('reports an oversized selection but refuses its snapshot without truncation', () => {
    const selection = chosen()
    const oversized = chosen({
      editor: { ...selection.editor, selectedText: '😀'.repeat(MAX_SELECTED_BYTES / 4 + 1) },
    })
    expect(contextFor(project, true, oversized).selectedBytes).toBe(MAX_SELECTED_BYTES + 4)
    expect(snapshotFor(project, true, oversized)).toBeNull()
  })

  it('marks a rendered preview only in the snapshot and omits a model version', () => {
    const preview = chosen({ preview: true })
    const context = contextFor(project, true, preview)
    expect(context.version).toBeNull()
    expect(context).not.toHaveProperty('preview')
    expect(snapshotFor(project, true, preview)).toEqual({
      ...context,
      text: 'first\nsecond\n',
      preview: true,
    })
  })

  it('does not treat an unresolved document as a file', () => {
    const unresolved = chosen({ location: null })
    expect(contextFor(project, true, unresolved).reason).toBe('unresolved')
    expect(snapshotFor(project, true, unresolved)).toBeNull()
  })
})
