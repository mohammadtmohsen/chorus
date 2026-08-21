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
 * `fetchRef` is the one exception and it is not a mutation of the work: it moves
 * remote-tracking refs so a base branch is current, touches no file in the tree,
 * and runs only when a person asks for it.
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

function stderrOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const value = (error as { stderr?: unknown }).stderr
  return typeof value === 'string' ? value.trim() : ''
}

async function git(
  options: GitOptions & { readonly maxBytes?: number },
  args: readonly string[]
): Promise<Result<string, GitError>> {
  try {
    const { stdout } = await run('git', [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 15_000,
      // A diff of a large change can exceed the default 1 MB buffer, and being
      // truncated mid-hunk is worse than being slow. A caller reading one file
      // for an editor passes its own, smaller cap: there the size *is* the
      // answer, and `maxBuffer length exceeded` is how it arrives.
      maxBuffer: options.maxBytes ?? 32 * 1024 * 1024,
    })
    return ok(stdout)
  } catch (error) {
    // git's own line first. `execFile` prefixes "Command failed: git diff …",
    // which buries "fatal: bad revision 'origin/develop'" — and that sentence is
    // the whole answer when someone picks a base they have never fetched.
    const stderr = stderrOf(error)
    const message = stderr !== '' ? stderr : error instanceof Error ? error.message : String(error)
    return err(new GitError(message, options.cwd))
  }
}

/**
 * Whether a string may be handed to git as a revision.
 *
 * An argument array stops *shell* injection, not *argument* injection: `git
 * diff --output=/tmp/x` is a perfectly valid invocation, so a ref beginning with
 * a dash is an option however innocently it arrived. Everything else here is
 * git's own refname grammar (`git check-ref-format`), which forbids whitespace,
 * `~ ^ : ? * [ \`, `..` and `@{`. Rejecting rather than escaping, because there
 * is no legitimate branch this refuses.
 */
// eslint-disable-next-line no-control-regex -- control characters are precisely what git forbids in a refname
const UNSAFE_REF = /^-|[\s~^:?*[\]\\\x00-\x1f]|\.\.|@\{/

export function isSafeRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 255 && !UNSAFE_REF.test(ref)
}

function refused(ref: string, options: GitOptions): GitError {
  return new GitError(`refusing to use ${JSON.stringify(ref)} as a git revision`, options.cwd)
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
  /**
   * Diff from this commit rather than from the index.
   *
   * With `to` left out the comparison runs to the working tree, so uncommitted
   * work is included — which is what someone reviewing their own branch means by
   * "what have I changed".
   */
  readonly from?: string
  readonly to?: string
  /**
   * Build line-by-line hunks, or only the per-file summary. See
   * `ParseDiffOptions`. Defaults to true, so every existing caller is unchanged.
   */
  readonly hunks?: boolean
}

export async function readDiff(options: DiffOptions): Promise<Result<DiffFile[], GitError>> {
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (options.staged === true) args.push('--cached')
  for (const ref of [options.from, options.to]) {
    if (ref === undefined) continue
    if (!isSafeRef(ref)) return err(refused(ref, options))
    args.push(ref)
  }
  // After the refs, and always with `--`, so a path that looks like a ref is
  // read as a path.
  if (options.path !== undefined) args.push('--', options.path)

  const result = await git(options, args)
  if (!result.ok) return result
  return ok(parseDiff(result.value, { hunks: options.hunks !== false }))
}

/**
 * The commit where this branch left the base branch.
 *
 * Everything downstream compares against this rather than against the base tip,
 * and the difference is the whole reason the function exists: `git diff develop`
 * on a branch cut a week ago shows every commit *develop* has taken since, as
 * though you had reverted them. That is the noise that makes people stop reading
 * a review.
 *
 * The `...` form of `git diff` computes this internally, but computing it here
 * means the caller can say which commit it compared against, and a UI that
 * cannot name its own baseline is not much of a review tool.
 */
export async function readMergeBase(
  options: GitOptions & { readonly base: string; readonly head?: string }
): Promise<Result<string, GitError>> {
  const head = options.head ?? 'HEAD'
  for (const ref of [options.base, head]) {
    if (!isSafeRef(ref)) return err(refused(ref, options))
  }
  const result = await git(options, ['merge-base', options.base, head])
  if (!result.ok) return result
  const sha = result.value.trim()
  if (sha === '') return err(new GitError(`no common ancestor with ${options.base}`, options.cwd))
  return ok(sha)
}

