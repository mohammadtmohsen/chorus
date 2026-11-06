import { randomUUID } from 'node:crypto'
import type {
  BrowserCDPSession,
  BrowserTab,
  BrowserTabShowOptions,
  Disposable,
  Memento,
  ViewColumn,
} from 'vscode'
import { z } from 'zod'
import { isBrowserNavigable } from '../../../desktop/src/shared/browser-ipc.js'
import messages from '../../../desktop/src/renderer/src/i18n/en.json'
import { BrowserCdpError, BrowserTabCdp } from './cdp-session.js'

export const BROWSER_HOST_STORAGE_KEY = 'chorus.browserTabs'

const SavedTab = z.object({
  tabId: z.string().min(1),
  projectId: z.string().nullable(),
  targetId: z.string().nullable(),
  url: z.string(),
  title: z.string(),
  generation: z.number().int().nonnegative(),
})
const SavedTabs = z.object({ version: z.literal(1), tabs: z.array(SavedTab) })
const History = z.object({
  currentIndex: z.number().int(),
  entries: z.array(z.object({ id: z.number().int() })),
})
const FrameTree = z.object({
  frameTree: z.object({
    frame: z.object({ id: z.string(), loaderId: z.string().optional() }),
  }),
})
const FrameNavigation = z.object({
  frame: z.object({ id: z.string(), parentId: z.string().optional() }),
})
const Frame = z.object({ frameId: z.string() })

export type BrowserTabRef = Pick<BrowserTab, 'url' | 'title' | 'startCDPSession' | 'close'>

export interface BrowserHostPlatform {
  readonly browserTabs: readonly BrowserTabRef[]
  openBrowserTab(url: string, options: BrowserTabShowOptions): PromiseLike<BrowserTabRef>
  onDidOpenBrowserTab(listener: (tab: BrowserTabRef) => void): Disposable
  onDidCloseBrowserTab(listener: (tab: BrowserTabRef) => void): Disposable
  onDidChangeBrowserTabState(listener: (tab: BrowserTabRef) => void): Disposable
}

export interface BrowserHostState {
  readonly tabId: string
  readonly projectId: string | null
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly generation: number
  readonly closed?: boolean
  readonly error?: string
}

interface BrowserHostIdentity {
  readonly tabId: string
  readonly projectId: string | null
  readonly generation: number
}

export type BrowserHostEvent =
  | { readonly kind: 'state'; readonly state: BrowserHostState }
  | (BrowserHostIdentity & {
      readonly kind: 'cdp'
      readonly method: string
      readonly params: unknown
    })
  | (BrowserHostIdentity & { readonly kind: 'navigated'; readonly url: string })
  | (BrowserHostIdentity & { readonly kind: 'crashed'; readonly reason: string })
  | (BrowserHostIdentity & { readonly kind: 'gone' })

export interface BrowserHostOptions {
  readonly workspaceState: Memento
  readonly focusedProject: () => string | null
  readonly emit: (event: BrowserHostEvent) => void
  readonly log: (message: string) => void
}

interface TabRecord {
  readonly tab: BrowserTabRef
  readonly lifetime: AbortController
  state: BrowserHostState
  targetId: string | null
  transport: BrowserTabCdp | null
  connection: Promise<BrowserTabCdp> | null
  announced: boolean
  initialized: boolean
  ownershipLost: boolean
  rootFrameId: string | null
  documentId: string | null
  apiNavigation: string | null
  historyRevision: number
}

function startSession(tab: BrowserTabRef, signal: AbortSignal): Promise<BrowserCDPSession> {
  if (signal.aborted) return Promise.reject(new BrowserCdpError('closed'))
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = (): void => {
      fail(new BrowserCdpError('closed'))
    }
    const timer = setTimeout(() => {
      fail(new BrowserCdpError('timeout'))
    }, 10_000)
    signal.addEventListener('abort', abort, { once: true })
    try {
      void Promise.resolve(tab.startCDPSession()).then(
        (session) => {
          if (settled) {
            void Promise.resolve(session.close()).catch(() => undefined)
            return
          }
          settled = true
          cleanup()
          resolve(session)
        },
        (error: unknown) => {
          fail(error instanceof Error ? error : new BrowserCdpError('protocol'))
        }
      )
    } catch (error) {
      fail(error instanceof Error ? error : new BrowserCdpError('protocol'))
    }
  })
}

