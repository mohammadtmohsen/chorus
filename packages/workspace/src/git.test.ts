/**
 * Against a real repository, because the thing under test is what git prints.
 *
 * `diff.ts` and `status.ts` are pure and tested against recorded output; this
 * file exists for the half that cannot be: whether the argument vectors are the
 * right ones. The merge-base case in particular cannot be proved from a fixture
 * string — it needs a base branch that genuinely moved after the branch was cut.
 */

import { execFileSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  isSafeRef,
  MAX_EDITOR_BYTES,
  readFileAt,
  readBranchDiff,
  readBranches,
  readDiff,
  readMergeBase,
  readWorkspace,
} from './git.js'

let base: string
let cwd: string
let firstSha: string

/**
 * A private config file rather than `/dev/null`: this has to run on Windows CI
 * too, and it must not read the developer's own global git config — a
 * `diff.external` or a default branch name there would change what is tested.
 */
function makeEnv(configPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_SYSTEM: configPath,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
}

let env: NodeJS.ProcessEnv

function run(...args: string[]): string {
  // `stdio` piped, or `git checkout`'s "Switched to branch" lands in the test
  // output and reads like a failure.
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'chorus-git-'))
  const configPath = join(base, 'gitconfig')
  writeFileSync(configPath, '')
  env = makeEnv(configPath)
  cwd = join(base, 'repo')

  execFileSync('git', ['init', '-b', 'main', cwd], { env, encoding: 'utf8' })

  writeFileSync(join(cwd, 'shared.txt'), 'one\n')
  run('add', 'shared.txt')
  run('commit', '-m', 'first')
  firstSha = run('rev-parse', 'HEAD').trim()

  // main moves on *after* the branch is cut. Everything below turns on this.
  run('checkout', '-b', 'feature')
  run('checkout', 'main')
  writeFileSync(join(cwd, 'moved-on-main.txt'), 'main moved\n')
  run('add', 'moved-on-main.txt')
  run('commit', '-m', 'main moved on')

  run('checkout', 'feature')
  writeFileSync(join(cwd, 'added-on-branch.txt'), 'branch work\n')
  run('add', 'added-on-branch.txt')
  run('commit', '-m', 'branch work')

  // ...and something not committed yet.
  appendFileSync(join(cwd, 'shared.txt'), 'uncommitted\n')

  // A remote-tracking ref and the symbolic pointer beside it, without a network.
  run('update-ref', 'refs/remotes/origin/main', firstSha)
  run('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
})

const paths = (files: readonly { path: string }[]): string[] => files.map((f) => f.path).sort()

