import { EventEmitter } from 'node:events'
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  ContextMenuParams,
  HandlerDetails,
  LoadURLOptions,
  NavigationEntry,
  PopupOptions,
  Session,
  WebContents,
  WindowOpenHandlerResponse,
} from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPageRowWheel, BrowserPush } from '../shared/browser-ipc.js'
import type { BrowserSettingsStore } from './browser-settings.js'
import {
  BROWSER_CLOSED_MAX,
  BROWSER_PAGE_ROW_WHEEL_ENABLE_CHANNEL,
  BROWSER_PAGE_SWIPE_CHANNEL,
  BROWSER_PAGE_SWIPE_SEQUENCE_CHANNEL,
  BROWSER_PAGE_SWIPE_STATE_CHANNEL,
} from '../shared/browser-ipc.js'
import { WEB_TABS_MAX } from '../shared/workspace-layout.js'
import {
  BROWSER_AUTOFILL_DELIVERIES_MAX,
  BROWSER_RECORDS_PER_OWNER,
  BrowserSurfaces,
} from './browser-surface.js'
import type { BrowserVault } from './browser-vault.js'
import type { BrowserMenuAction, BrowserMenuParams } from './browser-context-menu.js'
import { mainT } from './i18n.js'

interface FakeBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface FakeParticipant {
  readonly id: string
  readonly view: {
    setVisible: (visible: boolean) => void
    getVisible: () => boolean
    getBounds: () => FakeBounds
  }
  readonly shown: () => boolean
  readonly conceal?: () => void
}

type Listener = (...args: unknown[]) => void

interface FakeMenuItem {
  readonly type?: string
  readonly label?: string
  readonly enabled?: boolean
  readonly click?: () => void
}

const harness = vi.hoisted(() => ({
  captures: 0,
  loads: 0,
  throttled: true,
  participants: [] as FakeParticipant[],
  origin: 'https://example.com',
  contents: null as { readonly mainFrame: object } | null,
  events: new Map<string, Listener>(),
  ipc: new Map<string, Listener>(),
  fetch: vi.fn<Session['fetch']>(),
  sent: [] as { readonly channel: string; readonly payload: unknown }[],
  log: [] as string[],
  scale: 1,
  scaled: null as ((scale: number) => void) | null,
  windowOpen: null as ((details: HandlerDetails) => WindowOpenHandlerResponse) | null,
  urls: [] as { readonly url: string; readonly options: LoadURLOptions | undefined }[],
  histories: [] as { readonly entries: NavigationEntry[]; readonly index?: number }[],
  entries: [{ url: 'https://example.com/login', title: 'Example' }] as NavigationEntry[],
  zoom: 1,
  detached: false,
  finds: 0,
  closes: 0,
  reloads: 0,
  canGoBack: false,
  canGoForward: false,
  wentBack: 0,
  wentForward: 0,
  focuses: 0,
  devtools: false,
  devtoolsModes: [] as string[],
  devtoolsCloses: 0,
  menus: [] as FakeMenuItem[][],
  popups: [] as PopupOptions[],
  missingParent: null as WebContents | null,
  failMountFor: null as WebContents | null,
  mountLookups: 0,
  copied: [] as string[],
  copiedImages: [] as { readonly x: number; readonly y: number }[],
  inspected: [] as { readonly x: number; readonly y: number }[],
  downloaded: [] as string[],
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (owner: WebContents) => {
      if (owner === harness.missingParent) return null
      if (owner === harness.failMountFor) {
        harness.mountLookups += 1
        if (harness.mountLookups === 2) return null
      }
      return {
        isDestroyed: () => false,
        contentView: { addChildView: () => undefined, removeChildView: () => undefined },
      }
    },
  },
  Menu: {
    buildFromTemplate: (template: FakeMenuItem[]) => {
      harness.menus.push(template)
      return {
        popup: (options: PopupOptions) => {
          harness.popups.push(options)
        },
      }
    },
  },
  clipboard: {
    writeText: (text: string) => {
      harness.copied.push(text)
    },
  },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      fetch: harness.fetch,
    }),
  },
  shell: { openExternal: () => Promise.resolve() },
  WebContentsView: class {
    readonly primary: boolean
    constructor(
      options: {
        readonly webPreferences?: { readonly backgroundThrottling: boolean }
        readonly webContents?: WebContents
      } = {}
    ) {
      this.primary = options.webPreferences !== undefined || options.webContents !== undefined
      if (options.webContents !== undefined) {
        this.webContents = options.webContents as unknown as typeof this.webContents
      }
      if (this.primary) {
        harness.contents = this.webContents
        harness.throttled = options.webPreferences?.backgroundThrottling ?? true
      }
    }
    visible = true
    readonly webContents = {
      isDestroyed: () => false,
      close: () => {
        if (this.primary) harness.closes += 1
      },
      on: (event: string, listener: Listener) => {
        if (this.primary) harness.events.set(event, listener)
      },
      once: (event: string, listener: Listener) => {
        if (this.primary) harness.events.set(event, listener)
      },
      ipc: {
        on: (channel: string, listener: Listener) => {
          harness.ipc.set(channel, listener)
        },
      },
      setWindowOpenHandler: (handler: (details: HandlerDetails) => WindowOpenHandlerResponse) => {
        harness.windowOpen = handler
      },
      loadURL: (url: string, options?: LoadURLOptions) => {
        harness.loads += 1
        harness.urls.push({ url, options })
        return Promise.resolve()
      },
      getZoomFactor: () => harness.zoom,
      setZoomFactor: (zoom: number) => {
        harness.zoom = zoom
      },
      findInPage: () => {
        harness.finds += 1
        return harness.finds
      },
      stopFindInPage: () => undefined,
      focus: () => {
        harness.focuses += 1
      },
      reload: () => {
        harness.reloads += 1
      },
      undo: () => undefined,
      redo: () => undefined,
      cut: () => undefined,
      copy: () => undefined,
      paste: () => undefined,
      selectAll: () => undefined,
      copyImageAt: (x: number, y: number) => {
        harness.copiedImages.push({ x, y })
      },
      inspectElement: (x: number, y: number) => {
        harness.inspected.push({ x, y })
      },
      downloadURL: (url: string) => {
        harness.downloaded.push(url)
        harness.log.push('download')
      },
      isDevToolsOpened: () => harness.devtools,
      devToolsWebContents: null as WebContents | null,
      setDevToolsWebContents: (contents: WebContents) => {
        this.webContents.devToolsWebContents = contents
      },
      openDevTools: (options: { readonly mode: string }) => {
        harness.devtools = true
        harness.devtoolsModes.push(options.mode)
      },
      closeDevTools: () => {
        this.webContents.devToolsWebContents = null
        harness.devtools = false
        harness.devtoolsCloses += 1
      },
      getURL: () => `${harness.origin}/login`,
      navigationHistory: {
        canGoBack: () => harness.canGoBack,
        canGoForward: () => harness.canGoForward,
        goBack: () => {
          harness.wentBack += 1
        },
        goForward: () => {
          harness.wentForward += 1
        },
        getAllEntries: () => harness.entries,
        getActiveIndex: () => 0,
        restore: (history: { readonly entries: NavigationEntry[]; readonly index?: number }) => {
          harness.histories.push(history)
          return Promise.resolve()
        },
      },
      mainFrame: {
        get detached() {
          return harness.detached
        },
        get origin() {
          return harness.origin
        },
        send: (channel: string, payload: unknown) => {
          if (harness.detached) throw new Error('Render frame was disposed')
          harness.sent.push({ channel, payload })
        },
      },
      capturePage: () => {
        harness.captures += 1
        return Promise.resolve({ isEmpty: () => false, toJPEG: () => Buffer.from('still') })
      },
    }
    bounds: FakeBounds = { x: 0, y: 0, width: 0, height: 0 }
    readonly setBounds = (bounds: FakeBounds): void => {
      this.bounds = { ...bounds }
      if (this.primary) harness.log.push('bounds')
    }
    getBounds(): FakeBounds {
      return this.bounds
    }
    setVisible(visible: boolean): void {
      this.visible = visible
      if (this.primary) harness.log.push(`visible:${String(visible)}`)
    }
    getVisible(): boolean {
      return this.visible
    }
    setBackgroundColor(color: string): void {
      harness.log.push(`background:${color}`)
    }
  },
}))

vi.mock('./workbench-surface.js', () => ({
  applyParticipant: (participant: FakeParticipant) => {
    participant.view.setVisible(participant.shown())
  },
  registerOverlayParticipant: (participant: FakeParticipant) => {
    if (!participant.id.endsWith(':devtools')) harness.participants.push(participant)
    participant.view.setVisible(participant.shown())
    return () => undefined
  },
}))

vi.mock('./scale.js', () => ({
  currentScale: () => harness.scale,
  onScaleChange: (listener: (scale: number) => void) => {
    harness.scaled = listener
  },
}))

interface Read {
  readonly status: 'ready'
  readonly settings: { readonly lastUrl: string | null; readonly favorites: readonly never[] }
}

