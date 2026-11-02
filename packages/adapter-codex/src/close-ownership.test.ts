import { ProcessCleanupError } from '@chorus/shared/process-tree'
import { describe, expect, it, vi } from 'vitest'
import { CodexAdapter, CodexSession } from './codex-adapter.js'
import { JsonRpcClient } from './rpc.js'
import type { Transport } from './transport.js'

function gate() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function rpcWith(close: Transport['close']) {
  const transport: Transport = {
    send: () => undefined,
    onLine: () => undefined,
    onClose: () => undefined,
    onStderr: () => undefined,
    close,
  }
  return new JsonRpcClient({ transport })
}

describe('Codex process ownership on close', () => {
  it('does not resolve a session close before transport termination is confirmed', async () => {
    const exited = gate()
    const close = vi.fn(() => exited.promise)
    const rpc = rpcWith(close)
    const session = new CodexSession('thread', rpc, 60_000, Date.now)
    let finished = false
    const closing = session.close().then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(close).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)
    exited.resolve()
    await closing
    expect(finished).toBe(true)
  })

  it('shares an in-flight close and retries a rejected physical shutdown', async () => {
    let attempts = 0
    const rpc = rpcWith(() => {
      attempts++
      return attempts === 1 ? Promise.reject(new Error('Child survived')) : Promise.resolve()
    })
    const closing = rpc.close()
    expect(rpc.close()).toBe(closing)
    await expect(closing).rejects.toThrow('Child survived')
    await expect(rpc.close()).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('retains failed startup cleanup and releases it only after the typed retry succeeds', async () => {
    let deliver: (line: string) => void = () => undefined
    let attempts = 0
    const transport: Transport = {
      send: (line) => {
        const request = JSON.parse(line) as { id?: unknown }
        if (typeof request.id !== 'number') return
        queueMicrotask(() => {
          deliver(
            JSON.stringify({
              id: request.id,
              error: { code: -32000, message: 'Initialization refused' },
            })
          )
        })
      },
      onLine: (handler) => {
        deliver = handler
      },
      onClose: () => undefined,
      onStderr: () => undefined,
      close: () => {
        attempts++
        return attempts === 1 ? Promise.reject(new Error('Cleanup unconfirmed')) : Promise.resolve()
      },
    }
    const adapter = new CodexAdapter({ createTransport: () => transport })
    const failure: unknown = await adapter
      .start({
        cwd: process.cwd(),
        sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
      })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProcessCleanupError)
    if (!(failure instanceof ProcessCleanupError))
      throw new Error('Missing retryable startup cleanup')
    await failure.retry()
    expect(attempts).toBe(2)
    await adapter.dispose()
    expect(attempts).toBe(2)
  })
})
