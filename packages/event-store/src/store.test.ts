import { beforeEach, describe, expect, it } from 'vitest'
import { currentVersion } from './migrations.js'
import { openSqlite, type SqliteHandle } from './sqlite.js'
import { EventStore } from './store.js'

const CONV = 'conv-1'

let db: SqliteHandle
let store: EventStore

function messages(): { item_ref: string; content: string; status: string; actor: string }[] {
  return db
    .prepare('SELECT item_ref, content, status, actor FROM messages ORDER BY seq')
    .all() as never
}

beforeEach(() => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  store.append(
    {
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'conversation.created', projectId: 'p1', title: 'Spike' },
    },
    1000
  )
})

describe('migrations', () => {
  it('brings a fresh database to the current version', () => {
    expect(currentVersion(db)).toBe(1)
  })

  it('is idempotent — reopening applies nothing', () => {
    const { migration } = EventStore.open(db)
    expect(migration.applied).toEqual([])
    expect(migration.from).toBe(migration.to)
  })

  it('does not snapshot a database that had no prior version', () => {
    const fresh = openSqlite({ path: ':memory:' })
    let called = false
    const { migration } = EventStore.open(fresh, () => {
      called = true
      return '/tmp/backup.db'
    })
    expect(called).toBe(false)
    expect(migration.backedUpTo).toBeNull()
    fresh.close()
  })
})

describe('append', () => {
  it('rejects a payload that does not match its schema', () => {
    expect(() =>
      store.append({
        conversationId: CONV,
        actor: 'codex',
        // A delta with no text is meaningless and must not reach the log.
        payload: { type: 'agent.message.delta', itemRef: 'i1' } as never,
      })
    ).toThrow()
  })

  it('assigns strictly increasing seq', () => {
    const a = store.append({
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'user.message', text: 'one' },
    })
    const b = store.append({
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'user.message', text: 'two' },
    })
    expect(b.seq).toBeGreaterThan(a.seq)
    expect(store.lastSeq()).toBe(b.seq)
  })

  it('records the CLI version on session.started', () => {
    store.append({
      conversationId: CONV,
      actor: 'system',
      payload: {
        type: 'session.started',
        agentId: 'codex',
        sessionRef: 'thr_1',
        cwd: '/tmp/x',
        model: 'gpt-5.6-sol',
        cliVersion: '0.146.0',
      },
    })
    const row = db.prepare('SELECT cli_version, status FROM agent_sessions').get()
    expect(row).toMatchObject({ cli_version: '0.146.0', status: 'active' })
  })
})

describe('message projection', () => {
  it('stitches a run of deltas into a single message row', () => {
    for (const text of ['Hel', 'lo ', 'world']) {
      store.append({
        conversationId: CONV,
        actor: 'claude',
        payload: { type: 'agent.message.delta', itemRef: 'm1', text },
      })
    }
    const rows = messages()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ content: 'Hello world', status: 'streaming', actor: 'claude' })
  })

  it('replaces accumulated deltas with the final text rather than appending', () => {
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: { type: 'agent.message.delta', itemRef: 'm1', text: 'par' },
    })
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: { type: 'agent.message.completed', itemRef: 'm1', text: 'partial then final' },
    })
    const rows = messages()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe('partial then final')
    expect(rows[0]?.status).toBe('complete')
  })

  it('keeps a completed message even if no deltas preceded it', () => {
    store.append({
      conversationId: CONV,
      actor: 'codex',
      payload: { type: 'agent.message.completed', itemRef: 'm9', text: 'no streaming happened' },
    })
    expect(messages()[0]).toMatchObject({ content: 'no streaming happened', status: 'complete' })
  })

  it('gives each user message its own row', () => {
    store.append({
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'user.message', text: 'first' },
    })
    store.append({
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'user.message', text: 'second' },
    })
    expect(messages().map((m) => m.content)).toEqual(['first', 'second'])
  })
})

