import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ALL_AGENTS, shortenPath, type SessionInfo } from '../Session.js'
import { compactTokens, money } from '../format.js'
import { useSessionPulse, usePlanning } from './hooks.js'
import { createSignal, useSignal, type Signal } from './signal.js'

/**
 * One read-only card, shown from either representation of a session.
 *
 * The rail shortcut is two letters and the drawer row is a title — neither has
 * room for the project path, the cast, the profile, what a session has spent or
 * how full its context is. All of that used to be mounted permanently in every
 * card, which is how a list of six sessions became six small control panels.
 *
 * It is deliberately informational. Actions live in `SessionMenu`, because a
 * surface that disappears when the pointer crosses a 6px gap is a bad home for
 * "End session". If direct actions ever earn their place here they arrive with
 * an explicit pin state, not by accident.
 */

/** Long enough that crossing the list does not open anything. */
const DWELL_MS = 200

/**
 * The gap between a trigger and the card is a real distance, and a pointer
 * crosses it in more than zero milliseconds. Without this grace the card closes
 * under a pointer that is on its way into it, which reads as flicker.
 */
const CLOSE_GRACE_MS = 120

export interface PreviewTarget {
  readonly conversationId: string
  /** The trigger's box at the moment it was asked for; the card places itself. */
  readonly anchor: DOMRect
}

export interface PreviewController {
  readonly target: Signal<PreviewTarget | null>
  /** Hover or focus arrived. Opens after the dwell unless something cancels. */
  readonly open: (conversationId: string, anchor: DOMRect) => void
  /** Hover or focus left. Closes after the grace unless something holds it. */
  readonly leave: () => void
  /** The pointer reached the card, or a trigger came back. Cancels the close. */
  readonly hold: () => void
  /** Escape, a click, a drag starting. Closes now and cancels any pending open. */
  readonly dismiss: () => void
}

export function createPreviewController(): PreviewController {
  const target = createSignal<PreviewTarget | null>(null)
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const clear = (): void => {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
  }
  return {
    target,
    open: (conversationId, anchor) => {
      clear()
      /*
       * Already showing this session: re-anchor immediately rather than waiting
       * the dwell out again. Moving between the rail shortcut and the drawer row
       * for the same session should move the card, not close and reopen it.
       */
      if (target.get()?.conversationId === conversationId) {
        target.set({ conversationId, anchor })
        return
      }
      openTimer = setTimeout(() => {
        target.set({ conversationId, anchor })
      }, DWELL_MS)
    },
    leave: () => {
      clearTimeout(openTimer)
      clearTimeout(closeTimer)
      closeTimer = setTimeout(() => {
        target.set(null)
      }, CLOSE_GRACE_MS)
    },
    hold: () => {
      clearTimeout(closeTimer)
    },
    dismiss: () => {
      clear()
      target.set(null)
    },
  }
}

/**
 * The props a trigger needs to drive the preview, as one object.
 *
 * Written here rather than repeated in the rail and the row, because the four
 * handlers have to agree: focus opens as well as hover, and `pointerleave` and
 * `blur` both have to be a *leave* rather than a close, or the card cannot
 * survive the pointer travelling into it.
 */
export function previewTriggerProps(
  controller: PreviewController,
  conversationId: string
): {
  onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
  onFocus: (event: React.FocusEvent<HTMLElement>) => void
  onBlur: () => void
} {
  const show = (element: HTMLElement): void => {
    controller.open(conversationId, element.getBoundingClientRect())
  }
  return {
    onPointerEnter: (event) => {
      show(event.currentTarget)
    },
    onPointerLeave: () => {
      controller.leave()
    },
    onFocus: (event) => {
      show(event.currentTarget)
    },
    onBlur: () => {
      controller.leave()
    },
  }
}

/**
 * The one preview in the app, mounted beside the rail rather than inside it.
 *
 * Its own component so that opening it re-renders this and nothing else. Mount
 * it under `Workspace` and every hover would re-render every pane; mount one per
 * row and twenty sessions would mean twenty hidden cards subscribed to twenty
 * pulses.
 */
export function SessionPreviewHost(props: {
  readonly controller: PreviewController
  readonly sessions: readonly SessionInfo[]
  readonly profiles: readonly { readonly id: string; readonly name: string }[]
  readonly home: string
  readonly onRestart: (conversationId: string) => void
  readonly onEnd: (conversationId: string) => void
}): React.JSX.Element | null {
  const target = useSignal(props.controller.target)
  const session = props.sessions.find((s) => s.conversationId === target?.conversationId)
  if (target === null || session === undefined) return null
  return (
    <SessionPreviewCard
      onRestart={() => {
        props.controller.dismiss()
        props.onRestart(session.conversationId)
      }}
      onEnd={() => {
        props.controller.dismiss()
        props.onEnd(session.conversationId)
      }}
      key={session.conversationId}
      controller={props.controller}
      anchor={target.anchor}
      session={session}
      profileName={
        props.profiles.find((p) => p.id === session.profileId)?.name ?? session.profileId
      }
      home={props.home}
    />
  )
}

