import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { ClaudeAdapter } from '@chorus/adapter-claude'
import { CodexAdapter } from '@chorus/adapter-codex'
import type {
  AccountSummary,
  AgentAdapter,
  ApprovalDecision,
  McpServerHealth,
  ModelChoice,
  SessionOpts,
  SlashCommandInfo,
  UsageWindow,
  UserInputResponse,
} from '@chorus/agent-protocol'
import {
  EventStore,
  openSqlite,
  type AsideSummary,
  type ConversationSummary,
  type SqliteHandle,
  type StoredEvent,
} from '@chorus/event-store'
import {
  composeBrief,
  ConversationService,
  DEFAULT_PROFILE_ID,
  defaultIntent,
  parseMentions,
  profileById,
  PROFILES,
  SessionGrants,
  SupervisedSession,
  summariseHandoff,
  withCatchup,
  type HandoffIntent,
  type HandoffSource,
  type PermissionProfile,
} from '@chorus/orchestrator'
import { newConversationId, newHandoffId, type AgentId, type Logger } from '@chorus/shared'
import { readWorkspace, type DiffFile, type WorkspaceStatus } from '@chorus/workspace'
import type { ContextUsagePush, TasksPush } from '../shared/ipc.js'
import { UNREAD_EVENT_TYPES } from '../shared/unread.js'
import { readOpenSessions, writeOpenSessions, type OpenSession } from './open-sessions.js'
import { readRemembered, writeRemembered } from './remembered.js'
import { readSettings } from './settings.js'
import type { WorkspaceSnapshot } from '../shared/workspace-layout.js'
import { findExecutable } from './which.js'

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
  readonly agents: readonly AgentId[]
  readonly cwd: string
  readonly projectId?: string
  readonly title?: string
  /** Defaults to read-only. Permissive defaults ship by accident, not on purpose. */
  readonly profileId?: string
}

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
}

