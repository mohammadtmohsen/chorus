import { useTranslation } from 'react-i18next'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { AgentId } from '@chorus/shared'
import type { SessionInfo } from '../Session.js'
import { useSessionRowState } from './hooks.js'
import { countRender } from './render-count.js'
import { projectRow, type SessionPlacement, type SessionState } from './session-row.js'
import { previewTriggerProps, type PreviewController } from './SessionPreview.js'

/**
 * One 44px line with one primary target.
 *
 * Everything a row used to carry — the folder, the profile, the cast switches,
 * Plan, Summary, Review, the spend, Restart and End — is in the preview or the
 * menu now. What is left is what you scan a list for: what state it is in, what
 * it is called, who is in it, and whether it is waiting on you.
 */

/**
 * The state mark, as a shape rather than as a colour.
 *
 * Four shapes, because colour alone cannot carry state: a ring at rest, a
 * filled dot that breathes while an agent works, a triangle when the session is
 * waiting on a person, a diamond when the last turn failed. The colour is a
 * second signal on top of the shape, not the signal.
 *
 * `voice` is the second signal's subject and only exists while exactly one agent
 * is working. The mark used to be `--voice-codex` in the stylesheet whatever was
 * running, so a Claude-only session breathed in Codex's colour — `projectRow`
 * had already worked out whose turn it was and nothing read it. Null when
 * several agents are working: a mark cannot name two, and naming one of them
 * would be a lie rather than a simplification.
 *
 * `aria-hidden`, because the words are in the control's accessible name — a
 * screen reader hearing "triangle" would be worse than one hearing "waiting".
 */
export function StateMark(props: {
  readonly state: SessionState
  readonly voice?: AgentId | null
}): React.JSX.Element {
  return (
    <span
      className="state-mark"
      data-state={props.state}
      /* Absent rather than empty when there is no single voice: the stylesheet
         matches on the attribute existing, and `data-voice=""` would still. */
      data-voice={props.state === 'working' ? (props.voice ?? undefined) : undefined}
      aria-hidden="true"
    />
  )
}

export interface SessionRowProps {
  readonly session: SessionInfo
  readonly placement: SessionPlacement
  readonly monogram: string
  readonly renaming: boolean
  readonly arranging: boolean
  readonly dragging: boolean
  readonly drop: 'before' | 'after' | undefined
  readonly preview: PreviewController
  readonly onOpen: () => void
  readonly onMenu: (anchor: DOMRect, trigger: HTMLElement) => void
  readonly onRenameStart: () => void
  readonly onRenameEnd: (title: string | null) => void
  /** Normal mode: the workspace drag. Arrange mode: the reorder drag. */
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
}

export function SessionRow(props: SessionRowProps): React.JSX.Element {
  const { t } = useTranslation()
  countRender('SessionRow')
  const row = useSessionRowState(props.session.conversationId)
  const facts = projectRow(props.session, row, props.placement, props.monogram)

  /*
   * The whole sentence, in the name rather than in the marks.
   *
   * A row draws three things a pointer can read at a glance and a screen reader
   * cannot: the shape, the dots and the count. `aria-label` is where they turn
   * back into words, which is also why the marks themselves are hidden.
   */
  const name = [
    props.session.title,
    t(`state.${facts.state}`),
    facts.count > 0
      ? facts.state === 'waiting'
        ? t('workspace.waiting', { count: facts.count })
        : t('workspace.unread', { count: facts.count })
      : null,
    props.placement === 'active' ? t('state.active') : null,
  ]
    .filter((part) => part !== null)
    .join(' — ')

  if (props.renaming) {
    return (
      <li className="session-row" data-sidebar-conversation={props.session.conversationId}>
        <input
          className="session-row-rename"
          defaultValue={props.session.title}
          autoFocus
          aria-label={t('conversation.renameTitle')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') props.onRenameEnd(null)
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              props.onRenameEnd(event.currentTarget.value)
            }
          }}
          onBlur={(event) => {
            props.onRenameEnd(event.currentTarget.value)
          }}
        />
      </li>
    )
  }

  return (
    <li
      className="session-row"
      data-state={facts.state}
      data-placement={facts.placement}
      data-dragging={props.dragging}
      data-drop={props.drop}
      data-sidebar-conversation={props.session.conversationId}
      data-reorder-id={props.session.conversationId}
    >
      {props.arranging && (
        <span
          className="session-row-grip"
          data-arrange-grip={props.session.conversationId}
          aria-hidden="true"
          onPointerDown={props.onPointerDown}
        />
      )}
      <button
        type="button"
        className="session-row-main"
        data-session-open={props.session.conversationId}
        aria-label={name}
        aria-current={props.placement === 'active' ? 'true' : undefined}
        title={props.session.title}
        onPointerDown={props.arranging ? undefined : props.onPointerDown}
        onClick={props.onOpen}
        onDoubleClick={props.onRenameStart}
        {...previewTriggerProps(props.preview, props.session.conversationId)}
      >
        <StateMark state={facts.state} voice={facts.voice} />
        <span className="session-row-title">{props.session.title}</span>
        <span className="session-row-voices" aria-hidden="true">
          {props.session.participants.map((agent) => (
            <span className={`voice-dot voice--${agent}`} key={agent} />
          ))}
        </span>
        {facts.count > 0 && (
          <span className="session-row-count" data-state={facts.state} aria-hidden="true">
            {facts.count}
          </span>
        )}
      </button>
      {/*
        Always in the DOM and always keyboard-reachable.

        Revealing it on hover only would put every durable action behind a
        pointer, which is the thing the preview is deliberately not allowed to
        do either. The stylesheet fades it at rest; it never leaves the tree.
      */}
      <button
        type="button"
        className="session-row-more"
        data-session-more={props.session.conversationId}
        aria-haspopup="menu"
        aria-label={t('menu.more', { title: props.session.title })}
        title={t('menu.more', { title: props.session.title })}
        onClick={(event) => {
          props.onMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget)
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
    </li>
  )
}
