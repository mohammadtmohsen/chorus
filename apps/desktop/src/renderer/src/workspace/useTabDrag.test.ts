import { describe, expect, it } from 'vitest'
import { railSlotAt } from './useTabDrag.js'

/**
 * Where a card lands, by the midpoints of the cards it is dragged past.
 *
 * The geometry around this needs a running window; the arithmetic is the part
 * that gets the answer wrong, so it is pure and tested here. Slots are the gap
 * indices `reorderSessions` takes: 0 is above the first card, `length` is below
 * the last.
 */
describe('railSlotAt', () => {
  // Four 44px cards, 20px apart, starting at y=100: midpoints every 64px.
  const midpoints = [122, 186, 250, 314]

  it('puts a pointer above the first card in the first gap', () => {
    expect(railSlotAt(midpoints, 0)).toBe(0)
    expect(railSlotAt(midpoints, 121)).toBe(0)
  })

  it('crosses to the next gap at each midpoint, not at each edge', () => {
    // A card is claimed once the pointer is past its centre, which is what makes
    // the insertion line follow the pointer rather than jump a card early.
    expect(railSlotAt(midpoints, 123)).toBe(1)
    expect(railSlotAt(midpoints, 187)).toBe(2)
    expect(railSlotAt(midpoints, 251)).toBe(3)
  })

  it('puts a pointer below the last card in the last gap', () => {
    expect(railSlotAt(midpoints, 315)).toBe(4)
    expect(railSlotAt(midpoints, 10_000)).toBe(4)
  })

  it('has one gap and no cards when the rail is empty', () => {
    expect(railSlotAt([], 40)).toBe(0)
  })
})
