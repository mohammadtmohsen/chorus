import type { StoredEvent } from '@chorus/event-store'
import type { AgentId } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { composeCatchup, withCatchup } from './catchup.js'

let seq = 0

function said(actor: string, text: string): StoredEvent {
  seq += 1
  return {
    seq,
    id: `e${String(seq)}`,
    conversationId: 'c1',
    actor: actor as StoredEvent['actor'],
    type: actor === 'user' ? 'user.message' : 'agent.message.completed',
    payload:
      actor === 'user'
        ? { type: 'user.message', text }
        : { type: 'agent.message.completed', itemRef: `i${String(seq)}`, text },
    createdAt: seq,
    schemaVersion: 1,
  }
}

function other(type: StoredEvent['type'], payload: StoredEvent['payload']): StoredEvent {
  seq += 1
  return {
    seq,
    id: `e${String(seq)}`,
    conversationId: 'c1',
    actor: 'claude',
    type,
    payload,
    createdAt: seq,
    schemaVersion: 1,
  }
}

const PARTICIPANTS: AgentId[] = ['codex', 'claude']

describe('composeCatchup', () => {
  it('replays what the other agent and the user said', () => {
    const text = composeCatchup({
      recipient: 'codex',
      participants: PARTICIPANTS,
      events: [
        said('user', 'what mcp do we have'),
        said('claude', 'You have 6 MCP servers connected.'),
      ],
    })

    expect(text).toContain('user: what mcp do we have')
    expect(text).toContain('claude: You have 6 MCP servers connected.')
    // The agent has to be able to tell this from the user talking to it.
    expect(text).toContain('[Chorus]')
    expect(text).toContain('shared conversation')
  })

  it('names who else is in the room', () => {
    const text = composeCatchup({
      recipient: 'codex',
      participants: PARTICIPANTS,
      events: [said('user', 'hi')],
    })
    expect(text).toContain('and claude')
    expect(text).not.toContain('and codex')
  })

  it('returns null when nothing was missed', () => {
    expect(
      composeCatchup({ recipient: 'codex', participants: PARTICIPANTS, events: [] })
    ).toBeNull()
  })

  it("skips the recipient's own messages", () => {
    // They are already in its own context; replaying pays twice for the words.
    const text = composeCatchup({
      recipient: 'codex',
      participants: PARTICIPANTS,
      events: [said('codex', 'I already said this'), said('claude', 'and I said this')],
    })
    expect(text).not.toContain('I already said this')
    expect(text).toContain('and I said this')
  })

  it('ignores commands, reasoning and approvals', () => {
    // Another agent's mechanics are not the conversation.
    const events = [
      other('command.started', {
        type: 'command.started',
        itemRef: 'i1',
        command: ['rg', 'secret'],
        cwd: '/tmp',
      }),
      other('agent.reasoning.delta', { type: 'agent.reasoning.delta', itemRef: 'i1', text: 'hmm' }),
      other('approval.decided', {
        type: 'approval.decided',
        approvalId: 'a1',
        outcome: 'allow',
        scope: 'once',
        decidedBy: 'user',
        policyRuleId: null,
      }),
    ]
    expect(composeCatchup({ recipient: 'codex', participants: PARTICIPANTS, events })).toBeNull()
  })

  it('keeps the most recent lines when over budget and says what it dropped', () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      said('user', `message ${String(i)} `.repeat(20))
    )
    const text =
      composeCatchup({
        recipient: 'codex',
        participants: PARTICIPANTS,
        events,
        maxTotalChars: 500,
      }) ?? ''

    expect(text).toContain('message 9')
    expect(text).not.toContain('message 0:')
    expect(text).toMatch(/\(\d+ earlier messages omitted\)/)
  })

  it('trims a very long message from the middle, keeping both ends', () => {
    const long = `START${'x'.repeat(5_000)}END`
    const text =
      composeCatchup({
        recipient: 'codex',
        participants: PARTICIPANTS,
        events: [said('claude', long)],
        maxMessageChars: 200,
      }) ?? ''

    expect(text).toContain('START')
    expect(text).toContain('END')
    expect(text).toContain('[trimmed]')
    expect(text.length).toBeLessThan(1_000)
  })
})

describe('withCatchup', () => {
  it('leaves the message alone when nothing was missed', () => {
    // The single-agent case must cost exactly nothing.
    expect(
      withCatchup({ recipient: 'codex', participants: ['codex'], events: [] }, 'run the tests')
    ).toBe('run the tests')
  })

  it('puts the live message last, marked as the one to answer', () => {
    const out = withCatchup(
      {
        recipient: 'codex',
        participants: PARTICIPANTS,
        events: [said('claude', 'I finished the refactor')],
      },
      'review it'
    )
    expect(out.indexOf('I finished the refactor')).toBeLessThan(out.indexOf('review it'))
    expect(out).toContain('The user now says to you:')
    expect(out.endsWith('review it')).toBe(true)
  })
})
