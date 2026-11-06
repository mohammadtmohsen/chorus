import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createChorusApi } from '../shared/create-chorus-api.js'
import { CONVERSATION_NOTE_JOURNAL_CHANNEL } from '../shared/ipc.js'
import {
  TOAST_WINDOW_BOUNDS_CHANNEL,
  TOAST_WINDOW_INTERACTION_CHANNEL,
  ToastWindowBoundsResponse,
  ToastWindowInteractionResponse,
  type ChorusToastApi,
} from '../shared/toast-window-ipc.js'

const api = createChorusApi({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      listener(payload)
    }
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  noteJournal: (request) => {
    const reply: unknown = ipcRenderer.sendSync(CONVERSATION_NOTE_JOURNAL_CHANNEL, request)
    return reply
  },
})

contextBridge.exposeInMainWorld('chorus', api)

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
