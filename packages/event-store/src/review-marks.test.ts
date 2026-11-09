import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReviewMarksStore, type ReviewKey } from './review-marks.js'
import { openSqlite, type SqliteHandle } from './sqlite.js'
import { EventStore } from './store.js'

const KEY: ReviewKey = { host: 'gitlab.example.com', project: 'team/app', iid: 7 }

let db: SqliteHandle
let store: EventStore
let marks: ReviewMarksStore

beforeEach(() => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  marks = new ReviewMarksStore(db)
})

afterEach(() => {
  db.close()
})

describe('review marks', () => {
  it('reads untouched reviews without creating marks', () => {
    expect(marks.readViewed(KEY)).toEqual(new Map())
    expect(marks.readSeen(KEY)).toBeNull()
    expect(db.prepare('SELECT * FROM review_viewed').all()).toEqual([])
    expect(db.prepare('SELECT * FROM review_seen').all()).toEqual([])
  })

  it('stores the current digest and timestamp once per file', () => {
    marks.setViewed(KEY, 'src/a.ts', 'first', 10)
    marks.setViewed(KEY, 'src/b.ts', 'other', 20)
    marks.setViewed(KEY, 'src/a.ts', 'changed', 30)

    const restored = new ReviewMarksStore(db)
    expect(restored.readViewed(KEY)).toEqual(
      new Map([
        ['src/a.ts', 'changed'],
        ['src/b.ts', 'other'],
      ])
    )
    expect(
      db.prepare('SELECT path, digest, viewed_at FROM review_viewed ORDER BY path').all()
    ).toEqual([
      { path: 'src/a.ts', digest: 'changed', viewed_at: 30 },
      { path: 'src/b.ts', digest: 'other', viewed_at: 20 },
    ])
  })

  it('unviews only the named file and accepts repeated removal', () => {
    marks.setViewed(KEY, 'src/a.ts', 'first', 10)
    marks.setViewed(KEY, 'src/b.ts', 'other', 20)
    marks.setViewed(KEY, 'src/a.ts', null, 30)
    marks.setViewed(KEY, 'src/a.ts', null, 40)
    marks.setViewed(KEY, 'missing.ts', null, 50)

    expect(marks.readViewed(KEY)).toEqual(new Map([['src/b.ts', 'other']]))
    expect(db.prepare('SELECT path FROM review_viewed').all()).toEqual([{ path: 'src/b.ts' }])

    marks.setViewed(KEY, 'src/a.ts', 'read-again', 60)
    expect(marks.readViewed(KEY).get('src/a.ts')).toBe('read-again')
  })

  it('replaces the seen version, head and timestamp together', () => {
    marks.setSeen(KEY, 100, 'first-head', 10)
    expect(marks.readSeen(KEY)).toEqual({ versionId: 100, headSha: 'first-head', seenAt: 10 })

    marks.setSeen(KEY, 101, 'next-head', 20)
    const restored = new ReviewMarksStore(db)
    expect(restored.readSeen(KEY)).toEqual({ versionId: 101, headSha: 'next-head', seenAt: 20 })
    expect(db.prepare('SELECT version_id, head_sha, seen_at FROM review_seen').all()).toEqual([
      { version_id: 101, head_sha: 'next-head', seen_at: 20 },
    ])
  })

  it('keeps viewed files independent of the last seen review', () => {
    marks.setViewed(KEY, 'src/a.ts', 'first', 10)
    expect(marks.readSeen(KEY)).toBeNull()

    marks.setSeen(KEY, 100, 'first-head', 20)
    marks.setViewed(KEY, 'src/a.ts', 'changed', 30)
    marks.setViewed(KEY, 'src/a.ts', null, 40)
    expect(marks.readSeen(KEY)).toEqual({ versionId: 100, headSha: 'first-head', seenAt: 20 })

    marks.setViewed(KEY, 'src/a.ts', 'read-again', 50)
    marks.setSeen(KEY, 101, 'next-head', 60)
    expect(marks.readViewed(KEY)).toEqual(new Map([['src/a.ts', 'read-again']]))
  })

  it('isolates the same path by host, project and merge request', () => {
    const keys: readonly ReviewKey[] = [
      KEY,
      { ...KEY, host: 'elsewhere.example.com' },
      { ...KEY, project: 'team/other' },
      { ...KEY, iid: 8 },
    ]
    for (const [index, key] of keys.entries()) {
      marks.setViewed(key, 'src/a.ts', `digest-${String(index)}`, index + 10)
      marks.setSeen(key, index + 100, `head-${String(index)}`, index + 20)
    }

    marks.setViewed(KEY, 'src/a.ts', null, 50)
    marks.setSeen(KEY, 200, 'replacement', 60)
    expect(marks.readViewed(KEY)).toEqual(new Map())
    expect(marks.readSeen(KEY)).toEqual({ versionId: 200, headSha: 'replacement', seenAt: 60 })

    for (const [index, key] of keys.entries()) {
      if (index === 0) continue
      expect(marks.readViewed(key)).toEqual(new Map([['src/a.ts', `digest-${String(index)}`]]))
      expect(marks.readSeen(key)).toEqual({
        versionId: index + 100,
        headSha: `head-${String(index)}`,
        seenAt: index + 20,
      })
    }
  })

  it('survives reopening the store and rebuilding projections without recording history', () => {
    marks.setViewed(KEY, 'src/a.ts', 'first', 10)
    marks.setSeen(KEY, 100, 'first-head', 20)
    expect(store.lastSeq()).toBe(0)

    store.rebuildProjections()
    const reopened = EventStore.open(db)
    const restored = new ReviewMarksStore(db)
    expect(reopened.migration.applied).toEqual([])
    expect(restored.readViewed(KEY)).toEqual(new Map([['src/a.ts', 'first']]))
    expect(restored.readSeen(KEY)).toEqual({ versionId: 100, headSha: 'first-head', seenAt: 20 })
    expect(reopened.store.lastSeq()).toBe(0)
  })
})
