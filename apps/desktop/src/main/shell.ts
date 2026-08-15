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
 *
 * **The mode check is Unix-only, and leaving it universal was a real bug.**
 * libuv synthesises `st_mode` on Windows from one bit of information — the
 * read-only attribute — so a regular file comes back `0o666` and a read-only
 * one `0o444`. The execute bits are never set, for `cmd.exe` as much as for
 * anything else. With the check applied there, every candidate failed, the loop
 * over `fallbacks()` found nothing, and `resolveShell` reached its "nothing
 * validated" return every single time.
 *
 * That return hands back `COMSPEC` anyway, so a Windows terminal did open — by
 * the path meant for a machine with no shell at all. The bug was invisible
 * precisely because it produced the right answer, and any later edit to that
 * fallback would have changed Windows behaviour and nothing else.
 */
export function isExecutableFile(
  path: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    // Being a file is the whole test on Windows; what makes it runnable is its
    // extension against PATHEXT, which is `command.ts`'s business, not a mode.
    if (platform === 'win32') return true
    return (stat.mode & 0o111) !== 0
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
    /*
     * `cmd.exe` always last, even when COMSPEC is set.
     *
     * It used to be *either* COMSPEC or `cmd.exe`, which left Windows with a
     * single fallback — and it was the value that had already been rejected one
     * line earlier in `resolveShell`. A COMSPEC pointing at a directory or a
     * deleted file therefore fell all the way through to the "nothing
     * validated" return and came back as the shell, so Chorus tried to spawn a
     * directory. Unix has had three fallbacks here since the file was written;
     * this gives Windows its second.
     */
    const comspec = env['COMSPEC']
    return comspec === undefined || comspec === '' ? ['cmd.exe'] : [comspec, 'cmd.exe']
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

  if (preferred !== undefined && preferred !== '' && isExecutableFile(preferred, platform)) {
    return { file: preferred, args: login }
  }

  for (const candidate of fallbacks(platform, env)) {
    if (isExecutableFile(candidate, platform)) return { file: candidate, args: login }
  }

  /*
   * Nothing validated. Return a fallback by name rather than throwing: spawning
   * it will fail with its own error, which is more useful than this module's
   * guess at why, and a terminal that reports "cannot start" beats one that
   * takes the app down at startup.
   *
   * The **last** entry, not the first — `fallbacks()` is ordered preference-first
   * and guarantee-last, so the last is `/bin/sh` on Unix and `cmd.exe` on
   * Windows. Taking the first contradicted the ordering that function documents:
   * with a `$SHELL` pointing at a uninstalled shell it returned `/bin/zsh`,
   * which is the entry most likely to be missing on the machine that got here,
   * and on Windows it returned COMSPEC — the exact value rejected two lines
   * above, so a COMSPEC naming a directory came back as the shell to spawn.
   */
  const candidates = fallbacks(platform, env)
  return { file: candidates[candidates.length - 1] ?? '/bin/sh', args: login }
}
