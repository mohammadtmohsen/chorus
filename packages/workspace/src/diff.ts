/**
 * Parsing unified diff into something renderable.
 *
 * The review view has to answer "what changed, and is it right" without
 * switching to an editor (plan M7). That needs per-file navigation and line
 * numbers on both sides, neither of which survives if the diff is shown as one
 * block of text.
 *
 * Pure, so it is tested against recorded diffs rather than a repository.
 */

export type LineKind = 'context' | 'added' | 'removed' | 'meta'

export interface DiffLine {
  readonly kind: LineKind
  readonly text: string
  /** Line number in the original file, absent for an added line. */
  readonly before?: number
  /** Line number in the new file, absent for a removed line. */
  readonly after?: number
}

export interface DiffHunk {
  readonly header: string
  readonly lines: readonly DiffLine[]
}

export interface DiffFile {
  readonly path: string
  /** Differs from `path` only for a rename. */
  readonly oldPath: string
  readonly hunks: readonly DiffHunk[]
  readonly added: number
  readonly removed: number
  /** True when git reported a binary file rather than a textual diff. */
  readonly binary: boolean
  /**
   * What happened to the file, for anything drawing a status letter.
   *
   * Read from the headers git writes — `new file mode`, `deleted file mode`, and
   * a `diff --git` whose two paths differ — rather than guessed from the shape
   * of the hunks. A rewritten file is all-additions too, so counting `+` lines
   * would call it new.
   *
   * Only for patches that carry no better answer: where a provider states the
   * change itself (`file.change.completed`), that is authoritative and this is
   * not consulted.
   */
  readonly status: 'added' | 'removed' | 'modified' | 'renamed'
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export interface ParseDiffOptions {
  /**
   * Build the line-by-line hunks, or only the per-file summary.
   *
   * `false` still returns every file with its real `added`, `removed`, `status`
   * and `binary` — everything a changed-files list draws — and leaves `hunks`
   * empty. It exists because the Changes panel's default view is Monaco, which
   * aligns two whole files and never reads a hunk: the panel was parsing every
   * line of every file into an object, validating it twice across the IPC
   * boundary, structured-cloning it, and rendering none of it.
   *
   * Measured on this repository at 26 files and 3,272 diff lines: 88ms for the
   * read, of which git itself was 40ms. The rest was this.
   */
  readonly hunks?: boolean
}

export function parseDiff(source: string, options: ParseDiffOptions = {}): DiffFile[] {
  const wantsHunks = options.hunks !== false
  const files: DiffFile[] = []
  const lines = source.split('\n')
  // `split` leaves a trailing empty element for the final newline. Keeping it
  // would render a context line for content that is not in the file.
  if (lines.at(-1) === '') lines.pop()

  let current: {
    path: string
    oldPath: string
    hunks: DiffHunk[]
    added: number
    removed: number
    binary: boolean
    status: DiffFile['status']
  } | null = null
  let hunk: { header: string; lines: DiffLine[] } | null = null
  /*
   * Whether we are inside a hunk's body, tracked apart from `hunk` itself.
   *
   * With `hunks: false` there is no object to be inside, and the old
   * `if (hunk === null) continue` sat *above* the counting — so reusing it as
   * the position flag would have returned every file with `+0 −0`. The list is
   * the thing that survives this option; silently zeroing its numbers would be
   * a worse bug than the cost it saves.
   */
  let inHunk = false
  let before = 0
  let after = 0

  const closeHunk = (): void => {
    if (current !== null && hunk !== null) current.hunks.push(hunk)
    hunk = null
    inHunk = false
  }
  const closeFile = (): void => {
    closeHunk()
    if (current !== null) files.push(current)
    current = null
  }

  for (const line of lines) {
    const header = FILE_HEADER.exec(line)
    if (header !== null) {
      closeFile()
      const oldPath = header[1] ?? ''
      const path = header[2] ?? ''
      current = {
        oldPath,
        path,
        hunks: [],
        added: 0,
        removed: 0,
        binary: false,
        // The header alone settles a rename; a mode line below can still make
        // this an add or a delete.
        status: oldPath === path ? 'modified' : 'renamed',
      }
      continue
    }
    if (current === null) continue

    if (line.startsWith('new file mode')) {
      current.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'removed'
      continue
    }

    if (line.startsWith('Binary files ')) {
      current.binary = true
      continue
    }

    const hunkHeader = HUNK_HEADER.exec(line)
    if (hunkHeader !== null) {
      closeHunk()
      before = Number(hunkHeader[1] ?? 1)
      after = Number(hunkHeader[3] ?? 1)
      inHunk = true
      hunk = wantsHunks ? { header: line, lines: [] } : null
      continue
    }
    if (!inHunk) continue

    // "\ No newline at end of file" is metadata about the previous line, not a
    // change; showing it as context would imply a line that is not there.
    if (line.startsWith('\\')) {
      hunk?.lines.push({ kind: 'meta', text: line.slice(1).trim() })
      continue
    }

    // `line.slice(1)` only where a line object is being built. It is one string
    // allocation per diff line, and skipping it is most of what this saves.
    const marker = line[0]

    if (marker === '+') {
      hunk?.lines.push({ kind: 'added', text: line.slice(1), after })
      after += 1
      current.added += 1
    } else if (marker === '-') {
      hunk?.lines.push({ kind: 'removed', text: line.slice(1), before })
      before += 1
      current.removed += 1
    } else if (marker === ' ') {
      hunk?.lines.push({ kind: 'context', text: line.slice(1), before, after })
      before += 1
      after += 1
    } else if (line === '') {
      // Some tools strip the trailing space from an empty context line, so an
      // interior blank still counts as unchanged content.
      hunk?.lines.push({ kind: 'context', text: '', before, after })
      before += 1
      after += 1
    }
    // Anything else is a header git emitted between files (index, mode, ---,
    // +++). None of it belongs in the rendered diff.
  }

  closeFile()
  return files
}

export function diffTotals(files: readonly DiffFile[]): { added: number; removed: number } {
  return files.reduce(
    (total, file) => ({ added: total.added + file.added, removed: total.removed + file.removed }),
    { added: 0, removed: 0 }
  )
}
