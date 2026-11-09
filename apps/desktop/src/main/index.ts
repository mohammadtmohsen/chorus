import { electronBrowserSource, electronBrowserSourceOf } from './electron-browser-source.js'
import { electronBrowserPort, electronBrowserDownloads } from './electron-browser-port.js'
import { electronIpcRegistrar, electronShellClient } from './electron-shell-client.js'
import { existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session, webContents, type WebContents } from 'electron'
import {
  attachDetachedWindowListeners,
  closeEveryDetachedWindow,
  detachedAccess,
  detachedWindowOf,
  handOffExpired,
  registerDetachedWindowHandlers,
  type DetachedWindowDeps,
} from './detached-windows.js'
import { registerIpcHandlers } from './ipc.js'
import { EngineClient, type EngineState } from '../../../engine/src/client.js'
import {
  compareVersions,
  desktopDataDirectory,
  readEngineInstall,
  readRuntimeManifest,
  writeEngineInstall,
} from '../../../engine/src/descriptor.js'
import { DESKTOP_WORKSPACE_KEY, desktopClientDirectory } from '../../../engine/src/state.js'
import { readAgentKeys } from './agent-secrets.js'
import { answerEngineHostCall, configureDesktopHostCalls } from './desktop-host-ports.js'
import {
  ENGINE_STATUS_CHANNEL,
  ENGINE_UPDATE_CHANNEL,
  EngineUpdate,
  EVENTS_PUSH_CHANNEL,
  EventsPush,
  IPC_CONTRACT,
  SHELL_PRESENCE_CHANNEL,
  ShellPresence,
} from '../shared/ipc.js'
import type { WindowRole } from '../shared/detached-window-ipc.js'
import type { WorkbenchContextReport } from './ipc-host.js'
import type { WorkbenchPlace } from './project-root.js'
import type { WorkbenchTerminalEnv } from '../shared/workbench-ipc.js'
import {
  GIT_CONTRACT,
  GIT_REVIEW_PUSH_CHANNEL,
  GitReviewEnvelope,
  type GitRequest,
  type GitResponse,
} from '../shared/git-ipc.js'
import { BrowserIpc } from './browser-ipc.js'
import { BrowserConsoles } from './browser-console.js'
import { ConsoleIpc } from './console-ipc.js'
import { BrowserDownloads } from './browser-downloads.js'
import { BrowserSettingsStore } from './browser-settings.js'
import { BROWSER_PARTITION, BrowserSurfaces, isBrowserPage } from './browser-surface.js'
import { BrowserVault } from './browser-vault.js'
import { isShellSender, registerShellWindow } from './shell-windows.js'
import { registerToastWindow, registerToastWindowHandlers } from './toast-windows.js'
import { createLogger } from './logging.js'
import { registerNoteImageScheme, serveNoteImages } from './note-images.js'
import { createQuitGate } from './quit-gate.js'
import { installMenu } from './menu.js'
import { readSettings } from './settings.js'
import { flushWorkbenchStorageWrites } from './workbench-storage.js'
import { readOpenProjects } from './open-projects.js'
import { applyTheme } from './theme.js'
import { applyScale, currentScale } from './scale.js'
import { isReparentMode, runReparentCheck } from './reparent-check.js'
import { applyContentSecurityPolicy, lockDownNavigation } from './security.js'
import { reapedOrphanedServers, setWorkbenchHostLog, stopWorkbenchHost } from './workbench-host.js'
import { setCompletionLog } from './completion-client.js'
import {
  closeAllSurfaces,
  deliverUrl,
  registerWorkbenchHandlers,
  setDetachedAccessPredicate,
  setHandoffExpiredSink,
  setWorkbenchTerminalEnvSource,
  setWorkbenchContextSink,
  setWorkbenchSurfaceGoneSink,
  setWorkbenchReviewSource,
  publishWorkbenchReview,
  resetWorkbenchReviews,
} from './workbench-surface.js'
import { adoptShellPath } from './which.js'

const devServerUrl = process.env['ELECTRON_RENDERER_URL']

let browserIpc: BrowserIpc | null = null
let browserConsoles: BrowserConsoles | null = null
let consoleIpc: ConsoleIpc | null = null
let browserDownloads: BrowserDownloads | null = null
let browserSettings: BrowserSettingsStore | null = null
const adoptedProjectIds = new Set<string>()
const engineWindows = new Map<WebContents, EngineWindow>()
const terminalPlaces = new Map<string, WorkbenchPlace>()
const terminalEnvironment = new Map<string, WorkbenchTerminalEnv | null>()
let projectRefresh: Promise<void> | null = null
let projectRefreshRequested = false
const projectRefreshPending = (): boolean => projectRefreshRequested

interface EngineWindow {
  readonly window: BrowserWindow
  readonly role: WindowRole
  readonly client: EngineClient
  readonly contexts: Map<string, WorkbenchContextReport>
  readonly clearedContexts: Map<string, WorkbenchContextReport>
  presence: ShellPresence
  lastSeq: number
  state: EngineState
  update: EngineUpdate | null
}

const placeKey = (place: WorkbenchPlace): string => `${place.host}\0${place.root}`

