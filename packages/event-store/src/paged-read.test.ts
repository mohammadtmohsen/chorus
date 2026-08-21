import { describe, expect, it } from 'vitest'
import { EventStore } from './store.js'
import { openSqlite } from './sqlite.js'

/**
 * The paged read, and the state a page cannot contain.
 *
 * A page is a *suffix* of the log, so anything derived by accumulation — an
 * approval requested long before the page, a question still waiting, what has
 * been spent — has to come from somewhere else or it is silently lost. These are
 * the cases that decide whether "somewhere else" works.
 */
function store() {
  return EventStore.open(openSqlite({ path: ':memory:' })).store
}

const conversationId = 'c1'

function say(s: ReturnType<typeof store>, n: number) {
  for (let i = 0; i < n; i++) {
    s.append({
      conversationId,
      actor: 'claude',
      payload: { type: 'user.message', text: `line ${String(i)}` },
    })
  }
}

describe('readPage', () => {
  it('returns the newest events, oldest first', () => {
    const s = store()
    say(s, 50)
    const page = s.readPage(conversationId, { limit: 10 })
    expect(page).toHaveLength(10)
    // Oldest first inside the page, so the reducer folds it in log order.
    expect(page[0]!.seq).toBeLessThan(page[9]!.seq)
    // And it is the *newest* ten, not the first ten.
    expect(page[9]!.seq).toBe(50)
  })

  it('walks backwards with beforeSeq, without overlapping', () => {
    const s = store()
    say(s, 50)
    const last = s.readPage(conversationId, { limit: 10 })
    const earlier = s.readPage(conversationId, { limit: 10, beforeSeq: last[0]!.seq })
    expect(earlier).toHaveLength(10)
    expect(earlier[9]!.seq).toBe(last[0]!.seq - 1)
  })

  it('runs out at the beginning rather than repeating', () => {
    const s = store()
    say(s, 5)
    const page = s.readPage(conversationId, { limit: 10, beforeSeq: 2 })
    expect(page.map((e) => e.seq)).toEqual([1])
    expect(s.readPage(conversationId, { limit: 10, beforeSeq: 1 })).toEqual([])
  })

  it('narrows to the types asked for, so a page is a page of rows', () => {
    const s = store()
    say(s, 5)
    s.append({
      conversationId,
      actor: 'claude',
      payload: { type: 'command.output', itemRef: 'x', chunk: 'noise', stream: 'stdout' },
    })
    const page = s.readPage(conversationId, { limit: 10, types: ['user.message'] })
    expect(page.every((e) => e.type === 'user.message')).toBe(true)
  })
})

/*
 * The plan's oldest open question. A checkpoint shipped with the page would be a
 * snapshot of derived state — a second source of truth for something the log
 * already determines — so this comes from projections and indexed queries.
 */
describe('transcriptState', () => {
  it('finds an approval requested long before the page', () => {
    const s = store()
    s.append({
      conversationId,
      actor: 'claude',
      payload: {
        type: 'approval.requested',
        approvalId: 'a1',
        kind: 'command',
        request: { command: 'ls -la' },
        expiresAt: 9_999,
      },
    })
    say(s, 500)

    // Nothing in the last page mentions it, and it is still blocking.
    const page = s.readPage(conversationId, { limit: 10 })
    expect(page.some((e) => e.type === 'approval.requested')).toBe(false)
    expect(s.transcriptState(conversationId).approvals.map((a) => a.approvalId)).toEqual(['a1'])
  })

  it('forgets an approval once it is decided', () => {
    const s = store()
    s.append({
      conversationId,
      actor: 'claude',
      payload: {
        type: 'approval.requested',
        approvalId: 'a1',
        kind: 'command',
        request: {},
        expiresAt: 9_999,
      },
    })
    s.append({
      conversationId,
      actor: 'user',
      payload: {
        type: 'approval.decided',
        approvalId: 'a1',
        outcome: 'allow',
        scope: 'once',
        decidedBy: 'user',
        policyRuleId: null,
      },
    })
    expect(s.transcriptState(conversationId).approvals).toEqual([])
  })

  it('finds a question still waiting, which used to have no table at all', () => {
    const s = store()
    s.append({
      conversationId,
      actor: 'codex',
      payload: {
        type: 'userinput.requested',
        userInputId: 'q1',
        request: { questions: [] },
        expiresAt: 9_999,
      },
    })
    say(s, 500)
    const state = s.transcriptState(conversationId)
    expect(state.questions.map((q) => q.userInputId)).toEqual(['q1'])
    // The event id is carried because an aside has to name one.
    expect(state.questions[0]!.eventId).toBeTruthy()
  })

  it('forgets a question once it is answered', () => {
    const s = store()
    s.append({
      conversationId,
      actor: 'codex',
      payload: {
        type: 'userinput.requested',
        userInputId: 'q1',
        request: {},
        expiresAt: 9_999,
      },
    })
    s.append({
      conversationId,
      actor: 'user',
      payload: {
        type: 'userinput.answered',
        userInputId: 'q1',
        outcome: 'answered',
        answers: [],
        answeredBy: 'user',
      },
    })
    expect(s.transcriptState(conversationId).questions).toEqual([])
  })

  it('knows which agents are mid-turn, from the last boundary rather than a fold', () => {
    const s = store()
    s.append({ conversationId, actor: 'claude', payload: { type: 'turn.started', turnRef: 't1' } })
    s.append({ conversationId, actor: 'codex', payload: { type: 'turn.started', turnRef: 't1' } })
    s.append({
      conversationId,
      actor: 'codex',
      // `userInitiated` has a Zod default, which makes it optional on the way IN
      // and required on the inferred output type — the same trap `.default(0)`
      // sprang on `detailOmittedBytes` in Phase 1.
      payload: { type: 'turn.completed', turnRef: 't1', status: 'completed', userInitiated: false },
    })
    expect(s.transcriptState(conversationId).working).toEqual(['claude'])
  })

  it('takes the latest usage per agent, because the payload is a total', () => {
    const s = store()
    s.append({
      conversationId,
      actor: 'claude',
      payload: { type: 'usage.updated', inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
    })
    s.append({
      conversationId,
      actor: 'claude',
      payload: { type: 'usage.updated', inputTokens: 90, outputTokens: 40, costUsd: 0.9 },
    })
    // Not 100/45: totals, not deltas, so the newest one is the answer.
    expect(s.transcriptState(conversationId).usageByActor['claude']).toEqual({
      inputTokens: 90,
      outputTokens: 40,
      costUsd: 0.9,
    })
  })
})