const READ: Read = { status: 'ready', settings: { lastUrl: null, favorites: [] } }

function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let release: () => void = () => undefined
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    wait,
    open: () => {
      release()
    },
  }
}

function fakeOwner(): WebContents {
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  return owner as unknown as WebContents
}

function surfacesAfter(wait: Promise<void>, read: Read = READ): BrowserSurfaces {
  const settings = {
    project: async () => {
      await wait
      return read
    },
    flush: () => Promise.resolve(null),
  } as unknown as BrowserSettingsStore
  const vault = { flush: () => Promise.resolve() } as unknown as BrowserVault
  return new BrowserSurfaces({
    settings,
    vault,
    preloadPath: 'browser.js',
    mainOwner: () => null,
    downloads: { expect: () => undefined },
    deliver: () => undefined,
  })
}

describe('browser attachment', () => {
  it('holds the per-window cap when attaches race past the settings read', async () => {
    const settled = gate()
    const surfaces = surfacesAfter(settled.wait)
    const owner = fakeOwner()
    const attempts = Array.from({ length: BROWSER_RECORDS_PER_OWNER + 1 }, () =>
      surfaces.attach(owner, 'project')
    )
    settled.open()
    const results = await Promise.allSettled(attempts)
    const admitted = results.filter((result) => result.status === 'fulfilled')
    expect(admitted).toHaveLength(BROWSER_RECORDS_PER_OWNER)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('refuses an attach still waiting on settings once shutdown begins', async () => {
    const settled = gate()
    const surfaces = surfacesAfter(settled.wait)
    const pending = surfaces.attach(fakeOwner(), 'project')
    await surfaces.shutdown()
    settled.open()
    await expect(pending).rejects.toThrow('shutting down')
    await expect(surfaces.attach(fakeOwner(), 'project')).rejects.toThrow('shutting down')
  })
})

describe('live browser placement while scrolling', () => {
  it('keeps a partially visible page live without capturing or changing visibility', async () => {
    const page = await openPage()
    const view = harness.participants.at(-1)?.view
    const captures = harness.captures
    const loads = harness.loads
    harness.log.length = 0
    const rect = { ...RECT, x: 40, width: 760 }
    expect(await page.place(false, rect)).toEqual({ revision: 2, still: null })
    expect(view?.getBounds()).toEqual(rect)
    expect(view?.getVisible()).toBe(true)
    expect(harness.log).toEqual(['bounds'])
    expect(harness.captures).toBe(captures)
    expect(harness.loads).toBe(loads)
    expect(harness.throttled).toBe(false)
  })

  it('keeps the same contents and viewport alive when the box leaves the row', async () => {
    const page = await openPage()
    const view = harness.participants.at(-1)?.view
    const contents = harness.contents
    const captures = harness.captures
    const loads = harness.loads
    await page.place(false, { ...RECT, width: 0 })
    const bounds = view?.getBounds()
    expect(bounds).toMatchObject({ width: RECT.width, height: RECT.height })
    expect((bounds?.x ?? 0) + RECT.width).toBeLessThanOrEqual(0)
    expect((bounds?.y ?? 0) + RECT.height).toBeLessThanOrEqual(0)
    expect(view?.getVisible()).toBe(true)
    await page.place(true)
    expect(view?.getBounds()).toEqual(RECT)
    expect(harness.contents).toBe(contents)
    expect(harness.captures).toBe(captures)
    expect(harness.loads).toBe(loads)
  })

  it('hides only an inactive project and reveals the existing page without a capture', async () => {
    const page = await loadedPage()
    const participant = harness.participants.at(-1)
    const contents = harness.contents
    const captures = harness.captures
    const loads = harness.loads
    await page.place(false, RECT, false)
    expect(participant?.shown()).toBe(false)
    expect(participant?.view.getVisible()).toBe(false)
    await page.place(false, { ...RECT, width: 760 })
    expect(participant?.shown()).toBe(true)
    expect(participant?.view.getVisible()).toBe(true)
    expect(harness.contents).toBe(contents)
    expect(harness.captures).toBe(captures)
    expect(harness.loads).toBe(loads)
  })

  it('ignores stale geometry and scales live bounds without a visibility transition', async () => {
    const page = await openPage()
    const view = harness.participants.at(-1)?.view
    const rect = { ...RECT, x: 40, width: 760 }
    await page.place(false, rect)
    harness.log.length = 0
    expect(
      await page.surfaces.geometry(page.owner, {
        browserId: page.browserId,
        revision: 1,
        rect: { ...RECT, width: 0 },
        bodyOrigin: { x: 0, y: 0 },
        active: false,
        fullyVisible: false,
      })
    ).toEqual({ revision: 2, still: null })
    expect(view?.getBounds()).toEqual(rect)
    expect(view?.getVisible()).toBe(true)
    expect(harness.log).toEqual([])
    harness.scale = 1.5
    harness.scaled?.(harness.scale)
    expect(view?.getBounds()).toEqual({ x: 60, y: 0, width: 1140, height: 900 })
    expect(harness.log).toEqual(['bounds'])
  })
})

describe('restoring a saved address', () => {
  it('never loads a saved address that is not a web page', async () => {
    const surfaces = surfacesAfter(Promise.resolve(), {
      status: 'ready',
      settings: { lastUrl: 'file:///etc/passwd', favorites: [] },
    })
    const owner = fakeOwner()
    const before = harness.participants.length
    const { browserId } = await surfaces.attach(owner, 'project')
    expect(surfaces.restore(owner, browserId).failure).toBe('blocked-address')
    const rect = { x: 0, y: 0, width: 800, height: 600 }
    const bodyOrigin = { x: 0, y: 0 }
    const shown = { browserId, revision: 1, rect, bodyOrigin, active: true, fullyVisible: true }
    await surfaces.geometry(owner, shown)
    expect(harness.participants).toHaveLength(before)
  })
})

const TOKEN = 'a'.repeat(32)
const RECT = { x: 0, y: 0, width: 800, height: 600 }
const ACCOUNT = { id: 'only', origin: 'https://example.com', username: 'me@example.com' }
const FILL = 'browser:page:fill'
const SCAN = 'browser:page:scan'

interface Account {
  readonly id: string
  readonly origin: string
  readonly username: string
}

interface PageOptions {
  readonly accounts?: readonly Account[]
  readonly storage?: string
  readonly accountsGate?: Promise<void>
  readonly credentialGate?: Promise<void>
}

interface Page {
  readonly surfaces: BrowserSurfaces
  readonly owner: WebContents
  readonly browserId: string
  readonly calls: { accounts: number; credential: number; reload: number }
  readonly pushes: { readonly owner: WebContents; readonly push: BrowserPush }[]
  readonly committed: () => void
  readonly ready: () => void
  readonly loaded: () => void
  readonly place: (
    fullyVisible: boolean,
    rect?: typeof RECT,
    active?: boolean,
    bodyOrigin?: { readonly x: number; readonly y: number }
  ) => ReturnType<BrowserSurfaces['geometry']>
  readonly signal: (phase: string, frame?: object, documentToken?: string) => void
  readonly wheel: (payload: unknown, frame?: object, sender?: object | null) => void
}

const opened: Page[] = []
const openedWeb: { readonly surfaces: BrowserSurfaces; readonly owner: WebContents }[] = []

afterEach(() => {
  for (const page of opened.splice(0)) page.surfaces.closeOwner(page.owner)
  for (const page of openedWeb.splice(0)) page.surfaces.closeOwner(page.owner)
  harness.scale = 1
  harness.zoom = 1
  harness.detached = false
  harness.canGoBack = false
  harness.canGoForward = false
  harness.wentBack = 0
  harness.wentForward = 0
  harness.devtools = false
  harness.menus.length = 0
  harness.popups.length = 0
  harness.copied.length = 0
  harness.copiedImages.length = 0
  harness.inspected.length = 0
  harness.downloaded.length = 0
  harness.missingParent = null
  harness.failMountFor = null
  harness.mountLookups = 0
  harness.fetch.mockReset()
  vi.useRealTimers()
})

function webSurfaces(
  wait: Promise<void> = Promise.resolve(),
  page: { readonly url: string | null; readonly title: string; readonly icon: string | null } = {
    url: null,
    title: '',
    icon: null,
  },
  main?: WebContents | null
) {
  const setWebTabPage = vi.fn(() => Promise.resolve(null))
  const removeWebTab = vi.fn(() => Promise.resolve(null))
  const settings = {
    project: () => Promise.resolve(READ),
    webTab: async () => {
      await wait
      return { status: 'ready', page }
    },
    setWebTabPage,
    removeWebTab,
    flush: () => Promise.resolve(null),
  } as unknown as BrowserSettingsStore
  const pushes: BrowserPush[] = []
  const delivered: { readonly owner: WebContents; readonly push: BrowserPush }[] = []
  const owner = fakeOwner()
  const mainOwner = main === undefined ? owner : main
  const expectDownload = vi.fn(() => {
    harness.log.push('expect-download')
  })
  const surfaces = new BrowserSurfaces({
    settings,
    vault: { flush: () => Promise.resolve() } as unknown as BrowserVault,
    preloadPath: 'browser.js',
    mainOwner: () => mainOwner,
    downloads: { expect: expectDownload },
    deliver: (owner, push) => {
      pushes.push(push)
      delivered.push({ owner, push })
    },
  })
  openedWeb.push({ surfaces, owner })
  if (mainOwner !== null && mainOwner !== owner) openedWeb.push({ surfaces, owner: mainOwner })
  return { surfaces, owner, pushes, delivered, setWebTabPage, removeWebTab, expectDownload }
}

function windowDetails(
  disposition: HandlerDetails['disposition'] = 'foreground-tab'
): HandlerDetails {
  return {
    url: 'https://example.com/next',
    frameName: '',
    features: '',
    disposition,
    referrer: { url: 'https://example.com/login', policy: 'strict-origin-when-cross-origin' },
  }
}

function opening(details: HandlerDetails): WindowOpenHandlerResponse {
  const handler = harness.windowOpen
  if (handler === null) throw new Error('No window open handler')
  return handler(details)
}

describe('global web tab records', () => {
  it('adopts an existing record on reattach and leaves its page alive on detach', async () => {
    const { surfaces, owner } = webSurfaces()
    const attached = await surfaces.attachWebTab(owner, 'tab-1')
    surfaces.navigate(owner, attached.browserId, 'https://example.com')
    const contents = harness.contents
    const before = harness.loads
    const closes = harness.closes
    surfaces.detach(owner, attached.browserId)
    expect(await surfaces.attachWebTab(owner, 'tab-1')).toMatchObject({
      browserId: attached.browserId,
    })
    expect(harness.contents).toBe(contents)
    expect(harness.loads).toBe(before)
    expect(harness.closes).toBe(closes)
    expect(harness.throttled).toBe(true)
  })

  it('deduplicates attaches racing a settings read', async () => {
    const settled = gate()
    const { surfaces, owner } = webSurfaces(settled.wait)
    const first = surfaces.attachWebTab(owner, 'same')
    const second = surfaces.attachWebTab(owner, 'same')
    settled.open()
    expect((await first).browserId).toBe((await second).browserId)
  })

  it('drops late attach replies after a renderer reload closes its owner', async () => {
    const settled = gate()
    const { surfaces, owner } = webSurfaces(settled.wait)
    const pending = surfaces.attachWebTab(owner, 'late')
    surfaces.closeOwner(owner)
    settled.open()
    await expect(pending).rejects.toThrow('window changed')
    expect(surfaces.shownWebTab(owner)).toBeNull()
  })

  it('keeps saved pages lazy until the selected tab is shown', async () => {
    const { surfaces, owner } = webSurfaces(Promise.resolve(), {
      url: 'https://example.com/saved',
      title: 'Saved title',
      icon: null,
    })
    const loads = harness.loads
    const first = await surfaces.attachWebTab(owner, 'first')
    const second = await surfaces.attachWebTab(owner, 'second')
    expect(first.state).toMatchObject({ live: false, title: 'Saved title' })
    expect(second.state.live).toBe(false)
    expect(harness.loads).toBe(loads)
    await surfaces.geometry(owner, {
      browserId: second.browserId,
      revision: 1,
      rect: RECT,
      bodyOrigin: { x: 0, y: 0 },
      active: true,
      fullyVisible: true,
    })
    expect(harness.loads).toBe(loads + 1)
    expect((await surfaces.attachWebTab(owner, 'first')).state.live).toBe(false)
  })

  it('releases a closed page and caps its reopen stack at twenty', async () => {
    const { surfaces, owner, removeWebTab } = webSurfaces()
    const loaded = await surfaces.attachWebTab(owner, 'loaded')
    surfaces.navigate(owner, loaded.browserId, 'https://example.com')
    const closes = harness.closes
    surfaces.close(owner, loaded.browserId, 0)
    expect(harness.closes).toBe(closes + 1)
    expect(removeWebTab).toHaveBeenCalledWith('loaded')
    for (let index = 0; index < BROWSER_CLOSED_MAX + 1; index += 1) {
      const tab = await surfaces.attachWebTab(owner, `tab-${String(index)}`)
      surfaces.close(owner, tab.browserId, index)
    }
    const positions = Array.from(
      { length: BROWSER_CLOSED_MAX },
      () => surfaces.reopen(owner).reopened?.index
    )
    expect(positions).toEqual(
      Array.from({ length: BROWSER_CLOSED_MAX }, (_, index) => BROWSER_CLOSED_MAX - index)
    )
    expect(surfaces.reopen(owner)).toEqual({ reopened: null })
  })

  it('restores history once onto fresh contents when a closed tab is shown', async () => {
    const { surfaces, owner } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'history')
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    surfaces.close(owner, tab.browserId, 4)
    const restored = surfaces.reopen(owner).reopened
    expect(restored?.index).toBe(4)
    const attached = await surfaces.attachWebTab(owner, restored?.webTabId ?? '')
    const restores = harness.histories.length
    const loads = harness.loads
    surfaces.restore(owner, attached.browserId)
    surfaces.restore(owner, attached.browserId)
    expect(harness.histories.slice(restores)).toEqual([{ entries: harness.entries, index: 0 }])
    expect(harness.loads).toBe(loads)
  })

  it('uses an explicitly entered address instead of the saved reopen history', async () => {
    const { surfaces, owner } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'history')
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    surfaces.close(owner, tab.browserId, 0)
    const reopened = surfaces.reopen(owner).reopened
    const attached = await surfaces.attachWebTab(owner, reopened?.webTabId ?? '')
    const restores = harness.histories.length
    surfaces.navigate(owner, attached.browserId, 'https://another.example')
    expect(harness.histories).toHaveLength(restores)
    expect(harness.urls.at(-1)?.url).toBe('https://another.example/')
  })

  it('keeps new-window requests on the popup path', async () => {
    const { surfaces, owner, pushes } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    const response = opening(windowDetails('new-window'))
    expect(response.action).toBe('allow')
    expect(response.createWindow).toBeUndefined()
    expect(response.overrideBrowserWindowOptions?.webPreferences?.preload).toBeUndefined()
    expect(pushes.some((push) => push.kind === 'tab-open')).toBe(false)
  })

  it('attributes web popups to their record and keeps popup descendants as popups', async () => {
    const { surfaces, owner } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    const popupContents = { ...harness.contents } as unknown as WebContents
    const popup = {
      webContents: popupContents,
      isDestroyed: () => false,
      once: () => undefined,
      destroy: () => undefined,
    } as unknown as BrowserWindow
    harness.events.get('did-create-window')?.(popup)
    expect(surfaces.ownerOf(popupContents)).toEqual({ owner, browserId: tab.browserId })
    expect(opening(windowDetails()).createWindow).toBeUndefined()
    const project = await openPage()
    expect(surfaces.ownerOf(harness.contents as unknown as WebContents)).toBeNull()
    expect(project.surfaces.ownerOf(harness.contents as unknown as WebContents)).toBeNull()
  })

  it('returns the exact native guest without reloading it', async () => {
    const { surfaces, owner, pushes } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    const guest = { ...harness.contents } as unknown as WebContents
    const response = opening(windowDetails('background-tab'))
    const loads = harness.loads
    expect(
      response.createWindow?.({ webContents: guest } as unknown as BrowserWindowConstructorOptions)
    ).toBe(guest)
    expect(harness.loads).toBe(loads)
    const opened = pushes.findLast((push) => push.kind === 'tab-open')
    expect(opened).toMatchObject({ kind: 'tab-open', openerWebTabId: 'parent', background: true })
    if (opened?.kind === 'tab-open') {
      expect((await surfaces.attachWebTab(owner, opened.webTabId)).browserId).toBe(opened.browserId)
    }
    expect(response.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
      sandbox: true,
      preload: 'browser.js',
      backgroundThrottling: true,
    })
  })

  it('loads a fresh view with referrer and POST when no guest is supplied', async () => {
    const { surfaces, owner } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    const oldContents = harness.contents
    const details = {
      ...windowDetails(),
      postBody: {
        contentType: 'multipart/form-data',
        boundary: 'part',
        data: [{ type: 'rawData' as const, bytes: Buffer.from('body') }],
      },
    }
    const response = opening(details)
    const created = response.createWindow?.({})
    expect(created).not.toBe(oldContents)
    expect(harness.urls.at(-1)).toEqual({
      url: details.url,
      options: {
        httpReferrer: details.referrer,
        postData: details.postBody.data,
        extraHeaders: 'Content-Type: multipart/form-data; boundary=part',
      },
    })
  })

  it('closes stale guests without consuming pending opens after a renderer reload', async () => {
    const { surfaces, owner } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    const guest = { ...harness.contents } as unknown as WebContents
    const response = opening(windowDetails())
    surfaces.closeOwner(owner)
    const parent = await surfaces.attachWebTab(owner, 'new-parent')
    surfaces.navigate(owner, parent.browserId, 'https://example.com')
    for (let index = 1; index < WEB_TABS_MAX - 1; index += 1) {
      await surfaces.attachWebTab(owner, `new-tab-${String(index)}`)
    }
    const current = opening(windowDetails())
    expect(current.action).toBe('allow')
    const closes = harness.closes
    let refused: WebContents | undefined
    expect(() => {
      refused = response.createWindow?.({
        webContents: guest,
      } as unknown as BrowserWindowConstructorOptions)
    }).not.toThrow()
    expect(refused).toBe(guest)
    expect(harness.closes).toBe(closes + 1)
    const mounted = [...harness.log]
    const participants = harness.participants.length
    const loads = harness.loads
    let refusedFresh: WebContents | undefined
    expect(() => {
      refusedFresh = response.createWindow?.({})
    }).not.toThrow()
    expect(refusedFresh).not.toBe(guest)
    expect(refusedFresh).toBe(harness.contents)
    expect(harness.closes).toBe(closes + 2)
    expect(harness.log).toEqual(mounted)
    expect(harness.participants).toHaveLength(participants)
    expect(harness.loads).toBe(loads)
    expect(opening(windowDetails()).action).toBe('deny')
    await expect(surfaces.attachWebTab(owner, 'overflow')).rejects.toThrow('Too many web tabs')
    current.createWindow?.({})
    expect(opening(windowDetails()).action).toBe('deny')
  })

  it('holds the web cap across pending opens, attaching and reopening', async () => {
    const { surfaces, owner } = webSurfaces()
    const closed = await surfaces.attachWebTab(owner, 'closed')
    surfaces.close(owner, closed.browserId, 0)
    const parent = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, parent.browserId, 'https://example.com')
    for (let index = 1; index < WEB_TABS_MAX - 1; index += 1) {
      await surfaces.attachWebTab(owner, `tab-${String(index)}`)
    }
    const response = opening(windowDetails())
    expect(response.action).toBe('allow')
    expect(opening(windowDetails()).action).toBe('deny')
    await expect(surfaces.attachWebTab(owner, 'overflow')).rejects.toThrow('Too many web tabs')
    expect(() => surfaces.reopen(owner)).toThrow('Too many web tabs')
    response.createWindow?.({})
    expect(opening(windowDetails()).action).toBe('deny')
    await expect(surfaces.attachWebTab(owner, 'overflow')).rejects.toThrow('Too many web tabs')
  })

  it('ignores stale find results and clears the request when find stops', async () => {
    const { surfaces, owner, pushes } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'find')
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    surfaces.find(owner, tab.browserId, 'first', true, true)
    const old = harness.finds
    surfaces.find(owner, tab.browserId, 'second', false, false)
    const found = harness.events.get('found-in-page')
    found?.({}, { requestId: old, finalUpdate: true, matches: 9, activeMatchOrdinal: 1 })
    found?.({}, { requestId: harness.finds, finalUpdate: false, matches: 9, activeMatchOrdinal: 1 })
    found?.({}, { requestId: harness.finds, finalUpdate: true, matches: 3, activeMatchOrdinal: 2 })
    expect(pushes.filter((push) => push.kind === 'found')).toEqual([
      { kind: 'found', browserId: tab.browserId, matches: 3, active: 2 },
    ])
    surfaces.act(owner, tab.browserId, 'find-stop')
    found?.({}, { requestId: harness.finds, finalUpdate: true, matches: 3, activeMatchOrdinal: 2 })
    expect(pushes.filter((push) => push.kind === 'found')).toHaveLength(1)
  })

  it('maps native key inputs and prevents only mapped commands', async () => {
    const { surfaces, owner, pushes } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'keys')
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    const preventDefault = vi.fn()
    const key = {
      type: 'keyDown',
      key: 't',
      meta: process.platform === 'darwin',
      control: process.platform !== 'darwin',
      shift: false,
      alt: false,
      isAutoRepeat: false,
      isComposing: false,
    }
    harness.events.get('before-input-event')?.({ preventDefault }, key)
    harness.events.get('before-input-event')?.({ preventDefault }, { ...key, isAutoRepeat: true })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(pushes.filter((push) => push.kind === 'command')).toEqual([
      { kind: 'command', browserId: tab.browserId, command: 'new-tab' },
    ])
  })

  it('routes an empty selected tab and reads page zoom and focus', async () => {
    const { surfaces, owner } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'empty')
    await surfaces.geometry(owner, {
      browserId: tab.browserId,
      revision: 1,
      rect: RECT,
      bodyOrigin: { x: 0, y: 0 },
      active: true,
      fullyVisible: true,
    })
    expect(surfaces.shownWebTab(owner)?.id).toBe(tab.browserId)
    expect(surfaces.routeReload(owner)).toBe(true)
    expect(surfaces.routeZoom(owner, 1)).toBe(true)
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    harness.zoom = 1.12
    expect(surfaces.act(owner, tab.browserId, 'zoom-in').state.zoom).toBe(1.25)
    harness.events.get('zoom-changed')?.({}, 'out')
    expect(surfaces.restore(owner, tab.browserId).state.zoom).toBe(1.1)
    const focused = harness.focuses
    surfaces.act(owner, tab.browserId, 'focus')
    expect(harness.focuses).toBe(focused + 1)
    const openedDevtools = harness.devtoolsModes.length
    const closedDevtools = harness.devtoolsCloses
    expect(surfaces.routeDevtools(owner)).toBe(true)
    expect(harness.devtoolsModes.slice(openedDevtools)).toEqual(['detach'])
    expect(surfaces.routeDevtools(owner)).toBe(true)
    expect(harness.devtoolsCloses).toBe(closedDevtools + 1)
  })

  it('pushes and persists a favicon from a constructed response with an empty URL', async () => {
    const bytes = new Uint8Array([0, 0, 1, 0, 1, 0])
    const response = new Response(bytes, {
      headers: { 'content-type': 'image/x-icon' },
      status: 200,
    })
    expect(response.url).toBe('')
    harness.fetch.mockResolvedValueOnce(response)
    const { surfaces, owner, pushes, setWebTabPage } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'favicon')
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    harness.events.get('did-navigate')?.({}, 'https://example.com/')
    harness.events.get('page-favicon-updated')?.({}, ['https://example.com/favicon.ico'])
    await settle()
    const icon = `data:image/x-icon;base64,${Buffer.from(bytes).toString('base64')}`
    expect(pushes.findLast((push) => push.kind === 'state')).toMatchObject({
      kind: 'state',
      browserId: tab.browserId,
      state: { icon },
    })
    expect(setWebTabPage).toHaveBeenLastCalledWith('favicon', {
      url: 'https://example.com/',
      title: '',
      icon,
    })
  })

  it('persists commit and title and enables row wheel only for project pages', async () => {
    const { surfaces, owner, setWebTabPage } = webSurfaces()
    const tab = await surfaces.attachWebTab(owner, 'saved')
    surfaces.navigate(owner, tab.browserId, 'https://example.com')
    harness.events.get('did-navigate')?.({}, 'https://example.com/next')
    harness.events.get('page-title-updated')?.({}, 'Page title')
    expect(setWebTabPage).toHaveBeenLastCalledWith('saved', {
      url: 'https://example.com/next',
      title: 'Page title',
      icon: null,
    })
    const contents = harness.contents
    harness.sent.length = 0
    harness.ipc.get('browser:page:ready')?.(
      { sender: contents, senderFrame: contents?.mainFrame },
      { documentToken: TOKEN }
    )
    expect(sentOn(BROWSER_PAGE_ROW_WHEEL_ENABLE_CHANNEL)).toEqual([])
    const project = await openPage()
    project.ready()
    expect(sentOn(BROWSER_PAGE_ROW_WHEEL_ENABLE_CHANNEL)).toHaveLength(1)
  })
})

