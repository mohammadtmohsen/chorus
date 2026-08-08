import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  WorkspaceSnapshot,
  type WorkspaceSnapshot as WorkspaceSnapshotType,
} from '../shared/workspace-layout.js'

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
  /**
   * The last event this conversation's card had been caught up to.
   *
   * A watermark rather than an unread *count*, so the number is derived and
   * self-correcting: counting is done against the log, which is the thing that
   * actually knows what happened. A stored count could disagree with the
   * transcript underneath it and there would be no way to tell which was wrong.
   *
   * `.default` keeps files written before this parse, so nobody's list resets on
   * upgrade — the same reason the version-2 envelope kept reading version 1.
   */
  lastSeenSeq: z.number().int().min(0).default(0),
})
export type OpenSession = z.infer<typeof OpenSession>

const LegacyOpenSessions = z.array(OpenSession)

/**
 * Versioned because the original file was a bare session array. Layout belongs
 * beside that array, not repeated inside every conversation.
 */
export const OpenSessionsFile = z.object({
  version: z.literal(2),
  sessions: z.array(OpenSession),
  workspace: WorkspaceSnapshot.nullable(),
})
export interface OpenSessionsState {
  readonly sessions: OpenSession[]
  readonly workspace: WorkspaceSnapshotType | null
}

function path(userDataPath: string): string {
  return join(userDataPath, 'open-sessions.json')
}

/** Anything unexpected means "nothing was open", which is always safe. */
export function parseOpenSessions(value: unknown): OpenSessionsState {
  const current = OpenSessionsFile.safeParse(value)
  if (current.success) {
    return { sessions: current.data.sessions, workspace: current.data.workspace }
  }
  const legacy = LegacyOpenSessions.safeParse(value)
  return legacy.success
    ? { sessions: legacy.data, workspace: null }
    : { sessions: [], workspace: null }
}

export function readOpenSessions(userDataPath: string): OpenSessionsState {
  try {
    return parseOpenSessions(JSON.parse(readFileSync(path(userDataPath), 'utf8')))
  } catch {
    return { sessions: [], workspace: null }
  }
}

/** Temp file and rename, so a crash mid-write cannot destroy a valid list. */
export function writeOpenSessions(userDataPath: string, state: OpenSessionsState): void {
  try {
    mkdirSync(userDataPath, { recursive: true })
    const target = path(userDataPath)
    const temp = `${target}.tmp`
    writeFileSync(
      temp,
      `${JSON.stringify({ version: 2, sessions: state.sessions, workspace: state.workspace }, null, 2)}\n`,
      'utf8'
    )
    renameSync(temp, target)
  } catch {
    // A note to ourselves is not worth failing a conversation over.
  }
}
