import { describe, expect, it } from 'vitest'
import { AsyncQueue } from './async-queue.js'

async function drain<T>(q: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of q) out.push(item)
  return out
}

describe('AsyncQueue', () => {
  it('delivers items pushed before consumption starts', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.close()
    expect(await drain(q)).toEqual([1, 2])
  })

  it('wakes a waiting consumer when an item arrives', async () => {
    const q = new AsyncQueue<string>()
    const result = drain(q)
    // The consumer is parked here; a lost wakeup would hang the test.
    setTimeout(() => {
      q.push('late')
      q.close()
    }, 0)
    expect(await result).toEqual(['late'])
  })

  it('drains buffered items before ending on close', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.close()
    q.push(3) // after close: ignored
    expect(await drain(q)).toEqual([1, 2])
  })

  it('is idempotent on close', async () => {
    const q = new AsyncQueue<number>()
    q.close()
    q.close()
    expect(await drain(q)).toEqual([])
  })

  it('rejects a second consumer rather than splitting the stream', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.close()
    await drain(q)
    await expect(drain(q)).rejects.toThrow(/single consumer/)
  })

  it('reports pending size', () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    expect(q.size).toBe(2)
    expect(q.isClosed).toBe(false)
  })
})
