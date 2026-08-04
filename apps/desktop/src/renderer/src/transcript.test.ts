import { describe, expect, it } from 'vitest'
import type { TranscriptEvent } from '../../shared/ipc.js'
import { EMPTY_VIEW, reduceEvents } from './transcript.js'

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
