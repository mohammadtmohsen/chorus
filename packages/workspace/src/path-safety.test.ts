import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolveWithinRoot } from './path-safety.js'

let root: string
let outside: string

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'chorus-path-'))
  root = join(base, 'project')
  outside = join(base, 'secrets')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), '')
  writeFileSync(join(outside, 'creds.txt'), 'token')
  symlinkSync(outside, join(root, 'escape-link'))
})

describe('resolveWithinRoot', () => {
  it('accepts a plain relative path inside the root', () => {
    const r = resolveWithinRoot(root, 'src/index.ts')
    expect(r.ok).toBe(true)
  })

  it('accepts a file that does not exist yet', () => {
    // The common case: the agent is about to create it.
    const r = resolveWithinRoot(root, 'src/new-file.ts')
    expect(r.ok).toBe(true)
  })

  it('accepts the root itself', () => {
    expect(resolveWithinRoot(root, '.').ok).toBe(true)
  })

  const traversals = [
    '../secrets/creds.txt',
    '../../etc/passwd',
    'src/../../secrets/creds.txt',
    './src/./../../secrets/creds.txt',
  ]
  it.each(traversals)('rejects traversal: %s', (candidate) => {
    const r = resolveWithinRoot(root, candidate)
    expect(r.ok).toBe(false)
  })

  it('rejects an absolute path outside the root', () => {
    expect(resolveWithinRoot(root, '/etc/passwd').ok).toBe(false)
  })

  it('rejects escape through a symlinked directory', () => {
    // A naive prefix check passes this, which is the whole reason we realpath.
    const r = resolveWithinRoot(root, 'escape-link/creds.txt')
    expect(r.ok).toBe(false)
  })

  it('rejects a sibling directory sharing the root prefix', () => {
    // "/tmp/x/project-evil" must not count as inside "/tmp/x/project".
    const sibling = resolve(root, '..', 'project-evil', 'f.txt')
    expect(resolveWithinRoot(root, sibling).ok).toBe(false)
  })
})
