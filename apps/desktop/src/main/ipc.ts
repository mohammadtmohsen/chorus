import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDiagnostics } from '@chorus/shared'
import { homedir } from 'node:os'
import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import {
  EVENTS_PUSH_CHANNEL,
  IDE_PUSH_CHANNEL,
  CONTEXT_PUSH_CHANNEL,
  TASKS_PUSH_CHANNEL,
  TERMINAL_PUSH_CHANNEL,
  LIMITS_PUSH_CHANNEL,
  IPC_CONTRACT,
  type IdeContextPush,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type TranscriptEvent,
} from '../shared/ipc.js'
import { toDisplayRange, type EditorMetadata } from '@chorus/ide-protocol'
import { projectRelativePath, type CanonicalRoot } from '@chorus/workspace'
import type { IdeBridge } from './ide-bridge.js'
import {
  defaultDeps,
  extensionStatus,
  installBundledExtension,
  openProjectInEditor,
  resolveVsix,
} from './ide-extension.js'
import { probeAgents } from './agent-probe.js'
import { completeFiles } from './files.js'
import { listPlugins } from './plugins.js'
import type { ChorusRuntime } from './runtime.js'
import type { WorkspaceSnapshot } from '../shared/workspace-layout.js'
import { readSettings, writeSettings, type Settings } from './settings.js'
import { previewFile, stashFile } from './stash.js'

type Handlers = { [C in IpcChannel]: (request: never) => Promise<IpcResponse<C>> }

const OK = { ok: true } as const

/**
 * The bridge, if it started. Held here rather than threaded through
 * `buildHandlers` because editor context is optional: every other handler must
 * work identically whether or not VS Code is involved.
 */
let ideBridge: IdeBridge | null = null

export function attachIdeBridge(bridge: IdeBridge | null): void {
  ideBridge = bridge
}

/**
 * The VSIX shipped with this build, and the `code` CLI to install it with.
 *
 * Resolved per call rather than cached: `code` can be installed while Chorus is
 * running, and a user who follows the "Shell Command: Install 'code'" hint
 * should not have to restart the app for the button to appear.
 */
function extensionDeps(): ReturnType<typeof defaultDeps> {
  const vsix = (): string | null =>
    resolveVsix({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    })
  return defaultDeps({
    vsixPath: vsix,
    // The extension is versioned with the app it ships inside, so the app's own
    // version is what the bundled VSIX carries.
    bundledVersion: () => (vsix() === null ? null : app.getVersion()),
  })
}

/**
 * What the renderer is allowed to see about an editor.
 *
 * The absolute path is dropped here and never sent: a pane shows a path
 * relative to its own project, so it cannot display — or leak into a
 * screenshot — where the project sits on disk. This is also the boundary where
 * VS Code's zero-based lines become the one-based numbers a human reads.
 */
function toPushFile(root: CanonicalRoot, editor: EditorMetadata): IdeContextPush['file'] {
  const relativePath = projectRelativePath(root, editor.filePath)
  if (relativePath === null) return null
  const range = toDisplayRange(editor.selection)
  return {
    relativePath,
    startLine: range.startLine,
    endLine: range.endLine,
    isEmpty: editor.selection.isEmpty,
    isDirty: editor.isDirty,
    languageId: editor.languageId,
    selectedBytes: editor.selection.selectedBytes,
  }
}

/**
 * Exported for tests.
 *
 * The folder chooser is a native modal: it cannot be opened and dismissed by a
 * driver, so the only way to exercise picking *and* cancelling is to call the
 * handler with `dialog` stubbed.
 */
