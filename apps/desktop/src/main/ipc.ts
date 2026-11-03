import {
  remoteProjectHost,
  type LiveState,
  type StoredEvent,
  type TranscriptState,
} from '@chorus/event-store'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildDiagnostics, type AgentId } from '@chorus/shared'
import { homedir } from 'node:os'
import {
  app,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  shell,
  type BrowserWindow,
  type OpenDialogOptions,
} from 'electron'
import {
  ACTIVITY_PUSH_CHANNEL,
  ATTENTION_PUSH_CHANNEL,
  REVEAL_PUSH_CHANNEL,
  DIAGNOSTIC_PUSH_CHANNEL,
  EVENTS_PUSH_CHANNEL,
  IDE_PUSH_CHANNEL,
  CONTEXT_PUSH_CHANNEL,
  CONVERSATION_NOTE_JOURNAL_CHANNEL,
  CONVERSATION_NOTE_PUSH_CHANNEL,
  ConversationNoteJournalRequest,
  ConversationNoteJournalResponse,
  TASKS_PUSH_CHANNEL,
  TERMINAL_PUSH_CHANNEL,
  LIMITS_PUSH_CHANNEL,
  SETTINGS_PUSH_CHANNEL,
  IPC_CONTRACT,
  type IdeContextPush,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type LiveStateWire,
  type TranscriptAssignment,
  type TranscriptEvent,
  type SettingsWithSecrets,
} from '../shared/ipc.js'
import { MAX_SELECTED_BYTES, toDisplayRange, type EditorMetadata } from '@chorus/ide-protocol'
/*
 * `isWithin` is `ide-protocol`'s `isInside` with this process's platform already
 * supplied. The shared rule stopped defaulting its platform — it is bundled into
 * the workbench renderer, where `process` does not exist — and `path-safety.ts`
 * is main's one place for that assumption. Importing the raw rule here would be
 * a second.
 */
import {
  isWithin,
  projectRelativePath,
  remoteProjectRoot,
  type CanonicalRoot,
} from '@chorus/workspace'
import type { TaskBundle } from '../shared/task-progress.js'
import type { IdeBridge } from './ide-bridge.js'
import { SshRemoteHost } from './remote-host.js'
import { focusedShellWindow, isShellSender, shellWindows } from './shell-windows.js'
import { checkRemoteHost, REMOTE_CHECK_DEADLINE_MS } from './remote-workbench.js'
import {
  defaultDeps,
  extensionStatus,
  installBundledExtension,
  openFileInEditor,
  openProjectInEditor,
  readBundledVersion,
  resolveVsix,
} from './ide-extension.js'
import { canonicalPath } from './real-path.js'
import { copyNoteImageTo, fetchNoteImage, pickNoteImage, saveNoteImage } from './note-images.js'
import { probeAgents } from './agent-probe.js'
import { completeFiles } from './files.js'
import { installSkill, listPlugins } from './plugins.js'
import { checkTypesafeKey } from './typesafe.js'
import type { ChorusRuntime } from './runtime.js'
import type { WorkspaceSnapshot } from '../shared/workspace-layout.js'
import { readSettings, writeSettings, type Settings } from './settings.js'
import { detachedWindowOf, raise } from './detached-windows.js'
import { PROJECT_CLOSED_PUSH_CHANNEL } from '../shared/detached-window-ipc.js'
import { agentKeyIsSet, clearAgentKey, writeAgentKey } from './agent-secrets.js'
import { invalidateCompletionCredential } from './completion-client.js'
import { applyTheme } from './theme.js'
import { previewFile, stashFile } from './stash.js'
import {
  closeWorkbenchProject,
  prepareWorkbenchProjectClose,
  requestWorkbenchReveal,
  requestWorkbenchSnapshot,
  setWorkbenchContextSink,
  setWorkbenchSurfaceGoneSink,
  type WorkbenchContextReport,
} from './workbench-surface.js'

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
    // Read from the sidecar the VSIX build writes, never from the app's own
    // version: the two are separate numbers and assuming otherwise is what made
    // Settings offer an update that could never complete.
    bundledVersion: () => readBundledVersion(vsix()),
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
    // Both are about *which* selection this is rather than where it lives, so
    // neither discloses anything the relative path did not already.
    provenance: editor.provenance,
    source: editor.source,
  }
}

/**
 * Splits `src/foo.ts:42:7` into the file and where in it to land.
 *
 * **Parsed here rather than in the renderer, so both editors get it from one
 * place.** `code -g` has always understood `path[:line[:column]]`, so a line an
 * agent wrote already worked in external VS Code by accident — through the
 * whole suffix reaching the CLI untouched. The embedded editor takes a
 * structured selection instead, so the string has to be taken apart somewhere,
 * and doing it at the boundary keeps the two routes landing on the same line
 * instead of one of them silently opening at the top.
 *
 * **Only a trailing `:<digits>` counts**, which is what keeps a Windows drive
 * letter a drive letter: `C:\src\foo.ts` has a colon with no digits after it
 * and comes back whole. `C:\src\foo.ts:42` still splits, because the match is
 * anchored at the end rather than at the first colon.
 *
 * Exported for tests: it is a pure function over strings and the interesting
 * cases are all shapes of path rather than states of the app.
 */
export function splitFileLocation(raw: string): {
  path: string
  line: number | null
  column: number | null
} {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw)
  const [, file, lineText, columnText] = match ?? []
  /*
   * A path that is *only* a position — `:42` — is not a file, and resolving it
   * against the project root would open the folder. Left whole, so containment
   * and the editor deal with it as the nonsense it is.
   */
  if (file === undefined || file === '' || lineText === undefined) {
    return { path: raw, line: null, column: null }
  }
  return {
    path: file,
    line: Number(lineText),
    column: columnText === undefined ? null : Number(columnText),
  }
}

/**
 * Exported for tests.
 *
 * The folder chooser is a native modal: it cannot be opened and dismissed by a
 * driver, so the only way to exercise picking *and* cancelling is to call the
 * handler with `dialog` stubbed.
 */
/**
 * What a renderer is told about the credentials main holds: that they exist.
 *
 * One function rather than a spread at each call site, so there is a single
 * place to read when the question is "can the renderer see the key" — and a
 * single place to change if another agent ever needs one.
 */
