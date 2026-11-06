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
  BrowserSelectPrompt,
  BrowserDialogPrompt,
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
import { CHORUS_WORLD, SELECT_BINDING, SELECT_BRIDGE, chooseSelectExpression } from './chrome-page-scripts.js'

interface ProjectBrowser {
  readonly id: string
  readonly projectId: string
  controller: EnginePeer | null
  readonly peers: Set<EnginePeer>
  creating: Promise<ChromePage> | null
  readonly stack: ChromePage[]
  generation: number
  navigation: number
  lifetime: number
  state: BrowserState
  select: { readonly prompt: BrowserSelectPrompt; readonly contextId: number; readonly page: ChromePage } | null
  dialog: { readonly prompt: BrowserDialogPrompt; readonly page: ChromePage } | null
}

interface PageEvents {
  readonly stop: () => void
  frameId: string | null
  loaderId: string | null
  history: number
  state: BrowserState
  dialog: BrowserDialogPrompt | null
  selectRevision: number
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
const TargetMetadata = TargetInfo.extend({ type: z.string(), openerId: z.string().optional() })
const FrameNode = z.object({ frame: FrameNavigated.shape.frame, childFrames: z.array(z.unknown()).optional() })
const FrameTree = z.object({ frameTree: FrameNode })
const ContextDescription = z.object({
  context: z.object({
    id: z.number(), name: z.string(),
    auxData: z.object({ isDefault: z.boolean().optional(), frameId: z.string().optional() }).optional(),
  }),
})
const BindingCalled = z.object({ name: z.string(), payload: z.string(), executionContextId: z.number() })
const DialogOpening = z.object({
  type: BrowserDialogPrompt.shape.type,
  message: z.string(),
  defaultPrompt: z.string().default(''),
})
const FileChooserOpened = z.object({ mode: z.enum(['selectSingle', 'selectMultiple']), backendNodeId: z.number().optional() })
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
  private readonly targets = new Map<string, { readonly record: ProjectBrowser; readonly page: ChromePage }>()
  private readonly openingTargets = new Set<string>()
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
        const record = this.viewed(owner, request.browserId)
        this.browserStreams.stream(owner as EnginePeer, request)
        owner.send(BROWSER_PUSH_CHANNEL, { kind: 'select', browserId: record.id, select: record.select?.prompt ?? null })
        owner.send(BROWSER_PUSH_CHANNEL, { kind: 'dialog', browserId: record.id, dialog: record.dialog?.prompt ?? null })
      },
      ack: (owner, id, instance, generation, serial) => {
        this.viewed(owner, id)
        this.browserStreams.ack(owner as EnginePeer, id, instance, generation, serial)
      },
      input: (owner, id, event) => this.input(this.controlled(owner, id), event),
      chooseSelect: (owner, id, token, index) => this.chooseSelect(this.controlled(owner, id), token, index),
      answerDialog: (owner, id, token, accept, text) => this.answerDialog(this.controlled(owner, id), token, accept, text),
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
      const page = this.active(record)
      if (page !== null) this.mountSource(record, page)
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
        lifetime: 0,
        state: emptyState(),
        select: null,
        dialog: null,
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

  private async createPage(
    record: ProjectBrowser,
    openerId: string | null = null,
    existing?: string
  ): Promise<ChromePage> {
    const lifetime = record.lifetime
    await this.chrome.start()
    if (this.closed || lifetime !== record.lifetime) {
      if (existing !== undefined) await this.closeTarget(existing)
      throw new Error('browser-stopped')
    }
    const targetId = existing ?? TargetCreated.parse(
      await this.chrome.send('Target.createTarget', { url: 'about:blank', newWindow: true })
    ).targetId
    let page: ChromePage | null = null
    try {
      const { sessionId } = TargetAttached.parse(
        await this.chrome.send('Target.attachToTarget', { targetId, flatten: true })
      )
      page = new ChromePage(this.chrome, targetId, sessionId, ++record.generation, openerId)
      const initialized = page
      const events: PageEvents = {
        stop: initialized.onEvent((method, params) => {
          this.pageEvent(record, initialized, method, params)
        }),
        frameId: null, loaderId: null, history: 0,
        state: { ...(openerId === null ? record.state : emptyState()), live: true, status: 'ready', error: null },
        dialog: null,
        selectRevision: 0,
      }
      this.pageEvents.set(initialized, events)
      this.targets.set(targetId, { record, page: initialized })
      await page.send('Runtime.addBinding', { name: SELECT_BINDING, executionContextName: CHORUS_WORLD })
      await Promise.all([
        page.send('Runtime.enable', {}),
        page.send('Page.enable', {}),
        page.send('Page.setLifecycleEventsEnabled', { enabled: true }),
        page.send('Page.setInterceptFileChooserDialog', { enabled: true }),
      ])
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: SELECT_BRIDGE, worldName: CHORUS_WORLD, runImmediately: true,
      })
      const tree = FrameTree.parse(await page.send('Page.getFrameTree', {}))
      if (events.frameId === null) {
        const frame = tree.frameTree.frame
        events.frameId = frame.id
        events.loaderId = frame.loaderId
        page.url = frame.url + (frame.urlFragment ?? '')
        events.state = {
          ...events.state,
          url: openerId === null ? events.state.url : browserScrubUrl(page.url),
          documentId: `${targetId}:${frame.loaderId}`,
        }
      }
      const frames = [tree.frameTree]
      while (frames.length > 0) {
        const node = frames.pop()
        if (node === undefined) continue
        frames.push(...(node.childFrames ?? []).map((child) => FrameNode.parse(child)))
        try {
          const { executionContextId } = z.object({ executionContextId: z.number() }).parse(
            await page.send('Page.createIsolatedWorld', { frameId: node.frame.id, worldName: CHORUS_WORLD })
          )
          const installed = z.object({ exceptionDetails: z.unknown().optional() }).parse(
            await page.send('Runtime.evaluate', { contextId: executionContextId, expression: SELECT_BRIDGE })
          )
          if (installed.exceptionDetails !== undefined) throw new Error('browser-bridge')
        } catch (error) {
          if (node.frame.id === tree.frameTree.frame.id) throw error
        }
      }
      if (
        this.closed || lifetime !== record.lifetime || page.isClosed() ||
        (openerId !== null && !record.stack.some((entry) => entry.targetId === openerId && !entry.isClosed()))
      )
        throw new Error('browser-stopped')
      const { targetInfo } = z.object({ targetInfo: TargetInfo }).parse(
        await this.chrome.send('Target.getTargetInfo', { targetId })
      )
      if (
        this.closed || lifetime !== record.lifetime || page.isClosed() ||
        (openerId !== null && !record.stack.some((entry) => entry.targetId === openerId && !entry.isClosed()))
      )
        throw new Error('browser-stopped')
      events.state = { ...events.state, title: targetInfo.title.slice(0, 512) }
      const previous = this.active(record)
      if (openerId === null) record.stack.splice(0, record.stack.length, initialized)
      else {
        record.navigation += 1
        record.stack.push(initialized)
      }
      this.activatePage(record, previous)
      return initialized
    } catch (error) {
      if (page !== null) this.releasePage(record, page)
      await this.closeTarget(targetId)
      throw error
    }
  }

  private activatePage(record: ProjectBrowser, previous: ChromePage | null): void {
    const prior = previous === null ? undefined : this.pageEvents.get(previous)
    if (prior !== undefined) prior.state = record.state
    this.clearSurfaces(record)
    const page = this.active(record)
    const events = page === null ? undefined : this.pageEvents.get(page)
    this.browserStreams.activeChanged(record.id)
    if (page === null || events === undefined) {
      this.unavailable(record, false)
      return
    }
    record.state = events.state
    this.mountSource(record, page)
    this.publish(record)
    if (events.dialog !== null) {
      record.dialog = { page, prompt: events.dialog }
      this.push(record, { kind: 'dialog', browserId: record.id, dialog: events.dialog })
    }
    void this.refreshHistory(record, page)
  }

  private setPageState(record: ProjectBrowser, page: ChromePage, change: Partial<BrowserState>): void {
    const events = this.pageEvents.get(page)
    if (events === undefined) return
    events.state = { ...(this.active(record) === page ? record.state : events.state), ...change }
    if (this.active(record) === page) {
      record.state = events.state
      this.publish(record)
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
      if (context.success && context.data.context.name === CHORUS_WORLD && context.data.context.auxData?.frameId === frameId)
        contextId = context.data.context.id
    }
    if (contextId === undefined) {
      const created = z.object({ executionContextId: z.number() }).parse(
        await page.send('Page.createIsolatedWorld', { frameId, worldName: CHORUS_WORLD })
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
    if (events === undefined) return
    if (method === 'Page.screencastFrame') {
      this.browserStreams.frame(record.id, page, params)
      return
    }
    if (method === 'Runtime.bindingCalled') {
      void this.selectOpened(record, page, params).catch(() => undefined)
      return
    }
    if (method === 'Runtime.executionContextDestroyed') {
      const parsed = z.object({ executionContextId: z.number() }).safeParse(params)
      if (parsed.success && record.select?.page === page && record.select.contextId === parsed.data.executionContextId)
        this.clearSurfaces(record, page)
    } else if (method === 'Runtime.executionContextsCleared') this.clearSurfaces(record, page)
    else if (method === 'Page.javascriptDialogOpening') {
      const parsed = DialogOpening.safeParse(params)
      if (!parsed.success) return
      if (record.select?.page === page) {
        record.select = null
        this.push(record, { kind: 'select', browserId: record.id, select: null })
      }
      events.dialog = {
        ...parsed.data,
        token: randomUUID(),
        message: parsed.data.message.slice(0, 10_000),
        defaultPrompt: parsed.data.defaultPrompt.slice(0, 10_000),
      }
      if (this.active(record) === page) {
        record.dialog = { page, prompt: events.dialog }
        this.push(record, { kind: 'dialog', browserId: record.id, dialog: events.dialog })
      }
    } else if (method === 'Page.javascriptDialogClosed') {
      events.dialog = null
      if (record.dialog?.page === page) {
        record.dialog = null
        this.push(record, { kind: 'dialog', browserId: record.id, dialog: null })
      }
    } else if (method === 'Page.fileChooserOpened') {
      void this.pickFiles(record, page, params).catch(() => undefined)
    } else if (method === 'Page.frameNavigated') {
      const parsed = FrameNavigated.safeParse(params)
      if (!parsed.success || parsed.data.frame.parentId !== undefined) return
      const frame = parsed.data.frame
      events.frameId = frame.id
      events.loaderId = frame.loaderId
      events.dialog = null
      this.clearSurfaces(record, page)
      this.navigatedTo(record, page, frame.url + (frame.urlFragment ?? ''))
      this.setPageState(record, page, { status: 'loading', documentId: `${page.targetId}:${frame.loaderId}`, error: null })
      const source = this.sources.get(this.sourceId(record, page))
      if (source?.page === page) source.navigatedTo(page.url)
      void this.refreshHistory(record, page)
    } else if (method === 'Page.navigatedWithinDocument') {
      const parsed = WithinDocument.safeParse(params)
      if (!parsed.success || parsed.data.frameId !== events.frameId) return
      this.clearSurfaces(record, page)
      this.navigatedTo(record, page, parsed.data.url)
      void this.refreshHistory(record, page)
    } else if (method === 'Page.lifecycleEvent') {
      const parsed = Lifecycle.safeParse(params)
      if (!parsed.success || parsed.data.frameId !== events.frameId || parsed.data.loaderId !== events.loaderId) return
      if (parsed.data.name === 'load') {
        this.setPageState(record, page, { status: 'ready', error: null })
        void this.refreshHistory(record, page)
      }
    } else if (method === 'Page.frameStartedLoading' || method === 'Page.frameStoppedLoading') {
      const parsed = z.object({ frameId: z.string() }).safeParse(params)
      if (!parsed.success || parsed.data.frameId !== events.frameId) return
      if (method === 'Page.frameStartedLoading') this.setPageState(record, page, { status: 'loading', error: null })
      else if ((this.active(record) === page ? record.state : events.state).status !== 'error')
        this.setPageState(record, page, { status: 'ready' })
    } else if (method === 'Inspector.targetCrashed' || method === 'Inspector.detached') {
      this.removePage(record, page)
      void this.closeTarget(page.targetId)
    }
  }

  private rootEvent(method: string, params: unknown): void {
    if (method === 'Target.targetCreated') {
      const parsed = z.object({ targetInfo: TargetMetadata }).safeParse(params)
      if (!parsed.success) return
      const info = parsed.data.targetInfo
      if (info.type !== 'page' || info.openerId === undefined || this.openingTargets.has(info.targetId) || this.targets.has(info.targetId)) return
      for (const record of this.records.values()) {
        if (!record.stack.some((page) => page.targetId === info.openerId && !page.isClosed())) continue
        this.openingTargets.add(info.targetId)
        void this.createPage(record, info.openerId, info.targetId).catch(() => undefined).finally(() => {
          this.openingTargets.delete(info.targetId)
        })
        break
      }
    } else if (method === 'Target.targetInfoChanged') {
      const parsed = z.object({ targetInfo: TargetInfo }).safeParse(params)
      if (!parsed.success) return
      const info = parsed.data.targetInfo
      const target = this.targets.get(info.targetId)
      if (target === undefined) return
      this.navigatedTo(target.record, target.page, info.url)
      this.setPageState(target.record, target.page, { title: info.title.slice(0, 512) })
    } else if (method === 'Target.targetDestroyed' || method === 'Target.detachedFromTarget') {
      const parsed = z.object({ targetId: z.string().optional(), sessionId: z.string().optional() }).safeParse(params)
      if (!parsed.success) return
      for (const { record, page } of this.targets.values()) {
        if (page.targetId !== parsed.data.targetId && page.sessionId !== parsed.data.sessionId) continue
        this.removePage(record, page)
        break
      }
    }
  }

  private removePage(record: ProjectBrowser, page: ChromePage): void {
    const previous = this.active(record)
    if (page.openerId === null && record.stack.includes(page)) {
      if (previous !== page) record.state = this.pageEvents.get(page)?.state ?? record.state
      const pages = this.clearPages(record)
      this.unavailable(record, false)
      void Promise.all(pages.filter((entry) => entry !== page).map((entry) => this.closeTarget(entry.targetId)))
      return
    }
    const index = record.stack.indexOf(page)
    if (index >= 0) record.stack.splice(index, 1)
    this.clearSurfaces(record, page)
    this.releasePage(record, page)
    if (previous === page) {
      record.navigation += 1
      const opener = record.stack.find((entry) => entry.targetId === page.openerId && !entry.isClosed())
      if (opener !== undefined && this.active(record) !== opener) {
        record.stack.splice(record.stack.indexOf(opener), 1)
        record.stack.push(opener)
      }
      this.activatePage(record, null)
    }
  }

  private navigatedTo(record: ProjectBrowser, page: ChromePage, url: string): void {
    page.url = url
    const scrubbed = browserScrubUrl(url)
    this.setPageState(record, page, { url: scrubbed })
    if (page.openerId === null && scrubbed !== null)
      void this.settings.setLastUrl(record.projectId, scrubbed)
  }

  private clearSurfaces(record: ProjectBrowser, page?: ChromePage): void {
    for (const entry of page === undefined ? record.stack : [page]) {
      const events = this.pageEvents.get(entry)
      if (events !== undefined) events.selectRevision += 1
    }
    if (page === undefined || record.select?.page === page) {
      record.select = null
      this.push(record, { kind: 'select', browserId: record.id, select: null })
    }
    if (page === undefined || record.dialog?.page === page) {
      record.dialog = null
      this.push(record, { kind: 'dialog', browserId: record.id, dialog: null })
    }
  }

  private async selectOpened(record: ProjectBrowser, page: ChromePage, params: unknown): Promise<void> {
    const called = BindingCalled.safeParse(params)
    if (!called.success || called.data.name !== SELECT_BINDING || called.data.payload.length > 4_000_000 || this.active(record) !== page) return
    const context = ContextDescription.safeParse(page.runtimeContexts().get(called.data.executionContextId))
    if (!context.success || context.data.context.name !== CHORUS_WORLD || context.data.context.auxData?.isDefault !== false) return
    let payload: unknown
    try { payload = JSON.parse(called.data.payload) } catch { return }
    const parsed = BrowserSelectPrompt.safeParse(payload)
    if (!parsed.success) return
    const events = this.pageEvents.get(page)
    if (events === undefined) return
    const revision = ++events.selectRevision
    const prompt = parsed.data
    const current = { prompt, contextId: called.data.executionContextId, page }
    const frameId = context.data.context.auxData.frameId
    const mainFrame = this.pageEvents.get(page)?.frameId
    if (frameId === undefined) return
    if (frameId !== mainFrame) {
      const owner = z.object({ backendNodeId: z.number() }).parse(await page.send('DOM.getFrameOwner', { frameId }))
      const box = z.object({ model: z.object({ content: z.array(z.number()).length(8) }) }).parse(
        await page.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId })
      )
      prompt.rect = { ...prompt.rect, x: prompt.rect.x + (box.model.content[0] ?? 0), y: prompt.rect.y + (box.model.content[1] ?? 0) }
    }
    if (events.selectRevision !== revision || this.active(record) !== page || !page.runtimeContexts().has(current.contextId)) return
    record.select = current
    this.push(record, { kind: 'select', browserId: record.id, select: prompt })
  }

  private async chooseSelect(record: ProjectBrowser, token: string, index: number): Promise<void> {
    const current = record.select
    if (current === null || current.prompt.token !== token || this.active(record) !== current.page) return
    const context = ContextDescription.safeParse(current.page.runtimeContexts().get(current.contextId))
    if (!context.success || context.data.context.name !== CHORUS_WORLD || context.data.context.auxData?.isDefault !== false) return
    record.select = null
    this.push(record, { kind: 'select', browserId: record.id, select: null })
    await current.page.send('Runtime.evaluate', {
      contextId: current.contextId, expression: chooseSelectExpression(token, index), returnByValue: true,
    })
  }

  private async answerDialog(record: ProjectBrowser, token: string, accept: boolean, text: string | undefined): Promise<void> {
    const current = record.dialog
    if (current === null || current.prompt.token !== token || this.active(record) !== current.page) return
    record.dialog = null
    this.push(record, { kind: 'dialog', browserId: record.id, dialog: null })
    try {
      await current.page.send('Page.handleJavaScriptDialog', { accept, ...(text === undefined ? {} : { promptText: text }) })
    } catch (error) {
      if (this.active(record) === current.page && this.pageEvents.get(current.page)?.dialog?.token === token) {
        record.dialog = current
        this.push(record, { kind: 'dialog', browserId: record.id, dialog: current.prompt })
      }
      throw error
    }
  }

  private async pickFiles(record: ProjectBrowser, page: ChromePage, params: unknown): Promise<void> {
    const parsed = FileChooserOpened.safeParse(params)
    const owner = record.controller
    const events = this.pageEvents.get(page)
    if (!parsed.success || parsed.data.backendNodeId === undefined || this.active(record) !== page || owner === null || owner.isGone() || events === undefined) return
    const loaderId = events.loaderId
    const result = z.object({ paths: z.array(z.string().max(8192)).max(1_000) }).parse(
      await owner.requestHost('browser.pickFiles', { many: parsed.data.mode === 'selectMultiple' })
    )
    if (result.paths.length === 0 || this.active(record) !== page || record.controller !== owner || owner.isGone() || this.pageEvents.get(page)?.loaderId !== loaderId) return
    await page.send('DOM.setFileInputFiles', { files: result.paths, backendNodeId: parsed.data.backendNodeId })
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
    if (this.targets.get(page.targetId)?.page === page) this.targets.delete(page.targetId)
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
    record.lifetime += 1
    record.navigation += 1
    record.creating = null
    const pages = record.stack.splice(0)
    for (const entry of this.targets.values())
      if (entry.record === record && !pages.includes(entry.page)) pages.push(entry.page)
    this.clearSurfaces(record)
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
      const page = this.active(record)
      if (page !== null) this.mountSource(record, page)
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
