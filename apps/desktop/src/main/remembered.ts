import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Answers the user gave permanently, kept next to the log and the database.
 *
 * The one permission Chorus persists. Session grants deliberately die with the
 * window they were made in — a grant that outlived it would be a permission the
 * user did not give — but `always` is a different sentence, and the reason it
 * exists is a measured failure: an MCP tool call may never be auto-decided, so
 * "allow for this session" on one was silently refused and the same tool asked
 * again on every call, in every session, forever. On this machine that is 118
 * tools across seven servers, `github: search_repositories` among them.
 *
 * Its own file rather than a field in `settings.json`, because settings are
 * *defaults for the next session* and these are decisions already made. Mixing
 * them would make "reset my settings" quietly mean "revoke my permissions".
 *
 * Machine-wide rather than per conversation, which is what the user asked for:
 * answered once, not once per room and again after a restart.
 */

const FILE = 'remembered-grants.json'

const path = (userDataPath: string): string => join(userDataPath, FILE)

/**
 * Exported for tests, and defensive because this file is on disk between runs.
 *
 * A hand-edited or truncated file must not stop the app opening, and it must
 * never widen anything: anything unreadable means no remembered answers, which
 * is the safe direction — the user is asked again rather than silently allowed.
 */
export function parseRemembered(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((key): key is string => typeof key === 'string' && key !== '')
}

export function readRemembered(userDataPath: string): string[] {
  try {
    return parseRemembered(JSON.parse(readFileSync(path(userDataPath), 'utf8')))
  } catch {
    // Missing is the common case and not an error.
    return []
  }
}

/** Temp file and rename, so a crash mid-write cannot destroy a valid list. */
export function writeRemembered(userDataPath: string, keys: readonly string[]): void {
  try {
    mkdirSync(userDataPath, { recursive: true })
    const target = path(userDataPath)
    const temp = `${target}.tmp`
    writeFileSync(temp, `${JSON.stringify([...keys], null, 2)}\n`, 'utf8')
    renameSync(temp, target)
  } catch {
    // Losing a remembered answer costs one extra question later. Failing the
    // decision the user just made would cost them the action.
  }
}
