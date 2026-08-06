import { isAbsolute, resolve } from 'node:path'
import type { Brand } from '@chorus/shared'
import { isWithin, safeRealpath } from './path-safety.js'

/**
 * Deciding whether an editor belongs to a conversation's project (plan §3).
 *
 * This is the security boundary for the VS Code bridge: everything the
 * extension reports is re-checked here before any of it reaches the renderer.
 * The rules are `path-safety.ts`'s, reused rather than restated — a second
 * implementation of "is this path inside that one" is a second place for the
 * sibling-prefix and symlink bugs to reappear.
 */

/**
 * A root that has already been resolved through symlinks.
 *
 * Branded on purpose. `resolveWithinRoot` realpaths its root on every call,
 * which is right for its one-shot callers and wrong for a 200ms-debounced
 * stream across several windows and roots — that would put a `realpathSync` on
 * the Electron main thread for every keystroke-sized selection change. The
 * brand makes it impossible to pass a raw string where a canonical root is
 * required, so the resolution cannot silently move back into the hot path.
 */
export type CanonicalRoot = Brand<string, 'CanonicalRoot'>

/**
 * Resolve a project root once, when the set of open conversations changes.
 *
 * `/tmp` vs `/private/tmp` on macOS, and symlinked checkouts generally, are why
 * this exists: a VS Code workspace folder and a Chorus `cwd` can name the same
 * directory with different strings and must still match.
 */
export function canonicalRoot(root: string): CanonicalRoot {
  return safeRealpath(resolve(root)) as CanonicalRoot
}

/**
 * Whether a VS Code workspace folder is the conversation's project root.
 *
 * Equality, not containment (plan §3): opening `/code` does not match a
 * conversation at `/code/project`, and opening `/code/project/src` does not
 * either. The project root itself has to be the folder that is open, because a
 * parent would silently widen the scope of everything the bridge reports.
 */
export function isProjectRoot(root: CanonicalRoot, workspaceFolder: string): boolean {
  return canonicalRoot(workspaceFolder) === root
}

/**
 * Whether an active file belongs inside an already-canonical root.
 *
 * The candidate is resolved every time, because it is the part that moves and
 * the part an attacker would control — a symlink inside the project pointing at
 * `/etc` passes a naive prefix check. The root is not resolved again; it was
 * canonicalized when the conversation list last changed.
 */
export function isFileInProject(root: CanonicalRoot, filePath: string): boolean {
  if (filePath === '' || !isAbsolute(filePath)) return false
  return isWithin(root, safeRealpath(resolve(filePath)))
}

/**
 * The path an agent is given, relative to the project it is running in.
 *
 * Returns `null` rather than a `../` escape when the file is outside the root,
 * so a caller cannot accidentally hand an agent a reference that points out of
 * its own working directory. Callers are expected to have checked
 * `isFileInProject` first; this is the second half of the same guarantee.
 */
export function projectRelativePath(root: CanonicalRoot, filePath: string): string | null {
  if (!isFileInProject(root, filePath)) return null
  const real = safeRealpath(resolve(filePath))
  if (real === root) return null
  // `isWithin` has already established the separator boundary, so this slice
  // cannot cut a path segment in half.
  return real.slice(root.length + 1)
}

/**
 * Choose the window that serves a conversation (plan §3).
 *
 * `null` means ambiguous: several eligible windows and nothing to separate
 * them. Arrival order is deliberately not a tiebreak — whichever extension
 * happened to connect first says nothing about which editor the user is
 * looking at, and guessing produces context from the wrong window.
 */
export function chooseWindow<
  T extends { readonly focused: boolean; readonly lastFocusedAt: number },
>(eligible: readonly T[]): T | null {
  if (eligible.length === 0) return null
  if (eligible.length === 1) return eligible[0] ?? null

  const focused = eligible.filter((w) => w.focused)
  if (focused.length === 1) return focused[0] ?? null

  // Focus has moved to Chorus, so no window is focused: fall back to the one
  // the user was in most recently.
  const seen = eligible.filter((w) => w.lastFocusedAt > 0)
  if (seen.length === 0) return null

  let best = seen[0]
  if (best === undefined) return null
  let tied = false
  for (const candidate of seen.slice(1)) {
    if (candidate.lastFocusedAt > best.lastFocusedAt) {
      best = candidate
      tied = false
    } else if (candidate.lastFocusedAt === best.lastFocusedAt) {
      tied = true
    }
  }
  return tied ? null : best
}
