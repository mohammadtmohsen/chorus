import { describe, expect, it } from 'vitest'
import { ShellMessageQueue } from './message-queue.js'

describe('hidden shell delivery', () => {
  it('keeps the latest context separately for each conversation', () => {
    const queue = new ShellMessageQueue(4, 4096)
    for (let index = 0; index < 100; index += 1)
      queue.add({ kind: 'push', channel: 'ide:context', payload: { conversationId: 'a', index } })
    queue.add({ kind: 'push', channel: 'ide:context', payload: { conversationId: 'b', index: 1 } })
    expect(queue.recover).toBe(false)
    expect(queue.take()).toEqual([
      { kind: 'push', channel: 'ide:context', payload: { conversationId: 'a', index: 99 } },
      { kind: 'push', channel: 'ide:context', payload: { conversationId: 'b', index: 1 } },
    ])
  })

  it('retains distinct request answers and requests recovery when bounded storage fills', () => {
    const queue = new ShellMessageQueue(2, 4096)
    queue.add({ kind: 'answer', id: 'a', ok: true, value: 1 })
    queue.add({ kind: 'answer', id: 'b', ok: true, value: 2 })
    expect(queue.take()).toHaveLength(2)
    for (let index = 0; index < 3; index += 1)
      queue.add({ kind: 'answer', id: String(index), ok: true, value: index })
    expect(queue.recover).toBe(true)
    expect(queue.take()).toEqual([])
    queue.clear()
    expect(queue.recover).toBe(false)
  })

  it('also bounds a single large message by bytes', () => {
    const queue = new ShellMessageQueue(20, 100)
    queue.add({ kind: 'answer', id: 'large', ok: true, value: 'x'.repeat(200) })
    expect(queue.recover).toBe(true)
    expect(queue.take()).toEqual([])
  })
})
