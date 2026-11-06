import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Logger } from '@chorus/shared'
import { z } from 'zod'
import type { BrowserSurfacePort } from '../../desktop/src/main/browser-port.js'
import type { BrowserStreamPort } from '../../desktop/src/main/browser-stream-port.js'
import type { BrowserConsoles } from '../../desktop/src/main/browser-console.js'
import type { ShellClient } from '../../desktop/src/main/shell-client.js'
import { BrowserSettingsStore } from '../../desktop/src/main/browser-settings.js'
import {
  BROWSER_PUSH_CHANNEL,
  BROWSER_HOME_URL,
  BROWSER_MISSING_CODE,
  BROWSER_STOPPED_CODE,
  browserAddressOrSearch,
  browserScrubUrl,
  isBrowserNavigable,
  type BrowserInputEvent,
  type BrowserAction,
  type BrowserState,
  type BrowserFailure,
  type BrowserPush,
} from '../../desktop/src/shared/browser-ipc.js'
import messages from '../../desktop/src/renderer/src/i18n/en.json'
import type { EnginePeer } from './peers.js'
import type { BrowserHostEvent } from './browser-protocol.js'
import { ChromeProcess, findChrome } from './chrome-process.js'
import { ChromeBrowserSource, ChromePage } from './chrome-browser-source.js'
import { BrowserStreams } from './browser-streams.js'
import { commandsFor } from './mac-editing-commands.js'

interface ProjectBrowser {
  readonly id: string
  readonly projectId: string
  controller: EnginePeer | null
  readonly peers: Set<EnginePeer>
  creating: Promise<ChromePage> | null
  readonly stack: ChromePage[]
  generation: number
  navigation: number
  state: BrowserState
}

interface PageEvents {
  readonly stop: () => void
  frameId: string | null
  loaderId: string | null
  history: number
}

const TargetCreated = z.object({ targetId: z.string() })
const TargetAttached = z.object({ sessionId: z.string() })
const TargetInfo = z.object({ targetId: z.string(), title: z.string(), url: z.string() })
const FrameNavigated = z.object({
  frame: z.object({
    id: z.string(),
    parentId: z.string().optional(),
    loaderId: z.string(),
    url: z.string(),
    urlFragment: z.string().optional(),
  }),
})
const WithinDocument = z.object({ frameId: z.string(), url: z.string() })
const Lifecycle = z.object({ frameId: z.string(), loaderId: z.string(), name: z.string() })
const NavigationHistory = z.object({
  currentIndex: z.number().int(),
  entries: z.array(z.object({ id: z.number().int() })),
})
const Navigated = z.object({ errorText: z.string().optional() })
const CONSOLE_READY_TIMEOUT_MS = 15_000
const NAVIGATION_TIMEOUT_MS = 120_000

const emptyState = (url: string | null = null): BrowserState => ({
  status: 'empty',
  live: false,
  url,
  title: '',
  icon: null,
  canGoBack: false,
  canGoForward: false,
  documentId: null,
  passwordOrigin: null,
  error: null,
  zoom: 1,
})

export class EngineBrowsers {
  readonly port: BrowserSurfacePort
  readonly streams: BrowserStreamPort
  private readonly browserStreams: BrowserStreams
  private readonly records = new Map<string, ProjectBrowser>()
  private readonly byId = new Map<string, ProjectBrowser>()
  private readonly sources = new Map<string, ChromeBrowserSource>()
  private readonly pageEvents = new Map<ChromePage, PageEvents>()
  private readonly settings: BrowserSettingsStore
  private readonly chrome: ChromeProcess
  private closed = false
  private closing: Promise<void> | null = null

