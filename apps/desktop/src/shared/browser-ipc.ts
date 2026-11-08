import { z } from 'zod'
import { WEB_TABS_MAX } from './workspace-layout.js'

export const BROWSER_FRAME_CHANNEL = 'browser:frame'
export const BROWSER_FRAME_MAX = 1_500_000
export const BROWSER_ID_MAX = 128
export const BROWSER_MISSING_CODE = -201
export const BROWSER_STOPPED_CODE = -202
export const BROWSER_PROJECT_ID_MAX = 256
export const BROWSER_URL_MAX = 8192
export const BROWSER_ADDRESS_MAX = 8192
export const BROWSER_SEARCH_MAX = 2048
export const BROWSER_HOME_URL = 'https://www.google.com/'
export const BROWSER_ORIGIN_MAX = 2048
export const BROWSER_TITLE_MAX = 512
export const BROWSER_ICON_MAX = 32_768
export const BROWSER_STILL_MAX = 16_000_000
export const BROWSER_ERROR_MAX = 512
export const BROWSER_FAVORITES_MAX = 48
export const BROWSER_USERNAME_MAX = 1024
export const BROWSER_PASSWORD_MAX = 8192
export const BROWSER_ACCOUNTS_MAX = 64
export const BROWSER_RECT_MAX = 32_768
export const BROWSER_REVISION_MAX = Number.MAX_SAFE_INTEGER
export const BROWSER_WHEEL_DELTA_MAX = 10_000
export const BROWSER_FIND_MAX = 1024
export const BROWSER_DOWNLOADS_MAX = 50
export const BROWSER_CLOSED_MAX = 20
export const BROWSER_ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const

export const BrowserId = z.string().min(1).max(BROWSER_ID_MAX)
export const BrowserProjectId = z.string().min(1).max(BROWSER_PROJECT_ID_MAX)
export const BrowserWebTabId = z.string().regex(/^[A-Za-z0-9-]{1,128}$/)
export const BrowserUrl = z.string().min(1).max(BROWSER_URL_MAX)
export const BrowserOrigin = z.string().min(1).max(BROWSER_ORIGIN_MAX)
export const BrowserTitle = z.string().max(BROWSER_TITLE_MAX)
export const BrowserIcon = z
  .string()
  .max(BROWSER_ICON_MAX)
  .regex(
    /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/
  )
export const BrowserStill = z.string().max(BROWSER_STILL_MAX).startsWith('data:image/jpeg;base64,')
export const BrowserRevision = z.number().int().nonnegative().max(BROWSER_REVISION_MAX)
export const BrowserUsername = z.string().max(BROWSER_USERNAME_MAX)
export const BrowserPassword = z.string().min(1).max(BROWSER_PASSWORD_MAX)
export const BrowserDocumentToken = z.string().regex(/^[A-Za-z0-9-]{16,128}$/)

export const BrowserRect = z
  .object({
    x: z.number().int().min(-BROWSER_RECT_MAX).max(BROWSER_RECT_MAX),
    y: z.number().int().min(-BROWSER_RECT_MAX).max(BROWSER_RECT_MAX),
    width: z.number().int().nonnegative().max(BROWSER_RECT_MAX),
    height: z.number().int().nonnegative().max(BROWSER_RECT_MAX),
  })
  .strict()
export type BrowserRect = z.infer<typeof BrowserRect>

const BrowserCoordinate = z.number().min(-BROWSER_RECT_MAX).max(BROWSER_RECT_MAX)

export const BrowserPoint = z.object({ x: BrowserCoordinate, y: BrowserCoordinate }).strict()
export type BrowserPoint = z.infer<typeof BrowserPoint>

export const BrowserFavorite = z
  .object({
    id: BrowserId,
    url: BrowserUrl,
    title: BrowserTitle,
    icon: BrowserIcon.nullable(),
  })
  .strict()
export type BrowserFavorite = z.infer<typeof BrowserFavorite>

export const BrowserFavorites = z.array(BrowserFavorite).max(BROWSER_FAVORITES_MAX)

