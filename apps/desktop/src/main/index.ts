import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { IdeBridge } from './ide-bridge.js'
import {
  attachIdeBridge,
  forwardEventsToRenderer,
  forwardIdeContextToRenderer,
  forwardContextUsageToRenderer,
  forwardTasksToRenderer,
  forwardTerminalToRenderer,
  forwardLimitsToRenderer,
  registerIpcHandlers,
} from './ipc.js'
import { createLogger } from './logging.js'
import { installMenu } from './menu.js'
import { applyScale, currentScale } from './scale.js'
import { reapOrphanedAgents } from './reap.js'
import { ChorusRuntime } from './runtime.js'
import { applyContentSecurityPolicy, lockDownNavigation } from './security.js'
import { adoptShellPath } from './which.js'

const devServerUrl = process.env['ELECTRON_RENDERER_URL']

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1_280,
    height: 860,
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
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
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

  lockDownNavigation(window, devServerUrl)

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

  if (devServerUrl !== undefined) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

let runtime: ChorusRuntime | null = null
let ideBridge: IdeBridge | null = null

void app.whenReady().then(async () => {
  applyContentSecurityPolicy(session.defaultSession, devServerUrl !== undefined)

  // Before anything is spawned: launched from Finder we get `/usr/bin:/bin:…`,
  // and the agent CLIs are not there — nor, for a shebang script, is the `node`
  // that runs one. Awaited, so no session can start on the bare PATH.
  await adoptShellPath()

  /*
   * Backstop for agents orphaned by a previous crash.
   *
   * Measured: stdio-connected children already exit when Electron dies, so this
   * normally finds nothing. It stays because that cleanup is incidental rather
   * than guaranteed — see reap.ts.
   */
  const log = createLogger(app.getPath('userData'))
  log.info('starting', { version: app.getVersion(), electron: process.versions.electron })

  void reapOrphanedAgents().then(({ killed, inspected, skipped }) => {
    // Said once at startup rather than never: the backstop being unavailable is
    // a fact about this platform, and a silent `killed: 0` reads as a clean
    // machine. See `reap.ts` for why Windows has no strategy yet.
    if (skipped) log.info('orphan backstop unavailable on this platform')
    else if (killed > 0) log.warn('reaped orphaned agents', { killed, inspected })
  })

  runtime = ChorusRuntime.open(app.getPath('userData'), log)
  registerIpcHandlers(runtime)
  forwardLimitsToRenderer(runtime)
  forwardContextUsageToRenderer(runtime)
  forwardTasksToRenderer(runtime)
  forwardTerminalToRenderer(runtime)
  // Owns ⌘+ / ⌘− / ⌘0; a menu accelerator is handled before the page sees it.
  installMenu()
  forwardEventsToRenderer(runtime)

  /*
   * The VS Code bridge. Chorus listens and the extension dials in, so this has
   * to be up before any window connects — but a failure here must not stop the
   * app: editor context is additive, and Chorus without it is exactly the app
   * it was before.
   */
  const started = runtime
  try {
    const bridge = await IdeBridge.start({
      runtimeDir: tmpdir(),
      pid: process.pid,
      chorusVersion: app.getVersion(),
      log,
    })
    ideBridge = bridge
    attachIdeBridge(bridge)
    forwardIdeContextToRenderer(started, bridge)
    const syncRoots = (): void => {
      bridge.setRoots(started.openConversations().map((c) => c.cwd))
    }
    syncRoots()
    // Resynced from the event stream rather than from each call site, so a
    // conversation that starts, closes, restarts or moves cannot be the one
    // that was forgotten. `setRoots` ignores an unchanged set.
    started.subscribe(syncRoots)
  } catch (error) {
    log.error('ide bridge failed to start', error)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/*
 * A different data directory, when asked for.
 *
 * The end-to-end tests drive the real app, and a real app writes real files —
 * the log, the database, what was open last time. Without this they would read
 * and overwrite whatever the person running them had open, which is both a
 * broken test and a rude one. Set before anything reads a path, because Electron
 * caches them.
 */
const overrideUserData = process.env['CHORUS_USER_DATA']
if (overrideUserData !== undefined && overrideUserData !== '') {
  app.setPath('userData', overrideUserData)
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
  app.setPath('sessionData', overrideUserData)
}

app.on('window-all-closed', () => {
  // Chorus supervises agent child processes; on macOS the app staying resident
  // with no window would leave them running invisibly.
  app.quit()
})

// Close sessions and the database before exit, so agent child processes are not
// orphaned and WAL is checkpointed cleanly.
app.on('before-quit', (event) => {
  if (runtime === null) return
  const closing = runtime
  const bridge = ideBridge
  runtime = null
  ideBridge = null
  event.preventDefault()
  // The bridge closes first: it unlinks its socket and descriptor, and anything
  // waiting on a snapshot is settled rather than left hanging behind the
  // runtime's own shutdown.
  void Promise.resolve(bridge?.close())
    .catch(() => undefined)
    .then(() => closing.close())
    .finally(() => {
      app.quit()
    })
})
