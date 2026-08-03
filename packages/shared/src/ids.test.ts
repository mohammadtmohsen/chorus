import { describe, expect, it } from 'vitest'
import { uuidv7 } from './ids.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuidv7', () => {
  it('produces a well-formed v7 uuid with the RFC 4122 variant', () => {
    expect(uuidv7()).toMatch(UUID_RE)
  })

  it('is unique across a tight loop', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7()))
    expect(ids.size).toBe(10_000)
  })

  it('sorts lexicographically in generation order', () => {
    // This is the property the event log depends on: id ordering must agree
    // with time ordering, or `events.seq` and id ordering diverge.
    const a = uuidv7()
    const later = Date.now() + 2
    while (Date.now() < later) {
      /* spin briefly so the millisecond field advances */
    }
    const b = uuidv7()
    expect(a < b).toBe(true)
  })
})
