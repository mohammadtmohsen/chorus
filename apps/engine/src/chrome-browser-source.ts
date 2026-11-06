import { z } from 'zod'
import type { BrowserSource, CdpTransport } from '../../desktop/src/main/browser-source.js'
import type { ShellClient } from '../../desktop/src/main/shell-client.js'
import type { ChromeProcess } from './chrome-process.js'

const ContextCreated = z.object({ context: z.object({ id: z.number() }) })
const ContextDestroyed = z.object({ executionContextId: z.number() })

export class ChromePage {
  private closed = false
  private readonly contexts = new Map<number, unknown>()
  private readonly stopContexts: () => void
  url = 'about:blank'

  constructor(
    private readonly chrome: ChromeProcess,
    readonly targetId: string,
    readonly sessionId: string,
    readonly generation: number,
    readonly openerId: string | null
  ) {
    this.stopContexts = this.onEvent((method, params) => {
      if (method === 'Runtime.executionContextCreated') {
        const parsed = ContextCreated.safeParse(params)
        if (parsed.success) this.contexts.set(parsed.data.context.id, params)
      } else if (method === 'Runtime.executionContextDestroyed') {
        const parsed = ContextDestroyed.safeParse(params)
        if (parsed.success) this.contexts.delete(parsed.data.executionContextId)
      } else if (method === 'Runtime.executionContextsCleared') this.contexts.clear()
    })
  }

  send(
    method: string,
    params: Readonly<Record<string, unknown>>,
    timeoutMs?: number
  ): Promise<unknown> {
    return this.closed
      ? Promise.reject(new Error('browser-disconnected'))
      : this.chrome.send(method, params, this.sessionId, timeoutMs)
  }

  onEvent(listener: (method: string, params: unknown) => void): () => void {
    return this.chrome.onEvent((method, params, sessionId) => {
      if (!this.closed && sessionId === this.sessionId) listener(method, params)
    })
  }

  isClosed(): boolean {
    return this.closed
  }

  runtimeContexts(): ReadonlyMap<number, unknown> {
    return this.contexts
  }

  markClosed(): void {
    if (this.closed) return
    this.closed = true
    this.stopContexts()
    this.contexts.clear()
  }
}

class PageTransport implements CdpTransport {
  private attached = false
  private attachment = 0
  private stop: (() => void) | null = null
  private readonly contexts = new Set<number>()
  private readonly messages = new Set<(method: string, params: unknown) => void>()
  private readonly detached = new Set<() => void>()

  constructor(private readonly page: ChromePage) {}

  attach(): void {
    if (this.page.isClosed()) throw new Error('browser-disconnected')
    if (this.attached) return
    this.attached = true
    this.attachment += 1
    this.contexts.clear()
    this.stop = this.page.onEvent((method, params) => {
      if (this.isAttached()) this.receive(method, params)
    })
  }

  isAttached(): boolean {
    return this.attached && !this.page.isClosed()
  }

  detach = (): void => {
    this.attached = false
    this.attachment += 1
    this.stop?.()
    this.stop = null
    this.contexts.clear()
  }

  sendCommand = async (
    method: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown> => {
    if (!this.isAttached()) throw new Error('browser-disconnected')
    const attachment = this.attachment
    const result = await this.page.send(method, params)
    if (!this.isAttached() || this.attachment !== attachment) throw new Error('browser-disconnected')
    if (method === 'Runtime.enable')
      for (const [id, context] of this.page.runtimeContexts())
        if (!this.contexts.has(id)) this.receive('Runtime.executionContextCreated', context)
    return result
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

  disconnect(): void {
    this.detach()
    for (const listener of this.detached) listener()
  }

  private receive(method: string, params: unknown): void {
    if (method === 'Runtime.executionContextCreated') {
      const parsed = ContextCreated.safeParse(params)
      if (parsed.success) this.contexts.add(parsed.data.context.id)
    } else if (method === 'Runtime.executionContextDestroyed') {
      const parsed = ContextDestroyed.safeParse(params)
      if (parsed.success) this.contexts.delete(parsed.data.executionContextId)
    } else if (method === 'Runtime.executionContextsCleared') this.contexts.clear()
    for (const listener of this.messages) listener(method, params)
  }
}

export class ChromeBrowserSource implements BrowserSource {
  readonly transport: PageTransport
  private gone = false
  private readonly navigated = new Set<(url: string) => void>()
  private readonly removed = new Set<() => void>()

  constructor(
    readonly id: string,
    readonly projectId: string,
    readonly owner: ShellClient,
    readonly page: ChromePage
  ) {
    this.transport = new PageTransport(page)
  }

  url(): string {
    return this.page.url
  }

  isGone(): boolean {
    return this.gone || this.page.isClosed()
  }

  isInspectorOpen(): boolean {
    return false
  }

  navigatedTo(url: string): void {
    for (const listener of this.navigated) listener(url)
  }

  close(): void {
    if (this.gone) return
    this.gone = true
    this.transport.disconnect()
    for (const listener of this.removed) listener()
  }

  onNavigated(listener: (url: string) => void): () => void {
    this.navigated.add(listener)
    return () => {
      this.navigated.delete(listener)
    }
  }

  onCrashed(): () => void {
    return () => undefined
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
}