export const BrowserDownload = z
  .object({
    id: BrowserId,
    filename: z.string().min(1).max(BROWSER_TITLE_MAX),
    state: z.enum(['progressing', 'paused', 'completed', 'cancelled', 'interrupted']),
    received: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
export type BrowserDownload = z.infer<typeof BrowserDownload>

export const BrowserDownloads = z.array(BrowserDownload).max(BROWSER_DOWNLOADS_MAX)
export type BrowserDownloads = z.infer<typeof BrowserDownloads>

export const BrowserStatus = z.enum(['empty', 'loading', 'ready', 'error'])
export type BrowserStatus = z.infer<typeof BrowserStatus>

export const BrowserLoadError = z
  .object({
    code: z.number().int(),
    description: z.string().max(BROWSER_ERROR_MAX),
  })
  .strict()
export type BrowserLoadError = z.infer<typeof BrowserLoadError>

export const BrowserState = z
  .object({
    status: BrowserStatus,
    live: z.boolean(),
    url: BrowserUrl.nullable(),
    title: BrowserTitle,
    icon: BrowserIcon.nullable(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    documentId: BrowserId.nullable(),
    passwordOrigin: BrowserOrigin.nullable(),
    error: BrowserLoadError.nullable(),
    zoom: z.number().min(0.25).max(5),
  })
  .strict()
export type BrowserState = z.infer<typeof BrowserState>

export const BrowserFailure = z.enum([
  'unknown-project',
  'unknown-browser',
  'invalid-address',
  'blocked-address',
  'not-loaded',
  'not-eligible',
  'not-found',
  'stale-document',
  'stale-candidate',
  'limit',
  'settings-corrupt',
  'settings-unreadable',
  'storage-unavailable',
  'storage-locked',
  'storage-corrupt',
  'storage-unreadable',
  'failed',
])
export type BrowserFailure = z.infer<typeof BrowserFailure>

export const BrowserSettingsStatus = z.enum(['ready', 'corrupt', 'unreadable'])
export type BrowserSettingsStatus = z.infer<typeof BrowserSettingsStatus>

export const BrowserStorage = z.enum(['ready', 'unavailable', 'locked', 'corrupt', 'unreadable'])
export type BrowserStorage = z.infer<typeof BrowserStorage>

export const BrowserAction = z.enum([
  'back',
  'forward',
  'reload',
  'stop',
  'devtools',
  'external',
  'focus',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'find-stop',
])
export type BrowserAction = z.infer<typeof BrowserAction>

export const BrowserWebCommand = z.enum([
  'reveal',
  'new-tab',
  'close-tab',
  'reopen-tab',
  'focus-address',
  'find',
  'find-next',
  'find-previous',
  'back',
  'forward',
  'next-tab',
  'previous-tab',
  'move-tab-left',
  'move-tab-right',
])
export type BrowserWebCommand = z.infer<typeof BrowserWebCommand>

export const BrowserPasswordDecision = z.enum(['save', 'update', 'never', 'dismiss'])
export type BrowserPasswordDecision = z.infer<typeof BrowserPasswordDecision>

export const BrowserPasswordAccount = z
  .object({
    id: BrowserId,
    origin: BrowserOrigin,
    username: BrowserUsername,
  })
  .strict()
export type BrowserPasswordAccount = z.infer<typeof BrowserPasswordAccount>

export const BrowserPasswordPrompt = z
  .object({
    candidateId: BrowserId,
    documentId: BrowserId,
    origin: BrowserOrigin,
    username: BrowserUsername,
    mode: z.enum(['save', 'update']),
  })
  .strict()
export type BrowserPasswordPrompt = z.infer<typeof BrowserPasswordPrompt>

export const BrowserPasswords = z
  .object({
    storage: BrowserStorage,
    origin: BrowserOrigin.nullable(),
    accounts: z.array(BrowserPasswordAccount).max(BROWSER_ACCOUNTS_MAX),
    neverSave: z.boolean(),
  })
  .strict()
export type BrowserPasswords = z.infer<typeof BrowserPasswords>

export const BrowserProject = z.object({ projectId: BrowserProjectId }).strict()
export type BrowserProject = z.infer<typeof BrowserProject>

export const BrowserScope = z.union([
  BrowserProject,
  z.object({ webTabId: BrowserWebTabId }).strict(),
])
export type BrowserScope = z.infer<typeof BrowserScope>

export const BrowserTarget = z.object({ browserId: BrowserId }).strict()
export type BrowserTarget = z.infer<typeof BrowserTarget>

export const BrowserNavigateRequest = BrowserTarget.extend({
  address: z.string().min(1).max(BROWSER_ADDRESS_MAX),
}).strict()

export const BrowserActionRequest = BrowserTarget.extend({ action: BrowserAction }).strict()

export const BrowserFindRequest = BrowserTarget.extend({
  text: z.string().min(1).max(BROWSER_FIND_MAX),
  forward: z.boolean(),
  start: z.boolean(),
}).strict()

const BrowserWebTabIndex = z
  .number()
  .int()
  .nonnegative()
  .max(WEB_TABS_MAX - 1)

export const BrowserCloseRequest = BrowserTarget.extend({ index: BrowserWebTabIndex }).strict()

export const BrowserDownloadRequest = z
  .object({ downloadId: BrowserId, action: z.enum(['open', 'show', 'cancel', 'clear']) })
  .strict()

export const BrowserGeometryRequest = BrowserTarget.extend({
  revision: BrowserRevision,
  rect: BrowserRect,
  bodyOrigin: BrowserPoint,
  active: z.boolean(),
  fullyVisible: z.boolean(),
}).strict()

export const BrowserDevtoolsGeometryRequest = BrowserTarget.extend({
  revision: BrowserRevision,
  rect: BrowserRect,
  active: z.boolean(),
}).strict()

export const BrowserFavoriteRequest = BrowserTarget.extend({ favoriteId: BrowserId }).strict()

export const BrowserPasswordDecideRequest = BrowserTarget.extend({
  candidateId: BrowserId,
  decision: BrowserPasswordDecision,
}).strict()

export const BrowserPasswordFillRequest = BrowserTarget.extend({
  accountId: BrowserId,
  documentId: BrowserId,
}).strict()

export const BrowserPasswordRemoveRequest = BrowserTarget.extend({ accountId: BrowserId }).strict()

const BrowserStateResult = z
  .object({ state: BrowserState, failure: BrowserFailure.nullable() })
  .strict()

const BrowserFavoritesResult = z
  .object({ favorites: BrowserFavorites, failure: BrowserFailure.nullable() })
  .strict()

const BrowserPasswordsResult = z
  .object({ passwords: BrowserPasswords, failure: BrowserFailure.nullable() })
  .strict()

const BrowserOk = z.object({ ok: z.literal(true) }).strict()
const BrowserModifiers = z.number().int().min(0).max(15)
const BrowserButtons = z.number().int().min(0).max(31)
const BrowserGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const BrowserInstance = z.uuid()

export const BrowserInputEvent = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('mouse'),
      type: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved']),
      x: z.number(),
      y: z.number(),
      button: z.enum(['none', 'left', 'middle', 'right']),
      buttons: BrowserButtons,
      clickCount: z.number().int().min(0).max(3),
      modifiers: BrowserModifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal('wheel'),
      x: z.number(),
      y: z.number(),
      deltaX: z.number(),
      deltaY: z.number(),
      modifiers: BrowserModifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal('key'),
      type: z.enum(['rawKeyDown', 'keyDown', 'keyUp']),
      key: z.string().max(32),
      code: z.string().max(32),
      text: z.string().max(8).optional(),
      keyCode: z.number().int().min(0).max(255),
      autoRepeat: z.boolean(),
      modifiers: BrowserModifiers,
    })
    .strict(),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(10_000) }).strict(),
])
export type BrowserInputEvent = z.infer<typeof BrowserInputEvent>

