import { parseDiff } from '@chorus/workspace/diff'
import type { AgentId } from '@chorus/shared'
import { trailingSummary } from '../../shared/markdown.js'
import type { TranscriptEvent } from '../../shared/ipc.js'

/**
 * Folds the event log into something renderable.
 *
 * The log is the source of truth (S3), so this is a pure reduction over it —
 * the same events replayed from `conversation:history` after a restart produce
 * the same view as the live push stream.
 */

/**
 * One file in a `Changes` card.
 *
 * Counts, not a patch. They arrive already counted from
 * `file.change.completed`, because only the adapter still knows how its provider
 * spells a diff — Codex sends raw file content for an add, so counting here
 * would report zero for exactly the largest changes.
 *
 * They count **what the turn wrote**, not the net result: a line added and then
 * removed in the same turn appears in both columns. The card says so in its own
 * words rather than implying it is `git diff --numstat`, which it can
 * legitimately disagree with.
 */
export interface ChangedFile {
  readonly path: string
  /** Set only for a rename: where the file was before it moved. */
  readonly oldPath?: string
  readonly change: 'added' | 'removed' | 'modified' | 'renamed'
  readonly added: number
  readonly removed: number
  /**
   * The file's own diff, git-format, drawn under its row.
   *
   * Carried as text and parsed by the component — the reducer counts, the view
   * renders. Empty for a row from a log written before the card drew diffs, and
   * the row then shows its counts and nothing else rather than an empty frame.
   */
  readonly patch?: string
  /** Lines left out of `patch` to keep a whole added or deleted file bounded. */
  readonly omittedLines?: number
}

export interface TranscriptMessage {
  readonly key: string
  readonly actor: TranscriptEvent['actor']
  readonly kind: 'message' | 'reasoning' | 'command' | 'notice' | 'handoff' | 'tool' | 'changes'
  readonly text: string
  readonly status: 'streaming' | 'complete'
  /** The log event this came from — what a handoff selects. */
  readonly eventId: string
  /**
   * When this row *began*, from the event's `createdAt`.
   *
   * First delta, not completion, and the difference is visible: a reply that
   * starts at 9:14 and finishes at 9:18 would print 9:18 above the tool rows it
   * spawned at 9:15, so the column would read backwards down the screen.
   * `agent.message.completed` rebuilds the row from scratch, so this has to be
   * carried across that boundary rather than re-read from the event.
   */
  readonly at: number
  /** Set on a handoff card: who it went to. */
  readonly handoffTo?: TranscriptEvent['actor']
  /**
   * The body behind the line — hook output, a denial's reason, the path a tool
   * was pointed at.
   *
   * Kept out of `text` so the row stays one line until asked otherwise. A hook
   * that prints forty lines of lint output should not push the answer it was
   * checking off the screen.
   */
  readonly detail?: string
  /**
   * Tools only: the provider's id for the call, so later events find this row.
   *
   * A subagent is reported twice — once as the `Task` tool call, then again by
   * name once it starts — and matching on this is what merges the two into one
   * row instead of stacking them.
   */
  readonly toolRef?: string
  /** Tools only: whether the call is still going, and how it ended. */
  readonly toolStatus?: 'running' | 'ok' | 'error'
  /** Tools only: the enclosing call, when this happened inside a subagent. */
  readonly parentRef?: string
  /**
   * Tools only: a unified diff of what a file-mutating tool changed.
   *
   * Carried as text and parsed by the component. Keeping `parseDiff` out of the
   * reducer is what lets this stay a pure fold that tests can drive with plain
   * payloads.
   */
  readonly patch?: string
  /** Tools only: lines left out of `patch` to keep a created file bounded. */
  readonly omittedLines?: number
  /** Notices only: severity, so the row can be tinted without reading its text. */
  readonly level?: 'info' | 'warn' | 'error'
  /**
   * Notices only: which part of the harness spoke.
   *
   * A key, not a label. The reducer has no translator, so the renderer turns
   * this into words — which is also why `text` never contains a composed
   * sentence.
   */
  readonly noticeSource?: string
  /**
   * Notices only: the rest of a run of hook notices this row stands for.
   *
   * A hook fires per matching tool call, so a repo with six talkative hooks puts
   * six durable rows between a command and its output — measured, on one Bash
   * call, as six. Folding is what `CommandEntry` already does for a turn's
   * commands, and it costs one row instead of N while keeping every line
   * reachable.
   *
   * Only ever set for `info`. A hook that failed or was cancelled arrives as
   * `warn`, keeps its own row, and is never folded into a count — the whole
   * reason the transcript carries hooks at all is the one that blocked
   * something.
   *
   * Absent for a lone notice, so a single hook still reads as a sentence rather
   * than as a group of one.
   */
  readonly folded?: readonly { readonly text: string; readonly detail?: string }[]
  /** `changes` only: the files this turn wrote, one row each. */
  readonly changes?: readonly ChangedFile[]
  /**
   * Messages only: the bullets of a trailing `Summary` section, lifted out.
   *
   * A convention an agent follows rather than a contract the app enforces —
   * nothing prompts for it, so most replies have none. Absent, not empty, when
   * there was no summary: an empty card and no card are different things.
   */
  readonly summary?: readonly string[]
}

