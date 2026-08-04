import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProbeResult } from '../../shared/ipc.js'
import { ChorusLogo } from './ChorusLogo.js'
import { LogViewer } from './LogViewer.js'
import { fail, Session, type SessionInfo } from './Session.js'
import { Settings, type Defaults } from './Settings.js'

/**
 * The stage: several conversations at once, side by side.
 *
 * The organising idea inside each pane is the voice rail down the left — one
 * continuous line for the shared timeline, a dot per message coloured by who
 * spoke. Reading the dots tells you the shape of an exchange before you read a
 * word, which is the first question a multi-agent transcript has to answer.
 *
 * Across panes the organising idea is that they are genuinely independent:
 * separate agents, separate approvals, separate drafts. `App` holds only the
 * list; everything a conversation knows lives in `Session`.
 */
export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [probes, setProbes] = useState<AgentProbeResult[] | null>(null)
  const [profiles, setProfiles] = useState<{ id: string; name: string; summary: string }[]>([])
  const [defaults, setDefaults] = useState<Defaults>({
    agents: ['codex', 'claude'],
    cwd: '',
    profileId: 'read-only',
  })
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [showingLogs, setShowingLogs] = useState(false)
  const [showingSettings, setShowingSettings] = useState(false)
  /** Null until we know whether anything was open, so the door does not flash. */
  const [restoring, setRestoring] = useState(true)
  /*
   * The pane being dragged, in a ref rather than state.
   *
   * `dragover` can fire in the same tick as `dragstart`, before React has
   * re-rendered — so a pane asked "is something being dragged?" would answer no
   * and refuse the drop. A ref is readable the instant it is set.
   */
  const dragging = useRef<string | null>(null)
  /** The same id as `dragging`, in state, purely so the pane can look lifted. */
  const [lifted, setLifted] = useState<string | null>(null)
  /** The size, shown briefly after it changes. Null when nothing to say. */
  const [zoom, setZoom] = useState<number | null>(null)

  useEffect(() => {
    window.chorus.probeAgents().then(setProbes).catch(fail(setError))
    window.chorus.profiles().then(setProfiles).catch(fail(setError))
    // Only the fields this sheet owns: `scale` belongs to the menu, and holding
    // a copy of it here is how a stale value gets written back.
    window.chorus
      .readSettings()
      .then(({ agents, cwd, profileId }) => {
        setDefaults({ agents, cwd, profileId })
      })
      .catch(fail(setError))

    /*
     * Whatever was open last time comes back before anything is drawn.
     *
     * Agents are started again by the main process as part of this, so the wait
     * is real — showing the start screen first and replacing it a second later
     * would be a worse lie than a moment of nothing.
     */
    window.chorus
      .restoreConversations()
      .then(setSessions)
      .catch(fail(setError))
      .finally(() => {
        setRestoring(false)
      })
  }, [])

  /**
   * Remembers a change made inside a session as the next one's starting point.
   *
   * With the duplicate controls gone from Settings, this is the only thing that
   * still writes defaults — and it is the honest rule: a new session starts
   * where the last one was, rather than snapping back to something you set once
   * and forgot. A patch, so one field cannot overwrite another.
   */
  const remember = useCallback((patch: Partial<Defaults>) => {
    setDefaults((current) => ({ ...current, ...patch }))
    window.chorus.writeSettings(patch).catch(fail(setError))
  }, [])

  useEffect(() => {
    /*
     * ⌘− has no visible control behind it, so the only feedback is the whole
     * window moving — which says something happened, not what. The badge says
     * what, then leaves.
     */
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = window.chorus.onScale((next) => {
      setZoom(next)
      // Restarted on every change, or holding ⌘− would hide the badge partway
      // through the run of presses that needed it most.
      clearTimeout(timer)
      timer = setTimeout(() => {
        setZoom(null)
      }, 1_400)
    })
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [])

  const start = useCallback(() => {
    setError(null)
    setStarting(true)
    window.chorus
      .startConversation({
        agents: defaults.agents,
        cwd: defaults.cwd,
        profileId: defaults.profileId,
      })
      .then(({ conversationId, participants, cwd: startedIn, profileId: profile, title }) => {
        setSessions((current) => [
          ...current,
          { conversationId, participants, cwd: startedIn, profileId: profile, title },
        ])
        // Kept, not cleared: the next session is usually in the same place, and
        // retyping the path is the kind of thing that stops you opening a second.
        setDefaults((current) => ({ ...current, cwd: startedIn }))
      })
      .catch(fail(setError))
      .finally(() => {
        setStarting(false)
      })
  }, [defaults])

  /**
   * Moves the dragged pane as it passes over another, not on drop.
   *
   * The grid rearranges under the cursor, so what you see while dragging is
   * what you get — a drop that only reveals the result at the end asks you to
   * predict it.
   *
   * Removing then inserting at the target's original index lands the pane after
   * the target when it came from the left and before it when it came from the
   * right, which is what "past it" means in each direction. It is also stable:
   * once moved, the pane *is* at that index, so hovering the same target again
   * does nothing rather than oscillating.
   *
   * Nothing is written to disk here — a drag across three panes would be three
   * writes for one decision. `commitOrder` does it once the drag ends.
   */
  const reorder = useCallback((movedId: string, ontoId: string) => {
    setSessions((current) => {
      const from = current.findIndex((s) => s.conversationId === movedId)
      const onto = current.findIndex((s) => s.conversationId === ontoId)
      if (from === -1 || onto === -1 || from === onto) return current

      const next = [...current]
      const [moved] = next.splice(from, 1)
      if (moved === undefined) return current
      next.splice(onto, 0, moved)
      return next
    })
  }, [])

  /**
   * Reordering without a mouse.
   *
   * A drag is the only way to move a pane otherwise, which leaves the grid
   * unreachable from the keyboard entirely. Committed immediately: a keypress
   * has no release to wait for.
   */
  const movePane = useCallback((conversationId: string, delta: -1 | 1) => {
    setSessions((current) => {
      const from = current.findIndex((s) => s.conversationId === conversationId)
      const to = from + delta
      if (from === -1 || to < 0 || to >= current.length) return current

      const next = [...current]
      const [moved] = next.splice(from, 1)
      if (moved === undefined) return current
      next.splice(to, 0, moved)

      window.chorus
        .reorderConversations({ order: next.map((s) => s.conversationId) })
        .catch(fail(setError))
      return next
    })
  }, [])

  /**
   * Slides panes from where they were to where they now are.
   *
   * Reordering is a layout change, so nothing about it can be transitioned in
   * CSS — panes simply appear somewhere else. Measuring before and after and
   * animating the difference is what turns "two panes swapped" from a fact you
   * have to re-read into a movement you watched.
   *
   * The carried pane is skipped: it is already under the cursor, and sliding it
   * as well would fight the drag. Motion is skipped entirely when the system
   * asks for less of it.
   */
  const positions = useRef(new Map<string, DOMRect>())
  const order = sessions.map((session) => session.conversationId).join(',')

  useLayoutEffect(() => {
    const previous = positions.current
    const next = new Map<string, DOMRect>()
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    for (const el of document.querySelectorAll<HTMLElement>('.pane[data-conversation]')) {
      const id = el.dataset['conversation']
      if (id === undefined) continue
      const rect = el.getBoundingClientRect()
      next.set(id, rect)

      const was = previous.get(id)
      if (was === undefined || still || el.dataset['lifted'] === 'true') continue
      const dx = was.left - rect.left
      const dy = was.top - rect.top
      if (dx === 0 && dy === 0) continue

      el.animate(
        [{ transform: `translate(${String(dx)}px, ${String(dy)}px)` }, { transform: 'none' }],
        {
          duration: 160,
          easing: 'ease-out',
        }
      )
    }
    positions.current = next
  }, [order])

  const commitOrder = useCallback(() => {
    setSessions((current) => {
      window.chorus
        .reorderConversations({ order: current.map((s) => s.conversationId) })
        .catch(fail(setError))
      return current
    })
  }, [])

  const close = useCallback((conversationId: string) => {
    // Removed from the grid first: the agents take a moment to shut down, and
    // leaving a dead pane on screen while that happens reads as a hang.
    setSessions((current) => current.filter((s) => s.conversationId !== conversationId))
    window.chorus.closeConversation({ conversationId }).catch(fail(setError))
  }, [])

  const badge =
    zoom === null ? null : (
      <div className="zoom-badge" role="status" aria-live="polite">
        {`${String(Math.round(zoom * 100))}%`}
      </div>
    )

  const sheets = (
    <>
      {showingSettings && (
        <Settings
          probes={probes}
          onClose={() => {
            setShowingSettings(false)
          }}
          onOpenLogs={() => {
            setShowingSettings(false)
            setShowingLogs(true)
          }}
        />
      )}

      {showingLogs && (
        <LogViewer
          onClose={() => {
            setShowingLogs(false)
          }}
          onError={setError}
        />
      )}
    </>
  )

  if (restoring) return <div className="empty" aria-busy="true" />

  if (sessions.length === 0) {
    return (
      <>
        <Empty
          onStart={start}
          starting={starting}
          onSettings={() => {
            setShowingSettings(true)
          }}
          error={error}
        />
        {sheets}
        {badge}
      </>
    )
  }

  return (
    <div className="stage">
      <header className="masthead">
        <h1 className="wordmark">
          <ChorusLogo className="wordmark-logo" label={t('app.name')} />
        </h1>
        <div className="masthead-actions">
          <button type="button" className="btn btn--chip" disabled={starting} onClick={start}>
            {starting ? t('conversation.starting') : t('conversation.newSession')}
          </button>
          <button
            type="button"
            className="btn btn--chip"
            onClick={() => {
              setShowingSettings(true)
            }}
          >
            {t('settings.open')}
          </button>
        </div>
      </header>

      {error !== null && (
        <p className="notice notice--bad" role="alert">
          {error}
        </p>
      )}

      {/* Capped at four; the stylesheet steps it down as the window narrows. */}
      <main className="grid" data-count={Math.min(sessions.length, 4)}>
        {sessions.map((session) => (
          <Session
            key={session.conversationId}
            session={session}
            dragging={dragging}
            onDragStart={(id) => {
              dragging.current = id
              setLifted(id)
            }}
            onDragEnd={() => {
              dragging.current = null
              setLifted(null)
              // The grid already looks right; this is the one write that makes
              // it survive a relaunch.
              commitOrder()
            }}
            onDragOverPane={(ontoId) => {
              const moved = dragging.current
              if (moved !== null) reorder(moved, ontoId)
            }}
            lifted={lifted === session.conversationId}
            onMove={movePane}
            onTitle={(title) => {
              // Names belong to one conversation; they are not a starting point.
              setSessions((current) =>
                current.map((s) =>
                  s.conversationId === session.conversationId ? { ...s, title } : s
                )
              )
            }}
            profiles={profiles}
            onProfile={(profileId) => {
              setSessions((current) =>
                current.map((s) =>
                  s.conversationId === session.conversationId ? { ...s, profileId } : s
                )
              )
              remember({ profileId })
            }}
            installed={(probes ?? []).filter((probe) => probe.installed).map((probe) => probe.id)}
            onParticipants={(participants) => {
              setSessions((current) =>
                current.map((s) =>
                  s.conversationId === session.conversationId ? { ...s, participants } : s
                )
              )
              // Only when somebody is left: an empty room is a step on the way to
              // swapping agents, not a choice about how the next one should open.
              if (participants.length > 0) remember({ agents: participants })
            }}
            onCwd={(cwd, title) => {
              // The title comes with it: a name nobody chose follows the folder.
              setSessions((current) =>
                current.map((s) =>
                  s.conversationId === session.conversationId ? { ...s, cwd, title } : s
                )
              )
              remember({ cwd })
            }}
            onClose={close}
          />
        ))}
      </main>

      {sheets}
      {badge}
    </div>
  )
}

