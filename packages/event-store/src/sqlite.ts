import SqliteDatabase from 'better-sqlite3'
import type { Database, PreparedStatement } from './port.js'

/**
 * The only file in the codebase that knows which SQLite driver we use.
 * Everything else talks to the `Database` port, which is what keeps
 * `node:sqlite` available as an escape hatch (plan §2.4).
 */

export interface OpenOptions {
  /** `:memory:` for tests. */
  readonly path: string
  readonly readonly?: boolean
}

export interface SqliteHandle extends Database {
  /**
   * better-sqlite3's backup is the one async method (S4). Kept off the `Database`
   * port so the port stays synchronous, and exposed here for the pre-migration
   * snapshot path.
   */
  backupTo(destination: string): Promise<void>
}

export function openSqlite(options: OpenOptions): SqliteHandle {
  const db = new SqliteDatabase(options.path, { readonly: options.readonly ?? false })

  // WAL lets readers proceed during a write. Not meaningful for :memory:, and
  // better-sqlite3 silently keeps `memory` journal mode there.
  db.pragma('journal_mode = WAL')
  // NORMAL is the right trade for a local-first app: durable across process
  // crashes (which is what S3 cares about), only at risk on OS-level power loss.
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  const wrap = (sql: string): PreparedStatement => {
    const stmt = db.prepare(sql)
    return {
      run: (params) => {
        const info = params === undefined ? stmt.run() : stmt.run(params)
        return { changes: info.changes, lastInsertRowid: info.lastInsertRowid }
      },
      get: (params) => (params === undefined ? stmt.get() : stmt.get(params)),
      all: (params) => (params === undefined ? stmt.all() : stmt.all(params)),
    }
  }

  return {
    prepare: wrap,
    exec: (sql) => {
      db.exec(sql)
    },
    transaction: <T>(fn: () => T) => db.transaction(fn),
    close: () => {
      db.close()
    },
    backupTo: async (destination) => {
      await db.backup(destination)
    },
  }
}
