import { ipcMain, type WebContents } from 'electron'
import type { IpcRegistrar, ShellClient } from './shell-client.js'

const clients = new WeakMap<WebContents, ShellClient>()
const contentsByClient = new WeakMap<ShellClient, WebContents>()

export function electronShellClient(contents: WebContents): ShellClient {
  const previous = clients.get(contents)
  if (previous !== undefined) return previous
  const client: ShellClient = {
    id: String(contents.id),
    send: (channel, payload) => {
      contents.send(channel, payload)
    },
    isGone: () => contents.isDestroyed(),
    onGone: (listener) => {
      const navigated = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
        if (details.isMainFrame && !details.isSameDocument) listener()
      }
      contents.on('did-start-navigation', navigated)
      contents.on('destroyed', listener)
      return () => {
        contents.removeListener('did-start-navigation', navigated)
        contents.removeListener('destroyed', listener)
      }
    },
  }
  clients.set(contents, client)
  contentsByClient.set(client, contents)
  return client
}

export function electronContents(client: ShellClient): WebContents {
  const contents = contentsByClient.get(client)
  if (contents === undefined) throw new Error('Unknown shell client')
  return contents
}

export const electronIpcRegistrar: IpcRegistrar = {
  handle: (channel, handler) => {
    ipcMain.handle(channel, (event, raw: unknown) =>
      handler(
        {
          sender: electronShellClient(event.sender),
          isMainFrame: event.senderFrame === event.sender.mainFrame,
        },
        raw
      )
    )
  },
  removeHandler: (channel) => {
    ipcMain.removeHandler(channel)
  },
}