function clientFor(sender: WebContents): EngineClient {
  const entry = engineWindows.get(sender)
  if (entry === undefined || sender.isDestroyed()) throw new Error('unknown-shell-window')
  return entry.client
}

async function invokeReview<
  C extends 'git:activeReview' | 'git:openDiff' | 'git:comment' | 'git:reply' | 'git:resolve',
>(owner: WebContents, channel: C, request: GitRequest<C>): Promise<GitResponse<C>> {
  const raw = await clientFor(owner).invoke(channel, request)
  const result = GIT_CONTRACT[channel].response.safeParse(raw)
  if (!result.success) {
    throw new Error(`Malformed response on "${channel}": ${result.error.message}`)
  }
  return result.data as GitResponse<C>
}

function activeClient(): EngineClient {
  const main = [...engineWindows.values()].find((entry) => entry.role.kind === 'main')
  const entry = main ?? engineWindows.values().next().value
  if (entry === undefined) throw new Error('no-shell-window')
  return entry.client
}

function deliver(entry: EngineWindow, channel: string, payload: unknown): void {
  if (!entry.window.isDestroyed() && !entry.window.webContents.isDestroyed())
    entry.window.webContents.send(channel, payload)
}

function publishPresence(entry: EngineWindow): void {
  if (entry.window.isDestroyed() || entry.window.webContents.isDestroyed()) return
  const visible = entry.window.isVisible() && entry.presence.visible
  entry.client.focus(
    entry.window.isFocused(),
    entry.presence.projectIds,
    entry.lastSeq,
    entry.presence.focusedProjectId,
    entry.window.isFocused() && visible && entry.presence.attentive,
    visible
  )
}

function refreshProjects(): Promise<void> {
  projectRefreshRequested = true
  projectRefresh ??= (async () => {
    do {
      projectRefreshRequested = false
      const answer = IPC_CONTRACT['project:list'].response.parse(
        await activeClient().invoke('project:list', {})
      )
      adoptedProjectIds.clear()
      for (const project of answer.projects) adoptedProjectIds.add(project.id)
      const workspace = readOpenProjects(desktopClientDirectory(app.getPath('userData'))).workspace
      const webTabIds = new Set((workspace?.webTabs.tabs ?? []).map((tab) => tab.id))
      const failure = await browserSettings?.prune(adoptedProjectIds, webTabIds)
      if (failure !== undefined && failure !== null)
        mainLog?.warn('browser settings were not pruned', { failure })
    } while (projectRefreshPending())
  })().finally(() => {
    projectRefresh = null
  })
  return projectRefresh
}

async function environmentFor(
  place: WorkbenchPlace,
  ensure: boolean
): Promise<WorkbenchTerminalEnv | null> {
  terminalPlaces.set(placeKey(place), place)
  const value = IPC_CONTRACT['workbench:terminalEnvFor'].response.parse(
    await activeClient().invoke('workbench:terminalEnvFor', { place, ensure })
  )
  terminalEnvironment.set(placeKey(place), value)
  return value
}

async function refreshTerminalEnv(): Promise<void> {
  await Promise.all([...terminalPlaces.values()].map((place) => environmentFor(place, false)))
}

async function resolvePlace(projectId: string): Promise<WorkbenchPlace> {
  const place = IPC_CONTRACT['workbench:target'].response.parse(
    await activeClient().invoke('workbench:target', { projectId })
  )
  terminalPlaces.set(placeKey(place), place)
  return place
}

