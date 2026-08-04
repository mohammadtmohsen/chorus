import { describe, expect, it } from 'vitest'
import { compare } from './which.js'

describe('compare', () => {
  it('orders by number, not by text', () => {
    // The bug this exists for: 0.42.0 sorted above 0.146.0 as strings, and
    // 0.42.0 is old enough that `codex app-server` will not start.
    expect(compare([0, 146, 0], [0, 42, 0])).toBeGreaterThan(0)
  })

  it('compares major before minor before patch', () => {
    expect(compare([1, 0, 0], [0, 999, 999])).toBeGreaterThan(0)
    expect(compare([1, 2, 0], [1, 1, 99])).toBeGreaterThan(0)
    expect(compare([1, 2, 3], [1, 2, 4])).toBeLessThan(0)
  })

  it('treats equal versions as equal', () => {
    expect(compare([2, 1, 220], [2, 1, 220])).toBe(0)
  })

  it('treats a missing part as zero', () => {
    expect(compare([1], [1, 0, 0])).toBe(0)
    expect(compare([1, 1], [1, 0, 5])).toBeGreaterThan(0)
  })
})
