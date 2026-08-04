import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * What a new session starts with, remembered between launches.
 *
 * Deliberately not in the event log: the log records what happened in a
 * conversation, and a preference is neither an event nor something you would
 * want replayed. A small JSON file is the honest shape for it.
 *
 * Everything here is a *default*, never a constraint — each session still
 * chooses its own agents, directory and profile when it starts. That is what
 * keeps this file safe to lose.
 */

/** The range the layout was checked at; past either end it stops being a layout. */
export const MIN_SCALE = 0.8
export const MAX_SCALE = 1.5

/** Offered as steps rather than a slider: five sizes, each visibly different. */
export const SCALES = [0.85, 1, 1.15, 1.3, 1.5] as const

export const Settings = z.object({
  agents: z.array(z.enum(['codex', 'claude'])),
  /** Empty means "start at home", the same as leaving the field blank. */
  cwd: z.string(),
  profileId: z.string(),
  /**
   * Zoom factor for the whole window, not a font size.
   *
   * Scaling type alone would leave every border, gutter and control where it
   * was, so larger text would arrive in a layout built for smaller text. Zoom
   * moves all of it together, and the responsive breakpoints come along —
   * at 1.5 the window holds fewer columns, which is the truth.
   */
  scale: z.number().min(MIN_SCALE).max(MAX_SCALE),
})
export type Settings = z.infer<typeof Settings>

export const DEFAULT_SETTINGS: Settings = {
  agents: ['codex', 'claude'],
  cwd: '',
  // Permissive defaults ship by accident, not on purpose (plan §4.4).
  profileId: 'read-only',
  scale: 1,
}

function settingsPath(userDataPath: string): string {
  return join(userDataPath, 'settings.json')
}

/**
 * Reads the file, falling back to defaults on anything unexpected.
 *
 * A corrupt or hand-edited settings file must not stop the app opening — the
 * worst case is a preference reset, and refusing to launch over one is a far
 * bigger failure than the one it reports.
 */
export function readSettings(userDataPath: string): Settings {
  try {
    const parsed = Settings.safeParse(JSON.parse(readFileSync(settingsPath(userDataPath), 'utf8')))
    return parsed.success ? parsed.data : DEFAULT_SETTINGS
  } catch {
    // Missing is the common case, and it is not an error.
    return DEFAULT_SETTINGS
  }
}

/**
 * Writes via a temporary file and a rename, so a crash mid-write cannot leave a
 * half-written file where a valid one used to be. Rename is atomic within a
 * directory on every filesystem this app runs on.
 */
export function writeSettings(userDataPath: string, next: Settings): Settings {
  const settings = Settings.parse(next)
  mkdirSync(userDataPath, { recursive: true })
  const target = settingsPath(userDataPath)
  const temp = `${target}.tmp`
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  renameSync(temp, target)
  return settings
}
