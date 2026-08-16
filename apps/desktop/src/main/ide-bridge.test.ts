import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Logger, type LogSink } from '@chorus/shared'
import { encodeFrame, PROTOCOL_VERSION, type EditorMetadata } from '@chorus/ide-protocol'
import { canonicalRoot } from '@chorus/workspace'
import { IdeBridge } from './ide-bridge.js'

/**
 * Driven with real sockets and real frames rather than a mocked broker: the
 * whole point of Phase 2 is the wire path, and a mock of it would test nothing
 * that can actually break.
 */

const TOKEN = 'test-token'

let base: string
let bridge: IdeBridge
let lines: string[]
let clients: Socket[]

function testLogger(): Logger {
  const sink: LogSink = {
    write: (line) => {
      lines.push(line)
    },
    size: () => 0,
    rotate: () => undefined,
  }
  return new Logger({ sink })
}

/** A fake VS Code window. */
class FakeWindow {
  #buffer = ''
  readonly received: Record<string, unknown>[] = []
  readonly socket: Socket

  private constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.#buffer += chunk
      for (;;) {
        const nl = this.#buffer.indexOf('\n')
        if (nl === -1) break
        const line = this.#buffer.slice(0, nl)
        this.#buffer = this.#buffer.slice(nl + 1)
        if (line.trim() !== '') this.received.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
  }

  static async open(socketPath: string): Promise<FakeWindow> {
    const socket = connect(socketPath)
    clients.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return new FakeWindow(socket)
  }

  send(frame: unknown): void {
    this.socket.write(encodeFrame(frame))
  }

  handshake(windowId: string, overrides: Record<string, unknown> = {}): void {
    this.send({
      jsonrpc: '2.0',
      id: `h-${windowId}`,
      method: 'initialize',
      params: {
        token: TOKEN,
        protocolVersion: PROTOCOL_VERSION,
        clientVersion: '0.4.0',
        windowId,
        ideName: 'Visual Studio Code',
        isTrusted: true,
        focused: false,
        ...overrides,
      },
    })
  }

  state(windowId: string, focused: boolean, roots: unknown[]): void {
    this.send({
      jsonrpc: '2.0',
      method: 'stateChanged',
      params: { windowId, focused, roots },
    })
  }

  get closed(): boolean {
    return this.socket.destroyed
  }
}

function editor(filePath: string): EditorMetadata {
  return {
    source: 'current',
    filePath,
    fileUrl: `file://${filePath}`,
    languageId: 'typescript',
    documentVersion: 1,
    isDirty: false,
    provenance: { kind: 'worktree' },
    selection: {
      start: { line: 10, character: 0 },
      end: { line: 12, character: 4 },
      isEmpty: false,
      selectedBytes: 12,
    },
  }
}

/** Let queued socket writes drain and be handled. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r))
}

beforeEach(async () => {
  lines = []
  clients = []
  base = mkdtempSync(join(tmpdir(), 'chorus-ide-t-'))
  bridge = await IdeBridge.start({
    runtimeDir: base,
    pid: 4242,
    chorusVersion: '0.4.0',
    log: testLogger(),
    token: TOKEN,
    now: () => 1_000,
  })
})

afterEach(async () => {
  for (const c of clients) c.destroy()
  await bridge.close()
  rmSync(base, { recursive: true, force: true })
})

/**
 * Cases that need a unix filesystem, not merely a unix argument — `chmod` is a
 * no-op on Windows and a named pipe has no directory entry to stat.
 */
const onUnixFs = it.skipIf(process.platform === 'win32')

