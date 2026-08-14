import { describe, expect, it } from 'vitest'
import type { TranscriptEvent } from '../../../shared/ipc.js'
import { reducePulse, type SessionPulse } from './store.js'

const PULSE: SessionPulse = {
  lastSeq: 0,
  unread: 0,
  working: [],
  approvalIds: [],
  questionIds: [],
  usageByActor: {},
  tokens: 0,
  costUsd: null,
  contextByActor: {},
  tasksByActor: {},
  failed: false,
}

function event(type: string, payload: Record<string, unknown> = {}): TranscriptEvent {
  return {
    seq: 1,
    id: 'e1',
    conversationId: 'c1',
    actor: 'claude',
    type,
    payload,
    createdAt: 1,
  }
}

describe('reducePulse', () => {
  /*
   * The one real hazard in carrying context fill on the pulse.
   *
   * Nothing in the log reports it — it arrives on its own push channel — so a
   * reducer that rebuilds the pulse from an event must copy it forward. Rebuilt
   * without it, every message the agent sent would silently reset the figure to
   * empty and the sidebar would flicker back to showing nothing.
   */
  it('does not let a logged event erase pushed context fill', () => {
    const withContext: SessionPulse = { ...PULSE, contextByActor: { claude: 72 } }
    const next = reducePulse(withContext, event('agent.message.completed', { text: 'hi' }), true)
    expect(next.contextByActor).toEqual({ claude: 72 })
  })

  /* The same hazard, for the same reason: nothing in the log reports it. */
  it('does not let a logged event erase pushed background tasks', () => {
    const withTasks: SessionPulse = {
      ...PULSE,
      tasksByActor: { claude: [{ id: 't1', kind: 'shell', description: 'sleep 60' }] },
    }
    const next = reducePulse(withTasks, event('agent.message.completed', { text: 'hi' }), true)
    expect(next.tasksByActor).toEqual({
      claude: [{ id: 't1', kind: 'shell', description: 'sleep 60' }],
    })
  })

  it('still folds what the log does report', () => {
    const next = reducePulse(PULSE, event('turn.started', { turnRef: 't1' }), true)
    expect(next.working).toContain('claude')
  })

  it('counts an unread only while the conversation is off screen', () => {
    const seen = reducePulse(PULSE, event('agent.message.completed', { text: 'a' }), true)
    const unseen = reducePulse(PULSE, event('agent.message.completed', { text: 'a' }), false)
    expect(seen.unread).toBe(0)
    expect(unseen.unread).toBe(1)
  })

  /*
   * The fourth row state, and the only one folded from a payload field rather
   * than counted. A row that could not tell a failed turn from an idle session
   * would leave the worst outcome looking like the ordinary one.
   */
  it('marks a session failed when a turn ends that way', () => {
    const next = reducePulse(PULSE, event('turn.completed', { status: 'failed' }), true)
    expect(next.failed).toBe(true)
  })

  it('does not call a stopped turn a failure', () => {
    const next = reducePulse(PULSE, event('turn.completed', { status: 'interrupted' }), true)
    expect(next.failed).toBe(false)
  })

  it('clears a failure when the next turn starts', () => {
    const failed = reducePulse(PULSE, event('turn.completed', { status: 'failed' }), true)
    const next = reducePulse(failed, { ...event('turn.started'), seq: 2 }, true)
    expect(next.failed).toBe(false)
  })

  /*
   * A conversation has two agents in it, and they finish separately.
   *
   * This was an assignment — `failed = status === 'failed'` — so the *last*
   * completion in a turn decided the flag for the whole session. Codex failing
   * and Claude finishing normally a second later left a row reading idle, which
   * is the one case where the state matters most: the answer never came and
   * nothing on the rail said so. Only `turn.started` may clear it.
   */
  it('does not let one agent finishing erase another agent’s failure', () => {
    const failed = reducePulse(
      PULSE,
      { ...event('turn.completed', { status: 'failed' }), actor: 'codex' },
      true
    )
    expect(failed.failed).toBe(true)
    const alsoDone = reducePulse(
      failed,
      { ...event('turn.completed', { status: 'completed' }), actor: 'claude', seq: 2 },
      true
    )
    expect(alsoDone.failed).toBe(true)
  })

  it('does not let a stop after a failure erase it either', () => {
    const failed = reducePulse(PULSE, event('turn.completed', { status: 'failed' }), true)
    const stopped = reducePulse(
      failed,
      { ...event('turn.completed', { status: 'interrupted' }), seq: 2 },
      true
    )
    expect(stopped.failed).toBe(true)
  })
})
