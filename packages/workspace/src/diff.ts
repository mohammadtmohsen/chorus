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
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parseDiff(source: string): DiffFile[] {
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
  } | null = null
  let hunk: { header: string; lines: DiffLine[] } | null = null
  let before = 0
  let after = 0

  const closeHunk = (): void => {
    if (current !== null && hunk !== null) current.hunks.push(hunk)
    hunk = null
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
      current = {
        oldPath: header[1] ?? '',
        path: header[2] ?? '',
        hunks: [],
        added: 0,
        removed: 0,
        binary: false,
      }
      continue
    }
    if (current === null) continue

    if (line.startsWith('Binary files ')) {
      current.binary = true
      continue
    }

    const hunkHeader = HUNK_HEADER.exec(line)
    if (hunkHeader !== null) {
      closeHunk()
      before = Number(hunkHeader[1] ?? 1)
      after = Number(hunkHeader[3] ?? 1)
      hunk = { header: line, lines: [] }
      continue
    }
    if (hunk === null) continue

    // "\ No newline at end of file" is metadata about the previous line, not a
    // change; showing it as context would imply a line that is not there.
    if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', text: line.slice(1).trim() })
      continue
    }

    const marker = line[0]
    const text = line.slice(1)

    if (marker === '+') {
      hunk.lines.push({ kind: 'added', text, after })
      after += 1
      current.added += 1
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'removed', text, before })
      before += 1
      current.removed += 1
    } else if (marker === ' ') {
      hunk.lines.push({ kind: 'context', text, before, after })
      before += 1
      after += 1
    } else if (line === '') {
      // Some tools strip the trailing space from an empty context line, so an
      // interior blank still counts as unchanged content.
      hunk.lines.push({ kind: 'context', text: '', before, after })
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