function connectWindow(window: BrowserWindow, role: WindowRole): EngineWindow {
  const userData = app.getPath('userData')
  const client = new EngineClient({
    dataDirectory: userData,
    install: () => readEngineInstall(userData),
    appVersion: app.getVersion(),
    client: {
      kind: 'desktop',
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
    },
    role,
    clientId: randomUUID(),
    workspaceKey: DESKTOP_WORKSPACE_KEY,
    workspaceFolders: [],
    trusted: true,
    secrets: () => readAgentKeys(userData),
  })
  const entry: EngineWindow = {
    window,
    role,
    client,
    contexts: new Map(),
    clearedContexts: new Map(),
    presence: {
      projectIds: role.kind === 'detached' ? [role.projectId] : [],
      focusedProjectId: role.kind === 'detached' ? role.projectId : null,
      attentive: false,
      visible: true,
    },
    lastSeq: 0,
    state: 'connecting',
    update: null,
  }
  engineWindows.set(window.webContents, entry)
  client.setHostHandler((method, params) => answerEngineHostCall(role, method, params))
  client.onPush((channel, payload) => {
    if (channel === GIT_REVIEW_PUSH_CHANNEL) {
      const state = GitReviewEnvelope.safeParse(payload)
      if (state.success) publishWorkbenchReview(window.webContents, state.data)
    }
    if (channel === EVENTS_PUSH_CHANNEL) {
      const events = EventsPush.safeParse(payload)
      if (events.success) {
        for (const event of events.data) entry.lastSeq = Math.max(entry.lastSeq, event.seq)
        publishPresence(entry)
      }
    }
    if (channel === ENGINE_UPDATE_CHANNEL) {
      const update = EngineUpdate.safeParse(payload)
      if (update.success) entry.update = update.data
    }
    if (channel === 'projects:changed')
      void refreshProjects().catch((error: unknown) => {
        mainLog?.warn('projects could not be refreshed', { error: String(error) })
      })
    deliver(entry, channel, payload)
  })
  client.onState((state) => {
    const changed = entry.state !== state
    entry.state = state
    deliver(entry, ENGINE_STATUS_CHANNEL, { state })
    if (changed && state === 'connected') resetWorkbenchReviews(window.webContents)
    if (state === 'connected') entry.update = null
    if (changed && (state === 'connected' || state === 'restart-required'))
      void client
        .connect()
        .then(async () => {
          publishPresence(entry)
          for (const [key, report] of entry.clearedContexts)
            if (![...engineWindows.values()].some((owner) => owner.contexts.has(key)))
              client.notify({ kind: 'editorContext', report })
          for (const report of entry.contexts.values())
            client.notify({ kind: 'editorContext', report })
          entry.clearedContexts.clear()
          await refreshProjects()
        })
        .catch((error: unknown) => {
          mainLog?.warn('engine window could not be refreshed', { error: String(error) })
        })
  })
  window.on('focus', () => {
    publishPresence(entry)
  })
  window.on('blur', () => {
    publishPresence(entry)
  })
  window.on('show', () => {
    publishPresence(entry)
  })
  window.on('hide', () => {
    publishPresence(entry)
  })
  window.webContents.on('did-finish-load', () => {
    deliver(entry, ENGINE_STATUS_CHANNEL, { state: entry.state })
    if (entry.update !== null) deliver(entry, ENGINE_UPDATE_CHANNEL, entry.update)
    publishPresence(entry)
  })
  window.webContents.once('destroyed', () => {
    client.dispose()
    engineWindows.delete(window.webContents)
  })
  void client.connect().catch((error: unknown) => {
    mainLog?.warn('engine connection failed', { error: String(error) })
    entry.state =
      error instanceof Error && error.message === 'engine-client-outdated'
        ? 'restart-required'
        : 'stopped'
    deliver(entry, ENGINE_STATUS_CHANNEL, { state: entry.state })
  })
  return entry
}

/** The shell's one document, named once so the load and the allowlist agree. */
const SHELL_ENTRY_FILE = join(__dirname, '../renderer/index.html')

type ShellWindowRole =
  { kind: 'main' } | { kind: 'detached'; projectId: string; title: string; x: number; y: number }

