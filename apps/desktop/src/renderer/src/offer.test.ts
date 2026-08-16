import { describe, expect, it } from 'vitest'
import { offersToAct } from './offer.js'

/**
 * Every string in this file is a real reply, or the tail of one, taken from this
 * machine's event store — 1,276 final-of-turn replies across 454 conversations.
 * None is invented, and that is the point: the first draft of this detector was
 * written from imagination and its central rule turned out to hold in 2 replies
 * out of 78.
 */

describe('offersToAct — the cases it exists for', () => {
  it('takes the commonest offer there is', () => {
    // `want me to` carries 86 of the 140 verdicts. It is not close.
    expect(offersToAct('Want me to commit and push the I-3 change?')).toBe(true)
    expect(offersToAct('Want me to start with the rebase?')).toBe(true)
    expect(offersToAct('Want me to finish it?')).toBe(true)
  })

  it('takes an offer that never asks a question', () => {
    // 119 replies carry an offer and end in a full stop. A punctuation rule
    // would have missed all of them.
    expect(offersToAct('Say the word and I’ll apply it.')).toBe(true)
    expect(offersToAct('I’d take the release first. Say the word.')).toBe(true)
  })

  it('reads the closing paragraph, not the whole reply', () => {
    const long = [
      'I can see three problems here, and I can list them if that helps.',
      'The parser is the one that matters.',
      'Want me to fix it?',
    ].join('\n\n')
    expect(offersToAct(long)).toBe(true)
  })
})

describe('offersToAct — the fork, which is what it mostly refuses', () => {
  it('refuses two next moves, because Go would choose between them', () => {
    // 59 of 199 question-enders. The dominant real shape, and the reason this
    // function refuses far more than it accepts.
    expect(
      offersToAct('Want me to run the e2e suite before starting Phase 2a, or go straight on?')
    ).toBe(false)
    expect(offersToAct('Want me to chase it now, or leave you to look at the UI first?')).toBe(
      false
    )
  })

  it('refuses a fork that ends in a full stop', () => {
    // The shape an anchored `or …?` rule missed.
    expect(
      offersToAct('Say the word and I’ll open the PR — or strip the probes first if you’d rather.')
    ).toBe(false)
  })

  it('refuses a second ask that never got its own question mark', () => {
    expect(offersToAct('Want me to commit the translate work — and should C-025 come next?')).toBe(
      false
    )
  })

  it('refuses two questions in one paragraph', () => {
    expect(offersToAct('Want me to take one — and which first? Both are small.')).toBe(false)
  })

  it('refuses a bare choice', () => {
    expect(offersToAct('Which is it — A, B, or both?')).toBe(false)
    expect(
      offersToAct('Next, per Codex’s ordering: the Node 26 issue, or history paging. Which?')
    ).toBe(false)
  })
})

describe('offersToAct — the phrases that read like offers and are not', () => {
  it('refuses an agent reporting that it is blocked', () => {
    // Both real, and both matched `I can` in the first draft.
    expect(
      offersToAct('There is nothing substantial left that I can do without one of those answers.')
    ).toBe(false)
    expect(
      offersToAct(
        'The engineering effort is the real number, and I can’t size it until D-1 through D-3 are answered.'
      )
    ).toBe(false)
  })

  it('refuses perception, which is not an offer to act', () => {
    expect(
      offersToAct(
        'That’s the last untested difference I can see between my measurements and your screen.'
      )
    ).toBe(false)
  })

  it('refuses an offer whose condition is the user', () => {
    expect(
      offersToAct(
        'If you share the project path or package.json, I can identify the exact changes needed.'
      )
    ).toBe(false)
  })

  it('refuses ordinary prose that happens to contain the words', () => {
    // `want that` and `want the` carried 11 verdicts in the first draft and were
    // wrong in essentially all of them.
    expect(offersToAct('I’d want that to be your call.')).toBe(false)
    expect(
      offersToAct(
        'The installed app is still the old build — `pnpm app:install` when you want the terminal in it.'
      )
    ).toBe(false)
  })

  it('refuses an announcement of work already begun', () => {
    // `I'll start` carried 14. A Go under it approves something in flight.
    expect(offersToAct('I’ll start by exploring the menu tree structure.')).toBe(false)
  })

  it('refuses a plan still waiting on a decision', () => {
    expect(
      offersToAct(
        'File the self-skip pattern as C-027? And the plan still needs your call on whether "no agents" binds literally.'
      )
    ).toBe(false)
  })
})

describe('offersToAct — edges', () => {
  it('says no to nothing at all', () => {
    expect(offersToAct('')).toBe(false)
    expect(offersToAct('   \n\n  ')).toBe(false)
  })

  it('says no to an ordinary report with no offer in it', () => {
    expect(offersToAct('`pnpm check` green, 1,587 tests pass.')).toBe(false)
  })
})