describe('approvals projection', () => {
  it('records the rule that auto-decided an approval', () => {
    store.append({
      conversationId: CONV,
      actor: 'codex',
      payload: {
        type: 'approval.requested',
        approvalId: 'ap1',
        kind: 'command',
        request: { command: ['git', 'status'] },
        expiresAt: 9999,
      },
    })
    store.append({
      conversationId: CONV,
      actor: 'system',
      payload: {
        type: 'approval.decided',
        approvalId: 'ap1',
        outcome: 'allow',
        scope: 'session',
        decidedBy: 'policy',
        policyRuleId: 'allow-read-only-git',
      },
    })
    // "Human controlled" means auditable: an auto-allow must say which rule did it.
    expect(
      db.prepare('SELECT outcome, decided_by, policy_rule_id FROM approvals').get()
    ).toMatchObject({
      outcome: 'allow',
      decided_by: 'policy',
      policy_rule_id: 'allow-read-only-git',
    })
  })
})

describe('rebuildProjections', () => {
  function seed(): void {
    store.append({
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'user.message', text: 'hi' },
    })
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: { type: 'agent.message.delta', itemRef: 'm1', text: 'a' },
    })
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: { type: 'agent.message.delta', itemRef: 'm1', text: 'b' },
    })
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: { type: 'agent.message.completed', itemRef: 'm1', text: 'ab' },
    })
    store.append({
      conversationId: CONV,
      actor: 'system',
      payload: {
        type: 'session.started',
        agentId: 'claude',
        sessionRef: 's1',
        cwd: '/x',
        model: null,
        cliVersion: '2.1.220',
      },
    })
  }

  it('reproduces identical state after the projections are wiped', () => {
    seed()
    const before = messages()

    db.exec('DELETE FROM messages; DELETE FROM conversations; DELETE FROM agent_sessions')
    expect(messages()).toHaveLength(0)

    const result = store.rebuildProjections()
    expect(result.events).toBe(store.lastSeq())
    expect(messages()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS c FROM agent_sessions').get()).toMatchObject({ c: 1 })
  })

  it('is the recovery path for a corrupted projection', () => {
    seed()
    // Simulate a projector bug having written nonsense.
    db.exec("UPDATE messages SET content = 'CORRUPT'")
    store.rebuildProjections()
    expect(messages().map((m) => m.content)).toEqual(['hi', 'ab'])
  })
})

describe('projectionDrift', () => {
  it('reports nothing when projections are current', () => {
    store.append({
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'user.message', text: 'hi' },
    })
    expect(store.projectionDrift()).toEqual([])
  })

  it('detects a projection left behind the log', () => {
    store.append({
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'user.message', text: 'hi' },
    })
    db.exec('UPDATE projection_state SET last_seq = 0')
    const drift = store.projectionDrift()
    expect(drift.length).toBeGreaterThan(0)
    expect(drift[0]?.logSeq).toBe(store.lastSeq())
  })
})

describe('read', () => {
  beforeEach(() => {
    store.append({
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'user.message', text: 'a' },
    })
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: { type: 'agent.message.delta', itemRef: 'm', text: 'x' },
    })
    store.append({
      conversationId: 'other',
      actor: 'user',
      payload: { type: 'user.message', text: 'elsewhere' },
    })
  })

  it('scopes to one conversation', () => {
    expect(store.read(CONV).every((e) => e.conversationId === CONV)).toBe(true)
  })

  it('filters by type', () => {
    const only = store.read(CONV, { types: ['user.message'] })
    expect(only).toHaveLength(1)
    expect(only[0]?.payload.type).toBe('user.message')
  })

  it('resumes after a sequence number', () => {
    const all = store.read(CONV)
    const first = all[0]
    expect(first).toBeDefined()
    const after = store.read(CONV, { afterSeq: first?.seq ?? 0 })
    expect(after.length).toBe(all.length - 1)
  })

  it('round-trips the payload through JSON unchanged', () => {
    const deltas = store.read(CONV, { types: ['agent.message.delta'] })
    expect(deltas[0]?.payload).toEqual({ type: 'agent.message.delta', itemRef: 'm', text: 'x' })
  })
})