export function buildHandlers(runtime: ChorusRuntime): Handlers {
  return {
    'app:getInfo': () =>
      Promise.resolve({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        chromeVersion: process.versions.chrome,
        platform: process.platform,
        home: homedir(),
      }),

    'agents:probe': () => probeAgents(),

    'limits:refresh': async () => {
      await runtime.refreshLimits()
      return OK
    },

    'terminal:attach': async (request: IpcRequest<'terminal:attach'>) => {
      const size =
        request.cols === undefined || request.rows === undefined
          ? undefined
          : { cols: request.cols, rows: request.rows }
      return await runtime.attachTerminal(request.ref, size)
    },

    'terminal:detach': (request: IpcRequest<'terminal:detach'>) => {
      runtime.detachTerminal(request.ref, request.epoch)
      return Promise.resolve(OK)
    },

    'terminal:dispose': (request: IpcRequest<'terminal:dispose'>) => {
      runtime.disposeTerminal(request.ref, request.epoch)
      return Promise.resolve(OK)
    },

    'terminal:write': (request: IpcRequest<'terminal:write'>) => {
      runtime.writeTerminal(request.ref, request.epoch, request.data)
      return Promise.resolve(OK)
    },

    'terminal:resize': (request: IpcRequest<'terminal:resize'>) => {
      runtime.resizeTerminal(request.ref, request.epoch, request.cols, request.rows)
      return Promise.resolve(OK)
    },

    'terminal:ack': (request: IpcRequest<'terminal:ack'>) => {
      runtime.ackTerminal(request.ref, request.epoch, request.seq)
      return Promise.resolve(OK)
    },

    'terminal:clear': (request: IpcRequest<'terminal:clear'>) => {
      runtime.clearTerminal(request.ref, request.epoch)
      return Promise.resolve(OK)
    },

    'terminal:describe': (request: IpcRequest<'terminal:describe'>) =>
      Promise.resolve(runtime.describeTerminal(request.ref)),

    'app:setBadge': (request: { count: number }) => {
      // macOS shows the number; other platforms show a dot or nothing, which is
      // why a zero has to clear rather than draw.
      app.setBadgeCount(request.count)
      return Promise.resolve(OK)
    },

    'app:focus': () => {
      const window = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (window !== undefined) {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      }
      return Promise.resolve(OK)
    },

    'conversation:start': (request: {
      agents: ('codex' | 'claude')[]
      cwd: string
      profileId?: string
    }) =>
      runtime.startConversation({
        agents: request.agents,
        cwd: request.cwd,
        ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
      }),

    'conversation:send': async (request: { conversationId: string; text: string }) => {
      const { targets } = await runtime.send(request.conversationId, request.text)
      // Copied out of the readonly domain type; the IPC boundary is plain JSON.
      return { targets: [...targets] }
    },

    'conversation:interrupt': async (request: { conversationId: string }) => {
      await runtime.interrupt(request.conversationId)
      return OK
    },

    'conversation:addAgent': (request: { conversationId: string; agentId: 'codex' | 'claude' }) =>
      runtime.addParticipant(request.conversationId, request.agentId),

    'conversation:removeAgent': (request: {
      conversationId: string
      agentId: 'codex' | 'claude'
    }) => runtime.removeParticipant(request.conversationId, request.agentId),

    'conversation:restore': () => runtime.restoreOpenConversations(),

    'conversation:list': () =>
      Promise.resolve({
        // Copied out of the readonly domain type; the IPC boundary is plain JSON.
        conversations: runtime.listConversations().map((c) => ({ ...c, agents: [...c.agents] })),
      }),

    'conversation:reopen': (request: { conversationId: string }) =>
      runtime.reopenConversation(request.conversationId),

    'agents:mcp': async () => ({
      servers: (await runtime.mcpServers()).map((server) => ({
        name: server.name,
        status: server.status,
        ...(server.error === undefined ? {} : { error: server.error }),
        ...(server.tools === undefined ? {} : { tools: server.tools }),
      })),
    }),

    'tasks:stop': async (request: {
      conversationId: string
      agentId: 'codex' | 'claude'
      taskId: string
    }) => {
      await runtime.stopTask(request.conversationId, request.agentId, request.taskId)
      return OK
    },

    'agents:plugins': async () => ({ plugins: await listPlugins() }),

    'agents:account': async () => ({
      accounts: (await runtime.accounts()).map(({ agentId, account }) => ({
        agentId,
        ...(account.email === undefined ? {} : { email: account.email }),
        ...(account.organization === undefined ? {} : { organization: account.organization }),
        ...(account.plan === undefined ? {} : { plan: account.plan }),
        ...(account.provider === undefined ? {} : { provider: account.provider }),
      })),
    }),

    'agents:models': () =>
      Promise.resolve({
        agents: runtime.knownModels().map((agent) => ({
          agentId: agent.agentId,
          status: agent.status,
          models: agent.models.map((model) => ({
            value: model.value,
            label: model.label,
            effortLevels: [...(model.effortLevels ?? [])],
            ...(model.isDefault === true ? { isDefault: true } : {}),
          })),
        })),
      }),

    'files:complete': (request: { conversationId: string; query: string }) =>
      completeFiles(runtime.projectDirectory(request.conversationId), request.query),

    'conversation:commands': async (request: { conversationId: string }) => ({
      commands: await runtime.listCommands(request.conversationId),
    }),

    'conversation:planMode': async (request: { conversationId: string; on: boolean }) => {
      await runtime.setPlanMode(request.conversationId, request.on)
      return { planning: runtime.planning(request.conversationId) }
    },

    'conversation:draft': (request: { conversationId: string; draft: string }) => {
      runtime.rememberDraft(request.conversationId, request.draft)
      return Promise.resolve(OK)
    },

    'conversation:markSeen': (request: { conversationId: string; seq: number }) => {
      runtime.markSeen(request.conversationId, request.seq)
      return Promise.resolve(OK)
    },

    'conversation:restart': (request: { conversationId: string }) =>
      runtime.restartConversation(request.conversationId),

    'files:stash': (request: { name: string; base64: string }) =>
      Promise.resolve({
        path: stashFile(app.getPath('userData'), request.name, request.base64),
      }),

    'files:preview': (request: { path: string }) => Promise.resolve(previewFile(request.path)),

    'conversation:layout': (request: { order: string[]; workspace: WorkspaceSnapshot }) => {
      runtime.setConversationLayout(request.order, request.workspace)
      return Promise.resolve(OK)
    },

    'conversation:rename': (request: { conversationId: string; title: string }) =>
      Promise.resolve(runtime.renameConversation(request.conversationId, request.title)),

    'conversation:chooseCwd': async (request: { conversationId: string }) => {
      const current = runtime.projectDirectory(request.conversationId)
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: OpenDialogOptions = {
        // `createDirectory` lets a new project be started from the panel itself,
        // which is otherwise a trip to Finder and back.
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: current,
        buttonLabel: 'Use this folder',
      }

      // Attached to the window when there is one, so it arrives as a sheet
      // rather than a panel floating loose over the desktop.
      const result = await (window === undefined
        ? dialog.showOpenDialog(options)
        : dialog.showOpenDialog(window, options))

      const chosen = result.canceled ? undefined : result.filePaths[0]
      if (chosen === undefined) {
        return {
          cwd: current,
          title: runtime.conversationTitle(request.conversationId),
          changed: false,
        }
      }

      // Through the runtime, so the change is validated and recorded exactly as
      // a typed one is.
      const { cwd, title } = runtime.setProjectDirectory(request.conversationId, chosen)
      return { cwd, title, changed: cwd !== current }
    },

    'conversation:setCwd': (request: { conversationId: string; cwd: string }) =>
      Promise.resolve(runtime.setProjectDirectory(request.conversationId, request.cwd)),

    'conversation:close': async (request: { conversationId: string }) => {
      await runtime.closeConversation(request.conversationId)
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

    'userinput:extend': (request: {
      conversationId: string
      userInputId: string
      engaged: boolean
    }) =>
      Promise.resolve({
        expiresAt: runtime.extendUserInput(
          request.conversationId,
          request.userInputId,
          request.engaged
        ),
      }),

    'userinput:answer': async (request: {
      conversationId: string
      agentId: 'codex' | 'claude'
      userInputId: string
      outcome: 'answered' | 'cancel'
      answers: { questionId: string; values: string[] }[]
    }) => {
      await runtime.answerUserInput(
        request.conversationId,
        request.agentId,
        request.userInputId,
        request.outcome === 'answered'
          ? { outcome: 'answered', answers: request.answers }
          : { outcome: 'cancel' }
      )
      return OK
    },

    'policy:set': (request: { conversationId: string; profileId: string }) =>
      Promise.resolve(runtime.setProfile(request.conversationId, request.profileId)),

    'policy:profiles': () => Promise.resolve(runtime.availableProfiles()),

    'settings:read': () => Promise.resolve(readSettings(app.getPath('userData'))),

    'settings:write': (request: Partial<Settings>) => {
      const path = app.getPath('userData')
      const current = readSettings(path)
      /*
       * Merged over what is on disk, so a field the renderer did not send keeps
       * whatever the menu or a previous session left there. Zod drops absent
       * keys rather than passing them as undefined, so the spread is safe.
       *
       * The per-agent maps need their own merge, one level deeper. A spread is
       * shallow, so sending `{ models: { codex: 'x' } }` would replace the whole
       * map and silently drop Claude's — a caller setting one agent's model
       * clearing the other's, with nothing on screen to show it had happened.
       */
      return Promise.resolve(
        writeSettings(path, {
          ...current,
          ...request,
          models: { ...current.models, ...request.models },
          efforts: { ...current.efforts, ...request.efforts },
        })
      )
    },

    'diagnostics:read': () =>
      Promise.resolve(
        runtime.log.recent().map((e) => ({
          at: e.at,
          level: e.level,
          message: e.message,
          ...(e.fields === undefined ? {} : { fields: e.fields }),
        }))
      ),

    'diagnostics:export': () => {
      const path = join(app.getPath('desktop'), `chorus-diagnostics-${String(Date.now())}.md`)
      writeFileSync(
        path,
        buildDiagnostics({
          generatedAt: Date.now(),
          entries: runtime.log.recent(500),
          versions: {
            chorus: app.getVersion(),
            electron: process.versions.electron,
            node: process.versions.node,
          },
          counts: { events: runtime.store.lastSeq() },
        }),
        'utf8'
      )
      // Revealed rather than opened: the user attaches it somewhere, they do
      // not need it displayed.
      shell.showItemInFolder(path)
      return Promise.resolve({ path })
    },

    /**
     * The one moment source code crosses into Chorus, and it happens because
     * the user pressed Send.
     *
     * Everything is re-derived here rather than trusted from the live push:
     * the selection may have moved since the pill was drawn, and the file may
     * no longer belong to this conversation at all. A failure returns a reason
     * the composer can explain instead of throwing, because the caller's job is
     * to keep the draft, not to handle an exception on a path taken constantly.
     */
    'ide:extensionStatus': () => extensionStatus(extensionDeps()),

    'ide:installExtension': () => installBundledExtension(extensionDeps()),

    'ide:openProject': (request: { conversationId: string }) =>
      openProjectInEditor(runtime.projectDirectory(request.conversationId), extensionDeps()),

    'ide:snapshot': async (request: { conversationId: string }) => {
      const bridge = ideBridge
      if (bridge === null) return { outcome: 'unavailable', reason: 'unavailable' } as const

      const cwd = runtime.projectDirectory(request.conversationId)
      const root = bridge.rootFor(cwd)
      const result = await bridge.requestSnapshot(root)
      if (result.outcome !== 'ok') return result

      const { snapshot } = result
      const relativePath = projectRelativePath(root, snapshot.filePath)
      // Re-checked after the answer came back, closing the race between the
      // live metadata and Send.
      if (relativePath === null) return { outcome: 'unavailable', reason: 'unmatched' } as const

      const range = toDisplayRange(snapshot.selection)
      return {
        outcome: 'ok',
        relativePath,
        startLine: range.startLine,
        endLine: range.endLine,
        isEmpty: snapshot.selection.isEmpty,
        isDirty: snapshot.isDirty,
        languageId: snapshot.languageId,
        text: snapshot.selection.text,
      } as const
    },

    'workspace:read': async (request: { conversationId: string }) => {
      const { status, diff, problem } = await runtime.readWorkspace(request.conversationId)
      // Copied out of the readonly domain types; the IPC boundary is plain JSON.
      return {
        problem,
        status: {
          branch: status.branch,
          upstream: status.upstream,
          ahead: status.ahead,
          behind: status.behind,
          clean: status.clean,
          files: status.files.map((f) => ({
            path: f.path,
            ...(f.from === undefined ? {} : { from: f.from }),
            state: f.state,
            staged: f.staged,
            unstaged: f.unstaged,
          })),
        },
        diff: diff.map((f) => ({
          path: f.path,
          oldPath: f.oldPath,
          added: f.added,
          removed: f.removed,
          binary: f.binary,
          hunks: f.hunks.map((h) => ({
            header: h.header,
            lines: h.lines.map((l) => ({
              kind: l.kind,
              text: l.text,
              ...(l.before === undefined ? {} : { before: l.before }),
              ...(l.after === undefined ? {} : { after: l.after }),
            })),
          })),
        })),
      }
    },

    'handoff:prepare': (request: {
      conversationId: string
      from: 'codex' | 'claude'
      to: 'codex' | 'claude'
      sourceEventIds: string[]
      includeDiff?: boolean
      intent?: 'implement' | 'review' | 'discuss'
      note?: string
    }) =>
      Promise.resolve(
        runtime.prepareHandoff(request.conversationId, {
          from: request.from,
          to: request.to,
          sourceEventIds: request.sourceEventIds,
          ...(request.includeDiff === undefined ? {} : { includeDiff: request.includeDiff }),
          ...(request.intent === undefined ? {} : { intent: request.intent }),
          ...(request.note === undefined ? {} : { note: request.note }),
        })
      ),

    'handoff:send': (request: {
      conversationId: string
      from: 'codex' | 'claude'
      to: 'codex' | 'claude'
      sourceEventIds: string[]
      brief: string
    }) =>
      runtime.sendHandoff(request.conversationId, {
        from: request.from,
        to: request.to,
        sourceEventIds: request.sourceEventIds,
        brief: request.brief,
      }),

    /*
     * Everything the renderer says about the passage is re-checked in
     * `openAside` against what the log holds. Nothing is taken on trust here,
     * which is why this handler is a straight pass-through rather than the place
     * the validation lives — the check belongs next to the store, not next to
     * the boundary that could be bypassed.
     */
    'aside:open': (request: {
      conversationId: string
      sourceEventId: string
      excerpt: string
      question?: string
      purpose?: 'question' | 'explanation' | 'translation'
    }) => runtime.openAside(request),

    'aside:ask': async (request: { asideId: string; question: string }) => {
      await runtime.askAside(request.asideId, request.question)
      return { ok: true as const }
    },

    'aside:promote': (request: { asideId: string; profileId: string }) =>
      runtime.promoteAside(request.asideId, request.profileId),

    'aside:close': async (request: { asideId: string }) => {
      await runtime.closeAside(request.asideId)
      return { ok: true as const }
    },

    'aside:list': (request: { conversationId: string; sourceEventId?: string }) =>
      Promise.resolve(
        runtime.listAsides(
          request.conversationId,
          ...(request.sourceEventId === undefined ? [] : [request.sourceEventId])
        )
      ),
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
/** Sends account usage windows to every window as providers report them. */
export function forwardLimitsToRenderer(runtime: ChorusRuntime): void {
  runtime.onLimitsReported((push) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(LIMITS_PUSH_CHANNEL, push)
    }
  })
}

/** Sends each conversation's context-window fill as its agents finish a turn. */
export function forwardContextUsageToRenderer(runtime: ChorusRuntime): void {
  runtime.onContextUsageReported((push) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CONTEXT_PUSH_CHANNEL, push)
    }
  })
}