export const BrowserStreamRequest = z
  .object({
    browserId: BrowserId,
    instance: BrowserInstance,
    generation: BrowserGeneration,
    visible: z.boolean(),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    scale: z.number().min(1).max(4),
  })
  .strict()
export type BrowserStreamRequest = z.infer<typeof BrowserStreamRequest>

export const BrowserFrame = z
  .object({
    browserId: BrowserId,
    instance: BrowserInstance,
    generation: BrowserGeneration,
    epoch: z.number().int().min(1),
    serial: z.number().int().min(1),
    data: z.string().max(BROWSER_FRAME_MAX),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict()
export type BrowserFrame = z.infer<typeof BrowserFrame>

export const SelectToken = z.string().regex(/^[0-9a-f]{32}$/)

export const BROWSER_CONTRACT = {
  'browser:stream': { request: BrowserStreamRequest, response: BrowserOk },
  'browser:input': {
    request: z.object({ browserId: BrowserId, event: BrowserInputEvent }).strict(),
    response: BrowserOk,
  },
  'browser:frameAck': {
    request: z
      .object({
        browserId: BrowserId,
        instance: BrowserInstance,
        generation: BrowserGeneration,
        serial: z.number().int().min(1),
      })
      .strict(),
    response: BrowserOk,
  },
  'browser:selectChoose': {
    request: z
      .object({ browserId: BrowserId, token: SelectToken, index: z.number().int().min(-1) })
      .strict(),
    response: BrowserOk,
  },
  'browser:dialogAnswer': {
    request: z
      .object({
        browserId: BrowserId,
        token: z.uuid(),
        accept: z.boolean(),
        text: z.string().max(10_000).optional(),
      })
      .strict(),
    response: BrowserOk,
  },
  'browser:selection': {
    request: z.object({ browserId: BrowserId }).strict(),
    response: z.object({ text: z.string().max(100_000) }).strict(),
  },
  'browser:webReady': {
    request: z.object({}).strict(),
    response: z.object({ ok: z.literal(true) }).strict(),
  },
  'browser:attach': {
    request: BrowserScope,
    response: z
      .object({
        browserId: BrowserId,
        state: BrowserState,
        favorites: BrowserFavorites,
        settings: BrowserSettingsStatus,
      })
      .strict(),
  },
  'browser:detach': {
    request: BrowserTarget,
    response: z.object({ ok: z.literal(true) }).strict(),
  },
  'browser:restore': {
    request: BrowserTarget,
    response: BrowserStateResult,
  },
  'browser:navigate': {
    request: BrowserNavigateRequest,
    response: BrowserStateResult,
  },
  'browser:action': {
    request: BrowserActionRequest,
    response: BrowserStateResult,
  },
  'browser:find': {
    request: BrowserFindRequest,
    response: z.object({ failure: BrowserFailure.nullable() }).strict(),
  },
  'browser:close': {
    request: BrowserCloseRequest,
    response: z.object({ ok: z.literal(true) }).strict(),
  },
  'browser:reopen': {
    request: z.object({}).strict(),
    response: z
      .object({
        reopened: z
          .object({ webTabId: BrowserWebTabId, index: BrowserWebTabIndex, state: BrowserState })
          .strict()
          .nullable(),
      })
      .strict(),
  },
  'browser:downloads': {
    request: z.object({}).strict(),
    response: z.object({ downloads: BrowserDownloads }).strict(),
  },
  'browser:download': {
    request: BrowserDownloadRequest,
    response: z
      .object({ downloads: BrowserDownloads, failure: BrowserFailure.nullable() })
      .strict(),
  },
  'browser:geometry': {
    request: BrowserGeometryRequest,
    response: z
      .object({
        revision: BrowserRevision,
        still: BrowserStill.nullable(),
      })
      .strict(),
  },
  'browser:devtoolsGeometry': {
    request: BrowserDevtoolsGeometryRequest,
    response: z.object({ revision: BrowserRevision }).strict(),
  },
  'browser:favoriteAdd': {
    request: BrowserTarget,
    response: BrowserFavoritesResult,
  },
  'browser:favoriteRemove': {
    request: BrowserFavoriteRequest,
    response: BrowserFavoritesResult,
  },
  'browser:favoriteOpen': {
    request: BrowserFavoriteRequest,
    response: BrowserStateResult,
  },
  'browser:passwords': {
    request: BrowserTarget,
    response: BrowserPasswordsResult,
  },
  'browser:passwordDecide': {
    request: BrowserPasswordDecideRequest,
    response: BrowserPasswordsResult,
  },
  'browser:passwordFill': {
    request: BrowserPasswordFillRequest,
    response: z.object({ failure: BrowserFailure.nullable() }).strict(),
  },
  'browser:passwordRemove': {
    request: BrowserPasswordRemoveRequest,
    response: BrowserPasswordsResult,
  },
  'browser:passwordAllow': {
    request: BrowserTarget,
    response: BrowserPasswordsResult,
  },
} as const

export type BrowserContract = typeof BROWSER_CONTRACT
export type BrowserChannel = keyof BrowserContract
export type BrowserRequest<C extends BrowserChannel> = z.infer<BrowserContract[C]['request']>
export type BrowserResponse<C extends BrowserChannel> = z.infer<BrowserContract[C]['response']>

export const BROWSER_CHANNELS = Object.keys(BROWSER_CONTRACT) as BrowserChannel[]

export const BROWSER_PUSH_CHANNEL = 'browser:push'

const BrowserWheelDelta = z.number().min(-BROWSER_WHEEL_DELTA_MAX).max(BROWSER_WHEEL_DELTA_MAX)

export const BrowserPageRowWheel = z
  .object({
    deltaX: BrowserWheelDelta,
    deltaY: BrowserWheelDelta,
    deltaMode: z.number().int().min(0).max(2),
    shiftKey: z.boolean(),
    ctrlKey: z.boolean(),
    metaKey: z.boolean(),
  })
  .strict()
  .refine(
    (wheel) =>
      !wheel.ctrlKey &&
      !wheel.metaKey &&
      (wheel.shiftKey || Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY)) &&
      (wheel.deltaX !== 0 || (wheel.shiftKey && wheel.deltaY !== 0))
  )
export type BrowserPageRowWheel = z.infer<typeof BrowserPageRowWheel>

export const BrowserSelectPrompt = z
  .object({
    token: SelectToken,
    selectedIndex: z.number().int(),
    rect: z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative() }).strict(),
    options: z
      .array(
        z
          .object({
            label: z.string().max(1_000),
            disabled: z.boolean(),
            group: z.string().max(1_000).nullable(),
          })
          .strict()
      )
      .max(2_000),
  })
  .strict()
