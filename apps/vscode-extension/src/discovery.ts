import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { descriptorIsPrivate } from '@chorus/ide-protocol'

/**
 * Finding the Chorus processes this window may talk to (plan §4).
 *
 * Chorus publishes one descriptor per process rather than binding a fixed
 * path, because a fixed path breaks the moment a second Chorus launches and
 * fails in the least obvious way — the newer process silently takes the older
 * one's socket. Per-pid descriptors cost a directory scan and nothing else.
 */

export interface Descriptor {
  readonly pid: number
  readonly socketPath: string
  readonly token: string
  readonly protocolVersion: number
  readonly chorusVersion: string
}

export interface DiscoveryDeps {
  /** Injected so tests do not have to create processes. */
  readonly isAlive: (pid: number) => boolean
  /**
   * Named by tests, inherited in production.
   *
   * The privacy check below is meaningless on Windows and says so by returning
   * true, so a suite that asserts "a world-readable descriptor is refused" is
   * asserting unix — and without naming it, asserted its own host instead.
   */
  readonly platform?: NodeJS.Platform
}

/** Whether a pid is still running, without signalling it. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user. Still alive;
    // its descriptor would have been rejected by the permission check anyway.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isPrivate(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const stats = statSync(path)
    return descriptorIsPrivate(stats, process.getuid?.(), platform)
  } catch {
    return false
  }
}

/**
 * Read every live descriptor in the directory.
 *
 * A crash leaves the file behind, so liveness is checked by pid rather than
 * assumed from the file's existence — three of the five Claude Code lock files
 * on this machine were stale when the protocol was surveyed, which is what
 * that failure mode looks like in practice.
 *
 * Nothing here deletes another process's files. A descriptor whose pid is gone
 * is skipped and left alone: the process that wrote it owns its cleanup, and
 * an extension racing to tidy up would eventually delete a live one.
 */
export function readDescriptors(directory: string, deps: DiscoveryDeps): Descriptor[] {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    // No directory means no Chorus is running, which is a normal state.
    return []
  }

  const found: Descriptor[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const path = join(directory, entry)
    // A descriptor anyone else can read is one we must not trust: the token in
    // it would already be compromised.
    if (!isPrivate(path, deps.platform ?? process.platform)) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    const descriptor = asDescriptor(parsed)
    if (descriptor === null) continue
    if (!deps.isAlive(descriptor.pid)) continue
    found.push(descriptor)
  }
  return found
}

function asDescriptor(value: unknown): Descriptor | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const pid = record['pid']
  const socketPath = record['socketPath']
  const token = record['token']
  const protocolVersion = record['protocolVersion']
  const chorusVersion = record['chorusVersion']
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof socketPath !== 'string' || socketPath === '') return null
  if (typeof token !== 'string' || token === '') return null
  if (typeof protocolVersion !== 'number') return null
  if (typeof chorusVersion !== 'string') return null
  return { pid, socketPath, token, protocolVersion, chorusVersion }
}