/** Sends what each conversation's agents have left running, as it changes. */
export function forwardTasksToRenderer(runtime: ChorusRuntime): void {
  runtime.onTasksReported((push) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(TASKS_PUSH_CHANNEL, push)
    }
  })
}

/**
 * Push terminal output to the renderer.
 *
 * Broadcast to every window rather than routed, like the other pushes here: the
 * `ref` and `epoch` on each payload are what a view filters on, and a window
 * with no terminal attached simply has no listener that cares.
 */
export function forwardTerminalToRenderer(runtime: ChorusRuntime): () => void {
  return runtime.onTerminalOutput((push) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(TERMINAL_PUSH_CHANNEL, push)
    }
  })
}

/**
 * Push each open conversation's editor context to the renderer.
 *
 * Scoped per conversation on this side of the boundary: a pane is sent its own
 * project's state and nothing else, so a renderer bug cannot show one project's
 * file in another's composer.
 */
export function forwardIdeContextToRenderer(runtime: ChorusRuntime, bridge: IdeBridge): () => void {
  const push = (): void => {
    const payloads: IdeContextPush[] = runtime
      .openConversations()
      .map(({ conversationId, cwd }) => {
        const root = bridge.rootFor(cwd)
        const context = bridge.contextFor(root)
        const file = context.editor === null ? null : toPushFile(root, context.editor)
        // A file that fails the relative-path check is not this project's, so the
        // status must not claim otherwise.
        const status = context.status === 'ready' && file === null ? 'unmatched' : context.status
        return { conversationId, status, file }
      })

    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      for (const payload of payloads) window.webContents.send(IDE_PUSH_CHANNEL, payload)
    }
  }

  const unsubscribeBridge = bridge.subscribe(push)
  // Also on runtime events: a conversation that opens or moves needs its first
  // push without waiting for the editor to change.
  const unsubscribeRuntime = runtime.subscribe(push)
  push()
  return () => {
    unsubscribeBridge()
    unsubscribeRuntime()
  }
}

export function forwardEventsToRenderer(runtime: ChorusRuntime): () => void {
  return runtime.subscribe((events) => {
    const payload = events.map(toTranscript)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(EVENTS_PUSH_CHANNEL, payload)
    }
  })
}
