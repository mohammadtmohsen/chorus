import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * A path with every symlink resolved — including for a file that is not there.
 *
 * `isInside` compares lexically, segment by segment, and neither side is
 * canonicalized. That is correct for the extension, which cannot touch the
 * filesystem, and it is why the same file spelled two ways reads as two files:
 * a project opened as `/var/folders/…` against a path an agent printed as
 * `/private/var/folders/…` is one directory and its realpath, and `ide:openFile`
 * refused it. Measured in the running app before this existed.
 *
 * `realpathSync` alone cannot do the job because it throws on anything that does
 * not exist, and opening a file that does not exist yet is a case the guard
 * deliberately allows — VS Code creates it. So this resolves the deepest
 * ancestor that *does* exist and re-attaches the rest, which is the part that
 * cannot contain a symlink precisely because it is not on disk.
 *
 * Falls back to the lexically resolved path rather than throwing. A caller
 * deciding containment must always get an answer; returning the uncanonicalized
 * form leaves it exactly as strict as it was before this function existed.
 */
export function canonicalPath(input: string): string {
  const absolute = resolve(input)
  const missing: string[] = []
  let head = absolute

  for (;;) {
    try {
      // `join` with no tail returns the head unchanged, which is the common case
      // of a path that exists.
      return join(realpathSync(head), ...missing)
    } catch {
      const parent = dirname(head)
      // The filesystem root resolved to nothing: there is no ancestor left to
      // ask about, so the lexical answer is the only one available.
      if (parent === head) return absolute
      missing.unshift(basename(head))
      head = parent
    }
  }
}
