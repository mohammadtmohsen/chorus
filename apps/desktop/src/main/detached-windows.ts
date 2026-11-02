import { randomUUID } from 'node:crypto'
import {
  ipcMain,
  screen,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type Point,
  type Rectangle,
  type WebContents,
} from 'electron'
import {
  CONVERSATIONS_PUSH_CHANNEL,
  DETACHED_WINDOW_CHANNELS,
  DETACHED_WINDOW_CONTRACT,
  HIT_TEST_REQUEST_PUSH_CHANNEL,
  PROJECT_CLOSE_REQUEST_PUSH_CHANNEL,
  PROJECT_RETURNED_PUSH_CHANNEL,
  PROJECT_SLICE_PUSH_CHANNEL,
  PROJECT_VISIBILITY_PUSH_CHANNEL,
  type DetachedWindowChannel,
  type DetachedWindowRequest,
  type DetachedWindowResponse,
} from '../shared/detached-window-ipc.js'
import type { ProjectLayoutSlice, ReturnSlot } from '../shared/workspace-layout.js'
import type { ChorusRuntime } from './runtime.js'
import { isShellSender, shellWindows } from './shell-windows.js'
import { beginHandoff, type WorkbenchPlace } from './workbench-surface.js'

export type DetachedState =
  'detaching' | 'detached' | 'redocking' | 'returning' | 'closing-empty' | 'shutting-down'

interface DetachedEntry {
  readonly window: BrowserWindow
  readonly host: string
  readonly projectRoot: string
  state: DetachedState
  returnSlot: ReturnSlot
  slice: ProjectLayoutSlice
}

interface Ticket {
  readonly projectId: string
  readonly kind: 'detach' | 'redock'
  readonly caller: WebContents
  readonly expires: number
  readonly title: string
  readonly cursor: Point
  readonly paneId: string | null
  readonly slot: number | null
}

interface HitTestAnswer {
  readonly paneId: string | null
  readonly slot: number | null
}

export interface DetachedWindowDeps {
  readonly mainWindow: () => BrowserWindow | null
  readonly createDetachedWindow: (
    projectId: string,
    title: string,
    x: number,
    y: number
  ) => BrowserWindow
  readonly resolvePlace: (projectId: string) => WorkbenchPlace
  readonly runtime: ChorusRuntime
}

type Handlers = {
  [C in DetachedWindowChannel]: (
    event: IpcMainInvokeEvent,
    request: DetachedWindowRequest<C>
  ) => DetachedWindowResponse<C> | Promise<DetachedWindowResponse<C>>
}

const PREPARE_TICKET_TTL_MS = 5_000
const HIT_TEST_TIMEOUT_MS = 500
const OK = { ok: true } as const
const REFUSED = { refused: true } as const

const entries = new Map<string, DetachedEntry>()
const tickets = new Map<string, Ticket>()
const pendingHitTests = new Map<
  string,
  { resolve: (answer: HitTestAnswer) => void; timer: ReturnType<typeof setTimeout> }
>()

function inside(point: Point, rect: Rectangle): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  )
}

