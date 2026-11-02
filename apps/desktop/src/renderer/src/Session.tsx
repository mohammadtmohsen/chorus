import { CONVERSATION_NOTE_MAX_LENGTH, isAgentId, type AgentId } from '@chorus/shared'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Attachment } from './Attachments.js'
import { NOTE_IMAGE_DRAG_TYPE, noteImageUrls } from './attach.js'
import { formatDiagnosticBlock } from './editor-context.js'
import { fitCard, type AsidePurpose } from './aside.js'
import { Composer, type ComposerHandle, type ComposerState } from './Composer.js'
import { ConversationNote } from './ConversationNote.js'
import { useConversationNote } from './useConversationNote.js'
import { isLiveReply } from '../../shared/live-message.js'
import { Entry, ToolPatch } from './Entry.js'
import { ErrorNotice } from './ErrorNotice.js'
import { focusedNow, fullyVisible, mayTakeCaret } from './focus.js'
import { profileHas, profileMark, profileMarkAfterPaint } from './profile-marks.js'
import { thinkingWord, offsetForActor, THINKING_WORD_MS, AWAITING_MAX_MS } from './thinking-word.js'
import { QuickQuestion } from './QuickQuestion.js'
import { readerAnchorOf, restoreReaderAnchor, type ReaderAnchor } from './reader-anchor.js'
import { TaskProgress } from './TaskProgress.js'
import type { LiveSource } from './task-strip.js'
import {
  anchorOf,
  askableSource,
  inPane,
  type ContentAnchor,
  type PaneAnchor,
  type SourceEntry,
} from './quote.js'
import type { ActivityPush, TranscriptEvent } from '../../shared/ipc.js'

