import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { spawnSpec, type ResolvedCommand } from './command.js'
import { resolveCommand } from './which.js'

const run = promisify(execFile)

export interface ExtensionDeps {
  /**
   * The `code` launcher, resolved to something spawnable.
   *
   * A `ResolvedCommand` rather than a path because on Windows VS Code installs
   * `code.cmd`, and every `exec` below would otherwise be handed a shim that
   * `spawn` refuses to run.
   */
  readonly findCode: () => Promise<ResolvedCommand | null>
  readonly exec: (bin: string, args: readonly string[]) => Promise<{ stdout: string }>
}

export interface ActionResult {
  readonly ok: boolean
  /** A reason code, never a path or a shell string. */
  readonly reason: string | null
}

/**
 * Open one file in VS Code, at the project it belongs to.
 *
 * `-g` is `--goto`, which takes `path[:line[:column]]` and is why a line can be
 * added later without changing the shape of this. Two arguments, both from the
 * caller, both passed as array members — `spawnSpec` is what keeps a path with a
 * space or a semicolon from becoming shell.
 *
 * **The path is expected to be resolved and contained already.** This runs a
 * process on it; deciding whether a renderer may name it is the caller's job and
 * is done in `ipc.ts` against the conversation's own directory.
 */
export async function openFileInEditor(
  path: string,
  deps: Pick<ExtensionDeps, 'findCode' | 'exec'>
): Promise<ActionResult> {
  const code = await deps.findCode()
  if (code === null) return { ok: false, reason: 'cli-missing' }
  try {
    const open = spawnSpec(code, ['-g', path])
    await deps.exec(open.file, open.args)
    return { ok: true, reason: null }
  } catch {
    return { ok: false, reason: 'open-failed' }
  }
}

/** The real dependencies, for production. */
export function defaultDeps(): ExtensionDeps {
  return {
    findCode: () => resolveCommand('code'),
    exec: async (bin, args) => {
      const { stdout } = await run(bin, [...args], { timeout: 60_000 })
      return { stdout }
    },
  }
}