const MENU_PARAMS: BrowserMenuParams = {
  linkURL: 'https://example.com/link',
  srcURL: '',
  mediaType: 'none',
  hasImageContents: false,
  isEditable: false,
  selectionText: '',
  formControlType: 'none',
  editFlags: {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: true,
    canPaste: false,
    canDelete: false,
    canSelectAll: false,
    canEditRichly: false,
  },
}

type MenuEvent = BrowserMenuParams & {
  readonly x: number
  readonly y: number
  readonly frame: object | null
  readonly menuSourceType: ContextMenuParams['menuSourceType']
}

function showMenu(
  params: Partial<MenuEvent> = {},
  listener = harness.events.get('context-menu')
): FakeMenuItem[] {
  if (listener === undefined) throw new Error('No context menu listener')
  listener({}, { ...MENU_PARAMS, x: 12, y: 24, frame: null, menuSourceType: 'mouse', ...params })
  return harness.menus.at(-1) ?? []
}

function menuItem(items: FakeMenuItem[], id: BrowserMenuAction, text = ''): FakeMenuItem {
  const label = mainT(`browserMenu.${id}`, { text })
  const nativeLabel = process.platform === 'darwin' ? label : label.replace(/&/g, '&&')
  const item = items.find((item) => item.label === nativeLabel)
  if (item === undefined) throw new Error(`No menu item for ${id}`)
  return item
}