function createWindow(role: ShellWindowRole): BrowserWindow {
  const window = new BrowserWindow({
    width: role.kind === 'main' ? 1_280 : 1_000,
    height: role.kind === 'main' ? 860 : 720,
    ...(role.kind === 'detached' ? { title: role.title, x: role.x, y: role.y } : {}),
    /*
     * Down to phone width: the layout reflows there, and the old floor of 940 —
     * tablet width — was stopping a window that renders perfectly well at 360.
     *
     * 360 rather than 380 because 375 is an iPhone and 360 an Android, and a
     * minimum that lands between the two common phone widths excludes both.
     */
    minWidth: 360,
    minHeight: 420,
    show: false,
    acceptFirstMouse: true,
    /*
     * macOS only, and the guard is load-bearing rather than tidy.
     *
     * `hiddenInset` hides the frame and draws the traffic lights over the top
     * of the page, which is why `.masthead` is exactly 31px tall and carries
     * 88px of left padding — that inset is the traffic lights' room, and the
     * masthead is the window's drag region because there is no title bar to
     * drag. On Windows Electron falls back to a standard frame, so unguarded
     * the user got the OS title bar *plus* the 31px masthead *plus* 88px of
     * empty space where no traffic lights are.
     *
     * A custom Windows frame is deliberately not hidden inside this change: it
     * would also need accessible minimize, maximize, restore and close
     * controls, and that is a feature rather than a platform guard.
     */
    ...(process.platform === 'darwin' && role.kind === 'main'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Non-negotiable (plan §4.4). Relaxing any of these turns an injection in
      // agent output into remote code execution.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  registerShellWindow(window)

  /*
   * One value decides both what loads and what is allowed to load.
   *
   * The allowlist is exact rather than a `file://` prefix, so it has to name the
   * shell's entry document precisely — and deriving it from the same constant the
   * load below uses is what stops the two drifting into a window that navigates
   * nowhere, or one that navigates anywhere.
   */
  const entry = devServerUrl ?? pathToFileURL(SHELL_ENTRY_FILE).href
  lockDownNavigation(window.webContents, [entry], undefined, registerToastWindow(window))

  /*
   * The shell's role, registered here rather than at each call site: this is the
   * one place a window is made, so a new kind of window cannot be added without
   * a role. A document with no role is refused every traffic request, which is
   * the safe default rather than the convenient one.
   */
  const shellRole =
    role.kind === 'main'
      ? { kind: 'main' as const }
      : { kind: 'detached' as const, projectId: role.projectId }
  connectWindow(window, shellRole)
  browserIpc?.registerShell(electronShellClient(window.webContents), shellRole)
  consoleIpc?.registerShell(electronShellClient(window.webContents), shellRole)
  window.webContents.on('destroyed', () => {
    browserIpc?.releaseShell(electronShellClient(window.webContents))
    consoleIpc?.releaseShell(electronShellClient(window.webContents))
  })

  // Avoids a white flash before the renderer has painted.
  window.once('ready-to-show', () => {
    window.show()
  })

  /*
   * Reapplied per navigation, not once per window: Electron resets the factor on
   * every load, so a reload mid-session would silently drop back to 100% while
   * the app still believed it was zoomed.
   */
  window.webContents.on('did-finish-load', () => {
    applyScale(currentScale())
  })

  if (role.kind === 'main') {
    window.on('close', () => {
      closeEveryDetachedWindow()
    })
  } else {
    window.on('page-title-updated', (event) => {
      event.preventDefault()
    })
  }

  const hash = role.kind === 'detached' ? `detached=${encodeURIComponent(role.projectId)}` : ''

  if (devServerUrl !== undefined) {
    void window.loadURL(hash === '' ? devServerUrl : `${devServerUrl}#${hash}`)
  } else {
    void window.loadFile(SHELL_ENTRY_FILE, hash === '' ? {} : { hash })
  }

  return window
}

let mainWindow: BrowserWindow | null = null
/**
 * Held at module scope so shutdown can say what it failed to stop.
 *
 * `before-quit` runs outside `whenReady`'s closure, so without this the workbench
 * host's shutdown result — specifically the pids of any process group that
 * outlived `SIGKILL` — had nowhere to go, and a function that reports survivors to
 * nobody is a function that may as well claim success.
 */
let mainLog: ReturnType<typeof createLogger> | null = null

/*
 * Before ready, because Electron only accepts scheme privileges before then and
 * throws afterwards. Nothing is served yet — this is the declaration, and
 * `serveNoteImages` below is the handler.
 */
registerNoteImageScheme()

if (process.platform === 'win32') app.setAppUserModelId('dev.chorus.desktop')

void app.whenReady().then(async () => {
  applyContentSecurityPolicy(session.defaultSession, devServerUrl !== undefined)
  serveNoteImages(app.getPath('userData'))

  // Before anything is spawned: launched from Finder we get `/usr/bin:/bin:…`,
  // and the agent CLIs are not there — nor, for a shebang script, is the `node`
  // that runs one. Awaited, so no session can start on the bare PATH.
  await adoptShellPath()

  const log = createLogger(app.getPath('userData'))
  mainLog = log
  /*
   * The workbench host is free functions with module state and no owner to hand
   * it a logger, so main gives it one here. Before this it logged nothing at all,
   * and the slowest operation in the app — download, unpack, spawn, port wait —
   * was invisible in the file people are told to read.
   */
  setWorkbenchHostLog(log)
  setCompletionLog(log)
  log.info('starting', { version: app.getVersion(), electron: process.versions.electron })

  /*
   * TEMPORARY — renderer console into `chorus.log`. Remove when the web-worker
   * extension host question is settled (2026-09-02).
   *
   * The workbench's failures are invisible from here. Main logs its own side, the
   * REH logs the remote extension host, and **nothing captures the renderer** —
   * so when `enableWorkerExtensionHost` was turned on and every extension command
   * wedged, the only evidence was in a DevTools console nobody was reading. Two
   * causes were proposed from source and both were wrong; this exists so the
   * third is observed instead.
   *
   * `web-contents-created` rather than a hook per surface, because the frame that
   * matters is not one we construct: the worker extension host runs in an iframe
   * of the workbench document, and `console-message` reports it with `frame`
   * naming the sub-frame. One listener covers the shell, every project's
   * workbench view, and everything they frame.
   *
   * All four levels are forwarded, at the user's request, and this is the reason
   * it must not become permanent: a renderer console carries whatever extensions
   * choose to print, which is the same class of leak C-021 is open about. It goes
   * to the same file `chorus.log` rotates, so it is not unbounded.
   */
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', ({ level, message, lineNumber, sourceId, frame }) => {
      if (isBrowserPage(contents)) return
      // `frame` is non-optional on the event and `lineNumber` is a number, so no
      // `??` and no optional chain — the linter rejects both as unnecessary.
      const fields = { level, source: `${sourceId}:${String(lineNumber)}`, frame: frame.url }
      // Mapped so the file's own levels stay meaningful, and nothing is dropped:
      // the logger's `minLevel` is `info` unless CHORUS_DEBUG=1, so a `debug`
      // console line logged as `debug` would be silently discarded — which is the
      // failure mode this whole detour is about.
      // `undefined` in the middle is not noise: `error` is
      // `(message, error?, fields?)`, so passing `fields` second files the whole
      // object as the caught error and drops it from the record.
      if (level === 'error') log.error(`renderer: ${message}`, undefined, fields)
      else if (level === 'warning') log.warn(`renderer: ${message}`, fields)
      else log.info(`renderer: ${message}`, fields)
    })
  })

  /*
   * And the same backstop for the workbench server, which needs it more than the
   * agents do.
   *
   * An agent is a stdio-connected child that dies when its pipes close; the remote
   * extension host is spawned **detached**, so that shutdown can signal its whole
   * process group, and that same property is what lets it survive a `SIGKILL` or a
   * power cut with no handler to catch either. Every ordered exit now stops it —
   * this is for the disordered ones.
   *
   * Identified by this profile's own `--server-data-dir` and by having been
   * reparented to init, never by executable name: see the function's own note for
   * why that distinction is the whole safety argument.
   *
   * **Started here and awaited in `start`.** This call is only to get it going
   * early; it is not what makes it safe. Opening a project is a renderer request
   * that can arrive in the same tick this window finishes loading, so the
   * guarantee has to live where the server is spawned — `start` awaits the same
   * memoised promise, and a `void` here would otherwise let a new host come up
   * beside an orphan that still owns this profile's data directory and token.
   */
  void reapedOrphanedServers()
    .then(({ killed, inspected, survivors, skipped }) => {
      if (skipped === 'unsupported-platform') {
        log.info('workbench server backstop unavailable on this platform')
      } else if (skipped === 'sweep-failed') {
        // Distinct from the line above on purpose: this one means projects will be
        // refused until the app is restarted, which is a thing a person can act on.
        log.error('the workbench server backstop could not read the process table')
      } else if (killed > 0) {
        log.warn('reaped orphaned workbench servers', { killed, inspected })
      }
      /*
       * Survivors are the interesting line, not the kills. A server carrying this
       * profile's data directory that is still alive after the sweep is why the
       * next project open will be refused, and without this the person sees only
       * the refusal — at the point they tried to open something, with no record of
       * what was found at boot.
       */
      if (survivors.length > 0) {
        /*
         * The same distinction the refusal makes, made here rather than left to
         * the log reader. A survivor with a live parent is another Chorus on this
         * profile and the app is about to refuse to open a project because of it;
         * a survivor with parent `1` is an orphan that refused to die. Both words
         * name what was found, and neither claims the other's cause.
         */
        log.warn('a workbench server is still running for this profile', {
          survivors,
          inspected,
          ownedByAnotherChorus: survivors.some((survivor) => survivor.parent !== 1),
        })
      }
    })
    .catch((error: unknown) => {
      /*
       * A sweep that threw is logged and **left rejected**, which is the
       * fail-closed half. `start` awaits this same memoised promise, so the
       * rejection reaches the project open as a refusal rather than being
       * swallowed here into an app that spawns a server having never checked. An
       * unhandled rejection would also be a main-process crash on some Electron
       * configurations — this catch exists so the promise has a handler, not so
       * the failure has no consequence.
       */
      log.error('the workbench server backstop failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })

  const userData = app.getPath('userData')
  const expectedData = desktopDataDirectory(!app.isPackaged)
  if (process.env['CHORUS_USER_DATA'] === undefined && userData !== expectedData)
    log.warn('desktop data directory differs from the engine default', {
      actual: userData,
      expected: expectedData,
    })
  const shipped = app.isPackaged
    ? join(process.resourcesPath, 'engine')
    : join(app.getAppPath(), '..', 'engine', 'dist', 'runtime')
  const manifest = readRuntimeManifest(shipped)
  const installed = readEngineInstall(userData)
  const ours = manifest !== null && manifest.version === app.getVersion()
  const ahead =
    !app.isPackaged ||
    installed === null ||
    !existsSync(installed.shipped) ||
    compareVersions(app.getVersion(), installed.version) > 0
  if (ours && ahead)
    writeEngineInstall(userData, {
      version: app.getVersion(),
      executable: process.execPath,
      shipped,
    })
  registerIpcHandlers(clientFor)
  ipcMain.on(SHELL_PRESENCE_CHANNEL, (event, raw: unknown) => {
    if (!isShellSender(event)) return
    const entry = engineWindows.get(event.sender)
    const parsed = ShellPresence.safeParse(raw)
    if (entry === undefined || !parsed.success) return
    entry.presence =
      entry.role.kind === 'main'
        ? parsed.data
        : {
            ...parsed.data,
            projectIds: [entry.role.projectId],
            focusedProjectId: entry.role.projectId,
          }
    publishPresence(entry)
  })
  registerToastWindowHandlers()
  /*
   * Separate from `registerIpcHandlers` because these handlers need `event`.
   * Registered even though no surface exists yet: opening one is a renderer
   * request, and a channel that is not registered fails at `invoke` with a
   * message about the channel rather than about the workbench.
   */
  registerWorkbenchHandlers(devServerUrl, resolvePlace, async (projectId) => {
    await activeClient().invoke('workbench:projectOpened', { projectId })
  })
  setWorkbenchTerminalEnvSource({
    current: (place) => terminalEnvironment.get(placeKey(place)) ?? null,
    ensure: (place) => environmentFor(place, true),
  })
  setWorkbenchReviewSource({
    comment: (owner, request) => invokeReview(owner, 'git:comment', request),
    reply: (owner, request) => invokeReview(owner, 'git:reply', request),
    resolve: (owner, request) => invokeReview(owner, 'git:resolve', request),
    state: (owner, projectId) => invokeReview(owner, 'git:activeReview', { projectId }),
    openDiff: (owner, request) => invokeReview(owner, 'git:openDiff', request),
  })
  const detachedDeps: DetachedWindowDeps = {
    mainWindow: () => mainWindow,
    createDetachedWindow: (projectId, title, x, y) => {
      const window = createWindow({ kind: 'detached', projectId, title, x, y })
      attachDetachedWindowListeners(detachedDeps, projectId, window)
      return window
    },
    resolvePlace,
    clientFor,
  }
  registerDetachedWindowHandlers(detachedDeps)
  setDetachedAccessPredicate((caller, projectRoot) =>
    detachedAccess(
      caller,
      projectRoot,
      mainWindow === null || mainWindow.isDestroyed() ? null : mainWindow.webContents
    )
  )
  setHandoffExpiredSink((projectRoot) => {
    handOffExpired(detachedDeps, projectRoot)
  })
  setWorkbenchContextSink((report, owner) => {
    const entry = engineWindows.get(owner)
    if (entry === undefined) return
    const key = placeKey({ host: report.host, root: report.projectRoot })
    entry.contexts.set(key, report)
    for (const window of engineWindows.values()) window.clearedContexts.delete(key)
    entry.client.notify({ kind: 'editorContext', report })
  })
  setWorkbenchSurfaceGoneSink((place, owner) => {
    const entry = engineWindows.get(owner)
    if (entry === undefined) return
    const key = placeKey(place)
    entry.contexts.delete(key)
    const report: WorkbenchContextReport = {
      host: place.host,
      projectRoot: place.root,
      context: {
        relativePath: null,
        provenance: { kind: 'worktree' },
        scheme: '',
        editorTypeId: '',
        reason: 'no-editor',
        startLine: null,
        endLine: null,
        isEmpty: true,
        isDirty: false,
        languageId: '',
        selectedBytes: 0,
        version: null,
      },
    }
    entry.clearedContexts.set(key, report)
    entry.client.notify({ kind: 'editorContext', report })
  })
  const settings = new BrowserSettingsStore(userData)
  browserSettings = settings
  const mainOwner = (): WebContents | null =>
    mainWindow === null || mainWindow.isDestroyed() ? null : mainWindow.webContents
  const consoles = new BrowserConsoles({
    preferredOwner: (projectId) => {
      const detached = detachedWindowOf(projectId)
      const owner =
        detached !== null && !detached.isDestroyed() ? detached.webContents : mainOwner()
      return owner === null ? null : electronShellClient(owner)
    },
  })
  browserConsoles = consoles
  const browserSurfaces = new BrowserSurfaces({
    settings,
    vault: new BrowserVault(userData),
    preloadPath: join(__dirname, '../preload/browser.js'),
    devtoolsPreloadPath: join(__dirname, '../preload/devtools.js'),
    mainOwner,
    downloads: {
      expect: (contents) => {
        downloads.expect(contents)
      },
    },
    deliver: (owner, push) => {
      browserIpc?.deliver(electronShellClient(owner), push)
    },
    console: {
      mounted: (source) => {
        consoles.mount(electronBrowserSource(source))
      },
      released: (contents) => {
        consoles.release(electronBrowserSourceOf(contents))
      },
    },
  })
  const downloads = new BrowserDownloads({
    session: session.fromPartition(BROWSER_PARTITION),
    ownerOf: (contents) => browserSurfaces.ownerOf(contents),
    mainOwner,
    directory: () => app.getPath('downloads'),
    deliver: (owner, push) => {
      browserIpc?.deliver(electronShellClient(owner), push)
    },
  })
  browserDownloads = downloads
  browserIpc = new BrowserIpc(
    {
      surfaces: electronBrowserPort(browserSurfaces),
      downloads: electronBrowserDownloads(downloads),
      isAdopted: (projectId) => adoptedProjectIds.has(projectId),
    },
    electronIpcRegistrar
  )
  consoleIpc = new ConsoleIpc(
    {
      consoles,
      isAdopted: (projectId) => adoptedProjectIds.has(projectId),
    },
    electronIpcRegistrar
  )
  // Takes no runtime: the watches are keyed by the conversations that ask for
  // one, not by what the runtime happens to have open.
  // Owns ⌘+ / ⌘− / ⌘0; a menu accelerator is handled before the page sees it.
  const routeOwner = (): BrowserWindow | null => {
    const focused = BrowserWindow.getFocusedWindow()
    return focused === mainWindow && focused !== null && !focused.isDestroyed() ? focused : null
  }
  installMenu(
    {
      zoom: (direction) => {
        const owner = routeOwner()
        return owner !== null && browserSurfaces.routeZoom(owner.webContents, direction)
      },
      reload: () => {
        const owner = routeOwner()
        return owner !== null && browserSurfaces.routeReload(owner.webContents)
      },
      devtools: () => {
        if (browserSurfaces.routeFocusedDevtools(webContents.getFocusedWebContents())) return true
        const owner = routeOwner()
        return owner !== null && browserSurfaces.routeDevtools(owner.webContents)
      },
    },
    process.platform
  )
  configureDesktopHostCalls({
    windowFor: (role) =>
      [...engineWindows.values()].find(
        (entry) =>
          !entry.window.isDestroyed() &&
          entry.role.kind === role.kind &&
          (role.kind === 'main' ||
            (entry.role.kind === 'detached' && entry.role.projectId === role.projectId))
      )?.window ?? null,
    consoles: () => browserConsoles,
    refreshTerminalEnv,
  })

  /*
   * Before the window, not after — otherwise the app paints in the OS
   * appearance and snaps to the chosen one, a flash on every launch for anyone
   * whose choice differs from their system.
   */
  applyTheme(readSettings(app.getPath('userData')).theme)

  mainWindow = createWindow({ kind: 'main' })
  const reparentMode = process.env['CHORUS_REPARENT_CHECK']
  if (isReparentMode(reparentMode)) runReparentCheck(mainWindow, reparentMode)

  app.on('activate', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) mainWindow = createWindow({ kind: 'main' })
  })
})