export interface PendingApproval {
  readonly approvalId: string
  /** Which agent asked — several can be waiting at once in a shared conversation. */
  readonly agentId: TranscriptEvent['actor']
  readonly kind: string
  readonly summary: string
  readonly detail: string | null
  readonly expiresAt: number
}

/**
 * A question set an agent is blocked on.
 *
 * Shaped from the event's payload rather than imported from the protocol: the
 * renderer only ever sees a logged event, and reading it defensively is what
 * keeps a replayed log from an older version out of the UI's assumptions.
 */
export interface PendingQuestion {
  readonly userInputId: string
  /** Which agent asked — several can be waiting at once in a shared conversation. */
  readonly agentId: TranscriptEvent['actor']
  readonly questions: readonly QuestionField[]
  readonly expiresAt: number
}

export interface QuestionField {
  readonly id: string
  readonly header: string
  readonly question: string
  /** Empty means free text: the provider is asking you to type, not to choose. */
  readonly options: readonly { readonly label: string; readonly description: string }[]
  readonly multiSelect: boolean
  readonly allowOther: boolean
  /** The answer is a credential: never echoed on screen, never written down. */
  readonly isSecret: boolean
}

/** What this conversation has cost so far, as the agents reported it. */
export interface Spend {
  readonly inputTokens: number
  readonly outputTokens: number
  /** Null when no agent reported a price; a zero would be a claim we cannot make. */
  readonly costUsd: number | null
}

export interface TranscriptView {
  readonly messages: readonly TranscriptMessage[]
  readonly approvals: readonly PendingApproval[]
  /** Question sets waiting on an answer. Blocking, like approvals, but unruleable. */
  readonly questions: readonly PendingQuestion[]
  /** Agents currently mid-turn. Drives the live indicator on each voice. */
  readonly working: readonly TranscriptEvent['actor'][]
  readonly busy: boolean
  readonly lastSeq: number
  readonly spend: Spend
  /** The latest total each agent reported, which `spend` is the sum of. */
  readonly usageByActor: Readonly<Record<string, Spend>>
  /**
   * The `changes` row currently open for each agent, by key.
   *
   * In the view rather than in a local, because `reduceEvents` is incremental —
   * `Session.tsx` folds each push into the previous view — and a push can deliver
   * the file change, the reply and `turn.completed` in three separate calls.
   * Anything held between events has to live somewhere that survives the call,
   * and this is the only such place. It replays for free: the same events from
   * `EMPTY_VIEW` rebuild it exactly.
   *
   * `Partial`, not `Record`: `EMPTY_VIEW` holds none of them, and a full
   * `Record` initialised to `{}` would be lying about its keys.
   */
  readonly openChanges: Readonly<Record<AgentId, string | null>>
}

export const EMPTY_VIEW: TranscriptView = {
  messages: [],
  approvals: [],
  questions: [],
  working: [],
  busy: false,
  lastSeq: 0,
  spend: { inputTokens: 0, outputTokens: 0, costUsd: null },
  usageByActor: {},
  openChanges: { codex: null, claude: null },
}

interface Mutable {
  spend: Spend
  usageByActor: Record<string, Spend>
  openChanges: Record<AgentId, string | null>
  messages: TranscriptMessage[]
  approvals: PendingApproval[]
  questions: PendingQuestion[]
  working: TranscriptEvent['actor'][]
  busy: boolean
  lastSeq: number
}

export function reduceEvents(
  view: TranscriptView,
  events: readonly TranscriptEvent[]
): TranscriptView {
  const next: Mutable = {
    messages: [...view.messages],
    approvals: [...view.approvals],
    questions: [...view.questions],
    working: [...view.working],
    busy: view.busy,
    lastSeq: view.lastSeq,
    spend: view.spend,
    usageByActor: { ...view.usageByActor },
    openChanges: { ...view.openChanges },
  }

  for (const event of events) {
    // Pushes and history replays can overlap; the log's ordering makes
    // deduplication a comparison rather than a guess.
    if (event.seq <= next.lastSeq) continue
    next.lastSeq = event.seq
    apply(next, event)
  }

  next.busy = next.working.length > 0
  return next
}

