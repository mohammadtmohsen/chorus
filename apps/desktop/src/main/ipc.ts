import { app, BrowserWindow, ipcMain } from 'electron'
import {
  EVENTS_PUSH_CHANNEL,
  IPC_CONTRACT,
  type IpcChannel,
  type IpcResponse,
  type TranscriptEvent,
} from '../shared/ipc.js'
import { probeAgents } from './agent-probe.js'
import type { ChorusRuntime } from './runtime.js'

type Handlers = { [C in IpcChannel]: (request: never) => Promise<IpcResponse<C>> }

const OK = { ok: true } as const

function buildHandlers(runtime: ChorusRuntime): Handlers {
  return {
    'app:getInfo': () =>
      Promise.resolve({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        chromeVersion: process.versions.chrome,
        platform: process.platform,
      }),

    'agents:probe': () => probeAgents(),

    'conversation:start': (request: { agents: ('codex' | 'claude')[]; cwd: string }) =>
      runtime.startConversation({ agents: request.agents, cwd: request.cwd }),

    'conversation:send': async (request: { conversationId: string; text: string }) => {
      const { targets } = await runtime.send(request.conversationId, request.text)
      // Copied out of the readonly domain type; the IPC boundary is plain JSON.
      return { targets: [...targets] }
    },

    'conversation:interrupt': async (request: { conversationId: string }) => {
      await runtime.interrupt(request.conversationId)
      return OK
    },

    'conversation:history': (request: { conversationId: string; afterSeq?: number }) =>
      Promise.resolve(runtime.history(request.conversationId, request.afterSeq).map(toTranscript)),

    'approval:decide': async (request: {
      conversationId: string
      agentId: 'codex' | 'claude'
      approvalId: string
      outcome: 'allow' | 'deny' | 'cancel'
      scope: 'once' | 'session'
    }) => {
      await runtime.decideApproval(
        request.conversationId,
        request.agentId,
        request.approvalId,
        request.outcome === 'allow'
          ? { outcome: 'allow', scope: request.scope }
          : request.outcome === 'deny'
            ? { outcome: 'deny', message: 'Denied by the user' }
            : { outcome: 'cancel' }
      )
      return OK
    },
  }
}

/** Branded ids and zod-parsed payloads flatten to plain JSON for the renderer. */
function toTranscript(event: {
  seq: number
  id: string
  conversationId: string
  actor: string
  type: string
  payload: unknown
  createdAt: number
}): TranscriptEvent {
  return {
    seq: event.seq,
    id: event.id,
    conversationId: event.conversationId,
    actor: event.actor as TranscriptEvent['actor'],
    type: event.type,
    payload: event.payload as Record<string, unknown>,
    createdAt: event.createdAt,
  }
}

/**
 * Every channel validates its request on the way in and its response on the way
 * out. Anything not in IPC_CONTRACT is never registered, so an unknown channel
 * fails at `invoke` rather than reaching a handler (plan §4.4).
 */
export function registerIpcHandlers(runtime: ChorusRuntime): void {
  const handlers = buildHandlers(runtime)

  for (const channel of Object.keys(IPC_CONTRACT) as IpcChannel[]) {
    ipcMain.handle(channel, async (_event, rawRequest: unknown) => {
      const schema = IPC_CONTRACT[channel]

      const parsedRequest = schema.request.safeParse(rawRequest)
      if (!parsedRequest.success) {
        throw new Error(`Invalid request on "${channel}": ${parsedRequest.error.message}`)
      }

      const result = await handlers[channel](parsedRequest.data as never)

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

/**
 * Streams committed events to every open window.
 *
 * Push rather than poll so the transcript feels live, but the renderer can
 * always fall back to `conversation:history` — the log is authoritative, so a
 * dropped push is a recoverable gap rather than lost data.
 */
export function forwardEventsToRenderer(runtime: ChorusRuntime): () => void {
  return runtime.subscribe((events) => {
    const payload = events.map(toTranscript)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(EVENTS_PUSH_CHANNEL, payload)
    }
  })
}