/*
 * A different data directory, when asked for — and for a dev build, always.
 *
 * The end-to-end tests drive the real app, and a real app writes real files —
 * the log, the database, what was open last time. Without this they would read
 * and overwrite whatever the person running them had open, which is both a
 * broken test and a rude one. Set before anything reads a path, because Electron
 * caches them.
 */
const overrideUserData = process.env['CHORUS_USER_DATA']

/*
 * And a dev build never shares a directory with an installed one.
 *
 * Until this line, `pnpm dev` and `/Applications/Chorus.app` both resolved
 * `userData` from the package name and so opened the *same* `chorus.db`. That
 * is fine exactly as long as the two builds agree on the schema, and the whole
 * point of a dev build is that it does not: a branch adding `repo.changed.byUser`
 * to `ChorusEventPayload` wrote twelve of them into the shared log, and the
 * installed 0.19.7 — which has never heard of that type — then failed to
 * discriminate the union on read and put a raw Zod issue array in the
 * transcript where the conversation should be.
 *
 * Read-back is fail-hard by design (`toStoredEvent` parses every row against
 * the current union), so this is not a cosmetic collision: one unrecognised
 * event takes down the read that contains it. And the log is append-only, so
 * the damage is permanent for the older build — there is no cleanup, only
 * prevention, which is why the fix is a separate directory rather than a
 * tolerant parser.
 *
 * `isPackaged` rather than a flag in the dev script, so it cannot be forgotten
 * by anyone running electron-vite directly. An explicit `CHORUS_USER_DATA`
 * still wins, because e2e is unpackaged too and already passes its own path.
 */
