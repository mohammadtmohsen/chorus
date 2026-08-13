import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeFrame, PROTOCOL_VERSION, type CurrentContextResult } from '@chorus/ide-protocol'
import { ChorusConnection } from './connection.js'
import type { Descriptor } from './discovery.js'

/**
 * Driven against a real socket with a fake Chorus on the other end. The point
 * of this module is the wire behaviour, and a mocked socket would exercise
 * none of it.
 */

let dir: string
let server: Server
let socketPath: string
let received: Record<string, unknown>[]
let peers: Socket[]
let connection: ChorusConnection | null

function descriptor(overrides: Partial<Descriptor> = {}): Descriptor {
  return {
    pid: process.pid,
    socketPath,
    token: 'secret',
    protocolVersion: PROTOCOL_VERSION,
    chorusVersion: '0.4.0',
    ...overrides,
  }
}

function makeConnection(
  d: Descriptor,
  onSnapshot: (root: string) => CurrentContextResult = () => ({
    outcome: 'unavailable',
    reason: 'unsupported',
  }),
  onRoots: () => void = () => undefined
): ChorusConnection {
  const c = new ChorusConnection(
    d,
    {
      windowId: 'w1',
      ideName: 'Visual Studio Code',
      clientVersion: '0.4.0',
      isTrusted: () => true,
      isFocused: () => true,
    },
    { onRoots, onSnapshot, onStateChange: () => undefined, log: () => undefined }
  )
  connection = c
  return c
}

async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

beforeEach(async () => {
  received = []
  peers = []
  connection = null
  dir = mkdtempSync(join(tmpdir(), 'chorus-conn-'))
  socketPath = join(dir, 's.sock')
  server = createServer((socket) => {
    peers.push(socket)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) break
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.trim() !== '') received.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve)
  })
})

afterEach(async () => {
  connection?.dispose()
  for (const p of peers) p.destroy()
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  rmSync(dir, { recursive: true, force: true })
})

describe('handshake', () => {
  it('sends initialize with the descriptor token', async () => {
    makeConnection(descriptor()).start()
    await settle()

    expect(received[0]).toMatchObject({
      method: 'initialize',
      params: { token: 'secret', protocolVersion: PROTOCOL_VERSION, windowId: 'w1' },
    })
  })

  /* The handshake must not disclose which projects this window has open —
     Chorus names the roots first. */
  it('sends no workspace paths in the handshake', async () => {
    makeConnection(descriptor()).start()
    await settle()

    const params = (received[0]?.['params'] ?? {}) as Record<string, unknown>
    expect(params['workspaceFolders']).toBeUndefined()
    expect(JSON.stringify(received[0])).not.toContain('/')
  })

  /* One clear "update the extension" beats a socket that reconnects forever. */
  it('refuses a protocol version it cannot speak', async () => {
    makeConnection(descriptor({ protocolVersion: PROTOCOL_VERSION + 1 })).start()
    await settle()

    expect(received).toEqual([])
  })

  it('reports connected only after the socket is up', async () => {
    const c = makeConnection(descriptor())
    expect(c.connected).toBe(false)
    c.start()
    await settle()
    expect(c.connected).toBe(true)
  })

  /*
   * The refusal above is silent: no frame is sent, so the status bar read "not
   * running" and the only trace was a line in an unopened output channel. The
   * state is what the window can act on, and the direction decides which of the
   * two things the user has to update.
   */
  it('names a mismatch by direction, so the status bar can say what to update', () => {
    expect(makeConnection(descriptor({ protocolVersion: PROTOCOL_VERSION + 1 })).state).toBe(
      'extensionOutdated'
    )
    expect(makeConnection(descriptor({ protocolVersion: PROTOCOL_VERSION - 1 })).state).toBe(
      'chorusOutdated'
    )
  })

  it('moves from dialing to connected on a version it can speak', async () => {
    const c = makeConnection(descriptor())
    expect(c.state).toBe('dialing')
    c.start()
    await settle()
    expect(c.state).toBe('connected')
  })
})

