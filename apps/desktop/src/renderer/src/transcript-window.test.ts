import { describe, expect, it } from 'vitest'
import { anchorAt, scrollTopFor, windowFor, type HeightCache } from './transcript-window.js'

/**
 * The arithmetic of virtualisation, with no DOM anywhere near it.
 *
 * These are the only assertions about this phase that can be trusted in the fast
 * suite. jsdom does no layout, never fires a `ResizeObserver`, and treats
 * `scrollTop` as a plain property — so following, restoration and selection
 * across the window boundary are verified in Chromium, not here. What is here is
 * the part that is genuinely a function.
 */

const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `m${String(i)}`)

/** Every row the same height, so an expected offset is a multiplication. */
const uniform = (n: number, height: number): HeightCache =>
  new Map(keys(n).map((key) => [key, height]))

const input = (over: Partial<Parameters<typeof windowFor>[0]>) => ({
  keys: keys(100),
  heights: uniform(100, 10),
  estimate: 10,
  viewportTop: 0,
  viewportHeight: 100,
  overscan: 0,
  pinned: null,
  tail: false,
  ...over,
})

describe('windowFor', () => {
  it('mounts only what the viewport touches', () => {
    const { blocks, spacerAfter } = windowFor(input({ viewportTop: 500 }))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ start: 50, end: 60, spacerBefore: 500 })
    // 100 rows of 10px = 1000; 500 above, 100 mounted, 400 below.
    expect(spacerAfter).toBe(400)
  })

  it('keeps the total height right, so the scrollbar does not lie', () => {
    const { blocks, spacerAfter } = windowFor(input({ viewportTop: 300 }))
    const mounted = blocks.reduce((sum, b) => sum + (b.end - b.start) * 10, 0)
    const spacers = blocks.reduce((sum, b) => sum + b.spacerBefore, 0) + spacerAfter
    expect(mounted + spacers).toBe(1_000)
  })

  it('mounts more when asked to overscan, without changing the total', () => {
    const { blocks, spacerAfter } = windowFor(input({ viewportTop: 500, overscan: 100 }))
    expect(blocks[0]?.start).toBe(40)
    const mounted = blocks.reduce((sum, b) => sum + (b.end - b.start) * 10, 0)
    expect(mounted + blocks[0]!.spacerBefore + spacerAfter).toBe(1_000)
  })

  it('falls back to an estimate for rows nothing has measured', () => {
    const { blocks } = windowFor(
      input({ heights: new Map(), estimate: 20, viewportTop: 200, viewportHeight: 100 })
    )
    // 20px rows: 200/20 = row 10, and five rows fill 100px.
    expect(blocks[0]).toMatchObject({ start: 10, end: 15 })
  })

  it('never returns an empty window while there are rows', () => {
    /*
     * An empty window renders nothing, so nothing is measured, so the heights
     * that would make it non-empty are never learned. It does not converge — it
     * stays broken. Reachable when the viewport sits past the end of a list
     * whose heights are all still estimates.
     */
    const { blocks } = windowFor(input({ viewportTop: 100_000 }))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.end).toBeGreaterThan(blocks[0]!.start)
  })

  it('handles an empty list without inventing a block', () => {
    expect(windowFor(input({ keys: [], heights: new Map() }))).toEqual({
      blocks: [],
      spacerAfter: 0,
    })
  })
})

/*
 * Following is a mode, not a computation. Deriving the window from `scrollTop`
 * needs the total height to be right, and it is not while rows are estimates —
 * so the bottom the arithmetic finds and the bottom the browser scrolls to are
 * different numbers, and the difference moves a pinned pane.
 */
describe('tail mode', () => {
  it('mounts the end of the list, whatever viewportTop says', () => {
    const { blocks, spacerAfter } = windowFor(input({ viewportTop: 0, tail: true }))
    expect(blocks[0]!.end).toBe(100)
    // A real bottom: nothing stands in for rows below, because there are none.
    expect(spacerAfter).toBe(0)
  })

  it('mounts enough to fill the viewport and its overscan', () => {
    const { blocks } = windowFor(input({ tail: true, viewportHeight: 100, overscan: 50 }))
    // 150px of 10px rows.
    expect(blocks[0]!.start).toBe(85)
  })

  it('does not walk off the front of a short list', () => {
    const { blocks, spacerAfter } = windowFor(
      input({ keys: keys(3), heights: uniform(3, 10), tail: true, viewportHeight: 1_000 })
    )
    expect(blocks[0]).toMatchObject({ start: 0, end: 3, spacerBefore: 0 })
    expect(spacerAfter).toBe(0)
  })

  it('still keeps a held selection mounted', () => {
    const { blocks } = windowFor(input({ tail: true, pinned: { start: 1, end: 3 } }))
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ start: 1, end: 3 })
  })
})

