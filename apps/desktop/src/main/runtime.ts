import { existsSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { ClaudeAdapter } from '@chorus/adapter-claude'
import { CodexAdapter } from '@chorus/adapter-codex'
import type { AgentAdapter, ApprovalDecision, SessionOpts } from '@chorus/agent-protocol'
import { EventStore, openSqlite, type SqliteHandle, type StoredEvent } from '@chorus/event-store'
import {
  composeBrief,
  ConversationService,
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
import { readOpenSessions, writeOpenSessions, type OpenSession } from './open-sessions.js'

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
}

/**
 * What a joining agent may be handed at once.
 *
 * Several times the ordinary per-turn allowance: it is paid once, and an agent
 * that has read half a conversation is worse than one that has read none, because
 * it does not know which half it is missing.
 */
const JOINING_CATCHUP_CHARS = 60_000

export interface SendResult {
  readonly targets: readonly AgentId[]
}

export class ChorusRuntime {
  private readonly active = new Map<string, ActiveConversation>()

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
  async restoreOpenConversations(): Promise<
    {
      conversationId: string
      participants: AgentId[]
      profileId: string
      cwd: string
      title: string
    }[]
  > {
    const saved = readOpenSessions(this.userDataPath)
    const restored: {
      conversationId: string
      participants: AgentId[]
      profileId: string
      cwd: string
      title: string
    }[] = []

    for (const entry of saved) {
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
      })
    }

    this.rememberOpen()
    if (restored.length > 0) this.log.info('sessions reopened', { count: restored.length })
    return restored
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
    }
    const sessionOpts = this.sessionOptsFor(conversation)

    const started = await Promise.allSettled(
      entry.agents.map(async (agentId) => {
        const ref = entry.sessionRefs[agentId]
        const participant = await this.startParticipant(
          agentId,
          entry.conversationId,
          sessionOpts,
          profile,
          grants,
          ref
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
    writeOpenSessions(
      this.userDataPath,
      [...this.active.values()].map((c) => ({
        conversationId: c.conversationId,
        agents: [...c.participants.keys()],
        cwd: c.cwd,
        profileId: c.profile.id,
        title: c.title,
        sessionRefs: Object.fromEntries(
          [...c.participants.values()].map((p) => [p.agentId, p.session.sessionRef])
        ),
      }))
    )
  }

  /** Conversations with live agents right now, newest last. */
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
    return {
      cwd: conversation.cwd,
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
    for (const conversation of this.active.values()) {
      await Promise.all([...conversation.participants.values()].map((p) => p.service.close()))
    }
    this.active.clear()
    await Promise.all([...this.adapters.values()].map((a) => a.dispose()))
    this.db.close()
  }

  private async startParticipant(
    agentId: AgentId,
    conversationId: string,
    sessionOpts: SessionOpts,
    profile: PermissionProfile,
    grants: SessionGrants,
    /** A provider thread to rejoin instead of starting a new one. */
    resumeFrom?: string
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
    const service = new ConversationService({
      store: this.store,
      conversationId,
      adapter,
      profile,
      grants,
    })
    await service.attach(session, sessionOpts, health)
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
    ['codex', new CodexAdapter()],
    ['claude', new ClaudeAdapter(claudeOptions())],
  ])
}

/**
 * The SDK needs an absolute path; `claude` on PATH is not enough once the app
 * runs outside a login shell, where PATH is much smaller than a terminal's.
 * Falls back to the SDK's own lookup when none of the usual locations exist.
 */
function claudeOptions(): { executablePath?: string } {
  const found = [
    join(homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].find((p) => existsSync(p))
  return found === undefined ? {} : { executablePath: found }
}

export interface Diagnostics {
  readonly bundle: string
  readonly path: string
}
