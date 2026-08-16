import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Attachment } from './Attachments.js'
import { fitCard, type AsidePurpose } from './aside.js'
import { Composer, type ComposerHandle, type ComposerState } from './Composer.js'
import { Entry } from './Entry.js'
import { focusedNow, mayTakeCaret } from './focus.js'
import { thinkingWord, offsetForActor, THINKING_WORD_MS } from './thinking-word.js'
import { HandoffComposer, type HandoffDraft } from './HandoffComposer.js'
import { QuickQuestion } from './QuickQuestion.js'
import {
  anchorOf,
  askableSource,
  inPane,
  type ContentAnchor,
  type PaneAnchor,
  type SourceEntry,
} from './quote.js'
import type { IdeContextPush, TerminalRefShape } from '../../shared/ipc.js'
import { TerminalPanel } from './TerminalPanel.js'
import { useSessionTerminal, useWorkspaceActions } from './workspace/hooks.js'
import { ReviewPanel } from './ReviewPanel.js'
import { SummaryPanel } from './SummaryPanel.js'
import {
  answersThinking,
  groupedWith,
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
 *
 * `.terminal-panel` is here for a reason the tag list cannot cover: xterm types
 * into a hidden `<textarea>` that is a *sibling* of the rendered rows rather
 * than an ancestor, so a click on the terminal's own output matched none of the
 * tags above and the composer took the caret. Typing into the shell then went
 * into the message box — observed, with the characters landing under the
 * transcript.
 */
const FOCUS_KEEPS_ITS_OWN =
  'button, a, input, textarea, select, summary, [role="button"], [contenteditable], .approval, .question, .terminal-panel'

/**
 * The transcript entry a DOM node sits inside, in the shape `askableSource`
 * wants.
 *
 * Thin on purpose: the traversal is DOM, the judgement is not. Everything here
 * comes straight off the attributes `Entry` writes, so the decision stays in a
 * pure function that can be tested without a document.
 */
function sourceEntryAt(node: Node | null): SourceEntry | null {
  const from = node instanceof Element ? node : (node?.parentElement ?? null)
  const entry = from?.closest('.entry') ?? null
  if (entry === null) return null
  return {
    eventId: entry.getAttribute('data-event-id') ?? '',
    actor: entry.getAttribute('data-actor') ?? '',
    kind: entry.getAttribute('data-kind') ?? '',
    status: entry.getAttribute('data-status') ?? '',
  }
}

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
  /** Turns an aside into a conversation and brings it up as a tab. */
  onPromoteAside: (asideId: string, profileId: string) => void
  /** Set when the sidenav asked for a panel this pane owns. */
  panelRequest?: 'review' | 'summary' | undefined
  /** Starting over and ending, offered in the composer as well as in the menu. */
  onRestart?: (() => void) | undefined
  onEnd?: (() => void) | undefined
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

  /*
   * This session's terminal panel.
   *
   * Both live in the workspace store rather than here, because `⌘J` is handled
   * by a document-level listener in `Workspace` and this component may not even
   * be mounted when it fires — and because the store is what gets persisted, so
   * a panel is where you left it after a relaunch.
   */
  const terminal = useSessionTerminal(conversationId)
  const {
    toggleSessionTerminal,
    setSessionTerminalHeight,
    addSessionTerminal,
    activateSessionTerminal,
    removeSessionTerminalTab,
  } = useWorkspaceActions()
  /*
   * How this session names one of its shells.
   *
   * The panel holds the roster and asks for a ref per tab, so scope
   * construction stays at the call site that knows the conversation — the panel
   * itself is shared by both scopes and must not learn to build either.
   */
  const terminalRefFor = useCallback(
    (id: string): TerminalRefShape => ({ scope: 'session', conversationId, id }),
    [conversationId]
  )
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
    /**
     * The passage itself, unclamped.
     *
     * Raw on purpose. The old anchor arrived already clamped against a guess at
     * the offer's width, which meant the true geometry was gone before anything
     * could measure what was actually rendered — so a wider offer could never be
     * placed correctly however carefully it was measured.
     */
    anchor: ContentAnchor
    /**
     * The entry it came out of, when the passage is one an agent could be asked
     * to expand on — `null` when it can only be quoted.
     */
    source: SourceEntry | null
  } | null>(null)
  /**
   * The open quick-question card, if any.
   *
   * Held apart from `selected` and seeded from it: once a card is open, the
   * passage it is about must not change. Scrolling drops the offer and a later
   * selection replaces it, and either would otherwise re-point a question that
   * has already been asked.
   */
  const [askingAbout, setAskingAbout] = useState<{
    text: string
    /** Pane space: the card floats over the pane and does not scroll with it. */
    anchor: PaneAnchor
    source: SourceEntry
    purpose: AsidePurpose
    /** Started by the click, because a mount effect runs twice and can send twice. */
    opening: Promise<string>
    /** Whatever main decided, so the card cannot name a stale language. */
    language: Promise<string>
  } | null>(null)
  /**
   * The language explanations come back in, or empty when there is none.
   *
   * Re-read on every selection rather than held from mount. `App` reads settings
   * once and keeps only the session defaults, so nothing here would otherwise
   * learn that the language had just been set — and the sheet where it is set is
   * a few clicks from the passage where it is used. One IPC call per selection is
   * cheaper than being wrong.
   */
  const [explainLanguage, setExplainLanguage] = useState('')
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
   * the moment a reply fills the view. It used to publish the same figure as
   * `--spare`, which held the rail up out of the emptiness; the rail went with
   * the bubble when the transcript became rows, and nothing reads it now.
   */
  const makeRoom = useCallback(() => {
    const el = score.current
    const content = transcript.current
    const spacer = tail.current
    if (el === null || content === null) return
    if (spacer === null) return
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
    /*
     * The work happens a frame later, and that is the fix rather than a tidying.
     *
     * `makeRoom` writes `spacer.style.height`, and the spacer is a child of the
     * observed element. Done inside the delivery, that is a guaranteed
     * ResizeObserver loop: Chromium re-runs the observation, hits its depth
     * limit, reports "loop completed with undelivered notifications" and **drops
     * the rest**. Measured against a real streaming reply, eleven times per
     * answer — on healthy runs too, which is why it went unnoticed.
     *
     * Usually the next token resizes the content again and the dropped
     * notification is made good. When the dropped one is the *last* of a turn —
     * the typewriter's jump to the whole text, or a diff card committing at once
     * — nothing ever changes size again, so nothing corrects it and the
     * transcript sits stranded below the fold until the reader scrolls. That is
     * the "stops dead mid-reply" report. Driven: 182px left hidden, with the
     * observer having fired 7 times against a healthy run's 25.
     *
     * A frame later the write is an ordinary resize rather than an undelivered
     * one, so the loop cannot form. It also coalesces a burst of notifications
     * into one layout, where the old shape paid for each.
     */
    let frame = 0
    const settle = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        // Before following, not after: the spare room decides where the bottom is.
        makeRoom()
        if (following.current) el.scrollTop = el.scrollHeight
      })
    }

    const follow = new ResizeObserver(settle)
    follow.observe(content)
    // The pane itself, because how much room the turn is short of is measured
    // against the view — and a window resize changes that without changing a word.
    follow.observe(el)
    return () => {
      follow.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [makeRoom])

  /**
   * A short watch after the reply ends, for what arrives after it.
   *
   * `overflow-anchor: none` on `.score` is what actually fixed this — the
   * browser was moving `scrollTop` back to hold the view still while cards
   * landed above the foot. With anchoring off, six tool-heavy turns settle at
   * 0-1px instead of 163-241px.
   *
   * This is the remainder. A command's output, a diff, or the action row can
   * commit a second or two after the last token, and the resize that reports it
   * is answered correctly — but a reader looking at the bottom still wants the
   * bottom. So the end of a turn is watched for a moment rather than trusted to
   * one notification.
   *
   * Bounded by wall clock and cheap on purpose: it reads two numbers a frame and
   * only touches layout when it actually has to correct. `makeRoom` is *not*
   * called on every pass — it forces a layout, and 150 forced layouts to catch
   * one late card would cost more than the card.
   *
   * `following` is re-read each pass rather than captured, so scrolling up to
   * read during the watch ends it. The reader wins, as everywhere else here.
   */
  useEffect(() => {
    if (view.busy) return undefined
    const el = score.current
    if (el === null) return undefined

    let frame = 0
    const until = Date.now() + 2_500
    const watch = (): void => {
      if (following.current && el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
        makeRoom()
        el.scrollTop = el.scrollHeight
      }
      if (Date.now() < until) frame = requestAnimationFrame(watch)
    }
    frame = requestAnimationFrame(watch)
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [view.busy, makeRoom])

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
    const contentEl = transcript.current
    if (selection === null || selection.isCollapsed || scoreEl === null || contentEl === null) {
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
    /*
     * Against the scrolling content, not the pane.
     *
     * The offer lives inside `.score-content` now, so it travels with the
     * passage instead of being thrown away every time the transcript moves
     * under it — which on a narrow pane was several times a second.
     */
    const anchor = anchorOf(range.getBoundingClientRect(), contentEl.getBoundingClientRect())
    /*
     * Both ends, not `commonAncestorContainer`: a range spanning two entries has
     * the scroller as its common ancestor, which carries none of the attributes
     * the decision needs and would read as "no source" rather than as the
     * cross-entry selection it actually is.
     */
    const source = askableSource(
      sourceEntryAt(range.startContainer),
      sourceEntryAt(range.endContainer),
      text
    )
    if (source !== null) {
      window.chorus
        .readSettings()
        .then((settings) => {
          setExplainLanguage(settings.explainLanguage)
        })
        .catch(() => undefined)
    }
    setSelected(anchor === null ? null : { text, source, anchor })
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

  /**
   * Where the offer ends up, once it knows how wide it is.
   *
   * Measured rather than estimated. The width depends on how many actions are
   * shown and what they are labelled — two, or three when a language is set —
   * and every constant written down for it has been wrong within a phase of
   * being written.
   */
  const offer = useRef<HTMLDivElement | null>(null)
  const [offerAt, setOfferAt] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = offer.current
    const scoreEl = score.current
    const contentEl = transcript.current
    if (selected === null || el === null || scoreEl === null || contentEl === null) {
      setOfferAt(null)
      return
    }
    const place = (): void => {
      const content = contentEl.getBoundingClientRect()
      const scrollport = scoreEl.getBoundingClientRect()
      setOfferAt(
        fitCard(
          selected.anchor,
          {
            width: contentEl.clientWidth,
            /*
             * The scrollport, expressed in content coordinates. Derived from the
             * two rectangles rather than from `scrollTop` and padding, which is
             * the same number by a route with two things to forget — and the
             * scroller has 15px of top padding to forget.
             */
            top: scrollport.top - content.top,
            bottom: scrollport.bottom - content.top,
          },
          { width: el.offsetWidth, height: el.offsetHeight }
        )
      )
    }
    place()
    // Wrapping to a second line changes its height, which changes where it
    // should hang from.
    const observer = new ResizeObserver(place)
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [selected])

  /**
   * Opens an aside on the selected passage, and starts its fork here.
   *
   * The open belongs to the click. A card that opened its own fork in a mount
   * effect would open two in development, and for an explanation — which sends
   * its first turn on open — the second is a paid turn already written to the
   * log before any cleanup could run. A click happens once.
   */
  const openCard = useCallback(
    (purpose: AsidePurpose) => {
      const passage = selected
      const source = passage?.source ?? null
      if (passage === null || source === null) return

      const opened = window.chorus.openAside({
        conversationId,
        sourceEventId: source.eventId,
        excerpt: passage.text,
        purpose,
      })

      /*
       * Into pane space, once, here.
       *
       * The offer's anchor is relative to the scrolling content, because the
       * offer scrolls with the passage. The card does not — it floats over the
       * pane — so handing it the same numbers would place it correctly at the
       * top of a transcript and further out the more you had scrolled. The
       * compiler refuses the mix-up now; this is the conversion it is asking
       * for.
       */
      const contentEl = transcript.current
      const paneEl = pane.current
      if (contentEl === null || paneEl === null) return

      setAskingAbout({
        ...passage,
        anchor: inPane(
          passage.anchor,
          contentEl.getBoundingClientRect(),
          paneEl.getBoundingClientRect()
        ),
        source,
        purpose,
        opening: opened.then((result) => result.asideId),
        /*
         * The language main used, not the one this pane happened to be holding.
         * The local copy is read asynchronously per selection and can be a
         * moment behind — long enough for the card to say Arabic while the log
         * says French.
         */
        language: opened.then((result) => result.language),
      })
      setSelected(null)
      window.getSelection()?.removeAllRanges()
    },
    [selected, conversationId]
  )

  /**
   * Opens a recap card on a finished reply. `openCard`'s sibling, not a fourth
   * branch of it.
   *
   * `openCard` starts from `selected`, and a recap has no selection: it is asked
   * from a button under the last reply, about the conversation rather than about
   * a passage. Everything after the anchor is the same, which is why the two sit
   * next to each other rather than one calling the other — the shared part is
   * four lines and the different part is the first four.
   *
   * **The excerpt is the whole reply, and it never reaches the prompt.** Main
   * still checks it (`containsPassage`), because that guard authenticates which
   * agent said this and in which session — a recap needs both, since the fork it
   * takes is of that agent's session. What a recap has no use for is the
   * quoting, and `recapPrompt` does not do any.
   *
   * The anchor comes from the button's own rect, converted from viewport space
   * to pane space the way `inPane` converts content space — by subtracting the
   * pane's origin. `fitCard` prefers above and drops below, so a button near the
   * foot of a long transcript gets its card over the transcript rather than over
   * the composer.
   */
  const openRecap = useCallback(
    (message: TranscriptMessage, from: DOMRect) => {
      if (message.actor !== 'codex' && message.actor !== 'claude') return
      if (message.eventId === '' || message.text === '') return

      const paneEl = pane.current
      if (paneEl === null) return
      const paneRect = paneEl.getBoundingClientRect()

      const opened = window.chorus.openAside({
        conversationId,
        sourceEventId: message.eventId,
        excerpt: message.text,
        purpose: 'recap',
      })

      setAskingAbout({
        text: message.text,
        anchor: {
          space: 'pane',
          centreX: from.left + from.width / 2 - paneRect.left,
          top: from.top - paneRect.top,
          height: from.height,
        },
        source: {
          eventId: message.eventId,
          actor: message.actor,
          kind: message.kind,
          status: message.status,
        },
        purpose: 'recap',
        opening: opened.then((result) => result.asideId),
        // Nothing to resolve — a recap names no language. Kept a promise because
        // the card's prop is one, and a second shape for one purpose would be a
        // branch in every consumer to save an await that never blocks.
        language: opened.then(() => ''),
      })

      // The card replaces the quote offer, as `openCard` does. Clicking the
      // button clears the DOM selection but not this, and the offer would
      // otherwise float over the card it was replaced by.
      setSelected(null)
      window.getSelection()?.removeAllRanges()
    },
    [conversationId]
  )

  /**
   * Says yes to the one thing a reply offered to do.
   *
   * An ordinary message, deliberately: this is the user telling an agent to
   * proceed, and it belongs in the transcript exactly as typing it would. What
   * the log keeps is `@claude Go ahead.` — a line they would recognise as their
   * own — while main expands the `go` intent into the real instruction. The
   * prompt is built there rather than here because prompt content from the
   * renderer is the same class of problem as an unverified source event.
   *
   * The mention is load-bearing. Routing is decided from the logged text, and
   * `lastAddressed` is not necessarily whoever wrote the reply the button sat
   * under — `recapPromotion` names the agent for the same reason.
   */
  const accept = useCallback(
    (message: TranscriptMessage) => {
      if (message.actor !== 'codex' && message.actor !== 'claude') return
      following.current = true
      window.chorus
        .sendMessage({ conversationId, text: `@${message.actor} Go ahead.`, intent: 'go' })
        .catch(fail(setError))
    },
    [conversationId]
  )

  /**
   * Closes the aside a card was showing. The other half of `openCard`.
   *
   * Here rather than in the card's own cleanup, because React runs an effect
   * setup → cleanup → setup in development and the simulated cleanup would close
   * the fork the second setup had just adopted. Opening and closing belong to one
   * owner; this is it.
   *
   * Closes what the *promise* resolves to, not what the card managed to render:
   * dismissing during the two seconds a CLI takes to start would otherwise leave
   * a fork nobody closes.
   */
  const closeCard = useCallback((card: { opening: Promise<string> } | null) => {
    if (card === null) return
    void card.opening.then((id) => window.chorus.closeAside({ asideId: id })).catch(() => undefined)
  }, [])

  /*
   * A pane can be unmounted with a card open — closing its tab, or another pane
   * becoming the active one. The fork outlives the component unless something
   * says otherwise.
   */
  const openCardRef = useRef<{ opening: Promise<string> } | null>(null)
  openCardRef.current = askingAbout
  useEffect(
    () => () => {
      closeCard(openCardRef.current)
    },
    [closeCard]
  )

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
    /*
     * Only where you are working. In a background pane this used to reach across
     * and pull the caret out of the sentence you were typing.
     *
     * And only when there is a sentence to come back to. Normally the caret is
     * on the Allow button that is about to unmount, so bringing it here is the
     * whole point — but if the card never took the caret, because someone was
     * writing, then the aside they were writing in is where it still belongs.
     */
    if (props.active && mayTakeCaret(focusedNow())) composer.current?.focus()
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
      /* So a `Changes` card can print `src/rate.ts` rather than the whole
         absolute path an agent reports. Stable per session, so it costs the
         memoisation nothing. */
      cwd={props.session.cwd}
      final={message.key === finalKey}
      answersThinking={answersThinking(view.messages[index - 1], message)}
      /*
       * A run of steps by one agent is one speaker, not eleven.
       *
       * Only the *steps* group: a message keeps its avatar, its name and its
       * time however many rows precede it, because those are what the row is.
       * A command, a tool call or a notice under the same agent is that agent
       * still working, and repeating the name down the column says nothing while
       * costing a line each time.
       */
      grouped={groupedWith(view.messages[index - 1], message)}
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
      /*
       * `Entry` gates this on `final`, which is already null mid-turn. Passed
       * unconditionally for every agent message rather than filtered here, so
       * the one rule about which reply may be recapped lives in one place.
       */
      onRecap={message.actor === 'codex' || message.actor === 'claude' ? openRecap : undefined}
      /*
       * Whether the reply *offered* anything is `Entry`'s to decide — it reads
       * the words, and this only supplies the ability to answer.
       */
      onGo={message.actor === 'codex' || message.actor === 'claude' ? accept : undefined}
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
        {/* The same mark-and-head a step wears in `Entry`: these two rows are
            built here rather than by the reducer, so they have to follow the
            row structure by hand or they land in the wrong grid cells. */}
        <span className="entry-mark" aria-hidden="true">
          <span className="tick" />
        </span>
        <div className="entry-head">
          <span className="speaker">{soleAgent === undefined ? '' : t(`actor.${soleAgent}`)}</span>
        </div>
        <p className="said thinking" role="status">
          <ThinkingWord kind="waiting" />
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
        <span className="entry-mark" aria-hidden="true">
          <span className="tick" />
        </span>
        <div className="entry-head">
          <span className="speaker">{t(`actor.${agent}`)}</span>
        </div>
        <p className="said thinking" role="status">
          <ThinkingWord kind="thinking" offset={offsetForActor(agent)} />
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
          void composer.current?.attach([...e.dataTransfer.files])
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
        /*
         * Following stops on a *gesture*, not on a position.
         *
         * This used to read `scrollTop` moving backwards as "the reader scrolled
         * up", and several things move it backwards that are not a reader:
         * `makeRoom` shrinking the spare room clamps it, and Chromium's scroll
         * anchoring used to drag it back to hold the view still while cards
         * landed above the foot. Either one turned following off for good, and a
         * transcript that stops following mid-reply never starts again on its
         * own — which is exactly the report.
         *
         * A wheel, a trackpad swipe, a touch drag and the scrolling keys are the
         * only things the app cannot manufacture, so they are the only things
         * that count as deciding to read something else. Position is still what
         * *resumes* following, in `onScroll` below: coming back to the bottom is
         * unambiguous however you got there.
         */
        onWheel={(e) => {
          if (e.deltaY < 0) following.current = false
        }}
        onTouchMove={() => {
          const el = score.current
          if (el === null) return
          if (el.scrollHeight - el.scrollTop - el.clientHeight > 32) following.current = false
        }}
        onKeyDown={(e) => {
          if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) following.current = false
        }}
        onScroll={(e) => {
          const el = e.currentTarget
          /*
           * Only ever turns following back *on*.
           *
           * "At the bottom" with room to spare: a couple of pixels of rounding,
           * or a scroll that lands just short, still counts as following. The
           * `else` that used to sit here — turning it off when the bottom got
           * further away — is what the gesture handlers above replaced.
           */
          if (el.scrollHeight - el.scrollTop - el.clientHeight <= 32) following.current = true
        }}
      >
        <div className="score-content" ref={transcript}>
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
          {/*
            Offered where the passage is, not in a toolbar.

            `onMouseDown` with `preventDefault` rather than `onClick` alone: a
            mousedown on a button clears the selection before the click lands, so by
            the time the handler ran there would be nothing left to quote.
          */}
          {selected !== null && askingAbout === null && (
            <div
              className="quote-offer"

              /*
               * The classifier's answer, visible in the DOM as well as in the
               * buttons, so a wrong one is assertable rather than only lookable-at.
               */
              data-askable={selected.source === null ? undefined : 'true'}
              ref={offer}
              /*
               * Hidden for the frame before it has been measured, so the first paint
               * is not the offer in the wrong place followed by a jump.
               */
              style={
                offerAt === null
                  ? { visibility: 'hidden' }
                  : { left: `${String(offerAt.left)}px`, top: `${String(offerAt.top)}px` }
              }
              onMouseDown={(e) => {
                e.preventDefault()
              }}
            >
              <button type="button" className="quote-offer-action" onClick={quoteSelection}>
                {t('conversation.quoteInMessage')}
              </button>
              {/*
                Offered only where an aside can actually be answered. A passage that
                crosses two replies has no single author, and one still streaming
                cannot be seen by a fork at all — so the button is absent rather than
                present-and-failing.
              */}
              {selected.source !== null && (
                <button
                  type="button"
                  className="quote-offer-action"
                  onClick={() => {
                    openCard('question')
                  }}
                >
                  {t('conversation.askAboutThis')}
                </button>
              )}
              {/*
                Offered only when a language has been set. There is no honest guess
                at someone's own language, and an action that cannot say which one it
                would answer in is worse than an absent one.
              */}
              {selected.source !== null && explainLanguage !== '' && (
                <button
                  type="button"
                  className="quote-offer-action"
                  onClick={() => {
                    openCard('explanation')
                  }}
                >
                  {t('conversation.explainSimply')}
                </button>
              )}
              {/*
                Gated on a language for the same reason Explain is, and on the same
                value: an action that cannot say which language it would produce is
                worse than an absent one.

                A word, not an icon, though the request said "translate icon". The
                other three are labelled, and one icon among three labels reads as an
                accident rather than a decision — while an unlabelled icon is the
                least legible thing on a bar people meet rarely. Icons for all four
                is defensible and is a different change; mixing is the only option
                that is not.
              */}
              {selected.source !== null && explainLanguage !== '' && (
                <button
                  type="button"
                  className="quote-offer-action"
                  onClick={() => {
                    openCard('translation')
                  }}
                >
                  {t('conversation.translateThis')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {askingAbout !== null && (
        <QuickQuestion
          opening={askingAbout.opening}
          purpose={askingAbout.purpose}
          language={askingAbout.language}
          agent={askingAbout.source.actor}
          excerpt={askingAbout.text}
          anchor={askingAbout.anchor}
          onClose={() => {
            closeCard(askingAbout)
            setAskingAbout(null)
          }}
          profileId={props.session.profileId}
          onStage={(text) => {
            composer.current?.insert(text)
          }}
          onPromote={(asideId, profileId) => {
            /*
             * The card is dropped without closing the aside, because promotion
             * has already taken its fork — `closeCard` would end a session the
             * new conversation is now built on.
             */
            setAskingAbout(null)
            props.onPromoteAside(asideId, profileId)
          }}
          onError={setError}
        />
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

      {/*
       * This session's terminal, between the transcript and the dock.
       *
       * `.pane` is a flex column whose only stretching child is `.score`, so a
       * fixed-height row lands here without touching an existing rule. Above the
       * composer rather than below it: the composer is where you talk to an
       * agent and stays adjacent to the approvals it answers.
       *
       * Mounted only while open. The shell is in main and outlives this, so
       * closing the panel detaches a view and kills nothing.
       */}
      {terminal.open && (
        <TerminalPanel
          panel={terminal}
          refFor={terminalRefFor}
          /*
           * The room's name, not its path.
           *
           * It read `Terminal — /var/folders/lh/…/T/chorus-abc123` in any
           * scratch workspace, which is the one string on screen that says
           * nothing about which session you are looking at. The title is what
           * the tab, the rail tile and the composition all call it.
           */
          title={t('terminal.sessionTitle', { project: props.session.title })}
          onHeightChange={(height) => {
            /*
             * No `commitLayout` bypass here, unlike the sash and the sidebar.
             * Those fire per frame and need the debounce skipped on release;
             * this fires *once*, on release already, so the 180ms window in
             * `App` is exactly what it is for.
             */
            setSessionTerminalHeight(conversationId, height)
          }}
          onClose={() => {
            toggleSessionTerminal(conversationId)
          }}
          onAddTerminal={() => {
            addSessionTerminal(conversationId)
          }}
          onActivateTerminal={(id) => {
            activateSessionTerminal(conversationId, id)
          }}
          onRemoveTerminal={(id) => {
            removeSessionTerminalTab(conversationId, id)
          }}
          onFocusAway={() => {
            /*
             * Put the caret back where someone would expect it. Queried from the
             * pane rather than held as a ref because the composer is several
             * components down and this is the only thing that ever asks.
             */
            pane.current?.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
          }}
          variant="session"
          shortcut={t('terminal.shortcutSession')}
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
          /*
           * The four session actions, in the row where the work happens.
           *
           * The panels are opened here rather than through the session menu's
           * `onOpenPanel`, because this component already owns whether they are
           * showing — the menu's route exists for a session that is *not* the
           * one you are typing in.
           */
          onOpenPanel={(panel) => {
            if (panel === 'review') setReviewing(true)
            else setSummarising(true)
          }}
          {...(props.onRestart === undefined ? {} : { onRestart: props.onRestart })}
          {...(props.onEnd === undefined ? {} : { onEnd: props.onEnd })}
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
   *
   * And the same exception, for the same reason: not out of a sentence already
   * being typed. A question card lands on a radio, where the words that follow
   * are swallowed and the arrow keys change an answer instead of moving a caret.
   */
  useEffect(() => {
    if (!active) return
    if (!mayTakeCaret(focusedNow())) return
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
   *
   * Never out of a sentence someone is part-way through, though. The card
   * arrives when the *agent* decides, not when the user does, and it used to
   * land on Allow mid-word — scattering the rest of the typing across a button
   * and leaving the next Enter to approve a command nobody had read.
   */
  useEffect(() => {
    if (!active) return
    if (!mayTakeCaret(focusedNow())) return
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

/**
 * The rotating word in a silent row.
 *
 * Its own component so the timer belongs to it: a `setInterval` in `Session`
 * would re-render four mounted transcripts every 2.6 seconds for the sake of one
 * word, which is exactly the kind of thing `render-count.ts` was written to
 * catch.
 *
 * Elapsed time from mount rather than a stored index, because the row unmounts
 * the moment the first token arrives — there is no state worth keeping and a
 * clock cannot drift out of step with itself.
 *
 * `role="status"` is on the paragraph above, so a screen reader announces the
 * row once when it appears. This deliberately does not re-announce on every
 * word: the point is reassurance for someone watching, not a stream of
 * interruptions for someone listening.
 */
function ThinkingWord({
  kind,
  offset = 0,
}: {
  readonly kind: 'thinking' | 'waiting'
  readonly offset?: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    /* Frozen for anyone who asked for less motion. Text that changes under the
       eye is motion, whatever the media query was named for. */
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const started = performance.now()
    const timer = setInterval(() => {
      setElapsed(performance.now() - started)
    }, THINKING_WORD_MS)
    return () => {
      clearInterval(timer)
    }
  }, [])

  const words = t(`conversation.${kind}Words`, { returnObjects: true })
  const list = Array.isArray(words) ? (words as string[]) : []
  /* The single-word key is the fallback, so a missing or malformed list degrades
     to what this row said before rather than to an empty line. */
  const word = list.length > 0 ? thinkingWord(list, elapsed, offset) : t(`conversation.${kind}`)

  return <span className="thinking-word">{word}</span>
}