  constructor(
    directory: string,
    private readonly consoles: BrowserConsoles,
    private readonly isAdopted: (id: string) => boolean,
    log: Logger
  ) {
    this.settings = new BrowserSettingsStore(directory)
    this.browserStreams = new BrowserStreams((id) => {
      const record = this.byId.get(id)
      return record === undefined ? null : this.active(record)
    })
    this.streams = {
      stream: (owner, request) => {
        this.viewed(owner, request.browserId)
        this.browserStreams.stream(owner as EnginePeer, request)
      },
      ack: (owner, id, instance, generation, serial) => {
        this.viewed(owner, id)
        this.browserStreams.ack(owner as EnginePeer, id, instance, generation, serial)
      },
      input: (owner, id, event) => this.input(this.controlled(owner, id), event),
      selection: (owner, id) => this.selection(this.viewed(owner, id)),
      release: (owner) => {
        this.browserStreams.release(owner as EnginePeer)
      },
    }
    this.chrome = new ChromeProcess(
      join(directory, 'browser', 'chrome-profile'),
      (message, fields) => {
        log.warn(message, fields)
      }
    )
    this.chrome.onExit((reason) => {
      this.stopped(reason)
    })
    this.chrome.onEvent((method, params, sessionId) => {
      if (sessionId === undefined) this.rootEvent(method, params)
    })
    const unsupportedPasswords = () => ({
      passwords: { storage: 'unavailable' as const, origin: null, accounts: [], neverSave: false },
      failure: 'not-eligible' as const,
    })
    this.port = {
      webReady: () => ({ ok: true }),
      attach: (owner, projectId) => this.attach(owner as EnginePeer, projectId),
      attachWebTab: () => {
        throw new Error(messages.extension.browserUnavailable)
      },
      detach: () => ({ ok: true }),
      restore: async (owner, id) => {
        const record = this.controlled(owner, id)
        return await this.navigate(record, record.state.url ?? BROWSER_HOME_URL)
      },
      navigate: (owner, id, address) => this.navigate(this.controlled(owner, id), address),
      act: (owner, id, action) => this.act(this.controlled(owner, id), action),
      find: () => ({ failure: 'not-eligible' }),
      close: async (owner, id) => {
        const record = this.controlled(owner, id)
        const pages = this.clearPages(record)
        record.state = emptyState(record.state.url)
        this.publish(record)
        await Promise.all(pages.map((page) => this.closeTarget(page.targetId)))
        return { ok: true }
      },
      reopen: () => ({ reopened: null }),
      geometry: (_owner, request) => ({ revision: request.revision, still: null }),
      addFavorite: async (owner, id) => {
        const record = this.viewed(owner, id)
        if (record.state.url === null) return { favorites: [], failure: 'not-loaded' }
        const outcome = await this.settings.addFavorite(record.projectId, {
          url: record.state.url,
          title: record.state.title,
          icon: record.state.icon,
        })
        this.push(record, {
          kind: 'favorites',
          browserId: record.id,
          favorites: outcome.favorites,
        })
        return { favorites: [...outcome.favorites], failure: outcome.failure }
      },
      removeFavorite: async (owner, id, favoriteId) => {
        const record = this.viewed(owner, id)
        const outcome = await this.settings.removeFavorite(record.projectId, favoriteId)
        this.push(record, {
          kind: 'favorites',
          browserId: record.id,
          favorites: outcome.favorites,
        })
        return { favorites: [...outcome.favorites], failure: outcome.failure }
      },
      openFavorite: async (owner, id, favoriteId) => {
        const record = this.controlled(owner, id)
        const favorite = await this.settings.favorite(record.projectId, favoriteId)
        return favorite === null
          ? { state: record.state, failure: 'not-found' }
          : await this.navigate(record, favorite.url)
      },
      passwords: unsupportedPasswords,
      decide: unsupportedPasswords,
      removePassword: unsupportedPasswords,
      allowPasswords: unsupportedPasswords,
      fill: () => ({ failure: 'not-eligible' }),
      closeOwner: (owner) => {
        this.release(owner)
      },
      shutdown: () => this.close(),
    }
  }

