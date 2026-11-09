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
    expect(marks.readSeen(KEY)).toBeNull()
    expect(db.prepare('SELECT * FROM review_seen').all()).toEqual([])
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

  it('isolates seen reviews by host, project and merge request', () => {
    const keys: readonly ReviewKey[] = [
      KEY,
      { ...KEY, host: 'elsewhere.example.com' },
      { ...KEY, project: 'team/other' },
      { ...KEY, iid: 8 },
    ]
    for (const [index, key] of keys.entries()) {
      marks.setSeen(key, index + 100, `head-${String(index)}`, index + 20)
    }

    marks.setSeen(KEY, 200, 'replacement', 60)
    expect(marks.readSeen(KEY)).toEqual({ versionId: 200, headSha: 'replacement', seenAt: 60 })

    for (const [index, key] of keys.entries()) {
      if (index === 0) continue
      expect(marks.readSeen(key)).toEqual({
        versionId: index + 100,
        headSha: `head-${String(index)}`,
        seenAt: index + 20,
      })
    }
  })

  it('survives reopening the store and rebuilding projections without recording history', () => {
    marks.setSeen(KEY, 100, 'first-head', 20)
    expect(store.lastSeq()).toBe(0)

    store.rebuildProjections()
    const reopened = EventStore.open(db)
    const restored = new ReviewMarksStore(db)
    expect(reopened.migration.applied).toEqual([])
    expect(restored.readSeen(KEY)).toEqual({ versionId: 100, headSha: 'first-head', seenAt: 20 })
    expect(reopened.store.lastSeq()).toBe(0)
  })
})
