import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { compactTokens, money } from './format.js'
import { EMPTY_SUMMARY, summariseSession, summaryPrompt, type SessionSummary } from './summary.js'
import { useDialog } from './useDialog.js'

/**
 * What happened in this session, from the log (plan §4.5's read of S3).
 *
 * Two halves, and the split is the point.
 *
 * The counts are read from the event log, so they are free, instant and exactly
 * true. They answer "what was done" — turns, commands, files, approvals, errors,
 * spend, per agent.
 *
 * What they cannot answer is everything the question is usually *for*: whether
 * the work was any good, what is still missing, what to do next. Nothing in the
 * log records intent, so deriving those here would mean inventing them. Instead
 * the panel offers to ask an agent, which is honest about the cost — the reply
 * lands in the shared transcript like any other turn, because Chorus has no
 * side-channel to an agent and inventing one for a summary would be a large
 * change hidden inside a small feature.
 */
export function SummaryPanel({
  conversationId,
  onClose,
  onAsk,
  onError,
}: {
  conversationId: string
  onClose: () => void
  /** Sends the prompt as an ordinary message, so the answer is part of the room. */
  onAsk: (prompt: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<SessionSummary>(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(true)
  const dialog = useDialog<HTMLElement>(onClose)

  const refresh = (): void => {
    setLoading(true)
    window.chorus
      .history({ conversationId })
      .then((events) => {
        setSummary(summariseSession(events))
      })
      .catch((e: unknown) => {
        onError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setLoading(false)
      })
  }

  useEffect(refresh, [conversationId])

  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialog}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('summary.heading')}
      >
        <header className="sheet-head">
          <strong>{t('summary.heading')}</strong>
          {summary.spend.inputTokens + summary.spend.outputTokens > 0 && (
            <span className="summary-spend">
              {t('spend.tokens', {
                input: compactTokens(summary.spend.inputTokens),
                output: compactTokens(summary.spend.outputTokens),
              })}
              {summary.spend.costUsd !== null && ` · ${money(summary.spend.costUsd)}`}
            </span>
          )}
        </header>

        {loading && !summary.anything ? (
          <p className="muted">{t('summary.loading')}</p>
        ) : !summary.anything ? (
          <p className="muted">{t('summary.empty')}</p>
        ) : (
          <div className="summary-body">
            <section className="summary-block">
              <h3 className="summary-title">{t('summary.whatAgentsDid')}</h3>
              {summary.agents.length === 0 ? (
                <p className="muted">{t('summary.noAgentWork')}</p>
              ) : (
                <ul className="summary-agents">
                  {summary.agents.map((a) => (
                    <li key={a.actor} className={`summary-agent summary-agent--${a.actor}`}>
                      <span className="summary-agent-name">{a.actor}</span>
                      {/*
                        Assembled from pluralised fragments rather than one
                        interpolated sentence: i18next pluralises on a single
                        `count`, and three numbers in one key gave "1 turns".
                      */}
                      <span className="summary-agent-facts">
                        {[
                          t('summary.turns', { count: a.turns }),
                          t('summary.commands', { count: a.commands }),
                          t('summary.filesCount', { count: a.filesTouched.length }),
                          ...(a.commandsFailed > 0
                            ? [t('summary.failed', { count: a.commandsFailed })]
                            : []),
                          ...(a.approvalsDenied > 0
                            ? [t('summary.denied', { count: a.approvalsDenied })]
                            : []),
                        ].join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="summary-block">
              <h3 className="summary-title">
                {t('summary.problems', { count: summary.problems.length })}
              </h3>
              {summary.problems.length === 0 ? (
                <p className="muted">{t('summary.noProblems')}</p>
              ) : (
                <ul className="summary-problems">
                  {summary.problems.map((p) => (
                    <li key={p.eventId} className="summary-problem" data-kind={p.kind}>
                      <span className="summary-problem-who">{p.actor}</span>
                      <span className="summary-problem-detail">{p.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {summary.filesTouched.length > 0 && (
              <section className="summary-block">
                <h3 className="summary-title">
                  {t('summary.files', { count: summary.filesTouched.length })}
                </h3>
                <ul className="summary-files">
                  {summary.filesTouched.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        <div className="sheet-actions">
          {/*
            Said plainly rather than discovered: the counts are facts, the rest
            is a question for an agent, and asking costs a turn in the room.
          */}
          <span className="hint">{t('summary.source')}</span>
          <button type="button" className="btn" onClick={refresh} disabled={loading}>
            {t('summary.refresh')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onAsk(summaryPrompt(summary))
              onClose()
            }}
          >
            {t('summary.ask')}
          </button>
          <button type="button" className="btn btn--go" onClick={onClose}>
            {t('summary.done')}
          </button>
        </div>
      </section>
    </div>
  )
}
