import { describe, expect, it } from 'vitest'
import { countsAsUnread, UNREAD_EVENT_TYPES } from './unread.js'

describe('countsAsUnread', () => {
  /*
   * This list exists to stop two sides drifting: the renderer counts these live
   * as pushes arrive, and the main process counts the same ones back out of the
   * log at launch. Two lists would mean a card that says 3 before a restart and
   * 5 after it, with nothing having happened in between.
   */
  it('counts the three things a person would say happened', () => {
    expect([...UNREAD_EVENT_TYPES]).toEqual([
      'agent.message.completed',
      'error.raised',
      'handoff.created',
    ])
  })

  it('does not count an agent working', () => {
    // Unread means "work happened you have not seen", not "bytes arrived". A
    // badge counting deltas would be a progress bar with no top.
    for (const type of [
      'agent.message.delta',
      'agent.reasoning.delta',
      'tool.started',
      'tool.progress',
      'tool.completed',
      'command.started',
      'command.output',
      'notice.raised',
      'usage.updated',
      'turn.started',
      'turn.completed',
    ]) {
      expect(countsAsUnread(type)).toBe(false)
    }
  })

  it('counts a reply, a failure and a handoff', () => {
    expect(countsAsUnread('agent.message.completed')).toBe(true)
    expect(countsAsUnread('error.raised')).toBe(true)
    expect(countsAsUnread('handoff.created')).toBe(true)
  })

  it('does not count an approval, which the badge already answers for', () => {
    // A blocked agent is urgent and has its own surface — the dock badge and the
    // waiting chip. Counting it as unread too would say the same thing twice.
    expect(countsAsUnread('approval.requested')).toBe(false)
    expect(countsAsUnread('userinput.requested')).toBe(false)
  })
})