describe('native browser context menus', () => {
  it('opens a background tab after its web opener without changing page visibility', async () => {
    const { surfaces, owner, pushes, setWebTabPage } = webSurfaces()
    const parent = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, parent.browserId, 'https://example.com')
    const source = harness.contents
    surfaces.webReady(owner)
    const loads = harness.loads
    menuItem(showMenu(), 'link-new-tab').click?.()
    const opened = pushes.findLast((push) => push.kind === 'tab-open')
    expect(opened).toMatchObject({ openerWebTabId: 'parent', background: true })
    expect(harness.loads).toBe(loads + 1)
    expect(harness.urls.at(-1)?.url).toBe(MENU_PARAMS.linkURL)
    expect(harness.contents).not.toBe(source)
    expect(harness.participants.at(-1)?.view.getVisible()).toBe(false)
    expect(harness.throttled).toBe(true)
    if (opened?.kind !== 'tab-open') throw new Error('No tab-open push')
    expect((await surfaces.attachWebTab(owner, opened.webTabId)).browserId).toBe(opened.browserId)
    expect(setWebTabPage).toHaveBeenCalledWith(opened.webTabId, {
      url: MENU_PARAMS.linkURL,
      title: '',
      icon: null,
    })
  })

  it('opens from a detached project panel under the main owner with a null opener', async () => {
    const main = fakeOwner()
    const { surfaces, owner, delivered } = webSurfaces(undefined, undefined, main)
    const project = await surfaces.attach(owner, 'project')
    surfaces.navigate(owner, project.browserId, 'https://example.com')
    surfaces.webReady(main)
    menuItem(showMenu(), 'link-new-tab').click?.()
    const opened = delivered.findLast((entry) => entry.push.kind === 'tab-open')
    expect(opened).toMatchObject({
      owner: main,
      push: { openerWebTabId: null, background: true },
    })
    const push = opened?.push
    if (push?.kind !== 'tab-open') throw new Error('No tab-open push')
    expect((await surfaces.attachWebTab(main, push.webTabId)).browserId).toBe(push.browserId)
    expect(() => surfaces.restore(owner, push.browserId)).toThrow('belongs to this window')
    surfaces.closeOwner(owner)
    expect(surfaces.restore(main, push.browserId).failure).toBeNull()
  })

  it('creates nothing before renderer readiness or when the main window is absent', async () => {
    const { surfaces, owner, pushes } = webSurfaces()
    const parent = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, parent.browserId, 'https://example.com')
    const listener = harness.events.get('context-menu')
    const loads = harness.loads
    const disabled = menuItem(showMenu({}, listener), 'link-new-tab')
    expect(disabled.enabled).toBe(false)
    disabled.click?.()
    expect(harness.loads).toBe(loads)
    expect(pushes.some((push) => push.kind === 'tab-open')).toBe(false)
    surfaces.webReady(owner)
    expect(menuItem(showMenu({}, listener), 'link-new-tab').enabled).toBe(true)
    const absent = webSurfaces(undefined, undefined, null)
    const project = await absent.surfaces.attach(absent.owner, 'project')
    absent.surfaces.navigate(absent.owner, project.browserId, 'https://example.com')
    const noMain = menuItem(showMenu(), 'link-new-tab')
    const absentLoads = harness.loads
    noMain.click?.()
    expect(noMain.enabled).toBe(false)
    expect(harness.loads).toBe(absentLoads)
  })

  it('watches readiness even before the main owner has a browser record', async () => {
    const main = fakeOwner()
    const { surfaces, owner, pushes } = webSurfaces(undefined, undefined, main)
    const project = await surfaces.attach(owner, 'project')
    surfaces.navigate(owner, project.browserId, 'https://example.com')
    surfaces.webReady(main)
    main.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    const item = menuItem(showMenu(), 'link-new-tab')
    expect(item.enabled).toBe(false)
    item.click?.()
    expect(pushes.some((push) => push.kind === 'tab-open')).toBe(false)
  })

  it('rechecks the cap when a menu was opened before the last slot was filled', async () => {
    const { surfaces, owner, pushes } = webSurfaces()
    const parent = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, parent.browserId, 'https://example.com')
    surfaces.webReady(owner)
    const item = menuItem(showMenu(), 'link-new-tab')
    expect(item.enabled).toBe(true)
    for (let index = 1; index < WEB_TABS_MAX; index += 1) {
      await surfaces.attachWebTab(owner, `filled-${String(index)}`)
    }
    const loads = harness.loads
    item.click?.()
    expect(harness.loads).toBe(loads)
    expect(pushes.some((push) => push.kind === 'tab-open')).toBe(false)
    expect(menuItem(showMenu(), 'link-new-tab').enabled).toBe(false)
  })

  it('releases cross-window tabs and clears readiness on a main owner reload', async () => {
    const main = fakeOwner()
    const { surfaces, owner, pushes } = webSurfaces(undefined, undefined, main)
    const project = await surfaces.attach(owner, 'project')
    surfaces.navigate(owner, project.browserId, 'https://example.com')
    const listener = harness.events.get('context-menu')
    surfaces.webReady(main)
    menuItem(showMenu({}, listener), 'link-new-tab').click?.()
    const opened = pushes.findLast((push) => push.kind === 'tab-open')
    if (opened?.kind !== 'tab-open') throw new Error('No tab-open push')
    main.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(() => surfaces.restore(main, opened.browserId)).toThrow('belongs to this window')
    expect(menuItem(showMenu({}, listener), 'link-new-tab').enabled).toBe(false)
  })

  it('closes a view and releases its record when mounting fails', async () => {
    const main = fakeOwner()
    const { surfaces, owner, pushes } = webSurfaces(undefined, undefined, main)
    const project = await surfaces.attach(owner, 'project')
    surfaces.navigate(owner, project.browserId, 'https://example.com')
    surfaces.webReady(main)
    const item = menuItem(showMenu(), 'link-new-tab')
    const loads = harness.loads
    const closes = harness.closes
    harness.failMountFor = main
    expect(() => item.click?.()).not.toThrow()
    expect(harness.closes).toBe(closes + 1)
    expect(harness.loads).toBe(loads)
    expect(pushes.some((push) => push.kind === 'tab-open')).toBe(false)
    harness.failMountFor = null
    for (let index = 0; index < WEB_TABS_MAX; index += 1) {
      await surfaces.attachWebTab(main, `admitted-${String(index)}`)
    }
    await expect(surfaces.attachWebTab(main, 'overflow')).rejects.toThrow('Too many web tabs')
  })

  it('ignores every saved menu callback once the source record closes', async () => {
    const { surfaces, owner, pushes } = webSurfaces()
    const parent = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, parent.browserId, 'https://example.com')
    surfaces.webReady(owner)
    const items = showMenu()
    surfaces.close(owner, parent.browserId, 0)
    const loads = harness.loads
    const reloads = harness.reloads
    for (const item of items) item.click?.()
    expect(harness.loads).toBe(loads)
    expect(harness.reloads).toBe(reloads)
    expect(harness.copied).toEqual([])
    expect(harness.downloaded).toEqual([])
    expect(harness.inspected).toEqual([])
    expect(pushes.some((push) => push.kind === 'tab-open')).toBe(false)
  })

  it('does not show a menu when the parent window is gone', async () => {
    const { surfaces, owner } = webSurfaces()
    const parent = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, parent.browserId, 'https://example.com')
    harness.missingParent = owner
    expect(showMenu()).toEqual([])
    expect(harness.popups).toEqual([])
  })

  it('anchors keyboard menus while copy and inspect retain page-relative coordinates', async () => {
    const { surfaces, owner } = webSurfaces()
    const parent = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, parent.browserId, 'https://example.com')
    await surfaces.geometry(owner, {
      browserId: parent.browserId,
      revision: 1,
      rect: { ...RECT, x: 40, y: 70 },
      bodyOrigin: { x: 40, y: 70 },
      active: true,
      fullyVisible: true,
    })
    const frame = {}
    const items = showMenu({
      mediaType: 'image',
      srcURL: 'https://example.com/image.png',
      hasImageContents: true,
      menuSourceType: 'keyboard',
      frame,
      x: 7,
      y: 13,
    })
    expect(harness.popups.at(-1)).toMatchObject({ sourceType: 'keyboard', frame, x: 47, y: 83 })
    menuItem(items, 'image-copy').click?.()
    menuItem(items, 'inspect').click?.()
    expect(harness.copiedImages).toEqual([{ x: 7, y: 13 }])
    expect(harness.inspected).toEqual([{ x: 7, y: 13 }])
    expect(harness.devtoolsModes.at(-1)).toBe('detach')
    showMenu()
    expect(harness.popups.at(-1)).toMatchObject({ sourceType: 'mouse' })
    expect(harness.popups.at(-1)).not.toHaveProperty('x')
    expect(harness.popups.at(-1)).not.toHaveProperty('y')
    expect(harness.popups.at(-1)).not.toHaveProperty('frame')
  })

  it('searches a selected address in a foreground tab', async () => {
    const { surfaces, owner, pushes } = webSurfaces()
    const parent = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, parent.browserId, 'https://example.com')
    surfaces.webReady(owner)
    menuItem(
      showMenu({ selectionText: 'example.com' }),
      'selection-search',
      'example.com'
    ).click?.()
    expect(harness.urls.at(-1)?.url).toBe('https://www.google.com/search?q=example.com')
    expect(pushes.findLast((push) => push.kind === 'tab-open')).toMatchObject({
      openerWebTabId: 'parent',
      background: false,
    })
  })

  it('caps the displayed selection without truncating the search to the label', async () => {
    const { surfaces, owner } = webSurfaces()
    const parent = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, parent.browserId, 'https://example.com')
    surfaces.webReady(owner)
    const text = 'selected words '.repeat(8).trim()
    const item = menuItem(showMenu({ selectionText: text }), 'selection-search', text.slice(0, 40))
    item.click?.()
    expect(harness.urls.at(-1)?.url).toBe(
      `https://www.google.com/search?q=${encodeURIComponent(text)}`
    )
  })

  it('keeps selected ampersands literal in native labels and in the searched query', async () => {
    const { surfaces, owner } = webSurfaces()
    const parent = await surfaces.attachWebTab(owner, 'parent')
    surfaces.navigate(owner, parent.browserId, 'https://example.com')
    surfaces.webReady(owner)
    const text = 'cats & dogs'
    const item = menuItem(showMenu({ selectionText: text }), 'selection-search', text)
    expect(item.label).toBe(
      process.platform === 'darwin'
        ? 'Search Google for “cats & dogs”'
        : 'Search Google for “cats && dogs”'
    )
    item.click?.()
    expect(harness.urls.at(-1)?.url).toBe('https://www.google.com/search?q=cats%20%26%20dogs')
  })

  it('marks explicit saves before downloading and copies captured addresses', async () => {
    const { surfaces, owner, expectDownload } = webSurfaces()
    const project = await surfaces.attach(owner, 'project')
    surfaces.navigate(owner, project.browserId, 'https://example.com')
    const contents = harness.contents
    const srcURL = 'https://example.com/image.png'
    const items = showMenu({ mediaType: 'image', srcURL, hasImageContents: true })
    harness.log.length = 0
    menuItem(items, 'link-save').click?.()
    menuItem(items, 'image-save').click?.()
    expect(expectDownload).toHaveBeenCalledTimes(2)
    expect(expectDownload).toHaveBeenCalledWith(contents)
    expect(harness.downloaded).toEqual([MENU_PARAMS.linkURL, srcURL])
    expect(harness.log).toEqual(['expect-download', 'download', 'expect-download', 'download'])
    menuItem(items, 'link-copy').click?.()
    menuItem(items, 'image-copy-address').click?.()
    expect(harness.copied).toEqual([MENU_PARAMS.linkURL, srcURL])
  })
})

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function sentOn(channel: string): unknown[] {
  return harness.sent.filter((entry) => entry.channel === channel).map((entry) => entry.payload)
}

