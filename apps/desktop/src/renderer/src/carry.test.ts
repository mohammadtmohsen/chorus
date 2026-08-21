import { describe, expect, it } from 'vitest'
import { CARRY_BUDGET_CHARS, trimCarry, withinBudget } from './carry.js'
import { EMPTY_VIEW } from './transcript.js'
import type { TranscriptMessage } from './transcript.js'
import type { SessionCarry } from './Session.js'

/** Enough on its own to trip the budget, whichever field it is put in. */
const big = 'x'.repeat(CARRY_BUDGET_CHARS + 1)

function messageOf(over: Partial<TranscriptMessage>): TranscriptMessage {
  return {
    key: 'm1',
    eventId: 'e1',
    at: 0,
    actor: 'claude',
    kind: 'message',
    text: '',
    status: 'complete',
    ...over,
  }
}

function carryOfMessages(messages: readonly TranscriptMessage[]): SessionCarry {
  return {
    view: { ...EMPTY_VIEW, lastSeq: 42, messages },
    draft: 'half a thought',
    attached: [],
    following: true,
    scrollTop: 120,
    ideIncluded: false,
  }
}

function carryOf(chars: number): SessionCarry {
  return {
    view: {
      ...EMPTY_VIEW,
      lastSeq: 42,
      messages: [
        {
          key: 'm1',
          eventId: 'e1',
          at: 0,
          actor: 'claude',
          kind: 'message',
          text: 'x'.repeat(chars),
          status: 'complete',
        },
      ],
    },
    draft: 'half a thought',
    attached: [],
    following: true,
    scrollTop: 120,
    ideIncluded: false,
  }
}

/**
 * An open aside card rides in the carry, so looking at another session does not
 * throw away an answer part-way through being read. It must survive the drop
 * that a long transcript triggers, which is the whole point of that drop being
 * selective.
 */
describe('an open card', () => {
  const card = {
    text: 'The projection lags',
    anchor: { space: 'pane' as const, centreX: 100, top: 40, height: 18 },
    source: { eventId: 'e1', actor: 'claude', kind: 'message', status: 'complete' },
    purpose: 'explanation' as const,
    opening: Promise.resolve('aside-1'),
    language: Promise.resolve('Arabic'),
  }

  it('survives the transcript being dropped for size', () => {
    const trimmed = trimCarry({ ...carryOf(CARRY_BUDGET_CHARS + 1), card })
    expect(trimmed.view).toBe(EMPTY_VIEW)
    // The transcript comes back from the log; a fork that was mid-answer does
    // not, so this is the half that cannot be rebuilt.
    expect(trimmed.card).toBe(card)
  })

  it('is absent when no card was open, rather than null', () => {
    expect(trimCarry(carryOf(10))).not.toHaveProperty('card', null)
  })
})

describe('carry budget', () => {
  it('keeps a short transcript, so coming back is instant', () => {
    const carry = carryOf(1_000)
    expect(withinBudget(carry)).toBe(true)
    expect(trimCarry(carry)).toBe(carry)
  })

  /*
   * The measured case: unmounting released 0.1MB of a 0.9MB transcript, because
   * the view is kept to make the return instant. Past the budget that trade
   * stops being worth it.
   */
  it('drops the view of a long one', () => {
    const carry = carryOf(CARRY_BUDGET_CHARS + 1)
    expect(withinBudget(carry)).toBe(false)
    expect(trimCarry(carry).view.messages).toEqual([])
  })

  /*
   * The whole reason dropping it is safe: `Session` asks for everything after
   * `lastSeq`, so a zeroed view replays the conversation in full rather than
   * showing a truncated one.
   */
  it('zeroes lastSeq with it, so the refetch asks for everything', () => {
    expect(trimCarry(carryOf(CARRY_BUDGET_CHARS + 1)).view.lastSeq).toBe(0)
  })

  it('keeps what the event store cannot give back', () => {
    const trimmed = trimCarry(carryOf(CARRY_BUDGET_CHARS + 1))
    expect(trimmed.draft).toBe('half a thought')
    expect(trimmed.scrollTop).toBe(120)
    expect(trimmed.following).toBe(true)
  })
})

/*
 * The bug this exists to catch: `text` is the one-line summary, so a row whose
 * memory is entirely in `detail`, `patch`, `changes` or `folded` used to weigh
 * almost nothing. Each case below is a real carrier from `TranscriptMessage`,
 * and each one alone is enough to trip the budget.
 */
