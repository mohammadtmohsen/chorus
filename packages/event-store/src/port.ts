/**
 * The seam that keeps `node:sqlite` available as an escape hatch if
 * better-sqlite3's native build ever becomes a notarization problem (plan §2.4).
 * Nothing above this file may import a driver directly.
 *
 * Rows come back as `unknown` on purpose. A generic `get<T>()` would be an
 * unchecked cast wearing a type annotation; the store validates every row with
 * the same zod schemas it validates writes against (plan §4.3).
 */
export interface PreparedStatement {
  run(params?: Readonly<Record<string, unknown>>): {
    readonly changes: number
    readonly lastInsertRowid: number | bigint
  }
  get(params?: Readonly<Record<string, unknown>>): unknown
  all(params?: Readonly<Record<string, unknown>>): readonly unknown[]
}

export interface Database {
  prepare(sql: string): PreparedStatement
  exec(sql: string): void
  /** Appends and projection updates must land in one transaction (plan §4.3). */
  transaction<T>(fn: () => T): () => T
  close(): void
}