  async consoleBrowser(owner: EnginePeer, browserId: string): Promise<string> {
    const record = this.controlled(owner, browserId)
    const page = this.active(record)
    if (page === null) return browserId
    const id = this.sourceId(record, page)
    const state = this.consoles
      .snapshot(record.projectId)
      .sources.find((source) => source.browserId === id)?.state
    if (state === 'connecting') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          stop()
          resolve()
        }, CONSOLE_READY_TIMEOUT_MS)
        timer.unref()
        const stop = this.consoles.subscribe((event) => {
          if (event.kind !== 'state' || event.projectId !== record.projectId) return
          if (event.sources.find((source) => source.browserId === id)?.state === 'connecting') return
          clearTimeout(timer)
          stop()
          resolve()
        })
      })
    }
    return id
  }

  private viewed(owner: ShellClient, id: string): ProjectBrowser {
    const record = this.byId.get(id)
    if (
      this.closed ||
      record === undefined ||
      !record.peers.has(owner as EnginePeer) ||
      owner.isGone()
    )
      throw new Error(messages.extension.browserUnavailable)
    return record
  }

  private controlled(owner: ShellClient, id: string): ProjectBrowser {
    const record = this.viewed(owner, id)
    const peer = owner as EnginePeer
    if (record.controller !== peer) {
      record.controller = peer
      for (const page of record.stack) if (!page.isClosed()) this.mountSource(record, page)
    }
    return record
  }

  private ensure(owner: EnginePeer, projectId: string): ProjectBrowser {
    let record = this.records.get(projectId)
    if (record === undefined) {
      record = {
        id: randomUUID(),
        projectId,
        controller: null,
        peers: new Set(),
        creating: null,
        stack: [],
        generation: 0,
        navigation: 0,
        state: emptyState(),
      }
      this.records.set(projectId, record)
      this.byId.set(record.id, record)
    }
    record.peers.add(owner)
    return this.controlled(owner, record.id)
  }

  private async attach(owner: EnginePeer, projectId: string) {
    if (!this.isAdopted(projectId)) throw new Error(messages.extension.browserUnavailable)
    const record = this.ensure(owner, projectId)
    const saved = await this.settings.project(projectId)
    if (record.state.url === null) record.state = { ...record.state, url: saved.settings.lastUrl }
    if (this.active(record) === null) {
      if (findChrome() === null) this.unavailable(record, true)
      else if (record.state.error?.code === BROWSER_MISSING_CODE)
        record.state = emptyState(record.state.url)
    }
    this.publish(record)
    return {
      browserId: record.id,
      state: record.state,
      favorites: [...saved.settings.favorites],
      settings: saved.status,
    }
  }

  private ensurePage(record: ProjectBrowser): Promise<ChromePage> {
    const live = this.active(record)
    if (live !== null) return Promise.resolve(live)
    if (this.closed) return Promise.reject(new Error('browser-stopping'))
    if (record.creating !== null) return record.creating
    const creating = this.createPage(record).finally(() => {
      if (record.creating === creating) record.creating = null
    })
    record.creating = creating
    return creating
  }

  private async createPage(record: ProjectBrowser): Promise<ChromePage> {
    const generation = ++record.generation
    await this.chrome.start()
    if (this.closed || generation !== record.generation) throw new Error('browser-stopped')
    const { targetId } = TargetCreated.parse(
      await this.chrome.send('Target.createTarget', { url: 'about:blank', newWindow: true })
    )
    let page: ChromePage | null = null
    try {
      const { sessionId } = TargetAttached.parse(
        await this.chrome.send('Target.attachToTarget', { targetId, flatten: true })
      )
      page = new ChromePage(this.chrome, targetId, sessionId, generation, null)
      await Promise.all([
        page.send('Page.enable', {}),
        page.send('Page.setLifecycleEventsEnabled', { enabled: true }),
      ])
      if (this.closed || generation !== record.generation || page.isClosed())
        throw new Error('browser-stopped')
      const initialized = page
      this.pageEvents.set(initialized, {
        stop: initialized.onEvent((method, params) => {
          this.pageEvent(record, initialized, method, params)
        }),
        frameId: null,
        loaderId: null,
        history: 0,
      })
      record.stack.splice(0, record.stack.length, initialized)
      record.state = { ...record.state, live: true, error: null }
      this.mountSource(record, initialized)
      this.browserStreams.activeChanged(record.id)
      this.publish(record)
      return initialized
    } catch (error) {
      if (page !== null) this.releasePage(record, page)
      await this.closeTarget(targetId)
      throw error
    }
  }

  private active(record: ProjectBrowser): ChromePage | null {
    for (let index = record.stack.length - 1; index >= 0; index -= 1) {
      const page = record.stack[index]
      if (page !== undefined && !page.isClosed()) return page
    }
    return null
  }

  private async navigate(
    record: ProjectBrowser,
    address: string
  ): Promise<{ state: BrowserState; failure: BrowserFailure | null }> {
    const url = browserAddressOrSearch(address)
    if (url === null || !isBrowserNavigable(url))
      return { state: record.state, failure: 'invalid-address' }
    const navigation = ++record.navigation
    record.state = { ...record.state, url: browserScrubUrl(url), status: 'loading', error: null }
    this.publish(record)
    let page: ChromePage
    try {
      page = await this.ensurePage(record)
    } catch {
      if (navigation === record.navigation) {
        const pages = this.clearPages(record)
        this.unavailable(record, findChrome() === null)
        void Promise.all(pages.map((page) => this.closeTarget(page.targetId)))
      }
      return { state: record.state, failure: 'not-loaded' }
    }
    if (navigation !== record.navigation || this.active(record) !== page)
      return { state: record.state, failure: null }
    try {
      const result = Navigated.parse(
        await page.send('Page.navigate', { url }, NAVIGATION_TIMEOUT_MS)
      )
      if (navigation !== record.navigation || this.active(record) !== page)
        return { state: record.state, failure: null }
      if (result.errorText !== undefined) {
        this.navigationFailed(record, page, navigation, new Error(result.errorText))
        return { state: record.state, failure: 'not-loaded' }
      }
      return { state: record.state, failure: null }
    } catch (error) {
      this.navigationFailed(record, page, navigation, error)
      return { state: record.state, failure: 'not-loaded' }
    }
  }

  private async act(
    record: ProjectBrowser,
    action: BrowserAction
  ): Promise<{ state: BrowserState; failure: BrowserFailure | null }> {
    if (action === 'external') {
      if (record.state.url !== null)
        await record.controller?.requestHost('openExternal', { url: record.state.url })
      return { state: record.state, failure: null }
    }
    if (action === 'focus') {
      this.push(record, { kind: 'command', browserId: record.id, command: 'reveal' })
      return { state: record.state, failure: null }
    }
    const page = this.active(record)
    if (action === 'reload' && page === null)
      return await this.navigate(record, record.state.url ?? BROWSER_HOME_URL)
    if (page === null) return { state: record.state, failure: 'not-loaded' }
    if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop')
      return { state: record.state, failure: 'not-eligible' }
    const navigation = ++record.navigation
    try {
      if (action === 'back' || action === 'forward') {
        const history = NavigationHistory.parse(await page.send('Page.getNavigationHistory', {}))
        if (navigation !== record.navigation || this.active(record) !== page)
          return { state: record.state, failure: 'not-loaded' }
        const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)]
        if (entry !== undefined) {
          record.state = { ...record.state, status: 'loading', error: null }
          this.publish(record)
          await page.send('Page.navigateToHistoryEntry', { entryId: entry.id }, NAVIGATION_TIMEOUT_MS)
        }
      } else if (action === 'reload') {
        record.state = { ...record.state, status: 'loading', error: null }
        this.publish(record)
        await page.send('Page.reload', {}, NAVIGATION_TIMEOUT_MS)
      } else {
        await page.send('Page.stopLoading', {})
        if (navigation === record.navigation && this.active(record) === page) {
          record.state = { ...record.state, status: 'ready', error: null }
          this.publish(record)
        }
      }
      if (navigation === record.navigation && this.active(record) === page)
        void this.refreshHistory(record, page)
      return { state: record.state, failure: null }
    } catch (error) {
      this.navigationFailed(record, page, navigation, error)
      return { state: record.state, failure: 'not-loaded' }
    }
  }

  private navigationFailed(
    record: ProjectBrowser,
    page: ChromePage,
    navigation: number,
    error: unknown
  ): void {
    if (navigation !== record.navigation || this.active(record) !== page) return
    if (error instanceof Error && error.message === 'browser-timeout')
      record.state = { ...record.state, status: 'loading', error: null }
    else {
      const description = error instanceof Error ? error.message : messages.browser.failure.failed
      record.state = {
        ...record.state,
        status: 'error',
        error: { code: -1, description: description.slice(0, 512) },
      }
    }
    this.publish(record)
  }

  private async input(record: ProjectBrowser, event: BrowserInputEvent): Promise<void> {
    const page = this.active(record)
    if (page === null) return
    if (event.kind === 'mouse') {
      const { kind: _kind, ...params } = event
      await page.send('Input.dispatchMouseEvent', params)
    } else if (event.kind === 'wheel') {
      const { kind: _kind, ...params } = event
      await page.send('Input.dispatchMouseEvent', { ...params, type: 'mouseWheel' })
    } else if (event.kind === 'key') {
      await page.send('Input.dispatchKeyEvent', {
        type: event.type,
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        modifiers: event.modifiers,
        autoRepeat: event.autoRepeat,
        ...(process.platform === 'darwin' && event.type !== 'keyUp'
          ? { commands: commandsFor(event.code, event.modifiers) }
          : {}),
        ...(event.text === undefined ? {} : { text: event.text, unmodifiedText: event.text }),
      })
    } else await page.send('Input.insertText', { text: event.text })
  }

  private async selection(record: ProjectBrowser): Promise<string> {
    const page = this.active(record)
    const frameId = page === null ? null : this.pageEvents.get(page)?.frameId
    if (page === null || frameId === null || frameId === undefined) return ''
    let contextId: number | undefined
    for (const payload of page.runtimeContexts().values()) {
      const context = z.object({
        context: z.object({
          id: z.number(),
          name: z.string(),
          auxData: z.object({ frameId: z.string() }).optional(),
        }),
      }).safeParse(payload)
      if (context.success && context.data.context.name === 'chorus' && context.data.context.auxData?.frameId === frameId)
        contextId = context.data.context.id
    }
    if (contextId === undefined) {
      const created = z.object({ executionContextId: z.number() }).parse(
        await page.send('Page.createIsolatedWorld', { frameId, worldName: 'chorus' })
      )
      contextId = created.executionContextId
    }
    if (this.active(record) !== page) return ''
    const raw = await page.send('Runtime.evaluate', {
      contextId,
      expression: `(() => {
        const field = document.activeElement
        if (field instanceof HTMLInputElement && field.type === 'password') return ''
        if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.selectionStart !== null && field.selectionEnd !== null)
          return field.value.slice(field.selectionStart, field.selectionEnd)
        return window.getSelection()?.toString() ?? ''
      })()`,
      returnByValue: true,
    })
    if (this.active(record) !== page) return ''
    const result = z.object({ result: z.object({ value: z.string().optional() }) }).parse(raw)
    return (result.result.value ?? '').slice(0, 100_000)
  }

  viewVisibility(peer: EnginePeer, visible: boolean): void {
    this.browserStreams.viewVisibility(peer, visible)
  }

  private pageEvent(record: ProjectBrowser, page: ChromePage, method: string, params: unknown): void {
    const events = this.pageEvents.get(page)
    if (events === undefined || this.active(record) !== page) return
    if (method === 'Page.screencastFrame') {
      this.browserStreams.frame(record.id, page, params)
      return
    }
    if (method === 'Page.frameNavigated') {
      const parsed = FrameNavigated.safeParse(params)
      if (!parsed.success || parsed.data.frame.parentId !== undefined) return
      const frame = parsed.data.frame
      events.frameId = frame.id
      events.loaderId = frame.loaderId
      this.navigatedTo(record, page, frame.url + (frame.urlFragment ?? ''))
      record.state = {
        ...record.state,
        status: 'loading',
        documentId: `${page.targetId}:${frame.loaderId}`,
        error: null,
      }
      this.sources.get(this.sourceId(record, page))?.navigatedTo(page.url)
      this.publish(record)
      void this.refreshHistory(record, page)
    } else if (method === 'Page.navigatedWithinDocument') {
      const parsed = WithinDocument.safeParse(params)
      if (!parsed.success || parsed.data.frameId !== events.frameId) return
      this.navigatedTo(record, page, parsed.data.url)
      this.publish(record)
      void this.refreshHistory(record, page)
    } else if (method === 'Page.lifecycleEvent') {
      const parsed = Lifecycle.safeParse(params)
      if (
        !parsed.success ||
        parsed.data.frameId !== events.frameId ||
        parsed.data.loaderId !== events.loaderId
      )
        return
      if (parsed.data.name === 'load') {
        record.state = { ...record.state, status: 'ready', error: null }
        this.publish(record)
        void this.refreshHistory(record, page)
      }
    } else if (method === 'Page.frameStartedLoading' || method === 'Page.frameStoppedLoading') {
      const parsed = z.object({ frameId: z.string() }).safeParse(params)
      if (!parsed.success || parsed.data.frameId !== events.frameId) return
      if (method === 'Page.frameStartedLoading')
        record.state = { ...record.state, status: 'loading', error: null }
      else if (record.state.status !== 'error') record.state = { ...record.state, status: 'ready' }
      this.publish(record)
    } else if (method === 'Inspector.targetCrashed' || method === 'Inspector.detached') {
      this.clearPages(record)
      this.unavailable(record, false)
      void this.closeTarget(page.targetId)
    }
  }

  private rootEvent(method: string, params: unknown): void {
    if (method === 'Target.targetInfoChanged') {
      const parsed = z.object({ targetInfo: TargetInfo }).safeParse(params)
      if (!parsed.success) return
      const info = parsed.data.targetInfo
      for (const record of this.records.values()) {
        const page = this.active(record)
        if (page === null || page.targetId !== info.targetId) continue
        this.navigatedTo(record, page, info.url)
        record.state = { ...record.state, title: info.title.slice(0, 512) }
        this.publish(record)
      }
    } else if (method === 'Target.targetDestroyed' || method === 'Target.detachedFromTarget') {
      const parsed = z
        .object({ targetId: z.string().optional(), sessionId: z.string().optional() })
        .safeParse(params)
      if (!parsed.success) return
      for (const record of this.records.values()) {
        const page = this.active(record)
        if (
          page === null ||
          (page.targetId !== parsed.data.targetId && page.sessionId !== parsed.data.sessionId)
        )
          continue
        this.clearPages(record)
        this.unavailable(record, false)
      }
    }
  }

  private navigatedTo(record: ProjectBrowser, page: ChromePage, url: string): void {
    page.url = url
    const scrubbed = browserScrubUrl(url)
    record.state = { ...record.state, url: scrubbed }
    if (page.openerId === null && scrubbed !== null)
      void this.settings.setLastUrl(record.projectId, scrubbed)
  }

  private async refreshHistory(record: ProjectBrowser, page: ChromePage): Promise<void> {
    const events = this.pageEvents.get(page)
    if (events === undefined) return
    const revision = ++events.history
    try {
      const history = NavigationHistory.parse(await page.send('Page.getNavigationHistory', {}))
      if (this.active(record) !== page || events.history !== revision) return
      record.state = {
        ...record.state,
        canGoBack: history.currentIndex > 0,
        canGoForward: history.currentIndex >= 0 && history.currentIndex < history.entries.length - 1,
      }
      this.publish(record)
    } catch {
      return
    }
  }

  private sourceId(record: ProjectBrowser, _page: ChromePage): string {
    return record.id
  }

  private mountSource(record: ProjectBrowser, page: ChromePage): void {
    const owner = record.controller
    const id = this.sourceId(record, page)
    const previous = this.sources.get(id)
    if (previous?.owner === owner && previous.page === page && !previous.isGone()) return
    if (previous !== undefined) {
      previous.close()
      this.consoles.release(previous)
      this.sources.delete(id)
    }
    if (owner === null || owner.isGone() || page.isClosed()) return
    const source = new ChromeBrowserSource(id, record.projectId, owner, page)
    this.sources.set(id, source)
    this.consoles.mount(source)
  }

  private releasePage(record: ProjectBrowser, page: ChromePage): void {
    page.markClosed()
    this.pageEvents.get(page)?.stop()
    this.pageEvents.delete(page)
    const id = this.sourceId(record, page)
    const source = this.sources.get(id)
    if (source?.page === page) {
      source.close()
      this.consoles.release(source)
      this.sources.delete(id)
    }
  }

  private clearPages(record: ProjectBrowser): ChromePage[] {
    record.generation += 1
    record.navigation += 1
    record.creating = null
    const pages = record.stack.splice(0)
    for (const page of pages) this.releasePage(record, page)
    this.browserStreams.activeChanged(record.id)
    return pages
  }

  private async closeTarget(targetId: string): Promise<void> {
    await this.chrome.send('Target.closeTarget', { targetId }).catch(() => undefined)
  }

  private unavailable(record: ProjectBrowser, missing: boolean): void {
    record.state = {
      ...record.state,
      status: 'error',
      live: false,
      canGoBack: false,
      canGoForward: false,
      documentId: null,
      error: {
        code: missing ? BROWSER_MISSING_CODE : BROWSER_STOPPED_CODE,
        description: missing ? messages.extension.browserMissing : messages.extension.browserStopped,
      },
    }
    this.publish(record)
  }

  private stopped(_reason: string): void {
    for (const record of this.records.values()) {
      this.clearPages(record)
      this.unavailable(record, false)
    }
  }

  receive(_owner: EnginePeer, _event: BrowserHostEvent): void {
    return
  }

  private push(record: ProjectBrowser, push: BrowserPush): void {
    for (const peer of record.peers) if (!peer.isGone()) peer.send(BROWSER_PUSH_CHANNEL, push)
  }

  private publish(record: ProjectBrowser): void {
    this.push(record, { kind: 'state', browserId: record.id, state: record.state })
  }

  release(owner: ShellClient): void {
    for (const record of this.records.values()) {
      record.peers.delete(owner as EnginePeer)
      if (record.controller !== owner) continue
      record.controller = [...record.peers].find((peer) => !peer.isGone()) ?? null
      for (const page of record.stack) this.mountSource(record, page)
    }
  }

  close(): Promise<void> {
    if (this.closing !== null) return this.closing
    this.closed = true
    this.browserStreams.close()
    this.stopped('shutdown')
    this.closing = Promise.all([this.chrome.close(), this.settings.flush()]).then(() => undefined)
    return this.closing
  }
}
