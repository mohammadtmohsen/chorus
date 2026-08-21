import { describe, expect, it } from 'vitest'
import { changeRows } from './changes-tree.js'

/** Just enough of a changed file for the grouping to be about paths. */
const f = (path: string): { path: string } => ({ path })

const shape = (rows: ReturnType<typeof changeRows>): string[] =>
  rows.map((r) => `${'  '.repeat(r.depth)}${r.kind === 'dir' ? `${r.label}/` : r.label}`)

describe('changeRows', () => {
  it('puts a shared prefix in one row and the difference at the leaf', () => {
    expect(shape(changeRows([f('src/Panel.tsx'), f('src/Panel.css')]))).toEqual([
      'src/',
      '  Panel.tsx',
      '  Panel.css',
    ])
  })

  it('compacts a chain of single-child directories', () => {
    // A column of one-child folders is indentation carrying no information,
    // and in a panel this narrow the indentation is the scarce thing.
    expect(shape(changeRows([f('apps/desktop/src/main/ipc.ts')]))).toEqual([
      'apps/desktop/src/main/',
      '  ipc.ts',
    ])
  })

  it('stops compacting where the tree actually branches', () => {
    expect(shape(changeRows([f('a/b/c/one.ts'), f('a/b/d/two.ts')]))).toEqual([
      'a/b/',
      '  c/',
      '    one.ts',
      '  d/',
      '    two.ts',
    ])
  })

  it('does not compact past a directory that holds files of its own', () => {
    // `a` holds both a file and a subdirectory, so absorbing `a/b` into one
    // row would put `own.ts` under a heading it is not in. `a` stays its own
    // row and both live inside it.
    expect(shape(changeRows([f('a/own.ts'), f('a/b/deep.ts')]))).toEqual([
      'a/',
      '  b/',
      '    deep.ts',
      '  own.ts',
    ])
  })

  it('keeps a root-level file at depth zero', () => {
    expect(shape(changeRows([f('README.md')]))).toEqual(['README.md'])
  })

  it('lists directories before files at each level', () => {
    expect(shape(changeRows([f('z.ts'), f('sub/a.ts')]))).toEqual(['sub/', '  a.ts', 'z.ts'])
  })

  it('carries the file through on a leaf, and gives every row a unique path', () => {
    const rows = changeRows([f('src/a.ts'), f('src/b.ts')])
    expect(rows.filter((r) => r.kind === 'file').map((r) => r.file?.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
    // The path is a React key, so a collision would drop a row.
    expect(new Set(rows.map((r) => r.path)).size).toBe(rows.length)
  })

  it('returns nothing for nothing', () => {
    expect(changeRows([])).toEqual([])
  })
})
