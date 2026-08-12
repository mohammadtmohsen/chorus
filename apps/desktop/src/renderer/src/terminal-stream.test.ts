import { describe, expect, it } from 'vitest'
import type { TerminalPush, TerminalRefShape } from '../../shared/ipc.js'
import {
  pendingUntilAttached,
  sameTerminal,
  shouldApply,
  type Attachment,
} from './terminal-stream.js'

const GLOBAL: TerminalRefShape = { scope: 'global' }
const C1: TerminalRefShape = { scope: 'session', conversationId: 'c1' }
const C2: TerminalRefShape = { scope: 'session', conversationId: 'c2' }

const at = (ref: TerminalRefShape, epoch: number, seq: number): Attachment => ({ ref, epoch, seq })

const push = (ref: TerminalRefShape, epoch: number, seq: number, data = 'x'): TerminalPush => ({
  kind: 'data',
  ref,
  epoch,
  seq,
  data,
})

describe('sameTerminal', () => {
  it('matches the global terminal only to itself', () => {
    expect(sameTerminal(GLOBAL, GLOBAL)).toBe(true)
    expect(sameTerminal(GLOBAL, C1)).toBe(false)
  })

  it('matches a session terminal by its conversation', () => {
    expect(sameTerminal(C1, C1)).toBe(true)
    expect(sameTerminal(C1, C2)).toBe(false)
  })

  /*
   * The global terminal has no conversation id, so a comparison that reached for
   * one would find undefined on both sides and call two different terminals the
   * same. That is the bug the union exists to make unrepresentable.
   */
  it('does not confuse the global terminal with a session', () => {
    expect(sameTerminal(GLOBAL, C1)).toBe(false)
    expect(sameTerminal(C1, GLOBAL)).toBe(false)
  })
})

describe('shouldApply', () => {
  it('applies output for this terminal, this attachment, after the snapshot', () => {
    expect(shouldApply(push(C1, 2, 11), at(C1, 2, 10))).toBe(true)
  })

  it("ignores another terminal's output, since the channel is a broadcast", () => {
    expect(shouldApply(push(GLOBAL, 2, 11), at(C1, 2, 10))).toBe(false)
    expect(shouldApply(push(C2, 2, 11), at(C1, 2, 10))).toBe(false)
  })

  it('ignores a push aimed at an attachment this view has superseded', () => {
    expect(shouldApply(push(C1, 1, 11), at(C1, 2, 10))).toBe(false)
  })

  /*
   * `attach` returns the screen *and* the sequence it includes. Replaying what
   * the snapshot already drew duplicates lines — visible immediately as a
   * doubled prompt.
   */
  it('ignores output the snapshot already contains', () => {
    expect(shouldApply(push(C1, 2, 10), at(C1, 2, 10))).toBe(false)
    expect(shouldApply(push(C1, 2, 9), at(C1, 2, 10))).toBe(false)
  })

  it('applies the first push after the snapshot, with nothing skipped', () => {
    expect(shouldApply(push(C1, 2, 11), at(C1, 2, 10))).toBe(true)
  })

  /*
   * An exit has no sequence number to compare — it is not a position in the
   * output stream, it is the end of it — so it is judged on terminal and epoch
   * alone. Filtering it by seq would drop it whenever it arrived on the same
   * frame as the snapshot.
   */
  it('applies an exit regardless of position', () => {
    const exit: TerminalPush = { kind: 'exit', ref: C1, epoch: 2, code: 0 }
    expect(shouldApply(exit, at(C1, 2, 999))).toBe(true)
  })

  it('still ignores an exit for another terminal', () => {
    const exit: TerminalPush = { kind: 'exit', ref: C2, epoch: 2, code: 0 }
    expect(shouldApply(exit, at(C1, 2, 10))).toBe(false)
  })
})

describe('pendingUntilAttached', () => {
  /*
   * The reason the API says subscribe first, attach second. Output written
   * between the snapshot being taken and the listener going live has nowhere to
   * go; queuing from the moment the listener exists and filtering afterwards is
   * what closes it.
   */
  it('replays exactly what the snapshot missed', () => {
    const queued = [push(C1, 2, 9, 'old'), push(C1, 2, 10, 'edge'), push(C1, 2, 11, 'new')]
    expect(
      pendingUntilAttached(queued, at(C1, 2, 10)).map((p) => (p.kind === 'data' ? p.data : ''))
    ).toEqual(['new'])
  })

  it('drops anything queued for another terminal', () => {
    const queued = [push(GLOBAL, 2, 11, 'theirs'), push(C1, 2, 11, 'mine')]
    expect(pendingUntilAttached(queued, at(C1, 2, 10))).toHaveLength(1)
  })

  it('holds nothing back when the queue is empty', () => {
    expect(pendingUntilAttached([], at(C1, 1, 0))).toEqual([])
  })
})