function withSecretState(settings: Settings): SettingsWithSecrets {
  const path = app.getPath('userData')
  return {
    ...settings,
    deepseekKeySet: agentKeyIsSet(path, 'deepseek'),
    typesafeKeySet: agentKeyIsSet(path, 'typesafe'),
    completionDeepseekKeySet: agentKeyIsSet(path, 'completion-deepseek'),
    completionCodestralKeySet: agentKeyIsSet(path, 'completion-codestral'),
  }
}

const MAX_SHOWN = 50
const shown = new Set<Notification>()

export function buildHandlers(
  runtime: ChorusRuntime,
  mainWindow: () => BrowserWindow | null
): Handlers {
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

    'agents:probe': () => probeAgents(app.getPath('userData')),

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

    'terminal:kill': (request: IpcRequest<'terminal:kill'>) => {
      runtime.killTerminal(request.ref)
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

    'app:notify': (request: IpcRequest<'app:notify'>) => {
      if (!Notification.isSupported() || !readSettings(app.getPath('userData')).notifications)
        return Promise.resolve(OK)
      const banner = new Notification({ title: request.title, body: request.body, silent: true })
      shown.add(banner)
      if (shown.size > MAX_SHOWN) {
        const oldest = shown.values().next().value
        if (oldest !== undefined) shown.delete(oldest)
      }
      const forget = (): void => {
        shown.delete(banner)
      }
      banner.on('click', () => {
        forget()
        raise(detachedWindowOf(request.projectId) ?? mainWindow())
      })
      banner.on('close', forget)
      banner.show()
      return Promise.resolve(OK)
    },

    'conversation:reveal': (request: IpcRequest<'conversation:reveal'>) => {
      const target = detachedWindowOf(request.projectId) ?? mainWindow()
      if (target === null || target.isDestroyed()) return Promise.resolve(OK)
      raise(target)
      target.webContents.send(REVEAL_PUSH_CHANNEL, request)
      return Promise.resolve(OK)
    },

    'app:copyText': (request: IpcRequest<'app:copyText'>) => {
      // `writeText`, never `write`: an HTML flavour would carry the transcript's
      // markup onto the clipboard, and what the user pointed at is the source.
      clipboard.writeText(request.text)
      return Promise.resolve(OK)
    },

    'project:adopt': async () => {
      const window = focusedShellWindow() ?? shellWindows()[0]
      const options: OpenDialogOptions = {
        // `createDirectory` lets a project be started from the dialog itself,
        // which is otherwise a trip to Finder and back.
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Add project',
      }
      const result = await (window === undefined
        ? dialog.showOpenDialog(options)
        : dialog.showOpenDialog(window, options))

      const chosen = result.canceled ? undefined : result.filePaths[0]
      if (chosen === undefined) return { project: null }

      const { project, created } = runtime.projects.adopt(chosen)
      return { project: { id: project.id, name: project.name, root: project.root, created } }
    },

    'project:adoptRemote': async (request: IpcRequest<'project:adoptRemote'>) => {
      const host = remoteProjectHost(request.host)
      remoteProjectRoot(request.root)
      const window = focusedShellWindow() ?? shellWindows()[0]
      const options: OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Run agents here',
      }
      const result = await (window === undefined
        ? dialog.showOpenDialog(options)
        : dialog.showOpenDialog(window, options))

      const chosen = result.canceled ? undefined : result.filePaths[0]
      if (chosen === undefined) return { project: null }

      const { project, created } = runtime.projects.adoptRemote({
        host,
        root: request.root,
        agentCwd: chosen,
      })
      return { project: { id: project.id, name: project.name, root: project.root, created } }
    },

    'project:checkRemoteHost': async (request: IpcRequest<'project:checkRemoteHost'>) => {
      const remote = new SshRemoteHost(remoteProjectHost(request.host))
      const check = await checkRemoteHost(remote, REMOTE_CHECK_DEADLINE_MS)
      return check
    },

    'conversation:start': (request: IpcRequest<'conversation:start'>) =>
      runtime.startConversation({
        projectId: request.projectId,
        ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
        ...(request.continueFrom === undefined ? {} : { continueFrom: request.continueFrom }),
        ...(request.objective === undefined ? {} : { objective: request.objective }),
        ...(request.sourceEventIds === undefined ? {} : { sourceEventIds: request.sourceEventIds }),
      }),

    'conversation:begin': (request: IpcRequest<'conversation:begin'>) =>
      Promise.resolve(
        runtime.beginConversation({
          projectId: request.projectId,
          ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
          ...(request.continueFrom === undefined ? {} : { continueFrom: request.continueFrom }),
          ...(request.objective === undefined ? {} : { objective: request.objective }),
          ...(request.sourceEventIds === undefined
            ? {}
            : { sourceEventIds: request.sourceEventIds }),
        })
      ),

    'conversation:awaitStart': (request: IpcRequest<'conversation:awaitStart'>) =>
      runtime.awaitStart(request.conversationId),

    'conversation:send': async (request: IpcRequest<'conversation:send'>) => {
      const { targets } = await runtime.send(
        request.conversationId,
        request.text,
        request.intent,
        request.mode
      )
      // Copied out of the readonly domain type; the IPC boundary is plain JSON.
      return { targets: [...targets] }
    },

    'conversation:interrupt': async (request: { conversationId: string }) => {
      await runtime.interrupt(request.conversationId)
      return OK
    },

    'conversation:restore': () => runtime.restoreOpenConversations(),

    'conversation:active': () => Promise.resolve({ sessions: runtime.activeSessions() }),

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

    'tasks:stop': async (request: { conversationId: string; agentId: AgentId; taskId: string }) => {
      await runtime.stopTask(request.conversationId, request.agentId, request.taskId)
      return OK
    },

    'agents:plugins': async () => ({ plugins: await listPlugins() }),

    'agents:installSkill': async ({ skill }) => {
      const outcome = await installSkill(skill)
      return outcome.state === 'failed' ? outcome : { ...outcome, detail: '' }
    },

    /*
     * The request's `service` is an enum of one and is not read yet. It is an
     * enum rather than an empty object so that a second service arrives as a
     * member here rather than as a second channel — at which point this becomes
     * a lookup and the linter's exhaustiveness check starts earning its keep.
     */
    'agents:checkServiceKey': async () => {
      const check = await checkTypesafeKey(app.getPath('userData'))
      return check.state === 'unreachable' ? check : { ...check, detail: '' }
    },

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
      completeFiles(runtime.agentDirectory(request.conversationId), request.query),

    'conversation:commands': async (request: { conversationId: string }) => ({
      commands: await runtime.listCommands(request.conversationId),
    }),

    'conversation:planMode': async (request: { conversationId: string; on: boolean }) => {
      await runtime.setPlanMode(request.conversationId, request.on)
      return { planning: runtime.planning(request.conversationId) }
    },

    'conversation:answerStyle': async (request: { conversationId: string; on?: boolean }) => {
      // No `on` is a read. See the channel's own comment for why it is one
      // channel rather than two.
      if (request.on !== undefined) await runtime.setAnswerStyle(request.conversationId, request.on)
      return { styleOn: runtime.answerStyle(request.conversationId) }
    },

    'conversation:draft': (request: { conversationId: string; draft: string }) => {
      runtime.rememberDraft(request.conversationId, request.draft)
      return Promise.resolve(OK)
    },

    'conversation:markSeen': (request: { conversationId: string; seq: number }) => {
      runtime.markSeen(request.conversationId, request.seq)
      return Promise.resolve(OK)
    },

    'files:stash': (request: { name: string; base64: string }) =>
      Promise.resolve({
        path: stashFile(app.getPath('userData'), request.name, request.base64),
      }),

    'files:stashNoteImage': (request: { url: string }) =>
      copyNoteImageTo(app.getPath('userData'), request.url),

    'files:preview': (request: { path: string }) => Promise.resolve(previewFile(request.path)),

    /*
     * A folder to attach, and nothing else.
     *
     * `conversation:chooseCwd` below opens the same dialog and then moves the
     * project. This one takes no conversation id precisely so it cannot: an
     * agent silently starting to work in another tree because someone attached
     * a folder is a failure nobody would think to look for.
     */
    'files:chooseDirectory': async () => {
      const window = focusedShellWindow() ?? shellWindows()[0]
      const options: OpenDialogOptions = {
        properties: ['openDirectory'],
        buttonLabel: 'Attach this folder',
      }
      const result = await (window === undefined
        ? dialog.showOpenDialog(options)
        : dialog.showOpenDialog(window, options))
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    },

    'conversation:layout': (request: { order: string[]; workspace: WorkspaceSnapshot }) => {
      runtime.setConversationLayout(request.order, request.workspace)
      return Promise.resolve(OK)
    },

    'conversation:rename': (request: { conversationId: string; title: string }) =>
      Promise.resolve(runtime.renameConversation(request.conversationId, request.title)),

    'project:list': () => Promise.resolve({ projects: runtime.listProjects() }),

    'project:rename': (request: { projectId: string; name: string }) =>
      Promise.resolve(runtime.renameProject(request.projectId, request.name)),

    /*
     * Ids and no positions, which is what makes this safe to send from a
     * renderer. An index would be the shell's opinion about a list main owns, and
     * a stale one — the rail redraws from a pushed list — would move the wrong
     * tile silently. `beforeId` names the neighbour the tile lands in front of,
     * so the worst a stale drag can do is land beside a project that still
     * exists; `null` is the end, the one place no neighbour can name.
     */
    'project:reorder': (request: { projectId: string; beforeId: string | null }) =>
      Promise.resolve({ projects: runtime.reorderProjects(request.projectId, request.beforeId) }),

    'project:forget': (request: { projectId: string }) =>
      Promise.resolve(runtime.forgetProject(request.projectId)),

    /*
     * Find a project whose folder moved. The picker is opened here rather than
     * a path being accepted from the renderer, for the reason `project:adopt`
     * above does the same: a directory the shell could name is a directory the
     * shell chose, and choosing a project root is the person's decision.
     *
     * Cancelling returns `root: null` rather than throwing — a person backing
     * out of a file dialog is not an error, and the caller has nothing to
     * report.
     */
    'project:relocate': async (request: { projectId: string }) => {
      const window = focusedShellWindow() ?? shellWindows()[0]
      const options: OpenDialogOptions = {
        properties: ['openDirectory'],
        buttonLabel: 'Use this folder',
      }
      const result = await (window === undefined
        ? dialog.showOpenDialog(options)
        : dialog.showOpenDialog(window, options))

      const chosen = result.canceled ? undefined : result.filePaths[0]
      if (chosen === undefined) return { root: null }

      return { root: runtime.relocateProject(request.projectId, chosen).root }
    },

    'project:setProfile': (request: { projectId: string; profileId: string }) =>
      Promise.resolve(runtime.setProjectProfile(request.projectId, request.profileId)),

    'project:setNotes': (request: { projectId: string; notes: string }) =>
      Promise.resolve(runtime.setProjectNotes(request.projectId, request.notes)),

    'conversation:getNote': (request: IpcRequest<'conversation:getNote'>) =>
      Promise.resolve(runtime.getConversationNote(request.conversationId)),

    'conversation:setNoteText': (request: IpcRequest<'conversation:setNoteText'>) =>
      Promise.resolve(
        runtime.setConversationNoteText(request.conversationId, request.text, request.baseRevision)
      ),

    'conversation:setNoteView': (request: IpcRequest<'conversation:setNoteView'>) => {
      const { conversationId, ...view } = request
      return Promise.resolve(runtime.setConversationNoteView(conversationId, view))
    },

    'app:getNote': () => Promise.resolve(runtime.getAppNote()),

    'app:setNote': (request: { notes: string }) =>
      Promise.resolve(runtime.setAppNote(request.notes)),

    'app:listKeptNotes': () => Promise.resolve(runtime.listKeptNotes()),

    'app:createKeptNote': () => Promise.resolve(runtime.createKeptNote()),

    'app:setKeptNote': (request: { id: string; notes: string }) =>
      Promise.resolve(runtime.setKeptNote(request.id, request.notes)),

    'app:removeKeptNote': (request: { id: string }) =>
      Promise.resolve(runtime.removeKeptNote(request.id)),

    'app:reorderKeptNotes': (request: { ids: string[] }) =>
      Promise.resolve(runtime.reorderKeptNotes(request.ids)),

    'app:setNoteSize': (request: { width: number; height: number | null }) =>
      Promise.resolve(runtime.setAppNoteSize(request.width, request.height)),

    'project:setNoteSize': (request: {
      projectId: string
      width: number | null
      height: number | null
    }) =>
      Promise.resolve(runtime.setProjectNoteSize(request.projectId, request.width, request.height)),

    'app:addNoteImage': (request: { data: string; extension: string }) =>
      saveNoteImage(
        app.getPath('userData'),
        new Uint8Array(Buffer.from(request.data, 'base64')),
        request.extension
      ),

    'app:pickNoteImage': () => pickNoteImage(app.getPath('userData')),

    'app:fetchNoteImage': (request: { address: string }) =>
      fetchNoteImage(app.getPath('userData'), request.address),

    'project:close': async (request: { projectId: string }) => {
      const project = runtime.projects.get(request.projectId)
      if (project === null) throw new Error('That project is no longer registered.')
      const place = { host: project.host, root: project.canonicalRoot }
      await prepareWorkbenchProjectClose(place)
      await runtime.closeProject(request.projectId, () => closeWorkbenchProject(place))
      for (const window of shellWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(PROJECT_CLOSED_PUSH_CHANNEL, { projectId: request.projectId })
        }
      }
      return OK
    },

    'conversation:close': async (request: { conversationId: string }) => {
      await runtime.closeConversation(request.conversationId)
      return OK
    },

    'conversation:history': (request: { conversationId: string; afterSeq?: number }) =>
      Promise.resolve(runtime.history(request.conversationId, request.afterSeq).map(toTranscript)),

    /*
     * The transcript's read, narrowed to what it draws.
     *
     * `throughSeq` is taken **before** the query, deliberately. Taken after, an
     * event appended between the read and the mark would be claimed as seen and
     * never fetched again — a silently missing entry, which is the worst
     * failure this channel could have. Taken before, the worst case is that a
     * few rows are read twice, and the reducer's own `seq <= lastSeq` guard
     * discards them for free.
     */
    'conversation:transcript': (request: {
      conversationId: string
      afterSeq?: number
      beforeSeq?: number
      limit?: number
      live?: boolean
    }) => {
      /*
       * Taken before the read, and that ordering is the correctness story.
       *
       * It is what the renderer advances `lastSeq` to, and it is what stops a
       * conversation whose newest events are all filtered types from re-querying
       * the same range on every push. Taking it *after* would claim to have
       * covered an event appended during the read that the read did not return,
       * and that event would then never be fetched. Before can only ever
       * under-claim, which costs one redundant query rather than a lost message.
       */
      const throughSeq = runtime.logPosition()

      /*
       * Three questions, one channel, and they never combine. `afterSeq` is the
       * live catch-up — everything since. `limit` is a page — the newest rows,
       * or the ones before `beforeSeq`. No `limit` is the whole conversation,
       * which is what everything did before paging existed and what the aside
       * path still wants.
       */
      const events =
        request.limit === undefined
          ? runtime.transcriptHistory(request.conversationId, request.afterSeq)
          : runtime.transcriptPage(request.conversationId, request.limit, request.beforeSeq)

      /*
       * State only when this is not a catch-up. An incremental read is folded
       * into a view that already holds it, and re-sending it would overwrite a
       * live approval card with a snapshot taken a moment earlier.
       */
      const state =
        request.afterSeq === undefined || request.live === true
          ? { state: toTranscriptState(runtime.transcriptState(request.conversationId)) }
          : {}

      return Promise.resolve({ events: events.map(toTranscript), throughSeq, ...state })
    },

    'task:state': (request: { conversationId: string }) => {
      const throughSeq = runtime.logPosition()
      return Promise.resolve({ task: runtime.taskState(request.conversationId), throughSeq })
    },

    'task:close': (request: {
      conversationId: string
      taskId: string
      reason: 'completed' | 'abandoned'
    }) =>
      Promise.resolve({
        closed: runtime.closeTask(request.conversationId, request.taskId, request.reason),
      }),

    'task:bindAssignment': (request: { conversationId: string; taskId: string }) =>
      Promise.resolve({
        bound: runtime.bindAssignment(request.conversationId, request.taskId).outcome !== 'refused',
      }),

    'approval:decide': async (request: {
      conversationId: string
      agentId: AgentId
      approvalId: string
      outcome: 'allow' | 'deny' | 'cancel'
      scope: 'once' | 'session'
      message?: string
    }) => {
      await runtime.decideApproval(
        request.conversationId,
        request.agentId,
        request.approvalId,
        request.outcome === 'allow'
          ? { outcome: 'allow', scope: request.scope }
          : request.outcome === 'deny'
            ? {
                outcome: 'deny',
                // The person's own words when they gave any. The fallback is not
                // decoration: an agent told only "denied" retries the same thing.
                message:
                  request.message !== undefined && request.message.trim() !== ''
                    ? request.message.trim()
                    : 'Denied by the user',
              }
            : { outcome: 'cancel' }
      )
      return OK
    },

    'userinput:answer': async (request: {
      conversationId: string
      agentId: AgentId
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

    'settings:read': () => Promise.resolve(withSecretState(readSettings(app.getPath('userData')))),

    'settings:write': (
      request: Partial<Settings> & {
        deepseekApiKey?: string
        typesafeApiKey?: string
        completionDeepseekApiKey?: string
        completionCodestralApiKey?: string
      }
    ) => {
      const path = app.getPath('userData')
      const current = readSettings(path)
      /*
       * The credential is handled before the preferences and never reaches
       * `writeSettings` — it does not belong in `settings.json` and an empty
       * string is a real instruction rather than a missing value: it is how the
       * field clears a key that is already there.
       */
      const {
        deepseekApiKey,
        typesafeApiKey,
        completionDeepseekApiKey,
        completionCodestralApiKey,
        ...preferences
      } = request
      if (deepseekApiKey !== undefined) {
        if (deepseekApiKey === '') clearAgentKey(path, 'deepseek')
        else writeAgentKey(path, 'deepseek', deepseekApiKey)
      }
      if (typesafeApiKey !== undefined) {
        if (typesafeApiKey === '') clearAgentKey(path, 'typesafe')
        else writeAgentKey(path, 'typesafe', typesafeApiKey)
      }
      const completionTouched =
        preferences.completionProvider !== undefined ||
        completionDeepseekApiKey !== undefined ||
        completionCodestralApiKey !== undefined
      if (completionDeepseekApiKey !== undefined) {
        if (completionDeepseekApiKey === '') clearAgentKey(path, 'completion-deepseek')
        else writeAgentKey(path, 'completion-deepseek', completionDeepseekApiKey)
      }
      if (completionCodestralApiKey !== undefined) {
        if (completionCodestralApiKey === '') clearAgentKey(path, 'completion-codestral')
        else writeAgentKey(path, 'completion-codestral', completionCodestralApiKey)
      }
      if (completionTouched) invalidateCompletionCredential()
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
      const written = writeSettings(path, {
        ...current,
        ...preferences,
        models: { ...current.models, ...preferences.models },
        efforts: { ...current.efforts, ...preferences.efforts },
      })
      const answer = withSecretState(written)
      /*
       * Appearance is the one setting that is not just data to hand back.
       *
       * `nativeTheme.themeSource` is what `prefers-color-scheme` answers from,
       * and CSS, Monaco, xterm and the file icons all read that query — so this
       * single line repaints every one of them. Applied from `written` rather
       * than `request`, so a write that did not mention the theme re-asserts
       * the stored one instead of clearing it.
       */
      applyTheme(written.theme)
      /*
       * Broadcast, including back to the window that asked.
       *
       * A window that reads its own preferences once and then draws from that
       * copy is stale the moment anything else writes — another window, the
       * menu, a driver. Echoing to the sender costs a render and removes the
       * question of which writes need answering and which do not.
       */
      for (const window of shellWindows()) {
        if (!window.isDestroyed()) window.webContents.send(SETTINGS_PUSH_CHANNEL, answer)
      }
      return Promise.resolve(answer)
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
      openProjectInEditor(runtime.agentDirectory(request.conversationId), extensionDeps()),

    /*
     * Resolved and contained here, never trusted from the renderer.
     *
     * The path comes off a transcript row, and a transcript is agent output —
     * so this is the boundary that decides whether `code -g` may be pointed at
     * it. `resolve` against the conversation's own directory makes a relative
     * path meaningful (Codex reports them) and an absolute one unchanged;
     * `isWithin` is the check, and it is segment-wise because `/a/project-old`
     * must not count as inside `/a/project`.
     *
     * A conversation that is no longer open throws from `agentDirectory` —
     * caught, because a pane closing mid-click is a normal race and not
     * something to surface as an unhandled rejection.
     */
    'ide:openFile': async (request: { conversationId: string; path: string }) => {
      let cwd: string
      try {
        cwd = runtime.agentDirectory(request.conversationId)
      } catch {
        return { ok: false, reason: 'outside-project' as const, path: request.path, project: '' }
      }
      const at = splitFileLocation(request.path)
      const target = resolve(cwd, at.path)
      /*
       * Two ways to say yes, and the order is the design.
       *
       * The lexical check is the boundary as it has always been, and it stays
       * first because it is what keeps a symlinked `node_modules` or a linked
       * package in a monorepo working — those resolve *outside* the project and
       * are meant to.
       *
       * The canonical check is an additional way to say yes, never a new way to
       * say no. It exists because the lexical one refused files that were
       * genuinely inside: a project opened as `/var/folders/…` against a path an
       * agent printed as `/private/var/folders/…` is one directory and its own
       * realpath. Measured in the running app, not reasoned about.
       *
       * Trusting the canonical answer *alone* would also close the reverse hole
       * — an outward symlink inside the project passes today — but that refuses
       * the linked dependencies above, so it is a change to what the boundary
       * means rather than a repair of it. Left as a decision, on the board.
       */
      const contained = isWithin(cwd, target) || isWithin(canonicalPath(cwd), canonicalPath(target))
      if (cwd === '' || !contained) {
        // The path and the folder travel with the refusal: the message used to
        // name neither, so "not inside this session's project folder" could not
        // be told apart from a bug in the check itself.
        return { ok: false, reason: 'outside-project' as const, path: target, project: cwd }
      }

      /*
       * The editor in this window first, external VS Code only if there is none
       * — the same ordering `ide:snapshot` uses below, and the same reason.
       * "The editor owns what the editor owns": the workbench the person is
       * looking at should win over an application that may not even be running.
       *
       * `undefined` is the only thing that falls through, and that is load
       * bearing. It means this project has no surface — the Editor switch is
       * off — which is exactly the case the external editor still serves. A
       * surface that answered and refused is a real answer about a real editor,
       * and spawning VS Code on top of it would open a second window for a file
       * the person can already see is missing.
       */
      const revealed = await requestWorkbenchReveal(cwd, {
        path: target,
        line: at.line,
        column: at.column,
      })
      if (revealed !== undefined) {
        return revealed.ok
          ? { ok: true, reason: null }
          : { ok: false, reason: 'open-failed' as const, path: target, project: cwd }
      }

      /*
       * The line goes back onto the path for `code -g`, which takes
       * `path[:line[:column]]` — so the fallback lands where the click asked
       * for, not at the top of the file.
       */
      const goto =
        at.line === null
          ? target
          : `${target}:${String(at.line)}${at.column === null ? '' : `:${String(at.column)}`}`
      return openFileInEditor(goto, extensionDeps())
    },

    'ide:snapshot': async (request: { conversationId: string }) => {
      const cwd = runtime.agentDirectory(request.conversationId)

      /*
       * The embedded editor first, and the external bridge only if there is none.
       *
       * "The editor owns what the editor owns" — the workbench in this window is
       * the one the person is actually looking at, and losing to a VS Code that
       * may not even be open would be the wrong way round. The external bridge
       * stays as the fallback until Phase 8 deletes it.
       */
      /*
       * Asked of the surface, not read from the retained push.
       *
       * The push is debounced and drives the pill; the composer's own comment
       * says sending what the pill said would attach the wrong lines, which is
       * worse than attaching none. This is the same pull the external bridge
       * does, one process over — and it is the only path that carries the
       * selected **text**, which the push omits by design.
       */
      const embedded = await requestWorkbenchSnapshot(runtime.editorPlace(request.conversationId))
      /*
       * Which source answered, and what it said. This path has now been wrong
       * three times — no context at all, then a reference with no code, then a
       * selection read off an editor that was never focused — and each time the
       * app's own log said nothing, so the diagnosis came from reading source.
       * One line ends that.
       */
      runtime.log.info('editor snapshot', {
        source: embedded === undefined ? 'external-bridge' : 'workbench',
        path: embedded?.relativePath ?? null,
        lines:
          embedded === null || embedded === undefined
            ? null
            : `${String(embedded.startLine)}-${String(embedded.endLine)}`,
        bytes: embedded?.selectedBytes ?? 0,
        modelVersion: embedded?.version ?? null,
      })
      if (embedded !== undefined) {
        if (
          embedded?.relativePath == null ||
          embedded.startLine === null ||
          embedded.endLine === null
        ) {
          return { outcome: 'unavailable', reason: 'unmatched' } as const
        }
        /*
         * The same cap the external bridge enforces, and enforced here rather
         * than trusted from the surface: a truncated selection can mean
         * something different from what it was cut out of.
         */
        if (embedded.selectedBytes > MAX_SELECTED_BYTES) {
          return { outcome: 'tooLarge', selectedBytes: embedded.selectedBytes } as const
        }
        return {
          outcome: 'ok',
          relativePath: embedded.relativePath,
          startLine: embedded.startLine,
          endLine: embedded.endLine,
          isEmpty: embedded.isEmpty,
          isDirty: embedded.isDirty,
          languageId: embedded.languageId,
          text: embedded.text,
          ...(embedded.preview === true ? { preview: true as const } : {}),
          ...(embedded.version === null ? {} : { modelVersion: embedded.version }),
          editor: 'workbench' as const,
          /*
           * The surface's own answer, not an assertion.
           *
           * This was `{ kind: 'worktree' }` for every embedded report — true of
           * an ordinary file and false of a GitLab merge-request pane, which
           * shows one side of a diff at a specific commit. Telling an agent it
           * was the worktree pointed it at a file whose current contents are not
           * what the person was looking at. `context.ts` resolves it with the
           * same `resolveDocument` the VS Code extension uses.
           */
          provenance: embedded.provenance,
        } as const
      }

      const bridge = ideBridge
      if (bridge === null) return { outcome: 'unavailable', reason: 'unavailable' } as const

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
        // What decides whether the agent is told to read the file or told that
        // reading it would show something else.
        provenance: snapshot.provenance,
      } as const
    },

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

    'aside:restate': async (request: IpcRequest<'aside:restate'>) => {
      await runtime.restateAside(request.asideId, request.purpose)
      return { ok: true as const }
    },

    'aside:promote': (request: { asideId: string; profileId: string }) =>
      runtime.promoteAside(request.asideId, request.profileId),

    'aside:forward': async (request: { asideId: string; directive: string }) => {
      const { targets } = await runtime.forwardAside(request.asideId, request.directive)
      // Copied out of the readonly domain type; the IPC boundary is plain JSON.
      return { targets: [...targets] }
    },

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

/**
 * The store's readonly arrays flatten to the mutable ones the wire schema infers.
 *
 * Not a formality: `z.array` infers `T[]`, the store returns `readonly T[]`, and
 * the two are genuinely different types. Copying here rather than widening the
 * store's type keeps the immutability where it is useful — inside main, where
 * the same object is handed to more than one caller.
 */
function toTranscriptState(
  state: Omit<TranscriptState, 'assignment'> & {
    assignment?: TranscriptState['assignment']
    replies?: readonly StoredEvent[]
    task?: TaskBundle | null
    live?: LiveState
  }
): {
  approvals: TranscriptState['approvals'][number][]
  questions: TranscriptState['questions'][number][]
  working: string[]
  workingSince?: Record<string, number>
  replies: TranscriptEvent[]
  task?: TaskBundle | null
  live?: LiveStateWire
  assignment?: TranscriptAssignment
  usageByActor: Record<
    string,
    { inputTokens: number; outputTokens: number; costUsd: number | null }
  >
} {
  return {
    approvals: [...state.approvals],
    questions: [...state.questions],
    working: [...state.working],
    ...(state.workingSince === undefined ? {} : { workingSince: { ...state.workingSince } }),
    replies: (state.replies ?? []).map(toTranscript),
    ...(state.task === undefined ? {} : { task: state.task }),
    ...(state.live === undefined ? {} : { live: toLiveState(state.live) }),
    ...(state.assignment === undefined
      ? {}
      : {
          assignment: {
            linked: state.assignment.linked,
            boundTaskId: state.assignment.boundTaskId,
          },
        }),
    usageByActor: { ...state.usageByActor },
  }
}

function toLiveState(live: LiveState): LiveStateWire {
  return {
    work: live.work.map((lane) => ({ ...lane })),
    chat: live.chat.map((lane) => ({ ...lane })),
    operations: live.operations.map((operation) => ({ ...operation })),
    handoffs: live.handoffs.map((handoff) => ({
      ...handoff,
      sourceEventIds: [...handoff.sourceEventIds],
    })),
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
export function registerIpcHandlers(
  runtime: ChorusRuntime,
  mainWindow: () => BrowserWindow | null
): void {
  const handlers = buildHandlers(runtime, mainWindow)

  for (const channel of Object.keys(IPC_CONTRACT) as IpcChannel[]) {
    ipcMain.handle(channel, async (event, rawRequest: unknown) => {
      if (!isShellSender(event)) throw new Error(`"${channel}" is only available to Chorus windows`)
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

  ipcMain.on(CONVERSATION_NOTE_JOURNAL_CHANNEL, (event, rawRequest: unknown) => {
    let reply: ConversationNoteJournalResponse
    try {
      reply = answerConversationNoteJournal(runtime, isShellSender(event), rawRequest)
    } catch {
      reply = { ok: false, error: 'The note journal could not be answered' }
    }
    event.returnValue = reply
  })
}

export function answerConversationNoteJournal(
  runtime: Pick<ChorusRuntime, 'readConversationNoteJournal' | 'compareConversationNoteJournal'>,
  trusted: boolean,
  rawRequest: unknown
): ConversationNoteJournalResponse {
  if (!trusted) return { ok: false, error: 'The note journal is only available to Chorus windows' }
  const parsed = ConversationNoteJournalRequest.safeParse(rawRequest)
  if (!parsed.success) return { ok: false, error: 'Invalid note journal request' }
  const request = parsed.data
  try {
    const answer =
      request.op === 'read'
        ? { matched: true, current: runtime.readConversationNoteJournal(request.conversationId) }
        : runtime.compareConversationNoteJournal(
            request.conversationId,
            request.expected,
            request.next
          )
    const reply = ConversationNoteJournalResponse.safeParse({ ok: true, ...answer })
    return reply.success ? reply.data : { ok: false, error: 'Invalid note journal response' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message.slice(0, 512) }
  }
}

/**
 * Streams committed events to every open window.
 *
 * Push rather than poll so the transcript feels live, but the renderer can
 * always fall back to `conversation:history` — the log is authoritative, so a
 * dropped push is a recoverable gap rather than lost data.
 */
export function forwardLimitsToRenderer(runtime: ChorusRuntime): void {
  runtime.onLimitsReported((push) => {
    for (const window of shellWindows()) {
      if (!window.isDestroyed()) window.webContents.send(LIMITS_PUSH_CHANNEL, push)
    }
  })
}

/** Sends each conversation's context-window fill as its agents finish a turn. */
export function forwardContextUsageToRenderer(runtime: ChorusRuntime): void {
  runtime.onContextUsageReported((push) => {
    for (const window of shellWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CONTEXT_PUSH_CHANNEL, push)
    }
  })
}

/** Sends what each conversation's agents have left running, as it changes. */
export function forwardTasksToRenderer(runtime: ChorusRuntime): void {
  runtime.onTasksReported((push) => {
    for (const window of shellWindows()) {
      if (!window.isDestroyed()) window.webContents.send(TASKS_PUSH_CHANNEL, push)
    }
  })
}

export function forwardConversationNotesToRenderer(runtime: ChorusRuntime): () => void {
  return runtime.onNoteChanged((push) => {
    for (const window of shellWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CONVERSATION_NOTE_PUSH_CHANNEL, push)
    }
  })
}

/**
 * Sends what each conversation's agents say they are doing, as they say it.
 *
 * The loudest of the four state channels — many pushes a turn — and the one
 * whose whole point is that it never reaches SQLite. See `ActivityPush`.
 */
export function forwardActivityToRenderer(runtime: ChorusRuntime): void {
  runtime.onActivityReported((push) => {
    for (const window of shellWindows()) {
      if (!window.isDestroyed()) window.webContents.send(ACTIVITY_PUSH_CHANNEL, push)
    }
  })
}

export function forwardAttentionToRenderer(runtime: ChorusRuntime): void {
  runtime.onAttentionReported((push) => {
    const focused = focusedShellWindow()
    if (focused !== null) {
      focused.webContents.send(ATTENTION_PUSH_CHANNEL, { ...push, mode: 'toast' })
      return
    }
    for (const window of shellWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(ATTENTION_PUSH_CHANNEL, { ...push, mode: 'banner' })
      }
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
    for (const window of shellWindows()) {
      if (!window.isDestroyed()) window.webContents.send(TERMINAL_PUSH_CHANNEL, push)
    }
  })
}

/**
 * The embedded workbench's editor state, routed to that project's conversations
 * — Phase 6 slice 6c.
 *
 * **Project-first, which is the whole rule.** A surface reports; main resolves
 * the root it opened that surface for into a project, and delivers only to
 * conversations carrying that project's id. A conversation in another project
 * cannot receive this no matter what the surface said, because the surface never
 * said which project it was.
 *
 * The payload is the same `IdeContextPush` the external bridge produces, so the
 * renderer, the composer pill and the disclosure controls need no second shape —
 * §5.2's "rework, not rewrite" in one line. `provenance` is `worktree` because an
 * embedded editor is looking at the working tree by construction; the external
 * bridge could be looking at a ref or a review, and this cannot.
 *
 * **Held, never logged.** No `ChorusEventPayload` exists for any of this and none
 * may be added: a cursor position read back a week later is worse than none.
 */
/**
 * The last thing each project's editor reported, held so `ide:snapshot` can
 * answer from it.
 *
 * **Held, and still never logged.** The rule is unchanged — a cursor position
 * read back a week later is worse than none, so this is memory and there is no
 * `ChorusEventPayload` for it. What changed is that pushing it to the renderer
 * and dropping it was not enough: the composer's pill said "ready" from the
 * push, and Send then asked the *external* bridge, which knows nothing about the
 * embedded editor. The pill was right and the send was blind, so an agent was
 * told nothing was open while a file sat open in front of the person.
 *
 * Keyed by host and canonical project root, because that is what a surface belongs to.
 */
const lastWorkbenchContext = new Map<string, WorkbenchContextReport>()

const placeKey = (host: string, projectRoot: string): string => `${host}\n${projectRoot}`

export function forwardWorkbenchContextToRenderer(runtime: ChorusRuntime): () => void {
  const send = ({ host, projectRoot, context }: WorkbenchContextReport): void => {
    const conversations = runtime.conversationsForPlace({ host, root: projectRoot })
    /*
     * Debug, because it is per keystroke — but it is the line that separates the
     * three ways this can fail, and three rounds were spent guessing between
     * them: the surface never reporting, the root not matching a project, and a
     * report arriving with no selection in it. `CHORUS_DEBUG=1` to see it.
     */
    runtime.log.debug('workbench context', {
      host,
      projectRoot,
      conversations: conversations.length,
      path: context.relativePath,
      /*
       * Why the path is what it is. A null used to mean three different bugs —
       * unknown scheme, a review URI that failed validation, or a real file
       * outside this project — and the log could not tell them apart.
       * The scheme only; a `gl-review` query carries repository and merge-request
       * metadata and never reaches a log line.
       */
      scheme: context.scheme,
      editorTypeId: context.editorTypeId,
      reason: context.reason,
      lines:
        context.startLine === null
          ? null
          : `${String(context.startLine)}-${String(context.endLine)}`,
      version: context.version,
    })
    if (conversations.length === 0) return

    /*
     * A report with no file is `unmatched`, not `ready`. The external bridge
     * makes the same correction a few lines below, and for the same reason: a
     * status claiming readiness beside an absent file is the one combination a
     * consumer cannot render honestly.
     */
    const file =
      context.relativePath === null || context.startLine === null || context.endLine === null
        ? null
        : {
            relativePath: context.relativePath,
            startLine: context.startLine,
            endLine: context.endLine,
            isEmpty: context.isEmpty,
            isDirty: context.isDirty,
            languageId: context.languageId,
            selectedBytes: context.selectedBytes,
            /* As reported by the surface — see the snapshot path above. */
            provenance: context.provenance,
            /*
             * Always `current`. The external bridge can be reporting a selection
             * it remembered from before the editor lost focus; this fires from
             * the editor's own events, so there is nothing cached to report and
             * claiming otherwise would make the pill say `cached` about a live
             * cursor.
             */
            source: 'current' as const,
          }

    for (const window of shellWindows()) {
      if (window.isDestroyed()) continue
      for (const conversationId of conversations) {
        window.webContents.send(IDE_PUSH_CHANNEL, {
          conversationId,
          editor: 'workbench' as const,
          status: file === null ? ('unmatched' as const) : ('ready' as const),
          file,
        })
      }
    }
  }

  setWorkbenchContextSink((report) => {
    lastWorkbenchContext.set(placeKey(report.host, report.projectRoot), report)
    send(report)
  })

  /*
   * Replayed when the runtime changes — a conversation opening, a project
   * moving. The external forwarder has done this from the start
   * (`runtime.subscribe(push)`, "a conversation that opens or moves needs its
   * first push without waiting for the editor to change") and this one did not,
   * so a room opened after the last editor event was never told anything.
   *
   * `lastWorkbenchContext` existed and was only ever written. This is the reader
   * it was retained for.
   */
  const replay = (): void => {
    for (const report of lastWorkbenchContext.values()) send(report)
  }
  /*
   * When a project's last surface goes, its held context goes with it and the
   * conversations are told the embedded editor has nothing — which is what lets
   * the external bridge become visible again, since the shell prefers a
   * workbench push only while one exists.
   */
  setWorkbenchSurfaceGoneSink((place) => {
    lastWorkbenchContext.delete(placeKey(place.host, place.root))
    for (const conversationId of runtime.conversationsForPlace(place)) {
      for (const window of shellWindows()) {
        /*
         * **Both objects, because they die separately.** `window.isDestroyed()`
         * alone was the guard here and it is not enough: this sink is reached
         * during quit — the shell's WebContents is destroyed, which releases its
         * surfaces, which lands here — and in that window the `BrowserWindow`
         * still reports alive while the `webContents` underneath it has already
         * gone. `send` then throws `Object has been destroyed` out of a
         * `WebContents` event handler, where nothing catches it, and Electron
         * shows the person a main-process error dialog on every single quit.
         */
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        window.webContents.send(IDE_PUSH_CHANNEL, {
          conversationId,
          editor: 'workbench' as const,
          status: 'unavailable' as const,
          file: null,
        })
      }
    }
  })

  const unsubscribe = runtime.subscribe(replay)
  replay()

  return () => {
    unsubscribe()
    setWorkbenchSurfaceGoneSink(null)
    setWorkbenchContextSink(null)
  }
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
        return { conversationId, editor: 'external' as const, status, file }
      })

    for (const window of shellWindows()) {
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

/**
 * Sends a problem from VS Code to the conversation whose project it belongs to.
 *
 * **Routing is main's, not the extension's.** The extension knows a root; only
 * main knows which conversations are open on it. A root with no conversation is
 * dropped here rather than guessed at — a compiler error landing in a
 * conversation about something else is worse than one landing nowhere, and the
 * person who pressed the button is told by VS Code either way.
 *
 * Every conversation on that root is sent to, which is the honest reading of
 * "this project": two panes on one repository are both looking at the file, and
 * choosing between them from main — which cannot see which pane has focus —
 * would be a guess dressed as a decision. The renderer stages it in each; a
 * draft is not a turn.
 *
 * The absolute path is dropped and the range becomes one-based here, exactly as
 * `toPushFile` does, so a pane never holds where the project sits on disk.
 */
export function forwardDiagnosticsToRenderer(
  runtime: ChorusRuntime,
  bridge: IdeBridge
): () => void {
  return bridge.onDiagnostic((params) => {
    const targets = runtime
      .openConversations()
      .filter(({ cwd }) => String(bridge.rootFor(cwd)) === params.root)

    for (const { conversationId, cwd } of targets) {
      const relativePath = projectRelativePath(bridge.rootFor(cwd), params.filePath)
      // Re-checked after the extension already filtered, for the reason
      // `ide:snapshot` re-checks: main is the security boundary.
      if (relativePath === null) continue
      const range = toDisplayRange({ start: params.range.start, end: params.range.end })
      const payload = {
        conversationId,
        relativePath,
        languageId: params.languageId,
        severity: params.severity,
        ...(params.source === undefined ? {} : { source: params.source }),
        ...(params.code === undefined ? {} : { code: params.code }),
        message: params.message,
        startLine: range.startLine,
        endLine: range.endLine,
        text: params.text,
      }
      for (const window of shellWindows()) {
        if (!window.isDestroyed()) window.webContents.send(DIAGNOSTIC_PUSH_CHANNEL, payload)
      }
    }
  })
}

export function forwardEventsToRenderer(runtime: ChorusRuntime): () => void {
  return runtime.subscribe((events) => {
    const payload = events.map(toTranscript)
    for (const window of shellWindows()) {
      if (!window.isDestroyed()) window.webContents.send(EVENTS_PUSH_CHANNEL, payload)
    }
  })
}
