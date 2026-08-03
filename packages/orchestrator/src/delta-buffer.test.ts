import { describe, expect, it } from 'vitest'
import { DeltaBuffer, type FlushEntry, type Scheduler } from './delta-buffer.js'

/** Lets tests drive time instead of waiting for it. */
function fakeScheduler(): Scheduler & { advance: (ms: number) => void; time: () => number } {
  let time = 0
  let pending: { fn: () => void; at: number; id: number } | null = null
  let nextId = 1
  return {
    setTimeout(fn, ms) {
      const id = nextId++
      pending = { fn, at: time + ms, id }
      return id
    },
    clearTimeout(handle) {
      if (pending?.id === handle) pending = null
    },
    now: () => time,
    time: () => time,
    advance(ms) {
      time += ms
      if (pending !== null && pending.at <= time) {
        const due = pending
        pending = null
        due.fn()
      }
    },
  }
}

function collect() {
  const flushes: FlushEntry<{ n: number }>[][] = []
  return { flushes, onFlush: (e: readonly FlushEntry<{ n: number }>[]) => flushes.push([...e]) }
}

describe('DeltaBuffer', () => {
  it('does not flush on every push', () => {
    const { flushes, onFlush } = collect()
    const scheduler = fakeScheduler()
    const buf = new DeltaBuffer({ maxChars: 100, maxAgeMs: 250, onFlush, scheduler })

    for (let i = 0; i < 10; i++) buf.push('k', 'ab', { n: i })
    // One row per token is exactly what the buffer exists to avoid.
    expect(flushes).toHaveLength(0)
    expect(buf.pendingChars()).toBe(20)
  })

  it('flushes once a key crosses the size bound', () => {
    const { flushes, onFlush } = collect()
    const buf = new DeltaBuffer({
      maxChars: 10,
      maxAgeMs: 999_999,
      onFlush,
      scheduler: fakeScheduler(),
    })

    buf.push('k', '12345', { n: 1 })
    expect(flushes).toHaveLength(0)
    buf.push('k', '67890', { n: 2 })
    expect(flushes).toHaveLength(1)
    expect(flushes[0]?.[0]?.text).toBe('1234567890')
  })

  it('flushes a slow stream on the time bound', () => {
    // Without this, the tail of a slow stream would sit in memory indefinitely
    // and be lost on a crash — the exact failure S3 found with Codex.
    const { flushes, onFlush } = collect()
    const scheduler = fakeScheduler()
    const buf = new DeltaBuffer({ maxChars: 10_000, maxAgeMs: 250, onFlush, scheduler })

    buf.push('k', 'trickle', { n: 1 })
    expect(flushes).toHaveLength(0)

    scheduler.advance(250)
    expect(flushes).toHaveLength(1)
    expect(flushes[0]?.[0]?.text).toBe('trickle')
    expect(buf.pendingChars()).toBe(0)
  })

  it('bounds total memory even if the timer never fires', () => {
    // S5's failure mode: the flush trigger stalls (backgrounded window) while
    // data keeps arriving. The total cap is the backstop.
    const { flushes, onFlush } = collect()
    const stalled: Scheduler = {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      now: () => 0,
    }
    const buf = new DeltaBuffer({
      maxChars: 10_000,
      maxAgeMs: 250,
      maxTotalChars: 50,
      onFlush,
      scheduler: stalled,
    })

    for (let i = 0; i < 10; i++) buf.push(`k${String(i)}`, '12345', { n: i })
    expect(flushes.length).toBeGreaterThan(0)
    expect(buf.pendingChars()).toBeLessThan(50)
  })

  it('keeps separate keys separate', () => {
    const { flushes, onFlush } = collect()
    const buf = new DeltaBuffer({
      maxChars: 1_000,
      maxAgeMs: 250,
      onFlush,
      scheduler: fakeScheduler(),
    })

    buf.push('a', 'hello', { n: 1 })
    buf.push('b', 'world', { n: 2 })
    buf.flushAll()

    expect(flushes[0]?.map((e) => [e.key, e.text])).toEqual([
      ['a', 'hello'],
      ['b', 'world'],
    ])
  })

  it('flushKey emits only that key', () => {
    const { flushes, onFlush } = collect()
    const buf = new DeltaBuffer({
      maxChars: 1_000,
      maxAgeMs: 250,
      onFlush,
      scheduler: fakeScheduler(),
    })

    buf.push('a', 'aaa', { n: 1 })
    buf.push('b', 'bbb', { n: 2 })
    buf.flushKey('a')

    expect(flushes).toHaveLength(1)
    expect(flushes[0]?.map((e) => e.key)).toEqual(['a'])
    expect(buf.pendingKeys()).toEqual(['b'])
  })

  it('ignores empty pushes and no-op flushes', () => {
    const { flushes, onFlush } = collect()
    const buf = new DeltaBuffer({ onFlush, scheduler: fakeScheduler() })
    buf.push('a', '', { n: 1 })
    buf.flushAll()
    buf.flushKey('nope')
    expect(flushes).toHaveLength(0)
  })

  it('disarms its timer once drained, so an idle buffer emits nothing', () => {
    const { flushes, onFlush } = collect()
    const scheduler = fakeScheduler()
    const buf = new DeltaBuffer({ maxChars: 1_000, maxAgeMs: 100, onFlush, scheduler })

    buf.push('a', 'x', { n: 1 })
    buf.flushAll()
    expect(flushes).toHaveLength(1)

    scheduler.advance(1_000)
    expect(flushes).toHaveLength(1)
  })
})
