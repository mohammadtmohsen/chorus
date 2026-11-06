import { electronIpcRegistrar, electronShellClient } from './electron-shell-client.js'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, raw: unknown) => unknown>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, raw: unknown) => unknown) => {
      handlers.set(channel, handler)
    },
    removeHandler: () => undefined,
  },
}))

const { TrafficIpc } = await import('./traffic-ipc.js')
const { ProjectTrafficRegistry } = await import('./project-traffic.js')
const { TRAFFIC_PUSH_CHANNEL } = await import('../shared/traffic-ipc.js')

const PROJECT = 'p1'
const OTHER = 'p2'
const CAPTURE = 'cap-1'

const state = {
  capturing: true,
  port: 30_100,
  wantedPort: 30_100,
  address: '127.0.0.1:30100',
  origin: 'http://127.0.0.1:3000',
  access: 'loopback' as const,
  envVar: null,
  source: { kind: 'off' as const },
  failure: null,
  forwardedDevices: 0,
}

const row = {
  source: 'http' as const,
  seq: 1,
  requestId: 'r1',
  m: 'GET',
  u: '/',
  dpop: false,
  status: 200,
  aborted: false,
  parsed: true,
  code: null,
  nextAction: null,
}

const legacy = {
  completed: true,
  assignedProjectId: null,
  origin: null,
  port: null,
  access: null,
  error: null,
}

function fakeWindow(id = 7): {
  sender: Record<string, unknown>
  sent: { channel: string; payload: unknown }[]
} {
  const sent: { channel: string; payload: unknown }[] = []
  const frame = {}
  const sender = {
    id,
    mainFrame: frame,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload })
    },
    isDestroyed: () => false,
    senderFrame: frame,
  }
  return { sender, sent }
}

function build(registry: unknown): {
  ipc: InstanceType<typeof TrafficIpc>
  sent: { channel: string; payload: unknown }[]
  event: unknown
  listeners: ((push: unknown) => void)[]
} {
  const { sender, sent } = fakeWindow()
  const listeners: ((push: unknown) => void)[] = []
  const ipc = new TrafficIpc(
    {
      registry: registry as never,
      isAdopted: () => true,
      legacy: () => legacy,
      decideLegacy: () => undefined,
    },
    electronIpcRegistrar
  )
  ipc.registerShell(electronShellClient(sender as unknown as WebContents), { kind: 'main' })
  return { ipc, sent, event: { sender, senderFrame: sender['senderFrame'] }, listeners }
}

function stubRegistry(): {
  ipc: InstanceType<typeof TrafficIpc>
  sent: { channel: string; payload: unknown }[]
  event: unknown
  listeners: ((push: unknown) => void)[]
} {
  let listeners: ((push: unknown) => void)[] = []
  const registry = {
    subscribe: (listener: (push: unknown) => void) => {
      listeners = [listener]
      return () => undefined
    },
    open: () => ({ captureId: CAPTURE, seq: 0, rows: [] }),
    journal: () => ({ captureId: CAPTURE, seq: 0, rows: [] }),
    state: () => state,
  }
  const built = build(registry)
  built.listeners = listeners
  return built
}