/**
 * The app with nothing open.
 *
 * One thing to press. A setup form stood here once, asking three questions that
 * all had remembered answers — and none of whose answers is final: the directory
 * is a starting point the agent can be told to leave, and permissions change
 * from inside the room. Settings holds the defaults for anyone who wants to
 * change them first.
 */
function Empty(props: {
  onStart: () => void
  starting: boolean
  onSettings: () => void
  error: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="empty">
      <div className="empty-inner">
        <h1 className="wordmark wordmark--large">
          <ChorusLogo className="wordmark-logo" label={t('app.name')} />
        </h1>
        <p className="lede">{t('app.tagline')}</p>

        {props.error !== null && (
          <p className="notice notice--bad" role="alert">
            {props.error}
          </p>
        )}

        {/*
          Straight into a session, on the settings you last used. The form that
          used to stand here asked three questions that all had remembered
          answers — and none of them is final: the directory is a starting point
          the agent can be told to leave, and permissions change from the room
          itself.
        */}
        <button
          type="button"
          className="btn btn--go btn--wide"
          onClick={props.onStart}
          disabled={props.starting}
        >
          {props.starting ? t('conversation.starting') : t('conversation.startSession')}
        </button>
        <button type="button" className="btn btn--quiet" onClick={props.onSettings}>
          {t('settings.open')}
        </button>
      </div>
    </div>
  )
}
