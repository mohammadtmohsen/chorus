import { describe, expect, it } from 'vitest'
import type { LimitsPush } from '../../../shared/ipc.js'
import { describeWindow, fullRemaining, usageReadings } from './useUsage.js'

/**
 * Four readings, in one order, whatever has arrived.
 *
 * The rail's account column is monitoring information, and monitoring
 * information that moves is information you have to read rather than glance at.
 * The version this replaces derived its rows from the pushes it had received and
 * sorted the accounts by agent id — so a fresh window showed nothing, then two
 * Claude figures, then four with Claude above Codex. Every case below is one of
 * the ways that went wrong.
 */

const NOW = 1_700_000_000_000

function push(agentId: 'codex' | 'claude', windows: LimitsPush['windows']): LimitsPush {
  return { agentId, windows }
}

const FIVE_HOURS = { id: '5h', usedPercent: 42, windowMinutes: 300, resetsAt: NOW + 3_600_000 }
const WEEKLY = { id: 'weekly', usedPercent: 18, windowMinutes: 10_080, resetsAt: NOW + 86_400_000 }

/** What each slot is, said once, in the order the plan locked. */
const ORDER = [
  ['codex', 'short'],
  ['codex', 'long'],
  ['claude', 'short'],
  ['claude', 'long'],
] as const

describe('usageReadings', () => {
  it('gives four readings before anything has been pushed', () => {
    const readings = usageReadings([], NOW)
    expect(readings.map((r) => [r.agentId, r.kind])).toEqual(ORDER.map((slot) => [...slot]))
  })

  /*
   * The bug, stated as a test: `0%` and "not reported" are different facts, and
   * the first one is a claim about the account.
   */
  it('never reports an unpushed window as empty', () => {
    for (const reading of usageReadings([], NOW)) {
      expect(reading.percent).toBeNull()
      expect(reading.reported).toBe(false)
      expect(reading.reset).toBe('—')
    }
  })

  it('keeps the order when only one provider has answered', () => {
    const readings = usageReadings([push('claude', [FIVE_HOURS, WEEKLY])], NOW)
    expect(readings.map((r) => [r.agentId, r.kind])).toEqual(ORDER.map((slot) => [...slot]))
    expect(readings.filter((r) => r.reported).map((r) => r.agentId)).toEqual(['claude', 'claude'])
    expect(readings.filter((r) => r.agentId === 'codex').every((r) => r.percent === null)).toBe(
      true
    )
  })

  /*
   * Alphabetical order put Claude first, and the pushes arrive in whatever order
   * two independent processes answer in. Neither may reach the column.
   */
  it('is the same order whichever provider answers first', () => {
    const claudeFirst = usageReadings(
      [push('claude', [FIVE_HOURS, WEEKLY]), push('codex', [WEEKLY, FIVE_HOURS])],
      NOW
    )
    const codexFirst = usageReadings(
      [push('codex', [WEEKLY, FIVE_HOURS]), push('claude', [FIVE_HOURS, WEEKLY])],
      NOW
    )
    expect(claudeFirst.map((r) => [r.agentId, r.kind])).toEqual(ORDER.map((slot) => [...slot]))
    expect(codexFirst.map((r) => [r.agentId, r.kind])).toEqual(
      claudeFirst.map((r) => [r.agentId, r.kind])
    )
  })

  /*
   * And the windows within an account are placed by their reported duration, not
   * by their position — a provider that pushes weekly first still reads 5h, 1w.
   */
  it('places a window by its length rather than by its position in the push', () => {
    const [short, long] = usageReadings([push('codex', [WEEKLY, FIVE_HOURS])], NOW)
    expect(short?.label).toBe('5h')
    expect(short?.percent).toBe(42)
    expect(long?.label).toBe('1w')
    expect(long?.percent).toBe(18)
  })

  it('uses the provider’s own label and percentage when it reports one', () => {
    const readings = usageReadings(
      [push('codex', [{ id: 'x', usedPercent: 66.4, windowMinutes: 1_440, resetsAt: null }])],
      NOW
    )
    expect(readings[0]?.label).toBe('1d')
    expect(readings[0]?.percent).toBe(66)
    // No reset time reported is still a reported window; only the moment is missing.
    expect(readings[0]?.reported).toBe(true)
    expect(readings[0]?.reset).toBe('—')
  })

  it('leaves the other slot unreported when a provider answers with one window', () => {
    const readings = usageReadings([push('codex', [FIVE_HOURS])], NOW)
    expect(readings[0]?.reported).toBe(true)
    expect(readings[1]?.reported).toBe(false)
    expect(readings[1]?.label).toBe('1w')
  })

  /*
   * A window with no percentage is not a reading of nothing — it must not take
   * the slot, or the reading that did arrive would have nowhere to go.
   */
  it('does not let a window with no percentage take a slot', () => {
    const readings = usageReadings(
      [push('codex', [{ id: 'partial', usedPercent: null, windowMinutes: 60, resetsAt: null }])],
      NOW
    )
    expect(readings[0]?.reported).toBe(false)
    expect(readings[0]?.percent).toBeNull()
  })

  it('clamps a percentage over the top rather than drawing past it', () => {
    const readings = usageReadings(
      [push('codex', [{ id: 'over', usedPercent: 140, windowMinutes: 300, resetsAt: null }])],
      NOW
    )
    expect(readings[0]?.percent).toBe(100)
  })
})

