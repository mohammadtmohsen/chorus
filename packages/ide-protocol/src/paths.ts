import { posix, win32 } from 'node:path'

/**
 * Path containment, on segments — the rule both ends of the bridge must agree
 * on, in the one package both ends already import.
 *
 * It used to live twice: `isWithin` in `@chorus/workspace` for Electron main,
 * and `isInside` in the extension's `editor-context.ts`. Their own comments said
 * they had to agree, and they did not — main used `path.sep` and the extension
 * hardcoded `/`, so on Windows main said a file was inside its project and the
 * extension said it was outside. The extension checks first, so every file in
 * every project reported `unmatched` and nothing ever reached main's copy to be
 * re-checked.
 *
 * That is why this is here rather than in `@chorus/workspace`: the extension
 * cannot import that package, because it pulls in `node:fs` and the extension
 * bundles for a VS Code host. `ide-protocol` is what they share, and "we agree
 * about what is inside the project" is as much a part of the protocol as the
 * frame format is.
 *
 * The two checks still differ in *authority*, and that has not changed: the
 * extension's is a disclosure guard, main's is a security boundary against a
 * client it cannot trust. Sharing the rule does not make main trust the answer.
 */

/** `path` for the platform being reasoned about, which in tests is not this one. */
function ops(platform: NodeJS.Platform): typeof win32 {
  return platform === 'win32' ? win32 : posix
}

/**
 * Ordinal on POSIX, where two casings are two files.
 *
 * On Windows, both case and separator are folded. NTFS is case-insensitive, and
 * the two sides canonicalize with different code that disagrees about the drive
 * letter — `Uri.fsPath` lowercases it, `realpathSync` returns the volume's own
 * casing — so an ordinal comparison fails on exactly the machines where the
 * extension's `realpathSync` fallback fires. Separators fold for the same
 * reason: Windows accepts both and VS Code emits `/` in places.
 */
function normalize(p: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p
}

/**
 * Whether `target` is `root` or sits beneath it.
 *
 * Segment-wise: `/a/project-old` is **not** inside `/a/project`. That sibling
 * prefix is the bug this function exists to prevent, and the reason it is not
 * a bare `startsWith`.
 */
export function isInside(
  root: string,
  target: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const a = normalize(root, platform)
  const b = normalize(target, platform)
  if (b === a) return true
  const sep = ops(platform).sep
  return b.startsWith(a.endsWith(sep) ? a : a + sep)
}

/**
 * The part of `target` below `root`, or null when it is not below it.
 *
 * The separator arithmetic lives here and nowhere else.
 * `target.slice(root.length + 1)` is right only when the root does not already
 * end in a separator — and every filesystem root does. `C:\`, `\\server\share\`
 * and `/` all arrive from `resolve()` with the separator attached, so a project
 * sitting at a drive or share root sliced one character too many and reported
 * `ile.ts` for `file.ts`. That string goes into an agent mention verbatim.
 *
 * Slices the original `target`, not the folded copy, so the caller gets back
 * the casing the filesystem reported.
 */
export function relativeInside(
  root: string,
  target: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (!isInside(root, target, platform)) return null
  const sep = ops(platform).sep
  return target.slice(root.endsWith(sep) ? root.length : root.length + 1)
}

/**
 * Absolute *and* anchored — locatable without borrowing anything from context.
 *
 * `isAbsolute` alone answers a different question on Windows: true for `\etc`
 * (rooted, but on no particular drive) and false for `C:etc` (a drive with no
 * root). Resolving either borrows the current process's working directory,
 * which is never the right source when the caller supplied a root.
 */
export function hasRoot(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!ops(platform).isAbsolute(candidate)) return false
  if (platform !== 'win32') return true
  if (/^[\\/]{2}/.test(candidate)) return true
  return /^[a-zA-Z]:[\\/]/.test(candidate)
}
