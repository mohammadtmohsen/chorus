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

export async function completeFiles(cwd: string, query: string): Promise<string[]> {
  const all = await tracked(cwd)
  if (all.length === 0) return []

  const needle = query.toLowerCase()
  if (needle === '') return all.slice(0, LIMIT)

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
  return [...byName, ...byPath].slice(0, LIMIT)
}

/**
 * Everything git considers part of the project, tracked or not yet.
 *
 * `--others --exclude-standard` is what includes a file you have just created
 * and have not committed — the one you are most likely to be talking about —
 * while still honouring every ignore rule.
 */
async function tracked(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await run(
      'git',
      ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    )
    return stdout.split('\n').filter((line) => line !== '')
  } catch {
    // Not a repository, no git, or a repository too large to list in time. All
    // three mean the same thing to the caller: nothing to offer.
    return []
  }
}
