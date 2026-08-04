import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { err, ok, type Result } from '@chorus/shared'
import { parseDiff, type DiffFile } from './diff.js'
import { EMPTY_STATUS, parseStatus, type WorkspaceStatus } from './status.js'

const run = promisify(execFile)

/**
 * Reading a repository's state.
 *
 * Read-only by design: nothing here stages, commits, or writes. Chorus reviews
 * what an agent did; the agent is the one that acts, and its actions go through
 * the approval gate. A convenience `git add` here would be a mutation with no
 * approval behind it.
 *
 * `execFile` with an argument array, never a shell string — a branch or path
 * containing a quote should be a rendering problem, not an injection.
 */

export interface GitOptions {
  readonly cwd: string
  readonly timeoutMs?: number
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly cwd: string
  ) {
    super(message)
    this.name = 'GitError'
  }
}

async function git(
  options: GitOptions,
  args: readonly string[]
): Promise<Result<string, GitError>> {
  try {
    const { stdout } = await run('git', [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 15_000,
      // A diff of a large change can exceed the default 1 MB buffer, and being
      // truncated mid-hunk is worse than being slow.
      maxBuffer: 32 * 1024 * 1024,
    })
    return ok(stdout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new GitError(message, options.cwd))
  }
}

export async function isRepository(options: GitOptions): Promise<boolean> {
  const result = await git(options, ['rev-parse', '--is-inside-work-tree'])
  return result.ok && result.value.trim() === 'true'
}

export async function readStatus(options: GitOptions): Promise<Result<WorkspaceStatus, GitError>> {
  const result = await git(options, ['status', '--porcelain=v2', '--branch'])
  if (!result.ok) return result
  return ok(parseStatus(result.value))
}

export interface DiffOptions extends GitOptions {
  /** Staged changes rather than working-tree ones. */
  readonly staged?: boolean
  readonly path?: string
}

export async function readDiff(options: DiffOptions): Promise<Result<DiffFile[], GitError>> {
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (options.staged === true) args.push('--cached')
  if (options.path !== undefined) args.push('--', options.path)

  const result = await git(options, args)
  if (!result.ok) return result
  return ok(parseDiff(result.value))
}

/**
 * Everything an agent has changed, staged or not, as one diff.
 *
 * This is what the review view shows by default: after a turn, the question is
 * "what did it do", and splitting that across staged and unstaged makes the
 * reader reassemble it themselves.
 */
export async function readWorkingDiff(options: GitOptions): Promise<Result<DiffFile[], GitError>> {
  const [unstaged, staged] = await Promise.all([
    readDiff({ ...options }),
    readDiff({ ...options, staged: true }),
  ])
  if (!unstaged.ok) return unstaged
  if (!staged.ok) return staged

  // Staged first: it is the older half of the change.
  const merged = new Map<string, DiffFile>()
  for (const file of [...staged.value, ...unstaged.value]) {
    const existing = merged.get(file.path)
    merged.set(
      file.path,
      existing === undefined
        ? file
        : {
            ...existing,
            hunks: [...existing.hunks, ...file.hunks],
            added: existing.added + file.added,
            removed: existing.removed + file.removed,
          }
    )
  }
  return ok([...merged.values()])
}

export async function readWorkspace(
  options: GitOptions
): Promise<{ status: WorkspaceStatus; diff: DiffFile[]; problem: string | null }> {
  if (!(await isRepository(options))) {
    // Not every project is a git repo, and that is not an error — it just means
    // there is nothing to review.
    return { status: EMPTY_STATUS, diff: [], problem: null }
  }

  const [status, diff] = await Promise.all([readStatus(options), readWorkingDiff(options)])
  return {
    status: status.ok ? status.value : EMPTY_STATUS,
    diff: diff.ok ? diff.value : [],
    problem: status.ok ? (diff.ok ? null : diff.error.message) : status.error.message,
  }
}