interface ActiveConversation {
  readonly conversationId: string
  readonly participants: Map<AgentId, Participant>
  /** Shared, so a grant given to one agent is not re-asked for the next to join. */
  readonly grants: SessionGrants
  profile: PermissionProfile
  cwd: string
  title: string
  /** Who the user last addressed, so an unaddressed follow-up stays with them. */
  lastAddressed: AgentId | undefined
  /** How far this conversation's card had been read. See `OpenSession`. */
  lastSeenSeq: number
  /** A message typed and not sent, so quitting does not lose it. */
  draft: string
  /** Reading and reasoning, executing nothing, until a plan is approved. */
  planning: boolean
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
function asideQuestion(excerpt: string, question: string): string {
  return [
    'You are being asked a short side question about something you said.',
    'Answer it and nothing else: do not continue the work, do not change files.',
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
 * What a fork is asked when someone did not follow a passage.
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
 * 190px tall and a passage of one sentence deserves an answer of three.
 *
 * The do-not-work clause is the same one `asideQuestion` carries, and for the
 * same measured reason: without it a fork treats the request as the next turn of
 * the work and starts doing things, which no permission rule catches because
 * reading files is allowed.
 */
export function explainPrompt(excerpt: string, language: string): string {
  return [
    'Someone reading this conversation did not follow the passage below.',
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
    'Explain the work the passage refers to, not how the passage is written.',
    '',
    // Two rounds of real answers taught this list. Each line is something that
    // arrived unasked and pushed the useful part off the card.
    'Leave out:',
    '- what the words mean in general, or one by one, or where they come from;',
    '- what something is *not*, or which other meaning is not intended;',
    '- anything the passage already says, restated;',
    '- remarks about this conversation, about your earlier messages, or about',
    '  what you were or were not offering to do;',
    '- background about the project or its conventions, unless the passage is',
    '  about them.',
    '',
    // Bounded by a number, because "short" drifted twice. Lists are allowed only
    // where the answer genuinely *is* a sequence — a real workflow, a real
    // ordering — and never as a way of getting more room.
    'Aim for about a hundred words. Plain paragraphs, short sentences, no headings',
    'and no closing summary. Use a short numbered list only if the answer is a',
    'sequence of steps; otherwise prose.',
    '',
    'They are a developer working on this project who has not met this particular',
    'thing before — not a beginner. Do not start from first principles.',
    '',
    'Keep identifiers, file names and paths exactly as written, in their own',
    'script. Do not translate or transliterate them.',
    '',
    `Write your explanation in ${language}. Every sentence of it — not bilingually,`,
    `and not only the first line. If you find yourself back in the passage's own`,
    `language, return to ${language}.`,
    '',
    'You have the whole conversation. Use it: say what this refers to *here*,',
    'rather than what it could mean in general.',
    '',
    // Each clause whole on its own line. A phrase split across a line break is
    // harder to read and easier to weaken by editing one half of it.
    'Do not restate the passage. Do not widen the subject.',
    'Do not continue the work or change anything. Answer this and stop.',
    '',
    excerpt
      .split('\n')
      .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
      .join('\n'),
  ].join('\n')
}

/** Long enough for a cold provider start, short enough not to look like a hang. */
const REOPEN_TIMEOUT_MS = 20_000

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
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

export class ChorusRuntime {
  private readonly active = new Map<string, ActiveConversation>()
  /**
   * Live asides, by their own conversation id.
   *
   * Separate from `active` on purpose: an aside is not a session. Nothing that
   * walks open conversations — restore, the sidebar, quit — should find one,
   * and keeping them in the same map is how they would.
   */
  private readonly asides = new Map<
    string,
    { service: ConversationService; parentId: string; excerpt: string; agentId: AgentId }
  >()
  /** Last renderer-owned editor arrangement, persisted beside the active sessions. */
  private workspaceSnapshot: WorkspaceSnapshot | null = null
  /** The latest windows each provider reported, for a window opened later. */
  private readonly limits = new Map<AgentId, readonly UsageWindow[]>()
  private onLimits: ((push: { agentId: AgentId; windows: UsageWindow[] }) => void) | undefined
  private onContextUsage: ((push: ContextUsagePush) => void) | undefined
  private onTasks: ((push: TasksPush) => void) | undefined
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

  private constructor(
    private readonly db: SqliteHandle,
    readonly store: EventStore,
    private readonly adapters: Map<AgentId, AgentAdapter>,
    readonly log: Logger,
    /** Where the note about what was open is kept, next to the log and the db. */
    private readonly userDataPath: string
  ) {}

  static open(
    userDataPath: string,
    log: Logger,
    adapters?: Map<AgentId, AgentAdapter>
  ): ChorusRuntime {
    const path = join(userDataPath, 'chorus.db')
    const { db, store, recovered } = openOrRecover(path, userDataPath)
    if (recovered !== null) log.warn('database was unreadable and was moved aside', { recovered })

    /*
     * Close sessions the log still believes are running.
     *
     * A crash leaves `session.started` with no `session.ended`, so without this
     * the app boots claiming agents are alive that died with the process — and
     * the UI would show them as live.
     */
    const { closed } = store.reconcileOrphanedSessions()
    if (closed > 0) log.warn('closed sessions orphaned by a crash', { closed })
    log.info('runtime ready', { events: store.lastSeq() })

    return new ChorusRuntime(db, store, adapters ?? defaultAdapters(), log, userDataPath)
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

  async startConversation(options: StartConversationOptions): Promise<{
    conversationId: string
    participants: AgentId[]
    profileId: string
    cwd: string
    title: string
  }> {
    if (options.agents.length === 0) throw new Error('A conversation needs at least one agent')

    /*
     * Check the directory before spawning anything.
     *
     * A missing cwd makes the spawn fail with ENOENT, and the Claude SDK
     * reports that as "the native binary failed to launch — this usually means
     * the binary does not match this system's libc". That message sent a real
     * user hunting a nonexistent architecture problem, and the supervisor then
     * retried it six times. Say what is actually wrong instead.
     */
    /*
     * An empty directory is allowed and means "start at home".
     *
     * The filesystem is not scoped to a project (§4.4), so a directory is a
     * starting point rather than a boundary — and requiring one up front asks
     * the user to decide something they can just tell the agent later.
     */
    const cwd = options.cwd.trim() === '' ? homedir() : options.cwd
    const problem = describeDirectory(cwd)
    if (problem !== null) throw new Error(problem)

    const conversationId = newConversationId()
    this.store.append({
      conversationId,
      actor: 'user',
      payload: {
        type: 'conversation.created',
        projectId: options.projectId ?? cwd,
        // The folder is what a conversation is about until you say otherwise,
        // and it is a better answer than "Untitled" for one you never rename.
        title: options.title ?? folderName(cwd),
      },
    })

    const profile = profileById(options.profileId ?? '')

    // One set of grants for the whole conversation: allowing something for
    // Codex should not mean being asked again the moment Claude does the same.
    const grants = this.newGrants()

    // Started in parallel: two agents booting sequentially doubles the wait for
    // no reason, and one failing should not hide the other.
    const started = await Promise.allSettled(
      options.agents.map((agentId) =>
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
          (resuming) => this.sessionOptsFor({ cwd, profile }, agentId, resuming),
          profile,
          grants
        )
      )
    )

    const conversation: ActiveConversation = {
      conversationId,
      participants: new Map(),
      grants,
      profile,
      cwd,
      title: options.title ?? folderName(cwd),
      lastAddressed: undefined,
      // A new room has nothing unread in it, and the log's end is what "nothing"
      // means — seeding 0 would count the whole database as news.
      lastSeenSeq: this.store.lastSeq(),
      draft: '',
      planning: false,
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

    if (conversation.participants.size === 0) {
      throw new Error(failures.join('; ') || 'No agent could be started')
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
    this.active.set(conversationId, conversation)
    this.rememberOpen()
    return {
      conversationId,
      participants: [...conversation.participants.keys()],
      profileId: profile.id,
      cwd,
      title: conversation.title,
    }
  }

  /**
   * Logs the user's message **once**, then routes it.
   *
   * Logging inside each participant would make the transcript show the user
   * repeating themselves once per agent.
   */
  async send(conversationId: string, text: string): Promise<SendResult> {
    const conversation = this.require(conversationId)
    const participants = [...conversation.participants.keys()]
    const route = parseMentions(text, {
      participants,
      lastAddressed: conversation.lastAddressed,
    })

    if (route.targets.length === 0) throw new Error('No agent is available in this conversation')

    const stored = this.store.append({
      conversationId,
      actor: 'user',
      payload: { type: 'user.message', text },
    })
    // Null only once the store is closed, which means the app is quitting.
    // Delivering a message the log has no record of would be worse than not.
    if (stored === null) throw new Error('Chorus is shutting down')
    conversation.lastAddressed = route.targets.at(-1)

    // Filtered rather than optional-chained: `Promise.all` over a list that can
    // contain `undefined` is a silent no-op waiting to happen.
    await Promise.all(
      route.targets
        .map((agentId) => conversation.participants.get(agentId))
        .filter((p) => p !== undefined)
        .map(async (p) => {
          /*
           * Read up to — not including — the message being delivered: that one
           * is the live turn, not history. Anything appended after this read
           * keeps a higher `seq` than the watermark below, so it is caught up
           * next time rather than lost.
           */
          const missed = this.store
            .read(conversationId, { afterSeq: p.seenSeq })
            .filter((e) => e.seq < stored.seq)

          /*
           * The seed goes before the user's words, once.
           *
           * It is context about what already happened, so it reads as
           * background rather than as an instruction — and it is dropped after
           * one delivery whether or not the turn succeeds, because a seed that
           * could arrive twice is worse than one that arrives late.
           */
          const seeded =
            p.seedContext === undefined ? route.text : `${p.seedContext}\n\n${route.text}`
          delete p.seedContext

          await p.service.deliver(
            withCatchup(
              {
                recipient: p.agentId,
                participants,
                events: missed,
                ...(p.catchupBudget === undefined ? {} : { maxTotalChars: p.catchupBudget }),
              },
              seeded
            )
          )
          p.seenSeq = stored.seq
          delete p.catchupBudget
        })
    )
    // Cheap, and it keeps the resume refs current if the app dies without a
    // clean quit.
    this.rememberOpen()
    return { targets: route.targets }
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
    /**
     * Why it is being opened, and therefore what the fork is first asked.
     *
     * `explanation` carries its own first turn: there is nothing for the user to
     * type, so opening and asking are one act. `question` opens empty and waits.
     */
    purpose?: 'question' | 'explanation'
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
    const parent = this.active.get(request.conversationId)
    if (parent === undefined) throw new Error('That conversation is not open')

    const source = this.store
      .read(request.conversationId)
      .find((e) => e.id === request.sourceEventId)
    if (source === undefined) throw new Error('That passage is no longer in the log')

    /*
     * Only a finished agent message. A fork inherits the session *as persisted*,
     * so it cannot see a turn still in flight — asked about a reply that is
     * still arriving it answers that no such reply exists. Measured, not assumed:
     * see the plan's STATUS.
     */
    if (source.payload.type !== 'agent.message.completed') {
      throw new Error('An aside can only be asked about a finished reply')
    }
    const said = source.payload.text
    const excerpt = request.excerpt.trim()
    if (excerpt === '' || !said.includes(excerpt)) {
      throw new Error('That passage is not part of that reply')
    }

    const agentId = source.actor
    if (agentId !== 'codex' && agentId !== 'claude') {
      throw new Error('Only an agent can be asked about what it said')
    }
    const participant = parent.participants.get(agentId)
    if (participant === undefined) throw new Error(`${agentId} is no longer in this conversation`)

    const adapter = this.adapters.get(agentId)
    if (adapter?.fork === undefined) throw new Error(`${agentId} cannot be forked`)
    if (participant.session.sessionRef === '') {
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
    const language =
      purpose === 'explanation' ? readSettings(this.userDataPath).explainLanguage : ''
    if (purpose === 'explanation' && language === '') {
      throw new Error('No language is set to explain in')
    }

    const opts: SessionOpts = {
      cwd: parent.cwd,
      sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
    }
    const forked = await adapter.fork(participant.session.sessionRef, {
      ...opts,
      // Decided with the user: the aside inherits the user's configuration, so
      // hooks, skills and CLAUDE.md load exactly as they do in the room.
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

      this.asides.set(asideId, { service, parentId: request.conversationId, excerpt, agentId })

      try {
        if (purpose === 'explanation') {
          await service.sendUserMessage(
            `Explain this in ${language}.`,
            explainPrompt(excerpt, language)
          )
        } else if (request.question !== undefined && request.question !== '') {
          await service.sendUserMessage(request.question, asideQuestion(excerpt, request.question))
        }
      } catch (error) {
        this.asides.delete(asideId)
        await service.close('closed')
        throw error
      }

      return { asideId, language }
    } catch (error) {
      // The fork is ours until an id is handed back. Nobody else can close it.
      await forked.close()
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
    await aside.service.sendUserMessage(question, asideQuestion(aside.excerpt, question))
  }

  /**
   * In flight promotions, so two clicks cannot make two permanent branches.
   *
   * Keyed by aside id and holding the promise rather than a boolean: a second
   * caller should get the same answer as the first, not a refusal and not a
   * second provider session on disk.
   */
  private readonly promoting = new Map<string, Promise<{ conversationId: string }>>()

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
  async promoteAside(asideId: string, profileId: string): Promise<{ conversationId: string }> {
    const inFlight = this.promoting.get(asideId)
    if (inFlight !== undefined) return inFlight

    const run = this.runPromotion(asideId, profileId).finally(() => {
      this.promoting.delete(asideId)
    })
    this.promoting.set(asideId, run)
    return run
  }

  private async runPromotion(
    asideId: string,
    profileId: string
  ): Promise<{ conversationId: string }> {
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
    const parent = this.active.get(aside.parentId)
    if (parent === undefined) throw new Error('The conversation this came from is no longer open')
    const { agentId } = aside
    const source = parent.participants.get(agentId)
    if (source === undefined) throw new Error(`${agentId} is no longer in that conversation`)
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
    this.asides.delete(asideId)
    await aside.service.close('closed')

    const grants = this.newGrants()
    const where = { cwd: parent.cwd, profile }
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
        source.session.sessionRef
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
      await participant.service.close('closed')
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
      grants,
      profile,
      cwd: parent.cwd,
      title: aside.excerpt.slice(0, 80),
      lastAddressed: agentId,
      lastSeenSeq: 0,
      draft: '',
      planning: false,
    }
    this.active.set(asideId, conversation)
    this.rememberOpen()
    this.log.info('aside promoted', { asideId, parentId: aside.parentId, agentId, profileId })
    return { conversationId: asideId }
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

  /** Ends an aside's fork. Its transcript stays in the log. */
  async closeAside(asideId: string): Promise<void> {
    const aside = this.asides.get(asideId)
    if (aside === undefined) return
    this.asides.delete(asideId)
    await aside.service.close('closed')
  }

  /** The asides taken on a conversation, or on one reply within it. */
  listAsides(conversationId: string, sourceEventId?: string): AsideSummary[] {
    return this.store.listAsides(conversationId, sourceEventId)
  }

  /**
   * Builds the packet that would cross to another agent — without sending it.
   *
   * The user sees and edits this before anything moves. Agents keep separate
   * contexts, so a handoff *is* the cross-agent context; composing it silently
   * would be Chorus deciding what one agent knows about another (plan §4.5).
   */
  prepareHandoff(
    conversationId: string,
    options: {
      from: AgentId
      to: AgentId
      sourceEventIds: readonly string[]
      includeDiff?: boolean
      intent?: HandoffIntent
      note?: string
    }
  ): { brief: string; intent: HandoffIntent; summary: string; sourceCount: number } {
    const conversation = this.require(conversationId)
    if (!conversation.participants.has(options.to)) {
      throw new Error(`"${options.to}" is not in this conversation`)
    }

    const sources = this.sourcesFor(conversationId, options.sourceEventIds)
    if (sources.length === 0) throw new Error('Nothing was selected to hand off')

    const intent = options.intent ?? defaultIntent(options.from, options.to)
    const diff = options.includeDiff === true ? this.latestDiff(conversationId) : undefined

    return {
      intent,
      sourceCount: sources.length,
      brief: composeBrief({
        from: options.from,
        to: options.to,
        intent,
        sources,
        cwd: conversation.cwd,
        diff,
        note: options.note,
      }),
      summary: summariseHandoff({
        from: options.from,
        to: options.to,
        intent,
        sourceCount: sources.length,
        includesDiff: diff !== undefined && diff.trim() !== '',
      }),
    }
  }

  /** Records the handoff and delivers the brief the user approved. */
  async sendHandoff(
    conversationId: string,
    options: {
      from: AgentId
      to: AgentId
      sourceEventIds: readonly string[]
      brief: string
    }
  ): Promise<{ handoffId: string }> {
    const conversation = this.require(conversationId)
    const target = conversation.participants.get(options.to)
    if (target === undefined) throw new Error(`"${options.to}" is not in this conversation`)
    if (options.brief.trim() === '') throw new Error('The brief is empty')

    const handoffId = newHandoffId()
    this.store.append({
      conversationId,
      actor: 'user',
      payload: {
        type: 'handoff.created',
        handoffId,
        from: options.from,
        to: options.to,
        sourceEventIds: [...options.sourceEventIds],
        brief: options.brief,
      },
    })

    // The receiving agent is now the one an unaddressed follow-up continues with.
    conversation.lastAddressed = options.to
    // The brief is context the user curated by hand; replaying the same events
    // as catch-up on the next message would say it all twice.
    target.seenSeq = this.store.lastSeq()
    await target.service.deliver(options.brief)
    return { handoffId }
  }

  private sourcesFor(conversationId: string, eventIds: readonly string[]): HandoffSource[] {
    const wanted = new Set(eventIds)
    const sources: HandoffSource[] = []

    for (const event of this.store.read(conversationId)) {
      if (!wanted.has(event.id)) continue
      const payload = event.payload as { text?: string }
      if (typeof payload.text !== 'string' || payload.text.trim() === '') continue
      sources.push({ eventId: event.id, actor: event.actor, text: payload.text })
    }
    return sources
  }

  /** The most recent aggregate diff, when an agent produced one. */
  private latestDiff(conversationId: string): string | undefined {
    const diffs = this.store.read(conversationId, { types: ['diff.updated'] })
    const last = diffs.at(-1)?.payload as { unifiedDiff?: string } | undefined
    return last?.unifiedDiff
  }

  /**
   * Ends one conversation, leaving every other one running.
   *
   * Removed from `active` before its agents are closed, so a message sent into
   * the gap fails loudly rather than being handed to a session on its way out.
   */
  async closeConversation(conversationId: string): Promise<void> {
    const conversation = this.require(conversationId)
    this.active.delete(conversationId)
    this.rememberOpen()

    /*
     * The conversation's asides go with it. They fork its agents and are only
     * reachable from its transcript, so a closed conversation leaving live forks
     * behind is a leak with nothing left on screen to close them from.
     */
    const orphans = [...this.asides].filter(([, a]) => a.parentId === conversationId)
    for (const [id] of orphans) this.asides.delete(id)

    await Promise.all([
      ...[...conversation.participants.values()].map((p) => p.service.close()),
      ...orphans.map(([, a]) => a.service.close()),
    ])
    this.log.info('conversation closed', {
      conversationId,
      remaining: this.active.size,
    })
  }

  /**
   * Reopens what was on screen last time.
   *
   * Called once at startup. A conversation whose directory has since been
   * deleted is dropped rather than failing the restore — the others are still
   * worth having, and the log keeps the one that could not come back.
   */
  async restoreOpenConversations(): Promise<{
    sessions: {
      conversationId: string
      participants: AgentId[]
      profileId: string
      cwd: string
      title: string
      unread: number
      draft: string
      planning: boolean
    }[]
    workspace: WorkspaceSnapshot | null
  }> {
    const savedState = readOpenSessions(this.userDataPath)
    const saved = savedState.sessions
    this.workspaceSnapshot = savedState.workspace
    const restored: {
      conversationId: string
      participants: AgentId[]
      profileId: string
      cwd: string
      title: string
      unread: number
      draft: string
      planning: boolean
    }[] = []

    for (const entry of saved) {
      // Already open: restore is called once, but calling it twice must not
      // start a second set of agents for the same conversation.
      const open = this.active.get(entry.conversationId)
      if (open !== undefined) {
        restored.push({
          conversationId: entry.conversationId,
          participants: [...open.participants.keys()],
          profileId: open.profile.id,
          cwd: open.cwd,
          title: open.title,
          unread: this.unreadSince(entry.conversationId, open.lastSeenSeq),
          draft: open.draft,
          planning: open.planning,
        })
        continue
      }
      if (describeDirectory(entry.cwd) !== null) {
        this.log.warn('a session could not be reopened', {
          conversationId: entry.conversationId,
          cwd: entry.cwd,
        })
        continue
      }
      const conversation = await this.reopen(entry)
      if (conversation === null) continue
      restored.push({
        conversationId: entry.conversationId,
        participants: [...conversation.participants.keys()],
        profileId: conversation.profile.id,
        cwd: conversation.cwd,
        title: conversation.title,
        unread: this.unreadSince(entry.conversationId, entry.lastSeenSeq),
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

  private async reopen(entry: OpenSession): Promise<ActiveConversation | null> {
    const profile = profileById(entry.profileId)
    const grants = this.newGrants()
    const conversation: ActiveConversation = {
      conversationId: entry.conversationId,
      participants: new Map(),
      grants,
      profile,
      cwd: entry.cwd,
      title: entry.title,
      lastAddressed: undefined,
      lastSeenSeq: entry.lastSeenSeq,
      draft: entry.draft,
      planning: false,
    }
    const started = await Promise.allSettled(
      entry.agents.map(async (agentId) => {
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
        const participant = await withTimeout(
          this.startParticipant(
            agentId,
            entry.conversationId,
            sessionOpts,
            profile,
            grants,
            ref,
            true
          ),
          REOPEN_TIMEOUT_MS,
          `${agentId} did not come back within ${String(Math.round(REOPEN_TIMEOUT_MS / 1000))}s`
        )
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
        }
        return participant
      })
    )

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

    if (conversation.participants.size === 0) return null
    this.active.set(entry.conversationId, conversation)
    return conversation
  }

  /** Written after anything that changes what is open, or what it is. */
  private rememberOpen(): void {
    writeOpenSessions(this.userDataPath, {
      sessions: [...this.active.values()].map((c) => ({
        conversationId: c.conversationId,
        agents: [...c.participants.keys()],
        cwd: c.cwd,
        profileId: c.profile.id,
        title: c.title,
        lastSeenSeq: c.lastSeenSeq,
        draft: c.draft,
        // Only real ones: an agent that has not spoken yet has no thread to
        // resume, and writing an empty string down makes it look like it does.
        sessionRefs: Object.fromEntries(
          [...c.participants.values()]
            .filter((p) => p.session.sessionRef.trim() !== '')
            .map((p) => [p.agentId, p.session.sessionRef])
        ),
      })),
      workspace: this.workspaceSnapshot,
    })
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

  /**
   * Starts the same room again, empty.
   *
   * A new conversation rather than a cleared one: the old transcript stays in
   * the log, where it is still the record of what happened, and the agents get
   * genuinely fresh sessions rather than a context we asked them to forget.
   * Same folder, same cast, same permissions, same name — the only thing that
   * changes is that nothing has been said yet.
   *
   * It keeps its place in the grid, because a pane that jumps to the end when
   * you restart it is a pane you then have to find again.
   */
  async restartConversation(conversationId: string): Promise<{
    conversationId: string
    participants: AgentId[]
    profileId: string
    cwd: string
    title: string
  }> {
    const existing = this.require(conversationId)
    const agents = [...existing.participants.keys()]
    const { cwd, title } = existing
    const profileId = existing.profile.id
    const order = [...this.active.keys()]

    await this.closeConversation(conversationId)
    const started = await this.startConversation({ agents, cwd, profileId, title })
    this.reorderConversations(
      order.map((id) => (id === conversationId ? started.conversationId : id))
    )
    this.log.info('conversation restarted', { from: conversationId, to: started.conversationId })
    return started
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
    return this.store.read(conversationId, {
      afterSeq: lastSeenSeq,
      types: [...UNREAD_EVENT_TYPES],
    }).length
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
      open: this.active.has(summary.conversationId),
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
  async reopenConversation(conversationId: string): Promise<{
    conversationId: string
    participants: AgentId[]
    profileId: string
    cwd: string
    title: string
    unread: number
  }> {
    const open = this.active.get(conversationId)
    if (open !== undefined) {
      return {
        conversationId,
        participants: [...open.participants.keys()],
        profileId: open.profile.id,
        cwd: open.cwd,
        title: open.title,
        unread: this.unreadSince(conversationId, open.lastSeenSeq),
      }
    }

    const summary = this.store
      .listConversations()
      .find((candidate) => candidate.conversationId === conversationId)
    if (summary === undefined) throw new Error('That conversation is not in the log.')

    const problem = describeDirectory(summary.cwd)
    if (problem !== null) throw new Error(problem)

    const agents = summary.agents.filter((id): id is AgentId => this.adapters.has(id as AgentId))
    if (agents.length === 0) throw new Error('No agent from that conversation is available.')

    const conversation = await this.reopen({
      conversationId,
      agents,
      cwd: summary.cwd,
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
      cwd: conversation.cwd,
      title: conversation.title,
      unread: 0,
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
      participants: [...c.participants.keys()],
      cwd: c.cwd,
    }))
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
    const conversation = this.require(conversationId)
    if (conversation.participants.has(agentId)) return { agentId }

    const participant = await this.startParticipant(
      agentId,
      conversationId,
      (resuming) => this.sessionOptsFor(conversation, agentId, resuming),
      conversation.profile,
      conversation.grants
    )
    participant.seenSeq = 0
    participant.catchupBudget = JOINING_CATCHUP_CHARS
    conversation.participants.set(agentId, participant)
    this.rememberOpen()
    this.log.info('agent joined', { conversationId, agentId })
    return { agentId }
  }

  /**
   * Takes an agent out without ending the conversation.
   *
   * Its session closes, which appends `session.ended` — the transcript keeps
   * everything it said, and the log explains the silence that follows.
   */
  async removeParticipant(conversationId: string, agentId: AgentId): Promise<{ agentId: AgentId }> {
    const conversation = this.require(conversationId)
    const participant = conversation.participants.get(agentId)
    if (participant === undefined) return { agentId }

    conversation.participants.delete(agentId)
    if (conversation.lastAddressed === agentId) conversation.lastAddressed = undefined
    await participant.service.close()
    this.rememberOpen()
    this.log.info('agent left', {
      conversationId,
      agentId,
      remaining: conversation.participants.size,
    })
    return { agentId }
  }

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
    where: { readonly cwd: string; readonly profile: PermissionProfile },
    agentId: AgentId,
    resuming = false
  ): SessionOpts {
    // Read at call time rather than held: changing the sheet should affect the
    // next session without the app having to be restarted.
    const preferred = resuming ? '' : this.preferredModelFor(agentId)
    return {
      cwd: where.cwd,
      ...(preferred === '' ? {} : { model: preferred }),
      sandbox:
        where.profile.id === 'read-only'
          ? { mode: 'readOnly', writableRoots: [], networkAccess: false }
          : { mode: 'workspaceWrite', writableRoots: [where.cwd], networkAccess: false },
    }
  }

  /**
   * Names a conversation.
   *
   * Recorded like everything else: a name is how you will refer to this in a
   * week, and the log is the only thing that will still have it.
   */
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
  projectDirectory(conversationId: string): string {
    return this.require(conversationId).cwd
  }

  /**
   * Points the conversation at another directory.
   *
   * This moves what *Chorus* means by the project — the review panel and the
   * handoff brief follow it. It does not move an agent's shell: those were
   * started with a working directory and keep it. The filesystem is not scoped
   * (§4.4), so the agent can work anywhere it is told to, and the change is
   * replayed as catch-up so the next one addressed is told.
   */
  setProjectDirectory(conversationId: string, cwd: string): { cwd: string; title: string } {
    const conversation = this.require(conversationId)
    const next = cwd.trim() === '' ? homedir() : cwd.trim()
    const problem = describeDirectory(next)
    if (problem !== null) throw new Error(problem)

    const previous = conversation.cwd
    if (next === previous) return { cwd: previous, title: conversation.title }

    this.store.append({
      conversationId,
      actor: 'system',
      payload: { type: 'project.changed', cwd: next, previousCwd: previous },
    })
    conversation.cwd = next
    // A title nobody has touched is still the folder's name, so it follows the
    // folder. One that was chosen deliberately is left alone.
    if (conversation.title === folderName(previous)) {
      this.renameConversation(conversationId, folderName(next))
    }
    this.rememberOpen()
    this.log.info('project directory changed', { conversationId, from: previous, to: next })
    return { cwd: next, title: conversation.title }
  }

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
  async interrupt(conversationId: string): Promise<void> {
    const conversation = this.require(conversationId)
    await Promise.all([...conversation.participants.values()].map((p) => p.service.interrupt()))
  }

  async decideApproval(
    conversationId: string,
    agentId: AgentId,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const participant = this.require(conversationId).participants.get(agentId)
    if (participant === undefined) throw new Error(`"${agentId}" is not in this conversation`)
    await participant.service.decideApproval(approvalId, decision)
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
    const participant = this.require(conversationId).participants.get(agentId)
    if (participant === undefined) throw new Error(`"${agentId}" is not in this conversation`)
    await participant.service.answerUserInput(userInputId, response)
  }

  /**
   * Reads the repository as it stands right now.
   *
   * Deliberately not derived from the event log: the log records what agents
   * *proposed*, git records what is actually on disk. After a crash, a manual
   * edit, or an approval that was denied, those differ — and the one worth
   * reviewing is the disk.
   */
  async readWorkspace(
    conversationId: string
  ): Promise<{ status: WorkspaceStatus; diff: DiffFile[]; problem: string | null }> {
    return readWorkspace({ cwd: this.require(conversationId).cwd })
  }

  /** Replays a conversation from the log — the only complete record (S3). */
  history(conversationId: string, afterSeq?: number): StoredEvent[] {
    return this.store.read(conversationId, afterSeq === undefined ? {} : { afterSeq })
  }

  async close(): Promise<void> {
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
    await Promise.all(services.map((service) => service.close('shutdown')))
    this.asides.clear()
    this.active.clear()
    await Promise.all([...this.adapters.values()].map((a) => a.dispose()))

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
    this.db.close()
  }

  private async startParticipant(
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
    forkFrom?: string
  ): Promise<Participant> {
    const adapter = this.adapters.get(agentId)
    if (adapter === undefined) throw new Error(`No adapter registered for "${agentId}"`)

    const health = await adapter.health()
    if (health.state !== 'ready') {
      const detail = health.state === 'unauthenticated' ? health.hint : health.reason
      throw new Error(`${agentId} is not ready: ${detail}`)
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
          const opts = sessionOpts(false)
          return {
            session: await SupervisedSession.fork(adapter, forkFrom, {
              ...opts,
              // The user's own hooks, skills and project instructions, as
              // everywhere else. A promoted room is an ordinary room.
              inherits: 'config' as const,
              // Kept, because this one is going to be saved and reopened.
              persist: true,
            }),
            opts,
          }
        })()
      : resumeFrom === undefined
        ? (async () => {
            const opts = sessionOpts(false)
            return { session: await SupervisedSession.start(adapter, opts), opts }
          })()
        : (async () => {
            const resumeOpts = sessionOpts(true)
            try {
              return {
                session: await SupervisedSession.resume(adapter, resumeFrom, resumeOpts),
                opts: resumeOpts,
              }
            } catch {
              // Fresh options on the fallback: this is now a new session, and it
              // should start with what the sheet says new sessions start with.
              const opts = sessionOpts(false)
              return { session: await SupervisedSession.start(adapter, opts), opts }
            }
          })())
    // The options actually used, so what is attached matches what was opened
    // rather than a second guess at which branch ran.
    const { session, opts: usedOpts } = opened
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
    }

    const service = new ConversationService({
      store: this.store,
      conversationId,
      adapter,
      profile,
      grants,
      // Account state, not conversation history: it goes to the window, not the log.
      onLimits: (windows) => {
        this.limits.set(agentId, windows)
        this.onLimits?.({ agentId, windows: [...windows] })
      },
      // Conversation state, not account state: it goes to the pane that asked.
      onContextUsage: (usage) => {
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
        this.onTasks?.({ conversationId, agentId, tasks: tasks.map((task) => ({ ...task })) })
      },
      // An approved plan ends the mode for the room, not just for the agent
      // whose plan it was.
      onPlanExited: () => {
        const conversation = this.active.get(conversationId)
        if (conversation !== undefined) conversation.planning = false
      },
    })
    await service.attach(session, usedOpts, health, reopening)
    // Joining mid-conversation is not a case yet, but starting at the current
    // end of the log is what makes it one when it is.
    return { agentId, service, session, seenSeq: this.store.lastSeq() }
  }

  private require(conversationId: string): ActiveConversation {
    const found = this.active.get(conversationId)
    if (found === undefined) throw new Error(`Conversation "${conversationId}" is not active`)
    return found
  }
}

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
  const snapshot = (db: SqliteHandle, from: number): string => {
    const destination = join(userDataPath, `chorus.pre-v${String(from)}.db`)
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
    const moved = join(userDataPath, `chorus.unreadable-${String(Date.now())}.db`)
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

function describeDirectory(cwd: string): string | null {
  if (!existsSync(cwd)) return `That directory does not exist: ${cwd}`
  try {
    if (!statSync(cwd).isDirectory()) return `That path is a file, not a directory: ${cwd}`
  } catch (error) {
    return `That directory cannot be read: ${error instanceof Error ? error.message : String(error)}`
  }
  return null
}

function defaultAdapters(): Map<AgentId, AgentAdapter> {
  return new Map<AgentId, AgentAdapter>([
    // The command is resolved lazily, on first use: asking a login shell at
    // module load would delay the window for something not needed until a
    // session starts.
    ['codex', new CodexAdapter({ resolveCommand: () => findExecutable('codex') })],
    ['claude', new ClaudeAdapter(claudeOptions())],
  ])
}

/**
 * The SDK needs an absolute path; `claude` on PATH is not enough once the app
 * runs outside a login shell, where PATH is much smaller than a terminal's.
 *
 * The same lookup as Codex's, deliberately: taking the first install that
 * happens to exist is what picked a `codex` too old to start, and there is no
 * reason `claude` cannot end up in the same state. Falls back to the SDK's own
 * lookup when nothing is found.
 */
function claudeOptions(): { resolveExecutablePath: () => Promise<string | null> } {
  return { resolveExecutablePath: () => findExecutable('claude') }
}

export interface Diagnostics {
  readonly bundle: string
  readonly path: string
}