const devUserData = app.isPackaged ? null : `${app.getPath('userData')}-dev`

const dataDir =
  overrideUserData !== undefined && overrideUserData !== '' ? overrideUserData : devUserData

if (dataDir !== null) {
  // Electron creates `userData` lazily, but the logger and the store both write
  // into it before anything else does; e2e only ever passed an existing mkdtemp
  // path, so the create-it case was never exercised.
  mkdirSync(dataDir, { recursive: true })
  app.setPath('userData', dataDir)
  /*
   * And the session directory with it, which is a separate path and was not.
   *
   * `sessionData` is where Chromium keeps its HTTP cache, and it stopped
   * defaulting to `userData` in Electron 20. So overriding `userData` alone gave
   * every e2e launch a private database and a *shared* cache — and a shared
   * cache of `file://` documents means a run can be served the `index.html` a
   * previous run loaded, pointing at a hashed bundle that no longer exists.
   *
   * Measured, not inferred, and it defeated a mutation test before it was found:
   * `readTheme` was deliberately broken, the break was confirmed present in
   * `out/renderer/assets/index-WAOOPaQa.js`, the spec passed anyway, and the page
   * asked for its own script URL answered `index-DaglO1ZH.js` — the previous
   * build, already deleted from disk.
   *
   * This is C-014 one layer down. That entry guards `out/` being stale relative
   * to `src/`; nothing guarded the renderer being stale relative to `out/`, and
   * the failure mode is the one C-014 calls the worst possible outcome — a spec
   * reporting on code that is not under review.
   *
   * What the evidence covers: three full-suite runs, two with this line and one
   * with it reverted, produced the same eight failures in the same order — so
   * **no observed regression from this change**, which is a narrower claim than
   * safe. The suite is red either way, for reasons belonging to the control-rail
   * redesign; the matrix and the per-failure triage are in that plan's STATUS §10.
   */
  app.setPath('sessionData', dataDir)
}

