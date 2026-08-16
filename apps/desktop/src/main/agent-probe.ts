import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentProbeResult } from '../shared/ipc.js'
import { spawnSpec, type ResolvedCommand } from './command.js'
import { resolveCommand } from './which.js'

const run = promisify(execFile)

/**
 * Chorus drives the user's installed CLIs rather than bundling its own
 * (plan §2.5). That makes their versions part of our runtime state: recording
 * them turns "it broke this morning" into "claude went 2.1.220 -> 2.2.0".
 */
const PROBES = [
  { id: 'codex', command: 'codex', args: ['--version'] },
  { id: 'claude', command: 'claude', args: ['--version'] },
] as const

export async function probeAgents(): Promise<AgentProbeResult[]> {
  return Promise.all(PROBES.map(probeOne))
}

async function probeOne(probe: (typeof PROBES)[number]): Promise<AgentProbeResult> {
  try {
    /*
     * By absolute path: a packaged app has no terminal's PATH to inherit.
     *
     * Through `spawnSpec` rather than by taking `.file`, so a Windows `.cmd`
     * shim arrives as `cmd.exe /d /s /c <shim> --version` instead of as a bare
     * shim path that `spawn` rejects. Nothing found still falls back to the bare
     * name — the resulting ENOENT is what tells the user it is not installed.
     */
    const resolved = await resolveCommand(probe.command)
    const { file, args } =
      resolved === null
        ? { file: probe.command, args: [...probe.args] }
        : spawnSpec(resolved, probe.args)
    const { stdout } = await run(file, args, { timeout: 10_000 })
    return {
      id: probe.id,
      installed: true,
      version: extractVersion(stdout),
      problem: null,
      reason: null,
      foundAt: null,
    }
  } catch (error) {
    /*
     * Which failure it was, decided here because here is where it is known.
     *
     * `resolveCommand` returning null means nothing exists at any candidate
     * path — that is a missing install, and the advice is how to install it.
     * A resolution that then fails to run is a different thing entirely: the
     * file is there, so telling the user to install it would send them round a
     * loop they have already been through. Most often a shim whose interpreter
     * is gone, which is the third failure `which.ts` documents.
     */
    const resolved = await resolveCommand(probe.command)
    return {
      id: probe.id,
      installed: false,
      version: null,
      problem: error instanceof Error ? error.message : String(error),
      reason: resolved === null ? 'missing' : 'failed',
      foundAt: resolved === null ? null : identityPath(resolved),
    }
  }
}

/** `codex --version` prints "codex-cli 0.146.0"; `claude --version` prints "2.1.220 (Claude Code)". */
export function extractVersion(stdout: string): string | null {
  return /\d+\.\d+\.\d+[\w.-]*/.exec(stdout.trim())?.[0] ?? null
}

/**
 * What to show a person as "where it is".
 *
 * A `cmd-shim` resolves `file` to `cmd.exe`, which is true and useless — the
 * shim's own path is the thing they would go and look at.
 */
function identityPath(resolved: ResolvedCommand): string {
  return resolved.kind === 'cmd-shim'
    ? (resolved.argsPrefix.at(-1) ?? resolved.file)
    : (resolved.scriptPath ?? resolved.file)
}
