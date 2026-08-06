import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  EVENTS_PUSH_CHANNEL,
  IDE_PUSH_CHANNEL,
  IdeContextPush,
  LIMITS_PUSH_CHANNEL,
  LimitsPush,
  SCALE_PUSH_CHANNEL,
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
  closeConversation: invoke('conversation:close'),
  addAgent: invoke('conversation:addAgent'),
  removeAgent: invoke('conversation:removeAgent'),
  restoreConversations: () => invoke('conversation:restore')({}),
  restartConversation: invoke('conversation:restart'),
  previewFile: invoke('files:preview'),
  stashFile: invoke('files:stash'),
  // Renderers cannot read a File's path any more; only the bridge can.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  reorderConversations: invoke('conversation:reorder'),
  renameConversation: invoke('conversation:rename'),
  chooseProjectDirectory: invoke('conversation:chooseCwd'),
  setProjectDirectory: invoke('conversation:setCwd'),
  readSettings: () => invoke('settings:read')({}),
  writeSettings: invoke('settings:write'),
  history: invoke('conversation:history'),
  decideApproval: invoke('approval:decide'),
  answerQuestion: invoke('userinput:answer'),
  profiles: invoke('policy:profiles'),
  setProfile: invoke('policy:set'),
  readDiagnostics: invoke('diagnostics:read'),
  exportDiagnostics: invoke('diagnostics:export'),
  readWorkspace: invoke('workspace:read'),
  ideSnapshot: invoke('ide:snapshot'),
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
  onIdeContext: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      // Validated here as well as in main: a shape mismatch should fail at the
      // boundary rather than as a blank pill with no explanation.
      const parsed = IdeContextPush.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(IDE_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(IDE_PUSH_CHANNEL, wrapped)
    }
  },
  onLimits: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      const parsed = LimitsPush.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(LIMITS_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(LIMITS_PUSH_CHANNEL, wrapped)
    }
  },
  onScale: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      // Validated like every other push: main is trusted, but a shape mismatch
      // should fail here rather than as a NaN in the badge.
      if (typeof payload === 'number' && Number.isFinite(payload)) listener(payload)
    }
    ipcRenderer.on(SCALE_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(SCALE_PUSH_CHANNEL, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('chorus', api)
