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

interface SeenRow {
  readonly version_id: unknown
  readonly head_sha: unknown
  readonly seen_at: unknown
}

export class ReviewMarksStore {
  constructor(private readonly db: Database) {}

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
