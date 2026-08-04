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
 * What a new session starts with.
 *
 * Every field here is a default rather than a rule — a session still chooses its
 * own agents, directory and profile as it opens. That is what makes it safe to
 * put the permission profile in a settings sheet at all: nothing here can
 * quietly widen what an agent may do in a session you have already started.
 *
 * Changes save as you make them. A settings sheet with a Save button is a sheet
 * you can leave without your change taking effect, which is a worse failure than
 * anything an extra confirmation prevents.
 */
export function Settings(props: {
  defaults: Defaults
  probes: AgentProbeResult[] | null
  profiles: { id: string; name: string; summary: string }[]
  onChange: (next: Defaults) => void
  onClose: () => void
  onOpenLogs: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(props.onClose)
  const { defaults } = props

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
            <legend>{t('conversation.cast')}</legend>
            {AGENTS.map((id) => {
              const probe = props.probes?.find((p) => p.id === id)
              const installed = probe?.installed ?? false
              return (
                <label
                  key={id}
                  className={`cast-member voice--${id}`}
                  data-on={defaults.agents.includes(id)}
                >
                  <input
                    type="checkbox"
                    checked={defaults.agents.includes(id)}
                    disabled={props.probes !== null && !installed}
                    onChange={() => {
                      props.onChange({
                        ...defaults,
                        agents: defaults.agents.includes(id)
                          ? defaults.agents.filter((a) => a !== id)
                          : [...defaults.agents, id],
                      })
                    }}
                  />
                  <span className="voice-dot" aria-hidden="true" />
                  <span className="cast-name">{id}</span>
                  <span className="cast-version">
                    {props.probes === null
                      ? t('agents.probing')
                      : installed
                        ? (probe?.version ?? t('agents.unknownVersion'))
                        : t('agents.notFound', { agent: id })}
                  </span>
                </label>
              )
            })}
          </fieldset>

          <label className="field">
            <span>{t('conversation.projectPath')}</span>
            <input
              value={defaults.cwd}
              placeholder={t('conversation.projectPathPlaceholder')}
              onChange={(e) => {
                props.onChange({ ...defaults, cwd: e.target.value })
              }}
            />
          </label>

          <fieldset className="cast">
            <legend>{t('policy.heading')}</legend>
            {props.profiles.map((profile) => (
              <label
                key={profile.id}
                className="cast-member"
                data-on={defaults.profileId === profile.id}
              >
                <input
                  type="radio"
                  name="default-profile"
                  checked={defaults.profileId === profile.id}
                  onChange={() => {
                    props.onChange({ ...defaults, profileId: profile.id })
                  }}
                />
                <span className="cast-name">{profile.name}</span>
                <span className="cast-version cast-summary">{profile.summary}</span>
              </label>
            ))}
          </fieldset>

          <p className="footnote">{t('policy.footnote')}</p>
        </div>

        <div className="sheet-actions">
          <span className="hint">{t('settings.saved')}</span>
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