export type BrowserSelectPrompt = z.infer<typeof BrowserSelectPrompt>
export const BrowserDialogPrompt = z
  .object({
    token: z.uuid(),
    type: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
    message: z.string().max(10_000),
    defaultPrompt: z.string().max(10_000),
  })
  .strict()
export type BrowserDialogPrompt = z.infer<typeof BrowserDialogPrompt>

export const BrowserPush = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('devtools'),
      browserId: BrowserId,
      action: z.enum(['show', 'toggle']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('select'),
      browserId: BrowserId,
      select: BrowserSelectPrompt.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dialog'),
      browserId: BrowserId,
      dialog: BrowserDialogPrompt.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('state'), browserId: BrowserId, state: BrowserState }).strict(),
  z
    .object({ kind: z.literal('favorites'), browserId: BrowserId, favorites: BrowserFavorites })
    .strict(),
  z
    .object({
      kind: z.literal('prompt'),
      browserId: BrowserId,
      prompt: BrowserPasswordPrompt.nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal('passwords'), browserId: BrowserId, passwords: BrowserPasswords })
    .strict(),
  z
    .object({ kind: z.literal('row-wheel'), browserId: BrowserId, wheel: BrowserPageRowWheel })
    .strict(),
  z
    .object({
      kind: z.literal('devtools-row-wheel'),
      browserId: BrowserId,
      wheel: BrowserPageRowWheel,
    })
    .strict(),
  z
    .object({
      kind: z.literal('found'),
      browserId: BrowserId,
      matches: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      active: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tab-open'),
      browserId: BrowserId,
      webTabId: BrowserWebTabId,
      openerWebTabId: BrowserWebTabId.nullable(),
      background: z.boolean(),
      state: BrowserState,
    })
    .strict(),
  z
    .object({ kind: z.literal('command'), browserId: BrowserId, command: BrowserWebCommand })
    .strict(),
  z
    .object({ kind: z.literal('downloads'), browserId: BrowserId, downloads: BrowserDownloads })
    .strict(),
])
export type BrowserPush = z.infer<typeof BrowserPush>

