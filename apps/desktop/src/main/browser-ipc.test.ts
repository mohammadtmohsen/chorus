import { electronBrowserPort, electronBrowserDownloads } from './electron-browser-port.js'
import { electronIpcRegistrar, electronShellClient } from './electron-shell-client.js'
import type { WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_PUSH_CHANNEL, type BrowserPush, type BrowserState } from '../shared/browser-ipc.js'
import { BrowserIpc } from './browser-ipc.js'
import type { BrowserSurfaces } from './browser-surface.js'
import type { BrowserDownloads } from './browser-downloads.js'

type Handler = (event: unknown, raw: unknown) => Promise<unknown>

const handlers = vi.hoisted(() => new Map<string, Handler>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    },
  },
}))

const EMPTY_STATE: BrowserState = {
  status: 'empty',
  live: false,
  url: null,
  title: '',
  icon: null,
  canGoBack: false,
  canGoForward: false,
  documentId: null,
  passwordOrigin: null,
  error: null,
  zoom: 1,
}

interface FakeShell {
  readonly id: number
  readonly mainFrame: object
  readonly isDestroyed: () => boolean
  readonly send: ReturnType<typeof vi.fn>
}

function fakeShell(id: number): FakeShell {
  return { id, mainFrame: {}, isDestroyed: () => false, send: vi.fn() }
}

function contentsOf(shell: FakeShell): WebContents {
  return shell as unknown as WebContents
}

const attach = vi.fn((_owner: unknown, projectId: string) =>
  Promise.resolve({
    browserId: `browser-${projectId}`,
    state: EMPTY_STATE,
    favorites: [],
    settings: 'ready' as const,
  })
)
const closeOwner = vi.fn()
const webReady = vi.fn(() => ({ ok: true }))
const attachWebTab = vi.fn((_owner: unknown, webTabId: string) =>
  Promise.resolve({
    browserId: `web-${webTabId}`,
    state: EMPTY_STATE,
    favorites: [],
    settings: 'ready' as const,
  })
)
const find = vi.fn(() => ({ failure: null }))
const closeBrowser = vi.fn(() => ({ ok: true }))
const reopen = vi.fn(() => ({ reopened: null }))
const downloadList = vi.fn(() => [])
const downloadAct = vi.fn(() => null)
const downloads = { list: downloadList, act: downloadAct } as unknown as BrowserDownloads
const surfaces = {
  webReady,
  attach,
  attachWebTab,
  find,
  close: closeBrowser,
  reopen,
  closeOwner,
  shutdown: () => Promise.resolve(),
} as unknown as BrowserSurfaces

function invoke(channel: string, shell: FakeShell, raw: unknown, frame?: object): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) return Promise.reject(new Error(`no handler for ${channel}`))
  return handler({ sender: shell, senderFrame: frame ?? shell.mainFrame }, raw)
}

let ipc: BrowserIpc

beforeEach(() => {
  handlers.clear()
  attach.mockClear()
  closeOwner.mockClear()
  webReady.mockClear()
  attachWebTab.mockClear()
  find.mockClear()
  closeBrowser.mockClear()
  reopen.mockClear()
  downloadList.mockClear()
  downloadAct.mockClear()
  ipc = new BrowserIpc(
    {
      surfaces: electronBrowserPort(surfaces),
      downloads: electronBrowserDownloads(downloads),
      isAdopted: (projectId) => projectId === 'adopted',
    },
    electronIpcRegistrar
  )
})

