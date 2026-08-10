import { beforeEach, describe, expect, it } from 'vitest'
import { asideMetaOf } from './events.js'
import { currentVersion, MIGRATIONS } from './migrations.js'
import { openSqlite, type SqliteHandle } from './sqlite.js'
import { EventStore } from './store.js'

/**
 * Asides, and the first schema migration this database has ever had.
 *
 * The migration is the risk, not the feature. `MIGRATIONS` held one entry until
 * now, so the upgrade path has never run against a database with data in it —
 * which means the interesting test is not "does a fresh database get the new
 * columns" but "does an old one survive getting them".
 */

const PARENT = 'conv-parent'
const REPLY = 'evt-reply-1'

let db: SqliteHandle
let store: EventStore

const created = (id: string, over: Record<string, unknown> = {}): void => {
  store.append(
    {
      conversationId: id,
      actor: 'user',
      payload: { type: 'conversation.created', projectId: '/repo', title: id, ...over },
    },
    1000
  )
}

const aside = (id: string, sourceEventId = REPLY): void => {
  created(id, { aside: { parentId: PARENT, sourceEventId } })
}

const row = (id: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM conversations WHERE id = @id').get({ id }) as Record<string, unknown>

beforeEach(() => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  created(PARENT)
})

describe('the upgrade path', () => {
  it('adds the columns to a version 1 database that already holds data', () => {
    // A database as it existed before asides: schema v1, one conversation in it.
    const old = openSqlite({ path: ':memory:' })
    const first = MIGRATIONS.find((m) => m.version === 1)
    if (first === undefined) throw new Error('migration 1 has gone missing')
    old.exec(first.up)
    old.exec('PRAGMA user_version = 1')
    old
      .prepare(
        `INSERT INTO conversations (id, project_id, title, created_at, updated_at)
         VALUES ('old-conv', '/repo', 'Written before asides existed', 1, 1)`
      )
      .run()

    const { migration, store: upgraded } = EventStore.open(old)

    expect(migration.from).toBe(1)
    expect(migration.to).toBe(2)
    expect(migration.applied).toEqual(['aside-conversations'])

    // The row that was already there is untouched and still listed.
    const listed = upgraded.listConversations().find((c) => c.conversationId === 'old-conv')
    expect(listed?.title).toBe('Written before asides existed')
  })

  it('reads a conversation written before asides existed as an ordinary one', () => {
    // Absent means ordinary. There is no `kind: 'main'` to backfill, which is
    // what keeps old rows correct rather than merely quiet.
    expect(row(PARENT)['kind']).toBeNull()
    expect(row(PARENT)['parent_id']).toBeNull()
    expect(row(PARENT)['source_event_id']).toBeNull()
  })

  it('is idempotent — reopening applies nothing', () => {
    const { migration } = EventStore.open(db)
    expect(migration.applied).toEqual([])
    expect(currentVersion(db)).toBe(2)
  })
})

describe('asides', () => {
  it('records what it branched from and what it is about', () => {
    aside('conv-aside-1')
    expect(row('conv-aside-1')).toMatchObject({
      kind: 'aside',
      parent_id: PARENT,
      source_event_id: REPLY,
    })
  })

  it('keeps asides out of the session list', () => {
    aside('conv-aside-1')
    const ids = store.listConversations().map((c) => c.conversationId)
    expect(ids).toContain(PARENT)
    // An aside in the sidebar would put "what did you mean by that" beside the
    // work it was about.
    expect(ids).not.toContain('conv-aside-1')
  })

  it('finds the asides taken on one conversation, oldest first', () => {
    aside('conv-aside-1')
    aside('conv-aside-2')
    expect(store.listAsides(PARENT).map((a) => a.id)).toEqual(['conv-aside-1', 'conv-aside-2'])
  })

  it('narrows to the asides taken on one reply', () => {
    aside('conv-aside-1', REPLY)
    aside('conv-aside-2', 'evt-reply-2')
    expect(store.listAsides(PARENT, REPLY).map((a) => a.id)).toEqual(['conv-aside-1'])
  })

  it('does not confuse the asides of one conversation with another’s', () => {
    created('conv-other')
    aside('conv-aside-1')
    expect(store.listAsides('conv-other')).toEqual([])
  })

  it('survives a projection rebuild unchanged', () => {
    // The property the whole store leans on: projections are derived, so a
    // rebuild from the log must reproduce them exactly — including the three
    // columns that did not exist when most of the log was written.
    aside('conv-aside-1')
    const before = row('conv-aside-1')
    store.rebuildProjections()
    expect(row('conv-aside-1')).toEqual(before)
    expect(store.listAsides(PARENT).map((a) => a.id)).toEqual(['conv-aside-1'])
  })

  it('still hides asides from the session list after a rebuild', () => {
    aside('conv-aside-1')
    store.rebuildProjections()
    expect(store.listConversations().map((c) => c.conversationId)).not.toContain('conv-aside-1')
  })
})