export const BROWSER_PAGE_READY_CHANNEL = 'browser:page:ready'
export const BROWSER_PAGE_CANDIDATE_CHANNEL = 'browser:page:candidate'
export const BROWSER_PAGE_FILL_CHANNEL = 'browser:page:fill'
export const BROWSER_PAGE_FORM_CHANNEL = 'browser:page:form'
export const BROWSER_PAGE_SCAN_CHANNEL = 'browser:page:scan'
export const BROWSER_PAGE_ROW_WHEEL_CHANNEL = 'browser:page:row-wheel'
export const BROWSER_DEVTOOLS_ROW_WHEEL_CHANNEL = 'browser:devtools:row-wheel'
export const BROWSER_PAGE_ROW_WHEEL_ENABLE_CHANNEL = 'browser:page:row-wheel-enable'
export const BROWSER_PAGE_SWIPE_CHANNEL = 'browser:page:swipe'
export const BROWSER_PAGE_SWIPE_STATE_CHANNEL = 'browser:page:swipe-state'
export const BROWSER_PAGE_SWIPE_SEQUENCE_CHANNEL = 'browser:page:swipe-sequence'

const BrowserSwipeRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const BrowserPageSwipe = z
  .object({ direction: z.enum(['back', 'forward']), revision: BrowserSwipeRevision })
  .strict()
