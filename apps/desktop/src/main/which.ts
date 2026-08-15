import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import {
  classify,
  executableCandidates,
  parseShimTarget,
  spawnSpec,
  withScriptPath,
  type ResolvedCommand,
} from './command.js'

const run = promisify(execFile)

/**
 * Finding the user's CLIs — the right ones — when there is no shell to inherit.
 *
 * Three problems, discovered in that order.
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
 *
 * ## And a fourth, which is Windows
 *
 * A path is not enough there either, for a different reason: npm installs these
 * as `.cmd` shims, and `spawn` will not run a `.cmd` without a shell. So this
 * module no longer answers with a path at all — it answers with a
 * `ResolvedCommand`, and `command.ts` holds the platform reasoning. The
 * selection rule above is unchanged, and the macOS path through here is the same
 * one it always was.
 */

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
 *
 * **A no-op on Windows.** There is no login shell to ask and no `-lic` to ask it
 * with; a Windows process already inherits the user's environment from Explorer,
 * which is the thing this function exists to recover on macOS. Running it anyway
 * would spawn `/bin/zsh`, fail, and be caught — harmless, but it would also read
 * as though Windows were covered.
 */
export async function adoptShellPath(platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return

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

/**
 * Everything `resolveCommand` touches that is not a pure function.
 *
 * Injected as one object so the whole resolution — candidate order, shim
 * reading, version ranking, the tie-breaks — is testable without a filesystem
 * and, more to the point, testable for Windows from macOS. `command.ts` holds
 * the pure half; this is the seam between it and the machine.
 */
export interface ResolveDeps {
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  readonly home: string
  readonly exists: (path: string) => boolean
  /** Null rather than throwing: an unreadable shim is a shim we do not upgrade. */
  readonly readFile: (path: string) => string | null
  readonly realpath: (path: string) => string
  /** The user's login shell, asked directly. Unix only; empty on Windows. */
  readonly shellCandidates: (name: string) => Promise<string[]>
  /** Null when it will not run or will not say — either way, not a candidate. */
  readonly versionOf: (spec: { file: string; args: string[] }) => Promise<number[] | null>
}

export function defaultDeps(): ResolveDeps {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: existsSync,
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    realpath: (path) => {
      try {
        return realpathSync(path)
      } catch {
        return path
      }
    },
    shellCandidates: askShell,
    versionOf: async (spec) => {
      try {
        const { stdout } = await run(spec.file, spec.args, { timeout: 10_000 })
        const found = /(\d+)\.(\d+)\.(\d+)/.exec(stdout)
        if (found === null) return null
        return [Number(found[1]), Number(found[2]), Number(found[3])]
      } catch {
        return null
      }
    },
  }
}

const cache = new Map<string, ResolvedCommand | null>()

/** For tests, and for a settings action that should not be answered from a stale run. */
export function clearResolveCache(): void {
  cache.clear()
}

/**
 * The one boundary. What to launch, and what makes it launchable.
 *
 * Replaces the old `findExecutable(name): Promise<string | null>`. A path was a
 * complete answer on macOS and half an answer on Windows, and every consumer
 * that only stored the path would have dropped the half that matters.
 */
export async function resolveCommand(
  name: string,
  deps: ResolveDeps = defaultDeps()
): Promise<ResolvedCommand | null> {
  const known = cache.get(name)
  if (known !== undefined) return known

  const resolved = await resolveUncached(name, deps)
  cache.set(name, resolved)
  return resolved
}

async function resolveUncached(name: string, deps: ResolveDeps): Promise<ResolvedCommand | null> {
  const paths = new Set([
    ...executableCandidates(name, { platform: deps.platform, env: deps.env, home: deps.home }),
    ...(await deps.shellCandidates(name)),
  ])

  const commands = [...paths].filter(deps.exists).map((path) => upgrade(path, deps))

  /*
   * Ranked by version, newest first — the rule the Homebrew-vs-npm `codex` split
   * forced and the reason this function is not just "first path that exists".
   *
   * Identity is the realpath of the *underlying* target, not of `file`: on
   * Windows every shim resolves `file` to the same `cmd.exe`, so deduping on it
   * would collapse every candidate into one and pick an arbitrary winner.
   */
  const seen = new Set<string>()
  const ranked: { command: ResolvedCommand; version: number[] }[] = []
  await Promise.all(
    commands.map(async (command) => {
      const identity = deps.realpath(identityOf(command))
      if (seen.has(identity)) return
      seen.add(identity)
      const version = await deps.versionOf(spawnSpec(command, ['--version']))
      if (version !== null) ranked.push({ command, version })
    })
  )

  ranked.sort((a, b) => compare(b.version, a.version))
  return ranked[0]?.command ?? null
}

/**
 * Classify a path, and read a shim to find the script behind it.
 *
 * The read only happens for a `cmd-shim`, and only its failure is silent — a
 * shim whose format we do not recognise keeps the `cmd-shim` kind, which every
 * consumer but the Claude SDK can still launch. That degrade is the whole
 * reason `parseShimTarget` returns null instead of throwing.
 */
function upgrade(path: string, deps: ResolveDeps): ResolvedCommand {
  const base = classify(path, { platform: deps.platform, comspec: deps.env['COMSPEC'] })
  if (base.kind !== 'cmd-shim') return base

  const contents = deps.readFile(path)
  if (contents === null) return base
  const script = parseShimTarget(contents, path, deps.platform)
  if (script === null || !deps.exists(script)) return base
  return withScriptPath(base, script)
}

/** What makes two candidates the same install: the thing that actually runs. */
function identityOf(command: ResolvedCommand): string {
  if (command.scriptPath !== undefined) return command.scriptPath
  if (command.kind === 'cmd-shim') return command.argsPrefix[3] ?? command.file
  return command.file
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
 *
 * Windows gets nothing here rather than a translation. `where.exe` searches the
 * same PATH `executableCandidates` already walks, so asking it would add a
 * process launch and no candidates — and the interactive-shell trick this exists
 * for has no Windows equivalent to translate.
 */
async function askShell(name: string): Promise<string[]> {
  if (process.platform === 'win32') return []

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

/** Newest first, comparing numerically rather than as strings: 0.146 > 0.42. */
export function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
