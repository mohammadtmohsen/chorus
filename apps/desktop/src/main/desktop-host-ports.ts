import { app, clipboard, dialog, Notification, shell } from 'electron'
import { agentKeyIsSet, clearAgentKey, readAgentKey, writeAgentKey } from './agent-secrets.js'
import type { HostPorts } from './host-ports.js'
import { focusedShellWindow, shellWindows } from './shell-windows.js'
import {
  hasWorkbenchSurface,
  refreshWorkbenchTerminalEnv,
  reopenWorkbenchProject,
  requestWorkbenchAskDiff,
  requestWorkbenchEdit,
  requestWorkbenchSnapshot,
} from './workbench-surface.js'

export function desktopHostPorts(userDataPath: string): HostPorts {
  return {
    userDataPath,
    editor: {
      hasSurface: hasWorkbenchSurface,
      refreshTerminalEnv: refreshWorkbenchTerminalEnv,
      reopenProject: reopenWorkbenchProject,
      askDiff: requestWorkbenchAskDiff,
      edit: requestWorkbenchEdit,
      snapshot: requestWorkbenchSnapshot,
    },
    secrets: {
      read: (id) => readAgentKey(userDataPath, id),
      isSet: (id) => agentKeyIsSet(userDataPath, id),
      write: (id, value) => {
        writeAgentKey(userDataPath, id, value)
      },
      clear: (id) => {
        clearAgentKey(userDataPath, id)
      },
    },
    windows: {
      pickDirectory: async ({ title }) => {
        const window = focusedShellWindow() ?? shellWindows()[0]
        const options = { title, properties: ['openDirectory'] as ['openDirectory'] }
        const picked = await (window === undefined
          ? dialog.showOpenDialog(options)
          : dialog.showOpenDialog(window, options))
        return picked.canceled ? null : (picked.filePaths[0] ?? null)
      },
      pickFiles: async ({ title }) => {
        const window = focusedShellWindow() ?? shellWindows()[0]
        const options = {
          title,
          properties: ['openFile', 'multiSelections'] as ['openFile', 'multiSelections'],
        }
        const picked = await (window === undefined
          ? dialog.showOpenDialog(options)
          : dialog.showOpenDialog(window, options))
        return picked.canceled ? [] : picked.filePaths
      },
      writeClipboard: (text) => {
        clipboard.writeText(text)
      },
      revealInFolder: (path) => {
        shell.showItemInFolder(path)
      },
      openExternal: (url) => shell.openExternal(url),
      notify: (notice) => {
        if (Notification.isSupported()) new Notification(notice).show()
      },
      setAttentionCount: (count) => {
        app.setBadgeCount(count)
      },
    },
  }
}