export type BrowserPageSwipe = z.infer<typeof BrowserPageSwipe>

export const BrowserPageSwipeState = z
  .object({
    back: z.boolean(),
    forward: z.boolean(),
    zoom: z.number().positive().max(10),
    revision: BrowserSwipeRevision,
  })
  .strict()
export type BrowserPageSwipeState = z.infer<typeof BrowserPageSwipeState>

export const BrowserPageSwipeSequence = z
  .object({ phase: z.enum(['begin', 'end']), sequence: BrowserSwipeRevision })
  .strict()
export type BrowserPageSwipeSequence = z.infer<typeof BrowserPageSwipeSequence>

export const BrowserPageReady = z.object({ documentToken: BrowserDocumentToken }).strict()
export type BrowserPageReady = z.infer<typeof BrowserPageReady>

export const BrowserFormPhase = z.enum(['identifier', 'password'])
export type BrowserFormPhase = z.infer<typeof BrowserFormPhase>

export const BrowserPageForm = z
  .object({ documentToken: BrowserDocumentToken, phase: BrowserFormPhase })
  .strict()
export type BrowserPageForm = z.infer<typeof BrowserPageForm>

export const BrowserPageScan = z.object({ documentToken: BrowserDocumentToken }).strict()
export type BrowserPageScan = z.infer<typeof BrowserPageScan>

export const BrowserFillMode = z.enum(['manual', 'automatic'])
export type BrowserFillMode = z.infer<typeof BrowserFillMode>

export const BrowserPageCandidate = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('identifier'),
      documentToken: BrowserDocumentToken,
      username: BrowserUsername.min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('credential'),
      documentToken: BrowserDocumentToken,
      username: BrowserUsername,
      password: BrowserPassword,
    })
    .strict(),
])
export type BrowserPageCandidate = z.infer<typeof BrowserPageCandidate>

export const BrowserPageFill = z
  .object({
    documentToken: BrowserDocumentToken,
    origin: BrowserOrigin,
    username: BrowserUsername,
    password: BrowserPassword,
    mode: BrowserFillMode,
  })
  .strict()
export type BrowserPageFill = z.infer<typeof BrowserPageFill>

