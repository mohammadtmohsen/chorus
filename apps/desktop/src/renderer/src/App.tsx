import { useCallback, useEffect, useState } from 'react'
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
  }, [])

  /**
   * Applied immediately and written in the background.
   *
   * Waiting for the disk before the checkbox moves would make the sheet feel
   * broken over a write that has never once failed.
   */
  const changeDefaults = useCallback((next: Defaults) => {
    setDefaults(next)
    window.chorus.writeSettings(next).catch(fail(setError))
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
      .then(({ conversationId, participants, cwd: startedIn, profileId: profile }) => {
        setSessions((current) => [
          ...current,
          { conversationId, participants, cwd: startedIn, profileId: profile },
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
          defaults={defaults}
          probes={probes}
          profiles={profiles}
          onChange={changeDefaults}
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
        <span className="session-count">
          {t('conversation.openCount', { count: sessions.length })}
        </span>
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
        {sessions.map((session, index) => (
          <Session
            key={session.conversationId}
            session={session}
            index={index + 1}
            profiles={profiles}
            onProfile={(profileId) => {
              setSessions((current) =>
                current.map((s) =>
                  s.conversationId === session.conversationId ? { ...s, profileId } : s
                )
              )
            }}
            installed={(probes ?? []).filter((probe) => probe.installed).map((probe) => probe.id)}
            onParticipants={(participants) => {
              setSessions((current) =>
                current.map((s) =>
                  s.conversationId === session.conversationId ? { ...s, participants } : s
                )
              )
            }}
            onCwd={(cwd) => {
              setSessions((current) =>
                current.map((s) =>
                  s.conversationId === session.conversationId ? { ...s, cwd } : s
                )
              )
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