/*
 * The other two thirds of the OAuth return trip.
 *
 * `electron-builder.yml` puts `chorus://` in the bundle so the OS knows who owns
 * the scheme, `services.ts` sets `urlProtocol` so an extension builds its
 * redirect out of it, and this claims the scheme at runtime and receives the
 * result. All three or none: any one missing and a person authenticates in a
 * browser and comes back to an extension still waiting, which is what GitLab
 * sign-in did.
 *
 * `setAsDefaultProtocolClient` matters most **unpackaged** — a `pnpm dev` build
 * has no `CFBundleURLTypes` to register from, so without this the flow could only
 * ever be tested from an installed app.
 *
 * `preventDefault` because the default is to do nothing visible: without it the
 * URL is dropped and the failure looks identical to having no handler at all.
 */
if (process.env['CHORUS_PROFILE_READONLY'] !== '1') app.setAsDefaultProtocolClient('chorus')

app.on('open-url', (event, url) => {
  event.preventDefault()
  /*
   * Main does not parse it and does not decide what it means. Routing is
   * `deliverUrl`'s question — which surface, if any, has a claim on this — and
   * the URL's contents are the waiting extension's business, reached through
   * `IURLService` exactly as they would be in a desktop VS Code.
   *
   * A URL nobody claims is dropped, deliberately: see `deliverUrl`. There is no
   * safe fallback surface, because every one of them routes a credential to a
   * project that did not ask for it.
   */
  deliverUrl(url)
})

