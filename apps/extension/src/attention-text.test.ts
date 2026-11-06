import { describe, expect, it } from 'vitest'
import messages from '../../desktop/src/renderer/src/i18n/en.json'
import { attentionChoices, attentionHeadline, roomDescription } from './attention-text.js'

const base = {
  conversationId: 'c',
  projectId: 'p',
  title: 'Room',
  agentId: 'claude',
  mode: 'banner',
} as const
const approval = (kind: 'command' | 'fileChange' | 'mcpToolCall') =>
  ({
    ...base,
    reason: 'approval',
    approvalId: 'a',
    kind,
    request: { command: ['ls', '-la'] },
  }) as const

describe('attention text', () => {
  it('offers the session choice only where the desktop toast does', () => {
    expect(attentionChoices(approval('command'))).toEqual([
      messages.approval.allowOnce,
      messages.approval.allowAlways,
      messages.approval.deny,
      messages.notify.open,
    ])
    expect(attentionChoices(approval('fileChange'))).not.toContain(messages.approval.allowAlways)
    expect(attentionChoices(approval('mcpToolCall'))).not.toContain(messages.approval.allowAlways)
  })

  it('offers only Open for what cannot be decided from a notification', () => {
    expect(attentionChoices({ ...base, reason: 'idle' })).toEqual([messages.notify.open])
    expect(
      attentionChoices({ ...base, reason: 'question', userInputId: 'q', request: {} })
    ).toEqual([messages.notify.open])
  })

  it('names the room, the agent and what is being asked', () => {
    const headline = attentionHeadline(approval('command'))
    expect(headline).toContain('Room')
    expect(headline).toContain('claude')
    expect(headline).toContain('ls -la')
  })

  it('describes what a room is waiting on', () => {
    const room = { conversationId: 'c', projectId: 'p', projectName: 'alpha', title: 'Room' }
    expect(roomDescription({ ...room, approvals: 1, questions: 0 })).toBe('alpha · 1 approval')
    expect(roomDescription({ ...room, approvals: 2, questions: 3 })).toBe(
      'alpha · 2 approvals · 3 questions'
    )
  })
})