function apply(view: Mutable, event: TranscriptEvent): void {
  const p = event.payload
  const str = (key: string): string => (typeof p[key] === 'string' ? p[key] : '')
  const num = (key: string): number => (typeof p[key] === 'number' ? p[key] : 0)

  switch (event.type) {
    case 'user.message':
      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: 'user',
        kind: 'message',
        text: str('text'),
        status: 'complete',
      })
      return

    case 'agent.message.delta':
      appendStreamed(view, event, 'message', str('itemRef'), str('text'))
      return

    case 'agent.reasoning.delta':
      appendReasoning(view, event, str('text'))
      return

    case 'agent.message.completed': {
      const key = str('itemRef')
      const existing = view.messages.findIndex((m) => m.key === key)
      /*
       * Only a finished message is read for a summary.
       *
       * A card that appeared mid-stream would arrive the moment the bullets were
       * written and then move as the rest of the reply landed under it. It also
       * costs nothing to wait: the text is scanned once, here, not per render.
       */
      const said = str('text')
      const summary = trailingSummary(said)
      const message: TranscriptMessage = {
        key,
        eventId: event.id,
        /*
         * The streamed row's time, not this event's.
         *
         * This case replaces the row wholesale, so re-reading `createdAt` here
         * would stamp every reply with the moment it *finished* — see `at` on
         * `TranscriptMessage`. A completion with no prior delta (a short turn
         * that never streamed) has nothing to carry and takes its own.
         */
        at: existing === -1 ? event.createdAt : (view.messages[existing]?.at ?? event.createdAt),
        actor: event.actor,
        kind: 'message',
        // The prefix the agent wrote, exactly — never a rebuilt body.
        text: summary === null ? said : said.slice(0, summary.cut).trimEnd(),
        status: 'complete',
        ...(summary === null ? {} : { summary: summary.items }),
      }
      if (existing === -1) view.messages.push(message)
      else view.messages[existing] = message
      moveChangesBelow(view, event.actor)
      return
    }

    /*
     * What the turn actually wrote, as a card that grows.
     *
     * Merged into an open row rather than pushed each time, the way
     * `tool.started` merges by ref — a turn that edits four files is one card,
     * not four. The row's key lives in `view.openChanges`, which is what lets
     * this survive the pushes arriving in separate `reduceEvents` calls.
     *
     * `file.change.proposed` is deliberately not handled: it fires when the
     * operation *starts*, so a declined or failed patch would draw a row saying
     * the file changed.
     */
    case 'file.change.completed': {
      if (p['outcome'] !== 'applied') return
      const files = readChangedFiles(p['files'])
      if (files.length === 0) return

      openChanges(view, event, files)
      return
    }

    case 'command.started':
      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: event.actor,
        kind: 'command',
        text: `$ ${(Array.isArray(p['command']) ? p['command'] : []).join(' ')}`,
        status: 'complete',
      })
      return

    /*
     * Merged by ref rather than appended.
     *
     * A subagent announces itself twice — once as the `Task` tool call the
     * model made, then again by name when the provider starts it — and the
     * second one knows more. Keyed on the call's id, the later event refines
     * the row that is already on screen instead of stacking a second one under
     * it.
     */
    case 'tool.started': {
      const ref = str('itemRef')
      if (ref === '') return
      const at = view.messages.findIndex((m) => m.kind === 'tool' && m.toolRef === ref)
      const prev = at === -1 ? undefined : view.messages[at]
      const parent = str('parentRef')
      // An empty detail on the refining event must not erase the subject the
      // first one carried.
      const detail = str('detail') === '' ? prev?.detail : str('detail')
      const message: TranscriptMessage = {
        key: prev?.key ?? event.id,
        eventId: prev?.eventId ?? event.id,
        // The row's own time survives the refining event, like its key does.
        at: prev?.at ?? event.createdAt,
        actor: event.actor,
        kind: 'tool',
        text: str('name'),
        status: 'complete',
        toolRef: ref,
        toolStatus: prev?.toolStatus ?? 'running',
        ...(parent === '' ? {} : { parentRef: parent }),
        ...(detail === undefined || detail === '' ? {} : { detail }),
      }
      if (prev === undefined) view.messages.push(message)
      else view.messages[at] = message
      return
    }

    case 'tool.progress': {
      const at = view.messages.findIndex((m) => m.kind === 'tool' && m.toolRef === str('itemRef'))
      const prev = at === -1 ? undefined : view.messages[at]
      // Progress for a call we never saw start is not worth inventing a row for.
      if (prev === undefined) return
      const note = str('note')
      if (note === '') return
      view.messages[at] = { ...prev, detail: note }
      return
    }

    case 'tool.completed': {
      const at = view.messages.findIndex((m) => m.kind === 'tool' && m.toolRef === str('itemRef'))
      const prev = at === -1 ? undefined : view.messages[at]
      if (prev === undefined) return
      /*
       * The summary only fills a subject that is still empty.
       *
       * For a subagent it is the whole point; for a `Read` it is the first line
       * of the file, which says less than the path already shown. Preferring
       * what is there keeps the row identifying.
       */
      const summary = str('summary')
      // Carried whole for the row's own diff — rendering it is the component's
      // job, and `ToolPatch` parses it there.
      const patch = str('patch')
      const omitted = num('omittedLines')
      view.messages[at] = {
        ...prev,
        toolStatus: str('status') === 'error' ? 'error' : 'ok',
        ...(prev.detail === undefined && summary !== '' ? { detail: summary } : {}),
        ...(patch === '' ? {} : { patch }),
        ...(omitted > 0 ? { omittedLines: omitted } : {}),
      }
      /*
       * The other half of the `Changes` card, and the asymmetry is the
       * providers', not ours.
       *
       * Codex reports a file change as its own item, which arrives as
       * `file.change.completed` already counted. Claude has no such event at
       * all — an edit is a *tool result*, and the only record of what it did is
       * the patch on it. So the card is fed from both, and this end has to
       * count.
       *
       * `parseDiff` is pure, so folding it in here keeps the reducer a pure
       * fold; what it must not do is parse for *rendering*, which stays in the
       * component. A patch is parsed once, when its event arrives.
       */
      if (str('status') !== 'error' && patch !== '') foldPatch(view, event, patch)
      return
    }

    case 'turn.started':
      // Tracked per agent: in a shared conversation one can be thinking while
      // another is idle, and a single boolean would flatten that away.
      if (!view.working.includes(event.actor)) view.working.push(event.actor)
      return

    case 'turn.completed':
      view.working = view.working.filter((a) => a !== event.actor)
      // Before the key is dropped, and before an interruption notice is pushed
      // below: this is the only moment the last reply is known to be the last.
      liftChangesAboveFinal(view, event.actor)
      // The turn's card is finished. The next turn opens its own rather than
      // growing this one, which is what makes a card mean "this turn".
      if (isAgent(event.actor)) view.openChanges[event.actor] = null
      if (p['status'] === 'interrupted') {
        view.messages.push({
          key: event.id,
          eventId: event.id,
          at: event.createdAt,
          actor: 'system',
          kind: 'notice',
          text: p['userInitiated'] === true ? 'Stopped.' : 'Interrupted.',
          status: 'complete',
        })
      }
      return

    /*
     * A question an agent is blocked on, held until somebody answers it.
     *
     * Never auto-answered anywhere in the stack: a permission profile can hold
     * an opinion about whether an action is allowed, but not about what you
     * want. So unlike an approval there is no rule that can clear this — only a
     * person, or the deadline.
     */
    case 'userinput.requested': {
      const asked = questionSet(p['request'])
      if (asked.length === 0) return
      view.questions.push({
        userInputId: str('userInputId'),
        agentId: event.actor,
        questions: asked,
        expiresAt: num('expiresAt'),
      })
      return
    }

    case 'userinput.answered': {
      const id = str('userInputId')
      view.questions = view.questions.filter((q) => q.userInputId !== id)

      /*
       * An unanswered question leaves a line, an answered one does not.
       *
       * Answering is visible already — you did it, and the agent's next words
       * are the result. A question that ran out its deadline is the opposite:
       * the agent was told nothing was chosen and carried on, and without this
       * the only trace is a reply that quietly assumed something. That silence
       * is precisely how a whole missing question UI went unnoticed.
       */
      const outcome = str('outcome')
      if (outcome === 'answered') return
      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: 'system',
        kind: 'notice',
        text:
          outcome === 'timeout'
            ? 'A question went unanswered in time.'
            : 'A question was dismissed.',
        status: 'complete',
      })
      return
    }

    case 'approval.requested':
      view.approvals.push({
        approvalId: str('approvalId'),
        agentId: event.actor,
        kind: str('kind'),
        summary: summarize(p),
        detail: detailOf(p),
        expiresAt: typeof p['expiresAt'] === 'number' ? p['expiresAt'] : 0,
      })
      return

    case 'approval.decided': {
      const id = str('approvalId')
      view.approvals = view.approvals.filter((a) => a.approvalId !== id)

      /*
       * An auto-decision always leaves a line in the transcript. A policy that
       * works silently is indistinguishable from no policy — the user must be
       * able to see what was decided for them, and which rule did it (§4.4).
       *
       * Deliberately not conditioned on whether a card was showing: the request
       * is logged before policy evaluates, so an auto-decided approval *does*
       * briefly appear pending. Skipping the notice in that case made every
       * automatic decision invisible, which a live run caught.
       */
      if (str('decidedBy') !== 'user') {
        const rule = str('policyRuleId')
        const outcome = str('outcome')
        view.messages.push({
          key: event.id,
          eventId: event.id,
          at: event.createdAt,
          actor: 'system',
          kind: 'notice',
          text:
            outcome === 'timeout'
              ? 'Denied — nobody answered in time.'
              : `${outcome === 'allow' ? 'Allowed' : 'Denied'} automatically${rule === '' ? '' : ` · ${rule}`}`,
          status: 'complete',
        })
      }
      return
    }

    /*
     * Widening what agents may do belongs in the transcript, above the actions
     * it permitted. A permission change that left no mark would make the log an
     * incomplete account of why something was allowed.
     */
    /*
     * Joining and leaving belong in the transcript. Without them an agent's
     * first message appears from nowhere, and its last is followed by a silence
     * with no explanation.
     */
    /*
     * Reopening the app is not somebody joining.
     *
     * Every launch closed and restarted each agent, so a conversation collected
     * a "left" and a "joined" per agent per restart — a transcript that filled
     * with the app's own lifecycle. The notices are for the cast changing, which
     * is a thing you did, so a resumed session says nothing.
     */
    case 'session.started':
      if (event.payload['resumed'] === true) return
      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: 'system',
        kind: 'notice',
        text: `${str('agentId')} joined`,
        status: 'complete',
      })
      return

    case 'session.ended': {
      /*
       * Closed by the payload's `agentId`, never by the event's actor.
       *
       * A session ending is appended as `actor: 'system'` — `reconcileOrphaned
       * Sessions` does exactly that after a crash — so clearing by actor would
       * clear an entry under `system` that never existed and leave the agent's
       * card open, growing into whatever the next session does.
       */
      const ended = str('agentId')
      if (isAgent(ended)) view.openChanges[ended] = null
      if (str('reason') === 'shutdown') return
      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: 'system',
        kind: 'notice',
        text: `${str('agentId')} left`,
        status: 'complete',
      })
      return
    }

    case 'project.changed':
      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: 'system',
        kind: 'notice',
        text: `Project directory: ${str('cwd')}`,
        status: 'complete',
      })
      return

    /*
     * The line above which the agent no longer remembers verbatim.
     *
     * Everything before this stays on screen and still reads as shared history,
     * but the agent replaced it with a summary of itself to fit the context
     * window. Saying so is the whole point: a message you can still scroll to
     * is not necessarily one it can still recall, and without this marker there
     * is nothing to tell you which is which.
     */
    case 'context.compacted':
      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: 'system',
        kind: 'notice',
        text: 'Context compacted — the agent kept a summary of everything above.',
        status: 'complete',
      })
      return

    case 'policy.changed':
      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: 'system',
        kind: 'notice',
        text: `Permissions changed: ${str('previousProfileId')} → ${str('profileId')}`,
        status: 'complete',
      })
      return

    /*
     * What it cost, accumulated rather than shown per turn.
     *
     * Agents report usage at the end of each turn; the interesting number is the
     * running total for the conversation, which is the one that decides whether
     * to keep going. Cost stays null until an agent actually reports a price —
     * Codex does not always — because a zero would be a claim we cannot make.
     */
    case 'usage.updated': {
      /*
       * Each agent reports its own running total, so the latest wins per agent
       * and the conversation is their sum. Adding every report up would count
       * the same tokens again each time one arrived.
       */
      view.usageByActor = {
        ...view.usageByActor,
        [event.actor]: {
          inputTokens: num('inputTokens'),
          outputTokens: num('outputTokens'),
          costUsd: typeof p['costUsd'] === 'number' ? p['costUsd'] : null,
        },
      }

      const totals = Object.values(view.usageByActor)
      const priced = totals.filter((t) => t.costUsd !== null)
      view.spend = {
        inputTokens: totals.reduce((sum, t) => sum + t.inputTokens, 0),
        outputTokens: totals.reduce((sum, t) => sum + t.outputTokens, 0),
        costUsd: priced.length === 0 ? null : priced.reduce((sum, t) => sum + (t.costUsd ?? 0), 0),
      }
      return
    }

    case 'error.raised':
      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: 'system',
        kind: 'notice',
        text: str('message'),
        status: 'complete',
      })
      return

    /*
     * Attributed to the agent whose turn it happened in, not to 'system'.
     *
     * A hook that fired while Claude was working is part of reading what Claude
     * did; filing it under a neutral actor separates it from the command it
     * gated, which is the one thing a reader needs it next to.
     */
    case 'notice.raised': {
      const raw = str('level')
      const level = raw === 'warn' || raw === 'error' ? raw : 'info'
      const source = str('source')
      const detail = str('detail')
      const line = { text: str('text'), ...(detail === '' ? {} : { detail }) }

      /*
       * A run of talkative hooks becomes one row.
       *
       * Consecutive rather than "all of this turn's", because the run *is* the
       * tool call: the hooks for one call arrive together, and the next thing
       * logged is the command they gated. Anything at all between them breaks
       * the group, which is what keeps a hook from folding into one that fired
       * before something else happened.
       */
      const previous = view.messages[view.messages.length - 1]
      if (
        source === 'hook' &&
        level === 'info' &&
        previous?.kind === 'notice' &&
        previous.noticeSource === 'hook' &&
        previous.level === 'info' &&
        previous.actor === event.actor
      ) {
        view.messages[view.messages.length - 1] = {
          ...previous,
          folded: [
            ...(previous.folded ?? [
              {
                text: previous.text,
                ...(previous.detail === undefined ? {} : { detail: previous.detail }),
              },
            ]),
            line,
          ],
        }
        return
      }

      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: event.actor,
        kind: 'notice',
        text: line.text,
        status: 'complete',
        noticeSource: source,
        level,
        ...(detail === '' ? {} : { detail }),
      })
      return
    }

    /*
     * A handoff is shown as its own entry rather than as a user message. It is
     * the moment context crosses between two agents that otherwise cannot see
     * each other, and the transcript should make that visible (plan §4.5).
     */
    case 'handoff.created':
      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: str('from') as TranscriptEvent['actor'],
        kind: 'handoff',
        handoffTo: str('to') as TranscriptEvent['actor'],
        text: str('brief'),
        status: 'complete',
      })
      return

    case 'aside.promoted':
      /*
       * Said in the transcript, because the room's rules changed here.
       *
       * Everything above this line was answered by a fork that could only look;
       * everything below it can act, under a profile someone chose. A reader
       * scrolling back through one continuous log would otherwise have no way to
       * see where that happened.
       */
      view.messages.push({
        key: event.id,
        eventId: event.id,
        at: event.createdAt,
        actor: 'system',
        kind: 'notice',
        text: 'Opened as a conversation. It can now act, with your approval.',
        status: 'complete',
      })
      return

    default:
      return
  }
}

