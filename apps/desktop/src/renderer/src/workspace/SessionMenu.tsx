import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ALL_AGENTS, shortenPath, type AgentId, type SessionInfo } from '../Session.js'
import { usePlanning, useWorkspaceActions } from './hooks.js'

/**
 * One menu for the whole list, opened against whichever row asked for it.
 *
 * Every row used to mount its own configuration: a folder editor, a profile
 * picker, two agent switches, a Plan toggle, Summary, Review, Restart and End.
 * With twenty sessions that is a hundred and sixty controls in a column 248px
 * wide, of which you wanted one. This is the same set of things, mounted once,
 * for the session you actually asked about.
 *
 * The durable route, deliberately: everything here is reachable by mouse,
 * keyboard and assistive technology, which is why the preview is allowed to be
 * read-only. Escape closes and puts focus back where it came from.
 */

export interface MenuTarget {
  readonly conversationId: string
  readonly anchor: DOMRect
  /** Where focus goes when the menu closes. */
  readonly trigger: HTMLElement | null
}

export interface SessionMenuProps {
  readonly target: MenuTarget
  readonly session: SessionInfo
  readonly home: string
  readonly profiles: readonly {
    readonly id: string
    readonly name: string
    readonly summary: string
  }[]
  readonly installed: readonly AgentId[]
  readonly onClose: () => void
  readonly onToggleAgent: (agentId: AgentId, present: boolean) => Promise<void>
  readonly onChooseFolder: () => Promise<void>
  readonly onSetFolder: (cwd: string) => Promise<void>
  readonly onChooseProfile: (profileId: string) => Promise<void>
}

export function SessionMenu(props: SessionMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const { setPlanning } = useWorkspaceActions()
  const planning = usePlanning(props.session.conversationId)
  const surface = useRef<HTMLDivElement | null>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)

  const close = props.onClose
  const trigger = props.target.trigger
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      trigger?.focus()
      close()
    }
    const onPointerDown = (event: Event): void => {
      if (surface.current?.contains(event.target as Node) === true) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [close, trigger])

  /*
   * Measured, then held — the same rule the profile picker already followed and
   * for the same reason: the menu's height depends on how many profiles this
   * machine has, and a row near the foot of a long list would otherwise open a
   * menu into the space below the window.
   */
  useLayoutEffect(() => {
    if (surface.current === null) return
    const box = surface.current.getBoundingClientRect()
    const margin = 8
    setPlaced({
      left: Math.round(
        Math.min(props.target.anchor.left, Math.max(margin, window.innerWidth - box.width - margin))
      ),
      top: Math.round(
        Math.min(
          props.target.anchor.bottom + 4,
          Math.max(margin, window.innerHeight - box.height - margin)
        )
      ),
    })
  }, [props.target.anchor])

  /*
   * Focus lands in the surface so arrows and Escape work without a click.
   *
   * Not before it is placed: the surface is `visibility: hidden` until its
   * position is measured, and a hidden element cannot take focus — so focusing
   * on mount silently did nothing and the first arrow key went to the page.
   */
  useEffect(() => {
    if (placed === null) return
    surface.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  }, [placed])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [
      ...(surface.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []),
    ]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    const next = (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  return createPortal(
    <div
      ref={surface}
      className="session-menu"
      role="menu"
      aria-label={t('menu.label', { title: props.session.title })}
      style={{
        left: placed?.left ?? 0,
        top: placed?.top ?? 0,
        visibility: placed === null ? 'hidden' : 'visible',
      }}
      onKeyDown={onKeyDown}
    >
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
    </div>,
    document.body
  )
}
