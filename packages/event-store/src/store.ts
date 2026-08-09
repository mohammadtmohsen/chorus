import { redactPayload, uuidv7 } from '@chorus/shared'
import { z } from 'zod'
import {
  ChorusEventPayload,
  SCHEMA_VERSION,
  StoredEventRow,
  type AppendInput,
  type StoredEvent,
} from './events.js'
import { migrate, type MigrationResult } from './migrations.js'
import type { Database } from './port.js'
import { applyToProjections, PROJECTION_NAMES, PROJECTION_TABLES } from './projections.js'

export interface ReadOptions {
  /** Exclusive — return events with `seq` greater than this. */
  readonly afterSeq?: number
  readonly limit?: number
  readonly types?: readonly string[]
}

/**
 * Enough to name a past conversation in a list and decide whether to reopen it.
 *
 * Not the transcript. This answers "which one was that" — the folder, when it
 * was last touched, how much was said in it — and the transcript is fetched by
 * id once one is chosen.
 */
export interface ConversationSummary {
  readonly conversationId: string
  readonly title: string
  readonly cwd: string
  /** Every agent that ever had a session in it, not only the last ones. */
  readonly agents: readonly string[]
  readonly updatedAt: number
  readonly messages: number
}

/** One aside, as the badge on its source reply needs it. */
export interface AsideSummary {
  readonly id: string
  readonly sourceEventId: string
  readonly title: string
  readonly createdAt: number
}

/** The raw shape of a `listConversations` row, before the nulls are resolved. */
interface ConversationRow {
  id: string
  title: string
  projectId: string
  updatedAt: number
  messages: number
  agents: string | null
  cwd: string | null
}

/**
 * The append-only log plus its projections.
 *
 * The invariant that everything else leans on: an append and the projection
 * updates it causes land in **one** transaction. A projection can therefore
 * never be ahead of the log, and if it drifts behind it can be rebuilt.
 */
export class EventStore {
  private readonly listeners = new Set<(events: readonly StoredEvent[]) => void>()
  /** Set by `close`, so a late write is refused rather than hitting a dead handle. */
  private closed = false
  private droppedAfterClose = 0

  private constructor(private readonly db: Database) {}

  static open(
    db: Database,
    onBeforeMigrate?: (from: number) => string | null
  ): {
    store: EventStore
    migration: MigrationResult
  } {
    const migration = migrate(db, onBeforeMigrate)
    return { store: new EventStore(db), migration }
  }