const call = (channel: string, event: unknown, raw: unknown): unknown => {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} was never registered`)
  return handler(event, raw)
}

const pushes = (sent: { channel: string; payload: unknown }[]): unknown[] =>
  sent.filter((each) => each.channel === TRAFFIC_PUSH_CHANNEL).map((each) => each.payload)

const deliveredTo = (sent: { channel: string; payload: unknown }[]): string[] =>
  pushes(sent).map((push) => (push as { subscriptionId: string }).subscriptionId)

const attach = async (event: unknown, projectId: string): Promise<string> => {
  const attached = (await call('traffic:attach', event, { projectId })) as {
    subscriptionId: string
  }
  return attached.subscriptionId
}

const rowsFor = (projectId: string, seq = 1): unknown => ({
  kind: 'rows',
  projectId,
  captureId: CAPTURE,
  seq,
  rows: [{ ...row, seq }],
})

const serverOn = (): Promise<{ port: number; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        address !== null && typeof address === 'object' && 'port' in address ? address.port : 0
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              done()
            })
          }),
      })
    })
  })

describe('traffic ipc delivery', () => {
  it('delivers a captured row to the window that attached', async () => {
    const { sent, listeners, event } = stubRegistry()
    const attached = (await call('traffic:attach', event, { projectId: PROJECT })) as {
      subscriptionId: string
    }

    listeners[0]?.({ kind: 'rows', projectId: PROJECT, captureId: CAPTURE, seq: 1, rows: [row] })

    expect(pushes(sent)).toHaveLength(1)
    expect(pushes(sent)[0]).toMatchObject({
      kind: 'rows',
      projectId: PROJECT,
      subscriptionId: attached.subscriptionId,
      captureId: CAPTURE,
    })
  })

  it('sends nothing at all to a project this window did not attach to', async () => {
    const { sent, listeners, event } = stubRegistry()
    await call('traffic:attach', event, { projectId: PROJECT })

    listeners[0]?.({ kind: 'rows', projectId: 'other', captureId: CAPTURE, seq: 1, rows: [row] })

    expect(pushes(sent)).toHaveLength(0)
  })

  it('holds the next push until the previous one is acknowledged', async () => {
    const { sent, listeners, event } = stubRegistry()
    const attached = (await call('traffic:attach', event, { projectId: PROJECT })) as {
      subscriptionId: string
    }

    listeners[0]?.({ kind: 'rows', projectId: PROJECT, captureId: CAPTURE, seq: 1, rows: [row] })
    listeners[0]?.({
      kind: 'rows',
      projectId: PROJECT,
      captureId: CAPTURE,
      seq: 2,
      rows: [{ ...row, seq: 2 }],
    })
    expect(pushes(sent)).toHaveLength(1)

    await call('traffic:ack', event, {
      projectId: PROJECT,
      subscriptionId: attached.subscriptionId,
      seq: 1,
    })
    expect(pushes(sent)).toHaveLength(2)
  })

  it('gives every fragment of an oversized delivery its own high-water seq', async () => {
    const { sent, listeners, event } = stubRegistry()
    const attached = (await call('traffic:attach', event, { projectId: PROJECT })) as {
      subscriptionId: string
    }

    const rows: { source: string; seq: number; line: string }[] = []
    for (let index = 1; index <= 400; index += 1) {
      rows.push({ source: 'logcat', seq: index, line: 'x'.repeat(200) })
    }
    listeners[0]?.({ kind: 'rows', projectId: PROJECT, captureId: CAPTURE, seq: 400, rows })

    for (let round = 0; round < 8; round += 1) {
      const next = pushes(sent)[round]
      if (next === undefined) break
      await call('traffic:ack', event, {
        projectId: PROJECT,
        subscriptionId: attached.subscriptionId,
        seq: (next as { seq: number }).seq,
      })
    }

    const fragments = pushes(sent) as { seq: number; rows: { seq: number }[] }[]
    expect(fragments.length).toBeGreaterThan(1)
    for (const fragment of fragments) {
      const highest = Math.max(...fragment.rows.map((each) => each.seq))
      expect(fragment.seq).toBe(highest)
    }
    const delivered = fragments.flatMap((fragment) => fragment.rows.map((each) => each.seq))
    expect(delivered).toEqual(rows.map((each) => each.seq))
  })

  it('refuses a document that is not a registered shell', async () => {
    const { event } = stubRegistry()
    const stranger = {
      sender: { id: 99, mainFrame: {}, isDestroyed: () => false },
      senderFrame: {},
    }
    await expect(call('traffic:attach', stranger, { projectId: PROJECT })).rejects.toThrow()
    expect(event).toBeDefined()
  })

  it('attaches to a project that has never been configured', async () => {
    const registry = new ProjectTrafficRegistry({
      config: () => null,
      nextPort: () => 0,
      remember: () => undefined,
      address: () => '127.0.0.1',
    })
    const { event, ipc } = build(registry)
    const attached = (await call('traffic:attach', event, { projectId: PROJECT })) as {
      subscriptionId: string
      rows: unknown[]
    }
    expect(attached.subscriptionId).toBeTypeOf('string')
    expect(attached.rows).toEqual([])
    ipc.close()
  })

  it('carries a real request from the socket all the way to the window', async () => {
    const upstream = await serverOn()
    const free = await serverOn()
    const capturePort = free.port
    await free.close()

    const registry = new ProjectTrafficRegistry({
      config: () => ({
        origin: `http://127.0.0.1:${String(upstream.port)}`,
        port: capturePort,
        access: 'loopback',
        envVar: null,
      }),
      nextPort: () => capturePort,
      remember: () => undefined,
      address: () => '127.0.0.1',
    })
    await registry.configure(PROJECT, {})

    const { ipc, sent, event } = build(registry)
    await call('traffic:attach', event, { projectId: PROJECT })
    await registry.start(PROJECT)

    const answer = await fetch(`http://127.0.0.1:${String(capturePort)}/`)
    expect(answer.status).toBe(200)

    await vi.waitFor(() => {
      expect(registry.journal(PROJECT)?.rows.length ?? 0).toBeGreaterThan(0)
    })

    await vi.waitFor(async () => {
      for (const each of pushes(sent)) {
        const push = each as { projectId: string; subscriptionId: string; seq?: number }
        await call('traffic:ack', event, {
          projectId: push.projectId,
          subscriptionId: push.subscriptionId,
          seq: push.seq ?? 0,
        })
      }
      expect(pushes(sent).some((pad) => (pad as { kind: string }).kind === 'rows')).toBe(true)
    })

    const rowsPush = pushes(sent).find((push) => (push as { kind: string }).kind === 'rows') as {
      rows: { m: string }[]
    }
    expect(rowsPush.rows.length).toBeGreaterThan(0)

    await registry.shutdown()
    ipc.close()
    await upstream.close()
  })
})

