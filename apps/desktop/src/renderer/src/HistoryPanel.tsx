import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { IpcResponse } from '../../shared/ipc.js'
import { shortenPath } from './Session.js'
import { useDialog } from './useDialog.js'

/**
 * Every conversation the log holds, so an ended one can be found again.
 *
 * Before this the only list of conversations was the note recording which
 * windows were open, and ending one removed it from that — while its transcript
 * stayed in SQLite forever, named by an id nothing displayed. This reads the log
 * instead, which is the thing that actually kept them.
 */

type Conversation = IpcResponse<'conversation:list'>['conversations'][number]

/** Coarse on purpose: the question is "which one", not "exactly when". */
function ago(then: number, now: number, t: TFunction): string {
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 1) return t('history.justNow')
  if (minutes < 60) return t('history.minutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('history.hours', { count: hours })
  return t('history.days', { count: Math.round(hours / 24) })
}

export function HistoryPanel(props: {
  onClose: () => void
  /** Resolves once the conversation is on screen, so the sheet can close after. */
  onPick: (conversationId: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(props.onClose)
  const [conversations, setConversations] = useState<Conversation[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** Fixed on open, so rows do not silently re-time themselves while being read. */
  const now = useRef(Date.now())

  useEffect(() => {
    let live = true
    window.chorus
      .listConversations()
      .then((result) => {
        if (live) setConversations(result.conversations)
      })
      .catch((error: unknown) => {
        if (live) setProblem(error instanceof Error ? error.message : String(error))
      })
    return () => {
      live = false
    }
  }, [])

  const pick = (conversation: Conversation): void => {
    setProblem(null)
    setBusy(conversation.conversationId)
    props
      .onPick(conversation.conversationId)
      .then(props.onClose)
      .catch((error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error))
        setBusy(null)
      })
  }

  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialog}
        className="sheet sheet--wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('history.heading')}
      >
        <header className="sheet-head">
          <strong>{t('history.heading')}</strong>
          <button type="button" className="ghost" onClick={props.onClose}>
            {t('history.close')}
          </button>
        </header>

        {problem !== null && (
          <p className="notice notice--bad" role="alert">
            {problem}
          </p>
        )}

        {conversations === null ? (
          <p className="muted">{t('history.loading')}</p>
        ) : conversations.length === 0 ? (
          <p className="muted">{t('history.empty')}</p>
        ) : (
          <ul className="history-list">
            {conversations.map((conversation) => (
              <li key={conversation.conversationId}>
                <button
                  type="button"
                  className="history-row"
                  disabled={busy !== null}
                  data-open={conversation.open ? 'true' : undefined}
                  onClick={() => {
                    pick(conversation)
                  }}
                >
                  <span className="history-title">{conversation.title}</span>
                  <span className="history-meta">
                    {/* The folder it was last worked in, shortened the same way
                        a session card shortens it. */}
                    {shortenPath(conversation.cwd)}
                  </span>
                  <span className="history-meta">
                    {conversation.agents.length === 0
                      ? t('history.noAgents')
                      : conversation.agents.join(' · ')}
                  </span>
                  <span className="history-meta">
                    {t('history.messages', { count: conversation.messages })}
                  </span>
                  <span className="history-when">
                    {busy === conversation.conversationId
                      ? t('history.opening')
                      : conversation.open
                        ? t('history.alreadyOpen')
                        : ago(conversation.updatedAt, now.current, t)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="muted history-note">{t('history.note')}</p>
      </section>
    </div>
  )
}
