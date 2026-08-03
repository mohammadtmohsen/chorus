import { z } from 'zod'

/**
 * The single source of truth for the IPC surface.
 *
 * Main validates every inbound payload and every outbound result; the preload
 * validates too, so our own bugs surface at the boundary instead of deeper in.
 * A channel that is not in this map does not exist (plan §4.4).
 */

export const AgentProbeResult = z.object({
  id: z.enum(['codex', 'claude']),
  installed: z.boolean(),
  version: z.string().nullable(),
  /** Populated when the CLI is missing or not on PATH. */
  problem: z.string().nullable(),
})
export type AgentProbeResult = z.infer<typeof AgentProbeResult>

export const AppInfo = z.object({
  appVersion: z.string(),
  electronVersion: z.string(),
  nodeVersion: z.string(),
  chromeVersion: z.string(),
  platform: z.string(),
})
export type AppInfo = z.infer<typeof AppInfo>

/**
 * One entry per operation, each with its own request/response schema. Adding a
 * channel means adding it here first — `contextBridge` is generated from this.
 */
export const IPC_CONTRACT = {
  'app:getInfo': { request: z.void(), response: AppInfo },
  /**
   * Reads the installed `codex` and `claude` versions. These get recorded on
   * `session.started` so a break after a CLI self-update is visible in the log
   * rather than a guess (plan §2.5).
   */
  'agents:probe': { request: z.void(), response: z.array(AgentProbeResult) },
} as const

export type IpcContract = typeof IPC_CONTRACT
export type IpcChannel = keyof IpcContract

export type IpcRequest<C extends IpcChannel> = z.infer<IpcContract[C]['request']>
export type IpcResponse<C extends IpcChannel> = z.infer<IpcContract[C]['response']>

export const IPC_CHANNELS = Object.keys(IPC_CONTRACT) as IpcChannel[]

export function isIpcChannel(value: string): value is IpcChannel {
  return Object.hasOwn(IPC_CONTRACT, value)
}

/**
 * The shape exposed on `window.chorus`. It lives here rather than in the preload
 * so the renderer never has to import a module that pulls in Electron — the
 * renderer is sandboxed and that import would typecheck but fail at runtime.
 */
export interface ChorusApi {
  readonly getAppInfo: () => Promise<AppInfo>
  readonly probeAgents: () => Promise<AgentProbeResult[]>
}
