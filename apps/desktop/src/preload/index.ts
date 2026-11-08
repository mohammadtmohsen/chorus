import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createChorusApi } from '../shared/create-chorus-api.js'
import {
  CONVERSATION_NOTE_JOURNAL_ASYNC_CHANNEL,
  CONVERSATION_NOTE_JOURNAL_PUSH_CHANNEL,
  ENGINE_STATUS_CHANNEL,
  ENGINE_UPDATE_CHANNEL,
  SHELL_PRESENCE_CHANNEL,
  ConversationNoteJournalResponse,
  EngineStatus,
  EngineUpdate,
  ShellPresence,
  type ConversationNoteJournalRequest,
  type DesktopShellApi,
} from '../shared/ipc.js'
import { MirroredJournalBackend } from '../shared/mirrored-journal.js'
import {
  TOAST_WINDOW_BOUNDS_CHANNEL,
  TOAST_WINDOW_INTERACTION_CHANNEL,
  ToastWindowBoundsResponse,
  ToastWindowInteractionResponse,
  type ChorusToastApi,
} from '../shared/toast-window-ipc.js'

declare const window: {
  readonly localStorage: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
  }
}

const journals = new Map<string, MirroredJournalBackend>()
const journalListeners = new Set<(payload: unknown) => void>()
const statusListeners = new Set<(status: EngineStatus) => void>()
const updateListeners = new Set<(update: EngineUpdate) => void>()
let latestStatus: EngineStatus | null = null
let latestUpdate: EngineUpdate | null = null

const journalFor = (conversationId: string): MirroredJournalBackend => {
  const existing = journals.get(conversationId)
  if (existing !== undefined) return existing
  const key = `chorus:note-journal:${conversationId}`
  let backup: unknown
  try {
    const stored = window.localStorage.getItem(key)
    backup = stored === null ? undefined : JSON.parse(stored)
  } catch {
    backup = undefined
  }
  const remote = async (
    request: ConversationNoteJournalRequest
  ): Promise<ConversationNoteJournalResponse> => {
    const reply: unknown = await ipcRenderer.invoke(
      CONVERSATION_NOTE_JOURNAL_ASYNC_CHANNEL,
      request
    )
    return ConversationNoteJournalResponse.parse(reply)
  }
  const mirror = new MirroredJournalBackend(
    {
      read: () => remote({ conversationId, op: 'read' }),
      compare: (expected, next) => remote({ conversationId, op: 'compare', expected, next }),
    },
    {
      backup,
      save: (snapshot) => {
        window.localStorage.setItem(key, JSON.stringify(snapshot))
      },
    }
  )
  mirror.subscribe(() => {
    for (const listener of journalListeners) listener({ conversationId })
  })
  journals.set(conversationId, mirror)
  return mirror
}

ipcRenderer.on(ENGINE_STATUS_CHANNEL, (_event: unknown, payload: unknown) => {
  const parsed = EngineStatus.safeParse(payload)
  if (!parsed.success) return
  latestStatus = parsed.data
  if (parsed.data.state === 'connected') {
    latestUpdate = null
    for (const mirror of journals.values()) void mirror.prepare().catch(() => undefined)
  }
  for (const listener of statusListeners) listener(parsed.data)
})
ipcRenderer.on(ENGINE_UPDATE_CHANNEL, (_event: unknown, payload: unknown) => {
  const parsed = EngineUpdate.safeParse(payload)
  if (!parsed.success) return
  latestUpdate = parsed.data
  for (const listener of updateListeners) listener(parsed.data)
})

const api = createChorusApi({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => {
    if (channel === CONVERSATION_NOTE_JOURNAL_PUSH_CHANNEL) journalListeners.add(listener)
    const wrapped = (_event: unknown, payload: unknown): void => {
      listener(payload)
    }
    ipcRenderer.on(channel, wrapped)
    return () => {
      if (channel === CONVERSATION_NOTE_JOURNAL_PUSH_CHANNEL) journalListeners.delete(listener)
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  noteJournal: (request) => journalFor(request.conversationId).answer(request),
  prepareConversationNoteJournal: ({ conversationId }) => journalFor(conversationId).prepare(),
})

contextBridge.exposeInMainWorld('chorus', api)

const desktopApi: DesktopShellApi = {
  presence: (report) => {
    ipcRenderer.send(SHELL_PRESENCE_CHANNEL, ShellPresence.parse(report))
  },
  onEngineStatus: (listener) => {
    statusListeners.add(listener)
    const status = latestStatus
    if (status !== null)
      queueMicrotask(() => {
        if (statusListeners.has(listener)) listener(status)
      })
    return () => {
      statusListeners.delete(listener)
    }
  },
  onEngineUpdate: (listener) => {
    updateListeners.add(listener)
    const update = latestUpdate
    if (update !== null)
      queueMicrotask(() => {
        if (updateListeners.has(listener)) listener(update)
      })
    return () => {
      updateListeners.delete(listener)
    }
  },
}

contextBridge.exposeInMainWorld('chorusDesktop', desktopApi)

const toastApi: ChorusToastApi = {
  setBounds: async (request) => {
    const raw: unknown = await ipcRenderer.invoke(TOAST_WINDOW_BOUNDS_CHANNEL, request)
    return ToastWindowBoundsResponse.parse(raw)
  },
  setInteraction: async (request) => {
    const raw: unknown = await ipcRenderer.invoke(TOAST_WINDOW_INTERACTION_CHANNEL, request)
    return ToastWindowInteractionResponse.parse(raw)
  },
}

contextBridge.exposeInMainWorld('chorusToasts', toastApi)
