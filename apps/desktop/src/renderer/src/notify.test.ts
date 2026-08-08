import { describe, expect, it } from 'vitest'
import type { TranscriptEvent } from '../../shared/ipc.js'
import { noticesFrom, roomsWaiting, shouldRaise, trackPending } from './notify.js'

let seq = 0
function event(
  type: string,
  payload: Record<string, unknown> = {},
  conversationId = 'c1'
): TranscriptEvent {
  seq += 1
  return {
    seq,
    id: `e${String(seq)}`,
    conversationId,
    actor: 'claude',
    type,
    payload,
    createdAt: seq,
  }
}

describe('noticesFrom', () => {
  it('reports an agent that is blocked on a person', () => {
    expect(noticesFrom([event('approval.requested', { approvalId: 'a1' })])).toMatchObject([
      { conversationId: 'c1', actor: 'claude', kind: 'waiting' },
    ])
  })

  it('reports a finished turn', () => {
    expect(noticesFrom([event('turn.completed', { status: 'completed' })])).toMatchObject([
      { kind: 'done' },
    ])
  })

  it('says nothing about an interrupt, which the user caused', () => {
    // Notifying someone about the button they just pressed is the fastest way to
    // teach them that these banners are noise.
    expect(
      noticesFrom([event('turn.completed', { status: 'interrupted', userInitiated: true })])
    ).toEqual([])
  })

  it('ignores a recoverable error, which the supervisor handles', () => {
    expect(
      noticesFrom([event('error.raised', { message: 'restarting', recoverable: true })])
    ).toEqual([])
  })

  it('reports an error that stuck', () => {
    expect(
      noticesFrom([event('error.raised', { message: 'gave up', recoverable: false })])
    ).toMatchObject([{ kind: 'failed' }])
  })

  it('says nothing about the work itself', () => {
    for (const type of [
      'agent.message.delta',
      'agent.message.completed',
      'tool.started',
      'notice.raised',
      'usage.updated',
      'turn.started',
    ]) {
      expect(noticesFrom([event(type)])).toEqual([])
    }
  })

  it('collapses one moment into one notice, most urgent first', () => {
    /*
     * A finished turn arrives with the lifecycle and usage events around it, and
     * an approval can land in the same push. Three banners for one moment is how
     * people turn notifications off.
     */
    const notices = noticesFrom([
      event('turn.completed', { status: 'completed' }),
      event('approval.requested', { approvalId: 'a1' }),
      event('error.raised', { message: 'x', recoverable: false }),
    ])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ kind: 'waiting' })
  })

  it('keeps conversations apart', () => {
    const notices = noticesFrom([
      event('turn.completed', { status: 'completed' }, 'c1'),
      event('approval.requested', { approvalId: 'a1' }, 'c2'),
    ])
    expect(notices).toHaveLength(2)
  })
})

describe('shouldRaise', () => {
  const notice = { conversationId: 'c1', actor: 'claude', kind: 'done' } as const

  it('raises when Chorus is in the background', () => {
    expect(shouldRaise(notice, { windowFocused: false, visibleConversationIds: ['c1'] })).toBe(true)
  })

  it('raises for a conversation you cannot see, even when Chorus is frontmost', () => {
    // The case the feature exists for: four projects running, one on screen.
    expect(shouldRaise(notice, { windowFocused: true, visibleConversationIds: ['c2'] })).toBe(true)
  })

  it('stays quiet about the pane you are looking at', () => {
    expect(shouldRaise(notice, { windowFocused: true, visibleConversationIds: ['c1'] })).toBe(false)
  })
})

describe('trackPending', () => {
  it('holds a request until it is answered', () => {
    let pending = trackPending({}, [event('approval.requested', { approvalId: 'a1' })])
    expect(roomsWaiting(pending)).toBe(1)
    pending = trackPending(pending, [event('approval.decided', { approvalId: 'a1' })])
    expect(roomsWaiting(pending)).toBe(0)
  })

  it('tells a second question from a repeat of the first', () => {
    // Why ids rather than a counter: requests and answers arrive in separate
    // pushes, and history replay can repeat one.
    let pending = trackPending({}, [event('userinput.requested', { userInputId: 'q1' })])
    pending = trackPending(pending, [event('userinput.requested', { userInputId: 'q1' })])
    expect(pending['c1']).toHaveLength(1)

    pending = trackPending(pending, [event('userinput.requested', { userInputId: 'q2' })])
    expect(pending['c1']).toHaveLength(2)
  })

  it('counts rooms, not requests', () => {
    // The badge answers "how many rooms need me", not "how many clicks".
    const pending = trackPending({}, [
      event('approval.requested', { approvalId: 'a1' }, 'c1'),
      event('approval.requested', { approvalId: 'a2' }, 'c1'),
      event('approval.requested', { approvalId: 'a3' }, 'c2'),
    ])
    expect(roomsWaiting(pending)).toBe(2)
  })

  it('is unchanged by events that are not requests', () => {
    const pending = trackPending({}, [event('turn.completed', { status: 'completed' })])
    expect(pending).toEqual({})
  })
})
