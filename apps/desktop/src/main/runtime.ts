import { ProcessCleanupError } from '@chorus/shared/process-tree'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { TRANSCRIPT_TYPES } from '../shared/transcript-events.js'
import { homedir } from 'node:os'
import { basename, join, resolve as resolvePreviewPath } from 'node:path'
import { ClaudeAdapter, anthropicManagedEnv, type ResolvedExecutable } from '@chorus/adapter-claude'
import { CodexAdapter } from '@chorus/adapter-codex'
import type {
  AccountSummary,
  AgentAdapter,
  AgentSession,
  ApprovalDecision,
  BrowserConsoleAccess,
  BrowserConsoleRead,
  BrowserConsoleRun,
  HealthStatus,
  McpServerHealth,
  ModelChoice,
  NativePlanStep,
  ProgressReport,
  ProgressStep,
  ProjectToolResult,
  SessionOpts,
  SlashCommandInfo,
  TranscriptRequest,
  UsageWindow,
  UserInputResponse,
  EditorEditCapability,
} from '@chorus/agent-protocol'
import {
  mergeUsageWindows,
  nativeProgressSteps,
  noteReminder,
  PROGRESS_INSTRUCTION,
  readOnlyBrowser,
  readOnlyNote,
  validateProgressReport,
} from '@chorus/agent-protocol'
import {
  reduceTask,
  TASK_IGNORED_ITEM_REF_PREFIXES,
  taskBundleFrom,
  taskOutcomeOf,
  type TaskBundle,
  type TaskSnapshot,
} from '../shared/task-progress.js'
import {
  digestAssignment,
  interruptedTurns,
  renderDigest,
  renderForwardedList,
  renderForwardedRefusal,
  renderNotForwarded,
  renderRecord,
  renderSearch,
  type BindAssignmentResult,
  type ForwardedReadContext,
} from './forwarded-work.js'
import type { HostPorts, SecretsPort } from './host-ports.js'
import { editorApprovalRequest } from './editor-preview.js'
import type { WorkbenchPlace } from './project-root.js'
import {
  AppNoteStore,
  ConversationNoteStore,
  EventStore,
  FORWARDED_PAGE,
  KeptNoteStore,
  LOCAL_HOST,
  openSqlite,
  ProjectStore,
  type AppNote,
  type AsideSummary,
  type ConversationSummary,
  type KeptNote,
  type LiveState,
  type RunCommands,
  type SqliteHandle,
  type StoredEvent,
  type TaskStepPayload,
  type TranscriptState,
} from '@chorus/event-store'
import {
  callRule,
  composeCarryover,
  composeCatchup,
  composeTranscript,
  CONTEXT_DEFERRED_PREFIX,
  ConversationService,
  DEFAULT_PROFILE_ID,
  findReplyHandoff,
  parseMentions,
  profileById,
  PROFILES,
  SessionGrants,
  SupervisedSession,
  withCallRule,
  withCatchup,
  type CarryoverOptions,
  type CarryoverSource,
  type PermissionProfile,
  type ReplyHandoff,
} from '@chorus/orchestrator'
import {
  AGENT_IDS,
  isAgentId,
  newConversationId,
  newHandoffId,
  redactText,
  uuidv7,
  type AgentId,
  type ApprovalId,
  type ConversationNote,
  type ConversationNoteView,
  type ConversationNoteWrite,
  type Logger,
} from '@chorus/shared'
import {
  terminalRefKey,
  type ActivityPush,
  type AttentionEvent,
  type ContextUsagePush,
  type ConversationNotePush,
  type TasksPush,
  type TrafficSourceShape,
} from '../shared/ipc.js'
import type { TrafficLegacy } from '../shared/traffic-ipc.js'
import type { WorkbenchTerminalEnv } from '../shared/workbench-ipc.js'
import { UNREAD_EVENT_TYPES } from '../shared/unread.js'
import {
  openConversations,
  readOpenProjects,
  writeOpenProjects,
  type OpenConversation,
  type OpenProjectsState,
} from './open-projects.js'
import { ProjectService } from './project-service.js'
import { EditPreviews } from './edit-preview.js'
import { containsPassage } from '../shared/plain-text.js'
import { questionSetText } from '../shared/question-text.js'
import { networkInterfaces } from 'node:os'
import { readRemembered, writeRemembered } from './remembered.js'
import {
  collaborationPair,
  isExpandedCollaboration,
  isTeamCommand,
  originalCollaborationText,
} from '../shared/collaboration.js'
import { collaborationPrompt, teamIntroduction } from './collaboration-prompt.js'

import { readSettings, type SavedTrafficConnection } from './settings.js'
import {
  TerminalService,
  type TerminalAttachment,
  type TerminalDescription,
  type TerminalPush,
  type TerminalRef,
} from './terminal.js'
import {
  ProjectTrafficRegistry,
  terminalEnvOf,
  type ProjectTrafficConfig,
  type ProjectTrafficState,
} from './project-traffic.js'
import { LineCarries } from './log-lines.js'
import { ProjectRunner, runAvailable } from './project-run.js'
import { projectReader } from './project-read.js'
import type { ConsoleReadRequest, ConsoleRunRequest } from './browser-console.js'
import { resolveShell } from './shell.js'
import { AdbReverse, readRememberedDevices, writeRememberedDevices } from './adb-reverse.js'
import { LogcatService } from './logcat.js'
import type { WorkspaceSnapshot } from '../shared/workspace-layout.js'
import { sdkExecutablePath, spawnSpec } from './command.js'
import { resolveCommand } from './which.js'
import {
  isDiscussion,
  isLiveReply,
  liveMessageAction,
  liveMessageText,
  type LiveMessageMode,
} from '../shared/live-message.js'
import {
  LIVE_QUESTION_CONTEXT_BYTES,
  LiveReplies,
  type DiscussionContextOptions,
} from './live-replies.js'
import { mainT } from './i18n.js'
import { conversationChain, forwardContext, type ForwardContext } from './conversation-context.js'
import {
  contextBudget,
  deferredContext,
  fitContextExcerpt,
  fitContextTail,
  hasTranscript,
  type ContextWindow,
} from './context-budget.js'

export interface ProjectConsoles {
  read(projectId: string, request: ConsoleReadRequest): string | Promise<string>
  run(projectId: string, request: ConsoleRunRequest): Promise<string>
  dispose(projectId: string): void
}

/**
 * Wires the domain to real agents inside the main process.
 *
 * The orchestrator packages know nothing about Electron; this is where the
 * dependency direction turns around (plan §3.2). It owns the single SQLite
 * handle, so every write funnels through here — SQLite is single-writer, and
 * centralising that removes a class of lock contention.
 *
 * A conversation holds **several agents at once**. That is the product's whole
 * point: one shared transcript, separate agent contexts, and the user choosing
 * who sees what. Each agent gets its own `ConversationService` writing into the
 * same conversation id; the log's global sequence is what interleaves them.
 */

export interface StartConversationOptions {
  /**
   * Who to seat, and **absent is the ordinary case**: every conversation gets
   * every agent.
   *
   * The cast used to be a preference — `DEFAULT_SETTINGS.agents` for a new room,
   * `project.agentIds` for a project that had been asked — and `conversation:start`
   * read neither of the two consistently, so a new chat in a project whose card
   * showed three agents opened with the two the settings file happened to hold.
   * DeepSeek was never seated by anything a person could reach.
   *
   * A cast is now a fact rather than a setting: the room holds everyone and the
   * message says who it is for. What stays here is a narrower thing — a caller
   * that genuinely means one agent, which today is only the tests.
   */
  readonly agents?: readonly AgentId[]
  /**
   * Which project the conversation belongs to — an id from the registry, and the
   * only way to say where a conversation is.
   *
   * This used to be a `cwd` string with `projectId` as an optional companion that
   * defaulted to the path when absent, so "the project" was whatever directory
   * the caller happened to name. A conversation could therefore be started
   * anywhere, and two rooms on one folder were two projects that merely looked
   * alike. The root is now resolved from this id and cannot be passed in.
   */
  readonly projectId: string
  readonly title?: string
  /** Defaults to read-only. Permissive defaults ship by accident, not on purpose. */
  readonly profileId?: string
  /**
   * A conversation to go on from, whose transcript seeds every agent here.
   *
   * An id the store is asked about, never text a caller supplies — see the IPC
   * field of the same name. Absent means a fresh room, and Restart depends on
   * that: it starts a replacement through this same method and names no source,
   * so restarting is the one gesture that reliably clears what was carried.
   */
  readonly continueFrom?: string
  readonly objective?: string
  readonly sourceEventIds?: readonly string[]
}

const FAILED_START_LIMIT = 64
const STARTUP_DRAIN_MS = 3_000
const STARTUP_CANCELLED = 'The conversation was closed before its agents started'

export interface StartedConversation {
  readonly conversationId: string
  readonly participants: AgentId[]
  readonly profileId: string
  readonly projectId: string
  readonly cwd: string
  readonly title: string
}

export type StartOutcome =
  | { readonly status: 'ready'; readonly conversation: StartedConversation }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'cancelled' }

interface Participant {
  readonly agentId: AgentId
  readonly service: ConversationService
  readonly session: SupervisedSession
  /**
   * The last event in the shared log this agent has been shown.
   *
   * Agents keep separate contexts, so without this each one only knows the
   * messages addressed to it — which makes a shared transcript that isn't
   * actually shared. Everything past this mark is replayed as catch-up the next
   * time the agent is addressed.
   */
  seenSeq: number
  deferredMessages?: { readonly sessionRef: string; readonly seqs: Set<number> }
  /**
   * Context this agent must be given, prepended to the **next** real message.
   *
   * Promotion cannot send it. `send` starts a turn: delivering the aside's
   * exchange at the moment of promotion would produce an answer nobody asked
   * for, possibly run tools under the profile just chosen, and make "open as a
   * conversation" behave like "ask that again, now, with permissions".
   *
   * Catch-up cannot carry it either — it skips events whose actor is the
   * recipient, and the aside's answer was written by this very agent, so the one
   * thing worth carrying is exactly what it drops.
   *
   * So it waits here, costs nothing, and rides along when the user next speaks.
   */
  seedContext?: string
  continuationPending?: boolean
  /**
   * A larger catch-up allowance, used once.
   *
   * An agent joining an hour-old conversation has to read all of it, and the
   * per-turn budget is sized for "what happened while you were not addressed",
   * not "everything". Cleared after the first delivery so the next turn is
   * ordinary again.
   */
  catchupBudget?: number
  /** The provider's command list, asked for once per session. */
  commands?: readonly SlashCommandInfo[]
  lastReply?: { readonly eventId: string; readonly text: string }
  dispatchEpoch?: number
  origin?: TaskOrigin
}

interface TaskOrigin {
  readonly eventId: string
  readonly at: number
}

type TaskPayload = Extract<
  StoredEvent['payload'],
  { type: 'task.opened' | 'task.revised' | 'task.closed' }
>

type TaskClosedReason = Extract<TaskPayload, { type: 'task.closed' }>['reason']

type HandoffOutcome = Extract<StoredEvent['payload'], { type: 'handoff.outcome' }>

function discussionOpts(opts: SessionOpts): SessionOpts {
  const { progress: _progress, instructions, note, browser, ...rest } = opts
  const kept = (instructions ?? '')
    .split('\n\n')
    .filter((part) => part !== PROGRESS_INSTRUCTION)
    .join('\n\n')
  const viewed = browser === undefined ? rest : { ...rest, browser: readOnlyBrowser(browser) }
  const readable = note === undefined ? viewed : { ...viewed, note: readOnlyNote(note) }
  return kept === '' ? readable : { ...readable, instructions: kept }
}

function redactedStep(step: ProgressStep): TaskStepPayload {
  return {
    id: step.id,
    title: redactText(step.title).text,
    status: step.status,
    ...(step.label === undefined ? {} : { label: step.label }),
    ...(step.parentId === undefined ? {} : { parentId: step.parentId }),
    ...(step.estimateMinutes === undefined ? {} : { estimateMinutes: step.estimateMinutes }),
    ...(step.dependsOn === undefined ? {} : { dependsOn: [...step.dependsOn] }),
  }
}

function sameNativeSteps(a: readonly TaskStepPayload[], b: readonly TaskStepPayload[]): boolean {
  return (
    a.length === b.length &&
    a.every((step, index) => {
      const other = b[index]
      return step.id === other?.id && step.title === other.title && step.status === other.status
    })
  )
}

/**
 * The session that names a conversation's current topic, and its one slot.
 *
 * `queue` serialises requests. Two messages sent in quick succession would
 * otherwise both be in flight on one session, and the replies could be matched
 * to the wrong questions — the second title landing for the first message. It
 * is a promise chain rather than a lock because the failure mode of a lock here
 * is a conversation whose titles stop forever, and nothing on screen says why.
 *
 * `resolve` is set only while a request is waiting, and the reader loop clears
 * it as it hands the reply over. An event arriving with nothing waiting is the
 * ordinary case — the session says other things — and is dropped.
 */
type NamerOutcome =
  | { readonly kind: 'title'; readonly text: string }
  | { readonly kind: 'failed' }
  | { readonly kind: 'timeout' }

interface Namer {
  /**
   * Absent until the first message starts it.
   *
   * Lazy because a conversation nobody speaks in should cost no CLI at all —
   * opening four projects would otherwise spawn four naming sessions to name
   * four empty rooms. Created inside the queue, so two messages sent together
   * cannot each start one.
   */
  readonly sessions: Map<AgentId, AgentSession>
  readonly demoted: Set<AgentId>
  queue: Promise<void>
  starting?: {
    readonly session: Promise<AgentSession>
    readonly cancel: () => void
  }
  pending?: {
    readonly session: AgentSession
    readonly settle: (outcome: NamerOutcome) => void
  }
}

export const NAMER_INSTRUCTIONS = [
  'You are naming a conversation for a tab label. You will be sent the user’s',
  'messages one at a time, in the order they are sent. After each one, reply',
  'with a title naming the topic the conversation is on right now.',
  '',
  'A message may start with "Current title:" and the title the tab shows now.',
  'If the topic has not changed, repeat that title exactly.',
  '',
  'Your entire reply is the title. One line, at most six words, no quotes, no',
  'punctuation at the end, no explanation, no preamble, no translation, no',
  'formatting. Any house style you have been given about how to answer does not',
  'apply here — this is a label, not a reply to a person.',
].join('\n')

/** Long enough for a small model, short enough that nothing waits on it. */
const NAMER_TIMEOUT_MS = 20_000
/** A tab is not a sentence. Past this it is truncated rather than refused. */
const MAX_TITLE_CHARS = 60

const NAMER_ORDER: readonly AgentId[] = ['claude', 'deepseek', 'codex']

/**
 * The one line of a namer's reply that can be used as a title, or null.
 *
 * Null rather than a fallback, and that is the point: a namer that answered with
 * something unusable must leave the title alone. Substituting a guess would
 * rename a conversation on the strength of a reply nobody could parse.
 */
