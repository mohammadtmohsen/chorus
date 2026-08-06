import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProbeResult, IpcResponse } from '../../shared/ipc.js'
import { useDialog } from './useDialog.js'

type AgentId = 'codex' | 'claude'
const AGENTS: AgentId[] = ['codex', 'claude']

export interface Defaults {
  agents: AgentId[]
  cwd: string
  profileId: string
}

/**
 * What only this sheet can tell you.
 *
 * It used to hold the cast, the directory and the permission profile — all three
 * now live in the pane that owns them, where changing one affects the
 * conversation you are looking at rather than the next one you open. Two
 * controls with the same name doing different things is worse than one, so the
 * duplicates are gone and a new session simply starts where the last one was.
 *
 * What is left is what a session cannot answer: which agents this machine has
 * and at what version, and the way into the log.
 */
export function Settings(props: {
  probes: AgentProbeResult[] | null
  onClose: () => void
  onOpenLogs: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(props.onClose)

  /*
   * The companion VS Code extension.
   *
   * Here rather than in a pane: it is a property of the machine, like which
   * agent CLIs are installed, not of the conversation you happen to be looking
   * at. Installing is always an explicit press — Chorus ships the VSIX but
   * never puts anything into another application on its own.
   */
  const [ext, setExt] = useState<IpcResponse<'ide:extensionStatus'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refreshExt = useCallback(() => {
    window.chorus
      .ideExtensionStatus()
      .then(setExt)
      .catch(() => {
        // An optional integration must not be able to break this sheet.
        setExt(null)
      })
  }, [])

  useEffect(refreshExt, [refreshExt])

  const install = useCallback(() => {
    setBusy(true)
    setNote(t('ide.extension.working'))
    window.chorus
      .ideInstallExtension()
      .then((result) => {
        setNote(
          result.ok
            ? t('ide.extension.done')
            : t('ide.extension.failed', { reason: result.reason ?? 'unknown' })
        )
        refreshExt()
      })
      .catch(() => {
        setNote(t('ide.extension.failed', { reason: 'unknown' }))
      })
      .finally(() => {
        setBusy(false)
      })
  }, [refreshExt, t])

  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialog}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.heading')}
      >
        <header className="sheet-head">
          <strong>{t('settings.heading')}</strong>
          <span className="hint">{t('settings.subhead')}</span>
        </header>

        <div className="sheet-body">
          {ext !== null && (
            <fieldset className="cast">
              <legend>{t('ide.extension.title')}</legend>
              <p className="hint">
                {!ext.cliAvailable
                  ? t('ide.extension.missing')
                  : ext.bundledVersion === null
                    ? t('ide.extension.unavailable')
                    : ext.need === 'install'
                      ? t('ide.extension.none')
                      : ext.need === 'update'
                        ? t('ide.extension.outdated', {
                            installed: ext.installedVersion ?? '',
                            bundled: ext.bundledVersion,
                          })
                        : t('ide.extension.installed', { version: ext.installedVersion ?? '' })}
              </p>
              {ext.cliAvailable && ext.need !== 'none' && (
                <button type="button" className="btn" disabled={busy} onClick={install}>
                  {ext.need === 'update' ? t('ide.extension.update') : t('ide.extension.install')}
                </button>
              )}
              {note !== null && <p className="hint">{note}</p>}
            </fieldset>
          )}

          <fieldset className="cast">
            <legend>{t('settings.installed')}</legend>
            {AGENTS.map((id) => {
              const probe = props.probes?.find((p) => p.id === id)
              const installed = probe?.installed ?? false
              return (
                <p key={id} className={`cast-member voice--${id}`} data-on={installed}>
                  <span className="voice-dot" aria-hidden="true" />
                  <span className="cast-name">{id}</span>
                  <span className="cast-version">
                    {props.probes === null
                      ? t('agents.probing')
                      : installed
                        ? (probe?.version ?? t('agents.unknownVersion'))
                        : t('agents.notFound', { agent: id })}
                  </span>
                </p>
              )
            })}
          </fieldset>

          <p className="footnote">{t('settings.paneNote')}</p>
        </div>

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={props.onOpenLogs}>
            {t('logs.open')}
          </button>
          <button type="button" className="btn btn--go" onClick={props.onClose}>
            {t('settings.done')}
          </button>
        </div>
      </section>
    </div>
  )
}