describe('descriptor', () => {
  it('publishes the socket path, token, and versions', () => {
    const descriptor = JSON.parse(readFileSync(bridge.descriptorPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(descriptor).toMatchObject({
      pid: 4242,
      socketPath: bridge.socketPath,
      token: TOKEN,
      protocolVersion: PROTOCOL_VERSION,
      chorusVersion: '0.4.0',
    })
  })

  /* A world-readable token would defeat the whole discovery scheme. */
  /*
   * Unix only, and not because the check is unimportant there.
   *
   * On Windows `mode` is synthesised from the read-only attribute, so a private
   * file still reports 0o666 and this can never be zero; and `socketPath` is a
   * `\\.\pipe\` name, which `statSync` cannot stat at all. `endpoint.ts`
   * records that the pipe has no ACL and the handshake token is the only guard —
   * pretending otherwise here would be the test asserting a protection that does
   * not exist.
   */
  onUnixFs('keeps the descriptor and socket private', () => {
    expect(statSync(bridge.descriptorPath).mode & 0o077).toBe(0)
    expect(statSync(bridge.socketPath).mode & 0o077).toBe(0)
    expect(statSync(join(base, 'chorus-ide')).mode & 0o077).toBe(0)
  })

  it('still writes a descriptor a second process can find, on either platform', () => {
    // What survives the above on Windows: the descriptor is a real file there,
    // and it is what carries the token.
    expect(statSync(bridge.descriptorPath).isFile()).toBe(true)
  })

  /* A second Chorus must not collide with the first, and neither may delete
     the other's files. */
  it('gives a second process its own descriptor and socket', async () => {
    const other = await IdeBridge.start({
      runtimeDir: base,
      pid: 4243,
      chorusVersion: '0.4.0',
      log: testLogger(),
      token: 'other',
    })
    expect(other.socketPath).not.toBe(bridge.socketPath)
    expect(other.descriptorPath).not.toBe(bridge.descriptorPath)
    await other.close()
    // Closing one leaves the other listening. Asserted through the filesystem on
    // unix, where the socket is a node; a named pipe has no such entry, and its
    // liveness is what the connection tests cover instead.
    if (process.platform !== 'win32') {
      expect(statSync(bridge.socketPath).isSocket()).toBe(true)
    }
    expect(statSync(bridge.descriptorPath).isFile()).toBe(true)
  })
})

describe('handshake', () => {
  it('accepts a valid handshake and answers with the versions', async () => {
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1')
    await settle()

    expect(bridge.connectionCount()).toBe(1)
    expect(w.received[0]).toMatchObject({
      id: 'h-w1',
      result: { protocolVersion: PROTOCOL_VERSION, chorusVersion: '0.4.0' },
    })
  })

  /* The roots must arrive without waiting for the next conversation change,
     or a window connecting mid-session reports nothing until one happens. */
  it('sends the current roots immediately after the handshake', async () => {
    bridge.setRoots([base])
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1')
    await settle()

    expect(w.received[1]).toMatchObject({
      method: 'setRoots',
      params: { roots: [String(canonicalRoot(base))] },
    })
  })

  /* The caller resyncs on every runtime event batch, and most of those are
     streaming deltas that change nothing. */
  it('does not rebroadcast roots that have not changed', async () => {
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1')
    await settle()
    const before = w.received.filter((f) => f['method'] === 'setRoots').length

    bridge.setRoots([base])
    bridge.setRoots([base])
    bridge.setRoots([base])
    await settle()

    expect(w.received.filter((f) => f['method'] === 'setRoots').length).toBe(before + 1)
  })

  it('rejects a wrong token', async () => {
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1', { token: 'wrong' })
    await settle()

    expect(bridge.connectionCount()).toBe(0)
    expect(w.closed).toBe(true)
  })

  it('rejects a protocol version mismatch', async () => {
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1', { protocolVersion: PROTOCOL_VERSION + 1 })
    await settle()

    expect(bridge.connectionCount()).toBe(0)
    expect(w.closed).toBe(true)
  })

  it('rejects a frame sent before the handshake', async () => {
    const w = await FakeWindow.open(bridge.socketPath)
    w.state('w1', true, [])
    await settle()

    expect(bridge.connectionCount()).toBe(0)
    expect(w.closed).toBe(true)
  })

  it('accepts several windows concurrently', async () => {
    const a = await FakeWindow.open(bridge.socketPath)
    const b = await FakeWindow.open(bridge.socketPath)
    a.handshake('w1')
    b.handshake('w2')
    await settle()

    expect(bridge.connectionCount()).toBe(2)
  })

  /* An extension host restart must not leave a phantom window competing in
     focus arbitration. */
  it('replaces an earlier connection from the same window', async () => {
    const first = await FakeWindow.open(bridge.socketPath)
    first.handshake('w1')
    await settle()
    const second = await FakeWindow.open(bridge.socketPath)
    second.handshake('w1')
    await settle()

    expect(bridge.connectionCount()).toBe(1)
    expect(first.closed).toBe(true)
  })
})

describe('project resolution', () => {
  const root = () => canonicalRoot(base)

  it('reports unavailable with nothing connected', () => {
    expect(bridge.contextFor(root())).toMatchObject({ status: 'unavailable', editor: null })
  })

  /* "nothing connected" and "connected, but this project is not open" are
     different problems with different fixes. */
  it('reports unmatched when the window does not have the root', async () => {
    bridge.setRoots([base])
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1')
    await settle()
    w.state('w1', true, [{ root: String(root()), status: 'unmatched', editor: null }])
    await settle()

    expect(bridge.contextFor(root()).status).toBe('unmatched')
  })

  it('reports ready with the editor for a matching window', async () => {
    bridge.setRoots([base])
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1')
    await settle()
    w.state('w1', true, [
      { root: String(root()), status: 'ready', editor: editor(join(base, 'a.ts')) },
    ])
    await settle()

    const context = bridge.contextFor(root())
    expect(context.status).toBe('ready')
    expect(context.editor?.filePath).toBe(join(base, 'a.ts'))
    expect(context.windowId).toBe('w1')
  })

  /* Electron main is the security boundary; the extension's filtering is only
     a disclosure minimisation. A report for a root Chorus never asked about
     must not become visible state. */
  it('drops a report for a root it never asked about', async () => {
    bridge.setRoots([base])
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1')
    await settle()
    w.state('w1', true, [
      { root: '/somewhere/else', status: 'ready', editor: editor('/somewhere/else/x.ts') },
    ])
    await settle()

    expect(bridge.contextFor(root()).status).toBe('unmatched')
    expect(bridge.contextFor(canonicalRoot('/somewhere/else')).status).toBe('unmatched')
  })

  it('prefers the focused window', async () => {
    bridge.setRoots([base])
    const a = await FakeWindow.open(bridge.socketPath)
    const b = await FakeWindow.open(bridge.socketPath)
    a.handshake('w1')
    b.handshake('w2')
    await settle()
    a.state('w1', false, [
      { root: String(root()), status: 'ready', editor: editor(join(base, 'a.ts')) },
    ])
    b.state('w2', true, [
      { root: String(root()), status: 'ready', editor: editor(join(base, 'b.ts')) },
    ])
    await settle()

    expect(bridge.contextFor(root()).editor?.filePath).toBe(join(base, 'b.ts'))
  })

  /* Arrival order says nothing about which editor the user is looking at. */
  it('reports ambiguous rather than guessing between two unfocused windows', async () => {
    bridge.setRoots([base])
    const a = await FakeWindow.open(bridge.socketPath)
    const b = await FakeWindow.open(bridge.socketPath)
    a.handshake('w1')
    b.handshake('w2')
    await settle()
    const report = [{ root: String(root()), status: 'ready', editor: editor(join(base, 'a.ts')) }]
    a.state('w1', false, report)
    b.state('w2', false, report)
    await settle()

    expect(bridge.contextFor(root()).status).toBe('ambiguous')
  })

  it('clears a window from resolution when it disconnects abruptly', async () => {
    bridge.setRoots([base])
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1')
    await settle()
    w.state('w1', true, [
      { root: String(root()), status: 'ready', editor: editor(join(base, 'a.ts')) },
    ])
    await settle()
    expect(bridge.contextFor(root()).status).toBe('ready')

    w.socket.destroy()
    await settle()

    expect(bridge.connectionCount()).toBe(0)
    expect(bridge.contextFor(root()).status).toBe('unavailable')
  })
})

describe('snapshot requests', () => {
  const root = () => canonicalRoot(base)

  async function readyWindow(): Promise<FakeWindow> {
    bridge.setRoots([base])
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1')
    await settle()
    w.state('w1', true, [
      { root: String(root()), status: 'ready', editor: editor(join(base, 'a.ts')) },
    ])
    await settle()
    return w
  }

  it('returns the snapshot the window answers with', async () => {
    const w = await readyWindow()
    const pending = bridge.requestSnapshot(root())
    await settle()

    const request = w.received.find((f) => f['method'] === 'currentContext')
    expect(request).toBeDefined()
    w.send({
      jsonrpc: '2.0',
      id: request?.['id'],
      result: {
        outcome: 'ok',
        snapshot: {
          ...editor(join(base, 'a.ts')),
          selection: {
            start: { line: 10, character: 0 },
            end: { line: 12, character: 4 },
            isEmpty: false,
            selectedBytes: 3,
            text: 'abc',
          },
        },
      },
    })

    const result = await pending
    expect(result.outcome).toBe('ok')
    if (result.outcome === 'ok') expect(result.snapshot.selection.text).toBe('abc')
  })

  /* A timeout resolves rather than rejects: the caller keeps the draft and
     explains, which is not an exceptional path. */
  it('resolves unavailable when the window never answers', async () => {
    await readyWindow()
    const result = await bridge.requestSnapshot(root(), 20)
    expect(result).toEqual({ outcome: 'unavailable', reason: 'unavailable' })
  })

  it('does not ask the extension when the project is not ready', async () => {
    bridge.setRoots([base])
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1')
    await settle()
    w.state('w1', true, [{ root: String(root()), status: 'untrusted', editor: null }])
    await settle()

    const result = await bridge.requestSnapshot(root())
    expect(result).toEqual({ outcome: 'unavailable', reason: 'untrusted' })
    expect(w.received.some((f) => f['method'] === 'currentContext')).toBe(false)
  })

  it('settles a malformed result instead of hanging until the timeout', async () => {
    const w = await readyWindow()
    const pending = bridge.requestSnapshot(root(), 5_000)
    await settle()
    const request = w.received.find((f) => f['method'] === 'currentContext')
    w.send({ jsonrpc: '2.0', id: request?.['id'], result: { outcome: 'nonsense' } })

    expect(await pending).toEqual({ outcome: 'unavailable', reason: 'unavailable' })
  })

  /* Quitting mid-Send must not deadlock the caller. */
  it('settles anything outstanding when the bridge closes', async () => {
    await readyWindow()
    const pending = bridge.requestSnapshot(root(), 5_000)
    await settle()
    await bridge.close()

    expect(await pending).toEqual({ outcome: 'unavailable', reason: 'unavailable' })
  })
})

describe('diagnostics', () => {
  /* The one place a token or a path may never end up. */
  it('logs no token, path, or source text', async () => {
    bridge.setRoots([base])
    const w = await FakeWindow.open(bridge.socketPath)
    w.handshake('w1', { token: 'wrong' })
    await settle()

    const bad = await FakeWindow.open(bridge.socketPath)
    bad.socket.write('{"jsonrpc":"2.0","method":"nope","params":{}}\n')
    await settle()

    const all = lines.join('\n')
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain('wrong')
    expect(all).not.toContain(base)
    expect(all.length).toBeGreaterThan(0)
  })
})
