import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import { z } from 'zod'
import { workbenchUserDataPath } from './workbench-user-settings.js'

export const GITLAB_WORKFLOW_SECRET =
  '{"extensionId":"gitlab.gitlab-workflow","key":"gitlab-tokens"}'

const WorkflowSecrets = z.record(
  z.string(),
  z.object({ token: z.string().min(1), refreshToken: z.string().optional() })
)

export type WorkflowImport =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'none' | 'oauth-only' | 'several' }

export function importableGitLabToken(raw: string | null, instanceUrl: string): WorkflowImport {
  if (raw === null) return { kind: 'none' }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return { kind: 'none' }
  }
  const parsed = WorkflowSecrets.safeParse(decoded)
  if (!parsed.success) return { kind: 'none' }
  const forHost = Object.entries(parsed.data).filter(([accountId]) =>
    accountId.startsWith(`${instanceUrl}|`)
  )
  const tokens = forHost.filter(([, secret]) => secret.refreshToken === undefined)
  if (tokens.length > 1) return { kind: 'several' }
  const only = tokens[0]
  if (only !== undefined) return { kind: 'token', token: only[1].token }
  return { kind: forHost.length > 0 ? 'oauth-only' : 'none' }
}

/**
 * Where an extension's credentials live between launches.
 *
 * **Separate from `workbench-storage.ts`, and the separation is the point.**
 * They are written by the same kind of caller through the same kind of channel,
 * and folding them together would be one small refactor away from a GitLab
 * token sitting in the file people open to see why an extension keeps greeting
 * them. What is in here is different in kind: a `api`-scoped personal access
 * token is a live credential, and the file is treated accordingly.
 *
 * **Why anything is stored at all.** `BrowserSecretStorageService` is
 * constructed `super(true, …)` — `_useInMemoryStorage` hardcoded — so
 * `BaseSecretStorageService` always takes the `new InMemoryStorageService()`
 * branch and secrets never reach `IStorageService`. Nothing about the durable
 * storage added alongside this could have helped: a token was gone on every
 * quit, and signing in to GitLab was a thing you did once per launch. The
 * supported way out is `options.secretStorageProvider`, which the same
 * constructor checks for and which `get`/`set`/`delete` prefer when present.
 */

/**
 * Encrypted with the OS keychain, never written as text.
 *
 * VS Code desktop keeps secrets in the platform credential store, and the reason
 * to match that is not symmetry: the alternative is a readable `api`-scoped
 * token in a predictable path, which is worth strictly more to anything that can
 * read a file than everything else in this profile combined. `safeStorage` binds
 * the ciphertext to the macOS login keychain, so a copied file is inert on
 * another machine and on another account.
 *
 * **A profile whose keychain is unavailable stores nothing rather than storing
 * plaintext.** `isEncryptionAvailable` is false on a Linux box with no
 * keyring and during early startup before the app is ready; degrading to a
 * readable token is exactly the trade this file exists to refuse. The cost of
 * refusing is that an extension asks to sign in again, which is the behaviour
 * everybody already had.
 */
export function workbenchSecretsPath(userData: string): string {
  return join(workbenchUserDataPath(userData), 'secrets.json')
}

/** Base64 ciphertext per key. The keys themselves are not secret; the values are. */
type SecretsFile = Record<string, string>

function readAll(userData: string): SecretsFile {
  const path = workbenchSecretsPath(userData)
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: SecretsFile = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    /*
     * An unreadable file is treated as no secrets, not as an error. The only
     * consequence is being asked to sign in again — and refusing to start a
     * workbench because a credential cache was corrupt would be a far worse
     * failure than the one it is reporting.
     */
    return {}
  }
}

function write(userData: string, all: SecretsFile): void {
  const path = workbenchSecretsPath(userData)
  mkdirSync(dirname(path), { recursive: true })
  const staging = `${path}.tmp`
  writeFileSync(staging, JSON.stringify(all), { encoding: 'utf8', mode: 0o600 })
  renameSync(staging, path)
}

/** The stored secret, or null when there is none — or when nothing can decrypt it. */
export function readWorkbenchSecret(userData: string, key: string): string | null {
  const stored = readAll(userData)[key]
  if (stored === undefined) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    /*
     * Written by another machine, another account, or a keychain that has since
     * been reset. Unreadable is indistinguishable from absent to every caller,
     * and both mean the same thing: ask the person to sign in again.
     */
    return null
  }
}

/**
 * Stores one secret, encrypted, or refuses.
 *
 * Throwing rather than silently skipping when encryption is unavailable: the
 * caller is a `secretStorageProvider`, and an extension told its `set` succeeded
 * will not ask again. A rejected promise surfaces as a sign-in that did not
 * stick, which is true and visible; a silent no-op is a token the person
 * believes is saved.
 */
export function writeWorkbenchSecret(userData: string, key: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('No OS keychain is available to encrypt this secret')
  }
  const all = readAll(userData)
  all[key] = safeStorage.encryptString(value).toString('base64')
  write(userData, all)
}

export function deleteWorkbenchSecret(userData: string, key: string): void {
  const all = readAll(userData)
  if (!(key in all)) return
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete all[key]
  write(userData, all)
}
