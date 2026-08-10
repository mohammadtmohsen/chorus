import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { asideState, EMPTY_ASIDE, fitCard, promotion, type AsideState } from './aside.js'
import type { SelectionAnchor } from './quote.js'
import { MarkdownView } from './MarkdownView.js'
import { EMPTY_VIEW, reduceEvents, type TranscriptView } from './transcript.js'
import type { TranscriptEvent } from '../../shared/ipc.js'

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
  /**
   * The aside, already opening.
   *
   * Handed in rather than started here, and that is the contract: a mount effect
   * runs twice in development, and while a leaked fork can be closed after the
   * fact a *sent prompt* is already paid for and already in the log. An
   * explanation sends on open, so the only safe place to open one is somewhere
   * that happens once per click.
   */
  opening: Promise<string>
  /** An explanation asks itself; a question waits for one to be typed. */
  purpose: 'question' | 'explanation'
  /**
   * The language main used, resolved once it has opened.
   *
   * A promise rather than a string because the renderer's own copy is read per
   * selection and can lag a settings change — and a card claiming Arabic while
   * the prompt and the log say French is worse than a card that says nothing for
   * a moment.
   */
  language: Promise<string>
  agent: string
  excerpt: string
  /** The passage, unclamped — the card measures itself and fits from it. */
  anchor: SelectionAnchor
  /** The parent's profile, offered as the promoted room's starting point. */
  profileId: string
  onClose: () => void
  /** Stages text into the composer — quoting, or taking the answer forward. */
  onStage: (text: string) => void
  /**
   * Opens this aside as a conversation of its own, under the chosen profile.
   *
   * The card does not do it itself: promotion ends with a room that has to
   * appear as a tab, and only the workspace knows how to do that.
   */
  onPromote: (asideId: string, profileId: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [question, setQuestion] = useState('')
  const [asideId, setAsideId] = useState<string | null>(null)
  const [language, setLanguage] = useState('')
  const [state, setState] = useState<AsideState>(EMPTY_ASIDE)
  const [asking, setAsking] = useState(false)
  /** What the promoted room would be allowed to do. Shown, and changeable. */
  const [profileId, setProfileId] = useState(props.profileId)
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    let live = true
    window.chorus.profiles().then(
      (list) => {
        if (live) setProfiles(list.map((p) => ({ id: p.id, name: p.name })))
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [])
  const input = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLDivElement>(null)
  /** Where it ends up, once it knows how big it is. */
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  /*
   * Something has to hold the caret.
   *
   * Asking focuses its box. Explaining has no box yet and the toolbar that was
   * clicked has gone, so focus would fall to the document — leaving Escape as
   * the only key that did anything and nothing for a screen reader to announce.
   * The card itself takes it instead, which is why it carries `tabIndex={-1}`.
   *
   * Deliberately not moved again when the follow-up box appears: the user is
   * reading an answer, and taking the caret mid-sentence is the same intrusion
   * as a card that resizes while it streams.
   */
  const focused = useRef(false)
  useEffect(() => {
    /*
     * Once, and only once the card has been measured.
     *
     * The measurement is what it waits for: until then the card is
     * `visibility: hidden`, and a hidden element cannot take focus — the call
     * silently did nothing and left the caret on the document.
     *
     * The latch is what stops it happening again. `at` is a fresh object on
     * every re-measure, and the card re-measures as the answer streams, so
     * without this the caret was pulled back each time — including the moment
     * the follow-up box appears, which is exactly when someone is reading.
     */
    if (at === null || focused.current) return
    focused.current = true
    if (props.purpose === 'explanation') card.current?.focus()
    else input.current?.focus()
  }, [props.purpose, at])

  /*
   * Adopt the boot the click started. Nothing is opened or closed here.
   *
   * Closing used to live in this effect's cleanup, which was wrong in a way only
   * development shows: React runs setup → cleanup → setup, so the simulated
   * cleanup closed the fork the *second* setup had just adopted. Asking then
   * reported that the aside had ended, and an explanation could be interrupted
   * after it had already sent and been billed.
   *
   * Opening and closing are one pair and belong to one owner. `Session` opens on
   * the click and closes when the card goes, which no amount of re-running an
   * effect can confuse.
   */
  useEffect(() => {
    let adopted = true
    props.opening.then(
      (id) => {
        if (adopted) setAsideId(id)
      },
      (e: unknown) => {
        if (!adopted) return
        props.onError(e instanceof Error ? e.message : String(e))
        props.onClose()
      }
    )
    void props.language.then((it) => {
      if (adopted) setLanguage(it)
    })
    return () => {
      adopted = false
    }
  }, [props])

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
          props.anchor,
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
  }, [props.anchor])

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
   * History first, then the live stream — the same order the main transcript
   * uses, and for the same reason.
   *
   * Subscribing alone loses anything appended between the fork opening and this
   * effect running, which is a real window: a question can be submitted the
   * moment the boot resolves, and a fast answer can begin before React has
   * committed `asideId`. Seeding from the log and then applying only events past
   * `lastSeq` means the overlap is harmless and nothing is missed.
   */
  useEffect(() => {
    if (asideId === null) return
    let view: TranscriptView = EMPTY_VIEW
    let live = false
    const pending: TranscriptEvent[] = []

    const apply = (events: readonly TranscriptEvent[]): void => {
      const fresh = events.filter((e) => e.seq > view.lastSeq)
      if (fresh.length === 0) return
      view = reduceEvents(view, fresh)
      setState(asideState(view))
    }

    const stop = window.chorus.onEvents((events) => {
      const mine = events.filter((e) => e.conversationId === asideId)
      if (mine.length === 0) return
      // Held until the history read lands, so a delta cannot be applied to an
      // empty view and then re-applied underneath it.
      if (!live) pending.push(...mine)
      else apply(mine)
    })

    window.chorus
      .history({ conversationId: asideId })
      .then((past) => {
        apply(past)
        live = true
        apply(pending)
        pending.length = 0
      })
      .catch(() => {
        // A history read that fails still leaves the live stream usable.
        live = true
        apply(pending)
        pending.length = 0
      })

    return stop
  }, [asideId])

  const ask = (): void => {
    const text = question.trim()
    if (text === '' || asking) return
    setAsking(true)
    setQuestion('')

    /*
     * Waits on the boot the click started. Usually resolved long before anyone
     * has typed — but a one-word follow-up can beat it, and that must queue
     * rather than race.
     */
    props.opening
      .then((id) => window.chorus.askAside({ asideId: id, question: text }))
      .catch((e: unknown) => {
        props.onError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setAsking(false)
      })
  }

  /**
   * Whether there is an answer region at all.
   *
   * An explanation has one from the first frame: it asked itself, so a card with
   * nothing in it would be a card that appears to have done nothing.
   */
  /*
   * The language belongs here rather than on the button. A constant label keeps
   * the offer a constant width — the pill already overflowed a narrow pane once
   * — and this is the moment the language actually matters.
   */
  const heading =
    props.purpose !== 'explanation'
      ? t('aside.heading', { agent: props.agent })
      : /*
         * A whole sentence while the language is still resolving, rather than
         * "Explaining in " with a hole where the answer goes. Main is
         * authoritative about which language was used and takes a moment to say
         * so; naming the renderer's own copy in the meantime would be the exact
         * staleness this indirection exists to prevent, just briefer.
         */
        language === ''
        ? t('aside.explainingPending')
        : t('aside.explaining', { language })

  const started =
    props.purpose === 'explanation' ||
    asking ||
    state.answer !== '' ||
    state.failed !== null ||
    state.working

  return (
    <div
      ref={card}
      className="quick-question"
      tabIndex={-1}
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
      aria-label={heading}
    >
      <header className="quick-head">
        <strong>{heading}</strong>
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
          /*
           * Present only once there is something to follow up on. An explanation
           * asks itself, so an empty box beside a pending answer would invite a
           * second question before the first had arrived.
           */
          /*
           * Keyed on there being something on screen rather than on the turn
           * having finished. `answered` waits for the provider to close the
           * turn, which can be seconds after the last word — long enough for the
           * box to look like it is never coming.
           */
          hidden={props.purpose === 'explanation' && state.answer === '' && state.failed === null}
          className="quick-input"
          rows={2}
          value={question}
          placeholder={state.answer === '' ? t('aside.placeholder') : t('aside.followUp')}
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

      {/*
        The other way out of a card: stop being a footnote and become a room.
        Everything above this point could only look; a promoted conversation can
        act, which is why the profile is chosen here and not inherited quietly.
      */}
      <div className="quick-promote">
        <label>
          <span className="sr-only">{t('aside.profileLabel')}</span>
          <select
            value={profileId}
            onChange={(event) => {
              setProfileId(event.target.value)
            }}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          disabled={asideId === null || state.working}
          onClick={() => {
            if (asideId !== null) props.onPromote(asideId, profileId)
          }}
        >
          {t('aside.openAsConversation')}
        </button>
      </div>
    </div>
  )
}
