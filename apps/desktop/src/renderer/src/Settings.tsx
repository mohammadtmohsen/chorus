import { useTranslation } from 'react-i18next'
import type { AgentProbeResult } from '../../shared/ipc.js'
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
