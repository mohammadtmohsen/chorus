/**
 * **PARKED. Nothing imports this today — Phase 6 is deferred, not shipped.**
 *
 * Transcript virtualisation was built, measured (58,380 DOM nodes to 568, commit
 * 751.7 ms to 28.2 ms) and then backed out of the 0.20.0 release, because it
 * cost the reader their scroll position when switching tabs (C-049) and the fix
 * for that — carrying the measured heights alongside the anchor — stopped a pane
 * mounting at all. Phase 5's paged read bounds the first mount to 400 events on
 * its own, which is what the original freeze was about, so this became an
 * optimisation rather than a fix.
 *
 * Kept rather than deleted because it is pure, it is covered by twenty tests,
 * and it is the half of that work that was never in doubt. It compiles into
 * nothing while no module imports it.
 *
 * ---
 *
 * Which transcript rows are worth mounting, and how much empty space stands in
 * for the rest.
 *
 * **All of the judgement, none of the DOM.** This is the part of virtualisation
 * that can be tested honestly: jsdom does no layout, never fires a
 * `ResizeObserver` and treats `scrollTop` as a plain property, so a test there
 * that "proved" the window was right would be asserting on numbers it had
 * assigned itself. Everything here is arithmetic over measured heights, and the
 * lifecycle around it is verified in Chromium instead.
 *
 * **Why any of this exists.** Measured in a real renderer, an entry-heavy
 * conversation spends 752 ms committing 4,276 rows into 58,380 DOM nodes,
 * against 156 ms reducing them. Mounting is the larger cost by 4.8×.
 */

/** A row's height once something has measured it. Keyed by `TranscriptMessage.key`. */
export type HeightCache = ReadonlyMap<string, number>

/**
 * Where the reader is, expressed so it survives re-measurement.
 *
 * **Not a pixel offset, and that is the whole point.** `SessionCarry` used to
 * carry `scrollTop` as a number, and the restore effect then spent up to two
 * seconds polling for the content to grow tall enough to hold it — an
 * approximation of an anchor, written because there was no anchor. Once rows
 * above the viewport are estimates rather than measurements, a pixel offset does
 * not even approximate: it names a position in a coordinate system that changes
 * as things are measured.
 *
 * A row key plus how far into that row the viewport starts is stable under
 * re-measurement, survives the pane being dragged into another pane, and lets
 * the restore write once instead of polling.
 */
export interface ScrollAnchor {
  /** `TranscriptMessage.key` of the topmost row touching the viewport. */
  readonly key: string
  /** Pixels of that row already scrolled past. Never negative. */
  readonly offset: number
}

export interface WindowInput {
  /** Row keys, in order. The list being windowed. */
  readonly keys: readonly string[]
  readonly heights: HeightCache
  /** Stand-in for a row nothing has measured yet. */
  readonly estimate: number
  /** The scroller's `scrollTop`, in this list's own coordinates. */
  readonly viewportTop: number
  readonly viewportHeight: number
  /** Extra pixels mounted above and below, so ordinary scrolling never sees a gap. */
  readonly overscan: number
  /**
   * Rows held mounted regardless of where the viewport is, because a selection
   * is live inside them. Inclusive start, exclusive end.
   */
  readonly pinned: Range | null
  /**
   * Window the **end** of the list rather than wherever `viewportTop` points.
   *
   * Set while the transcript is following. Deriving the window from `scrollTop`
   * works only if the total height is right, and it is not — rows nothing has
   * measured are estimates, so the bottom the arithmetic computes and the bottom
   * the browser scrolls to are different numbers. Estimation error would then
   * move a pinned pane, which is the failure a reader notices fastest.
   *
   * Walking back from the end sidesteps the question: the last row is mounted
   * because it is the last row, `spacerAfter` is zero, and the bottom is a real
   * bottom whatever the estimates say.
   */
  readonly tail: boolean
}

/** Inclusive start, exclusive end — the half-open convention `slice` uses. */
export interface Range {
  readonly start: number
  readonly end: number
}

export interface MountedBlock extends Range {
  /** Height of the rows skipped immediately before this block. */
  readonly spacerBefore: number
}

export interface WindowResult {
  /**
   * The runs of rows to render, in order, never overlapping.
   *
   * Usually one. Two when a selection is being held somewhere the reader has
   * since scrolled away from — and **two rather than one merged range** on
   * purpose: merging would mount every row between the selection and the
   * viewport, which for a selection made near the top of a long conversation is
   * thousands of rows and exactly the freeze this phase removes.
   */
  readonly blocks: readonly MountedBlock[]
  /** Height of the rows after the last block. */
  readonly spacerAfter: number
}

function heightOf(
  keys: readonly string[],
  heights: HeightCache,
  index: number,
  estimate: number
): number {
  const key = keys[index]
  if (key === undefined) return 0
  return heights.get(key) ?? estimate
}

