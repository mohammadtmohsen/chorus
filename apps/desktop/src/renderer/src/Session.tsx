import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Attachment } from './Attachments.js'
import { Composer, type ComposerHandle, type ComposerState } from './Composer.js'
import { Entry } from './Entry.js'
import { HandoffComposer, type HandoffDraft } from './HandoffComposer.js'
import { anchorFor } from './quote.js'
import type { IdeContextPush } from '../../shared/ipc.js'
import { ReviewPanel } from './ReviewPanel.js'
import { SummaryPanel } from './SummaryPanel.js'
import {
  answersThinking,
  EMPTY_VIEW,
  reduceEvents,
  type PendingApproval,
  type PendingQuestion,
  type QuestionField,
  type TranscriptMessage,
  type TranscriptView,
} from './transcript.js'

/**
 * Things a click must not be taken away from.
 *
 * Anything focusable does its own job with the caret, and the two blocking
 * cards are the sharp case: they focus a control so Enter can answer them, and
 * a click landing anywhere inside one would hand the caret straight back to the
 * composer and undo that.
 */
const FOCUS_KEEPS_ITS_OWN =
  'button, a, input, textarea, select, summary, [role="button"], [contenteditable], .approval, .question'

export type AgentId = 'codex' | 'claude'
/** Every agent Chorus knows how to seat, present or not. */
export const ALL_AGENTS: AgentId[] = ['codex', 'claude']

export interface SessionInfo {
  readonly conversationId: string
  readonly participants: AgentId[]
  readonly cwd: string
  readonly profileId: string
  readonly title: string
}

/** Renderer state that survives closing or backgrounding a tab. */
export interface SessionCarry {
  readonly view: TranscriptView
  readonly draft: string
  readonly attached: readonly Attachment[]
  readonly following: boolean
  readonly scrollTop: number
  readonly ideIncluded: boolean
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
  /** Set when the sidenav asked for a panel this pane owns. */
  panelRequest?: 'review' | 'summary' | undefined
  onPanelOpened: () => void
  /*
   * Undefined is spelled out because `exactOptionalPropertyTypes` is on: the
   * caller reads this out of a Map, and a miss is a real value it has to be
   * allowed to pass rather than an argument it must remember to omit.
   */
  carry?: SessionCarry | undefined
  onCarry: (conversationId: string, carry: SessionCarry) => void
  /**
   * Whether this pane owns the caret.
   *
   * Only the active pane may take focus on its own. Everything that grabs it —
   * an approval, a question, the composer after a queue clears — is worth doing
   * in the pane you are working in and is theft anywhere else.
   */
  active: boolean
  onActivate: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { conversationId, participants, cwd } = props.session
  const [view, setView] = useState<TranscriptView>(props.carry?.view ?? EMPTY_VIEW)
  /** The composer holds the draft now; the pane only reads it on unmount. */
  const composer = useRef<ComposerHandle | null>(null)
  /** Where the composer leaves its draft, so the pane can carry it out. */
  const box = useRef<ComposerState>({
    draft: props.carry?.draft ?? '',
    attached: [...(props.carry?.attached ?? [])],
    ideIncluded: props.carry?.ideIncluded ?? true,
  })
  const [error, setError] = useState<string | null>(null)
  const [handoff, setHandoff] = useState<HandoffDraft | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [summarising, setSummarising] = useState(false)

  /*
   * A panel asked for from outside — the sidenav card, which has the buttons
   * but not the panels.
   *
   * The panels live in here because they are about one conversation and read
   * its transcript, and a card can be showing a session that is not mounted at
   * all. So the card activates the session first and leaves a request; this
   * picks it up on the mount that follows and clears it, so it fires once.
   */
  useEffect(() => {
    if (props.panelRequest === undefined) return
    if (props.panelRequest === 'review') setReviewing(true)
    if (props.panelRequest === 'summary') setSummarising(true)
    props.onPanelOpened()
  }, [props])
  /** A passage selected in this pane's transcript, and where to offer to quote it. */
  const [selected, setSelected] = useState<{
    text: string
    left: number
    top: number
    placement: 'above' | 'below'
  } | null>(null)
  /* The cast, the folder, the profile, Restart and End all live on the
     session's card in the sidenav now, along with the state each of them needs
     while it is mid-flight. */
  /** True while a file from outside is over this pane. */
  const [fileOver, setFileOver] = useState(false)
  /** Files waiting to be sent, shown above the box rather than typed into it. */

