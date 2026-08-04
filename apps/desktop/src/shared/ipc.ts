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

/** Defaults for a new session. Zoom is not here: it lasts one launch. */
export const SettingsShape = z.object({
  agents: z.array(z.enum(['codex', 'claude'])),
  cwd: z.string(),
  profileId: z.string(),
})

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
      /** Empty means "start at home" — a directory is a starting point, not a boundary. */
      cwd: z.string(),
      profileId: z.string().optional(),
    }),
    response: z.object({
      conversationId: z.string(),
      participants: z.array(z.enum(['codex', 'claude'])),
      profileId: z.string(),
      /** Where the session actually started, which may not be what was asked for. */
      cwd: z.string(),
      /** Defaults to the folder's name; the user can rename it. */
      title: z.string(),
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
  /**
   * Ends one conversation. Others keep running — the grid holds several at once,
   * and closing one pane must not touch the agents in the next.
   */
  /**
   * Brings an agent in, or takes one out, without ending the conversation.
   * A joining agent reads the whole transcript on the first thing it is asked.
   */
  'conversation:addAgent': {
    request: z.object({ conversationId: z.string(), agentId: z.enum(['codex', 'claude']) }),
    response: z.object({ agentId: z.enum(['codex', 'claude']) }),
  },
  'conversation:removeAgent': {
    request: z.object({ conversationId: z.string(), agentId: z.enum(['codex', 'claude']) }),
    response: z.object({ agentId: z.enum(['codex', 'claude']) }),
  },

  /**
   * Asks for a directory with the system's folder chooser, and applies it.
   *
   * One call rather than "pick" then "set": the chosen path never has to cross
   * back through the renderer, and a cancelled dialog cannot leave the two
   * halves disagreeing about where the conversation is.
   */
  /**
   * Reopens what was on screen when the app last ran.
   *
   * Called once, at startup. Returns an empty list when nothing was open, which
   * is the same shape as a first launch.
   */
  'conversation:restore': {
    request: z.object({}),
    response: z.array(
      z.object({
        conversationId: z.string(),
        participants: z.array(z.enum(['codex', 'claude'])),
        profileId: z.string(),
        cwd: z.string(),
        title: z.string(),
      })
    ),
  },

  /**
   * Starts the same room again with nothing said in it.
   *
   * Returns a *new* conversation: the old transcript stays in the log rather
   * than being erased, and the agents get fresh sessions rather than a context
   * they were asked to ignore.
   */
  'conversation:restart': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({
      conversationId: z.string(),
      participants: z.array(z.enum(['codex', 'claude'])),
      profileId: z.string(),
      cwd: z.string(),
      title: z.string(),
    }),
  },

  /**
   * Writes pasted bytes down and returns the path.
   *
   * Base64 because the bridge carries JSON; a screenshot is a few megabytes
   * once, which is cheaper than teaching the whole protocol about binaries.
   */
  'files:stash': {
    request: z.object({ name: z.string(), base64: z.string() }),
    response: z.object({ path: z.string() }),
  },

  /** Enough to show an attachment: its name, its size, and a preview if it has one. */
  'files:preview': {
    request: z.object({ path: z.string() }),
    response: z.object({
      name: z.string(),
      bytes: z.number(),
      dataUrl: z.string().nullable(),
    }),
  },

  /** Records the order the panes were arranged into, so a restore keeps it. */
  'conversation:reorder': {
    request: z.object({ order: z.array(z.string()) }),
    response: z.object({ ok: z.literal(true) }),
  },

  /** Names a conversation. An empty name asks for the folder's name back. */
  'conversation:rename': {
    request: z.object({ conversationId: z.string(), title: z.string() }),
    response: z.object({ title: z.string() }),
  },

  'conversation:chooseCwd': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({ cwd: z.string(), title: z.string(), changed: z.boolean() }),
  },

  /** Repoints the conversation's project directory while it is open. */
  'conversation:setCwd': {
    request: z.object({ conversationId: z.string(), cwd: z.string() }),
    /** The title comes back because an untouched one follows the folder. */
    response: z.object({ cwd: z.string(), title: z.string() }),
  },
  'conversation:close': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },
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
  /**
   * The repository as it stands on disk, not as the log describes it. Those
   * differ after a crash, a manual edit, or a denied approval.
   */
  'workspace:read': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({
      status: z.object({
        branch: z.string().nullable(),
        upstream: z.string().nullable(),
        ahead: z.number().int(),
        behind: z.number().int(),
        clean: z.boolean(),
        files: z.array(
          z.object({
            path: z.string(),
            from: z.string().optional(),
            state: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked', 'conflicted']),
            staged: z.boolean(),
            unstaged: z.boolean(),
          })
        ),
      }),
      diff: z.array(
        z.object({
          path: z.string(),
          oldPath: z.string(),
          added: z.number().int(),
          removed: z.number().int(),
          binary: z.boolean(),
          hunks: z.array(
            z.object({
              header: z.string(),
              lines: z.array(
                z.object({
                  kind: z.enum(['context', 'added', 'removed', 'meta']),
                  text: z.string(),
                  before: z.number().int().optional(),
                  after: z.number().int().optional(),
                })
              ),
            })
          ),
        })
      ),
      problem: z.string().nullable(),
    }),
  },
  /** Recent log entries, already redacted as they were written. */
  /**
   * What a new session starts with. Defaults only — a session still chooses its
   * own agents, directory and profile.
   */
  'settings:read': {
    request: z.object({}),
    response: SettingsShape,
  },
  /** A patch: sending only what changed keeps one field from clobbering another. */
  'settings:write': {
    request: SettingsShape.partial(),
    response: SettingsShape,
  },
  'diagnostics:read': {
    request: z.void(),
    response: z.array(
      z.object({
        at: z.number().int(),
        level: z.enum(['debug', 'info', 'warn', 'error']),
        message: z.string(),
        fields: z.record(z.string(), z.unknown()).optional(),
      })
    ),
  },
  /** Writes a bundle to disk and returns where it landed. */
  'diagnostics:export': {
    request: z.void(),
    response: z.object({ path: z.string() }),
  },
  /** The permission profiles a conversation can be started under. */
  /** Changes what agents may do without asking, in a conversation already open. */
  'policy:set': {
    request: z.object({ conversationId: z.string(), profileId: z.string() }),
    response: z.object({ profileId: z.string() }),
  },
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