export class BrowserHostCore implements Disposable {
  readonly available: boolean
  private readonly byTab = new Map<BrowserTabRef, TabRecord>()
  private readonly byId = new Map<string, TabRecord>()
  private readonly closedTabs = new WeakSet<BrowserTabRef>()
  private readonly openedDuringRequest = new Map<BrowserTabRef, string | null>()
  private readonly creating = new Map<
    string,
    { readonly projectId: string | null; readonly pending: Promise<BrowserHostState> }
  >()
  private readonly cleanup: Disposable[] = []
  private restoration: Promise<void> | null = null
  private persistence = Promise.resolve()
  private persisted = ''
  private opening = 0
  private restoring = false
  private disposed = false

  constructor(
    private readonly options: BrowserHostOptions,
    private readonly platform: Partial<BrowserHostPlatform>,
    private readonly beside: ViewColumn
  ) {
    try {
      const opened = platform.onDidOpenBrowserTab
      const closed = platform.onDidCloseBrowserTab
      const changed = platform.onDidChangeBrowserTabState
      this.available =
        typeof platform.openBrowserTab === 'function' &&
        Array.isArray(platform.browserTabs) &&
        typeof opened === 'function' &&
        typeof closed === 'function' &&
        typeof changed === 'function'
      if (
        !this.available ||
        opened === undefined ||
        closed === undefined ||
        changed === undefined
      ) {
        return
      }
      this.cleanup.push(
        opened.call(platform, (tab) => {
          this.opened(tab)
        })
      )
      this.cleanup.push(
        closed.call(platform, (tab) => {
          this.closedTabs.add(tab)
          this.openedDuringRequest.delete(tab)
          const record = this.byTab.get(tab)
          if (record !== undefined) this.release(record)
        })
      )
      this.cleanup.push(
        changed.call(platform, (tab) => {
          const record = this.byTab.get(tab)
          if (record !== undefined) this.syncState(record)
        })
      )
    } catch {
      this.available = false
      for (const disposable of this.cleanup) disposable.dispose()
    }
  }

  restore(): Promise<void> {
    if (this.restoration === null) {
      this.restoration = this.restoreTabs()
      return this.restoration
    }
    return this.restoration.then(() => {
      for (const record of this.byTab.values()) this.publish(record)
    })
  }

  private async restoreTabs(): Promise<void> {
    const raw: unknown = this.options.workspaceState.get(BROWSER_HOST_STORAGE_KEY)
    const saved = SavedTabs.safeParse(raw)
    const previous = saved.success ? saved.data.tabs : []
    const ownershipExpected = previous.length > 0 || (raw !== undefined && !saved.success)
    if (raw !== undefined && !saved.success) {
      this.options.log(messages.browser.failure['settings-corrupt'])
    }
    if (!this.available) {
      for (const state of previous) this.missing(state, messages.extension.missingBrowser)
      return
    }
    this.restoring = true
    const focus = this.options.focusedProject()
    const tabs = [...(this.platform.browserTabs ?? [])]
    const records = tabs.map((tab) => this.create(tab, ownershipExpected ? null : focus))
    await Promise.all(
      records.map(async (record) => {
        try {
          await this.connect(record)
        } catch {
          record.state = { ...record.state, error: messages.browser.attachFailed }
        }
      })
    )
    if (this.disposed) return
    const recovered = new Set<string>()
    for (const record of records) {
      if (record.state.closed === true) continue
      const candidates = previous.filter(
        (saved) =>
          saved.targetId !== null &&
          saved.targetId === record.targetId &&
          !recovered.has(saved.tabId)
      )
      const saved = candidates.length === 1 ? candidates[0] : undefined
      if (saved !== undefined && !this.byId.has(saved.tabId)) {
        this.byId.delete(record.state.tabId)
        record.state = {
          ...record.state,
          tabId: saved.tabId,
          projectId: saved.projectId,
          generation: saved.generation + 1,
        }
        this.byId.set(saved.tabId, record)
        recovered.add(saved.tabId)
      } else if (ownershipExpected) {
        record.ownershipLost = true
        record.state = { ...record.state, projectId: null, error: messages.browser.attachFailed }
      }
      record.announced = true
      this.publish(record)
      if (record.transport?.isAttached() === true) {
        try {
          await this.initialize(record)
        } catch {
          if (!record.lifetime.signal.aborted) {
            this.fail(record, messages.browser.attachFailed)
          }
        }
      }
    }
    for (const saved of previous) {
      if (!recovered.has(saved.tabId)) this.missing(saved, messages.browser.attachFailed)
    }
    this.restoring = false
    await this.persist()
  }

