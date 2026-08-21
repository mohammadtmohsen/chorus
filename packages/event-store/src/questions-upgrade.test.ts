import { describe, expect, it } from 'vitest'
import { EventStore } from './store.js'
import { MIGRATIONS } from './migrations.js'
import { openSqlite } from './sqlite.js'

/**
 * The `questions` projection surviving an upgrade, which it did not at first.
 *
 * **A new projection starts empty, and nothing rebuilds projections on
 * startup** — `EventStore.open` runs `migrate()` and returns. The paged
 * transcript reads pending questions from this table rather than by folding the
 * log, so without a backfill an upgraded database would show *no* question an
 * agent was already waiting on: no card, no error, and every test passing
 * because a fresh database has nothing to lose. Found in review.
 *
 * These build a genuine pre-v3 database — schema at v2, events already in it —
 * and then open it the way the app does.
 */
function preV3(): ReturnType<typeof openSqlite> {
  const db = openSqlite({ path: ':memory:' })
  for (const migration of MIGRATIONS.filter((m) => m.version <= 2)) {
    db.exec(migration.up)
  }
  db.exec('PRAGMA user_version = 2')
  return db
}

/**
 * A v2 database as the app would actually have left one: events in it, and every
 * projection's high-water mark caught up to the last of them.
 *
 * **Seeding this is what makes the drift assertion able to fail.** A fixture that
 * inserts events and leaves `projection_state` empty reports every projection at
 * 0, so `projectionDrift()` is non-empty before and after the upgrade and a
 * missing row for `questions` is invisible in the noise.
 */
function catchUpProjections(db: ReturnType<typeof openSqlite>): void {
  const last = (db.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number | null })
    .seq
  const stmt = db.prepare(
    `INSERT INTO projection_state (name, last_seq) VALUES (@name, @seq)
     ON CONFLICT (name) DO UPDATE SET last_seq = excluded.last_seq`
  )
  // The five that existed at v2 — deliberately not PROJECTION_NAMES, which now
  // includes `questions` and would seed the very row this is testing for.
  for (const name of ['conversations', 'messages', 'agent_sessions', 'approvals', 'handoffs']) {
    stmt.run({ name, seq: last ?? 0 })
  }
}

/** An event written the way the store writes one, without the store. */
function put(
  db: ReturnType<typeof openSqlite>,
  seq: number,
  type: string,
  payload: unknown,
  actor = 'codex'
): void {
  db.prepare(
    `INSERT INTO events (seq, id, conversation_id, actor, type, payload, created_at, schema_ver)
     VALUES (@seq, @id, 'c1', @actor, @type, @payload, @createdAt, 1)`
  ).run({
    seq,
    id: `e${String(seq)}`,
    actor,
    type,
    payload: JSON.stringify(payload),
    createdAt: 1_000 + seq,
  })
}

describe('upgrading a database that already holds questions', () => {
  it('carries a pending question across the upgrade', () => {
    const db = preV3()
    put(db, 1, 'userinput.requested', {
      type: 'userinput.requested',
      userInputId: 'q1',
      request: { questions: [{ id: 'f1', header: 'Which', question: 'Pick' }] },
      expiresAt: 4_242,
    })

    const { store, migration } = EventStore.open(db)
    expect(migration.from).toBe(2)

    const state = store.transcriptState('c1')
    expect(state.questions.map((q) => q.userInputId)).toEqual(['q1'])
    expect(state.questions[0]?.expiresAt).toBe(4_242)
    // The event id is carried because an aside has to name one, and losing it
    // would break Explain on a restored card rather than losing the card.
    expect(state.questions[0]?.eventId).toBe('e1')
  })

  it('records the projection as caught up, not as 249,000 events behind', () => {
    /*
     * `questions` is in `PROJECTION_NAMES`, so `projectionDrift()` asks for its
     * high-water row. The backfill reads the whole log; without a matching
     * `projection_state` row the projection reads as sequence 0 and the drift
     * check reports a table that is in fact completely up to date — until the
     * next append bumps every projection at once and the symptom disappears on
     * its own, which is the worst way for a consistency check to behave.
     */
    const db = preV3()
    put(db, 1, 'userinput.requested', {
      type: 'userinput.requested',
      userInputId: 'q1',
      request: {},
      expiresAt: 9,
    })
    put(db, 2, 'user.message', { type: 'user.message', text: 'hello' })
    catchUpProjections(db)

    const { store } = EventStore.open(db)
    expect(store.projectionDrift()).toEqual([])
  })

  it('does not resurrect a question that was already answered', () => {
    const db = preV3()
    put(db, 1, 'userinput.requested', {
      type: 'userinput.requested',
      userInputId: 'q1',
      request: {},
      expiresAt: 1,
    })
    put(db, 2, 'userinput.answered', {
      type: 'userinput.answered',
      userInputId: 'q1',
      outcome: 'answered',
      answers: [],
      answeredBy: 'user',
    })

    const { store } = EventStore.open(db)
    expect(store.transcriptState('c1').questions).toEqual([])
  })

  it('keeps the request, so the restored card has something to draw', () => {
    const db = preV3()
    put(db, 1, 'userinput.requested', {
      type: 'userinput.requested',
      userInputId: 'q1',
      request: { questions: [{ id: 'f1' }] },
      expiresAt: 9,
    })

    const { store } = EventStore.open(db)
    const request = store.transcriptState('c1').questions[0]?.request as {
      questions?: { id: string }[]
    }
    expect(request.questions?.[0]?.id).toBe('f1')
  })

  it('survives a payload with no request at all', () => {
    // The column is NOT NULL, and `json_extract` yields NULL for a missing key —
    // an unguarded backfill fails the whole migration on one malformed old row.
    const db = preV3()
    put(db, 1, 'userinput.requested', { type: 'userinput.requested', userInputId: 'q1' })

    const { store } = EventStore.open(db)
    expect(store.transcriptState('c1').questions.map((q) => q.userInputId)).toEqual(['q1'])
  })

  it('is idempotent, so reopening does not double-insert', () => {
    const db = preV3()
    put(db, 1, 'userinput.requested', {
      type: 'userinput.requested',
      userInputId: 'q1',
      request: {},
      expiresAt: 9,
    })

    const { store } = EventStore.open(db)
    expect(store.transcriptState('c1').questions).toHaveLength(1)
    // Second open: migrations are already applied and must not run again.
    const again = EventStore.open(db)
    expect(again.migration.applied).toEqual([])
    expect(again.store.transcriptState('c1').questions).toHaveLength(1)
  })

  it('continues to record questions asked after the upgrade', () => {
    // The backfill must not be the only thing that ever writes here.
    const db = preV3()
    const { store } = EventStore.open(db)
    store.append({
      conversationId: 'c1',
      actor: 'codex',
      payload: {
        type: 'userinput.requested',
        userInputId: 'q2',
        request: {},
        expiresAt: 9,
      },
    })
    expect(store.transcriptState('c1').questions.map((q) => q.userInputId)).toEqual(['q2'])
  })
})
