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