  async open(projectId: string | null, url: string, browserId?: string): Promise<BrowserHostState> {
    const owner = projectId ?? this.options.focusedProject()
    await (this.restoration ?? this.restore())
    this.requireAvailable()
    this.requireUrl(url)
    if (browserId !== undefined) {
      const creating = this.creating.get(browserId)
      if (creating !== undefined) {
        if (creating.projectId !== owner) {
          throw new BrowserCdpError('unsupported', messages.extension.channelRefused)
        }
        const state = await creating.pending
        return state.url === url ? state : await this.navigate(state.tabId, url)
      }
      const previous = this.byId.get(browserId)
      if (previous !== undefined) {
        if (previous.state.projectId !== owner) {
          throw new BrowserCdpError('unsupported', messages.extension.channelRefused)
        }
        return await this.navigate(browserId, url)
      }
    }
    const pending = this.openTab(owner, url, browserId)
    if (browserId !== undefined) this.creating.set(browserId, { projectId: owner, pending })
    try {
      return await pending
    } finally {
      if (browserId !== undefined && this.creating.get(browserId)?.pending === pending) {
        this.creating.delete(browserId)
      }
    }
  }

  private async openTab(
    owner: string | null,
    url: string,
    browserId: string | undefined
  ): Promise<BrowserHostState> {
    const open = this.platform.openBrowserTab
    if (open === undefined) throw new Error(messages.extension.missingBrowser)
    this.opening += 1
    try {
      const created = await open.call(this.platform, url, {
        viewColumn: this.beside,
        preserveFocus: true,
      })
      this.openedDuringRequest.delete(created)
      this.requireAvailable()
      if (this.closedTabs.has(created)) throw new BrowserCdpError('closed')
      const record = this.create(created, owner, browserId)
      record.announced = true
      this.publish(record)
      try {
        await this.connect(record)
        await this.initialize(record)
      } catch {
        if (record.state.closed !== true && !this.disposed) {
          this.fail(record, messages.browser.attachFailed)
        }
      }
      await this.persist()
      return this.snapshot(record)
    } finally {
      this.opening -= 1
      if (this.opening === 0) this.flushOpened()
    }
  }

  async navigate(tabId: string, url: string): Promise<BrowserHostState> {
    this.requireUrl(url)
    const record = this.requireTab(tabId)
    record.state = { ...record.state, loading: true }
    this.clearError(record)
    this.publish(record)
    try {
      const result = await this.cdp(tabId, 'Page.navigate', { url })
      const failure = z.object({ errorText: z.string().optional() }).safeParse(result)
      if (failure.success && failure.data.errorText !== undefined) {
        throw new BrowserCdpError('protocol', failure.data.errorText)
      }
      await this.refreshHistory(record)
    } catch (error) {
      if (record.state.closed !== true) this.fail(record, messages.browser.failure.failed)
      throw error
    }
    return this.snapshot(record)
  }

