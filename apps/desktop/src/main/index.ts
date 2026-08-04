import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { forwardEventsToRenderer, registerIpcHandlers } from './ipc.js'
import { createLogger } from './logging.js'
import { installMenu } from './menu.js'
import { applyScale, currentScale } from './scale.js'
import { reapOrphanedAgents } from './reap.js'
import { ChorusRuntime } from './runtime.js'
import { applyContentSecurityPolicy, lockDownNavigation } from './security.js'

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
    titleBarStyle: 'hiddenInset',
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

void app.whenReady().then(() => {
  applyContentSecurityPolicy(session.defaultSession, devServerUrl !== undefined)

  /*
   * Backstop for agents orphaned by a previous crash.
   *
   * Measured: stdio-connected children already exit when Electron dies, so this
   * normally finds nothing. It stays because that cleanup is incidental rather
   * than guaranteed — see reap.ts.
   */
  const log = createLogger(app.getPath('userData'))
  log.info('starting', { version: app.getVersion(), electron: process.versions.electron })

  void reapOrphanedAgents().then(({ killed, inspected }) => {
    if (killed > 0) log.warn('reaped orphaned agents', { killed, inspected })
  })

  runtime = ChorusRuntime.open(app.getPath('userData'), log)
  registerIpcHandlers(runtime)
  // Owns ⌘+ / ⌘− / ⌘0; a menu accelerator is handled before the page sees it.
  installMenu()
  forwardEventsToRenderer(runtime)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

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
  runtime = null
  event.preventDefault()
  void closing.close().finally(() => {
    app.quit()
  })
})
