import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * Which conversations were open when the app last ran.
 *
 * Not derived from the event log, though it nearly could be. The log says a
 * session started and never ended, which after a crash is indistinguishable
 * from one that was open on purpose — and `reconcileOrphanedSessions` exists
 * precisely to close those. This file answers a different question: which
 * conversations did the user still have on screen. It is a note to ourselves,
 * and losing it costs nothing but a click.
 *
 * The transcripts are not here. They are in the log, which is where they belong;
 * this is only the list of doors to reopen.
 */

export const OpenSession = z.object({
  conversationId: z.string(),
  agents: z.array(z.enum(['codex', 'claude'])),
  cwd: z.string(),
  profileId: z.string(),
  title: z.string(),
  /**
   * Each agent's provider thread, so it can be resumed rather than restarted.
   *
   * A resumed agent still has its own reasoning; a restarted one has to be told
   * the conversation again. Keyed by agent because they resume independently and
   * one failing must not cost the other its context.
   */
  sessionRefs: z.record(z.string(), z.string()),
})
export type OpenSession = z.infer<typeof OpenSession>

const OpenSessions = z.array(OpenSession)

function path(userDataPath: string): string {
  return join(userDataPath, 'open-sessions.json')
}

/** Anything unexpected means "nothing was open", which is always safe. */
export function readOpenSessions(userDataPath: string): OpenSession[] {
  try {
    const parsed = OpenSessions.safeParse(JSON.parse(readFileSync(path(userDataPath), 'utf8')))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/** Temp file and rename, so a crash mid-write cannot destroy a valid list. */
export function writeOpenSessions(userDataPath: string, sessions: readonly OpenSession[]): void {
  try {
    mkdirSync(userDataPath, { recursive: true })
    const target = path(userDataPath)
    const temp = `${target}.tmp`
    writeFileSync(temp, `${JSON.stringify(sessions, null, 2)}\n`, 'utf8')
    renameSync(temp, target)
  } catch {
    // A note to ourselves is not worth failing a conversation over.
  }
}
