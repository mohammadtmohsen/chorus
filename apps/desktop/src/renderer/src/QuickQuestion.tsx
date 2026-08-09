import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { asideState, EMPTY_ASIDE, fitCard, promotion, type AsideState } from './aside.js'
import { MarkdownView } from './MarkdownView.js'
import { EMPTY_VIEW, reduceEvents, type TranscriptView } from './transcript.js'

/**
 * A small question about one passage, answered in a fork of the agent that said
 * it, without the exchange becoming the next turn of the conversation.
 *
 * **Not a sheet.** Every other overlay here — Review, Summary, Handoff, History,
 * Settings — renders `.sheet-backdrop` over the whole window and traps Tab with
 * `useDialog`. Reaching for that by reflex would give a full-window modal for a
 * footnote. This follows the only non-modal overlay that exists, `.quote-offer`:
 * positioned inside the pane, dismissed by Escape or by clicking away, and
 * taking nothing away from the composer behind it.
 *
 * **It will not be quick.** Measured at 4–8.5 seconds to first token on both
 * providers, so the card opens immediately with the excerpt and a pending state
 * rather than appearing when the answer is ready — and it can be dismissed while
 * the answer is still in flight. A wait you cannot walk away from would be worse
 * than the turn this exists to avoid.
 */
/**
 * The same "working" pip the sidebar uses for a session mid-turn.
 *
 * Lifted rather than invented: a breathing dot in the agent's own voice colour
 * already means "this one is busy" everywhere else in the app, and a card that
 * said it a different way would read as a different application. The dot
 * carries the signal, so the word does not have to move.
 *
 * The pip and its 1.6s `breathe` are duplicated from `.workspace-session-pip`
 * on purpose — the card should not reach into the workspace's class names for a
 * visual idiom, and eight lines of CSS is cheaper than that coupling.
 */
function Thinking({ agent }: { agent: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <p className={`quick-thinking voice--${agent}`} role="status">
      <span className="quick-pip" aria-hidden="true" />
      {t('aside.thinking')}
    </p>
  )
}

