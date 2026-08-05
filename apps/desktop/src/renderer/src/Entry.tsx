import { memo, useRef, useState } from 'react'
import { CodeRun } from './CodeRun.js'
import { useTranslation } from 'react-i18next'
import { MarkdownView } from './MarkdownView.js'
import type { TranscriptMessage } from './transcript.js'
import { useTypewriter } from './useTypewriter.js'

/**
 * One entry on the score: a dot on the rail, a speaker, and what was said.
 *
 * Memoised on purpose. The transcript hands down a fresh array on every streamed
 * delta, so without this every message in the conversation re-renders for each
 * token — the cost grows with the length of the conversation rather than with
 * the size of the change. With it, only the message actually receiving text
 * re-renders (plan §4.6).
 */
/** Agents are named, not identified — copy should read like a sentence. */
function displayName(actor: TranscriptMessage['actor'] | undefined): string {
  switch (actor) {
    case 'codex':
      return 'Codex'
    case 'claude':
      return 'Claude'
    case 'user':
      return 'you'
    case 'system':
    case undefined:
      return 'the system'
  }
}

export const Entry = memo(function Entry({
  message,
  onHandOff,
  answersThinking = false,
}: {
  message: TranscriptMessage
  /** Absent when there is nobody to hand to — a one-agent conversation. */
  onHandOff?: ((message: TranscriptMessage) => void) | undefined
  /** This reply follows the agent's own thinking, so it is worth marking as the answer. */
  answersThinking?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  /*
   * Messages already finished when the pane first drew them are never typed out.
   * That is history — a transcript reopened at launch, or one just restored —
   * and performing it as if it were happening now would be a lie about when.
   */
  const wasComplete = useRef(message.status !== 'streaming')
  const typed = useTypewriter(message.text, wasComplete.current)

  if (message.kind === 'handoff') {
    return (
      <article className={`entry entry--${message.actor} entry--handoff`}>
        <span className="tick" aria-hidden="true" />
        <span className="speaker">{message.actor}</span>
        <details className="handoff-card">
          <summary>
            {t('handoff.card', {
              from: displayName(message.actor),
              to: displayName(message.handoffTo),
            })}
          </summary>
          <pre>{message.text}</pre>
        </details>
      </article>
    )
  }

  if (message.kind === 'reasoning') {
    return (
      <article className={`entry entry--${message.actor} entry--reasoning`}>
        <span className="tick" aria-hidden="true" />
        <button
          type="button"
          className="reasoning-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open)
          }}
        >
          {open ? t('conversation.hideThinking') : t('conversation.showThinking')}
        </button>
        {open && <div className="reasoning-body">{message.text}</div>}
      </article>
    )
  }

  return (
    <article
      className={`entry entry--${message.actor} entry--${message.kind}`}
      // Only ever set when thinking precedes it, so it marks the answer rather
      // than marking every message and therefore nothing.
      data-answer={answersThinking ? 'true' : undefined}
    >
      <span className="tick" aria-hidden="true" />
      <span className="speaker">{message.actor}</span>
      {onHandOff !== undefined && message.status === 'complete' && (
        <button
          type="button"
          className="handoff-action"
          onClick={() => {
            onHandOff(message)
          }}
        >
          {t('handoff.action')}
        </button>
      )}
      <div className="said" data-streaming={message.status === 'streaming'}>
        {message.kind === 'command' ? (
          /* A command is shell, wherever it is shown. */
          <pre className="command">
            <CodeRun code={message.text} language="shell" />
          </pre>
        ) : message.kind === 'notice' ? (
          <p className="notice-line">{message.text}</p>
        ) : (
          <MarkdownView source={typed} />
        )}
      </div>
    </article>
  )
})