async function openPage(options: PageOptions = {}): Promise<Page> {
  harness.sent.length = 0
  const pushes: { readonly owner: WebContents; readonly push: BrowserPush }[] = []
  const calls = { accounts: 0, credential: 0, reload: 0 }
  const vault = {
    flush: () => Promise.resolve(),
    reload: () => {
      calls.reload += 1
      return Promise.resolve()
    },
    accounts: async (origin: string) => {
      calls.accounts += 1
      await (options.accountsGate ?? Promise.resolve())
      const accounts = (options.accounts ?? []).filter((account) => account.origin === origin)
      return { storage: options.storage ?? 'ready', accounts, neverSave: false }
    },
    credential: async (_origin: string, id: string) => {
      calls.credential += 1
      await (options.credentialGate ?? Promise.resolve())
      return id === 'only' ? { username: 'me@example.com', password: 'pw' } : null
    },
  } as unknown as BrowserVault
  const settings = {
    project: () => Promise.resolve(READ),
    flush: () => Promise.resolve(null),
    setLastUrl: () => Promise.resolve(null),
  } as unknown as BrowserSettingsStore
  const surfaces = new BrowserSurfaces({
    settings,
    vault,
    preloadPath: 'browser.js',
    mainOwner: () => null,
    downloads: { expect: () => undefined },
    deliver: (owner, push) => {
      pushes.push({ owner, push })
    },
  })
  const owner = fakeOwner()
  const { browserId } = await surfaces.attach(owner, 'project')
  surfaces.navigate(owner, browserId, `${harness.origin}/login`)
  let revision = 0
  const place = (
    fullyVisible: boolean,
    rect = RECT,
    active = true,
    bodyOrigin = { x: rect.x, y: rect.y }
  ): ReturnType<BrowserSurfaces['geometry']> => {
    revision += 1
    return surfaces.geometry(owner, { browserId, revision, rect, bodyOrigin, active, fullyVisible })
  }
  await place(true)
  const contents = harness.contents
  const mainFrame = contents?.mainFrame ?? {}
  const from = (frame: object) => ({ sender: contents, senderFrame: frame })
  const page: Page = {
    surfaces,
    owner,
    browserId,
    calls,
    pushes,
    place,
    committed: () => {
      harness.events.get('did-navigate')?.({}, `${harness.origin}/login`)
    },
    ready: () => {
      harness.ipc.get('browser:page:ready')?.(from(mainFrame), { documentToken: TOKEN })
    },
    loaded: () => {
      harness.events.get('did-finish-load')?.({})
    },
    signal: (phase, frame = mainFrame, documentToken = TOKEN) => {
      harness.ipc.get('browser:page:form')?.(from(frame), { documentToken, phase })
    },
    wheel: (payload, frame = mainFrame, sender = contents) => {
      harness.ipc.get('browser:page:row-wheel')?.({ sender, senderFrame: frame }, payload)
    },
  }
  opened.push(page)
  return page
}

