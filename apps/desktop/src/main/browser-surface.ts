import { randomUUID } from 'node:crypto'
import {
  BrowserWindow,
  clipboard,
  Menu,
  session as electronSession,
  shell,
  WebContentsView,
  type ContextMenuParams,
  type HandlerDetails,
  type IpcMainEvent,
  type MenuItemConstructorOptions,
  type NavigationEntry,
  type PostBody,
  type Session,
  type WebContents,
  type WebPreferences,
  type WindowOpenHandlerResponse,
} from 'electron'
import {
  BROWSER_CLOSED_MAX,
  BROWSER_DEVTOOLS_ROW_WHEEL_CHANNEL,
  BROWSER_ERROR_MAX,
  BROWSER_PAGE_CANDIDATE_CHANNEL,
  BROWSER_PAGE_FILL_CHANNEL,
  BROWSER_PAGE_FORM_CHANNEL,
  BROWSER_PAGE_READY_CHANNEL,
  BROWSER_PAGE_ROW_WHEEL_CHANNEL,
  BROWSER_PAGE_ROW_WHEEL_ENABLE_CHANNEL,
  BROWSER_PAGE_SCAN_CHANNEL,
  BROWSER_PAGE_SWIPE_CHANNEL,
  BROWSER_PAGE_SWIPE_SEQUENCE_CHANNEL,
  BROWSER_PAGE_SWIPE_STATE_CHANNEL,
  BROWSER_TITLE_MAX,
  BROWSER_URL_MAX,
  BrowserIcon,
  BrowserPageCandidate,
  BrowserPageForm,
  BrowserPageReady,
  BrowserPageRowWheel,
  BrowserPageSwipe,
  browserAddress,
  browserPasswordOrigin,
  browserSearchUrl,
  browserWebCommand,
  browserZoomStep,
  isBrowserNavigable,
  isBrowserPasswordOrigin,
  type BrowserAction,
  type BrowserFailure,
  type BrowserFavorite,
  type BrowserFillMode,
  type BrowserFormPhase,
  type BrowserLoadError,
  type BrowserPageFill,
  type BrowserPageScan,
  type BrowserPageSwipeSequence,
  type BrowserPageSwipeState,
  type BrowserPasswordDecision,
  type BrowserPasswordPrompt,
  type BrowserPasswords,
  type BrowserPush,
  type BrowserRect,
  type BrowserRequest,
  type BrowserResponse,
  type BrowserState,
  type BrowserSettingsStatus,
} from '../shared/browser-ipc.js'
import { WEB_TABS_MAX } from '../shared/workspace-layout.js'
import { browserContextMenu, type BrowserMenuAction } from './browser-context-menu.js'
import type { BrowserSettingsStore } from './browser-settings.js'
import type { BrowserVault, BrowserVaultCredential } from './browser-vault.js'
import { mainT } from './i18n.js'
import { currentScale, onScaleChange } from './scale.js'
import {
  applyParticipant,
  registerOverlayParticipant,
  type OverlayParticipant,
} from './workbench-surface.js'

export const BROWSER_PARTITION = 'persist:chorus-browser'

const ALLOWED_PERMISSIONS = new Set<string>(['fullscreen', 'clipboard-sanitized-write'])
const FRAME_SCHEMES = new Set(['http:', 'https:', 'about:', 'blob:', 'data:'])
export const BROWSER_RECORDS_PER_OWNER = 64 + WEB_TABS_MAX
export const BROWSER_AUTOFILL_DELIVERIES_MAX = 3
const POPUPS_MAX = 8
const POPUP_WIDTH = 960
const POPUP_HEIGHT = 720
const CANDIDATE_TTL_MS = 120_000
const PROMPT_TTL_MS = 300_000
const IDENTIFIER_TTL_MS = 300_000
const FAVICON_TIMEOUT_MS = 5_000
const FAVICON_BYTES_MAX = 24_000
const FAVICON_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])
const PAGE_BACKGROUND = '#ffffff'

const browserPages = new WeakSet<WebContents>()

export function isBrowserPage(contents: WebContents): boolean {
  return browserPages.has(contents)
}

export interface BrowserConsoleHooks {
  readonly mounted: (source: {
    readonly browserId: string
    readonly projectId: string
    readonly owner: WebContents
    readonly contents: WebContents
  }) => void
  readonly released: (contents: WebContents) => void
}

export interface BrowserSurfaceDeps {
  readonly settings: BrowserSettingsStore
  readonly vault: BrowserVault
  readonly preloadPath: string
  readonly devtoolsPreloadPath: string
  readonly mainOwner: () => WebContents | null
  readonly downloads: { readonly expect: (contents: WebContents) => void }
  readonly deliver: (owner: WebContents, push: BrowserPush) => void
  readonly console?: BrowserConsoleHooks
}

interface PendingCredential {
  readonly candidateId: string
  readonly origin: string
  readonly username: string
  readonly password: string
  prompt: BrowserPasswordPrompt | null
  timer: ReturnType<typeof setTimeout> | null
}

interface PendingIdentifier {
  readonly origin: string
  readonly username: string
  readonly expires: number
}

interface PageToken {
  readonly value: string
  readonly origin: string
}

interface PageIdentity {
  readonly contents: WebContents
  readonly origin: string
  readonly token: string
  readonly documentId: string
  readonly navigation: number
}

interface AutofillState {
  readonly key: string
  readonly pending: Set<BrowserFormPhase>
  readonly settled: Set<BrowserFormPhase>
  readonly deliveries: Map<BrowserFormPhase, number>
}

type AutofillOutcome = 'delivered' | 'settled' | 'interrupted'

type RecordScope =
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'web'; readonly webTabId: string }

interface ClosedWebTab {
  readonly url: string | null
  readonly title: string
  readonly icon: string | null
  readonly entries: NavigationEntry[]
  readonly index: number
  readonly position: number
  readonly settings: BrowserSettingsStatus
}

interface DevtoolsDock {
  readonly view: WebContentsView
  readonly participant: OverlayParticipant
  readonly unregister: () => void
}

interface BrowserRecord {
  readonly id: string
  readonly owner: WebContents
  readonly scope: RecordScope
  readonly settings: BrowserSettingsStatus
  readonly popups: Set<BrowserWindow>
  view: WebContentsView | null
  participant: OverlayParticipant | null
  unregister: (() => void) | null
  devtools: DevtoolsDock | null
  devtoolsRect: BrowserRect | null
  devtoolsRevision: number
  devtoolsShown: boolean
  pendingUrl: string | null
  url: string | null
  revision: number
  rect: BrowserRect | null
  wanted: boolean
  live: boolean
  loading: boolean
  title: string
  icon: string | null
  error: BrowserLoadError | null
  documentId: string | null
  navigation: number
  swipeSequence: number
  token: PageToken | null
  credential: PendingCredential | null
  identifier: PendingIdentifier | null
  favicon: AbortController | null
  autofill: AutofillState | null
  history: { readonly entries: NavigationEntry[]; readonly index: number } | null
  findRequest: number | null
  closed: boolean
}

function guestOf(options: unknown): options is { readonly webContents: WebContents } {
  if (typeof options !== 'object' || options === null || !('webContents' in options)) return false
  const guest = options.webContents
  if (typeof guest !== 'object' || guest === null) return false
  return (
    'isDestroyed' in guest &&
    typeof guest.isDestroyed === 'function' &&
    'loadURL' in guest &&
    typeof guest.loadURL === 'function' &&
    'on' in guest &&
    typeof guest.on === 'function'
  )
}

function contentTypeHeader(body: PostBody): string {
  const boundary =
    body.contentType === 'multipart/form-data' && body.boundary !== undefined
      ? `; boundary=${body.boundary}`
      : ''
  return `Content-Type: ${body.contentType}${boundary}`
}

