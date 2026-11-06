import type { BrowserCDPSession, BrowserTabShowOptions, Disposable } from 'vscode'
import type { BrowserHostPlatform, BrowserTabRef } from '../host.js'

export class Signal<T> {
  private readonly listeners = new Set<(value: T) => void>()

  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value)
  }
}

export interface Request {
  readonly id: number
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
  readonly sessionId?: string
}

export class FakeSession implements BrowserCDPSession {
  readonly messages = new Signal<unknown>()
  readonly closed = new Signal<void>()
  readonly onDidReceiveMessage = this.messages.event
  readonly onDidClose = this.closed.event
  readonly requests: Request[] = []
  targetId = 'page-target'
  pageUrl = 'https://project.test/'
  targetInfos: unknown[] | undefined
  handle: ((request: Request) => void) | undefined
  closes = 0

  sendMessage(raw: unknown): Promise<void> {
    const request = raw as Request
    this.requests.push(request)
    if (this.handle !== undefined) {
      this.handle(request)
      return Promise.resolve()
    }
    if (request.method === 'Target.getTargets') {
      this.reply(request, {
        targetInfos: this.targetInfos ?? [
          { targetId: this.targetId, type: 'page', url: this.pageUrl, title: 'Project' },
        ],
      })
    } else if (request.method === 'Target.attachToTarget') {
      this.reply(request, { sessionId: 'page-session' })
    } else if (request.method === 'Page.getFrameTree') {
      this.reply(request, { frameTree: { frame: { id: 'root', loaderId: 'initial-document' } } })
    } else if (request.method === 'Page.getNavigationHistory') {
      this.reply(request, { currentIndex: 0, entries: [{ id: 1, url: this.pageUrl }] })
    } else {
      this.reply(request, {})
    }
    return Promise.resolve()
  }

  reply(request: Request, result: unknown): void {
    this.messages.fire({
      id: request.id,
      result,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    })
  }

  event(method: string, params: unknown, sessionId = 'page-session'): void {
    this.messages.fire({ method, params, sessionId })
  }

  close(): Promise<void> {
    this.closes += 1
    this.closed.fire()
    return Promise.resolve()
  }
}

export class FakeTab implements BrowserTabRef {
  title = 'Project'
  closes = 0
  session = new FakeSession()
  starts = 0

  constructor(
    public url = 'https://project.test/',
    targetId = 'page-target'
  ) {
    this.session.targetId = targetId
    this.session.pageUrl = url
  }

  startCDPSession(): Promise<BrowserCDPSession> {
    this.starts += 1
    return Promise.resolve(this.session)
  }

  close(): Promise<void> {
    this.closes += 1
    return Promise.resolve()
  }
}

export class FakeWindow implements BrowserHostPlatform {
  browserTabs: FakeTab[] = []
  readonly opened = new Signal<BrowserTabRef>()
  readonly closed = new Signal<BrowserTabRef>()
  readonly changed = new Signal<BrowserTabRef>()
  readonly onDidOpenBrowserTab = this.opened.event
  readonly onDidCloseBrowserTab = this.closed.event
  readonly onDidChangeBrowserTabState = this.changed.event
  readonly options: BrowserTabShowOptions[] = []
  beforeOpen: (() => void) | undefined

  openBrowserTab(url: string, options: BrowserTabShowOptions): Promise<BrowserTabRef> {
    this.options.push(options)
    this.beforeOpen?.()
    const tab = new FakeTab(url, `page-${String(this.browserTabs.length + 1)}`)
    this.browserTabs.push(tab)
    this.opened.fire(tab)
    return Promise.resolve(tab)
  }

  external(tab: FakeTab): void {
    this.browserTabs.push(tab)
    this.opened.fire(tab)
  }
}