app.on('window-all-closed', () => {
  app.quit()
})

/**
 * The shutdown itself. The *decision* about when a quit may proceed lives in
 * `quit-gate.ts`, because that decision was wrong in a way reading it did not
 * reveal and `index.ts` cannot be unit tested.
 */
async function shutDownEverything(): Promise<void> {
  for (const entry of engineWindows.values()) entry.client.dispose()
  engineWindows.clear()
  setWorkbenchContextSink(null)
  setWorkbenchSurfaceGoneSink(null)
  setWorkbenchTerminalEnvSource(null)
  browserDownloads?.dispose()
  browserDownloads = null
  consoleIpc?.close()
  consoleIpc = null
  browserConsoles?.close()
  browserConsoles = null
  const browserClosed = browserIpc?.close()
  browserIpc = null
  const surfacesClosed = closeAllSurfaces()
  /*
   * And one level out again — `stopAll()` from preflight §5.4, the only
   * unconditional kill in the workbench's lifecycle. Closing the last project
   * deliberately does *not* stop the server, so without this a remote extension
   * host outlives the app holding a port, a project root and a lock on its own
   * extensions directory.
   */
  const workbenchStopped = stopWorkbenchHost()

  /*
   * Every step is allowed to fail and **none of them silently**.
   *
   * These were four bare `.catch(() => undefined)`s, which is how a shutdown that
   * went wrong let Chorus exit with nothing written down anywhere: no survivor
   * result, no log line, no trace. That is not a check that could not fail — it is
   * a failure that could not be *seen*, and it was sitting inside the machinery
   * built to expose exactly this class of lifecycle bug.
   *
   * Each failure is caught **here**, where there is enough context to say which
   * step it was, and the step then resolves. That is also what makes the quit
   * gate's own reporting fire exactly once: anything handled here never reaches
   * it, and anything that escapes here reaches it and nothing else. The two paths
   * are disjoint by construction rather than by being careful.
   */
  const step = async (work: Promise<unknown> | undefined, what: string): Promise<void> => {
    try {
      await work
    } catch (error) {
      mainLog?.error(what, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  await step(surfacesClosed, 'the workbench surfaces did not close cleanly')
  await step(flushWorkbenchStorageWrites(), 'the workbench storage did not flush cleanly')

  await step(browserClosed, 'the browser did not close cleanly')

  const result = await workbenchStopped.catch((error: unknown) => {
    /*
     * Logged **before** the `null`, which is the whole of this correction. The
     * `null` is how the caller below knows there is no survivor list to report;
     * without this line it was also how a failed workbench shutdown became
     * indistinguishable from a clean one that had nothing to say.
     */
    mainLog?.error('the workbench server shutdown failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })
  // Said out loud, because "the server did not stop" is the one shutdown outcome
  // a person can act on — and the one the previous design could not express.
  if (result !== null && result.survivors.length > 0) {
    mainLog?.warn('workbench server survived shutdown', { survivors: result.survivors })
  }
}

const quitGate = createQuitGate(
  shutDownEverything,
  () => {
    app.quit()
  },
  (error: unknown) => {
    /*
     * Only reached by something `shutDownEverything` did not handle itself, since
     * every step in there catches and resolves. So this is the unexpected-throw
     * arm rather than a second chance at the same failure — which is what keeps a
     * cleanup failure reported once rather than twice.
     */
    mainLog?.error('shutdown threw before it could finish', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
)

app.on('before-quit', (event) => {
  quitGate.onBeforeQuit(event)
})

/*
 * `SIGTERM` and `SIGINT` join the **same** shutdown rather than getting their own.
 *
 * `app.quit()` rather than a bespoke sequence, so there is exactly one shutdown to
 * get right. It goes through `before-quit`, whose re-entrancy `quit-gate.ts` owns,
 * and `stopWorkbenchHost` is memoised for the same reason: two signals in quick
 * succession must not start two shutdowns.
 *
 * **What this does not cover, and it was measured rather than assumed.** One
 * signal shuts down cleanly. A *second* one arriving mid-cleanup was observed to
 * end the process with `signal=SIGTERM`, and nothing here prevented it. That is a
 * forced-quit boundary rather than a second graceful request, and its recovery is
 * the next launch's reaper — `BOARD.md` C-055.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.quit()
  })
}
