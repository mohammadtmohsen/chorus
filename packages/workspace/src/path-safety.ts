import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { hasRoot, isInside, relativeInside } from '@chorus/ide-protocol'
import { err, ok, type Result } from '@chorus/shared'

/**
 * Containment is defined once, in `@chorus/ide-protocol`, and re-exported here
 * under the names main has always used.
 *
 * It lived in two places and they had already drifted: this file used
 * `path.sep`, the VS Code extension's `isInside` hardcoded `/`, and both
 * comments claimed the two had to agree. On Windows they did not — the
 * extension called every file outside its own project and returned before main
 * ever got to re-check. Moving the rule into the package both ends already
 * import is what makes "they agree" a fact rather than a request.
 *
 * `ide-protocol` rather than here, because the extension cannot import this
 * package: `safeRealpath` below needs `node:fs`, and the extension bundles for
 * a VS Code host.
 */
export { hasRoot, isInside as isWithin, relativeInside as relativeWithin }

export class PathEscapeError extends Error {
  constructor(
    readonly candidate: string,
    readonly root: string
  ) {
    super(`Path "${candidate}" resolves outside the project root "${root}"`)
    this.name = 'PathEscapeError'
  }
}

/**
 * The ONLY supported way to turn an agent- or user-supplied path into a real
 * one (plan §4.4). Every other layer calls this; nothing else calls `resolve`
 * on untrusted input.
 *
 * Resolves symlinks, because `root/link -> /etc` passes a naive prefix check.
 * Falls back to the lexical path when the target does not exist yet, which is
 * the normal case for a file the agent is about to create.
 */
export function resolveWithinRoot(
  root: string,
  candidate: string
): Result<string, PathEscapeError> {
  const realRoot = safeRealpath(resolve(root))

  /*
   * An absolute candidate is resolved as-is; a relative one is joined to root.
   * `resolve` already collapses `..`, so traversal is normalized before checking.
   *
   * `hasRoot` rather than `isAbsolute`, because on Windows two shapes make
   * "absolute" the wrong question and both are now resolved against the root:
   *
   * - `\etc\passwd` is `isAbsolute`-true but names no drive, so `resolve()`
   *   binds it to whichever drive this process is on. With a root on `D:` that
   *   turns a legitimate `\src\index.ts` into `C:\src\index.ts`.
   * - `C:secrets` is `isAbsolute`-**false** — drive-relative — so the naive
   *   branch called it relative to the root, and `resolve()` sent it to
   *   `C:\<process cwd>\secrets`, escaping entirely.
   *
   * `isWithin` rejected both already, so this is a correctness fix rather than
   * a hole being closed. The point is that the branch now means what it says.
   */
  const resolved = hasRoot(candidate) ? resolve(candidate) : resolve(realRoot, candidate)
  const real = safeRealpath(resolved)

  if (!isInside(realRoot, real)) return err(new PathEscapeError(candidate, root))
  return ok(real)
}

/**
 * Resolve symlinks as far as the path exists. For a not-yet-created file we
 * still resolve the deepest existing ancestor, so a symlinked parent directory
 * cannot be used to escape.
 */
export function safeRealpath(p: string): string {
  let current = p
  const trailing: string[] = []

  for (;;) {
    try {
      const real = realpathSync(current)
      return trailing.length > 0 ? resolve(real, ...trailing.reverse()) : real
    } catch {
      const parent = resolve(current, '..')
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return p
      /*
       * The segment below `parent`, through the one helper that knows a root
       * carries its own separator. This was `slice(parent.length + 1)`, which
       * ate a character whenever `parent` was a filesystem root: a nonexistent
       * `\\server\share\proj\x` walked up to `\\server\share\` and came back
       * with `roj`. UNC makes that the common case rather than the exotic one,
       * since every project on a share sits directly beneath it.
       */
      const segment = relativeInside(parent, current)
      if (segment === null || segment === '') return p
      trailing.push(segment)
      current = parent
    }
  }
}
