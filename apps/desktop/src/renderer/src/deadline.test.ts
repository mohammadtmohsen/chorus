import { describe, expect, it } from 'vitest'
import { deadlineState, formatCountdown, WARN_WITHIN_MS } from './deadline.js'

/**
 * The judgement behind the countdown, tested where it lives.
 *
 * Measured from the real log: 10 of 25 question sets timed out at exactly 300.0
 * seconds, and nothing on screen had mentioned a deadline. These pin down when
 * the card starts speaking and what it says.
 */

const NOW = 1_000_000

describe('while there is plenty of time', () => {
  it('says nothing', () => {
    const state = deadlineState(NOW + 5 * 60_000, NOW)
    expect(state.warn).toBe(false)
  })

  it('asks to be woken when the warning is due, not every second', () => {
    // The whole reason `nextChangeInMs` exists: a 1Hz interval running for five
    // minutes to notice one moment is a re-render per second of a card that has
    // nothing new to say.
    const state = deadlineState(NOW + 5 * 60_000, NOW)
    expect(state.nextChangeInMs).toBe(5 * 60_000 - WARN_WITHIN_MS)
  })
})

describe('inside the last minute', () => {
  it('warns', () => {
    expect(deadlineState(NOW + 59_000, NOW).warn).toBe(true)
  })

  it('does not warn a millisecond early', () => {
    // The boundary is exclusive, so the two states cannot both be true.
    expect(deadlineState(NOW + WARN_WITHIN_MS + 1, NOW).warn).toBe(false)
    expect(deadlineState(NOW + WARN_WITHIN_MS, NOW).warn).toBe(true)
  })

  it('never shows zero while the card can still be answered', () => {
    /*
     * Ceil rather than floor. Flooring reaches "0" a whole second before the
     * deadline does — a card reading 0:00 that still takes an answer, at exactly
     * the moment someone is reading it most carefully.
     */
    expect(deadlineState(NOW + 1, NOW).secondsLeft).toBe(1)
    expect(deadlineState(NOW + 999, NOW).secondsLeft).toBe(1)
    expect(deadlineState(NOW + 1_000, NOW).secondsLeft).toBe(1)
    expect(deadlineState(NOW + 1_001, NOW).secondsLeft).toBe(2)
  })

  it('wakes exactly when the displayed second becomes wrong', () => {
    // 30.4s left shows "31"; it becomes "30" in 400ms, not in a full second.
    const state = deadlineState(NOW + 30_400, NOW)
    expect(state.secondsLeft).toBe(31)
    expect(state.nextChangeInMs).toBe(400)
  })

  it('lands on a whole second without asking for a zero-length wait', () => {
    const state = deadlineState(NOW + 30_000, NOW)
    expect(state.secondsLeft).toBe(30)
    expect(state.nextChangeInMs).toBe(1_000)
  })
})

describe('once the deadline has passed', () => {
  it('stops, rather than counting into negatives', () => {
    expect(deadlineState(NOW - 1, NOW)).toEqual({
      warn: false,
      secondsLeft: 0,
      nextChangeInMs: null,
    })
  })

  it('treats the exact deadline as passed', () => {
    expect(deadlineState(NOW, NOW).nextChangeInMs).toBeNull()
  })
})

describe('the threshold is a parameter', () => {
  it('so a caller can want a different one without a second function', () => {
    expect(deadlineState(NOW + 90_000, NOW, 120_000).warn).toBe(true)
  })
})

describe('formatCountdown', () => {
  it('pads the seconds, so the width does not jump as it counts', () => {
    expect(formatCountdown(65)).toBe('1:05')
    expect(formatCountdown(9)).toBe('0:09')
  })

  it('keeps the minute place under a minute, so it reads as a clock', () => {
    expect(formatCountdown(59)).toBe('0:59')
  })

  it('never renders a negative', () => {
    expect(formatCountdown(-5)).toBe('0:00')
  })
})