export interface BranchDiff {
  /** What the caller asked for — `origin/develop`. */
  readonly base: string
  /** What it actually resolved to, and what the diff is against. */
  readonly mergeBase: string
  readonly files: DiffFile[]
}

export interface BranchDiffOptions extends GitOptions {
  readonly base: string
  /** Passed through to `readDiff`; see `ParseDiffOptions`. */
  readonly hunks?: boolean
  /**
   * Stop at the last commit instead of running on into the working tree.
   *
   * The merge request's own answer: what has been committed on this branch, and
   * nothing a reviewer on the other end cannot see yet.
   */
  readonly committedOnly?: boolean
}

/**
 * Everything this branch has done since it left `base`.
 */
export async function readBranchDiff(
  options: BranchDiffOptions
): Promise<Result<BranchDiff, GitError>> {
  const mergeBase = await readMergeBase(options)
  if (!mergeBase.ok) return mergeBase

  const files = await readDiff({
    ...options,
    from: mergeBase.value,
    ...(options.committedOnly === true ? { to: 'HEAD' } : {}),
  })
  if (!files.ok) return files
  return ok({ base: options.base, mergeBase: mergeBase.value, files: files.value })
}

/**
 * The largest file worth handing to an editor.
 *
 * Not a guess at how big source files are — a bound on what one click can do to
 * the renderer. Monaco holds the whole text in memory and tokenises it, and a
 * generated bundle or a checked-in lockfile is tens of megabytes; the honest
 * answer for those is "too large to show", not a frozen window.
 */
export const MAX_EDITOR_BYTES = 2 * 1024 * 1024

/**
 * One side of a comparison, and why it might not be text.
 *
 * `absent` is a real answer rather than an error: a file added on this branch
 * does not exist at the merge base, and a deleted one does not exist now. An
 * editor shows that as an empty side, which is exactly right.
 */
export type FileVersion =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'binary' }
  | { readonly kind: 'tooLarge' }

/** git's way of saying the path is fine but not present at that revision. */
const ABSENT = /does not exist|exists on disk, but not in|unknown revision|no such path/i

/**
 * A file as it was at a revision.
 *
 * `git show <ref>:<path>` — one argument, which is why the ref check matters as
 * much here as anywhere: a ref beginning with a dash would make the whole thing
 * an option.
 */
export async function readFileAt(
  options: GitOptions & { readonly ref: string; readonly path: string }
): Promise<Result<FileVersion, GitError>> {
  if (!isSafeRef(options.ref)) return err(refused(options.ref, options))

  const result = await git({ ...options, maxBytes: MAX_EDITOR_BYTES }, [
    'show',
    `${options.ref}:${options.path}`,
  ])
  if (!result.ok) {
    if (ABSENT.test(result.error.message)) return ok({ kind: 'absent' })
    // `execFile` reports the cap as `maxBuffer length exceeded`, which is the
    // only way we learn the size without reading it.
    if (/maxBuffer/i.test(result.error.message)) return ok({ kind: 'tooLarge' })
    return result
  }
  return ok(asVersion(result.value))
}

/** A NUL byte is git's own test for binary, and the only one that is cheap. */
export function asVersion(text: string): FileVersion {
  if (text.includes('\0')) return { kind: 'binary' }
  if (text.length > MAX_EDITOR_BYTES) return { kind: 'tooLarge' }
  return { kind: 'text', text }
}

export interface BranchRef {
  /** `develop`, or `origin/develop` for a remote-tracking branch. */
  readonly name: string
  readonly remote: boolean
  /** The branch currently checked out. */
  readonly head: boolean
}

/**
 * The branches a base picker can offer.
 *
 * Sorted by most recent commit, because the branch someone wants to compare
 * against is nearly always one that is alive.
 */
