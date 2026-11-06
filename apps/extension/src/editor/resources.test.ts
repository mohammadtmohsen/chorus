import { describe, expect, it } from 'vitest'
import {
  isProjectRelativePath,
  locateDocument,
  mapResource,
  projectPath,
  relativePath,
  type ResourceUri,
} from './resources.js'

const uri = (over: Partial<ResourceUri> = {}): ResourceUri => ({
  scheme: 'vscode-remote',
  authority: 'ssh-remote+Office',
  path: '/repo',
  query: '',
  fsPath: '/repo',
  ...over,
})

describe('project resource mapping', () => {
  it('preserves the remote scheme and exact authority when opening a project file', () => {
    expect(mapResource({ host: 'office', root: '/repo' }, '/repo/src/a.ts', [uri()])).toEqual({
      scheme: 'vscode-remote',
      authority: 'ssh-remote+Office',
      path: '/repo/src/a.ts',
    })
  })

  it('maps a remote document without treating the UI extension host as its filesystem', () => {
    expect(
      locateDocument(uri({ path: '/repo/a.ts', fsPath: '/repo/a.ts' }), [uri()], 'darwin')
    ).toEqual({
      host: 'office',
      filePath: '/repo/a.ts',
      provenance: { kind: 'worktree' },
    })
  })

  it('does not invent a remote authority when this VS Code window has supplied none', () => {
    expect(mapResource({ host: 'office', root: '/repo' }, '/repo/a.ts', [])).toBeNull()
    expect(mapResource({ host: 'other', root: '/repo' }, '/repo/a.ts', [uri()])).toBeNull()
    expect(locateDocument(uri({ authority: 'dev-container+unknown' }), [], 'darwin')).toBeNull()
  })

  it('opens configured local projects outside every workspace folder', () => {
    expect(mapResource({ host: '', root: '/unopened' }, '/unopened/a.ts', [])).toEqual({
      scheme: 'file',
      authority: '',
      path: '/unopened/a.ts',
    })
  })

  it('keeps remote Windows drive paths anchored and emits URI path separators', () => {
    const place = { host: 'office', root: 'C:\\repo' }
    expect(mapResource(place, 'c:\\repo\\src\\a.ts', [uri()])).toEqual({
      scheme: 'vscode-remote',
      authority: 'ssh-remote+Office',
      path: '/c:/repo/src/a.ts',
    })
    expect(
      relativePath(place, {
        host: 'office',
        filePath: '/C:/repo/src/a.ts',
        provenance: { kind: 'worktree' },
      })
    ).toBe('src/a.ts')
  })

  it('keeps a working-tree URI local even while an SSH folder is open', () => {
    expect(
      locateDocument(
        uri({
          scheme: 'file',
          authority: '',
          path: '/repo/a.ts',
          fsPath: '/repo/a.ts',
        }),
        [uri()],
        'darwin'
      )?.host
    ).toBe('')
  })

  it('resolves historical git content through the shared provenance resolver', () => {
    const document = uri({
      scheme: 'git',
      authority: '',
      path: '/repo/a.ts.git',
      fsPath: '/repo/a.ts.git',
      query: JSON.stringify({ path: '/repo/a.ts', ref: 'abc123' }),
    })
    expect(locateDocument(document, [], 'darwin')).toMatchObject({
      host: '',
      filePath: '/repo/a.ts',
      provenance: { kind: 'ref', ref: 'abc123' },
    })
  })

  it('keeps historical remote content on its uniquely identified SSH host', () => {
    const document = uri({
      scheme: 'git',
      authority: '',
      path: '/repo/a.ts.git',
      fsPath: '/repo/a.ts.git',
      query: JSON.stringify({ path: '/repo/a.ts', ref: 'HEAD' }),
    })
    expect(locateDocument(document, [uri()], 'win32')).toMatchObject({
      host: 'office',
      filePath: '/repo/a.ts',
      provenance: { kind: 'ref', ref: 'HEAD' },
    })
    expect(
      locateDocument(document, [uri(), uri({ authority: 'ssh-remote+other' })], 'darwin')
    ).toBeNull()
    expect(
      locateDocument(document, [uri(), uri({ scheme: 'file', authority: '' })], 'darwin')
    ).toBeNull()
    expect(
      locateDocument(document, [uri({ authority: 'dev-container+unknown' })], 'darwin')
    ).toBeNull()
  })

  it('refuses absolute paths, both traversal separators, drive-relative paths and URI spellings', () => {
    for (const path of [
      '',
      '.',
      '/a.ts',
      '\\a.ts',
      '../a.ts',
      'src/../../a.ts',
      '..\\a.ts',
      'C:a.ts',
      'file:///a.ts',
    ]) {
      expect(isProjectRelativePath(path), path).toBe(false)
      expect(projectPath({ host: '', root: '/repo' }, path), path).toBeNull()
    }
    expect(projectPath({ host: '', root: '/repo' }, 'src/a.ts')).toBe('/repo/src/a.ts')
  })

  it('refuses normalized escapes before constructing a resource URI', () => {
    expect(mapResource({ host: '', root: '/repo' }, '/repo/../private/a.ts', [])).toBeNull()
  })
})
