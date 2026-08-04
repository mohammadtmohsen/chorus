import { useCallback, useEffect, useRef, useState } from 'react'
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
   * Moves the dragged pane to where it was dropped.
   *
   * Insertion before the target rather than a swap: dragging one pane onto
   * another reads as "put it here", and a swap would fling the target across the
   * grid to a place nobody pointed at.
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

      window.chorus
        .reorderConversations({ order: next.map((s) => s.conversationId) })
        .catch(fail(setError))
      return next
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
            }}
            onDragEnd={() => {
              dragging.current = null
            }}
            onDropOn={(ontoId) => {
              const moved = dragging.current
              dragging.current = null
              if (moved !== null) reorder(moved, ontoId)
            }}
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