/**
 * One block of thinking, however many items the provider split it into.
 *
 * Reasoning used to be keyed by `itemRef`, so a model that emitted its thinking
 * as several items produced several entries — several dots on the rail, several
 * "Show thinking" toggles, and the reply pushed further down each time. The
 * provider's item boundaries are an implementation detail of how it streams;
 * they are not something the reader asked to see.
 *
 * A run ends when anything else is said. Thinking, then a reply, then more
 * thinking is genuinely two blocks, and joining those would misrepresent the
 * order the agent worked in.
 */
function appendReasoning(view: Mutable, event: TranscriptEvent, text: string): void {
  const last = view.messages.at(-1)
  if (last?.kind === 'reasoning' && last.actor === event.actor) {
    view.messages[view.messages.length - 1] = { ...last, text: last.text + text }
    return
  }
  view.messages.push({
    // Keyed by the event that opened the run, so the block keeps its identity as
    // more of it arrives.
    key: `reasoning:${event.id}`,
    eventId: event.id,
    at: event.createdAt,
    actor: event.actor,
    kind: 'reasoning',
    text,
    status: 'streaming',
  })
}

/**
 * True when this row carries on from the one above it, under the same speaker.
 *
 * Derived from the pair rather than stored on either, exactly like
 * `answersThinking` — whether a row repeats its header is a fact about what
 * precedes it.
 *
 * Only steps group. A message keeps its avatar, name and time however many rows
 * come before it: that treatment *is* the message row, and the time is the one
 * thing in it that cannot be recovered from the row above. A command, tool call
 * or notice under the same agent is that agent still working, and eleven rows
 * each saying "Claude" say nothing eleven times.
 */