function cleanTitle(reply: string | null): string | null {
  if (reply === null) return null
  const first = reply
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
  if (first === undefined) return null

  // Quotes at either end are the most common way a model returns a label, and
  // they are the only decoration stripped — anything more would start editing
  // titles rather than reading them.
  const stripped = first
    .replace(/^Current title:\s*/, '')
    .replace(/^["'`“”«»]+/, '')
    .replace(/["'`“”«»]+$/, '')
    .trim()
  if (stripped === '') return null
  return stripped.length <= MAX_TITLE_CHARS
    ? stripped
    : `${stripped.slice(0, MAX_TITLE_CHARS - 1)}…`
}

/** What the renderer needs to draw a promoted aside as a tab. */
export interface PromotedConversation {
  readonly conversationId: string
  readonly participants: AgentId[]
  readonly profileId: string
  readonly projectId: string
  readonly cwd: string
  readonly title: string
  readonly unread: number
}

interface DormantAgent {
  readonly ref: string | undefined
  readonly known: boolean
  readonly seenSeq: number
  readonly carry: string | undefined
}

interface ActiveConversation {
  readonly conversationId: string
  stopEpoch?: number
  agentStopEpochs?: Map<AgentId, number>
  readonly participants: Map<AgentId, Participant>
  readonly dormant: Map<AgentId, DormantAgent>
  /** Shared, so a grant given to one agent is not re-asked for the next to join. */
  readonly grants: SessionGrants
  profile: PermissionProfile
  /** Which project this room belongs to. Fixed for the life of the conversation. */
  readonly projectId: string
  /**
   * The project's root, resolved once when the conversation was opened.
   *
   * **Readonly, and that single word is most of Phase 2's invariant.** It used to
   * be assignable and `setProjectDirectory` assigned it, so a conversation could
   * walk to another directory while its agents kept the one they were spawned
   * with — two answers to "where is this" inside one room. The path is now a
   * cached read of the project's root; moving a project is `ProjectService`'s job
   * and moves every conversation under it at once.
   */
  readonly cwd: string
  title: string
  lastAddressed: AgentId | undefined
  /** How far this conversation's card had been read. See `OpenSession`. */
  lastSeenSeq: number
  /** A message typed and not sent, so quitting does not lose it. */
  draft: string
  /** Reading and reasoning, executing nothing, until a plan is approved. */
  planning: boolean
  /**
   * Whether this room's agents carry the user's standing instruction.
   *
   * Per conversation and in memory, which is `planning`'s shape rather than the
   * log's. It was going to be an event; the precedent won, because this is a
   * property of the running session in the same way a mode is — and the state
   * that decides how an agent is *spawned* has to be readable before any event
   * has been replayed.
   *
   * Seeded from `styleOnByDefault` when the conversation opens, so a relaunch
   * returns a room to the global default rather than to whatever it was last
   * toggled to. That is the cost of following `planning`, and it is deliberate:
   * see `answer-in-your-language-2026-09-08/plan.md`.
   */
  styleOn: boolean
  handoffEpoch: number
  readonly working: Set<AgentId>
}

interface StartingConversation {
  readonly conversationId: string
  readonly agents: readonly AgentId[]
  readonly projectId: string
  readonly cwd: string
  readonly title: string
  readonly profile: PermissionProfile
  readonly grants: SessionGrants
  readonly styleOn: boolean
  readonly lastAddressed: AgentId | undefined
  readonly planning: boolean
  readonly continueFrom: string | undefined
  readonly forward: ForwardContext | undefined
  readonly settled: Promise<StartOutcome>
  readonly settle: (outcome: StartOutcome) => void
  readonly started: Participant[]
  draft: string
  cancelled: boolean
}

/**
 * What a joining agent may be handed at once.
 *
 * Several times the ordinary per-turn allowance: it is paid once, and an agent
 * that has read half a conversation is worse than one that has read none, because
 * it does not know which half it is missing.
 */
const JOINING_CATCHUP_CHARS = 60_000

/**
 * What the fork is actually asked.
 *
 * The excerpt is quoted rather than described, for the same reason `quote.ts`
 * quotes into the composer: both CLIs already read `>` as quotation, so the
 * agent sees the passage and the question as two separate things without Chorus
 * inventing a convention to teach it.
 *
 * The framing is deliberate. Without it a fork treats the question as the next
 * turn of the work and starts *doing* things — which is the one behaviour an
 * aside must not have, and which no permission rule would catch because reading
 * files is allowed.
 */
/**
 * What stays in English when the answer is in another language.
 *
 * **One copy, because three prompts need it** — an explanation, a translation,
 * and every follow-up inside either card. Written out three times they drift,
 * and the drift is invisible: two of the three keep working and the third
 * quietly renders `commit` as a word the reader then has to translate back.
 *
 * Two rules, and the second is the one that was missing. Identifiers, paths and
 * file names were already protected — they are names, and a translated name
 * points at nothing. But the **vocabulary** was not: `event`, `status`,
 * `variable`, `props`, `endpoint`, `migration`. A translator renders those,
 * correctly, into ordinary words of the target language — and the result is
 * prose a developer cannot search, cannot paste into a terminal, and cannot
 * match against the code in front of them. Reported from the running app.
 *
 * The examples are deliberate rather than exhaustive: a list that tried to be
 * complete would be wrong tomorrow, and a model given six of the right shape
 * generalises to the seventh.
 */
const KEEP_IN_ENGLISH = [
  'Keep identifiers, file names and paths exactly as written, in their own',
  'script. Do not translate or transliterate them.',
  '',
  'Keep the technical vocabulary in English too, inside otherwise translated',
  'sentences — event, status, variable, commit, branch, props, hook, endpoint,',
  'cache, migration, and the names of tools, libraries, formats and APIs. A term',
  'translated is one the reader has to translate back before they can search for',
  'it, or match it against the code in front of them.',
]

/**
 * The style the toggle turns on when nobody has written their own.
 *
 * **In code rather than in the settings file, and that is the whole design.** A
 * prefilled settings box looks like something the user wrote, so it is edited by
 * accident, half-deleted, and impossible to restore without a "reset" button
 * nobody finds. A constant is the product's own answer: the box starts empty, the
 * toggle starts off, and a first launch behaves exactly as every launch before
 * this feature existed.
 *
 * What the box holds is therefore an **override**, not a seed. Empty means "use
 * this"; anything at all means "use that instead". There is no merge, because a
 * merge of two prompts about how to write is two prompts arguing — and the user's
 * would be the one that lost, being second and shorter.
 *
 * The wording is `docs/plans/answer-in-your-language-2026-09-08/prompt-draft.md`,
 * which was tuned against real replies over a dozen rounds. Three shapes were
 * tried before this one: a single mixed text, unreadable to anyone who does not
 * code-switch; whole-answer doubling, which put each Arabic paragraph screens away
 * from the English it translates. Pairing per paragraph keeps a point beside its
 * translation, which is what a reader actually compares.
 */
export const DEFAULT_STYLE_INSTRUCTION = [
  'Write every reply as paired paragraphs: one paragraph in English, then the same',
  'paragraph in Modern Standard Arabic immediately under it, then the next point',
  'and the same again. The unit is the paragraph, never the whole answer — do not',
  'write the entire reply in one language and then repeat it in the other.',
  '',
  'The Arabic is a full restatement rather than a summary. It says the same thing,',
  'at the same length, and leaves nothing out.',
  '',
  ...KEEP_IN_ENGLISH,
  '',
  'Inside the Arabic paragraph, carry a further share of the sentence in English,',
  'and put that share on verbs and nouns — appending, passing, field, value,',
  'projects, agents. Not on connectives: "otherwise", "which means" and "once" read',
  'as an English sentence interrupted by Arabic, while an English noun inside an',
  'Arabic clause reads as how a developer actually speaks.',
  '',
  'Definite articles stay Arabic and attached — الـ Settings, never "the Settings".',
  'Do not attach an Arabic prefix to an English word in any other position.',
  '',
  'Open every Arabic paragraph with an Arabic word. Direction is decided per block',
  'from its own first strong character, so a paragraph that begins with an',
  'identifier or a code span is laid out left to right however much Arabic follows',
  'it, and nothing later in the paragraph can undo that.',
  '',
  'A status block, a table, or anything else whose value is that it can be scanned',
  'stays in English and is not doubled. Doubling it produces a second essay where a',
  'footer was wanted.',
  '',
  'Questions follow the same rule as a reply, and they matter most, being blocking',
  'and dense. Write the question text in English, then the same text in Arabic as a',
  'separate paragraph under it.',
  '',
  'Option labels and headers stay English — a label is a few words wide and a header',
  'a dozen characters, so two languages truncate both. An option description carries',
  'both languages, and they never share a paragraph: the English sentence first, the',
  'Arabic sentence after it as its own paragraph. Do not mix the two inside one',
  'sentence anywhere in a question card. That card does not resolve direction per',
  'run, so a mixed sentence is laid out by whichever script opened it and the rest',
  'reads backwards.',
].join('\n')

function asideQuestion(excerpt: string, question: string, language = ''): string {
  return [
    'You are being asked a short side question about something you said.',
    'Answer it and nothing else: do not continue the work, do not change files.',
    /*
     * The language the card was opened in, repeated on every follow-up.
     *
     * A card opened by Explain or Translate answered in the chosen language and
     * then switched to English the moment a second question was typed — because
     * only the *first* prompt named a language, and a model answers in the
     * language it was asked in. That is the reported bug, and it makes the
     * feature useless for the person it exists for: someone who reads more
     * comfortably in their own language does not stop after one answer.
     *
     * **The question's own language is deliberately not the answer's.** Typing
     * in English is how a developer types; it says nothing about which language
     * they want to read. The setting says that, and it is the setting that wins
     * until the card is closed.
     *
     * Empty for an ordinary "Ask about this" — that card names no language, and
     * inventing one would answer a plain question in a language nobody chose.
     */
    ...(language === ''
      ? []
      : [
          `Answer in ${language}. Every sentence of it, whatever language the`,
          `question is written in — a question typed in English is still to be`,
          `answered in ${language}.`,
          ...KEEP_IN_ENGLISH,
        ]),
    '',
    excerpt
      .split('\n')
      .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
      .join('\n'),
    '',
    question,
  ].join('\n')
}

/**
 * What a fork is asked when someone did not follow a reply.
 *
 * **The subject is the whole reply now, not a selection**, and the wording moved
 * with it. Explain was offered on a drag until the button under each reply
 * replaced it, so every "the passage below" here would have been pointing at an
 * entire answer while asking the model to treat it as a fragment — and the one
 * instruction that matters most, the length, only reads as a limit if the model
 * knows it is summarising something long.
 *
 * **Level first, language second**, and the ordering is the feature. A prompt
 * that leads with the language produces a faithful translation of something
 * still too dense — the reader is no better off, in a second language.
 *
 * Two failure modes the wording works against, both of which read as a bad
 * feature rather than a bad prompt. **Condescension**: "explain simply" invites
 * an answer starting from first principles, which is insulting to someone who
 * understood every word but one, so the reader is named as what they are — a
 * developer on this project who has not met this particular thing. And
 * **length**: a model asked to explain will keep explaining, while the card is
 * a few hundred pixels at its largest and a passage of one sentence deserves an
 * answer of three.
 *
 * The do-not-work clause is the same one `asideQuestion` carries, and for the
 * same measured reason: without it a fork treats the request as the next turn of
 * the work and starts doing things, which no permission rule catches because
 * reading files is allowed.
 */
export function explainPrompt(excerpt: string, language: string): string {
  return [
    'Someone reading this conversation did not follow your reply below.',
    'Say what it actually is here, what it means for the work, and — briefly — why',
    'it is that way. Nothing else.',
    '',
    // Lead position, because the list below said this and a real answer still
    // opened with "this is not a code unit you saw in the source". An opening
    // clause is the one the model commits to first.
    'Begin with what it *is*. Never open by saying what it is not.',
    '',
    // Also learned from a real answer: asked about a line in a task list, it
    // explained the line's punctuation rather than the task.
    'Explain the work the reply refers to, not how the reply is written.',
    '',
    // Two rounds of real answers taught this list. Each line is something that
    // arrived unasked and pushed the useful part off the card.
    'Leave out:',
    '- what the words mean in general, or one by one, or where they come from;',
    '- what something is *not*, or which other meaning is not intended;',
    '- anything the reply already says, restated;',
    '- remarks about this conversation, about your earlier messages, or about',
    '  what you were or were not offering to do;',
    '- background about the project or its conventions, unless the reply is',
    '  about them.',
    '',
    // Bounded by a number, because "short" drifted twice. Lists are allowed only
    // where the answer genuinely *is* a sequence — a real workflow, a real
    // ordering — and never as a way of getting more room.
    //
    // The second sentence arrived with the whole-reply subject: a long answer
    // invites a proportionally long explanation, which is a second long answer
    // to read rather than a way through the first.
    'Aim for about a hundred words. However long the reply is, the explanation is',
    'this short — the point is a way in, not a second version of it.',
    'Plain paragraphs, short sentences, no headings',
    'and no closing summary. Use a short numbered list only if the answer is a',
    'sequence of steps; otherwise prose.',
    '',
    'They are a developer working on this project who has not met this particular',
    'thing before — not a beginner. Do not start from first principles.',
    '',
    ...KEEP_IN_ENGLISH,
    '',
    `Write your explanation in ${language}. Every sentence of it — not bilingually,`,
    `and not only the first line. If you find yourself back in the reply's own`,
    `language, return to ${language}.`,
    '',
    'You have the whole conversation. Use it: say what this refers to *here*,',
    'rather than what it could mean in general.',
    '',
    // Each clause whole on its own line. A phrase split across a line break is
    // harder to read and easier to weaken by editing one half of it.
    'Do not restate the reply. Do not widen the subject.',
    'Do not continue the work or change anything. Answer this and stop.',
    '',
    excerpt
      .split('\n')
      .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
      .join('\n'),
  ].join('\n')
}

/**
 * What a fork is asked when someone wants a passage in their own language.
 *
 * **Not `explainPrompt` with the language moved up.** The two are opposites.
 * Explain answers _what does this mean_ and its output is deliberately not the
 * passage — "Do not restate the passage" is its sharpest rule, and restating the
 * passage is precisely this job. Sharing a prompt would mean one string holding
 * two contradictory instructions, and the first bad answer would be fixed in a
 * direction that damaged the other feature.
 *
 * **The standard written form**, because the field it reads was built to accept
 * more than a language name — `ipc.ts` calls "Lebanese Arabic" and "simple
 * Arabic" the answers a locale list cannot express. Those are different kinds of
 * modifier: one names a variety, the other a reading level, and a reading level
 * fights the register rule below. Asked for as "standard arabic translation", so
 * the rule is stated rather than left to the model: take the language, render it
 * standard, and let the passage decide the register.
 *
 * **Code and prose are separated explicitly** because "keep code exactly" and
 * "translate the comments" contradict each other if comments count as code, and
 * a model handed both picks one per selection.
 *
 * The do-not-work clause is the same one `asideQuestion` and `explainPrompt`
 * carry, for the same measured reason: without it a fork treats the request as
 * the next turn of the work and starts doing things, which no permission rule
 * catches because reading files is allowed. A translation request looks more
 * like a task than a question does, not less.
 */
export function translatePrompt(excerpt: string, language: string): string {
  return [
    `Translate the passage below into ${language}.`,
    '',
    // Lead position: the first clause is the one a model commits to, and the
    // failure this guards against is an answer that explains instead.
    'Your reply is the passage itself, in another language. Nothing else.',
    'Do not explain it, summarise it, expand it, or comment on what it means.',
    '',
    `Use standard, professional ${language} — the standard written form of the`,
    'language, not a regional dialect and not a simplified reading level.',
    '',
    // Register belongs to the passage, which is what makes this a translation
    // rather than a rewrite.
    'Match the passage: terse stays terse, formal stays formal, a heading stays a',
    'heading, a list stays a list. Same length, same tone, same structure.',
    '',
    'Inside code, translate the prose and nothing else:',
    '- reproduce identifiers, keywords, file names, paths, string literals,',
    '  punctuation, delimiters and indentation exactly as written, in their own',
    '  script — never translated, never transliterated;',
    '- translate natural-language comments and docstrings;',
    '- change nothing else, so the code still runs.',
    '',
    ...KEEP_IN_ENGLISH,
    '',
    'No preamble, no "here is the translation", no notes about the choices you',
    'made, no alternatives in brackets.',
    '',
    // Otherwise a passage already in the target language comes back paraphrased,
    // which looks like a translation and is not one.
    `If the passage is already in ${language}, say so in one short line and stop.`,
    'Do not paraphrase it.',
    '',
    'Do not continue the work or change anything. Answer this and stop.',
    '',
    excerpt
      .split('\n')
      .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
      .join('\n'),
  ].join('\n')
}

/**
 * What `Go` actually sends, in place of the word "go".
 *
 * Built here rather than passed in, for the reason `shared/ipc.ts` states about
 * the aside prompts: prompt content arriving from the renderer is the same class
 * of problem as an unverified source event. The IPC carries the *intent*; the
 * words are the log's side of the boundary.
 *
 * **Short on purpose, unlike its neighbours.** `explainPrompt` and `recapPrompt`
 * are long because they are asking for a shape the model would not otherwise
 * produce — a hundred words of plain prose, a five-heading board. This asks for
 * the thing the agent has *already said it would do*, so most of what could be
 * written here would be re-specifying work that is already specified one message
 * up. Every line below earns its place by naming a way that goes wrong.
 *
 * The last paragraph is the load-bearing one, and it exists because the trigger
 * is a heuristic. `offersToAct` reads prose and will sometimes be wrong; measured
 * over 1,276 real replies it shows on about one turn in nine and refuses far more
 * than it accepts, but "far more" is not "always". Without that paragraph a
 * misfire is an agent picking an option nobody chose; with it, a misfire is an
 * agent answering the question — which is what typing nothing would have got.
 * A heuristic that cannot be perfect is made survivable in the prompt rather
 * than by more regex.
 */
export function goPrompt(): string {
  return [
    'Go ahead with what you just proposed.',
    '',
    // The failure `recapPrompt` also had to name: asked to proceed, a model
    // frequently restates the plan first and calls that the turn.
    'You have already described it, so do not restate it and do not re-plan it.',
    'Start with the doing.',
    '',
    'Work to the end of what you proposed. Stop before the end only if a decision',
    'is genuinely blocking — and then ask that one question and nothing else.',
    '',
    // The trigger is a heuristic over prose. This is what makes it survivable.
    'If you were asking me something rather than offering to act, answer the',
    'question instead. If you are waiting on a decision only I can make, say which',
    'one. Do not guess at what I would have chosen.',
  ].join('\n')
}

/**
 * A decision reached in an aside, carried back into the conversation it came from.
 *
 * An aside is where you work out *whether* to go on — you ask "where are we",
 * read the answer, and conclude "run the tests" or "hold on". Until now that
 * conclusion had nowhere to go: `aside:promote` turns the side question into a
 * third conversation, which takes the thread further away from the work rather
 * than returning to it. This is the return.
 *
 * **The directive leads, and that is a routing constraint rather than a style
 * choice.** `parseMentions` reads mentions only at the *start* of the text, so a
 * provenance line above `@claude run the tests` would leave the mention
 * unparsed and the message routed by `lastAddressed` — to whichever agent
 * happened to speak last, which is exactly the wrong one often enough to matter.
 * Anything added therefore goes underneath.
 *
 * **A reference, not a transcript.** Forwarding the whole side exchange would
 * put its prose in the parent's log, where `catchup.ts` makes every other agent
 * read and summarise it — the cost C-004 exists to measure, paid on every side
 * question anyone ever asks. One line naming what the aside was about is enough
 * for the reply to make sense to a reader a week later, which is the bar the log
 * is held to.
 *
 * The excerpt is flattened and clipped because it is provenance, not content: it
 * says *which* passage this came from, and a paragraph of it in the composer's
 * own transcript would bury the instruction it is annotating.
 */
export function forwardedFromAside(directive: string, excerpt: string): string {
  const trimmed = directive.trim()
  const flat = excerpt.replace(/\s+/g, ' ').trim()
  if (flat === '') return trimmed
  const clipped = flat.length > 120 ? `${flat.slice(0, 119).trimEnd()}…` : flat
  return `${trimmed}\n\n_(from a side question about “${clipped}”)_`
}

/** Long enough for a cold provider start, short enough not to look like a hang. */
const REOPEN_TIMEOUT_MS = 20_000

function withTimeout<T>(work: Promise<T>, ms: number, reason: string | Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(reason instanceof Error ? reason : new Error(reason))
    }, ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export interface SendResult {
  readonly targets: readonly AgentId[]
}

/** What a restore hands back. Named so the single-flight guard and the work it
 *  guards cannot drift apart. */
interface RestoredConversations {
  sessions: {
    conversationId: string
    participants: AgentId[]
    profileId: string
    projectId: string
    cwd: string
    title: string
    unread: number
    /** Still waiting to be answered — see `pendingDecisions`. */
    pendingApprovalIds: string[]
    pendingQuestionIds: string[]
    draft: string
    planning: boolean
  }[]
  workspace: WorkspaceSnapshot | null
}

const VIRTUAL_INTERFACE = /^(utun|bridge|awdl|llw|docker|vmnet|vboxnet|tap|tun)/

const isPrivateLan = (address: string): boolean => {
  const [first, second] = address.split('.').map(Number)
  if (first === undefined || second === undefined) return false
  if (first === 10) return true
  if (first === 172) return second >= 16 && second <= 31
  return first === 192 && second === 168
}

const lanAddress = (): string | null => {
  const fallbacks: string[] = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_INTERFACE.test(name)) continue
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (isPrivateLan(address.address)) return address.address
      fallbacks.push(address.address)
    }
  }
  return fallbacks[0] ?? null
}

export class ChorusRuntime {
  private readonly active = new Map<string, ActiveConversation>()
  private readonly starting = new Map<string, StartingConversation>()
  private readonly failedStarts = new Map<string, string>()
  private readonly startupWork = new Set<Promise<unknown>>()
  private readonly pendingParticipants = new Map<string, Set<Participant>>()
  private readonly promotionParents = new Map<string, string>()
  private readonly conversationProjects = new Map<string, string>()
  private readonly startupOwners = new Map<string, Set<Promise<unknown>>>()
  private readonly cleanupOwners = new Map<string, Map<object, () => Promise<void>>>()
  private readonly cleanedOwners = new WeakSet<object>()
  private readonly conversationClosures = new Map<string, Promise<void>>()
  private readonly closingConversations = new Set<string>()
  private readonly projectClosures = new Map<string, Promise<void>>()
  private readonly closingProjects = new Set<string>()
  private readonly closedProjects = new Set<string>()
  private readonly namerOwners = new WeakMap<AgentSession, string>()
  private readonly backgroundWork = new WeakMap<ConversationService, number>()
  private readonly seating = new WeakMap<ActiveConversation, Map<AgentId, Promise<Participant>>>()
  private closing = false
  /**
   * The restore in flight, so two callers cannot both perform it.
   *
   * `restoreOpenConversations` deduplicates against `this.active`, which only
   * helps once a conversation has finished reopening and registered itself.
   * Two *concurrent* calls both find `active` empty and both start agents for
   * every saved conversation — measured as paired `sessions reopened` log lines
   * milliseconds apart, and two starts for one conversation at seq 159790 and
   * 159795.
   *
   * The second caller is React's Strict Mode, which invokes the startup effect
   * twice in development; but the guard belongs here rather than in the renderer
   * because "start one set of agents per conversation" is main's invariant to
   * keep, and any other caller — a reload, a second window — would break it the
   * same way.
   *
   * Held only for the duration of the call. A later restore is a real request
   * and gets its own run, where the `active` check is the right one.
   */
  private restoring: Promise<RestoredConversations> | null = null
  /**
   * Live asides, by their own conversation id.
   *
   * Separate from `active` on purpose: an aside is not a session. Nothing that
   * walks open conversations — restore, the sidebar, quit — should find one,
   * and keeping them in the same map is how they would.
   */
  private readonly asides = new Map<
    string,
    {
      service: ConversationService
      parentId: string
      excerpt: string
      agentId: AgentId
      /**
       * The language this card answers in, or `''` when it names none.
       *
       * Held for the follow-ups: only the opening prompt used to name it, so a
       * second question in the same card came back in English however the card
       * was opened.
       */
      language: string
    }
  >()
  private readonly namers = new Map<string, Namer>()
  private readonly namingCleanup = new Set<Promise<void>>()
  /**
   * The terminal panels' shells.
   *
   * Held by the runtime because a session terminal's lifetime is a
   * conversation's, and because its working directory is one only the runtime
   * knows. The global terminal is inside the same service but outside that
   * lifetime — the service keeps it in its own field for the same reason
   * `asides` is not in `active`, and `close()` below drains it explicitly for
   * the same reason too.
   */
  private readonly terminals = new TerminalService({
    cwdFor: (ref) => {
      switch (ref.scope) {
        case 'global':
          return homedir()
        case 'session':
          return this.active.get(ref.conversationId)?.cwd ?? homedir()
        case 'project':
          return this.projects.get(ref.projectId)?.canonicalRoot ?? homedir()
        case 'shell':
          return this.shellRoot(ref.projectId)
      }
    },
    envFor: (ref) => (ref.scope === 'shell' ? this.shellEnv(ref.projectId) : process.env),
  })
  private readonly traffic: ProjectTrafficRegistry
  private readonly runner: ProjectRunner
  private browserConsoles: ProjectConsoles | null = null
  /**
   * Partial lines, one per terminal — see `LineCarries`.
   *
   * It was a single string here, which is the defect: the tap fires for every
   * session, so two terminals producing output at once shared one buffer and the
   * line assembled from both was filed against whichever delivered the newline.
   */
  private readonly trafficCarry = new LineCarries()
  private readonly logcat = new LogcatService()
  private readonly adbReverse = new AdbReverse({
    load: () => readRememberedDevices(this.userDataPath),
    save: (addresses) => {
      writeRememberedDevices(this.userDataPath, addresses)
    },
    warn: (message, fields) => {
      this.log.warn(message, fields)
    },
  })
  /** Last renderer-owned editor arrangement, persisted beside the active sessions. */
  private workspaceSnapshot: WorkspaceSnapshot | null = null
  /** The latest windows each provider reported, for a window opened later. */
  private readonly limits = new Map<AgentId, readonly UsageWindow[]>()
  private onLimits: ((push: { agentId: AgentId; windows: UsageWindow[] }) => void) | undefined
  private onContextUsage: ((push: ContextUsagePush) => void) | undefined
  private readonly contextWindows = new Map<
    string,
    { readonly sessionRef: string; readonly usage: ContextWindow }
  >()
  private onTasks: ((push: TasksPush) => void) | undefined
  private readonly noteListeners = new Set<(push: ConversationNotePush) => void>()
  private onConversations: (() => void) | undefined
  private onActivity: ((push: ActivityPush) => void) | undefined
  private onAttention: ((push: AttentionEvent) => void) | undefined
  /**
   * The last model list each agent reported, for the settings sheet.
   *
   * The sheet can be opened with nothing running, and `supportedModels()` is a
   * control request to a live CLI. An installed CLI's list does not change, so
   * remembering what a session already answered is both cheaper and available
   * when no session is.
   */
  /**
   * What each agent's catalogue is doing, not just what is in it.
   *
   * A list and a length cannot say why it is empty. Discovery discarded an empty
   * answer and swallowed a failure, so "not asked yet", "asked and offered
   * nothing" and "asked and it broke" were one indistinguishable silence — and a
   * sheet cannot be honest about an agent that reports nothing until they are
   * separate facts.
   */
  private readonly knownModelsByAgent = new Map<
    AgentId,
    { status: 'unqueried' | 'loading' | 'ready' | 'failed'; models: readonly ModelChoice[] }
  >()

  /**
   * Proposed edits waiting on a card, by approval id.
   *
   * One store for the app rather than one per conversation, because a preview is
   * settled by an approval id and those are unique across every room. Nothing in
   * it is durable: a preview describes a decision that is still open, and a
   * decision read back after a restart is one nobody is waiting on.
   */
  private readonly previews = new EditPreviews()
  private readonly editorPreviews = new Map<string, { root: string; path: string }>()
  private readonly liveReplies: LiveReplies

  private get userDataPath(): string {
    return this.ports.userDataPath
  }

  private constructor(
    readonly store: EventStore,
    private readonly adapters: Map<AgentId, AgentAdapter>,
    readonly log: Logger,
    /** Where the note about what was open is kept, next to the log and the db. */
    readonly ports: HostPorts,
    /**
     * The project registry — Phase 2's domain, and the thing that turns a project
     * id into a root without putting a dialog in front of somebody.
     */
    readonly projects: ProjectService,
    /**
     * The note that belongs to no project — the same registry, one level up.
     *
     * Not folded into `ProjectService`: that class turns a project id into a
     * root and reconciles what runs inside one, and this row has no project id
     * to be about.
     */
    private readonly appNote: AppNoteStore,
    /**
     * The notes that belong to nothing, which is a different claim from the one
     * above: that row is *the* note the app keeps, and these are a collection
     * addressed by id, made and deleted one at a time.
     */
    private readonly keptNotes: KeptNoteStore,
    private readonly conversationNotes: ConversationNoteStore,
    private readonly deferRestoredAgents: boolean
  ) {
    this.liveReplies = new LiveReplies(this.store)
    this.store.subscribe((events) => {
      this.followHandoffs(events)
    })
    this.traffic = new ProjectTrafficRegistry({
      config: (projectId) => this.projectTrafficConfig(projectId),
      nextPort: (projectId) => this.projects.nextTrafficPort(projectId),
      remember: (projectId, config) => {
        this.projects.setTrafficConfig(projectId, {
          trafficOrigin: config.origin,
          trafficPort: config.port,
          trafficAccess: config.access,
          trafficEnvVar: config.envVar,
        })
      },
      address: () => lanAddress(),
      wantsReady: (projectId) => this.ownsLocalSurface(projectId),
      localProject: (projectId) => this.projects.get(projectId)?.host === LOCAL_HOST,
    })
    this.logcat.subscribe((line) => {
      this.traffic.routeLogcatLine(line)
    })
    this.traffic.subscribe((push) => {
      if (push.kind !== 'state') return
      this.adbReverse.sync(this.traffic.capturingPorts())
      this.ports.editor.refreshTerminalEnv()
    })
    this.adbReverse.onChange(() => {
      this.traffic.setForwarded((port) => this.adbReverse.forwarded(port))
    })
    this.runner = new ProjectRunner({
      project: (projectId) => this.projects.get(projectId),
      traffic: this.traffic,
      terminals: this.terminals,
      shell: () => resolveShell(process.env, process.platform),
      env: () => process.env,
      platform: process.platform,
      kill: (pid, signal) => {
        process.kill(pid, signal)
      },
      log: this.log,
    })
    /*
     * The tap observes; it does not read history. A terminal running Metro holds
     * whatever was typed before Metro started, which is the sharpest instance of
     * C-021's unsolved half — so lines flow to whichever project chose this
     * terminal, and a terminal nobody chose sends nothing anywhere.
     */
    this.terminals.tap((ref, event) => {
      const key = terminalRefKey(ref)
      if (event.kind === 'exit') {
        for (const line of this.trafficCarry.flush(key)) {
          this.traffic.routeLogLine(ref, line, null)
        }
        this.traffic.routeLogLine(ref, '', event.code)
        return
      }
      for (const line of this.trafficCarry.push(key, event.data)) {
        this.traffic.routeLogLine(ref, line, null)
      }
    })
  }

  private projectTrafficConfig(projectId: string): ProjectTrafficConfig | null {
    const project = this.projects.get(projectId)
    if (project === null) return null
    return {
      origin: project.trafficOrigin,
      port: project.trafficPort,
      access: project.trafficAccess,
      envVar: project.trafficEnvVar,
    }
  }

  terminalEnvFor(place: WorkbenchPlace): WorkbenchTerminalEnv | null {
    if (place.host !== LOCAL_HOST) return null
    const project = this.projects.findByPlace(place)
    if (project === null) return null
    return terminalEnvOf(this.traffic.state(project.id))
  }

  async ensureTerminalEnv(place: WorkbenchPlace): Promise<WorkbenchTerminalEnv | null> {
    if (place.host !== LOCAL_HOST) return null
    const project = this.projects.findByPlace(place)
    if (project === null) return null
    await this.traffic.prepare(project.id)
    return terminalEnvOf(this.traffic.state(project.id))
  }

  private shellRoot(projectId: string): string | null {
    if (readOnlyProfiling()) return null
    const project = this.projects.get(projectId)
    if (project === null || !runAvailable(project, process.platform)) return null
    return project.canonicalRoot
  }

  private shellEnv(projectId: string): NodeJS.ProcessEnv {
    const redirect = terminalEnvOf(this.traffic.state(projectId))
    return redirect === null ? process.env : { ...process.env, [redirect.name]: redirect.value }
  }

  private disposeProjectShells(projectId: string): void {
    try {
      this.terminals.disposeShells(projectId)
    } catch (error) {
      this.log.warn('project shells did not all stop', {
        projectId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private ownsLocalSurface(projectId: string): boolean {
    const project = this.projects.get(projectId)
    if (project?.host !== LOCAL_HOST) return false
    return this.ports.editor.hasSurface({ host: LOCAL_HOST, root: project.canonicalRoot })
  }

  static open(
    ports: HostPorts,
    log: Logger,
    adapters?: Map<AgentId, AgentAdapter>,
    options: { readonly deferRestoredAgents?: boolean } = {}
  ): ChorusRuntime {
    const userDataPath = ports.userDataPath
    const path = join(userDataPath, DATABASE_FILE)
    const { db, store, recovered } = openOrRecover(path, userDataPath)
    if (recovered !== null) log.warn('database was unreadable and was moved aside', { recovered })

    /*
     * Close sessions the log still believes are running.
     *
     * A crash leaves `session.started` with no `session.ended`, so without this
     * the app boots claiming agents are alive that died with the process — and
     * the UI would show them as live.
     */
    /*
     * Skipped under the profiling flag, because it *writes*: it appends a
     * `session.ended` for every session the log still believes is running. A
     * copy of a live database has plenty of those, so the first profiling open
     * would change the fixture and the second run would measure a different
     * conversation from the first — which is the exact failure the pristine copy
     * exists to prevent.
     */
    const { closed } = readOnlyProfiling() ? { closed: 0 } : store.reconcileOrphanedSessions()
    if (closed > 0) log.warn('closed sessions orphaned by a crash', { closed })
    log.info('runtime ready', { events: store.lastSeq() })

    /*
     * Built over the same handle as the log, so a project write and an append can
     * share a transaction if anything ever needs them to. Nothing does today, and
     * the point is that the option was not designed away.
     */
    const projects = new ProjectService(new ProjectStore(db), db)

    return new ChorusRuntime(
      store,
      adapters ?? defaultAdapters(ports),
      log,
      ports,
      projects,
      new AppNoteStore(db),
      new KeptNoteStore(db),
      new ConversationNoteStore(db),
      options.deferRestoredAgents ?? false
    )
  }

  /**
   * Grants for one conversation, seeded with what the user answered permanently.
   *
   * The remembered set is machine-wide and the same for every room — answered
   * once, which is the whole point — while the session half stays per
   * conversation as before. Written back on every addition rather than at quit,
   * because a decision lost to a crash is a decision the user has to make twice.
   */
  private newGrants(): SessionGrants {
    return new SessionGrants({
      keys: readRemembered(this.userDataPath),
      onRemember: (keys) => {
        writeRemembered(this.userDataPath, keys)
        this.log.info('remembered a permission permanently', { total: keys.length })
      },
    })
  }

  /** Told whenever a provider reports its account limits. */
  onLimitsReported(listener: (push: { agentId: AgentId; windows: UsageWindow[] }) => void): void {
    this.onLimits = listener
  }

  /**
   * Told how full a conversation's agent has filled its context window.
   *
   * Scoped by conversation, unlike limits: a plan window belongs to the account
   * and reads the same wherever it is asked from, while this belongs to one
   * agent in one conversation. Not remembered across restarts — a figure from
   * before a restart describes a context that no longer exists.
   */
  onContextUsageReported(listener: (push: ContextUsagePush) => void): void {
    this.onContextUsage = listener
  }

  /**
   * Told what each conversation's agents have left running.
   *
   * Not remembered across restarts, and deliberately not seeded on reopen: the
   * processes belonged to a session that has ended. The next change repopulates
   * it, and until then nothing running is the truthful answer.
   */
  onTasksReported(listener: (push: TasksPush) => void): void {
    this.onTasks = listener
  }

  onNoteChanged(listener: (push: ConversationNotePush) => void): () => void {
    this.noteListeners.add(listener)
    return () => {
      this.noteListeners.delete(listener)
    }
  }

  onConversationsChanged(listener: () => void): void {
    this.onConversations = listener
  }

  /**
   * Told what each conversation's agents say they are doing.
   *
   * Nothing is remembered and nothing is seeded on reopen, for a stronger
   * version of the reason above: this describes an agent mid-turn, and there is
   * no turn in flight when a window opens. The next thing the provider says
   * repopulates it; until then, saying nothing in particular is the truth.
   */
  onActivityReported(listener: (push: ActivityPush) => void): void {
    this.onActivity = listener
  }

  onAttentionReported(listener: (push: AttentionEvent) => void): void {
    this.onAttention = listener
  }

  /** What each provider last reported, so a new window is not born blank. */
  knownLimits(): { agentId: AgentId; windows: UsageWindow[] }[] {
    return [...this.limits].map(([agentId, windows]) => ({ agentId, windows: [...windows] }))
  }

  /** Push target for the renderer. Fires only after a commit. */
  subscribe(listener: (events: readonly StoredEvent[]) => void): () => void {
    return this.store.subscribe(listener)
  }

  availableAgents(): AgentId[] {
    return [...this.adapters.keys()]
  }

  availableProfiles(): { id: string; name: string; summary: string }[] {
    return PROFILES.map(({ id, name, summary }) => ({ id, name, summary }))
  }

  /** Everything the user has granted for this session, for the audit view. */
  sessionGrants(conversationId: string): { key: string; describe: string }[] {
    const first = [...this.require(conversationId).participants.values()][0]
    return first?.service.sessionGrants() ?? []
  }

  /**
   * Starts a conversation in a directory, adopting that directory as a project
   * if it is not one already.
   *
   * The bridge between a world where somebody picks a folder and one where every
   * conversation belongs to a project. `adopt` is idempotent on the canonical
   * root, so picking the same folder twice — or picking it through a symlink —
   * yields **one** project with two conversations in it rather than two projects
   * that merely look alike. That is the invariant arriving by the front door: it
   * is not enforced on the renderer, it is simply no longer expressible.
   *
   * An empty directory still means "start at home", because that behaviour
   * belongs to the person choosing rather than to the domain, and removing it
   * here would break the first-launch path before there is a projects rail to
   * replace it with.
   */
  async startConversationIn(options: {
    readonly cwd: string
    readonly title?: string
    readonly profileId?: string
    /** Narrower than the full cast, and only ever a test saying so. */
    readonly agents?: readonly AgentId[]
  }): Promise<{
    conversationId: string
    participants: AgentId[]
    profileId: string
    projectId: string
    cwd: string
    title: string
  }> {
    const { project } = this.projects.adopt(
      options.cwd.trim() === '' ? homedir() : options.cwd.trim()
    )

    /*
     * The project's answer wins over this call's default, and loses to an
     * explicit argument.
     *
     * The order is the point of moving this setting up: a second conversation
     * in a directory whose profile is already Trusted should open Trusted, not
     * ask again. An explicit `profileId` still overrides, because a caller that
     * named one — restart, promotion, a side task inheriting its parent's — is
     * stating a fact rather than accepting a default.
     *
     * The cast used to be read here too, out of `project.agentIds`. It is no
     * longer a project answer at all: every room holds every agent, so there is
     * nothing left to inherit and nothing left to disagree about.
     */
    const profileId = options.profileId ?? project.profileId ?? undefined

    // Spread rather than assigned: under `exactOptionalPropertyTypes` an
    // explicit `undefined` is not the same as an absent optional field.
    return this.startConversation({
      projectId: project.id,
      ...(options.agents === undefined ? {} : { agents: options.agents }),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(profileId === undefined ? {} : { profileId }),
    })
  }

  async startConversation(options: StartConversationOptions): Promise<StartedConversation> {
    const { conversationId } = this.beginConversation(options)
    const outcome = await this.awaitStart(conversationId)
    switch (outcome.status) {
      case 'ready':
        return outcome.conversation
      case 'failed':
        throw new Error(outcome.message)
      case 'cancelled':
        throw new Error(STARTUP_CANCELLED)
    }
  }

  beginConversation(options: StartConversationOptions): StartedConversation {
    this.openProject(options.projectId)

    /*
     * The whole cast unless a caller narrowed it, and a narrowed empty list is
     * still refused rather than quietly widened.
     */
    const agents = options.agents ?? [...AGENT_IDS]
    if (agents.length === 0) throw new Error('A conversation needs at least one agent')

    /*
     * The root comes from the registry, and the check comes with it.
     *
     * This used to normalise a caller's string and then `describeDirectory` it.
     * `resolveAgentCwd` does the same job from the other end — it refuses an id
     * nobody adopted, and refuses an adopted id whose folder has gone — so the
     * directory is still verified before anything is spawned, which is what the
     * old check was for: a missing cwd makes the spawn fail with ENOENT, and the
     * Claude SDK reports that as "the native binary failed to launch", which once
     * sent a real user hunting a nonexistent architecture problem.
     *
     * What is gone is "an empty directory means start at home". A conversation
     * now belongs to a project, and there is no project that means "nowhere in
     * particular" — whoever adopts the folder decides that, before we get here.
     */
    const cwd = this.projects.resolveAgentCwd(options.projectId)

    /*
     * Refused here rather than at `startParticipant`, and the difference is a
     * write.
     *
     * `conversation.created` is appended a few lines below, before any agent is
     * started — so relying on the guard further down left a **ghost
     * conversation** in the log every time one was attempted: the start failed,
     * the row stayed. A profiling run against a copy of a real database would
     * therefore change it, and the second run would measure a different fixture
     * from the first. Found by a test asserting the log position does not move.
     */
    if (readOnlyProfiling()) {
      throw new Error('A conversation cannot be started: CHORUS_PROFILE_READONLY is set')
    }

    const conversationId = newConversationId()
    const source =
      options.continueFrom === undefined ? undefined : this.active.get(options.continueFrom)
    const sourceEvents =
      options.continueFrom === undefined ? [] : this.store.read(options.continueFrom)
    const latestRequest = sourceEvents.findLast((event) => event.payload.type === 'user.message')
    const objective = (
      options.objective ??
      (latestRequest?.payload.type === 'user.message' ? latestRequest.payload.text : undefined) ??
      ''
    )
      .trim()
      .slice(0, 2000)
    const anchored = [...new Set(options.sourceEventIds ?? [])]
      .filter((id) => sourceEvents.some((event) => event.id === id))
      .slice(0, 20)
    const forward =
      options.continueFrom === undefined || objective === ''
        ? undefined
        : {
            throughSeq: sourceEvents.at(-1)?.seq ?? 0,
            objective,
            sourceEventIds:
              anchored.length > 0
                ? anchored
                : sourceEvents
                    .filter((event) => event.payload.type === 'agent.message.completed')
                    .slice(-1)
                    .map((event) => event.id),
          }
    const profile = profileById(
      source?.profile.id ??
        this.projects.get(options.projectId)?.profileId ??
        options.profileId ??
        ''
    )

    // One set of grants for the whole conversation: allowing something for
    // Codex should not mean being asked again the moment Claude does the same.
    const grants = this.newGrants()

    /*
     * Read once, and used by both the agents and the room they belong to.
     *
     * The agents are started before the `ActiveConversation` exists, so this
     * cannot come from `conversation.styleOn` — and reading the sheet twice would
     * let a settings write land between the two and produce a room whose flag
     * says one thing while its agents were spawned under another.
     *
     * **This is the bug the first version shipped with.** The factory below
     * passed a bare `{ cwd, profile }`, so a new conversation was always spawned
     * without the instruction whatever the checkbox said — while the flag was
     * seeded `true` from that same checkbox. The composer's toggle then did
     * nothing on its first click, because `setAnswerStyle` returns early when the
     * flag already matches what was asked for.
     */
    const styleOn = source?.styleOn ?? this.defaultStyleOn()

    let settle: (outcome: StartOutcome) => void = () => undefined
    const settled = new Promise<StartOutcome>((resolve) => {
      settle = resolve
    })
    const starting: StartingConversation = {
      conversationId,
      agents,
      projectId: options.projectId,
      cwd,
      title:
        options.title ??
        (options.objective === undefined
          ? (source?.title ?? folderName(cwd))
          : Array.from(
              (
                options.objective
                  .trim()
                  .split(/\r?\n/u)
                  .find((line) => line.trim() !== '') ?? ''
              )
                .trim()
                .replace(/\s+/gu, ' ')
            )
              .slice(0, 80)
              .join('')),
      profile,
      grants,
      styleOn,
      lastAddressed: source?.lastAddressed,
      planning: source?.planning ?? false,
      continueFrom: options.continueFrom,
      forward,
      settled,
      settle,
      started: [],
      draft: '',
      cancelled: false,
    }
    this.conversationProjects.set(conversationId, options.projectId)
    this.starting.set(conversationId, starting)
    this.trackStartup(
      this.bootStarting(starting)
        .catch((error: unknown) =>
          this.failStart(starting, [error instanceof Error ? error.message : String(error)])
        )
        .then(settle, (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          settle({ status: 'failed', message })
        }),
      conversationId
    )
    this.onConversations?.()
    return {
      conversationId,
      participants: [],
      profileId: profile.id,
      projectId: options.projectId,
      cwd,
      title: starting.title,
    }
  }

  async awaitStart(conversationId: string): Promise<StartOutcome> {
    const starting = this.starting.get(conversationId)
    if (starting !== undefined) {
      const outcome = await starting.settled
      if (outcome.status === 'failed') this.failedStarts.delete(conversationId)
      return outcome
    }
    const failure = this.failedStarts.get(conversationId)
    if (failure !== undefined) {
      this.failedStarts.delete(conversationId)
      return { status: 'failed', message: failure }
    }
    const open = this.active.get(conversationId)
    return open === undefined
      ? { status: 'cancelled' }
      : { status: 'ready', conversation: this.startedInfo(open) }
  }

  private async bootStarting(starting: StartingConversation): Promise<StartOutcome> {
    const stopped = (): boolean => starting.cancelled
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    if (stopped()) return { status: 'cancelled' }
    const { conversationId, cwd, profile, grants, styleOn } = starting

    /*
     * Composed before anything is appended, so a source that is not there costs
     * nothing.
     *
     * `carriedChain` returns nothing for an unknown id and `composeCarryover`
     * answers `null` for rooms that said nothing — so a stale id, a purged
     * conversation or one that never held a word all collapse to the same
     * harmless outcome: an ordinary fresh room. Refusing to start would be the
     * wrong trade, because the thing the person asked for is a conversation and
     * the carry is what they wanted *in* it.
     */
    const carryover =
      starting.continueFrom === undefined
        ? null
        : composeCarryover(
            this.carriedChain(starting.continueFrom, starting.forward?.throughSeq),
            starting.forward === undefined
              ? {}
              : {
                  objective: starting.forward.objective,
                  sourceEventIds: starting.forward.sourceEventIds,
                }
          )

    this.store.append({
      conversationId,
      actor: 'user',
      payload: {
        type: 'conversation.created',
        // Recorded only when something was actually carried. Naming a source
        // that turned out to be empty would make the reopen path below rebuild
        // a seed that does not exist, every launch, forever.
        ...(carryover === null || starting.continueFrom === undefined
          ? {}
          : {
              continuedFrom: starting.continueFrom,
              ...(starting.forward === undefined ? {} : { forward: starting.forward }),
            }),
        /*
         * A real project id at last. This read `options.projectId ?? cwd`, so
         * every conversation ever started without one recorded its *path* in the
         * field named for the project — which is why the `projects` table could
         * sit empty since migration 1 while every row in `conversations` claimed
         * to have a project.
         */
        projectId: starting.projectId,
        // The folder is what a conversation is about until you say otherwise,
        // and it is a better answer than "Untitled" for one you never rename.
        title: starting.title,
      },
    })

    /*
     * Said out loud, because an agent that silently knows things is worse than
     * one that does not know them.
     *
     * Carrying a transcript changes what every answer in this room is based on,
     * and none of it is on screen — the new transcript is empty. Without a line
     * saying so, an agent referring to a decision made in the other room reads
     * as a hallucination, and the person has no way to tell the two apart.
     *
     * Appended here, above the `lastSeenSeq` watermark taken further down, so
     * the room it explains does not open already claiming to be unread.
     */
    if (carryover !== null) {
      this.store.append({
        conversationId,
        actor: 'system',
        payload: {
          type: 'notice.raised',
          level: 'info',
          source: 'system',
          code: 'contextCarried',
          // The words live in `en.json`; this is the fallback a coded notice
          // falls back to, never the string anyone is expected to read.
          text: 'Continued from the previous conversation.',
          detail: starting.forward?.objective ?? null,
        },
      })
    }

    // Started in parallel: two agents booting sequentially doubles the wait for
    // no reason, and one failing should not hide the other.
    const started = await Promise.allSettled(
      starting.agents.map((agentId) =>
        /*
         * Resolved per agent, and resolved *here*.
         *
         * This path used to build its own `SessionOpts` with a cwd, a sandbox
         * and no model at all — so the sheet headed "New sessions start with"
         * did nothing for new sessions, the one case its label promises. The
         * provider sandbox still mirrors the profile, for defence in depth
         * rather than relying only on our own gate (plan §4.4).
         */
        this.startParticipant(
          agentId,
          conversationId,
          (resuming) =>
            this.sessionOptsFor(
              { conversationId, cwd, profile, styleOn, projectId: starting.projectId },
              agentId,
              resuming
            ),
          profile,
          grants,
          undefined,
          false,
          undefined,
          stopped
        ).then((participant) => {
          if (stopped()) {
            this.closeStarted(participant, conversationId)
            throw new Error(STARTUP_CANCELLED)
          }
          starting.started.push(participant)
          return participant
        })
      )
    )
    if (stopped()) return { status: 'cancelled' }

    const conversation: ActiveConversation = {
      conversationId,
      participants: new Map(),
      dormant: new Map(),
      grants,
      profile,
      projectId: starting.projectId,
      cwd,
      title: starting.title,
      lastAddressed: starting.lastAddressed,
      handoffEpoch: 0, // A new room has nothing unread in it, and the log's end is what "nothing"
      // means — seeding 0 would count the whole database as news.
      working: new Set(),
      lastSeenSeq: this.store.lastSeq(),
      draft: starting.draft,
      planning: starting.planning,
      // The same value the agents above were spawned under, not a second read.
      styleOn,
    }
    const failures: string[] = []

    for (const outcome of started) {
      if (outcome.status === 'fulfilled') {
        conversation.participants.set(outcome.value.agentId, outcome.value)
      } else {
        failures.push(
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        )
      }
    }

    if (conversation.participants.size === 0) return this.failStart(starting, failures)

    if (conversation.planning) {
      await Promise.all(
        [...conversation.participants.values()].map((participant) =>
          participant.session.setPermissionMode('plan')
        )
      )
    }
    if (stopped()) return { status: 'cancelled' }

    /*
     * The carried transcript waits with the agents rather than being sent.
     *
     * Delivering it now would start a turn nobody asked for: the person opened
     * a room, they have not said anything yet, and an agent handed a transcript
     * with no question attached answers it. `seedContext` exists for exactly
     * this shape — it costs nothing until the person speaks, and rides in front
     * of their first message when they do.
     *
     * Every agent gets its own copy of the same text. They keep separate
     * contexts, so seeding only the one that happens to be addressed first
     * would produce a room where one agent remembers the earlier work and the
     * other does not, which is worse than neither remembering it.
     */
    if (carryover !== null) {
      for (const participant of conversation.participants.values()) {
        participant.seedContext = carryover
        participant.continuationPending = true
      }
    }

    // A partial start belongs in the transcript: it should say why an agent the
    // user asked for is absent, rather than silently omitting it.
    for (const message of failures) {
      this.log.error('an agent could not be started', undefined, { conversationId, message })
      this.store.append({
        conversationId,
        actor: 'system',
        payload: { type: 'error.raised', message, recoverable: false },
      })
    }

    this.log.info('conversation started', {
      conversationId,
      agents: [...conversation.participants.keys()].join(','),
      profile: profile.id,
    })
    this.starting.delete(conversationId)
    this.active.set(conversationId, conversation)
    this.rememberOpen()
    this.onConversations?.()
    return { status: 'ready', conversation: this.startedInfo(conversation) }
  }

  private failStart(starting: StartingConversation, failures: readonly string[]): StartOutcome {
    if (starting.cancelled) return { status: 'cancelled' }
    const message = failures.join('; ') || 'No agent could be started'
    const { conversationId } = starting
    this.starting.delete(conversationId)
    for (const participant of starting.started.splice(0))
      this.closeStarted(participant, conversationId)
    if (this.active.delete(conversationId)) {
      try {
        this.rememberOpen()
      } catch (error) {
        this.log.warn('a failed start could not be dropped from the reopen list', {
          conversationId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.failedStarts.set(conversationId, message)
    if (this.failedStarts.size > FAILED_START_LIMIT) {
      const oldest = this.failedStarts.keys().next()
      if (oldest.done !== true) this.failedStarts.delete(oldest.value)
    }
    this.onConversations?.()
    return { status: 'failed', message }
  }

  private cancelStarting(starting: StartingConversation): void {
    starting.cancelled = true
    this.starting.delete(starting.conversationId)
    starting.settle({ status: 'cancelled' })
    for (const participant of starting.started.splice(0))
      this.closeStarted(participant, starting.conversationId)
    this.onConversations?.()
  }

  private closeStarted(participant: Participant, conversationId: string): void {
    const work = this.closeOwned(conversationId, participant.service, () =>
      participant.service.close(this.closing ? 'shutdown' : 'closed')
    )
    this.trackStartup(work, conversationId)
    void work.catch((error: unknown) => {
      this.log.warn('a starting agent could not be closed', {
        agentId: participant.agentId,
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private closeOwned(
    conversationId: string,
    key: object,
    close: () => Promise<void>
  ): Promise<void> {
    if (this.cleanedOwners.has(key)) return Promise.resolve()
    const owners = this.cleanupOwners.get(conversationId) ?? new Map<object, () => Promise<void>>()
    this.cleanupOwners.set(conversationId, owners)
    const existing = owners.get(key)
    if (existing !== undefined) return existing()
    let pending: Promise<void> | undefined
    const retry = (): Promise<void> => {
      pending ??= Promise.resolve()
        .then(close)
        .then(() => {
          this.cleanedOwners.add(key)
          owners.delete(key)
          if (owners.size === 0) this.cleanupOwners.delete(conversationId)
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    }
    owners.set(key, retry)
    return retry()
  }

  private trackStartup(work: Promise<unknown>, conversationId?: string): void {
    this.startupWork.add(work)
    const owned =
      conversationId === undefined
        ? undefined
        : (this.startupOwners.get(conversationId) ?? new Set<Promise<unknown>>())
    if (conversationId !== undefined && owned !== undefined)
      this.startupOwners.set(conversationId, owned)
    owned?.add(work)
    const forget = (): void => {
      this.startupWork.delete(work)
      owned?.delete(work)
      if (conversationId !== undefined && owned?.size === 0)
        this.startupOwners.delete(conversationId)
    }
    void work.then(forget, (error: unknown) => {
      if (conversationId !== undefined && error instanceof ProcessCleanupError) {
        void this.closeOwned(conversationId, error, () => error.retry()).catch(() => undefined)
      }
      forget()
    })
  }

  private async drainConversationStarts(conversationId: string): Promise<void> {
    const drain = async (): Promise<void> => {
      while ((this.startupOwners.get(conversationId)?.size ?? 0) > 0) {
        await Promise.allSettled([...(this.startupOwners.get(conversationId) ?? [])])
      }
    }
    await withTimeout(
      drain(),
      25_000,
      'Agent startup has not finished stopping; close this chat again to retry'
    )
  }

  private async settleClosures(work: readonly Promise<unknown>[], message: string): Promise<void> {
    const results = await withTimeout(Promise.allSettled(work), 25_000, message)
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (errors.length > 0)
      throw new AggregateError(
        errors.map((result): unknown => result.reason),
        `${message}: ${errors.map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason))).join('; ')}`
      )
  }

  private async drainStartups(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => {
        resolve('expired')
      }, STARTUP_DRAIN_MS)
    })
    while (this.startupWork.size > 0) {
      const result = await Promise.race([Promise.allSettled([...this.startupWork]), deadline])
      if (result === 'expired') break
    }
    clearTimeout(timer)
  }

  private startedInfo(conversation: ActiveConversation): StartedConversation {
    return {
      conversationId: conversation.conversationId,
      participants: [...conversation.participants.keys()],
      profileId: conversation.profile.id,
      projectId: conversation.projectId,
      cwd: conversation.cwd,
      title: conversation.title,
    }
  }

  private startingSession(starting: StartingConversation): {
    conversationId: string
    participants: AgentId[]
    profileId: string
    projectId: string
    cwd: string
    title: string
    unread: number
    pendingApprovalIds: string[]
    pendingQuestionIds: string[]
    draft: string
    planning: boolean
    starting: true
  } {
    return {
      conversationId: starting.conversationId,
      participants: [],
      profileId: starting.profile.id,
      projectId: starting.projectId,
      cwd: starting.cwd,
      title: starting.title,
      unread: 0,
      pendingApprovalIds: [],
      pendingQuestionIds: [],
      draft: starting.draft,
      planning: false,
      starting: true,
    }
  }

  /**
   * Logs the user's message **once**, then routes it.
   *
   * Logging inside each participant would make the transcript show the user
   * repeating themselves once per agent.
   */
  async send(
    conversationId: string,
    text: string,
    intent?: 'go' | 'collaborate',
    mode: LiveMessageMode = 'auto'
  ): Promise<SendResult> {
    if (this.closing) throw new Error(mainT('live.closed'))
    const conversation = this.require(conversationId)
    const stopEpoch = conversation.stopEpoch ?? 0
    /*
     * Addressable is the cast, not the live map, and the two differ exactly when
     * something went wrong.
     *
     * An agent whose CLI is missing, or whose key is not saved yet, fails to
     * start and is therefore absent from `participants` — so routing over that
     * map made `@deepseek` unparseable as a mention, which `parseMentions`
     * silently reads as "nobody named" and delivers to whoever spoke last. The
     * message went to the wrong agent and nothing said so.
     *
     * Naming one is a decision, and the answer to it belongs in the transcript
     * whichever way it goes. `ensureSeated` below either brings the agent in or
     * says why it cannot.
     *
     * **The live ones come first, and the order is load-bearing.** With nobody
     * named, `parseMentions` falls back to the head of this list — so a flat
     * `AGENT_IDS` would send every unaddressed message to whichever agent the
     * tuple happens to start with, including on a machine where that one is the
     * agent that will not run. Listing the live ones first keeps the fallback on
     * something that can answer, while a mention still reaches anybody.
     */
    const live = this.roster(conversation)
    const liveInRoutingOrder: AgentId[] =
      conversation.lastAddressed === undefined && live.includes('claude')
        ? ['claude', ...live.filter((id) => id !== 'claude')]
        : live
    const task = intent === 'go' ? text : originalCollaborationText(text)
    const team = intent !== 'go' && isTeamCommand(task)
    const pair =
      !team && (intent === 'collaborate' || task !== text) && !isExpandedCollaboration(task)
        ? collaborationPair(task, AGENT_IDS)
        : null
    const mentioned = parseMentions(task, {
      participants: [...liveInRoutingOrder, ...AGENT_IDS.filter((id) => !live.includes(id))],
      lastAddressed: conversation.lastAddressed,
    })
    const route = team
      ? { targets: [...AGENT_IDS], text: task }
      : pair === null
        ? mentioned
        : { ...mentioned, targets: [pair.leader] }

    if (route.targets.length === 0) throw new Error('No agent is available in this conversation')

    const agentStopEpochs = new Map(
      route.targets.map((id) => [id, conversation.agentStopEpochs?.get(id) ?? 0])
    )
    const wasWorking = route.targets.some((id) => conversation.working.has(id))

    const requestedAction = liveMessageAction(route.text, mode, wasWorking)
    const action =
      requestedAction === 'discussion' ||
      requestedAction === 'stopAndDiscuss' ||
      requestedAction === 'stop' ||
      mode === 'work'
        ? requestedAction
        : intent !== undefined || team || pair !== null
          ? 'guide'
          : requestedAction
    const discussion = action === 'discussion' || action === 'stopAndDiscuss'
    const liveText = liveMessageText(route.text)
    if ((action === 'ask' || action === 'guide' || action === 'discussion') && liveText === '') {
      throw new Error(mainT('live.empty'))
    }

    const stored = this.store.append({
      conversationId,
      actor: 'user',
      payload: {
        type: 'user.message',
        text: task,
        ...(action === 'guide' ? {} : { live: true }),
        ...(discussion || mode === 'discussion'
          ? { mode: 'discussion' as const }
          : mode === 'work'
            ? { mode: 'work' as const }
            : {}),
      },
    })
    // Null only once the store is closed, which means the app is quitting.
    // Delivering a message the log has no record of would be worse than not.
    if (stored === null) throw new Error('Chorus is shutting down')
    conversation.lastAddressed = route.targets.at(-1)
    if (action === 'guide' || action === 'stop') conversation.handoffEpoch += 1

    if (action === 'status') {
      const events = this.store.readPage(conversationId, {
        limit: 100,
        types: ['agent.message.completed', 'command.started', 'command.completed'],
      })
      const completedCommands = new Set(
        events.flatMap((event) =>
          event.payload.type === 'command.completed'
            ? [`${event.actor}:${event.payload.itemRef}`]
            : []
        )
      )
      for (const agentId of route.targets) {
        const participant = conversation.participants.get(agentId)
        const command = conversation.working.has(agentId)
          ? events.findLast(
              (event) =>
                event.actor === agentId &&
                event.payload.type === 'command.started' &&
                !completedCommands.has(`${agentId}:${event.payload.itemRef}`)
            )
          : undefined
        const status =
          participant === undefined
            ? mainT('live.notRunning', { agent: agentId })
            : participant.service.pendingApprovals().length > 0
              ? mainT('live.awaitingApproval', { agent: agentId })
              : participant.service.pendingQuestions().length > 0
                ? mainT('live.awaitingAnswer', { agent: agentId })
                : command?.payload.type === 'command.started'
                  ? mainT('live.command', {
                      agent: agentId,
                      command: command.payload.command.join(' ').slice(0, 400),
                    })
                  : mainT(conversation.working.has(agentId) ? 'live.working' : 'live.idle', {
                      agent: agentId,
                    })
        const latest = events.findLast(
          (event) =>
            event.actor === agentId &&
            event.payload.type === 'agent.message.completed' &&
            !isLiveReply(event.payload.itemRef)
        )
        const update =
          latest?.payload.type === 'agent.message.completed'
            ? latest.payload.text.slice(0, 800)
            : ''
        this.liveNotice(
          conversationId,
          update === '' ? status : `${status}\n\n${mainT('live.latest')}\n${update}`
        )
      }
      return { targets: route.targets }
    }
    if (action === 'stop') {
      const addressed = /^\s*@/.test(task)
      const targets = addressed ? route.targets : this.roster(conversation)
      this.liveNotice(conversationId, mainT('live.stopping', { agents: targets.join(', ') }))
      await this.interrupt(conversationId, addressed ? targets : undefined)
      return { targets }
    }

    if (discussion) {
      if (action === 'stopAndDiscuss') await this.interrupt(conversationId)
      if (this.active.get(conversationId) !== conversation) throw new Error(mainT('live.closed'))
      const readContext = (
        afterSeq = 0,
        recipient?: AgentId,
        options?: DiscussionContextOptions
      ): string => {
        const events = this.store.read(conversationId, { afterSeq }).filter((event) => {
          if (event.seq >= (options?.beforeSeq ?? stored.seq)) return false
          if (options?.excludeSeqs?.has(event.seq) === true) return false
          if (afterSeq === 0 || event.actor !== recipient) return true
          const payload = event.payload
          return !(
            (payload.type === 'agent.message.completed' && payload.mode === 'discussion') ||
            ('itemRef' in payload && isDiscussion(payload.itemRef))
          )
        })
        return (
          composeCatchup({
            recipient: recipient ?? AGENT_IDS[0],
            participants: this.roster(conversation),
            events,
            includeOwnDiscussion: true,
            includeOwnMessages: true,
            ...(options === undefined
              ? {}
              : { maxTotalBytes: options.maxTotalBytes, retrieval: options.retrieval }),
          }) ?? ''
        )
      }
      const participants = AGENT_IDS.flatMap((agentId) => {
        const adapter = this.adapters.get(agentId)
        if (adapter === undefined) return []
        return [
          {
            agentId,
            adapter,
            opts: discussionOpts(this.sessionOptsFor(conversation, agentId)),
          },
        ]
      })
      const targets = team ? route.targets.slice(0, 1) : route.targets
      for (const agentId of targets) {
        const participant = participants.find((candidate) => candidate.agentId === agentId)
        if (participant === undefined) {
          this.liveNotice(conversationId, mainT('live.discussionUnavailable', { agent: agentId }))
          continue
        }
        const question = team
          ? `Discuss this with the other discussion agents and combine their findings.\n\n${liveText.replace(/^\/team\s*/, '')}`
          : liveText === ''
            ? 'Discuss the current task.'
            : liveText
        this.liveReplies.ask({
          conversationId,
          ...participant,
          sourceId: stored.id,
          sessionRef: '',
          question,
          context: '',
          readNote: () => this.pinnedNote(conversationId),
          discussion: {
            participants,
            readContext,
            contextThroughSeq: stored.seq,
            readInitialContext: (options) =>
              this.continuationContext(
                conversationId,
                options?.beforeSeq ?? stored.seq,
                {
                  ...(options === undefined
                    ? {}
                    : { maxTotalBytes: options.maxTotalBytes, retrieval: options.retrieval }),
                },
                undefined,
                options?.excludeSeqs
              ),
            createService: (agent, store, onContextUsage) =>
              new ConversationService({
                store,
                conversationId,
                adapter: this.adapters.get(agent) ?? participant.adapter,
                profile: conversation.profile,
                grants: conversation.grants,
                ...(onContextUsage === undefined ? {} : { onContextUsage }),
                onApprovalQueued: (request) =>
                  this.onAttention?.({
                    reason: 'approval',
                    conversationId,
                    projectId: conversation.projectId,
                    title: conversation.title,
                    agentId: agent,
                    approvalId: request.id,
                    kind: request.kind,
                    request,
                  }),
                onQuestionQueued: (request) =>
                  this.onAttention?.({
                    reason: 'question',
                    conversationId,
                    projectId: conversation.projectId,
                    title: conversation.title,
                    agentId: agent,
                    userInputId: request.id,
                    request,
                  }),
              }),
          },
        })
      }
      return { targets }
    }

    /*
     * Logged before the delivery is awaited, and again after it returns.
     *
     * C-043 is open because a send that neither lands nor fails leaves the pane
     * waiting for a turn that never starts — and the log said nothing at all
     * about it, so the only evidence was a screenshot. `deliver` is awaited
     * below and an adapter that hangs there hangs this call, which hangs the
     * IPC, which is invisible from every side.
     *
     * A pair of lines makes that shape readable after the fact: `accepted`
     * without a matching `delivered` is a delivery that hung, and neither line
     * is a send that never reached main at all. Cheap, and only once per turn.
     */
    this.log.info('message accepted', { conversationId, targets: route.targets.join(',') })

    /*
     * Fired here and not awaited, so the naming runs alongside the turn instead
     * of in front of it. `route.text` rather than the logged text: the mentions
     * are addressing, not subject, and a namer told "@claude" every message
     * would be reading the routing as part of the topic.
     */
    if (action === 'guide') this.nameTopic(conversationId, liveText)

    await this.ensureSeated(conversation, route.targets)
    if (this.active.get(conversationId) !== conversation) throw new Error(mainT('live.closed'))
    if ((conversation.stopEpoch ?? 0) !== stopEpoch) return { targets: [] }
    const targets = route.targets.filter(
      (id) => (conversation.agentStopEpochs?.get(id) ?? 0) === agentStopEpochs.get(id)
    )

    /*
     * Who is in the room, read **after** seating and not before.
     *
     * This is the catch-up preamble's roster — it tells an agent whose voices it
     * is about to read in the transcript. `live` above cannot serve: it was taken
     * before `ensureSeated`, so an agent seated by this very message would be
     * missing from the list the others are handed.
     */
    const roster = this.roster(conversation)

    if (action === 'ask') {
      const events = this.store.readPage(conversationId, {
        limit: 300,
        types: [
          'user.message',
          'agent.message.completed',
          'command.started',
          'command.completed',
          'file.change.completed',
          'plan.updated',
          'approval.requested',
          'userinput.requested',
          'turn.started',
          'turn.completed',
          'notice.raised',
        ],
      })
      const context =
        composeCarryover([{ title: conversation.title, conversationId, events }], {
          maxTotalBytes: LIVE_QUESTION_CONTEXT_BYTES,
          retrieval: false,
          currentConversationId: conversationId,
        }) ?? ''
      for (const agentId of targets) {
        const participant = conversation.participants.get(agentId)
        const adapter = this.adapters.get(agentId)
        if (participant === undefined || adapter === undefined) continue
        this.liveReplies.ask({
          conversationId,
          agentId,
          sourceId: stored.id,
          adapter,
          sessionRef: participant.session.sessionRef,
          opts: {
            cwd: conversation.cwd,
            note: { read: () => this.conversationNotes.read(conversationId) },
          },
          question: liveText,
          context,
          readNote: () => this.pinnedNote(conversationId),
          onAnswered: (answer) => {
            if (this.active.get(conversationId)?.participants.get(agentId) !== participant) return
            const exchange = `A live question was already answered while you worked. Context only, not a new task.\nQuestion: ${liveText.slice(0, 4_000)}\nAnswer: ${answer.slice(0, 12_000)}`
            participant.seedContext = fitContextTail(
              `${participant.seedContext ?? ''}\n\n${exchange}`,
              8_000
            )
          },
        })
      }
      return { targets }
    }

    // Filtered rather than optional-chained: `Promise.all` over a list that can
    // contain `undefined` is a silent no-op waiting to happen.
    await Promise.all(
      targets
        .map((agentId) => conversation.participants.get(agentId))
        .filter((p) => p !== undefined)
        .map(async (p) => {
          /*
           * Read up to — not including — the message being delivered: that one
           * is the live turn, not history. Anything appended after this read
           * keeps a higher `seq` than the watermark below, so it is caught up
           * next time rather than lost.
           */

          /*
           * The seed goes before the user's words, once.
           *
           * It is context about what already happened, so it reads as
           * background rather than as an instruction — and it is dropped after
           * one delivery whether or not the turn succeeds, because a seed that
           * could arrive twice is worse than one that arrives late.
           */
          /*
           * What the agent reads, which is not always what the log kept.
           *
           * `route.text` is the typed message with its leading mentions removed.
           * An intent replaces it: the transcript keeps `@claude Go ahead.` — a
           * line the user would recognise as their own — and the agent receives
           * `goPrompt()`. The same split `sendUserMessage(text, delivered)` makes
           * for asides, for the reason stated there: logging the wrapper puts
           * words in the user's mouth in their own transcript.
           */
          const body =
            intent === 'go'
              ? goPrompt()
              : team
                ? teamIntroduction(roster, task)
                : pair === null
                  ? liveText
                  : collaborationPrompt(pair, task)
          p.dispatchEpoch = conversation.handoffEpoch
          p.origin = { eventId: stored.id, at: stored.createdAt }
          const recoveryText = withCallRule(roster, body)
          try {
            await p.service.deliver(recoveryText, recoveryText, {
              recoveryBeforeSeq: stored.seq,
              prepare: () => this.contextualMessage(conversation, p, body, stored.seq),
            })
          } catch (error) {
            p.deferredMessages?.seqs.delete(stored.seq)
            throw error
          }
        })
    )
    this.log.info('message delivered', { conversationId, targets: targets.join(',') })
    if (wasWorking && targets.length > 0) {
      this.liveNotice(conversationId, mainT('live.guided', { agents: targets.join(', ') }))
    }
    // Cheap, and it keeps the resume refs current if the app dies without a
    // clean quit.
    this.rememberOpen()
    return { targets }
  }

  private liveNotice(conversationId: string, text: string): void {
    this.store.append({
      conversationId,
      actor: 'system',
      payload: { type: 'notice.raised', source: 'system', level: 'info', text, detail: null },
    })
  }

  /**
   * Opens an aside: a fork of one agent, asked about one passage of one reply.
   *
   * Nothing here touches the parent. No `lastAddressed`, no `seenSeq`, no draft,
   * no `rememberOpen` — an aside is not a turn, and a conversation that
   * re-ordered its routing because someone asked a footnote would be exactly the
   * derailment this feature exists to avoid.
   *
   * **The source is re-resolved from the log, never trusted from the caller.**
   * The renderer sends an event id and the text it believes it selected; both
   * are checked against what the store actually holds. A caller that could name
   * any event and any excerpt could put words in an agent's mouth and have them
   * quoted back as its own.
   */
  async openAside(request: {
    conversationId: string
    sourceEventId: string
    excerpt: string
    purpose?: 'question' | 'explanation' | 'translation'
    question?: string
  }): Promise<{ asideId: string; language: string }> {
    if (!this.active.has(request.conversationId)) throw new Error('That conversation is not open')
    this.require(request.conversationId)
    const work = this.openAsideOwned(request)
    this.trackStartup(work, request.conversationId)
    return work
  }

  private async openAsideOwned(request: {
    conversationId: string
    sourceEventId: string
    excerpt: string
    /**
     * Why it is being opened, and therefore what the fork is first asked.
     *
     * `explanation` carries its own first turn: there is nothing for the user to
     * type, so opening and asking are one act. `question` opens empty and waits.
     * `translation` and `recap` behave as `explanation` does here.
     */
    purpose?: 'question' | 'explanation' | 'translation'
    /**
     * Optional, and usually absent.
     *
     * The card opens this the moment it appears, before the user has typed
     * anything, so the CLI is spawning and loading its config while they write
     * the question rather than afterwards. Measured, that is about 2.6 of the
     * 4.2 seconds — two thirds of the wait was a process starting, not an agent
     * thinking. Asking without a question is what lets that happen in parallel.
     */
    question?: string
  }): Promise<{ asideId: string; language: string }> {
    const parent = this.require(request.conversationId)

    const source = this.store
      .read(request.conversationId)
      .find((e) => e.id === request.sourceEventId)
    if (source === undefined) throw new Error('That passage is no longer in the log')

    /*
     * A finished agent message, or a question the agent is blocked on.
     *
     * The first was the only case for a long time, and the reason is unchanged:
     * a fork inherits the session *as persisted*, so it cannot see a turn still
     * in flight — asked about a reply that is still arriving it answers that no
     * such reply exists. Measured, not assumed: see the plan's STATUS.
     *
     * A question set is safe by the same test and was excluded only because
     * nothing asked. It is already durable when the card appears — the card is
     * drawn *from* the logged event — so there is no in-flight window at all,
     * which is a stronger position than a reply's.
     *
     * `said` is re-derived here from the logged payload rather than taken from
     * the request. That is what keeps the guard below meaning what it says: the
     * renderer supplies an excerpt and main supplies the text it must be found
     * in, so a caller that could name any event still cannot put words in an
     * agent's mouth. `questionSetText` is the same projection the card renders
     * with, so the two cannot drift apart into questions nobody can ask about.
     */
    const said =
      source.payload.type === 'agent.message.completed'
        ? source.payload.text
        : source.payload.type === 'userinput.requested'
          ? questionSetText(source.payload.request)
          : null
    if (said === null) {
      throw new Error('An aside can only be asked about a finished reply or a question')
    }
    const excerpt = request.excerpt.trim()
    /*
     * Checked against the reply as the transcript reads, not as the log stores
     * it — `containsPassage` carries both the projection and why the comparison
     * ignores serialization-only spacing, measured against the running app.
     *
     * The guard stays what it was for: the renderer is the least trustworthy
     * thing in the process tree, and a caller that could name any event and any
     * excerpt could put words in an agent's mouth and have them quoted back as
     * its own.
     */
    if (!containsPassage({ said, excerpt })) {
      throw new Error('That passage is not part of that reply')
    }

    const agentId = source.actor
    if (!isAgentId(agentId)) {
      throw new Error('Only an agent can be asked about what it said')
    }
    if (!this.roster(parent).includes(agentId)) {
      throw new Error(`${agentId} is no longer in this conversation`)
    }

    const adapter = this.adapters.get(agentId)
    if (adapter?.fork === undefined) throw new Error(`${agentId} cannot be forked`)
    const participant = await this.seat(parent, agentId)
    if (this.active.get(request.conversationId) !== parent) {
      throw new Error('That conversation is not open')
    }
    const sessionRef = participant.session.sessionRef
    if (sessionRef === '') {
      throw new Error(`${agentId} has not started a session yet`)
    }

    /*
     * The passage must belong to the session about to be forked.
     *
     * Source authenticity says the reply is genuinely that agent's; it says
     * nothing about *which* of its sessions said it. An agent taken out of a
     * conversation and brought back gets a new session, and forking that one to
     * ask about a reply from the old one produces an agent politely explaining
     * something it has never seen — the same failure as forking mid-turn, and
     * just as hard to recognise as a bug rather than a bad answer.
     *
     * The check is the log's own: the last `session.started` for this agent at
     * or before the reply must name the ref the participant is running now.
     */
    /*
     * Only a session the agent *started afresh* can have missed the passage.
     *
     * Reopening a conversation writes a new `session.started` too, and the first
     * version of this refused on any newer start at all — so the option
     * disappeared after every relaunch, which is most of the time. A resume
     * rejoins the same provider session and holds the same context; it is
     * `addParticipant` that produces one which has never seen the reply.
     *
     * Compared by *event*, not by `sessionRef`. Claude's real id arrives with
     * its first message, so `session.started` is written with an empty string —
     * an earlier attempt skipped empty refs and therefore never fired for Claude
     * at all, the provider it most needed to fire for.
     *
     * `resumed` absent means an event written before the flag existed, and those
     * are treated as resumes. The two ways of being wrong are not equal: refusing
     * wrongly takes the feature away, while allowing wrongly is the behaviour
     * that existed before this guard did.
     */
    const freshStartAfter = this.store
      .read(request.conversationId)
      .find(
        (e) =>
          e.seq > source.seq &&
          e.payload.type === 'session.started' &&
          e.payload.agentId === agentId &&
          e.payload.resumed === false
      )
    if (freshStartAfter !== undefined) {
      throw new Error(`${agentId} has started a new session since it said that`)
    }

    /*
     * The language is read here, and read **before** anything is spawned.
     *
     * Not accepted from the caller: the renderer already has its source event
     * re-resolved because it renders untrusted agent output, and a language
     * string is prompt content — the same class of problem wearing a smaller
     * word. And checked first, because a refusal after the fork leaves a CLI
     * running that nobody has a handle to.
     */
    const purpose = request.purpose ?? 'question'
    /*
     * Both language-bearing purposes read the same setting, and read it here.
     *
     * They use it differently — an explanation is written *in* it however the
     * user qualified it, a translation takes the language and renders its
     * standard form — but that distinction belongs in the prompts, not in which
     * value is fetched. One field, one read, two documented readings.
     */
    const needsLanguage = purpose === 'explanation' || purpose === 'translation'
    const language = needsLanguage ? readSettings(this.userDataPath).explainLanguage : ''
    if (needsLanguage && language === '') {
      throw new Error(
        purpose === 'translation'
          ? 'No language is set to translate into'
          : 'No language is set to explain in'
      )
    }

    const reader = this.projectReaderFor(parent.projectId)
    const opts: SessionOpts = {
      cwd: parent.cwd,
      sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
      ...(reader === undefined ? {} : { project: reader }),
    }
    const forked = await adapter.fork(sessionRef, {
      ...opts,
      // Decided with the user: the aside inherits the user's configuration,
      // so hooks, skills and CLAUDE.md load exactly as they do in the room.
      inherits: 'config',
    })

    const asideId = newConversationId()

    /*
     * Everything past the fork is wrapped, because everything past the fork can
     * fail with a provider process already running.
     *
     * Appending, attaching, the health check and the first send each have their
     * own way of going wrong, and any of them leaving a live CLI behind is a
     * leak nobody has a handle to — the caller never learns an id, so it cannot
     * close what it does not know about. The send is the sharp one: it happens
     * after the service is already in `this.asides`, so failing there strands an
     * entry as well as a process.
     */
    try {
      this.require(request.conversationId)
      this.store.append({
        conversationId: asideId,
        actor: 'user',
        payload: {
          type: 'conversation.created',
          projectId: parent.cwd,
          title: excerpt.slice(0, 80),
          aside: {
            parentId: request.conversationId,
            sourceEventId: request.sourceEventId,
            purpose,
            // The language as it was, not as it will be. Settings change.
            ...(language === '' ? {} : { language }),
          },
        },
      })

      const service = new ConversationService({
        store: this.store,
        conversationId: asideId,
        adapter,
        profile: profileById('read-only'),
        /*
         * Its own grants, deliberately empty — **not** the parent's.
         *
         * A grant outranks an `ask` and an aside never asks, so carrying them
         * would mean a previously allowed `npm publish`, or a granted MCP tool
         * that posts outward, running silently inside a fork nobody is watching.
         * Claude's sandbox is emulated, so nothing below would have stopped it.
         *
         * Little is lost. Grants exist to stop the user being re-asked, and an
         * aside does not ask; what they would add here is the power to act,
         * which is the one thing an explanation must not have. `SAFE_READS`
         * still lets it go and look. The user's *configuration* is a separate
         * thing and still inherited in full — see `ForkOpts.inherits`.
         */
        grants: new SessionGrants(),
        neverAsks: true,
      })
      await service.attach(forked, opts, await adapter.health())

      /*
       * `language` is held for the follow-ups, not for the first turn.
       *
       * The opening prompt names it and then the card stays open for as long as
       * the conversation in it lasts; without this, question two came back in
       * English. Empty for a question or a recap, which name no language.
       */
      this.require(request.conversationId)
      this.asides.set(asideId, {
        service,
        parentId: request.conversationId,
        excerpt,
        agentId,
        language,
      })

      try {
        if (purpose === 'explanation') {
          await service.sendUserMessage(
            `Explain this in ${language}.`,
            explainPrompt(excerpt, language)
          )
        } else if (purpose === 'translation') {
          // Two arguments, as above: the log keeps the short line, the model
          // gets the prompt. What is read back later should be what was asked
          // for, not the instructions that carried it.
          await service.sendUserMessage(
            `Translate this into ${language}.`,
            translatePrompt(excerpt, language)
          )
        } else if (request.question !== undefined && request.question !== '') {
          await service.sendUserMessage(request.question, asideQuestion(excerpt, request.question))
        }
      } catch (error) {
        await this.closeOwned(request.conversationId, service, () => service.close('closed'))
        this.asides.delete(asideId)
        throw error
      }

      return { asideId, language }
    } catch (error) {
      // The fork is ours until an id is handed back. Nobody else can close it.
      await this.closeOwned(request.conversationId, forked, () => forked.close())
      throw error
    }
  }

  /** A follow-up in an aside that is still alive. */
  async askAside(asideId: string, question: string): Promise<void> {
    const aside = this.asides.get(asideId)
    if (aside === undefined) {
      // Its fork was ephemeral and is gone. The transcript survives in the log;
      // continuing it does not, which is why a reopened aside is view-only.
      throw new Error('That aside has ended — ask again to start a new one')
    }
    await aside.service.sendUserMessage(
      question,
      asideQuestion(aside.excerpt, question, aside.language)
    )
  }

  /**
   * Explain or translate what the aside itself just said.
   *
   * A follow-up in the same fork, not a second aside, and that is the design
   * rather than a shortcut. Forking again would be the honest analogue of the
   * transcript's button, but the card is one floating panel: a nested aside
   * would have to replace the one being read, which throws away the answer the
   * person was in the middle of not understanding. A follow-up leaves the
   * exchange intact and appends to it, which is what the card is already for.
   *
   * **The subject is the aside's own latest answer, and it is read from the log
   * rather than taken from the renderer.** "I did not follow *that*" means the
   * thing on screen, not the passage this aside was opened about — an
   * explanation of the original excerpt is what the person already has. Reading
   * it here also keeps `askAside`'s trust model from having to widen: nothing
   * new is accepted from the renderer but the id and which of two things to do.
   *
   * No language, no action — the same rule `openAside` applies, restated
   * because an aside opened as a plain question carries no language at all and
   * would otherwise compose a prompt asking for a translation into nothing.
   */
  async restateAside(asideId: string, purpose: 'explanation' | 'translation'): Promise<void> {
    const aside = this.asides.get(asideId)
    if (aside === undefined) {
      throw new Error('That aside has ended — ask again to start a new one')
    }

    const language =
      aside.language === '' ? readSettings(this.userDataPath).explainLanguage : aside.language
    if (language === '') {
      throw new Error(
        purpose === 'translation'
          ? 'No language is set to translate into'
          : 'No language is set to explain in'
      )
    }

    /*
     * The last thing the agent finished saying in this aside.
     *
     * `agent.message.completed` only: a turn still streaming would be explained
     * half-written, and the card offers these buttons once an answer has landed
     * anyway. Searching from the end because an aside can be several turns long
     * by the time someone gives up on one of them.
     */
    const said = this.store
      .read(asideId)
      .filter((e) => e.payload.type === 'agent.message.completed')
      .map((e) => (e.payload.type === 'agent.message.completed' ? e.payload.text : ''))
      .filter((text) => text.trim() !== '')
    const latest = said.at(-1)
    if (latest === undefined) throw new Error('That aside has not answered yet')

    await aside.service.sendUserMessage(
      // The log keeps the short line and the model gets the prompt, exactly as
      // `openAside` does it: what is read back later should be what was asked
      // for rather than the instructions that carried it.
      purpose === 'translation'
        ? `Translate this into ${language}.`
        : `Explain this in ${language}.`,
      purpose === 'translation'
        ? translatePrompt(latest, language)
        : explainPrompt(latest, language)
    )
  }

  /**
   * Sends a decision from an aside into the conversation the aside came from.
   *
   * Deliberately `this.send` rather than a path of its own, and that is the
   * whole design: the routing, the log entry, the catch-up watermark and the
   * mention handling are the ones a typed message already gets, so a forwarded
   * directive cannot drift from a typed one. It is not a new kind of event
   * either — the user really did author these words, so `user.message` is what
   * it is, and the provenance line in the text is what says where they were
   * written rather than a new payload type three switches would have to learn.
   *
   * **The parent is revalidated, not trusted from when the aside opened.** It
   * may have been closed, or had its last agent removed, in the minutes someone
   * spent reading the side answer — `promoteAside` revalidates for the same
   * reason and `send` would otherwise throw something about a missing
   * conversation, which is true and useless.
   *
   * The aside is left open. Forwarding is not promoting and not closing: having
   * decided to run the tests, the next thing you want is usually to ask the same
   * fork what it thought about the result.
   */
  async forwardAside(asideId: string, directive: string): Promise<SendResult> {
    const aside = this.asides.get(asideId)
    if (aside === undefined) {
      throw new Error('That aside has ended — ask again to start a new one')
    }
    if (this.active.get(aside.parentId) === undefined) {
      throw new Error('The conversation this came from is no longer open')
    }
    return this.send(aside.parentId, forwardedFromAside(directive, aside.excerpt))
  }

  /**
   * In flight promotions, so two clicks cannot make two permanent branches.
   *
   * Keyed by aside id and holding the promise rather than a boolean: a second
   * caller should get the same answer as the first, not a refusal and not a
   * second provider session on disk.
   */
  private readonly promoting = new Map<string, Promise<PromotedConversation>>()

  /**
   * Turns an aside into a conversation of its own.
   *
   * The aside stops being a tooltip and becomes a room: a pane, a profile, an
   * approval card, and a transcript that was already being kept. What it gains
   * is the ability to act — under permissions someone chose at this moment,
   * which is the explicit act that makes it safe.
   *
   * **The parent is forked, not the aside.** Both providers fork from disk and
   * an aside is deliberately never written there, so there is nothing of it to
   * fork. The parent is on disk, and forking it is what already gives an aside
   * its context — this one is simply kept.
   */
  async promoteAside(asideId: string, profileId: string): Promise<PromotedConversation> {
    const inFlight = this.promoting.get(asideId)
    if (inFlight !== undefined) return inFlight

    const aside = this.asides.get(asideId)
    if (aside === undefined) throw new Error('That aside has ended')
    const parent = this.require(aside.parentId)
    this.conversationProjects.set(asideId, parent.projectId)
    this.promotionParents.set(asideId, aside.parentId)
    const run = this.runPromotion(asideId, profileId)
      .then((result) => {
        this.promotionParents.delete(asideId)
        return result
      })
      .finally(() => {
        this.promoting.delete(asideId)
      })
    this.promoting.set(asideId, run)
    this.trackStartup(run, asideId)
    return run
  }

  private async runPromotion(asideId: string, profileId: string): Promise<PromotedConversation> {
    const aside = this.asides.get(asideId)
    if (aside === undefined) throw new Error('That aside has ended — ask again to start a new one')
    if (this.active.has(asideId)) throw new Error('That aside is already a conversation')

    /*
     * Not while it is still answering.
     *
     * Two services would otherwise write to one conversation — the ephemeral
     * fork finishing its turn and the promoted one starting — and the log would
     * interleave two agents' lifecycle events under a single id.
     */
    if (this.stillAnswering(asideId)) {
      throw new Error('Wait for the aside to finish answering, then open it as a conversation')
    }

    // Revalidated now, not trusted from when the aside was opened: the parent
    // may have been closed, the agent removed, or its session replaced since.
    if (!this.active.has(aside.parentId)) {
      throw new Error('The conversation this came from is no longer open')
    }
    const parent = this.require(aside.parentId)
    const { agentId } = aside
    if (!this.roster(parent).includes(agentId)) {
      throw new Error(`${agentId} is no longer in that conversation`)
    }
    const source = await this.seat(parent, agentId)
    if (this.active.get(aside.parentId) !== parent) {
      throw new Error('The conversation this came from is no longer open')
    }
    if (this.asides.get(asideId) !== aside) {
      throw new Error('That aside has ended — ask again to start a new one')
    }
    if (this.stillAnswering(asideId)) {
      throw new Error('Wait for the aside to finish answering, then open it as a conversation')
    }
    if (source.session.sessionRef === '') {
      throw new Error(`${agentId} has not started a session yet`)
    }

    const profile = profileById(profileId)
    const seed = this.asideSeed(asideId, aside.excerpt)

    /*
     * The ephemeral fork is closed *before* the persistent one is opened.
     *
     * Ordering, not tidiness: it is the only way one conversation cannot have
     * two live services. If the fork below fails the aside is gone — but its
     * transcript is in the log, and losing the ability to continue a side
     * question is a smaller failure than two writers appending to one thread.
     */
    await this.closeOwned(aside.parentId, aside.service, () => aside.service.close('closed'))
    this.asides.delete(asideId)

    const grants = this.newGrants()
    const where = { cwd: parent.cwd, profile, projectId: parent.projectId }
    let participant
    try {
      participant = await this.startParticipant(
        agentId,
        asideId,
        (resuming) => this.sessionOptsFor(where, agentId, resuming),
        profile,
        grants,
        undefined,
        false,
        source.session.sessionRef,
        () =>
          this.closingConversations.has(aside.parentId) ||
          this.active.get(aside.parentId) !== parent
      )
    } catch (error) {
      throw new Error(
        `Could not open this as a conversation: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }

    /*
     * The commit point. Everything above can fail and leave nothing but a
     * closed aside; from here the conversation exists.
     *
     * A failure to append is a failure to promote, so the branch just created is
     * closed rather than left running with nothing pointing at it — the same
     * reasoning as `openAside`'s cleanup.
     */
    try {
      this.require(aside.parentId)
      this.store.append({
        conversationId: asideId,
        actor: 'user',
        payload: {
          type: 'aside.promoted',
          parentId: aside.parentId,
          sourceEventId: '',
        },
      })
    } catch (error) {
      await this.closeOwned(asideId, participant.service, () => participant.service.close('closed'))
      throw error
    }

    participant.seedContext = seed
    // Its watermark starts at the end: everything before this is either the
    // aside's own transcript, which the fork does not need told back to it, or
    // the seed above.
    participant.seenSeq = this.store.lastSeq()

    const conversation: ActiveConversation = {
      conversationId: asideId,
      participants: new Map([[agentId, participant]]),
      dormant: new Map(),
      grants,
      profile,
      projectId: parent.projectId,
      cwd: parent.cwd,
      title: aside.excerpt.slice(0, 80),
      lastAddressed: agentId,
      handoffEpoch: 0,
      working: new Set(),
      lastSeenSeq: 0,
      draft: '',
      planning: false,
      /*
       * Never on for an aside, whatever the default says.
       *
       * An aside is already told how to write: `explainPrompt` and
       * `translatePrompt` name a language and hold `KEEP_IN_ENGLISH`. Adding the
       * standing instruction on top gives one context two rules about wording,
       * and the one that loses is the card's own — which is the only reason the
       * card exists.
       */
      styleOn: false,
    }
    this.active.set(asideId, conversation)
    this.rememberOpen()
    this.onConversations?.()
    this.log.info('aside promoted', { asideId, parentId: aside.parentId, agentId, profileId })
    return {
      conversationId: asideId,
      participants: [agentId],
      profileId: profile.id,
      projectId: conversation.projectId,
      cwd: conversation.cwd,
      title: conversation.title,
      unread: 0,
    }
  }

  /**
   * Whether a conversation has a turn still in flight.
   *
   * Read off the log rather than asked of the service, which tracks no such
   * state — and the log is the thing that would be corrupted by a second writer,
   * so it is the right place to ask.
   */
  private stillAnswering(conversationId: string): boolean {
    let open = 0
    for (const event of this.store.read(conversationId)) {
      if (event.payload.type === 'turn.started') open += 1
      if (event.payload.type === 'turn.completed') open -= 1
    }
    return open > 0
  }

  /**
   * What the promoted room is told about where it came from.
   *
   * Its own transcript, framed as already handled. The fork it is built on has
   * the *work's* context but not the aside's — that conversation happened in a
   * branch this one is not descended from — so without this the room would not
   * know the question it was opened to continue.
   */
  private asideSeed(asideId: string, excerpt: string): string {
    const said = this.store
      .read(asideId)
      .flatMap((e) => (e.payload.type === 'agent.message.completed' ? [e.payload.text] : []))
      .join('\n\n')
      .trim()

    const quote = (text: string): string =>
      text
        .split('\n')
        .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
        .join('\n')

    return [
      'For context, this conversation began as a side question about a passage you',
      'had written. That exchange has already happened — you do not need to answer',
      'it again.',
      '',
      'The passage:',
      quote(excerpt),
      ...(said === '' ? [] : ['', 'What you said about it:', quote(said)]),
      '',
      'You are now in an ordinary conversation and may act on what is asked next.',
    ].join('\n')
  }

  /**
   * Holds a question's deadline off while someone is answering it.
   *
   * Asked of every participant rather than routed by agent: a `userInputId`
   * belongs to whichever service raised it, and the caller — a card — knows the
   * question but not which agent's queue it is sitting in. The first service
   * that recognises it answers; the rest return null, which is what "not mine"
   * means here.
   */

  /** Ends an aside's fork. Its transcript stays in the log. */
  async closeAside(asideId: string): Promise<void> {
    const aside = this.asides.get(asideId)
    if (aside === undefined) return
    await this.closeOwned(aside.parentId, aside.service, () => aside.service.close('closed'))
    this.asides.delete(asideId)
  }

  /** The asides taken on a conversation, or on one reply within it. */
  listAsides(conversationId: string, sourceEventId?: string): AsideSummary[] {
    return this.store.listAsides(conversationId, sourceEventId)
  }

  private followHandoffs(events: readonly StoredEvent[]): void {
    const settled = new Map<string, AgentId>()
    for (const event of events) {
      const { payload } = event
      if (payload.type === 'session.ended') {
        this.active.get(event.conversationId)?.working.delete(payload.agentId)
        continue
      }
      const from = event.actor
      if (!isAgentId(from)) continue
      const conversation = this.active.get(event.conversationId)
      if (conversation === undefined) continue
      if (payload.type === 'agent.message.completed' && payload.text.trim() !== '')
        conversation.lastAddressed = from
      const participant = conversation.participants.get(from)
      if (participant === undefined) continue
      if (payload.type === 'turn.started') {
        delete participant.lastReply
        conversation.working.add(from)
      } else if (payload.type === 'agent.message.completed') {
        if (isLiveReply(payload.itemRef)) continue
        participant.lastReply = { eventId: event.id, text: payload.text }
      } else if (payload.type === 'turn.completed') {
        conversation.working.delete(from)
        const reply = participant.lastReply
        delete participant.lastReply
        if (payload.status !== 'completed') continue
        const handoff = reply === undefined ? null : findReplyHandoff(reply.text, from, AGENT_IDS)
        if (reply !== undefined && handoff !== null) {
          const handoffId = newHandoffId()
          if (participant.dispatchEpoch === conversation.handoffEpoch) {
            const epoch = conversation.handoffEpoch
            queueMicrotask(() => {
              void this.handOffOnward(conversation, from, reply, handoff, handoffId, epoch)
            })
            continue
          }
          this.recordHandoffOutcome(event.conversationId, {
            handoffId,
            from,
            to: handoff.to,
            sourceEventIds: [reply.eventId],
            outcome: 'cancelled',
          })
        }
        settled.set(event.conversationId, from)
      }
    }

    for (const [conversationId, agentId] of settled) {
      const conversation = this.active.get(conversationId)
      if (conversation === undefined) continue
      this.settleTask(conversation)
      this.announceIdle(conversation, agentId)
    }
  }

  private announceIdle(conversation: ActiveConversation, agentId: AgentId): void {
    if (this.active.get(conversation.conversationId) !== conversation) return
    if (conversation.working.size > 0) return
    if (this.asides.has(conversation.conversationId)) return
    this.onAttention?.({
      reason: 'idle',
      conversationId: conversation.conversationId,
      projectId: conversation.projectId,
      title: conversation.title,
      agentId,
    })
  }

  private async handOffOnward(
    conversation: ActiveConversation,
    from: AgentId,
    reply: { readonly eventId: string; readonly text: string },
    handoff: ReplyHandoff,
    handoffId: string,
    epoch: number
  ): Promise<void> {
    const { conversationId } = conversation

    let attempted: Participant | undefined
    const owned = (): boolean =>
      conversation.handoffEpoch === epoch &&
      this.active.get(conversationId) === conversation &&
      (attempted === undefined || conversation.participants.get(handoff.to) === attempted)
    let recorded = false
    const settle = (outcome: HandoffOutcome['outcome']): void => {
      if (recorded) return
      recorded = true
      this.recordHandoffOutcome(conversationId, {
        handoffId,
        from,
        to: handoff.to,
        sourceEventIds: [reply.eventId],
        outcome,
      })
    }
    let created = false
    if (!owned()) {
      settle('cancelled')
      return
    }
    try {
      await this.ensureSeated(conversation, [handoff.to])
      const target = conversation.participants.get(handoff.to)
      if (target === undefined) {
        settle(owned() ? 'unavailable' : 'cancelled')
        this.announceIdle(conversation, from)
        return
      }
      if (!owned()) {
        settle('cancelled')
        return
      }
      attempted = target

      const stored = this.store.append({
        conversationId,
        actor: from,
        payload: {
          type: 'handoff.created',
          handoffId,
          from,
          to: handoff.to,
          sourceEventIds: [reply.eventId],
          brief: handoff.prompt,
        },
      })
      if (stored === null) return
      created = true
      conversation.lastAddressed = handoff.to
      target.dispatchEpoch = epoch
      const origin = conversation.participants.get(from)?.origin
      if (origin !== undefined) target.origin = origin

      const original = this.store.read(conversationId).find((event) => event.id === reply.eventId)
      const callingReply =
        original?.payload.type === 'agent.message.completed'
          ? { ...original, payload: { ...original.payload, text: handoff.above } }
          : undefined
      const recoveryText = withCatchup(
        { recipient: handoff.to, participants: this.roster(conversation), events: [] },
        handoff.prompt,
        from
      )
      try {
        await target.service.deliver(recoveryText, recoveryText, {
          recoveryBeforeSeq: stored.seq,
          prepare: () =>
            this.contextualMessage(
              conversation,
              target,
              handoff.prompt,
              stored.seq,
              from,
              callingReply
            ),
        })
      } catch (error) {
        target.deferredMessages?.seqs.delete(stored.seq)
        throw error
      }
      settle(owned() ? 'submitted' : 'cancelled')
    } catch (error) {
      settle(owned() ? (created ? 'failed' : 'unavailable') : 'cancelled')
      this.announceIdle(conversation, from)
      const message = error instanceof Error ? error.message : String(error)
      this.log.error('a hand-off could not be delivered', undefined, {
        conversationId,
        from,
        to: handoff.to,
        message,
      })
      this.store.append({
        conversationId,
        actor: 'system',
        payload: { type: 'error.raised', message: `${handoff.to}: ${message}`, recoverable: true },
      })
    }
  }

  private recordHandoffOutcome(
    conversationId: string,
    outcome: Omit<HandoffOutcome, 'type'>
  ): void {
    this.store.append({
      conversationId,
      actor: 'system',
      payload: { type: 'handoff.outcome', ...outcome },
    })
  }

  closeConversation(conversationId: string): Promise<void> {
    const pending = this.conversationClosures.get(conversationId)
    if (pending !== undefined) return pending
    this.closingConversations.add(conversationId)
    const work = this.finishCloseConversation(conversationId).finally(() => {
      this.conversationClosures.delete(conversationId)
    })
    this.conversationClosures.set(conversationId, work)
    return work
  }

  private async finishCloseConversation(conversationId: string): Promise<void> {
    const starting = this.starting.get(conversationId)
    if (starting !== undefined) this.cancelStarting(starting)
    const conversation = this.active.get(conversationId)
    const orphans = [...this.asides].filter(([, aside]) => aside.parentId === conversationId)
    const cleanup = [
      ...[...this.promotionParents]
        .filter(([, parentId]) => parentId === conversationId)
        .map(([id]) => this.closeConversation(id)),
      this.disposeNamer(conversationId),
      this.liveReplies.cancel(conversationId),
      this.terminals.stopSession(conversationId),
      ...[...(this.pendingParticipants.get(conversationId) ?? [])].map((participant) =>
        this.closeOwned(conversationId, participant.service, () => participant.service.close())
      ),
      ...[...(conversation?.participants.values() ?? [])].map((participant) =>
        this.closeOwned(conversationId, participant.service, () => participant.service.close())
      ),
      ...orphans.map(([, aside]) =>
        this.closeOwned(conversationId, aside.service, () => aside.service.close())
      ),
    ]
    await this.settleClosures(
      [
        ...cleanup,
        this.drainConversationStarts(conversationId).then(async () => {
          await this.settleClosures(
            [...(this.cleanupOwners.get(conversationId)?.values() ?? [])].map((close) => close()),
            'Some agent processes could not be confirmed stopped'
          )
        }),
      ],
      'Chat shutdown could not be confirmed'
    )
    const projectId = conversation?.projectId ?? this.conversationProjects.get(conversationId)
    if (projectId !== undefined && this.closingProjects.has(projectId)) return
    const noteFailure = this.forgetConversationNote(conversationId)
    if (noteFailure !== undefined) throw noteFailure
    this.finishConversationRemoval(conversationId)
  }

  private finishConversationRemoval(conversationId: string): void {
    this.active.delete(conversationId)
    this.failedStarts.delete(conversationId)
    this.conversationProjects.delete(conversationId)
    this.promotionParents.delete(conversationId)
    for (const [id, aside] of this.asides) {
      if (aside.parentId === conversationId) this.asides.delete(id)
    }
    for (const key of this.contextWindows.keys()) {
      if (key.startsWith(`${conversationId}:`)) this.contextWindows.delete(key)
    }
    this.closingConversations.delete(conversationId)
    this.rememberOpen()
    this.onConversations?.()
    this.log.info('conversation closed; owned processes exited', {
      conversationId,
      remaining: this.active.size,
    })
  }

  closeProject(projectId: string, editorCleanup?: () => Promise<void>): Promise<void> {
    const pending = this.projectClosures.get(projectId)
    if (pending !== undefined) return pending
    if (this.closedProjects.has(projectId)) return Promise.resolve()
    this.closingProjects.add(projectId)
    const work = this.finishCloseProject(projectId, editorCleanup).finally(() => {
      this.projectClosures.delete(projectId)
    })
    this.projectClosures.set(projectId, work)
    return work
  }

  private async finishCloseProject(
    projectId: string,
    editorCleanup?: () => Promise<void>
  ): Promise<void> {
    this.traffic.suspend(projectId)
    const conversations = new Set([
      ...[...this.conversationProjects]
        .filter(([, owner]) => owner === projectId)
        .map(([id]) => id),
      ...[...this.active.values()]
        .filter((conversation) => conversation.projectId === projectId)
        .map((conversation) => conversation.conversationId),
      ...[...this.starting.values()]
        .filter((conversation) => conversation.projectId === projectId)
        .map((conversation) => conversation.conversationId),
    ])
    const logcat = this.logcat.stopConfirmed(projectId)
    await this.settleClosures(
      [
        ...[...conversations].map((id) => this.closeConversation(id)),
        logcat,
        Promise.resolve().then(() => editorCleanup?.()),
        this.runner.suspend(projectId).then(async () => {
          await this.terminals.stopProject(projectId)
          this.runner.releaseStopped(projectId)
          await this.traffic.dispose(projectId)
        }),
      ],
      'Project shutdown could not be confirmed'
    )
    await this.adbReverse.syncConfirmed(this.traffic.capturingPorts())
    this.ports.editor.refreshTerminalEnv()
    for (const id of conversations) this.finishConversationRemoval(id)
    this.browserConsoles?.dispose(projectId)
    this.closingProjects.delete(projectId)
    this.closedProjects.add(projectId)
    this.log.info('project work stopped; owned processes exited', { projectId })
  }

  openProject(projectId: string): void {
    if (this.closing) throw new Error('Chorus is shutting down')
    if (this.closingProjects.has(projectId))
      throw new Error('This project is closing; retry its close action before reopening it')
    this.ports.editor.reopenProject(this.projects.workbenchTarget(projectId))
    this.closedProjects.delete(projectId)
    this.runner.allowProject(projectId)
    this.terminals.allowProject(projectId)
    this.traffic.allowProject(projectId)
  }

  /**
   * Reopens what was on screen last time.
   *
   * Called once at startup. A conversation whose directory has since been
   * deleted is dropped rather than failing the restore — the others are still
   * worth having, and the log keeps the one that could not come back.
   */
  async restoreOpenConversations(): Promise<RestoredConversations> {
    /* Single-flight: the second concurrent caller waits on the first rather than
       starting a duplicate set of agents. See `restoring`. */
    this.restoring ??= this.runRestore().finally(() => {
      this.restoring = null
    })
    return this.restoring
  }

  private async runRestore(): Promise<RestoredConversations> {
    /*
     * Restore still runs under the profiling flag, and an earlier version of
     * this returning `{ sessions: [] }` was wrong in a way that made the whole
     * mode useless: `App.tsx` renders `<div className="empty" aria-busy>` while
     * there are no sessions, so the window stayed permanently blank and there
     * was no route to a transcript at all — the one thing the mode exists to
     * show. Reopening is not what starts an agent; `startParticipant` is, and
     * that is where the guard belongs.
     */
    const savedState = this.ports.openProjects?.read() ?? readOpenProjects(this.userDataPath)
    const saved = openConversations(savedState)
    this.workspaceSnapshot = savedState.workspace
    const restored: {
      conversationId: string
      participants: AgentId[]
      profileId: string
      projectId: string
      cwd: string
      title: string
      unread: number
      pendingApprovalIds: string[]
      pendingQuestionIds: string[]
      draft: string
      planning: boolean
    }[] = []

    for (const { projectId, conversation: entry } of saved) {
      // Already open: restore is called once, but calling it twice must not
      // start a second set of agents for the same conversation.
      const open = this.active.get(entry.conversationId)
      if (open !== undefined) {
        restored.push({
          conversationId: entry.conversationId,
          participants: this.roster(open),
          profileId: open.profile.id,
          projectId: open.projectId,
          cwd: open.cwd,
          title: open.title,
          unread: this.unreadSince(entry.conversationId, open.lastSeenSeq),
          ...this.pendingDecisions(entry.conversationId),
          draft: open.draft,
          planning: open.planning,
        })
        continue
      }
      /*
       * The registry answers what `describeDirectory` used to. Both refusals it
       * can raise mean the same thing here — this conversation has nowhere to
       * open — but they are logged apart because only one of them is the
       * person's problem: a project they removed is expected, a project whose
       * folder vanished is something they may want to relocate.
       */
      try {
        this.projects.resolveAgentCwd(projectId)
      } catch (error) {
        this.log.warn('a session could not be reopened', {
          conversationId: entry.conversationId,
          projectId,
          reason: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      const conversation = await this.reopen(projectId, entry, this.deferRestoredAgents)
      if (conversation === null) continue
      restored.push({
        conversationId: entry.conversationId,
        participants: this.roster(conversation),
        profileId: conversation.profile.id,
        projectId: conversation.projectId,
        cwd: conversation.cwd,
        title: conversation.title,
        unread: this.unreadSince(entry.conversationId, entry.lastSeenSeq),
        ...this.pendingDecisions(entry.conversationId),
        draft: entry.draft,
        // Never restored: a mode is a property of a running session, and a
        // relaunch is a new one.
        planning: false,
      })
    }

    this.rememberOpen()
    if (restored.length > 0) this.log.info('sessions reopened', { count: restored.length })
    return { sessions: restored, workspace: this.workspaceSnapshot }
  }

  private reopen(
    projectId: string,
    entry: OpenConversation,
    deferAgents = false
  ): Promise<ActiveConversation | null> {
    const work = this.reopenOwned(projectId, entry, deferAgents).finally(() => {
      this.pendingParticipants.delete(entry.conversationId)
    })
    this.trackStartup(work, entry.conversationId)
    return work
  }

  private async reopenOwned(
    projectId: string,
    entry: OpenConversation,
    deferAgents = false
  ): Promise<ActiveConversation | null> {
    if (this.closing) return null
    this.openProject(projectId)
    if (this.closingConversations.has(entry.conversationId))
      throw new Error('This chat is still closing')
    this.terminals.allowSession(entry.conversationId)
    this.conversationProjects.set(entry.conversationId, projectId)
    const pending = new Set<Participant>()
    this.pendingParticipants.set(entry.conversationId, pending)
    const remembered = profileById(entry.profileId)
    const profile = profileById(this.projects.get(projectId)?.profileId ?? remembered.id)
    if (profile.id !== remembered.id && !readOnlyProfiling()) {
      this.store.append({
        conversationId: entry.conversationId,
        actor: 'system',
        payload: {
          type: 'policy.changed',
          profileId: profile.id,
          previousProfileId: remembered.id,
        },
      })
    }
    const grants = this.newGrants()
    /*
     * Resolved from the registry rather than read out of the file, which is the
     * whole reason the file no longer stores it. A root recorded at quit and
     * replayed at launch is a stale copy the moment the project moves; asking the
     * registry means a relocated project reopens where it now is.
     */
    const conversation: ActiveConversation = {
      conversationId: entry.conversationId,
      participants: new Map(),
      dormant: new Map(),
      grants,
      profile,
      projectId,
      cwd: this.projects.resolveAgentCwd(projectId),
      title: entry.title,
      lastAddressed: undefined,
      lastSeenSeq: entry.lastSeenSeq,
      handoffEpoch: 0,
      working: new Set(),
      draft: entry.draft,
      planning: false,
      styleOn: this.defaultStyleOn(),
    }
    if (deferAgents) {
      const restoredSeq = this.store.lastSeq()
      for (const agentId of AGENT_IDS) {
        const saved = entry.sessionRefs[agentId]
        conversation.dormant.set(agentId, {
          ref: saved === undefined || saved.trim() === '' ? undefined : saved,
          known: entry.agents.includes(agentId),
          seenSeq: restoredSeq,
          carry: undefined,
        })
      }
      this.reseedCarriedContext(conversation)
      this.active.set(entry.conversationId, conversation)
      this.onConversations?.()
      return conversation
    }
    /*
     * The whole cast, not the cast this conversation was saved with.
     *
     * This is where a room opened before DeepSeek existed — or before it was
     * seated by anything reachable — gets it. `entry.agents` is still read, one
     * line down, for the only question it can still answer: whether a given
     * agent is somebody this conversation already had. That decides the
     * announcement, because "deepseek joined" is true of an arrival and false of
     * a relaunch, and putting the line on every reopen is the noise the
     * `resumed` flag exists to suppress.
     */
    const started = await Promise.allSettled(
      AGENT_IDS.map(async (agentId) => {
        const arriving = !entry.agents.includes(agentId)
        /*
         * Resolved inside the loop, and left undecided about resuming.
         *
         * One object outside it meant every agent got the same model. Deciding
         * "this is a resume" out here was the second half of the same mistake:
         * an agent with no saved thread, or one whose resume fails, is started
         * fresh from this path and must get the configured model. Only
         * `startParticipant` knows which happened, so it asks.
         */
        const sessionOpts = (resuming: boolean): SessionOpts =>
          this.sessionOptsFor(conversation, agentId, resuming)
        /*
         * An empty ref is not a thread.
         *
         * Claude's session id only arrives with its first message, so an agent
         * that joined and never spoke is written down with `""`. Passing that to
         * `resume` asks the provider to continue a conversation with no name,
         * and it does not answer — which is what left the window blank rather
         * than falling back to a fresh session.
         */
        const saved = entry.sessionRefs[agentId]
        const ref = saved === undefined || saved.trim() === '' ? undefined : saved
        /*
         * Bounded, because reopening is the one place a provider can hold the
         * whole app hostage.
         *
         * A stale thread does not always fail — `thread/resume` on an id the
         * provider has forgotten can simply never answer, and the window stayed
         * blank waiting for it. One agent taking too long now costs that agent,
         * not the session and not the app.
         */
        let expired = false
        const participant = await withTimeout(
          this.startParticipant(
            agentId,
            entry.conversationId,
            sessionOpts,
            profile,
            grants,
            ref,
            !arriving,
            undefined,
            () => expired
          ),
          REOPEN_TIMEOUT_MS,
          `${agentId} did not come back within ${String(Math.round(REOPEN_TIMEOUT_MS / 1000))}s`
        ).catch((error: unknown) => {
          expired = true
          throw error
        })
        pending.add(participant)
        /*
         * A resumed agent already holds its own side of the conversation, so it
         * starts at the end of the log. One that had to be restarted holds
         * nothing, so it starts at zero and reads the transcript on the first
         * thing it is asked — the same path an agent joining mid-conversation
         * takes.
         */
        if (ref === undefined || participant.session.sessionRef !== ref) {
          participant.seenSeq = 0
          participant.catchupBudget = JOINING_CATCHUP_CHARS
          participant.continuationPending = true
        }
        return participant
      })
    )

    if (
      this.isClosing() ||
      this.closingConversations.has(entry.conversationId) ||
      this.closingProjects.has(projectId)
    ) {
      await this.settleClosures(
        [...pending].map((participant) =>
          this.closeOwned(entry.conversationId, participant.service, () =>
            participant.service.close()
          )
        ),
        'Reopening agents could not be confirmed stopped'
      )
      return null
    }
    for (const outcome of started) {
      if (outcome.status === 'fulfilled') {
        conversation.participants.set(outcome.value.agentId, outcome.value)
      } else {
        this.log.error('an agent could not be reopened', undefined, {
          conversationId: entry.conversationId,
          message:
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        })
      }
    }

    /*
     * No participants normally means the reopen failed and there is nothing to
     * show. Under the profiling flag it is the expected outcome — the
     * conversation is being opened to be *read* — so the transcript is still
     * worth mounting.
     */
    if (conversation.participants.size === 0 && !readOnlyProfiling()) return null
    this.reseedCarriedContext(conversation)
    this.active.set(entry.conversationId, conversation)
    this.onConversations?.()
    return conversation
  }

  /**
   * Puts back a carried transcript that a relaunch would otherwise have eaten.
   */
  private reseedCarriedContext(conversation: ActiveConversation): void {
    const events = this.store.read(conversation.conversationId)

    const created = events.find((event) => event.payload.type === 'conversation.created')
    const source =
      created?.payload.type === 'conversation.created' ? created.payload.continuedFrom : undefined
    if (source === undefined) return

    const carryover = this.continuationContext(conversation.conversationId)
    if (carryover === undefined) return

    for (const participant of conversation.participants.values()) {
      if (
        participant.seenSeq !== 0 &&
        events.some(
          (event) => event.actor === participant.agentId && event.payload.type === 'turn.started'
        )
      )
        continue
      participant.seedContext = carryover
      participant.continuationPending = true
    }
    for (const [agentId, record] of conversation.dormant) {
      if (
        record.ref !== undefined &&
        events.some((event) => event.actor === agentId && event.payload.type === 'turn.started')
      )
        continue
      conversation.dormant.set(agentId, { ...record, carry: carryover })
    }
  }

  private continuationContext(
    conversationId: string,
    beforeSeq?: number,
    options: CarryoverOptions = {},
    excludeId?: string,
    excludeSeqs?: ReadonlySet<number>
  ): string | undefined {
    const chain = this.carriedChain(conversationId).map((source) => ({
      ...source,
      events:
        source.conversationId !== conversationId
          ? source.events
          : source.events.filter(
              (event) =>
                (beforeSeq === undefined || event.seq < beforeSeq) &&
                event.id !== excludeId &&
                excludeSeqs?.has(event.seq) !== true
            ),
    }))
    const forward = forwardContext(this.store.read(conversationId))
    return (
      composeCarryover(chain, {
        currentConversationId: conversationId,
        ...(forward === undefined
          ? {}
          : { objective: forward.objective, sourceEventIds: forward.sourceEventIds }),
        ...options,
      }) ?? undefined
    )
  }

  private contextWindow(conversationId: string, agentId: AgentId): ContextWindow | undefined {
    const participant = this.active.get(conversationId)?.participants.get(agentId)
    const held = this.contextWindows.get(`${conversationId}:${agentId}`)
    return held?.sessionRef === participant?.session.sessionRef ? held?.usage : undefined
  }

  private contextualMessage(
    conversation: ActiveConversation,
    participant: Participant,
    body: string,
    beforeSeq: number,
    from?: AgentId,
    callingReply?: StoredEvent
  ): string {
    const participants = this.roster(conversation)
    const retrieval = hasTranscript(participant.session)
    const deliveredMessageSeqs =
      participant.deferredMessages?.sessionRef === participant.session.sessionRef
        ? participant.deferredMessages.seqs
        : new Set<number>()
    const reminder = this.pinnedNote(conversation.conversationId)
    const reserved = reminder === '' ? 0 : Buffer.byteLength(reminder, 'utf8') + 2
    const frame = withCatchup(
      { recipient: participant.agentId, participants, events: [] },
      body,
      from
    )
    const overhead = Buffer.byteLength(frame, 'utf8') - Buffer.byteLength(body, 'utf8')
    const budget = contextBudget(
      reminder === '' ? frame : `${reminder}\n\n${frame}`,
      this.contextWindow(conversation.conversationId, participant.agentId),
      24_000 - overhead - reserved - 2
    )
    const parts: string[] = []
    let quotedReply: string | undefined
    let remaining = budget
    let deferred = budget < 1_024 && (participant.seedContext?.length ?? 0) > 0
    const room = (): number => Math.max(remaining - (parts.length === 0 ? 0 : 2), 0)
    const add = (text: string | undefined | null): void => {
      if (text === undefined || text === null || text === '') return
      const cost = Buffer.byteLength(text, 'utf8') + (parts.length === 0 ? 0 : 2)
      if (text.startsWith(CONTEXT_DEFERRED_PREFIX) || cost > remaining) {
        deferred = true
        return
      }
      parts.push(text)
      remaining -= cost
    }
    if (
      callingReply?.payload.type === 'agent.message.completed' &&
      callingReply.payload.text !== ''
    ) {
      const header =
        `${from ?? callingReply.actor}'s reply before calling you:\n` +
        `[conversation ${callingReply.conversationId}, #${String(callingReply.seq)} ${callingReply.id}]\n`
      const hint = retrieval
        ? `\n(full original reply: read_transcript eventId ${callingReply.id})`
        : ''
      const quoteRoom =
        Math.min(6_000, Math.floor(room() / 3)) - Buffer.byteLength(header + hint, 'utf8')
      quotedReply =
        header + fitContextExcerpt(callingReply.payload.text, Math.max(quoteRoom, 0)) + hint
      add(quotedReply)
    }
    const continuation =
      participant.continuationPending === true
        ? this.continuationContext(
            conversation.conversationId,
            beforeSeq,
            {
              maxTotalBytes: room(),
              retrieval,
            },
            callingReply?.id,
            deliveredMessageSeqs
          )
        : undefined
    add(
      continuation ??
        (participant.seedContext === undefined
          ? undefined
          : fitContextTail(participant.seedContext, Math.min(Math.floor(room() * 0.6), 8_000)))
    )
    if (continuation === undefined) {
      const missed = this.store
        .read(conversation.conversationId, { afterSeq: participant.seenSeq })
        .filter(
          (event) =>
            event.seq < beforeSeq &&
            event.id !== callingReply?.id &&
            !deliveredMessageSeqs.has(event.seq)
        )
      add(
        composeCatchup({
          recipient: participant.agentId,
          participants,
          events: missed,
          retrieval,
          includeOwnDiscussion: true,
          maxTotalBytes: Math.min(room(), participant.catchupBudget ?? 12_000),
        })
      )
    }
    const ordered = quotedReply === undefined ? parts : [...parts.slice(1), quotedReply]
    const context = deferred ? deferredContext(retrieval) : ordered.join('\n\n')
    const delivered = withCatchup(
      { recipient: participant.agentId, participants, events: [] },
      context === '' ? body : `${context}\n\n${body}`,
      from
    )
    if (deferred) {
      deliveredMessageSeqs.add(beforeSeq)
      participant.deferredMessages = {
        sessionRef: participant.session.sessionRef,
        seqs: deliveredMessageSeqs,
      }
    } else {
      delete participant.deferredMessages
      delete participant.seedContext
      delete participant.continuationPending
      delete participant.catchupBudget
      participant.seenSeq = Math.max(participant.seenSeq, beforeSeq)
    }
    return reminder === '' ? delivered : `${reminder}\n\n${delivered}`
  }

  /**
   * Every conversation a new room is continuing, oldest first.
   *
   * Only the *immediate* source is recorded on a conversation, because that is
   * the one fact the moment knows. The rest of the chain is recovered by
   * following each room's own `continuedFrom` back until one has none — which
   * is what makes carrying transitive without storing a growing copy of the
   * same transcript on every hop.
   *
   * **Restart is what ends a chain, and it ends it here.** A restarted room is
   * started with no source at all, so the walk stops the moment it reaches one:
   * everything before the restart is unreachable, which is exactly what
   * restarting is for.
   *
   * The visited set is a guard, not an optimisation. Ids are minted forward in
   * time so a cycle cannot arise from anything this code does — but the log is
   * a file on disk, and a corrupt or hand-edited row pointing backwards would
   * otherwise spin the main thread with the whole app on it.
   */
  private carriedChain(from: string, throughSeq?: number): CarryoverSource[] {
    return conversationChain((id) => this.store.read(id), from, throughSeq)
  }

  /** Written after anything that changes what is open, or what it is. */
  private rememberOpen(): void {
    // Under the flag every conversation reopens with no participants, so writing
    // this back would erase the agent list from the fixture and make the next
    // launch restore something different.
    if (readOnlyProfiling()) return

    /*
     * Grouped by project, because that is now the thing being reopened. The old
     * file was a flat session list with a path on each entry; conversations that
     * shared a folder repeated it, and nothing said they were the same place.
     */
    const state = this.snapshotOpenProjects()
    if (this.ports.openProjects === undefined) writeOpenProjects(this.userDataPath, state)
    else this.ports.openProjects.write(state)
  }

  snapshotOpenProjects(): OpenProjectsState {
    const byProject = new Map<string, OpenConversation[]>()
    for (const c of this.active.values()) {
      const conversations = byProject.get(c.projectId) ?? []
      conversations.push({
        conversationId: c.conversationId,
        agents: [
          ...c.participants.keys(),
          ...[...c.dormant]
            .filter(([agentId, record]) => record.known && !c.participants.has(agentId))
            .map(([agentId]) => agentId),
        ],
        profileId: c.profile.id,
        title: c.title,
        lastSeenSeq: c.lastSeenSeq,
        draft: c.draft,
        // Only real ones: an agent that has not spoken yet has no thread to
        // resume, and writing an empty string down makes it look like it does.
        sessionRefs: Object.fromEntries([
          ...[...c.dormant].flatMap(([agentId, record]) =>
            record.ref === undefined ? [] : [[agentId, record.ref] as const]
          ),
          ...[...c.participants.values()]
            .filter((p) => p.session.sessionRef.trim() !== '')
            .map((p) => [p.agentId, p.session.sessionRef] as const),
        ]),
      })
      byProject.set(c.projectId, conversations)
    }

    return {
      projects: [...byProject].map(([projectId, conversations]) => ({
        projectId,
        conversations,
      })),
      workspace: this.workspaceSnapshot,
    }
  }

  /**
   * Puts the conversations in the order the user arranged them.
   *
   * The map's insertion order is what gets written down and restored, so the
   * grid you arranged is the grid you get back. Unknown ids are ignored and any
   * conversation the caller forgot keeps its place at the end, so a stale list
   * cannot drop a live session.
   */
  reorderConversations(order: readonly string[]): void {
    const remaining = new Map(this.active)
    const next = new Map<string, ActiveConversation>()

    for (const id of order) {
      const conversation = remaining.get(id)
      if (conversation === undefined) continue
      next.set(id, conversation)
      remaining.delete(id)
    }
    for (const [id, conversation] of remaining) next.set(id, conversation)

    this.active.clear()
    for (const [id, conversation] of next) this.active.set(id, conversation)
    this.rememberOpen()
  }

  /**
   * Stores the editor arrangement and the sidebar's order together.
   *
   * `order` is the sidebar's list of running conversations; the panes' tab
   * orders travel inside `workspace`. The snapshot is set first so that
   * `reorderConversations`' single `rememberOpen()` writes both in one go
   * rather than leaving the file briefly holding a new order against an old
   * layout.
   */
  setConversationLayout(order: readonly string[], workspace: WorkspaceSnapshot): void {
    this.workspaceSnapshot = workspace
    this.reorderConversations(order)
  }

  attentionRooms(): {
    conversationId: string
    projectId: string
    projectName: string
    title: string
    approvals: number
    questions: number
  }[] {
    const rooms = []
    for (const [conversationId, conversation] of this.active) {
      const pending = this.pendingDecisions(conversationId)
      const approvals = pending.pendingApprovalIds.length
      const questions = pending.pendingQuestionIds.length
      if (approvals + questions === 0) continue
      rooms.push({
        conversationId,
        projectId: conversation.projectId,
        projectName: this.projects.get(conversation.projectId)?.name ?? '',
        title: conversation.title,
        approvals,
        questions,
      })
    }
    return rooms
  }

  activeWork(): {
    conversations: string[]
    approvals: number
    questions: number
    runs: string[]
    starting: number
    busy: boolean
  } {
    const conversations = new Set<string>()
    let approvals = 0
    let questions = 0
    for (const [id, conversation] of this.active) {
      const pending = this.pendingDecisions(id)
      approvals += pending.pendingApprovalIds.length
      questions += pending.pendingQuestionIds.length
      if (
        conversation.working.size > 0 ||
        this.liveReplies.pendingReplies(id).length > 0 ||
        [...conversation.participants.values()].some(
          (participant) => (this.backgroundWork.get(participant.service) ?? 0) > 0
        )
      )
        conversations.add(id)
    }
    for (const [id, aside] of this.asides) {
      const state = this.store.transcriptState(id)
      if (state.working.length > 0) conversations.add(id)
      approvals += aside.service.pendingApprovals().length
      questions += aside.service.pendingQuestions().length
    }
    const runs = this.projects
      .list()
      .filter((project) => {
        const state = this.runner.snapshot(project.id)
        return (
          state.process.kind === 'running' ||
          state.process.kind === 'starting' ||
          state.process.kind === 'stopping' ||
          state.cleanupPending
        )
      })
      .map((project) => project.id)
    const starting =
      this.startupWork.size +
      [...this.namers.values()].filter(
        (namer) => namer.starting !== undefined || namer.pending !== undefined
      ).length
    return {
      conversations: [...conversations],
      approvals,
      questions,
      runs,
      starting,
      busy:
        conversations.size > 0 ||
        approvals > 0 ||
        questions > 0 ||
        runs.length > 0 ||
        starting > 0 ||
        this.terminals.hasBusyShells(),
    }
  }

  activeSessions(): {
    conversationId: string
    participants: AgentId[]
    profileId: string
    projectId: string
    cwd: string
    title: string
    unread: number
    pendingApprovalIds: string[]
    pendingQuestionIds: string[]
    draft: string
    planning: boolean
    starting?: boolean
  }[] {
    const ready = [...this.active.entries()].map(([conversationId, open]) => ({
      conversationId,
      participants: this.roster(open),
      profileId: open.profile.id,
      projectId: open.projectId,
      cwd: open.cwd,
      title: open.title,
      unread: this.unreadSince(conversationId, open.lastSeenSeq),
      ...this.pendingDecisions(conversationId),
      draft: open.draft,
      planning: open.planning,
    }))
    return [
      ...ready,
      ...[...this.starting.values()].map((starting) => this.startingSession(starting)),
    ]
  }

  /** Conversations with live agents right now, newest last. */
  /**
   * How much a card has to say happened while nobody was looking.
   *
   * Counted out of the log rather than remembered, which is the whole reason the
   * watermark is a sequence number instead of a tally: the log is the thing that
   * actually knows what happened, so the count cannot drift away from the
   * transcript underneath it.
   */
  private unreadSince(conversationId: string, lastSeenSeq: number): number {
    return this.store.count(conversationId, {
      afterSeq: lastSeenSeq,
      types: [...UNREAD_EVENT_TYPES],
    })
  }

  /**
   * Records that a conversation's card has been caught up to `seq`.
   *
   * The renderer is the only side that knows this: whether something has been
   * read depends on which tab is in front, which is not a fact the main process
   * has. Backwards moves are ignored — pushes and history replays interleave, so
   * a late report of an older position is expected rather than exceptional.
   */
  /**
   * Remembers a message typed and not sent.
   *
   * Debounced by the renderer, which owns the keystrokes; this only writes what
   * it is told. Silent for a conversation that is no longer open — a draft
   * arriving for a room that just ended is a race, not an error.
   */
  rememberDraft(conversationId: string, draft: string): void {
    const starting = this.starting.get(conversationId)
    if (starting !== undefined) {
      starting.draft = draft
      return
    }
    const conversation = this.active.get(conversationId)
    if (conversation === undefined || conversation.draft === draft) return
    conversation.draft = draft
    this.rememberOpen()
  }

  markSeen(conversationId: string, seq: number): void {
    const conversation = this.active.get(conversationId)
    if (conversation === undefined) return
    if (seq <= conversation.lastSeenSeq) return
    conversation.lastSeenSeq = seq
    this.rememberOpen()
  }

  /**
   * Every conversation the log holds, with the open ones marked.
   *
   * The list is the log's, not the window's. `open-sessions.json` only records
   * what was on screen, so ending a conversation removed the last thing that
   * knew its name while its transcript stayed in the database forever.
   */
  listConversations(): (ConversationSummary & { open: boolean })[] {
    return this.store.listConversations().map((summary) => ({
      ...summary,
      open: this.active.has(summary.conversationId) || this.starting.has(summary.conversationId),
    }))
  }

  /**
   * Brings a past conversation back, transcript and all.
   *
   * Its agents are **started, not resumed**: the provider threads died with the
   * session, and a resume against a forgotten id is the one call that can hang
   * without failing. They pick the history up the way an agent joining
   * mid-conversation does — `reopen` sets their watermark to zero, so the first
   * thing asked arrives with the transcript attached.
   *
   * The permission profile deliberately falls back to the default rather than to
   * whatever the conversation last ran under. Reopening something from last week
   * should not silently restore permissions granted for a task nobody remembers.
   */
  /**
   * What is still waiting to be answered in one conversation, by id.
   *
   * `outcome IS NULL` and `answered_at IS NULL` are the whole definition, so
   * this is as true after a relaunch as it was before one: an agent's process
   * died, but the decision it was blocked on is a row, and the transcript has
   * always drawn it. Handing it to the renderer is what lets a tab agree with
   * the transcript instead of reading idle beside a visible approval card.
   *
   * Ids rather than counts, because the renderer clears them by id when the
   * answer arrives — a count would have no way to know which one was decided.
   */
  private pendingDecisions(conversationId: string): {
    pendingApprovalIds: string[]
    pendingQuestionIds: string[]
  } {
    return this.store.pendingDecisionIds(conversationId)
  }

  async reopenConversation(conversationId: string): Promise<{
    conversationId: string
    participants: AgentId[]
    profileId: string
    projectId: string
    cwd: string
    title: string
    unread: number
    pendingApprovalIds: string[]
    pendingQuestionIds: string[]
    starting?: boolean
  }> {
    const starting = this.starting.get(conversationId)
    if (starting !== undefined) return this.startingSession(starting)
    const open = this.active.get(conversationId)
    if (open !== undefined) {
      return {
        conversationId,
        participants: this.roster(open),
        profileId: open.profile.id,
        projectId: open.projectId,
        cwd: open.cwd,
        title: open.title,
        unread: this.unreadSince(conversationId, open.lastSeenSeq),
        ...this.pendingDecisions(conversationId),
      }
    }

    const summary = this.store
      .listConversations()
      .find((candidate) => candidate.conversationId === conversationId)
    if (summary === undefined) throw new Error('That conversation is not in the log.')

    // The registry decides whether this can be reopened, and it refuses both an
    // id nobody adopted and a project whose folder has gone.
    this.projects.resolveAgentCwd(summary.projectId)

    /*
     * Who this conversation *had*, which `reopen` uses only to tell an arrival
     * from a relaunch — it seats the whole cast either way. The refusal that
     * stood here, "no agent from that conversation is available", went with the
     * cast being a fact: a room from before an agent existed is not a room that
     * cannot be opened.
     */
    const agents = summary.agents.filter((id): id is AgentId => this.adapters.has(id as AgentId))

    const conversation = await this.reopen(summary.projectId, {
      conversationId,
      agents,
      profileId: DEFAULT_PROFILE_ID,
      title: summary.title,
      // Nothing to resume: those threads ended with their sessions.
      sessionRefs: {},
      draft: '',
      // Opened in order to be read, so it starts caught up rather than shouting
      // about every message it already contains.
      lastSeenSeq: this.store.lastSeq(),
    })
    if (conversation === null) throw new Error('That conversation could not be reopened.')

    this.rememberOpen()
    return {
      conversationId,
      participants: [...conversation.participants.keys()],
      profileId: conversation.profile.id,
      projectId: conversation.projectId,
      cwd: conversation.cwd,
      title: conversation.title,
      unread: 0,
      /*
       * Unread is zero because the watermark was just moved to the log's head,
       * but a pending decision is not something that was "missed" — it is still
       * outstanding, and a conversation opened from history is exactly where one
       * is most likely to have been left waiting.
       */
      ...this.pendingDecisions(conversationId),
    }
  }

  /**
   * The commands a conversation's agents accept.
   *
   * Per conversation, unlike models: the list is built from the project's own
   * `.claude/commands`, its skills and its plugins, so two rooms in two
   * repositories offer different things. Cached per participant because asking
   * is a control request and the menu asks every time it opens.
   */
  async listCommands(conversationId: string): Promise<SlashCommandInfo[]> {
    const conversation = this.require(conversationId)
    const perAgent = await Promise.all(
      [...conversation.participants.values()].map(async (participant) => {
        /*
         * Remembered only once there is something to remember.
         *
         * `??=` looked like the cache this wants and is not: an empty array is
         * not nullish, so the first answer is kept even when it is empty — and
         * it is empty exactly while the session is still starting, which is
         * when a freshly opened pane asks. That would leave the menu
         * permanently empty for a participant whose CLI had fifty commands to
         * offer a second later.
         *
         * Latent rather than observed: found while chasing a flaky spec that
         * turned out to be the test's own doing, and kept because an empty
         * answer means "could not ask yet" rather than "there are none", and
         * caching the two as the same thing is wrong however rarely it bites.
         */
        const known = participant.commands
        if (known !== undefined && known.length > 0) return known
        const asked = await participant.session.supportedCommands()
        if (asked.length > 0) participant.commands = asked
        return asked
      })
    )

    /*
     * Merged by name across agents, first one wins.
     *
     * Two agents in a room usually report overlapping sets, and a menu that
     * lists `/compact` twice because two CLIs both have it is a menu that looks
     * broken. Which agent runs it is decided by the routing that already
     * governs every other message.
     */
    const byName = new Map<string, SlashCommandInfo>()
    for (const command of perAgent.flat()) {
      if (!byName.has(command.name)) byName.set(command.name, command)
    }
    return [...byName.values()]
  }

  /**
   * Puts a conversation's agents into plan mode, or takes them out.
   *
   * Per conversation rather than per message, which is how Chorus already
   * models what a room may do: the permission profile lives here too, and a
   * mode that reset itself every turn would be a checkbox nobody could rely on.
   *
   * Every participant together. A room where one agent plans and the other
   * edits is not a mode, it is a disagreement.
   */
  async setPlanMode(conversationId: string, on: boolean): Promise<void> {
    const conversation = this.require(conversationId)
    conversation.planning = on
    await Promise.all(
      [...conversation.participants.values()].map((participant) =>
        participant.session.setPermissionMode(on ? 'plan' : 'default')
      )
    )
  }

  /** Whether this conversation is planning, for a control that has to say so. */
  planning(conversationId: string): boolean {
    return this.active.get(conversationId)?.planning ?? false
  }

  /**
   * Turns the standing instruction on or off for one conversation.
   *
   * **This has to respawn, and that is a property of system prompts rather than
   * a shortcoming here.** A system prompt is an argument to the session: Claude
   * fixes it when the long-lived `query` opens, and Codex when the thread starts.
   * Neither provider offers a way to change it mid-session, so the only honest
   * implementations were injecting the text on every turn — which puts a standing
   * instruction inside the conversation, competing with what the user actually
   * asked — or this.
   *
   * **A respawn is not a reset.** Each agent is resumed onto the provider thread
   * it was already on, and `seenSeq` moves across, so nothing is re-read as
   * catch-up and nothing is said twice. `reopening` is passed for the same reason
   * the relaunch path passes it: this must not put "claude joined" in a
   * transcript where nobody joined.
   *
   * `planning` is reapplied by hand afterwards, because permission mode is
   * session state too and a respawned session comes back in `default`. Losing
   * plan mode silently on a language toggle is exactly the kind of coupling that
   * makes a mode untrustworthy.
   *
   * The turn in flight is the one thing not handled here: the caller must refuse
   * while an agent is streaming, because closing a service mid-turn discards a
   * partial reply that the log cannot rebuild.
   */
  setAnswerStyle(conversationId: string, on: boolean): Promise<void> {
    this.require(conversationId)
    const work = this.setAnswerStyleOwned(conversationId, on)
    this.trackStartup(work, conversationId)
    return work
  }

  private async setAnswerStyleOwned(conversationId: string, on: boolean): Promise<void> {
    const conversation = this.require(conversationId)
    if (conversation.styleOn === on) return
    conversation.styleOn = on

    for (const previous of [...conversation.participants.values()]) {
      const agentId = previous.agentId
      const resumeFrom = previous.session.sessionRef.trim()
      await this.closeOwned(conversationId, previous.service, () => previous.service.close())
      this.require(conversationId)
      conversation.participants.delete(agentId)

      const participant = await this.startParticipant(
        agentId,
        conversationId,
        (resuming) => this.sessionOptsFor(conversation, agentId, resuming),
        conversation.profile,
        conversation.grants,
        resumeFrom === '' ? undefined : resumeFrom,
        true
      )
      try {
        this.require(conversationId)
      } catch (error) {
        await this.closeOwned(conversationId, participant.service, () =>
          participant.service.close()
        )
        throw error
      }
      participant.seenSeq = previous.seenSeq
      /*
       * Guarded, not assigned through: both are optional under
       * `exactOptionalPropertyTypes`, and writing `undefined` into one is not the
       * same as leaving it absent. A one-off allowance that has already been
       * spent must stay spent across the respawn.
       */
      if (previous.catchupBudget !== undefined) participant.catchupBudget = previous.catchupBudget
      if (previous.seedContext !== undefined) participant.seedContext = previous.seedContext
      if (previous.continuationPending === true) participant.continuationPending = true
      if (previous.origin !== undefined) participant.origin = previous.origin
      if (previous.deferredMessages?.sessionRef === participant.session.sessionRef) {
        participant.deferredMessages = previous.deferredMessages
      }
      if (participant.session.sessionRef !== resumeFrom) {
        const context = this.continuationContext(conversationId)
        if (context !== undefined) {
          participant.seedContext = context
          participant.continuationPending = true
        }
      }
      conversation.participants.set(agentId, participant)
      if (conversation.planning) await participant.session.setPermissionMode('plan')
    }

    this.rememberOpen()
    this.log.info('answer style changed', { conversationId, on })
  }

  /** Whether this conversation carries the instruction, for the control that says so. */
  answerStyle(conversationId: string): boolean {
    return (
      this.active.get(conversationId)?.styleOn ??
      this.starting.get(conversationId)?.styleOn ??
      false
    )
  }

  /**
   * How the inherited MCP servers are doing, asked of whichever session can say.
   *
   * Asked live rather than cached, unlike the model list. A model list does not
   * change under a running CLI; a server's health is exactly the thing that
   * does — it can drop, or come back once you authenticate it, and a remembered
   * answer would be the one state worse than none.
   *
   * Any live conversation will do: the servers come from the user's own config,
   * so every session in the app has the same ones.
   */
  async mcpServers(): Promise<McpServerHealth[]> {
    for (const conversation of this.active.values()) {
      for (const participant of conversation.participants.values()) {
        const servers = await participant.session.mcpServerStatus()
        if (servers.length > 0) return [...servers]
      }
    }
    return []
  }

  /**
   * Which account each agent is signed in as.
   *
   * Per agent rather than first-answer-wins, unlike the MCP servers: those come
   * from one config file and every session inherits the same ones, but claude
   * and codex are separate logins and the whole point of asking is that they
   * can differ. Asked live, because signing in elsewhere changes the answer
   * under a running app.
   *
   * One conversation per agent is enough — a second session for the same agent
   * is the same login — so this stops at the first that answers for each.
   */
  async accounts(): Promise<{ agentId: AgentId; account: AccountSummary }[]> {
    const found = new Map<AgentId, AccountSummary>()
    for (const conversation of this.active.values()) {
      for (const [agentId, participant] of conversation.participants) {
        if (found.has(agentId)) continue
        const account = await participant.session.accountInfo()
        if (account !== null) found.set(agentId, account)
      }
    }
    return [...found].map(([agentId, account]) => ({ agentId, account }))
  }

  /**
   * Ends one background task, on the agent that owns it.
   *
   * Routed by agent rather than broadcast: task ids come from one provider's
   * snapshot and mean nothing to the other, so asking both would be asking a
   * stranger to stop something it never started.
   *
   * No confirmation is returned. The provider's next snapshot is what says the
   * task is gone, and it is the only thing that can — a success here would only
   * mean the request was delivered.
   */
  async stopTask(conversationId: string, agentId: AgentId, taskId: string): Promise<void> {
    const participant = this.active.get(conversationId)?.participants.get(agentId)
    await participant?.session.stopTask(taskId)
  }

  /** What the settings sheet offers, from whichever session last answered. */
  /**
   * One row per adapter, whether or not it has ever been asked.
   *
   * Seeded from `adapters` rather than from what discovery happened to record,
   * so the sheet can draw a row for an agent that has never run — which is the
   * common case on a machine where only one agent has been used.
   */
  knownModels(): {
    agentId: AgentId
    status: 'unqueried' | 'loading' | 'ready' | 'failed'
    models: ModelChoice[]
  }[] {
    return [...this.adapters.keys()].map((agentId) => {
      const known = this.knownModelsByAgent.get(agentId)
      return {
        agentId,
        status: known?.status ?? 'unqueried',
        models: [...(known?.models ?? [])],
      }
    })
  }

  openConversations(): { conversationId: string; participants: AgentId[]; cwd: string }[] {
    return [...this.active.values()].map((c) => ({
      conversationId: c.conversationId,
      participants: this.roster(c),
      cwd: c.cwd,
    }))
  }

  /**
   * Seats anyone a message is addressed to who is not running, and says so when
   * that cannot be done.
   *
   * The cast is fixed, so an absent agent is never a choice somebody made — it
   * is a start that failed, and the two reasons are a missing CLI and a key that
   * was not saved yet. Both are fixable while the app is open, which is why this
   * retries on every send rather than only at launch: saving a DeepSeek key in
   * Settings has to be enough, with no restart and no new conversation.
   *
   * The cost is bounded by the failure being the unusual case. A seated agent
   * short-circuits on the first line, so an ordinary turn pays one map lookup.
   *
   * **The error is appended, not thrown.** The message is already in the log by
   * the time this runs, and refusing the send would leave a user message that
   * nothing ever answered and nothing ever explained.
   */
  private async ensureSeated(
    conversation: ActiveConversation,
    targets: readonly AgentId[]
  ): Promise<void> {
    for (const agentId of targets) {
      if (conversation.participants.has(agentId)) continue
      try {
        await this.seat(conversation, agentId)
      } catch (error) {
        if (this.closing || this.active.get(conversation.conversationId) !== conversation) return
        const message = error instanceof Error ? error.message : String(error)
        this.log.error('an addressed agent could not be started', undefined, {
          conversationId: conversation.conversationId,
          agentId,
          message,
        })
        this.store.append({
          conversationId: conversation.conversationId,
          actor: 'system',
          payload: { type: 'error.raised', message: `${agentId}: ${message}`, recoverable: true },
        })
      }
    }
  }

  /**
   * Brings an agent into a conversation already under way.
   *
   * Its watermark starts at zero, so the first thing it is asked comes with the
   * whole conversation attached — including what the agent it is replacing said.
   * That is the point: catching up should cost nothing until the agent is
   * actually used, and then cost exactly one turn.
   */
  async addParticipant(conversationId: string, agentId: AgentId): Promise<{ agentId: AgentId }> {
    await this.seat(this.require(conversationId), agentId)
    return { agentId }
  }

  private roster(conversation: ActiveConversation): AgentId[] {
    const live = [...conversation.participants.keys()]
    const dormant = [...conversation.dormant.keys()].filter((agentId) => !live.includes(agentId))
    return [...live, ...dormant]
  }

  private seat(conversation: ActiveConversation, agentId: AgentId): Promise<Participant> {
    const live = conversation.participants.get(agentId)
    if (live !== undefined) return Promise.resolve(live)
    const pending = this.seating.get(conversation) ?? new Map<AgentId, Promise<Participant>>()
    this.seating.set(conversation, pending)
    const running = pending.get(agentId)
    if (running !== undefined) return running
    const work = this.startSeat(conversation, agentId).finally(() => {
      pending.delete(agentId)
    })
    pending.set(agentId, work)
    this.trackStartup(work, conversation.conversationId)
    return work
  }

  private async startSeat(
    conversation: ActiveConversation,
    agentId: AgentId
  ): Promise<Participant> {
    const { conversationId } = conversation
    const dormant = conversation.dormant.get(agentId)
    const timedOut = new Error(
      `${agentId} did not come back within ${String(Math.round(REOPEN_TIMEOUT_MS / 1000))}s`
    )
    let expired = false
    const stopped = (): boolean =>
      expired ||
      this.closing ||
      this.closingConversations.has(conversationId) ||
      this.active.get(conversationId) !== conversation
    if (stopped()) throw new Error(STARTUP_CANCELLED)
    const starting = this.startParticipant(
      agentId,
      conversationId,
      (resuming) => this.sessionOptsFor(conversation, agentId, resuming),
      conversation.profile,
      conversation.grants,
      dormant?.ref,
      dormant?.known ?? false,
      undefined,
      stopped
    )
    const participant =
      dormant === undefined
        ? await starting
        : await withTimeout(starting, REOPEN_TIMEOUT_MS, timedOut).catch((error: unknown) => {
            expired = true
            if (error === timedOut) this.forgetStaleRef(conversation, agentId, dormant)
            throw error instanceof Error ? error : new Error(String(error))
          })
    if (dormant?.ref !== undefined && participant.session.sessionRef === dormant.ref) {
      participant.seenSeq = dormant.seenSeq
    } else {
      participant.seenSeq = 0
      participant.catchupBudget = JOINING_CATCHUP_CHARS
      participant.continuationPending = true
    }
    if (dormant?.carry !== undefined) {
      participant.seedContext = dormant.carry
      participant.continuationPending = true
    } else if (participant.seenSeq === 0) {
      const context = this.continuationContext(conversationId)
      if (context !== undefined) {
        participant.seedContext = context
        participant.continuationPending = true
      }
    }
    let applied = false
    try {
      while (conversation.planning !== applied) {
        const wanted: boolean = conversation.planning
        await participant.session.setPermissionMode(wanted ? 'plan' : 'default')
        applied = wanted
        if (stopped()) throw new Error(STARTUP_CANCELLED)
      }
    } catch (error) {
      this.closeStarted(participant, conversationId)
      throw error instanceof Error ? error : new Error(String(error))
    }
    if (stopped()) {
      this.closeStarted(participant, conversationId)
      throw new Error(STARTUP_CANCELLED)
    }
    participant.service.setProfile(conversation.profile)
    conversation.dormant.delete(agentId)
    conversation.participants.set(agentId, participant)
    this.rememberOpen()
    this.log.info(dormant === undefined ? 'agent joined' : 'restored agent started', {
      conversationId,
      agentId,
    })
    return participant
  }

  private forgetStaleRef(
    conversation: ActiveConversation,
    agentId: AgentId,
    stale: DormantAgent
  ): void {
    if (this.closing || this.active.get(conversation.conversationId) !== conversation) return
    if (conversation.dormant.get(agentId) !== stale) return
    conversation.dormant.set(agentId, { ...stale, ref: undefined })
    this.rememberOpen()
  }

  /*
   * `removeParticipant` stood here and is gone.
   *
   * It took an agent out without ending the conversation, which is an operation
   * a fixed cast does not have. Nothing asks for it now — and keeping it as a
   * primitive "in case" would leave the one method able to produce the state the
   * rest of this file no longer expects: a room missing an agent on purpose,
   * indistinguishable from one whose start failed.
   *
   * Ending a conversation still closes every session. That is `endConversation`,
   * and it is a different question.
   */

  /** The provider sandbox mirrors the profile, so it is rebuilt when either moves. */
  /**
   * The default model for one agent, from that agent's own entry.
   *
   * The setting was a single string until this, and that string was always
   * chosen from **Claude's** list — the only catalogue the sheet ever showed —
   * so handing it to Codex sent a value from one provider's catalogue to
   * another's API. The schema's transform folds the old scalar onto Claude for
   * exactly that reason; this only has to read the map.
   */
  private preferredModelFor(agentId: AgentId): string {
    return readSettings(this.userDataPath).models[agentId]
  }

  /**
   * Whether a conversation opens in the bilingual style.
   *
   * The checkbox and nothing else. There was a settings box overriding
   * `DEFAULT_STYLE_INSTRUCTION` for one build and it was removed: the style is
   * the product's answer, and offering a blank textarea beside it made a settled
   * decision look like a question the user was expected to answer. The whole
   * choice is now one switch — this style, or plain.
   */
  private defaultStyleOn(): boolean {
    return readSettings(this.userDataPath).styleOnByDefault
  }

  /**
   * What one agent starts with.
   *
   * Per agent, which it was not: this returned one object for whichever agent
   * happened to be starting, so a Claude model reached Codex's `thread/start`.
   *
   * `resuming` drops the model entirely. A resumed session already has one —
   * it is in the provider's own record of the thread — and passing today's
   * preference would silently re-point a conversation that already exists at a
   * different model, days after anyone chose it.
   */
  private sessionOptsFor(
    /*
     * The two fields this actually needs, rather than a whole conversation.
     * `startConversation` has them before an `ActiveConversation` exists, and a
     * cast to pretend otherwise would be a lie the type system believed.
     */
    where: {
      readonly cwd: string
      readonly profile: PermissionProfile
      /*
       * Absent means "not a conversation" — the probe and the aside paths call
       * this with a bare `{ cwd, profile }` and neither should ever carry the
       * instruction. Optional rather than required so that stays true by
       * omission instead of by every call site remembering to pass `false`.
       */
      readonly styleOn?: boolean
      readonly conversationId?: string
      readonly projectId?: string
    },
    agentId: AgentId,
    resuming = false
  ): SessionOpts {
    const project = where.projectId === undefined ? null : this.projects.get(where.projectId)
    const editorPlace =
      project === null ? undefined : { host: project.host, root: project.canonicalRoot }
    // Read at call time rather than held: changing the sheet should affect the
    // next session without the app having to be restarted.
    const preferred = resuming ? '' : this.preferredModelFor(agentId)
    /*
     * Carried on a resume, unlike the model.
     *
     * The model is dropped when resuming because the provider's own record of
     * the thread already holds one. A system prompt is the opposite: it is not
     * part of the thread's record, it is an argument to the session, and a
     * resume that omitted it would silently return a conversation to English on
     * the next relaunch.
     */
    const instructions = [
      where.styleOn === true ? DEFAULT_STYLE_INSTRUCTION : '',
      where.styleOn === undefined ? '' : callRule(AGENT_IDS),
      where.conversationId === undefined ? '' : PROGRESS_INSTRUCTION,
    ]
      .filter((part) => part !== '')
      .join('\n\n')
    const { conversationId } = where
    const transcript: SessionOpts['transcript'] =
      conversationId === undefined
        ? undefined
        : (request, maximum) => {
            const maxTotalBytes =
              maximum ?? contextBudget('', this.contextWindow(conversationId, agentId), 16_000)
            return request.scope === 'forwarded'
              ? this.readForwarded(conversationId, request, maxTotalBytes)
              : composeTranscript(this.carriedChain(conversationId), request, { maxTotalBytes })
          }
    const reader = this.projectReaderFor(where.projectId)
    const progress: SessionOpts['progress'] =
      conversationId === undefined
        ? undefined
        : (report) => this.recordProgress(conversationId, agentId, report, null)
    const note: SessionOpts['note'] =
      conversationId === undefined
        ? undefined
        : {
            read: () => this.conversationNotes.read(conversationId),
            write: (text, expectedRevision) =>
              this.writeAgentNote(conversationId, agentId, text, expectedRevision, null),
          }
    const browser =
      conversationId === undefined || where.projectId === undefined
        ? undefined
        : this.browserAccessFor(where.projectId, conversationId, agentId)
    return {
      cwd: where.cwd,
      ...(preferred === '' ? {} : { model: preferred }),
      ...(instructions === '' ? {} : { instructions }),
      ...(transcript === undefined ? {} : { transcript }),
      ...(editorPlace === undefined ? {} : { editorPlace }),
      ...(reader === undefined ? {} : { project: reader }),
      ...(progress === undefined ? {} : { progress }),
      ...(note === undefined ? {} : { note }),
      ...(browser === undefined ? {} : { browser }),
      sandbox:
        where.profile.id === 'read-only'
          ? { mode: 'readOnly', writableRoots: [], networkAccess: false }
          : { mode: 'workspaceWrite', writableRoots: [where.cwd], networkAccess: false },
    }
  }

  attachBrowserConsoles(consoles: ProjectConsoles): void {
    this.browserConsoles = consoles
  }

  private browserAccessFor(
    projectId: string,
    conversationId: string,
    agentId: AgentId
  ): BrowserConsoleAccess {
    return {
      read: (request) =>
        new Promise<string>((resolve) => {
          resolve(this.readBrowserConsole(projectId, conversationId, request))
        }),
      run: (request) => this.runBrowserConsole(projectId, conversationId, agentId, request),
    }
  }

  private async readBrowserConsole(
    projectId: string,
    conversationId: string,
    request: BrowserConsoleRead
  ): Promise<string> {
    const consoles = this.browserConsoles
    if (consoles === null) throw new Error(mainT('browserConsole.unavailable'))
    const refusal = this.consoleRefusal(projectId, conversationId)
    if (refusal !== null) throw new Error(refusal)
    return consoles.read(projectId, request)
  }

  private async runBrowserConsole(
    projectId: string,
    conversationId: string,
    agentId: AgentId,
    request: BrowserConsoleRun
  ): Promise<string> {
    const consoles = this.browserConsoles
    if (consoles === null) throw new Error(mainT('browserConsole.unavailable'))
    const refusal =
      this.consoleRefusal(projectId, conversationId) ??
      this.runRefusal(projectId, conversationId, agentId)
    if (refusal !== null) throw new Error(refusal)
    return consoles.run(projectId, { ...request, actor: agentId })
  }

  private consoleRefusal(projectId: string, conversationId: string): string | null {
    const conversation = this.active.get(conversationId)
    if (
      this.closing ||
      conversation?.projectId !== projectId ||
      this.closingConversations.has(conversationId) ||
      this.closingProjects.has(projectId) ||
      this.closedProjects.has(projectId) ||
      this.projects.get(projectId) === null
    ) {
      return mainT('browserConsole.closed')
    }
    return null
  }

  private runRefusal(projectId: string, conversationId: string, agentId: AgentId): string | null {
    const conversation = this.active.get(conversationId)
    const saved = this.projects.get(projectId)?.profileId ?? null
    if (!conversation?.participants.has(agentId)) {
      return mainT('browserConsole.closed')
    }
    if (
      conversation.profile.id === 'read-only' ||
      (saved !== null && profileById(saved).id === 'read-only')
    ) {
      return mainT('browserConsole.readOnly')
    }
    if (conversation.planning) return mainT('browserConsole.planning')
    return null
  }

  private projectReaderFor(projectId: string | undefined): SessionOpts['project'] {
    if (projectId === undefined || this.projects.get(projectId)?.host !== LOCAL_HOST) {
      return undefined
    }
    return projectReader(projectId, {
      local: (id) => this.projects.get(id)?.host === LOCAL_HOST,
      runner: this.runner,
      terminals: this.terminals,
      traffic: this.traffic,
    })
  }

  /**
   * Names a conversation.
   *
   * Recorded like everything else: a name is how you will refer to this in a
   * week, and the log is the only thing that will still have it.
   */
  /**
   * Keeps the tab naming the topic the conversation is actually on.
   *
   * Called for every message the user sends and never awaited. A title is worth
   * nothing next to the turn it describes, so it must not delay delivery, must
   * not fail a send, and must not surface an error anywhere the person can see
   * one — the whole path swallows into a log line.
   *
   * **It renames over a name you typed, by decision rather than by oversight.**
   * The alternative was considered and refused: a conversation that keeps its
   * hand-typed name forever stops tracking the topic the moment you touch it,
   * which is the opposite of what this exists for. If that turns out to be
   * wrong, the fix is a flag on the conversation set by `renameConversation`
   * and read here, not a change to what the namer does.
   */
  private nameTopic(conversationId: string, message: string): void {
    if (this.closing || this.closingConversations.has(conversationId) || message.trim() === '')
      return
    const conversation = this.active.get(conversationId)
    if (conversation === undefined) return

    let namer = this.namers.get(conversationId)
    if (namer === undefined) {
      namer = { sessions: new Map(), demoted: new Set(), queue: Promise.resolve() }
      this.namers.set(conversationId, namer)
    }
    const held = namer
    const stillStarting = (): boolean => held.starting !== undefined

    held.queue = held.queue
      .then(async () => {
        if (this.closing || this.namers.get(conversationId) !== held) return
        if (
          this.active.get(conversationId) !== conversation ||
          held.starting !== undefined ||
          held.sessions.size > 0
        )
          return
        const text =
          conversation.title === folderName(conversation.cwd)
            ? message
            : `Current title: ${conversation.title}\n\n${message}`

        for (const agentId of NAMER_ORDER) {
          if (this.isClosing() || this.namers.get(conversationId) !== held) return
          if (held.demoted.has(agentId) || !this.adapters.has(agentId)) continue

          let session: AgentSession
          try {
            session = await this.startNamer(conversation, held, agentId)
          } catch (error: unknown) {
            if (this.isClosing() || this.namers.get(conversationId) !== held) return
            this.log.error('the topic namer failed', error instanceof Error ? error : undefined, {
              conversationId,
              agentId,
            })
            if (stillStarting()) return
            held.demoted.add(agentId)
            continue
          }

          try {
            if (this.isClosing() || this.namers.get(conversationId) !== held) return

            const outcome = await this.askNamer(held, session, text)
            if (this.isClosing() || this.namers.get(conversationId) !== held) return
            const title = outcome.kind === 'title' ? cleanTitle(outcome.text) : null
            if (title === null) {
              if (outcome.kind !== 'timeout') held.demoted.add(agentId)
              continue
            }

            if (this.active.get(conversationId) !== conversation) return
            if (title === conversation.title) return
            this.renameConversation(conversationId, title)
            return
          } finally {
            await this.closeNamerSession(session)
            if (held.sessions.get(agentId) === session) held.sessions.delete(agentId)
          }
        }
      })
      .catch((error: unknown) => {
        this.log.error('the topic namer failed', error instanceof Error ? error : undefined, {
          conversationId,
        })
      })
  }

  /**
   * Starts the naming session and the one reader that serves it.
   *
   * The reader is started here, once, rather than per request: `events` is a
   * single async iterable, so a second `for await` over it competes with the
   * first for the same events and each would see roughly half of them.
   */
  private async startNamer(
    conversation: ActiveConversation,
    namer: Namer,
    agentId: AgentId
  ): Promise<AgentSession> {
    const adapter = this.adapters.get(agentId)
    if (adapter === undefined) throw new Error(`${agentId} is not available`)
    const model = this.preferredModelFor(agentId)

    /*
     * Read-only, and it never asks. The namer is handed the user's words and
     * replies with a label — it has no business touching the working tree, and
     * a sandbox says so at the process rather than trusting a prompt.
     */
    let abandoned = false
    let cancel = (): void => undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        abandoned = true
        reject(new Error(STARTUP_CANCELLED))
      }
    })
    const started = adapter
      .start({
        cwd: conversation.cwd,
        sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
        toolPolicy: 'none',
        instructions: NAMER_INSTRUCTIONS,
        ...(model === '' ? {} : { model }),
      })
      .then(async (session) => {
        this.namerOwners.set(session, conversation.conversationId)
        if (
          abandoned ||
          this.closing ||
          this.namers.get(conversation.conversationId) !== namer ||
          this.active.get(conversation.conversationId) !== conversation
        ) {
          await this.closeNamerSession(session)
          throw new Error(STARTUP_CANCELLED)
        }
        this.readNamer(namer, agentId, session)
        return session
      })
    this.trackStartup(started, conversation.conversationId)
    const starting = { session: started, cancel }
    namer.starting = starting
    const release = (): void => {
      if (namer.starting === starting) delete namer.starting
    }
    void started.then(release, release)
    try {
      return await withTimeout(
        Promise.race([started, cancelled]),
        NAMER_TIMEOUT_MS,
        'The title helper did not start in time'
      )
    } catch (error) {
      abandoned = true
      throw error
    }
  }

  private readNamer(namer: Namer, agentId: AgentId, session: AgentSession): void {
    namer.sessions.set(agentId, session)

    const settle = (outcome: NamerOutcome): void => {
      const waiting = namer.pending
      if (waiting?.session !== session) return
      // Cleared before the hand-off, so a second completed message in one
      // turn cannot resolve the same request twice.
      delete namer.pending
      waiting.settle(outcome)
    }

    void (async () => {
      let reply: string | null = null
      try {
        for await (const event of session.events) {
          if (event.type === 'turn.started') {
            reply = null
          } else if (event.type === 'message.completed') {
            reply = event.text
          } else if (event.type === 'error' && !event.recoverable) {
            reply = null
            settle({ kind: 'failed' })
          } else if (event.type === 'turn.completed') {
            const outcome: NamerOutcome =
              event.status === 'completed' && reply !== null
                ? { kind: 'title', text: reply }
                : { kind: 'failed' }
            reply = null
            settle(outcome)
          }
        }
      } catch {
        // The session ended or the provider went away. Anything waiting on it
        // times out on its own, which is the same outcome by a slower route.
      }
      settle({ kind: 'failed' })
    })()
  }

  /**
   * One question, one answer, with a deadline.
   *
   * The timeout is not defensive dressing: without it a provider that accepts a
   * message and never completes it leaves this promise pending forever, and the
   * queue behind it never moves again — so one silent turn would stop the
   * conversation being renamed for the rest of the session.
   */
  private async askNamer(namer: Namer, session: AgentSession, text: string): Promise<NamerOutcome> {
    return new Promise<NamerOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (namer.pending?.session === session) delete namer.pending
        resolve({ kind: 'timeout' })
      }, NAMER_TIMEOUT_MS)

      namer.pending = {
        session,
        settle: (outcome) => {
          clearTimeout(timer)
          resolve(outcome)
        },
      }

      void session.send({ text }).catch(() => {
        const waiting = namer.pending
        if (waiting?.session !== session) return
        delete namer.pending
        waiting.settle({ kind: 'failed' })
      })
    })
  }

  private closeNamerSession(session: AgentSession): Promise<void> {
    const owner = this.namerOwners.get(session)
    const closing =
      owner === undefined ? session.close() : this.closeOwned(owner, session, () => session.close())
    this.namingCleanup.add(closing)
    const release = (): void => {
      this.namingCleanup.delete(closing)
    }
    void closing.then(release, release)
    return closing
  }

  private async disposeNamer(conversationId: string): Promise<void> {
    const namer = this.namers.get(conversationId)
    if (namer === undefined) return
    this.namers.delete(conversationId)
    namer.starting?.cancel()
    const pending = namer.pending
    delete namer.pending
    pending?.settle({ kind: 'failed' })
    const sessions = [...namer.sessions.values()]
    namer.sessions.clear()
    await Promise.all(sessions.map((session) => this.closeNamerSession(session)))
  }

  renameConversation(conversationId: string, title: string): { title: string } {
    const conversation = this.require(conversationId)
    // Emptying the field is a request for the default back, not for no name.
    const next = title.trim() === '' ? folderName(conversation.cwd) : title.trim()
    if (next === conversation.title) return { title: next }

    this.store.append({
      conversationId,
      actor: 'system',
      payload: { type: 'conversation.renamed', title: next, previousTitle: conversation.title },
    })
    conversation.title = next
    this.rememberOpen()
    /*
     * Carried through to each provider's own record of the session.
     *
     * Chorus's log stays authoritative for Chorus's history — this is so a room
     * named here is recognisable if the same session is later resumed in the
     * provider's own client, instead of appearing under an auto-generated
     * summary of its first prompt.
     *
     * Not awaited, and failures are the adapter's to swallow: a rename is a
     * local fact that has already happened, and it must not wait on, or be
     * undone by, another program's bookkeeping.
     */
    for (const participant of conversation.participants.values()) {
      const adapter = this.adapters.get(participant.agentId)
      void adapter?.renameSession?.(participant.session.sessionRef, next, conversation.cwd)
    }
    return { title: next }
  }

  /** What a conversation is called right now. */
  conversationTitle(conversationId: string): string {
    return this.require(conversationId).title
  }

  /** Where a conversation is, for anything that needs the path rather than the id. */
  agentDirectory(conversationId: string): string {
    return this.require(conversationId).cwd
  }

  editorPlace(conversationId: string): WorkbenchPlace {
    return this.projects.workbenchTarget(this.require(conversationId).projectId)
  }

  /**
   * The registry as the shell needs it: every project, with how many of its
   * conversations are open.
   *
   * The count is the runtime's to add and not the store's. `ProjectStore` knows
   * what has been adopted and nothing about what is running, which is the split
   * that lets it stay a database — so the two facts are joined here, where both
   * are already in hand.
   */
  listProjects(): {
    id: string
    name: string
    host: string
    root: string
    lastOpenedAt: number
    openConversations: number
    profileId: string | null
    agentIds: AgentId[] | null
    notes: string | null
    noteWidth: number | null
    noteHeight: number | null
    missing: boolean
  }[] {
    const open = new Map<string, number>()
    for (const conversation of this.active.values()) {
      open.set(conversation.projectId, (open.get(conversation.projectId) ?? 0) + 1)
    }
    return this.projects.list().map((project) => ({
      id: project.id,
      name: project.name,
      host: project.host,
      root: project.root,
      lastOpenedAt: project.lastOpenedAt,
      openConversations: open.get(project.id) ?? 0,
      profileId: project.profileId,
      /*
       * Narrowed here rather than in the store, which holds `string[]` on
       * purpose: which agents exist is this app's question, not the database's.
       * A row naming an agent this build no longer ships is dropped rather than
       * passed through, so the renderer never has to render a cast member it has
       * no icon or launcher for — and dropping it beats refusing the whole
       * project list over one stale name.
       */
      agentIds: project.agentIds === null ? null : project.agentIds.filter(isAgentId),
      /*
       * On the listing rather than behind a read of its own, because the rail
       * and the column both want it and neither wants a second round trip. It is
       * a short string on a short list.
       */
      notes: project.notes,
      /* And how big its pad was left, which travels with the text for the same
         reason: two reads would let the note and its box disagree by a refresh. */
      noteWidth: project.noteWidth,
      noteHeight: project.noteHeight,
      /*
       * Whether the folder is still on disk, answered here so the renderer never
       * has to find out by failing.
       *
       * It is read at list time rather than cached on the row because it is a
       * fact about the world, not about the project: the volume mounts, the
       * checkout is restored, and the next refresh says so without anything
       * having been written. A stat per project, and the list is short.
       */
      missing: !this.projects.rootPresent(project.id),
    }))
  }

  /**
   * Which open conversations belong to the project at this root — Phase 6 slice
   * 6c's routing rule, in one place.
   *
   * **Keyed by the project, never by the path**, which is the whole of what
   * "routing is project-first" means. The old bridge matched a conversation's
   * `cwd` against the editor's file, so two conversations that happened to share
   * a directory string were the same target and a relocated project was none.
   * Here the root resolves to a project id and conversations are selected by the
   * id they carry, so the answer survives a relocation and cannot be spoofed by
   * a coincidence of paths.
   *
   * An unadopted root returns nothing rather than everything. A surface can only
   * have been opened for a project that exists, so this should not happen — and
   * if it does, delivering a stray editor's contents to every conversation is
   * the worst available answer.
   */
  conversationsForPlace(place: WorkbenchPlace): string[] {
    const project = this.projects.findByPlace(place)
    if (project === null) return []
    return [...this.active.values()]
      .filter((conversation) => conversation.projectId === project.id)
      .map((conversation) => conversation.conversationId)
  }

  /**
   * Emptying the field asks for the folder's own name back, not for no name.
   *
   * The rule `renameConversation` already follows, and it lives here for the
   * reason that one does: `projects.rename` rejects a blank string, so a
   * renderer that guarded the empty case would be deciding what empty *means*,
   * and every surface offering a rename would have to keep deciding it the same
   * way. There are two of them now — the tab and the hover card.
   *
   * An unknown project falls through with the blank intact, so it fails as
   * `UnknownProjectError` rather than as a name it never had.
   */
  renameProject(projectId: string, name: string): { name: string } {
    const project = this.projects.get(projectId)
    const next = name.trim() === '' && project !== null ? folderName(project.root) : name
    return { name: this.projects.rename(projectId, next).name }
  }

  /**
   * Moves a project to sit immediately before another, or to the end.
   *
   * Answers with the same shape `listProjects` does, rather than with the moved
   * row or with nothing. The rail redraws from one array, and a caller that had
   * to merge a partial answer into its own copy would be deciding the order in
   * the renderer — which is exactly the split `listProjects` exists to prevent,
   * since the open-conversation counts are the runtime's and the order is the
   * store's.
   */
  reorderProjects(
    projectId: string,
    beforeId: string | null
  ): ReturnType<ChorusRuntime['listProjects']> {
    this.projects.moveOrder(projectId, beforeId)
    return this.listProjects()
  }

  /**
   * Changes what agents may do in a project, and in everything running in it.
   *
   * A profile is an answer about a *place* — "agents may write in this
   * repository" — so it is stored on the project, and every conversation under
   * that project moves with it. Two rooms in one directory disagreeing about
   * what may be run there is the state this removes; it is the same argument
   * `setProfile` already makes one level down about two agents in one room.
   *
   * **The row is written first, then the live conversations follow.** The other
   * order would leave a fanout that failed halfway with running conversations
   * widened and nothing recording it — the durable answer would still say the
   * old profile and the next launch would silently narrow them back. Written
   * first, a failed fanout is a conversation that has not caught up yet, which
   * a restart fixes.
   *
   * Each conversation still appends its own `policy.changed`, because a
   * transcript has to show the widening above the actions it permitted. The
   * project's row is current state; the log is what happened.
   */
  setProjectProfile(projectId: string, profileId: string): { profileId: string } {
    const profile = profileById(profileId)
    this.projects.setProfile(projectId, profile.id)

    for (const conversation of [...this.active.values()]) {
      if (conversation.projectId !== projectId) continue
      if (conversation.profile.id === profile.id) continue
      this.setProfile(conversation.conversationId, profile.id)
    }
    this.log.info('project policy changed', { projectId, to: profile.id })
    return { profileId: profile.id }
  }

  /**
   * Changes the project's cast, and reconciles every live conversation to it.
   *
   * Adds before it removes, deliberately. A conversation whose cast is being
   * swapped wholesale would otherwise spend the middle of this operation with no
   * participants at all, and a turn arriving in that window has nobody to route
   * to. Adding first means the room is never empty.
   *
   * `allSettled` and not `all`: one agent failing to launch — a CLI that is not
   * installed, an expired login — must not abandon the reconcile with the other
   * conversations half-done. The project's row is already correct, so a failure
   * here is a conversation that will pick the cast up when it next starts.
   */
  /**
   * Records the project's scratchpad, and tells nothing.
   *
   * Its two neighbours reconcile live conversations — a profile changes what
   * agents may do, a cast starts and stops them. A note changes neither, so
   * this is a write and a returned value, and it is synchronous for the same
   * reason.
   */
  setProjectNotes(projectId: string, notes: string): { notes: string } {
    const saved = this.projects.setNotes(projectId, notes)
    return { notes: saved.notes ?? '' }
  }

  /**
   * The app's own scratchpad. Tells nothing, for the reason above.
   *
   * Synchronous like its project-scoped neighbour, and read whole: the panel
   * needs the text and the width in the same breath to open at the size it was
   * left at, and two round trips would open it at the default and then jump.
   */
  getAppNote(): AppNote {
    return this.appNote.read()
  }

  setAppNote(notes: string): { notes: string } {
    const saved = this.appNote.setNotes(notes)
    return { notes: saved.notes ?? '' }
  }

  /**
   * Fractions of the window, already bounded by the IPC schema.
   *
   * Returned rather than assumed, so the caller writes what was stored instead
   * of what it sent.
   */
  setAppNoteSize(width: number, height: number | null): { width: number; height: number | null } {
    const saved = this.appNote.setSize(width, height)
    return { width: saved.width ?? width, height: saved.height }
  }

  getConversationNote(conversationId: string): ConversationNote {
    return this.conversationNotes.read(conversationId)
  }

  readConversationNoteJournal(conversationId: string): string | null {
    return this.conversationNotes.readJournal(conversationId)
  }

  compareConversationNoteJournal(
    conversationId: string,
    expected: string | null,
    next: string | null
  ): { readonly matched: boolean; readonly current: string | null } {
    this.require(conversationId)
    return this.conversationNotes.compareJournal(conversationId, expected, next)
  }

  setConversationNoteText(
    conversationId: string,
    text: string,
    baseRevision: number
  ): ConversationNoteWrite {
    return this.writeConversationNoteText(conversationId, text, baseRevision, 'user')
  }

  setConversationNoteView(conversationId: string, view: ConversationNoteView): ConversationNote {
    this.require(conversationId)
    const before = this.conversationNotes.read(conversationId)
    const note = this.conversationNotes.setView(conversationId, view)
    if (note.version !== before.version) this.publishConversationNote(conversationId, note)
    return note
  }

  private writeConversationNoteText(
    conversationId: string,
    text: string,
    expectedRevision: number,
    author: 'user' | AgentId
  ): ConversationNoteWrite {
    this.require(conversationId)
    const before = this.conversationNotes.read(conversationId)
    const written = this.conversationNotes.setText(
      conversationId,
      text,
      expectedRevision,
      author,
      Date.now()
    )
    if (written.status === 'saved' && written.note.version !== before.version) {
      this.publishConversationNote(conversationId, written.note)
    }
    return written
  }

  private writeAgentNote(
    conversationId: string,
    agentId: AgentId,
    text: string,
    expectedRevision: number,
    owner: { readonly service?: ConversationService } | null
  ): ConversationNoteWrite {
    const participant = this.active.get(conversationId)?.participants.get(agentId)
    if (
      participant === undefined ||
      owner?.service === undefined ||
      owner.service !== participant.service
    ) {
      throw new Error(
        'The note was not saved: this session is no longer the active one for this conversation.'
      )
    }
    return this.writeConversationNoteText(conversationId, text, expectedRevision, agentId)
  }

  private pinnedNote(conversationId: string): string {
    try {
      return noteReminder(this.conversationNotes.read(conversationId))
    } catch (error) {
      this.log.warn('the pinned note could not be read for delivery', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return ''
    }
  }

  private forgetConversationNote(conversationId: string): Error | undefined {
    let failure: Error | undefined
    try {
      this.conversationNotes.delete(conversationId)
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      this.log.warn('a closed conversation note could not be deleted', {
        conversationId,
        error: failure.message,
      })
    }
    this.publishConversationNote(conversationId, null)
    return failure
  }

  private publishConversationNote(conversationId: string, note: ConversationNote | null): void {
    for (const listener of this.noteListeners) {
      try {
        listener({ conversationId, note })
      } catch (error) {
        this.log.warn('a conversation note push failed', {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /**
   * The notes the masthead's menu lists, whole.
   *
   * Not paged, and that is a judgement rather than an omission: the list is read
   * by looking down it, so it is short by construction. A cursor would be
   * machinery for a case that cannot arise without a feature nobody has asked
   * for.
   */
  listKeptNotes(): { notes: KeptNote[] } {
    return { notes: this.keptNotes.list() }
  }

  /**
   * Makes one and answers only its id.
   *
   * The row itself is not returned because the caller has to re-read the list
   * anyway: where a new note sits is the store's decision, and a caller that
   * spliced the row in itself would be guessing at an order it does not own.
   */
  createKeptNote(): { id: string } {
    return { id: this.keptNotes.create(Date.now()).id }
  }

  /**
   * Records one, and says plainly when there was nothing to record.
   *
   * The editor saves on a debounce, so a write can land after its note was
   * deleted — ordinary rather than exceptional, for the reason the store's own
   * `setNotes` gives. It answers instead of throwing and the renderer drops it.
   *
   * The clock is this side's because the store takes one: the same split that
   * lets the store be tested without pretending about time.
   */
  setKeptNote(id: string, notes: string): { saved: boolean } {
    return { saved: this.keptNotes.setNotes(id, notes, Date.now()) !== null }
  }

  removeKeptNote(id: string): { removed: boolean } {
    return { removed: this.keptNotes.remove(id) }
  }

  /**
   * The whole sequence, because a move changes where everything after it sits.
   *
   * Answers nothing but acknowledgement: the caller already knows the order — it
   * is the one it just sent — and re-reading the list here would only let the
   * renderer replace its own arrangement with an identical copy of it.
   */
  reorderKeptNotes(ids: readonly string[]): { ordered: boolean } {
    this.keptNotes.reorder(ids)
    return { ordered: true }
  }

  /** The same, for the note that belongs to a project. */
  setProjectNoteSize(
    projectId: string,
    width: number | null,
    height: number | null
  ): { width: number | null; height: number | null } {
    const saved = this.projects.setNoteSize(projectId, width, height)
    return { width: saved.noteWidth, height: saved.noteHeight }
  }

  /*
   * `setProjectAgents` stood here and is gone with the channel that called it.
   *
   * It wrote a project's cast and then reconciled every live conversation to it,
   * adding and removing participants — the fan-out that made a project's answer
   * feel authoritative while `conversation:start` was quietly using a different
   * one. The reconciliation has nothing left to reconcile: every room already
   * holds every agent, from the moment it opens.
   */

  /**
   * Deletes a project and everything it recorded, closing its open rooms first.
   *
   * **This used to refuse while any conversation was open**, and the reasoning
   * was sound: `ProjectService` cannot see running conversations, so it would
   * happily delete a record three open rooms are resolving their root through.
   * They would not notice immediately — `cwd` is already resolved and cached on
   * each one — which is what made it worth refusing. The failure arrived later
   * and somewhere else, as an agent that could not start, with no visible
   * connection to the moment the project was removed.
   *
   * **What changed is the caller, not that reasoning.** Refusing was right while
   * the only route here was a folder that had vanished, because such a project
   * cannot have started a conversation and the guard fired only for someone
   * removing a working project on purpose. Remove is now offered on any
   * project's card, where having rooms open is the normal case rather than the
   * odd one — so a refusal would be a button that errors on the projects people
   * most want to remove.
   *
   * So the rooms are closed rather than the removal refused. That is the same
   * end state the old message asked the person to produce by hand, and it keeps
   * the invariant the guard was protecting: nothing is still resolving a root
   * through a record that is about to stop existing.
   *
   * `relocateProject` keeps its refusal deliberately. Moving a project is a
   * recovery whose whole point is that the work survives, so silently closing
   * rooms to make it possible would be destroying the thing being recovered.
   */
  async forgetProject(projectId: string): Promise<{ forgotten: boolean }> {
    this.terminals.refuseShells(projectId)
    for (const starting of [...this.starting.values()]) {
      if (starting.projectId === projectId) this.cancelStarting(starting)
    }
    const open = [...this.active.values()].filter((c) => c.projectId === projectId)
    /*
     * Sequential, not `Promise.all`. Closing a conversation tears down agent
     * processes and its workbench lease, and the settled order is what the
     * supervisor's own logs are read against — a fan of parallel teardowns
     * interleaves them into something nobody can follow when one fails.
     */
    for (const conversation of open) {
      await this.closeConversation(conversation.conversationId)
    }
    if (open.length > 0) {
      this.log.info('closed rooms before removing project', {
        projectId,
        closed: open.length,
      })
    }
    /*
     * The listener goes first, and the order is the point. `forget` deletes the
     * registry row the listener's configuration was read from, so disposing
     * afterwards would release a socket whose owner is already gone — and until
     * it was released the port stayed held by a project that no longer exists
     * and can never be started again to give it up.
     */
    await this.runner.dispose(projectId)
    await this.traffic.dispose(projectId)
    this.disposeProjectShells(projectId)
    this.browserConsoles?.dispose(projectId)
    this.adbReverse.sync(this.traffic.capturingPorts())
    this.ports.editor.refreshTerminalEnv()
    return { forgotten: this.projects.forget(projectId) }
  }

  /**
   * Points a project at a different folder — the recovery for a root that moved.
   *
   * **Refused while conversations are open**, and that is the honest version of
   * the caveat `ProjectService.relocate` states rather than solves: an agent
   * session holds the working directory it was spawned with and a workbench
   * surface holds the path it connected on, and neither of them notices a
   * database write. Moving the row underneath them would leave two subsystems
   * addressing a folder that is no longer the project's, which is worse than
   * asking for the rooms to be closed. Same bargain `forgetProject` makes, for
   * the same reason.
   *
   * **The case this exists for has none open anyway.** A project whose folder
   * has vanished cannot start a conversation — that is how it came to need
   * relocating — so the refusal above is a guard on the rarer path, where
   * somebody moves a working project on purpose.
   */
  relocateProject(projectId: string, proposed: string): { root: string } {
    const open = [...this.active.values(), ...this.starting.values()].filter(
      (c) => c.projectId === projectId
    ).length
    if (open > 0) {
      throw new Error(
        `This project still has ${String(open)} open conversation${open === 1 ? '' : 's'}. Close them before moving it.`
      )
    }
    return { root: this.projects.relocate(projectId, proposed).root }
  }

  /**
   * `setProjectDirectory` was here, and its removal is Phase 2's point rather
   * than a tidy-up.
   *
   * It took a conversation and a path, appended `project.changed`, and assigned
   * `conversation.cwd`. Three things were wrong with that once a Project owns the
   * development environment. The room moved while **the agents inside it did
   * not** — they keep the working directory they were spawned with, so the
   * transcript and the shells disagreed from that moment on. Two rooms on one
   * folder could be walked apart, which is only possible because each carried its
   * own copy of the path. And it made "where is this conversation" a question
   * with a per-conversation answer, which is exactly the shape this phase
   * replaces.
   *
   * **What replaces it is `ProjectService.relocate`**, which moves the project
   * and therefore every conversation under it, in one explicit operation — and
   * which is honest that stopping and restarting what is already running against
   * the old root is the caller's job.
   *
   * `project.changed` stays in the event schema. Transcripts already contain it
   * and a reader must still render them; nothing appends it any more.
   */

  /**
   * Changes what agents may do without asking, mid-conversation.
   *
   * Every participant moves together: two agents in one room under different
   * rules would make "what may happen here" unanswerable. Recorded in the log
   * before it takes effect, so the transcript shows the widening above the
   * actions it permitted rather than below them.
   */
  setProfile(conversationId: string, profileId: string): { profileId: string } {
    const conversation = this.require(conversationId)
    const profile = profileById(profileId)
    const previous = conversation.profile

    this.store.append({
      conversationId,
      actor: 'system',
      payload: { type: 'policy.changed', profileId: profile.id, previousProfileId: previous.id },
    })

    conversation.profile = profile
    this.liveReplies.setProfile(conversationId, profile)
    for (const participant of conversation.participants.values()) {
      participant.service.setProfile(profile)
    }
    this.rememberOpen()
    this.log.info('policy changed', { conversationId, from: previous.id, to: profile.id })
    return { profileId: profile.id }
  }

  /**
   * Re-reads every live agent's account windows.
   *
   * Across conversations, not just one: the windows are the account's, so the
   * answer is the same wherever it is asked from, and asking once per session
   * would report the same number several times over.
   */
  async refreshLimits(): Promise<void> {
    const asked = new Set<AgentId>()
    const reads: Promise<void>[] = []
    for (const conversation of this.active.values()) {
      for (const [agentId, participant] of conversation.participants) {
        if (asked.has(agentId)) continue
        asked.add(agentId)
        reads.push(participant.service.refreshLimits())
      }
    }
    await Promise.allSettled(reads)
  }

  /** Interrupts every agent mid-turn; the user pressed one Stop button. */
  async interrupt(conversationId: string, agents?: readonly AgentId[]): Promise<void> {
    const conversation = this.require(conversationId)
    if (agents === undefined) {
      conversation.stopEpoch = (conversation.stopEpoch ?? 0) + 1
    } else {
      conversation.agentStopEpochs ??= new Map()
      for (const agent of agents) {
        conversation.agentStopEpochs.set(agent, (conversation.agentStopEpochs.get(agent) ?? 0) + 1)
      }
    }
    conversation.handoffEpoch += 1
    await Promise.all([
      this.liveReplies.cancel(conversationId, agents),
      ...[...conversation.participants.values()]
        .filter((p) => agents === undefined || agents.includes(p.agentId))
        .map((p) => p.service.interrupt()),
    ])
  }

  async decideApproval(
    conversationId: string,
    agentId: AgentId,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const conversation = this.require(conversationId)
    const service =
      this.liveReplies.approvalService(conversationId, agentId, approvalId) ??
      conversation.participants.get(agentId)?.service
    if (service === undefined) throw new Error(`"${agentId}" is not in this conversation`)
    await service.decideApproval(approvalId, await this.withSelection(decision, approvalId))
  }

  /**
   * Adds the line you had selected to a refusal, so "this line" has a referent.
   *
   * Refusing an edit with words is a review comment, and a review comment about
   * a line the reader cannot see is a riddle. The selection is read from the
   * editor at the moment of the refusal — the diff is still open, because the
   * card is still up.
   *
   * **The filename comes from the preview, not from the snapshot.** Both sides
   * of the diff are served on `chorus-ask:`, a scheme that resolves to no file
   * on disk, so the snapshot's own path would be an internal URI. The approval
   * already knows which file it is about.
   *
   * Silent when there is no selection, no preview or no editor: an approval can
   * be refused perfectly well without one, and a failure here must not stop the
   * refusal reaching the agent.
   */
  private async withSelection(
    decision: ApprovalDecision,
    approvalId: string
  ): Promise<ApprovalDecision> {
    if (decision.outcome !== 'deny' || decision.message.trim() === '') return decision
    const preview = this.previews.get(approvalId)
    if (preview === undefined) return decision

    try {
      const snapshot = await this.ports.editor.snapshot({
        host: LOCAL_HOST,
        root: preview.projectRoot,
      })
      if (snapshot === undefined || snapshot === null || snapshot.preview === true) return decision
      const { startLine, endLine, text } = snapshot
      if (startLine === null || endLine === null || text.trim() === '') return decision

      const where =
        startLine === endLine
          ? `${preview.path} line ${String(startLine)}`
          : `${preview.path} lines ${String(startLine)}-${String(endLine)}`
      // Quoted rather than fenced: it is a fragment of one file being pointed
      // at, and a fence would invite the agent to read it as a replacement.
      const quoted = text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
      return { ...decision, message: `${decision.message}\n\nAbout ${where}:\n${quoted}` }
    } catch {
      // A refusal that could not be decorated is still a refusal.
      return decision
    }
  }

  /**
   * Carries an answer back to the agent that asked for it.
   *
   * A sibling of `decideApproval` rather than part of it: a permission is a
   * question a rule can be given an opinion about, and what the user *wants* is
   * not — which is why the service refuses to auto-answer these and why they
   * come back through their own path.
   *
   * `timeout` is deliberately not reachable from here. The deadline belongs to
   * the orchestrator, which owns the timer; a UI that could claim a question had
   * expired would be able to say so before it had.
   */
  async answerUserInput(
    conversationId: string,
    agentId: AgentId,
    userInputId: string,
    response: UserInputResponse
  ): Promise<void> {
    const conversation = this.require(conversationId)
    const service =
      this.liveReplies.questionService(conversationId, agentId, userInputId) ??
      conversation.participants.get(agentId)?.service
    if (service === undefined) throw new Error(`"${agentId}" is not in this conversation`)
    await service.answerUserInput(userInputId, response)
  }

  /** Replays a conversation from the log — the only complete record (S3). */
  history(conversationId: string, afterSeq?: number): StoredEvent[] {
    return this.store.read(conversationId, afterSeq === undefined ? {} : { afterSeq })
  }

  /**
   * The same read, narrowed to the events the transcript draws.
   *
   * Kept beside `history` rather than replacing it: three surfaces read raw
   * history and two of them need types this filter excludes. See
   * `TRANSCRIPT_DISPOSITION` for what is excluded and why.
   */
  transcriptHistory(conversationId: string, afterSeq?: number): StoredEvent[] {
    return this.store.read(conversationId, {
      ...(afterSeq === undefined ? {} : { afterSeq }),
      types: TRANSCRIPT_TYPES,
    })
  }

  /**
   * One page of transcript: the newest `limit` rows, or the ones before
   * `beforeSeq`.
   *
   * Counted in **events, not rows**. The type filter already drops what the
   * reducer has no case for, so a page of events is a page of rows to within
   * that filter — and counting rows would mean running the reducer before the
   * query could decide where to stop, which is the work being avoided.
   */
  transcriptPage(conversationId: string, limit: number, beforeSeq?: number): StoredEvent[] {
    return this.store.readPage(conversationId, {
      limit,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      types: TRANSCRIPT_TYPES,
    })
  }

  /** Approvals, questions, who is mid-turn and what has been spent — queried. */
  transcriptState(conversationId: string): TranscriptState & {
    replies: readonly StoredEvent[]
    task: TaskBundle | null
    live: LiveState
  } {
    const replies = this.liveReplies.pendingReplies(conversationId)
    return {
      ...this.store.transcriptState(conversationId),
      replies,
      task: this.taskState(conversationId),
      live: this.store.liveState(conversationId, {
        chatRequests: replies.flatMap((event) =>
          event.payload.type === 'reply.status'
            ? [{ requestId: event.payload.requestId, agentId: event.payload.agentId }]
            : []
        ),
        ignoredItemRefPrefixes: TASK_IGNORED_ITEM_REF_PREFIXES,
      }),
    }
  }

  taskState(conversationId: string): TaskBundle | null {
    return taskBundleFrom(this.taskRecordsOf(conversationId), this.store.taskOutcomes())
  }

  closeTask(conversationId: string, taskId: string, reason: 'completed' | 'abandoned'): boolean {
    const latest = this.latestTaskOf(conversationId)
    if (latest === null || latest.closed || latest.taskId !== taskId) return false
    this.closeTaskNow(conversationId, latest.taskId, reason)
    return true
  }

  bindAssignment(conversationId: string, taskId: string): BindAssignmentResult {
    const asOfSeq = this.logPosition()
    const created = this.store.read(conversationId, {
      types: ['conversation.created'],
      limit: 1,
    })[0]
    const parent =
      created?.payload.type === 'conversation.created' ? created.payload.continuedFrom : undefined
    if (
      parent === undefined ||
      this.store.forwardedChild(parent, conversationId, asOfSeq) === null
    ) {
      return { outcome: 'refused', reason: 'not-forwarded' }
    }
    const latest = this.latestTaskOf(conversationId)
    if (latest === null) return { outcome: 'refused', reason: 'no-task' }
    if (latest.taskId !== taskId) return { outcome: 'refused', reason: 'not-latest' }
    const { current } = this.store.assignmentBinding(conversationId, asOfSeq)
    if (current?.taskId === taskId) return { outcome: 'unchanged', taskId, ref: current.ref }
    const previousTaskId = current?.taskId ?? null
    const stored = this.store.append({
      conversationId,
      actor: 'user',
      payload: { type: 'assignment.bound', taskId, previousTaskId },
    })
    if (stored === null) return { outcome: 'refused', reason: 'unavailable' }
    return {
      outcome: 'bound',
      taskId,
      previousTaskId,
      ref: { seq: stored.seq, eventId: stored.id, at: stored.createdAt },
    }
  }

  private readForwarded(parentId: string, request: TranscriptRequest, maxBytes: number): string {
    const asOfSeq = this.logPosition()
    const ignoredItemRefPrefixes = TASK_IGNORED_ITEM_REF_PREFIXES
    const childId = request.conversationId
    if (childId === undefined) {
      if (
        request.query !== undefined ||
        request.eventId !== undefined ||
        request.offset !== undefined
      ) {
        return renderForwardedRefusal(
          'query, eventId and offset are not accepted when listing forwarded conversations; pass conversationId to read one.',
          maxBytes
        )
      }
      const page = this.store.forwardedChildren(parentId, {
        skip: request.skip,
        count: request.count,
        asOfSeq,
      })
      const entries = page.children.map((child) => {
        const binding = this.store.assignmentBinding(child.conversationId, asOfSeq)
        const bound = binding.current?.taskId
        const window =
          bound === undefined ? null : this.store.taskWindow(child.conversationId, bound, asOfSeq)
        return { child, binding, window }
      })
      return renderForwardedList(page, entries, maxBytes)
    }
    const child = this.store.forwardedChild(parentId, childId, asOfSeq)
    if (child === null) {
      const readable = this.store.forwardedChildren(parentId, {
        skip: 0,
        count: FORWARDED_PAGE.fallback,
        asOfSeq,
      })
      return renderNotForwarded(childId, readable, maxBytes)
    }
    const binding = this.store.assignmentBinding(childId, asOfSeq)
    const taskId = binding.current?.taskId ?? binding.suggestion?.taskId ?? null
    const window = taskId === null ? null : this.store.taskWindow(childId, taskId, asOfSeq)
    const context: ForwardedReadContext = {
      conversationId: childId,
      taskId,
      bound: binding.current !== null,
      window,
      asOfSeq,
    }
    if (request.eventId !== undefined) {
      const record = this.store.assignmentRecord(childId, request.eventId, {
        taskIds: taskId === null ? [] : [taskId],
        window,
        asOfSeq,
        ignoredItemRefPrefixes,
      })
      return renderRecord(record, request.eventId, context, request.offset ?? 0, maxBytes)
    }
    if (request.query !== undefined) {
      const query = request.query.trim()
      if (query === '') {
        return renderForwardedRefusal(
          'The query is empty once trimmed, so nothing was searched.',
          maxBytes
        )
      }
      const page =
        window === null
          ? { matches: [], total: 0, skip: request.skip, count: request.count }
          : this.store.searchWindow(window, query, {
              skip: request.skip,
              count: request.count,
              ignoredItemRefPrefixes,
            })
      return renderSearch(page, query, context, maxBytes)
    }
    const bound = binding.current === null ? null : window
    const current = bound === null ? null : this.store.currentWork(bound)
    const records =
      bound === null || current === null
        ? null
        : this.store.taskRecordsFor(bound, { ignoredItemRefPrefixes })
    const digest = digestAssignment(
      {
        child,
        binding,
        window,
        facts: bound === null ? null : this.store.taskFacts(bound),
        observations:
          window === null
            ? null
            : this.store.windowObservations(window, { ignoredItemRefPrefixes }),
        current,
        interrupted:
          bound === null || records === null ? [] : interruptedTurns(records.events, bound.fromSeq),
      },
      asOfSeq
    )
    return renderDigest(digest, maxBytes)
  }

  private taskRecordsOf(conversationId: string): ReturnType<EventStore['taskRecords']> {
    return this.store.taskRecords(conversationId, {
      ignoredItemRefPrefixes: TASK_IGNORED_ITEM_REF_PREFIXES,
    })
  }

  private latestTaskOf(conversationId: string): {
    readonly taskId: string
    readonly originEventId: string
    readonly closed: boolean
    readonly revisions: readonly Extract<TaskPayload, { type: 'task.revised' }>[]
  } | null {
    const events = this.store.taskEvents(conversationId)
    const opened = events[0]?.payload
    if (opened?.type !== 'task.opened') return null
    const { taskId, originEventId } = opened
    const revisions: Extract<TaskPayload, { type: 'task.revised' }>[] = []
    let closed = false
    for (const event of events) {
      const { payload } = event
      if (payload.type === 'task.closed' && payload.taskId === taskId) closed = true
      if (payload.type === 'task.revised' && payload.taskId === taskId) revisions.push(payload)
    }
    return { taskId, originEventId, closed, revisions }
  }

  private workOrigin(conversationId: string, participant: Participant): TaskOrigin | null {
    if (participant.origin !== undefined) return participant.origin
    const found = this.store
      .readPage(conversationId, { limit: 50, types: ['user.message'] })
      .findLast(
        (event) =>
          event.payload.type === 'user.message' &&
          event.payload.mode !== 'discussion' &&
          event.payload.live !== true
      )
    return found === undefined ? null : { eventId: found.id, at: found.createdAt }
  }

  private openTask(participant: Participant, origin: TaskOrigin): string {
    const taskId = uuidv7()
    participant.service.recordTask({
      type: 'task.opened',
      taskId,
      originEventId: origin.eventId,
      startedAt: origin.at,
    })
    return taskId
  }

  private recordProgress(
    conversationId: string,
    agentId: AgentId,
    report: ProgressReport,
    owner: { readonly service?: ConversationService } | null
  ): ProjectToolResult {
    const participant = this.active.get(conversationId)?.participants.get(agentId)
    if (
      participant === undefined ||
      owner?.service === undefined ||
      owner.service !== participant.service
    ) {
      return {
        ok: false,
        text: 'Progress was not recorded: this session is no longer the active one for this conversation.',
      }
    }
    const validation = validateProgressReport(report)
    if (!validation.ok) {
      return {
        ok: false,
        text: `Progress was not recorded: ${validation.issues.join('; ')}`,
      }
    }
    const origin = this.workOrigin(conversationId, participant)
    const latest = this.latestTaskOf(conversationId)
    let open = latest !== null && !latest.closed ? latest : null
    if (open === null && latest !== null && latest.originEventId === origin?.eventId) {
      return {
        ok: false,
        text: 'Progress was not recorded: the task for this request is already closed. A plan for new work is recorded once the user asks for it.',
      }
    }
    let kept = false
    if (open !== null && report.scope === 'new') {
      if (origin !== null && origin.eventId !== open.originEventId) {
        this.closeTaskNow(conversationId, open.taskId, 'superseded', participant.service)
        open = null
      } else {
        kept = true
      }
    }
    if (open === null && origin === null) {
      return {
        ok: false,
        text: 'Progress was not recorded: there is no work request in this conversation to attach it to.',
      }
    }
    const taskId = open?.taskId ?? (origin === null ? null : this.openTask(participant, origin))
    if (taskId === null) {
      return { ok: false, text: 'Progress was not recorded: no task could be opened.' }
    }
    const revision = (open?.revisions.length ?? 0) + 1
    participant.service.recordTask({
      type: 'task.revised',
      taskId,
      agentId,
      revision,
      source: 'chorus',
      steps: report.steps.map(redactedStep),
      ...(report.reason === undefined ? {} : { reason: redactText(report.reason).text }),
      ...(report.parallel === undefined ? {} : { parallel: report.parallel }),
      ...(report.awaitingUser === undefined ? {} : { awaitingUser: report.awaitingUser }),
      ...(report.complete === undefined ? {} : { complete: report.complete }),
    })
    const finished = report.steps.filter(
      (step) => step.status === 'done' || step.status === 'skipped'
    ).length
    return {
      ok: true,
      text: [
        `Recorded revision ${String(revision)}: ${String(report.steps.length)} steps, ${String(finished)} finished.`,
        kept
          ? 'It stays in the current task, because the user has not asked for new work since that task began.'
          : '',
        report.complete === true
          ? 'The task closes once every agent working on it has finished its turn and its steps.'
          : '',
      ]
        .filter((line) => line !== '')
        .join(' '),
    }
  }

  private recordNativePlan(
    conversationId: string,
    agentId: AgentId,
    plan: readonly NativePlanStep[],
    service: ConversationService
  ): void {
    const participant = this.active.get(conversationId)?.participants.get(agentId)
    if (participant?.service !== service) return
    const steps = nativeProgressSteps(plan).map(redactedStep)
    if (steps.length === 0) return
    const origin = this.workOrigin(conversationId, participant)
    const latest = this.latestTaskOf(conversationId)
    const open = latest !== null && !latest.closed ? latest : null
    if (open === null && (origin === null || latest?.originEventId === origin.eventId)) return
    const own = open?.revisions.filter((revision) => revision.agentId === agentId) ?? []
    if (own.some((revision) => revision.source === 'chorus')) return
    const last = own.at(-1)
    if (last !== undefined && sameNativeSteps(last.steps, steps)) return
    const taskId = open?.taskId ?? (origin === null ? null : this.openTask(participant, origin))
    if (taskId === null) return
    service.recordTask({
      type: 'task.revised',
      taskId,
      agentId,
      revision: (open?.revisions.length ?? 0) + 1,
      source: 'native',
      steps,
    })
  }

  private settleTask(conversation: ActiveConversation): void {
    if (conversation.working.size > 0) return
    const latest = this.latestTaskOf(conversation.conversationId)
    if (latest === null || latest.closed) return
    const bundle = taskBundleFrom(this.taskRecordsOf(conversation.conversationId), [])
    const snapshot = bundle === null ? null : reduceTask(bundle, Date.now())
    if (snapshot?.taskId !== latest.taskId || !snapshot.readyToClose) return
    this.closeTaskNow(conversation.conversationId, latest.taskId, 'completed', undefined, snapshot)
  }

  private closeTaskNow(
    conversationId: string,
    taskId: string,
    reason: TaskClosedReason,
    service?: ConversationService,
    measured?: TaskSnapshot
  ): void {
    const bundle =
      measured === undefined ? taskBundleFrom(this.taskRecordsOf(conversationId), []) : null
    const snapshot = measured ?? (bundle === null ? null : reduceTask(bundle, Date.now()))
    const outcome = snapshot?.taskId === taskId ? taskOutcomeOf(snapshot) : undefined
    const payload: TaskPayload = {
      type: 'task.closed',
      taskId,
      reason,
      ...(outcome === undefined ? {} : { outcome }),
    }
    if (service !== undefined) {
      service.recordTask(payload)
      return
    }
    this.store.append({ conversationId, actor: 'system', payload })
  }

  /**
   * How far the log has got, across every conversation.
   *
   * Global rather than per-conversation, and that is what makes it safe as a
   * high-water mark: `seq` is monotonic over the whole log, so having read
   * everything for one conversation up to a global position means nothing below
   * it can still be unseen.
   */
  logPosition(): number {
    return this.store.lastSeq()
  }

  /**
   * The terminal panels, delegated straight through.
   *
   * Thin on purpose: the runtime owns the service's lifetime and knows where a
   * shell should open, and that is all it contributes. Everything else is the
   * service's, and putting logic here would be the second place to look for it.
   */
  onTerminalOutput(listener: (push: TerminalPush) => void): () => void {
    return this.terminals.subscribe(listener)
  }

  async attachTerminal(
    ref: TerminalRef,
    size?: { cols: number; rows: number }
  ): Promise<TerminalAttachment | null> {
    if (this.closing) return null
    if (ref.scope === 'session' && this.closingConversations.has(ref.conversationId)) return null
    if (
      (ref.scope === 'project' || ref.scope === 'shell') &&
      (this.closingProjects.has(ref.projectId) || this.closedProjects.has(ref.projectId))
    )
      return null
    if (ref.scope === 'shell' && this.shellRoot(ref.projectId) !== null) {
      try {
        await this.traffic.prepare(ref.projectId)
      } catch (error) {
        this.log.warn('project shell Traffic could not be prepared', {
          projectId: ref.projectId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      if (this.projectTerminalClosed(ref.projectId)) return null
    }
    return await this.terminals.attach(ref, size)
  }

  private projectTerminalClosed(projectId: string): boolean {
    return this.closing || this.closingProjects.has(projectId) || this.closedProjects.has(projectId)
  }

  detachTerminal(ref: TerminalRef, epoch: number): void {
    this.terminals.detach(ref, epoch)
  }

  /**
   * Kill a terminal on request.
   *
   * Guarded by the epoch like every other write: a `dispose` from a view that
   * has already been superseded is a stale click, and killing a shell is the
   * least recoverable thing this surface can do.
   */
  disposeTerminal(ref: TerminalRef, epoch: number): void {
    if (ref.scope === 'project') throw new Error('A project run is stopped through run:stop')
    this.terminals.disposeIfCurrent(ref, epoch)
  }

  /**
   * Kill a shell the user pointed at in a list, with no epoch to check.
   *
   * Not a weakening of the guard above — a different caller. Only the active tab
   * of a panel is mounted, so a background tab has no attachment and no epoch to
   * offer; the guard exists to stop a *superseded view* acting, and a tab strip
   * is mounted at the moment of the gesture. `dispose` on a shell that has
   * already exited is a no-op that still forgets it, so a stale click here costs
   * nothing.
   */
  killTerminal(ref: TerminalRef): void {
    if (ref.scope === 'project') throw new Error('A project run is stopped through run:stop')
    this.terminals.dispose(ref)
  }

  writeTerminal(ref: TerminalRef, epoch: number, data: string): void {
    this.terminals.write(ref, epoch, data)
  }

  resizeTerminal(ref: TerminalRef, epoch: number, cols: number, rows: number): void {
    this.terminals.resize(ref, epoch, cols, rows)
  }

  clearTerminal(ref: TerminalRef, epoch: number): void {
    this.terminals.clear(ref, epoch)
  }

  ackTerminal(ref: TerminalRef, epoch: number, seq: number): void {
    this.terminals.ack(ref, epoch, seq)
  }

  describeTerminal(ref: TerminalRef): TerminalDescription | null {
    return this.terminals.describe(ref)
  }

  trafficRegistry(): ProjectTrafficRegistry {
    return this.traffic
  }

  projectRunner(): ProjectRunner {
    return this.runner
  }

  setRunCommands(projectId: string, commands: RunCommands | null): void {
    this.projects.setRunCommands(projectId, commands)
  }

  /**
   * The device-logcat lease, and the child process behind it.
   *
   * **The registry decides who holds it** — one project at a time, and a second
   * is told `source-busy` rather than being handed lines it cannot attribute.
   * Starting and stopping `adb` stays here, because a child process is runtime's
   * business and not a project's.
   */
  selectTrafficSource(projectId: string, source: TrafficSourceShape): ProjectTrafficState {
    if (this.closingProjects.has(projectId) || this.closedProjects.has(projectId))
      throw new Error('This project is closed')
    const previousHolder = this.traffic.logcatHolder()
    const state = this.traffic.selectSource(projectId, source)
    if (state.failure !== null) return state

    const running = this.logcat.state()
    if (source.kind !== 'logcat') {
      if (previousHolder === projectId) this.logcat.stop()
    } else if (!running.running) {
      this.logcat.start(source.filters, projectId)
    } else if (running.filters !== source.filters) {
      this.logcat.stop()
      this.logcat.start(source.filters, projectId)
    }
    /*
     * Every terminal's partial line goes, which is what this reset has always
     * meant — it dropped the one buffer there was, and now there is one per
     * terminal. A discard rather than a flush: a half-line belongs to the source
     * being left, and ending it would send a line nobody typed a newline for.
     */
    this.trafficCarry.clear()
    return state
  }

  syncLegacyTraffic(): SavedTrafficConnection {
    return this.projects.syncLegacyTraffic(this.userDataPath)
  }

  legacyTraffic(): TrafficLegacy {
    const state = this.projects.trafficImport()
    return {
      completed: state.completed,
      assignedProjectId: state.assignedProjectId,
      origin: state.candidate?.origin ?? null,
      port: state.candidate?.port ?? null,
      access: state.candidate?.access ?? null,
      error: state.error,
    }
  }

  /**
   * The two halves of Keep / Start fresh.
   *
   * **Keep is deliberately unresolved.** Keeping the shared connection means the
   * reservation it holds stays held, so the candidate is left exactly as it is
   * and only Start fresh releases anything. Whether Keep should be remembered so
   * the question is not asked again is an open question in the plan, not
   * something to answer by writing a column nobody has agreed to.
   */
  decideLegacyTraffic(keep: boolean): void {
    if (keep) return
    this.projects.dismissLegacyTraffic()
  }

  async disposeProjectTraffic(projectId: string): Promise<void> {
    this.terminals.refuseShells(projectId)
    await this.runner.dispose(projectId)
    await this.traffic.dispose(projectId)
    this.disposeProjectShells(projectId)
    this.adbReverse.sync(this.traffic.capturingPorts())
    this.ports.editor.refreshTerminalEnv()
  }

  async close(): Promise<void> {
    this.closing = true
    const naming = [...this.namers.keys()].map((id) => this.disposeNamer(id))
    for (const starting of [...this.starting.values()]) this.cancelStarting(starting)
    await this.drainStartups()
    await Promise.all(naming)
    this.failedStarts.clear()
    /*
     * Refs are read here, not only when a session starts.
     *
     * Claude's real session id arrives with its first message rather than at
     * `start`, so the list written when a conversation opened holds a
     * placeholder. Quitting is the last and most accurate moment to record what
     * to resume from — without this, every restored Claude began again with no
     * memory of the conversation it was supposedly continuing.
     */
    this.rememberOpen()
    await this.runner.close()

    /*
     * Terminals first, and the global one is why this line exists.
     *
     * It belongs to no conversation, so nothing below reaches it — the same
     * shape as the aside bug recorded underneath, where separate storage was
     * right and quitting still left the processes running. `close()` on the
     * service drains both kinds.
     */
    this.terminals.close()
    this.logcat.close()
    this.adbReverse.close()
    await this.traffic.shutdown()

    /*
     * Asides are closed alongside participants, not forgotten.
     *
     * They live in their own map so nothing that walks open conversations finds
     * one — which is right, and which also meant quitting drained the main
     * services and left these running. A `DeltaBuffer` that never flushes loses
     * the tail of whatever it held, no `session.ended` is written, and the pump
     * outlives the database it writes into.
     */
    const services = [
      ...[...this.active.values()].flatMap((c) =>
        [...c.participants.values()].map((p) => p.service)
      ),
      ...[...this.asides.values()].map((a) => a.service),
    ]
    await Promise.all([
      this.liveReplies.cancel(),
      ...services.map((service) => service.close('shutdown')),
    ])
    this.asides.clear()
    this.active.clear()
    await Promise.all([...this.adapters.values()].map((a) => a.dispose()))
    await Promise.all([...this.namingCleanup])

    /*
     * Drained after the adapters are gone, not before.
     *
     * Disposing a session emits its last events, and those travel through a
     * pump nobody awaits. Closing the database first left them writing into a
     * dead handle. This waits for each pump to finish, so the log gets the end
     * of the story rather than an exception.
     */
    await Promise.all(services.map((service) => service.drain()))

    const dropped = this.store.droppedWrites()
    if (dropped > 0) this.log.warn('events arrived after the log closed', { dropped })
    this.store.close()
  }

  private startParticipant(
    agentId: AgentId,
    conversationId: string,
    sessionOpts: (resuming: boolean) => SessionOpts,
    profile: PermissionProfile,
    grants: SessionGrants,
    resumeFrom?: string,
    reopening = false,
    forkFrom?: string,
    stopped: () => boolean = () => false
  ): Promise<Participant> {
    const work = this.startParticipantOwned(
      agentId,
      conversationId,
      sessionOpts,
      profile,
      grants,
      resumeFrom,
      reopening,
      forkFrom,
      () =>
        stopped() ||
        this.closingConversations.has(conversationId) ||
        this.closingProjects.has(this.conversationProjects.get(conversationId) ?? '') ||
        this.closing
    )
    this.trackStartup(work, conversationId)
    return work
  }

  private async startParticipantOwned(
    agentId: AgentId,
    conversationId: string,
    /*
     * A factory, not an object, because only this method knows which it needs.
     *
     * Resuming strips the model — a rejoined thread already carries the one it
     * was started with, and passing today's preference would re-point a
     * conversation that already exists. But three paths inside here start
     * *fresh* while reopening: an agent with no saved thread, a past
     * conversation whose refs are deliberately empty, and a resume that failed
     * and fell back. Resolved once outside, all three started with no model at
     * all — the reopen half of the bug this phase was meant to fix.
     */
    sessionOpts: (resuming: boolean) => SessionOpts,
    profile: PermissionProfile,
    grants: SessionGrants,
    /** A provider thread to rejoin instead of starting a new one. */
    resumeFrom?: string,
    /*
     * Whether this is the app reopening the conversation.
     *
     * Not the same question as "did we have a thread to resume": an agent that
     * never spoke has no thread and is started fresh, but the app is still
     * reopening — and announcing it as somebody joining put a "claude joined" in
     * the transcript on every launch.
     */
    reopening = false,
    /*
     * A session to branch from, kept, instead of starting or resuming.
     *
     * Promotion needs the *work's* context, and Chorus's log cannot supply it —
     * `tool.completed` stores a summary capped at 120 characters, so a room
     * rebuilt from the log cannot answer a question about a file the agent read
     * (measured; see the plan's STATUS). A fork of the parent can.
     */
    forkFrom?: string,
    stopped: () => boolean = () => false
  ): Promise<Participant> {
    const adapter = this.adapters.get(agentId)
    if (adapter === undefined) throw new Error(`No adapter registered for "${agentId}"`)

    /*
     * The real door, and the one a review found standing open.
     *
     * Guarding only the command *resolvers* was not enough: `adapter.health()`
     * below runs its own `claude --version` / `codex --version` before anything
     * consults a resolver, so every path that starts an agent — reopen, start,
     * restart, addAgent, promotion, side tasks — still launched two child
     * processes under a flag whose entire purpose is that it launches none.
     *
     * Refusing here covers all of them at once, because none of them reaches a
     * provider without passing through this function.
     */
    if (readOnlyProfiling()) {
      throw new Error(`${agentId} cannot start: CHORUS_PROFILE_READONLY is set`)
    }

    const health = await adapter.health()
    if (stopped()) throw new Error(STARTUP_CANCELLED)
    if (health.state !== 'ready') {
      const detail = health.state === 'unauthenticated' ? health.hint : health.reason
      throw new Error(`${agentId} is not ready: ${detail}`)
    }

    const owner: { service?: ConversationService } = {}
    const owned = (opts: SessionOpts): SessionOpts => {
      const { note } = opts
      return {
        ...opts,
        ...(opts.progress === undefined
          ? {}
          : {
              progress: (report: ProgressReport) =>
                this.recordProgress(conversationId, agentId, report, owner),
            }),
        ...(note?.write === undefined
          ? {}
          : {
              note: {
                read: note.read,
                write: (text: string, expectedRevision: number) =>
                  this.writeAgentNote(conversationId, agentId, text, expectedRevision, owner),
              },
            }),
      }
    }

    const supervision = {
      recover: () => {
        if (stopped() || this.closing) throw new Error(STARTUP_CANCELLED)
        const conversation = this.active.get(conversationId)
        this.contextWindows.delete(`${conversationId}:${agentId}`)
        return {
          opts: owned(
            conversation === undefined
              ? sessionOpts(false)
              : this.sessionOptsFor(conversation, agentId, false)
          ),
          context: (input: string, session: AgentSession, beforeSeq?: number) => {
            const reminder = this.pinnedNote(conversationId)
            const reserved = reminder === '' ? 0 : Buffer.byteLength(reminder, 'utf8') + 2
            const continuation =
              this.continuationContext(conversationId, beforeSeq, {
                maxTotalBytes: contextBudget(input, undefined, 22_976 - reserved),
                retrieval: hasTranscript(session),
              }) ?? ''
            return [reminder, continuation].filter((part) => part !== '').join('\n\n')
          },
        }
      },
      onRecovery: (state: 'starting' | 'ready') => {
        if (stopped() || this.closing) return
        this.liveNotice(
          conversationId,
          mainT(state === 'starting' ? 'live.agentRecovering' : 'live.agentRecovered', {
            agent: agentId,
          })
        )
        if (state === 'ready') this.rememberOpen()
      },
    }

    /*
     * Resume when there is a thread to resume.
     *
     * A resumed agent still has its own reasoning about the work; a restarted
     * one has only what the transcript can tell it. Falling back rather than
     * failing, because a thread the provider has forgotten is a normal thing to
     * find after a day away — and a session that opens without its context beats
     * one that refuses to open.
     */
    const opened = await (forkFrom !== undefined
      ? (async () => {
          const opts = owned(sessionOpts(false))
          return {
            session: await SupervisedSession.fork(
              adapter,
              forkFrom,
              {
                ...opts,
                // The user's own hooks, skills and project instructions, as
                // everywhere else. A promoted room is an ordinary room.
                inherits: 'config' as const,
                // Kept, because this one is going to be saved and reopened.
                persist: true,
              },
              undefined,
              supervision
            ),
            opts,
          }
        })()
      : resumeFrom === undefined
        ? (async () => {
            const opts = owned(sessionOpts(false))
            return {
              session: await SupervisedSession.start(adapter, opts, undefined, supervision),
              opts,
            }
          })()
        : (async () => {
            const resumeOpts = owned(sessionOpts(true))
            try {
              return {
                session: await SupervisedSession.resume(
                  adapter,
                  resumeFrom,
                  resumeOpts,
                  undefined,
                  supervision
                ),
                opts: resumeOpts,
              }
            } catch (error) {
              if (error instanceof ProcessCleanupError) throw error
              if (stopped()) throw new Error(STARTUP_CANCELLED, { cause: error })
              // Fresh options on the fallback: this is now a new session, and it
              // should start with what the sheet says new sessions start with.
              const opts = owned(sessionOpts(false))
              return {
                session: await SupervisedSession.start(adapter, opts, undefined, supervision),
                opts,
              }
            }
          })())
    // The options actually used, so what is attached matches what was opened
    // rather than a second guess at which branch ran.
    const { session, opts: usedOpts } = opened
    try {
      return await this.joinParticipant({
        agentId,
        conversationId,
        adapter,
        profile,
        grants,
        health,
        reopening,
        session,
        usedOpts,
        stopped,
        owner,
      })
    } catch (error) {
      const reason = this.closing ? 'shutdown' : 'closed'
      const release = this.closeOwned(conversationId, owner.service ?? session, () =>
        owner.service === undefined ? session.close() : owner.service.close(reason)
      )
      await release.catch(() => undefined)
      throw error
    }
  }

  private async joinParticipant(join: {
    readonly agentId: AgentId
    readonly conversationId: string
    readonly adapter: AgentAdapter
    readonly profile: PermissionProfile
    readonly grants: SessionGrants
    readonly health: HealthStatus
    readonly reopening: boolean
    readonly session: SupervisedSession
    readonly usedOpts: SessionOpts
    readonly stopped: () => boolean
    readonly owner: { service?: ConversationService }
  }): Promise<Participant> {
    const {
      agentId,
      conversationId,
      adapter,
      profile,
      grants,
      health,
      reopening,
      session,
      usedOpts,
      stopped,
      owner,
    } = join
    if (stopped()) throw new Error(STARTUP_CANCELLED)
    /*
     * The preferred effort, applied once the session exists.
     *
     * Unlike the model it is not a `SessionOpts` field — the CLI takes it as a
     * settings override after the query is open — so it is a call rather than a
     * construction argument. Failing to apply a preference must not cost the
     * session, so it is awaited but not allowed to throw.
     */
    /*
     * Asked once, here, rather than when something wants to draw a picker.
     *
     * The settings sheet is the only place a model is chosen now, and it can be
     * opened with nothing running — so the list has to be collected as a side
     * effect of having a session at all, not of rendering a control. One control
     * request per participant, and the answer does not change under a running
     * CLI.
     */
    /*
     * Recorded as a state, including when the answer is nothing.
     *
     * The previous version kept the result only when it was non-empty and
     * swallowed a failure, which made an agent that offers no models
     * indistinguishable from one nobody has asked — and from one whose CLI is
     * too old to be asked. The sheet needs to tell a user which of those it is.
     */
    this.knownModelsByAgent.set(agentId, {
      status: 'loading',
      models: this.knownModelsByAgent.get(agentId)?.models ?? [],
    })
    void session
      .supportedModels()
      .then((models) => {
        this.knownModelsByAgent.set(agentId, { status: 'ready', models })
      })
      .catch((error: unknown) => {
        this.knownModelsByAgent.set(agentId, { status: 'failed', models: [] })
        this.log.warn('could not read the model catalogue', {
          agentId,
          message: error instanceof Error ? error.message : String(error),
        })
      })

    /*
     * That agent's own, for the same reason the model is. Codex's levels differ
     * per model — `ultra` exists on some and not others — so the two providers'
     * lists are not interchangeable even where they appear to overlap.
     *
     * Applied on a reopen as well as a fresh start, which is deliberately *not*
     * what the model does. A resumed thread carries its own model in the
     * provider's record, so passing one would override it; effort is not
     * recorded anywhere, so not applying it does not restore what the
     * conversation had — it silently drops to the provider default. Neither
     * choice is "what it was", and losing the preference is the worse of the
     * two. Recording effort per conversation is the real answer and is not this
     * phase.
     */
    const effort = readSettings(this.userDataPath).efforts[agentId]
    if (effort !== '') {
      await session.setEffort(effort).catch((error: unknown) => {
        this.log.warn('could not apply the preferred effort level', {
          agentId,
          message: error instanceof Error ? error.message : String(error),
        })
      })
      if (stopped()) throw new Error(STARTUP_CANCELLED)
    }

    const service = new ConversationService({
      store: this.store,
      conversationId,
      adapter,
      profile,
      grants,
      // Account state, not conversation history: it goes to the window, not the log.
      onLimits: (windows) => {
        const merged = mergeUsageWindows(this.limits.get(agentId) ?? [], windows)
        this.limits.set(agentId, merged)
        this.onLimits?.({ agentId, windows: merged })
      },
      // Conversation state, not account state: it goes to the pane that asked.
      onContextUsage: (usage) => {
        this.contextWindows.set(`${conversationId}:${agentId}`, {
          sessionRef: session.sessionRef,
          usage,
        })
        this.onContextUsage?.({ conversationId, agentId, ...usage })
      },
      /*
       * Live processes, not history — pushed to the pane like the context
       * window, and never logged.
       *
       * Passed on even when empty. The provider replaces rather than merges, so
       * an empty list is the only way anyone learns the last task finished; a
       * falsy guard here would leave the indicator stuck on forever.
       */
      onTasks: (tasks) => {
        this.backgroundWork.set(service, tasks.length)
        this.onTasks?.({ conversationId, agentId, tasks: tasks.map((task) => ({ ...task })) })
      },
      /*
       * What it says it is doing, pushed to the pane and never written down.
       *
       * `null` is forwarded like an empty task list is: it is the only thing
       * that says a compaction finished, and swallowing it would leave the
       * working line insisting on a word that stopped being true.
       */
      onActivity: (activity) => {
        if (this.active.get(conversationId)?.participants.get(agentId)?.service !== service) return
        if (this.cleanupOwners.get(conversationId)?.has(service) === true) return
        this.onActivity?.({ conversationId, agentId, activity })
      },
      // An approved plan ends the mode for the room, not just for the agent
      // whose plan it was.
      onPlanExited: () => {
        const conversation = this.active.get(conversationId)
        if (conversation !== undefined) conversation.planning = false
      },
      onPlan: (steps) => {
        this.recordNativePlan(conversationId, agentId, steps, service)
      },
      /*
       * A card was raised for a person, so work out what the edit would do.
       *
       * Fired after the queue takes the request, which is the only moment that
       * means "the verdict was `ask`" — an auto-allowed edit must not compute a
       * preview or flash a tab that closes again immediately.
       *
       * Deliberately not awaited: this runs on the synchronous path that pumps
       * provider events, and a slow filesystem must not hold the stream. The
       * preview simply arrives a moment after the card, and `EditPreviews`
       * swallows its own failures.
       */
      onApprovalQueued: (request) => {
        const room = this.active.get(conversationId)
        if (room !== undefined) {
          this.onAttention?.({
            reason: 'approval',
            conversationId,
            projectId: room.projectId,
            title: room.title,
            agentId,
            approvalId: request.id,
            kind: request.kind,
            request,
          })
        }
        if (request.kind === 'editorEdit' && this.ports.editor.previewEdit !== undefined) {
          this.editorPreviews.set(request.id, {
            root: this.agentDirectory(conversationId),
            path: request.path,
          })
          void this.ports.editor
            .previewEdit(this.editorPlace(conversationId), {
              ...editorApprovalRequest(request),
              approvalId: request.id,
            })
            .catch(() => undefined)
          return
        }
        if (request.kind !== 'fileChange') return
        const projectRoot = this.agentDirectory(conversationId)
        void this.previews
          .capture({
            request,
            projectRoot,
            propose: (approvalId, currentText) =>
              service.previewFileChange(approvalId as ApprovalId, currentText),
          })
          .then(async (preview) => {
            if (preview === null) return
            /*
             * Refused when the project has no editor open, and that is fine: the
             * card still asks and still carries the patch. The tab is the better
             * read, not the only one.
             */
            await this.ports.editor.askDiff(projectRoot, {
              approvalId: preview.approvalId,
              path: preview.path,
              before: preview.before,
              proposed: preview.proposed,
            })
          })
          .catch(() => undefined)
      },
      onQuestionQueued: (request) => {
        const room = this.active.get(conversationId)
        if (room === undefined) return
        this.onAttention?.({
          reason: 'question',
          conversationId,
          projectId: room.projectId,
          title: room.title,
          agentId,
          userInputId: request.id,
          request,
        })
      },
      /*
       * The last thing before an allowed edit is let through.
       *
       * A preflight, not a guarantee — see `EditPreviews.stillCurrent`. It runs
       * before the grant and before anything is sent to the provider, so a stale
       * approval leaves no grant behind it.
       */
      preflightApproval: async (request) => this.previews.stillCurrent(request.id),
      onApprovalSettled: (approvalId) => {
        const editorPreview = this.editorPreviews.get(approvalId)
        if (editorPreview !== undefined) {
          this.editorPreviews.delete(approvalId)
          void this.ports.editor
            .askDiff(editorPreview.root, {
              approvalId,
              path: editorPreview.path,
              before: null,
              proposed: '',
              close: true,
              revealPath: resolvePreviewPath(editorPreview.root, editorPreview.path),
            })
            .catch(() => undefined)
        }
        const preview = this.previews.release(approvalId)
        if (preview === undefined) return
        // The decision is made, so the diff describing it goes with it.
        void this.ports.editor
          .askDiff(preview.projectRoot, {
            approvalId,
            path: preview.path,
            before: null,
            proposed: '',
            close: true,
            revealPath: preview.absolutePath,
          })
          .catch(() => undefined)
      },
    })
    owner.service = service
    await service.attach(session, usedOpts, health, reopening)
    if (stopped()) throw new Error(STARTUP_CANCELLED)
    // Joining mid-conversation is not a case yet, but starting at the current
    // end of the log is what makes it one when it is.
    return { agentId, service, session, seenSeq: this.store.lastSeq() }
  }

  private isClosing(): boolean {
    return this.closing
  }

  private require(conversationId: string): ActiveConversation {
    if (this.closingConversations.has(conversationId))
      throw new Error('This chat is closing; retry its close action if cleanup failed')
    const found = this.active.get(conversationId)
    if (found !== undefined && this.closingProjects.has(found.projectId))
      throw new Error('This project is closing')
    if (found === undefined) throw new Error(`Conversation "${conversationId}" is not active`)
    return found
  }
}

/**
 * The project-first product's own database, and the clean start the plan chose.
 *
 * **`chorus.db` is not opened by this build and is not touched by it.** Phase 2
 * takes a new namespace rather than migrating the session-first schema: there is
 * no conversation migration and no compatibility parser, which is the decision
 * Mohamad accepted when he accepted a clean database. The old file stays exactly
 * where it is, at whatever `PRAGMA user_version` it reached, readable by anything
 * that wants it and loaded by nothing.
 *
 * **Left in place rather than renamed**, although the plan offered either. Not
 * opening a file is reversible by changing this constant back; renaming somebody's
 * only copy of their history on first launch is a mutation performed before anyone
 * has agreed the new product works, and "beside it, never loaded automatically" is
 * already true without it.
 *
 * The `v2` is the **product** generation, not the schema version. Schema version
 * lives in `PRAGMA user_version` and is at 4; a fresh v2 file runs all four
 * migrations at once and lands there.
 */
const DATABASE_FILE = 'chorus.v2.db'

/**
 * Opens the database, and gets out of the way if it cannot be read.
 *
 * A corrupt SQLite file would otherwise make the app unstartable — the worst
 * possible failure for a local-first tool, because the data is only here. The
 * file is moved aside rather than deleted: it is the user's history, and a
 * later `sqlite3 .recover` may still get it back.
 */
function openOrRecover(
  path: string,
  userDataPath: string
): { db: SqliteHandle; store: EventStore; recovered: string | null } {
  /**
   * A snapshot, taken by SQLite rather than by the filesystem.
   *
   * The first version of this copied the main file and then its `-wal` and
   * `-shm` in turn, which is not a snapshot: the three are copied at three
   * different moments, and nothing stops another process — Chorus has no
   * single-instance lock — writing between them. What that produces is a backup
   * that looks fine and restores to a moment that never existed.
   *
   * `VACUUM INTO` is SQLite's own answer. It writes one consistent file from a
   * live database, with no sidecars to keep in step, and it is synchronous,
   * which `migrate` requires.
   */
  /*
   * Sibling names are derived from the database's own, not from a second literal.
   * With two generations of file in one directory, a hardcoded `chorus.pre-vN.db`
   * would let a v2 snapshot land on a name that reads as the v1 database's, and
   * the one moment anybody reads these filenames is while recovering from
   * something having already gone wrong.
   */
  const stem = basename(path).replace(/\.db$/, '')

  const snapshot = (db: SqliteHandle, from: number): string => {
    const destination = join(userDataPath, `${stem}.pre-v${String(from)}.db`)
    // A leftover from an interrupted attempt would make VACUUM INTO fail.
    if (existsSync(destination)) rmSync(destination)
    // The path is ours, not a user's, but a quote in it would end the literal
    // and the rest would be executed.
    db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`)
    return destination
  }

  /*
   * Only *opening* may be treated as corruption.
   *
   * This catch used to wrap the migration too, and it recovers by renaming the
   * database aside and starting an empty one. So a disk-full or a permission
   * error while backing up — or any migration failure at all — presented as "your
   * database was unreadable", and the user's history was moved out of the way to
   * make room for nothing. A migration that cannot run has to fail loudly with
   * the database untouched.
   */
  let db: SqliteHandle
  let recovered: string | null = null
  try {
    db = openSqlite({ path })
  } catch (error) {
    if (!existsSync(path)) throw error
    const moved = join(userDataPath, `${stem}.unreadable-${String(Date.now())}.db`)
    renameSync(path, moved)
    db = openSqlite({ path })
    recovered = moved
  }

  return { db, store: EventStore.open(db, (from) => snapshot(db, from)).store, recovered }
}

/** Returns why a directory cannot be used, or null when it is fine. */
/**
 * The last piece of a path, which is what anyone calls the project.
 *
 * Falls back to the whole thing at the filesystem root, where there is no last
 * piece and "/" is a better name than nothing.
 */
function folderName(cwd: string): string {
  const name = basename(cwd)
  return name === '' ? cwd : name
}

/*
 * `describeDirectory` was here and has no callers left.
 *
 * Four places asked it whether a path was a usable directory: starting a
 * conversation, restoring one, reopening one from history, and repointing one.
 * The last no longer exists, and the other three now ask the registry instead —
 * `ProjectService.resolveAgentCwd` refuses an id nobody adopted and an adopted id
 * whose folder has gone, which is the same question asked of the thing that
 * actually owns the answer. `approveProjectRoot` performs the equivalent check
 * once, at adoption, where a person is choosing.
 */

/**
 * A window onto the log with no agents behind it.
 *
 * Set `CHORUS_PROFILE_READONLY=1` and the app opens, reads the event store and
 * renders transcripts exactly as it always does, but **starts no session and
 * launches no CLI**. It exists because the transcript's remaining cost — commit,
 * paint and retention — can only be measured in a real renderer with a real
 * conversation in it, and the only route to that was opening one for real:
 * restoring sessions and spawning the user's `claude` and `codex` against their
 * actual repositories. That is a side effect nobody should trigger to take a
 * measurement.
 *
 * **Two chokepoints, because one is not enough.** Suppressing restore stops the
 * conversations saved at quit from coming back, but the profiler has to *open*
 * one, and `conversation:reopen` starts agents by its own route. So command
 * resolution returns null as well, which is the app's existing "the CLI is not
 * installed" path — already handled everywhere, already tested, and it fails
 * closed. Belt and braces on purpose: a spawn that escapes this flag is a real
 * process against a real repository.
 *
 * Read from the environment at the call rather than cached, so a test can set
 * and clear it without reloading the module.
 */
function readOnlyProfiling(): boolean {
  return process.env['CHORUS_PROFILE_READONLY'] === '1'
}

function defaultAdapters(ports: HostPorts): Map<AgentId, AgentAdapter> {
  return new Map<AgentId, AgentAdapter>([
    // The command is resolved lazily, on first use: asking a login shell at
    // module load would delay the window for something not needed until a
    // session starts.
    ['codex', new CodexAdapter(codexOptions(ports.secrets))],
    ['claude', new ClaudeAdapter(claudeOptions(ports))],
    /*
     * The same class and the same binary, pointed elsewhere.
     *
     * **Registered unconditionally, even with no key.** Building the map is a
     * one-off at construction and `settings:write` does not rebuild it, so an
     * adapter registered only when a key happened to exist at launch would be
     * absent after the key was first saved and stale after it was rotated —
     * both needing a restart. Present-but-refusing is a state the UI already
     * knows how to draw, and `deepseekOptions` reads the key at each spawn.
     */
    ['deepseek', new ClaudeAdapter(deepseekOptions(ports.secrets))],
  ])
}

/**
 * DeepSeek through the `claude` CLI, pointed at its Anthropic-compatible
 * endpoint.
 *
 * Every variable here is from DeepSeek's own Claude Code recipe, and the four
 * model pins are not decoration: without them a subagent or an aliased model
 * resolves through DeepSeek's `claude-opus` mapping to `deepseek-v4-pro` and
 * bills at Pro rates. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is what makes the 1M
 * context usable rather than compacting at Claude's threshold.
 *
 * The key is read **at each spawn**, not captured here, which is what lets it be
 * added, rotated or removed without restarting.
 */
function deepseekOptions(secrets: SecretsPort): {
  id: AgentId
  resolveExecutable: () => Promise<ResolvedExecutable | null>
  env: { inject: () => Record<string, string> | undefined; clear: (key: string) => boolean }
  precondition: () => string | null
  models: readonly ModelChoice[]
} {
  const key = (): string | null => secrets.read('deepseek')
  return {
    id: 'deepseek',
    // The same binary as Claude's, so the same lookup answers for both.
    resolveExecutable: async () => {
      if (readOnlyProfiling()) return null
      const resolved = await resolveCommand('claude')
      if (resolved === null) return null
      return { sdkPath: sdkExecutablePath(resolved), launch: spawnSpec(resolved) }
    },
    /*
     * `clear` is `anthropicManagedEnv`, which is what the adapter used to apply
     * to every injection. It is named here because this is the only instance
     * that needs it: DeepSeek must remove an inherited `ANTHROPIC_API_KEY` it
     * never sets, since that would take precedence over the saved login and bill
     * the session to the user's own Claude account.
     */
    env: {
      inject: () => {
        const token = key()
        return token === null ? undefined : { ...deepseekEnv(token), ...serviceEnv(secrets) }
      },
      clear: anthropicManagedEnv,
    },
    precondition: () => (key() === null ? 'DeepSeek needs an API key. Add one in Settings.' : null),
    models: DEEPSEEK_MODELS,
  }
}

/**
 * `deepseek-flash` is V4.1-Flash; the `[1m]` suffix asks for the million-token
 * context. Both names are DeepSeek's, not Claude's — the endpoint maps
 * `claude-*` names on its side and an opus-shaped one bills at V4-Pro rates.
 */
const DEEPSEEK_MODEL = 'deepseek-flash'
const DEEPSEEK_LONG_CONTEXT_MODEL = 'deepseek-flash[1m]'

/**
 * DeepSeek's catalogue, stated rather than discovered.
 *
 * `supportedModels` asks the running CLI, and the CLI answers with the models
 * *Claude Code* knows about whatever provider it points at — Opus and Sonnet for
 * an endpoint that has neither. Those names are then mapped on DeepSeek's side
 * into something nobody chose, and an opus-shaped one maps to the expensive
 * route. A short published list is the honest answer.
 *
 * **Order is reading order and the first is not special.** What a session gets
 * when nobody has chosen is the `ANTHROPIC_MODEL` this adapter injects, which is
 * the 1M Flash — so "the provider's default" in the picker already *is* the top
 * entry here, and these three are overrides of it.
 *
 * No `effortLevels`: the recipe pins `CLAUDE_CODE_EFFORT_LEVEL=max` for every
 * one of them, so offering a control that changes nothing would be a lie.
 */
export const DEEPSEEK_MODELS: readonly ModelChoice[] = [
  { value: DEEPSEEK_LONG_CONTEXT_MODEL, label: 'V4.1 Flash (1M context)' },
  { value: DEEPSEEK_MODEL, label: 'V4.1 Flash' },
  /*
   * Named for what it will be. Today `deepseek-v4-pro` is routed to V4.1-Flash
   * and billed at Flash rates because no V4.1 Pro exists yet; choosing it is
   * therefore currently free of consequence and will stop being so the moment
   * DeepSeek ships one.
   */
  { value: 'deepseek-v4-pro', label: 'V4 Pro' },
]

/**
 * Every variable DeepSeek's own Claude Code recipe sets, given a key.
 *
 * Exported and pure so the recipe can be read back in a test without a keychain
 * or an Electron app behind it — the judgement is the list, and the list is the
 * thing that would silently drift from DeepSeek's docs.
 *
 * **The three `ANTHROPIC_DEFAULT_*` pins and the subagent model are not
 * decoration.** Left unset, an aliased or delegated model resolves through
 * DeepSeek's `claude-opus` mapping to `deepseek-v4-pro` and bills at Pro rates
 * for work nobody asked to be expensive.
 */
export function deepseekEnv(token: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: DEEPSEEK_LONG_CONTEXT_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_LONG_CONTEXT_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_LONG_CONTEXT_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: DEEPSEEK_MODEL,
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
  }
}

/**
 * The SDK needs an absolute path; `claude` on PATH is not enough once the app
 * runs outside a login shell, where PATH is much smaller than a terminal's.
 *
 * The same lookup as Codex's, deliberately: taking the first install that
 * happens to exist is what picked a `codex` too old to start, and there is no
 * reason `claude` cannot end up in the same state. Falls back to the SDK's own
 * lookup when nothing is found.
 *
 * **Two answers, because there are two consumers.** The SDK takes
 * `pathToClaudeCodeExecutable`, a plain string with no slot for an argument
 * prefix — `executableArgs` is flags for the JS runtime, not a command prefix —
 * so on Windows it gets the script behind the `.cmd` shim, and null when the
 * shim could not be read. The adapter's own version probe gets the spawnable
 * pair instead, because `execFile` cannot run a `.js` on Windows and handing it
 * the SDK's answer reported every npm install as unavailable.
 */
/**
 * The credentials of services an agent calls, as opposed to its own provider's.
 *
 * TypeSafe is not an agent — it has no entry in `AGENT_IDS` and no voice — so
 * this is not a provider configuration like `deepseekEnv`. It is a key put where
 * whatever the agent reaches for can find it: the TypeSafe Python SDK reads
 * `TYPESAFE_API_KEY` from the environment and every client in its docs is
 * constructed with no arguments.
 *
 * **Omitted rather than emptied when there is no key.** An empty string is a
 * *present* variable, and a caller reading one would send an empty bearer token
 * and get a 401 instead of recognising that nothing is configured.
 */
function serviceEnv(secrets: SecretsPort): Record<string, string> | undefined {
  const typesafe = secrets.read('typesafe')
  return typesafe === null ? undefined : { TYPESAFE_API_KEY: typesafe }
}

/**
 * Codex's lazy command lookup, lifted out of `defaultAdapters` so it can be
 * exercised rather than re-described.
 *
 * It used to be an inline closure, and the read-only-profiling test could only
 * reach it by copying its body — which asserts a duplicate and passes even if
 * the real one loses its guard. Naming it is what makes the test real.
 */
function codexOptions(secrets: SecretsPort): {
  resolveCommand: () => Promise<{ readonly file: string; readonly args: string[] } | null>
  env: () => Record<string, string> | undefined
} {
  return {
    resolveCommand: async () => {
      if (readOnlyProfiling()) return null
      const resolved = await resolveCommand('codex')
      return resolved === null ? null : spawnSpec(resolved)
    },
    env: () => serviceEnv(secrets),
  }
}

function claudeOptions(ports: HostPorts): {
  resolveExecutable: () => Promise<ResolvedExecutable | null>
  env: { inject: () => Record<string, string> | undefined; clear: (key: string) => boolean }
  editorEdit: EditorEditCapability
} {
  return {
    /*
     * Adds a service credential and clears nothing.
     *
     * `clear: () => false` is the whole point of the option being a pair. This
     * is the user's own Claude agent: clearing `anthropicManagedEnv` here would
     * strip their `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_*`
     * out of the agent they use most, which is what the old unconditional scrub
     * would have done the moment this instance was given any environment at all.
     */
    env: { inject: () => serviceEnv(ports.secrets), clear: () => false },
    resolveExecutable: async () => {
      if (readOnlyProfiling()) return null
      const resolved = await resolveCommand('claude')
      if (resolved === null) return null
      return { sdkPath: sdkExecutablePath(resolved), launch: spawnSpec(resolved) }
    },
    /*
     * Phase 6e. The adapter offers this to the agent as `editor_edit`; main is
     * the only layer that may implement it, because it reaches a
     * `WebContentsView` and no adapter may depend on Electron.
     *
     * The two refusal unions are the same by construction — `WorkbenchEditRefusal`
     * and `EditorEditRefusal` list the same arms — so this is a shape change and
     * not a translation. If they ever diverge the compiler says so here, which is
     * the point of not widening either to a string.
     */
    editorEdit: async (place, request) => {
      const result = await ports.editor.edit(place, request)
      return result.ok
        ? { ok: true, version: result.version }
        : { ok: false, refusal: result.refusal, message: result.message, version: result.version }
    },
  }
}

export interface Diagnostics {
  readonly bundle: string
  readonly path: string
}