async function loadedPage(options: PageOptions = {}): Promise<Page> {
  const page = await openPage(options)
  page.committed()
  page.ready()
  harness.sent.length = 0
  return page
}

describe('browser navigation while partially visible', () => {
  it('keeps the document and native view live across same-document navigation', async () => {
    const page = await loadedPage()
    const participant = harness.participants.at(-1)
    const documentId = page.surfaces.restore(page.owner, page.browserId).state.documentId
    const captures = harness.captures
    const loads = harness.loads
    await page.place(false, { ...RECT, width: 760 })
    harness.events.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: true })
    harness.events.get('did-navigate-in-page')?.({}, `${harness.origin}/login#next`, true)
    await page.place(false, { ...RECT, width: 720 })
    expect(participant?.shown()).toBe(true)
    expect(participant?.view.getVisible()).toBe(true)
    expect(page.surfaces.restore(page.owner, page.browserId).state.documentId).toBe(documentId)
    expect(harness.captures).toBe(captures)
    expect(harness.loads).toBe(loads)
  })
})

describe('automatic filling', () => {
  it('reads the vault once for simultaneous signals of one phase', async () => {
    const page = await loadedPage({ accounts: [ACCOUNT] })
    page.signal('password')
    page.signal('password')
    await settle()
    const fills = sentOn(FILL)
    expect(fills).toHaveLength(1)
    expect(fills[0]).toMatchObject({
      mode: 'automatic',
      origin: 'https://example.com',
      documentToken: TOKEN,
      username: 'me@example.com',
    })
    expect(page.calls.accounts).toBe(1)
  })

  it('fills again on later signals up to the cap, then reads nothing', async () => {
    const page = await loadedPage({ accounts: [ACCOUNT] })
    for (let round = 0; round < BROWSER_AUTOFILL_DELIVERIES_MAX + 2; round += 1) {
      page.signal('password')
      await settle()
    }
    expect(sentOn(FILL)).toHaveLength(BROWSER_AUTOFILL_DELIVERIES_MAX)
    expect(page.calls.accounts).toBe(BROWSER_AUTOFILL_DELIVERIES_MAX)
    expect(page.calls.credential).toBe(BROWSER_AUTOFILL_DELIVERIES_MAX)
  })

  it('caps the username and password phases independently', async () => {
    const page = await loadedPage({ accounts: [ACCOUNT] })
    for (let round = 0; round < BROWSER_AUTOFILL_DELIVERIES_MAX; round += 1) {
      page.signal('identifier')
      await settle()
    }
    page.signal('identifier')
    page.signal('password')
    await settle()
    expect(sentOn(FILL)).toHaveLength(BROWSER_AUTOFILL_DELIVERIES_MAX + 1)
    expect(page.calls.accounts).toBe(BROWSER_AUTOFILL_DELIVERIES_MAX + 1)
  })

  it('keeps several, none or locked storage settled across signals', async () => {
    const second = { ...ACCOUNT, id: 'second', username: 'other@example.com' }
    for (const options of [
      { accounts: [ACCOUNT, second], storage: 'ready' },
      { accounts: [], storage: 'ready' },
      { accounts: [ACCOUNT], storage: 'locked' },
    ]) {
      const page = await loadedPage(options)
      page.signal('password')
      await settle()
      page.signal('password')
      await settle()
      expect(sentOn(FILL)).toHaveLength(0)
      expect(page.calls.accounts).toBe(1)
      expect(page.calls.credential).toBe(0)
      expect(page.calls.reload).toBe(0)
    }
  })

  it('keeps a credential that vanished between reads settled', async () => {
    const page = await loadedPage({ accounts: [{ ...ACCOUNT, id: 'gone' }] })
    page.signal('password')
    await settle()
    page.signal('password')
    await settle()
    expect(sentOn(FILL)).toHaveLength(0)
    expect(page.calls.accounts).toBe(1)
    expect(page.calls.credential).toBe(1)
  })

  it('ignores form signals from other frames, stale tokens and public http', async () => {
    const page = await loadedPage({ accounts: [ACCOUNT] })
    page.signal('password', {})
    page.signal('password', undefined, 'b'.repeat(32))
    await settle()
    expect(page.calls.accounts).toBe(0)
    harness.origin = 'http://example.com'
    try {
      const plain = await loadedPage({ accounts: [{ ...ACCOUNT, origin: 'http://example.com' }] })
      plain.signal('password')
      await settle()
      expect(plain.calls.accounts).toBe(0)
    } finally {
      harness.origin = 'https://example.com'
    }
  })

  it('reads nothing while the project is inactive', async () => {
    const page = await loadedPage({ accounts: [ACCOUNT] })
    await page.place(false, RECT, false)
    page.signal('password')
    await settle()
    expect(page.calls.accounts).toBe(0)
  })

  it('retries after switching projects interrupts the accounts read', async () => {
    const settled = gate()
    const page = await loadedPage({ accounts: [ACCOUNT], accountsGate: settled.wait })
    page.signal('password')
    await page.place(false, RECT, false)
    settled.open()
    await settle()
    expect(page.calls.credential).toBe(0)
    await page.place(true)
    expect(sentOn(SCAN)).toEqual([{ documentToken: TOKEN }])
    page.signal('password')
    await settle()
    expect(page.calls.accounts).toBe(2)
    expect(sentOn(FILL)).toHaveLength(1)
  })

  it('delivers nothing when the page navigates during the accounts read', async () => {
    const settled = gate()
    const page = await loadedPage({ accounts: [ACCOUNT], accountsGate: settled.wait })
    page.signal('password')
    harness.events.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: true })
    settled.open()
    await settle()
    expect(page.calls.credential).toBe(0)
    expect(sentOn(FILL)).toHaveLength(0)
  })

  it('delivers nothing when the page navigates during the credential read', async () => {
    const settled = gate()
    const page = await loadedPage({ accounts: [ACCOUNT], credentialGate: settled.wait })
    page.signal('password')
    await settle()
    expect(page.calls.credential).toBe(1)
    harness.events.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: true })
    settled.open()
    await settle()
    expect(sentOn(FILL)).toHaveLength(0)
  })

  it('retries after switching projects interrupts the credential read', async () => {
    const settled = gate()
    const page = await loadedPage({ accounts: [ACCOUNT], credentialGate: settled.wait })
    page.signal('password')
    await settle()
    await page.place(false, RECT, false)
    settled.open()
    await settle()
    expect(sentOn(FILL)).toHaveLength(0)
    await page.place(true)
    page.signal('password')
    await settle()
    expect(page.calls.credential).toBe(2)
    expect(sentOn(FILL)).toHaveLength(1)
  })

  it('probes again after in-page navigation and starts a fresh cap', async () => {
    const page = await loadedPage({ accounts: [ACCOUNT] })
    for (let round = 0; round < BROWSER_AUTOFILL_DELIVERIES_MAX; round += 1) {
      page.signal('password')
      await settle()
    }
    harness.events.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: true })
    harness.events.get('did-navigate-in-page')?.({}, 'https://example.com/login#again', true)
    expect(sentOn(SCAN)).toEqual([{ documentToken: TOKEN }])
    page.signal('password')
    await settle()
    expect(sentOn(FILL)).toHaveLength(BROWSER_AUTOFILL_DELIVERIES_MAX + 1)
  })

  it('probes on the first reveal only, not on every visible geometry', async () => {
    const page = await loadedPage({ accounts: [ACCOUNT] })
    await page.place(false, RECT, false)
    await page.place(true)
    await page.place(true, { ...RECT, width: 900 })
    expect(sentOn(SCAN)).toEqual([{ documentToken: TOKEN }])
  })

  it('probes once the page is usable, whether ready or load comes first', async () => {
    const early = await openPage({ accounts: [ACCOUNT] })
    early.committed()
    early.loaded()
    expect(sentOn(SCAN)).toHaveLength(0)
    early.ready()
    expect(sentOn(SCAN)).toEqual([{ documentToken: TOKEN }])
    const late = await openPage({ accounts: [ACCOUNT] })
    late.ready()
    late.committed()
    expect(sentOn(SCAN)).toHaveLength(0)
    late.loaded()
    expect(sentOn(SCAN)).toEqual([{ documentToken: TOKEN }])
  })

  it('fills once when both ready and load probe the page', async () => {
    const page = await openPage({ accounts: [ACCOUNT] })
    page.committed()
    page.ready()
    page.loaded()
    expect(sentOn(SCAN)).toHaveLength(2)
    page.signal('password')
    page.signal('password')
    await settle()
    expect(sentOn(FILL)).toHaveLength(1)
    expect(page.calls.accounts).toBe(1)
  })

  it('still sends an explicit Fill as manual', async () => {
    const { surfaces, owner, browserId } = await loadedPage({ accounts: [ACCOUNT] })
    const documentId = surfaces.restore(owner, browserId).state.documentId ?? ''
    const reply = await surfaces.fill(owner, browserId, 'only', documentId)
    expect(reply.failure).toBeNull()
    const fills = sentOn(FILL)
    expect(fills).toHaveLength(1)
    expect(fills[0]).toMatchObject({ mode: 'manual' })
  })
})

