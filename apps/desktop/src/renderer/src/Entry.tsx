import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MarkdownView } from './MarkdownView.js'
import type { TranscriptMessage } from './transcript.js'

/**
 * One entry on the score: a dot on the rail, a speaker, and what was said.
 *
 * Memoised on purpose. The transcript hands down a fresh array on every streamed
 * delta, so without this every message in the conversation re-renders for each
 * token — the cost grows with the length of the conversation rather than with
 * the size of the change. With it, only the message actually receiving text
 * re-renders (plan §4.6).
 */
export const Entry = memo(function Entry({
  message,
}: {
  message: TranscriptMessage
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

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
    <article className={`entry entry--${message.actor} entry--${message.kind}`}>
      <span className="tick" aria-hidden="true" />
      <span className="speaker">{message.actor}</span>
      <div className="said" data-streaming={message.status === 'streaming'}>
        {message.kind === 'command' ? (
          <pre className="command">{message.text}</pre>
        ) : message.kind === 'notice' ? (
          <p className="notice-line">{message.text}</p>
        ) : (
          <MarkdownView source={message.text} />
        )}
      </div>
    </article>
  )
})
