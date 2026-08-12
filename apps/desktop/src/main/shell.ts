import { statSync } from 'node:fs'

/**
 * Which shell a terminal opens, and how.
 *
 * Deliberately *not* `which.ts`. That file exists to choose between several
 * installed copies of an agent CLI: it asks each candidate its `--version` and
 * keeps the newest, because a machine with Homebrew and npm copies of `codex`
 * resolves to the old one and it will not start. None of that applies here. A
 * shell has no version ranking worth having, `$SHELL` is already absolute, and
 * running `zsh --version` to pick between two zshes would be inventing a problem.
 *
 * What does apply is that `$SHELL` can be stale — a path to a shell that was
 * uninstalled, or pointing at a directory — so it is validated as an
 * **executable file** rather than merely one that exists. `existsSync` is true
 * for a directory, and spawning one fails with a message that blames the
 * terminal rather than the setting.
 */

/** What to spawn, and the arguments that make it behave like Terminal.app. */
export interface ShellChoice {
  readonly file: string
  readonly args: readonly string[]
}

/**
 * A file that can actually be exec'd.
 *
 * `statSync` rather than `access(X_OK)` because the mode is also what
 * distinguishes a directory, and a directory on `$SHELL` is the failure this
 * guards. Throws are swallowed: a missing path is simply not a shell.
 */
export function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile() && (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * The fallbacks, in the order they are tried.
 *
 * `/bin/sh` is last on Unix because POSIX guarantees it exists; if that is
 * missing the machine has bigger problems than a terminal.
 */
function fallbacks(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const comspec = env['COMSPEC']
    return comspec === undefined || comspec === '' ? ['cmd.exe'] : [comspec]
  }
  return ['/bin/zsh', '/bin/bash', '/bin/sh']
}

/**
 * A **login** shell on Unix, which is what makes it feel like Terminal.app.
 *
 * Not cosmetic. A non-login shell skips the user's profile, so `PATH` is
 * whatever Chorus inherited — and under a Finder launch that is
 * `/usr/bin:/bin:…` with no Homebrew, no nvm, no `~/.local/bin`. `which.ts`'s
 * `adoptShellPath()` exists precisely because that gap already bit this app once
 * for agent CLIs; opening a terminal without `-l` would reintroduce it inside
 * the terminal, where the user would meet it as "brew: command not found".
 *
 * Windows shells have no equivalent flag, so they get none.
 */
export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ShellChoice {
  const login = platform === 'win32' ? [] : ['-l']
  const preferred = platform === 'win32' ? env['COMSPEC'] : env['SHELL']

  if (preferred !== undefined && preferred !== '' && isExecutableFile(preferred)) {
    return { file: preferred, args: login }
  }

  for (const candidate of fallbacks(platform, env)) {
    if (isExecutableFile(candidate)) return { file: candidate, args: login }
  }

  /*
   * Nothing validated. Return the first fallback by name rather than throwing:
   * spawning it will fail with its own error, which is more useful than this
   * module's guess at why, and a terminal that reports "cannot start" beats one
   * that takes the app down at startup.
   */
  const [first = '/bin/sh'] = fallbacks(platform, env)
  return { file: first, args: login }
}