describe('horizontal wheel from the browser page', () => {
  const wheel = {
    deltaX: -40,
    deltaY: 0,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
  }

  const rowWheels = (page: Page) => page.pushes.filter(({ push }) => push.kind === 'row-wheel')

  it('routes the primary page gesture only to its owning shell without vault work', async () => {
    const page = await openPage()
    page.wheel(wheel)
    expect(rowWheels(page)).toEqual([
      { owner: page.owner, push: { kind: 'row-wheel', browserId: page.browserId, wheel } },
    ])
    expect(page.calls).toEqual({ accounts: 0, credential: 0, reload: 0 })
  })

  it('allows public http pages with no password token', async () => {
    harness.origin = 'http://example.com'
    try {
      const page = await openPage()
      page.wheel(wheel)
      expect(rowWheels(page)).toHaveLength(1)
      expect(page.calls.accounts).toBe(0)
    } finally {
      harness.origin = 'https://example.com'
    }
  })

  it('ignores foreign contents, subframes and malformed or zoom gestures', async () => {
    const page = await openPage()
    page.wheel(wheel, {})
    page.wheel(wheel, undefined, {})
    page.wheel({ ...wheel, password: 'secret' })
    page.wheel({ ...wheel, ctrlKey: true })
    page.wheel({ ...wheel, deltaX: 0, deltaY: 40 })
    page.wheel({ ...wheel, deltaX: Infinity })
    expect(rowWheels(page)).toHaveLength(0)
    expect(harness.sent).toEqual([])
  })

  it('forwards every real delta immediately through clipping and off-row placement', async () => {
    const page = await openPage()
    const captures = harness.captures
    const deltas: readonly BrowserPageRowWheel[] = [
      wheel,
      { ...wheel, deltaX: -12 },
      { ...wheel, deltaX: 18 },
    ]
    page.wheel(deltas[0])
    await page.place(false, { ...RECT, width: 760 })
    page.wheel(deltas[1])
    await page.place(false, { ...RECT, width: 0 })
    page.wheel(deltas[2])
    expect(rowWheels(page)).toEqual(
      deltas.map((delta) => ({
        owner: page.owner,
        push: { kind: 'row-wheel', browserId: page.browserId, wheel: delta },
      }))
    )
    expect(harness.captures).toBe(captures)
    expect(harness.sent).toEqual([])
  })

  it('ignores wheel messages after the browser is detached', async () => {
    const page = await openPage()
    page.surfaces.detach(page.owner, page.browserId)
    page.wheel(wheel)
    expect(rowWheels(page)).toHaveLength(0)
  })
})

