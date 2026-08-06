import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { err, ok, type Result } from '@chorus/shared'

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

  // An absolute candidate is resolved as-is; a relative one is joined to root.
  // `resolve` already collapses `..`, so traversal is normalized before checking.
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(realRoot, candidate)
  const real = safeRealpath(resolved)

  if (!isWithin(realRoot, real)) return err(new PathEscapeError(candidate, root))
  return ok(real)
}

/**
 * Prefix check on path segments — "/a/bc" must not count as inside "/a/b".
 *
 * Exported for `project-match.ts`, which needs the same rule against a root it
 * has already canonicalized. Duplicating it there would be one more place for
 * the sibling-prefix bug to come back.
 */
export function isWithin(root: string, target: string): boolean {
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : root + sep)
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
      trailing.push(current.slice(parent.length + 1))
      current = parent
    }
  }
}