  /** Something to send: what the one button below decides its job from. */
  /** The pane itself, so dragging its bar carries the whole thing. */
  const pane = useRef<HTMLElement | null>(null)
  const score = useRef<HTMLDivElement | null>(null)
  /** The growing part, which is what a resize observer has to watch. */
  const transcript = useRef<HTMLDivElement | null>(null)
  /** The current turn — what you last said and whatever is answering it. */
  const turn = useRef<HTMLDivElement | null>(null)
  /** Empty space at the foot of the current turn, so its question can reach the top. */
  const tail = useRef<HTMLDivElement | null>(null)
  /** Read once: whether this pane was the active one at the moment it mounted. */
  const activeOnMount = useRef(props.active)

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
     *
     * Still only if it is the active one. Restoring four panes at launch mounts
     * four of these at once, and without the guard the caret landed in whichever
     * happened to finish last rather than in the pane you are looking at.
     */
    if (!activeOnMount.current) return
    composer.current?.focus()
  }, [])

  useEffect(() => {
    window.chorus
      .history({
        conversationId,
        ...(view.lastSeq > 0 ? { afterSeq: view.lastSeq } : {}),
      })
      .then((history) => {
        setView((current) => reduceEvents(current, history))
      })
      .catch(fail(setError))
  }, [conversationId])

  /**
   * Whether the transcript is following what is being written.
   *
   * True while the view is at the bottom, false the moment you scroll up — and
   * true again when you come back down. A transcript that yanks you to the
   * bottom while you are reading something further up is worse than one that
   * never follows at all, and one that stops following for good is worse than
   * either.
   */
  const following = useRef(props.carry?.following ?? true)
  /** Where the last scroll left us, so the next one can be told which way it went. */
  const wasAt = useRef(0)

  /**
   * Makes the current turn a view tall, however little has been said in it.
   *
   * Two things need the height, and both need it *inside* the turn. A pinned
   * header can only travel as far as the block it belongs to, so a turn no
   * taller than its own question gives the pin nowhere to go. And there has to
   * be something below to scroll, or a question asked at the foot of a long
   * history stays where it landed until the answer happens to be tall enough to
   * lift it — which reads as the layout waiting for the agent's permission.
   *
   * Spare rather than fixed: exactly what the turn is short of, so it is gone
   * the moment a reply fills the view. The rail is pulled up by the same amount,
   * because a line drawn down through deliberate emptiness is a line drawn
   * through nothing.
   */
  const makeRoom = useCallback(() => {
    const el = score.current
    const content = transcript.current
    const spacer = tail.current
    if (el === null || content === null) return
    if (spacer === null) {
      content.style.removeProperty('--spare')
      return
    }
    const block = turn.current
    // The turn's own height, less whatever room was added last time — measuring
    // the block whole would feed the spacer its own size.
    const said = block === null ? 0 : block.offsetHeight - spacer.offsetHeight
    /*
     * The scroller's own bottom padding counts as room.
     *
     * Without this the turn was a whole view tall *and* the padding sat under
     * it, so the bottom of the scroll range fell a padding's width past the
     * point where the question reaches the top — and the reader, sitting at the
     * bottom, had that much of the answer's first line hidden behind the pinned
     * header. On a short reply that is most of the only line there is.
     *
     * Read each time rather than cached: it is 21px normally and 18px at phone
     * width, and a stale one would put the slice back at one size or the other.
     */
    const below = parseFloat(getComputedStyle(el).paddingBottom) || 0
    const spare = Math.max(0, el.clientHeight - below - said)
    spacer.style.height = `${String(spare)}px`
    content.style.setProperty('--spare', `${String(spare)}px`)
  }, [])

  useEffect(() => {
    const el = score.current
    const content = transcript.current
    if (el === null || content === null) return

    /*
     * Watching the content grow, not the message count.
     *
     * Text types itself out character by character, so the thing that changes is
     * the height of a message already on screen — no new entry, no new event, no
     * state change in this component to hang an effect on. The observer sees
     * exactly what a reader sees: the page got taller.
     *
     * `scrollTop` rather than `scrollIntoView`: the latter walks every scrollable
     * ancestor and would drag the whole grid around when panes sit side by side.
     */
    const follow = new ResizeObserver(() => {
      // Before following, not after: the spare room decides where the bottom is.
      makeRoom()
      if (following.current) el.scrollTop = el.scrollHeight
    })
    follow.observe(content)
    // The pane itself, because how much room the turn is short of is measured
    // against the view — and a window resize changes that without changing a word.
    follow.observe(el)
    return () => {
      follow.disconnect()
    }
  }, [makeRoom])

  /** Agents already writing: their words say more than a label would. */
  const streaming = new Set(
    view.messages.filter((m) => m.status === 'streaming').map((m) => m.actor)
  )

  /*
   * The transcript is split at the last thing you said.
   *
   * Everything before it is history; from it down is the current turn — the
   * question and whatever is being made of it. The division is derived from the
   * messages rather than stored, so a conversation restored from the log finds
   * its current turn the same way a live one does, with nothing extra persisted.
   */
  /**
   * What the user said before, oldest first, for the composer's recall.
   *
   * Derived from the same reduced transcript the pane draws, so it needs no
   * storage of its own and cannot disagree with what is on screen.
   */
  const spoken = view.messages
    .filter((m) => m.actor === 'user' && m.kind === 'message')
    .map((m) => m.text)

  const turnAt = view.messages.findLastIndex((m) => m.actor === 'user' && m.kind === 'message')
  const currentTurn = turnAt === -1 ? undefined : view.messages[turnAt]
  const turnKey = currentTurn?.key ?? null

  useEffect(() => {
    /*
     * A new turn takes the top, whether or not the page grew.
     *
     * Following is driven by the transcript getting taller, and a short question
     * asked below a long answer can add less height than the spare room it takes
     * away — the observer sees nothing, and the message you just sent stays
     * halfway up. Keyed on which message the turn is, so this fires once per
     * question rather than on every token of the reply.
     */
    const el = score.current
    if (el === null || turnKey === null) return
    makeRoom()
    if (following.current) el.scrollTop = el.scrollHeight
  }, [turnKey, makeRoom])

  /**
   * Offers to quote whatever was just selected in this pane's transcript.
   *
   * Read on mouse-up and key-up rather than from `selectionchange`, which fires
   * on every pixel of a drag: the offer should appear when you finish choosing a
   * passage, not follow the pointer while you are still choosing it.
   *
   * Scoped to this pane's scroller, so selecting in one conversation never
   * offers to quote it into another's composer, and selecting the chrome — a
   * title, a path, the composer's own text — offers nothing.
   */
  const readSelection = useCallback(() => {
    const selection = window.getSelection()
    const scoreEl = score.current
    const paneEl = pane.current
    if (selection === null || selection.isCollapsed || scoreEl === null || paneEl === null) {
      setSelected(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!scoreEl.contains(range.commonAncestorContainer)) {
      setSelected(null)
      return
    }
    const text = selection.toString().trim()
    if (text === '') {
      setSelected(null)
      return
    }
    const at = anchorFor(range.getBoundingClientRect(), paneEl.getBoundingClientRect())
    setSelected(at === null ? null : { text, ...at })
  }, [])

  useEffect(() => {
    /*
     * A selection made anywhere else takes the offer away.
     *
     * `selectionchange` is the only event that fires when a click in another
     * pane collapses this one's selection, so it is worth listening to for the
     * clearing half even though the positioning half ignores it.
     */
    const onChange = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) setSelected(null)
    }
    document.addEventListener('selectionchange', onChange)
    return () => {
      document.removeEventListener('selectionchange', onChange)
    }
  }, [])

  /** Puts the passage in the draft and leaves the caret under it, ready for the question. */
  const quoteSelection = useCallback(() => {
    const passage = selected
    if (passage === null) return
    composer.current?.quote(passage.text)
    setSelected(null)
    window.getSelection()?.removeAllRanges()
  }, [selected])

  /*
   * Sent, and nothing has come back yet.
   *
   * `working` is driven by `turn.started`, which the agent emits once it has
   * actually begun — and starting a session, spinning up a CLI and accepting the
   * message all happen first. For as long as that took, the transcript showed
   * your message and then nothing, which is indistinguishable from a message
   * that went nowhere. This fills exactly that gap and gets out of the way the
   * moment the agent speaks for itself.
   */
  const [awaiting, setAwaiting] = useState(false)

  useEffect(() => {
    /*
     * Cleared by the agent starting, or by anything the system had to say —
     * an error or a refusal arrives as a notice, and the row must not outlive
     * the turn it was waiting for.
     */
    if (view.working.length === 0 && view.messages.at(-1)?.actor !== 'system') return
    setAwaiting(false)
  }, [view.working.length, view.messages])

  /*
   * What VS Code is showing for *this* pane's project.
   *
   * Metadata only: a path already relative to this conversation's cwd, and a
   * line range. No source text is here and none has crossed yet — that happens
   * once, when Send is pressed.
   */
  const [ide, setIde] = useState<IdeContextPush | null>(null)

  /*
   * What must survive the pane being unmounted.
   *
   * The transcript half is mirrored on every render because it changes with
   * every event; the composer half is *read* on the way out instead, which is
   * what lets the draft live in the composer and a keystroke repaint a textarea
   * rather than a conversation.
   */
  const latest = useRef<Omit<SessionCarry, 'draft' | 'attached' | 'ideIncluded'>>({
    view,
    following: following.current,
    scrollTop: props.carry?.scrollTop ?? 0,
  })
  latest.current = {
    view,
    following: following.current,
    scrollTop: score.current?.scrollTop ?? latest.current.scrollTop,
  }

  useEffect(
    () => () => {
      props.onCarry(conversationId, { ...latest.current, ...box.current })
    },
    [conversationId, props.onCarry]
  )

  useLayoutEffect(() => {
    const scrollTop = props.carry?.scrollTop
    if (scrollTop === undefined || score.current === null) return
    score.current.scrollTop = scrollTop
    wasAt.current = scrollTop
  }, [])

  useEffect(() => {
    return window.chorus.onIdeContext((payload) => {
      // Main scopes this per conversation already; the pane checks anyway,
      // because a pane showing another project's file is the one failure this
      // feature must never have.
      if (payload.conversationId === conversationId) setIde(payload)
    })
  }, [conversationId])

  const decide = useCallback(
    (
      approval: PendingApproval,
      outcome: 'allow' | 'deny',
      scope: 'once' | 'session' | 'always' = 'once'
    ) => {
      window.chorus
        .decideApproval({
          conversationId,
          agentId: approval.agentId === 'claude' ? 'claude' : 'codex',
          approvalId: approval.approvalId,
          outcome,
          scope,
        })
        .catch(fail(setError))
    },
    [conversationId]
  )

  /** The one being asked about. The rest of the queue waits behind it. */
  const current = view.approvals[0]
  const queued = view.approvals.length

  /*
   * The head of the question queue, if the agent that asked is still one we can
   * answer. `actor` spans the whole cast including `system`, and only a real
   * agent has a session to send an answer back to.
   */
  const asking = view.questions.find((q) => q.agentId === 'codex' || q.agentId === 'claude')

  const answerQuestion = useCallback(
    (
      request: PendingQuestion,
      outcome: 'answered' | 'cancel',
      answers: { questionId: string; values: string[] }[]
    ) => {
      if (request.agentId !== 'codex' && request.agentId !== 'claude') return
      window.chorus
        .answerQuestion({
          conversationId,
          agentId: request.agentId,
          userInputId: request.userInputId,
          outcome,
          answers,
        })
        .catch(fail(setError))
    },
    [conversationId]
  )

  /*
   * When the last approval clears, the caret goes back to the composer.
   *
   * The card took focus to be answerable by Enter; handing it back means a
   * burst of approvals ends where you were before it started, rather than on a
   * button that has just been unmounted — which drops focus to `body` and
   * leaves the next keystroke going nowhere.
   */
  const hadApprovals = useRef(false)
  useEffect(() => {
    if (queued > 0) {
      hadApprovals.current = true
      return
    }
    if (!hadApprovals.current) return
    hadApprovals.current = false
    // Only where you are working. In a background pane this used to reach across
    // and pull the caret out of the sentence you were typing.
    if (props.active) composer.current?.focus()
  }, [queued, props.active])

  /**
   * One entry, drawn the same wherever it falls.
   *
   * Takes its index in the whole transcript rather than in the slice it is being
   * drawn from: whether a message answers a block of thinking is a fact about
   * the pair, and splitting the list at the current turn must not make the first
   * message after the split forget what came before it.
   */
  /*
   * The answer the latest finished turn arrived at.
   *
   * Only while nothing is working: mid-turn there is no final message, and
   * marking the newest one as final would move the mark down the transcript
   * every time the agent spoke again. Only the newest, too — every agent
   * message is some turn's conclusion, so marking them all marks nothing.
   */
  const finalKey =
    view.busy || view.messages.length === 0
      ? null
      : (view.messages.findLast(
          (m) => (m.actor === 'codex' || m.actor === 'claude') && m.kind === 'message'
        )?.key ?? null)

  const entry = (message: TranscriptMessage, index: number): React.JSX.Element => (
    <Entry
      key={message.key}
      message={message}
      final={message.key === finalKey}
      answersThinking={answersThinking(view.messages[index - 1], message)}
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
  )

  /*
   * Who is thinking, directly under the question they were asked.
   *
   * The dots in the bar have always breathed for whoever is mid-turn, but they
   * are chrome — small, at the edge, and easy to miss while reading. This sits
   * where the answer will appear, in the voice's own colour, so "is anything
   * happening, and from whom" is answered where you are already looking. Two
   * agents waiting stack, in the order the conversation put them in.
   *
   * Only until the first words arrive: once an agent is writing, its text is a
   * better indicator than any label, and leaving both would say the same thing
   * twice.
   */
  /*
   * Who will answer is not ours to say.
   *
   * Mentions are routed by the orchestrator, so at this moment the pane knows a
   * message went out and nothing more. With one agent in the room there is no
   * ambiguity and it is named; with two, naming either would be a guess, and a
   * guess about who is working is worse than an honest unattributed wait.
   */
  const soleAgent = participants.length === 1 ? participants[0] : undefined
  const waitingRow =
    awaiting && view.working.length === 0 ? (
      <article key="awaiting" className={`entry entry--${soleAgent ?? 'system'} entry--thinking`}>
        <span className="tick" aria-hidden="true" />
        <span className="speaker">{soleAgent ?? ''}</span>
        <p className="said thinking" role="status">
          <span className="thinking-word">{t('conversation.waiting')}</span>
          <span className="thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </p>
      </article>
    ) : null

  const thinking = view.working
    .filter((agent) => !streaming.has(agent))
    .map((agent) => (
      <article key={`thinking:${agent}`} className={`entry entry--${agent} entry--thinking`}>
        <span className="tick" aria-hidden="true" />
        <span className="speaker">{agent}</span>
        <p className="said thinking" role="status">
          <span className="thinking-word">{t('conversation.thinking')}</span>
          <span className="thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </p>
      </article>
    ))

  return (
    <section
      ref={pane}
      className="pane"
      // Which conversation this pane is, for anything outside React that needs
      // to address it — a driver, a bug report, the element inspector.
      data-conversation={conversationId}
      data-active={props.active}
      aria-label={t('conversation.sessionLabel', { path: cwd })}
      /*
       * Touching a pane makes it yours, before anything else happens.
       *
       * `pointerdown` rather than `click`: it lands before focus moves, so a
       * card that focuses itself on the way in is already doing so in a pane
       * that counts as active. Capture, so it still fires when the press was on
       * a control that stops propagation.
       */
      onPointerDownCapture={props.onActivate}
      // Tab, or a click the pointer handler did not see, is also a claim.
      onFocusCapture={props.onActivate}
      onClick={(e) => {
        /*
         * Clicking the body puts the caret in the composer — but not at the
         * cost of what the click was actually for.
         *
         * Two things are left alone. A control does its own job, and yanking
         * focus off an approval's Allow button or a question's options would
         * make the card unanswerable by keyboard the moment you clicked it. And
         * a selection is the beginning of quoting a passage; stealing the caret
         * mid-drag would empty it before the offer could be taken.
         */
        if (e.target instanceof Element && e.target.closest(FOCUS_KEEPS_ITS_OWN) !== null) return
        const selection = window.getSelection()
        if (selection !== null && !selection.isCollapsed) return
        composer.current?.focus()
      }}
      onDragOver={(e) => {
        // Workspace tabs use pointer events. HTML drag here now means a file
        // from outside the app, and remains scoped to the composer.
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setFileOver(true)
        }
      }}
      onDragLeave={(e) => {
        // Only when the pointer actually left the pane, not on every child.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileOver(false)
      }}
      onDrop={(e) => {
        setFileOver(false)
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault()
          void composer.current?.attach(e.dataTransfer)
          return
        }
      }}
      data-file-over={fileOver}
    >
      {error !== null && (
        <p className="notice notice--bad" role="alert">
          {error}
        </p>
      )}

      <div
        className="score"
        ref={score}
        aria-label={t('conversation.transcript')}
        onMouseUp={readSelection}
        onKeyUp={readSelection}
        onScroll={(e) => {
          const el = e.currentTarget
          // "At the bottom" with room to spare: a couple of pixels of rounding,
          // or a scroll that lands just short, should still count as following.
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 32
          // A pixel of slack, because a scroll that lands a hair short of where
          // it started is rounding, not a decision.
          const wentUp = el.scrollTop < wasAt.current - 1
          wasAt.current = el.scrollTop

          /*
           * Following stops when *you* scroll up, not merely when the bottom
           * gets further away.
           *
           * Measuring the distance alone read a growing transcript as a reader
           * who had wandered off: the page gains an entry between a scroll being
           * written and its event being delivered, so the handler saw a
           * three-line gap that nobody had opened, gave up following, and left
           * the view one entry short of the bottom for the rest of the
           * conversation. Since the current turn is pinned by being scrolled to,
           * that also stranded the question halfway up the pane.
           *
           * Coming back to the bottom always resumes, which is what makes this
           * safe: a shrinking transcript clamps the scroll down by itself, and
           * that lands at the bottom rather than counting as a scroll upward.
           */
          if (atBottom) following.current = true
          else if (wentUp) following.current = false
          // The offer is anchored to a rectangle that just moved. Re-reading it
          // on every scroll frame would fight the scroll; dropping it is honest
          // and the selection itself survives, so it can be re-made.
          if (selected !== null) setSelected(null)
        }}
      >
        <div className="score-content" ref={transcript}>
          {/*
            Inside the entries, not beside them.
            
            Positioned against the scroller it was measured from the padding
            edge, while every dot is measured from its own entry — so the line
            sat 15px to the left of the dots it was supposed to run through, and
            carried on into empty space below the last message. Sharing an origin
            with the entries fixes both: it lines up, and it is exactly as long as
            the conversation.
          */}
          <div className="rail" aria-hidden="true" />

          {/* History: everything said before the question now being answered. */}
          {(currentTurn === undefined ? view.messages : view.messages.slice(0, turnAt)).map(entry)}

          {currentTurn === undefined ? (
            // Nothing has been asked yet, so there is no turn to pin — an agent
            // can still be working, and says so at the foot as it always did.
            <>
              {thinking}
              {waitingRow}
            </>
          ) : (
            /*
              The current turn, with its question held at the top.

              What you asked is the thing the whole reply is measured against, and
              a long answer used to push it out of the window within a paragraph —
              leaving a screen of prose with no visible sign of what it was for.
              Pinned, it stays the heading of its own answer until you ask the next
              thing, which is when the heading should change.
            */
            <div className="turn" ref={turn}>
              <div className="turn-head" data-turn={currentTurn.key}>
                {/* The rail passes behind an opaque header, so the header carries
                    its own length of it — otherwise the line breaks at the pin. */}
                <div className="rail rail--turn" aria-hidden="true" />
                {entry(currentTurn, turnAt)}
                {thinking}
                {waitingRow}
              </div>
              {view.messages.slice(turnAt + 1).map((m, i) => entry(m, turnAt + 1 + i))}
              {/*
                Room for the question to rise into, and for the pin to hold it
                there. Inside the turn because a pinned header travels only
                within its own block; sized in `makeRoom`, which is the only
                thing that knows how much of the view is still empty.
              */}
              <div className="turn-tail" ref={tail} aria-hidden="true" />
            </div>
          )}
        </div>
      </div>

      {/*
        Offered where the passage is, not in a toolbar.

        `onMouseDown` with `preventDefault` rather than `onClick` alone: a
        mousedown on a button clears the selection before the click lands, so by
        the time the handler ran there would be nothing left to quote.
      */}
      {selected !== null && (
        <button
          type="button"
          className="quote-offer"
          data-placement={selected.placement}
          style={{ left: `${String(selected.left)}px`, top: `${String(selected.top)}px` }}
          onMouseDown={(e) => {
            e.preventDefault()
          }}
          onClick={quoteSelection}
        >
          {t('conversation.askAboutThis')}
        </button>
      )}

      {reviewing && (
        <ReviewPanel
          conversationId={conversationId}
          onClose={() => {
            setReviewing(false)
          }}
          onError={setError}
        />
      )}

      {summarising && (
        <SummaryPanel
          conversationId={conversationId}
          onClose={() => {
            setSummarising(false)
          }}
          onAsk={(prompt) => {
            // An ordinary message, deliberately. Chorus has no side-channel to
            // an agent, so a summary asked for privately would be a reply
            // arriving from nowhere — and the answer is worth keeping in the
            // room anyway.
            following.current = true
            window.chorus.sendMessage({ conversationId, text: prompt }).catch(fail(setError))
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
        {/*
         * One at a time, oldest first.
         *
         * Approvals arrive in a burst — an agent asks for four commands in a
         * row — and stacking all four leaves you reading a wall of them,
         * deciding the wrong one, with the buttons of the next three a Tab
         * away. Showing only the head of the queue makes the decision singular
         * and lets the Allow button take focus without ambiguity about which
         * request Enter would answer. The rest are counted, not drawn; the next
         * one takes its place the moment this one is decided.
         */}
        {current !== undefined && (
          <ApprovalCard
            key={current.approvalId}
            approval={current}
            waiting={view.approvals.length - 1}
            active={props.active}
            onAllow={() => {
              decide(current, 'allow')
            }}
            onAllowAlways={() => {
              /*
               * `session` is a lie for an outward-facing kind, so it says
               * `always` there instead.
               *
               * An MCP tool call may never be auto-decided, which means a session
               * grant for one was silently refused and the same tool asked again
               * on the very next call. The wider button either widens something
               * or it should not be offered; for these it now remembers the
               * answer past a restart, which is the only scope that changes
               * anything at all.
               */
              decide(current, 'allow', current.kind === 'mcpToolCall' ? 'always' : 'session')
            }}
            onDeny={() => {
              decide(current, 'deny')
            }}
          />
        )}

        {/*
          Below the approval, and for the same reason it is drawn one at a time:
          two blocking cards at once make you answer whichever your eye lands on
          rather than whichever came first.
        */}
        {asking !== undefined && (
          <QuestionCard
            key={asking.userInputId}
            request={asking}
            waiting={view.questions.length - 1}
            active={props.active}
            onAnswer={(answers) => {
              answerQuestion(asking, 'answered', answers)
            }}
            onDismiss={() => {
              answerQuestion(asking, 'cancel', [])
            }}
          />
        )}

        <Composer
          ref={composer}
          conversationId={conversationId}
          participants={participants}
          busy={view.busy}
          working={view.working}
          ide={ide}
          report={box}
          history={spoken}
          {...(props.carry === undefined
            ? {}
            : {
                initial: {
                  draft: props.carry.draft,
                  attached: props.carry.attached,
                  ideIncluded: props.carry.ideIncluded,
                },
              })}
          onError={fail(setError)}
          onSending={() => {
            // You just spoke; you want to see the answer.
            following.current = true
            setAwaiting(true)
          }}
          onSendFailed={() => {
            setAwaiting(false)
          }}
        />
      </div>
    </section>
  )
}

/**
 * Marks "Other" apart from a real option label.
 *
 * A sentinel rather than a boolean beside the selection, because Other is one
 * more thing you can pick and behaves like the rest until the answer is
 * assembled — at which point it is replaced by what was typed. A NUL cannot
 * collide with a provider's label; a string like "Other" could.
 */
const OTHER = '\u0000other'

/**
 * A question set, answered inline.
 *
 * The other half of the blocking pair. An approval asks whether an action may
 * happen and a rule can answer it; this asks what you want, which nothing but a
 * person can. That is why it has no Allow — only your answer, or a dismissal
 * that tells the agent nothing was chosen.
 *
 * Every control is drawn from the request's own capability flags and never from
 * a guess: an agent that sent no options is asking for typed text, and offering
 * it a multiple choice would produce an answer it cannot take back.
 */
function QuestionCard({
  request,
  waiting,
  active,
  onAnswer,
  onDismiss,
}: {
  request: PendingQuestion
  /** How many more sets are queued behind this one. */
  waiting: number
  /** Whether this pane owns the caret; a background card must not take it. */
  active: boolean
  onAnswer: (answers: { questionId: string; values: string[] }[]) => void
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  /*
   * Whichever control comes first, whatever kind it is.
   *
   * A callback ref rather than a typed one: the first thing to focus is a button
   * on a multiple choice and an input on a free-text question, and the card does
   * not know which until it reads the request.
   */
  const first = useRef<HTMLElement | null>(null)
  const takeFocus = (el: HTMLElement | null): void => {
    first.current = el
  }
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [typed, setTyped] = useState<Record<string, string>>({})
  /** Which question of the set is on screen; a set of one never shows it. */
  const [step, setStep] = useState(0)

  /*
   * The first control takes focus as the card appears, so the keyboard can
   * answer without reaching for the mouse — the same bargain the approval card
   * makes, for the same reason: the agent is stopped until this is answered.
   */
  useEffect(() => {
    if (!active) return
    first.current?.focus()
  }, [request.userInputId, active])

  /** What this question currently answers, in the array shape the wire expects. */
  const valuesFor = (q: QuestionField): string[] => {
    const text = (typed[q.id] ?? '').trim()
    if (q.options.length === 0) return text === '' ? [] : [text]
    return (picked[q.id] ?? []).flatMap((value) =>
      value === OTHER ? (text === '' ? [] : [text]) : [value]
    )
  }

  /** Complete enough to move on from: this question has something to send. */
  const done = (q: QuestionField): boolean => valuesFor(q).length > 0
  const answered = request.questions.every(done)
  const last = step >= request.questions.length - 1
  const asked = request.questions[step]

  const toggle = (q: QuestionField, value: string): void => {
    setPicked((current) => {
      const chosen = current[q.id] ?? []
      /*
       * One choice replaces, several accumulate.
       *
       * Straight from the provider's own flag rather than from how many options
       * arrived: a single-select question with four options and a multi-select
       * with four look identical from here, and guessing would silently send
       * one answer where the agent expected a list.
       */
      if (!q.multiSelect) return { ...current, [q.id]: chosen.includes(value) ? [] : [value] }
      return {
        ...current,
        [q.id]: chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value],
      }
    })
  }

  if (asked === undefined) return <></>

  const chosen = picked[asked.id] ?? []
  const free = asked.options.length === 0
  const otherOpen = chosen.includes(OTHER)

  return (
    <section
      className={`question question--${request.agentId}`}
      // Assertive for the same reason an approval is: the agent is blocked and
      // the request expires. Hearing about it afterwards is hearing nothing.
      role="alertdialog"
      aria-live="assertive"
      aria-label={t('question.asking', { agent: request.agentId })}
    >
      <header className="question-head">
        <span className={`voice-dot voice--${request.agentId}`} aria-hidden="true" />
        <strong>{t('question.asking', { agent: request.agentId })}</strong>
        {/*
          One question at a time, counted.

          A set can hold four, and stacking them makes a wall you answer by
          scrolling — the last one reached with the first already forgotten.
          Stepping keeps the decision singular, which is the same reason the
          approval queue draws only its head.
        */}
        {request.questions.length > 1 && (
          <span className="question-step">
            {t('question.step', { step: step + 1, total: request.questions.length })}
          </span>
        )}
        {waiting > 0 && (
          <span className="question-queue">{t('question.waiting', { count: waiting })}</span>
        )}
      </header>

      <div className="question-item">
        {asked.header !== '' && <span className="question-label">{asked.header}</span>}
        <p className="question-ask">{asked.question}</p>
        {asked.multiSelect && <span className="question-hint">{t('question.multiHint')}</span>}

        {!free && (
          /*
           * Checkboxes or radios, said in the markup rather than only in a hint.
           *
           * The two behave differently under the pointer and must therefore look
           * different before it is used: a reader who cannot tell a "pick one"
           * from a "pick several" learns the difference by losing a selection
           * they had already made. The roles carry the same distinction to a
           * screen reader, which the shape alone would not.
           */
          <div
            className="question-options"
            role={asked.multiSelect ? 'group' : 'radiogroup'}
            aria-label={asked.question}
          >
            {asked.options.map((option, optionIndex) => (
              <button
                key={option.label}
                ref={optionIndex === 0 ? takeFocus : undefined}
                type="button"
                className="question-option"
                role={asked.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={chosen.includes(option.label)}
                onClick={() => {
                  toggle(asked, option.label)
                }}
              >
                <span
                  className={`question-mark question-mark--${asked.multiSelect ? 'many' : 'one'}`}
                  aria-hidden="true"
                />
                <span className="question-option-body">
                  <span className="question-option-label">{option.label}</span>
                  {option.description !== '' && (
                    <span className="question-option-why">{option.description}</span>
                  )}
                </span>
              </button>
            ))}
            {asked.allowOther && (
              <button
                type="button"
                className="question-option"
                role={asked.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={otherOpen}
                onClick={() => {
                  toggle(asked, OTHER)
                }}
              >
                <span
                  className={`question-mark question-mark--${asked.multiSelect ? 'many' : 'one'}`}
                  aria-hidden="true"
                />
                <span className="question-option-body">
                  <span className="question-option-label">{t('question.other')}</span>
                </span>
              </button>
            )}
          </div>
        )}

        {(free || otherOpen) && (
          <input
            ref={free ? takeFocus : undefined}
            className="question-text"
            // A secret is never echoed, and the orchestrator strips it from the
            // log before it is written rather than after.
            type={asked.isSecret ? 'password' : 'text'}
            value={typed[asked.id] ?? ''}
            placeholder={free ? t('question.freePlaceholder') : t('question.otherPlaceholder')}
            onChange={(e) => {
              const { value } = e.target
              setTyped((current) => ({ ...current, [asked.id]: value }))
            }}
          />
        )}

        {asked.isSecret && <span className="question-hint">{t('question.secretNote')}</span>}
      </div>

      <div className="question-actions">
        {step > 0 && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setStep((current) => current - 1)
            }}
          >
            {t('question.back')}
          </button>
        )}
        {last ? (
          <button
            type="button"
            className="btn btn--go"
            disabled={!answered}
            onClick={() => {
              onAnswer(request.questions.map((q) => ({ questionId: q.id, values: valuesFor(q) })))
            }}
          >
            {t('question.send')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--go"
            // Answer before moving on: a skipped question would arrive at the
            // agent as an empty list, which reads as a choice rather than a gap.
            disabled={!done(asked)}
            onClick={() => {
              setStep((current) => current + 1)
            }}
          >
            {t('question.next')}
          </button>
        )}
        <button type="button" className="btn" onClick={onDismiss}>
          {t('question.dismiss')}
        </button>
      </div>
    </section>
  )
}

function ApprovalCard({
  approval,
  waiting,
  active,
  onAllow,
  onAllowAlways,
  onDeny,
}: {
  approval: PendingApproval
  /** How many more are queued behind this one. Counted so the card can say so. */
  waiting: number
  /** Whether this pane owns the caret; a background card must not take it. */
  active: boolean
  onAllow: () => void
  /** Grants it for the rest of the session, so the same ask stops coming back. */
  onAllowAlways: () => void
  onDeny: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const allow = useRef<HTMLButtonElement | null>(null)

  /*
   * The Allow button takes focus as the card appears, so Enter answers it.
   *
   * An approval stops the agent dead, so the fastest possible answer is the
   * point: reaching for the mouse, or Tabbing in from the composer, is friction
   * on the one interaction that is always blocking. Keyed on the approval id as
   * well as mount, so the next request in a queue claims focus too even if
   * React reuses this instance.
   */
  useEffect(() => {
    if (!active) return
    allow.current?.focus()
  }, [approval.approvalId, active])

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
        {waiting > 0 && (
          <span className="approval-queue">{t('approval.waiting', { count: waiting })}</span>
        )}
      </header>
      <pre className="approval-summary">{approval.summary}</pre>
      {approval.detail !== null && <pre className="approval-detail">{approval.detail}</pre>}
      <div className="approval-actions">
        <button
          ref={allow}
          type="button"
          className="btn btn--go"
          onClick={onAllow}
          /*
           * Enter approves. Space does not, and a held Enter approves once.
           *
           * Both guards exist because this button takes focus on its own, which
           * makes the usual button keys dangerous here:
           *
           *  - **Space.** If a request lands while you are typing, focus moves
           *    mid-sentence and the next space of ordinary prose would activate
           *    the button — approving a command you had not read. Nothing else
           *    the user can type reaches this button, so Space is dropped and
           *    Enter is the only key that approves.
           *  - **Repeat.** Auto-repeat fires ~30 times a second, and every
           *    approval unmounts this card and focuses the next one's button —
           *    so one leant-on key would walk the whole queue. Each approval
           *    costs its own deliberate press.
           *
           * Deny keeps both keys: refusing is the safe direction.
           */
          onKeyDown={(e) => {
            if (e.key === ' ' || (e.repeat && e.key === 'Enter')) e.preventDefault()
          }}
        >
          {t('approval.allowOnce')}
        </button>
        {/*
          Granted for the session, not remembered past it.
          
          The same ask arriving four times in a row is the commonest way an
          approval queue becomes something you stop reading, which is the
          failure mode the whole card exists to avoid. Scoped to the session
          because a permission that outlived the window would be a policy
          change, and those are made in Settings where they can be seen.
          
          Deliberately not the focused button: it is the wider grant, so it
          costs a deliberate press rather than the Enter that is already armed.
        */}
        <button type="button" className="btn" onClick={onAllowAlways}>
          {approval.kind === 'mcpToolCall'
            ? t('approval.allowRemembered')
            : t('approval.allowAlways')}
        </button>
        <button type="button" className="btn" onClick={onDeny}>
          {t('approval.deny')}
        </button>
        {/* Focus alone is a quiet affordance; saying it makes it discoverable. */}
        <span className="approval-hint" aria-hidden="true">
          {t('approval.enterHint')}
        </span>
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