export function QuickQuestion(props: {
  conversationId: string
  sourceEventId: string
  agent: string
  excerpt: string
  left: number
  top: number
  placement: 'above' | 'below'
  onClose: () => void
  /** Stages text into the composer — quoting, or taking the answer forward. */
  onStage: (text: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [question, setQuestion] = useState('')
  const [asideId, setAsideId] = useState<string | null>(null)
  const [state, setState] = useState<AsideState>(EMPTY_ASIDE)
  const [asking, setAsking] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLDivElement>(null)
  /** Where it ends up, once it knows how big it is. */
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  /*
   * Measured, not estimated, and re-measured as the answer arrives.
   *
   * The card's height is unknown until it renders and changes while it streams,
   * so a position computed once from a guessed height is wrong twice. A
   * `ResizeObserver` is the same instrument `Clamped` uses in `Entry` for the
   * same reason.
   *
   * `offsetParent` is the pane, because the card is absolutely positioned inside
   * it — asking the document for `.pane` would find the wrong one in a split.
   */
  useLayoutEffect(() => {
    const el = card.current
    if (el === null) return
    const place = (): void => {
      const pane = el.offsetParent
      if (!(pane instanceof HTMLElement)) return
      setAt(
        fitCard(
          { left: props.left, top: props.top, placement: props.placement },
          { width: pane.clientWidth, height: pane.clientHeight },
          { width: el.offsetWidth, height: el.offsetHeight }
        )
      )
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [props.left, props.top, props.placement])

  /*
   * Escape closes, and a click anywhere outside does too.
   *
   * Capture phase for the key, so it beats anything the pane behind would do
   * with Escape. `mousedown` rather than `click` for the outside dismiss,
   * because a click that starts inside the card and ends outside it — dragging
   * to select the answer — is not an attempt to leave.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (card.current !== null && !card.current.contains(e.target as Node)) props.onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [props])

  /*
   * The aside is an ordinary conversation, so its events arrive on the same
   * push channel as everything else and reduce with the same reducer. Filtering
   * by its own id is all that separates it from the transcript behind.
   */
  useEffect(() => {
    if (asideId === null) return
    let view: TranscriptView = EMPTY_VIEW
    return window.chorus.onEvents((events) => {
      const mine = events.filter((e) => e.conversationId === asideId)
      if (mine.length === 0) return
      view = reduceEvents(view, mine)
      setState(asideState(view))
    })
  }, [asideId])

  /** Closing ends the fork. The transcript stays in the log. */
  useEffect(
    () => () => {
      if (asideId !== null) void window.chorus.closeAside({ asideId })
    },
    [asideId]
  )

  const ask = (): void => {
    const text = question.trim()
    if (text === '' || asking) return
    setAsking(true)

    if (asideId === null) {
      window.chorus
        .openAside({
          conversationId: props.conversationId,
          sourceEventId: props.sourceEventId,
          excerpt: props.excerpt,
          question: text,
        })
        .then((result) => {
          setAsideId(result.asideId)
          setQuestion('')
        })
        .catch((e: unknown) => {
          props.onError(e instanceof Error ? e.message : String(e))
          props.onClose()
        })
        .finally(() => {
          setAsking(false)
        })
      return
    }

    window.chorus
      .askAside({ asideId, question: text })
      .then(() => {
        setQuestion('')
      })
      .catch((e: unknown) => {
        props.onError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setAsking(false)
      })
  }

  const started = asideId !== null

  return (
    <div
      ref={card}
      className="quick-question"
      /*
       * Hidden until it has been measured, so the first paint is not the card
       * in the wrong place followed by a jump. One frame, because
       * `useLayoutEffect` measures before the browser paints.
       */
      style={
        at === null
          ? { visibility: 'hidden' }
          : { left: `${String(at.left)}px`, top: `${String(at.top)}px` }
      }
      role="dialog"
      aria-label={t('aside.heading', { agent: props.agent })}
    >
      <header className="quick-head">
        <strong>{t('aside.heading', { agent: props.agent })}</strong>
        <button type="button" className="quick-close" onClick={props.onClose}>
          {t('aside.close')}
        </button>
      </header>

      {/* The passage, so the card says what it is about without the transcript. */}
      <blockquote className="quick-excerpt">{props.excerpt}</blockquote>

      {started && (
        <div className="quick-answer">
          {state.failed !== null ? (
            <p className="notice notice--bad">{state.failed}</p>
          ) : state.answer !== '' ? (
            <MarkdownView source={state.answer} />
          ) : (
            <Thinking agent={props.agent} />
          )}
          {/*
            While text is already arriving, the dots continue without repeating
            the expectation — that line is for the wait before anything appears,
            and after it has appeared it would only be noise.
          */}
          {state.working && state.answer !== '' && <Thinking agent={props.agent} />}
        </div>
      )}

      <form
        className="quick-form"
        onSubmit={(e) => {
          e.preventDefault()
          ask()
        }}
      >
        <textarea
          ref={input}
          className="quick-input"
          rows={2}
          value={question}
          placeholder={started ? t('aside.followUp') : t('aside.placeholder')}
          onChange={(e) => {
            setQuestion(e.target.value)
          }}
          onKeyDown={(e) => {
            // Enter sends; the card is one short question, not a document.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              ask()
            }
          }}
        />
      </form>

      <div className="quick-actions">
        <button
          type="button"
          className="btn"
          disabled={!state.answered}
          onClick={() => {
            props.onStage(`> ${props.excerpt}\n\n${state.answer}\n\n`)
            props.onClose()
          }}
        >
          {t('aside.quote')}
        </button>
        {/*
          Staged, never sent. The routing is by mention and the wording has to
          say the answer came from somewhere this agent cannot remember — both
          of which the user should see before it goes.
        */}
        <button
          type="button"
          className="btn btn--go"
          disabled={!state.answered}
          onClick={() => {
            props.onStage(promotion(props.agent, props.excerpt, state.answer))
            props.onClose()
          }}
        >
          {t('aside.takeForward')}
        </button>
      </div>
    </div>
  )
}