export function groupedWith(
  previous: TranscriptMessage | undefined,
  current: TranscriptMessage
): boolean {
  if (previous === undefined) return false
  if (current.kind === 'message' || current.kind === 'handoff') return false
  return previous.actor === current.actor
}

/**
 * True when this message is the reply a block of thinking led to.
 *
 * Derived from where a message sits rather than stored on it: the answer is only
 * distinguishable *because* thinking precedes it, so it is a fact about the pair
 * and not about either one. When no reasoning arrives — which is every turn both
 * CLIs currently produce — nothing is marked, which is the right answer rather
 * than a degraded one.
 */
export function answersThinking(
  previous: TranscriptMessage | undefined,
  current: TranscriptMessage
): boolean {
  if (current.kind !== 'message') return false
  if (current.actor === 'user' || current.actor === 'system') return false
  return previous?.kind === 'reasoning' && previous.actor === current.actor
}

/**
 * Reads the files off a `file.change.completed` payload.
 *
 * Defensive for the reason every payload read in this file is: this comes off
 * disk, and a log written by an older build must produce a card with a row
 * missing rather than a renderer that throws.
 */
/**
 * A tool's patch, folded into the turn's `Changes` card.
 *
 * Only for a provider that reports edits as tool results rather than as file
 * changes — in practice Claude. A file it created carries `new file mode`, which
 * is what lets `parseDiff` letter it `A` instead of `M`.
 */
