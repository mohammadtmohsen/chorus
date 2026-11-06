import type { BrowserSource, CdpTransport } from '../../desktop/src/main/browser-source.js'
import type { EnginePeer } from './peers.js'
import type { BrowserHostEvent, BrowserHostState } from './browser-protocol.js'

class RemoteCdp implements CdpTransport {
  private attached = false
  private readonly messages = new Set<(method: string, params: unknown) => void>()
  private readonly detached = new Set<() => void>()

  constructor(private readonly source: RemoteBrowserSource) {}

  attach(): void {
    if (this.source.isGone()) throw new Error('browser-disconnected')
    this.attached = true
  }
  isAttached(): boolean {
    return this.attached && !this.source.isGone()
  }
  detach = (): void => {
    this.attached = false
  }
  sendCommand = (method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
    if (!this.isAttached()) return Promise.reject(new Error('browser-disconnected'))
    return this.source.owner.requestHost('browser.cdp', {
      tabId: this.source.state.tabId,
      method,
      params,
    })
  }
  onMessage(listener: (method: string, params: unknown) => void): () => void {
    this.messages.add(listener)
    return () => {
      this.messages.delete(listener)
    }
  }
  onDetached(listener: () => void): () => void {
    this.detached.add(listener)
    return () => {
      this.detached.delete(listener)
    }
  }
  receive(method: string, params: unknown): void {
    if (method === 'Inspector.detached') {
      this.disconnect()
      return
    }
    for (const listener of this.messages) listener(method, params)
  }
  disconnect(): void {
    this.attached = false
    for (const listener of this.detached) listener()
  }
}

export class RemoteBrowserSource implements BrowserSource {
  readonly transport: RemoteCdp
  private gone = false
  private readonly navigated = new Set<(url: string) => void>()
  private readonly crashed = new Set<(reason: string) => void>()
  private readonly removed = new Set<() => void>()

  constructor(
    readonly id: string,
    readonly owner: EnginePeer,
    public state: BrowserHostState
  ) {
    this.transport = new RemoteCdp(this)
  }
  get projectId(): string | null {
    return this.state.projectId
  }
  url(): string {
    return this.state.url
  }
  isGone(): boolean {
    return this.gone || this.owner.isGone()
  }
  isInspectorOpen(): boolean {
    return false
  }
  onNavigated(listener: (url: string) => void): () => void {
    this.navigated.add(listener)
    return () => {
      this.navigated.delete(listener)
    }
  }
  onCrashed(listener: (reason: string) => void): () => void {
    this.crashed.add(listener)
    return () => {
      this.crashed.delete(listener)
    }
  }
  onGone(listener: () => void): () => void {
    this.removed.add(listener)
    return () => {
      this.removed.delete(listener)
    }
  }
  onInspectorChanged(): () => void {
    return () => undefined
  }

  receive(event: BrowserHostEvent): void {
    if (event.kind === 'state') {
      this.state = event.state
      if (event.state.closed === true) this.close()
      return
    }
    if (this.isGone() || event.generation < this.state.generation) return
    if (event.kind === 'cdp') this.transport.receive(event.method, event.params)
    else if (event.kind === 'navigated') {
      this.state = { ...this.state, generation: event.generation, url: event.url }
      for (const listener of this.navigated) listener(event.url)
    } else if (event.kind === 'crashed') {
      for (const listener of this.crashed) listener(event.reason)
    } else this.close()
  }
  close(): void {
    if (this.gone) return
    this.gone = true
    this.transport.disconnect()
    for (const listener of this.removed) listener()
  }
}