describe('traffic ipc subscriptions', () => {
  it('keeps a subscription per project in one window, each with its own credit', async () => {
    const { sent, listeners, event } = stubRegistry()
    const first = await attach(event, PROJECT)
    const second = await attach(event, OTHER)

    listeners[0]?.(rowsFor(PROJECT, 1))
    listeners[0]?.(rowsFor(OTHER, 1))
    listeners[0]?.(rowsFor(PROJECT, 2))
    expect(deliveredTo(sent)).toEqual([first, second])

    await call('traffic:ack', event, { projectId: OTHER, subscriptionId: second, seq: 1 })
    expect(deliveredTo(sent)).toEqual([first, second])

    await call('traffic:ack', event, { projectId: PROJECT, subscriptionId: first, seq: 1 })
    expect(deliveredTo(sent)).toEqual([first, second, first])
  })

  it('replaces only the earlier subscription of the same project', async () => {
    const { sent, listeners, event } = stubRegistry()
    const replaced = await attach(event, PROJECT)
    const other = await attach(event, OTHER)
    const current = await attach(event, PROJECT)

    listeners[0]?.(rowsFor(PROJECT))
    listeners[0]?.(rowsFor(OTHER))

    expect(current).not.toBe(replaced)
    expect(deliveredTo(sent)).toEqual([current, other])
  })

  it('leaves the newer subscription delivering when a replaced one detaches late', async () => {
    const { sent, listeners, event } = stubRegistry()
    const replaced = await attach(event, PROJECT)
    const current = await attach(event, PROJECT)

    await call('traffic:detach', event, { projectId: PROJECT, subscriptionId: replaced })
    listeners[0]?.(rowsFor(PROJECT))

    expect(deliveredTo(sent)).toEqual([current])
  })

  it('keeps delivering to the other projects of a window when one detaches', async () => {
    const { sent, listeners, event } = stubRegistry()
    const leaving = await attach(event, PROJECT)
    const staying = await attach(event, OTHER)

    await call('traffic:detach', event, { projectId: PROJECT, subscriptionId: leaving })
    listeners[0]?.(rowsFor(PROJECT))
    listeners[0]?.(rowsFor(OTHER))

    expect(deliveredTo(sent)).toEqual([staying])
  })

  it('releases every subscription of a closed window and none of another window', async () => {
    const { ipc, sent, listeners, event } = stubRegistry()
    const second = fakeWindow(8)
    ipc.registerShell(electronShellClient(second.sender as unknown as WebContents), {
      kind: 'main',
    })
    const secondEvent = { sender: second.sender, senderFrame: second.sender['senderFrame'] }
    await attach(event, PROJECT)
    await attach(event, OTHER)
    const surviving = await attach(secondEvent, PROJECT)

    ipc.releaseShell(electronShellClient((event as { sender: WebContents }).sender))
    listeners[0]?.(rowsFor(PROJECT))
    listeners[0]?.(rowsFor(OTHER))

    expect(pushes(sent)).toEqual([])
    expect(deliveredTo(second.sent)).toEqual([surviving])
  })
})

describe('manual capture beside a managed run', () => {
  const routed = (
    capture: (projectId: string, change: 'start' | 'stop') => Promise<typeof state>
  ): unknown => {
    const { sender } = fakeWindow(8)
    const registry = {
      subscribe: () => () => undefined,
      state: () => state,
      start: () => Promise.reject(new Error('the registry was asked directly')),
      stop: () => Promise.reject(new Error('the registry was asked directly')),
    }
    const ipc = new TrafficIpc(
      {
        registry: registry as never,
        isAdopted: () => true,
        legacy: () => legacy,
        decideLegacy: () => undefined,
        capture,
      },
      electronIpcRegistrar
    )
    ipc.registerShell(electronShellClient(sender as unknown as WebContents), { kind: 'main' })
    return { sender, senderFrame: sender['senderFrame'] }
  }

  it('sends Start and Stop through the capture route, never straight to the registry', async () => {
    const asked: string[] = []
    const event = routed((projectId, change) => {
      asked.push(`${change} ${projectId}`)
      return Promise.resolve(state)
    })
    expect(await call('traffic:stop', event, { projectId: PROJECT })).toEqual({ state })
    expect(await call('traffic:start', event, { projectId: PROJECT })).toEqual({ state })
    expect(asked).toEqual([`stop ${PROJECT}`, `start ${PROJECT}`])
  })

  it('answers a refusal from the capture route as a failed request', async () => {
    const event = routed(() => Promise.reject(new Error('Capture belongs to the running command')))
    await expect(call('traffic:stop', event, { projectId: PROJECT })).rejects.toThrow(
      'running command'
    )
  })
})
