import { memo } from 'react'
import { useTranslation } from 'react-i18next'

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

export const FileDiff = memo(function FileDiff({
  file,
}: {
  file: DiffFileView
}): React.JSX.Element {
  const { t } = useTranslation()
  if (file.binary) return <p className="muted">{t('review.binary')}</p>

  return (
    <>
      {file.hunks.map((hunk, i) => (
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
                <td className="code">{line.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </>
  )
})
