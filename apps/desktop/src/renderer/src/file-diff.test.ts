import { describe, expect, it } from 'vitest'
import { capHunks, MAX_DIFF_LINES } from './FileDiff.js'

/**
 * The cap on how much of one file's diff is drawn.
 *
 * A hunk is normally the change plus three lines of context however large the
 * file — which is why this never mattered until branch diffs, where a file
 * created on the branch is one hunk holding the whole file.
 */

const hunk = (
  n: number,
  header = '@@'
): { header: string; lines: { kind: 'added'; text: string }[] } => ({
  header,
  lines: Array.from({ length: n }, (_, i) => ({
    kind: 'added' as const,
    text: `line ${String(i)}`,
  })),
})

describe('capHunks', () => {
  it('leaves an ordinary diff alone', () => {
    const hunks = [hunk(7), hunk(12)]
    const capped = capHunks(hunks)
    expect(capped.hunks).toBe(hunks)
    expect(capped.omitted).toBe(0)
  })

  it('cuts a file-sized hunk down and says how much it cut', () => {
    const capped = capHunks([hunk(5_000)], 600)
    expect(capped.hunks[0]?.lines.length).toBe(600)
    expect(capped.omitted).toBe(4_400)
  })

  it('keeps whole hunks until the budget runs out', () => {
    // From the front rather than a sample: a diff read from the top is one you
    // can follow, and a windowed middle is one you cannot.
    const capped = capHunks([hunk(10, 'a'), hunk(10, 'b'), hunk(10, 'c')], 15)
    expect(capped.hunks.map((h) => h.header)).toEqual(['a', 'b'])
    expect(capped.hunks[0]?.lines.length).toBe(10)
    expect(capped.hunks[1]?.lines.length).toBe(5)
    expect(capped.omitted).toBe(15)
  })

  it('drops nothing at exactly the limit', () => {
    expect(capHunks([hunk(600)], 600).omitted).toBe(0)
  })

  it('handles a file with no hunks', () => {
    expect(capHunks([])).toEqual({ hunks: [], omitted: 0 })
  })

  it('defaults to a limit far above any hunk anyone reads', () => {
    expect(MAX_DIFF_LINES).toBeGreaterThan(100)
  })
})
