import { describe, expect, it } from 'vitest'
import {
  FINISH_LAG_MS,
  MAX_LAG_MS,
  TYPING_CHARS_PER_SECOND,
  nextShown,
  paceFor,
} from './typewriter.js'

/** Plays a backlog through at 16ms a frame, the way the hook does. */
function play(total: number, from = 0, complete = false): { shown: number; elapsed: number } {
  const perSecond = paceFor(total - from, complete)
  let shown = from
  let elapsed = 0
  while (shown < total && elapsed < 30_000) {
    shown = nextShown(shown, total, 16, perSecond)
    elapsed += 16
  }
  return { shown, elapsed }
}

describe('paceFor', () => {
  /*
   * The rate is the contract, and this is the assertion the old one could not
   * make. It used to clear whatever had arrived within 80ms, so a paragraph of
   * 300 characters was revealed at 3,750 a second — a block appearing, which is
   * what the pacing exists to prevent.
   */
  it('types a normal delta at the reading pace', () => {
    for (const delta of [12, 80, 200]) expect(paceFor(delta)).toBe(TYPING_CHARS_PER_SECOND)
  })

  it('speeds up only for a backlog it could not otherwise clear', () => {
    // The valve opens where the two rules meet, and not before.
    const knee = (TYPING_CHARS_PER_SECOND * MAX_LAG_MS) / 1000
    expect(paceFor(knee - 1)).toBe(TYPING_CHARS_PER_SECOND)
    expect(paceFor(4_000)).toBe((4_000 * 1000) / MAX_LAG_MS)
  })

  it('finishes a completed message sooner, without abandoning the pace', () => {
    // Brisk, not a cut: a small tail still types at the reading pace.
    expect(paceFor(40, true)).toBe(TYPING_CHARS_PER_SECOND)
    expect(paceFor(4_000, true)).toBe((4_000 * 1000) / FINISH_LAG_MS)
    expect(paceFor(4_000, true)).toBeGreaterThan(paceFor(4_000))
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

  it('advances whenever time passes, and not when it does not', () => {
    // The remainder is carried between frames, so a fraction of a character is
    // real progress and nothing stalls. That replaced a forced whole character
    // per frame, which was a cap as much as a floor.
    expect(nextShown(0, 1_000, 1, TYPING_CHARS_PER_SECOND)).toBeGreaterThan(0)
    expect(nextShown(10, 100, 0, 500)).toBe(10)
    expect(nextShown(10, 100, -50, 500)).toBe(10)
  })

  it('runs at the same rate whatever the display does', () => {
    /*
     * The bug this pins: rounding each frame's step made the rate a function of
     * the refresh rate. At the 160/s floor it once was, a 60Hz frame rounded
     * 2.67 up to 3 and a 120Hz frame rounded 1.33 down to 1 — 180 a second on
     * one machine, 125 on another, and the promised floor on neither.
     */
    const msToReveal = (frameMs: number): number => {
      let shown = 0
      let elapsed = 0
      while (shown < 400 && elapsed < 30_000) {
        shown = nextShown(shown, 400, frameMs, TYPING_CHARS_PER_SECOND)
        elapsed += frameMs
      }
      return elapsed
    }
    const ideal = (400 / TYPING_CHARS_PER_SECOND) * 1000
    for (const frameMs of [8, 16, 33]) {
      expect(Math.abs(msToReveal(frameMs) - ideal)).toBeLessThanOrEqual(frameMs)
    }
  })

  /*
   * Letter by letter, and this is the test that says so.
   *
   * A frame may not carry a whole line: at the reading pace a 60Hz frame is
   * about three characters, so a sentence takes many frames and is watched
   * being written. The old contract failed this — a 20-character delta was
   * revealed inside one 16ms frame.
   */
  it('reveals a delta over many frames rather than in one', () => {
    const perSecond = paceFor(60)
    let shown = 0
    let frames = 0
    while (shown < 60 && frames < 1_000) {
      shown = nextShown(shown, 60, 16, perSecond)
      frames += 1
    }
    expect(frames).toBeGreaterThan(8)
    expect(nextShown(0, 60, 16, perSecond)).toBeLessThan(6)
  })

  it('keeps a burst bounded rather than falling minutes behind', () => {
    // The reason the rate is fixed at arrival: recomputing it from what is left
    // decays exponentially and the tail dawdles.
    const { shown, elapsed } = play(20_000)
    expect(shown).toBe(20_000)
    expect(elapsed).toBeLessThanOrEqual(MAX_LAG_MS + 32)
  })

  it('takes a readable moment over a short one', () => {
    const { elapsed } = play(40)
    // 40 characters at the reading pace is 200ms — watched, not blinked.
    expect(elapsed).toBeGreaterThan(150)
  })
})
