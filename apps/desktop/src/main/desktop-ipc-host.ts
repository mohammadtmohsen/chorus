import { DESKTOP_CAPABILITIES } from '../shared/host-capabilities.js'
import { homedir } from 'node:os'
import { app, dialog, Notification, type BrowserWindow } from 'electron'
import type { IpcHost } from './ipc-host.js'
import { desktopHostPorts } from './desktop-host-ports.js'
import { electronShellClient, electronContents } from './electron-shell-client.js'
import { focusedShellWindow, shellWindows } from './shell-windows.js'
import { detachedWindowOf, raise } from './detached-windows.js'
import { probeAgents } from './agent-probe.js'
import { checkTypesafeKey } from './typesafe.js'
import { defaultDeps } from './ide-extension.js'
import { invalidateCompletionCredential } from './completion-client.js'
import { applyTheme } from './theme.js'
import { copyNoteImageTo, fetchNoteImage, pickNoteImage, saveNoteImage } from './note-images.js'
import { checkRemoteHost, REMOTE_CHECK_DEADLINE_MS } from './remote-workbench.js'
import { SshRemoteHost } from './remote-host.js'
import { remoteProjectHost } from '@chorus/event-store'
import {
  closeWorkbenchProject,
  prepareWorkbenchProjectClose,
  requestWorkbenchReveal,
  setWorkbenchContextSink,
  setWorkbenchSurfaceGoneSink,
} from './workbench-surface.js'

const MAX_SHOWN = 50
const shown = new Set<Notification>()

export function desktopIpcHost(mainWindow: () => BrowserWindow | null): IpcHost {
  return {
    ...desktopHostPorts(app.getPath('userData')),
    appInfo: () => ({
      capabilities: DESKTOP_CAPABILITIES,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome,
      platform: process.platform,
      home: homedir(),
    }),
    appVersion: () => app.getVersion(),
    getPath: (name) => app.getPath(name),
    clients: () =>
      shellWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => electronShellClient(window.webContents)),
    focused: () => {
      const window = focusedShellWindow()
      return window === null ? null : electronShellClient(window.webContents)
    },
    target: (projectId) => {
      const window = detachedWindowOf(projectId) ?? mainWindow()
      return window === null || window.isDestroyed()
        ? null
        : electronShellClient(window.webContents)
    },
    raise: (client) => {
      if (client === null || client.isGone()) return
      const contents = electronContents(client)
      const window = shellWindows().find((candidate) => candidate.webContents === contents)
      if (window !== undefined) raise(window)
    },
    notify: (request) => {
      if (!Notification.isSupported()) return
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
    },
    pickDirectory: async (options) => {
      const window = focusedShellWindow() ?? shellWindows()[0]
      return window === undefined
        ? dialog.showOpenDialog(options)
        : dialog.showOpenDialog(window, options)
    },
    probeAgents,
    checkTypesafeKey,
    checkRemoteHost: (host) =>
      checkRemoteHost(new SshRemoteHost(remoteProjectHost(host)), REMOTE_CHECK_DEADLINE_MS),
    extensionDeps: () => defaultDeps(),
    invalidateCompletionCredential,
    applyTheme,
    images: { copyNoteImageTo, fetchNoteImage, pickNoteImage, saveNoteImage },
    prepareProjectClose: prepareWorkbenchProjectClose,
    closeProject: closeWorkbenchProject,
    reveal: requestWorkbenchReveal,
    setContextSink: setWorkbenchContextSink,
    setSurfaceGoneSink: setWorkbenchSurfaceGoneSink,
  }
}