export interface BrowserApi {
  readonly streamBrowser: (
    request: BrowserRequest<'browser:stream'>
  ) => Promise<BrowserResponse<'browser:stream'>>
  readonly browserInput: (
    request: BrowserRequest<'browser:input'>
  ) => Promise<BrowserResponse<'browser:input'>>
  readonly ackBrowserFrame: (
    request: BrowserRequest<'browser:frameAck'>
  ) => Promise<BrowserResponse<'browser:frameAck'>>
  readonly chooseBrowserSelect: (
    request: BrowserRequest<'browser:selectChoose'>
  ) => Promise<BrowserResponse<'browser:selectChoose'>>
  readonly answerBrowserDialog: (
    request: BrowserRequest<'browser:dialogAnswer'>
  ) => Promise<BrowserResponse<'browser:dialogAnswer'>>
  readonly browserSelection: (
    request: BrowserRequest<'browser:selection'>
  ) => Promise<BrowserResponse<'browser:selection'>>
  readonly onBrowserFrame: (listener: (frame: BrowserFrame) => void) => () => void
  readonly announceWebReady: () => Promise<BrowserResponse<'browser:webReady'>>
  readonly attachBrowser: (
    request: BrowserRequest<'browser:attach'>
  ) => Promise<BrowserResponse<'browser:attach'>>
  readonly detachBrowser: (
    request: BrowserRequest<'browser:detach'>
  ) => Promise<BrowserResponse<'browser:detach'>>
  readonly restoreBrowser: (
    request: BrowserRequest<'browser:restore'>
  ) => Promise<BrowserResponse<'browser:restore'>>
  readonly navigateBrowser: (
    request: BrowserRequest<'browser:navigate'>
  ) => Promise<BrowserResponse<'browser:navigate'>>
  readonly actOnBrowser: (
    request: BrowserRequest<'browser:action'>
  ) => Promise<BrowserResponse<'browser:action'>>
  readonly findInBrowser: (
    request: BrowserRequest<'browser:find'>
  ) => Promise<BrowserResponse<'browser:find'>>
  readonly closeBrowser: (
    request: BrowserRequest<'browser:close'>
  ) => Promise<BrowserResponse<'browser:close'>>
  readonly reopenBrowser: () => Promise<BrowserResponse<'browser:reopen'>>
  readonly readBrowserDownloads: () => Promise<BrowserResponse<'browser:downloads'>>
  readonly actOnBrowserDownload: (
    request: BrowserRequest<'browser:download'>
  ) => Promise<BrowserResponse<'browser:download'>>
  readonly setBrowserGeometry: (
    request: BrowserRequest<'browser:geometry'>
  ) => Promise<BrowserResponse<'browser:geometry'>>
  readonly setBrowserDevtoolsGeometry: (
    request: BrowserRequest<'browser:devtoolsGeometry'>
  ) => Promise<BrowserResponse<'browser:devtoolsGeometry'>>
  readonly addBrowserFavorite: (
    request: BrowserRequest<'browser:favoriteAdd'>
  ) => Promise<BrowserResponse<'browser:favoriteAdd'>>
  readonly removeBrowserFavorite: (
    request: BrowserRequest<'browser:favoriteRemove'>
  ) => Promise<BrowserResponse<'browser:favoriteRemove'>>
  readonly openBrowserFavorite: (
    request: BrowserRequest<'browser:favoriteOpen'>
  ) => Promise<BrowserResponse<'browser:favoriteOpen'>>
  readonly readBrowserPasswords: (
    request: BrowserRequest<'browser:passwords'>
  ) => Promise<BrowserResponse<'browser:passwords'>>
  readonly decideBrowserPassword: (
    request: BrowserRequest<'browser:passwordDecide'>
  ) => Promise<BrowserResponse<'browser:passwordDecide'>>
  readonly fillBrowserPassword: (
    request: BrowserRequest<'browser:passwordFill'>
  ) => Promise<BrowserResponse<'browser:passwordFill'>>
  readonly removeBrowserPassword: (
    request: BrowserRequest<'browser:passwordRemove'>
  ) => Promise<BrowserResponse<'browser:passwordRemove'>>
  readonly allowBrowserPasswordSaving: (
    request: BrowserRequest<'browser:passwordAllow'>
  ) => Promise<BrowserResponse<'browser:passwordAllow'>>
  readonly onBrowser: (listener: (push: BrowserPush) => void) => () => void
}

const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const DOTTED_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const LOOPBACK_SUBDOMAIN = /^(?:[a-z0-9-]+\.)+localhost$/
const ADDRESS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const ADDRESS_HOST_PORT = /^[^:/?#]+:\d+(?:[/?#]|$)/
const SEARCH_URL = 'https://www.google.com/search?q='
const ONCE_PER_PRESS = new Set<BrowserWebCommand>(['new-tab', 'close-tab', 'reopen-tab'])
const SECRET_PARAMETERS = new Set([
  'code',
  'state',
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'client_secret',
  'code_verifier',
  'session_state',
  'oauth_token',
  'oauth_verifier',
  'assertion',
  'samlrequest',
  'samlresponse',
  'relaystate',
  'ticket',
  'jwt',
  'password',
  'secret',
  'api_key',
  'apikey',
  'signature',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
])
const SECRET_FRAGMENT =
  /(?:^#|[#&?/])(?:access_token|id_token|refresh_token|token|code|state|session_state)=/i

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host === '[::1]') return true
  if (LOOPBACK_SUBDOMAIN.test(host)) return true
  if (!LOOPBACK_IPV4.test(host)) return false
  return host.split('.').every((part) => Number(part) <= 255)
}

export function isPrivateNetworkHostname(hostname: string): boolean {
  const match = DOTTED_IPV4.exec(hostname)
  if (match === null) return false
  const octets = match.slice(1).map(Number)
  if (octets.length !== 4 || octets.some((octet) => octet > 255)) return false
  const [first, second] = octets
  if (first === 10) return true
  if (first === 172) return second !== undefined && second >= 16 && second <= 31
  return first === 192 && second === 168
}

function webUrl(raw: string): URL | null {
  if (raw.length === 0 || raw.length > BROWSER_URL_MAX) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.hostname === '' ? null : url
}

export function isBrowserNavigable(raw: string): boolean {
  return raw === 'about:blank' || webUrl(raw) !== null
}

