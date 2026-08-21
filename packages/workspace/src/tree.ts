import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { err, ok, type Result } from '@chorus/shared'
import { GitError, type GitOptions } from './git.js'
import { resolveWithinRoot } from './path-safety.js'

const run = promisify(execFile)

/**
 * Walking the project, one directory at a time.
 *
 * **Lazy on purpose.** A recursive listing of a repository with `node_modules`
 * is hundreds of thousands of entries, and every one of them would cross IPC to
 * draw a tree the user has collapsed. One directory per call means the cost is
 * what was actually expanded.
 *
 * **`.gitignore` is honoured by asking git.** `check-ignore` reads the whole
 * chain — the repository's `.gitignore`, nested ones, `.git/info/exclude`, and
 * the user's global excludes — and reimplementing that means reimplementing its
 * precedence rules and its negation syntax. This is the same instinct as the
 * rest of the package: git already knows, so ask it.
 */

export interface TreeEntry {
  readonly name: string
  /** Repo-relative, forward slashes, so it matches what the diff calls a path. */
  readonly path: string
  readonly directory: boolean
}

/**
 * Which entries git considers ignored.
 *
 * One call for the whole directory rather than one per entry. `-z` on both
 * sides because a filename may contain a newline, which is the separator the
 * default format uses to mean "next path".
 *
 * `check-ignore` **exits 1 when nothing matched**, which `execFile` reports as
 * a failure. That is the ordinary case for a source directory, so it is read as
 * an empty set rather than an error — the mistake here would be to treat a
 * clean directory as a broken one and show nothing.
 */
async function ignoredIn(cwd: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  try {
    const running = run('git', ['check-ignore', '--stdin', '-z'], {
      cwd,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    /*
     * Written to the child's stdin, because `execFile` has no `input` option —
     * that belongs to `execFileSync`, and passing it here is silently ignored.
     * The first version did exactly that behind a type cast, and every call hung
     * until its timeout: git was waiting on a stdin nobody was going to close.
     *
     * `promisify` exposes the child on the promise for this case. The trailing
     * NUL terminates the last path like the others.
     */
    running.child.stdin?.end(`${paths.join('\0')}\0`)
    const { stdout } = await running
    return new Set(stdout.split('\0').filter((line) => line !== ''))
  } catch {
    // Exit 1 (nothing ignored) and a genuine failure are indistinguishable
    // here, and both mean the same thing for the caller: show everything. A
    // repository without a `.gitignore` must not render as an empty tree.
    return new Set()
  }
}

/**
 * One directory's entries, ignoring what git ignores.
 *
 * `path` is repo-relative; `''` is the root. Every path is resolved through
 * `resolveWithinRoot`, so a `..` segment or a symlink pointing outside the
 * project is refused here rather than read and then filtered.
 */
export async function readDirectory(
  options: GitOptions & { readonly path: string }
): Promise<Result<TreeEntry[], GitError>> {
  const resolved = resolveWithinRoot(options.cwd, options.path === '' ? '.' : options.path)
  if (!resolved.ok) {
    return err(new GitError(`refusing to read outside the project: ${options.path}`, options.cwd))
  }

  let dirents
  try {
    dirents = await readdir(resolved.value, { withFileTypes: true })
  } catch (error) {
    return err(new GitError(error instanceof Error ? error.message : String(error), options.cwd))
  }

  const prefix = options.path === '' || options.path === '.' ? '' : `${options.path}/`
  const entries: TreeEntry[] = dirents
    // `.git` is never interesting and is enormous. It is also not ignored by
    // `.gitignore` — git excludes it structurally — so nothing below would
    // drop it.
    .filter((entry) => entry.name !== '.git')
    .map((entry) => ({
      name: entry.name,
      path: `${prefix}${entry.name}`,
      /*
       * A symlink to a directory counts as one, so it can be expanded — and
       * the expansion is where `resolveWithinRoot` refuses it if it leaves the
       * project. Refusing at the listing would hide a link to a sibling
       * directory *inside* the repository, which is legitimate.
       */
      directory: entry.isDirectory() || entry.isSymbolicLink(),
    }))

  const ignored = await ignoredIn(
    options.cwd,
    entries.map((entry) => entry.path)
  )

  return ok(
    entries
      .filter((entry) => !ignored.has(entry.path))
      // Directories first, then by name: the shape people expect from every
      // file tree, and the one that makes a deep project scannable.
      .sort((left, right) => {
        if (left.directory !== right.directory) return left.directory ? -1 : 1
        return left.name.localeCompare(right.name)
      })
  )
}
