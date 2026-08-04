import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProbeResult } from '../../shared/ipc.js'
import { EMPTY_VIEW, reduceEvents, type TranscriptView } from './transcript.js'

/**
 * M2 vertical slice: enough UI to drive a real Codex session end to end.
 *
 * Deliberately plain — M4 owns the actual conversation surface, mentions,
 * handoffs and approval cards. What matters here is that the wiring is real:
 * every line of transcript below came out of the event log, not out of a
 * provider callback.
 */
export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<AgentProbeResult[] | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [view, setView] = useState<TranscriptView>(EMPTY_VIEW)
  const [cwd, setCwd] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const bottom = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    window.chorus
      .probeAgents()
      .then(setAgents)
      .catch((e: unknown) => {
        setError(describe(e))
      })
  }, [])

  useEffect(() => {
    // Subscribed before any conversation exists, so nothing is missed between
    // starting one and the first event landing.
    return window.chorus.onEvents((events) => {
      setView((current) => reduceEvents(current, events))
    })
  }, [])

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [view.messages.length])

  const start = useCallback(() => {
    setError(null)
    setStarting(true)
    window.chorus
      .startConversation({ agentId: 'codex', cwd })
      .then(({ conversationId: id }) => {
        setConversationId(id)
        return window.chorus.history({ conversationId: id })
      })
      .then((history) => {
        setView((current) => reduceEvents(current, history))
      })
      .catch((e: unknown) => {
        setError(describe(e))
      })
      .finally(() => {
        setStarting(false)
      })
  }, [cwd])

  const send = useCallback(() => {
    if (conversationId === null || draft.trim() === '') return
    const text = draft
    setDraft('')
    window.chorus.sendMessage({ conversationId, text }).catch((e: unknown) => {
      setError(describe(e))
    })
  }, [conversationId, draft])

  const decide = useCallback(
    (approvalId: string, outcome: 'allow' | 'deny') => {
      if (conversationId === null) return
      window.chorus
        .decideApproval({ conversationId, approvalId, outcome, scope: 'once' })
        .catch((e: unknown) => {
          setError(describe(e))
        })
    },
    [conversationId]
  )

  const codex = agents?.find((a) => a.id === 'codex')

  return (
    <main className="shell">
      <header className="bar">
        <h1>{t('app.name')}</h1>
        <span className="muted">
          {codex === undefined
            ? t('agents.probing')
            : codex.installed
              ? `codex ${codex.version ?? ''}`
              : t('agents.notFound')}
        </span>
      </header>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {conversationId === null ? (
        <section className="starter">
          <label htmlFor="cwd">{t('conversation.projectPath')}</label>
          <input
            id="cwd"
            value={cwd}
            placeholder="/Users/you/code/some-project"
            onChange={(e) => {
              setCwd(e.target.value)
            }}
          />
          <button type="button" onClick={start} disabled={cwd.trim() === '' || starting}>
            {starting ? t('conversation.starting') : t('conversation.start')}
          </button>
          <p className="muted small">{t('conversation.readOnlyNotice')}</p>
        </section>
      ) : (
        <>
          <section className="transcript">
            {view.messages.map((m) => (
              <article key={m.key} className={`msg ${m.actor} ${m.kind}`}>
                <span className="who">{m.actor}</span>
                <pre>{m.text}</pre>
              </article>
            ))}
            {view.busy && <p className="muted small">{t('conversation.working')}</p>}
            <div ref={bottom} />
          </section>

          {view.approvals.map((a) => (
            <section
              key={a.approvalId}
              className="approval"
              role="group"
              aria-label={t('approval.heading')}
            >
              <strong>{t('approval.heading')}</strong>
              <pre>{a.summary}</pre>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => {
                    decide(a.approvalId, 'allow')
                  }}
                >
                  {t('approval.allowOnce')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    decide(a.approvalId, 'deny')
                  }}
                >
                  {t('approval.deny')}
                </button>
              </div>
            </section>
          ))}

          <section className="composer">
            <textarea
              value={draft}
              rows={3}
              placeholder={t('conversation.placeholder')}
              onChange={(e) => {
                setDraft(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
              }}
            />
            <div className="actions">
              <button type="button" onClick={send} disabled={draft.trim() === ''}>
                {t('conversation.send')}
              </button>
              <button
                type="button"
                disabled={!view.busy}
                onClick={() => {
                  window.chorus.interrupt({ conversationId }).catch((e: unknown) => {
                    setError(describe(e))
                  })
                }}
              >
                {t('conversation.stop')}
              </button>
            </div>
          </section>
        </>
      )}
    </main>
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
