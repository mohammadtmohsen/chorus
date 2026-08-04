import { contextBridge, ipcRenderer } from 'electron'
import {
  EVENTS_PUSH_CHANNEL,
  EventsPush,
  IPC_CONTRACT,
  type ChorusApi,
  type IpcChannel,
  type IpcResponse,
} from '../shared/ipc.js'

/**
 * One method per IPC message, generated from the contract. `ipcRenderer` itself
 * is never exposed — handing the renderer a generic `invoke(channel, ...)` would
 * make the allowlist meaningless (plan §4.4).
 */
function invoke<C extends IpcChannel>(channel: C) {
  return async (request?: unknown): Promise<IpcResponse<C>> => {
    const raw: unknown = await ipcRenderer.invoke(channel, request)
    // Validate on this side too: a mismatch here is our bug, and it should
    // surface at the boundary rather than as a render-time crash.
    const parsed = IPC_CONTRACT[channel].response.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`Malformed response on "${channel}": ${parsed.error.message}`)
    }
    return parsed.data as IpcResponse<C>
  }
}

const api: ChorusApi = {
  getAppInfo: invoke('app:getInfo'),
  probeAgents: invoke('agents:probe'),
  startConversation: invoke('conversation:start'),
  sendMessage: invoke('conversation:send'),
  interrupt: invoke('conversation:interrupt'),
  history: invoke('conversation:history'),
  decideApproval: invoke('approval:decide'),
  profiles: invoke('policy:profiles'),
  readDiagnostics: invoke('diagnostics:read'),
  exportDiagnostics: invoke('diagnostics:export'),
  readWorkspace: invoke('workspace:read'),
  prepareHandoff: invoke('handoff:prepare'),
  sendHandoff: invoke('handoff:send'),

  onEvents: (listener) => {
    // The payload is validated before it reaches renderer code: main is
    // trusted, but a shape mismatch should fail here, not three components deep.
    const wrapped = (_event: unknown, payload: unknown): void => {
      const parsed = EventsPush.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(EVENTS_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(EVENTS_PUSH_CHANNEL, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('chorus', api)