function frameNavigable(raw: string): boolean {
  try {
    return FRAME_SCHEMES.has(new URL(raw).protocol)
  } catch {
    return false
  }
}

function clampUrl(url: string): string | null {
  return url !== '' && url.length <= BROWSER_URL_MAX ? url : null
}

async function readIcon(source: Session, url: string, signal: AbortSignal): Promise<string | null> {
  const response = await source.fetch(url, { signal })
  if (!response.ok) return null
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  const declared = Number(response.headers.get('content-length') ?? '0')
  const body = response.body
  if (body === null) return null
  if (type === undefined || !FAVICON_TYPES.has(type) || declared > FAVICON_BYTES_MAX) {
    await body.cancel()
    return null
  }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    const value: unknown = next.value
    if (!(value instanceof Uint8Array) || total + value.byteLength > FAVICON_BYTES_MAX) {
      await reader.cancel()
      return null
    }
    total += value.byteLength
    chunks.push(Buffer.from(value))
  }
  const icon = `data:${type};base64,${Buffer.concat(chunks, total).toString('base64')}`
  return BrowserIcon.safeParse(icon).success ? icon : null
}

export class BrowserSurfaces {
  private readonly deps: BrowserSurfaceDeps
  private readonly records = new Map<string, BrowserRecord>()
  private readonly watched = new WeakSet<WebContents>()
  private readonly readyOwners = new WeakSet<WebContents>()
  private readonly generations = new WeakMap<WebContents, number>()
  private readonly closedTabs = new WeakMap<WebContents, ClosedWebTab[]>()
  private readonly pendingOpens = new WeakMap<WebContents, number>()
  private browserSession: Session | null = null
  private stopping = false

  constructor(deps: BrowserSurfaceDeps) {
    this.deps = deps
    onScaleChange(() => {
      for (const record of this.records.values()) {
        if (record.live) this.place(record)
        if (record.devtools !== null) this.placeDock(record)
      }
    })
  }

  webReady(owner: WebContents): BrowserResponse<'browser:webReady'> {
    if (!this.stopping && !owner.isDestroyed()) {
      this.watch(owner)
      this.readyOwners.add(owner)
    }
    return { ok: true }
  }

  async attach(owner: WebContents, projectId: string): Promise<BrowserResponse<'browser:attach'>> {
    this.admit(owner)
    this.watch(owner)
    const generation = this.generations.get(owner) ?? 0
    const read = await this.deps.settings.project(projectId)
    if (owner.isDestroyed() || (this.generations.get(owner) ?? 0) !== generation) {
      throw new Error('The window changed before its browser attached')
    }
    this.admit(owner)
    const record = this.createRecord(owner, { kind: 'project', projectId }, read.status, {
      url: read.settings.lastUrl,
      title: '',
      icon: null,
    })
    return {
      browserId: record.id,
      state: this.state(record),
      favorites: [...read.settings.favorites],
      settings: read.status,
    }
  }

  async attachWebTab(
    owner: WebContents,
    webTabId: string
  ): Promise<BrowserResponse<'browser:attach'>> {
    const existing = this.webRecord(owner, webTabId)
    if (existing !== null) return this.attached(existing)
    this.admitWeb(owner)
    this.watch(owner)
    const generation = this.generations.get(owner) ?? 0
    const read = await this.deps.settings.webTab(webTabId)
    if (owner.isDestroyed() || (this.generations.get(owner) ?? 0) !== generation) {
      throw new Error('The window changed before its web tab attached')
    }
    const adopted = this.webRecord(owner, webTabId)
    if (adopted !== null) return this.attached(adopted)
    this.admitWeb(owner)
    return this.attached(
      this.createRecord(owner, { kind: 'web', webTabId }, read.status, read.page)
    )
  }

  private createRecord(
    owner: WebContents,
    scope: RecordScope,
    settings: BrowserSettingsStatus,
    page: { readonly url: string | null; readonly title: string; readonly icon: string | null }
  ): BrowserRecord {
    const record: BrowserRecord = {
      id: randomUUID(),
      owner,
      scope,
      settings,
      popups: new Set(),
      view: null,
      participant: null,
      unregister: null,
      devtools: null,
      devtoolsRect: null,
      devtoolsRevision: 0,
      devtoolsShown: false,
      pendingUrl: page.url,
      url: null,
      revision: 0,
      rect: null,
      wanted: false,
      live: false,
      loading: false,
      title: page.title,
      icon: page.icon,
      error: null,
      documentId: null,
      navigation: 0,
      swipeSequence: 0,
      token: null,
      credential: null,
      identifier: null,
      favicon: null,
      autofill: null,
      history: null,
      findRequest: null,
      closed: false,
    }
    this.records.set(record.id, record)
    return record
  }

  private attached(record: BrowserRecord): BrowserResponse<'browser:attach'> {
    return {
      browserId: record.id,
      state: this.state(record),
      favorites: [],
      settings: record.settings,
    }
  }

  detach(owner: WebContents, browserId: string): BrowserResponse<'browser:detach'> {
    const record = this.records.get(browserId)
    if (record?.owner === owner && record.scope.kind === 'project') this.release(record)
    return { ok: true }
  }

  close(owner: WebContents, browserId: string, position: number): BrowserResponse<'browser:close'> {
    const record = this.owned(owner, browserId)
    if (record.scope.kind !== 'web') return { ok: true }
    this.remember(record, position)
    this.release(record)
    this.deps.settings.removeWebTab(record.scope.webTabId).catch(() => null)
    return { ok: true }
  }

  reopen(owner: WebContents): BrowserResponse<'browser:reopen'> {
    const stack = this.closedTabs.get(owner)
    const closed = stack?.at(-1)
    if (closed === undefined) return { reopened: null }
    this.admitWeb(owner)
    const webTabId = randomUUID()
    const record = this.createRecord(owner, { kind: 'web', webTabId }, closed.settings, closed)
    record.history =
      closed.entries.length === 0 ? null : { entries: closed.entries, index: closed.index }
    stack?.pop()
    this.savePage(record)
    return { reopened: { webTabId, index: closed.position, state: this.state(record) } }
  }

  shownWebTab(owner: WebContents): BrowserRecord | null {
    for (const record of this.records.values()) {
      if (record.owner === owner && record.scope.kind === 'web' && record.wanted) return record
    }
    return null
  }

  ownerOf(contents: WebContents): { owner: WebContents; browserId: string } | null {
    for (const record of this.records.values()) {
      if (record.scope.kind !== 'web' || record.closed) continue
      if (record.view?.webContents === contents) {
        return { owner: record.owner, browserId: record.id }
      }
      for (const popup of record.popups) {
        if (!popup.isDestroyed() && popup.webContents === contents) {
          return { owner: record.owner, browserId: record.id }
        }
      }
    }
    return null
  }

  routeZoom(owner: WebContents, direction: -1 | 0 | 1): boolean {
    const record = this.shownWebTab(owner)
    if (record === null) return false
    this.zoom(record, direction)
    return true
  }

  routeReload(owner: WebContents): boolean {
    const record = this.shownWebTab(owner)
    if (record === null) return false
    this.contents(record)?.reload()
    return true
  }

  routeDevtools(owner: WebContents): boolean {
    const record = this.shownWebTab(owner)
    if (record === null) return false
    const contents = this.contents(record)
    if (contents !== null) {
      if (contents.isDevToolsOpened()) contents.closeDevTools()
      else contents.openDevTools({ mode: 'detach' })
    }
    return true
  }

