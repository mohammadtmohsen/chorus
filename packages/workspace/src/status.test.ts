import { describe, expect, it } from 'vitest'
import { parseStatus } from './status.js'

// Recorded from `git status --porcelain=v2 --branch`.
const SAMPLE = [
  '# branch.oid 0f4b1c2d',
  '# branch.head feature/adapter',
  '# branch.upstream origin/feature/adapter',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 aaa bbb src/edited.ts',
  '1 M. N... 100644 100644 100644 aaa bbb src/staged.ts',
  '1 A. N... 000000 100644 100644 000000 ccc src/added.ts',
  '1 .D N... 100644 100644 000000 ddd ddd src/gone.ts',
  '2 R. N... 100644 100644 100644 eee eee R100 src/new-name.ts\tsrc/old-name.ts',
  '? untracked.txt',
  '! ignored.log',
].join('\n')

describe('parseStatus', () => {
  it('reads the branch and its upstream', () => {
    const status = parseStatus(SAMPLE)
    expect(status.branch).toBe('feature/adapter')
    expect(status.upstream).toBe('origin/feature/adapter')
  })

  it('reads ahead and behind counts', () => {
    expect(parseStatus(SAMPLE)).toMatchObject({ ahead: 2, behind: 1 })
  })

  it('distinguishes staged from unstaged', () => {
    const files = parseStatus(SAMPLE).files
    expect(files.find((f) => f.path === 'src/edited.ts')).toMatchObject({
      staged: false,
      unstaged: true,
    })
    expect(files.find((f) => f.path === 'src/staged.ts')).toMatchObject({
      staged: true,
      unstaged: false,
    })
  })

  it('classifies each kind of change', () => {
    const byPath = new Map(parseStatus(SAMPLE).files.map((f) => [f.path, f.state]))
    expect(byPath.get('src/added.ts')).toBe('added')
    expect(byPath.get('src/gone.ts')).toBe('deleted')
    expect(byPath.get('src/edited.ts')).toBe('modified')
    expect(byPath.get('untracked.txt')).toBe('untracked')
  })

  it('keeps both sides of a rename', () => {
    const renamed = parseStatus(SAMPLE).files.find((f) => f.state === 'renamed')
    expect(renamed).toMatchObject({ path: 'src/new-name.ts', from: 'src/old-name.ts' })
  })

  it('drops ignored entries', () => {
    // They only appear with --ignored and are never what a reviewer is looking at.
    expect(parseStatus(SAMPLE).files.some((f) => f.path === 'ignored.log')).toBe(false)
  })

  it('reports a clean tree', () => {
    const status = parseStatus('# branch.head main\n')
    expect(status).toMatchObject({ branch: 'main', clean: true, files: [] })
  })

  it('handles a detached head without inventing a branch name', () => {
    expect(parseStatus('# branch.head (detached)\n').branch).toBeNull()
  })

  it('handles a branch with no upstream', () => {
    const status = parseStatus('# branch.head solo\n')
    expect(status.upstream).toBeNull()
    expect(status).toMatchObject({ ahead: 0, behind: 0 })
  })

  it('keeps a path containing spaces intact', () => {
    const status = parseStatus('1 .M N... 100644 100644 100644 a b docs/my notes.md')
    expect(status.files[0]?.path).toBe('docs/my notes.md')
  })

  it('marks a conflict', () => {
    const line = 'u UU N... 100644 100644 100644 100644 a b c src/conflict.ts'
    expect(parseStatus(line).files[0]).toMatchObject({
      path: 'src/conflict.ts',
      state: 'conflicted',
    })
  })

  it('tells a copy from a rename', () => {
    // Kind `2` is "renamed OR copied" and the XY code says which. Every kind-2
    // line was read as a rename until 2026-08-20, so a copy claimed the
    // original had moved — a false statement about the tree, not just a
    // missing letter.
    const copied = '2 C. N... 100644 100644 100644 a b C75 src/copy.ts\tsrc/orig.ts'
    expect(parseStatus(copied).files[0]).toMatchObject({
      path: 'src/copy.ts',
      from: 'src/orig.ts',
      state: 'copied',
    })
    const renamed = '2 R. N... 100644 100644 100644 a b R100 src/new.ts\tsrc/old.ts'
    expect(parseStatus(renamed).files[0]).toMatchObject({ state: 'renamed' })
  })

  it('reports a type change rather than calling it a modification', () => {
    // A file becoming a symlink. It used to fall through to `modified`, which
    // is what a diff shows and not what happened.
    const line = '1 .T N... 100644 120000 120000 a b src/link'
    expect(parseStatus(line).files[0]).toMatchObject({ path: 'src/link', state: 'typechanged' })
  })

  it('still ignores ignored entries', () => {
    // Only reachable with --ignored, which readStatus does not pass and VS
    // Code's own status command does not either. Enumerating node_modules to
    // populate a letter no upstream UI shows is not parity.
    expect(parseStatus('! node_modules/left-pad/index.js\n').files).toEqual([])
  })
})
