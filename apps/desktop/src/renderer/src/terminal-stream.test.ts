import { describe, expect, it } from 'vitest'
import type { TerminalPush, TerminalRefShape } from '../../shared/ipc.js'
import {
  pendingUntilAttached,
  sameTerminal,
  shouldApply,
  type Attachment,
} from './terminal-stream.js'

const GLOBAL: TerminalRefShape = { scope: 'global', id: 't1' }
const C1: TerminalRefShape = { scope: 'session', conversationId: 'c1', id: 't1' }
const C2: TerminalRefShape = { scope: 'session', conversationId: 'c2', id: 't1' }

/** C1's sibling: same conversation, different shell. Only `id` separates them. */
const C1B: TerminalRefShape = { scope: 'session', conversationId: 'c1', id: 't2' }
/** The global panel's second shell. */
const GLOBAL_B: TerminalRefShape = { scope: 'global', id: 't2' }

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

  /*
   * The case that arrives with several terminals per panel, and the one a
   * conversation-only comparison gets wrong.
   *
   * Two tabs in the same session differ by `id` and nothing else. The output
   * channel is a broadcast, so a comparison that stopped at `conversationId`
   * would print terminal 2's output into terminal 1's screen and mark terminal 1
   * dead when terminal 2 exited.
   */
  it('tells two terminals in the same conversation apart', () => {
    expect(sameTerminal(C1, C1B)).toBe(false)
    expect(sameTerminal(C1B, C1)).toBe(false)
    expect(sameTerminal(C1B, C1B)).toBe(true)
  })

  it('tells two global terminals apart', () => {
    expect(sameTerminal(GLOBAL, GLOBAL_B)).toBe(false)
    expect(sameTerminal(GLOBAL_B, GLOBAL_B)).toBe(true)
  })

  /*
   * The mirror-image mistake, and the reason `id` is *added* to the tuple rather
   * than substituted for it.
   *
   * Ids are minted by the renderer, typed as a bare string at the IPC boundary,
   * and persisted in a file a person can edit — so the same id in two different
   * conversations is reachable, and during Phase 1 it is not merely reachable
   * but *guaranteed*: every session's terminal is minted as `'primary'`.
   * Comparing on `id` alone would have made every session share one terminal.
   */
  it('does not merge two conversations that mint the same id', () => {
    expect(sameTerminal(C1, C2)).toBe(false)
    expect(sameTerminal(C1, { scope: 'global', id: 't1' })).toBe(false)
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

  /*
   * The sibling case, at the level that actually decides what gets drawn.
   *
   * `sameTerminal` being right is necessary and not sufficient — this is the
   * function `TerminalView` calls, and the bug it prevents is visible: a `pnpm
   * build` scrolling past inside the tab you opened to run `git status`.
   */
  it("ignores a sibling tab's output in the same conversation", () => {
    expect(shouldApply(push(C1B, 2, 11), at(C1, 2, 10))).toBe(false)
  })

  /*
   * And the exit, separately, because it takes a different route through
   * `shouldApply` — it returns before the sequence check, so a terminal filter
   * that let a sibling through would mark the wrong tab dead with no other
   * symptom.
   */
  it("ignores a sibling tab's exit in the same conversation", () => {
    const exit: TerminalPush = { kind: 'exit', ref: C1B, epoch: 2, code: 1 }
    expect(shouldApply(exit, at(C1, 2, 10))).toBe(false)
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
