import { electronIpcRegistrar, electronShellClient } from './electron-shell-client.js'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSOLE_PUSH_CHANNEL, type ConsoleSnapshot } from '../shared/console-ipc.js'
import type { BrowserConsoles, ConsoleServiceEvent } from './browser-console.js'
import { ConsoleIpc } from './console-ipc.js'
import type { ShellRole } from './traffic-ipc.js'

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

const PROJECT = 'project-1'

class FakeShell extends EventEmitter {
  readonly mainFrame = {}
  readonly send = vi.fn()

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean {
    return false
  }
}

let emit: (event: ConsoleServiceEvent) => void = () => undefined
let snapshots = 0

function snapshot(projectId: string): ConsoleSnapshot {
  snapshots += 1
  return { projectId, epoch: snapshots, entries: [], dropped: 0, history: [], sources: [] }
}

const consoles = {
  subscribe: (listener: (event: ConsoleServiceEvent) => void) => {
    emit = listener
    return () => undefined
  },
  snapshot,
  evaluate: () => ({ commandId: null, status: 'no-page', done: null }),
  expand: () => Promise.resolve({ status: 'gone' }),
  clear: () => undefined,
} as unknown as BrowserConsoles

function invoke(channel: string, shell: FakeShell, raw: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) return Promise.reject(new Error(`no handler for ${channel}`))
  return handler({ sender: shell, senderFrame: shell.mainFrame }, raw)
}

function sentKinds(shell: FakeShell): string[] {
  return shell.send.mock.calls.map((call) => {
    const push: unknown = call[1]
    expect(call[0]).toBe(CONSOLE_PUSH_CHANNEL)
    return typeof push === 'object' && push !== null && 'kind' in push ? String(push.kind) : ''
  })
}

async function subscribed(shell: FakeShell): Promise<string> {
  const reply = (await invoke('console:subscribe', shell, { projectId: PROJECT })) as {
    readonly subscriptionId: string
  }
  return reply.subscriptionId
}

const state = (): ConsoleServiceEvent => ({
  kind: 'state',
  projectId: PROJECT,
  sources: [],
  dropped: 0,
})

beforeEach(() => {
  handlers.clear()
  snapshots = 0
  emit = () => undefined
})

function open(role: ShellRole): { readonly shell: FakeShell; readonly ipc: ConsoleIpc } {
  const ipc = new ConsoleIpc(
    { consoles, isAdopted: (projectId) => projectId === PROJECT },
    electronIpcRegistrar
  )
  const shell = new FakeShell(1)
  ipc.registerShell(electronShellClient(shell as unknown as WebContents), role)
  return { shell, ipc }
}

describe('Console IPC delivery', () => {
  it('holds every push until the subscription snapshot has been acknowledged', async () => {
    const { shell } = open({ kind: 'main' })
    const subscriptionId = await subscribed(shell)
    emit(state())
    expect(shell.send).not.toHaveBeenCalled()
    await invoke('console:ack', shell, { subscriptionId })
    expect(sentKinds(shell)).toEqual(['state'])
  })

  it('drops pushes the resnapshot covers and keeps a later Clear behind it', async () => {
    const { shell } = open({ kind: 'main' })
    const subscriptionId = await subscribed(shell)
    await invoke('console:ack', shell, { subscriptionId })
    emit(state())
    emit(state())
    expect(sentKinds(shell)).toEqual(['state'])
    await invoke('console:snapshot', shell, { subscriptionId })
    emit({ kind: 'cleared', projectId: PROJECT, epoch: 9 })
    expect(sentKinds(shell)).toEqual(['state'])
    await invoke('console:ack', shell, { subscriptionId })
    expect(sentKinds(shell)).toEqual(['state', 'cleared'])
    await invoke('console:ack', shell, { subscriptionId })
    expect(sentKinds(shell)).toEqual(['state', 'cleared'])
  })

  it('keeps a detached shell to its own project', async () => {
    const { shell } = open({ kind: 'detached', projectId: 'other' })
    await expect(invoke('console:subscribe', shell, { projectId: PROJECT })).rejects.toThrow(
      'not this shell'
    )
    await expect(invoke('console:clear', shell, { projectId: PROJECT })).rejects.toThrow(
      'not this shell'
    )
  })
})