function foldPatch(view: Mutable, event: TranscriptEvent, patch: string): void {
  if (!isAgent(event.actor)) return
  const parsed = parseDiff(patch)
  const files = parsed.map((file): ChangedFile => ({
    path: file.path,
    ...(file.status === 'renamed' ? { oldPath: file.oldPath } : {}),
    change: file.status,
    added: file.added,
    removed: file.removed,
    /*
     * The whole tool patch is this file's diff — `readPatch` builds one from a
     * single `filePath`, so a Claude edit is always one file. Claimed only
     * when there is exactly one, because a patch covering two would otherwise
     * be handed to both rows.
     */
    ...(parsed.length === 1 ? { patch } : {}),
  }))
  if (files.length === 0) return
  openChanges(view, event, files)
}

/** Adds files to the actor's open card, or opens one. */
function openChanges(view: Mutable, event: TranscriptEvent, files: readonly ChangedFile[]): void {
  if (!isAgent(event.actor)) return
  const open = view.openChanges[event.actor]
  const at = open === null ? -1 : view.messages.findIndex((m) => m.key === open)
  const prev = at === -1 ? undefined : view.messages[at]

  if (prev === undefined) {
    const key = `changes:${event.id}`
    view.openChanges[event.actor] = key
    view.messages.push({
      key,
      eventId: event.id,
      at: event.createdAt,
      actor: event.actor,
      kind: 'changes',
      text: '',
      status: 'complete',
      changes: [...files],
    })
    return
  }
  view.messages[at] = { ...prev, changes: mergeChanges(prev.changes ?? [], files) }
}

/** Only an agent writes files, so only an agent can have a card open. */
function isAgent(actor: string): actor is AgentId {
  return actor === 'codex' || actor === 'claude'
}

