import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProbeResult } from '../../shared/ipc.js'
import { ChorusLogo } from './ChorusLogo.js'
import { LogViewer } from './LogViewer.js'
import { fail, Session, type SessionInfo } from './Session.js'
import { Settings, type Defaults } from './Settings.js'

type AgentId = 'codex' | 'claude'
const AGENTS: AgentId[] = ['codex', 'claude']

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
  const [adding, setAdding] = useState(false)
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
        setAdding(false)
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

  const setup = (
    <Setup
      probes={probes}
      chosen={defaults.agents}
      onToggle={(id) => {
        changeDefaults({
          ...defaults,
          agents: defaults.agents.includes(id)
            ? defaults.agents.filter((a) => a !== id)
            : [...defaults.agents, id],
        })
      }}
      cwd={defaults.cwd}
      onCwd={(next) => {
        changeDefaults({ ...defaults, cwd: next })
      }}
      profiles={profiles}
      profileId={defaults.profileId}
      onProfile={(id) => {
        changeDefaults({ ...defaults, profileId: id })
      }}
      onStart={start}
      starting={starting}
      error={error}
      onCancel={() => {
        setAdding(false)
        setError(null)
      }}
    />
  )

  const badge =
    zoom === null ? null : (
      <div className="zoom-badge" role="status" aria-live="polite">
        {`${String(Math.round(zoom * 100))}%`}
      </div>
    )

  const sheets = (
    <>
      {adding && (
        <div className="sheet-backdrop" role="presentation">
          {setup}
        </div>
      )}

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
          onStart={() => {
            setError(null)
            setAdding(true)
          }}
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
          <button
            type="button"
            className="btn btn--chip"
            onClick={() => {
              setError(null)
              setAdding(true)
            }}
          >
            {t('conversation.newSession')}
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
            profileName={
              profiles.find((p) => p.id === session.profileId)?.name ?? session.profileId
            }
            profileSummary={profiles.find((p) => p.id === session.profileId)?.summary ?? ''}
            showClose={sessions.length > 1}
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
 * One thing to press. The setup form used to be the launch screen, which meant
 * arriving at a wall of choices before there was any reason to make them — and
 * every one of them already has a remembered answer. It is a sheet now, and this
 * is the door.
 */
function Empty(props: {
  onStart: () => void
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

        <button type="button" className="btn btn--go btn--wide" onClick={props.onStart}>
          {t('conversation.startSession')}
        </button>
        <button type="button" className="btn btn--quiet" onClick={props.onSettings}>
          {t('settings.open')}
        </button>
      </div>
    </div>
  )
}

function Setup(props: {
  probes: AgentProbeResult[] | null
  chosen: AgentId[]
  onToggle: (id: AgentId) => void
  cwd: string
  onCwd: (value: string) => void
  profiles: { id: string; name: string; summary: string }[]
  profileId: string
  onProfile: (id: string) => void
  onStart: () => void
  starting: boolean
  error: string | null
  /** Absent for the first session — there is nothing behind it to return to. */
  onCancel?: (() => void) | undefined
}): React.JSX.Element {
  const { t } = useTranslation()
  // The directory is optional; an empty one starts at home.
  const ready = props.chosen.length > 0 && !props.starting

  return (
    <div className="setup">
      <div className="setup-inner">
        <h1 className="wordmark wordmark--large">
          <ChorusLogo className="wordmark-logo" label={t('app.name')} />
        </h1>
        <p className="lede">{t('app.tagline')}</p>

        <fieldset className="cast">
          <legend>{t('conversation.cast')}</legend>
          {AGENTS.map((id) => {
            const probe = props.probes?.find((p) => p.id === id)
            const installed = probe?.installed ?? false
            return (
              <label
                key={id}
                className={`cast-member voice--${id}`}
                data-on={props.chosen.includes(id)}
              >
                <input
                  type="checkbox"
                  checked={props.chosen.includes(id)}
                  disabled={props.probes !== null && !installed}
                  onChange={() => {
                    props.onToggle(id)
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
            value={props.cwd}
            placeholder={t('conversation.projectPathPlaceholder')}
            onChange={(e) => {
              props.onCwd(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) props.onStart()
            }}
          />
        </label>

        <fieldset className="cast">
          <legend>{t('policy.heading')}</legend>
          {props.profiles.map((profile) => (
            <label
              key={profile.id}
              className="cast-member"
              data-on={props.profileId === profile.id}
            >
              <input
                type="radio"
                name="profile"
                checked={props.profileId === profile.id}
                onChange={() => {
                  props.onProfile(profile.id)
                }}
              />
              <span className="cast-name">{profile.name}</span>
              <span className="cast-version cast-summary">{profile.summary}</span>
            </label>
          ))}
        </fieldset>

        {props.error !== null && (
          <p className="notice notice--bad" role="alert">
            {props.error}
          </p>
        )}

        <div className="setup-actions">
          {props.onCancel !== undefined && (
            <button type="button" className="btn" onClick={props.onCancel}>
              {t('conversation.cancel')}
            </button>
          )}
          <button
            type="button"
            className="btn btn--go btn--wide"
            onClick={props.onStart}
            disabled={!ready}
          >
            {props.starting ? t('conversation.starting') : t('conversation.start')}
          </button>
        </div>
        <p className="footnote">{t('policy.footnote')}</p>
      </div>
    </div>
  )
}
