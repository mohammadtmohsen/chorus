import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentProbeResult } from '../shared/ipc.js'

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
    const { stdout } = await run(probe.command, [...probe.args], { timeout: 10_000 })
    return {
      id: probe.id,
      installed: true,
      version: extractVersion(stdout),
      problem: null,
    }
  } catch (error) {
    return {
      id: probe.id,
      installed: false,
      version: null,
      problem: error instanceof Error ? error.message : String(error),
    }
  }
}

/** `codex --version` prints "codex-cli 0.146.0"; `claude --version` prints "2.1.220 (Claude Code)". */
export function extractVersion(stdout: string): string | null {
  return /\d+\.\d+\.\d+[\w.-]*/.exec(stdout.trim())?.[0] ?? null
}
