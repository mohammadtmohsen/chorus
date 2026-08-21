import { describe, expect, it } from 'vitest'
import { EMPTY_VIEW, reduceTranscriptRead } from './transcript.js'
import type { TranscriptEvent } from '../../shared/ipc.js'

/**
 * The half of Phase 2 that is not the filter: how far the view claims to have
 * read.
 *
 * A filter that forgets what it filtered is a loop. `conversation:transcript`
 * omits the types the transcript has no case for, and `command.output` is the
 * commonest event in the log — so a conversation's newest events are routinely
 * ones that never reach the renderer. These are the cases that decide whether
 * the next push asks for the same range again.
 */
const event = (seq: number, type = 'user.message'): TranscriptEvent => ({
  seq,
  id: `e${String(seq)}`,
  conversationId: 'c1',
  actor: 'user',
  type,
  payload: { text: 'hello' },
  createdAt: 1_000,
})

describe('reduceTranscriptRead', () => {
  it('advances past events the read filtered out and never returned', () => {
    // The read covered up to 90 but only three rows were of a drawable type.
    const view = reduceTranscriptRead(EMPTY_VIEW, [event(1), event(2), event(3)], 90)
    expect(view.lastSeq).toBe(90)
    expect(view.messages).toHaveLength(3)
  })

  it('advances on an empty response, which is the loop this prevents', () => {
    // Every event after `lastSeq` was an ignored type. Without `throughSeq` the
    // view would sit at 0 and re-query the same range on every single push.
    const view = reduceTranscriptRead(EMPTY_VIEW, [], 500)
    expect(view.lastSeq).toBe(500)
    expect(view.messages).toEqual([])
  })

  /*
   * The hazard the buffering in `Session` exists to avoid, pinned here so nobody
   * removes the buffer on the grounds that this function "handles it".
   *
   * It does not, and cannot: `reduceEvents` skips anything at or below
   * `lastSeq`, which is right for a duplicate and catastrophic for a backfill.
   * A push at 101 arriving before the read of 1–100 resolves leaves the view at
   * 101, and folding the read in then discards **every one of those hundred
   * rows** — the transcript shows the pushed row and nothing before it. The fix
   * is ordering, in the component; this test only says why.
   */
  it('discards a backfill that a push already ran ahead of — hence the buffer', () => {
    const overtaken = reduceTranscriptRead(EMPTY_VIEW, [event(101)], 101)
    expect(overtaken.messages).toHaveLength(1)

    const backfilled = reduceTranscriptRead(overtaken, [event(1), event(2), event(3)], 3)
    // One row, not four. This is the bug, asserted as behaviour rather than
    // fixed here — `Session` holds pushes until the read lands so it cannot
    // happen.
    expect(backfilled.messages).toHaveLength(1)
    expect(backfilled.lastSeq).toBe(101)
  })

  it('never moves lastSeq backwards when a push overtook the read', () => {
    // A live push landed while the read was in flight, so the view is already
    // ahead. Assigning `throughSeq` here would replay events it already holds.
    const ahead = { ...EMPTY_VIEW, lastSeq: 900 }
    expect(reduceTranscriptRead(ahead, [], 500).lastSeq).toBe(900)
  })

  it('prefers the reduction when it went further than the mark', () => {
    const view = reduceTranscriptRead(EMPTY_VIEW, [event(1), event(77)], 10)
    expect(view.lastSeq).toBe(77)
  })

  it('leaves an ignored type out of the rows while still counting it', () => {
    const view = reduceTranscriptRead(EMPTY_VIEW, [event(4, 'command.output')], 4)
    expect(view.messages).toEqual([])
    expect(view.lastSeq).toBe(4)
  })
})
