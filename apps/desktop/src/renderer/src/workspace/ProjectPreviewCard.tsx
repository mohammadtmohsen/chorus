import { useHostCapabilities } from '../host-context.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { shortenPath, type AgentId, type SessionInfo } from '../Session.js'
import { compactTokens, money } from '../format.js'
import { useProjectFacts } from './hooks.js'
import { ProjectSettings } from './ProjectSettings.js'
import type { PreviewController } from './SessionPreview.js'
import type { ProjectInfo } from './session-row.js'

/**
 * One read-only card for a **project**, shown from its rail tile.
 *
 * It was a conversation card, and the rail it opened from listed conversations.
 * Both moved up together: the rail lists projects, so the card describes the
 * place — its folder, what agents may do in it, who is in it — and the
 * conversations appear as a list *inside* it rather than as four tiles in a
 * column.
 *
 * The settings block is shared with the project menu, not copied — see
 * `ProjectSettings`. Two implementations of a permission chooser is two places
 * for the list of profiles to disagree about which one is selected.
 *
 * Actions on a hover card remain a rule broken deliberately, and the licence is
 * unchanged: this card is hoverable for WCAG 2.2, so reaching a control inside
 * it is a movement rather than a slip, and both destructive ones open the
 * confirmation dialog `App` owns.
 */
