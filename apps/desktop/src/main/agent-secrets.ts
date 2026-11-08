import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { OfferedSecret, SecretId as SecretIdSchema } from '../../../engine/src/protocol.js'
import type { SecretId } from './host-ports.js'
export type { SecretId } from './host-ports.js'

/**
 * A credential an agent needs, encrypted, and reachable only from main.
 *
 * **Deliberately not `workbench-secrets.ts`, and the separation is the whole
 * point of this file.** That store is correct for what it holds and is wired to
 * a generic channel: `readSecret(key: string)` in the preload reaches a handler
 * that returns whatever key it is asked for, to any workbench surface, with no
 * allowlist. An installed extension asking for an agent's key by name would be
 * handed it in plaintext. So this keeps the same mechanism and none of the
 * reach — a different file, and no channel anywhere names it.
 *
 * **The key is a `SecretId`, not a string.** The workbench store takes a string
 * because a `secretStorageProvider` must; nothing here does, and a closed set
 * means there is no such thing as asking for a key this module did not intend
 * to hold.
 *
 * **`SecretId` is deliberately wider than `AgentId`, and deliberately not
 * `AgentId` itself.** A service an agent calls needs a credential without being
 * a voice in the cast: `ACTORS` in `@chorus/shared` spreads `AGENT_IDS`, and both
 * `AgentIdSchema` and `ActorSchema` are `z.enum` over those tuples — so a member
 * added there becomes a speaker the event log accepts, owing a colour, a label
 * and a row. The union keeps the closed set this file depends on without paying
 * for any of that.
 *
 * What a caller may learn from the renderer side is whether a key is *set* —
 * never the value. A renderer that can read it is a renderer that can leak it
 * into a transcript.
 */

function secretsPath(userData: string): string {
  return join(userData, 'agent-secrets.json')
}

/** An agent, or a service an agent calls and Chorus holds the credential for. */

/** Base64 ciphertext per holder. The names are not secret; the values are. */
type SecretsFile = Partial<Record<SecretId, string>>

function readAll(userData: string): SecretsFile {
  const path = secretsPath(userData)
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: SecretsFile = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = SecretIdSchema.safeParse(key)
      if (id.success && typeof value === 'string') out[id.data] = value
    }
    return out
  } catch {
    /*
     * Unreadable is treated as "no key", not as an error. The consequence is an
     * agent reporting that it needs one, which is true and visible; refusing to
     * start the app over a corrupt credential cache would be a far worse failure
     * than the one it reports.
     */
    return {}
  }
}

function write(userData: string, all: SecretsFile): void {
  const path = secretsPath(userData)
  mkdirSync(dirname(path), { recursive: true })
  const staging = `${path}.tmp`
  writeFileSync(staging, JSON.stringify(all), { encoding: 'utf8', mode: 0o600 })
  renameSync(staging, path)
}

/**
 * The stored key, or null when there is none — or when nothing can decrypt it.
 *
 * Read at spawn rather than cached at startup, which is what lets a key be
 * added, rotated or removed without restarting the app.
 */
function readOffered(stored: string | undefined): OfferedSecret {
  if (stored === undefined || !safeStorage.isEncryptionAvailable()) {
    return { value: null, revision: 0 }
  }
  let value: string
  try {
    value = safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    /*
     * Written by another machine, another account, or a keychain since reset.
     * Indistinguishable from absent to every caller, and both mean the same
     * thing: ask the person for it again.
     */
    return { value: null, revision: 0 }
  }
  try {
    const parsed = OfferedSecret.safeParse(JSON.parse(value) as unknown)
    if (parsed.success) return parsed.data
  } catch {
    return { value, revision: 0 }
  }
  return { value, revision: 0 }
}

export function readAgentKeys(userData: string): Record<SecretId, OfferedSecret> {
  const all = readAll(userData)
  return Object.fromEntries(
    SecretIdSchema.options.map((id) => [id, readOffered(all[id])])
  ) as Record<SecretId, OfferedSecret>
}

export function readAgentKey(userData: string, id: SecretId): string | null {
  return readOffered(readAll(userData)[id]).value
}

/** Whether a key is present — the only thing a renderer is ever told. */
export function agentKeyIsSet(userData: string, id: SecretId): boolean {
  return readAgentKey(userData, id) !== null
}

/**
 * Stores one key, encrypted, or refuses.
 *
 * Throwing rather than silently skipping when no keychain is available: a person
 * told their key was saved will not enter it again, and a plaintext fallback is
 * exactly the trade this file exists to refuse.
 */
function storeAgentKey(
  userData: string,
  id: SecretId,
  value: string | null,
  revision: number | undefined
): number {
  const all = readAll(userData)
  const current = readOffered(all[id])
  const offered = OfferedSecret.parse({
    value,
    revision: revision ?? Math.max(Date.now(), current.revision + 1),
  })
  if (offered.revision < current.revision) return current.revision
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('No OS keychain is available to encrypt this key')
  }
  all[id] = safeStorage.encryptString(JSON.stringify(offered)).toString('base64')
  write(userData, all)
  return offered.revision
}

export function writeAgentKey(
  userData: string,
  id: SecretId,
  value: string,
  revision?: number
): number {
  return storeAgentKey(userData, id, value, revision)
}

export function clearAgentKey(userData: string, id: SecretId, revision?: number): number {
  return storeAgentKey(userData, id, null, revision)
}
