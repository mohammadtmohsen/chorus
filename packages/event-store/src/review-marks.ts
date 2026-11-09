import type { Database } from './port.js'

export interface ReviewKey {
  readonly host: string
  readonly project: string
  readonly iid: number
}

export interface ReviewSeen {
  readonly versionId: number
  readonly headSha: string
  readonly seenAt: number
}

interface ViewedRow {
  readonly path: unknown
  readonly digest: unknown
}

interface SeenRow {
  readonly version_id: unknown
  readonly head_sha: unknown
  readonly seen_at: unknown
}

export class ReviewMarksStore {
  constructor(private readonly db: Database) {}

  readViewed(key: ReviewKey): ReadonlyMap<string, string> {
    const rows = this.db
      .prepare(
        `SELECT path, digest FROM review_viewed
          WHERE host = @host AND project = @project AND iid = @iid`
      )
      .all({ ...key }) as readonly ViewedRow[]
    const viewed = new Map<string, string>()
    for (const row of rows) {
      if (typeof row.path === 'string' && typeof row.digest === 'string') {
        viewed.set(row.path, row.digest)
      }
    }
    return viewed
  }

  readSeen(key: ReviewKey): ReviewSeen | null {
    const row = this.db
      .prepare(
        `SELECT version_id, head_sha, seen_at FROM review_seen
          WHERE host = @host AND project = @project AND iid = @iid`
      )
      .get({ ...key }) as SeenRow | undefined
    if (
      row === undefined ||
      typeof row.version_id !== 'number' ||
      !Number.isSafeInteger(row.version_id) ||
      typeof row.head_sha !== 'string' ||
      typeof row.seen_at !== 'number' ||
      !Number.isFinite(row.seen_at)
    ) {
      return null
    }
    return { versionId: row.version_id, headSha: row.head_sha, seenAt: row.seen_at }
  }

  setViewed(key: ReviewKey, path: string, digest: string | null, now: number): void {
    if (digest === null) {
      this.db
        .prepare(
          `DELETE FROM review_viewed
            WHERE host = @host AND project = @project AND iid = @iid AND path = @path`
        )
        .run({ ...key, path })
      return
    }
    this.db
      .prepare(
        `INSERT INTO review_viewed (host, project, iid, path, digest, viewed_at)
         VALUES (@host, @project, @iid, @path, @digest, @now)
         ON CONFLICT(host, project, iid, path) DO UPDATE SET
           digest = excluded.digest,
           viewed_at = excluded.viewed_at`
      )
      .run({ ...key, path, digest, now })
  }

  setSeen(key: ReviewKey, versionId: number, headSha: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO review_seen (host, project, iid, version_id, head_sha, seen_at)
         VALUES (@host, @project, @iid, @versionId, @headSha, @now)
         ON CONFLICT(host, project, iid) DO UPDATE SET
           version_id = excluded.version_id,
           head_sha = excluded.head_sha,
           seen_at = excluded.seen_at`
      )
      .run({ ...key, versionId, headSha, now })
  }
}
