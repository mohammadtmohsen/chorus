import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Finding a file in the project, for the composer's `@` menu.
 *
 * The SDK expects the *host* to answer this. There is a `file_suggestions`
 * control request on the wire, documented as returning "the same fuzzy-matched
 * results the TUI shows", and `Query` exposes no method for it — so the CLI's own
 * matcher is unreachable and this is ours to build.
 *
 * Asked of git rather than walked, which is the whole trick. `git ls-files`
 * already knows what belongs to the project and what does not: no `node_modules`
 * to skip, no `.gitignore` to reimplement, no `dist` to filter, and it is fast
 * enough on a large repository to run on a keystroke. The cost is honest and
 * stated — a directory that is not a repository offers no completion rather than
 * a slow walk that eventually offers the wrong things.
 */

/** Enough to choose from; more is a list nobody reads to the end of. */
const LIMIT = 20

/** Long enough that a large repository does not hang the menu. */
const TIMEOUT_MS = 4_000

/**
 * Why the menu has nothing, which is three different things and used to be one.
 *
 * Every failure here — a timeout, a missing git, a spawn that could not fork, a
 * directory that is no repository — returned `[]`, and the menu renders `[]` as
 * "nothing matches". So a question that could not be *asked* looked exactly like
 * one that had been answered, and nothing ever asked again (C-003).
 *
 * The distinction the caller needs is not "did it work" but **"is it worth
 * asking again"**:
 *
 * - `ready` — git answered. An empty list here is a real answer, not a failure.
 * - `retryable` — the question could not be put this time. Under a loaded
 *   machine that is the timeout and the spawn refusals, and both pass.
 * - `unavailable` — it can never be answered in this directory. Asking again is
 *   a promise that cannot come true, and it would spawn a process each time to
 *   learn the same thing.
 */
export type Completion =
  | { readonly state: 'ready'; readonly files: string[] }
  | { readonly state: 'retryable'; readonly files: [] }
  | { readonly state: 'unavailable'; readonly files: [] }

export async function completeFiles(cwd: string, query: string): Promise<Completion> {
  const listing = await tracked(cwd)
  if (listing.state !== 'ready') return listing
  const all = listing.files
  if (all.length === 0) return { state: 'ready', files: [] }

  const needle = query.toLowerCase()
  if (needle === '') return { state: 'ready', files: all.slice(0, LIMIT) }

  /*
   * Ranked by where the match landed, not merely whether it did.
   *
   * Typing "button" almost always means a file called button-something, not the
   * twelfth file inside `src/buttons/`. A basename match is what was meant; a
   * path match is a fallback worth offering after it.
   */
  const byName: string[] = []
  const byPath: string[] = []
  for (const path of all) {
    const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
    if (base.includes(needle)) byName.push(path)
    else if (path.toLowerCase().includes(needle)) byPath.push(path)
    if (byName.length >= LIMIT) break
  }
  return { state: 'ready', files: [...byName, ...byPath].slice(0, LIMIT) }
}

/**
 * Everything git considers part of the project, tracked or not yet.
 *
 * `--others --exclude-standard` is what includes a file you have just created
 * and have not committed — the one you are most likely to be talking about —
 * while still honouring every ignore rule.
 */
async function tracked(cwd: string): Promise<Completion> {
  try {
    const { stdout } = await run(
      'git',
      ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    )
    return { state: 'ready', files: stdout.split('\n').filter((line) => line !== '') }
  } catch (error) {
    return { state: askAgain(error) ? 'retryable' : 'unavailable', files: [] }
  }
}

/**
 * Whether the same question, put again, could get a different answer.
 *
 * The two kinds of `code` are the whole trick, and Node overloads the field:
 * when the process **ran** and exited non-zero it is the exit status, a number;
 * when the spawn itself **failed** it is an errno, a string. So a string `code`
 * is about starting git and a number is about what git said.
 *
 * What that buys, in the order it is checked:
 *
 * - **Killed** is the timeout. Under the load that makes this fail at all, four
 *   seconds is a machine that is busy rather than a repository that is enormous.
 * - **`EAGAIN`, `ENOMEM`, `EMFILE`, `ENFILE`** are a machine that could not fork
 *   right now — exactly the condition a suite of Electron launches creates, and
 *   exactly the one worth asking about again a moment later.
 * - **Any other string** is `ENOENT` (no git on this machine) or the output
 *   overrunning `maxBuffer`. Neither changes by asking twice.
 * - **Git objecting to the place** is permanent. Both its wordings were read off
 *   the binary rather than guessed: `not a git repository` for a directory that
 *   is not a project, and `cannot change to` for one that is not there at all.
 * - **Anything else git said** is retried, deliberately, and the case that earns
 *   it is real: `Unable to create '.git/index.lock': File exists` is what
 *   concurrent git processes produce under exactly the load this bug appears
 *   under, and it clears on its own. Being wrong this way costs a handful of
 *   bounded asks; being wrong the other way turns a transient into a menu that
 *   is empty until the app restarts, which is this bug.
 */
const FORK_AGAIN = new Set(['EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE'])
const NO_SUCH_PROJECT = /not a git repository|cannot change to/i

export function askAgain(error: unknown): boolean {
  // A rejection carrying nothing readable is still a question that was not
  // answered, and reading a field off it must not throw inside a `catch`.
  if (typeof error !== 'object' || error === null) return true
  const failure = error as { code?: unknown; killed?: unknown; stderr?: unknown }
  if (failure.killed === true) return true
  if (typeof failure.code === 'string') return FORK_AGAIN.has(failure.code)
  return !NO_SUCH_PROJECT.test(typeof failure.stderr === 'string' ? failure.stderr : '')
}