describe('state', () => {
  it('sends per-root reports once connected', async () => {
    const c = makeConnection(descriptor())
    c.start()
    await settle()
    c.send([{ root: '/p', status: 'unmatched', editor: null }])
    await settle()

    expect(received.at(-1)).toMatchObject({
      method: 'stateChanged',
      params: { windowId: 'w1', focused: true, roots: [{ root: '/p', status: 'unmatched' }] },
    })
  })

  /* Dropping is correct: the roots have not arrived yet, so anything sent now
     would be filtered against nothing. */
  it('drops state sent before the handshake', async () => {
    const c = makeConnection(descriptor())
    c.send([{ root: '/p', status: 'ready', editor: null }])
    await settle()

    expect(received).toEqual([])
  })

  /*
   * The roots stay on the connection that was told about them. A window can
   * serve several Chorus processes, and one shared array meant the last
   * handshake decided what every one of them heard about.
   */
  it('keeps the roots Chorus published, and says the window should republish', async () => {
    let republished = 0
    const c = makeConnection(descriptor(), undefined, () => (republished += 1))
    c.start()
    await settle()
    expect(c.roots).toEqual([])

    peers[0]?.write(
      encodeFrame({ jsonrpc: '2.0', method: 'setRoots', params: { roots: ['/p/a', '/p/b'] } })
    )
    await settle()

    expect(c.roots).toEqual(['/p/a', '/p/b'])
    expect(republished).toBe(1)
  })

  it('replaces the roots rather than accumulating them', async () => {
    const c = makeConnection(descriptor())
    c.start()
    await settle()
    peers[0]?.write(
      encodeFrame({ jsonrpc: '2.0', method: 'setRoots', params: { roots: ['/p/a', '/p/b'] } })
    )
    await settle()
    peers[0]?.write(
      encodeFrame({ jsonrpc: '2.0', method: 'setRoots', params: { roots: ['/p/c'] } })
    )
    await settle()

    expect(c.roots).toEqual(['/p/c'])
  })
})

describe('snapshot requests', () => {
  it('answers with what the handler returns, against the request id', async () => {
    const c = makeConnection(descriptor(), () => ({
      outcome: 'tooLarge',
      selectedBytes: 99_999,
    }))
    c.start()
    await settle()
    peers[0]?.write(
      encodeFrame({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'currentContext',
        params: { root: '/p/a' },
      })
    )
    await settle()

    expect(received.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      result: { outcome: 'tooLarge', selectedBytes: 99_999 },
    })
  })

  it('asks the handler for the root Chorus named', async () => {
    const asked: string[] = []
    const c = makeConnection(descriptor(), (root) => {
      asked.push(root)
      return { outcome: 'unavailable', reason: 'unsupported' }
    })
    c.start()
    await settle()
    peers[0]?.write(
      encodeFrame({
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'currentContext',
        params: { root: '/p/b' },
      })
    )
    await settle()

    expect(asked).toEqual(['/p/b'])
  })

  /* A frame Chorus would never send must not reach the handler. */
  it('ignores a malformed frame instead of answering it', async () => {
    let called = false
    const c = makeConnection(descriptor(), () => {
      called = true
      return { outcome: 'unavailable', reason: 'unsupported' }
    })
    c.start()
    await settle()
    const before = received.length
    peers[0]?.write('{"jsonrpc":"2.0","method":"nonsense","params":{}}\n')
    await settle()

    expect(called).toBe(false)
    expect(received.length).toBe(before)
  })
})

describe('reconnect', () => {
  it('comes back after the peer drops the connection', async () => {
    const c = makeConnection(descriptor())
    c.start()
    await settle()
    expect(c.connected).toBe(true)

    peers[0]?.destroy()
    await settle()
    expect(c.connected).toBe(false)

    // First backoff step is 250ms.
    await settle(500)
    expect(c.connected).toBe(true)
  })

  it('stops trying once disposed', async () => {
    const c = makeConnection(descriptor())
    c.start()
    await settle()
    c.dispose()
    peers[0]?.destroy()
    await settle(500)

    expect(c.connected).toBe(false)
  })
})
