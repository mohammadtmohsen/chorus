import { join } from 'node:path'
import { CodexAdapter } from '@chorus/adapter-codex'
import type { AgentAdapter, ApprovalDecision } from '@chorus/agent-protocol'
import { EventStore, openSqlite, type StoredEvent, type SqliteHandle } from '@chorus/event-store'
import { ConversationService, SupervisedSession } from '@chorus/orchestrator'
import { newConversationId, type AgentId, type ApprovalId } from '@chorus/shared'

/**
 * Wires the domain to a real agent inside the main process.
 *
 * The orchestrator packages know nothing about Electron; this file is where the
 * dependency direction turns around (plan §3.2). It owns the single SQLite
 * handle, which is why every write funnels through here — SQLite is
 * single-writer, and centralising that removes a whole class of lock contention.
 */

export interface StartConversationOptions {
  readonly agentId: AgentId
  readonly cwd: string
  readonly projectId?: string
  readonly title?: string
}

interface ActiveConversation {
  readonly conversationId: string
  readonly service: ConversationService
  readonly session: SupervisedSession
}

export class ChorusRuntime {
  private readonly active = new Map<string, ActiveConversation>()

  private constructor(
    private readonly db: SqliteHandle,
    readonly store: EventStore,
    private readonly adapters: Map<AgentId, AgentAdapter>
  ) {}

  static open(userDataPath: string, adapters?: Map<AgentId, AgentAdapter>): ChorusRuntime {
    const path = join(userDataPath, 'chorus.db')
    const db = openSqlite({ path })

    // Snapshot before any migration that touches an existing database. S4
    // confirmed backup() is async, so the hook records the intended path and
    // the copy is taken separately — the migration itself stays synchronous.
    const { store } = EventStore.open(db, (from) =>
      join(userDataPath, `chorus.pre-v${String(from)}.db`)
    )

    return new ChorusRuntime(db, store, adapters ?? new Map([['codex', new CodexAdapter()]]))
  }

  /** Push target for the renderer. Fires only after a commit. */
  subscribe(listener: (events: readonly StoredEvent[]) => void): () => void {
    return this.store.subscribe(listener)
  }

  async startConversation(options: StartConversationOptions): Promise<{ conversationId: string }> {
    const adapter = this.adapters.get(options.agentId)
    if (adapter === undefined) throw new Error(`No adapter registered for "${options.agentId}"`)

    const health = await adapter.health()
    if (health.state !== 'ready') {
      const detail = health.state === 'unauthenticated' ? health.hint : health.reason
      throw new Error(`${options.agentId} is not ready: ${detail}`)
    }

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

    const sessionOpts = {
      cwd: options.cwd,
      // Read-only until the policy engine lands in M5. Starting permissive and
      // tightening later is how permissive defaults ship by accident.
      sandbox: { mode: 'readOnly' as const, writableRoots: [], networkAccess: false },
    }

    const session = await SupervisedSession.start(adapter, sessionOpts)
    const service = new ConversationService({ store: this.store, conversationId, adapter })
    await service.attach(session, sessionOpts, health)

    this.active.set(conversationId, { conversationId, service, session })
    return { conversationId }
  }

  async send(conversationId: string, text: string): Promise<void> {
    await this.require(conversationId).service.sendUserMessage(text)
  }

  async interrupt(conversationId: string): Promise<void> {
    await this.require(conversationId).service.interrupt()
  }

  async decideApproval(
    conversationId: string,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    await this.require(conversationId).session.respondToApproval(approvalId as ApprovalId, decision)
  }

  /** Replays a conversation from the log — the only source of truth (S3). */
  history(conversationId: string, afterSeq?: number): StoredEvent[] {
    return this.store.read(conversationId, afterSeq === undefined ? {} : { afterSeq })
  }

  async close(): Promise<void> {
    await Promise.all([...this.active.values()].map((c) => c.service.close()))
    this.active.clear()
    await Promise.all([...this.adapters.values()].map((a) => a.dispose()))
    this.db.close()
  }

  private require(conversationId: string): ActiveConversation {
    const found = this.active.get(conversationId)
    if (found === undefined) throw new Error(`Conversation "${conversationId}" is not active`)
    return found
  }
}
