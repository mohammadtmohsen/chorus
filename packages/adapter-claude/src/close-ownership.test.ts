import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { OwnedProcessTree } from '@chorus/shared/process-tree'
import { AsyncQueue } from '@chorus/shared'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeSession } from './claude-adapter.js'

function gate() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function sessionFor(owner: OwnedProcessTree, released = vi.fn()) {
  const messages = new AsyncQueue<unknown>()
  const close = vi.fn(() => {
    messages.close()
  })
  const query = {
    [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
    close,
  } as unknown as Query
  const session = new ClaudeSession(
    'session',
    query,
    new AsyncQueue(),
    60_000,
    Date.now,
    'claude',
    undefined,
    released,
    () => owner
  )
  return { session, close, released }
}

describe('Claude process ownership on close', () => {
  it('keeps shutdown pending until the owned process tree confirms exit', async () => {
    const captured = gate()
    const exited = gate()
    const owner: OwnedProcessTree = {
      capture: () => captured.promise,
      stop: async (graceful) => {
        await captured.promise
        await graceful?.()
        await exited.promise
      },
    }
    const target = sessionFor(owner)
    let finished = false
    const closing = target.session.close().then(() => {
      finished = true
    })
    expect(target.close).not.toHaveBeenCalled()
    captured.resolve()
    await Promise.resolve()
    expect(target.close).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)
    expect(target.released).not.toHaveBeenCalled()
    exited.resolve()
    await closing
    expect(target.released).toHaveBeenCalledTimes(1)
  })

  it('retains ownership after an unconfirmed shutdown and permits retry', async () => {
    let attempts = 0
    const target = sessionFor({
      capture: () => Promise.resolve(),
      stop: async (graceful) => {
        attempts++
        if (attempts === 1) throw new Error('Owned child still running')
        await graceful?.()
      },
    })
    await expect(target.session.close()).rejects.toThrow('Owned child still running')
    expect(target.released).not.toHaveBeenCalled()
    await target.session.close()
    expect(target.released).toHaveBeenCalledTimes(1)
    expect(target.close).toHaveBeenCalledTimes(1)
  })
})