  async action(
    tabId: string,
    action: 'back' | 'forward' | 'reload' | 'stop'
  ): Promise<BrowserHostState> {
    const record = this.requireTab(tabId)
    try {
      if (action === 'back' || action === 'forward') {
        const history = History.safeParse(await this.cdp(tabId, 'Page.getNavigationHistory', {}))
        if (!history.success) throw new BrowserCdpError('protocol')
        const next = history.data.currentIndex + (action === 'back' ? -1 : 1)
        const entry = history.data.entries[next]
        if (entry === undefined) {
          await this.refreshHistory(record)
          return this.snapshot(record)
        }
        record.state = { ...record.state, loading: true }
        this.publish(record)
        await this.cdp(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id })
      } else if (action === 'reload') {
        record.state = { ...record.state, loading: true }
        this.clearError(record)
        this.publish(record)
        await this.cdp(tabId, 'Page.reload', {})
      } else {
        await this.cdp(tabId, 'Page.stopLoading', {})
        record.state = { ...record.state, loading: false }
      }
      await this.refreshHistory(record)
      return this.snapshot(record)
    } catch (error) {
      if (record.state.closed !== true) this.fail(record, messages.browser.failure.failed)
      throw error
    }
  }

  focus(tabId: string): Promise<BrowserHostState> {
    this.requireTab(tabId)
    return Promise.reject(new BrowserCdpError('unsupported', messages.extension.channelRefused))
  }

  async close(tabId: string): Promise<BrowserHostState> {
    const record = this.requireTab(tabId)
    await record.tab.close()
    this.release(record)
    await this.persist()
    return this.snapshot(record)
  }

  async cdp(
    tabId: string,
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const record = this.requireTab(tabId)
    if (record.ownershipLost) throw new BrowserCdpError('detached', messages.browser.attachFailed)
    const transport = await this.connect(record)
    if (!record.initialized) await this.initialize(record)
    this.requireTab(tabId)
    return await transport.sendCommand(method, params, signal)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const disposable of this.cleanup) disposable.dispose()
    this.openedDuringRequest.clear()
    this.creating.clear()
    for (const record of this.byTab.values()) {
      record.lifetime.abort()
      record.transport?.dispose()
    }
    this.byTab.clear()
    this.byId.clear()
  }

  private create(
    tab: BrowserTabRef,
    projectId: string | null,
    browserId: string = randomUUID()
  ): TabRecord {
    const existing = this.byTab.get(tab)
    if (existing !== undefined) return existing
    const record: TabRecord = {
      tab,
      lifetime: new AbortController(),
      state: {
        tabId: browserId,
        projectId,
        url: tab.url,
        title: tab.title,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        generation: 0,
      },
      targetId: null,
      transport: null,
      connection: null,
      announced: false,
      initialized: false,
      ownershipLost: false,
      rootFrameId: null,
      documentId: null,
      apiNavigation: null,
      historyRevision: 0,
    }
    this.byTab.set(tab, record)
    this.byId.set(browserId, record)
    return record
  }

  private opened(tab: BrowserTabRef): void {
    if (this.disposed || this.closedTabs.has(tab) || this.byTab.has(tab)) return
    const owner = this.options.focusedProject()
    if (this.opening > 0) {
      this.openedDuringRequest.set(tab, owner)
      return
    }
    this.adopt(tab, owner)
  }

  private flushOpened(): void {
    for (const [tab, owner] of this.openedDuringRequest) {
      this.openedDuringRequest.delete(tab)
      if (!this.byTab.has(tab) && !this.disposed) this.adopt(tab, owner)
    }
  }

  private adopt(tab: BrowserTabRef, projectId: string | null): void {
    const record = this.create(tab, projectId)
    record.announced = true
    this.publish(record)
    void this.connect(record)
      .then(() => this.initialize(record))
      .catch(() => {
        if (record.state.closed !== true && !this.disposed) {
          this.fail(record, messages.browser.attachFailed)
        }
      })
  }

  private connect(record: TabRecord): Promise<BrowserTabCdp> {
    if (record.transport?.isAttached() === true) return Promise.resolve(record.transport)
    record.connection ??= this.attach(record).finally(() => {
      record.connection = null
    })
    return record.connection
  }

  private async attach(record: TabRecord): Promise<BrowserTabCdp> {
    const closed = (): boolean => this.disposed || record.lifetime.signal.aborted
    if (closed()) throw new BrowserCdpError('closed')
    const session = await startSession(record.tab, record.lifetime.signal)
    if (closed()) {
      void Promise.resolve(session.close()).catch(() => undefined)
      throw new BrowserCdpError('closed')
    }
    const transport = new BrowserTabCdp(session, { url: () => record.tab.url })
    const previous = record.transport
    record.transport = transport
    record.initialized = false
    previous?.dispose()
    this.listen(record, transport)
    try {
      await transport.attach('1.3')
      record.targetId = transport.targetId
      if (!record.ownershipLost) this.clearError(record)
      this.publish(record)
      return transport
    } catch (error) {
      if (record.transport === transport) record.transport = null
      transport.dispose()
      throw error
    }
  }

  private listen(record: TabRecord, transport: BrowserTabCdp): void {
    const active = (): boolean =>
      !this.disposed &&
      record.state.closed !== true &&
      record.transport === transport &&
      !record.lifetime.signal.aborted
    transport.onMessage((method, params) => {
      if (!active()) return
      if (method === 'Page.frameNavigated') {
        const frame = FrameNavigation.safeParse(params)
        if (frame.success && frame.data.frame.parentId === undefined) {
          record.rootFrameId = frame.data.frame.id
        }
      } else if (method === 'Page.frameStartedLoading' || method === 'Page.frameStoppedLoading') {
        const frame = Frame.safeParse(params)
        if (frame.success && frame.data.frameId === record.rootFrameId) {
          record.state = { ...record.state, loading: method === 'Page.frameStartedLoading' }
          this.publish(record)
        }
      } else if (method === 'Page.loadEventFired') {
        record.state = { ...record.state, loading: false }
        this.publish(record)
        void this.refreshHistory(record).catch(() => undefined)
      }
      if (record.announced) {
        this.options.emit({ kind: 'cdp', ...this.identity(record), method, params })
      }
    })
    transport.onNavigated((url, documentId, sameDocument) => {
      if (!active()) return
      if (documentId !== null && documentId === record.documentId) return
      record.documentId = documentId
      if (record.apiNavigation === url) {
        record.apiNavigation = null
        record.state = { ...record.state, url, loading: !sameDocument }
        this.publish(record)
      } else {
        this.navigated(record, url, !sameDocument)
      }
      void this.refreshHistory(record).catch(() => undefined)
    })
    transport.onCrashed((reason) => {
      if (!active()) return
      record.state = {
        ...record.state,
        loading: false,
        generation: record.state.generation + 1,
        error: messages.browser.failure.failed,
      }
      if (record.announced) {
        this.options.emit({ kind: 'crashed', ...this.identity(record), reason })
      }
      this.publish(record)
    })
    transport.onGone(() => {
      if (active()) this.release(record)
    })
    transport.onDetached(() => {
      if (!active()) return
      if (record.state.error === undefined) {
        record.state = {
          ...record.state,
          loading: false,
          generation: record.state.generation + 1,
          error: messages.browser.attachFailed,
        }
      }
      if (record.announced) {
        this.options.emit({
          kind: 'cdp',
          ...this.identity(record),
          method: 'Inspector.detached',
          params: {},
        })
      }
      this.publish(record)
    })
  }

  private async initialize(record: TabRecord): Promise<void> {
    if (record.initialized) return
    const transport = await this.connect(record)
    await transport.sendCommand('Page.enable', {})
    const frame = FrameTree.safeParse(await transport.sendCommand('Page.getFrameTree', {}))
    if (frame.success) {
      record.rootFrameId = frame.data.frameTree.frame.id
      record.documentId = frame.data.frameTree.frame.loaderId ?? null
    }
    await this.refreshHistory(record)
    if (record.transport === transport) record.initialized = true
  }

  private async refreshHistory(record: TabRecord): Promise<void> {
    const transport = record.transport
    const closed = (): boolean => this.disposed || record.lifetime.signal.aborted
    if (transport?.isAttached() !== true || record.state.closed === true || closed()) return
    const revision = ++record.historyRevision
    const generation = record.state.generation
    const history = History.safeParse(await transport.sendCommand('Page.getNavigationHistory', {}))
    if (
      !history.success ||
      closed() ||
      generation !== record.state.generation ||
      revision !== record.historyRevision
    ) {
      return
    }
    record.state = {
      ...record.state,
      canGoBack: history.data.currentIndex > 0,
      canGoForward: history.data.currentIndex + 1 < history.data.entries.length,
    }
    this.publish(record)
  }

  private syncState(record: TabRecord): void {
    if (record.state.closed === true || this.disposed) return
    const url = record.tab.url
    const changed = url !== record.state.url
    record.state = { ...record.state, url, title: record.tab.title }
    if (changed) {
      record.apiNavigation = url
      record.transport?.invalidateDocument()
      this.navigated(record, url)
      void this.refreshHistory(record).catch(() => undefined)
    } else {
      this.publish(record)
    }
  }

  private navigated(record: TabRecord, url: string, loading = true): void {
    record.state = {
      ...record.state,
      url,
      loading,
      generation: record.state.generation + 1,
    }
    this.clearError(record)
    if (record.announced) {
      this.options.emit({ kind: 'navigated', ...this.identity(record), url })
    }
    this.publish(record)
  }

  private release(record: TabRecord): void {
    if (record.state.closed === true) return
    record.state = {
      ...record.state,
      loading: false,
      closed: true,
      generation: record.state.generation + 1,
    }
    record.lifetime.abort()
    record.transport?.dispose()
    this.byTab.delete(record.tab)
    this.byId.delete(record.state.tabId)
    this.publish(record)
    if (!this.disposed && record.announced) {
      this.options.emit({ kind: 'gone', ...this.identity(record) })
    }
  }

  private missing(saved: z.infer<typeof SavedTab>, error: string): void {
    const state: BrowserHostState = {
      tabId: saved.tabId,
      projectId: saved.projectId,
      url: saved.url,
      title: saved.title,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      generation: saved.generation + 1,
      closed: true,
      error,
    }
    this.options.emit({ kind: 'state', state })
    this.options.emit({
      kind: 'gone',
      tabId: state.tabId,
      projectId: state.projectId,
      generation: state.generation,
    })
  }

  private requireAvailable(): void {
    if (this.disposed) throw new BrowserCdpError('closed')
    if (!this.available) throw new Error(messages.extension.missingBrowser)
  }

  private requireTab(tabId: string): TabRecord {
    this.requireAvailable()
    const record = this.byId.get(tabId)
    if (record === undefined || record.state.closed === true) throw new BrowserCdpError('closed')
    return record
  }

  private requireUrl(url: string): void {
    if (!isBrowserNavigable(url)) {
      throw new BrowserCdpError('unsupported', messages.browser.failure['invalid-address'])
    }
  }

  private identity(record: TabRecord): BrowserHostIdentity {
    return {
      tabId: record.state.tabId,
      projectId: record.state.projectId,
      generation: record.state.generation,
    }
  }

  private snapshot(record: TabRecord): BrowserHostState {
    return { ...record.state }
  }

  private clearError(record: TabRecord): void {
    if (record.ownershipLost || record.state.error === undefined) return
    const { error: _error, ...state } = record.state
    record.state = state
  }

  private fail(record: TabRecord, error: string): void {
    record.state = { ...record.state, loading: false, error }
    this.publish(record)
  }

  private publish(record: TabRecord): void {
    if (this.disposed || !record.announced) return
    this.options.emit({ kind: 'state', state: this.snapshot(record) })
    void this.persist()
  }

  private persist(): Promise<void> {
    if (this.disposed || this.restoring) return this.persistence
    const value = {
      version: 1,
      tabs: [...this.byTab.values()]
        .filter((record) => record.state.closed !== true)
        .map((record) => ({
          tabId: record.state.tabId,
          projectId: record.state.projectId,
          targetId: record.targetId,
          url: record.state.url,
          title: record.state.title,
          generation: record.state.generation,
        })),
    }
    const serialized = JSON.stringify(value)
    if (serialized === this.persisted) return this.persistence
    this.persisted = serialized
    this.persistence = this.persistence
      .then(async () => {
        await this.options.workspaceState.update(BROWSER_HOST_STORAGE_KEY, value)
      })
      .catch(() => {
        this.persisted = ''
        this.options.log(messages.browser.failure['storage-unavailable'])
      })
    return this.persistence
  }
}
