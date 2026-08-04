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

/** Anything claude did rather than said. */
function did(type: StoredEvent['type'], payload: StoredEvent['payload']): StoredEvent {
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

function ran(ref: string, command: string[]): StoredEvent {
  return did('command.started', { type: 'command.started', itemRef: ref, command, cwd: '/tmp' })
}

function exited(ref: string, exitCode: number | null): StoredEvent {
  return did('command.completed', { type: 'command.completed', itemRef: ref, exitCode })
}

function printed(ref: string, chunk: string): StoredEvent {
  return did('command.output', { type: 'command.output', itemRef: ref, stream: 'stdout', chunk })
}

const PARTICIPANTS: AgentId[] = ['codex', 'claude']

function catchup(
  events: StoredEvent[],
  overrides: Partial<Parameters<typeof composeCatchup>[0]> = {}
): string {
  return (
    composeCatchup({ recipient: 'codex', participants: PARTICIPANTS, events, ...overrides }) ?? ''
  )
}

describe('composeCatchup', () => {
  it('replays what the other agent and the user said', () => {
    const text = catchup([
      said('user', 'what mcp do we have'),
      said('claude', 'You have 6 MCP servers connected.'),
    ])

    expect(text).toContain('user: what mcp do we have')
    expect(text).toContain('claude: You have 6 MCP servers connected.')
    // The agent has to be able to tell this from the user talking to it.
    expect(text).toContain('[Chorus]')
    expect(text).toContain('shared conversation')
  })

  it('names who else is in the room', () => {
    const text = catchup([said('user', 'hi')])
    expect(text).toContain('and claude')
    expect(text).not.toContain('and codex')
  })

  it('returns null when nothing was missed', () => {
    expect(
      composeCatchup({ recipient: 'codex', participants: PARTICIPANTS, events: [] })
    ).toBeNull()
  })

  it("skips the recipient's own events", () => {
    // They are already in its own context; replaying pays twice for the words.
    const text = catchup([said('codex', 'I already said this'), said('claude', 'and I said this')])
    expect(text).not.toContain('I already said this')
    expect(text).toContain('and I said this')
  })

  it('ignores reasoning, approvals and bookkeeping', () => {
    // Private working and Chorus's own record-keeping are not the conversation.
    const events = [
      did('agent.reasoning.delta', { type: 'agent.reasoning.delta', itemRef: 'i1', text: 'hmm' }),
      did('approval.decided', {
        type: 'approval.decided',
        approvalId: 'a1',
        outcome: 'allow',
        scope: 'once',
        decidedBy: 'user',
        policyRuleId: null,
      }),
      did('usage.updated', {
        type: 'usage.updated',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: null,
      }),
    ]
    expect(composeCatchup({ recipient: 'codex', participants: PARTICIPANTS, events })).toBeNull()
  })

  it('reports a command that succeeded as one line, without its output', () => {
    const text = catchup([
      ran('c1', ['pnpm', 'test']),
      printed('c1', 'all 400 tests passed'),
      exited('c1', 0),
    ])

    expect(text).toContain('· claude ran `pnpm test` → ok')
    // Nobody asks about the output of a command that worked.
    expect(text).not.toContain('all 400 tests passed')
  })

  it('carries the tail of the output when a command failed', () => {
    // "Why did that fail" is exactly the question the other agent gets asked.
    const text = catchup([
      ran('c1', ['pnpm', 'test']),
      printed('c1', 'TypeError: cannot read property id of undefined'),
      exited('c1', 1),
    ])

    expect(text).toContain('failed (exit 1)')
    expect(text).toContain('TypeError: cannot read property id of undefined')
  })

  it('keeps only the tail of a long output', () => {
    const text = catchup([
      ran('c1', ['pnpm', 'build']),
      printed('c1', `${'noise '.repeat(2_000)}the actual failure`),
      exited('c1', 2),
    ])

    expect(text).toContain('the actual failure')
    expect(text.length).toBeLessThan(1_500)
  })

  it('says a command ran even when no result was recorded', () => {
    // Silence would read as "never ran", which is the wrong thing to believe.
    expect(catchup([ran('c1', ['pnpm', 'build'])])).toContain(
      '· claude ran `pnpm build` (no result recorded)'
    )
  })

  it('lists changed files, and counts them once the list gets long', () => {
    const files = (n: number): { path: string; patch: string }[] =>
      Array.from({ length: n }, (_, i) => ({ path: `src/f${String(i)}.ts`, patch: '' }))
    const changed = (n: number): StoredEvent =>
      did('file.change.proposed', { type: 'file.change.proposed', itemRef: 'i1', files: files(n) })

    expect(catchup([changed(2)])).toContain('· claude changed src/f0.ts, src/f1.ts')
    expect(catchup([changed(9)])).toContain('and 6 more')
  })

  it('reports an error that stuck, not a restart it recovered from', () => {
    const text = catchup([
      did('error.raised', {
        type: 'error.raised',
        message: 'agent claude exited unexpectedly; restarting',
        recoverable: true,
      }),
      did('error.raised', {
        type: 'error.raised',
        message: 'That directory does not exist: /nope',
        recoverable: false,
      }),
    ])

    expect(text).toContain('· claude hit an error: That directory does not exist: /nope')
    expect(text).not.toContain('restarting')
  })

  it('keeps everything in the order it happened', () => {
    const text = catchup([
      said('user', 'run the tests'),
      ran('c1', ['pnpm', 'test']),
      exited('c1', 0),
      said('claude', 'all green'),
    ])

    expect(text.indexOf('run the tests')).toBeLessThan(text.indexOf('pnpm test'))
    expect(text.indexOf('pnpm test')).toBeLessThan(text.indexOf('all green'))
  })

  it('sheds activity before speech when the budget binds', () => {
    // Losing "claude ran the tests" costs less than losing what claude said.
    const events = [
      said('claude', 'here is the summary that matters'),
      ...Array.from({ length: 40 }, (_, i) => [
        ran(`c${String(i)}`, ['rg', `pattern-${String(i)}`]),
        exited(`c${String(i)}`, 0),
      ]).flat(),
    ]

    const text = catchup(events, { maxTotalChars: 600 })
    expect(text).toContain('here is the summary that matters')
    expect(text).not.toContain('pattern-0`')
  })

  it('keeps the most recent lines when over budget and says what it dropped', () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      said('user', `message ${String(i)} `.repeat(20))
    )
    const text = catchup(events, { maxTotalChars: 500 })

    expect(text).toContain('message 9')
    expect(text).not.toContain('message 0:')
    expect(text).toMatch(/\(\d+ earlier entries omitted\)/)
  })

  it('trims a very long message from the middle, keeping both ends', () => {
    const text = catchup([said('claude', `START${'x'.repeat(5_000)}END`)], { maxMessageChars: 200 })

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
