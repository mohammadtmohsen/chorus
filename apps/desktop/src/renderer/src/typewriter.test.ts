import { describe, expect, it } from 'vitest'
import { DRAIN_MS, MIN_CHARS_PER_SECOND, nextShown, paceFor } from './typewriter.js'

/** Plays a backlog through at 16ms a frame, the way the hook does. */
function play(total: number, from = 0): { shown: number; elapsed: number } {
  const perSecond = paceFor(total - from)
  let shown = from
  let elapsed = 0
  while (shown < total && elapsed < 30_000) {
    shown = nextShown(shown, total, 16, perSecond)
    elapsed += 16
  }
  return { shown, elapsed }
}

describe('paceFor', () => {
  it('clears a big backlog inside the drain window', () => {
    expect(paceFor(4_000)).toBe((4_000 * 1000) / DRAIN_MS)
  })

  it('never drops below the floor for a small one', () => {
    expect(paceFor(1)).toBe(MIN_CHARS_PER_SECOND)
  })
})

describe('nextShown', () => {
  it('reveals nothing more once it has caught up', () => {
    expect(nextShown(40, 40, 100, 500)).toBe(40)
    expect(nextShown(41, 40, 100, 500)).toBe(40)
  })

  it('never overshoots the text that has arrived', () => {
    // Inventing characters an agent has not sent is the one thing this must
    // never do, however far behind it is.
    expect(nextShown(0, 5, 10_000, 5_000)).toBe(5)
  })

  it('moves at least one character, so it cannot stall', () => {
    expect(nextShown(0, 1_000, 1, MIN_CHARS_PER_SECOND)).toBeGreaterThan(0)
    expect(nextShown(10, 100, 0, 500)).toBe(11)
    expect(nextShown(10, 100, -50, 500)).toBe(11)
  })

  it('reads as typing when text trickles in', () => {
    const perSecond = paceFor(20)
    const afterAFrame = nextShown(0, 20, 16, perSecond)
    expect(afterAFrame).toBeGreaterThan(0)
    expect(afterAFrame).toBeLessThan(20)
  })

  it('clears a burst within the window rather than crawling', () => {
    // The reason the rate is fixed at arrival: recomputing it from what is left
    // decays exponentially and the tail dawdles.
    const { shown, elapsed } = play(4_000)
    expect(shown).toBe(4_000)
    expect(elapsed).toBeLessThanOrEqual(DRAIN_MS + 32)
  })

  it('takes a readable moment over a short one', () => {
    const { elapsed } = play(40)
    expect(elapsed).toBeGreaterThan(100)
  })
})