function readChangedFiles(value: unknown): ChangedFile[] {
  if (!Array.isArray(value)) return []
  const files: ChangedFile[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const file = entry as Record<string, unknown>
    const path = typeof file['path'] === 'string' ? file['path'] : ''
    if (path === '') continue
    const change = file['change']
    const omitted = file['omittedLines']
    files.push({
      path,
      ...(typeof file['oldPath'] === 'string' ? { oldPath: file['oldPath'] } : {}),
      change:
        change === 'added' || change === 'removed' || change === 'renamed' ? change : 'modified',
      added: typeof file['added'] === 'number' ? file['added'] : 0,
      removed: typeof file['removed'] === 'number' ? file['removed'] : 0,
      ...(typeof file['patch'] === 'string' && file['patch'] !== ''
        ? { patch: file['patch'] }
        : {}),
      ...(typeof omitted === 'number' && omitted > 0 ? { omittedLines: omitted } : {}),
    })
  }
  return files
}

/**
 * Folds a turn's later edits into the card already on screen.
 *
 * Summed per path, so a file edited three times is one row carrying the total.
 * That total is **what the turn wrote**, not the net result — a line added and
 * then taken out again counts on both sides, and the card says as much rather
 * than claiming to be `git diff --numstat`.
 *
 * A later `change` wins: a file created and then edited in one turn is still a
 * file that was created, but a file edited and then *renamed* should read as the
 * rename, and taking the last one said is the only rule that gets both right
 * without inventing a precedence table.
 */
function mergeChanges(
  existing: readonly ChangedFile[],
  arriving: readonly ChangedFile[]
): ChangedFile[] {
  const merged = [...existing]
  for (const file of arriving) {
    const at = merged.findIndex((m) => m.path === file.path || m.path === file.oldPath)
    const prev = at === -1 ? undefined : merged[at]
    if (prev === undefined) {
      merged.push(file)
      continue
    }
    merged[at] = {
      ...prev,
      path: file.path,
      ...(file.oldPath === undefined ? {} : { oldPath: prev.oldPath ?? file.oldPath }),
      change: file.change,
      added: prev.added + file.added,
      removed: prev.removed + file.removed,
      /*
       * The latest diff for the file, not the sum of them.
       *
       * The counts are what the turn *wrote* and add up; a patch does not — two
       * hunks from two edits stitched together would describe a file that never
       * existed. Showing the most recent one is the honest single answer, and
       * the counts beside it still say the whole turn.
       */
      ...(file.patch === undefined ? {} : { patch: file.patch }),
      ...(file.omittedLines === undefined ? {} : { omittedLines: file.omittedLines }),
    }
  }
  return merged
}

/**
 * Puts the open `Changes` card under the reply it belongs to.
 *
 * An agent usually edits *before* it narrates, so a card that stayed where its
 * first file landed would sit above the words explaining it — the reverse of the
 * approved composition. Moving it on completion keeps the row's identity (it is
 * still merged into as more files land) and is driven entirely by logged events,
 * so a replay produces the same order.
 *
 * This cannot know whether the reply it is moving under is the *last* one, so it
 * moves under every one and `liftChangesAboveFinal` undoes the final hop when the
 * turn ends. See there for why the last reply is the exception.
 */
function moveChangesBelow(view: Mutable, actor: TranscriptEvent['actor']): void {
  if (!isAgent(actor)) return
  const key = view.openChanges[actor]
  if (key === null) return
  const at = view.messages.findIndex((m) => m.key === key)
  if (at === -1 || at === view.messages.length - 1) return
  const [card] = view.messages.splice(at, 1)
  if (card !== undefined) view.messages.push(card)
}

/**
 * The last reply is the one the card does not go under.
 *
 * `moveChangesBelow` puts the card beneath each reply as it completes, which is
 * right for narration mid-turn — the card is evidence and evidence reads under
 * the claim. It is wrong for the *final* reply, and that only became visible
 * once the answer was given a brightness of its own: a receipt printed after the
 * conclusion means the conclusion is not the last thing in the turn, which is
 * the whole property `data-final` exists to assert.
 *
 * So the last hop is undone here rather than prevented there. Prevention is not
 * available: `agent.message.completed` cannot know whether another reply is
 * coming, and guessing from a timer would make the order depend on how fast the
 * provider was. `turn.completed` is the first moment "final" is a fact.
 *
 * Only when the card actually trails, and only over an agent's own message — a
 * notice or a tool row after it means something else happened last and the card
 * is already where it belongs.
 */
function liftChangesAboveFinal(view: Mutable, actor: TranscriptEvent['actor']): void {
  if (!isAgent(actor)) return
  const key = view.openChanges[actor]
  if (key === null) return
  const last = view.messages.length - 1
  if (last < 1 || view.messages[last]?.key !== key) return
  const above = view.messages[last - 1]
  if (above?.kind !== 'message' || !isAgent(above.actor)) return
  const [card] = view.messages.splice(last, 1)
  if (card !== undefined) view.messages.splice(last - 1, 0, card)
}