/** Total height of `[from, to)`. */
function spanHeight(
  keys: readonly string[],
  heights: HeightCache,
  estimate: number,
  from: number,
  to: number
): number {
  let total = 0
  for (let i = Math.max(0, from); i < Math.min(keys.length, to); i++) {
    total += heightOf(keys, heights, i, estimate)
  }
  return total
}

/**
 * The rows the viewport touches, plus overscan.
 *
 * Walks from the top rather than keeping prefix sums. For the measured worst
 * case — 4,276 rows — that is a few thousand additions per render, which is
 * microseconds against the 752 ms this is here to remove. Prefix sums would be
 * an optimisation of the cheap half, and a second structure to invalidate every
 * time a `ResizeObserver` reports a row grew.
 */
function visibleRange(input: WindowInput): Range {
  const { keys, heights, estimate, viewportTop, viewportHeight, overscan, tail } = input

  if (tail) {
    // Backwards from the end until the viewport and its overscan are covered.
    const wanted = viewportHeight + overscan
    let start = keys.length
    let filled = 0
    while (start > 0 && filled < wanted) {
      start--
      filled += heightOf(keys, heights, start, estimate)
    }
    return { start, end: keys.length }
  }

  const top = viewportTop - overscan
  const bottom = viewportTop + viewportHeight + overscan

  let start = 0
  let offset = 0
  while (start < keys.length) {
    const height = heightOf(keys, heights, start, estimate)
    if (offset + height > top) break
    offset += height
    start++
  }

  /*
   * A viewport past the end of the list walks `start` off it, and then no amount
   * of clamping `end` can produce a non-empty window — the two meet at
   * `keys.length`. Reachable while every height is still an estimate and the
   * real content is taller than the guess, which is exactly the first render.
   * Falling back to the last row keeps something mounted, so something gets
   * measured, so the next pass has a real number to work from.
   */
  if (start >= keys.length) {
    start = keys.length - 1
    offset -= heightOf(keys, heights, start, estimate)
  }

  let end = start
  while (end < keys.length && offset < bottom) {
    offset += heightOf(keys, heights, end, estimate)
    end++
  }

  // Never an empty window while there are rows: an empty one renders nothing,
  // measures nothing, and so can never learn the heights that would make it
  // non-empty. That is a window that stays broken rather than converging.
  if (end === start && keys.length > 0) end = Math.min(keys.length, start + 1)
  return { start, end }
}

/** Merges only ranges that actually touch, so a distant selection stays its own block. */
function normalise(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start)
  const out: Range[] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && range.start <= last.end) {
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, range.end) }
      continue
    }
    out.push(range)
  }
  return out
}

export function windowFor(input: WindowInput): WindowResult {
  const { keys, heights, estimate, pinned } = input
  if (keys.length === 0) return { blocks: [], spacerAfter: 0 }

  const clamp = (r: Range): Range => ({
    start: Math.max(0, Math.min(keys.length, r.start)),
    end: Math.max(0, Math.min(keys.length, r.end)),
  })

  const ranges = normalise(
    pinned === null ? [visibleRange(input)] : [visibleRange(input), clamp(pinned)]
  )

  const blocks: MountedBlock[] = []
  let previousEnd = 0
  for (const range of ranges) {
    blocks.push({
      ...range,
      spacerBefore: spanHeight(keys, heights, estimate, previousEnd, range.start),
    })
    previousEnd = range.end
  }

  return {
    blocks,
    spacerAfter: spanHeight(keys, heights, estimate, previousEnd, keys.length),
  }
}

/**
 * The anchor for a scroll position — what to write down when a pane is
 * backgrounded.
 *
 * Returns `null` for the top of an empty list, so a carry never stores an anchor
 * naming a row that is not there.
 */
export function anchorAt(
  keys: readonly string[],
  heights: HeightCache,
  estimate: number,
  viewportTop: number
): ScrollAnchor | null {
  let offset = 0
  for (const key of keys) {
    const height = heights.get(key) ?? estimate
    if (offset + height > viewportTop) return { key, offset: Math.max(0, viewportTop - offset) }
    offset += height
  }
  return null
}

/**
 * The scroll position an anchor names now, or `null` if its row is gone.
 *
 * `null` rather than a guess: a row can genuinely disappear — a conversation
 * reopened after events were compacted, or a carry from a previous version — and
 * scrolling to an arbitrary substitute puts the reader somewhere they never
 * were, silently. Not restoring is honest and visible.
 */
export function scrollTopFor(
  keys: readonly string[],
  heights: HeightCache,
  estimate: number,
  anchor: ScrollAnchor
): number | null {
  let offset = 0
  for (const key of keys) {
    if (key === anchor.key) return offset + anchor.offset
    offset += heights.get(key) ?? estimate
  }
  return null
}
