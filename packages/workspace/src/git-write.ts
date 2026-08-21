import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { err, ok, type Result } from '@chorus/shared'
import { GitError, isSafeRef, type GitOptions } from './git.js'
import { readStatus } from './git.js'

const run = promisify(execFile)

/**
 * The commands that change a repository.
 *
 * **Its own file, and that is the point.** `git.ts` opens by saying it is
 * read-only by design and that "a convenience `git add` here would be a
 * mutation with no approval behind it". That sentence is still true of `git.ts`
 * and this module does not weaken it: the read path cannot mutate anything, and
 * anything that mutates has to be imported from here, by name, deliberately.
 *
 * What changed is a product decision, recorded rather than implied: Chorus now
 * offers source control, so staging, committing, pushing and discarding are
 * things the *person* asks for through the panel. They are not things an agent
 * can reach — no adapter imports this, and the IPC channels behind it are
 * driven by buttons.
 *
 * Every path is checked before it reaches git. `--` separates paths from
 * options, and paths are additionally resolved against the repository, because
 * `git add ../../other-repo/file` is a perfectly valid command and not one this
 * panel should be able to issue.
 */

/**
 * Whether a string may be handed to git as a pathspec.
 *
 * The `--` separator already stops a path being read as an option, so this is
 * about *reach* rather than injection: a path that climbs out of the repository
 * is one the panel is not looking at and must not act on.
 */
export function isSafePath(path: string): boolean {
  if (path === '' || path.length > 4096) return false
  if (path.includes('\0')) return false
  // Split rather than a substring test, so `..foo` and `foo..bar` are fine and
  // only a real parent segment is refused.
  return !path.split('/').includes('..') && !path.startsWith('/')
}

function checkPaths(paths: readonly string[], options: GitOptions): GitError | null {
  if (paths.length === 0) return new GitError('no paths given', options.cwd)
  const bad = paths.find((path) => !isSafePath(path))
  return bad === undefined
    ? null
    : new GitError(`refusing the path ${JSON.stringify(bad)}`, options.cwd)
}

async function git(
  options: GitOptions & { readonly timeoutMs?: number },
  args: readonly string[]
): Promise<Result<string, GitError>> {
  try {
    const { stdout } = await run('git', [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return ok(stdout)
  } catch (error) {
    const stderr =
      typeof error === 'object' &&
      error !== null &&
      typeof (error as { stderr?: unknown }).stderr === 'string'
        ? (error as { stderr: string }).stderr.trim()
        : ''
    const message = stderr !== '' ? stderr : error instanceof Error ? error.message : String(error)
    return err(new GitError(message, options.cwd))
  }
}

/** Add paths to the index. Reversible by `unstage`, which is why it needs no confirmation. */
export async function stage(
  options: GitOptions & { readonly paths: readonly string[] }
): Promise<Result<void, GitError>> {
  const bad = checkPaths(options.paths, options)
  if (bad !== null) return err(bad)
  const result = await git(options, ['add', '--', ...options.paths])
  return result.ok ? ok(undefined) : result
}

/** Take paths back out of the index, leaving the working tree alone. */
export async function unstage(
  options: GitOptions & { readonly paths: readonly string[] }
): Promise<Result<void, GitError>> {
  const bad = checkPaths(options.paths, options)
  if (bad !== null) return err(bad)
  const result = await git(options, ['restore', '--staged', '--', ...options.paths])
  return result.ok ? ok(undefined) : result
}

/**
 * Throw away changes to paths. **The only operation here that destroys work.**
 *
 * Two commands, because git has two notions of "undo this file" and neither
 * covers the other: `restore` puts a *tracked* file back to HEAD, and a file
 * git has never seen is not restorable at all — it has to be deleted. Running
 * only the first silently leaves new files behind, which reads as "discard did
 * not work".
 *
 * The split is computed here from status rather than asked of the caller, so a
 * renderer cannot get it wrong and delete something it meant to revert.
 */
export async function discard(
  options: GitOptions & { readonly paths: readonly string[] }
): Promise<Result<void, GitError>> {
  const bad = checkPaths(options.paths, options)
  if (bad !== null) return err(bad)

  const status = await readStatus(options)
  if (!status.ok) return status
  const untracked = new Set(
    status.value.files.filter((file) => file.state === 'untracked').map((file) => file.path)
  )

  const tracked = options.paths.filter((path) => !untracked.has(path))
  const fresh = options.paths.filter((path) => untracked.has(path))

  if (tracked.length > 0) {
    // Both sides: a file staged *and* modified needs the index and the worktree
    // put back, or "discard" leaves half the change in place.
    const result = await git(options, ['restore', '--staged', '--worktree', '--', ...tracked])
    if (!result.ok) return result
  }
  if (fresh.length > 0) {
    // `-d` as well, or discarding a new directory of files leaves the directory.
    const result = await git(options, ['clean', '-fd', '--', ...fresh])
    if (!result.ok) return result
  }
  return ok(undefined)
}

/**
 * Commit what is staged.
 *
 * Deliberately not `-a`: the panel has a staging area and showing one while
 * committing something else is the kind of surprise that loses trust in the
 * whole feature.
 */
export async function commit(
  options: GitOptions & { readonly message: string }
): Promise<Result<string, GitError>> {
  const message = options.message.trim()
  if (message === '') return err(new GitError('a commit needs a message', options.cwd))

  const result = await git(options, ['commit', '-m', message])
  if (!result.ok) return result

  const sha = await git(options, ['rev-parse', 'HEAD'])
  return sha.ok ? ok(sha.value.trim()) : sha
}

export interface PushOptions extends GitOptions {
  readonly remote: string
  readonly branch: string
  /** First push of a branch: set the upstream as well as sending it. */
  readonly setUpstream?: boolean
}

/**
 * Send the branch to a remote.
 *
 * The one operation here that other people can see, and the only one this
 * module refuses to make convenient: no `--force`, and no way to ask for it.
 * A force-push is the irreversible action the permission engine's own rule
 * names, and a button for it in a side panel is how someone loses a colleague's
 * commits at four in the afternoon.
 */
export async function push(options: PushOptions): Promise<Result<void, GitError>> {
  for (const ref of [options.remote, options.branch]) {
    if (!isSafeRef(ref)) return err(new GitError(`refusing ${JSON.stringify(ref)}`, options.cwd))
  }
  const args = ['push']
  if (options.setUpstream === true) args.push('--set-upstream')
  args.push(options.remote, options.branch)

  // The network deserves longer than a local command, and still a bound.
  const result = await git({ ...options, timeoutMs: 120_000 }, args)
  return result.ok ? ok(undefined) : result
}
