import { useTranslation } from 'react-i18next'
import { ALL_AGENTS, shortenPath, type AgentId, type SessionInfo } from '../Session.js'
import { usePlanning, useWorkspaceActions } from './hooks.js'

/**
 * Everything a session can be configured to be, in one block.
 *
 * Lifted out of `SessionMenu` unchanged on 2026-08-14, because the hover card
 * was asked to carry the same controls and the alternative was a second copy of
 * them. Two implementations of a permission chooser is two places for the list
 * of profiles to disagree about which one is selected — and the menu already
 * warns, in its own header, that a hundred and sixty controls in a narrow column
 * is what this design exists to avoid. One set of controls, two hosts.
 *
 * It renders no surface of its own: no portal, no positioning, no dismissal.
 * Those differ between a menu opened by a click and a card opened by a pointer,
 * and they are the host's business. This is the contents.
 */

export interface SessionSettingsProps {
  readonly session: SessionInfo
  readonly home: string
  readonly profiles: readonly {
    readonly id: string
    readonly name: string
    readonly summary: string
  }[]
  readonly installed: readonly AgentId[]
  readonly onToggleAgent: (agentId: AgentId, present: boolean) => Promise<void>
  readonly onChooseFolder: () => Promise<void>
  readonly onSetFolder: (cwd: string) => Promise<void>
  readonly onChooseProfile: (profileId: string) => Promise<void>
}

export function SessionSettings(props: SessionSettingsProps): React.JSX.Element {
  const { t } = useTranslation()
  const { setPlanning } = useWorkspaceActions()
  const planning = usePlanning(props.session.conversationId)

  return (
    <div className="session-settings">
      <p className="session-settings-label">{t('conversation.cast')}</p>
      <ul className="session-settings-agents">
        {ALL_AGENTS.map((agent) => {
          const here = props.session.participants.includes(agent)
          const available = props.installed.includes(agent)
          return (
            <li key={agent}>
              <button
                type="button"
                className={`voice voice--${agent}`}
                data-on={here}
                aria-pressed={here}
                disabled={!here && !available}
                title={
                  available
                    ? t(here ? 'conversation.removeAgent' : 'conversation.addAgent', { agent })
                    : t('agents.notFound', { agent })
                }
                onClick={() => {
                  void props.onToggleAgent(agent, here)
                }}
              >
                <span className="voice-dot" aria-hidden="true" />
                {agent}
              </button>
            </li>
          )
        })}
      </ul>

      <p className="session-settings-label">{t('conversation.choosePath')}</p>
      <div className="session-settings-folder">
        <button
          type="button"
          className="path path--button session-settings-path"
          title={
            props.session.cwd === props.home ? t('conversation.choosePath') : props.session.cwd
          }
          data-empty={props.session.cwd === props.home}
          onClick={() => {
            void props.onChooseFolder()
          }}
        >
          {props.session.cwd === props.home
            ? t('conversation.noFolder')
            : shortenPath(props.session.cwd)}
        </button>
        {props.session.cwd !== props.home && (
          <button
            type="button"
            className="session-settings-clear"
            aria-label={t('conversation.clearFolder')}
            title={t('conversation.clearFolder')}
            onClick={() => {
              void props.onSetFolder('')
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>

      <p className="session-settings-label">{t('aside.profileLabel')}</p>
      <ul className="session-settings-profiles" role="listbox">
        {props.profiles.map((profile) => (
          <li key={profile.id}>
            <button
              type="button"
              role="option"
              aria-selected={profile.id === props.session.profileId}
              data-on={profile.id === props.session.profileId}
              className="profile-option"
              onClick={() => {
                if (profile.id === props.session.profileId) return
                void props.onChooseProfile(profile.id)
              }}
            >
              <span className="profile-option-name">{profile.name}</span>
              <span className="profile-option-summary">{profile.summary}</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="session-settings-label">{t('plan.label')}</p>
      <button
        type="button"
        className="session-settings-plan"
        aria-pressed={planning}
        title={planning ? t('plan.leave') : t('plan.enter')}
        onClick={() => {
          const conversationId = props.session.conversationId
          window.chorus
            .setPlanMode({ conversationId, on: !planning })
            /*
             * The session's answer, not the click's intent: a mode that
             * failed to change must not leave a control claiming it did.
             * The preview reads the same value, so a lie here would be a
             * lie in two places.
             */
            .then((result) => {
              setPlanning(conversationId, result.planning)
            })
            .catch(() => {
              // The previous state is the truthful one.
            })
        }}
      >
        {planning ? t('preview.planOn') : t('preview.planOff')}
      </button>
    </div>
  )
}