async function openSwipePage() {
  harness.sent.length = 0
  const { surfaces, owner } = webSurfaces()
  const { browserId } = await surfaces.attachWebTab(owner, 'swipe')
  surfaces.navigate(owner, browserId, 'https://example.com')
  await surfaces.geometry(owner, {
    browserId,
    revision: 1,
    rect: RECT,
    bodyOrigin: { x: 0, y: 0 },
    active: true,
    fullyVisible: true,
  })
  const contents = harness.contents
  const participant = harness.participants.at(-1)
  const commit = harness.ipc.get(BROWSER_PAGE_SWIPE_CHANNEL)
  const input = harness.events.get('input-event')
  if (
    contents === null ||
    participant === undefined ||
    commit === undefined ||
    input === undefined
  ) {
    throw new Error('No live swipe page')
  }
  const from = { sender: contents, senderFrame: contents.mainFrame }
  return { surfaces, owner, browserId, contents, participant, commit, input, from }
}

describe('web tab swipe navigation', () => {
  it.each(['back', 'forward'] as const)(
    'commits a visible main-frame swipe toward %s',
    async (direction) => {
      const page = await openSwipePage()
      harness.canGoBack = true
      harness.canGoForward = true
      page.commit(page.from, { direction, revision: 0 })
      expect(harness.wentBack).toBe(direction === 'back' ? 1 : 0)
      expect(harness.wentForward).toBe(direction === 'forward' ? 1 : 0)
    }
  )

  it('rejects project-page commits even when the page is visible and has history', async () => {
    const page = await openPage()
    harness.canGoBack = true
    harness.canGoForward = true
    const contents = harness.contents
    const commit = harness.ipc.get(BROWSER_PAGE_SWIPE_CHANNEL)
    if (contents === null || commit === undefined) throw new Error('No project page')
    commit(
      { sender: contents, senderFrame: contents.mainFrame },
      { direction: 'back', revision: 0 }
    )
    expect(harness.wentBack).toBe(0)
    expect(harness.wentForward).toBe(0)
    expect(page.calls.accounts).toBe(0)
  })

  it('rejects a hidden tab and accepts it once it is shown again', async () => {
    const page = await openSwipePage()
    harness.canGoBack = true
    const geometry = {
      browserId: page.browserId,
      rect: RECT,
      bodyOrigin: { x: 0, y: 0 },
      fullyVisible: true,
    }
    await page.surfaces.geometry(page.owner, { ...geometry, revision: 2, active: false })
    page.commit(page.from, { direction: 'back', revision: 0 })
    expect(harness.wentBack).toBe(0)
    await page.surfaces.geometry(page.owner, { ...geometry, revision: 3, active: true })
    page.commit(page.from, { direction: 'back', revision: 0 })
    expect(harness.wentBack).toBe(1)
  })

  it('rejects a closed record through its saved commit listener', async () => {
    const page = await openSwipePage()
    harness.canGoBack = true
    page.commit(page.from, { direction: 'back', revision: 0 })
    page.surfaces.close(page.owner, page.browserId, 0)
    page.commit(page.from, { direction: 'back', revision: 0 })
    expect(harness.wentBack).toBe(1)
  })

  it('rejects a view concealed by a shell overlay while the record remains shown', async () => {
    const page = await openSwipePage()
    harness.canGoBack = true
    expect(page.participant.shown()).toBe(true)
    page.participant.view.setVisible(false)
    page.commit(page.from, { direction: 'back', revision: 0 })
    expect(harness.wentBack).toBe(0)
    page.participant.view.setVisible(true)
    page.commit(page.from, { direction: 'back', revision: 0 })
    expect(harness.wentBack).toBe(1)
  })

  it('rejects subframes, absent frames and foreign contents', async () => {
    const page = await openSwipePage()
    harness.canGoBack = true
    const payload = { direction: 'back', revision: 0 }
    page.commit({ sender: page.contents, senderFrame: {} }, payload)
    page.commit({ sender: page.contents, senderFrame: null }, payload)
    page.commit({ sender: {}, senderFrame: page.contents.mainFrame }, payload)
    expect(harness.wentBack).toBe(0)
    page.commit(page.from, payload)
    expect(harness.wentBack).toBe(1)
  })

  it('rejects a revision from before same-document navigation', async () => {
    const page = await openSwipePage()
    harness.canGoBack = true
    harness.events.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: true })
    page.commit(page.from, { direction: 'back', revision: 0 })
    expect(harness.wentBack).toBe(0)
    page.commit(page.from, { direction: 'back', revision: 1 })
    expect(harness.wentBack).toBe(1)
  })

  it.each([
    null,
    {},
    { direction: 'sideways', revision: 0 },
    { direction: 'back' },
    { direction: 'back', revision: -1 },
    { direction: 'back', revision: 0.5 },
    { direction: 'back', revision: Number.POSITIVE_INFINITY },
    { direction: 'back', revision: 0, extra: true },
  ])('rejects malformed swipe payload %j', async (payload) => {
    const page = await openSwipePage()
    harness.canGoBack = true
    page.commit(page.from, payload)
    expect(harness.wentBack).toBe(0)
  })

  it('rechecks available history for both directions', async () => {
    const page = await openSwipePage()
    page.commit(page.from, { direction: 'back', revision: 0 })
    page.commit(page.from, { direction: 'forward', revision: 0 })
    expect(harness.wentBack).toBe(0)
    expect(harness.wentForward).toBe(0)
    harness.canGoForward = true
    page.commit(page.from, { direction: 'forward', revision: 0 })
    expect(harness.wentForward).toBe(1)
  })

  it('sends web-page swipe state on ready and subsequent state pushes', async () => {
    const page = await openSwipePage()
    harness.canGoBack = true
    harness.zoom = 1.5
    harness.sent.length = 0
    harness.ipc.get('browser:page:ready')?.(page.from, { documentToken: TOKEN })
    expect(sentOn(BROWSER_PAGE_SWIPE_STATE_CHANNEL)).toEqual([
      { back: true, forward: false, zoom: 1.5, revision: 0 },
    ])
    harness.canGoForward = true
    harness.events.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: true })
    harness.events.get('did-navigate-in-page')?.({}, 'https://example.com/login#next', true)
    expect(sentOn(BROWSER_PAGE_SWIPE_STATE_CHANNEL).at(-1)).toEqual({
      back: true,
      forward: true,
      zoom: 1.5,
      revision: 1,
    })
    page.surfaces.act(page.owner, page.browserId, 'zoom-reset')
    expect(sentOn(BROWSER_PAGE_SWIPE_STATE_CHANNEL).at(-1)).toEqual({
      back: true,
      forward: true,
      zoom: 1,
      revision: 1,
    })
  })

  it('never sends swipe state or sequences to project pages', async () => {
    harness.events.delete('input-event')
    const page = await openPage()
    page.ready()
    page.committed()
    expect(sentOn(BROWSER_PAGE_SWIPE_STATE_CHANNEL)).toEqual([])
    expect(sentOn(BROWSER_PAGE_SWIPE_SEQUENCE_CHANNEL)).toEqual([])
    expect(harness.events.has('input-event')).toBe(false)
  })

  it('sends nothing to a detached frame on a renderer crash or native begin', async () => {
    const page = await openSwipePage()
    const gone = harness.events.get('render-process-gone')
    if (gone === undefined) throw new Error('No renderer crash listener')
    harness.sent.length = 0
    harness.detached = true
    expect(() => {
      gone({}, { reason: 'crashed' })
    }).not.toThrow()
    expect(() => {
      page.input({}, { type: 'gestureScrollBegin' })
    }).not.toThrow()
    expect(sentOn(BROWSER_PAGE_SWIPE_STATE_CHANNEL)).toEqual([])
    expect(sentOn(BROWSER_PAGE_SWIPE_SEQUENCE_CHANNEL)).toEqual([])
  })

  it('numbers native begins and pairs each end without emitting other input types', async () => {
    const page = await openSwipePage()
    harness.sent.length = 0
    page.input({}, { type: 'mouseWheel' })
    page.input({}, { type: 'gestureScrollUpdate' })
    page.input({}, { type: 'gestureFlingStart' })
    expect(sentOn(BROWSER_PAGE_SWIPE_SEQUENCE_CHANNEL)).toEqual([])
    page.input({}, { type: 'gestureScrollBegin' })
    page.input({}, { type: 'gestureScrollEnd' })
    page.input({}, { type: 'gestureScrollBegin' })
    page.input({}, { type: 'gestureScrollEnd' })
    expect(sentOn(BROWSER_PAGE_SWIPE_SEQUENCE_CHANNEL)).toEqual([
      { phase: 'begin', sequence: 1 },
      { phase: 'end', sequence: 1 },
      { phase: 'begin', sequence: 2 },
      { phase: 'end', sequence: 2 },
    ])
  })
})
