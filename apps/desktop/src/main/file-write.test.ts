import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { digestOf, lineDelta, writeProjectFile } from './file-write.js'

/**
 * The only path in this app that writes into a project tree.
 *
 * Two things are being tested and they are not the same: that a write lands
 * atomically, and that a path which leaves the project cannot be written at
 * all. The second is the one that matters — `resolveWithinRoot` has had no
 * write-side caller until now, so this is the first time its refusal is load
 * bearing rather than decorative.
 */

let root: string
let outside: string

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'chorus-write-'))
  root = join(base, 'project')
  outside = join(base, 'secrets')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const A = 1\n')
  writeFileSync(join(outside, 'creds.txt'), 'token')
  symlinkSync(outside, join(root, 'escape-link'))
})

describe('writeProjectFile', () => {
  it('writes a file and reports what moved', async () => {
    const result = await writeProjectFile({
      cwd: root,
      path: 'src/index.ts',
      content: 'export const A = 2\n',
      expectedSha: digestOf('export const A = 1\n'),
    })
    expect(result.problem).toBeNull()
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('export const A = 2\n')
    expect(result).toMatchObject({ added: 1, removed: 1 })
  })

  it('creates a file that did not exist', async () => {
    const result = await writeProjectFile({
      cwd: root,
      path: 'src/new.ts',
      content: 'a\nb\n',
      // Null: the editor saw no file. The write still fails if one appeared.
      expectedSha: null,
    })
    expect(result.problem).toBeNull()
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toBe('a\nb\n')
  })

  it('leaves no temp file behind', async () => {
    // The rename is what makes the write atomic; a leftover `.chorus-*.tmp`
    // would mean it fell back to a copy, and would also show up in the tree.
    await writeProjectFile({
      cwd: root,
      path: 'src/index.ts',
      content: 'x\n',
      expectedSha: digestOf('export const A = 1\n'),
    })
    expect(readdirSync(join(root, 'src')).filter((n) => n.startsWith('.chorus-'))).toEqual([])
  })

  it('refuses a path that climbs out of the project', async () => {
    const result = await writeProjectFile({
      cwd: root,
      path: '../secrets/creds.txt',
      content: 'stolen',
      expectedSha: null,
    })
    expect(result.outcome).toBe('failed')
    expect(readFileSync(join(outside, 'creds.txt'), 'utf8')).toBe('token')
  })

  it('refuses a write through a symlink leaving the project', async () => {
    // A naive prefix check passes this, which is the whole reason the resolver
    // calls realpath.
    const result = await writeProjectFile({
      cwd: root,
      path: 'escape-link/creds.txt',
      content: 'stolen',
      expectedSha: null,
    })
    expect(result.outcome).toBe('failed')
    expect(readFileSync(join(outside, 'creds.txt'), 'utf8')).toBe('token')
  })

  it('refuses an absolute path outside the project', async () => {
    const result = await writeProjectFile({
      cwd: root,
      path: join(outside, 'creds.txt'),
      content: 'stolen',
      expectedSha: null,
    })
    expect(result.outcome).toBe('failed')
    expect(readFileSync(join(outside, 'creds.txt'), 'utf8')).toBe('token')
  })
})

describe('lineDelta', () => {
  it('counts only what moved, not the whole file', () => {
    // The number reaches an agent as "+1 −1", so a typo fix that reported the
    // file's length would read as a rewrite.
    const before = ['a', 'b', 'c', 'd'].join('\n')
    const after = ['a', 'B', 'c', 'd'].join('\n')
    expect(lineDelta(before, after)).toEqual({ added: 1, removed: 1 })
  })

  it('counts an insertion as an addition alone', () => {
    expect(lineDelta('a\nc\n', 'a\nb\nc\n')).toEqual({ added: 1, removed: 0 })
  })

  it('counts a deletion as a removal alone', () => {
    expect(lineDelta('a\nb\nc\n', 'a\nc\n')).toEqual({ added: 0, removed: 1 })
  })

  it('reports nothing for an unchanged file', () => {
    expect(lineDelta('a\nb\n', 'a\nb\n')).toEqual({ added: 0, removed: 0 })
  })

  it('reports a new file as all additions', () => {
    expect(lineDelta('', 'a\nb\n').added).toBeGreaterThan(0)
  })
})

describe('a save that would overwrite work the editor never saw', () => {
  it('is refused when the file moved underneath', async () => {
    // The decision this implements: a refusal is recoverable, a silent
    // overwrite is not.
    const result = await writeProjectFile({
      cwd: root,
      path: 'src/index.ts',
      content: 'mine\n',
      expectedSha: digestOf('something the file never contained\n'),
    })
    expect(result.outcome).toBe('conflict')
    // And nothing was written.
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('export const A = 1\n')
  })

  it('goes through once the conflict has been accepted', async () => {
    const result = await writeProjectFile({
      cwd: root,
      path: 'src/index.ts',
      content: 'mine\n',
      expectedSha: digestOf('stale\n'),
      force: true,
    })
    expect(result.outcome).toBe('written')
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('mine\n')
  })

  it('refuses a new file when somebody else created it first', async () => {
    // Null means "there was no file". If one exists now, the save would clobber
    // it, which is the same failure as any other stale write.
    const result = await writeProjectFile({
      cwd: root,
      path: 'src/index.ts',
      content: 'mine\n',
      expectedSha: null,
    })
    expect(result.outcome).toBe('conflict')
  })

  it('allows a save the file has not moved under', async () => {
    const result = await writeProjectFile({
      cwd: root,
      path: 'src/index.ts',
      content: 'export const A = 3\n',
      expectedSha: digestOf('export const A = 1\n'),
    })
    expect(result.outcome).toBe('written')
  })

  it('compares content rather than timestamps', async () => {
    // A checkout can restore a byte-identical file with a new mtime, and
    // refusing that save would be a conflict nobody could make sense of.
    writeFileSync(join(root, 'src', 'index.ts'), 'export const A = 1\n')
    const result = await writeProjectFile({
      cwd: root,
      path: 'src/index.ts',
      content: 'export const A = 9\n',
      expectedSha: digestOf('export const A = 1\n'),
    })
    expect(result.outcome).toBe('written')
  })
})