export function raise(window: BrowserWindow | null | undefined): void {
  if (window === null || window === undefined || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

export function detachedWindowOf(projectId: string): BrowserWindow | null {
  const entry = entries.get(projectId)
  return entry?.state === 'detached' ? entry.window : null
}

function sendToMain(deps: DetachedWindowDeps, channel: string, payload: unknown): void {
  const main = deps.mainWindow()
  if (main !== null && !main.isDestroyed()) main.webContents.send(channel, payload)
}

function tryHandOff(
  from: WebContents,
  place: WorkbenchPlace,
  to: WebContents,
  kind: 'detach' | 'return'
): boolean {
  try {
    beginHandoff(from, place.root, to, kind, place.host)
    return true
  } catch {
    return false
  }
}

function takeTicket(id: string, caller: WebContents, kind: Ticket['kind']): Ticket {
  const held = tickets.get(id)
  tickets.delete(id)
  if (held?.caller !== caller || held.kind !== kind || held.expires < Date.now()) {
    throw new Error('That detach ticket is not valid for this window')
  }
  return held
}

function entryForWindow(sender: WebContents, projectId?: string): [string, DetachedEntry] {
  const found = [...entries].find(([, entry]) => entry.window.webContents === sender)
  if (found === undefined || (projectId !== undefined && found[0] !== projectId)) {
    throw new Error('No detached project belongs to this window')
  }
  return found
}

function requestProjectClose(projectId: string): void {
  const entry = entries.get(projectId)
  if (entry?.state !== 'detached') return
  entry.window.webContents.send(PROJECT_CLOSE_REQUEST_PUSH_CHANNEL, { projectId })
}

function askHitTest(main: BrowserWindow, x: number, y: number): Promise<HitTestAnswer> {
  return new Promise((resolve) => {
    const requestId = randomUUID()
    pendingHitTests.set(requestId, {
      resolve,
      timer: setTimeout(() => {
        pendingHitTests.delete(requestId)
        resolve({ paneId: null, slot: null })
      }, HIT_TEST_TIMEOUT_MS),
    })
    main.webContents.send(HIT_TEST_REQUEST_PUSH_CHANNEL, { requestId, x, y })
  })
}

export function detachedAccess(
  caller: WebContents,
  projectRoot: string,
  mainContents: WebContents | null
): boolean {
  for (const entry of entries.values()) {
    if (entry.projectRoot !== projectRoot) continue
    if (caller === entry.window.webContents) return true
    return (entry.state === 'returning' || entry.state === 'redocking') && caller === mainContents
  }
  return true
}

export function handOffExpired(deps: DetachedWindowDeps, projectRoot: string): void {
  const found = [...entries].find(([, entry]) => entry.projectRoot === projectRoot)
  if (found === undefined) return
  const [projectId, entry] = found
  sendToMain(deps, PROJECT_RETURNED_PUSH_CHANNEL, {
    projectId,
    returnSlot: entry.returnSlot,
    slice: entry.slice,
  })
  entry.state = 'returning'
  entry.window.close()
}

export function closeEveryDetachedWindow(): void {
  for (const entry of entries.values()) {
    entry.state = 'shutting-down'
    if (!entry.window.isDestroyed()) entry.window.close()
  }
}

export function attachDetachedWindowListeners(
  deps: DetachedWindowDeps,
  projectId: string,
  window: BrowserWindow
): void {
  window.on('close', (event) => {
    if (entries.get(projectId)?.state !== 'detached') return
    event.preventDefault()
    requestProjectClose(projectId)
  })
  window.on('closed', () => {
    const entry = entries.get(projectId)
    if (entry?.window !== window) return
    if (entry.state === 'detaching' || entry.state === 'detached') {
      sendToMain(deps, PROJECT_RETURNED_PUSH_CHANNEL, {
        projectId,
        returnSlot: entry.returnSlot,
        slice: entry.slice,
      })
    }
    entries.delete(projectId)
  })
}

export function registerDetachedWindowHandlers(deps: DetachedWindowDeps): void {
  const handlers: Handlers = {
    'project:focusWindow': (_event, request) => {
      raise(entries.get(request.projectId)?.window)
      return OK
    },
    'project:prepareDetach': (event, request) => {
      const main = deps.mainWindow()
      if (
        main === null ||
        main.isDestroyed() ||
        event.sender !== main.webContents ||
        entries.has(request.projectId)
      ) {
        return REFUSED
      }
      const cursor = screen.getCursorScreenPoint()
      if (inside(cursor, main.getBounds())) return REFUSED
      const id = randomUUID()
      tickets.set(id, {
        projectId: request.projectId,
        kind: 'detach',
        caller: event.sender,
        expires: Date.now() + PREPARE_TICKET_TTL_MS,
        title: request.title,
        cursor,
        paneId: null,
        slot: null,
      })
      return { ticket: id }
    },
    'project:commitDetach': (event, request) => {
      const held = takeTicket(request.ticket, event.sender, 'detach')
      const place = deps.resolvePlace(held.projectId)
      const window = deps.createDetachedWindow(
        held.projectId,
        held.title,
        held.cursor.x - 120,
        held.cursor.y - 16
      )
      const entry: DetachedEntry = {
        window,
        host: place.host,
        projectRoot: place.root,
        state: 'detaching',
        returnSlot: request.returnSlot,
        slice: request.slice,
      }
      entries.set(held.projectId, entry)
      if (!tryHandOff(event.sender, place, window.webContents, 'detach')) {
        entries.delete(held.projectId)
        window.destroy()
        throw new Error('That project has no single workbench surface to move')
      }
      entry.state = 'detached'
      return OK
    },
    'project:prepareRedock': async (event, request) => {
      const main = deps.mainWindow()
      const entry = entries.get(request.projectId)
      if (
        main === null ||
        main.isDestroyed() ||
        entry?.state !== 'detached' ||
        entry.window.webContents !== event.sender
      ) {
        return REFUSED
      }
      const cursor = screen.getCursorScreenPoint()
      const content = main.getContentBounds()
      if (inside(cursor, entry.window.getBounds()) || !inside(cursor, content)) return REFUSED
      const zoom = main.webContents.getZoomFactor()
      const answer = await askHitTest(
        main,
        (cursor.x - content.x) / zoom,
        (cursor.y - content.y) / zoom
      )
      if (answer.paneId === null || answer.slot === null) return REFUSED
      const id = randomUUID()
      tickets.set(id, {
        projectId: request.projectId,
        kind: 'redock',
        caller: event.sender,
        expires: Date.now() + PREPARE_TICKET_TTL_MS,
        title: '',
        cursor,
        paneId: answer.paneId,
        slot: answer.slot,
      })
      return { ticket: id, paneId: answer.paneId, slot: answer.slot }
    },
    'project:commitRedock': (event, request) => {
      const held = takeTicket(request.ticket, event.sender, 'redock')
      const entry = entries.get(held.projectId)
      const main = deps.mainWindow()
      if (
        entry?.state !== 'detached' ||
        main === null ||
        main.isDestroyed() ||
        held.paneId === null ||
        held.slot === null
      ) {
        throw new Error('That project cannot go back to the main window now')
      }
      entry.slice = request.slice
      entry.returnSlot = { paneId: held.paneId, index: held.slot }
      entry.state = 'redocking'
      tryHandOff(
        event.sender,
        { host: entry.host, root: entry.projectRoot },
        main.webContents,
        'return'
      )
      sendToMain(deps, PROJECT_RETURNED_PUSH_CHANNEL, {
        projectId: held.projectId,
        returnSlot: entry.returnSlot,
        slice: entry.slice,
      })
      entry.window.close()
      return OK
    },
    'project:closeEmpty': (event, request) => {
      const existing = entries.get(request.projectId)
      if (existing === undefined) return OK
      const [, entry] = entryForWindow(event.sender, request.projectId)
      if (entry.state === 'closing-empty') return OK
      entry.state = 'closing-empty'
      entry.window.close()
      return OK
    },
    'project:sliceChanged': (event, request) => {
      const [projectId, entry] = entryForWindow(event.sender, request.projectId)
      entry.slice = request.slice
      sendToMain(deps, PROJECT_SLICE_PUSH_CHANNEL, { projectId, slice: request.slice })
      return OK
    },
    'project:visibility': (event, request) => {
      entryForWindow(event.sender, request.projectId)
      sendToMain(deps, PROJECT_VISIBILITY_PUSH_CHANNEL, request)
      return OK
    },
    'window:detachedState': () => ({
      entries: [...entries].map(([projectId, entry]) => ({
        projectId,
        returnSlot: entry.returnSlot,
        slice: entry.slice,
      })),
    }),
    'window:detachedBootstrap': (event) => {
      const [projectId, entry] = entryForWindow(event.sender)
      return {
        projectId,
        slice: entry.slice,
        conversations: deps.runtime
          .activeSessions()
          .filter((session) => session.projectId === projectId),
      }
    },
    'window:flushResult': () => OK,
    'window:hitTestResult': (event, request) => {
      const main = deps.mainWindow()
      const pending = pendingHitTests.get(request.requestId)
      if (pending === undefined || main?.webContents !== event.sender) return OK
      clearTimeout(pending.timer)
      pendingHitTests.delete(request.requestId)
      pending.resolve({ paneId: request.paneId, slot: request.slot })
      return OK
    },
  }

  deps.runtime.onConversationsChanged(() => {
    for (const window of shellWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CONVERSATIONS_PUSH_CHANNEL)
    }
  })

  for (const channel of DETACHED_WINDOW_CHANNELS) {
    ipcMain.handle(channel, async (event, rawRequest: unknown) => {
      if (!isShellSender(event)) throw new Error(`"${channel}" is only available to Chorus windows`)
      const schema = DETACHED_WINDOW_CONTRACT[channel]
      const parsedRequest = schema.request.safeParse(rawRequest)
      if (!parsedRequest.success) {
        throw new Error(`Invalid request on "${channel}": ${parsedRequest.error.message}`)
      }
      const result = await handlers[channel](event, parsedRequest.data as never)
      const parsedResponse = schema.response.safeParse(result)
      if (!parsedResponse.success) {
        throw new Error(`Invalid response on "${channel}": ${parsedResponse.error.message}`)
      }
      return parsedResponse.data
    })
  }
}
