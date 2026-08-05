import { describe, expect, it } from 'vitest'
import type { TranscriptEvent } from '../../shared/ipc.js'
import { answersThinking, EMPTY_VIEW, reduceEvents, type TranscriptMessage } from './transcript.js'

let seq = 0
function event(
  type: string,
  payload: Record<string, unknown>,
  actor: TranscriptEvent['actor'] = 'codex'
): TranscriptEvent {
  seq += 1
  return {
    seq,
    id: `e${String(seq)}`,
    conversationId: 'c1',
    actor,
    type,
    payload,
    createdAt: seq,
  }
}

describe('reduceEvents', () => {
  it('stitches deltas into one growing message', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.message.delta', { itemRef: 'm1', text: 'Hel' }),
      event('agent.message.delta', { itemRef: 'm1', text: 'lo' }),
    ])
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({ text: 'Hello', status: 'streaming' })
  })

  it('lets the completed text replace the streamed fragments', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.message.delta', { itemRef: 'm1', text: 'Hel' }),
      event('agent.message.completed', { itemRef: 'm1', text: 'Hello world' }),
    ])
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({ text: 'Hello world', status: 'complete' })
  })

  it('ignores a delta that arrives after completion', () => {
    // Push and history replay can interleave; a late delta must not corrupt an
    // already-final message.
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.message.completed', { itemRef: 'm1', text: 'final' }),
      event('agent.message.delta', { itemRef: 'm1', text: ' extra' }),
    ])
    expect(view.messages[0]?.text).toBe('final')
  })

  it('deduplicates events already applied', () => {
    // The renderer receives the same events from both the live push and a
    // history replay. seq makes that a comparison rather than a guess.
    const first = reduceEvents(EMPTY_VIEW, [event('user.message', { text: 'hi' }, 'user')])
    const replayed = reduceEvents(first, first.messages.length > 0 ? [] : [])
    const again = reduceEvents(replayed, [
      { ...event('user.message', { text: 'hi' }, 'user'), seq: 1, id: 'e1' },
    ])
    expect(again.messages).toHaveLength(1)
  })

  it('tracks busy across a turn', () => {
    let view = reduceEvents(EMPTY_VIEW, [event('turn.started', { turnRef: 't1' })])
    expect(view.busy).toBe(true)
    view = reduceEvents(view, [event('turn.completed', { turnRef: 't1', status: 'completed' })])
    expect(view.busy).toBe(false)
  })

  it('says "Stopped." for a user-initiated interrupt, not an error', () => {
    // Claude reports a user stop identically to a failure on the wire (S3b);
    // the log carries userInitiated so the UI can tell the difference.
    const view = reduceEvents(EMPTY_VIEW, [
      event('turn.completed', { turnRef: 't1', status: 'interrupted', userInitiated: true }),
    ])
    expect(view.messages.at(-1)?.text).toBe('Stopped.')
  })

  it('announces an automatic decision, even though the request was pending first', () => {
    // The request is logged before policy evaluates, so an auto-decided approval
    // does briefly show as pending. Skipping the notice in that case made every
    // automatic decision invisible — a live run caught it.
    let view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a9',
        kind: 'command',
        expiresAt: 0,
        request: { command: ['rm', '-rf', './x'] },
      }),
    ])
    expect(view.approvals).toHaveLength(1)

    view = reduceEvents(view, [
      event('approval.decided', {
        approvalId: 'a9',
        outcome: 'deny',
        decidedBy: 'policy',
        policyRuleId: 'deny-recursive-delete',
      }),
    ])
    expect(view.approvals).toHaveLength(0)
    expect(view.messages.at(-1)?.text).toBe('Denied automatically · deny-recursive-delete')
  })

  it('says plainly when nobody answered in time', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.decided', { approvalId: 'a', outcome: 'timeout', decidedBy: 'system' }),
    ])
    expect(view.messages.at(-1)?.text).toBe('Denied — nobody answered in time.')
  })

  it('stays quiet when the user decided it themselves', () => {
    // They just clicked the button; narrating it back is noise.
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.decided', { approvalId: 'a', outcome: 'allow', decidedBy: 'user' }),
    ])
    expect(view.messages).toHaveLength(0)
  })

  it('surfaces and then clears an approval', () => {
    let view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a1',
        kind: 'command',
        expiresAt: 999,
        request: { command: ['git', 'status'] },
      }),
    ])
    expect(view.approvals).toHaveLength(1)
    expect(view.approvals[0]).toMatchObject({ summary: '$ git status' })

    view = reduceEvents(view, [event('approval.decided', { approvalId: 'a1', outcome: 'allow' })])
    expect(view.approvals).toHaveLength(0)
  })

  it('summarizes a file-change approval by path', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a2',
        kind: 'fileChange',
        expiresAt: 0,
        request: { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] },
      }),
    ])
    expect(view.approvals[0]?.summary).toBe('Edit src/a.ts, src/b.ts')
  })

  it('ignores event types it does not render', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('usage.updated', { inputTokens: 1, outputTokens: 2 }),
    ])
    expect(view.messages).toHaveLength(0)
    expect(view.lastSeq).toBeGreaterThan(0)
  })
})