describe('what a row actually holds', () => {
  it('counts a notice detail — 200 KB of hook output is 200 KB of memory', () => {
    const carry = carryOfMessages([
      messageOf({ kind: 'notice', text: 'Hook ran', detail: 'y'.repeat(200_000) }),
    ])
    expect(withinBudget(carry)).toBe(false)
    expect(trimCarry(carry).view).toBe(EMPTY_VIEW)
  })

  it("counts a tool's patch", () => {
    expect(withinBudget(carryOfMessages([messageOf({ kind: 'tool', patch: big })]))).toBe(false)
  })

  it('counts the diffs under a changes card', () => {
    const carry = carryOfMessages([
      messageOf({
        kind: 'changes',
        changes: [{ path: 'src/a.ts', change: 'modified', added: 1, removed: 0, patch: big }],
      }),
    ])
    expect(withinBudget(carry)).toBe(false)
  })

  it('counts the folded run a single notice row stands for', () => {
    const carry = carryOfMessages([
      messageOf({
        kind: 'notice',
        text: 'Hooks ran',
        folded: Array.from({ length: 40 }, () => ({ text: 'hook', detail: 'z'.repeat(4_000) })),
      }),
    ])
    expect(withinBudget(carry)).toBe(false)
  })

  it("counts a reply's lifted summary", () => {
    const carry = carryOfMessages([messageOf({ summary: [big] })])
    expect(withinBudget(carry)).toBe(false)
  })

  it('still keeps an ordinary transcript, so the fuller weighing is not a hair trigger', () => {
    const carry = carryOfMessages(
      Array.from({ length: 50 }, (_, i) =>
        messageOf({ key: `m${String(i)}`, text: 'a'.repeat(400), detail: 'b'.repeat(1_000) })
      )
    )
    expect(withinBudget(carry)).toBe(true)
  })
})

/*
 * Trimming throws the whole view away, so anything the view retains has to be
 * weighed. Messages were the obvious half; these are the half a review found.
 */
describe('what the rest of the view holds', () => {
  it('counts a blocked approval, which can be the whole command being asked about', () => {
    const carry = carryOfMessages([])
    const withApproval: SessionCarry = {
      ...carry,
      view: {
        ...carry.view,
        approvals: [
          {
            approvalId: 'a1',
            agentId: 'claude',
            kind: 'bash',
            summary: 'Run a migration',
            detail: big,
            expiresAt: 0,
          },
        ],
      },
    }
    // No messages at all, and still over budget — the case that used to return
    // true and retain the view.
    expect(withApproval.view.messages).toEqual([])
    expect(withinBudget(withApproval)).toBe(false)
    expect(trimCarry(withApproval).view).toBe(EMPTY_VIEW)
  })

  it('counts a question set, options and all', () => {
    const carry = carryOfMessages([])
    const withQuestion: SessionCarry = {
      ...carry,
      view: {
        ...carry.view,
        questions: [
          {
            userInputId: 'q1',
            eventId: 'e1',
            agentId: 'claude',
            expiresAt: 0,
            questions: [
              {
                id: 'f1',
                header: 'Which',
                question: 'Pick one',
                multiSelect: false,
                allowOther: false,
                isSecret: false,
                options: [{ label: 'a', description: big }],
              },
            ],
          },
        ],
      },
    }
    expect(withinBudget(withQuestion)).toBe(false)
  })
})

/*
 * The budget's own contract, and the trap in widening it: the scan stops at the
 * budget so a long transcript does not cost a long scan. Reading every field of
 * every row would fix a memory problem by creating a CPU one — and the early
 * exit has to reach *inside* a row too, since one changes card can carry
 * hundreds of patches.
 */
describe('the scan short-circuits', () => {
  it('never reads a row past the one that settles it', () => {
    let reads = 0
    const counted = messageOf({ key: 'later' })
    Object.defineProperty(counted, 'text', {
      get: () => {
        reads++
        return ''
      },
    })

    const carry = carryOfMessages([messageOf({ detail: big }), counted])
    expect(withinBudget(carry)).toBe(false)
    expect(reads).toBe(0)
  })

  it('stops inside a row too, rather than summing every patch first', () => {
    let reads = 0
    const changes = [
      { path: 'src/a.ts', change: 'modified' as const, added: 1, removed: 0, patch: big },
      ...Array.from({ length: 500 }, (_, i) => {
        const file = {
          path: `src/b${String(i)}.ts`,
          change: 'modified' as const,
          added: 1,
          removed: 0,
        }
        Object.defineProperty(file, 'patch', {
          get: () => {
            reads++
            return ''
          },
          enumerable: true,
        })
        return file
      }),
    ]

    expect(withinBudget(carryOfMessages([messageOf({ kind: 'changes', changes })]))).toBe(false)
    expect(reads).toBe(0)
  })
})