/**
 * The comparison the rail could not previously make.
 *
 * A percentage on its own cannot be judged: 63% of a week is healthy on day six
 * and alarming on day two, and the rail drew both the same. These cases pin the
 * two things that fixes it — where the window has got to, and how much of its end
 * the allowance will not reach.
 */
describe('usageReadings pace', () => {
  const at = (usedPercent: number, minutesLeft: number, windowMinutes = 300): LimitsPush =>
    push('codex', [{ id: 'w', usedPercent, windowMinutes, resetsAt: NOW + minutesLeft * 60_000 }])

  it('reads how far through the window the reading sits', () => {
    // Four of five hours left, so the window is one fifth gone.
    expect(usageReadings([at(10, 240)], NOW)[0]?.elapsedPercent).toBe(20)
  })

  it('calls spending slower than the clock no shortfall at all', () => {
    const reading = usageReadings([at(10, 240)], NOW)[0]
    expect(reading?.dryMinutes).toBe(0)
    expect(reading?.dry).toBe('—')
  })

  /*
   * The arithmetic that makes the red segment mean something: what is left of
   * the allowance (40%) falls short of what is left of the window (60%) by 20%,
   * and 20% of five hours is an hour.
   */
  it('measures the shortfall as the stretch of window the allowance will not reach', () => {
    const reading = usageReadings([at(60, 180)], NOW)[0]
    expect(reading?.elapsedPercent).toBe(40)
    expect(reading?.dryMinutes).toBe(60)
    expect(reading?.dry).toBe('1h')
  })

  /* A spent account is shut until the reset, and the shortfall says exactly that. */
  it('counts a fully spent window as dry for the whole of what is left', () => {
    const reading = usageReadings([at(100, 97)], NOW)[0]
    expect(reading?.dryMinutes).toBe(97)
    expect(reading?.dry).toBe(reading?.reset)
  })

  it('has no pace to report when the provider gave no reset moment', () => {
    const readings = usageReadings(
      [push('codex', [{ id: 'w', usedPercent: 50, windowMinutes: 300, resetsAt: null }])],
      NOW
    )
    expect(readings[0]?.elapsedPercent).toBeNull()
    expect(readings[0]?.dryMinutes).toBeNull()
    expect(readings[0]?.dry).toBe('—')
  })

  /*
   * Without a length there is no share to compare against — a tick placed from
   * the slot's assumed duration would be Chorus claiming a window the provider
   * never reported.
   */
  it('has no pace to report when the provider gave no window length', () => {
    const readings = usageReadings(
      [
        push('codex', [
          { id: 'w', usedPercent: 50, windowMinutes: null, resetsAt: NOW + 3_600_000 },
        ]),
      ],
      NOW
    )
    expect(readings[0]?.elapsedPercent).toBeNull()
    expect(readings[0]?.dryMinutes).toBeNull()
  })

  it('reads a reset already past as a finished window, not a negative one', () => {
    const reading = usageReadings([at(80, -30)], NOW)[0]
    expect(reading?.elapsedPercent).toBe(100)
    expect(reading?.dryMinutes).toBe(0)
  })

  /* An unreported slot has no figure, so there is nothing to pace it against. */
  it('leaves the pace of an unreported slot null', () => {
    for (const reading of usageReadings([], NOW)) {
      expect(reading.elapsedPercent).toBeNull()
      expect(reading.dryMinutes).toBeNull()
      expect(reading.dry).toBe('—')
    }
  })
})

describe('describeWindow', () => {
  it('says each duration in the shortest honest form', () => {
    expect(describeWindow(300)).toBe('5h')
    expect(describeWindow(10_080)).toBe('1w')
    expect(describeWindow(1_440)).toBe('1d')
    expect(describeWindow(90)).toBe('90m')
    expect(describeWindow(null)).toBe('?')
  })
})

describe('fullRemaining', () => {
  it('spells out every unit, and says now for a boundary already gone', () => {
    expect(fullRemaining(NOW + 5 * 86_400_000 + 18 * 3_600_000 + 17 * 60_000, NOW)).toBe(
      '5d 18h 17m'
    )
    expect(fullRemaining(NOW - 1, NOW)).toBe('now')
    expect(fullRemaining(null, NOW)).toBe('—')
  })
})
