import type { WebContents } from 'electron'
import type { BrowserSource } from './browser-source.js'
import { electronShellClient } from './electron-shell-client.js'

interface ElectronBrowserSourceInput {
  readonly browserId: string
  readonly projectId: string
  readonly owner: WebContents
  readonly contents: WebContents
}

const sources = new WeakMap<WebContents, BrowserSource>()

export function electronBrowserSource(input: ElectronBrowserSourceInput): BrowserSource {
  const previous = sources.get(input.contents)
  if (previous?.id === input.browserId && previous.projectId === input.projectId) return previous
  const { contents } = input
  const debuggee = contents.debugger
  const source: BrowserSource = {
    id: input.browserId,
    projectId: input.projectId,
    owner: electronShellClient(input.owner),
    transport: {
      attach: (version) => {
        debuggee.attach(version)
      },
      isAttached: () => debuggee.isAttached(),
      detach: () => {
        debuggee.detach()
      },
      sendCommand: (method, params) => debuggee.sendCommand(method, params),
      onMessage: (listener) => {
        const receive = (
          _event: unknown,
          method: string,
          params: unknown,
          sessionId?: string
        ): void => {
          if (sessionId !== undefined && sessionId !== '') return
          listener(method, params)
        }
        debuggee.on('message', receive)
        return () => {
          debuggee.removeListener('message', receive)
        }
      },
      onDetached: (listener) => {
        debuggee.on('detach', listener)
        return () => {
          debuggee.removeListener('detach', listener)
        }
      },
    },
    url: () => contents.getURL(),
    isGone: () => contents.isDestroyed(),
    isInspectorOpen: () => contents.isDevToolsOpened() || contents.devToolsWebContents !== null,
    onNavigated: (listener) => {
      const receive = (_event: unknown, url: string): void => {
        listener(url)
      }
      contents.on('did-navigate', receive)
      return () => {
        contents.removeListener('did-navigate', receive)
      }
    },
    onCrashed: (listener) => {
      const receive = (_event: unknown, details: { readonly reason: string }): void => {
        listener(details.reason)
      }
      contents.on('render-process-gone', receive)
      return () => {
        contents.removeListener('render-process-gone', receive)
      }
    },
    onGone: (listener) => {
      contents.once('destroyed', listener)
      return () => {
        contents.removeListener('destroyed', listener)
      }
    },
    onInspectorChanged: (listener) => {
      const opened = (): void => {
        listener(true)
      }
      const closed = (): void => {
        listener(false)
      }
      contents.on('devtools-opened', opened)
      contents.on('devtools-closed', closed)
      return () => {
        contents.removeListener('devtools-opened', opened)
        contents.removeListener('devtools-closed', closed)
      }
    },
  }
  sources.set(contents, source)
  return source
}

export function electronBrowserSourceOf(contents: WebContents): BrowserSource | undefined {
  return sources.get(contents)
}
