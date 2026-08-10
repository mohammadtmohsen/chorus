import { beforeEach, describe, expect, it } from 'vitest'
import { redactPayload } from '@chorus/shared'
import { ChorusEventPayload } from './events.js'
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
    expect(currentVersion(db)).toBe(2)
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
    expect(b?.seq).toBeGreaterThan(a?.seq ?? 0)
    expect(store.lastSeq()).toBe(b?.seq)
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

describe('listConversations', () => {
  it('names a conversation the log holds', () => {
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: {
        type: 'session.started',
        agentId: 'claude',
        sessionRef: 'thread-1',
        cwd: '/repo/app',
        model: null,
        cliVersion: null,
      },
    })
    const [only] = store.listConversations()
    expect(only).toMatchObject({
      conversationId: CONV,
      title: 'Spike',
      cwd: '/repo/app',
      agents: ['claude'],
    })
  })

  it('falls back to the directory it was created in when no agent recorded one', () => {
    // `project_id` holds the cwd a conversation was created with, so a room
    // nobody ever started an agent in can still say where it was.
    const [only] = store.listConversations()
    expect(only?.cwd).toBe('p1')
  })

  it('lists every agent that was ever in it, not only the last', () => {
    for (const agentId of ['claude', 'codex'] as const) {
      store.append({
        conversationId: CONV,
        actor: agentId,
        payload: {
          type: 'session.started',
          agentId,
          sessionRef: `thread-${agentId}`,
          cwd: '/repo/app',
          model: null,
          cliVersion: null,
        },
      })
    }
    expect([...(store.listConversations()[0]?.agents ?? [])].sort()).toEqual(['claude', 'codex'])
  })

  it('puts the most recently active first', () => {
    store.append({
      conversationId: 'conv-2',
      actor: 'user',
      payload: { type: 'conversation.created', projectId: 'p2', title: 'Later' },
    })
    store.append({
      conversationId: 'conv-2',
      actor: 'user',
      payload: { type: 'user.message', text: 'hi' },
    })
    expect(store.listConversations()[0]?.conversationId).toBe('conv-2')
  })

  it('counts what was said, which is how a row is recognised', () => {
    store.append({
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'user.message', text: 'a' },
    })
    store.append({
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'user.message', text: 'b' },
    })
    expect(store.listConversations().find((c) => c.conversationId === CONV)?.messages).toBe(2)
  })
})

describe('notices', () => {
  it('round-trips through the log with its detail intact', () => {
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: {
        type: 'notice.raised',
        level: 'warn',
        source: 'hook',
        text: 'lint · PreToolUse',
        detail: 'no semicolons please',
      },
    })
    const [read] = store.read(CONV, { types: ['notice.raised'] })
    expect(read?.payload).toMatchObject({
      type: 'notice.raised',
      level: 'warn',
      source: 'hook',
      detail: 'no semicolons please',
    })
  })

  it('accepts a notice with no detail, because most have none', () => {
    expect(() =>
      store.append({
        conversationId: CONV,
        actor: 'claude',
        payload: {
          type: 'notice.raised',
          level: 'info',
          source: 'system',
          text: 'something',
          detail: null,
        },
      })
    ).not.toThrow()
  })

  it('rejects a source the renderer has no label for', () => {
    // The renderer maps `source` onto a translated label; an unknown one would
    // render as a raw key, so the schema is where it should fail.
    expect(() =>
      store.append({
        conversationId: CONV,
        actor: 'claude',
        payload: {
          type: 'notice.raised',
          level: 'info',
          source: 'gossip',
          text: 'x',
          detail: null,
        } as never,
      })
    ).toThrow()
  })
})

describe('tool calls', () => {
  it('round-trips a nested call with its parent intact', () => {
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: {
        type: 'tool.started',
        itemRef: 't1',
        name: 'Grep',
        parentRef: 'p1',
        detail: 'TODO',
      },
    })
    const [read] = store.read(CONV, { types: ['tool.started'] })
    expect(read?.payload).toMatchObject({ name: 'Grep', parentRef: 'p1', detail: 'TODO' })
  })

  it('rejects a call with no ref, which nothing downstream could attach to', () => {
    expect(() =>
      store.append({
        conversationId: CONV,
        actor: 'claude',
        payload: { type: 'tool.started', itemRef: '', name: 'Grep', parentRef: null, detail: null },
      })
    ).toThrow()
  })

  it('accepts an outcome and rejects an invented one', () => {
    expect(() =>
      store.append({
        conversationId: CONV,
        actor: 'claude',
        payload: { type: 'tool.completed', itemRef: 't1', status: 'ok', summary: null },
      })
    ).not.toThrow()
    expect(() =>
      store.append({
        conversationId: CONV,
        actor: 'claude',
        payload: {
          type: 'tool.completed',
          itemRef: 't1',
          status: 'probably',
          summary: null,
        } as never,
      })
    ).toThrow()
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

describe('redaction on write', () => {
  it('never lets a secret reach the log', () => {
    // The only path into the log, so a caller cannot opt out (plan §4.4).
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: {
        type: 'agent.message.completed',
        itemRef: 'm1',
        text: 'the token is ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234',
      },
    })

    const raw = db.prepare('SELECT payload FROM events ORDER BY seq DESC LIMIT 1').get()
    expect(JSON.stringify(raw)).not.toContain('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234')
    expect(JSON.stringify(raw)).toContain('[redacted:github-token]')
  })

  it('redacts the projection too, since it is built from the redacted event', () => {
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: {
        type: 'agent.message.completed',
        itemRef: 'm2',
        text: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv',
      },
    })
    const row = db.prepare("SELECT content FROM messages WHERE item_ref = 'm2'").get()
    expect(JSON.stringify(row)).not.toContain('sk-ant-api03')
  })

  it('leaves ordinary content untouched', () => {
    store.append({
      conversationId: CONV,
      actor: 'codex',
      payload: { type: 'agent.message.completed', itemRef: 'm3', text: 'git status is clean' },
    })
    const row = db.prepare("SELECT content FROM messages WHERE item_ref = 'm3'").get()
    expect(row).toMatchObject({ content: 'git status is clean' })
  })
})

