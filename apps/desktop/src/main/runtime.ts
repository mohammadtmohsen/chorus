import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAdapter } from '@chorus/adapter-claude'
import { CodexAdapter } from '@chorus/adapter-codex'
import type { AgentAdapter, ApprovalDecision, SessionOpts } from '@chorus/agent-protocol'
import { EventStore, openSqlite, type SqliteHandle, type StoredEvent } from '@chorus/event-store'
import { ConversationService, parseMentions, SupervisedSession } from '@chorus/orchestrator'
import { newConversationId, type AgentId } from '@chorus/shared'

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
}

interface Participant {
  readonly agentId: AgentId
  readonly service: ConversationService
  readonly session: SupervisedSession
}

interface ActiveConversation {
  readonly conversationId: string
  readonly participants: Map<AgentId, Participant>
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
    private readonly adapters: Map<AgentId, AgentAdapter>
  ) {}

  static open(userDataPath: string, adapters?: Map<AgentId, AgentAdapter>): ChorusRuntime {
    const db = openSqlite({ path: join(userDataPath, 'chorus.db') })
    const { store } = EventStore.open(db, (from) =>
      join(userDataPath, `chorus.pre-v${String(from)}.db`)
    )
    return new ChorusRuntime(db, store, adapters ?? defaultAdapters())
  }

  /** Push target for the renderer. Fires only after a commit. */
  subscribe(listener: (events: readonly StoredEvent[]) => void): () => void {
    return this.store.subscribe(listener)
  }

  availableAgents(): AgentId[] {
    return [...this.adapters.keys()]
  }

  async startConversation(
    options: StartConversationOptions
  ): Promise<{ conversationId: string; participants: AgentId[] }> {
    if (options.agents.length === 0) throw new Error('A conversation needs at least one agent')

    const conversationId = newConversationId()
    this.store.append({
      conversationId,
      actor: 'user',
      payload: {
        type: 'conversation.created',
        projectId: options.projectId ?? options.cwd,
        title: options.title ?? 'Untitled',
      },
    })

    const sessionOpts: SessionOpts = {
      cwd: options.cwd,
      // Read-only until the policy engine lands in M5. Starting permissive and
      // tightening later is how permissive defaults ship by accident.
      sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
    }

    // Started in parallel: two agents booting sequentially doubles the wait for
    // no reason, and one failing should not hide the other.
    const started = await Promise.allSettled(
      options.agents.map((agentId) => this.startParticipant(agentId, conversationId, sessionOpts))
    )

    const conversation: ActiveConversation = {
      conversationId,
      participants: new Map(),
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
      this.store.append({
        conversationId,
        actor: 'system',
        payload: { type: 'error.raised', message, recoverable: false },
      })
    }

    this.active.set(conversationId, conversation)
    return { conversationId, participants: [...conversation.participants.keys()] }
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
    sessionOpts: SessionOpts
  ): Promise<Participant> {
    const adapter = this.adapters.get(agentId)
    if (adapter === undefined) throw new Error(`No adapter registered for "${agentId}"`)

    const health = await adapter.health()
    if (health.state !== 'ready') {
      const detail = health.state === 'unauthenticated' ? health.hint : health.reason
      throw new Error(`${agentId} is not ready: ${detail}`)
    }

    const session = await SupervisedSession.start(adapter, sessionOpts)
    const service = new ConversationService({ store: this.store, conversationId, adapter })
    await service.attach(session, sessionOpts, health)
    return { agentId, service, session }
  }

  private require(conversationId: string): ActiveConversation {
    const found = this.active.get(conversationId)
    if (found === undefined) throw new Error(`Conversation "${conversationId}" is not active`)
    return found
  }
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
