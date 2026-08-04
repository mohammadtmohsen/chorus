import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProbeResult } from '../../shared/ipc.js'
import { LogViewer } from './LogViewer.js'
import { fail, Session, type SessionInfo } from './Session.js'

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
  const [profileId, setProfileId] = useState('read-only')
  const [chosen, setChosen] = useState<AgentId[]>(['codex', 'claude'])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [adding, setAdding] = useState(false)
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [showingLogs, setShowingLogs] = useState(false)

  useEffect(() => {
    window.chorus.probeAgents().then(setProbes).catch(fail(setError))
    window.chorus.profiles().then(setProfiles).catch(fail(setError))
  }, [])

  const start = useCallback(() => {
    setError(null)
    setStarting(true)
    window.chorus
      .startConversation({ agents: chosen, cwd, profileId })
      .then(({ conversationId, participants, cwd: startedIn, profileId: profile }) => {
        setSessions((current) => [
          ...current,
          { conversationId, participants, cwd: startedIn, profileId: profile },
        ])
        // Kept, not cleared: the next session is usually in the same place, and
        // retyping the path is the kind of thing that stops you opening a second.
        setCwd(startedIn)
        setAdding(false)
      })
      .catch(fail(setError))
      .finally(() => {
        setStarting(false)
      })
  }, [chosen, cwd, profileId])

  const close = useCallback((conversationId: string) => {
    // Removed from the grid first: the agents take a moment to shut down, and
    // leaving a dead pane on screen while that happens reads as a hang.
    setSessions((current) => current.filter((s) => s.conversationId !== conversationId))
    window.chorus.closeConversation({ conversationId }).catch(fail(setError))
  }, [])

  const setup = (
    <Setup
      probes={probes}
      chosen={chosen}
      onToggle={(id) => {
        setChosen((current) =>
          current.includes(id) ? current.filter((a) => a !== id) : [...current, id]
        )
      }}
      cwd={cwd}
      onCwd={setCwd}
      profiles={profiles}
      profileId={profileId}
      onProfile={setProfileId}
      onStart={start}
      starting={starting}
      error={error}
      onCancel={
        // Nothing to go back to when the grid is empty.
        sessions.length === 0
          ? undefined
          : () => {
              setAdding(false)
              setError(null)
            }
      }
    />
  )

  if (sessions.length === 0) return setup

  return (
    <div className="stage">
      <header className="masthead">
        <h1 className="wordmark">{t('app.name')}</h1>
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
              setShowingLogs(true)
            }}
          >
            {t('logs.open')}
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

      {adding && (
        <div className="sheet-backdrop" role="presentation">
          {setup}
        </div>
      )}

      {showingLogs && (
        <LogViewer
          onClose={() => {
            setShowingLogs(false)
          }}
          onError={setError}
        />
      )}
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
        <h1 className="wordmark wordmark--large">{t('app.name')}</h1>
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
