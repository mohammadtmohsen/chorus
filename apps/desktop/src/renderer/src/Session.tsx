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
const ALL_AGENTS: AgentId[] = ['codex', 'claude']

export interface SessionInfo {
  readonly conversationId: string
  readonly participants: AgentId[]
  readonly cwd: string
  readonly profileId: string
  readonly title: string
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
  onTitle: (title: string) => void
  /** Which pane is being dragged. A ref, so a drop decided in the same tick sees it. */
  dragging: { current: string | null }
  onDragStart: (conversationId: string) => void
  onDragEnd: () => void
  /**
   * Called as a dragged pane passes over this one; the grid sorts live.
   * `after` says which side of this pane it should land on.
   */
  onDragOverPane: (conversationId: string, after: boolean) => void
  lifted: boolean
  onMove: (conversationId: string, delta: -1 | 1) => void
  onRestart: (was: string, session: SessionInfo) => void
  /** False for the only session: there is nowhere to be with none open. */
  canClose: boolean
  profiles: { id: string; name: string; summary: string }[]
  /** Reported upward so the pane's chip and the log agree on what is in force. */
  onProfile: (profileId: string) => void
  /** Carries the title too: an untouched one follows the folder. */
  onCwd: (cwd: string, title: string) => void
  /** Which agents exist on this machine at all; an absent one cannot be added. */
  installed: readonly AgentId[]
  onParticipants: (participants: AgentId[]) => void
  onClose: (conversationId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { conversationId, participants, cwd, profileId, title } = props.session
  const profile = props.profiles.find((p) => p.id === profileId)
  const [view, setView] = useState<TranscriptView>(EMPTY_VIEW)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [handoff, setHandoff] = useState<HandoffDraft | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [pickingProfile, setPickingProfile] = useState(false)
  /** Set once Restart has been asked for and is being answered. */
  const [restarting, setRestarting] = useState(false)
  /** Non-null while the path is being edited; holds the draft, not the truth. */
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  /** The agent currently joining or leaving, so its chip can say so. */
  const [moving, setMoving] = useState<AgentId | null>(null)
  /** Non-null while the title is being edited; holds the draft, not the truth. */
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  /** The pane itself, so dragging its bar carries the whole thing. */
  const pane = useRef<HTMLElement | null>(null)
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
    /*
     * A new session exists to be typed into, so it takes the caret.
     *
     * Mount is the right moment rather than every render: this component is
     * keyed by conversation, so it runs exactly once per session — a pane that
     * already exists never steals the caret back from one you are using.
     */
    input.current?.focus()
  }, [])

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
    <section
      ref={pane}
      className="pane"
      // Which conversation this pane is, for anything outside React that needs
      // to address it — a driver, a bug report, the element inspector.
      data-conversation={conversationId}
      data-lifted={props.lifted}
      aria-label={t('conversation.sessionLabel', { path: cwd })}
      onDragOver={(e) => {
        // Only a pane being dragged counts; a file dropped from Finder is not a
        // reorder, and preventing default on it would swallow it silently.
        const moved = props.dragging.current
        if (moved === null) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (moved === conversationId) return

        /*
         * Which side, decided by the midpoint — with a dead band around it.
         *
         * Reordering the instant the cursor touched a pane meant the pane that
         * shifted under the cursor immediately triggered the next swap, and the
         * grid thrashed between two arrangements while the mouse sat still. A
         * pane now has to be crossed past its middle by a real margin before it
         * gives way, and the margin is what the return trip has to re-cross —
         * so a cursor hovering near a seam changes nothing.
         *
         * The axis comes from the grid's column count, not the pane's shape.
         * Two panes side by side in a tall window are each *taller than wide*,
         * so judging by aspect ratio decided them vertically — and left-to-right
         * drags did nothing at all while diagonal ones flipped about.
         */
        const box = e.currentTarget.getBoundingClientRect()
        const grid = e.currentTarget.parentElement
        const columns =
          grid === null
            ? 1
            : window.getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length

        // One column means the panes are stacked, so the question is up or down.
        const horizontal = columns > 1
        const at = horizontal ? e.clientX : e.clientY
        const start = horizontal ? box.left : box.top
        const extent = horizontal ? box.width : box.height
        const middle = start + extent / 2
        const deadBand = Math.max(16, extent * 0.12)

        if (at > middle + deadBand) props.onDragOverPane(conversationId, true)
        else if (at < middle - deadBand) props.onDragOverPane(conversationId, false)
      }}
      onDrop={(e) => {
        // The grid sorted itself on the way here; this only stops the browser
        // treating the drop as navigation.
        if (props.dragging.current !== null) e.preventDefault()
      }}
    >
      {error !== null && (
        <p className="notice notice--bad" role="alert">
          {error}
        </p>
      )}

      {/*
        The session's name, where a name belongs — above what it names.
        
        It replaced the grid position, which was only ever a way to tell two
        identical panes apart. A name does that better and says something as
        well, and the folder is the name until you choose another.
      */}
      {/*
        The title bar is the handle, the way a window's is.
        
        Not the whole pane: it holds a transcript you select text in and a field
        you type into, and either would fight a drag. Dragging is off while the
        name is being edited, or a caret drag inside the field would pick the
        pane up instead.
      */}
      <header
        className="pane-title"
        draggable={titleDraft === null}
        onDragStart={(e) => {
          // Some engines refuse to start a drag with nothing on the transfer.
          e.dataTransfer.setData('text/plain', conversationId)
          e.dataTransfer.effectAllowed = 'move'

          /*
           * The whole pane follows the cursor, not the strip you grabbed.
           *
           * Dragging a title bar that leaves its conversation behind reads as
           * moving the label rather than the session. Offset by where in the
           * pane you actually took hold of it, so it does not jump under the
           * cursor as it lifts.
           */
          const el = pane.current
          if (el !== null) {
            const box = el.getBoundingClientRect()
            e.dataTransfer.setDragImage(el, e.clientX - box.left, e.clientY - box.top)
          }
          props.onDragStart(conversationId)
        }}
        onDragEnd={props.onDragEnd}
      >
        {titleDraft === null ? (
          <button
            type="button"
            className="pane-title-name"
            title={t('conversation.renameTitle')}
            onClick={() => {
              setTitleDraft(title)
            }}
            /*
             * ⌥← and ⌥→ move the pane, so the grid can be rearranged without a
             * mouse. On the name because it is already the focusable thing in
             * the bar you grab — the same handle, reached the other way.
             */
            onKeyDown={(e) => {
              if (!e.altKey) return
              const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : null
              if (delta === null) return
              e.preventDefault()
              props.onMove(conversationId, delta)
            }}
          >
            {title}
          </button>
        ) : (
          <input
            className="pane-title-input"
            value={titleDraft}
            autoFocus
            spellCheck={false}
            aria-label={t('conversation.renameTitle')}
            placeholder={t('conversation.titlePlaceholder')}
            onChange={(e) => {
              setTitleDraft(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setTitleDraft(null)
                return
              }
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
              e.preventDefault()
              const next = titleDraft
              setTitleDraft(null)
              window.chorus
                .renameConversation({ conversationId, title: next })
                .then(({ title: applied }) => {
                  props.onTitle(applied)
                })
                .catch(fail(setError))
            }}
            onBlur={() => {
              setTitleDraft(null)
            }}
          />
        )}
        {titleDraft === null && (
          <span className="pane-title-actions">
            {/*
              Glyphs, not words.
              
              These sit beside a name that can be long, in a bar that has to
              survive a pane a third of the window wide — and both are shapes
              everything else uses for the same two ideas. The words live on
              `aria-label` and `title`, so a screen reader and a hover both still
              get "Restart" and "End".
            */}
            <button
              type="button"
              className="pane-title-action"
              disabled={restarting}
              aria-label={t('conversation.restartLabel')}
              title={t('conversation.restartLabel')}
              onClick={() => {
                setRestarting(true)
                window.chorus
                  .restartConversation({ conversationId })
                  .then((session) => {
                    props.onRestart(conversationId, session)
                  })
                  .catch(fail(setError))
                  .finally(() => {
                    setRestarting(false)
                  })
              }}
            >
              <span aria-hidden="true">{restarting ? '…' : '↻'}</span>
            </button>
            {/*
              Ending asks twice only while an agent is working — the one moment
              there is anything to lose. Rather than a second button, the first
              press arms this one: it turns the colour of a warning and says so,
              and disarms itself after a few seconds so a stray click cannot lie
              in wait.
            */}
            {props.canClose && (
              <button
                type="button"
                className="pane-title-action pane-title-action--end"
                data-armed={confirmingClose}
                aria-label={
                  confirmingClose ? t('conversation.endConfirm') : t('conversation.endLabel')
                }
                title={confirmingClose ? t('conversation.endConfirm') : t('conversation.endLabel')}
                onClick={() => {
                  if (view.busy && !confirmingClose) {
                    setConfirmingClose(true)
                    window.setTimeout(() => {
                      setConfirmingClose(false)
                    }, 3_000)
                    return
                  }
                  props.onClose(conversationId)
                }}
              >
                <span aria-hidden="true">✕</span>
              </button>
            )}
          </span>
        )}
      </header>

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
            placeholder={
              participants.length === 0
                ? t('conversation.nobodyHere')
                : t('conversation.placeholder')
            }
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
          {/*
            Everything about the session sits in the composer's own row.
            
            A separate strip above the transcript put who is here, where they
            are and what they may do at the top of the pane, while the thing you
            act with was at the bottom — so changing permissions meant crossing
            the whole transcript. Here it is all one place, and the keyboard hint
            that used to live in this row is gone: ↵ sends is the convention, and
            saying so forever is a label for the first minute.
          */}
          <div className="composer-actions">
            {/*
              The cast is a set of switches, not a label.
              
              An agent can leave a conversation and another take its place, and
              whoever joins reads the whole transcript on the first thing it is
              asked — including what the one it replaced said. Which is why this
              belongs here rather than on a start screen: who is in the room is a
              thing you change while in it.
            */}
            <ul className="voices voices--pane">
              {ALL_AGENTS.map((id) => {
                const here = participants.includes(id)
                const available = props.installed.includes(id)
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className={`voice voice--${id}`}
                      data-live={view.working.includes(id)}
                      data-on={here}
                      aria-pressed={here}
                      disabled={moving !== null || (!here && !available)}
                      title={
                        available
                          ? t(here ? 'conversation.removeAgent' : 'conversation.addAgent', {
                              agent: id,
                            })
                          : t('agents.notFound', { agent: id })
                      }
                      onClick={() => {
                        setMoving(id)
                        const move = here
                          ? window.chorus.removeAgent({ conversationId, agentId: id })
                          : window.chorus.addAgent({ conversationId, agentId: id })
                        move
                          .then(() => {
                            props.onParticipants(
                              here ? participants.filter((p) => p !== id) : [...participants, id]
                            )
                          })
                          .catch(fail(setError))
                          .finally(() => {
                            setMoving(null)
                          })
                      }}
                    >
                      <span className="voice-dot" aria-hidden="true" />
                      {id}
                    </button>
                  </li>
                )
              })}
            </ul>
            {/*
              The path edits in place.
              
              It decides what "the diff" means — the review panel and any handoff
              brief follow it — so being able to correct it without ending the
              session is the difference between a wrong panel and a right one. It
              does not move an agent's shell; that is what telling the agent
              does, and the change is replayed to whoever is addressed next.
            */}
            {pathDraft === null ? (
              <span className="path-pair">
                <button
                  type="button"
                  className="path path--button"
                  title={t('conversation.choosePath')}
                  onClick={() => {
                    window.chorus
                      .chooseProjectDirectory({ conversationId })
                      .then(({ cwd: applied, title: named }) => {
                        props.onCwd(applied, named)
                      })
                      .catch(fail(setError))
                  }}
                >
                  {shortenPath(cwd)}
                </button>
                {/*
                  Two ways in, because they suit different hands. The path opens
                  the folder chooser, which is how you find a directory you would
                  have to remember to type. The ✎ opens the field, which is how
                  you paste one you already have.
                */}
                <button
                  type="button"
                  className="path-edit"
                  aria-label={t('conversation.editPath', { path: cwd })}
                  title={t('conversation.editPath', { path: cwd })}
                  onClick={() => {
                    setPathDraft(cwd)
                  }}
                >
                  <span aria-hidden="true">✎</span>
                </button>
              </span>
            ) : (
              <input
                className="path path--input"
                value={pathDraft}
                autoFocus
                spellCheck={false}
                aria-label={t('conversation.projectPath')}
                onChange={(e) => {
                  setPathDraft(e.target.value)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setPathDraft(null)
                    return
                  }
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  const next = pathDraft
                  setPathDraft(null)
                  window.chorus
                    .setProjectDirectory({ conversationId, cwd: next })
                    .then(({ cwd: applied, title: named }) => {
                      props.onCwd(applied, named)
                    })
                    .catch(fail(setError))
                }}
                // Cancels rather than commits: leaving a field is not agreement,
                // and a half-typed path is exactly what a stray click produces.
                onBlur={() => {
                  setPathDraft(null)
                }}
              />
            )}
            {/*
              The chip is the control, not a label.
              
              What agents may do without asking is the thing you most want to change
              once a session is under way — you start read-only, watch an agent get
              it right, and stop wanting to approve every command. Sending someone
              back to a start screen for that would mean ending the conversation
              that earned the trust.
            */}
            <div className="profile-picker">
              <button
                type="button"
                className="profile-chip"
                title={profile?.summary}
                aria-haspopup="listbox"
                aria-expanded={pickingProfile}
                onClick={() => {
                  setPickingProfile((open) => !open)
                }}
              >
                {profile?.name ?? profileId}
              </button>
              {pickingProfile && (
                <ul className="profile-menu" role="listbox">
                  {props.profiles.map((option) => (
                    <li key={option.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={option.id === profileId}
                        data-on={option.id === profileId}
                        className="profile-option"
                        onClick={() => {
                          setPickingProfile(false)
                          if (option.id === profileId) return
                          window.chorus
                            .setProfile({ conversationId, profileId: option.id })
                            .then(({ profileId: applied }) => {
                              props.onProfile(applied)
                            })
                            .catch(fail(setError))
                        }}
                      >
                        <span className="profile-option-name">{option.name}</span>
                        <span className="profile-option-summary">{option.summary}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="pane-actions">
              {/*
                Two labels, one button. The row has to survive a pane a third of
                the window wide, and dropping the control would be worse than
                naming it briefly — "Diff" is what it opens either way.
              */}
              <button
                type="button"
                className="btn btn--chip"
                aria-label={t('review.open')}
                onClick={() => {
                  setReviewing(true)
                }}
              >
                <span className="label-full">{t('review.open')}</span>
                <span className="label-short" aria-hidden="true">
                  {t('review.openShort')}
                </span>
              </button>
            </div>
            <div className="composer-tools">
              {/*
              One button, both jobs: Stop while an agent is working, Send
              otherwise.

              The worry with this shape is real — one agent mid-turn must not
              stop you addressing another, which is the whole point of a shared
              room. What saves it is the keyboard: ↵ sends whether or not anyone
              is working, so the button showing Stop closes nothing off. A glyph,
              not a word, because a label would crowd the text being written; the
              name lives on `aria-label`, so a screen reader hears "Send" or
              "Stop" rather than a shape.
            */}
              {view.busy ? (
                <button
                  type="button"
                  className="send send--stop"
                  aria-label={t('conversation.stopAll', { agents: view.working.join(', ') })}
                  onClick={() => {
                    window.chorus.interrupt({ conversationId }).catch(fail(setError))
                  }}
                >
                  <span className="send-square" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send"
                  aria-label={t('conversation.send')}
                  disabled={draft.trim() === '' || participants.length === 0}
                >
                  <span aria-hidden="true">↑</span>
                </button>
              )}
            </div>
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