/*
 * A held selection is the reason this is not just "the visible range". Once a
 * row unmounts, the selection's anchor node is gone and there is nothing left to
 * say where it began — `view.messages` holds source text, not rendered text, so
 * it cannot supply a character offset into a markdown paragraph. Keeping the
 * rows is the only version that copies what was actually highlighted.
 */
describe('a pinned selection', () => {
  it('stays mounted when the reader scrolls away from it', () => {
    const { blocks } = windowFor(input({ viewportTop: 800, pinned: { start: 2, end: 5 } }))
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ start: 2, end: 5, spacerBefore: 20 })
    expect(blocks[1]!.start).toBe(80)
  })

  it('stays two blocks rather than merging into one huge one', () => {
    /*
     * The whole reason blocks are a list. Merging a selection near the top with a
     * viewport near the bottom would mount every row between them — thousands,
     * and exactly the freeze this phase removes.
     */
    const { blocks } = windowFor(input({ viewportTop: 900, pinned: { start: 0, end: 1 } }))
    const mounted = blocks.reduce((sum, b) => sum + (b.end - b.start), 0)
    expect(mounted).toBeLessThan(20)
  })

  it('merges when the selection touches the viewport, rather than splitting a run', () => {
    const { blocks } = windowFor(input({ viewportTop: 500, pinned: { start: 45, end: 52 } }))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ start: 45, end: 60 })
  })

  it('clamps a selection that names rows off the end', () => {
    const { blocks } = windowFor(input({ viewportTop: 0, pinned: { start: 95, end: 500 } }))
    expect(blocks[blocks.length - 1]!.end).toBe(100)
  })

  it('keeps the total height right with two blocks, so the scrollbar still does not lie', () => {
    const { blocks, spacerAfter } = windowFor(
      input({ viewportTop: 800, pinned: { start: 2, end: 5 } })
    )
    const mounted = blocks.reduce((sum, b) => sum + (b.end - b.start) * 10, 0)
    const spacers = blocks.reduce((sum, b) => sum + b.spacerBefore, 0) + spacerAfter
    expect(mounted + spacers).toBe(1_000)
  })
})

/*
 * The carry used to store `scrollTop` as a number, and the restore effect spent
 * up to two seconds polling for the content to grow tall enough to hold it. That
 * was an approximation of an anchor, written because there was no anchor.
 */
describe('the scroll anchor', () => {
  it('names the row the viewport starts inside, and how far in', () => {
    expect(anchorAt(keys(100), uniform(100, 10), 10, 325)).toEqual({ key: 'm32', offset: 5 })
  })

  it('round-trips through a re-measurement of rows above it', () => {
    const anchor = anchorAt(keys(100), uniform(100, 10), 10, 325)!
    // Every row above turns out to be twice as tall as assumed. A pixel offset
    // would now name a different row; the anchor names the same one.
    const remeasured = uniform(100, 20)
    expect(scrollTopFor(keys(100), remeasured, 20, anchor)).toBe(32 * 20 + 5)
  })

  it('refuses to restore an anchor whose row is gone', () => {
    // A conversation reopened after compaction, or a carry from an older build.
    // Scrolling to an arbitrary substitute would put the reader somewhere they
    // never were, silently.
    expect(scrollTopFor(keys(100), uniform(100, 10), 10, { key: 'vanished', offset: 4 })).toBeNull()
  })

  it('has no anchor for an empty list', () => {
    expect(anchorAt([], new Map(), 10, 0)).toBeNull()
  })

  it('anchors to the first row at the top', () => {
    expect(anchorAt(keys(10), uniform(10, 10), 10, 0)).toEqual({ key: 'm0', offset: 0 })
  })
})
