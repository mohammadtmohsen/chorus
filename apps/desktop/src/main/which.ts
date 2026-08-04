import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Finding the user's CLIs — the right ones — when there is no shell to inherit.
 *
 * Two problems, discovered in that order.
 *
 * Chorus drives the installed `codex` and `claude` (plan §2.5) and used to spawn
 * them by name, which works only because `pnpm dev` runs in a terminal and
 * inherits its PATH. An app launched from Finder gets `/usr/bin:/bin:…` and
 * little else, so packaged, every session would have failed with "spawn codex
 * ENOENT" — which reads as "not installed" for something the user can run.
 *
 * Then: a machine can have several. This one had `codex` 0.42.0 from Homebrew
 * and 0.146.0 from npm, and the login shell resolved to the Homebrew one, which
 * is old enough that `app-server` will not start. Picking the first path that
 * exists picked the broken one.
 *
 * So every candidate is asked its version and the newest is used. It costs a few
 * `--version` calls once per run, and it is the only rule that survives a
 * machine with history on it.
 *
 * And then a third, which the first two hid: a path is not enough. The npm
 * `codex` is a `#!/usr/bin/env node` script, so running it needs `node` on PATH
 * — and under a Finder launch there is none. It failed its own `--version`,
 * dropped out of the running, and the old Homebrew binary won by default. So the
 * app adopts the shell's PATH before it looks for anything.
 */

/** Where these tend to live, plus whatever the user's shell believes. */
function candidates(name: string): string[] {
  return [
    join(homedir(), '.local/bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ]
}

/**
 * Give the process the PATH the user's terminal would have.
 *
 * Called once at startup, before anything is spawned. Everything downstream —
 * discovery here, and the agent processes themselves, which inherit this env —
 * then behaves the way it does in a terminal. Without it a resolved script still
 * cannot find its own interpreter.
 *
 * The existing PATH is kept on the end, so a machine whose shell says nothing
 * useful is no worse off than before.
 */
export async function adoptShellPath(): Promise<void> {
  const shell = process.env['SHELL'] ?? '/bin/zsh'
  try {
    const { stdout } = await run(shell, ['-lic', 'printf %s "$PATH"'], { timeout: 10_000 })
    // Absolute entries only. An interactive shell may print its prompt or a
    // theme's banner alongside the answer, and a PATH is not a place to guess.
    const fromShell = stdout
      .trim()
      .split(':')
      .filter((entry) => entry.startsWith('/'))
    if (fromShell.length === 0) return

    const merged = new Set([
      ...fromShell,
      ...(process.env['PATH'] ?? '').split(':').filter(Boolean),
    ])
    process.env['PATH'] = [...merged].join(':')
  } catch {
    // Keep the PATH we were given; the candidate list still covers the usual
    // install locations.
  }
}

const cache = new Map<string, string | null>()

export async function findExecutable(name: string): Promise<string | null> {
  const known = cache.get(name)
  if (known !== undefined) return known

  const paths = new Set([...candidates(name), ...(await askShell(name))])
  const usable = (
    await Promise.all(
      [...paths].filter((path) => existsSync(path)).map(async (path) => await versionOf(path))
    )
  ).filter((found): found is { path: string; version: number[] } => found !== null)

  const best = usable.sort((a, b) => compare(b.version, a.version))[0]
  const chosen = best?.path ?? null
  cache.set(name, chosen)
  return chosen
}

/**
 * The user's shell, asked both ways.
 *
 * `-l` runs the login files; `-i` runs `.zshrc` — and nvm, asdf and mise are
 * nearly always set up in the interactive one. With `-lc` alone this machine
 * offered only the Homebrew `codex` 0.42.0 and never the npm-installed 0.146.0,
 * because the newer one sits on a PATH that `.zshrc` builds.
 *
 * `which -a`, so every install is a candidate and the newest can win.
 */
async function askShell(name: string): Promise<string[]> {
  const shell = process.env['SHELL'] ?? '/bin/zsh'
  const found = new Set<string>()

  for (const flags of ['-lic', '-lc']) {
    try {
      const { stdout } = await run(
        shell,
        [flags, `which -a ${name} 2>/dev/null || command -v ${name}`],
        { timeout: 10_000 }
      )
      for (const line of stdout.split('\n')) {
        const path = line.trim()
        if (path.startsWith('/')) found.add(path)
      }
    } catch {
      // A shell that will not answer is not an error; the other one may.
    }
  }
  return [...found]
}

/** Null when it will not run or will not say — either way, not a candidate. */
async function versionOf(path: string): Promise<{ path: string; version: number[] } | null> {
  try {
    const { stdout } = await run(path, ['--version'], { timeout: 10_000 })
    const found = /(\d+)\.(\d+)\.(\d+)/.exec(stdout)
    if (found === null) return null
    return {
      // Resolved, so two links to the same binary do not compete.
      path: realpathSync(path),
      version: [Number(found[1]), Number(found[2]), Number(found[3])],
    }
  } catch {
    return null
  }
}

/** Newest first, comparing numerically rather than as strings: 0.146 > 0.42. */
export function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