describe('browser IPC authorization', () => {
  it('refuses documents that are not registered shells', async () => {
    await expect(invoke('browser:attach', fakeShell(1), { projectId: 'adopted' })).rejects.toThrow(
      'not available'
    )
    expect(attach).not.toHaveBeenCalled()
  })

  it('refuses a registered shell speaking from a sub-frame', async () => {
    const shell = fakeShell(1)
    ipc.registerShell(electronShellClient(contentsOf(shell)), { kind: 'main' })
    await expect(invoke('browser:attach', shell, { projectId: 'adopted' }, {})).rejects.toThrow(
      'not available'
    )
  })

  it('lets the main shell attach adopted projects only', async () => {
    const shell = fakeShell(1)
    ipc.registerShell(electronShellClient(contentsOf(shell)), { kind: 'main' })
    await expect(invoke('browser:attach', shell, { projectId: 'adopted' })).resolves.toMatchObject({
      browserId: 'browser-adopted',
    })
    await expect(invoke('browser:attach', shell, { projectId: 'stranger' })).rejects.toThrow(
      'may not open'
    )
  })

  it('keeps a detached shell to its own project', async () => {
    const shell = fakeShell(2)
    ipc.registerShell(electronShellClient(contentsOf(shell)), {
      kind: 'detached',
      projectId: 'own',
    })
    await expect(invoke('browser:attach', shell, { projectId: 'own' })).resolves.toMatchObject({
      browserId: 'browser-own',
    })
    await expect(invoke('browser:attach', shell, { projectId: 'adopted' })).rejects.toThrow(
      'may not open'
    )
  })

  it('admits web tabs only in the main shell', async () => {
    const main = fakeShell(1)
    const detached = fakeShell(2)
    ipc.registerShell(electronShellClient(contentsOf(main)), { kind: 'main' })
    ipc.registerShell(electronShellClient(contentsOf(detached)), {
      kind: 'detached',
      projectId: 'own',
    })
    await expect(invoke('browser:attach', main, { webTabId: 'tab-1' })).resolves.toMatchObject({
      browserId: 'web-tab-1',
    })
    await expect(invoke('browser:attach', detached, { webTabId: 'tab-1' })).rejects.toThrow(
      'main window'
    )
    await expect(invoke('browser:reopen', detached, {})).rejects.toThrow('main window')
    expect(attachWebTab).toHaveBeenCalledTimes(1)
    expect(reopen).not.toHaveBeenCalled()
  })

  it('accepts readiness only from the registered main frame of the main window', async () => {
    const main = fakeShell(1)
    const detached = fakeShell(2)
    ipc.registerShell(electronShellClient(contentsOf(main)), { kind: 'main' })
    ipc.registerShell(electronShellClient(contentsOf(detached)), {
      kind: 'detached',
      projectId: 'own',
    })
    await expect(invoke('browser:webReady', main, {})).resolves.toEqual({ ok: true })
    expect(webReady).toHaveBeenCalledWith(main)
    await expect(invoke('browser:webReady', detached, {})).rejects.toThrow('main window')
    await expect(invoke('browser:webReady', main, {}, {})).rejects.toThrow('not available')
    await expect(invoke('browser:webReady', fakeShell(3), {})).rejects.toThrow('not available')
    await expect(invoke('browser:webReady', main, { ready: true })).rejects.toThrow(
      'Invalid request'
    )
    expect(webReady).toHaveBeenCalledTimes(1)
  })

  it('routes the five new handlers through their bounded contracts', async () => {
    const shell = fakeShell(1)
    ipc.registerShell(electronShellClient(contentsOf(shell)), { kind: 'main' })
    await expect(
      invoke('browser:find', shell, { browserId: 'b1', text: 'query', forward: true, start: true })
    ).resolves.toEqual({ failure: null })
    expect(find).toHaveBeenCalledWith(shell, 'b1', 'query', true, true)
    await expect(invoke('browser:close', shell, { browserId: 'b1', index: 3 })).resolves.toEqual({
      ok: true,
    })
    expect(closeBrowser).toHaveBeenCalledWith(shell, 'b1', 3)
    await expect(invoke('browser:reopen', shell, {})).resolves.toEqual({ reopened: null })
    expect(reopen).toHaveBeenCalledWith(shell)
    await expect(invoke('browser:downloads', shell, {})).resolves.toEqual({ downloads: [] })
    await expect(
      invoke('browser:download', shell, { downloadId: 'd1', action: 'cancel' })
    ).resolves.toEqual({ downloads: [], failure: null })
    expect(downloadAct).toHaveBeenCalledWith(shell, 'd1', 'cancel')
    await expect(
      invoke('browser:find', shell, {
        browserId: 'b1',
        text: 'x'.repeat(1025),
        forward: true,
        start: true,
      })
    ).rejects.toThrow('Invalid request')
    await expect(invoke('browser:close', shell, { browserId: 'b1', index: 100 })).rejects.toThrow(
      'Invalid request'
    )
    await expect(
      invoke('browser:download', shell, { downloadId: 'd1', action: 'open', path: '/secret' })
    ).rejects.toThrow('Invalid request')
  })

  it('rejects malformed requests before they reach the browser', async () => {
    const shell = fakeShell(1)
    ipc.registerShell(electronShellClient(contentsOf(shell)), { kind: 'main' })
    await expect(invoke('browser:attach', shell, { projectId: '' })).rejects.toThrow(
      'Invalid request'
    )
    await expect(
      invoke('browser:attach', shell, { projectId: 'adopted', extra: true })
    ).rejects.toThrow('Invalid request')
    expect(attach).not.toHaveBeenCalled()
  })

  it('releases a shell and its browsers together', async () => {
    const shell = fakeShell(1)
    ipc.registerShell(electronShellClient(contentsOf(shell)), { kind: 'main' })
    ipc.releaseShell(electronShellClient(contentsOf(shell)))
    expect(closeOwner).toHaveBeenCalledWith(shell)
    await expect(invoke('browser:attach', shell, { projectId: 'adopted' })).rejects.toThrow(
      'not available'
    )
  })
})

describe('browser pushes', () => {
  it('reach only registered shells and only when they satisfy the contract', () => {
    const shell = fakeShell(1)
    const stranger = fakeShell(2)
    ipc.registerShell(electronShellClient(contentsOf(shell)), { kind: 'main' })
    const state: BrowserPush = { kind: 'state', browserId: 'b1', state: EMPTY_STATE }
    const leaky = {
      kind: 'prompt',
      browserId: 'b1',
      prompt: {
        candidateId: 'c1',
        documentId: 'd1',
        origin: 'https://example.com',
        username: 'me',
        mode: 'save',
        password: 'secret',
      },
    } as unknown as BrowserPush
    ipc.deliver(electronShellClient(contentsOf(shell)), state)
    ipc.deliver(electronShellClient(contentsOf(shell)), leaky)
    ipc.deliver(electronShellClient(contentsOf(stranger)), state)
    expect(shell.send).toHaveBeenCalledTimes(1)
    expect(shell.send).toHaveBeenCalledWith(BROWSER_PUSH_CHANNEL, state)
    expect(stranger.send).not.toHaveBeenCalled()
  })
})
