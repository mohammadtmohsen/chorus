import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Entry } from './Entry.js'
import { HandoffComposer, type HandoffDraft } from './HandoffComposer.js'
import {
  applyMention,
  findMentionQuery,
  mentionOptions,
  type MentionQuery,
} from './mention-menu.js'
import { ReviewPanel } from './ReviewPanel.js'
import {
  EMPTY_VIEW,
  reduceEvents,
  type PendingApproval,
  type TranscriptView,
} from './transcript.js'

type AgentId = 'codex' | 'claude'

export interface SessionInfo {
  readonly conversationId: string
  readonly participants: AgentId[]
  readonly cwd: string
  readonly profileId: string
}

/**
 * One conversation, whole: its transcript, its approvals, its composer.
 *
 * Everything a conversation needs lives in here rather than in `App`, which is
 * what lets several run side by side. Each pane keeps its own draft, its own
 * error and its own scroll position — a message half-typed in one must survive
 * you reading another, and an error in one must not blank the rest.
 *
 * Events arrive for every conversation at once, so each pane filters the push
 * stream down to its own. The filter returns early when nothing matched, which
 * is what stops four panes re-rendering on every token of one agent's reply.
 */
export function Session(props: {
  session: SessionInfo
  /**
   * Position in the grid, 1-based.
   *
   * Two sessions on the same folder with the same agents are otherwise
   * indistinguishable, and "the second one" is how anyone would refer to them.
   * Position is the only thing about a pane that is true at a glance.
   */
  index: number
  profileName: string
  profileSummary: string
  /** Hidden when this is the only session; there is nothing to distinguish. */
  showClose: boolean
  onClose: (conversationId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { conversationId, participants, cwd } = props.session
  const [view, setView] = useState<TranscriptView>(EMPTY_VIEW)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [handoff, setHandoff] = useState<HandoffDraft | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [mention, setMention] = useState<MentionQuery | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  const score = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)

  useEffect(
    () =>
      window.chorus.onEvents((events) => {
        const mine = events.filter((e) => e.conversationId === conversationId)
        if (mine.length === 0) return
        setView((current) => reduceEvents(current, mine))
      }),
    [conversationId]
  )

  useEffect(() => {
    window.chorus
      .history({ conversationId })
      .then((history) => {
        setView((current) => reduceEvents(current, history))
      })
      .catch(fail(setError))
  }, [conversationId])

  useEffect(() => {
    /*
     * Scrolls this pane's own transcript, not the page.
     *
     * `scrollIntoView` walks every scrollable ancestor, so with panes side by
     * side one agent's reply would drag the whole grid around while you were
     * reading another. Setting `scrollTop` cannot reach past this element.
     */
    const el = score.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [view.messages.length, view.approvals.length])

  useEffect(() => {
    /*
     * The box grows with what is in it, up to a ceiling set in CSS.
     *
     * Collapsed to `auto` first: `scrollHeight` is the content height *or* the
     * current box height, whichever is larger, so without the reset the field
     * would grow and never shrink back.
     */
    const el = input.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${String(el.scrollHeight)}px`
  }, [draft])

  /** Identifies one mention being typed, so a refresh can tell it from the next. */
  const queryKey = useRef<string | null>(null)
  /** The query Escape dismissed; it stays shut until you type a different one. */
  const dismissed = useRef<string | null>(null)

  /**
   * Re-reads the caret after any edit or cursor move.
   *
   * Runs on every keystroke *and* every selection change, so it has to be able
   * to tell "the same mention as a moment ago" from a new one — otherwise it
   * resets the highlight under an arrow key, and re-opens a menu that Escape
   * just closed. Both happened.
   */
  const refreshMention = useCallback(() => {
    const el = input.current
    if (el === null) return
    const found = findMentionQuery(el.value, el.selectionStart)
    const key = found === null ? null : `${String(found.start)}:${found.query}`

    if (key !== queryKey.current) {
      queryKey.current = key
      setHighlighted(0)
    }
    if (key !== null && key === dismissed.current) {
      setMention(null)
      return
    }
    dismissed.current = null
    setMention(found)
  }, [])

  const options = mention === null ? [] : mentionOptions(participants, mention.query)
  const menuOpen = options.length > 0

  const choose = useCallback(
    (index: number) => {
      const el = input.current
      const option = options[index]
      if (el === null || mention === null || option === undefined) return
      const next = applyMention(el.value, mention, el.selectionStart, option)
      setDraft(next.text)
      setMention(null)
      // After React has written the new value, or the caret lands wherever the
      // browser last left it.
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(next.caret, next.caret)
      })
    },
    [mention, options]
  )

  const send = useCallback(() => {
    if (draft.trim() === '') return
    const text = draft
    setDraft('')
    window.chorus.sendMessage({ conversationId, text }).catch(fail(setError))
  }, [conversationId, draft])

  const decide = useCallback(
    (approval: PendingApproval, outcome: 'allow' | 'deny') => {
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

  return (
    <section className="pane" aria-label={t('conversation.sessionLabel', { path: cwd })}>
      <header className="pane-head">
        <span className="pane-index" aria-hidden="true">
          {props.index}
        </span>
        <ul className="voices voices--pane">
          {participants.map((id) => (
            <li key={id} className={`voice voice--${id}`} data-live={view.working.includes(id)}>
              <span className="voice-dot" aria-hidden="true" />
              {id}
            </li>
          ))}
        </ul>
        <span className="path" title={cwd}>
          {shortenPath(cwd)}
        </span>
        <span className="profile-chip" title={props.profileSummary}>
          {props.profileName}
        </span>
        <div className="pane-actions">
          <button
            type="button"
            className="btn btn--chip"
            onClick={() => {
              setReviewing(true)
            }}
          >
            {t('review.open')}
          </button>
          {props.showClose &&
            /*
             * Confirmed only while an agent is mid-turn. That is the one moment
             * ending costs something — the rest of the time the log is already
             * durable and the session can be started again.
             */
            (confirmingClose ? (
              <>
                <button
                  type="button"
                  className="btn btn--chip btn--stop"
                  onClick={() => {
                    props.onClose(conversationId)
                  }}
                >
                  {t('conversation.endNow')}
                </button>
                <button
                  type="button"
                  className="btn btn--chip"
                  onClick={() => {
                    setConfirmingClose(false)
                  }}
                >
                  {t('conversation.keep')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--chip"
                aria-label={t('conversation.endLabel')}
                onClick={() => {
                  if (view.busy) setConfirmingClose(true)
                  else props.onClose(conversationId)
                }}
              >
                {t('conversation.end')}
              </button>
            ))}
        </div>
      </header>

      {error !== null && (
        <p className="notice notice--bad" role="alert">
          {error}
        </p>
      )}

      <div className="score" ref={score} aria-label={t('conversation.transcript')}>
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
      </div>

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
          {menuOpen && (
            <ul className="mention-menu" id={`mentions-${conversationId}`} role="listbox">
              {options.map((option, i) => (
                <li key={option.label}>
                  <button
                    type="button"
                    className="mention-option"
                    role="option"
                    aria-selected={i === highlighted}
                    data-on={i === highlighted}
                    // Pointer down, not click: the textarea blurs on click and
                    // the menu would be gone before the choice registered.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      choose(i)
                    }}
                    onMouseEnter={() => {
                      setHighlighted(i)
                    }}
                  >
                    <span className="mention-dots" aria-hidden="true">
                      {option.agents.map((agent) => (
                        <span key={agent} className={`voice-dot voice--${agent}`} />
                      ))}
                    </span>
                    <span className="mention-name">@{option.label}</span>
                    <span className="mention-detail">{option.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={input}
            value={draft}
            rows={1}
            aria-label={t('conversation.messageLabel')}
            placeholder={t('conversation.placeholder', { agents: participants.join(', ') })}
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls={`mentions-${conversationId}`}
            aria-autocomplete="list"
            onChange={(e) => {
              setDraft(e.target.value)
              refreshMention()
            }}
            onSelect={refreshMention}
            onBlur={() => {
              setMention(null)
            }}
            onKeyDown={(e) => {
              /*
               * The menu takes the keys it needs first — Enter in particular.
               * Sending the message when the user meant to pick a name is the
               * failure this whole feature exists to prevent.
               */
              if (menuOpen) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const step = e.key === 'ArrowDown' ? 1 : options.length - 1
                  setHighlighted((current) => (current + step) % options.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  choose(highlighted)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  dismissed.current = queryKey.current
                  setMention(null)
                  return
                }
              }
              if (e.key !== 'Enter') return
              // Mid-composition Enter commits the candidate — for Japanese,
              // Chinese or Korean input that keypress belongs to the IME, not
              // to us, and sending there would swallow the word being typed.
              if (e.nativeEvent.isComposing) return
              // Shift holds the line; every other Enter sends. Cmd and Ctrl keep
              // working because that is what they did before.
              if (e.shiftKey) return
              e.preventDefault()
              send()
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
            {/*
              A glyph, not a word: the button sits inside the field where the
              label would crowd the text being written, and ↑ is what every
              composer of this shape uses. The name lives on `aria-label`, so a
              screen reader still hears "Send".
            */}
            <button
              type="submit"
              className="send"
              aria-label={t('conversation.send')}
              disabled={draft.trim() === ''}
            >
              <span aria-hidden="true">↑</span>
            </button>
          </div>
        </form>
      </div>
    </section>
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

export const fail =
  (setError: (message: string) => void) =>
  (error: unknown): void => {
    setError(readable(error))
  }

/**
 * Strips Electron's IPC wrapper from an error.
 *
 * A rejected `invoke` arrives as "Error invoking remote method
 * 'conversation:start': Error: That directory does not exist" — the useful half
 * is at the end, and the rest is plumbing the reader did not ask about.
 */
export function readable(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const withoutChannel = raw.replace(/^Error invoking remote method '[^']*':\s*/, '')
  return withoutChannel.replace(/^(?:Error:\s*)+/, '')
}

/** Keeps the tail of a long path, which is the part that identifies it. */
export function shortenPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}