function SessionPreviewCard(props: {
  readonly controller: PreviewController
  readonly anchor: DOMRect
  readonly session: SessionInfo
  readonly profileName: string
  readonly home: string
  readonly onRestart: () => void
  readonly onEnd: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const pulse = useSessionPulse(props.session.conversationId)
  const planning = usePlanning(props.session.conversationId)
  const card = useRef<HTMLDivElement | null>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)
  /*
   * The arm-then-confirm state that used to live here is gone.
   *
   * End armed itself while an agent was working, and that *was* the
   * confirmation. Both actions now open a real dialog from `App`, so keeping the
   * arm would mean three clicks to end a session — and a second confirmation is
   * how people learn to click through the first one without reading it.
   *
   * `working` goes with it: the dialog reads it from the store when it opens,
   * which is also the only moment it matters.
   */

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
   * Measured once it is real, then held.
   *
   * The card's height depends on how much this session has to say — a running
   * task list, a context figure, a path of any length — so a position predicted
   * before it renders puts the bottom of it below the window on any row near
   * the foot of a long list. Hidden for the frame it takes to measure, because
   * being seen in the wrong place first is worse than one frame of nothing.
   */
  useLayoutEffect(() => {
    if (card.current === null) return
    const box = card.current.getBoundingClientRect()
    const margin = 8
    const left = Math.min(
      props.anchor.right + margin,
      Math.max(margin, window.innerWidth - box.width - margin)
    )
    const top = Math.min(
      Math.max(margin, props.anchor.top),
      Math.max(margin, window.innerHeight - box.height - margin)
    )
    setPlaced({ left: Math.round(left), top: Math.round(top) })
  }, [props.anchor])

  const running = useMemo(
    () =>
      Object.entries(pulse?.tasksByActor ?? {}).flatMap(([agentId, tasks]) =>
        tasks.map((task) => ({ ...task, agentId }))
      ),
    [pulse?.tasksByActor]
  )
  const contextValues = Object.values(pulse?.contextByActor ?? {})
  const contextPercent = contextValues.length === 0 ? null : Math.max(...contextValues)
  const tokens = pulse?.tokens ?? 0

  return createPortal(
    <div
      ref={card}
      className="session-preview"
      role="tooltip"
      data-conversation={props.session.conversationId}
      style={{
        left: placed?.left ?? 0,
        top: placed?.top ?? 0,
        visibility: placed === null ? 'hidden' : 'visible',
      }}
      /* Hoverable, which WCAG 2.2 requires of anything shown on hover. */
      onPointerEnter={props.controller.hold}
      onPointerLeave={props.controller.leave}
    >
      <p className="session-preview-title">{props.session.title}</p>
      <p className="path session-preview-path">
        {props.session.cwd === props.home
          ? t('conversation.noFolder')
          : shortenPath(props.session.cwd)}
      </p>
      <dl className="session-preview-facts">
        <dt>{t('preview.participants')}</dt>
        <dd>
          {/* Through `ALL_AGENTS` rather than the session's own array, so the
              order is the same for every session however they were seated. */}
          {ALL_AGENTS.filter((agent) => props.session.participants.includes(agent)).join(', ') ||
            t('conversation.nobodyHere')}
        </dd>
        <dt>{t('preview.profile')}</dt>
        <dd>{props.profileName}</dd>
        <dt>{t('preview.plan')}</dt>
        <dd>{planning ? t('preview.planOn') : t('preview.planOff')}</dd>
        {tokens > 0 && (
          <>
            <dt>{t('preview.spend')}</dt>
            <dd className="session-preview-figure">
              {compactTokens(tokens)}
              {pulse?.costUsd != null && ` · ${money(pulse.costUsd)}`}
            </dd>
          </>
        )}
        {contextPercent !== null && (
          <>
            <dt>{t('preview.context')}</dt>
            <dd className="session-preview-figure">
              {t('context.short', { percent: contextPercent })}
            </dd>
          </>
        )}
        {running.length > 0 && (
          <>
            <dt>{t('preview.tasks')}</dt>
            <dd>
              <ul className="session-preview-tasks">
                {running.map((task) => (
                  <li key={`${task.agentId}:${task.id}`}>
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
        Two actions on a card that was deliberately informational.
        
        The rule it broke is a real one — a hover card that can act is a hover
        card you have to be careful around — and what makes it affordable here is
        that this card is already hoverable for WCAG 2.2, so reaching a button in
        it is a deliberate movement rather than a slip. Both buttons now open the
        confirmation dialog `App` owns, so neither destroys anything from a hover
        card on one click.
      */}
      <div className="session-preview-actions">
        <button type="button" onClick={props.onRestart}>
          <RestartIcon />
          {t('workspace.restart')}
        </button>
        <button type="button" className="session-preview-danger" onClick={props.onEnd}>
          <EndIcon armed={false} />
          {t('workspace.end')}
        </button>
      </div>
    </div>,
    document.body
  )
}

/*
 * The two icons these buttons wear.
 *
 * `aria-hidden`, because each sits beside its own word — the button is already
 * named, and a second name for the same control is noise in a screen reader
 * rather than help. Built from paths rather than a font or an inline string, for
 * the reason the whole renderer is: agent output is untrusted and a typed tree
 * cannot be injected into.
 */
function RestartIcon(): React.JSX.Element {
  return (
    <svg className="session-preview-icon" viewBox="0 0 24 24" aria-hidden="true">
      {/* An arc with a head, not a closed ring: a full circle reads as "loading",
          which is the one thing restarting must not be confused with. */}
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

/*
 * A power symbol while it is a question, a cross once it is armed.
 *
 * The label already changes on arming and the button turns red; the mark changes
 * with them so the state is carried by more than colour, which is the same rule
 * the dashed tab border follows. WCAG 1.4.1 — colour is never the only signal.
 */
function EndIcon({ armed }: { readonly armed: boolean }): React.JSX.Element {
  return (
    <svg className="session-preview-icon" viewBox="0 0 24 24" aria-hidden="true">
      {armed ? (
        <path d="M18 6 6 18M6 6l12 12" />
      ) : (
        <>
          <path d="M12 4v8" />
          <path d="M17.7 7.5a8 8 0 1 1-11.4 0" />
        </>
      )}
    </svg>
  )
}
