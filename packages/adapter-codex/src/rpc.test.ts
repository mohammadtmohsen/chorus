import { describe, expect, it } from 'vitest'
import { JsonRpcClient, OVERLOADED, RpcError } from './rpc.js'
import type { Transport } from './transport.js'

function fakeTransport() {
  const sent: Record<string, unknown>[] = []
  let onLine: ((line: string) => void) | null = null
  let onClose: ((i: { code: number | null; signal: string | null }) => void) | null = null
  let closed = false

  const transport: Transport = {
    send: (line) => sent.push(JSON.parse(line) as Record<string, unknown>),
    onLine: (h) => {
      onLine = h
    },
    onClose: (h) => {
      onClose = h
    },
    onStderr: () => undefined,
    close: () => {
      closed = true
    },
  }

  return {
    transport,
    sent,
    isClosed: () => closed,
    receive: (message: unknown) => onLine?.(JSON.stringify(message)),
    receiveRaw: (line: string) => onLine?.(line),
    exit: (code: number | null) => onClose?.({ code, signal: null }),
    lastId: () => sent.at(-1)?.['id'] as number,
  }
}

function client(
  t: ReturnType<typeof fakeTransport>,
  overrides: Partial<{ maxOverloadRetries: number }> = {}
) {
  return new JsonRpcClient({
    transport: t.transport,
    requestTimeoutMs: 500,
    baseBackoffMs: 1,
    random: () => 0.5, // deterministic backoff
    sleep: () => Promise.resolve(),
    ...overrides,
  })
}

describe('request/response correlation', () => {
  it('resolves the matching request and leaves others pending', async () => {
    const t = fakeTransport()
    const rpc = client(t)

    const first = rpc.request('a')
    const second = rpc.request('b')
    const [idA, idB] = t.sent.map((m) => m['id'] as number)

    t.receive({ id: idB, result: { got: 'b' } })
    await expect(second).resolves.toEqual({ got: 'b' })

    t.receive({ id: idA, result: { got: 'a' } })
    await expect(first).resolves.toEqual({ got: 'a' })
  })

  it('omits the jsonrpc member, matching the server', () => {
    const t = fakeTransport()
    client(t)
      .request('thread/start', { cwd: '/x' })
      .catch(() => undefined)
    expect(t.sent[0]).not.toHaveProperty('jsonrpc')
    expect(t.sent[0]).toMatchObject({ method: 'thread/start', params: { cwd: '/x' } })
  })

  it('rejects with an RpcError carrying the server code', async () => {
    const t = fakeTransport()
    const rpc = client(t)
    const p = rpc.request('boom')
    t.receive({ id: t.lastId(), error: { code: -32600, message: 'Invalid request' } })
    await expect(p).rejects.toBeInstanceOf(RpcError)
  })

  it('times out rather than hanging forever', async () => {
    const t = fakeTransport()
    const rpc = new JsonRpcClient({ transport: t.transport, requestTimeoutMs: 10 })
    await expect(rpc.request('slow')).rejects.toThrow(/timed out/)
  })

  it('ignores a response for an unknown id', () => {
    const t = fakeTransport()
    client(t)
    expect(() => t.receive({ id: 9999, result: {} })).not.toThrow()
  })

  it('survives a malformed line', () => {
    const t = fakeTransport()
    client(t)
    // A partial line during shutdown must not take the client down.
    expect(() => t.receiveRaw('{not json')).not.toThrow()
  })
})

describe('overload backoff', () => {
  it('retries -32001 and succeeds', async () => {
    const t = fakeTransport()
    const rpc = client(t)
    const p = rpc.request('busy')

    t.receive({ id: 1, error: { code: OVERLOADED, message: 'Server overloaded; retry later' } })
    await Promise.resolve()
    await Promise.resolve()
    t.receive({ id: 2, result: 'ok' })

    await expect(p).resolves.toBe('ok')
    expect(t.sent).toHaveLength(2)
  })

  it('gives up after the retry budget', async () => {
    const t = fakeTransport()
    const rpc = client(t, { maxOverloadRetries: 2 })
    const p = rpc.request('busy')

    for (let i = 1; i <= 3; i++) {
      t.receive({ id: i, error: { code: OVERLOADED, message: 'Server overloaded; retry later' } })
      await Promise.resolve()
      await Promise.resolve()
    }
    await expect(p).rejects.toThrow(/overloaded/i)
  })

  it('does not retry a non-overload error', async () => {
    const t = fakeTransport()
    const rpc = client(t)
    const p = rpc.request('bad')
    t.receive({ id: 1, error: { code: -32600, message: 'Invalid request' } })
    await expect(p).rejects.toThrow(/Invalid request/)
    expect(t.sent).toHaveLength(1)
  })
})

describe('server-initiated requests', () => {
  it('answers a request from the server by id', async () => {
    // Approvals arrive this way. A client that only models one direction
    // silently hangs every approval (plan §2.1).
    const t = fakeTransport()
    const rpc = client(t)
    rpc.setServerRequestHandler((method) =>
      Promise.resolve({ decision: method.includes('commandExecution') ? 'accept' : 'decline' })
    )

    t.receive({ id: 77, method: 'item/commandExecution/requestApproval', params: { itemId: 'i1' } })
    await new Promise((r) => setTimeout(r, 0))

    expect(t.sent.at(-1)).toEqual({ id: 77, result: { decision: 'accept' } })
  })

  it('replies with an error when no handler is registered', async () => {
    const t = fakeTransport()
    client(t)
    t.receive({ id: 5, method: 'item/fileChange/requestApproval', params: {} })
    await new Promise((r) => setTimeout(r, 0))
    expect(t.sent.at(-1)).toMatchObject({ id: 5, error: { code: -32601 } })
  })

  it('turns a throwing handler into an error response, not a crash', async () => {
    const t = fakeTransport()
    const rpc = client(t)
    rpc.setServerRequestHandler(() => Promise.reject(new Error('policy exploded')))
    t.receive({ id: 6, method: 'x', params: {} })
    await new Promise((r) => setTimeout(r, 0))
    expect(t.sent.at(-1)).toMatchObject({ id: 6, error: { message: 'policy exploded' } })
  })
})

describe('notifications', () => {
  it('fans out to every subscriber and can unsubscribe', () => {
    const t = fakeTransport()
    const rpc = client(t)
    const seen: string[] = []
    const off = rpc.onNotification((m) => seen.push(m))
    rpc.onNotification((m) => seen.push(`2:${m}`))

    t.receive({ method: 'turn/started', params: { turn: { id: 't1' } } })
    off()
    t.receive({ method: 'turn/completed', params: {} })

    expect(seen).toEqual(['turn/started', '2:turn/started', '2:turn/completed'])
  })
})

describe('process exit', () => {
  it('fails every in-flight request when the app-server dies', async () => {
    // The S3a scenario. Without this, a SIGKILL leaves promises pending forever.
    const t = fakeTransport()
    const rpc = client(t)
    const p = rpc.request('turn/start')
    t.exit(137)
    await expect(p).rejects.toThrow(/exited/)
  })

  it('rejects new requests after close', async () => {
    const t = fakeTransport()
    const rpc = client(t)
    rpc.close('done')
    expect(t.isClosed()).toBe(true)
    await expect(rpc.request('anything')).rejects.toThrow(/done/)
  })
})
