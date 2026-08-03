import { describe, expect, it } from 'vitest'
import { requiresExplicitUserDecision, type ApprovalKind } from './approval.js'
import { isCoalescable, type AgentEventType } from './events.js'

describe('requiresExplicitUserDecision', () => {
  it('never lets a profile auto-allow an outward-facing MCP tool call', () => {
    // Inheriting the user's MCP servers means agents can post to Slack or move
    // Jira issues. Those are not recoverable with `git checkout` (plan §2.6).
    expect(requiresExplicitUserDecision('mcpToolCall')).toBe(true)
  })

  it('leaves locally recoverable kinds available to policy', () => {
    const recoverable: ApprovalKind[] = ['command', 'fileChange', 'permissionGrant']
    for (const kind of recoverable) {
      expect(requiresExplicitUserDecision(kind)).toBe(false)
    }
  })
})

describe('isCoalescable', () => {
  it('protects lifecycle and approval events from backpressure dropping', () => {
    const undroppable: AgentEventType[] = [
      'turn.started',
      'turn.completed',
      'approval.requested',
      'command.started',
      'command.completed',
      'file.change.proposed',
      'error',
    ]
    for (const type of undroppable) {
      expect(isCoalescable(type)).toBe(false)
    }
  })

  it('allows text deltas to be coalesced', () => {
    expect(isCoalescable('message.delta')).toBe(true)
    expect(isCoalescable('reasoning.delta')).toBe(true)
  })
})