  /**
   * Notified after events are durably committed, never during the transaction.
   * A listener that ran mid-transaction could observe — or worse, act on —
   * state that a rollback then erases.
   */
  subscribe(listener: (events: readonly StoredEvent[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Validates, assigns position and time, writes, and projects — atomically.
   * `now` is injectable so tests are not at the mercy of the clock.
   */
  /**
   * Returns `null` once the store is closed.
   *
   * Agents keep talking while the app is shutting down — a session being torn
   * down still emits `turn.completed`, and its event pump is a loop nobody
   * awaits. Those writes used to reach a closed database and throw
   * "The database connection is not open" as an unhandled rejection, out of a
   * pump with no catch, which is a crash report for an app that was quitting
   * anyway.
   *
   * Refusing is the honest answer: the log's job is done, and what is being
   * dropped is the tail of a session that is ending regardless. It is counted,
   * so "we lost some" is a number rather than a shrug.
   */
  append(input: AppendInput, now: number = Date.now()): StoredEvent | null {
    if (this.closed) {
      this.droppedAfterClose += 1
      return null
    }
    const stored = this.appendInTransaction(input, now)
    this.notify([stored])
    return stored
  }

  private appendInTransaction(input: AppendInput, now: number): StoredEvent {
    /*
     * Redact before validate, and before anything touches disk.
     *
     * This is the only path into the log, which is the point: a caller cannot
     * opt out, and a payload type added later is covered structurally rather
     * than by remembering to list it (plan §4.4).
     */
    const payload = ChorusEventPayload.parse(redactPayload(input.payload).payload)
    const event = {
      id: uuidv7(),
      conversationId: input.conversationId,
      actor: input.actor,
      type: payload.type,
      payload,
      createdAt: now,
      schemaVersion: SCHEMA_VERSION,
    }

    const run = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO events (id, conversation_id, actor, type, payload, created_at, schema_ver)
           VALUES (@id, @conversationId, @actor, @type, @payload, @createdAt, @schemaVersion)`
        )
        .run({
          id: event.id,
          conversationId: event.conversationId,
          actor: event.actor,
          type: event.type,
          payload: JSON.stringify(event.payload),
          createdAt: event.createdAt,
          schemaVersion: event.schemaVersion,
        })

      const stored: StoredEvent = { ...event, seq: Number(info.lastInsertRowid) }
      applyToProjections(this.db, stored)
      this.bumpProjectionState(stored.seq)
      return stored
    })

    return run()
  }

  /** One transaction for the whole batch — used by the delta buffer's flush. */
  appendMany(inputs: readonly AppendInput[], now: number = Date.now()): StoredEvent[] {
    if (this.closed) {
      this.droppedAfterClose += inputs.length
      return []
    }
    const run = this.db.transaction(() => inputs.map((i) => this.appendInTransaction(i, now)))
    const stored = run()
    this.notify(stored)
    return stored
  }

  read(conversationId: string, options: ReadOptions = {}): StoredEvent[] {
    const clauses = ['conversation_id = @conversationId']
    const params: Record<string, unknown> = { conversationId }

    if (options.afterSeq !== undefined) {
      clauses.push('seq > @afterSeq')
      params['afterSeq'] = options.afterSeq
    }
    if (options.types !== undefined && options.types.length > 0) {
      // Inlined because SQLite has no array binding; values come from our own
      // event-type union, never from user input.
      const list = options.types.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')
      clauses.push(`type IN (${list})`)
    }

    const limit = options.limit === undefined ? '' : ` LIMIT ${String(options.limit)}`
    const rows = this.db
      .prepare(
        `SELECT seq, id, conversation_id, actor, type, payload, created_at, schema_ver
           FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq${limit}`
      )
      .all(params)

    return rows.map((r) => toStoredEvent(r))
  }

  lastSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM events').get()
    return (row as { m: number | null }).m ?? 0
  }

  /**
   * Every conversation the log has ever held, most recently active first.
   *
   * A projection query rather than a log scan: `conversations.updated_at` is
   * already touched by every append, so "what was I working on" is one indexed
   * read instead of a walk over the whole history.
   *
   * This is what makes an ended conversation findable again. Before it, the
   * transcript stayed in SQLite forever and nothing could name it — the only
   * list was the file recording which windows were open, and ending one removed
   * it from that.
   */
  listConversations(limit = 200): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.id                AS id,
                c.title             AS title,
                c.project_id        AS projectId,
                c.updated_at        AS updatedAt,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messages,
                (SELECT GROUP_CONCAT(DISTINCT s.agent_id) FROM agent_sessions s
                  WHERE s.conversation_id = c.id) AS agents,
                -- The directory it was last worked in, which can differ from the
                -- one it started in: a project.changed event moves it mid-run.
                (SELECT s2.cwd FROM agent_sessions s2 WHERE s2.conversation_id = c.id
                  ORDER BY s2.started_at DESC LIMIT 1) AS cwd
           FROM conversations c
          -- Asides are not sessions. They belong to one passage of one reply and
          -- are reached from it; listing them here would put "what did you mean
          -- by that" in the sidebar beside the work it was about.
          WHERE c.kind IS NULL
          ORDER BY c.updated_at DESC
          LIMIT @limit`
      )
      .all({ limit })

    return (rows as ConversationRow[]).map((row) => ({
      conversationId: row.id,
      title: row.title,
      // `project_id` holds the directory a conversation was created in, so it is
      // the honest fallback when no agent ever started and recorded its own.
      cwd: row.cwd ?? row.projectId,
      agents: row.agents === null || row.agents === '' ? [] : row.agents.split(','),
      updatedAt: row.updatedAt,
      messages: row.messages,
    }))
  }

  /**
   * The asides taken on one conversation, oldest first.
   *
   * By `parent_id` rather than by scanning payloads: `read` filters on
   * conversation, seq and type only, so "which asides belong to this reply" is
   * not a question the log can answer directly. That is the whole reason asides
   * are conversations with a projection row rather than events tagged with a
   * source id — the projection is what makes them findable.
   *
   * `sourceEventId` narrows to one reply, for the badge that offers to reopen
   * them; omitted, it answers for the whole conversation.
   */
  listAsides(parentId: string, sourceEventId?: string): AsideSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, source_event_id AS sourceEventId, title, created_at AS createdAt
           FROM conversations
          WHERE kind = 'aside'
            AND parent_id = @parentId
            AND (@sourceEventId IS NULL OR source_event_id = @sourceEventId)
          ORDER BY created_at ASC`
      )
      .all({ parentId, sourceEventId: sourceEventId ?? null })

    return rows as AsideSummary[]
  }

  /**
   * Drop every projection and replay the whole log.
   *
   * This is the guarantee that makes the log authoritative rather than merely
   * a nice audit trail: if a projection is corrupt, or a projector gains a bug
   * that is later fixed, the fix is a rebuild rather than a data-loss event.
   */
  rebuildProjections(): { events: number; lastSeq: number } {
    const run = this.db.transaction(() => {
      for (const table of PROJECTION_TABLES) this.db.exec(`DELETE FROM ${table}`)
      this.db.exec('DELETE FROM projection_state')

      const rows = this.db
        .prepare(
          `SELECT seq, id, conversation_id, actor, type, payload, created_at, schema_ver
             FROM events ORDER BY seq`
        )
        .all()

      let last = 0
      for (const row of rows) {
        const event = toStoredEvent(row)
        applyToProjections(this.db, event)
        last = event.seq
      }
      this.bumpProjectionState(last)
      return { events: rows.length, lastSeq: last }
    })
    return run()
  }

  /**
   * Closes sessions the log still believes are running.
   *
   * A crash leaves `session.started` with no matching `session.ended`, so on the
   * next boot the projection claims agents are alive that died with the process.
   * Reconciling is an append, not an UPDATE: the log is the record, and quietly
   * editing a projection would make the two disagree.
   */
  reconcileOrphanedSessions(now: number = Date.now()): { closed: number } {
    const rows = this.db
      .prepare(
        `SELECT conversation_id, agent_id, session_ref FROM agent_sessions WHERE status = 'active'`
      )
      .all()

    let closed = 0
    for (const row of rows) {
      const parsed = OrphanedSessionRow.safeParse(row)
      if (!parsed.success) continue
      this.append(
        {
          conversationId: parsed.data.conversation_id,
          actor: 'system',
          payload: {
            type: 'session.ended',
            agentId: parsed.data.agent_id,
            sessionRef: parsed.data.session_ref,
            reason: 'crashed',
          },
        },
        now
      )
      closed += 1
    }
    return { closed }
  }

  /** A projection behind the log means an append was interrupted mid-transaction. */
  projectionDrift(): { name: string; lastSeq: number; logSeq: number }[] {
    const logSeq = this.lastSeq()
    return PROJECTION_NAMES.map((name) => {
      const row = this.db
        .prepare('SELECT last_seq FROM projection_state WHERE name = @name')
        .get({ name })
      return { name, lastSeq: (row as { last_seq?: number } | undefined)?.last_seq ?? 0, logSeq }
    }).filter((s) => s.lastSeq !== logSeq)
  }

  /** How many writes arrived after closing; zero unless shutdown raced a turn. */
  droppedWrites(): number {
    return this.droppedAfterClose
  }

  close(): void {
    // Flagged before the handle goes, so nothing can slip between the two.
    this.closed = true
    this.db.close()
  }

  /** A throwing listener must not roll back or abort a committed append. */
  private notify(events: readonly StoredEvent[]): void {
    if (events.length === 0) return
    for (const listener of this.listeners) {
      try {
        listener(events)
      } catch {
        // Intentionally swallowed: the write already succeeded, and one bad
        // subscriber should not take down the others.
      }
    }
  }

  private bumpProjectionState(seq: number): void {
    const stmt = this.db.prepare(
      `INSERT INTO projection_state (name, last_seq) VALUES (@name, @seq)
       ON CONFLICT (name) DO UPDATE SET last_seq = excluded.last_seq`
    )
    for (const name of PROJECTION_NAMES) stmt.run({ name, seq })
  }
}

const OrphanedSessionRow = z.object({
  conversation_id: z.string(),
  agent_id: z.enum(['codex', 'claude']),
  session_ref: z.string(),
})

function toStoredEvent(row: unknown): StoredEvent {
  const parsed = StoredEventRow.parse(row)
  return {
    seq: parsed.seq,
    id: parsed.id,
    conversationId: parsed.conversation_id,
    actor: parsed.actor,
    type: parsed.type as StoredEvent['type'],
    payload: ChorusEventPayload.parse(JSON.parse(parsed.payload)),
    createdAt: parsed.created_at,
    schemaVersion: parsed.schema_ver,
  }
}
