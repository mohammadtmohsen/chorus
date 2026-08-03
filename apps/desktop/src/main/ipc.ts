import { app, ipcMain } from 'electron'
import { IPC_CONTRACT, type IpcChannel, type IpcResponse } from '../shared/ipc.js'
import { probeAgents } from './agent-probe.js'

type Handlers = { [C in IpcChannel]: (request: unknown) => Promise<IpcResponse<C>> }

const handlers: Handlers = {
  'app:getInfo': () =>
    Promise.resolve({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome,
      platform: process.platform,
    }),
  'agents:probe': () => probeAgents(),
}

/**
 * Every channel validates its request on the way in and its response on the way
 * out. Anything not in IPC_CONTRACT is never registered, so an unknown channel
 * fails at `invoke` rather than reaching a handler (plan §4.4).
 */
export function registerIpcHandlers(): void {
  for (const channel of Object.keys(IPC_CONTRACT) as IpcChannel[]) {
    ipcMain.handle(channel, async (_event, rawRequest: unknown) => {
      const schema = IPC_CONTRACT[channel]

      const parsedRequest = schema.request.safeParse(rawRequest)
      if (!parsedRequest.success) {
        throw new Error(`Invalid request on "${channel}": ${parsedRequest.error.message}`)
      }

      const result = await handlers[channel](parsedRequest.data)

      // Validating our own output catches main-process bugs at the boundary
      // instead of as a confusing render failure.
      const parsedResponse = schema.response.safeParse(result)
      if (!parsedResponse.success) {
        throw new Error(`Invalid response on "${channel}": ${parsedResponse.error.message}`)
      }
      return parsedResponse.data
    })
  }
}
