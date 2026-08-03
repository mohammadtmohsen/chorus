import type { Database } from './port.js'

/**
 * Numbered, forward-only, run inside a transaction at startup.
 *
 * Adding a migration means appending to this array. Never edit a shipped one —
 * a database that already applied version N will not re-run it.
 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly up: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      -- The append-only log. Everything else in this file is a projection that
      -- can be dropped and rebuilt from these rows.
      CREATE TABLE events (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        id              TEXT    NOT NULL UNIQUE,
        conversation_id TEXT    NOT NULL,
        actor           TEXT    NOT NULL,
        type            TEXT    NOT NULL,
        payload         TEXT    NOT NULL,
        created_at      INTEGER NOT NULL,
        schema_ver      INTEGER NOT NULL
      );
      CREATE INDEX events_conv_seq ON events (conversation_id, seq);
      CREATE INDEX events_type ON events (type);

      CREATE TABLE projects (
        id                    TEXT PRIMARY KEY,
        root_path             TEXT NOT NULL,
        name                  TEXT NOT NULL,
        permission_profile_id TEXT,
        created_at            INTEGER NOT NULL
      );

      CREATE TABLE conversations (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- One row per message. Agent messages are built up from delta events, so
      -- content grows and status moves streaming -> complete.
      CREATE TABLE messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT    NOT NULL,
        seq             INTEGER NOT NULL,
        actor           TEXT    NOT NULL,
        -- Always set. For agent messages it is the provider's streaming item id,
        -- which is how a run of deltas is stitched into one row; for user
        -- messages it is the originating event id, so the index stays simple.
        item_ref        TEXT    NOT NULL,
        content         TEXT    NOT NULL DEFAULT '',
        status          TEXT    NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX messages_conv_seq ON messages (conversation_id, seq);
      CREATE UNIQUE INDEX messages_item_ref ON messages (conversation_id, item_ref);

      CREATE TABLE agent_sessions (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT    NOT NULL,
        agent_id        TEXT    NOT NULL,
        session_ref     TEXT    NOT NULL,
        cwd             TEXT    NOT NULL,
        model           TEXT,
        cli_version     TEXT,
        status          TEXT    NOT NULL,
        started_at      INTEGER NOT NULL
      );
      CREATE INDEX agent_sessions_conv ON agent_sessions (conversation_id);

      CREATE TABLE approvals (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT    NOT NULL,
        agent_id        TEXT,
        kind            TEXT    NOT NULL,
        request         TEXT    NOT NULL,
        outcome         TEXT,
        scope           TEXT,
        decided_by      TEXT,
        decided_at      INTEGER,
        policy_rule_id  TEXT,
        expires_at      INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX approvals_conv ON approvals (conversation_id);

      CREATE TABLE handoffs (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT    NOT NULL,
        from_agent       TEXT    NOT NULL,
        to_agent         TEXT    NOT NULL,
        brief            TEXT    NOT NULL,
        source_event_ids TEXT    NOT NULL,
        created_at       INTEGER NOT NULL
      );

      -- Lets us detect a projection that has drifted from the log, and is the
      -- resume point for an incremental rebuild.
      CREATE TABLE projection_state (
        name     TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL
      );
    `,
  },
]

export interface MigrationResult {
  readonly from: number
  readonly to: number
  readonly applied: readonly string[]
  readonly backedUpTo: string | null
}

export function currentVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get()
  const parsed = row as { user_version?: number } | undefined
  return parsed?.user_version ?? 0
}

/**
 * `backup` is injected rather than called directly because it is the one async
 * method on better-sqlite3 (S4) and the port is otherwise synchronous. Callers
 * that can snapshot pass one in; tests and in-memory databases pass nothing.
 */
export function migrate(
  db: Database,
  onBeforeMigrate?: (from: number) => string | null
): MigrationResult {
  const from = currentVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > from)

  if (pending.length === 0) {
    return { from, to: from, applied: [], backedUpTo: null }
  }

  // Snapshot before touching a database that already holds data. A failed
  // migration on an empty database costs nothing; on a real one it costs
  // everything.
  const backedUpTo = from > 0 ? (onBeforeMigrate?.(from) ?? null) : null

  const run = db.transaction(() => {
    for (const m of pending) {
      db.exec(m.up)
      db.exec(`PRAGMA user_version = ${String(m.version)}`)
    }
  })
  run()

  const to = pending.at(-1)?.version ?? from
  return { from, to, applied: pending.map((m) => m.name), backedUpTo }
}
