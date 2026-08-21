/**
 * The commands that change a repository, against real ones.
 *
 * Each case gets its own repository. These mutate by definition, so a shared
 * fixture would make every assertion depend on the order the others ran in —
 * the coupling `git.test.ts` had to be rescued from once already.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { readStatus } from './git.js'
import { commit, discard, isSafePath, push, stage, unstage } from './git-write.js'

let base: string
let cwd: string
let env: NodeJS.ProcessEnv

const at = (repo: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'chorus-gitwrite-'))
  const configPath = join(base, 'gitconfig')
  writeFileSync(configPath, '')
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_SYSTEM: configPath,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  cwd = join(base, 'repo')
  execFileSync('git', ['init', '-b', 'main', cwd], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'kept.ts'), 'export const A = 1\n')
  at(cwd, 'add', '.')
  at(cwd, 'commit', '-m', 'first')
})

const stagedPaths = async (): Promise<string[]> => {
  const status = await readStatus({ cwd })
  if (!status.ok) throw status.error
  return status.value.files.filter((f) => f.staged).map((f) => f.path)
}

describe('stage and unstage', () => {
  it('stages a modified file and takes it back out again', async () => {
    writeFileSync(join(cwd, 'src', 'kept.ts'), 'export const A = 2\n')

    expect((await stage({ cwd, paths: ['src/kept.ts'] })).ok).toBe(true)
    expect(await stagedPaths()).toEqual(['src/kept.ts'])

    expect((await unstage({ cwd, paths: ['src/kept.ts'] })).ok).toBe(true)
    expect(await stagedPaths()).toEqual([])
    // Unstaging leaves the work alone — that is what makes it the inverse.
    expect(readFileSync(join(cwd, 'src', 'kept.ts'), 'utf8')).toBe('export const A = 2\n')
  })

  it('refuses a path that climbs out of the repository', async () => {
    const result = await stage({ cwd, paths: ['../elsewhere/file.ts'] })
    expect(result.ok).toBe(false)
  })

  it('refuses an empty list rather than staging everything', async () => {
    // `git add --` with no paths is a no-op, but an empty list reaching here at
    // all means the caller lost track of a selection.
    expect((await stage({ cwd, paths: [] })).ok).toBe(false)
  })
})

describe('discard', () => {
  it('puts a modified file back', async () => {
    writeFileSync(join(cwd, 'src', 'kept.ts'), 'ruined\n')
    expect((await discard({ cwd, paths: ['src/kept.ts'] })).ok).toBe(true)
    expect(readFileSync(join(cwd, 'src', 'kept.ts'), 'utf8')).toBe('export const A = 1\n')
  })

  it('deletes a file git has never seen', async () => {
    // `git restore` cannot touch an untracked file, so a discard that only
    // restored would silently leave new files behind.
    writeFileSync(join(cwd, 'src', 'brand-new.ts'), 'new\n')
    expect((await discard({ cwd, paths: ['src/brand-new.ts'] })).ok).toBe(true)
    expect(existsSync(join(cwd, 'src', 'brand-new.ts'))).toBe(false)
  })

  it('clears both the index and the worktree for a file that is staged and modified', async () => {
    writeFileSync(join(cwd, 'src', 'kept.ts'), 'staged\n')
    at(cwd, 'add', 'src/kept.ts')
    writeFileSync(join(cwd, 'src', 'kept.ts'), 'and then modified again\n')

    expect((await discard({ cwd, paths: ['src/kept.ts'] })).ok).toBe(true)
    expect(readFileSync(join(cwd, 'src', 'kept.ts'), 'utf8')).toBe('export const A = 1\n')
    expect(await stagedPaths()).toEqual([])
  })

  it('leaves files it was not asked about alone', async () => {
    writeFileSync(join(cwd, 'src', 'kept.ts'), 'changed\n')
    writeFileSync(join(cwd, 'src', 'other.ts'), 'also changed\n')
    expect((await discard({ cwd, paths: ['src/kept.ts'] })).ok).toBe(true)
    expect(readFileSync(join(cwd, 'src', 'other.ts'), 'utf8')).toBe('also changed\n')
  })
})

describe('commit', () => {
  it('commits what is staged and reports the new sha', async () => {
    writeFileSync(join(cwd, 'src', 'kept.ts'), 'export const A = 2\n')
    await stage({ cwd, paths: ['src/kept.ts'] })

    const result = await commit({ cwd, message: 'change the constant' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toMatch(/^[0-9a-f]{40}$/)
    expect(at(cwd, 'log', '-1', '--pretty=%s').trim()).toBe('change the constant')
  })

  it('leaves unstaged work out of the commit', async () => {
    // No `-a`: the panel shows a staging area, and committing something it is
    // not showing is the surprise that loses trust in the whole feature.
    writeFileSync(join(cwd, 'src', 'kept.ts'), 'staged\n')
    await stage({ cwd, paths: ['src/kept.ts'] })
    writeFileSync(join(cwd, 'src', 'later.ts'), 'not staged\n')

    expect((await commit({ cwd, message: 'only the staged one' })).ok).toBe(true)
    expect(at(cwd, 'show', '--name-only', '--pretty=', 'HEAD').trim()).toBe('src/kept.ts')
  })

  it('refuses an empty message', async () => {
    expect((await commit({ cwd, message: '   ' })).ok).toBe(false)
  })

  it('reports the failure when there is nothing staged', async () => {
    const result = await commit({ cwd, message: 'nothing to say' })
    expect(result.ok).toBe(false)
  })
})

describe('push', () => {
  it('sends the branch to a remote and can set the upstream', async () => {
    const remote = join(base, 'remote.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', remote], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    at(cwd, 'remote', 'add', 'origin', remote)

    const result = await push({ cwd, remote: 'origin', branch: 'main', setUpstream: true })
    expect(result.ok).toBe(true)
    // The remote really has it, rather than the command merely exiting zero.
    expect(
      execFileSync('git', ['log', '-1', '--pretty=%s', 'main'], {
        cwd: remote,
        env,
        encoding: 'utf8',
      }).trim()
    ).toBe('first')
  })

  it('refuses an option-shaped remote or branch', async () => {
    expect((await push({ cwd, remote: '--exec=touch /tmp/x', branch: 'main' })).ok).toBe(false)
    expect((await push({ cwd, remote: 'origin', branch: '--force' })).ok).toBe(false)
  })
})

describe('isSafePath', () => {
  it('accepts ordinary repository paths', () => {
    for (const path of ['a.ts', 'src/a.ts', 'src/x..y/a.ts', '..hidden.ts', 'a b/c.ts']) {
      expect(isSafePath(path), path).toBe(true)
    }
  })

  it('refuses anything that leaves the repository', () => {
    for (const path of ['../a.ts', 'src/../../a.ts', '/etc/passwd', '']) {
      expect(isSafePath(path), path).toBe(false)
    }
  })
})