  routeFocusedDevtools(focused: WebContents | null): boolean {
    if (focused === null || focused.isDestroyed()) return false
    for (const record of this.records.values()) {
      if (record.scope.kind !== 'project' || record.closed) continue
      const contents = this.contents(record)
      if (contents === null) continue
      if (contents !== focused && record.devtools?.view.webContents !== focused) continue
      this.push(record, { kind: 'devtools', browserId: record.id, action: 'toggle' })
      return true
    }
    return false
  }

  find(
    owner: WebContents,
    browserId: string,
    text: string,
    forward: boolean,
    start: boolean
  ): BrowserResponse<'browser:find'> {
    const record = this.owned(owner, browserId)
    const contents = this.contents(record)
    if (contents === null) return { failure: 'not-loaded' }
    record.findRequest = contents.findInPage(text, { forward, findNext: start })
    return { failure: null }
  }

  restore(owner: WebContents, browserId: string): BrowserResponse<'browser:restore'> {
    const record = this.owned(owner, browserId)
    if (record.view !== null || record.pendingUrl === null) return this.result(record, null)
    return this.result(record, this.load(record, record.pendingUrl))
  }

  navigate(
    owner: WebContents,
    browserId: string,
    address: string
  ): BrowserResponse<'browser:navigate'> {
    const record = this.owned(owner, browserId)
    const url = browserAddress(address)
    if (url === null) return this.result(record, 'invalid-address')
    if (!isBrowserNavigable(url)) return this.result(record, 'blocked-address')
    record.history = null
    return this.result(record, this.load(record, url))
  }

  act(
    owner: WebContents,
    browserId: string,
    action: BrowserAction
  ): BrowserResponse<'browser:action'> {
    const record = this.owned(owner, browserId)
    const contents = this.contents(record)
    if (action === 'external') {
      const url = contents === null ? record.pendingUrl : contents.getURL()
      if (url === null || url === 'about:blank' || !isBrowserNavigable(url)) {
        return this.result(record, 'not-loaded')
      }
      shell.openExternal(url).catch(() => undefined)
      return this.result(record, null)
    }
    if (contents === null) return this.result(record, 'not-loaded')
    switch (action) {
      case 'back':
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
        break
      case 'forward':
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
        break
      case 'reload':
        contents.reload()
        break
      case 'stop':
        contents.stop()
        break
      case 'devtools':
        if (record.scope.kind === 'project') {
          this.push(record, { kind: 'devtools', browserId: record.id, action: 'show' })
        } else contents.openDevTools({ mode: 'detach' })
        break
      case 'focus':
        contents.focus()
        break
      case 'zoom-in':
        this.zoom(record, 1)
        break
      case 'zoom-out':
        this.zoom(record, -1)
        break
      case 'zoom-reset':
        this.zoom(record, 0)
        break
      case 'find-stop':
        record.findRequest = null
        contents.stopFindInPage('clearSelection')
        break
    }
    return this.result(record, null)
  }

  geometry(
    owner: WebContents,
    request: BrowserRequest<'browser:geometry'>
  ): Promise<BrowserResponse<'browser:geometry'>> {
    const record = this.owned(owner, request.browserId)
    const { revision, rect } = request
    if (revision <= record.revision) {
      return Promise.resolve({ revision: record.revision, still: null })
    }
    record.revision = revision
    record.rect = rect
    record.wanted = request.active
    const created = record.view === null && record.wanted && record.pendingUrl !== null
    if (record.wanted && record.view === null && record.pendingUrl !== null) {
      this.load(record, record.pendingUrl)
    }
    if (record.view === null) return Promise.resolve({ revision, still: null })
    const revealed = record.wanted && !record.live
    const changed = record.live !== record.wanted
    record.live = record.wanted
    if (record.live) this.place(record)
    if (changed) this.apply(record)
    if (revealed) this.probe(record)
    if (record.scope.kind === 'web' && (created || changed)) this.pushState(record)
    return Promise.resolve({ revision, still: null })
  }

  devtoolsGeometry(
    owner: WebContents,
    request: BrowserRequest<'browser:devtoolsGeometry'>
  ): BrowserResponse<'browser:devtoolsGeometry'> {
    const record = this.owned(owner, request.browserId)
    if (request.revision <= record.devtoolsRevision) {
      return { revision: record.devtoolsRevision }
    }
    record.devtoolsRevision = request.revision
    record.devtoolsRect = request.rect
    record.devtoolsShown = request.active
    this.placeDock(record)
    if (record.devtools !== null) applyParticipant(record.devtools.participant)
    return { revision: record.devtoolsRevision }
  }

  async addFavorite(
    owner: WebContents,
    browserId: string
  ): Promise<BrowserResponse<'browser:favoriteAdd'>> {
    const record = this.owned(owner, browserId)
    if (record.scope.kind !== 'project') return { favorites: [], failure: 'not-eligible' }
    const url = record.url ?? record.pendingUrl
    if (url === null) return { favorites: await this.favoritesOf(record), failure: 'not-loaded' }
    const outcome = await this.deps.settings.addFavorite(record.scope.projectId, {
      url,
      title: record.title,
      icon: record.icon,
    })
    const favorites = [...outcome.favorites]
    if (outcome.failure === null) this.shareFavorites(record.scope.projectId, favorites)
    return { favorites, failure: outcome.failure }
  }

  async removeFavorite(
    owner: WebContents,
    browserId: string,
    favoriteId: string
  ): Promise<BrowserResponse<'browser:favoriteRemove'>> {
    const record = this.owned(owner, browserId)
    if (record.scope.kind !== 'project') return { favorites: [], failure: 'not-eligible' }
    const outcome = await this.deps.settings.removeFavorite(record.scope.projectId, favoriteId)
    const favorites = [...outcome.favorites]
    if (outcome.failure === null) this.shareFavorites(record.scope.projectId, favorites)
    return { favorites, failure: outcome.failure }
  }

  async openFavorite(
    owner: WebContents,
    browserId: string,
    favoriteId: string
  ): Promise<BrowserResponse<'browser:favoriteOpen'>> {
    const record = this.owned(owner, browserId)
    if (record.scope.kind !== 'project') return this.result(record, 'not-eligible')
    const favorite = await this.deps.settings.favorite(record.scope.projectId, favoriteId)
    if (favorite === null) return this.result(record, 'not-found')
    if (!isBrowserNavigable(favorite.url)) return this.result(record, 'blocked-address')
    return this.result(record, this.load(record, favorite.url))
  }

  async passwords(
    owner: WebContents,
    browserId: string
  ): Promise<BrowserResponse<'browser:passwords'>> {
    const record = this.owned(owner, browserId)
    await this.deps.vault.reload()
    return { passwords: await this.passwordsFor(this.currentOrigin(record)), failure: null }
  }

  async decide(
    owner: WebContents,
    browserId: string,
    candidateId: string,
    decision: BrowserPasswordDecision
  ): Promise<BrowserResponse<'browser:passwordDecide'>> {
    const record = this.owned(owner, browserId)
    const pending = record.credential
    if (pending?.candidateId !== candidateId || pending.prompt === null) {
      return {
        passwords: await this.passwordsFor(this.currentOrigin(record)),
        failure: 'stale-candidate',
      }
    }
    const failure = await this.persistDecision(pending, decision)
    if (failure === null && record.credential === pending) this.clearCredential(record, true)
    return { passwords: await this.passwordsFor(this.currentOrigin(record)), failure }
  }

