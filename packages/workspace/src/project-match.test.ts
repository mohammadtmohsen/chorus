import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  canonicalRoot,
  chooseWindow,
  isFileInProject,
  isProjectRoot,
  projectRelativePath,
  type CanonicalRoot,
} from './project-match.js'

let base: string
let root: CanonicalRoot
let rootPath: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'chorus-pm-'))
  rootPath = join(base, 'project')
  mkdirSync(join(rootPath, 'src'), { recursive: true })
  writeFileSync(join(rootPath, 'src', 'a.ts'), 'const a = 1\n')

  // The sibling-prefix trap: "/…/project-old" must never count as inside
  // "/…/project".
  mkdirSync(join(base, 'project-old'), { recursive: true })
  writeFileSync(join(base, 'project-old', 'b.ts'), 'const b = 2\n')

  // A symlink inside the project pointing out of it.
  mkdirSync(join(base, 'outside'), { recursive: true })
  writeFileSync(join(base, 'outside', 'secret.ts'), 'const s = 3\n')
  symlinkSync(join(base, 'outside'), join(rootPath, 'escape'))

  root = canonicalRoot(rootPath)
})

describe('canonicalRoot', () => {
  /* macOS resolves /tmp through /private/tmp, which is exactly why a raw
     string comparison between a VS Code folder and a Chorus cwd is not enough. */
  it('resolves symlinked ancestors', () => {
    expect(root.startsWith('/private') || root.startsWith('/tmp') || root.length > 0).toBe(true)
    expect(canonicalRoot(rootPath)).toBe(root)
  })

  it('is stable across equivalent spellings', () => {
    expect(canonicalRoot(join(rootPath, 'src', '..'))).toBe(root)
    expect(canonicalRoot(`${rootPath}/`)).toBe(root)
  })
})

describe('isProjectRoot', () => {
  it('matches the project root itself', () => {
    expect(isProjectRoot(root, rootPath)).toBe(true)
  })

  /* Opening the parent must not match: it would silently widen the scope of
     everything the bridge reports. */
  it('rejects a parent folder', () => {
    expect(isProjectRoot(root, base)).toBe(false)
  })

  it('rejects a subdirectory', () => {
    expect(isProjectRoot(root, join(rootPath, 'src'))).toBe(false)
  })

  it('rejects a sibling with a shared prefix', () => {
    expect(isProjectRoot(root, join(base, 'project-old'))).toBe(false)
  })
})

describe('isFileInProject', () => {
  it('accepts a file inside the root', () => {
    expect(isFileInProject(root, join(rootPath, 'src', 'a.ts'))).toBe(true)
  })

  it('accepts the root itself', () => {
    expect(isFileInProject(root, rootPath)).toBe(true)
  })

  it('rejects a file in a sibling directory with a shared prefix', () => {
    expect(isFileInProject(root, join(base, 'project-old', 'b.ts'))).toBe(false)
  })

  /* The whole reason the candidate is realpathed on every call. */
  it('rejects escape through a symlinked directory inside the root', () => {
    expect(isFileInProject(root, join(rootPath, 'escape', 'secret.ts'))).toBe(false)
  })

  it('rejects a relative path', () => {
    expect(isFileInProject(root, 'src/a.ts')).toBe(false)
  })

  it('rejects an empty path', () => {
    expect(isFileInProject(root, '')).toBe(false)
  })

  it('rejects a traversal that climbs out', () => {
    expect(isFileInProject(root, join(rootPath, '..', 'project-old', 'b.ts'))).toBe(false)
  })
})

describe('projectRelativePath', () => {
  it('returns the path an agent can open', () => {
    expect(projectRelativePath(root, join(rootPath, 'src', 'a.ts'))).toBe('src/a.ts')
  })

  /* Never hand an agent a reference that points out of its own cwd. */
  it('returns null for a file outside the root', () => {
    expect(projectRelativePath(root, join(base, 'project-old', 'b.ts'))).toBeNull()
  })

  it('returns null for the root itself', () => {
    expect(projectRelativePath(root, rootPath)).toBeNull()
  })

  it('returns null through a symlink escape', () => {
    expect(projectRelativePath(root, join(rootPath, 'escape', 'secret.ts'))).toBeNull()
  })
})

describe('chooseWindow', () => {
  const w = (id: string, focused: boolean, lastFocusedAt: number) => ({
    id,
    focused,
    lastFocusedAt,
  })

  it('returns null when nothing is eligible', () => {
    expect(chooseWindow([])).toBeNull()
  })

  it('returns the only eligible window', () => {
    expect(chooseWindow([w('a', false, 0)])?.id).toBe('a')
  })

  it('prefers the focused window', () => {
    expect(chooseWindow([w('a', false, 10), w('b', true, 1)])?.id).toBe('b')
  })

  /* Focus moves to Chorus the moment the user reaches for the composer, so the
     most recently focused editor is the one they mean. */
  it('falls back to the most recently focused when none is focused', () => {
    expect(chooseWindow([w('a', false, 10), w('b', false, 20)])?.id).toBe('b')
  })

  /* Arrival order says nothing about which editor the user is looking at. */
  it('reports ambiguity rather than guessing by order', () => {
    expect(chooseWindow([w('a', false, 0), w('b', false, 0)])).toBeNull()
  })

  it('reports ambiguity when two windows tie on last focus', () => {
    expect(chooseWindow([w('a', false, 5), w('b', false, 5)])).toBeNull()
  })

  it('reports ambiguity when several are somehow focused at once', () => {
    expect(chooseWindow([w('a', true, 0), w('b', true, 0)])).toBeNull()
  })
})
