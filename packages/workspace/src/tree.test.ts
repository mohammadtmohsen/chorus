/**
 * The tree read, against a real repository with real ignore rules.
 *
 * `.gitignore` precedence cannot be tested from a fixture string — the whole
 * point of leaning on `check-ignore` is that git owns the rules, so the test has
 * to ask git too.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { readDirectory } from './tree.js'

let base: string
let cwd: string
let outside: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'chorus-tree-'))
  const configPath = join(base, 'gitconfig')
  writeFileSync(configPath, '')
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_SYSTEM: configPath,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  cwd = join(base, 'repo')
  outside = join(base, 'secrets')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'creds.txt'), 'token')

  execFileSync('git', ['init', '-b', 'main', cwd], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  mkdirSync(join(cwd, 'src', 'nested'), { recursive: true })
  mkdirSync(join(cwd, 'node_modules', 'left-pad'), { recursive: true })
  mkdirSync(join(cwd, 'build'), { recursive: true })
  writeFileSync(join(cwd, '.gitignore'), 'node_modules/\nbuild/\n*.log\n')
  writeFileSync(join(cwd, 'README.md'), '# hi\n')
  writeFileSync(join(cwd, 'noisy.log'), 'ignored\n')
  writeFileSync(join(cwd, 'src', 'index.ts'), 'export const A = 1\n')
  writeFileSync(join(cwd, 'src', 'nested', 'deep.ts'), 'export const B = 2\n')
  writeFileSync(join(cwd, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(cwd, 'build', 'out.js'), 'built\n')
  symlinkSync(outside, join(cwd, 'escape-link'))

  execFileSync('git', ['add', '.'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('git', ['commit', '-m', 'first'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
})

const names = (entries: readonly { name: string }[]): string[] => entries.map((e) => e.name)

describe('readDirectory', () => {
  it('lists the root with directories first', async () => {
    const r = await readDirectory({ cwd, path: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const directories = r.value.filter((e) => e.directory).map((e) => e.name)
    const files = r.value.filter((e) => !e.directory).map((e) => e.name)
    // Every directory sorts before every file.
    expect(names(r.value)).toEqual([...directories, ...files])
    expect(directories).toContain('src')
  })

  it('honours .gitignore, including a bare glob', async () => {
    const r = await readDirectory({ cwd, path: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(names(r.value)).not.toContain('node_modules')
    expect(names(r.value)).not.toContain('build')
    expect(names(r.value)).not.toContain('noisy.log')
    expect(names(r.value)).toContain('README.md')
  })

  it('never lists .git, which no ignore rule covers', async () => {
    // git excludes it structurally rather than through `.gitignore`, so nothing
    // in `check-ignore` would drop it.
    const r = await readDirectory({ cwd, path: '' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(names(r.value)).not.toContain('.git')
  })

  it('lists a nested directory with repo-relative paths', async () => {
    const r = await readDirectory({ cwd, path: 'src' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.map((e) => e.path).sort()).toEqual(['src/index.ts', 'src/nested'])
    expect(r.value.find((e) => e.name === 'nested')?.directory).toBe(true)
  })

  it('shows everything in a directory with nothing ignored', async () => {
    // `check-ignore` exits 1 when it matches nothing, which reads as a failure
    // to `execFile`. Treating that as an error would render this directory empty.
    const r = await readDirectory({ cwd, path: 'src/nested' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(names(r.value)).toEqual(['deep.ts'])
  })

  it('refuses a path that climbs out of the project', async () => {
    const r = await readDirectory({ cwd, path: '../secrets' })
    expect(r.ok).toBe(false)
  })

  it('refuses to expand a symlink pointing outside the project', async () => {
    // The listing shows the link — it could legitimately point within the repo
    // — and the refusal happens when someone tries to open it.
    const root = await readDirectory({ cwd, path: '' })
    expect(root.ok).toBe(true)
    if (root.ok) expect(names(root.value)).toContain('escape-link')

    const through = await readDirectory({ cwd, path: 'escape-link' })
    expect(through.ok).toBe(false)
  })

  it('reports a directory that does not exist rather than throwing', async () => {
    const r = await readDirectory({ cwd, path: 'no-such-dir' })
    expect(r.ok).toBe(false)
  })
})
