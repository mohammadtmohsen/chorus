import { describe, expect, it, vi } from 'vitest'
import { BrowserConsoles } from './browser-console.js'
import type { BrowserSource } from './browser-source.js'
import type { ShellClient } from './shell-client.js'

function sourceFixture(): {
  source: BrowserSource
  finishAttach: () => void
  message: (method: string, params: unknown) => void
} {
  let attached = false
  let finishAttach: () => void = () => undefined
  const pending = new Promise<void>((resolve) => {
    finishAttach = () => {
      attached = true
      resolve()
    }
  })
  const listeners = new Set<(method: string, params: unknown) => void>()
  const owner: ShellClient = {
    id: 'window-1',
    send: () => undefined,
    isGone: () => false,
    onGone: () => () => undefined,
  }
  return {
    finishAttach,
    message: (method, params) => {
      for (const listener of listeners) listener(method, params)
    },
    source: {
      id: 'browser-1',
      projectId: 'project-1',
      owner,
      transport: {
        attach: () => pending,
        isAttached: () => attached,
        detach: vi.fn(() => {
          attached = false
        }),
        sendCommand: vi.fn((method) =>
          Promise.resolve(
            method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'root' } } } : {}
          )
        ),
        onMessage: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        onDetached: () => () => undefined,
      },
      url: () => 'http://localhost/',
      isGone: () => false,
      isInspectorOpen: () => false,
      onNavigated: () => () => undefined,
      onCrashed: () => () => undefined,
      onGone: () => () => undefined,
      onInspectorChanged: () => () => undefined,
    },
  }
}

async function drain(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

describe('browser console transport', () => {
  it('waits for asynchronous target attachment before enabling CDP domains', async () => {
    const fixture = sourceFixture()
    const consoles = new BrowserConsoles({ preferredOwner: () => fixture.source.owner })
    consoles.mount(fixture.source)
    expect(fixture.source.transport.sendCommand).not.toHaveBeenCalled()
    fixture.finishAttach()
    await drain()
    expect(fixture.source.transport.sendCommand).toHaveBeenCalledWith('Runtime.enable', {})
    fixture.message('Runtime.executionContextCreated', {
      context: { id: 1, uniqueId: 'default', auxData: { isDefault: true, frameId: 'root' } },
    })
    await drain()
    expect(consoles.snapshot('project-1').sources[0]?.state).toBe('ready')
    consoles.close()
  })

  it('detaches an attachment that finishes after its source was released', async () => {
    const fixture = sourceFixture()
    const consoles = new BrowserConsoles({ preferredOwner: () => fixture.source.owner })
    consoles.mount(fixture.source)
    consoles.release(fixture.source)
    fixture.finishAttach()
    await drain()
    expect(fixture.source.transport.detach).toHaveBeenCalledTimes(1)
    expect(fixture.source.transport.sendCommand).not.toHaveBeenCalled()
    expect(consoles.snapshot('project-1').sources).toEqual([])
    consoles.close()
  })
})