describe('an aside written by an earlier build', () => {
  /** Exactly the payload `ask-on-the-fly` wrote before the fields were gathered. */
  const legacy = (id: string): void => {
    created(id, { kind: 'aside', parentId: PARENT, sourceEventId: REPLY })
  }

  it('keeps its identity through a parse', () => {
    // Zod strips what a schema does not name. Dropping these three turned every
    // aside already in a log into an ordinary conversation.
    legacy('conv-old')
    expect(row('conv-old')).toMatchObject({
      kind: 'aside',
      parent_id: PARENT,
      source_event_id: REPLY,
    })
  })

  it('stays out of the session list', () => {
    // The visible symptom of losing it: someone's "what did you mean by that"
    // appearing in the sidebar beside the work it was about.
    legacy('conv-old')
    expect(store.listConversations().map((c) => c.conversationId)).not.toContain('conv-old')
  })

  it('is still findable from the reply it was asked about', () => {
    legacy('conv-old')
    expect(store.listAsides(PARENT, REPLY).map((a) => a.id)).toEqual(['conv-old'])
  })

  it('survives a rebuild, which is where the loss would have become permanent', () => {
    legacy('conv-old')
    store.rebuildProjections()
    expect(row('conv-old')['kind']).toBe('aside')
  })

  it('reads as a question, because it predates explanations', () => {
    legacy('conv-old')
    const created = store.read('conv-old')[0]
    expect(asideMetaOf(created!.payload)).toMatchObject({ purpose: 'question' })
  })
})

describe('promotion', () => {
  const promote = (id: string): void => {
    store.append(
      {
        conversationId: id,
        actor: 'user',
        payload: { type: 'aside.promoted', parentId: PARENT, sourceEventId: REPLY },
      },
      2000
    )
  }

  it('turns an aside into a listed conversation', () => {
    created('aside-1', { aside: { parentId: PARENT, sourceEventId: REPLY, purpose: 'question' } })
    expect(store.listConversations().map((c) => c.conversationId)).not.toContain('aside-1')

    promote('aside-1')
    expect(store.listConversations().map((c) => c.conversationId)).toContain('aside-1')
  })

  it('drops it out of its parent’s aside list', () => {
    // The same field does both jobs, so this is not a second assertion of the
    // first: `listAsides` filters `kind = 'aside'` and `listConversations`
    // filters `kind IS NULL`.
    created('aside-2', { aside: { parentId: PARENT, sourceEventId: REPLY, purpose: 'question' } })
    promote('aside-2')
    expect(store.listAsides(PARENT).map((a) => a.id)).not.toContain('aside-2')
  })

  it('survives a projection rebuild, which is why it is an event', () => {
    /*
     * The whole reason promotion is logged rather than written straight to the
     * column: `kind = 'aside'` is re-derived from `conversation.created` every
     * time projections are rebuilt, so an UPDATE would be undone by the one
     * operation the log guarantees. Replay order does the work — created first,
     * promoted after.
     */
    created('aside-3', { aside: { parentId: PARENT, sourceEventId: REPLY, purpose: 'question' } })
    promote('aside-3')
    store.rebuildProjections()
    expect(store.listConversations().map((c) => c.conversationId)).toContain('aside-3')
    expect(store.listAsides(PARENT).map((a) => a.id)).not.toContain('aside-3')
  })

  it('keeps an unpromoted aside hidden after the same rebuild', () => {
    // Guards the obvious way to get this wrong: clearing `kind` for everything.
    created('aside-4', { aside: { parentId: PARENT, sourceEventId: REPLY, purpose: 'question' } })
    created('aside-5', { aside: { parentId: PARENT, sourceEventId: REPLY, purpose: 'question' } })
    promote('aside-4')
    store.rebuildProjections()
    expect(store.listConversations().map((c) => c.conversationId)).not.toContain('aside-5')
    expect(store.listAsides(PARENT).map((a) => a.id)).toContain('aside-5')
  })

  it('keeps where it came from, so the log still says so', () => {
    created('aside-6', { aside: { parentId: PARENT, sourceEventId: REPLY, purpose: 'question' } })
    promote('aside-6')
    const row = db
      .prepare(
        'SELECT parent_id AS parentId, source_event_id AS sourceEventId FROM conversations WHERE id = @id'
      )
      .get({ id: 'aside-6' }) as { parentId: string | null; sourceEventId: string | null }
    expect(row.parentId).toBe(PARENT)
    expect(row.sourceEventId).toBe(REPLY)
  })
})
