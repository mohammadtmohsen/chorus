import { describe, expect, it } from 'vitest'
import { composeBrief, defaultIntent, summariseHandoff, type HandoffSource } from './handoff.js'

const source = (text: string, actor: HandoffSource['actor'] = 'codex'): HandoffSource => ({
  eventId: 'e1',
  actor,
  text,
})

const base = {
  from: 'codex' as const,
  to: 'claude' as const,
  cwd: '/repo',
  sources: [source('The adapter drops partial output.')],
}

describe('composeBrief', () => {
  it('names the source agent, so the receiver knows whose work it is', () => {
    // "Implement this" and "implement this analysis from Codex" produce
    // different behaviour from the receiving agent.
    const brief = composeBrief({ ...base, intent: 'implement' })
    expect(brief).toContain('receiving analysis from Codex')
    expect(brief).toContain('The adapter drops partial output.')
  })

  it('frames a review as reporting what is actually wrong', () => {
    const brief = composeBrief({ ...base, intent: 'review' })
    expect(brief).toMatch(/review it and report what is actually wrong/i)
    expect(brief).toMatch(/say so plainly if it looks right/i)
  })

  it('includes the project directory', () => {
    expect(composeBrief({ ...base, intent: 'discuss' })).toContain('Project: /repo')
  })

  it('includes the diff only when one was chosen', () => {
    const without = composeBrief({ ...base, intent: 'review' })
    expect(without).not.toContain('Current diff')

    const withDiff = composeBrief({ ...base, intent: 'review', diff: '--- a\n+++ b' })
    expect(withDiff).toContain('--- Current diff ---')
    expect(withDiff).toContain('```diff')
  })

  it('ignores an empty diff rather than emitting an empty block', () => {
    expect(composeBrief({ ...base, intent: 'review', diff: '   ' })).not.toContain('Current diff')
  })

  it('carries the user note above the quoted material', () => {
    const brief = composeBrief({ ...base, intent: 'implement', note: 'Skip the tests for now.' })
    expect(brief.indexOf('Skip the tests for now.')).toBeLessThan(brief.indexOf('--- From Codex'))
  })

  it('keeps several sources in order and attributes each', () => {
    const brief = composeBrief({
      ...base,
      intent: 'discuss',
      sources: [source('first'), source('second', 'claude'), source('third', 'user')],
    })
    expect(brief.indexOf('first')).toBeLessThan(brief.indexOf('second'))
    expect(brief).toContain('--- From Claude ---')
    expect(brief).toContain('--- From the developer ---')
  })

  it('produces no trailing whitespace', () => {
    expect(composeBrief({ ...base, intent: 'implement' })).toBe(
      composeBrief({ ...base, intent: 'implement' }).trimEnd()
    )
  })
})

describe('defaultIntent', () => {
  it('defaults to implement across agents, matching the README loop', () => {
    expect(defaultIntent('codex', 'claude')).toBe('implement')
  })

  it('degrades to discuss when handing to the same agent', () => {
    expect(defaultIntent('codex', 'codex')).toBe('discuss')
  })
})

describe('summariseHandoff', () => {
  it('reads as a sentence', () => {
    expect(
      summariseHandoff({
        from: 'claude',
        to: 'codex',
        intent: 'review',
        sourceCount: 1,
        includesDiff: true,
      })
    ).toBe('Claude → Codex, to review: 1 message and the current diff')
  })

  it('pluralises and drops the diff when absent', () => {
    expect(
      summariseHandoff({
        from: 'codex',
        to: 'claude',
        intent: 'implement',
        sourceCount: 3,
        includesDiff: false,
      })
    ).toBe('Codex → Claude, to implement: 3 messages')
  })
})
