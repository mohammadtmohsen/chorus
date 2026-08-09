import { beforeEach, describe, expect, it } from 'vitest'
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
  created(id, { kind: 'aside', parentId: PARENT, sourceEventId })
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
