import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { spawnSpec, type ResolvedCommand } from './command.js'
import { compare, resolveCommand } from './which.js'

/**
 * Installing and updating the companion VS Code extension (plan §6).
 *
 * The VSIX ships inside Chorus and is installed on request, never silently.
 * Marketplace publication is a separate decision requiring credentials and
 * review; bundling means the extension is always exactly the one this build's
 * protocol was written against, which is the property that matters while the
 * protocol is at version 1.
 */

/** `publisher.name`, as VS Code reports it. */
export const EXTENSION_ID = 'chorus.chorus-vscode'

const run = promisify(execFile)

export type ExtensionNeed = 'none' | 'install' | 'update'

export interface ExtensionStatus {
  /** False when the `code` command is not on PATH at all. */
  readonly cliAvailable: boolean
  readonly installedVersion: string | null
  readonly bundledVersion: string | null
  readonly need: ExtensionNeed
}

export interface ExtensionDeps {
  /**
   * The `code` launcher, resolved to something spawnable.
   *
   * A `ResolvedCommand` rather than a path because on Windows VS Code installs
   * `code.cmd`, and every `exec` below would otherwise be handed a shim that
   * `spawn` refuses to run — the VSIX install being the one that matters, since
   * a failed install is how the extension silently never appears.
   */
  readonly findCode: () => Promise<ResolvedCommand | null>
  readonly exec: (bin: string, args: readonly string[]) => Promise<{ stdout: string }>
  readonly vsixPath: () => string | null
  readonly bundledVersion: () => string | null
}

/**
 * Parse `code --list-extensions --show-versions`.
 *
 * Matched case-insensitively on the id: VS Code lowercases extension ids
 * internally, so a manifest with a capital letter in its publisher comes back
 * in a different case than it went in.
 */
export function parseInstalledVersion(stdout: string, id: string): string | null {
  const wanted = id.toLowerCase()
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    const at = trimmed.lastIndexOf('@')
    if (at <= 0) continue
    if (trimmed.slice(0, at).toLowerCase() !== wanted) continue
    const version = trimmed.slice(at + 1)
    return version === '' ? null : version
  }
  return null
}

/** Numeric comparison, so `0.10.0` is newer than `0.9.0` rather than earlier. */
export function isOlder(installed: string, bundled: string): boolean {
  const parts = (v: string): number[] =>
    v.split(/[.+-]/).map((piece) => {
      const n = Number.parseInt(piece, 10)
      return Number.isNaN(n) ? 0 : n
    })
  return compare(parts(installed), parts(bundled)) < 0
}

/**
 * What, if anything, the user should be offered.
 *
 * Every failure resolves to a status rather than throwing. This is called to
 * decide whether to draw a button; an exception here would take out the
 * settings panel over a missing optional tool.
 */
export async function extensionStatus(deps: ExtensionDeps): Promise<ExtensionStatus> {
  const bundledVersion = deps.bundledVersion()
  const code = await deps.findCode()
  if (code === null) {
    return { cliAvailable: false, installedVersion: null, bundledVersion, need: 'none' }
  }

  let installedVersion: string | null
  try {
    const listing = spawnSpec(code, ['--list-extensions', '--show-versions'])
    const { stdout } = await deps.exec(listing.file, listing.args)
    installedVersion = parseInstalledVersion(stdout, EXTENSION_ID)
  } catch {
    // A `code` that cannot list extensions cannot install one either; report it
    // as if the CLI were absent rather than offering an action that will fail.
    return { cliAvailable: false, installedVersion: null, bundledVersion, need: 'none' }
  }

  if (bundledVersion === null) {
    return { cliAvailable: true, installedVersion, bundledVersion, need: 'none' }
  }
  if (installedVersion === null) {
    return { cliAvailable: true, installedVersion, bundledVersion, need: 'install' }
  }
  return {
    cliAvailable: true,
    installedVersion,
    bundledVersion,
    need: isOlder(installedVersion, bundledVersion) ? 'update' : 'none',
  }
}

export interface ActionResult {
  readonly ok: boolean
  /** A reason code, never a path or a shell string. */
  readonly reason: string | null
}

/**
 * Install or replace the bundled VSIX.
 *
 * `--force` because this is also the update path: without it `code` refuses
 * when any version is already present, and the user would have to uninstall by
 * hand to move forward one version.
 */
