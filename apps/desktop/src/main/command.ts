import { posix, win32 } from 'node:path'

/**
 * What it takes to launch one of the user's CLIs, on either platform.
 *
 * `which.ts` used to answer this with a single path, which is true on macOS and
 * not true on Windows. There, npm installs `codex` and `claude` as a `.cmd`
 * shim rather than an executable, and since the CVE-2024-27980 fix (Node
 * 18.20.2 / 20.12.2) `child_process.spawn` refuses to run a `.cmd` at all
 * unless `shell: true` — which is not an option here, because the arguments
 * being passed include user text and turning on a shell turns on its
 * metacharacters with it.
 *
 * So a resolved command is a file *plus* the arguments that make that file
 * runnable, and the kind that says why.
 *
 * ## The three kinds, and why the caller has to care
 *
 * - `native` — a real executable. `file` is it, `argsPrefix` is empty. Every
 *   macOS case and a Windows `.exe`.
 * - `cmd-shim` — a Windows `.cmd`/`.bat`. `file` is `cmd.exe` and `argsPrefix`
 *   carries `/d /s /c <shim>`, so the caller spawns cmd and cmd runs the shim.
 * - `node-script` — the JavaScript entry point the shim would have run, found
 *   by reading the shim. `file` is that `.js`.
 *
 * The last one exists for one consumer. The Claude adapter does not spawn
 * anything: it hands a path to the Agent SDK, whose
 * `pathToClaudeCodeExecutable?: string` (read out of `sdk.d.ts`, not inferred)
 * is a single string with no slot for an argument prefix. `executableArgs`
 * looks like the way out and is not — its own doc string says "additional
 * arguments to pass to the JavaScript **runtime** executable", i.e. flags for
 * node, not a command prefix. So there is nowhere to put `cmd.exe /d /s /c`,
 * and the only shape the SDK can accept on Windows is the script itself, which
 * it will run under node.
 */
export interface ResolvedCommand {
  /** The thing to spawn — or, for `node-script`, the thing to hand the SDK. */
  readonly file: string
  /** Arguments that must come before the caller's own. Empty except for a shim. */
  readonly argsPrefix: readonly string[]
  readonly kind: 'native' | 'cmd-shim' | 'node-script'
}

/** `path` for the platform being resolved *for*, which in tests is not this one. */
function ops(platform: NodeJS.Platform): typeof win32 {
  return platform === 'win32' ? win32 : posix
}

/**
 * The extensions Windows will run, in the order it tries them.
 *
 * Read from `PATHEXT` rather than hardcoded, because a machine can add to it
 * and the order is the resolution order. The default is what a stock Windows
 * sets; the filter drops empties from a trailing or doubled semicolon, which
 * real registries do contain.
 *
 * Lowercased on the way out so comparison against a filename does not have to
 * care — `PATHEXT` is conventionally uppercase and filenames rarely are.
 */
export function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD'
  return raw
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.startsWith('.') && entry.length > 1)
}

/**
 * Every path worth testing for `name`, best-guess first.
 *
 * On Windows a bare name is not a filename: `codex` is `codex.exe` or
 * `codex.cmd` and the caller does not know which, so each PATH entry is
 * multiplied by `PATHEXT`. The bare name is still offered first, because a
 * PATH entry may legitimately hold a file with no extension and it costs one
 * `existsSync` to find out.
 *
 * On Unix this is the same list `which.ts` always used, plus PATH, and the
 * split is `path.delimiter` rather than a literal `:` — the one character that
 * makes the function wrong on Windows for a reason unrelated to extensions.
 */