export function browserPasswordOrigin(raw: string): string | null {
  const url = webUrl(raw)
  if (url === null) return null
  const local = isLoopbackHostname(url.hostname) || isPrivateNetworkHostname(url.hostname)
  if (url.protocol === 'http:' && !local) return null
  return url.origin.length <= BROWSER_ORIGIN_MAX ? url.origin : null
}

export function isBrowserPasswordOrigin(origin: string): boolean {
  return browserPasswordOrigin(origin) === origin
}

export function browserAddress(input: string): string | null {
  const text = input.trim()
  if (text.length === 0 || text.length > BROWSER_ADDRESS_MAX || /\s/.test(text)) return null
  if (text.toLowerCase() === 'about:blank') return 'about:blank'
  const explicit = ADDRESS_SCHEME.test(text) && !ADDRESS_HOST_PORT.test(text)
  const probe = webUrl(explicit ? text : `https://${text}`)
  if (probe === null) return null
  const url = !explicit && isLoopbackHostname(probe.hostname) ? webUrl(`http://${text}`) : probe
  if (url?.username !== '' || url.password !== '') return null
  return url.href.length <= BROWSER_URL_MAX ? url.href : null
}

export function browserSearchUrl(text: string, maximum = BROWSER_SEARCH_MAX): string | null {
  const query = text
    .trim()
    .slice(0, maximum)
    .replace(/[\uD800-\uDBFF]$/, '')
  if (query === '') return null
  try {
    const url = `${SEARCH_URL}${encodeURIComponent(query)}`
    return url.length <= BROWSER_URL_MAX ? url : null
  } catch {
    return null
  }
}

export function browserAddressOrSearch(input: string): string | null {
  const text = input.trim()
  if (text.length === 0 || text.length > BROWSER_ADDRESS_MAX) return null
  const explicit = ADDRESS_SCHEME.test(text) && !ADDRESS_HOST_PORT.test(text)
  const hostLike =
    !/\s/.test(text) &&
    (explicit || /^[^/?#]*[.:]/.test(text) || /^localhost(?:[:/?#]|$)/i.test(text))
  const address = hostLike ? browserAddress(text) : null
  if (address !== null) return address
  return browserSearchUrl(text, BROWSER_ADDRESS_MAX)
}

export function browserZoomStep(current: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return 1
  const steps = direction === 1 ? BROWSER_ZOOM_STEPS : [...BROWSER_ZOOM_STEPS].reverse()
  return (
    steps.find((step) => (direction === 1 ? step > current + 0.001 : step < current - 0.001)) ??
    current
  )
}

export interface BrowserKeyInput {
  readonly type: string
  readonly key: string
  readonly meta: boolean
  readonly control: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly isAutoRepeat: boolean
  readonly isComposing: boolean
}

export function browserWebCommand(
  input: BrowserKeyInput,
  platform: string
): BrowserWebCommand | null {
  if (input.type !== 'keyDown' || input.isComposing) return null
  const primary =
    platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (!primary) return null
  if (input.alt) {
    if (!input.shift) return null
    if (input.key === 'ArrowLeft') return 'move-tab-left'
    if (input.key === 'ArrowRight') return 'move-tab-right'
    return null
  }
  const command = webCommandFor(input.key.toLowerCase(), input.shift)
  if (command === null || (input.isAutoRepeat && ONCE_PER_PRESS.has(command))) return null
  return command
}

function webCommandFor(key: string, shift: boolean): BrowserWebCommand | null {
  if (key === 't') return shift ? 'reopen-tab' : 'new-tab'
  if (shift) {
    if (key === 'g') return 'find-previous'
    if (key === '[' || key === '{') return 'previous-tab'
    if (key === ']' || key === '}') return 'next-tab'
    return null
  }
  if (key === 'w') return 'close-tab'
  if (key === 'l') return 'focus-address'
  if (key === 'f') return 'find'
  if (key === 'g') return 'find-next'
  if (key === '[') return 'back'
  if (key === ']') return 'forward'
  return null
}

export function browserScrubUrl(raw: string): string | null {
  const url = webUrl(raw)
  if (url === null) return null
  url.username = ''
  url.password = ''
  const secrets = [...url.searchParams.keys()].filter((name) =>
    SECRET_PARAMETERS.has(name.toLowerCase())
  )
  for (const name of secrets) url.searchParams.delete(name)
  if (url.hash !== '' && SECRET_FRAGMENT.test(url.hash)) url.hash = ''
  return url.href.length <= BROWSER_URL_MAX ? url.href : null
}
