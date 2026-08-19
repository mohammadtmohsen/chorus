import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  asideHeading,
  asideState,
  EMPTY_ASIDE,
  explanationPromotion,
  fitCard,
  opensWithATurn,
  promotion,
  recapPromotion,
  type AsidePurpose,
  type AsideState,
} from './aside.js'
import type { PaneAnchor } from './quote.js'
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
  /** An explanation or translation asks itself; a question waits to be typed. */
  purpose: AsidePurpose
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
  /**
   * The passage, unclamped, in **pane** coordinates — the card measures itself
   * and fits from it. Not the offer's anchor, which is relative to the scrolling
   * content; `openCard` converts.
   */
  anchor: PaneAnchor
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
  const [forwarding, setForwarding] = useState(false)
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
  /** The one region that scrolls, and whether it is still following its answer. */
  const answer = useRef<HTMLDivElement>(null)
  const following = useRef(true)
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
    if (opensWithATurn(props.purpose)) card.current?.focus()
    else input.current?.focus()
  }, [props.purpose, at])

  /*
   * Keeps the newest words in view while an answer arrives.
   *
   * The card scrolls inside itself — one region, capped — and until now it never
   * moved, so a reply longer than the box left you reading its first paragraph
   * while the rest arrived below the fold. That is the same failure the main
   * transcript had, and this is the same rule: follow, unless a gesture said to
   * read something else.
   *
   * `useLayoutEffect` rather than an effect, so the scroll lands in the same
   * frame the text does and there is no visible jump. Keyed on the turns and on
   * `working`, which together change on every delta.
   */
  useLayoutEffect(() => {
    const el = answer.current
    if (el === null || !following.current) return
    el.scrollTop = el.scrollHeight
  }, [state.turns, state.working])

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
    props.language.then(
      (it) => {
        if (adopted) setLanguage(it)
      },
      /*
       * A rejection handler that does nothing, which is the point.
       *
       * `language` is derived from the same promise as `opening`, so when an
       * open fails they both reject — and this one had only a fulfil handler,
       * so every failed aside threw an unhandled rejection into the console.
       * Two, in fact: the effect re-runs under StrictMode and attaching to an
       * already-rejected promise raises it again.
       *
       * Silent rather than reported, because `opening` above already reports it
       * and closes the card. Two dialogs for one failure is worse than none.
       */
      () => undefined
    )
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
          // The card floats over the pane and does not scroll with the
          // transcript, so its visible band is the pane, top to bottom.
          { width: pane.clientWidth, top: 0, bottom: pane.clientHeight },
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
   * Escape closes, and so does a click outside the card **in its own pane**.
   *
   * Capture phase for the key, so it beats anything the pane behind would do
   * with Escape. `mousedown` rather than `click` for the outside dismiss,
   * because a click that starts inside the card and ends outside it — dragging
   * to select the answer — is not an attempt to leave.
   *
   * **Scoped to the pane, not the document.** It used to close on any outside
   * mousedown, which meant clicking another pane, a tab, or the sidebar threw
   * away an answer you were part-way through reading — and the click that did it
   * was usually "let me look at that other thing for a second". Turning away from
   * a pane is not dismissing what is in it; clicking past the card inside the
   * pane still is, because there the card is what you are looking at.
   *
   * `offsetParent` is the pane, for the reason `place` gives above: the card is
   * absolutely positioned inside it, and asking the document for `.pane` finds
   * the wrong one in a split.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
    }
    const onDown = (e: MouseEvent): void => {
      const el = card.current
      if (el === null) return
      const target = e.target as Node
      if (el.contains(target)) return
      const pane = el.offsetParent
      if (pane instanceof HTMLElement && pane.contains(target)) props.onClose()
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
   * "I did not follow *that* either" — aimed at the aside's own last answer.
   *
   * The card is where you came to have something explained, so it is the one
   * place the same two actions must not be missing. A follow-up in this fork
   * rather than a fork of it: a nested aside would have to replace the panel
   * being read, throwing away the answer the person is in the middle of not
   * understanding.
   *
   * Nothing is sent but the id and which of the two to do. Main reads the aside's
   * latest reply out of the log and composes the prompt with the same builders
   * `openAside` uses, so the wording of an explanation cannot drift depending on
   * where it was asked for.
   */
  const restate = (purpose: 'explanation' | 'translation'): void => {
    if (asking) return
    setAsking(true)
    props.opening
      .then((id) => window.chorus.restateAside({ asideId: id, purpose }))
      .catch((e: unknown) => {
        props.onError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setAsking(false)
      })
  }

  /**
   * The same box, sent the other way: to the conversation instead of the fork.
   *
   * The reason the aside exists is to work out *whether* to go on — you ask where
   * things stand, read the answer, and conclude "run the tests" or "hold on".
   * Until now that conclusion had nowhere to go but a retype.
   *
   * **Sent rather than staged, which is the opposite of the button below it**,
   * and the difference is what is travelling. `takeForward` stages the *agent's*
   * answer, because its wording has to admit it came from somewhere the receiving
   * agent cannot remember, and nobody should discover that after it went. This
   * sends words you typed a second ago into a box you are looking at. Staging
   * them would ask you to approve your own sentence.
   *
   * The card closes and the fork does not. Having decided, what you want next is
   * the conversation you decided about — but the aside stays alive behind it, so
   * the obvious follow-up ("did that work?") is still one click away rather than
   * a new fork with none of the context.
   */
  const forward = (): void => {
    const text = question.trim()
    if (text === '' || forwarding) return
    setForwarding(true)
    setQuestion('')

    // Waits on the same boot `ask` does: the id may not exist yet.
    props.opening
      .then((id) => window.chorus.forwardAside({ asideId: id, directive: text }))
      .then(() => {
        props.onClose()
      })
      .catch((e: unknown) => {
        props.onError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setForwarding(false)
      })
  }

  /*
   * The language belongs here rather than on the button. A constant label keeps
   * the offer a constant width — the pill already overflowed a narrow pane once
   * — and this is the moment the language actually matters.
   */
  const title = asideHeading(props.purpose, language, props.agent)
  const heading = t(title.key, title.vars)

  /**
   * Whether there is an answer region at all.
   *
   * A card that asked itself has one from the first frame: there is already a
   * turn in flight, so an empty card would be one that appears to have done
   * nothing. (This comment described `started` and sat above `heading`, two
   * declarations away from what it explained.)
   */
  const started =
    opensWithATurn(props.purpose) ||
    asking ||
    state.answer !== '' ||
    state.failed !== null ||
    state.working

  return (
    <div
      ref={card}
      /*
       * `started` sizes the card as well as filling it. Until there is an answer
       * the card fits its content; from the first frame there is one it stands at
       * its full height, so the answer arrives into a box that has already
       * finished moving. The `ResizeObserver` above re-fits it on that one step.
       */
      className={[
        'quick-question',
        ...(started ? ['quick-question--answering'] : []),
        // A board wraps badly at an explanation's width; see the rule in
        // `styles.css`. The `ResizeObserver` re-fits on the width change.
        ...(props.purpose === 'recap' ? ['quick-question--recap'] : []),
      ].join(' ')}
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

      {/*
        The passage, so the card says what it is about without the transcript.

        Two purposes are the exception and for one reason: their excerpt is a
        whole reply, carried so main can authenticate the source rather than to
        be read. A recap's is the reply being escaped, and showing it would put
        the long scattered answer back on screen directly above the board written
        to replace it. An explanation's is the reply the card is anchored *under*
        — the words are inches away, and repeating them would push the
        explanation, which is the only new thing here, off the bottom.

        Translation and a typed question still show it, because for those the
        excerpt really is a passage somebody chose.
      */}
      {props.purpose !== 'recap' && props.purpose !== 'explanation' && (
        <blockquote className="quick-excerpt">{props.excerpt}</blockquote>
      )}

      {/*
        The exchange, both sides, oldest first.

        It used to be one `MarkdownView` over every agent reply joined together,
        which is why a second question read as though it had overwritten the
        first answer: there was nowhere for the question to go and no boundary
        between the replies. Rows keyed by the message's own key, so a streaming
        reply updates in place rather than being remounted under a new index —
        the same reason the main transcript keys on `key` and not on position.

        Still not the main transcript, and the difference is deliberate: no
        avatars, no timestamps, no tool rows. A card anchored to a passage shows
        who spoke and what they said, and nothing that would turn a footnote into
        a second conversation competing with the one behind it.
      */}
      {started && (
        <div
          className="quick-answer"
          ref={answer}
          /*
           * The same rule the transcript follows, for the same measured reason.
           *
           * A card whose answer did not follow left you reading the top of a
           * reply while the rest arrived below the fold — the failure the main
           * transcript had and fixed. What counts as "I want to read something
           * else" is a gesture the app cannot manufacture: a wheel, a trackpad
           * swipe, a touch drag, a scrolling key. Position is what *resumes*
           * following, because arriving back at the bottom is unambiguous
           * however you got there.
           *
           * Reading `scroll` alone would not work here either: every streamed
           * delta grows the region and fires one, so the card would stop
           * following itself.
           */
          onWheel={(e) => {
            if (e.deltaY < 0) following.current = false
          }}
          onTouchMove={() => {
            const el = answer.current
            if (el === null) return
            if (el.scrollHeight - el.scrollTop - el.clientHeight > 24) following.current = false
          }}
          onKeyDown={(e) => {
            if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) following.current = false
          }}
          onScroll={(e) => {
            const el = e.currentTarget
            if (el.scrollHeight - el.scrollTop - el.clientHeight <= 24) following.current = true
          }}
        >
          {state.turns.map((turn) => (
            /*
              The wrapper takes a direction too, not only the blocks inside it.

              `.quick-turn` carries the border that tells the two voices apart,
              on its *inline-start* edge — which is only the correct side if the
              element knows which way its own text runs. Without this an Arabic
              turn kept its rule on the left, against the text's own margin.
            */
            <div key={turn.key} className="quick-turn" data-actor={turn.actor} dir="auto">
              <MarkdownView source={turn.text} />
            </div>
          ))}
          {state.failed !== null && <p className="notice notice--bad">{state.failed}</p>}
          {/*
            The dots stand in for a reply that has not started, and continue
            under one that has — that line is for the wait before anything
            appears, and repeating the expectation after it would be noise.
          */}
          {(state.turns.length === 0 || state.working) && state.failed === null && (
            <Thinking agent={props.agent} />
          )}
        </div>
      )}

      {/*
        The two restate actions, above the box rather than beside Send.

        Beside the box they would read as ways of sending what you typed, which
        is what they are not: they act on the answer above and ignore the box
        entirely. Above it they read as the last thing offered about the reply,
        which is what they are — the same position, and the same two words, as
        the row under a question card.

        Only once an answer exists. Offering to explain a reply that has not
        arrived is offering to explain nothing, and `state.answer` is the same
        signal the follow-up box already keys its own appearance on.

        `Ask about this` is deliberately absent: it is the box directly below,
        and a button that duplicates the control under it teaches that one of
        them does something else.
      */}
      {state.answer !== '' && language !== '' && state.failed === null && (
        <div className="quick-restate">
          <button
            type="button"
            className="entry-action"
            data-aside-action="explain"
            disabled={asking || state.working}
            onClick={() => {
              restate('explanation')
            }}
          >
            {t('conversation.explainSimply')}
          </button>
          {/*
            Not on a card that already answers in your language.

            Measured rather than reasoned about: translating an explanation into
            the language it was written in came back `النص مكتوب بالعربية أصلاً`
            — "the text is already in Arabic". The agent handles it gracefully,
            which is exactly why it would have survived unnoticed as a button
            that costs a turn to tell you it had nothing to do.

            A question or a recap answers in whatever the agent chose, so there
            it is worth offering.
          */}
          {props.purpose !== 'explanation' && props.purpose !== 'translation' && (
            <button
              type="button"
              className="entry-action"
              data-aside-action="translate"
              disabled={asking || state.working}
              onClick={() => {
                restate('translation')
              }}
            >
              {t('conversation.translateThis')}
            </button>
          )}
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
          hidden={opensWithATurn(props.purpose) && state.answer === '' && state.failed === null}
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
        {/*
          Enabled by what is in the box, not by whether the answer arrived.

          Every other control here waits on `answered`, because every other one
          carries the agent's words. This carries yours — and "hold on" is a
          decision you are entitled to reach halfway through a reply you have
          already seen enough of. Gating it on the turn finishing would make the
          one instruction that means *stop* the one you have to wait for.
        */}
        <button
          type="button"
          className="btn"
          disabled={question.trim() === '' || forwarding}
          onClick={forward}
        >
          {t('aside.sendToConversation')}
        </button>
        {/*
          Quoting is the passage plus the answer, so the two purposes whose
          passage is a whole reply have nothing to quote. A recap's is the reply
          being escaped; an explanation's is the reply this card is anchored
          under. In both cases the button beside this one already carries the
          only new thing there is.
        */}
        {props.purpose !== 'recap' && props.purpose !== 'explanation' && (
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
        )}
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
            props.onStage(staged(props.purpose, props.agent, props.excerpt, state.answer))
            props.onClose()
          }}
        >
          {t(props.purpose === 'recap' ? 'aside.useRecap' : 'aside.takeForward')}
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

/**
 * What "take this forward" writes into the composer, per purpose.
 *
 * Lifted out of the handler because it is now three branches rather than two,
 * and because the rule behind them is one sentence worth stating once: **quote
 * the excerpt only when the excerpt is a passage somebody chose.** A recap and
 * an explanation are both about a whole reply the agent already has in its
 * context, so quoting it back is noise the user has to delete.
 *
 * A switch rather than a ternary chain, for the reason `asideHeading` gives: the
 * chain it replaced would have read "everything that is not a recap is a
 * question", which is how a fourth purpose gets the wrong wording silently.
 */
function staged(purpose: AsidePurpose, agent: string, excerpt: string, answer: string): string {
  switch (purpose) {
    case 'recap':
      return recapPromotion(agent, answer)
    case 'explanation':
      return explanationPromotion(agent, answer)
    case 'question':
    case 'translation':
      return promotion(agent, excerpt, answer)
  }
}
