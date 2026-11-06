import type { ShellClient } from './shell-client.js'

export interface CdpTransport {
  attach(version: string): void | Promise<void>
  isAttached(): boolean
  detach: () => void
  sendCommand: (method: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>
  onMessage(listener: (method: string, params: unknown) => void): () => void
  onDetached(listener: () => void): () => void
}

export interface BrowserSource {
  readonly id: string
  readonly projectId: string | null
  readonly owner: ShellClient
  readonly transport: CdpTransport
  url(): string
  isGone(): boolean
  isInspectorOpen(): boolean
  onNavigated(listener: (url: string) => void): () => void
  onCrashed(listener: (reason: string) => void): () => void
  onGone(listener: () => void): () => void
  onInspectorChanged(listener: (open: boolean) => void): () => void
}
