import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { watchWorkspace, type WorkspaceWatch } from './workspace-watch.js'

/**
 * The watcher, against a real repository, because the bug was not in a string.
 *
 * A unit test over `isNoise` would have passed with the defect in place: the
 * question is not "is `index.lock` filtered" but "does reading git make the
 * watcher fire", and only git can answer that. It takes the lock on commands
 * that print nothing and change nothing, which is exactly why the loop was
 * invisible in the code.
 */

/** A shade over `DEBOUNCE_MS`, so a nudge that is coming has arrived. */
const SETTLE_MS = 900

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'chorus-watch-'))
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(cwd, 'a.ts'), 'export const A = 1\n')
  git('add', 'a.ts')
  git('commit', '-qm', 'first')
  return cwd
}

let open: WorkspaceWatch | null = null
afterEach(() => {
  open?.close()
  open = null
})

describe('watchWorkspace', () => {
  it('does not fire on the panel’s own read of git', async () => {
    /*
     * The loop, in one assertion.
     *
     * `git status` takes `.git/index.lock` **and rewrites `.git/index`** — both
     * on a command that changes nothing a person did. The watcher called that
     * news, the panel re-read, and round it went at about 2Hz: a flickering
     * Refresh button, an editor that could not hold focus because its file was
     * reloaded under it, and a main thread pinned in synchronous git.
     *
     * Driven through `suppress`, because that is how `ipc.ts` runs every
     * read-only git command. Removing the wrapper there, or the `ours()` check
     * in the watcher, fails this.
     */
    const cwd = repo()
    let nudges = 0
    const watch = watchWorkspace(cwd, () => {
      nudges += 1
    })
    open = watch
    await settle()
    nudges = 0

    for (let i = 0; i < 3; i += 1) {
      await watch.suppress(() => {
        execFileSync('git', ['-C', cwd, 'status', '--porcelain=v2', '--branch'], {
          stdio: 'ignore',
        })
        execFileSync('git', ['-C', cwd, 'diff', '--no-color', '--no-ext-diff'], { stdio: 'ignore' })
        return Promise.resolve()
      })
    }
    await settle()

    expect(nudges).toBe(0)
  })

  it('still hears a .git change that is not ours, mid-read', async () => {
    /*
     * The hole the first version of this had, found by the e2e driver.
     *
     * Suppression quietened the whole of `.git` for the length of our own
     * command. The driver configures an upstream with four `git config` calls —
     * `.git/config`, nothing else — they landed inside a window, and the panel
     * never learned the branch had one: `it shows how far the branch has
     * drifted from its upstream` failed with git reporting `ahead: 1` and the
     * DOM showing nothing. Only `index` and `index.lock` are ours.
     */
    const cwd = repo()
    let nudges = 0
    const watch = watchWorkspace(cwd, () => {
      nudges += 1
    })
    open = watch
    await settle()
    nudges = 0

    await watch.suppress(() => {
      execFileSync('git', ['-C', cwd, 'status', '--porcelain=v2', '--branch'], { stdio: 'ignore' })
      execFileSync('git', ['-C', cwd, 'config', 'branch.main.remote', 'origin'], {
        stdio: 'ignore',
      })
      return Promise.resolve()
    })
    await settle()

    expect(nudges).toBeGreaterThan(0)
  })

  it('still hears a stage made outside the app', async () => {
    /*
     * The half a filter could not have kept.
     *
     * `git add` changes `.git/index` and nothing else in the repository, so an
     * `IGNORED` entry for `index` would have killed the loop and this signal
     * together — and Phase 2 verified this signal on purpose. Suppression is
     * scoped to our own commands, so someone else's stage still arrives.
     */
    const cwd = repo()
    let nudges = 0
    open = watchWorkspace(cwd, () => {
      nudges += 1
    })

    /*
     * The file lands and is allowed to settle *before* the count starts.
     *
     * Otherwise this passes with `git add` doing nothing at all: the write
     * itself nudges the worktree watch, and a `git add -A` with nothing to
     * stage still rewrites the index. The first version of this test did
     * exactly that and proved neither thing it claimed.
     */
    writeFileSync(join(cwd, 'staged-outside.ts'), 'export const S = 3\n')
    await settle()
    nudges = 0

    execFileSync('git', ['-C', cwd, 'add', 'staged-outside.ts'], { stdio: 'ignore' })
    await settle()

    expect(nudges).toBeGreaterThan(0)
  })

  it('still fires when the tree really moves', async () => {
    /*
     * The control, and it is not optional.
     *
     * An assertion that counts to zero passes just as well when the watcher is
     * broken outright — the same shape as C-027, where counting panes could
     * never prove a shortcut was ignored. This is what says the mechanism is
     * alive, so the test above is measuring a filter rather than a corpse.
     */
    const cwd = repo()
    let nudges = 0
    open = watchWorkspace(cwd, () => {
      nudges += 1
    })
    await settle()
    nudges = 0

    writeFileSync(join(cwd, 'b.ts'), 'export const B = 2\n')
    await settle()

    expect(nudges).toBeGreaterThan(0)
  })
})