describe('reconcileOrphanedSessions', () => {
  const startSession = (ref: string): void => {
    store.append({
      conversationId: CONV,
      actor: 'system',
      payload: {
        type: 'session.started',
        agentId: 'codex',
        sessionRef: ref,
        cwd: '/x',
        model: null,
        cliVersion: '0.1.0',
      },
    })
  }

  it('closes a session the log still believes is running', () => {
    // A crash leaves session.started with no matching session.ended, so the
    // next boot would claim an agent is alive that died with the process.
    startSession('s1')
    expect(store.reconcileOrphanedSessions()).toEqual({ closed: 1 })

    expect(db.prepare('SELECT status FROM agent_sessions').get()).toMatchObject({
      status: 'crashed',
    })
  })

  it('records the reconciliation as an event, not a silent projection edit', () => {
    // The log is the record; editing a projection behind its back would make
    // the two disagree, and a rebuild would undo it.
    startSession('s1')
    store.reconcileOrphanedSessions()

    const ended = store.read(CONV, { types: ['session.ended'] })
    expect(ended).toHaveLength(1)
    expect(ended[0]?.payload).toMatchObject({ sessionRef: 's1', reason: 'crashed' })
  })

  it('survives a rebuild, because it is in the log', () => {
    startSession('s1')
    store.reconcileOrphanedSessions()
    store.rebuildProjections()
    expect(db.prepare('SELECT status FROM agent_sessions').get()).toMatchObject({
      status: 'crashed',
    })
  })

  it('leaves a cleanly ended session alone', () => {
    startSession('s1')
    store.append({
      conversationId: CONV,
      actor: 'system',
      payload: { type: 'session.ended', agentId: 'codex', sessionRef: 's1', reason: 'closed' },
    })
    expect(store.reconcileOrphanedSessions()).toEqual({ closed: 0 })
  })

  it('is a no-op on a clean boot', () => {
    expect(store.reconcileOrphanedSessions()).toEqual({ closed: 0 })
  })

  it('closes several at once', () => {
    startSession('s1')
    startSession('s2')
    expect(store.reconcileOrphanedSessions()).toEqual({ closed: 2 })
  })
})

describe('after close', () => {
  it('refuses writes instead of throwing at a dead handle', () => {
    /*
     * Agents keep talking while the app shuts down, and their event pumps have
     * nobody to catch a throw — a late `turn.completed` reaching a closed
     * database surfaced as "The database connection is not open" as an
     * unhandled rejection, which is a crash report for an app that was quitting
     * anyway. Refusing is the honest answer, and the count says how much.
     */
    const closing = EventStore.open(openSqlite({ path: ':memory:' })).store
    closing.close()

    expect(
      closing.append({
        conversationId: CONV,
        actor: 'user',
        payload: { type: 'user.message', text: 'late' },
      })
    ).toBeNull()
    expect(
      closing.appendMany([
        { conversationId: CONV, actor: 'user', payload: { type: 'user.message', text: 'later' } },
      ])
    ).toEqual([])
    expect(closing.droppedWrites()).toBe(2)
  })

  it('counts nothing while it is open', () => {
    expect(store.droppedWrites()).toBe(0)
  })
})

/**
 * Every stored payload is reparsed through the *current* schema on read, and
 * `schema_ver` is recorded but never branched on — there is no upcasting step.
 *
 * So a field added to an existing event has to tolerate its own absence, or
 * every conversation written before it shipped stops opening. That is a silent,
 * total failure, and this is the cheapest place to catch it.
 */
describe('payload schema: fields added later', () => {
  it('reads a tool.completed written before patches existed', () => {
    const parsed = ChorusEventPayload.parse({
      type: 'tool.completed',
      itemRef: 't1',
      status: 'ok',
      summary: null,
    })

    expect(parsed).toMatchObject({ type: 'tool.completed', itemRef: 't1' })
  })

  it('round-trips a tool.completed that carries a patch', () => {
    const patch = 'diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n'
    const parsed = ChorusEventPayload.parse({
      type: 'tool.completed',
      itemRef: 't1',
      status: 'ok',
      summary: null,
      patch,
      omittedLines: 12,
    })

    expect(parsed).toMatchObject({ patch, omittedLines: 12 })
  })

  it('redacts a secret an agent edited into a file, before it reaches disk', () => {
    /*
     * The reason the patch is a string named `patch` rather than structured
     * hunks: `redactPayload` keys on field name. Under `lines` this would be
     * written down verbatim.
     */
    const { payload, redacted } = redactPayload({
      type: 'tool.completed',
      itemRef: 't1',
      status: 'ok',
      summary: null,
      patch: 'diff --git a/.env b/.env\n@@ -1,1 +1,1 @@\n+KEY=sk-ant-api03-SECRETVALUEHERE\n',
    })

    expect(redacted.length).toBeGreaterThan(0)
    expect((payload as { patch: string }).patch).not.toContain('SECRETVALUEHERE')
  })
})