import { askableQuestion, questionText } from '../../shared/question-text.js'
import { useBackgroundAgents, useSessionActivity, useIdeContext } from './workspace/hooks.js'
import {
  answersThinking,
  groupedWith,
  EMPTY_VIEW,
  finalAnswerKey,
  applyTranscriptState,
  mergeTaskState,
  prependEvents,
  reduceEvents,
  reduceTranscriptRead,
  transcriptRows,
  type PendingApproval,
  type PendingQuestion,
  type QuestionField,
  type TranscriptMessage,
  type TranscriptRow,
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
 *
 * **`.monaco-editor` is the same shape and was missed.** Monaco renders text as
 * `div.view-line`s and keeps its own hidden `textarea.inputarea` elsewhere in
 * the tree, so a click on a line of code matched nothing here either and the
 * caret went to the composer — which made a file impossible to edit. That the
 * xterm sentence above did not already cover it is the point worth keeping:
 * this list is about *where the click landed*, and any component that renders
 * its text separately from its input needs naming, not inferring.
 */
const FOCUS_KEEPS_ITS_OWN =
  'button, a, input, textarea, select, summary, [role="button"], [contenteditable], .approval, .question, .terminal-panel, .monaco-editor, .conversation-note'

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

export type { AgentId }
/**
 * Every agent Chorus knows how to seat, present or not.
 *
 * The order is read, so it is not arbitrary: this drives the cast toggles and
 * the composer's placeholder, and something has to be named first. It matches
 * `DEFAULT_SETTINGS.agents`, and the two should move together or the sheet will
 * disagree with the room.
 *
 * **The order is the pipeline's, roughly.** Codex and Claude lead because they
 * are the two that think; DeepSeek is last because it is the one that is handed
 * work rather than asked what the work is. Reading the row top to bottom should
 * suggest that.
 *
 * **Deliberately not derived from `AGENT_IDS`.** That tuple is declaration
 * order; this is reading order, and they differ. A new agent has to be placed
 * here by hand, which is the cost of the sentence reading well.
 */
export const ALL_AGENTS: AgentId[] = ['claude', 'codex', 'deepseek']

export interface ForwardSelection {
  readonly text: string
  readonly sourceEventIds: readonly string[]
}

export interface SessionInfo {
  readonly conversationId: string
  readonly participants: AgentId[]
  /**
   * The project this conversation belongs to, and what the outer tabs are keyed
   * by. `cwd` is that project's root — kept because the UI shows a path, not
   * because a conversation has one of its own.
   */
  readonly projectId: string
  readonly cwd: string
  readonly profileId: string
  readonly title: string
  readonly starting?: boolean | undefined
  readonly restarting?: boolean | undefined
}

/**
 * How many *events* a page holds.
 *
 * Events rather than rows: the transcript filter already drops what the reducer
 * has no case for, so a page of events is a page of rows to within that filter —
 * and counting rows would mean running the reducer before the query could decide
 * where to stop, which is the work paging exists to avoid.
 *
 * 400 is a few dozen exchanges: comfortably more than a screen at any row height
 * the app produces, and far short of the 15,528 the measured conversation holds.
 * It is also what makes a fully-mounted transcript affordable again — 400 events
 * is a few hundred rows, not four thousand.
 */
const PAGE_EVENTS = 400

const FLOOR_HOLD_MS = 1_000
const NAVIGATION_EVENTS = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const
const FLOOR_EASE_MS = 240

/** Renderer state that survives closing or backgrounding a tab. */
export interface SessionCarry {
  readonly view: TranscriptView
  readonly draft: string
  readonly attached: readonly Attachment[]
  readonly mode?: 'work' | 'discussion'
  readonly following: boolean
  /**
   * Where the reader was, in pixels — the fallback when there is no `anchor`.
   *
   * History rows that are off screen are skipped and stand in at an estimated
   * height, so a pixel offset is only exact for content that has not moved
   * between those estimates. A carry with no anchor still restores by it.
   */
  readonly scrollTop: number
  /**
   * Where the reader was, as a row and an offset into it — not a pixel offset.
   *
   * This was `scrollTop: number`, and the restore effect spent up to two seconds
   * polling for the content to grow tall enough to hold it. That was an
   * approximation of an anchor, written because there was no anchor. With
   * history rows skipped until they are near the viewport it stops even
   * approximating: rows above the viewport are estimates until something
   * renders them, so a pixel offset names a position in a coordinate system that
   * moves.
   *
   * `null` while following, or when nothing has been captured; `scrollTop` is
   * then what restores.
   */
  readonly anchor?: ReaderAnchor | null
  /**
   * An aside card that was open when the pane went away.
   *
   * Only the active tab of each pane is mounted, so looking at another session
   * unmounts this one — and a card that lived in local state went with it,
   * taking an answer you were part-way through reading. The fork itself never
   * needed to end: it lives in main, and main already closes a conversation's
   * asides when the conversation ends.
   *
   * `undefined` is the ordinary case. The promises inside survive because
   * nothing re-runs them; the card adopts what they already resolved.
   */
  readonly card?: OpenCard | undefined
  readonly openActivity?: readonly string[]
}

/** The open aside card, as `Session` holds it and as a carry keeps it. */
export interface OpenCard {
  readonly text: string
  readonly anchor: PaneAnchor
  readonly source: SourceEntry
  readonly purpose: AsidePurpose
  readonly opening: Promise<string>
  readonly language: Promise<string>
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
  /**
   * Branches this conversation into a side task and brings it up as a tab.
   *
   * The pane does not do it itself for the same reason promotion does not: it
   * ends with a room that has to appear in the workspace, and only the shell
   * knows how to put it there.
   */
  /** Set when the sidenav asked for a panel this pane owns. */
  /**
   * Ends this conversation and opens a fresh one in the same project.
   *
   * The shell's, not the pane's, for the reason promotion is: it ends with a
   * conversation that has to appear in the workspace, and only `App` knows how
   * to put it there — and how to order the two so the project's tab survives the
   * handover.
   */
  onRestart: () => void
  /**
   * Opening a fresh conversation that carries this one's transcript.
   *
   * On `App` for the same reason `onRestart` is: it creates a conversation, and
   * only `App` knows how to put one in the workspace. The pane knows which room
   * is being continued and nothing else about it.
   */
  onForward: (selection: ForwardSelection) => void
  /*
   * Undefined is spelled out because `exactOptionalPropertyTypes` is on: the
   * caller reads this out of a Map, and a miss is a real value it has to be
   * allowed to pass rather than an argument it must remember to omit.
   */
  carry?: SessionCarry | undefined
  onCarry: (conversationId: string, carry: SessionCarry) => void
  /**
   * Lends the shell a way to read the draft, without ever pushing it there.
   *
   * A getter rather than the text, and that is the whole point. `onCarry` fires
   * on unmount, so the draft of the conversation you are *looking at* is exactly
   * the one the shell cannot see — and that is the one most likely to be
   * unsent. Sending it up on every keystroke would undo the arrangement the
   * carry comment above describes: the draft lives in the composer so a
   * keystroke repaints a textarea rather than a conversation.
   *
   * Registered on mount and withdrawn on unmount. The shell calls it at most
   * once, when somebody asks to end the room.
   */
  onDraftReader: (conversationId: string, read: (() => string) | null) => void
  /**
   * Whether this pane owns the caret.
   *
   * Only the active pane may take focus on its own. Everything that grabs it —
   * an approval, a question, the composer after a queue clears — is worth doing
   * in the pane you are working in and is theft anywhere else.
   */
  active: boolean
  onActivate: () => void
  /**
   * The language an explanation comes back in, or empty when none is set.
   *
   * A prop rather than a read of its own, because it now decides whether a
   * button exists under **every** reply rather than what a selection is offered.
   * A pane cannot wait for a drag to learn that, and `App` already owns the one
   * moment the value can change from inside the app — the settings sheet
   * closing.
   */
  explainLanguage: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const { conversationId, participants, cwd } = props.session
  const restarting = props.session.restarting === true
  const preparing = props.session.starting === true || restarting
  const [view, setView] = useState<TranscriptView>(() =>
    props.carry === undefined ? EMPTY_VIEW : { ...EMPTY_VIEW, ...props.carry.view }
  )
  const pendingReplies = Object.values(view.replies)
  const workingAgents = [
    ...new Set([...view.working, ...pendingReplies.map((reply) => reply.agentId)]),
  ]
  /** The composer holds the draft now; the pane only reads it on unmount. */
  const composer = useRef<ComposerHandle | null>(null)
  /** Where the composer leaves its draft, so the pane can carry it out. */
  const box = useRef<ComposerState>({
    draft: props.carry?.draft ?? '',
    attached: [...(props.carry?.attached ?? [])],
    mode: props.carry?.mode ?? 'work',
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
  /*
   * This session's Changes panel, in the store for the same two reasons the
   * terminal is: `⌘⇧G` is handled by a document-level listener in `Workspace`
   * and may fire while this is unmounted, and the store is what persists — so
   * the base you chose is still chosen after a relaunch.
   */
  /*
   * What each agent says it is doing, as a comma-joined `agent:activity` string.
   *
   * A string rather than the record so a pane re-renders only when a provider
   * actually changes its mind — a fresh object would compare unequal on every
   * push, and this arrives several times a turn.
   */
  const activityByAgent = useSessionActivity(conversationId)
  const backgroundAgents = useBackgroundAgents(conversationId)
  const note = useConversationNote(conversationId, props.session.starting === true)
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
    sourceEventIds: string[]
  } | null>(null)
  /**
   * The open quick-question card, if any.
   *
   * Held apart from `selected` and seeded from it: once a card is open, the
   * passage it is about must not change. Scrolling drops the offer and a later
   * selection replaces it, and either would otherwise re-point a question that
   * has already been asked.
   */
  const [askingAbout, setAskingAbout] = useState<OpenCard | null>(props.carry?.card ?? null)
  const [openActivity, setOpenActivity] = useState<ReadonlySet<string>>(
    () => new Set(props.carry?.openActivity ?? [])
  )
  const setActivityOpen = useCallback((keys: readonly string[], open: boolean) => {
    setOpenActivity((current) => {
      if (keys.some((key) => current.has(key)) === open) return current
      const next = new Set(current)
      for (const key of keys) {
        if (open) next.add(key)
        else next.delete(key)
      }
      return next
    })
  }, [])
  const rows = useMemo(() => transcriptRows(view.messages), [view.messages])
  const explainLanguage = props.explainLanguage
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
  /** Read once: whether this pane was the active one at the moment it mounted. */
  const activeOnMount = useRef(props.active)

  /*
   * Live events, held back until the transcript they belong on has arrived.
   *
   * **A push that overtakes the initial read used to erase it.** `reduceEvents`
   * skips anything at or below `lastSeq`, which is right for a duplicate and
   * catastrophic for a backfill: if push 101 lands before the read of 1–100
   * resolves, the view's `lastSeq` is already 101 and *every one of those
   * hundred events is discarded*. The transcript then shows the single pushed
   * row and nothing before it — no history, no pending approvals, no spend —
   * until something forces another read. `max(lastSeq, throughSeq)` prevented
   * `lastSeq` going backwards but could not bring back rows already dropped,
   * and the test for that case used an empty response, so it never saw this.
   *
   * `QuickQuestion` already solved it this way: buffer while the read is in
   * flight, then apply in order once it lands. Ordering is the fix, not
   * merging — the reducer is a fold over increasing `seq` and should stay one.
   */
  const readDone = useRef(false)
  const pending = useRef<TranscriptEvent[]>([])

  useEffect(() => {
    readDone.current = false
    pending.current = []
  }, [conversationId])

  const refreshTaskOnMount = useRef((props.carry?.view.lastSeq ?? 0) > 0)
  const taskEpoch = view.taskEpoch
  const taskBehind = view.taskEpoch !== view.taskSyncedEpoch
  useEffect(() => {
    if (!taskBehind && !refreshTaskOnMount.current) return undefined
    let current = true
    window.chorus
      .taskState({ conversationId })
      .then(({ task, throughSeq }) => {
        if (!current) return
        refreshTaskOnMount.current = false
        setView((held) => mergeTaskState(held, task, taskEpoch, throughSeq))
      })
      .catch(fail(setError))
    return () => {
      current = false
    }
  }, [conversationId, taskEpoch, taskBehind])

  useEffect(
    () =>
      window.chorus.onEvents((events) => {
        const mine = events.filter((e) => e.conversationId === conversationId)
        if (mine.length === 0) return
        if (!readDone.current) {
          pending.current.push(...mine)
          return
        }
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
      .transcript(
        view.lastSeq > 0
          ? // Coming back to a pane that still holds its transcript: catch up on
            // what was missed rather than re-reading a page it already has.
            { conversationId, afterSeq: view.lastSeq, live: true }
          : // A cold open reads the newest page, not the conversation.
            { conversationId, limit: PAGE_EVENTS }
      )
      .then(({ events, throughSeq, state }) => {
        profileMark('transcriptReceived')
        /*
         * The buffered pushes are applied in the same update as the read, and
         * after it. Draining them separately would let React commit the read
         * alone first, which is a visible flash of a transcript that is missing
         * the newest rows.
         */
        const held = pending.current
        pending.current = []
        readDone.current = true
        // The rule lives in `reduceTranscriptRead`, which is pure and tested;
        // this is the plumbing.
        setView((current) => {
          const read = reduceTranscriptRead(current, events, throughSeq)
          /*
           * State before the buffered pushes, never after. The queried state is
           * a snapshot from the moment of the read; a push that arrived since
           * may have decided an approval or answered a question, and applying
           * the snapshot last would put the card back.
           */
          const withState =
            state === undefined
              ? read
              : applyTranscriptState(read, { ...state, replies: state.replies ?? [] })
          const next = held.length === 0 ? withState : reduceEvents(withState, held)
          // Inside the updater, which React runs during the render pass — so
          // this is genuinely when the fold finished, not when it was queued.
          profileMark('reduced')
          return next
        })
      })
      .catch((error: unknown) => {
        // Open the gate even on failure: leaving it shut would silently drop
        // every live event for the rest of the session, which is worse than the
        // failed read the user is already being told about.
        readDone.current = true
        fail(setError)(error)
      })
  }, [conversationId])

  /*
   * The commit that carried the transcript, and an approximation of its paint.
   *
   * Runs after every commit and takes each mark once, so it lands on the first
   * commit following the reduction rather than on whichever one happens to be
   * last. `profileMark` is inert unless the profiling harness armed it, so this
   * costs one property read per commit in a normal run.
   */
  useLayoutEffect(() => {
    if (!profileHas('reduced') || profileHas('committed')) return
    profileMark('committed')
    profileMarkAfterPaint('paintedApprox')
  })

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

  const floor = useRef<HTMLDivElement | null>(null)
  const settleFloor = useRef<(immediately: boolean) => void>(() => undefined)
  const lastTop = useRef(0)
  const pinnedTop = useRef<number | null>(null)
  const atBottom = useRef(following.current)
  const lastHeight = useRef(0)
  const pointerHeld = useRef(false)
  const pointerRelease = useRef(0)

  const markFollowing = useCallback((value: boolean): void => {
    following.current = value
    score.current?.setAttribute('data-following', value ? 'true' : 'false')
  }, [])

  useLayoutEffect(() => {
    score.current?.setAttribute('data-following', following.current ? 'true' : 'false')
  }, [])

  const readerAnchor = useRef<{ anchor: ReaderAnchor; scrollTop: number } | null>(null)
  const restoreFrom = useRef({
    anchor: props.carry?.anchor ?? null,
    scrollTop: props.carry?.scrollTop ?? 0,
  })
  const restorePending = useRef(false)
  const anchorFrame = useRef(0)
  const captureAnchor = useCallback((): void => {
    if (anchorFrame.current !== 0) return
    anchorFrame.current = requestAnimationFrame(() => {
      anchorFrame.current = 0
      const el = score.current
      const content = transcript.current
      if (el === null || content === null || following.current || restorePending.current) return
      const anchor = readerAnchorOf(el, content)
      if (anchor !== null) readerAnchor.current = { anchor, scrollTop: el.scrollTop }
    })
  }, [])

  useEffect(
    () => () => {
      cancelAnimationFrame(anchorFrame.current)
      anchorFrame.current = 0
    },
    []
  )

  const stopFollowing = useCallback((): void => {
    markFollowing(false)
  }, [markFollowing])

  const resumeFollowing = useCallback((): void => {
    if (following.current) return
    markFollowing(true)
    settleFloor.current(false)
  }, [markFollowing])

  useEffect(() => {
    const release = (event: Event): void => {
      const touchPan =
        event instanceof PointerEvent &&
        event.type === 'pointercancel' &&
        event.pointerType === 'touch'
      if (touchPan) return
      cancelAnimationFrame(pointerRelease.current)
      pointerRelease.current = requestAnimationFrame(() => {
        pointerRelease.current = 0
        pointerHeld.current = false
      })
    }
    const blur = (event: FocusEvent): void => {
      if (event.target !== window) return
      cancelAnimationFrame(pointerRelease.current)
      pointerRelease.current = 0
      pointerHeld.current = false
    }
    const releases = ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const
    for (const type of releases) {
      window.addEventListener(type, release, { capture: true, passive: true })
    }
    window.addEventListener('blur', blur)
    return () => {
      for (const type of releases) window.removeEventListener(type, release, { capture: true })
      window.removeEventListener('blur', blur)
      cancelAnimationFrame(pointerRelease.current)
      pointerRelease.current = 0
      pointerHeld.current = false
    }
  }, [])

  /*
   * There used to be a `makeRoom` here, and its removal is the point.
   *
   * It padded the current turn out to a full view — a spacer sized to exactly
   * what the turn was short of — so a question could rise to the top of the
   * window the instant it was asked, whatever the reply turned out to be. The
   * pin then had somewhere to travel and the question was the heading of its
   * own answer from the first token.
   *
   * What it also produced was a screen of blank under every short reply, which
   * is what it was reported as. The argument for it was that otherwise "a
   * question asked at the foot of a long history stays where it landed until
   * the answer happens to be tall enough to lift it — which reads as the layout
   * waiting for the agent's permission". That is a fair description of what now
   * happens, and it was chosen deliberately over the void: the question rises
   * as the answer is written, which is the same information arriving as it is
   * earned rather than a promise made in advance.
   *
   * Nothing replaces it, because nothing has to. `.turn-head` is `position:
   * sticky` inside `.turn`, and a sticky header pins only while its own block
   * is taller than the scrollport — so a reply longer than the screen holds the
   * question at the top by construction, and a short one leaves it in the flow
   * where it belongs. That is exactly the rule asked for, expressed as the one
   * line of CSS it already was.
   */

  useEffect(() => {
    const el = score.current
    const content = transcript.current
    if (el === null || content === null) return
    lastTop.current = el.scrollTop

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
     * The work happens a frame later, and that is a fix rather than a tidying.
     *
     * It was written for `makeRoom`, which wrote to a child of the observed
     * element and so made a guaranteed ResizeObserver loop: Chromium re-ran the
     * observation, hit its depth limit, reported "loop completed with
     * undelivered notifications" and **dropped the rest**. Eleven times per
     * answer, measured, on healthy runs too. When the dropped one was the last
     * of a turn — the typewriter's final jump, a diff card committing at once —
     * nothing ever resized again to correct it, and the transcript sat stranded
     * below the fold. That was the "stops dead mid-reply" report: 182px hidden,
     * 7 observer firings against a healthy run's 25.
     *
     * `makeRoom` is gone, so the loop it caused cannot form either way. The
     * frame stays for the other half of what it bought: a burst of
     * notifications coalesces into one layout, where the old shape paid for
     * each. Removing it would be a performance change, not a simplification.
     */
    const spacer = floor.current
    let seen = content.offsetHeight
    let slack = 0
    let hold = 0
    let ease = 0

    const setSlack = (px: number): void => {
      slack = Math.max(0, px)
      if (spacer !== null) spacer.style.height = `${String(slack)}px`
    }

    const stopTimers = (): void => {
      clearTimeout(hold)
      cancelAnimationFrame(ease)
      hold = 0
      ease = 0
    }

    const glide = (): void => {
      hold = 0
      const from = slack
      const start = performance.now()
      const step = (now: number): void => {
        if (!following.current) {
          ease = 0
          return
        }
        const t = Math.min(1, (now - start) / FLOOR_EASE_MS)
        setSlack(from * (1 - t) ** 3)
        el.scrollTop = el.scrollHeight
        pinnedTop.current = el.scrollTop
        ease = t < 1 ? requestAnimationFrame(step) : 0
      }
      ease = requestAnimationFrame(step)
    }

    const holdSlack = (px: number): void => {
      stopTimers()
      setSlack(px)
      if (slack > 0) hold = window.setTimeout(glide, FLOOR_HOLD_MS)
    }

    settleFloor.current = (immediately) => {
      holdSlack(immediately ? 0 : slack)
    }

    const follow = new ResizeObserver(() => {
      const height = content.offsetHeight
      const change = height - seen
      seen = height
      lastHeight.current = height
      if (!following.current) {
        if (!restorePending.current && readDone.current && el.clientHeight > 0) {
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 1
        }
        captureAnchor()
        return
      }
      if (change < 0) holdSlack(-change > el.clientHeight ? 0 : slack - change)
      else if (change > 0 && slack > 0) holdSlack(slack - change)
      el.scrollTop = el.scrollHeight
      pinnedTop.current = el.scrollTop
      atBottom.current = true
    })
    follow.observe(content)
    // The pane too: a window resize changes where the bottom is without
    // changing a word, and a following transcript has to stay pinned to it.
    follow.observe(el)
    return () => {
      follow.disconnect()
      stopTimers()
      settleFloor.current = () => undefined
    }
  }, [])

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
   * only touches layout when it actually has to correct.
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
        el.scrollTop = el.scrollHeight
        pinnedTop.current = el.scrollTop
      }
      if (Date.now() < until) frame = requestAnimationFrame(watch)
    }
    frame = requestAnimationFrame(watch)
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [view.busy])

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

  /*
   * Whether an earlier page is in flight, and whether there is one to fetch.
   *
   * A ref rather than state for the in-flight flag: it guards a fetch, and a
   * re-render is not what the guard is for. `atBeginning` is state because it
   * changes what is drawn — there is nothing above the first row once it is true.
   */
  const loadingEarlier = useRef(false)
  const [atBeginning, setAtBeginning] = useState(false)

  /**
   * Fetches the page before what is held, when the reader nears the top.
   *
   * **Prepending, not reducing.** `reduceEvents` skips anything at or below
   * `lastSeq`, which is the guard that keeps the live stream safe and also what
   * makes it unable to accept an earlier range. `prependEvents` is a second
   * entry point that folds rows in ahead and touches no accumulated state — that
   * state came from the query and an earlier page would only contradict it.
   *
   * No state is requested with a page of history, for the same reason.
   */
  const loadEarlier = useCallback((): void => {
    if (loadingEarlier.current || atBeginning) return
    const oldest = latest.current.view.firstSeq
    if (oldest <= 1) {
      setAtBeginning(true)
      return
    }
    loadingEarlier.current = true
    window.chorus
      .transcript({ conversationId, beforeSeq: oldest, limit: PAGE_EVENTS })
      .then(({ events }) => {
        if (events.length === 0) {
          setAtBeginning(true)
          return
        }
        setView((current) => prependEvents(current, events))
      })
      .catch(fail(setError))
      .finally(() => {
        loadingEarlier.current = false
      })
  }, [conversationId, atBeginning])

  /*
   * Rows arriving *above* the viewport push everything down, and the reader must
   * not see it.
   *
   * A prepended page adds real height at the top of a fully-mounted transcript,
   * so the paragraph someone is reading slides down the screen by exactly that
   * much. Compensating for it is a subtraction that has to land in the same
   * commit as the growth — split across two, the intermediate state is painted
   * and the jump is real.
   *
   * Guarded on the row count rather than run unconditionally: `scrollHeight`
   * also changes when a diff card expands or markdown reflows, and correcting
   * for *those* would fight the reader instead of helping them. Only a page
   * landing changes how many messages the view holds.
   */
  const lastFirstSeq = useRef(view.firstSeq)
  useLayoutEffect(() => {
    const el = score.current
    const content = transcript.current
    if (el === null || content === null) return
    const grew = content.offsetHeight - lastHeight.current
    const prepended =
      lastFirstSeq.current > 0 && view.firstSeq < lastFirstSeq.current && !following.current
    lastHeight.current = content.offsetHeight
    lastFirstSeq.current = view.firstSeq
    if (prepended && grew > 0 && el.getAttribute('data-following') !== 'false') el.scrollTop += grew
  }, [view.firstSeq])

  const turnKey = currentTurn?.key ?? null

  useEffect(() => {
    /*
     * The message you just sent is on screen before anything answers it.
     *
     * Following is driven by the transcript getting taller, and the observer
     * that watches for that runs a frame later — so without this the question
     * sits below the fold for a frame, or longer if the growth is small enough
     * to be coalesced. Keyed on which message the turn is, so it fires once per
     * question rather than on every token of the reply.
     */
    const el = score.current
    if (el === null || turnKey === null) return
    settleFloor.current(true)
    if (!following.current) return
    el.scrollTop = el.scrollHeight
    pinnedTop.current = el.scrollTop
  }, [turnKey])

  useLayoutEffect(() => {
    const el = score.current
    const content = transcript.current
    const held = readerAnchor.current
    if (el === null || content === null || held === null) return
    if (following.current || restorePending.current) return
    if (restoreReaderAnchor(el, content, held.anchor)) {
      readerAnchor.current = { anchor: held.anchor, scrollTop: el.scrollTop }
    }
  }, [turnKey])

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
    const sourceEventIds = [
      sourceEntryAt(range.startContainer)?.eventId ?? '',
      sourceEntryAt(range.endContainer)?.eventId ?? '',
    ].filter((id, index, all) => id !== '' && all.indexOf(id) === index)
    setSelected(anchor === null ? null : { text, source, anchor, sourceEventIds })
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

  const onActivate = props.onActivate
  /*
   * A problem sent from VS Code, staged in this pane's composer.
   *
   * Staged and never sent, which is the whole shape of the feature: a gesture in
   * another application must not spend a turn here. What to *do* about the
   * problem is what the composer is for.
   *
   * Scoped to this conversation by main, which is the only place that knows
   * which conversations are open on the root the extension named. The pane also
   * takes focus — you pressed a button in VS Code expecting to end up here, and
   * a draft appearing in a background tab is a message you never find.
   */
  useEffect(
    () =>
      window.chorus.onDiagnostic((diagnostic) => {
        if (diagnostic.conversationId !== conversationId) return
        /*
         * `insert` rather than `withEditorContext`, and the difference is where
         * it lands: editor context is prepended because it qualifies whatever
         * you were already writing, while this *is* the subject. It appends,
         * like a promoted aside, and focuses the box — which is the same
         * behaviour arriving from a different direction.
         */
        composer.current?.insert(
          formatDiagnosticBlock(diagnostic, { heading: t('ide.diagnostic.heading') })
        )
        onActivate()
      }),
    [conversationId, t, onActivate]
  )

  /**
   * Opens a file a transcript row names, in this project's editor.
   *
   * **Unchanged when the destination changed**, which is the point of sending a
   * path rather than a decision: main picks the embedded workbench over
   * external VS Code, and a row that wants a line says so in the path it
   * already holds (`file.ts:42`). Nothing here had to learn about either.
   *
   * **The path is sent as the row holds it and resolved in main.** It comes off
   * agent output, and the renderer is the least trustworthy thing in the process
   * tree — so what crosses is `{conversationId, path}` and main decides, against
   * that conversation's own directory, whether it may be opened at all. The same
   * shape `ide:snapshot` uses, for the same reason.
   *
   * Failures land in the pane's error line rather than in silence: `code` not
   * being on `PATH` is the common one, and a row that does nothing when clicked
   * is indistinguishable from a broken feature.
   */
  const openFile = useCallback(
    (path: string) => {
      window.chorus
        .ideOpenFile({ conversationId, path })
        .then((result) => {
          if (!result.ok) {
            // The path and folder go into the sentence, so a refusal can be
            // acted on rather than only read.
            setError(
              t(`ide.openError.${result.reason ?? 'unknown'}`, {
                path: result.path ?? path,
                project: result.project ?? '',
              })
            )
          }
        })
        .catch(fail(setError))
    },
    [conversationId, t]
  )

  /**
   * Explains a whole reply in the user's own language, from a button under it.
   *
   * `openRecap`'s twin down to the anchor, and it is worth saying why it is not
   * `openCard('explanation')` with a different excerpt: `openCard` starts from
   * `selected`, and the whole point of this is that there is no selection. The
   * subject is the reply.
   *
   * **That is also the bug fix.** The excerpt main checks is `message.text` —
   * the prefix of the reply as the reducer holds it — so `containsPassage` is
   * comparing the log against itself rather than against whatever the DOM
   * serialized. The failure people met, `That passage is not part of that
   * reply`, is unreachable on this path however long the answer is.
   *
   * `message.text` and not `said`: `trailingSummary` cuts a trailing summary off
   * into its own card, and what is left is still an exact prefix of what the
   * agent wrote, which is all the guard asks for.
   */
  const openExplain = useCallback(
    (message: TranscriptMessage, from: DOMRect) => {
      if (!isAgentId(message.actor)) return
      if (message.eventId === '' || message.text === '') return

      const paneEl = pane.current
      if (paneEl === null) return
      const paneRect = paneEl.getBoundingClientRect()

      const opened = window.chorus.openAside({
        conversationId,
        sourceEventId: message.eventId,
        excerpt: message.text,
        purpose: 'explanation',
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
        purpose: 'explanation',
        opening: opened.then((result) => result.asideId),
        // Main's answer, not this pane's copy of the setting: the card's heading
        // names the language, and the log is what decides which one was used.
        language: opened.then((result) => result.language),
      })

      setSelected(null)
      window.getSelection()?.removeAllRanges()
    },
    [conversationId]
  )

  /**
   * The same three actions, aimed at a question instead of a reply.
   *
   * A question card is where they are needed most and where they were hardest
   * to get: a reply you did not follow can be re-read at leisure, while a
   * question is blocking, expires, and is often the densest thing in the
   * transcript. The card that prompted this asked which of three data models to
   * hand to the backend, and the prompt was one sentence over nine lines of
   * `status` versus `activeFilter` versus `versionWindow`.
   *
   * `openExplain`'s shape, deliberately, down to the anchor: there is no
   * selection here either, and the subject is the whole card. The difference is
   * only what `excerpt` is, and `questionText` builds it — the header, the
   * prompt, and every option, because the options are most of what is hard to
   * read.
   *
   * **The excerpt is checked against a projection main builds for itself.** It
   * used to be impossible to get here at all: `openAside` refused anything that
   * was not `agent.message.completed`, and `PendingQuestion` did not even carry
   * an event id to name. Both are fixed rather than bypassed, and the guard is
   * no weaker — main re-derives the card's words from the logged payload with
   * the same `question-text.ts` this call renders with, so the renderer still
   * cannot make an agent appear to have said something it did not.
   */
  const openAboutQuestion = useCallback(
    (
      question: PendingQuestion,
      field: QuestionField,
      purpose: AsidePurpose,
      from: DOMRect
    ): void => {
      const actor = question.agentId
      if (!isAgentId(actor)) return
      if (question.eventId === '' || !askableQuestion(field)) return

      const paneEl = pane.current
      if (paneEl === null) return
      const paneRect = paneEl.getBoundingClientRect()

      const excerpt = questionText(field)
      const opened = window.chorus.openAside({
        conversationId,
        sourceEventId: question.eventId,
        excerpt,
        purpose,
      })

      setAskingAbout({
        text: excerpt,
        anchor: {
          space: 'pane',
          centreX: from.left + from.width / 2 - paneRect.left,
          top: from.top - paneRect.top,
          height: from.height,
        },
        source: {
          eventId: question.eventId,
          actor,
          // Not `message`: `askableSource` uses these to decide what a *selection*
          // may become, and a question is not a reply. Nothing downstream reads
          // them for this path, and labelling it honestly is what keeps that true.
          kind: 'question',
          status: 'complete',
        },
        purpose,
        opening: opened.then((result) => result.asideId),
        // Main's answer, not this pane's copy of the setting.
        language: opened.then((result) => result.language),
      })
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
      if (!isAgentId(message.actor)) return
      markFollowing(true)
      window.chorus
        .sendMessage({ conversationId, text: `@${message.actor} Go ahead.`, intent: 'go' })
        .catch(fail(setError))
    },
    [conversationId, markFollowing]
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
  const openCardRef = useRef<OpenCard | null>(null)
  openCardRef.current = askingAbout
  /*
   * **Unmounting no longer closes the fork**, and that is the change.
   *
   * It used to, on the reasoning that a pane can go away with a card open and
   * the fork outlives the component. True, but it made the commonest reason a
   * pane goes away — looking at another session for a moment — destroy an answer
   * mid-read. The card rides in `SessionCarry` now and comes back with the tab.
   *
   * Nothing leaks. Main ends a conversation's asides when the conversation ends
   * (`closeConversation` drops every aside whose `parentId` matches), which is
   * the case this cleanup was standing in for, and it covers ending a session
   * and restarting one — the two moments `App` also drops the carry.
   */

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
  /**
   * The wait outlasted any real start, so it stops claiming to be one.
   *
   * Separate from `awaiting` rather than replacing it, because the row still
   * belongs on screen — what changes is what it says. See the deadline below.
   */
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    /*
     * Cleared by the agent starting, or by anything the system had to say —
     * an error or a refusal arrives as a notice, and the row must not outlive
     * the turn it was waiting for.
     */
    const latest = view.messages.at(-1)
    if (
      view.working.length === 0 &&
      !(latest?.actor === 'system' && (latest.level === 'error' || latest.level === 'warn')) &&
      !(latest?.kind === 'message' && isAgentId(latest.actor))
    )
      return
    setAwaiting(false)
    setStalled(false)
  }, [view.working.length, view.messages])

  /*
   * And a deadline, because both clauses above are things that *arrive*.
   *
   * Seen in the field: a finished reply with `getting started •••` sitting under
   * it, permanently. Every route out of the row is an event — an agent starting,
   * a system notice, a send that rejects and calls `onSendFailed` — so a send
   * that neither lands nor fails clears nothing, and the row waits for a turn
   * that was never going to start.
   *
   * **This bounds the symptom and does not fix the cause**, which is why C-043
   * is on the board: the honest fix is a send that cannot hang. What it does buy
   * is that the transcript stops asserting something false. Ninety seconds is
   * far past a cold CLI start — the gap this row exists to cover — so a wait
   * that reaches it is not a slow start, it is a lost message.
   *
   * **It used to go quiet at the deadline, and that was wrong.** The argument
   * was that the row's job is to say "it is on its way", so once that cannot be
   * claimed it should stop saying anything. What that produces is a message
   * sitting alone under a transcript with no indication that anything was ever
   * expected — reported as "still no thinking indicators when asking", which is
   * a fair reading of a screen that has nothing on it. It also destroyed the
   * only evidence a user could send: C-043 says as much in its own entry, that
   * the deadline "makes the underlying failure quieter".
   *
   * So the row stays and changes what it says. It stops animating, stops
   * claiming progress, and says the message may not have arrived — which is
   * both true and the one thing worth doing about it.
   */
  useEffect(() => {
    if (!awaiting) return
    const timer = setTimeout(() => {
      setStalled(true)
    }, AWAITING_MAX_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [awaiting])

  const { onForward } = props
  const forwardSelection = useCallback(() => {
    const passage = selected
    if (passage === null) return
    setSelected(null)
    window.getSelection()?.removeAllRanges()
    onForward({ text: passage.text, sourceEventIds: passage.sourceEventIds })
  }, [onForward, selected])

  const forwardReply = useCallback(
    (message: TranscriptMessage) => {
      setSelected(null)
      window.getSelection()?.removeAllRanges()
      onForward({ text: message.fullText ?? message.text, sourceEventIds: [message.eventId] })
    },
    [onForward]
  )

  const sendSelection = useCallback(() => {
    const passage = selected
    if (passage === null) return
    setSelected(null)
    window.getSelection()?.removeAllRanges()
    markFollowing(true)
    setAwaiting(true)
    window.chorus.sendMessage({ conversationId, text: passage.text }).catch((error: unknown) => {
      setAwaiting(false)
      fail(setError)(error)
    })
  }, [conversationId, selected])

  const sendSelectionToNote = useCallback(() => {
    const passage = selected
    if (passage === null) return
    setSelected(null)
    window.getSelection()?.removeAllRanges()
    const existing = note.text.trimEnd()
    const joined = existing === '' ? passage.text : `${existing}\n\n${passage.text}`
    note.edit(joined.slice(0, CONVERSATION_NOTE_MAX_LENGTH))
    if (!note.view.visible) note.changeView({ visible: true })
  }, [note, selected])

  /*
   * What VS Code is showing for *this* pane's project.
   *
   * Metadata only: a path already relative to this conversation's cwd, and a
   * line range. No source text is here and none has crossed yet — that happens
   * once, when Send is pressed.
   */
  /*
   * Read from the store, not held here — Phase 6.
   *
   * It was `useState` in this component, and only the active tab of each group
   * is mounted: switching away and back reinitialised both slots to `null`, and
   * every push that arrived while unmounted had nowhere to land. Nothing put it
   * back, because main's replay fires on runtime events and not on a React
   * component mounting. The composer's `ideAttached` was false again for a
   * reason that had nothing to do with the editor.
   */
  const ide = useIdeContext(conversationId)

  /*
   * What must survive the pane being unmounted.
   *
   * The transcript half is mirrored on every render because it changes with
   * every event; the composer half is *read* on the way out instead, which is
   * what lets the draft live in the composer and a keystroke repaint a textarea
   * rather than a conversation.
   */
  const latest = useRef<Omit<SessionCarry, 'draft' | 'attached'>>({
    view,
    following: following.current,
    scrollTop: props.carry?.scrollTop ?? 0,
  })
  latest.current = {
    view,
    following: following.current,
    scrollTop: score.current?.scrollTop ?? latest.current.scrollTop,
    openActivity: [...openActivity],
  }

  useLayoutEffect(
    () => () => {
      const el = score.current
      const content = transcript.current
      const top = el?.scrollTop ?? latest.current.scrollTop
      const pending = restorePending.current
      const followingNow = following.current || (!pending && atBottom.current)
      let held = readerAnchor.current
      if (!pending && !followingNow && el !== null && content !== null && held?.scrollTop !== top) {
        const anchor = readerAnchorOf(el, content)
        held = anchor === null ? null : { anchor, scrollTop: top }
      }
      props.onCarry(conversationId, {
        ...latest.current,
        following: followingNow,
        scrollTop: pending ? restoreFrom.current.scrollTop : top,
        anchor: followingNow ? null : pending ? restoreFrom.current.anchor : (held?.anchor ?? null),
        ...box.current,
        ...(openCardRef.current === null ? {} : { card: openCardRef.current }),
      })
    },
    [conversationId, props.onCarry]
  )

  // Lent on mount, withdrawn on unmount. Reading `box` rather than copying it is
  // what keeps this free: nothing runs while somebody types.
  const lend = props.onDraftReader
  useEffect(() => {
    lend(conversationId, () => box.current.draft)
    return () => {
      lend(conversationId, null)
    }
  }, [conversationId, lend])

  /**
   * Putting the view back where it was, after a drag or a split remounted us.
   *
   * Dragging a tab to another pane, splitting, and reordering all move this
   * component in the tree, and only the moved pane remounts — which is why the
   * one you dragged was the one that jumped to the top while its neighbours sat
   * still. Both halves of the old restore were wrong.
   *
   * **A pinned transcript is re-pinned, not restored.** `following` is carried
   * (line 308 reads it back) and was then ignored here, so a conversation that
   * was sitting at the bottom came back to whatever number `scrollTop` last
   * happened to be. The bottom is a *position* that survives the content being
   * measured again; a number is not.
   *
   * **And one assignment cannot land before the content has a height.** In a
   * layout effect the transcript has not measured: markdown, diff cards and
   * terminals all expand after mount. Assigning 4800 to a scroller whose
   * `scrollHeight` is still 600 silently clamps to ~0 — no error, no warning,
   * and nothing afterwards puts it right, because the ResizeObserver's
   * correction is guarded on `following` and this branch is the one that is not
   * following. That is the whole bug for a reader who had scrolled up.
   *
   * So the position is re-applied only while the scroller is still too short to
   * hold it, and the loop ends the moment it *can* — which is also what keeps it
   * from fighting the reader. Until the content is tall enough there is no
   * deliberate place to scroll to, so writing during that window overrides
   * nobody; once it is, this sets the position once and stops. Bounded by wall
   * clock as well, so a conversation that never grows that tall gives up instead
   * of spinning for the life of the pane.
   */
  useLayoutEffect(() => {
    const el = score.current
    if (el === null) return undefined

    /*
     * A following pane is left alone, and writing to it was the bug.
     *
     * The ResizeObserver already pins a following transcript on every resize,
     * so there is nothing here to add — and the write raced it. It landed while
     * the content was still short, then `onScroll` measured the gap the growth
     * opened, read it as the reader having scrolled up, and turned following
     * *off*. Driven: a pane pinned to the bottom came back 128px short of it,
     * and stayed there because the thing that would have corrected it had just
     * been switched off by the correction.
     */
    if (following.current) return undefined

    const wanted = props.carry?.scrollTop
    const anchor = props.carry?.anchor ?? null
    if (anchor === null && (wanted === undefined || wanted === 0)) return undefined

    /*
     * Waits for the range, and writes exactly once.
     *
     * In a layout effect the transcript has not measured: markdown, diff cards
     * and terminals all expand after mount, so assigning 4800 to a scroller
     * whose `scrollHeight` is still 600 silently clamps to ~0 — no error, and
     * nothing afterwards puts it right, because the `ResizeObserver`'s
     * correction is guarded on `following` and this branch is the one that is
     * not following.
     *
     * Parking at "as close as we can get for now" was the other wrong answer: it
     * puts the view at the *transient* bottom, and `onScroll` resumes following
     * within 32px of the end, so every such write said "the reader is at the
     * bottom" and the next resize duly dragged them there.
     *
     * So: read two numbers a frame, write nothing until the position is
     * reachable, then set it and stop. Bounded by wall clock, so a conversation
     * that never grows that tall gives up rather than spinning for the life of
     * the pane.
     */
    let frame = 0
    const until = Date.now() + 2_000
    restorePending.current = true
    const restore = (): void => {
      frame = 0
      const content = transcript.current
      if (
        anchor !== null &&
        content !== null &&
        el.clientHeight > 0 &&
        restoreReaderAnchor(el, content, anchor)
      ) {
        restorePending.current = false
        readerAnchor.current = { anchor, scrollTop: el.scrollTop }
        stopFollowing()
        return
      }
      const reachable = el.scrollHeight - el.clientHeight
      if (anchor === null && wanted !== undefined && reachable >= wanted) {
        el.scrollTop = wanted
        /*
         * Stated rather than inferred. `onScroll` decides following from where
         * the view ends up, and this write is a restoration rather than the
         * reader arriving anywhere.
         */
        restorePending.current = false
        stopFollowing()
        captureAnchor()
        return
      }
      if (Date.now() < until) {
        frame = requestAnimationFrame(restore)
        return
      }
      restorePending.current = false
      if (wanted !== undefined && wanted > 0 && reachable >= wanted) {
        el.scrollTop = wanted
        stopFollowing()
        captureAnchor()
      }
    }
    const navigated = (): void => {
      cancelAnimationFrame(frame)
      frame = 0
      restorePending.current = false
      for (const type of NAVIGATION_EVENTS) el.removeEventListener(type, navigated)
    }
    for (const type of NAVIGATION_EVENTS) el.addEventListener(type, navigated, { passive: true })
    restore()

    return () => {
      cancelAnimationFrame(frame)
      for (const type of NAVIGATION_EVENTS) el.removeEventListener(type, navigated)
    }
  }, [])

  /*
   * The subscription moved to `App`. One listener for the app, writing into the
   * store, is what makes the context outlive an unmounted tab — a listener per
   * `Session` can only ever feed a component that is on screen.
   */

  const decide = useCallback(
    (
      approval: PendingApproval,
      outcome: 'allow' | 'deny',
      scope: 'once' | 'session' | 'always' = 'once',
      message?: string
    ) => {
      window.chorus
        .decideApproval({
          conversationId,
          agentId: isAgentId(approval.agentId) ? approval.agentId : 'codex',
          approvalId: approval.approvalId,
          outcome,
          scope,
          ...(message === undefined || message.trim() === '' ? {} : { message }),
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
  const asking = view.questions.find((q) => isAgentId(q.agentId))

  const answerQuestion = useCallback(
    (
      request: PendingQuestion,
      outcome: 'answered' | 'cancel',
      answers: { questionId: string; values: string[] }[]
    ) => {
      if (!isAgentId(request.agentId)) return
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
    if (props.active && mayTakeCaret(focusedNow())) composer.current?.focusIfVisible()
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
  const finalKey = finalAnswerKey(view)

  /**
   * The newest message of each speaker still working, so its dot can say so.
   *
   * **The dot used to pulse while a *message* streamed**, and stop the moment
   * the words stopped — which is not the moment the agent stops. A turn that
   * says a sentence, runs three commands and then says another spends most of
   * itself with a solid dot above a finished-looking reply, and that is the
   * whole of the report: you cannot tell whether what you are reading is the
   * last thing you will get. Bound to the turn instead, the dot is honest in
   * both directions — moving means more is coming, still means done.
   *
   * Only the speaker's *newest* message, and that is what makes it affordable:
   * `Entry` is memoised, and a prop that changes while an agent works would
   * re-render every row it has ever written if it were passed to all of them.
   * One row per working agent changes; the rest keep their stable element.
   */
  const liveKeys = new Set([
    ...view.working.map(
      (actor) =>
        view.messages.findLast(
          (m) => m.actor === actor && m.kind === 'message' && !isLiveReply(m.key)
        )?.key
    ),
    ...pendingReplies.map(
      (reply) =>
        view.messages.findLast(
          (message) => message.kind === 'message' && message.key.startsWith(`${reply.requestId}:`)
        )?.key
    ),
  ])

  const entry = (message: TranscriptMessage, index: number): React.JSX.Element => (
    <Entry
      key={message.key}
      message={message}
      /* Its speaker has not finished, whatever this message's own status says. */
      live={liveKeys.has(message.key)}
      /* So a `Changes` card can print `src/rate.ts` rather than the whole
         absolute path an agent reports. Stable per session, so it costs the
         memoisation nothing. */
      cwd={props.session.cwd}
      final={message.key === finalKey}
      held={view.busy && message.key === finalKey}
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
      /*
       * Absent until a language is set, which is the gate the selection offer
       * used and the reason is unchanged: an action that cannot say which
       * language it would answer in is worse than an absent one. `Entry` decides
       * nothing here — it has no way to know — so this is the whole condition.
       */
      onExplain={explainLanguage !== '' && isAgentId(message.actor) ? openExplain : undefined}
      /* Passed for every row: whether a row *has* a file to open is the row's
         own business, and `Entry` is the only thing that knows. */
      onOpenFile={openFile}
      /*
       * Whether the reply *offered* anything is `Entry`'s to decide — it reads
       * the words, and this only supplies the ability to answer.
       */
      onGo={isAgentId(message.actor) ? accept : undefined}
      onForward={isAgentId(message.actor) ? forwardReply : undefined}
    />
  )

  const startOf = (item: TranscriptRow): number => (item.kind === 'entry' ? item.index : item.start)

  const row = (item: TranscriptRow): React.JSX.Element => {
    if (item.kind === 'entry') return entry(item.message, item.index)
    const groupKeys = item.steps.map((step) => `activity:${step.activityKey ?? step.key}`)
    const open = groupKeys.some((key) => openActivity.has(key))
    return (
      <details
        key={item.key}
        className={`activity entry--${item.actor}`}
        data-row-key={item.key}
        open={open}
        onToggle={(event) => {
          setActivityOpen(groupKeys, event.currentTarget.open)
        }}
      >
        <summary
          className="entry activity-summary"
          data-grouped="true"
          data-headless="true"
          onClick={() => {
            if (!open) stopFollowing()
          }}
        >
          <span className="entry-mark" aria-hidden="true">
            <span className="tick" />
          </span>
          <span className="said">
            <span className="command-summary">
              <span className="command-caret" aria-hidden="true">
                {open ? '⌄' : '›'}
              </span>
              <span className="activity-agent">{t(`actor.${item.actor}`)}</span>
              <span className="activity-count">
                {item.calls === 0
                  ? t('tool.activity')
                  : t('tool.activityCalls', { count: item.calls })}
              </span>
              {item.failed > 0 && (
                <span className="activity-failed">
                  {t('tool.activityFailed', { count: item.failed })}
                </span>
              )}
              {item.latest !== undefined && (
                <span className="activity-latest">
                  {item.latest.kind === 'tool' ? item.latest.text : t('tool.shell')}
                </span>
              )}
            </span>
          </span>
        </summary>
        {item.steps.map((message, offset) => entry(message, item.start + offset))}
      </details>
    )
  }

  /*
   * Who is thinking, directly under the question they were asked.
   *
   * The dots in the bar have always breathed for whoever is mid-turn, but they
   * are chrome — small, at the edge, and easy to miss while reading. This sits
   * where the answer will appear, in the voice's own colour, so "is anything
   * happening, and from whom" is answered where you are already looking. Two
   * agents waiting stack, in the order the conversation put them in.
   *
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
    awaiting && view.working.length === 0 && pendingReplies.length === 0 ? (
      <WaitingRow soleAgent={soleAgent} stalled={stalled} />
    ) : null

  /** `claude:compacting,codex:thinking` back into something addressable. */
  const activityOf = (agent: string): ActivityPush['activity'] => {
    const found = activityByAgent
      .split(',')
      .find((entry) => entry.startsWith(`${agent}:`))
      ?.slice(agent.length + 1)
    return found === undefined || found === '' ? null : (found as ActivityPush['activity'])
  }

  const liveSource: LiveSource = {
    working: view.working,
    workingSince: view.workingSince,
    turns: view.turns,
    replies: pendingReplies,
    operations: Object.values(view.operations),
    evidenceAt: view.evidenceAt,
    handoffs: Object.values(view.handoffs),
    approvals: view.approvals,
    questions: view.questions,
    activity: Object.fromEntries(view.working.map((agent) => [agent, activityOf(agent)])),
  }

  const thinking = view.working.map((agent) => (
    <article key={`thinking:${agent}`} className={`entry entry--${agent} entry--thinking`}>
      <span className="entry-mark" aria-hidden="true">
        <span className="tick" />
      </span>
      <div className="entry-head">
        <span className="speaker">{t(`actor.${agent}`)}</span>
      </div>
      <p className="said thinking" role="status">
        {activityOf(agent) === null ? (
          t('workspace.working')
        ) : (
          <ThinkingWord
            kind="thinking"
            offset={offsetForActor(agent)}
            activity={activityOf(agent)}
          />
        )}
        <span className="thinking-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </p>
    </article>
  ))

  const discussionThinking = pendingReplies.map((reply) => (
    <article key={reply.requestId} className={`entry entry--${reply.agentId} entry--thinking`}>
      <span className="entry-mark" aria-hidden="true">
        <span className="tick" />
      </span>
      <div className="entry-head">
        <span className="speaker">{t(`actor.${reply.agentId}`)}</span>
        <span className="entry-live-label">{t('live.chat')}</span>
      </div>
      <p className="said thinking" role="status">
        {reply.phase === 'waiting' ? (
          t('live.waiting')
        ) : reply.phase === 'replying' ? (
          t('live.replying')
        ) : (
          <ThinkingWord kind="thinking" offset={offsetForActor(reply.agentId)} activity={null} />
        )}
        <span className="thinking-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </p>
    </article>
  ))

  const waitingOnBackground =
    view.working.length === 0 && !awaiting
      ? backgroundAgents
          .split(',')
          .filter(isAgentId)
          .sort()
          .map((agent) => (
            <article
              key={`background:${agent}`}
              className={`entry entry--${agent} entry--thinking`}
            >
              <span className="entry-mark" aria-hidden="true">
                <span className="tick" />
              </span>
              <div className="entry-head">
                <span className="speaker">{t(`actor.${agent}`)}</span>
              </div>
              <p className="said thinking" role="status">
                {t('conversation.backgroundWork')}
                <span className="thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </p>
            </article>
          ))
      : null

  const readiness =
    preparing || (spoken.length === 0 && !view.busy && !awaiting && participants.length > 0) ? (
      <article
        className="entry entry--system session-readiness"
        data-preparing={preparing ? 'true' : undefined}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="entry-mark" aria-hidden="true">
          <span className="tick" />
        </span>
        <div className="entry-head">
          <span className="speaker">{t('actor.system')}</span>
        </div>
        <div className="said">
          <p className="session-readiness-line">
            {preparing && <span className="composer-spinner" aria-hidden="true" />}
            <span>
              {t(
                restarting
                  ? 'conversation.restarting'
                  : preparing
                    ? 'conversation.agentsStarting'
                    : 'conversation.readyToSend'
              )}
            </span>
          </p>
          {preparing && (
            <p className="session-readiness-hint">
              {t(restarting ? 'conversation.restartingHint' : 'conversation.startingHint')}
            </p>
          )}
        </div>
      </article>
    ) : null

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
        if (
          e.dataTransfer.types.includes('Files') ||
          e.dataTransfer.types.includes(NOTE_IMAGE_DRAG_TYPE)
        ) {
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
        const urls = noteImageUrls(e.dataTransfer.getData(NOTE_IMAGE_DRAG_TYPE))
        if (urls.length === 0) return
        e.preventDefault()
        void (async () => {
          const results = await Promise.allSettled(
            urls.map((url) => window.chorus.stashNoteImage({ url }))
          )
          const paths = results.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value.path] : []
          )
          await composer.current?.addPaths(paths)
        })()
      }}
      data-file-over={fileOver}
    >
      {error !== null && (
        <ErrorNotice
          message={error}
          onDismiss={() => {
            setError(null)
          }}
        />
      )}

      {/*
       * The transcript, and the Changes panel when there is room beside it.
       *
       * A wrapper rather than a row on `.pane` itself. `.pane` is a flex column
       * on purpose — the comment above it records a real incident where a grid
       * handed `1fr` to the wrong row the moment a conditional error notice
       * appeared as the first child, and pinned the composer up the middle. A
       * second flex container nested inside keeps that fix intact and confines
       * the axis switch to the two children it is about.
       *
       * Under the transcript below `PANE_SIDE_BY_SIDE_MIN`, beside it above.
       * The panel keeps a fixed size on the cross axis in both, so the
       * transcript is still the only child that takes the slack — the property
       * `.score` has always relied on.
       */}
      {/*
        Kept as a wrapper with a fixed orientation, not collapsed away.
        
        It divided the transcript from the Changes panel, and that panel is gone
        — changes are read from git inside the workbench now. `.score` relies on
        being the child of this element that takes the slack, so removing it
        would be a layout change dressed as a cleanup.
      */}
      <div className="pane-split" data-orientation="under">
        <div
          className="score"
          ref={score}
          aria-label={t('conversation.transcript')}
          onMouseUp={readSelection}
          onKeyUp={readSelection}
          onPointerDownCapture={() => {
            cancelAnimationFrame(pointerRelease.current)
            pointerRelease.current = 0
            pointerHeld.current = true
          }}
          /*
           * Following stops on a *gesture*, not on a position.
           *
           * This used to read `scrollTop` moving backwards as "the reader scrolled
           * up", and several things move it backwards that are not a reader:
           * `makeRoom` shrinking the spare room clamped it while it existed, and
           * Chromium's scroll anchoring used to drag it back to hold the view
           * still while cards landed above the foot. Either turned following off
           * for good, and a
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
            const el = e.currentTarget
            const gap = el.scrollHeight - el.scrollTop - el.clientHeight
            if (e.deltaY < 0) stopFollowing()
            else if (e.deltaY > 0 && gap <= 1) resumeFollowing()
          }}
          onTouchMove={() => {
            const el = score.current
            if (el === null) return
            if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) resumeFollowing()
          }}
          onKeyDown={(e) => {
            const el = e.currentTarget
            const gap = el.scrollHeight - el.scrollTop - el.clientHeight
            const down = ['PageDown', 'ArrowDown', 'End'].includes(e.key)
            if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) stopFollowing()
            else if (down && gap <= 1) resumeFollowing()
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
            /*
             * A scroll this component wrote is not a reader arriving anywhere.
             *
             * The windower and the restore both move `scrollTop` deliberately,
             * and either would otherwise be read as a gesture — resuming
             * following for someone who never asked, or leaving it off for
             * someone who did. One expected event per programmatic write.
             */
            /*
             * A screenful from the top, not at it. Waiting for zero means the
             * reader arrives at a hard stop and then waits for a fetch; a
             * screenful of warning is usually enough for the page to land before
             * they get there.
             */
            if (el.scrollTop < el.clientHeight) loadEarlier()
            /*
             * Position is what *resumes* following: coming back to the bottom is
             * unambiguous however you got there. Stopping it is a gesture, which
             * the handlers above own.
             */
            const top = el.scrollTop
            const gap = el.scrollHeight - top - el.clientHeight
            const pinned = pinnedTop.current !== null && Math.abs(top - pinnedTop.current) <= 1
            if (pointerHeld.current && !pinned && top < lastTop.current && gap > 1) stopFollowing()
            else if (top > lastTop.current && gap <= 1) resumeFollowing()
            lastTop.current = top
            if (!restorePending.current && el.clientHeight > 0) atBottom.current = gap <= 1
            if (!following.current) captureAnchor()
          }}
        >
          <div className="score-content" ref={transcript}>
            {readiness}
            {/* History: everything said before the question now being answered. */}
            {(currentTurn === undefined ? rows : rows.filter((r) => startOf(r) < turnAt)).map(row)}

            {currentTurn === undefined ? (
              // Nothing has been asked yet, so there is no turn to pin — an agent
              // can still be working, and says so at the foot as it always did.
              <>
                {thinking}
                {discussionThinking}
                {waitingRow}
                {waitingOnBackground}
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
                </div>
                {rows.filter((r) => startOf(r) > turnAt).map(row)}
                {/*
                  Under the newest row, not under the question.

                  It used to live inside `.turn-head`, which is pinned to the top
                  of the scroller — so during a long turn the one line saying an
                  agent is working sat at the top of the window while the reader
                  watched commands arrive at the bottom. Reported as silence: rows
                  appearing with nothing anywhere saying anyone was busy.

                  Here it travels with the output, which is the only place it can
                  be seen without scrolling back to the question. It is still
                  below the question — what `specs.mjs` asserts — and there is
                  still exactly one of it per working agent.
                */}
                {thinking}
                {discussionThinking}
                {waitingRow}
                {waitingOnBackground}
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
                {/*
                  Send first, and the order is the point rather than taste.

                  Quoting drops the passage into a draft you then still have to
                  write; sending is the whole action in one press. The pill wraps
                  on a narrow pane, so first is also the one guaranteed to be on
                  the row nearest the selection.
                */}
                <button type="button" className="quote-offer-action" onClick={sendSelection}>
                  {t('conversation.sendSelection')}
                </button>
                <button
                  type="button"
                  className="quote-offer-action"
                  disabled={note.state.load !== 'ready'}
                  onClick={sendSelectionToNote}
                >
                  {t('conversation.sendSelectionToNote')}
                </button>
                <button type="button" className="quote-offer-action" onClick={quoteSelection}>
                  {t('conversation.quoteInMessage')}
                </button>
                <button type="button" className="quote-offer-action" onClick={forwardSelection}>
                  {t('conversation.forwardSelection')}
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
                  Explain used to sit here, between the two, and it left because a
                  selection was the wrong input for it. Explaining an answer in your
                  own language is a question about the *reply*, not about a passage
                  — the drag was only how it got there, and it was also what made
                  the feature fail: `openAside` re-checks the text against the log,
                  and every piece of chrome inside `.entry` that the projection
                  cannot produce refused a perfectly real selection. It is a button
                  under the reply now (`Entry.tsx`, `data-entry-action="explain"`).

                  Translate stayed, and the difference is not arbitrary: a passage
                  genuinely is its subject. You translate a sentence, not an answer.

                  Gated on a language having been set. There is no honest guess at
                  someone's own language, and an action that cannot say which one it
                  would produce is worse than an absent one.

                  A word, not an icon, though the request said "translate icon". The
                  others are labelled, and one icon among labels reads as an accident
                  rather than a decision — while an unlabelled icon is the least
                  legible thing on a bar people meet rarely. Icons for all of them is
                  defensible and is a different change; mixing is the only option
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
          <div className="score-floor" ref={floor} aria-hidden="true" />
        </div>

        {/*
         * Mounted only while open — it holds no resource in main, so unmounting
         * it costs a re-read and nothing else. The terminal stays a full-width
         * strip below this wrapper either way: it is a tool you reach for, not
         * the work under discussion, and giving it the same axis switch would
         * mean two grips changing meaning together for no gain.
         */}
        {note.view.visible ? <ConversationNote note={note} /> : null}
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

      {/*
       * This session's terminal was here, and Phase 4 slice 4d retired it.
       *
       * It was a real PTY in main, per conversation, above the composer. A
       * project pane now carries a whole workbench, and that workbench has its
       * own terminal running on the REH — the same process tree that already
       * owns the project's files, rather than a second shell beside it with its
       * own idea of where the project is. Two terminals per project, one of them
       * unable to see what the other did, is worse than either alone.
       *
       * **The global terminal is untouched and stays a PTY.** It belongs to no
       * project, so a per-project workbench has nowhere to put it, and
       * `CLAUDE.md` states plainly that the person gets a real shell.
       */}

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
            onDeny={(message) => {
              decide(current, 'deny', 'once', message)
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
            explainLanguage={explainLanguage}
            onAsk={openAboutQuestion}
          />
        )}

        <TaskProgress
          conversationId={conversationId}
          task={view.task}
          assignment={view.assignment}
          syncing={taskBehind}
          working={view.working}
          workingSince={view.workingSince}
          live={liveSource}
          onError={fail(setError)}
        />

        <Composer
          ref={composer}
          conversationId={conversationId}
          /*
           * The cast, not the live map, and the two differ only when a start
           * failed. An agent whose CLI is missing or whose key is not saved yet
           * is absent from `participants` — and an addressing control that drops
           * it offers no way to ask for it, so the person cannot even find out
           * why it is not answering. Main seats it on the first message sent to
           * it, or appends the reason it could not.
           */
          participants={ALL_AGENTS}
          starting={props.session.starting === true}
          restarting={props.session.restarting === true}
          busy={view.busy}
          workBusy={view.working.length > 0}
          working={workingAgents}
          backgroundAgents={backgroundAgents}
          ide={ide}
          onRestart={props.onRestart}
          report={box}
          history={spoken}
          {...(props.carry === undefined
            ? {}
            : {
                initial: {
                  draft: props.carry.draft,
                  attached: props.carry.attached,
                  ...(props.carry.mode === undefined ? {} : { mode: props.carry.mode }),
                },
              })}
          onError={fail(setError)}
          onSending={() => {
            // You just spoke; you want to see the answer.
            markFollowing(true)
            setAwaiting(true)
          }}
          onSendFailed={() => {
            setAwaiting(false)
          }}
          note={{
            visible: note.view.visible,
            load: note.state.load,
            attention: note.attention,
            onToggle: note.toggle,
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
  explainLanguage,
  onAsk,
}: {
  request: PendingQuestion
  /** How many more sets are queued behind this one. */
  waiting: number
  /** Whether this pane owns the caret; a background card must not take it. */
  active: boolean
  onAnswer: (answers: { questionId: string; values: string[] }[]) => void
  onDismiss: () => void
  /**
   * Empty means Explain and Translate are not offered, exactly as under a reply.
   *
   * The gate is the setting rather than a guess: there is no honest default for
   * someone's own language, and an action that cannot say which one it would
   * produce is worse than an absent one. Main enforces the same rule again.
   */
  explainLanguage: string
  onAsk: (
    question: PendingQuestion,
    field: QuestionField,
    purpose: AsidePurpose,
    from: DOMRect
  ) => void
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
    const control = first.current
    if (control === null) return
    if (fullyVisible(control)) {
      control.focus({ preventScroll: true })
      return
    }
    const item = control.closest<HTMLElement>('.question-item')
    if (item === null || !fullyVisible(item)) return
    const placed = control.getBoundingClientRect()
    const top = item.getBoundingClientRect().top + item.clientTop
    const bottom = top + item.clientHeight
    if (placed.width <= 0 || placed.height <= 0 || placed.height > item.clientHeight) return
    if (placed.top < top) item.scrollTop -= top - placed.top
    else if (placed.bottom > bottom) item.scrollTop += placed.bottom - bottom
    if (!fullyVisible(control)) return
    control.focus({ preventScroll: true })
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

        {/*
          Help with the question, kept away from the answer to it.

          At the foot of the question rather than beside Send, and that is a
          safety choice rather than a layout one: this card is blocking and
          expires, so a row that reads "still stuck?" must not sit among the
          buttons that commit an answer. Same reason the approval queue keeps its
          deny apart from its allow.

          Absent for a secret. The whole point of `isSecret` is that the prompt
          and its answer stay out of anything durable, and handing the prompt to
          a fork is the same kind of leak as logging it — `askableQuestion` is
          where that is decided, so main and this agree by construction.
        */}
        {askableQuestion(asked) && (
          <div className="question-help">
            {explainLanguage !== '' && (
              <button
                type="button"
                className="entry-action"
                data-question-action="explain"
                onClick={(e) => {
                  onAsk(request, asked, 'explanation', e.currentTarget.getBoundingClientRect())
                }}
              >
                {t('conversation.explainSimply')}
              </button>
            )}
            {explainLanguage !== '' && (
              <button
                type="button"
                className="entry-action"
                data-question-action="translate"
                onClick={(e) => {
                  onAsk(request, asked, 'translation', e.currentTarget.getBoundingClientRect())
                }}
              >
                {t('conversation.translateThis')}
              </button>
            )}
            <button
              type="button"
              className="entry-action"
              data-question-action="ask"
              onClick={(e) => {
                onAsk(request, asked, 'question', e.currentTarget.getBoundingClientRect())
              }}
            >
              {t('conversation.askAboutThis')}
            </button>
          </div>
        )}
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

/**
 * Exported for `ApprovalCard.test.tsx`, which mounts it.
 *
 * The rule here is "pure reducers, exported for tests" — and this is the
 * documented exception to it, because the behaviour under test *is* the
 * lifecycle: which button takes focus when the card appears, and which keys it
 * refuses once it has. There is no pure part to extract; the judgement is the
 * effect.
 */
export function ApprovalCard({
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
  /**
   * Refuses it, optionally with words for the agent.
   *
   * The words are the point of refusing an edit: an agent told only "no" tries
   * the same thing again, while one told what to do instead does that. The
   * message reaches the provider, which is where a denial has always been able
   * to carry one — it simply had nothing to carry until now.
   */
  onDeny: (message?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const allow = useRef<HTMLButtonElement | null>(null)

  /*
   * Which button Enter answers, and it is the session grant — except for one
   * kind, where the same button means something else entirely.
   *
   * The wider button is `session` scope for everything but an MCP tool call,
   * and a session grant dies with the window. For `mcpToolCall` it is `always`:
   * an MCP call may never be auto-decided, so a session grant for one was
   * silently refused and the button had to widen further or not exist — it
   * writes to `remembered-grants.json` and outlives restarts.
   *
   * A keystroke that is already armed when the card appears may grant the
   * first. It may not grant the second: a permanent policy change made by a
   * key that was pointed at something else is exactly the failure the focus
   * rules below are written against, and the label there does not even say
   * "for this session".
   */
  /*
   * Allow once is the armed default, for every kind.
   *
   * It was the session grant, on the argument that answering the same ask four
   * times is what makes a queue people stop reading. Driven on 2026-09-04 that
   * argument lost to a simpler one: the key that is already under a finger
   * should do the *narrow* thing. A mistaken Enter on Allow once costs one
   * action you had not read; the same mistake on the wider button costs every
   * one of them for the rest of the session, and the person cannot see what it
   * went on to allow.
   *
   * The wider button is still there for every kind that has one. It just has to
   * be reached for, which is the whole difference.
   */
  /*
   * A file edit asks in its own words, and only a file edit.
   *
   * `ApprovalCard` also draws commands, MCP calls and editor edits, and "Make
   * this edit to X?" is wrong on all three. The wording matches the Claude Code
   * extension because the act is the same one: a proposed change, shown as a
   * diff, held until answered.
   */
  const [reason, setReason] = useState('')
  const isEdit = approval.kind === 'fileChange'
  const editPath = isEdit ? (approval.path ?? null) : null

  /*
   * The default button takes focus as the card appears, so Enter answers it.
   *
   * An approval stops the agent dead, so the fastest possible answer is the
   * point: reaching for the mouse, or Tabbing in from the composer, is friction
   * on the one interaction that is always blocking. Keyed on the approval id as
   * well as mount, so the next request in a queue claims focus too even if
   * React reuses this instance.
   *
   * Never out of a sentence someone is part-way through, though. The card
   * arrives when the *agent* decides, not when the user does, and it used to
   * land on the button mid-word — scattering the rest of the typing across it
   * and leaving the next Enter to approve a command nobody had read.
   */
  useEffect(() => {
    if (!active) return
    if (!mayTakeCaret(focusedNow())) return
    if (!fullyVisible(allow.current)) return
    allow.current?.focus({ preventScroll: true })
  }, [approval.approvalId, active])

  /*
   * Enter approves. Space does not, and a held Enter approves once.
   *
   * Both guards exist because whichever button this lands on takes focus on its
   * own, which makes the usual button keys dangerous here:
   *
   *  - **Space.** If a request lands while you are typing, focus moves
   *    mid-sentence and the next space of ordinary prose would activate the
   *    button — approving a command you had not read. Nothing else the user can
   *    type reaches this button, so Space is dropped and Enter is the only key
   *    that approves.
   *  - **Repeat.** Auto-repeat fires ~30 times a second, and every approval
   *    unmounts this card and focuses the next one's button — so one leant-on
   *    key would walk the whole queue. Each approval costs its own deliberate
   *    press.
   *
   * Deny keeps both keys: refusing is the safe direction.
   */
  const guardKeys = (e: React.KeyboardEvent): void => {
    if (e.key === ' ' || (e.repeat && e.key === 'Enter')) e.preventDefault()
  }

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
        <strong>
          {isEdit && editPath !== null
            ? t('ask.heading', { path: editPath })
            : t('approval.wants', { agent: approval.agentId })}
        </strong>
        {waiting > 0 && (
          <span className="approval-queue">{t('approval.waiting', { count: waiting })}</span>
        )}
      </header>
      <pre className="approval-summary">{approval.summary}</pre>
      {/*
        An editor edit says where and against what, above the diff.
        The version is the field that makes a later conflict comprehensible —
        "it moved on from 7" means nothing if nobody was told it was 7.
      */}
      {approval.path !== undefined && (
        <p className="approval-where">
          <span className="path">{approval.path}</span>
          {approval.where !== undefined && <span> · {approval.where}</span>}
          {approval.version !== undefined && (
            <span> · {t('approval.atVersion', { version: approval.version })}</span>
          )}
        </p>
      )}
      {approval.patch !== undefined ? (
        <ToolPatch patch={approval.patch} nested={false} />
      ) : (
        approval.detail !== null && <pre className="approval-detail">{approval.detail}</pre>
      )}
      {/*
        What to do instead, in the person's own words.
        
        A denial has always reached the provider as a message; until now that
        message was the fixed string "Denied by the user", so the one useful
        thing a refusal could carry could not be said. An agent told only "no"
        retries the same edit; one told why does something else.
        
        Enter sends it, because a box you have to leave to answer is a box people
        type in and then lose. Empty is not special-cased here — main falls back
        to the plain denial when nothing was typed.
      */}
      {isEdit && (
        <input
          className="approval-reason"
          type="text"
          value={reason}
          placeholder={t('ask.tellInstead')}
          aria-label={t('ask.tellInstead')}
          onChange={(event) => {
            setReason(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            onDeny(event.currentTarget.value)
          }}
        />
      )}
      <div className="approval-actions">
        <button
          ref={allow}
          type="button"
          className="btn btn--go"
          onClick={onAllow}
          onKeyDown={guardKeys}
        >
          {isEdit ? t('ask.yes') : t('approval.allowOnce')}
        </button>
        {/*
          Granted for the session, not remembered past it — and the default.

          The same ask arriving four times in a row is the commonest way an
          approval queue becomes something you stop reading, which is the
          failure mode the whole card exists to avoid. Answering it once per
          session is the answer most people mean, and making them reach past
          the armed key to say so produced the queue it was meant to prevent.

          It used to cost a deliberate press, on the argument that the wider
          grant should. What that argument missed is *how much* wider: a
          session grant ends with the window, so the blast radius of a mistaken
          Enter is this sitting, and the same mistake on Allow once costs a
          command you had not read either. The narrower button is not the safer
          one by enough to be worth the friction.

          Scoped to the session because a permission that outlived the window
          would be a policy change, and those are made in Settings where they
          can be seen — which is exactly why `mcpToolCall`, where this button
          means `always`, keeps Allow once as its default instead.
        */}
        {/*
          Not offered for a file edit, and that is the whole point of the
          feature rather than a simplification of it.
        
          "Allow all edits this session" stops the asking, which is what it says
          — and what it says is the opposite of what someone turned this on for.
          Driven for the first time on 2026-09-04, the answer was immediate:
          press it once and no edit is ever shown again. A control whose only
          use is to switch the feature off does not belong beside the feature.
        
          The wider grant still exists for every other kind, where it means what
          it has always meant.
        */}
        {!isEdit && (
          <button type="button" className="btn" onClick={onAllowAlways}>
            {approval.kind === 'mcpToolCall'
              ? t('approval.allowRemembered')
              : t('approval.allowAlways')}
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => {
            onDeny(reason)
          }}
        >
          {isEdit ? t('ask.no') : t('approval.deny')}
        </button>
        {/*
          Focus alone is a quiet affordance; saying it makes it discoverable —
          and now it has to say *what* Enter does, because the two cases grant
          different things and "Enter to allow" would be true of both while
          telling you neither.
        */}
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
/**
 * Sent, and nothing has come back yet — or nothing is coming.
 *
 * Its own component so the two things it can say are testable without a live
 * agent. That is not a convenience: with a healthy agent this row is on screen
 * for under a frame — `working` fills within tens of milliseconds — so the
 * state that matters here, the one after the deadline, cannot be reached by
 * driving the app at all. It is exactly the case where a mounted test is the
 * only honest verification available.
 *
 * Exported for `WaitingRow.test.tsx`.
 */
export function WaitingRow({
  soleAgent,
  stalled,
}: {
  /** Named only when there is one agent; naming either of two would be a guess. */
  readonly soleAgent: string | undefined
  /** The wait outlasted any real start, so the row stops claiming to be one. */
  readonly stalled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <article
      className={`entry entry--${soleAgent ?? 'system'} entry--thinking${
        soleAgent === undefined ? ' entry--unnamed' : ''
      }`}
    >
      {/* The same mark-and-head a step wears in `Entry`: this row is built here
          rather than by the reducer, so it has to follow the row structure by
          hand or it lands in the wrong grid cells. */}
      <span className="entry-mark" aria-hidden="true">
        <span className="tick" />
      </span>
      {/*
        No head at all when there is nobody to name, rather than a head holding
        an empty string.

        An empty `.speaker` is invisible but not absent: `.entry`'s first grid
        row is still spent on it, so the mark sat on the head row and the word
        dropped to the row below — a dot floating above its own sentence. It
        only ever looked right with one agent in the room, which is the case
        where the head has a name in it, and that is why it survived: the
        two-agent room is exactly the room that cannot name who is working.
      */}
      {soleAgent !== undefined && (
        <div className="entry-head">
          <span className="speaker">{t(`actor.${soleAgent}`)}</span>
        </div>
      )}
      {/*
        Two things this row can be, and the second is not a failure state so
        much as an honest one: the wait outlasted any real start, so it stops
        animating and says what that means. No dots, because three dots that
        never resolve are the claim being withdrawn.
      */}
      <p className="said thinking" data-stalled={stalled ? 'true' : undefined} role="status">
        {stalled ? (
          t('conversation.noAnswer')
        ) : (
          <>
            <ThinkingWord kind="waiting" />
            <span className="thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </>
        )}
      </p>
    </article>
  )
}

function ThinkingWord({
  kind,
  offset = 0,
  activity = null,
}: {
  readonly kind: 'thinking' | 'waiting'
  readonly offset?: number
  /**
   * What the agent itself says it is doing, when it says anything.
   *
   * Outranks the rotating word, because one is a report and the other is a
   * clock. It is null for most of a turn — an agent announces `requesting` and
   * `compacting` and then works in silence — which is why the invented words
   * stay rather than being replaced.
   */
  readonly activity?: ActivityPush['activity']
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

  /*
   * The provider's own word wins whenever there is one.
   *
   * `compacting` is the case that makes this worth having: it is the one moment
   * the transcript and the agent's memory of it stop agreeing, it can take a
   * while, and until now the line said "considering" through all of it. The
   * rotating word is what fills the long silences either side.
   */
  return (
    <span className="thinking-word">
      {activity === null ? word : t(`conversation.activity.${activity}`)}
    </span>
  )
}
