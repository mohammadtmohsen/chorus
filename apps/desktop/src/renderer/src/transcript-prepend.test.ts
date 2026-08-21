import { describe, expect, it } from 'vitest'
import { EMPTY_VIEW, prependEvents, reduceEvents } from './transcript.js'
import type { TranscriptEvent } from '../../shared/ipc.js'

/**
 * Loading an earlier page, which is the half of paging that can go silently
 * wrong.
 *
 * `reduceEvents` skips anything at or below `lastSeq`. That guard is what makes
 * the live stream safe, and it is also what makes it unable to prepend — so this
 * is a separate entry point rather than a loosened condition. The tests that
 * matter are the ones proving it stays separate.
 */
const event = (seq: number, text: string): TranscriptEvent => ({
  seq,
  id: `e${String(seq)}`,
  conversationId: 'c1',
  actor: 'user',
  type: 'user.message',
  payload: { text },
  createdAt: 1_000 + seq,
})

const approval = (seq: number): TranscriptEvent => ({
  seq,
  id: `a${String(seq)}`,
  conversationId: 'c1',
  actor: 'claude',
  type: 'approval.requested',
  payload: { approvalId: `ap${String(seq)}`, kind: 'command', request: {}, expiresAt: 9_999 },
  createdAt: 1_000 + seq,
})

describe('prependEvents', () => {
  it('puts older rows before the ones already held', () => {
    const latest = reduceEvents(EMPTY_VIEW, [event(10, 'ten'), event(11, 'eleven')])
    const full = prependEvents(latest, [event(1, 'one'), event(2, 'two')])
    expect(full.messages.map((m) => m.text)).toEqual(['one', 'two', 'ten', 'eleven'])
  })

  it('moves firstSeq back, which is what the next page is asked for', () => {
    const latest = reduceEvents(EMPTY_VIEW, [event(10, 'ten')])
    expect(latest.firstSeq).toBe(10)
    expect(prependEvents(latest, [event(4, 'four'), event(5, 'five')]).firstSeq).toBe(4)
  })

  it('leaves lastSeq alone, so the live stream keeps its guard', () => {
    /*
     * The whole reason this is not `reduceEvents` with a relaxed condition. If a
     * prepend moved `lastSeq` backwards, every subsequent live push would be
     * re-applied — or, worse, the next read would re-request rows already held.
     */
    const latest = reduceEvents(EMPTY_VIEW, [event(10, 'ten')])
    expect(prependEvents(latest, [event(1, 'one')]).lastSeq).toBe(10)
  })

  it('does not fold accumulated state out of an earlier page', () => {
    /*
     * An approval requested on an early page may well have been decided on a
     * later one. Folding the page would resurrect it as pending — a blocking
     * card for a decision already taken. State comes from `transcriptState`,
     * queried; this touches rows only.
     */
    const latest = reduceEvents(EMPTY_VIEW, [event(10, 'ten')])
    const full = prependEvents(latest, [approval(2), event(3, 'three')])
    expect(full.approvals).toEqual([])
    expect(full.messages.map((m) => m.text)).toEqual(['three', 'ten'])
  })

  it('still moves the boundary when a page renders nothing', () => {
    // Otherwise the next request asks for the same range forever — the same loop
    // `throughSeq` exists to prevent at the other end.
    const latest = reduceEvents(EMPTY_VIEW, [event(10, 'ten')])
    const full = prependEvents(latest, [approval(2)])
    expect(full.messages).toHaveLength(1)
    expect(full.firstSeq).toBe(2)
  })

  it('is a no-op for an empty page, so reaching the beginning changes nothing', () => {
    const latest = reduceEvents(EMPTY_VIEW, [event(10, 'ten')])
    expect(prependEvents(latest, [])).toBe(latest)
  })

  it('builds rows with the same cases as a forward fold', () => {
    // Not a second row-builder: prepending folds from EMPTY_VIEW and takes the
    // messages, so a new event type is rendered identically in both directions.
    const forward = reduceEvents(EMPTY_VIEW, [event(1, 'one'), event(2, 'two')])
    const backward = prependEvents(reduceEvents(EMPTY_VIEW, [event(2, 'two')]), [event(1, 'one')])
    expect(backward.messages.map((m) => m.text)).toEqual(forward.messages.map((m) => m.text))
    expect(backward.messages[0]?.key).toBe(forward.messages[0]?.key)
  })
})
