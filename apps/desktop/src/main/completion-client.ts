import { readAgentKey } from './agent-secrets.js'
import {
  CompletionClient,
  recordEditorOutcome as recordCoreEditorOutcome,
  type CompletionLog,
} from './completion-core.js'
import type { CompletionPayload, CompletionReply } from '../shared/workbench-ipc.js'

export { PROVIDER_ORDER, isCompletionPayload } from './completion-core.js'
export type { CompletionProvider } from './completion-core.js'

const clients = new Map<string, CompletionClient>()
let log: CompletionLog = { warn: () => undefined, info: () => undefined }

function clientFor(userData: string): CompletionClient {
  let client = clients.get(userData)
  if (client === undefined) {
    client = new CompletionClient(userData, readAgentKey, log)
    clients.set(userData, client)
  }
  return client
}

export function setCompletionLog(next: CompletionLog): void {
  log = next
  for (const client of clients.values()) client.setLog(next)
}

export function invalidateCompletionCredential(): void {
  for (const client of clients.values()) client.invalidate()
}

export function completionConfigured(userData: string): boolean {
  return clientFor(userData).configured()
}

export function recordEditorOutcome(raw: unknown): void {
  recordCoreEditorOutcome(raw, log)
}

export function requestCompletion(
  userData: string,
  requestId: string,
  payload: CompletionPayload,
  callerSignal: AbortSignal,
  timeoutMs?: number
): Promise<CompletionReply> {
  return clientFor(userData).request(requestId, payload, callerSignal, timeoutMs)
}

export function probeCompletionCache(userData: string): Promise<void> {
  return clientFor(userData).probeCache()
}
