import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { normaliseExplainLanguage } from '../shared/ipc.js'

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
 *
 * Zoom is deliberately **not** here. It is a per-launch adjustment, not a
 * preference: the app opens at 100% every time, and a size you set to read one
 * long diff should not be waiting for you tomorrow. An older file may still
 * carry a `scale` key; the schema drops it on the next read.
 */

export const Settings = z.object({
  agents: z.array(z.enum(['codex', 'claude'])),
  /** Empty means "start at home", the same as leaving the field blank. */
  cwd: z.string(),
  profileId: z.string(),
  /**
   * What a new session's agents start as. Empty means the provider's own
   * choice, which is not the same as a named model and must stay expressible.
   *
   * A default, like everything else here — a conversation's own picker
   * overrides it, and the sheet's controls say "new sessions" for exactly that
   * reason. `.default('')` so a file written before this still parses.
   */
  model: z.string().default(''),
  /** Likewise reasoning effort. Empty means whatever the model does unasked. */
  effortLevel: z.string().default(''),
  /**
   * The language a passage is explained in, when someone asks for one.
   *
   * Empty is the default and means the action is not offered at all. There is no
   * honest guess at a person's own language — the system locale describes the
   * machine, not whoever is reading — and a wrong guess here produces an answer
   * in a language nobody asked for.
   *
   * Normalised through the same function the renderer's field uses, so a
   * hand-edited file with a newline in it is tidied on read rather than
   * producing a control that looks empty while holding content.
   */
  explainLanguage: z.string().default('').transform(normaliseExplainLanguage),
})
export type Settings = z.infer<typeof Settings>

export const DEFAULT_SETTINGS: Settings = {
  /*
   * One agent, not two.
   *
   * A session opens the moment the app does, so its cast is what you pay for
   * without asking — and two agents is two provider processes and twice the
   * wait before anything can be typed. One alone is the cheap start; the other
   * can be brought in from its chip whenever the conversation needs it, and it
   * reads everything said so far when it arrives.
   *
   * Only the default. Toggling the cast on any session persists it, so this is
   * what a machine with no settings file yet begins with, not a rule.
   */
  agents: ['claude'],
  cwd: '',
  // Permissive defaults ship by accident, not on purpose (plan §4.4).
  profileId: 'read-only',
  // Nothing chosen: the provider decides, which is the right default for a
  // machine whose CLI we have not asked yet.
  model: '',
  effortLevel: '',
  // Off until someone says which language. See the field's own comment.
  explainLanguage: '',
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
