import { existsSync, renameSync, statSync } from 'node:fs'
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
  private readonly knownModelsByAgent = new Map<AgentId, readonly ModelChoice[]>()

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
    const sessionOpts: SessionOpts = {
      cwd,
      // The provider sandbox mirrors the profile, so we get defence in depth
      // rather than relying only on our own gate (plan §4.4).
      sandbox:
        profile.id === 'read-only'
          ? { mode: 'readOnly', writableRoots: [], networkAccess: false }
          : { mode: 'workspaceWrite', writableRoots: [cwd], networkAccess: false },
    }

    // One set of grants for the whole conversation: allowing something for
    // Codex should not mean being asked again the moment Claude does the same.
    const grants = new SessionGrants()

    // Started in parallel: two agents booting sequentially doubles the wait for
    // no reason, and one failing should not hide the other.
    const started = await Promise.allSettled(
      options.agents.map((agentId) =>
        this.startParticipant(agentId, conversationId, sessionOpts, profile, grants)
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

          await p.service.deliver(
            withCatchup(
              {
                recipient: p.agentId,
                participants,
                events: missed,
                ...(p.catchupBudget === undefined ? {} : { maxTotalChars: p.catchupBudget }),
              },
              route.text
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
    await Promise.all([...conversation.participants.values()].map((p) => p.service.close()))
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
    const grants = new SessionGrants()
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
    const sessionOpts = this.sessionOptsFor(conversation)

    const started = await Promise.allSettled(
      entry.agents.map(async (agentId) => {
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
        participant.commands ??= await participant.session.supportedCommands()
        return participant.commands
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
  knownModels(): { agentId: AgentId; models: ModelChoice[] }[] {
    return [...this.knownModelsByAgent].map(([agentId, models]) => ({
      agentId,
      models: [...models],
    }))
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
      this.sessionOptsFor(conversation),
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
  private sessionOptsFor(conversation: ActiveConversation): SessionOpts {
    // A default, read at start rather than held: changing it in the sheet
    // should affect the next session without the app having to be restarted.
    const preferred = readSettings(this.userDataPath).model
    return {
      cwd: conversation.cwd,
      ...(preferred === '' ? {} : { model: preferred }),
      sandbox:
        conversation.profile.id === 'read-only'
          ? { mode: 'readOnly', writableRoots: [], networkAccess: false }
          : { mode: 'workspaceWrite', writableRoots: [conversation.cwd], networkAccess: false },
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

    const services = [...this.active.values()].flatMap((c) =>
      [...c.participants.values()].map((p) => p.service)
    )
    await Promise.all(services.map((service) => service.close('shutdown')))
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
    sessionOpts: SessionOpts,
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
    reopening = false
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
    const session = await (resumeFrom === undefined
      ? SupervisedSession.start(adapter, sessionOpts)
      : SupervisedSession.resume(adapter, resumeFrom, sessionOpts).catch(() =>
          SupervisedSession.start(adapter, sessionOpts)
        ))
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
    void session
      .supportedModels()
      .then((models) => {
        if (models.length > 0) this.knownModelsByAgent.set(agentId, models)
      })
      .catch(() => {
        // A CLI that cannot be asked simply offers no choice in the sheet.
      })

    const effort = readSettings(this.userDataPath).effortLevel
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
    await service.attach(session, sessionOpts, health, reopening)
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
  const backupFor = (from: number): string => join(userDataPath, `chorus.pre-v${String(from)}.db`)

  try {
    const db = openSqlite({ path })
    return { db, store: EventStore.open(db, backupFor).store, recovered: null }
  } catch (error) {
    if (!existsSync(path)) throw error

    const moved = join(userDataPath, `chorus.unreadable-${String(Date.now())}.db`)
    renameSync(path, moved)
    const db = openSqlite({ path })
    return { db, store: EventStore.open(db, backupFor).store, recovered: moved }
  }
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
