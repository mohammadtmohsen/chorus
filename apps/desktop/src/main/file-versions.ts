import { readFile } from 'node:fs/promises'
import { digestOf } from './file-write.js'
import {
  asVersion,
  MAX_EDITOR_BYTES,
  readFileAt,
  readMergeBase,
  resolveWithinRoot,
  type FileVersion,
} from '@chorus/workspace'

/**
 * The two sides of one file, for an editor that wants whole files.
 *
 * The diff the panel already has is *hunks* — enough to draw a change, not
 * enough to scroll through the file around it. Monaco takes two complete texts
 * and computes its own alignment, which is what buys folding, a minimap, and
 * context beyond three lines.
 *
 * So this answers "what did this file look like at the baseline, and what does
 * it look like now", and the second half is deliberately read **from disk**
 * rather than from git: uncommitted work is the common case, and the index is
 * not what the person is looking at in their editor.
 */

export interface FileVersions {
  readonly original: FileVersion
  readonly modified: FileVersion
  /**
   * The working-tree digest this read saw, echoed back on save.
   *
   * Null whenever the modified side did not come from disk — absent, binary,
   * too large, or a `committedOnly` comparison. None of those is writable, so
   * there is nothing for a save to conflict with.
   */
  readonly sha: string | null
  readonly problem: string | null
}

const failed = (problem: string): FileVersions => ({
  original: { kind: 'absent' },
  modified: { kind: 'absent' },
  sha: null,
  problem,
})

/**
 * Read the working tree copy, through the containment primitive.
 *
 * `resolveWithinRoot` is documented as the only supported way to turn a
 * supplied path into a real one, and this is a read — but the path arrives from
 * the renderer, so a `../../.ssh/id_rsa` has to be refused here rather than
 * trusted because it came from our own UI.
 */
async function readWorktree(cwd: string, path: string): Promise<FileVersion> {
  const resolved = resolveWithinRoot(cwd, path)
  if (!resolved.ok) return { kind: 'absent' }
  try {
    const bytes = await readFile(resolved.value)
    if (bytes.byteLength > MAX_EDITOR_BYTES) return { kind: 'tooLarge' }
    return asVersion(bytes.toString('utf8'))
  } catch {
    // Deleted on this branch, or never existed. Both draw as an empty side.
    return { kind: 'absent' }
  }
}

export async function readFileVersions(options: {
  readonly cwd: string
  readonly path: string
  readonly base?: string | undefined
  readonly committedOnly?: boolean | undefined
}): Promise<FileVersions> {
  const { cwd, path, base } = options

  /*
   * Against the merge base, not the base tip — the same rule the file list
   * follows, and it has to be the same or the editor would disagree with the
   * list that opened it.
   */
  let originalRef = 'HEAD'
  if (base !== undefined) {
    const mergeBase = await readMergeBase({ cwd, base })
    if (!mergeBase.ok) return failed(mergeBase.error.message)
    originalRef = mergeBase.value
  }

  const [original, modified] = await Promise.all([
    readFileAt({ cwd, ref: originalRef, path }),
    options.committedOnly === true
      ? readFileAt({ cwd, ref: 'HEAD', path })
      : Promise.resolve({ ok: true as const, value: await readWorktree(cwd, path) }),
  ])

  if (!original.ok) return failed(original.error.message)
  if (!modified.ok) return failed(modified.error.message)

  /*
   * Only a working-tree read produces a digest.
   *
   * A `committedOnly` comparison shows two commits, and neither is a thing a
   * save could conflict with — handing back a digest there would let the panel
   * offer to overwrite a file it is not looking at.
   */
  const fromDisk = options.committedOnly !== true
  return {
    original: original.value,
    modified: modified.value,
    sha: fromDisk && modified.value.kind === 'text' ? digestOf(modified.value.text) : null,
    problem: null,
  }
}