  async fill(
    owner: WebContents,
    browserId: string,
    accountId: string,
    documentId: string
  ): Promise<BrowserResponse<'browser:passwordFill'>> {
    const record = this.owned(owner, browserId)
    if (this.contents(record) === null) return { failure: 'not-loaded' }
    const identity = this.identity(record)
    if (identity === null) return { failure: 'not-eligible' }
    if (identity.documentId !== documentId) return { failure: 'stale-document' }
    const credential = await this.deps.vault.credential(identity.origin, accountId)
    if (credential === null) return { failure: 'not-found' }
    if (!this.unchanged(record, identity)) return { failure: 'stale-document' }
    this.deliver(identity, credential, 'manual')
    return { failure: null }
  }

  async removePassword(
    owner: WebContents,
    browserId: string,
    accountId: string
  ): Promise<BrowserResponse<'browser:passwordRemove'>> {
    const record = this.owned(owner, browserId)
    const origin = this.currentOrigin(record)
    if (origin === null) {
      return { passwords: await this.passwordsFor(null), failure: 'not-eligible' }
    }
    const failure = await this.deps.vault.remove(origin, accountId)
    return { passwords: await this.passwordsFor(origin), failure }
  }

  async allowPasswords(
    owner: WebContents,
    browserId: string
  ): Promise<BrowserResponse<'browser:passwordAllow'>> {
    const record = this.owned(owner, browserId)
    const origin = this.currentOrigin(record)
    if (origin === null) {
      return { passwords: await this.passwordsFor(null), failure: 'not-eligible' }
    }
    const failure = await this.deps.vault.allow(origin)
    return { passwords: await this.passwordsFor(origin), failure }
  }

  closeOwner(owner: WebContents): void {
    this.readyOwners.delete(owner)
    this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1)
    this.closedTabs.delete(owner)
    this.pendingOpens.delete(owner)
    for (const record of [...this.records.values()]) {
      if (record.owner === owner) this.release(record)
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    for (const record of [...this.records.values()]) this.release(record)
    await Promise.all([this.deps.settings.flush(), this.deps.vault.flush()])
  }

  private admit(owner: WebContents): void {
    if (this.stopping) throw new Error('The browser is shutting down')
    if (owner.isDestroyed()) throw new Error('The browser window is closed')
    let count = 0
    for (const record of this.records.values()) if (record.owner === owner) count += 1
    if (count + (this.pendingOpens.get(owner) ?? 0) >= BROWSER_RECORDS_PER_OWNER) {
      throw new Error('Too many browsers in this window')
    }
  }

  private webRecord(owner: WebContents, webTabId: string): BrowserRecord | null {
    for (const record of this.records.values()) {
      if (
        record.owner === owner &&
        record.scope.kind === 'web' &&
        record.scope.webTabId === webTabId
      ) {
        return record
      }
    }
    return null
  }

  private webCount(owner: WebContents): number {
    let count = 0
    for (const record of this.records.values()) {
      if (record.owner === owner && record.scope.kind === 'web') count += 1
    }
    return count
  }

  private mayOpenWeb(owner: WebContents): boolean {
    if (this.stopping || owner.isDestroyed()) return false
    let total = 0
    for (const record of this.records.values()) if (record.owner === owner) total += 1
    const pending = this.pendingOpens.get(owner) ?? 0
    return (
      total + pending < BROWSER_RECORDS_PER_OWNER && this.webCount(owner) + pending < WEB_TABS_MAX
    )
  }

  private canOpenTabIn(owner: WebContents | null): owner is WebContents {
    return owner !== null && this.readyOwners.has(owner) && this.mayOpenWeb(owner)
  }

  private admitWeb(owner: WebContents): void {
    this.admit(owner)
    if (!this.mayOpenWeb(owner)) throw new Error('Too many web tabs in this window')
  }

  private holdOpen(owner: WebContents): void {
    this.pendingOpens.set(owner, (this.pendingOpens.get(owner) ?? 0) + 1)
  }

  private releaseOpen(owner: WebContents): void {
    const remaining = (this.pendingOpens.get(owner) ?? 0) - 1
    if (remaining <= 0) this.pendingOpens.delete(owner)
    else this.pendingOpens.set(owner, remaining)
  }

  private remember(record: BrowserRecord, position: number): void {
    const contents = this.contents(record)
    const stack = this.closedTabs.get(record.owner) ?? []
    stack.push({
      url: contents === null ? record.pendingUrl : clampUrl(contents.getURL()),
      title: record.title,
      icon: record.icon,
      entries: contents?.navigationHistory.getAllEntries() ?? record.history?.entries ?? [],
      index: contents?.navigationHistory.getActiveIndex() ?? record.history?.index ?? 0,
      position,
      settings: record.settings,
    })
    if (stack.length > BROWSER_CLOSED_MAX) stack.splice(0, stack.length - BROWSER_CLOSED_MAX)
    this.closedTabs.set(record.owner, stack)
  }

  private owned(owner: WebContents, browserId: string): BrowserRecord {
    const record = this.records.get(browserId)
    if (record?.owner !== owner || record.closed) {
      throw new Error(`No browser "${browserId}" belongs to this window`)
    }
    return record
  }

