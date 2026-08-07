import { describe, expect, it } from 'vitest'
import { CARRY_BUDGET_CHARS, trimCarry, withinBudget } from './carry.js'
import { EMPTY_VIEW } from './transcript.js'
import type { SessionCarry } from './Session.js'

function carryOf(chars: number): SessionCarry {
  return {
    view: {
      ...EMPTY_VIEW,
      lastSeq: 42,
      messages: [
        {
          key: 'm1',
          eventId: 'e1',
          actor: 'claude',
          kind: 'message',
          text: 'x'.repeat(chars),
          status: 'complete',
        },
      ],
    },
    draft: 'half a thought',
    attached: [],
    following: true,
    scrollTop: 120,
    ideIncluded: false,
  }
}

describe('carry budget', () => {
  it('keeps a short transcript, so coming back is instant', () => {
    const carry = carryOf(1_000)
    expect(withinBudget(carry)).toBe(true)
    expect(trimCarry(carry)).toBe(carry)
  })

  /*
   * The measured case: unmounting released 0.1MB of a 0.9MB transcript, because
   * the view is kept to make the return instant. Past the budget that trade
   * stops being worth it.
   */
  it('drops the view of a long one', () => {
    const carry = carryOf(CARRY_BUDGET_CHARS + 1)
    expect(withinBudget(carry)).toBe(false)
    expect(trimCarry(carry).view.messages).toEqual([])
  })

  /*
   * The whole reason dropping it is safe: `Session` asks for everything after
   * `lastSeq`, so a zeroed view replays the conversation in full rather than
   * showing a truncated one.
   */
  it('zeroes lastSeq with it, so the refetch asks for everything', () => {
    expect(trimCarry(carryOf(CARRY_BUDGET_CHARS + 1)).view.lastSeq).toBe(0)
  })

  it('keeps what the event store cannot give back', () => {
    const trimmed = trimCarry(carryOf(CARRY_BUDGET_CHARS + 1))
    expect(trimmed.draft).toBe('half a thought')
    expect(trimmed.scrollTop).toBe(120)
    expect(trimmed.following).toBe(true)
  })
})
