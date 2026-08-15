import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * A backstop for agent processes left behind by a crash.
 *
 * **This is defence, not a fix for an observed leak.** Measured on macOS: when
 * the Electron main process is SIGKILLed, its stdio-connected agent children
 * exit on their own — the pipes close and they die. An earlier reading of "two
 * orphans survived" was a broken test that killed the `npx` wrapper while
 * leaving Electron running, so the children still had a live parent.
 *
 * It stays because the cleanup it backs up is incidental rather than
 * guaranteed: an agent that ignores a closed stdin, or a future transport that
 * is not stdio, would leak a process holding a model session. The cost is one
 * `pgrep` at boot.
 *
 * Orphans are identified by having been reparented to init (PPID 1) rather than
 * by a recorded pid list. A pid file goes stale the moment the app crashes
 * writing it, and a reused pid would have us kill something unrelated. PPID 1 is
 * a fact about the process as it exists now.
 *
 * An agent started from a terminal has that shell as its parent, so it is never
 * a candidate — which matters, because Chorus drives the same CLIs the user runs
 * by hand.
 */

const AGENT_PATTERNS = ['codex app-server', 'claude --'] as const

export interface ReapResult {
  readonly killed: number
  readonly inspected: number
  /**
   * True when the backstop did not run at all, rather than ran and found
   * nothing. Those are different facts and the log should not conflate them.
   */
  readonly skipped: boolean
}

/**
 * Off on Windows, deliberately and visibly.
 *
 * It was already off there in effect: `pgrep` does not exist, `execFile` fails
 * with ENOENT, the catch treats that as "nothing matched", and the function
 * returned a confident `killed: 0`. That is the worst arrangement available —
 * indistinguishable in the log from a clean machine.
 *
 * The plan's instruction here was to measure before porting, and that
 * measurement needs a Windows machine nobody has run this on yet. Every piece
 * of the Unix strategy is a guess off Windows: PPID 1 is the Unix
 * reparenting convention and Windows has no equivalent — an orphan is simply a
 * process whose parent handle closed, with no marker on it; `SIGKILL` is not a
 * Windows signal; and `pgrep -f` matching on a command line would, ported
 * naively, match the user's own `codex` running in their own terminal, which is
 * the one thing the Unix version's PPID check exists to prevent.
 *
 * So it reports `skipped` and does nothing, which is at least true. What would
 * replace it is a job object or a pid whose ownership is proven, and that is
 * Phase 2 work with a Windows machine attached to it.
 */
export async function reapOrphanedAgents(
  platform: NodeJS.Platform = process.platform
): Promise<ReapResult> {
  if (platform === 'win32') return { killed: 0, inspected: 0, skipped: true }

  let killed = 0
  let inspected = 0

  for (const pattern of AGENT_PATTERNS) {
    for (const pid of await findPids(pattern)) {
      inspected += 1
      if (!(await isOrphan(pid))) continue
      try {
        process.kill(pid, 'SIGKILL')
        killed += 1
      } catch {
        // Gone between listing and killing, or not ours to kill. Either way
        // there is nothing to do and nothing worth reporting.
      }
    }
  }

  return { killed, inspected, skipped: false }
}

async function findPids(pattern: string): Promise<number[]> {
  try {
    const { stdout } = await run('pgrep', ['-f', pattern], { timeout: 5_000 })
    return stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  } catch {
    // pgrep exits non-zero when nothing matches, which is the common case.
    return []
  }
}

async function isOrphan(pid: number): Promise<boolean> {
  try {
    const { stdout } = await run('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 5_000 })
    return Number(stdout.trim()) === 1
  } catch {
    return false
  }
}
