import { describe, expect, it } from 'vitest'
import { compactTokens, money, untilReset } from './format.js'

describe('compactTokens', () => {
  it('leaves small counts exact', () => {
    expect(compactTokens(0)).toBe('0')
    expect(compactTokens(999)).toBe('999')
  })

  it('uses thousands, with a decimal only while it says something', () => {
    expect(compactTokens(1_200)).toBe('1.2k')
    expect(compactTokens(34_500)).toBe('35k')
  })

  it('uses millions past a million', () => {
    expect(compactTokens(3_400_000)).toBe('3.4M')
  })
})

describe('money', () => {
  it('does not round a real amount away to nothing', () => {
    // Most turns cost fractions of a cent; "$0.00" would read as free.
    expect(money(0.004)).toBe('<$0.01')
  })

  it('shows cents below a hundred dollars', () => {
    expect(money(0.42)).toBe('$0.42')
    expect(money(12.5)).toBe('$12.50')
  })

  it('drops cents once they are noise', () => {
    expect(money(1234.56)).toBe('$1,235')
  })

  it('says nothing spent plainly', () => {
    expect(money(0)).toBe('$0')
  })
})

describe('untilReset', () => {
  const now = 1_700_000_000_000

  it('says now once the window has passed', () => {
    expect(untilReset(now - 1, now)).toBe('now')
  })

  it('counts minutes under an hour', () => {
    expect(untilReset(now + 25 * 60_000, now)).toBe('25m')
    // Never "0m": something still to wait for should not read as none.
    expect(untilReset(now + 20_000, now)).toBe('1m')
  })

  it('counts hours and minutes under a day', () => {
    expect(untilReset(now + 2 * 3_600_000, now)).toBe('2h')
    expect(untilReset(now + (2 * 60 + 14) * 60_000, now)).toBe('2h 14m')
  })

  it('counts days past one', () => {
    expect(untilReset(now + 3 * 86_400_000, now)).toBe('3d')
    expect(untilReset(now + 26 * 3_600_000, now)).toBe('1d 2h')
  })
})
