import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IpcResponse } from '../../shared/ipc.js'
import { useDialog } from './useDialog.js'

type Entry = IpcResponse<'diagnostics:read'>[number]

/**
 * What the app has been doing, and a bundle to hand over when it misbehaves.
 *
 * Exists because the alternative is asking someone to find a log file in
 * `~/Library/Application Support`, and because in a packaged app nobody is
 * watching stdout. Entries arrive already redacted — scrubbing happens as the
 * log is written, so there is no unredacted copy to leak.
 */
export function LogViewer({
  onClose,
  onError,
}: {
  onClose: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(onClose)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [exported, setExported] = useState<string | null>(null)

  const refresh = (): void => {
    window.chorus
      .readDiagnostics()
      .then((next) => {
        setEntries(next)
      })
      .catch((e: unknown) => {
        onError(e instanceof Error ? e.message : String(e))
      })
  }

  useEffect(refresh, [])

  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialog}
        className="sheet sheet--wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('logs.heading')}
      >
        <header className="sheet-head">
          <strong>{t('logs.heading')}</strong>
          <span className="hint">{t('logs.redactedHint')}</span>
        </header>

        <div className="log-list" role="log">
          {entries === null ? (
            <p className="muted">{t('logs.loading')}</p>
          ) : entries.length === 0 ? (
            <p className="muted">{t('logs.empty')}</p>
          ) : (
            entries.map((entry, i) => (
              <div key={i} className={`log-line log-line--${entry.level}`}>
                <span className="log-time">{new Date(entry.at).toLocaleTimeString()}</span>
                <span className="log-level">{entry.level}</span>
                <span className="log-message">{entry.message}</span>
                {entry.fields !== undefined && (
                  <span className="log-fields">{JSON.stringify(entry.fields)}</span>
                )}
              </div>
            ))
          )}
        </div>

        <div className="sheet-actions">
          <span className="hint">{exported ?? t('logs.exportHint')}</span>
          <button type="button" className="btn" onClick={refresh}>
            {t('logs.refresh')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              window.chorus
                .exportDiagnostics()
                .then(({ path }) => {
                  setExported(t('logs.exported', { path }))
                })
                .catch((e: unknown) => {
                  onError(e instanceof Error ? e.message : String(e))
                })
            }}
          >
            {t('logs.export')}
          </button>
          <button type="button" className="btn btn--go" onClick={onClose}>
            {t('logs.done')}
          </button>
        </div>
      </section>
    </div>
  )
}
