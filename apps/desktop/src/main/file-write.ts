import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveWithinRoot } from '@chorus/workspace'

/**
 * Saving a file the person edited in Chorus.
 *
 * The first and only path by which this app writes into a project tree.
 * Everything else that mutates a project is an agent running its own CLI
 * behind the approval gate; this is the user's own hand, and it is gated by
 * containment rather than by permission — see the channel's own comment.
 *
 * Temp-file-plus-rename, like `settings.ts`: a crash between the truncate and
 * the write of a plain `writeFile` leaves the file empty, and an empty source
 * file is worse than an unsaved edit. `rename` within a directory is atomic on
 * every filesystem this ships to.
 */

export interface WriteResult {
  readonly outcome: 'written' | 'conflict' | 'failed'
  readonly problem: string | null
  readonly added: number
  readonly removed: number
  /**
   * The digest of what was just written, so the next save can chain off it.
   *
   * **Autosave cannot work without this.** The conflict check compares the
   * digest the editor loaded against what is on disk, so the *second* write of
   * a typing session would be refused as stale — the editor's `sha` still
   * describes the version it opened, which its own first save replaced. One
   * manual `⌘S` never noticed, because there was rarely a second one.
   *
   * Handing it back rather than re-reading closes the race the other way round:
   * the watcher's re-read is asynchronous, so a fast typist can produce the
   * next save before it lands.
   *
   * Null on anything but a successful write — there is nothing on disk this
   * editor can claim to have seen.
   */
  readonly sha: string | null
}

const failed = (problem: string): WriteResult => ({
  outcome: 'failed',
  problem,
  added: 0,
  removed: 0,
  sha: null,
})

/**
 * A digest of a file's bytes, or null when there is no file.
 *
 * The editor echoes this back on save, and a mismatch means the file moved
 * while it was open. Content rather than mtime: a checkout can restore an
 * identical file with a new timestamp, and refusing that save would be a
 * conflict the user cannot make sense of.
 */
export function digestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * How much moved, for the log line the other agent reads.
 *
 * A line count rather than a diff, and never the content: the event carries
 * "this file changed under you, read it again", and a file body in the log is
 * C-021's unsolved half with the volume turned up.
 *
 * Deliberately cheap and approximate — it is a magnitude in a sentence, not a
 * patch. Counting common prefix and suffix lines is enough to say "two lines"
 * rather than "the whole file" when someone fixes a typo.
 */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const from = before.split('\n')
  const to = after.split('\n')

  let head = 0
  while (head < from.length && head < to.length && from[head] === to[head]) head++

  let tail = 0
  while (
    tail < from.length - head &&
    tail < to.length - head &&
    from[from.length - 1 - tail] === to[to.length - 1 - tail]
  ) {
    tail++
  }

  return { removed: from.length - head - tail, added: to.length - head - tail }
}

export async function writeProjectFile(options: {
  readonly cwd: string
  readonly path: string
  readonly content: string
  /** The digest the editor loaded; null when it saw no file. */
  readonly expectedSha: string | null
  readonly force?: boolean | undefined
}): Promise<WriteResult> {
  const resolved = resolveWithinRoot(options.cwd, options.path)
  if (!resolved.ok) return failed(`refusing to write outside the project: ${options.path}`)
  const target = resolved.value

  let before = ''
  let existed = true
  try {
    before = await readFile(target, 'utf8')
  } catch {
    // New file. An empty "before" makes every line an addition, which is right.
    existed = false
  }

  /*
   * Refuse a save that would overwrite a change the editor never saw.
   *
   * The alternative — last-write-wins — is what this did by omission, and the
   * failure it allows is the quiet one: an agent writes the file a second
   * after you opened it, your save lands on top, and the only trace is a log
   * line nobody reads until the work is missing. A refusal is recoverable; a
   * silent overwrite is not.
   *
   * Compared against the *content*, not an mtime — see `digestOf`. A `force`
   * save is the same call with the conflict already shown and accepted, which
   * is why it is a separate flag rather than a null digest: null already means
   * "there was no file", and a save that creates one still has to fail if
   * somebody else created it first.
   */
  if (options.force !== true) {
    const actual = existed ? digestOf(before) : null
    if (actual !== options.expectedSha) {
      return {
        outcome: 'conflict',
        problem: null,
        added: 0,
        removed: 0,
        sha: null,
      }
    }
  }

  /*
   * The temp file sits beside the target, not in the system temp directory.
   *
   * `rename` is only atomic within a filesystem, and a project on an external
   * disk or a network mount is a different one from `/tmp` — there the rename
   * degrades to a copy, which is exactly the non-atomic write this avoids.
   */
  const temporary = join(dirname(target), `.chorus-${String(process.pid)}.tmp`)
  try {
    await writeFile(temporary, options.content, 'utf8')
    await rename(temporary, target)
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }

  return {
    outcome: 'written',
    problem: null,
    ...lineDelta(before, options.content),
    // Of what was written, not of what was read: this is what the editor must
    // save against next time.
    sha: digestOf(options.content),
  }
}
