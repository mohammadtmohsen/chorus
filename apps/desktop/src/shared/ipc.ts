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

/** Mirrors `StoredEvent` from the event store, minus its branded types. */
export const TranscriptEvent = z.object({
  seq: z.number().int(),
  id: z.string(),
  conversationId: z.string(),
  actor: z.enum(['user', 'system', 'codex', 'claude']),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number().int(),
})
export type TranscriptEvent = z.infer<typeof TranscriptEvent>

export const ApprovalChoice = z.object({
  conversationId: z.string(),
  /** Which agent asked — several can have approvals pending at once. */
  agentId: z.enum(['codex', 'claude']),
  approvalId: z.string(),
  outcome: z.enum(['allow', 'deny', 'cancel']),
  scope: z.enum(['once', 'session']),
})
export type ApprovalChoice = z.infer<typeof ApprovalChoice>

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

  'conversation:start': {
    /** Several agents share one conversation — that is the point of Chorus. */
    request: z.object({
      agents: z.array(z.enum(['codex', 'claude'])).min(1),
      cwd: z.string().min(1),
      profileId: z.string().optional(),
    }),
    response: z.object({
      conversationId: z.string(),
      participants: z.array(z.enum(['codex', 'claude'])),
      profileId: z.string(),
    }),
  },
  'conversation:send': {
    request: z.object({ conversationId: z.string(), text: z.string().min(1) }),
    /** Which agents the mention router picked, so the UI can show it. */
    response: z.object({ targets: z.array(z.enum(['codex', 'claude'])) }),
  },
  'conversation:interrupt': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },
  /**
   * Replays from the log rather than from provider history — Codex discards
   * partial assistant output, so the log is the only complete record (S3).
   */
  'conversation:history': {
    request: z.object({ conversationId: z.string(), afterSeq: z.number().int().optional() }),
    response: z.array(TranscriptEvent),
  },
  'approval:decide': {
    request: ApprovalChoice,
    response: z.object({ ok: z.literal(true) }),
  },
  /**
   * Builds the packet that would cross to another agent, without sending it.
   * The user edits this before anything moves (plan §4.5).
   */
  'handoff:prepare': {
    request: z.object({
      conversationId: z.string(),
      from: z.enum(['codex', 'claude']),
      to: z.enum(['codex', 'claude']),
      sourceEventIds: z.array(z.string()).min(1),
      includeDiff: z.boolean().optional(),
      intent: z.enum(['implement', 'review', 'discuss']).optional(),
      note: z.string().optional(),
    }),
    response: z.object({
      brief: z.string(),
      intent: z.enum(['implement', 'review', 'discuss']),
      summary: z.string(),
      sourceCount: z.number().int(),
    }),
  },
  'handoff:send': {
    request: z.object({
      conversationId: z.string(),
      from: z.enum(['codex', 'claude']),
      to: z.enum(['codex', 'claude']),
      sourceEventIds: z.array(z.string()),
      brief: z.string().min(1),
    }),
    response: z.object({ handoffId: z.string() }),
  },
  /** The permission profiles a conversation can be started under. */
  'policy:profiles': {
    request: z.void(),
    response: z.array(z.object({ id: z.string(), name: z.string(), summary: z.string() })),
  },
} as const

/**
 * Main-to-renderer push. Separate from the request/response contract because it
 * flows the other way and has no reply.
 */
export const EVENTS_PUSH_CHANNEL = 'conversation:events'
export const EventsPush = z.array(TranscriptEvent)
export type EventsPush = z.infer<typeof EventsPush>

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
  readonly startConversation: (
    request: IpcRequest<'conversation:start'>
  ) => Promise<IpcResponse<'conversation:start'>>
  readonly sendMessage: (
    request: IpcRequest<'conversation:send'>
  ) => Promise<IpcResponse<'conversation:send'>>
  readonly interrupt: (request: IpcRequest<'conversation:interrupt'>) => Promise<{ ok: true }>
  readonly history: (
    request: IpcRequest<'conversation:history'>
  ) => Promise<IpcResponse<'conversation:history'>>
  readonly decideApproval: (request: ApprovalChoice) => Promise<{ ok: true }>
  readonly profiles: () => Promise<IpcResponse<'policy:profiles'>>
  readonly prepareHandoff: (
    request: IpcRequest<'handoff:prepare'>
  ) => Promise<IpcResponse<'handoff:prepare'>>
  readonly sendHandoff: (
    request: IpcRequest<'handoff:send'>
  ) => Promise<IpcResponse<'handoff:send'>>
  /** Returns an unsubscribe function. */
  readonly onEvents: (listener: (events: TranscriptEvent[]) => void) => () => void
}
