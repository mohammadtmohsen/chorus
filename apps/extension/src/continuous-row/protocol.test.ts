import { describe, expect, it } from 'vitest'
import {
  CONTINUOUS_ROW,
  editorEdge,
  readPageMessage,
  readRowMessage,
  rowBounds,
  slideStrip,
  stripOf,
} from './protocol.js'

describe('continuous row geometry', () => {
  const bounds = rowBounds(1500, 48, 300)

  it('stops the editor at desktop’s 500px workbench, or VS Code’s own editor minimum', () => {
    expect(bounds).toEqual({ barRight: 48, floor: 520, widest: 1320 })
    expect(rowBounds(1500, 48, 200).floor).toBe(500)
  })

  it('moves the divider with Chorus’s edge until the editor reaches its floor', () => {
    expect(editorEdge(900, bounds)).toBe(900)
    expect(editorEdge(300, bounds)).toBe(520)
    expect(editorEdge(1450, bounds)).toBe(1320)
  })

  it('measures the strip from the widest editor to Chorus covering all but the activity bar', () => {
    expect(stripOf(1320, bounds)).toEqual({ page: 0, extra: 1272 })
    expect(stripOf(48, bounds)).toEqual({ page: 1272, extra: 1272 })
  })
})

describe('one strip', () => {
  const start = { page: 90, extra: 100, row: 0, rowMax: 500 }

  it('reveals Chorus before moving its row, and empties the row before moving the page', () => {
    const forward = slideStrip(start, 30)
    expect(forward).toMatchObject({ page: 100, row: 20 })
    expect(slideStrip(forward, -30)).toMatchObject({ page: 90, row: 0 })
  })

  it('stops at both ends', () => {
    expect(slideStrip(start, -1000)).toMatchObject({ page: 0, row: 0 })
    expect(slideStrip(start, 10_000)).toMatchObject({ page: 100, row: 500 })
  })

  it('moves the page alone when the strip has no row to scroll', () => {
    expect(slideStrip({ page: 0, extra: 100, row: 0, rowMax: 0 }, 60)).toMatchObject({
      page: 60,
      row: 0,
    })
  })
})

describe('message readers', () => {
  it('accepts well-formed messages and rejects the rest', () => {
    expect(readRowMessage({ source: CONTINUOUS_ROW, kind: 'hello', session: 7 })).toEqual({
      source: CONTINUOUS_ROW,
      kind: 'hello',
      session: 7,
    })
    expect(readRowMessage({ source: CONTINUOUS_ROW, kind: 'hello' })).toBeNull()
    expect(
      readPageMessage({
        source: CONTINUOUS_ROW,
        kind: 'page',
        page: 5,
        extra: 9,
        inset: 4,
        applied: 1,
      })
    ).toEqual({ source: CONTINUOUS_ROW, kind: 'page', page: 5, extra: 9, inset: 4, applied: 1 })
    expect(
      readPageMessage({ source: CONTINUOUS_ROW, kind: 'page', page: 5, extra: 9, applied: 1 })
    ).toBeNull()
    expect(
      readPageMessage({ source: 'other', kind: 'page', page: 0, extra: 0, inset: 0, applied: 0 })
    ).toBeNull()
    expect(
      readPageMessage({ source: CONTINUOUS_ROW, kind: 'row-target', seq: 1, row: 'x' })
    ).toBeNull()
    expect(readPageMessage({ source: CONTINUOUS_ROW, kind: 'unknown' })).toBeNull()
  })
})
