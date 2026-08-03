import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CONTRACT, type ChorusApi, type IpcChannel, type IpcResponse } from '../shared/ipc.js'

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
}

contextBridge.exposeInMainWorld('chorus', api)
