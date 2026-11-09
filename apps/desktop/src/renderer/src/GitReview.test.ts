import { describe, expect, it } from 'vitest'
import type { GitReviewFile } from '../../shared/git-ipc.js'
import { reviewTree } from './GitReview.js'

function file(path: string): GitReviewFile {
  return {
    path,
    oldPath: path,
    status: 'modified',
    added: 1,
    removed: 1,
    binary: false,
    collapsed: false,
    tooLarge: false,
    threads: 0,
  }
}

describe('the review file tree', () => {
  it('compacts single-child folder chains and preserves the original file paths', () => {
    const rows = reviewTree([file('src/features/x/main.ts'), file('README.md')], new Set())
    expect(rows.map(({ kind, path, name, depth }) => ({ kind, path, name, depth }))).toEqual([
      { kind: 'folder', path: 'src/features/x', name: 'src/features/x', depth: 0 },
      { kind: 'file', path: 'src/features/x/main.ts', name: 'main.ts', depth: 1 },
      { kind: 'file', path: 'README.md', name: 'README.md', depth: 0 },
    ])
  })

  it('closes a compact folder without hiding its siblings', () => {
    const rows = reviewTree(
      [file('src/features/x/main.ts'), file('README.md')],
      new Set(['src/features/x'])
    )
    expect(rows.map((row) => row.path)).toEqual(['src/features/x', 'README.md'])
  })

  it('keeps branching folders separate and sorts folders before files', () => {
    const paths = ['src/z.ts', 'src/x/one.ts', 'src/a.ts', 'src/y/two.ts']
    const files = paths.map(file)
    const rows = reviewTree(files, new Set())
    expect(rows.map((row) => row.path)).toEqual([
      'src',
      'src/x',
      'src/x/one.ts',
      'src/y',
      'src/y/two.ts',
      'src/a.ts',
      'src/z.ts',
    ])
    expect(files.map((entry) => entry.path)).toEqual(paths)
    expect(reviewTree([], new Set())).toEqual([])
  })
})
