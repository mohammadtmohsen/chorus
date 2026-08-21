import { describe, expect, it } from 'vitest'
import { ChorusEventPayload } from '@chorus/event-store'
import { EMPTY_VIEW, reduceEvents } from '../renderer/src/transcript.js'
import { TRANSCRIPT_DISPOSITION, TRANSCRIPT_TYPES } from './transcript-events.js'
import type { TranscriptEvent } from './ipc.js'

/**
 * The map's whole job is to be complete. TypeScript enforces that at compile
 * time — `Record<ChorusEventType, …>` will not build with a type missing — but
 * a compile-time guarantee is invisible in a test run, and this is the file
 * somebody will edit while adding an event type.
 */
describe('the transcript disposition map', () => {
  const stored = ChorusEventPayload.options.map((option) => option.shape.type.value as string)

  it('classifies every stored event type, with none left over', () => {
    expect([...Object.keys(TRANSCRIPT_DISPOSITION)].sort()).toEqual([...stored].sort())
  })

  it('excludes the types the reducer has no case for', () => {
    // The measured 30.6%: read, parsed, validated twice, cloned, discarded.
    for (const type of ['command.output', 'command.completed', 'diff.updated']) {
      expect(TRANSCRIPT_DISPOSITION[type as keyof typeof TRANSCRIPT_DISPOSITION]).toBe('ignore')
    }
  })

  it('keeps the ones a transcript is made of', () => {
    for (const type of ['user.message', 'agent.message.completed', 'notice.raised']) {
      expect(TRANSCRIPT_TYPES).toContain(type)
    }
  })

  /*
   * The guard the type system does NOT give, and a review caught the gap twice.
   *
   * `Record<ChorusEventType, …>` forces a *new* event type to be classified. It
   * says nothing about the other direction: adding a reducer case for a type
   * already marked `ignore` compiles cleanly, works through the live push —
   * which still carries every type — and then vanishes on replay, because the
   * read never asks for it. The bug would be a row that exists until you reopen
   * the conversation.
   *
   * The first version of this test fed each ignored type an **empty payload**,
   * which proves nothing: a future case reading real fields could return early
   * and leave it green. So `reduceEvents` now consults the map directly, and
   * this asserts that enforcement — with a payload rich enough to render, and a
   * control that proves it renders under a type marked `render`.
   */
  const RICH = {
    text: 'a line of output',
    detail: 'a body behind the line',
    command: 'pnpm check',
    exitCode: 1,
    source: 'hook',
    level: 'warn',
    path: 'src/a.ts',
    files: [{ path: 'src/a.ts', change: 'modified', added: 1, removed: 0 }],
  }

  const eventOf = (type: string, seq: number): TranscriptEvent => ({
    seq,
    id: `e-${type}`,
    conversationId: 'c1',
    actor: 'claude',
    type,
    payload: RICH,
    createdAt: 1_000,
  })

  it('proves each ignored type leaves the reduced view untouched', () => {
    const ignored = Object.entries(TRANSCRIPT_DISPOSITION)
      .filter(([, disposition]) => disposition === 'ignore')
      .map(([type]) => type)
    expect(ignored.length).toBeGreaterThan(0)

    for (const type of ignored) {
      // `lastSeq` is the one field that must move — that is the whole point of
      // `throughSeq`, which advances past exactly these events.
      // `firstSeq` moves too: an ignored event is still an event the view has
      // seen, and leaving the lower boundary behind it would make a paged read
      // ask for the same range again.
      expect(reduceEvents(EMPTY_VIEW, [eventOf(type, 7)])).toEqual({
        ...EMPTY_VIEW,
        lastSeq: 7,
        firstSeq: 7,
      })
    }
  })

  it('and the payload used to prove it is one that really does render', () => {
    /*
     * The control. Without it the test above passes for the wrong reason — a
     * payload no case would touch anyway — which is the same shape of mistake as
     * counting panes to prove a shortcut was ignored (C-027).
     */
    const rendered = reduceEvents(EMPTY_VIEW, [eventOf('notice.raised', 7)])
    expect(rendered.messages.length).toBeGreaterThan(0)
    expect(rendered.lastSeq).toBe(7)
  })

  it('derives the SQL list from the map rather than repeating it', () => {
    const rendered = Object.entries(TRANSCRIPT_DISPOSITION)
      .filter(([, d]) => d === 'render')
      .map(([t]) => t)
    expect([...TRANSCRIPT_TYPES].sort()).toEqual(rendered.sort())
    // And it is a real narrowing, not a list that happens to contain everything.
    expect(TRANSCRIPT_TYPES.length).toBeLessThan(stored.length)
  })
})
