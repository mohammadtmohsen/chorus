import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProbeResult } from '../../shared/ipc.js'
import { Entry } from './Entry.js'
import { HandoffComposer, type HandoffDraft } from './HandoffComposer.js'
import { ReviewPanel } from './ReviewPanel.js'
import {
  EMPTY_VIEW,
  reduceEvents,
  type PendingApproval,
  type TranscriptView,
} from './transcript.js'

type AgentId = 'codex' | 'claude'
const AGENTS: AgentId[] = ['codex', 'claude']

/**
 * The shared conversation.
 *
 * The organising idea is the voice rail down the left: one continuous line for
 * the shared timeline, a dot per message coloured by who spoke. Reading the dots
 * tells you the shape of an exchange before you read a word — which is the first
 * question a multi-agent transcript has to answer.
 */
export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [probes, setProbes] = useState<AgentProbeResult[] | null>(null)
  const [profiles, setProfiles] = useState<{ id: string; name: string; summary: string }[]>([])
  const [profileId, setProfileId] = useState('read-only')
  const [chosen, setChosen] = useState<AgentId[]>(['codex', 'claude'])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [participants, setParticipants] = useState<AgentId[]>([])
  const [view, setView] = useState<TranscriptView>(EMPTY_VIEW)
  const [cwd, setCwd] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [handoff, setHandoff] = useState<HandoffDraft | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const bottom = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    window.chorus.probeAgents().then(setProbes).catch(fail(setError))
    window.chorus.profiles().then(setProfiles).catch(fail(setError))
  }, [])

  useEffect(
    () =>
      window.chorus.onEvents((events) => {
        setView((current) => reduceEvents(current, events))
      }),
    []
  )

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [view.messages.length, view.approvals.length])

  const start = useCallback(() => {
    setError(null)
    setStarting(true)
    window.chorus
      .startConversation({ agents: chosen, cwd, profileId })
      .then(async ({ conversationId: id, participants: joined }) => {
        setConversationId(id)
        setParticipants(joined)
        const history = await window.chorus.history({ conversationId: id })
        setView((current) => reduceEvents(current, history))
      })
      .catch(fail(setError))
      .finally(() => {
        setStarting(false)
      })
  }, [chosen, cwd, profileId])

  const send = useCallback(() => {
    if (conversationId === null || draft.trim() === '') return
    const text = draft
    setDraft('')
    window.chorus.sendMessage({ conversationId, text }).catch(fail(setError))
  }, [conversationId, draft])

  const decide = useCallback(
    (approval: PendingApproval, outcome: 'allow' | 'deny') => {
      if (conversationId === null) return
      window.chorus
        .decideApproval({
          conversationId,
          agentId: approval.agentId === 'claude' ? 'claude' : 'codex',
          approvalId: approval.approvalId,
          outcome,
          scope: 'once',
        })
        .catch(fail(setError))
    },
    [conversationId]
  )

  if (conversationId === null) {
    return (
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
      />
    )
  }

  return (
    <div className="stage">
      <header className="masthead">
        <h1 className="wordmark">{t('app.name')}</h1>
        <span className="path" title={cwd}>
          {shortenPath(cwd)}
        </span>
        <span className="profile-chip" title={profiles.find((p) => p.id === profileId)?.summary}>
          {profiles.find((p) => p.id === profileId)?.name ?? profileId}
        </span>
        <button
          type="button"
          className="btn btn--chip"
          onClick={() => {
            setReviewing(true)
          }}
        >
          {t('review.open')}
        </button>
        <ul className="voices">
          {participants.map((id) => (
            <li key={id} className={`voice voice--${id}`} data-live={view.working.includes(id)}>
              <span className="voice-dot" aria-hidden="true" />
              {id}
            </li>
          ))}
        </ul>
      </header>

      {error !== null && (
        <p className="notice notice--bad" role="alert">
          {error}
        </p>
      )}

      <main className="score" aria-label={t('conversation.transcript')}>
        <div className="rail" aria-hidden="true" />
        {view.messages.map((message) => (
          <Entry
            key={message.key}
            message={message}
            onHandOff={
              // Only offered when there is somebody to hand to, and only for an
              // agent's own words — handing the user's message back is noise.
              participants.length > 1 && (message.actor === 'codex' || message.actor === 'claude')
                ? (m) => {
                    const from = m.actor === 'claude' ? 'claude' : 'codex'
                    const to = participants.find((p) => p !== from)
                    if (to !== undefined) {
                      setHandoff({ from, to, sourceEventIds: [m.eventId] })
                    }
                  }
                : undefined
            }
          />
        ))}
        <div ref={bottom} />
      </main>

      {reviewing && (
        <ReviewPanel
          conversationId={conversationId}
          onClose={() => {
            setReviewing(false)
          }}
          onError={setError}
        />
      )}

      {handoff !== null && (
        <HandoffComposer
          conversationId={conversationId}
          draft={handoff}
          onClose={() => {
            setHandoff(null)
          }}
          onSent={() => {
            setHandoff(null)
          }}
          onError={setError}
        />
      )}

      <div className="dock">
        {view.approvals.map((approval) => (
          <ApprovalCard
            key={approval.approvalId}
            approval={approval}
            onAllow={() => {
              decide(approval, 'allow')
            }}
            onDeny={() => {
              decide(approval, 'deny')
            }}
          />
        ))}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <textarea
            value={draft}
            rows={2}
            aria-label={t('conversation.messageLabel')}
            placeholder={t('conversation.placeholder', { agents: participants.join(', ') })}
            onChange={(e) => {
              setDraft(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="composer-actions">
            <span className="hint">{t('conversation.hint')}</span>
            {/*
              Stop appears alongside Send, never instead of it. One agent being
              mid-turn must not stop you addressing another — that is the whole
              point of a shared room.
            */}
            {view.busy && (
              <button
                type="button"
                className="btn btn--stop"
                onClick={() => {
                  window.chorus.interrupt({ conversationId }).catch(fail(setError))
                }}
              >
                {t('conversation.stopAll', { agents: view.working.join(', ') })}
              </button>
            )}
            <button type="submit" className="btn btn--go" disabled={draft.trim() === ''}>
              {t('conversation.send')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function ApprovalCard({
  approval,
  onAllow,
  onDeny,
}: {
  approval: PendingApproval
  onAllow: () => void
  onDeny: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <section
      className="approval"
      // Assertive, not polite: an approval blocks an agent and expires. A
      // screen-reader user hearing about it after the timeout has been told
      // nothing useful.
      role="alertdialog"
      aria-live="assertive"
      aria-label={t('approval.wants', { agent: approval.agentId })}
    >
      <header className="approval-head">
        <span className={`voice-dot voice--${approval.agentId}`} aria-hidden="true" />
        <strong>{t('approval.wants', { agent: approval.agentId })}</strong>
      </header>
      <pre className="approval-summary">{approval.summary}</pre>
      {approval.detail !== null && <pre className="approval-detail">{approval.detail}</pre>}
      <div className="approval-actions">
        <button type="button" className="btn btn--go" onClick={onAllow}>
          {t('approval.allowOnce')}
        </button>
        <button type="button" className="btn" onClick={onDeny}>
          {t('approval.deny')}
        </button>
      </div>
    </section>
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
}): React.JSX.Element {
  const { t } = useTranslation()
  const ready = props.cwd.trim() !== '' && props.chosen.length > 0 && !props.starting

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
            placeholder="/Users/you/code/project"
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

        <button
          type="button"
          className="btn btn--go btn--wide"
          onClick={props.onStart}
          disabled={!ready}
        >
          {props.starting ? t('conversation.starting') : t('conversation.start')}
        </button>
        <p className="footnote">{t('policy.footnote')}</p>
      </div>
    </div>
  )
}

const fail =
  (setError: (message: string) => void) =>
  (error: unknown): void => {
    setError(error instanceof Error ? error.message : String(error))
  }

/** Keeps the tail of a long path, which is the part that identifies it. */
function shortenPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}
