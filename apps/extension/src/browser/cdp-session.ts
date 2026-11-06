import type { BrowserCDPSession, Disposable } from 'vscode'
import { z } from 'zod'
import type { CdpTransport } from '../../../desktop/src/main/browser-source.js'
import messages from '../../../desktop/src/renderer/src/i18n/en.json'

const Message = z.object({
  id: z.number().int().positive().optional(),
  method: z.string().optional(),
  sessionId: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string(), code: z.number().optional() }).optional(),
})
const Targets = z.object({
  targetInfos: z.array(
    z.object({
      targetId: z.string().min(1),
      type: z.string(),
      url: z.string(),
      subtype: z.string().optional(),
    })
  ),
})
const Attachment = z.object({ sessionId: z.string().min(1) })
const NAVIGATION_COMMANDS = new Set([
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Page.reload',
  'Page.stopLoading',
  'Page.getNavigationHistory',
  'Page.getFrameTree',
])

export type BrowserCdpFailure =
  | 'closed'
  | 'detached'
  | 'navigated'
  | 'crashed'
  | 'timeout'
  | 'aborted'
  | 'no-target'
  | 'ambiguous-target'
  | 'protocol'
  | 'unsupported'

export class BrowserCdpError extends Error {
  constructor(
    readonly code: BrowserCdpFailure,
    message?: string
  ) {
    super(
      message ??
        (code === 'navigated'
          ? messages.browser.failure['stale-document']
          : code === 'closed' || code === 'detached'
            ? messages.browser.failure['unknown-browser']
            : messages.browser.failure.failed)
    )
  }
}

interface Pending {
  readonly method: string
  readonly sessionId: string | undefined
  readonly settle: (error: Error | null, result?: unknown) => void
}

