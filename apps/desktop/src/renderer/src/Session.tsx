import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { quotePath } from './attach.js'
import { Attachments, type Attachment } from './Attachments.js'
import { Entry } from './Entry.js'
import { formatContextBlock, withEditorContext } from './editor-context.js'
import { compactTokens, money } from './format.js'
import { HandoffComposer, type HandoffDraft } from './HandoffComposer.js'
import {
  applyMention,
  findMentionQuery,
  mentionOptions,
  type MentionQuery,
} from './mention-menu.js'
import { anchorFor, withQuote } from './quote.js'
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
  const { conversationId, participants, cwd, profileId, title } = props.session
  const profile = props.profiles.find((p) => p.id === profileId)
  const [view, setView] = useState<TranscriptView>(EMPTY_VIEW)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [handoff, setHandoff] = useState<HandoffDraft | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [summarising, setSummarising] = useState(false)
  /** A passage selected in this pane's transcript, and where to offer to quote it. */
  const [selected, setSelected] = useState<{
    text: string
    left: number
    top: number
    placement: 'above' | 'below'
  } | null>(null)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [pickingProfile, setPickingProfile] = useState(false)
  /** Set once Restart has been asked for and is being answered. */
  const [restarting, setRestarting] = useState(false)
  /** True while a file from outside is over this pane. */
  const [fileOver, setFileOver] = useState(false)
  /** Files waiting to be sent, shown above the box rather than typed into it. */
  const [attached, setAttached] = useState<Attachment[]>([])
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
  /** The growing part, which is what a resize observer has to watch. */
  const transcript = useRef<HTMLDivElement | null>(null)
  /** The current turn — what you last said and whatever is answering it. */
  const turn = useRef<HTMLDivElement | null>(null)
  /** Empty space at the foot of the current turn, so its question can reach the top. */
  const tail = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)
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

  /**
   * Whether the transcript is following what is being written.
   *
   * True while the view is at the bottom, false the moment you scroll up — and
   * true again when you come back down. A transcript that yanks you to the
   * bottom while you are reading something further up is worse than one that
   * never follows at all, and one that stops following for good is worse than
   * either.
   */
  const following = useRef(true)
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

  /**
   * Files become paths in the draft, not attachments.
   *
   * An agent reads a file the same way you would, so a drop needs no upload and
   * no change to what a message is. A clipboard image has no path — only bytes —
   * so those are written down first and the path is what you get.
   */
  const attach = useCallback(async (items: DataTransfer): Promise<void> => {
    const files = [...items.files]
    if (files.length === 0) return

    const paths = await Promise.all(
      files.map(async (file) => {
        const path = window.chorus.pathForFile(file)
        if (path !== '') return path
        // Pasted rather than dragged: it exists nowhere until we put it somewhere.
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        const stashed = await window.chorus.stashFile({
          name: file.name === '' ? 'pasted' : file.name,
          base64: btoa(binary),
        })
        return stashed.path
      })
    )

    const previews = await Promise.all(
      paths.map(async (path) => ({ path, ...(await window.chorus.previewFile({ path })) }))
    )
    setAttached((current) => [
      ...current,
      ...previews.filter((p) => !current.some((c) => c.path === p.path)),
    ])
    input.current?.focus()
  }, [])

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
    setDraft((current) => withQuote(current, passage.text))
    setSelected(null)
    window.getSelection()?.removeAllRanges()
    input.current?.focus()
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
  const [ideIncluded, setIncluded] = useState(true)

  useEffect(() => {
    return window.chorus.onIdeContext((payload) => {
      // Main scopes this per conversation already; the pane checks anyway,
      // because a pane showing another project's file is the one failure this
      // feature must never have.
      if (payload.conversationId === conversationId) setIde(payload)
    })
  }, [conversationId])

  const ideAttached = ide !== null && ide.status === 'ready' && ideIncluded

  const send = useCallback(() => {
    /*
     * The paths join the message on the way out, not while you are writing it.
     *
     * The agent still receives text with paths in it — that has not changed —
     * but a draft is no longer a place where a screenshot looks like forty
     * characters of noise.
     */
    const paths = attached.map((item) => quotePath(item.path)).join(' ')
    const text = [draft.trim(), paths].filter((part) => part !== '').join(' ')
    if (text === '') return

    /*
     * The editor context is captured now, not when the pill was drawn.
     *
     * The pill can be a few hundred milliseconds old — it is debounced — and
     * the user may have moved the selection since. Sending what the pill said
     * would attach the wrong lines to the question, which is worse than
     * attaching none.
     */
    const compose = async (): Promise<string> => {
      if (!ideAttached) return text
      const snapshot = await window.chorus.ideSnapshot({ conversationId })
      if (snapshot.outcome !== 'ok') {
        // The draft is never lost to this. The user is told what happened and
        // decides whether to retry or send without the context.
        throw new Error(
          snapshot.outcome === 'tooLarge'
            ? t('ide.error.tooLarge')
            : t('ide.error.unavailable', { reason: t(`ide.status.${snapshot.reason}`) })
        )
      }
      const block = formatContextBlock(
        { ...snapshot },
        { heading: t('ide.heading'), unsaved: t('ide.unsaved') }
      )
      return withEditorContext(text, block)
    }

    // You just spoke; you want to see the answer.
    following.current = true
    setAwaiting(true)
    compose()
      .then(async (body) => {
        // Cleared only once the context is in hand, so a failed snapshot leaves
        // the draft and its attachments exactly as they were.
        setDraft('')
        setAttached([])
        await window.chorus.sendMessage({ conversationId, text: body })
      })
      .catch((error: unknown) => {
        // Nothing is coming: the message never left, so the row would be
        // waiting for a turn that will not start.
        setAwaiting(false)
        fail(setError)(error)
      })
  }, [conversationId, draft, attached, ideAttached, t])

  const decide = useCallback(
    (approval: PendingApproval, outcome: 'allow' | 'deny', scope: 'once' | 'session' = 'once') => {
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
    if (props.active) input.current?.focus()
  }, [queued, props.active])

  /**
   * One entry, drawn the same wherever it falls.
   *
   * Takes its index in the whole transcript rather than in the slice it is being
   * drawn from: whether a message answers a block of thinking is a fact about
   * the pair, and splitting the list at the current turn must not make the first
   * message after the split forget what came before it.
   */
  const entry = (message: TranscriptMessage, index: number): React.JSX.Element => (
    <Entry
      key={message.key}
      message={message}
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
      data-lifted={props.lifted}
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
        input.current?.focus()
      }}
      onDragOver={(e) => {
        // Only a pane being dragged counts; a file dropped from Finder is not a
        // reorder, and preventing default on it would swallow it silently.
        const moved = props.dragging.current
        if (moved === null) {
          // A file from outside: accepted, but it is not a reorder.
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setFileOver(true)
          }
          return
        }
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
      onDragLeave={(e) => {
        // Only when the pointer actually left the pane, not on every child.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileOver(false)
      }}
      onDrop={(e) => {
        setFileOver(false)
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault()
          void attach(e.dataTransfer)
          return
        }
        // The grid sorted itself on the way here; this only stops the browser
        // treating the drop as navigation.
        if (props.dragging.current !== null) e.preventDefault()
      }}
      data-file-over={fileOver}
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
        {view.spend.inputTokens + view.spend.outputTokens > 0 && (
          <span
            className="spend"
            title={t('spend.tokens', {
              input: view.spend.inputTokens.toLocaleString(),
              output: view.spend.outputTokens.toLocaleString(),
            })}
            aria-label={t('spend.label')}
          >
            {compactTokens(view.spend.inputTokens + view.spend.outputTokens)}
            {view.spend.costUsd !== null && ` · ${money(view.spend.costUsd)}`}
          </span>
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
              decide(current, 'allow', 'session')
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

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          {ide !== null && ide.status !== 'unavailable' && (
            <div className="ide-pill" data-status={ide.status}>
              <span className="ide-pill-what">
                {ide.status === 'ready' && ide.file !== null
                  ? `${ide.file.relativePath}:${String(ide.file.startLine)}${
                      ide.file.isEmpty || ide.file.startLine === ide.file.endLine
                        ? ''
                        : `-${String(ide.file.endLine)}`
                    }`
                  : t(`ide.status.${ide.status}`)}
              </span>
              {ide.status === 'ready' && (
                <button
                  type="button"
                  className="ide-pill-toggle"
                  aria-pressed={ideIncluded}
                  title={ideIncluded ? t('ide.exclude') : t('ide.include')}
                  onClick={() => {
                    // Once excluded it stays excluded: a live selection change
                    // must never silently re-enable context the user turned off.
                    setIncluded((on) => !on)
                  }}
                >
                  {ideIncluded ? t('ide.on') : t('ide.off')}
                </button>
              )}
            </div>
          )}
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
          <Attachments
            items={attached}
            onRemove={(path) => {
              setAttached((current) => current.filter((item) => item.path !== path))
            }}
          />
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
            onPaste={(e) => {
              // Text pastes as text; anything else becomes a path.
              if (e.clipboardData.files.length === 0) return
              e.preventDefault()
              void attach(e.clipboardData)
            }}
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
              A glyph, not a word, and first in the row.

              The row already sheds labels as the pane narrows, so a fourth named
              control would be the thing that broke it. This one is the same
              shape as Send at the other end: a mark you learn once, with the
              name on `aria-label` and `title` so it is never only a shape.
            */}
            <button
              type="button"
              className="summary-open"
              aria-label={t('summary.open')}
              title={t('summary.open')}
              onClick={() => {
                setSummarising(true)
              }}
            >
              <span aria-hidden="true">≡</span>
            </button>
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
                  disabled={
                    (draft.trim() === '' && attached.length === 0) || participants.length === 0
                  }
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
          {t('approval.allowAlways')}
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
