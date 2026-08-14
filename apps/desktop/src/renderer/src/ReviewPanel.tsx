import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileDiff } from './FileDiff.js'
import { useDialog } from './useDialog.js'
import type { IpcResponse } from '../../shared/ipc.js'

type Workspace = IpcResponse<'workspace:read'>

/**
 * Reviewing what an agent actually did, without leaving Chorus (plan M7).
 *
 * Reads git rather than the event log on purpose: the log records what agents
 * *proposed*, git records what is on disk. After a denied approval, a crash, or
 * a manual edit those differ, and the one worth reviewing is the disk.
 */
export function ReviewPanel({
  conversationId,
  onClose,
  onError,
}: {
  conversationId: string
  onClose: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const dialog = useDialog<HTMLElement>(onClose)

  const refresh = (): void => {
    setLoading(true)
    window.chorus
      .readWorkspace({ conversationId })
      .then((result) => {
        setWorkspace(result)
        setSelected((current) =>
          current !== null && result.diff.some((f) => f.path === current)
            ? current
            : (result.diff[0]?.path ?? null)
        )
      })
      .catch((e: unknown) => {
        onError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setLoading(false)
      })
  }

  useEffect(refresh, [conversationId])

  const file = workspace?.diff.find((f) => f.path === selected) ?? null
  const totals = (workspace?.diff ?? []).reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 }
  )

  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialog}
        className="sheet sheet--wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('review.heading')}
      >
        <header className="sheet-head">
          <strong>{t('review.heading')}</strong>
          {workspace !== null && (
            <span className="review-branch">
              {workspace.status.branch ?? t('review.detached')}
              {workspace.status.ahead > 0 && ` ↑${String(workspace.status.ahead)}`}
              {workspace.status.behind > 0 && ` ↓${String(workspace.status.behind)}`}
            </span>
          )}
          <span className="review-totals">
            <span className="added">+{totals.added}</span>{' '}
            <span className="removed">−{totals.removed}</span>
          </span>
        </header>

        {workspace?.problem !== null && workspace !== null && (
          <p className="notice notice--bad" role="alert">
            {workspace.problem}
          </p>
        )}

        {loading && workspace === null ? (
          <p className="muted">{t('review.loading')}</p>
        ) : workspace !== null && workspace.diff.length === 0 ? (
          <p className="muted">
            {workspace.status.clean ? t('review.clean') : t('review.untrackedOnly')}
          </p>
        ) : (
          <div className="review-body">
            <nav className="review-files" aria-label={t('review.files')}>
              {(workspace?.diff ?? []).map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className="review-file"
                  /* The row shows a shortened path; the tooltip is where the
                     whole one lives. */
                  title={f.path}
                  data-on={f.path === selected}
                  onClick={() => {
                    setSelected(f.path)
                  }}
                >
                  <span className="review-file-path">{shorten(f.path)}</span>
                  <span className="review-file-counts">
                    <span className="added">+{f.added}</span>
                    <span className="removed">−{f.removed}</span>
                  </span>
                </button>
              ))}
            </nav>
            <div className="review-diff">{file !== null && <FileDiff file={file} />}</div>
          </div>
        )}

        <div className="sheet-actions">
          <span className="hint">{t('review.source')}</span>
          <button type="button" className="btn" onClick={refresh} disabled={loading}>
            {t('review.refresh')}
          </button>
          <button type="button" className="btn btn--go" onClick={onClose}>
            {t('review.done')}
          </button>
        </div>
      </section>
    </div>
  )
}

/** Keeps the tail of a path — the part that identifies the file. */
function shorten(path: string): string {
  const parts = path.split('/')
  return parts.length <= 3 ? path : `…/${parts.slice(-2).join('/')}`
}