export interface BrowserTabCdpOptions {
  readonly url?: () => string
  readonly timeoutMs?: number
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function pageUrl(url: string): boolean {
  if (url === '' || url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export class BrowserTabCdp implements CdpTransport, Disposable {
  private readonly waiting = new Map<number, Pending>()
  private readonly messages = new Set<(method: string, params: unknown) => void>()
  private readonly detached = new Set<() => void>()
  private readonly navigated = new Set<
    (url: string, documentId: string | null, sameDocument: boolean) => void
  >()
  private readonly crashed = new Set<(reason: string) => void>()
  private readonly gone = new Set<() => void>()
  private readonly cleanup: Disposable[]
  private nextId = 1
  private targetSession: string | null = null
  private pageTarget: string | null = null
  private rootFrameId: string | null = null
  private attachment: Promise<void> | null = null
  private ended: BrowserCdpFailure | null = null

  constructor(
    private readonly session: BrowserCDPSession,
    private readonly options: BrowserTabCdpOptions = {}
  ) {
    this.cleanup = [
      session.onDidReceiveMessage((message) => {
        this.receive(message)
      }),
      session.onDidClose(() => {
        this.finish('detached', false)
      }),
    ]
  }

  get targetId(): string | null {
    return this.pageTarget
  }

  attach(_version?: string): Promise<void> {
    if (this.ended !== null) return Promise.reject(new BrowserCdpError(this.ended))
    if (this.targetSession !== null) return Promise.resolve()
    this.attachment ??= this.connect().catch((error: unknown) => {
      this.attachment = null
      throw error
    })
    return this.attachment
  }

  private async connect(): Promise<void> {
    const parsed = Targets.safeParse(await this.send('Target.getTargets', {}))
    if (!parsed.success) throw new BrowserCdpError('protocol')
    const pages = parsed.data.targetInfos.filter(
      (target) =>
        target.type === 'page' &&
        (target.subtype === undefined || target.subtype === '') &&
        pageUrl(target.url)
    )
    const current = this.options.url?.()
    const matching = current === undefined ? [] : pages.filter((target) => target.url === current)
    const target = pages.length === 1 ? pages[0] : matching.length === 1 ? matching[0] : undefined
    if (target === undefined) {
      throw new BrowserCdpError(pages.length === 0 ? 'no-target' : 'ambiguous-target')
    }
    this.pageTarget = target.targetId
    const attached = Attachment.safeParse(
      await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    )
    if (!attached.success) throw new BrowserCdpError('protocol')
    if (this.ended !== null) throw new BrowserCdpError(this.ended)
    this.targetSession = attached.data.sessionId
  }

  isAttached(): boolean {
    return this.ended === null && this.targetSession !== null
  }

  async sendCommand(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    signal?: AbortSignal
  ): Promise<unknown> {
    if (method.startsWith('Target.') || method.startsWith('Browser.')) {
      throw new BrowserCdpError('unsupported')
    }
    if (this.ended !== null) throw new BrowserCdpError(this.ended)
    const sessionId = this.targetSession
    if (sessionId === null) throw new BrowserCdpError('detached')
    const result = await this.send(method, params, sessionId, signal)
    if (method === 'Page.getFrameTree') {
      const tree = record(record(result)?.['frameTree'])
      const frame = record(tree?.['frame'])
      if (typeof frame?.['id'] === 'string') this.rootFrameId = frame['id']
    }
    return result
  }

  onMessage(listener: (method: string, params: unknown) => void): () => void {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }

  onDetached(listener: () => void): () => void {
    this.detached.add(listener)
    return () => this.detached.delete(listener)
  }

  onNavigated(
    listener: (url: string, documentId: string | null, sameDocument: boolean) => void
  ): () => void {
    this.navigated.add(listener)
    return () => this.navigated.delete(listener)
  }

  onCrashed(listener: (reason: string) => void): () => void {
    this.crashed.add(listener)
    return () => this.crashed.delete(listener)
  }

  onGone(listener: () => void): () => void {
    this.gone.add(listener)
    return () => this.gone.delete(listener)
  }

  detach(): void {
    this.finish('detached', true)
  }

  dispose(): void {
    this.finish('closed', true)
    this.messages.clear()
    this.detached.clear()
    this.navigated.clear()
    this.crashed.clear()
    this.gone.clear()
  }

  private send(
    method: string,
    params: Readonly<Record<string, unknown>>,
    sessionId?: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.ended !== null) return Promise.reject(new BrowserCdpError(this.ended))
    if (signal?.aborted === true) return Promise.reject(new BrowserCdpError('aborted'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const settle = (error: Error | null, result?: unknown): void => {
        if (!this.waiting.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error === null) resolve(result)
        else reject(error)
      }
      const abort = (): void => {
        settle(new BrowserCdpError('aborted'))
      }
      const timer = setTimeout(() => {
        settle(new BrowserCdpError('timeout'))
      }, this.options.timeoutMs ?? 10_000)
      this.waiting.set(id, { method, sessionId, settle })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        void Promise.resolve(
          this.session.sendMessage({
            id,
            method,
            params,
            ...(sessionId === undefined ? {} : { sessionId }),
          })
        ).catch((error: unknown) => {
          settle(error instanceof Error ? error : new BrowserCdpError('protocol'))
        })
      } catch (error) {
        settle(error instanceof Error ? error : new BrowserCdpError('protocol'))
      }
    })
  }

  private receive(raw: unknown): void {
    if (this.ended !== null) return
    const parsed = Message.safeParse(raw)
    if (!parsed.success) return
    const message = parsed.data
    if (message.id !== undefined) {
      const pending = this.waiting.get(message.id)
      if (pending === undefined || pending.sessionId !== message.sessionId) return
      pending.settle(
        message.error === undefined ? null : new BrowserCdpError('protocol', message.error.message),
        message.result
      )
      return
    }
    const method = message.method
    if (method === undefined) return
    const params = record(message.params)
    if (method === 'Target.detachedFromTarget') {
      if (
        this.targetSession !== null &&
        (params?.['sessionId'] === this.targetSession ||
          (params?.['sessionId'] === undefined && params?.['targetId'] === this.pageTarget))
      ) {
        this.finish('detached', true)
      }
      return
    }
    if (
      method === 'Target.targetDestroyed' &&
      this.pageTarget !== null &&
      params?.['targetId'] === this.pageTarget
    ) {
      for (const listener of [...this.gone]) listener()
      this.finish('closed', true)
      return
    }
    if (method === 'Target.targetCrashed') {
      if (this.pageTarget !== null && params?.['targetId'] === this.pageTarget) this.crash(params)
      return
    }
    if (this.targetSession === null || message.sessionId !== this.targetSession) return
    if (method === 'Inspector.targetCrashed') {
      this.crash(params)
      return
    }
    if (method === 'Inspector.detached') {
      this.finish('detached', true)
      return
    }
    if (method === 'Runtime.executionContextsCleared') this.invalidate()
    if (method === 'Page.frameNavigated') {
      const frame = record(params?.['frame'])
      if (frame !== null && frame['parentId'] === undefined && typeof frame['url'] === 'string') {
        this.invalidate()
        if (typeof frame['id'] === 'string') this.rootFrameId = frame['id']
        const documentId = typeof frame['loaderId'] === 'string' ? frame['loaderId'] : null
        for (const listener of [...this.navigated]) listener(frame['url'], documentId, false)
      }
    } else if (method === 'Page.navigatedWithinDocument') {
      if (
        typeof params?.['url'] === 'string' &&
        this.rootFrameId !== null &&
        params['frameId'] === this.rootFrameId
      ) {
        this.invalidate()
        for (const listener of [...this.navigated]) listener(params['url'], null, true)
      }
    }
    for (const listener of [...this.messages]) listener(method, message.params ?? {})
  }

  invalidateDocument(): void {
    this.invalidate()
  }

  private invalidate(): void {
    for (const pending of [...this.waiting.values()]) {
      if (
        pending.sessionId !== undefined &&
        !NAVIGATION_COMMANDS.has(pending.method) &&
        !pending.method.endsWith('.enable') &&
        !pending.method.endsWith('.disable')
      ) {
        pending.settle(new BrowserCdpError('navigated'))
      }
    }
  }

  private crash(params: Readonly<Record<string, unknown>> | null): void {
    const reason =
      typeof params?.['status'] === 'string' ? params['status'] : messages.browser.failure.failed
    for (const listener of [...this.crashed]) listener(reason)
    this.finish('crashed', true)
  }

  private finish(reason: BrowserCdpFailure, close: boolean): void {
    if (this.ended !== null) return
    this.ended = reason
    this.targetSession = null
    for (const pending of [...this.waiting.values()]) pending.settle(new BrowserCdpError(reason))
    for (const disposable of this.cleanup) disposable.dispose()
    for (const listener of [...this.detached]) listener()
    if (close) {
      try {
        void Promise.resolve(this.session.close()).catch(() => undefined)
      } catch {
        return
      }
    }
  }
}