/**
 * The window's zoom factor, pushed whenever it changes.
 *
 * Zoom is owned by the menu, so the renderer has no other way to learn it — and
 * it needs to, in order to say what just happened.
 */
export const SCALE_PUSH_CHANNEL = 'settings:scale'

/**
 * Account usage windows, pushed as providers report them.
 *
 * A push rather than a query because nothing asks: the numbers arrive when an
 * agent happens to talk to its provider, and a header that only updated when you
 * opened something would be showing you yesterday.
 */
export const LIMITS_PUSH_CHANNEL = 'agents:limits'

export const UsageWindowShape = z.object({
  id: z.string(),
  usedPercent: z.number().nullable(),
  windowMinutes: z.number().nullable(),
  resetsAt: z.number().nullable(),
})
export type UsageWindowShape = z.infer<typeof UsageWindowShape>

export const LimitsPush = z.object({
  agentId: z.enum(['codex', 'claude']),
  windows: z.array(UsageWindowShape),
})
export type LimitsPush = z.infer<typeof LimitsPush>
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
  readonly closeConversation: (request: IpcRequest<'conversation:close'>) => Promise<{ ok: true }>
  readonly addAgent: (
    request: IpcRequest<'conversation:addAgent'>
  ) => Promise<IpcResponse<'conversation:addAgent'>>
  readonly removeAgent: (
    request: IpcRequest<'conversation:removeAgent'>
  ) => Promise<IpcResponse<'conversation:removeAgent'>>
  readonly restoreConversations: () => Promise<IpcResponse<'conversation:restore'>>
  readonly restartConversation: (
    request: IpcRequest<'conversation:restart'>
  ) => Promise<IpcResponse<'conversation:restart'>>
  readonly previewFile: (
    request: IpcRequest<'files:preview'>
  ) => Promise<IpcResponse<'files:preview'>>
  readonly stashFile: (request: IpcRequest<'files:stash'>) => Promise<IpcResponse<'files:stash'>>
  /** The real path of a dropped file; `File.path` was removed in Electron 32. */
  readonly pathForFile: (file: File) => string
  readonly reorderConversations: (
    request: IpcRequest<'conversation:reorder'>
  ) => Promise<{ ok: true }>
  readonly renameConversation: (
    request: IpcRequest<'conversation:rename'>
  ) => Promise<IpcResponse<'conversation:rename'>>
  readonly chooseProjectDirectory: (
    request: IpcRequest<'conversation:chooseCwd'>
  ) => Promise<IpcResponse<'conversation:chooseCwd'>>
  readonly setProjectDirectory: (
    request: IpcRequest<'conversation:setCwd'>
  ) => Promise<IpcResponse<'conversation:setCwd'>>
  readonly onScale: (listener: (scale: number) => void) => () => void
  readonly onLimits: (listener: (limits: LimitsPush) => void) => () => void
  readonly readSettings: () => Promise<IpcResponse<'settings:read'>>
  readonly writeSettings: (
    request: IpcRequest<'settings:write'>
  ) => Promise<IpcResponse<'settings:write'>>
  readonly history: (
    request: IpcRequest<'conversation:history'>
  ) => Promise<IpcResponse<'conversation:history'>>
  readonly decideApproval: (request: ApprovalChoice) => Promise<{ ok: true }>
  readonly profiles: () => Promise<IpcResponse<'policy:profiles'>>
  readonly setProfile: (request: IpcRequest<'policy:set'>) => Promise<IpcResponse<'policy:set'>>
  readonly readDiagnostics: () => Promise<IpcResponse<'diagnostics:read'>>
  readonly exportDiagnostics: () => Promise<IpcResponse<'diagnostics:export'>>
  readonly readWorkspace: (
    request: IpcRequest<'workspace:read'>
  ) => Promise<IpcResponse<'workspace:read'>>
  readonly prepareHandoff: (
    request: IpcRequest<'handoff:prepare'>
  ) => Promise<IpcResponse<'handoff:prepare'>>
  readonly sendHandoff: (
    request: IpcRequest<'handoff:send'>
  ) => Promise<IpcResponse<'handoff:send'>>
  /** Returns an unsubscribe function. */
  readonly onEvents: (listener: (events: TranscriptEvent[]) => void) => () => void
}