export function ProjectPreviewCard(props: {
  readonly controller: PreviewController
  readonly anchor: DOMRect
  readonly project: ProjectInfo
  /** This project's conversations, newest last — the order the rail built. */
  readonly sessions: readonly SessionInfo[]
  readonly home: string
  readonly installed: readonly AgentId[]
  readonly profiles: readonly {
    readonly id: string
    readonly name: string
    readonly summary: string
  }[]
  /**
   * Opened by a right-click rather than by a hover.
   *
   * It changes two things and nothing else: the pointer leaving no longer closes
   * it (the controller refuses `leave` while pinned), and a click outside does.
   */
  readonly pinned: boolean
  readonly onRename: (name: string) => void
  readonly onChooseProfile: (profileId: string) => Promise<void>
  /** Both only reachable while the project's folder is missing — see `ProjectSettings`. */
  readonly onRelocate: () => Promise<void>
  readonly onForget: () => Promise<void>
}): React.JSX.Element {
  const capabilities = useHostCapabilities()
  const { t } = useTranslation()
  const [renaming, setRenaming] = useState(false)
  const card = useRef<HTMLDivElement | null>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)
  const facts = useProjectFacts(props.sessions.map((session) => session.conversationId))

  const dismiss = props.controller.dismiss
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [dismiss])

  /*
   * A click outside puts a pinned card away — and only a pinned one.
   *
   * A hovered card needs nothing of the sort: the pointer leaving is already
   * what closes it. A pinned card ignores the pointer by design, so without this
   * the only ways out would be Escape and the tile it came from, and a panel you
   * have to aim at to dismiss is one you learn to leave open.
   *
   * The card excludes itself by containment; the *tile* does not need excluding,
   * because its `contextmenu` toggle is what a second right-click there does
   * anyway. `pointerdown` in the capture phase, so a drag beginning elsewhere in
   * the rail dismisses on the way down rather than after it has finished
   * somewhere else.
   */
  const pinned = props.pinned
  useEffect(() => {
    if (!pinned) return undefined
    const onDown = (event: Event): void => {
      const target = event.target as Node | null
      if (target !== null && card.current?.contains(target) === true) return
      dismiss()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [pinned, dismiss])

  /*
   * Measured once it is real, then held.
   *
   * The card's height depends on how much this project has to say — how many
   * conversations, a running task list, a path of any length — so a position
   * predicted before it renders puts the bottom of it below the window on any
   * tile near the foot of a long list. Hidden for the frame it takes to measure,
   * because being seen in the wrong place first is worse than one frame of
   * nothing.
   */
  useLayoutEffect(() => {
    if (card.current === null) return
    const box = card.current.getBoundingClientRect()
    const margin = 8
    const left = capabilities.railOnRight
      ? Math.max(margin, props.anchor.left - margin - box.width)
      : Math.min(
          props.anchor.right + margin,
          Math.max(margin, window.innerWidth - box.width - margin)
        )
    const top = Math.min(
      Math.max(margin, props.anchor.top),
      Math.max(margin, window.innerHeight - box.height - margin)
    )
    setPlaced({ left: Math.round(left), top: Math.round(top) })
  }, [props.anchor, capabilities.railOnRight])

  return createPortal(
    <div
      ref={card}
      className="session-preview"
      role="tooltip"
      data-project={props.project.id}
      style={{
        left: placed?.left ?? 0,
        top: placed?.top ?? 0,
        visibility: placed === null ? 'hidden' : 'visible',
      }}
      /* Hoverable, which WCAG 2.2 requires of anything shown on hover. */
      onPointerEnter={props.controller.hold}
      onPointerLeave={props.controller.leave}
    >
      {/*
        Double-click renames the project, which is where renaming lives now.

        It renamed a conversation before, for a reason that transfers exactly: a
        tile is two letters and a tab is truncated, and this card already shows
        the whole name and is already where you go to ask about the thing.
      */}
      {renaming ? (
        <input
          className="session-preview-rename"
          defaultValue={props.project.name}
          autoFocus
          aria-label={t('project.renameTitle')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setRenaming(false)
            }
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              props.onRename(event.currentTarget.value)
              setRenaming(false)
            }
          }}
          onBlur={(event) => {
            props.onRename(event.currentTarget.value)
            setRenaming(false)
          }}
        />
      ) : (
        <p
          className="session-preview-title"
          title={props.project.name}
          onDoubleClick={() => {
            setRenaming(true)
          }}
        >
          {props.project.name}
        </p>
      )}
      <p className="path session-preview-path">{shortenPath(props.project.root)}</p>

      <dl className="session-preview-facts">
        {facts.tokens > 0 && (
          <>
            <dt>{t('preview.spend')}</dt>
            <dd className="session-preview-figure">
              {compactTokens(facts.tokens)}
              {facts.costUsd != null && ` · ${money(facts.costUsd)}`}
            </dd>
          </>
        )}
        {facts.contextPercent !== null && (
          <>
            <dt>{t('preview.context')}</dt>
            <dd className="session-preview-figure">
              {t('context.short', { percent: facts.contextPercent })}
            </dd>
            <dd
              className="session-preview-meter"
              title={
                facts.contextMarkPercent === null
                  ? undefined
                  : t('context.title', { percent: facts.contextPercent })
              }
            >
              <i style={{ width: `${String(facts.contextPercent)}%` }} />
              {facts.contextMarkPercent !== null && (
                <i
                  className="session-preview-meter-mark"
                  style={{ left: `${String(facts.contextMarkPercent)}%` }}
                />
              )}
            </dd>
          </>
        )}
        {facts.tasks.length > 0 && (
          <>
            <dt>{t('preview.tasks')}</dt>
            <dd>
              <ul className="session-preview-tasks">
                {facts.tasks.map((task) => (
                  <li key={`${task.conversationId}:${task.agentId}:${task.id}`}>
                    <span className={`session-preview-task-kind voice--${task.agentId}`}>
                      {task.kind}
                    </span>
                    <span className="session-preview-task-what">{task.description}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>

      {/*
        The pointer is held while a dialog is open: a confirmation takes focus
        to another surface, the pointer leaves the card on its way there, and
        without this the card would close behind it and drop the answer.
      */}
      <div className="session-preview-settings" onPointerEnter={props.controller.hold}>
        <ProjectSettings
          project={props.project}
          sessions={props.sessions}
          home={props.home}
          profiles={props.profiles}
          installed={props.installed}
          onChooseProfile={props.onChooseProfile}
          onRelocate={props.onRelocate}
          onForget={props.onForget}
        />
      </div>
    </div>,
    document.body
  )
}