export async function installBundledExtension(deps: ExtensionDeps): Promise<ActionResult> {
  const code = await deps.findCode()
  if (code === null) return { ok: false, reason: 'cli-missing' }
  const vsix = deps.vsixPath()
  if (vsix === null) return { ok: false, reason: 'vsix-missing' }

  try {
    // An argument array, never a shell string: a project path with a space or a
    // quote in it would otherwise be a command injection.
    const install = spawnSpec(code, ['--install-extension', vsix, '--force'])
    await deps.exec(install.file, install.args)
    return { ok: true, reason: null }
  } catch {
    return { ok: false, reason: 'install-failed' }
  }
}

/**
 * Open a folder in VS Code.
 *
 * No `--new-window` or `--reuse-window`: which of those the user wants is a VS
 * Code preference they have already set, and overriding it here would be Chorus
 * having an opinion about someone else's window management.
 */
export async function openProjectInEditor(
  cwd: string,
  deps: Pick<ExtensionDeps, 'findCode' | 'exec'>
): Promise<ActionResult> {
  const code = await deps.findCode()
  if (code === null) return { ok: false, reason: 'cli-missing' }
  try {
    const open = spawnSpec(code, [cwd])
    await deps.exec(open.file, open.args)
    return { ok: true, reason: null }
  } catch {
    return { ok: false, reason: 'open-failed' }
  }
}

/**
 * Open one file in VS Code, at the project it belongs to.
 *
 * **A sibling of `openProjectInEditor`, not a flag on it.** That function is
 * covered by a test asserting it passes exactly one argument and adds no window
 * flags, and that assertion guards a real decision — which window a thing opens
 * in is the user's VS Code preference. Adding `-g` there would have broken it
 * for a reason unrelated to what it was protecting.
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

/**
 * Where the VSIX is, packaged and unpackaged.
 *
 * Packaged it sits in `extraResources`, outside the asar — an asar is not a
 * real directory, and `code --install-extension` needs a path it can open.
 * Unpackaged it is wherever the extension's own build put it, so `pnpm dev`
 * behaves like the shipped app instead of silently having no VSIX.
 */
export function resolveVsix(options: {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
}): string | null {
  const candidates = options.packaged
    ? [join(options.resourcesPath, 'chorus-vscode.vsix')]
    : [
        join(options.appPath, '../../apps/vscode-extension/chorus-vscode.vsix'),
        join(options.appPath, '../vscode-extension/chorus-vscode.vsix'),
      ]
  return candidates.find((path) => existsSync(path)) ?? null
}

/**
 * The version of the VSIX that is actually on disk.
 *
 * `package.mjs` writes it beside the archive in the same run, from the same
 * manifest, so it describes that build rather than the tree it was built from.
 *
 * Until 2026-08-13 this was `app.getVersion()`, which is not a fact about the
 * VSIX at all: the app was `0.12.0` while the extension shipped `0.6.0`, so
 * `extensionStatus` computed `need: 'update'` on a machine that was already up
 * to date, and pressing the button reinstalled the same version and left the
 * prompt standing. That mattered beyond tidiness — it is the path a user has to
 * follow when the protocol version moves.
 *
 * A malformed or missing sidecar answers `null`, which already means "offer
 * nothing": an app packaged before this existed loses the update button rather
 * than gaining a wrong one.
 */
export function readBundledVersion(vsixPath: string | null): string | null {
  if (vsixPath === null) return null
  let raw: string
  try {
    raw = readFileSync(`${vsixPath}.version`, 'utf8')
  } catch {
    return null
  }
  const version = raw.trim()
  return /^\d+\.\d+\.\d+(?:[.+-][0-9A-Za-z.+-]+)?$/.test(version) ? version : null
}

/** The real dependencies, for production. */
export function defaultDeps(options: {
  readonly vsixPath: () => string | null
  readonly bundledVersion: () => string | null
}): ExtensionDeps {
  return {
    findCode: () => resolveCommand('code'),
    exec: async (bin, args) => {
      const { stdout } = await run(bin, [...args], { timeout: 60_000 })
      return { stdout }
    },
    vsixPath: options.vsixPath,
    bundledVersion: options.bundledVersion,
  }
}