/** A repository of its own, for a test whose fixture would disturb the shared one. */
function scratchRepo(name: string): string {
  const repo = join(base, `scratch-${name}`)
  execFileSync('git', ['init', '-b', 'main', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  return repo
}

function commitAll(repo: string): void {
  const at = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  at('add', '.')
  at('commit', '-m', 'fixture')
}

describe('readMergeBase', () => {
  it('resolves to where the branch left the base', async () => {
    const r = await readMergeBase({ cwd, base: 'main' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(firstSha)
  })

  it('reports a bad revision rather than throwing', async () => {
    const r = await readMergeBase({ cwd, base: 'no-such-branch' })
    expect(r.ok).toBe(false)
    // git's own sentence, not execFile's "Command failed" preamble.
    if (!r.ok) expect(r.error.message).toMatch(/no-such-branch/)
  })
})

describe('readBranchDiff', () => {
  it('excludes commits the base took after the branch was cut', async () => {
    // The entire reason this plan exists. Two-dot `git diff main` would list
    // moved-on-main.txt as a deletion, as though the branch had reverted it.
    const r = await readBranchDiff({ cwd, base: 'main' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(paths(r.value.files)).not.toContain('moved-on-main.txt')
    expect(r.value.mergeBase).toBe(firstSha)
    expect(r.value.base).toBe('main')
  })

  it('includes uncommitted work by default', async () => {
    const r = await readBranchDiff({ cwd, base: 'main' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(paths(r.value.files)).toEqual(['added-on-branch.txt', 'shared.txt'])
  })

  it('stops at the last commit when asked', async () => {
    const r = await readBranchDiff({ cwd, base: 'main', committedOnly: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(paths(r.value.files)).toEqual(['added-on-branch.txt'])
  })

  it('carries the status letter through from git', async () => {
    const r = await readBranchDiff({ cwd, base: 'main', committedOnly: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.files[0]?.status).toBe('added')
  })
})

describe('argument injection', () => {
  // An argument array stops the shell, not git's own options. `--output` writes
  // a file, so a ref that reaches git unchecked is a write primitive.
  it('refuses an option-shaped ref, and writes nothing', async () => {
    const bomb = join(base, 'pwned.txt')
    const r = await readDiff({ cwd, from: `--output=${bomb}` })
    expect(r.ok).toBe(false)
    expect(existsSync(bomb)).toBe(false)
  })

  it('refuses an option-shaped base before running merge-base', async () => {
    const r = await readMergeBase({ cwd, base: '--help' })
    expect(r.ok).toBe(false)
  })

  it('accepts the branch names people actually have', () => {
    for (const ref of ['develop', 'origin/develop', 'feature-x', 'feat/ABC-123_thing', 'v1.2.3']) {
      expect(isSafeRef(ref), ref).toBe(true)
    }
  })

  it('rejects what git itself forbids in a refname', () => {
    for (const ref of [
      '-x',
      'a b',
      'a~1',
      'a^',
      'a:b',
      'a?',
      'a*',
      'a[',
      'a\\b',
      'a..b',
      'HEAD@{1}',
      '',
    ]) {
      expect(isSafeRef(ref), ref).toBe(false)
    }
  })
})

describe('readBranches', () => {
  it('lists local and remote branches and marks the checked-out one', async () => {
    const r = await readBranches({ cwd })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const names = r.value.map((b) => b.name)
    expect(names).toContain('main')
    expect(names).toContain('feature')
    expect(names).toContain('origin/main')
    expect(r.value.find((b) => b.name === 'feature')?.head).toBe(true)
    expect(r.value.find((b) => b.name === 'main')?.head).toBe(false)
    expect(r.value.find((b) => b.name === 'origin/main')?.remote).toBe(true)
  })

  it('omits origin/HEAD, which is a pointer rather than a branch', async () => {
    const r = await readBranches({ cwd })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.map((b) => b.name)).not.toContain('origin/HEAD')
  })
})

describe('readWorkspace', () => {
  it('shows the working tree and names no baseline when no base is asked for', async () => {
    const r = await readWorkspace({ cwd })
    expect(r.comparison).toBeNull()
    expect(r.problem).toBeNull()
    expect(paths(r.diff)).toEqual(['shared.txt'])
  })

  it('names the baseline it actually compared against', async () => {
    const r = await readWorkspace({ cwd, base: 'main' })
    expect(r.problem).toBeNull()
    expect(r.comparison).toEqual({ base: 'main', mergeBase: firstSha })
    expect(paths(r.diff)).not.toContain('moved-on-main.txt')
  })

  it('reports an unresolvable base instead of quietly showing the working tree', async () => {
    // The failure that would matter: a panel labelled "vs origin/develop" that
    // is really showing uncommitted work, on a repo that was never fetched.
    const r = await readWorkspace({ cwd, base: 'origin/develop' })
    expect(r.comparison).toBeNull()
    expect(r.diff).toEqual([])
    expect(r.problem).not.toBeNull()
    expect(r.status.branch).toBe('feature')
  })

  it('still reports status when the diff fails', async () => {
    const r = await readWorkspace({ cwd, base: 'origin/develop' })
    expect(r.status.files.length).toBeGreaterThan(0)
  })

  it('is not an error outside a repository', async () => {
    const r = await readWorkspace({ cwd: base })
    expect(r.problem).toBeNull()
    expect(r.diff).toEqual([])
    expect(r.comparison).toBeNull()
  })
})

describe('readFileAt', () => {
  it('reads a file as it was at a revision', async () => {
    const r = await readFileAt({ cwd, ref: firstSha, path: 'shared.txt' })
    expect(r.ok).toBe(true)
    // The committed content, not the working tree's — the appended line is not
    // in this commit.
    if (r.ok) expect(r.value).toEqual({ kind: 'text', text: 'one\n' })
  })

  it('calls a file that did not exist yet absent, not an error', async () => {
    // The added-on-this-branch case, and the reason `absent` is a kind rather
    // than a failure: an editor shows it as an empty original side.
    const r = await readFileAt({ cwd, ref: firstSha, path: 'added-on-branch.txt' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ kind: 'absent' })
  })

  it('refuses an option-shaped ref', async () => {
    const r = await readFileAt({ cwd, ref: '--output=/tmp/x', path: 'shared.txt' })
    expect(r.ok).toBe(false)
  })

  /*
   * These two commit, so they get their own repository.
   *
   * In the shared fixture they would move `feature`'s HEAD, and every assertion
   * about the branch diff above would then depend on having run first. Test
   * order is deterministic in vitest, which is exactly what makes that kind of
   * coupling survive review and break later.
   */
  it('reports a binary file rather than returning its bytes', async () => {
    const repo = scratchRepo('binary')
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
    commitAll(repo)
    const r = await readFileAt({ cwd: repo, ref: 'HEAD', path: 'blob.bin' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.kind).toBe('binary')
  })

  it('refuses a file too large to hand to an editor', async () => {
    const repo = scratchRepo('huge')
    writeFileSync(join(repo, 'huge.txt'), 'x'.repeat(MAX_EDITOR_BYTES + 1024))
    commitAll(repo)
    const r = await readFileAt({ cwd: repo, ref: 'HEAD', path: 'huge.txt' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.kind).toBe('tooLarge')
  })
})

describe('what a diff does not cover', () => {
  it('omits untracked files, which is git behaviour and why status exists', async () => {
    // Recorded rather than fixed: `git diff` has never listed untracked files.
    // The panel has to read them out of status, not out of the diff.
    writeFileSync(join(cwd, 'untracked.txt'), 'new\n')
    const r = await readWorkspace({ cwd })
    expect(paths(r.diff)).not.toContain('untracked.txt')
    expect(r.status.files.some((f) => f.path === 'untracked.txt')).toBe(true)
  })
})