describe('spend', () => {
  it('starts at nothing, and at no price at all', () => {
    // Zero cost would be a claim; "not reported" is the truth.
    expect(EMPTY_VIEW.spend).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: null })
  })

  it('takes the latest total from an agent rather than adding reports up', () => {
    // Both adapters report a running total, so summing every report would count
    // the same tokens again each time.
    const view = reduceEvents(EMPTY_VIEW, [
      event('usage.updated', { inputTokens: 100, outputTokens: 20 }),
      event('usage.updated', { inputTokens: 150, outputTokens: 25 }),
    ])
    expect(view.spend.inputTokens).toBe(150)
    expect(view.spend.outputTokens).toBe(25)
  })

  it('counts each agent once and adds them together', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      { ...event('usage.updated', { inputTokens: 100, outputTokens: 10 }), actor: 'codex' },
      { ...event('usage.updated', { inputTokens: 40, outputTokens: 4 }), actor: 'claude' },
      { ...event('usage.updated', { inputTokens: 120, outputTokens: 12 }), actor: 'codex' },
    ])
    expect(view.spend.inputTokens).toBe(160)
    expect(view.spend.outputTokens).toBe(16)
  })

  it('prices only from agents that reported one', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      {
        ...event('usage.updated', { inputTokens: 1, outputTokens: 1, costUsd: 0.02 }),
        actor: 'claude',
      },
      { ...event('usage.updated', { inputTokens: 1, outputTokens: 1 }), actor: 'codex' },
    ])
    expect(view.spend.costUsd).toBeCloseTo(0.02)
  })

  it('leaves cost unreported when no agent priced anything', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('usage.updated', { inputTokens: 9, outputTokens: 9 }),
    ])
    expect(view.spend.costUsd).toBeNull()
    expect(view.spend.inputTokens).toBe(9)
  })
})

describe('thinking, combined', () => {
  it('joins a run of reasoning items into one block', () => {
    // The provider's item boundaries are how it streams, not something the
    // reader asked to see: three items used to mean three dots and three
    // toggles.
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.reasoning.delta', { itemRef: 'r1', text: 'first ' }),
      event('agent.reasoning.delta', { itemRef: 'r2', text: 'second ' }),
      event('agent.reasoning.delta', { itemRef: 'r3', text: 'third' }),
    ])
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({
      kind: 'reasoning',
      text: 'first second third',
    })
  })

  it('keeps thinking either side of a reply as two blocks', () => {
    // Joining these would misrepresent the order the agent worked in.
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.reasoning.delta', { itemRef: 'r1', text: 'before' }),
      event('agent.message.delta', { itemRef: 'm1', text: 'partial answer' }),
      event('agent.reasoning.delta', { itemRef: 'r2', text: 'after' }),
    ])
    expect(view.messages.map((m) => m.kind)).toEqual(['reasoning', 'message', 'reasoning'])
    expect(view.messages[0]?.text).toBe('before')
    expect(view.messages[2]?.text).toBe('after')
  })

  it('does not join two agents thinking in the same room', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.reasoning.delta', { itemRef: 'r1', text: 'codex thinks' }, 'codex'),
      event('agent.reasoning.delta', { itemRef: 'r2', text: 'claude thinks' }, 'claude'),
    ])
    expect(view.messages).toHaveLength(2)
    expect(view.messages.map((m) => m.actor)).toEqual(['codex', 'claude'])
  })

  it('survives a replay without doubling the block', () => {
    const events = [
      event('agent.reasoning.delta', { itemRef: 'r1', text: 'a' }),
      event('agent.reasoning.delta', { itemRef: 'r2', text: 'b' }),
    ]
    const once = reduceEvents(EMPTY_VIEW, events)
    const twice = reduceEvents(once, events)
    expect(twice.messages).toHaveLength(1)
    expect(twice.messages[0]?.text).toBe('ab')
  })
})

describe('answersThinking', () => {
  const reasoning = { kind: 'reasoning', actor: 'codex' } as const
  const reply = { kind: 'message', actor: 'codex' } as const

  const message = (m: { kind: string; actor: string }): TranscriptMessage =>
    ({ key: 'k', eventId: 'e', text: 't', status: 'complete', ...m }) as TranscriptMessage

  it('marks a reply that follows the same agent thinking', () => {
    expect(answersThinking(message(reasoning), message(reply))).toBe(true)
  })

  it('marks nothing when no thinking arrived', () => {
    // Every turn both CLIs currently produce. Marking every message would mark
    // nothing, so this is the right answer rather than a degraded one.
    expect(answersThinking(undefined, message(reply))).toBe(false)
    expect(answersThinking(message({ kind: 'message', actor: 'user' }), message(reply))).toBe(false)
  })

  it('does not credit one agent with another agent thinking', () => {
    expect(answersThinking(message({ kind: 'reasoning', actor: 'claude' }), message(reply))).toBe(
      false
    )
  })

  it('never marks the user or the system', () => {
    expect(answersThinking(message(reasoning), message({ kind: 'message', actor: 'user' }))).toBe(
      false
    )
    expect(answersThinking(message(reasoning), message({ kind: 'message', actor: 'system' }))).toBe(
      false
    )
  })

  it('only marks a message, not a command or a notice', () => {
    for (const kind of ['command', 'notice', 'handoff', 'reasoning']) {
      expect(answersThinking(message(reasoning), message({ kind, actor: 'codex' }))).toBe(false)
    }
  })
})
