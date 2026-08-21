import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeRun } from './CodeRun.js'

/**
 * One file's hunks as a table: line numbers on both sides, a sign column, and
 * the code.
 *
 * Lives here rather than in `ReviewPanel` because it now has two callers — the
 * review panel, which renders git's diff as it arrives over IPC, and the
 * transcript, which parses the patch an agent's edit carried. A second
 * implementation would be a second thing to keep honest about what a `−` means.
 *
 * The prop type is declared structurally rather than imported from either
 * caller. The two sources are the same shape but not the same *type*: the IPC
 * response is inferred from a zod schema, whose optional fields carry an
 * explicit `| undefined` that `exactOptionalPropertyTypes` refuses to unify with
 * `@chorus/workspace`'s. Naming the looser shape here lets both satisfy it and
 * keeps this component a view over data rather than a client of a package.
 */
type LineKind = 'context' | 'added' | 'removed' | 'meta'

interface DiffLineView {
  readonly kind: LineKind
  readonly text: string
  readonly before?: number | undefined
  readonly after?: number | undefined
}

interface DiffHunkView {
  readonly header: string
  readonly lines: readonly DiffLineView[]
}

export interface DiffFileView {
  readonly binary: boolean
  readonly hunks: readonly DiffHunkView[]
}

/**
 * The language to colour a diff in, from the file it is a diff of.
 *
 * `highlight.ts`'s own alias table does the mapping, so this only has to turn a
 * path into the label that table expects. Anything it does not know falls
 * through to `generic`, which still finds comments, strings and numbers — the
 * degradation is gentle rather than a wall of grey.
 */
function languageOf(path: string | undefined): string {
  if (path === undefined) return ''
  const dot = path.lastIndexOf('.')
  return dot < 0 ? '' : path.slice(dot + 1).toLowerCase()
}

/**
 * How many lines of one file's diff are worth drawing.
 *
 * A hunk is normally the change plus three lines of context however large the
 * file, which is why this never mattered — until a *branch* diff, where a file
 * created on the branch is one hunk containing the whole file. `big.ts` against
 * `main` drew 5,000 rows, and with syntax highlighting that is ~20,000 token
 * spans in a panel that also has an editor in it.
 *
 * 600 is well past any hunk anyone reads and far below the point where the row
 * count is the problem. The editor view has no such limit: it is virtualised by
 * Monaco and is the right way to read a whole file.
 */
export const MAX_DIFF_LINES = 600

export interface CappedHunks {
  readonly hunks: readonly DiffHunkView[]
  /** Lines dropped, or zero. Never silent — the component says so. */
  readonly omitted: number
}

/**
 * Trim a file's hunks to `max` lines in total.
 *
 * Whole lines from the front rather than a sample: a diff read from the top is
 * a diff you can follow, and a windowed middle is one you cannot. What is cut
 * is reported rather than dropped quietly, which is the same rule the
 * provider-side `omittedLines` already follows.
 */
export function capHunks(hunks: readonly DiffHunkView[], max = MAX_DIFF_LINES): CappedHunks {
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  if (total <= max) return { hunks, omitted: 0 }

  const kept: DiffHunkView[] = []
  let budget = max
  for (const hunk of hunks) {
    if (budget <= 0) break
    if (hunk.lines.length <= budget) {
      kept.push(hunk)
      budget -= hunk.lines.length
      continue
    }
    kept.push({ header: hunk.header, lines: hunk.lines.slice(0, budget) })
    budget = 0
  }
  return { hunks: kept, omitted: total - max }
}

export const FileDiff = memo(function FileDiff({
  file,
  path,
}: {
  file: DiffFileView
  /**
   * What the diff is of, used only to pick a grammar.
   *
   * Optional because a caller may genuinely not know — a patch from a provider
   * that names no file still renders, just in `generic`.
   */
  path?: string | undefined
}): React.JSX.Element {
  const { t } = useTranslation()
  const language = languageOf(path)
  const capped = capHunks(file.hunks)
  if (file.binary) return <p className="muted">{t('review.binary')}</p>

  return (
    <>
      {capped.hunks.map((hunk, i) => (
        <table key={i} className="hunk">
          <caption>{hunk.header}</caption>
          <tbody>
            {hunk.lines.map((line, j) => (
              <tr key={j} className={`line line--${line.kind}`}>
                <td className="gutter">{line.before ?? ''}</td>
                <td className="gutter">{line.after ?? ''}</td>
                <td className="sign">
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
                </td>
                {/*
                  Coloured with the transcript's own highlighter rather than a
                  second one, and *not* with Monaco.

                  Measured before choosing: one Monaco diff editor is 304 DOM
                  nodes against this renderer's 43 for the same one-line change
                  — 7.1×. The transcript draws every patch inline and always, so
                  a turn with fifteen edits would carry fifteen editors, their
                  model pairs and their observers, in a list that re-renders on
                  every streamed delta. `CodeRun` is memoised per line and is
                  the same stack the transcript already uses for code blocks.

                  A `meta` line is git's own annotation, not source, so it is
                  left alone.
                */}
                <td className="code">
                  {line.kind === 'meta' ? (
                    line.text
                  ) : (
                    <CodeRun code={line.text} language={language} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      {/* Never a silent cap: what was cut is stated, with the way to read it. */}
      {capped.omitted > 0 && (
        <p className="tool-patch-omitted">{t('review.diffCapped', { count: capped.omitted })}</p>
      )}
    </>
  )
})
