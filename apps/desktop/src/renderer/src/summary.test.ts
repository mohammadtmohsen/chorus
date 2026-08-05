import { describe, expect, it } from 'vitest'
import type { TranscriptEvent } from '../../shared/ipc.js'
import { EMPTY_SUMMARY, summariseSession, summaryPrompt } from './summary.js'

let seq = 0
const event = (
  actor: TranscriptEvent['actor'],
  type: string,
  payload: Record<string, unknown> = {}
): TranscriptEvent => {
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

describe('summariseSession', () => {
  it('says nothing happened when nothing has', () => {
    expect(summariseSession([])).toEqual(EMPTY_SUMMARY)
  })

  it('counts what each agent did, per agent', () => {
    const summary = summariseSession([
      event('user', 'user.message', { text: 'go' }),
      event('codex', 'turn.completed', { status: 'completed' }),
      event('codex', 'command.started', { itemRef: 'a', command: ['ls', '-la'] }),
      event('codex', 'command.completed', { itemRef: 'a', exitCode: 0 }),
      event('claude', 'turn.completed', { status: 'completed' }),
      event('claude', 'file.change.proposed', { itemRef: 'b', files: [{ path: 'src/x.ts' }] }),
    ])

    expect(summary.userMessages).toBe(1)
    expect(summary.agents.map((a) => a.actor)).toEqual(['claude', 'codex'])
    const codex = summary.agents.find((a) => a.actor === 'codex')
    expect(codex).toMatchObject({ turns: 1, commands: 1, commandsFailed: 0 })
    const claude = summary.agents.find((a) => a.actor === 'claude')
    expect(claude).toMatchObject({ turns: 1, filesTouched: ['src/x.ts'] })
    expect(summary.problems).toEqual([])
  })

  it('leaves the user and the system out of the per-agent list', () => {
    const summary = summariseSession([
      event('user', 'user.message', { text: 'hi' }),
      event('system', 'turn.completed', { status: 'completed' }),
    ])
    expect(summary.agents).toEqual([])
    // But the log is not empty, so there is still something to show.
    expect(summary.anything).toBe(true)
  })

  it('attributes a failed command to the agent that started it, not to the exit event', () => {
    // The exit arrives as its own event and can carry a different actor; only
    // `command.started` names the command, so the pairing has to go by itemRef.
    const summary = summariseSession([
      event('codex', 'command.started', { itemRef: 'x1', command: ['pnpm', 'test'] }),
      event('system', 'command.completed', { itemRef: 'x1', exitCode: 1 }),
    ])

    const codex = summary.agents.find((a) => a.actor === 'codex')
    expect(codex?.commandsFailed).toBe(1)
    expect(summary.problems).toHaveLength(1)
    expect(summary.problems[0]).toMatchObject({ kind: 'commandFailed', actor: 'codex' })
    expect(summary.problems[0]?.detail).toContain('pnpm test')
    expect(summary.problems[0]?.detail).toContain('exited 1')
  })

  it('does not count a clean exit as a problem', () => {
    const summary = summariseSession([
      event('codex', 'command.started', { itemRef: 'x1', command: ['ls'] }),
      event('codex', 'command.completed', { itemRef: 'x1', exitCode: 0 }),
    ])
    expect(summary.problems).toEqual([])
    expect(summary.agents[0]?.commandsFailed).toBe(0)
  })

  it('reports a denied approval, and names the rule when policy decided it', () => {
    const summary = summariseSession([
      event('codex', 'approval.decided', {
        approvalId: 'a1',
        outcome: 'deny',
        policyRuleId: 'deny-credential-files',
      }),
    ])
    expect(summary.agents[0]?.approvalsDenied).toBe(1)
    expect(summary.problems[0]?.detail).toContain('deny-credential-files')
  })

  it('treats a timed-out approval as denied, because nothing was allowed to happen', () => {
    const summary = summariseSession([
      event('claude', 'approval.decided', { approvalId: 'a2', outcome: 'timeout' }),
    ])
    expect(summary.agents[0]?.approvalsDenied).toBe(1)
    expect(summary.problems[0]?.kind).toBe('approvalDenied')
  })

  it('counts an allowed approval without calling it a problem', () => {
    const summary = summariseSession([
      event('codex', 'approval.decided', { approvalId: 'a3', outcome: 'allow', scope: 'once' }),
    ])
    expect(summary.agents[0]?.approvalsAllowed).toBe(1)
    expect(summary.problems).toEqual([])
  })

  it('does not report an interrupted turn as a failure', () => {
    // The user stopped it. Reporting their own decision back as a problem is
    // noise, and it is the distinction `transcript.ts` already draws.
    const summary = summariseSession([
      event('codex', 'turn.completed', { status: 'interrupted', userInitiated: true }),
    ])
    expect(summary.problems).toEqual([])
    expect(summary.agents[0]?.turns).toBe(1)
  })

  it('reports a failed turn', () => {
    const summary = summariseSession([event('codex', 'turn.completed', { status: 'failed' })])
    expect(summary.problems[0]?.kind).toBe('turnFailed')
  })

  it('collects errors with their message', () => {
    const summary = summariseSession([
      event('claude', 'error.raised', { message: 'the CLI went away', recoverable: false }),
    ])
    expect(summary.agents[0]?.errors).toBe(1)
    expect(summary.problems[0]).toMatchObject({ kind: 'error', detail: 'the CLI went away' })
  })

  it('dedupes files across events and sorts them', () => {
    const summary = summariseSession([
      event('codex', 'file.change.proposed', {
        itemRef: 'f1',
        files: [{ path: 'b.ts' }, { path: 'a.ts' }],
      }),
      event('codex', 'file.change.proposed', { itemRef: 'f2', files: [{ path: 'a.ts' }] }),
    ])
    expect(summary.filesTouched).toEqual(['a.ts', 'b.ts'])
    expect(summary.agents[0]?.filesTouched).toEqual(['a.ts', 'b.ts'])
  })

  it('reads usage as the latest total per agent, then sums across agents', () => {
    // Same semantics as transcript.ts, so the panel and the spend line agree.
    const summary = summariseSession([
      event('codex', 'usage.updated', { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }),
      event('codex', 'usage.updated', { inputTokens: 30, outputTokens: 9, costUsd: 0.03 }),
      event('claude', 'usage.updated', { inputTokens: 100, outputTokens: 50, costUsd: 0.2 }),
    ])
    expect(summary.spend.inputTokens).toBe(130)
    expect(summary.spend.outputTokens).toBe(59)
    expect(summary.spend.costUsd).toBeCloseTo(0.23)
  })

  it('reports no price at all when no agent priced', () => {
    const summary = summariseSession([
      event('codex', 'usage.updated', { inputTokens: 10, outputTokens: 5, costUsd: null }),
    ])
    // Not zero: a zero is a claim, and nobody made it.
    expect(summary.spend.costUsd).toBeNull()
  })

  it('ignores event types it does not know', () => {
    const summary = summariseSession([event('codex', 'something.new', { whatever: true })])
    expect(summary.agents).toEqual([])
    expect(summary.problems).toEqual([])
  })

  it('survives malformed payloads rather than throwing', () => {
    const summary = summariseSession([
      event('codex', 'command.started', { itemRef: 'z', command: 'not-an-array' }),
      event('codex', 'command.completed', { itemRef: 'z', exitCode: 'nope' }),
      event('codex', 'file.change.proposed', { files: [{ nopath: 1 }, null, 'x'] }),
      event('codex', 'usage.updated', { inputTokens: 'lots' }),
    ])
    expect(summary.agents[0]?.commands).toBe(1)
    expect(summary.agents[0]?.commandsFailed).toBe(0)
    expect(summary.filesTouched).toEqual([])
    expect(summary.spend.inputTokens).toBe(0)
  })
})

describe('summaryPrompt', () => {
  it('asks the five questions and hands over the counted facts', () => {
    const summary = summariseSession([
      event('codex', 'command.started', { itemRef: 'q', command: ['pnpm', 'lint'] }),
      event('codex', 'command.completed', { itemRef: 'q', exitCode: 2 }),
      event('codex', 'file.change.proposed', { itemRef: 'r', files: [{ path: 'src/a.ts' }] }),
    ])
    const prompt = summaryPrompt(summary)

    expect(prompt).toContain('What issues were found?')
    expect(prompt).toContain("What's still missing?")
    expect(prompt).toContain("What's next?")
    // The facts the transcript alone would not spell out.
    expect(prompt).toContain('pnpm lint')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('codex:')
  })

  it('still asks the questions when there is nothing to report', () => {
    const prompt = summaryPrompt(EMPTY_SUMMARY)
    expect(prompt).toContain('What issues were found?')
    expect(prompt).not.toContain('Problems recorded')
  })
})