function appendStreamed(
  view: Mutable,
  event: TranscriptEvent,
  kind: TranscriptMessage['kind'],
  key: string,
  text: string
): void {
  const index = view.messages.findIndex((m) => m.key === key)
  if (index === -1) {
    view.messages.push({
      key,
      eventId: event.id,
      // Set once, when the row is opened: every later delta spreads over this.
      at: event.createdAt,
      actor: event.actor,
      kind,
      text,
      status: 'streaming',
    })
    return
  }
  const previous = view.messages[index]
  if (previous === undefined) return
  // A completed message is authoritative; a late delta must not append to it.
  if (previous.status === 'complete') return
  view.messages[index] = { ...previous, text: previous.text + text }
}

/**
 * The questions inside a logged request, read rather than trusted.
 *
 * Every field is checked because this comes off disk: a log written by an older
 * build, or by a provider that has since changed its mind about what it sends,
 * must produce a card that is missing a label rather than a renderer that
 * throws. A set with no readable questions is dropped — there would be nothing
 * to answer.
 *
 * The capability flags are copied exactly and never inferred. `options: []`
 * means the provider asked for typed text; adding a synthetic option would put
 * an answer in front of the user that their agent cannot accept back.
 */
function questionSet(request: unknown): QuestionField[] {
  if (typeof request !== 'object' || request === null) return []
  const asked = (request as { questions?: unknown }).questions
  if (!Array.isArray(asked)) return []

  return asked
    .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
    .map((q, index) => {
      const options = Array.isArray(q['options']) ? q['options'] : []
      return {
        // Position is a usable fallback: Claude's questions carry no id of their
        // own, and the adapter already keys them this way on the wire.
        id: typeof q['id'] === 'string' ? q['id'] : String(index),
        header: typeof q['header'] === 'string' ? q['header'] : '',
        question: typeof q['question'] === 'string' ? q['question'] : '',
        options: options
          .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
          .map((o) => ({
            label: typeof o['label'] === 'string' ? o['label'] : '',
            description: typeof o['description'] === 'string' ? o['description'] : '',
          }))
          .filter((o) => o.label !== ''),
        multiSelect: q['multiSelect'] === true,
        allowOther: q['allowOther'] === true,
        // Fails closed: an unreadable flag is treated as a secret, because
        // showing a credential once cannot be undone by fixing this later.
        isSecret: q['isSecret'] !== false,
      }
    })
    .filter((q) => q.question !== '' || q.header !== '')
}

/** The diff or arguments behind an approval, shown under the summary line. */
function detailOf(payload: Record<string, unknown>): string | null {
  const request = payload['request']
  if (typeof request !== 'object' || request === null) return null
  const r = request as Record<string, unknown>

  /*
   * Why it is being asked, ahead of what it would do.
   *
   * `blockedPath` is the one thing here that cannot be recovered from anywhere
   * else — a Bash command reaching outside the allowed directories names the
   * path only in the permission request, never in its own arguments.
   */
  const why = [r['description'], r['decisionReason'], r['blockedPath']]
    .filter((line): line is string => typeof line === 'string' && line !== '')
    .join('\n')
  if (why !== '') return why

  if (Array.isArray(r['files'])) {
    const patches = r['files']
      .map((f) =>
        typeof f === 'object' && f !== null ? ((f as { patch?: string }).patch ?? '') : ''
      )
      .filter((patch) => patch !== '')
    return patches.length > 0 ? patches.join('\n') : null
  }
  if (r['input'] !== undefined) return JSON.stringify(r['input'], null, 2)
  return null
}

function summarize(payload: Record<string, unknown>): string {
  const kind = typeof payload['kind'] === 'string' ? payload['kind'] : 'approval'
  const request = payload['request']
  if (typeof request !== 'object' || request === null) return kind
  const r = request as Record<string, unknown>

  /*
   * The provider's own sentence, when it rendered one.
   *
   * Everything below reconstructs a summary from a tool name and an argument
   * bag, which is guesswork about something the CLI already knows: it says
   * "Claude wants to read foo.txt" and we were saying "Read foo.txt" beside it.
   * Ours stays as the fallback for a provider that offers nothing.
   */
  if (typeof r['title'] === 'string' && r['title'] !== '') return r['title']

  if (Array.isArray(r['command'])) return `$ ${r['command'].join(' ')}`
  if (Array.isArray(r['files'])) {
    const paths = r['files']
      .map((f) =>
        typeof f === 'object' && f !== null ? ((f as { path?: string }).path ?? '') : ''
      )
      .filter(Boolean)
    return `Edit ${paths.join(', ')}`
  }
  /*
   * Kind first, not `toolName` first.
   *
   * A permissionGrant now carries `toolName` too, and the MCP branch used to
   * claim any payload that had one — defaulting the server to "mcp" when it was
   * absent. Left alone, that made every Task approval read "mcp: Task", which
   * is a worse lie than the "permissionGrant" it replaced.
   */
  if (kind === 'mcpToolCall' && typeof r['toolName'] === 'string') {
    const server = typeof r['serverName'] === 'string' ? r['serverName'] : 'mcp'
    return `${server}: ${r['toolName']}`
  }
  if (typeof r['toolName'] === 'string' && r['toolName'] !== '') return r['toolName']
  return kind
}
