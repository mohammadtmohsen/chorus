import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { spawnSpec } from './command.js'
import { resolveCommand } from './which.js'

const run = promisify(execFile)

/**
 * What the user's plugins are, and whether they are switched on.
 *
 * Plugins load into every session the same way MCP servers and skills do — they
 * contribute commands, agents and hooks that an agent has and Chorus never
 * mentions. A disabled one is the interesting case, for the same reason
 * `needs-auth` is on a server: it is configured, believed in, and contributing
 * nothing.
 *
 * Shelled out to `claude plugin list --json` rather than read from
 * `~/.claude/plugins/*.json`, which the plan called the more honest of the two —
 * `--json` is a stated machine interface, and the directory layout is not.
 *
 * Deliberately not `claude plugin details`, which prints a component inventory
 * and a projected token cost and has **no `--json`**. Scraping a formatted
 * table to put numbers on screen is the private-format commitment this project
 * declined for checkpoints, and the failure mode is silently wrong figures
 * rather than an error.
 */

export interface PluginInfo {
  /** `name@marketplace`, which is how the CLI identifies it. */
  readonly id: string
  /** The bare name, which is what a person calls it. */
  readonly name: string
  readonly enabled: boolean
  /** `user`, `project`, `local` — where it was installed from. */
  readonly scope: string
  /** Absent when the CLI reports it as "unknown", which it often does. */
  readonly version?: string
}

/** Long enough for a cold CLI start, short enough not to hang the sheet. */
const TIMEOUT_MS = 10_000

export async function listPlugins(): Promise<PluginInfo[]> {
  const claude = await resolveCommand('claude')
  if (claude === null) return []

  try {
    const { file, args } = spawnSpec(claude, ['plugin', 'list', '--json'])
    const { stdout } = await run(file, args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    return parsePlugins(stdout)
  } catch {
    // No claude, a version too old to have the subcommand, or a machine with no
    // plugins at all. All three mean the same to the caller: nothing to show.
    return []
  }
}

/**
 * Exported for tests, because this is the half that can be wrong.
 *
 * Every field is checked rather than trusted. The command is another program's
 * output, and a release that renames a key should cost the panel a row, not
 * throw inside the settings sheet.
 */
export function parsePlugins(stdout: string): PluginInfo[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed.flatMap((entry): PluginInfo[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const row = entry as Record<string, unknown>
    const id = typeof row['id'] === 'string' ? row['id'] : ''
    if (id === '') return []

    const version = typeof row['version'] === 'string' ? row['version'] : ''
    return [
      {
        id,
        // `name@marketplace` — the marketplace is noise in a list of what you
        // have, and the id is kept for anything that needs to address it.
        name: id.split('@')[0] ?? id,
        // Absent rather than false when the key is missing: a plugin the CLI
        // did not describe is not a plugin we should draw as switched off.
        enabled: row['enabled'] !== false,
        scope: typeof row['scope'] === 'string' ? row['scope'] : '',
        // The CLI says "unknown" more often than it says a version, and a row
        // reading "unknown" is worse than one that says nothing.
        ...(version === '' || version === 'unknown' ? {} : { version }),
      },
    ]
  })
}