export async function readBranches(options: GitOptions): Promise<Result<BranchRef[], GitError>> {
  const result = await git(options, [
    'for-each-ref',
    '--format=%(HEAD)%00%(refname)%00%(refname:short)',
    '--sort=-committerdate',
    'refs/heads',
    'refs/remotes',
  ])
  if (!result.ok) return result

  const branches: BranchRef[] = []
  for (const line of result.value.split('\n')) {
    if (line === '') continue
    const [marker, refname, short] = line.split('\0')
    if (refname === undefined || short === undefined) continue
    // `refs/remotes/origin/HEAD` is a symbolic pointer at the remote's default
    // branch, not a branch of its own. Offering it lists the same branch twice
    // under two names.
    if (refname.endsWith('/HEAD')) continue
    branches.push({
      name: short,
      remote: refname.startsWith('refs/remotes/'),
      head: marker === '*',
    })
  }
  return ok(branches)
}

/**
 * Move remote-tracking refs so a base branch is current.
 *
 * The one command here that talks to the network, and the one that is not
 * strictly read-only — it writes refs, never the working tree, and never the
 * index. It runs when a person asks and never on a timer: a background fetch
 * against someone else's repository, on someone else's connection, is a
 * surprise, and a surprise that can prompt for a passphrase.
 */
export async function fetchRef(
  options: GitOptions & { readonly remote: string; readonly ref?: string }
): Promise<Result<void, GitError>> {
  for (const ref of [options.remote, options.ref]) {
    if (ref !== undefined && !isSafeRef(ref)) return err(refused(ref, options))
  }
  const args = ['fetch', '--quiet', '--no-tags', options.remote]
  if (options.ref !== undefined) args.push(options.ref)

  // The network deserves longer than a local read, and still a bound: a hung
  // fetch behind a VPN prompt must not wedge the panel.
  const result = await git({ ...options, timeoutMs: options.timeoutMs ?? 60_000 }, args)
  if (!result.ok) return result
  return ok(undefined)
}

/**
 * Everything an agent has changed, staged or not, as one diff.
 *
 * This is what the review view shows by default: after a turn, the question is
 * "what did it do", and splitting that across staged and unstaged makes the
 * reader reassemble it themselves.
 */
export async function readWorkingDiff(
  options: GitOptions & { readonly hunks?: boolean }
): Promise<Result<DiffFile[], GitError>> {
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

export interface WorkspaceReadOptions extends GitOptions {
  /**
   * Compare against this branch instead of showing uncommitted work.
   *
   * Absent is the old behaviour and stays the default: the working tree, which
   * is what "what did the agent just do" means.
   */
  readonly base?: string
  readonly committedOnly?: boolean
  /**
   * Build line-by-line hunks, or only the per-file summary.
   *
   * The Changes panel asks for `false` while it is showing Monaco, which reads
   * whole files through `workspace:fileVersions` and never touches a hunk.
   */
  readonly hunks?: boolean
}

export interface WorkspaceRead {
  readonly status: WorkspaceStatus
  readonly diff: DiffFile[]
  readonly problem: string | null
  /**
   * Which baseline the diff is against, or null for the working tree.
   *
   * Null also when a base was asked for and could not be resolved — the diff is
   * then empty and `problem` says why, rather than quietly falling back to the
   * working tree. A review labelled "vs develop" that is silently showing
   * something else is worse than one that shows nothing.
   */
  readonly comparison: { readonly base: string; readonly mergeBase: string } | null
}

/** Whichever diff was asked for, in one shape, so the caller has no union. */
async function readComparison(
  options: WorkspaceReadOptions
): Promise<Result<Pick<WorkspaceRead, 'diff' | 'comparison'>, GitError>> {
  const base = options.base
  if (base === undefined) {
    const working = await readWorkingDiff(options)
    return working.ok ? ok({ diff: working.value, comparison: null }) : working
  }

  const branch = await readBranchDiff({ ...options, base })
  if (!branch.ok) return branch
  return ok({
    diff: branch.value.files,
    comparison: { base: branch.value.base, mergeBase: branch.value.mergeBase },
  })
}

export async function readWorkspace(options: WorkspaceReadOptions): Promise<WorkspaceRead> {
  if (!(await isRepository(options))) {
    // Not every project is a git repo, and that is not an error — it just means
    // there is nothing to review.
    return { status: EMPTY_STATUS, diff: [], problem: null, comparison: null }
  }

  const [status, compared] = await Promise.all([readStatus(options), readComparison(options)])

  return {
    status: status.ok ? status.value : EMPTY_STATUS,
    diff: compared.ok ? compared.value.diff : [],
    problem: status.ok ? (compared.ok ? null : compared.error.message) : status.error.message,
    comparison: compared.ok ? compared.value.comparison : null,
  }
}
