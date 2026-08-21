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

/**
 * One value per agent, defaulting to "the provider decides".
 *
 * Empty is a real answer and not a missing one: a model nobody chose is the
 * provider's own default, which is the right thing for a machine whose CLI we
 * have not asked yet.
 */
const perAgent = z
  .object({ codex: z.string().default(''), claude: z.string().default('') })
  .default({ codex: '', claude: '' })

export const Settings = z
  .object({
    agents: z.array(z.enum(['codex', 'claude'])),
    /** Empty means "start at home", the same as leaving the field blank. */
    cwd: z.string(),
    profileId: z.string(),
    /**
     * The shape before models were per agent. Read, migrated, and then written
     * back empty — see the transform below.
     *
     * Kept in the schema rather than deleted because zod strips what it does not
     * name, and a settings file written by 0.8.1 would otherwise lose the model
     * its owner had chosen on the first read after upgrading.
     */
    model: z.string().default(''),
    effortLevel: z.string().default(''),
    /**
     * What a new session's agents start as, per agent. Empty means the provider's
     * own choice, which is not the same as a named model and must stay
     * expressible.
     *
     * Per agent because the two providers share no model. One value for both was
     * not a simplification — it sent a name from one catalogue to the other's API.
     */
    models: perAgent,
    /**
     * Likewise reasoning effort, and per agent for a sharper reason: Codex's
     * levels differ *per model* — `ultra` exists on some and not others — so even
     * the levels the two providers appear to share are not interchangeable.
     */
    efforts: perAgent,
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
    /**
     * Which appearance to draw, rather than always deferring to the OS.
     *
     * `system` is the default and preserves what every version before this did:
     * follow `prefers-color-scheme`. The other two override it, which VS Code
     * users expect to be able to do — until now light mode here was a media
     * query with no switch attached.
     *
     * **Global, not per conversation.** It lived in `ChangesPanelState` in the
     * first draft of the plan, which is per-conversation state — one session in
     * dark and the next in light is not a feature.
     *
     * `.default(...)` is load-bearing: a required field here would fail the
     * parse for every settings file written before this shipped, and
     * `readSettings` falls back to defaults on a parse failure — so every
     * existing preference on the machine would silently reset.
     */
    theme: z.enum(['system', 'light', 'dark']).default('system'),
  })
  /**
   * Folds the old single model and effort onto **Claude**.
   *
   * Not a split. Whatever is in a settings file today was chosen from Claude's
   * list, because that is the only catalogue the sheet has ever shown — so the
   * honest migration is to recognise whose it was, and let Codex start with the
   * provider default rather than inheriting a name its API does not know.
   *
   * A transform rather than a migration step someone has to remember to run, and
   * it clears the legacy fields as it goes so the fold happens exactly once.
   */
  .transform((raw) => {
    const models = { ...raw.models }
    const efforts = { ...raw.efforts }
    if (raw.model !== '' && models.claude === '') models.claude = raw.model
    if (raw.effortLevel !== '' && efforts.claude === '') efforts.claude = raw.effortLevel
    return { ...raw, model: '', effortLevel: '', models, efforts }
  })
export type Settings = z.infer<typeof Settings>

export const DEFAULT_SETTINGS: Settings = {
  /*
   * Both, and Claude first.
   *
   * This said one agent, and the argument was cost: two agents is two provider
   * processes and twice the wait before anything can be typed, so the other
   * could be brought in from its chip when the conversation needed it. What that
   * missed is that **the product is the shared room** — a conversation with one
   * agent in it is the thing Chorus exists to replace, and asking for the second
   * one is a step nobody takes before they know they want it. An agent brought in
   * late reads the transcript as catch-up, which works, but it has not been
   * *present* for the reasoning it is catching up on.
   *
   * Claude first because the order is read: it leads the composer's placeholder
   * and the cast toggles, and something has to be named first.
   *
   * Only the default. A session still chooses its own cast, and toggling one no
   * longer writes back here — see `setParticipants` in `App.tsx` for why a cast
   * is not a preference.
   */
  agents: ['claude', 'codex'],
  cwd: '',
  // Permissive defaults ship by accident, not on purpose (plan §4.4).
  profileId: 'read-only',
  // Nothing chosen: the provider decides, which is the right default for a
  // machine whose CLI we have not asked yet.
  model: '',
  effortLevel: '',
  // Off until someone says which language. See the field's own comment.
  explainLanguage: '',
  models: { codex: '', claude: '' },
  efforts: { codex: '', claude: '' },
  // Follow the OS, which is what every version before the setting existed did.
  theme: 'system',
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
