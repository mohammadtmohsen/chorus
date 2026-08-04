import { existsSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  type HandoffIntent,
  type HandoffSource,
  type PermissionProfile,
} from '@chorus/orchestrator'
import { newConversationId, newHandoffId, type AgentId, type Logger } from '@chorus/shared'
import { readWorkspace, type DiffFile, type WorkspaceStatus } from '@chorus/workspace'

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
}

interface ActiveConversation {
  readonly conversationId: string
  readonly participants: Map<AgentId, Participant>
  readonly profile: PermissionProfile
  readonly cwd: string
  /** Who the user last addressed, so an unaddressed follow-up stays with them. */
  lastAddressed: AgentId | undefined
}

export interface SendResult {
  readonly targets: readonly AgentId[]
}

export class ChorusRuntime {
  private readonly active = new Map<string, ActiveConversation>()

  private constructor(
    private readonly db: SqliteHandle,
    readonly store: EventStore,
    private readonly adapters: Map<AgentId, AgentAdapter>,
    readonly log: Logger
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

    return new ChorusRuntime(db, store, adapters ?? defaultAdapters(), log)
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

  async startConversation(
    options: StartConversationOptions
  ): Promise<{ conversationId: string; participants: AgentId[]; profileId: string; cwd: string }> {
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
        title: options.title ?? 'Untitled',
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
      profile,
      cwd,
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
    return {
      conversationId,
      participants: [...conversation.participants.keys()],
      profileId: profile.id,
      cwd,
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
    const route = parseMentions(text, {
      participants: [...conversation.participants.keys()],
      lastAddressed: conversation.lastAddressed,
    })

    if (route.targets.length === 0) throw new Error('No agent is available in this conversation')

    this.store.append({ conversationId, actor: 'user', payload: { type: 'user.message', text } })
    conversation.lastAddressed = route.targets.at(-1)

    // Filtered rather than optional-chained: `Promise.all` over a list that can
    // contain `undefined` is a silent no-op waiting to happen.
    await Promise.all(
      route.targets
        .map((agentId) => conversation.participants.get(agentId))
        .filter((p) => p !== undefined)
        .map((p) => p.service.deliver(route.text))
    )
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
    grants: SessionGrants
  ): Promise<Participant> {
    const adapter = this.adapters.get(agentId)
    if (adapter === undefined) throw new Error(`No adapter registered for "${agentId}"`)

    const health = await adapter.health()
    if (health.state !== 'ready') {
      const detail = health.state === 'unauthenticated' ? health.hint : health.reason
      throw new Error(`${agentId} is not ready: ${detail}`)
    }

    const session = await SupervisedSession.start(adapter, sessionOpts)
    const service = new ConversationService({
      store: this.store,
      conversationId,
      adapter,
      profile,
      grants,
    })
    await service.attach(session, sessionOpts, health)
    return { agentId, service, session }
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