export function executableCandidates(
  name: string,
  options: {
    readonly platform: NodeJS.Platform
    readonly env: NodeJS.ProcessEnv
    readonly home: string
  }
): string[] {
  const { platform, env, home } = options
  const p = ops(platform)
  const found: string[] = []
  const add = (candidate: string): void => {
    if (!found.includes(candidate)) found.push(candidate)
  }

  const directories: string[] = []
  if (platform === 'win32') {
    /*
     * Where npm puts a global shim, and where it is *not* on PATH.
     *
     * An Electron app launched from the Start Menu inherits the user's
     * environment, so PATH is usually right — but `npm -g` writes to
     * `%APPDATA%\npm` and a machine whose PATH predates the npm install will
     * not list it. Same failure this file's Unix half already guards against
     * with `~/.local/bin`.
     */
    const appData = env['APPDATA']
    if (appData !== undefined && appData !== '') directories.push(p.join(appData, 'npm'))
    const localAppData = env['LOCALAPPDATA']
    if (localAppData !== undefined && localAppData !== '') {
      directories.push(p.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin'))
    }
  } else {
    directories.push(p.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  }

  const pathEntries = (env['PATH'] ?? env['Path'] ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  directories.push(...pathEntries)

  const extensions = platform === 'win32' ? pathExtensions(env) : []
  for (const directory of directories) {
    const base = p.join(directory, name)
    add(base)
    for (const extension of extensions) add(base + extension)
  }
  return found
}

/**
 * Classify a resolved path, and build the launch prefix a shim needs.
 *
 * `comspec` is threaded in rather than read from `process.env` so the Windows
 * cases are testable from macOS, and because a machine with a broken `COMSPEC`
 * should still get `cmd.exe` by name — `shell.ts` reaches the same conclusion
 * one layer down for the same reason.
 *
 * ## The quoting caveat, stated rather than buried
 *
 * `/d` skips AutoRun commands from the registry, which would otherwise run
 * before the shim and can print to stdout. `/s` changes how `/c` treats quotes
 * and `/c` runs the command. This is the prefix npm's own shims and cross-spawn
 * use, and the arguments after it are passed through Node's normal
 * argument-quoting rather than concatenated into a command string — which is
 * the part that keeps a `&` or a `|` in a user's prompt from being read by cmd
 * as an operator.
 *
 * **This has not been run on Windows.** The shape is taken from the documented
 * behaviour of `cmd /c` and from what npm ships, not from an observed spawn,
 * and argument quoting through cmd is the single most likely thing here to be
 * subtly wrong. It is Phase 1's first item to verify on a real machine.
 */
export function classify(
  executablePath: string,
  options: { readonly platform: NodeJS.Platform; readonly comspec?: string | undefined }
): ResolvedCommand {
  const { platform } = options
  if (platform !== 'win32') {
    return { file: executablePath, argsPrefix: [], kind: 'native' }
  }

  const extension = win32.extname(executablePath).toLowerCase()
  if (extension === '.cmd' || extension === '.bat') {
    const comspec =
      options.comspec !== undefined && options.comspec !== '' ? options.comspec : 'cmd.exe'
    return {
      file: comspec,
      argsPrefix: ['/d', '/s', '/c', executablePath],
      kind: 'cmd-shim',
    }
  }

  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return { file: executablePath, argsPrefix: [], kind: 'node-script' }
  }

  return { file: executablePath, argsPrefix: [], kind: 'native' }
}

/**
 * The JavaScript file an npm shim would have run, or null.
 *
 * npm's `cmd-shim` writes a pair: an extensionless `sh` script for MSYS/Git
 * Bash and a `.cmd` for Windows. Both end in a line that runs node against a
 * path relative to the shim's own directory — `%dp0%` in the `.cmd`,
 * `$basedir` in the shell one. That path is what the Claude SDK needs, because
 * it cannot be given a shim.
 *
 * **Null is a real answer and the caller must handle it.** This parses a format
 * that no test here has seen come off a real `npm install` on Windows — it is
 * written from cmd-shim's documented output, which is exactly the "guessed
 * shape" this repo has been bitten by before. Returning null when the line does
 * not match means an unrecognised shim degrades to `cmd-shim` kind, which still
 * launches correctly for every consumer except the SDK, rather than producing a
 * confidently wrong path.
 */
export function parseShimTarget(
  contents: string,
  shimPath: string,
  platform: NodeJS.Platform
): string | null {
  const p = ops(platform)
  const directory = p.dirname(shimPath)

  // Both shim flavours quote the script path; the `.cmd` uses backslashes after
  // `%dp0%` and the `sh` one forward slashes after `$basedir`. One pattern with
  // the variable made optional covers both, and the `.js` anchor is what keeps
  // it from matching `%_prog%` or the shim's own name.
  const target = /["']\s*(?:%dp0%|\$basedir)[\\/]?([^"']+?\.[cm]?js)\s*["']/i.exec(contents)?.[1]
  if (target === undefined) return null
  return p.resolve(directory, target.replace(/\\/g, p.sep).replace(/\//g, p.sep))
}

/**
 * What to hand `spawn`/`execFile`: the file, and the prefix ahead of the args.
 *
 * The one place a `ResolvedCommand` becomes a real launch, so the prefix cannot
 * be forgotten at a call site — which is the bug this whole type exists to make
 * unrepresentable.
 */
export function spawnSpec(
  resolved: ResolvedCommand,
  args: readonly string[] = []
): { readonly file: string; readonly args: string[] } {
  return { file: resolved.file, args: [...resolved.argsPrefix, ...args] }
}

/**
 * The path-only answer, for the Claude SDK and nothing else.
 *
 * Null for a `cmd-shim`, deliberately: handing the SDK a `.cmd` it will try to
 * spawn without a shell is the EINVAL this module exists to avoid, and a null
 * lets the adapter raise its own "could not find the claude CLI" message rather
 * than surfacing a spawn error from inside the SDK.
 */
export function sdkExecutablePath(resolved: ResolvedCommand): string | null {
  return resolved.kind === 'cmd-shim' ? null : resolved.file
}
