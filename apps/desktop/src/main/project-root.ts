import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export interface WorkbenchPlace {
  readonly host: string
  readonly root: string
}

/**
 * What the person picked, canonicalised — and this is now the *only* place a
 * string becomes a project root.
 *
 * It used to be handed the renderer's own string, which is where the defect
 * lived: canonicalisation makes a path well-formed, not permitted, so "absolute,
 * exists, is a directory" admitted every directory on the disk to anything that
 * could reach the channel. The caller here is main's own chooser, so the question
 * this answers is no longer "may the renderer open this?" but "which tree did the
 * person actually pick?" — and that still has to be settled, because in step 2
 * the answer becomes the REH's `--folder`, i.e. the root a server process is
 * pointed at:
 *
 *  - **Absolute.** A relative path is resolved against *main's* current working
 *    directory, which is whatever launched the app — Finder gives `/`. The root
 *    would then be a directory nobody named.
 *  - **Canonical.** `realpathSync` resolves every symlink, every `..` and the
 *    trailing slash. Without it a symlink is a second name for a tree, so the
 *    same project can be opened twice under two spellings — and a later
 *    per-project refcount, cache key or storage path keyed on the string would
 *    count them as two, which is the shared-REH lease of §5.4 pointed at the
 *    wrong number.
 *  - **A directory that exists.** `realpathSync` already refuses a path that
 *    does not, and the `stat` refuses a file. A surface rooted at a file would
 *    fail later, further in, in the workbench's own startup.
 *
 * What bounds *which* directories are openable is not here and cannot be: it is
 * the chooser above it, one dialog per root, and the grant that dialog mints. A
 * further product rule — a durable set of projects the person has adopted — is
 * ProjectService's, which is why the second arm of `WorkbenchTarget` exists.
 */
export function approveProjectRoot(proposed: string): string {
  if (!isAbsolute(proposed)) {
    throw new Error(`A workbench project root must be an absolute path: ${proposed}`)
  }

  let canonical: string
  try {
    canonical = realpathSync(proposed)
  } catch {
    // Deliberately not the OS error: it distinguishes "no such directory" from
    // "no permission to look", which answers a question the renderer did not
    // earn the right to ask.
    throw new Error(`No such workbench project root: ${proposed}`)
  }

  if (!statSync(canonical).isDirectory()) {
    throw new Error(`A workbench project root must be a directory: ${proposed}`)
  }
  return canonical
}