  private watch(owner: WebContents): void {
    if (this.watched.has(owner)) return
    this.watched.add(owner)
    owner.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.closeOwner(owner)
    })
    owner.once('destroyed', () => {
      this.closeOwner(owner)
    })
  }

  private session(): Session {
    if (this.browserSession !== null) return this.browserSession
    const created = electronSession.fromPartition(BROWSER_PARTITION)
    created.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission))
    })
    created.setPermissionCheckHandler((_contents, permission) =>
      ALLOWED_PERMISSIONS.has(permission)
    )
    this.browserSession = created
    return created
  }

  private preferences(primary: boolean, kind: RecordScope['kind']): WebPreferences {
    return {
      session: this.session(),
      ...(primary ? { preload: this.deps.preloadPath } : {}),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: kind === 'web' || !primary,
    }
  }

  private contents(record: BrowserRecord): WebContents | null {
    const contents = record.view?.webContents
    return contents === undefined || contents.isDestroyed() ? null : contents
  }

  private result(
    record: BrowserRecord,
    failure: BrowserFailure | null
  ): { state: BrowserState; failure: BrowserFailure | null } {
    return { state: this.state(record), failure }
  }

  private state(record: BrowserRecord): BrowserState {
    const contents = this.contents(record)
    const status =
      contents === null
        ? 'empty'
        : record.error !== null
          ? 'error'
          : record.loading
            ? 'loading'
            : 'ready'
    return {
      status,
      live: contents !== null,
      url: contents === null ? record.pendingUrl : clampUrl(contents.getURL()),
      title: record.title,
      icon: record.icon,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      documentId: contents === null ? null : record.documentId,
      passwordOrigin: this.currentOrigin(record),
      zoom: contents?.getZoomFactor() ?? 1,
      error: record.error,
    }
  }

  private push(record: BrowserRecord, push: BrowserPush): void {
    if (record.closed || record.owner.isDestroyed()) return
    this.deps.deliver(record.owner, push)
  }

  private pushState(record: BrowserRecord): void {
    this.push(record, { kind: 'state', browserId: record.id, state: this.state(record) })
    this.swipeState(record)
  }

  private swipeState(record: BrowserRecord): void {
    const contents = this.contents(record)
    if (record.scope.kind !== 'web' || contents === null || record.closed) return
    const frame = contents.mainFrame
    if (frame.detached) return
    const state: BrowserPageSwipeState = {
      back: contents.navigationHistory.canGoBack(),
      forward: contents.navigationHistory.canGoForward(),
      zoom: contents.getZoomFactor(),
      revision: record.navigation,
    }
    frame.send(BROWSER_PAGE_SWIPE_STATE_CHANNEL, state)
  }

  private shareFavorites(projectId: string, favorites: BrowserFavorite[]): void {
    for (const record of this.records.values()) {
      if (record.scope.kind !== 'project' || record.scope.projectId !== projectId) continue
      this.push(record, { kind: 'favorites', browserId: record.id, favorites })
    }
  }

  private async favoritesOf(record: BrowserRecord): Promise<BrowserFavorite[]> {
    if (record.scope.kind !== 'project') return []
    return [...(await this.deps.settings.project(record.scope.projectId)).settings.favorites]
  }

  private zoom(record: BrowserRecord, direction: -1 | 0 | 1): void {
    const contents = this.contents(record)
    if (contents === null) return
    contents.setZoomFactor(browserZoomStep(contents.getZoomFactor(), direction))
    const origin = new URL(contents.getURL() || 'about:blank').origin
    for (const other of this.records.values()) {
      const page = this.contents(other)
      if (page === null || new URL(page.getURL() || 'about:blank').origin !== origin) continue
      this.pushState(other)
    }
  }

  private load(record: BrowserRecord, url: string): BrowserFailure | null {
    if (!isBrowserNavigable(url)) return 'blocked-address'
    const view = this.ensureView(record)
    if (view === null) return 'failed'
    record.pendingUrl = null
    record.error = null
    const history = record.history
    record.history = null
    if (history !== null) {
      view.webContents.navigationHistory.restore(history).catch(() => undefined)
      return null
    }
    view.webContents.loadURL(url).catch(() => undefined)
    return null
  }

  private ensureView(record: BrowserRecord): WebContentsView | null {
    if (record.view !== null) return record.view
    if (record.closed || record.owner.isDestroyed()) return null
    const parent = BrowserWindow.fromWebContents(record.owner)
    if (parent === null) return null
    const view = new WebContentsView({ webPreferences: this.preferences(true, record.scope.kind) })
    const mounted = this.mountView(record, view)
    if (mounted === null && !view.webContents.isDestroyed()) view.webContents.close()
    return mounted
  }

  private mountView(record: BrowserRecord, view: WebContentsView): WebContentsView | null {
    const parent = BrowserWindow.fromWebContents(record.owner)
    if (parent === null || parent.isDestroyed() || record.closed) return null
    view.setBackgroundColor(PAGE_BACKGROUND)
    const contents = view.webContents
    browserPages.add(contents)
    record.view = view
    record.live = record.wanted
    this.guard(contents, record)
    this.observe(contents, record)
    this.listen(contents, record)
    if (record.scope.kind === 'project') {
      this.deps.console?.mounted({
        browserId: record.id,
        projectId: record.scope.projectId,
        owner: record.owner,
        contents,
      })
    }
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setVisible(false)
    parent.contentView.addChildView(view)
    if (record.live) this.place(record)
    const participant: OverlayParticipant = {
      id: record.id,
      owner: record.owner,
      view,
      shown: () => record.live && !record.closed && record.view === view,
    }
    record.participant = participant
    record.unregister = registerOverlayParticipant(participant)
    this.openDock(record)
    return view
  }

  private openDock(record: BrowserRecord): void {
    if (
      record.scope.kind !== 'project' ||
      record.devtools !== null ||
      record.closed ||
      record.owner.isDestroyed()
    ) {
      return
    }
    const contents = this.contents(record)
    const parent = BrowserWindow.fromWebContents(record.owner)
    if (contents === null || parent === null || parent.isDestroyed()) return
    const view = new WebContentsView({
      webPreferences: {
        preload: this.deps.devtoolsPreloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    view.webContents.ipc.on(BROWSER_DEVTOOLS_ROW_WHEEL_CHANNEL, (event, payload: unknown) => {
      if (record.closed || record.devtools?.view !== view) return
      const url = event.senderFrame?.url
      if (url === undefined) return
      try {
        if (new URL(url).protocol !== 'devtools:') return
      } catch {
        return
      }
      const parsed = BrowserPageRowWheel.safeParse(payload)
      if (!parsed.success) return
      this.push(record, { kind: 'devtools-row-wheel', browserId: record.id, wheel: parsed.data })
    })
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setVisible(false)
    parent.contentView.addChildView(view)
    contents.setDevToolsWebContents(view.webContents)
    contents.openDevTools({ mode: 'detach', activate: false })
    const participant: OverlayParticipant = {
      id: `${record.id}:devtools`,
      owner: record.owner,
      view,
      shown: () => record.devtoolsShown && record.devtools?.view === view,
    }
    const lost = (): void => {
      if (record.devtools?.view !== view) return
      this.closeDock(record)
      this.openDock(record)
    }
    view.webContents.once('destroyed', lost)
    view.webContents.on('render-process-gone', lost)
    record.devtools = { view, participant, unregister: registerOverlayParticipant(participant) }
    this.placeDock(record)
    applyParticipant(participant)
  }

  private closeDock(record: BrowserRecord): void {
    const dock = record.devtools
    if (dock === null) return
    record.devtools = null
    dock.unregister()
    const contents = this.contents(record)
    if (contents !== null) contents.closeDevTools()
    const parent = record.owner.isDestroyed() ? null : BrowserWindow.fromWebContents(record.owner)
    if (parent !== null && !parent.isDestroyed()) parent.contentView.removeChildView(dock.view)
    if (!dock.view.webContents.isDestroyed()) dock.view.webContents.close()
  }

  private placeDock(record: BrowserRecord): void {
    const view = record.devtools?.view
    const rect = record.devtoolsRect
    if (view === undefined || rect === null || view.webContents.isDestroyed()) return
    if (rect.width === 0 || rect.height === 0) {
      const bounds = view.getBounds()
      view.setBounds({
        x: -Math.max(1, bounds.width),
        y: -Math.max(1, bounds.height),
        width: bounds.width,
        height: bounds.height,
      })
      return
    }
    const scale = currentScale()
    view.setBounds({
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    })
  }

  private place(record: BrowserRecord): void {
    const view = record.view
    const rect = record.rect
    if (view === null || rect === null || view.webContents.isDestroyed()) return
    if (rect.width === 0 || rect.height === 0) {
      const bounds = view.getBounds()
      view.setBounds({
        x: -Math.max(1, bounds.width),
        y: -Math.max(1, bounds.height),
        width: bounds.width,
        height: bounds.height,
      })
      return
    }
    const scale = currentScale()
    view.setBounds({
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    })
  }

  private apply(record: BrowserRecord): void {
    if (record.participant !== null) applyParticipant(record.participant)
  }

  private release(record: BrowserRecord): void {
    if (record.closed) return
    record.closed = true
    this.records.delete(record.id)
    this.cancelIcon(record)
    this.clearCredential(record, false)
    record.identifier = null
    record.token = null
    record.autofill = null
    for (const popup of [...record.popups]) if (!popup.isDestroyed()) popup.destroy()
    record.popups.clear()
    this.releaseView(record)
  }

  private releaseView(record: BrowserRecord): void {
    this.closeDock(record)
    const view = record.view
    record.view = null
    record.live = false
    record.participant = null
    record.unregister?.()
    record.unregister = null
    if (view === null) return
    if (record.scope.kind === 'project') this.deps.console?.released(view.webContents)
    const parent = record.owner.isDestroyed() ? null : BrowserWindow.fromWebContents(record.owner)
    if (parent !== null && !parent.isDestroyed()) parent.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private discard(record: BrowserRecord, contents: WebContents): void {
    if (record.closed || record.view?.webContents !== contents) return
    record.pendingUrl = record.url ?? record.pendingUrl
    record.url = null
    record.loading = false
    record.documentId = null
    record.token = null
    record.identifier = null
    record.autofill = null
    this.cancelIcon(record)
    this.clearCredential(record, true)
    for (const popup of [...record.popups]) if (!popup.isDestroyed()) popup.destroy()
    record.popups.clear()
    this.releaseView(record)
    this.pushState(record)
  }

  private guard(contents: WebContents, record: BrowserRecord): void {
    contents.on('will-navigate', (event, url) => {
      if (!isBrowserNavigable(url)) event.preventDefault()
    })
    contents.on('will-redirect', (details) => {
      const allowed = details.isMainFrame
        ? isBrowserNavigable(details.url)
        : frameNavigable(details.url)
      if (!allowed) details.preventDefault()
    })
    contents.on('will-frame-navigate', (details) => {
      const allowed = details.isMainFrame
        ? isBrowserNavigable(details.url)
        : frameNavigable(details.url)
      if (!allowed) details.preventDefault()
    })
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    contents.setWindowOpenHandler((details) =>
      record.scope.kind === 'web' && record.view?.webContents === contents
        ? this.openFromWebTab(record, details)
        : this.openPopup(record, details)
    )
    contents.on('did-create-window', (window) => {
      this.adoptPopup(record, window)
    })
  }

  private contextMenu(
    record: BrowserRecord,
    contents: WebContents,
    params: ContextMenuParams
  ): void {
    const view = record.view
    if (record.closed || contents.isDestroyed() || view?.webContents !== contents) return
    const parent = BrowserWindow.fromWebContents(record.owner)
    if (parent === null || parent.isDestroyed()) return
    const items = browserContextMenu(params, {
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      canOpenTab: this.canOpenTabIn(this.deps.mainOwner()),
    })
    const text = Array.from(params.selectionText.trim().slice(0, 80)).slice(0, 40).join('')
    const template: MenuItemConstructorOptions[] = items.map((item) => {
      if (item.kind === 'separator') return { type: 'separator' }
      const label = mainT(`browserMenu.${item.id}`, { text })
      return {
        label: process.platform === 'darwin' ? label : label.replace(/&/g, '&&'),
        enabled: item.enabled,
        click: () => {
          if (record.closed || contents.isDestroyed() || record.view?.webContents !== contents) {
            return
          }
          this.menuAction(record, contents, params, item.id)
        },
      }
    })
    const bounds = view.getBounds()
    const frame = params.frame
    Menu.buildFromTemplate(template).popup({
      window: parent,
      sourceType: params.menuSourceType,
      ...(frame === null ? {} : { frame }),
      ...(params.menuSourceType === 'keyboard'
        ? { x: bounds.x + params.x, y: bounds.y + params.y }
        : {}),
    })
  }

  private menuAction(
    record: BrowserRecord,
    contents: WebContents,
    params: ContextMenuParams,
    action: BrowserMenuAction
  ): void {
    switch (action) {
      case 'link-new-tab':
        this.openInNewTab(record, params.linkURL, true)
        break
      case 'image-new-tab':
        this.openInNewTab(record, params.srcURL, true)
        break
      case 'selection-search': {
        const url = browserSearchUrl(params.selectionText)
        if (url !== null) this.openInNewTab(record, url, false)
        break
      }
      case 'link-external':
        if (isBrowserNavigable(params.linkURL)) {
          shell.openExternal(params.linkURL).catch(() => undefined)
        }
        break
      case 'link-copy':
        clipboard.writeText(params.linkURL)
        break
      case 'image-copy-address':
        clipboard.writeText(params.srcURL)
        break
      case 'image-copy':
        contents.copyImageAt(params.x, params.y)
        break
      case 'link-save':
      case 'image-save': {
        const url = action === 'link-save' ? params.linkURL : params.srcURL
        if (isBrowserNavigable(url)) {
          this.deps.downloads.expect(contents)
          contents.downloadURL(url)
        }
        break
      }
      case 'selection-copy':
      case 'copy':
        contents.copy()
        break
      case 'undo':
        contents.undo()
        break
      case 'redo':
        contents.redo()
        break
      case 'cut':
        contents.cut()
        break
      case 'paste':
        contents.paste()
        break
      case 'select-all':
        contents.selectAll()
        break
      case 'back':
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
        break
      case 'forward':
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
        break
      case 'reload':
        contents.reload()
        break
      case 'inspect':
        if (record.scope.kind === 'web') contents.openDevTools({ mode: 'detach' })
        contents.inspectElement(params.x, params.y)
        if (record.scope.kind === 'project') {
          this.push(record, { kind: 'devtools', browserId: record.id, action: 'show' })
        }
        break
    }
  }

  private openInNewTab(source: BrowserRecord, url: string, background: boolean): void {
    if (source.closed || !isBrowserNavigable(url)) return
    const main = this.deps.mainOwner()
    const target = source.owner === main ? source.owner : main
    if (!this.canOpenTabIn(target)) return
    this.watch(target)
    let record: BrowserRecord | null = null
    try {
      const webTabId = randomUUID()
      record = this.createRecord(target, { kind: 'web', webTabId }, source.settings, {
        url,
        title: '',
        icon: null,
      })
      const view = this.ensureView(record)
      if (view === null) {
        this.release(record)
        return
      }
      view.webContents.loadURL(url).catch(() => undefined)
      this.savePage(record)
      this.push(record, {
        kind: 'tab-open',
        browserId: record.id,
        webTabId,
        openerWebTabId: source.scope.kind === 'web' ? source.scope.webTabId : null,
        background,
        state: this.state(record),
      })
    } catch {
      if (record !== null) this.release(record)
    }
  }

  private openFromWebTab(
    record: BrowserRecord,
    details: HandlerDetails
  ): WindowOpenHandlerResponse {
    if (details.disposition === 'new-window') return this.openPopup(record, details)
    if (record.closed || !isBrowserNavigable(details.url) || !this.mayOpenWeb(record.owner)) {
      return { action: 'deny' }
    }
    this.holdOpen(record.owner)
    const generation = this.generations.get(record.owner) ?? 0
    return {
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences: this.preferences(true, 'web') },
      createWindow: (options) =>
        this.adoptTab(record, details, guestOf(options) ? options.webContents : null, generation),
    }
  }

  private adoptTab(
    opener: BrowserRecord,
    details: HandlerDetails,
    guest: WebContents | null,
    generation: number
  ): WebContents {
    if ((this.generations.get(opener.owner) ?? 0) !== generation) return this.refuseTab(guest)
    this.releaseOpen(opener.owner)
    if (opener.scope.kind !== 'web' || !this.mayOpenWeb(opener.owner)) return this.refuseTab(guest)
    let view: WebContentsView | null = null
    let record: BrowserRecord | null = null
    try {
      view =
        guest === null
          ? new WebContentsView({ webPreferences: this.preferences(true, 'web') })
          : new WebContentsView({ webContents: guest })
      const webTabId = randomUUID()
      record = this.createRecord(opener.owner, { kind: 'web', webTabId }, opener.settings, {
        url: null,
        title: '',
        icon: null,
      })
      if (this.mountView(record, view) === null) {
        this.release(record)
        return this.refuseTab(view.webContents)
      }
      this.push(record, {
        kind: 'tab-open',
        browserId: record.id,
        webTabId,
        openerWebTabId: opener.scope.webTabId,
        background: details.disposition === 'background-tab',
        state: this.state(record),
      })
      if (guest === null) {
        view.webContents
          .loadURL(details.url, {
            httpReferrer: details.referrer,
            ...(details.postBody === undefined
              ? {}
              : {
                  postData: details.postBody.data,
                  extraHeaders: contentTypeHeader(details.postBody),
                }),
          })
          .catch(() => undefined)
      }
      return view.webContents
    } catch {
      if (record !== null) this.release(record)
      return this.refuseTab(view?.webContents ?? guest)
    }
  }

  private refuseTab(guest: WebContents | null): WebContents {
    const contents =
      guest ?? new WebContentsView({ webPreferences: this.preferences(true, 'web') }).webContents
    if (!contents.isDestroyed()) contents.close()
    return contents
  }

  private openPopup(record: BrowserRecord, details: HandlerDetails): WindowOpenHandlerResponse {
    if (record.closed || record.popups.size >= POPUPS_MAX || !isBrowserNavigable(details.url)) {
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: POPUP_WIDTH,
        height: POPUP_HEIGHT,
        autoHideMenuBar: true,
        webPreferences: this.preferences(false, record.scope.kind),
      },
    }
  }

  private adoptPopup(record: BrowserRecord, window: BrowserWindow): void {
    if (record.closed) {
      window.destroy()
      return
    }
    record.popups.add(window)
    browserPages.add(window.webContents)
    this.guard(window.webContents, record)
    window.once('closed', () => {
      record.popups.delete(window)
    })
  }

  private observe(contents: WebContents, record: BrowserRecord): void {
    contents.on('context-menu', (_event, params) => {
      this.contextMenu(record, contents, params)
    })
    if (record.scope.kind === 'web') {
      contents.on('input-event', (_event, input) => {
        if (input.type !== 'gestureScrollBegin' && input.type !== 'gestureScrollEnd') return
        if (record.closed || this.contents(record) !== contents) return
        const frame = contents.mainFrame
        if (frame.detached) return
        if (input.type === 'gestureScrollBegin') record.swipeSequence += 1
        const message: BrowserPageSwipeSequence = {
          phase: input.type === 'gestureScrollBegin' ? 'begin' : 'end',
          sequence: record.swipeSequence,
        }
        frame.send(BROWSER_PAGE_SWIPE_SEQUENCE_CHANNEL, message)
      })
      contents.on('before-input-event', (event, input) => {
        const command = browserWebCommand(input, process.platform)
        if (command === null) return
        event.preventDefault()
        this.push(record, { kind: 'command', browserId: record.id, command })
      })
      contents.on('found-in-page', (_event, result) => {
        if (!result.finalUpdate || result.requestId !== record.findRequest) return
        this.push(record, {
          kind: 'found',
          browserId: record.id,
          matches: result.matches,
          active: result.activeMatchOrdinal,
        })
      })
      contents.on('zoom-changed', (_event, direction) => {
        this.zoom(record, direction === 'in' ? 1 : -1)
      })
    }
    contents.on('did-start-loading', () => {
      record.loading = true
      this.pushState(record)
    })
    contents.on('did-stop-loading', () => {
      record.loading = false
      this.pushState(record)
    })
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      record.navigation += 1
      record.findRequest = null
      if (!details.isSameDocument) record.error = null
    })
    contents.on('did-navigate', (_event, url) => {
      record.url = clampUrl(url)
      record.documentId = randomUUID()
      record.autofill = null
      record.title = ''
      record.icon = null
      this.cancelIcon(record)
      this.committed(record, true)
      this.pushState(record)
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      record.url = clampUrl(url)
      this.committed(record, false)
      this.pushState(record)
      this.probe(record)
    })
    contents.on('did-finish-load', () => {
      this.probe(record)
    })
    contents.on('page-title-updated', (_event, title) => {
      record.title = title.slice(0, BROWSER_TITLE_MAX)
      this.savePage(record)
      this.pushState(record)
    })
    contents.on('page-favicon-updated', (_event, favicons) => {
      void this.fetchIcon(record, favicons)
    })
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      record.error = { code, description: description.slice(0, BROWSER_ERROR_MAX) }
      this.pushState(record)
    })
    contents.on('render-process-gone', (_event, details) => {
      record.error = { code: -1, description: details.reason.slice(0, BROWSER_ERROR_MAX) }
      record.loading = false
      this.clearCredential(record, true)
      record.token = null
      this.pushState(record)
    })
    contents.once('destroyed', () => {
      this.discard(record, contents)
    })
  }

  private listen(contents: WebContents, record: BrowserRecord): void {
    contents.ipc.on(BROWSER_PAGE_SWIPE_CHANNEL, (event, payload: unknown) => {
      if (record.scope.kind !== 'web' || !this.showing(record)) return
      if (record.view?.getVisible() !== true || this.senderOrigin(record, event) === null) return
      const parsed = BrowserPageSwipe.safeParse(payload)
      if (!parsed.success || parsed.data.revision !== record.navigation) return
      const history = contents.navigationHistory
      if (parsed.data.direction === 'back' && history.canGoBack()) history.goBack()
      if (parsed.data.direction === 'forward' && history.canGoForward()) history.goForward()
    })
    contents.ipc.on(BROWSER_PAGE_ROW_WHEEL_CHANNEL, (event, payload: unknown) => {
      if (
        record.scope.kind !== 'project' ||
        record.closed ||
        this.senderOrigin(record, event) === null
      ) {
        return
      }
      const parsed = BrowserPageRowWheel.safeParse(payload)
      if (!parsed.success) return
      this.push(record, { kind: 'row-wheel', browserId: record.id, wheel: parsed.data })
    })
    contents.ipc.on(BROWSER_PAGE_READY_CHANNEL, (event, payload: unknown) => {
      const origin = this.senderOrigin(record, event)
      if (origin === null) return
      const parsed = BrowserPageReady.safeParse(payload)
      if (parsed.success && record.scope.kind === 'project') {
        contents.mainFrame.send(BROWSER_PAGE_ROW_WHEEL_ENABLE_CHANNEL)
      }
      if (parsed.success && record.scope.kind === 'web') this.swipeState(record)
      record.token =
        parsed.success && isBrowserPasswordOrigin(origin)
          ? { value: parsed.data.documentToken, origin }
          : null
      this.probe(record)
    })
    contents.ipc.on(BROWSER_PAGE_CANDIDATE_CHANNEL, (event, payload: unknown) => {
      const origin = this.senderOrigin(record, event)
      const token = record.token
      const parsed = BrowserPageCandidate.safeParse(payload)
      if (origin === null || token === null || !parsed.success) return
      if (token.origin !== origin || parsed.data.documentToken !== token.value) return
      this.capture(record, origin, parsed.data)
    })
    contents.ipc.on(BROWSER_PAGE_FORM_CHANNEL, (event, payload: unknown) => {
      const origin = this.senderOrigin(record, event)
      const token = record.token
      const parsed = BrowserPageForm.safeParse(payload)
      if (origin === null || token === null || !parsed.success) return
      if (token.origin !== origin || parsed.data.documentToken !== token.value) return
      if (!isBrowserPasswordOrigin(origin)) return
      this.autofill(record, parsed.data.phase).catch(() => undefined)
    })
  }

  private async autofill(record: BrowserRecord, phase: BrowserFormPhase): Promise<void> {
    if (!this.showing(record)) return
    const identity = this.identity(record)
    if (identity === null) return
    const key = `${identity.token}:${identity.documentId}:${String(identity.navigation)}`
    const state: AutofillState =
      record.autofill?.key === key
        ? record.autofill
        : { key, pending: new Set(), settled: new Set(), deliveries: new Map() }
    if (state.pending.has(phase) || state.settled.has(phase)) return
    if ((state.deliveries.get(phase) ?? 0) >= BROWSER_AUTOFILL_DELIVERIES_MAX) return
    state.pending.add(phase)
    record.autofill = state
    const outcome = await this.attemptAutofill(record, identity).catch(
      (): AutofillOutcome => 'interrupted'
    )
    state.pending.delete(phase)
    if (record.autofill !== state) return
    if (outcome === 'settled') state.settled.add(phase)
    if (outcome === 'delivered') state.deliveries.set(phase, (state.deliveries.get(phase) ?? 0) + 1)
  }

  private async attemptAutofill(
    record: BrowserRecord,
    identity: PageIdentity
  ): Promise<AutofillOutcome> {
    const listed = await this.deps.vault.accounts(identity.origin)
    if (!this.stillShowing(record, identity)) return 'interrupted'
    const only = listed.accounts.length === 1 ? listed.accounts[0] : undefined
    if (listed.storage !== 'ready' || only === undefined) return 'settled'
    const credential = await this.deps.vault.credential(identity.origin, only.id)
    if (!this.stillShowing(record, identity)) return 'interrupted'
    if (credential === null) return 'settled'
    this.deliver(identity, credential, 'automatic')
    return 'delivered'
  }

  private showing(record: BrowserRecord): boolean {
    return !record.closed && record.live && record.wanted
  }

  private stillShowing(record: BrowserRecord, identity: PageIdentity): boolean {
    return this.showing(record) && this.unchanged(record, identity)
  }

  private deliver(
    identity: PageIdentity,
    credential: BrowserVaultCredential,
    mode: BrowserFillMode
  ): void {
    const message: BrowserPageFill = {
      documentToken: identity.token,
      origin: identity.origin,
      username: credential.username,
      password: credential.password,
      mode,
    }
    identity.contents.mainFrame.send(BROWSER_PAGE_FILL_CHANNEL, message)
  }

  private probe(record: BrowserRecord): void {
    const identity = this.identity(record)
    if (identity === null || !this.showing(record)) return
    const message: BrowserPageScan = { documentToken: identity.token }
    identity.contents.mainFrame.send(BROWSER_PAGE_SCAN_CHANNEL, message)
  }

  private senderOrigin(record: BrowserRecord, event: IpcMainEvent): string | null {
    const contents = this.contents(record)
    const frame = event.senderFrame
    if (contents === null || event.sender !== contents) return null
    if (frame === null || frame !== contents.mainFrame) return null
    return frame.origin
  }

  private capture(record: BrowserRecord, origin: string, candidate: BrowserPageCandidate): void {
    if (!isBrowserPasswordOrigin(origin)) return
    const now = Date.now()
    if (candidate.kind === 'identifier') {
      record.identifier = { origin, username: candidate.username, expires: now + IDENTIFIER_TTL_MS }
      return
    }
    const remembered = record.identifier
    const recalled =
      remembered !== null && remembered.origin === origin && remembered.expires > now
        ? remembered.username
        : ''
    record.identifier = null
    this.clearCredential(record, true)
    const pending: PendingCredential = {
      candidateId: randomUUID(),
      origin,
      username: candidate.username === '' ? recalled : candidate.username,
      password: candidate.password,
      prompt: null,
      timer: null,
    }
    record.credential = pending
    this.arm(record, pending, CANDIDATE_TTL_MS)
  }

  private committed(record: BrowserRecord, crossDocument: boolean): void {
    if (record.scope.kind === 'web') this.savePage(record)
    else if (record.url !== null) {
      this.deps.settings.setLastUrl(record.scope.projectId, record.url).catch(() => null)
    }
    const pending = record.credential
    if (pending === null) return
    if (pending.prompt !== null) {
      if (crossDocument && pending.prompt.documentId !== record.documentId) {
        this.clearCredential(record, true)
      }
      return
    }
    void this.offer(record, pending)
  }

  private savePage(record: BrowserRecord): void {
    if (record.scope.kind !== 'web' || record.closed) return
    this.deps.settings
      .setWebTabPage(record.scope.webTabId, {
        url: record.url ?? record.pendingUrl,
        title: record.title,
        icon: record.icon,
      })
      .catch(() => null)
  }

  private async offer(record: BrowserRecord, pending: PendingCredential): Promise<void> {
    const documentId = record.documentId
    if (documentId === null) return
    const mode = await this.deps.vault.classify(pending.origin, pending.username, pending.password)
    if (record.closed || record.credential !== pending || pending.prompt !== null) return
    if (record.documentId !== documentId) return
    if (mode !== 'save' && mode !== 'update') {
      this.clearCredential(record, true)
      return
    }
    pending.prompt = {
      candidateId: pending.candidateId,
      documentId,
      origin: pending.origin,
      username: pending.username,
      mode,
    }
    this.arm(record, pending, PROMPT_TTL_MS)
    this.push(record, { kind: 'prompt', browserId: record.id, prompt: pending.prompt })
  }

  private arm(record: BrowserRecord, pending: PendingCredential, ttl: number): void {
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      if (record.credential === pending) this.clearCredential(record, true)
    }, ttl)
  }

  private clearCredential(record: BrowserRecord, notify: boolean): void {
    const pending = record.credential
    if (pending === null) return
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.timer = null
    record.credential = null
    if (notify && pending.prompt !== null) {
      this.push(record, { kind: 'prompt', browserId: record.id, prompt: null })
    }
  }

  private persistDecision(
    pending: PendingCredential,
    decision: BrowserPasswordDecision
  ): Promise<BrowserFailure | null> {
    switch (decision) {
      case 'save':
      case 'update':
        return this.deps.vault.save(pending.origin, pending.username, pending.password)
      case 'never':
        return this.deps.vault.never(pending.origin)
      case 'dismiss':
        return Promise.resolve(null)
    }
  }

  private currentOrigin(record: BrowserRecord): string | null {
    const contents = this.contents(record)
    if (contents === null) return null
    const origin = browserPasswordOrigin(contents.getURL())
    return origin !== null && contents.mainFrame.origin === origin ? origin : null
  }

  private identity(record: BrowserRecord): PageIdentity | null {
    const contents = this.contents(record)
    const origin = this.currentOrigin(record)
    const token = record.token
    const documentId = record.documentId
    if (contents === null || origin === null || token === null || documentId === null) return null
    if (token.origin !== origin) return null
    return { contents, origin, token: token.value, documentId, navigation: record.navigation }
  }

  private unchanged(record: BrowserRecord, before: PageIdentity): boolean {
    const now = this.identity(record)
    return (
      now !== null &&
      now.contents === before.contents &&
      now.origin === before.origin &&
      now.token === before.token &&
      now.documentId === before.documentId &&
      now.navigation === before.navigation
    )
  }

  private async passwordsFor(origin: string | null): Promise<BrowserPasswords> {
    if (origin === null) {
      return {
        storage: await this.deps.vault.storage(),
        origin: null,
        accounts: [],
        neverSave: false,
      }
    }
    const listed = await this.deps.vault.accounts(origin)
    return {
      storage: listed.storage,
      origin,
      accounts: listed.accounts.map((account) => ({ ...account })),
      neverSave: listed.neverSave,
    }
  }

  private cancelIcon(record: BrowserRecord): void {
    record.favicon?.abort()
    record.favicon = null
  }

  private async fetchIcon(record: BrowserRecord, favicons: readonly string[]): Promise<void> {
    this.cancelIcon(record)
    const source = favicons.find((url) => /^https?:/i.test(url) && url.length <= BROWSER_URL_MAX)
    if (source === undefined || record.closed) return
    const controller = new AbortController()
    record.favicon = controller
    const documentId = record.documentId
    const timer = setTimeout(() => {
      controller.abort()
    }, FAVICON_TIMEOUT_MS)
    try {
      const icon = await readIcon(this.session(), source, controller.signal)
      if (icon === null || record.favicon !== controller) return
      if (record.documentId !== documentId) return
      record.icon = icon
      this.savePage(record)
      this.pushState(record)
    } catch {
      return
    } finally {
      clearTimeout(timer)
      if (record.favicon === controller) record.favicon = null
    }
  }
}
