import { describe, expect, it } from 'vitest'
import { describeRoute, parseMentions } from './mentions.js'

const BOTH = { participants: ['codex', 'claude'] as const }

describe('parseMentions', () => {
  it('routes to the agent named at the start', () => {
    const route = parseMentions('@codex what does this repo do?', BOTH)
    expect(route).toMatchObject({
      targets: ['codex'],
      text: 'what does this repo do?',
      explicit: true,
    })
  })

  it('strips a trailing comma or colon after the mention', () => {
    expect(parseMentions('@claude: implement it', BOTH).text).toBe('implement it')
    expect(parseMentions('@claude, implement it', BOTH).text).toBe('implement it')
  })

  it('routes to both when both are named', () => {
    const route = parseMentions('@codex @claude compare your answers', BOTH)
    expect(route.targets).toEqual(['codex', 'claude'])
    expect(route.text).toBe('compare your answers')
  })

  it('keeps a mid-sentence mention in the text', () => {
    // "ask @codex to review this" reads differently without the name, and the
    // agent needs to know who it is being asked about.
    const route = parseMentions('@claude ask @codex to review this', BOTH)
    expect(route.targets).toEqual(['claude', 'codex'])
    expect(route.text).toBe('ask @codex to review this')
  })

  it('ignores an unknown mention', () => {
    const route = parseMentions('@gemini are you there?', BOTH)
    expect(route.explicit).toBe(false)
    expect(route.text).toBe('@gemini are you there?')
  })

  it('ignores an agent that is not a participant', () => {
    const route = parseMentions('@claude hello', { participants: ['codex'] })
    expect(route.targets).toEqual(['codex'])
    expect(route.explicit).toBe(false)
  })

  it('does not treat an email address as a mention', () => {
    const route = parseMentions('mail me at hi@codex.dev', BOTH)
    expect(route.explicit).toBe(false)
    expect(route.text).toBe('mail me at hi@codex.dev')
  })

  it('deduplicates a repeated mention', () => {
    expect(parseMentions('@codex @codex hurry up', BOTH).targets).toEqual(['codex'])
  })
})

describe('routing with nobody named', () => {
  it('continues with whoever was last addressed', () => {
    // Silently switching agents would send a follow-up to one that never saw
    // what it follows.
    const route = parseMentions('and now the tests?', {
      ...BOTH,
      lastAddressed: 'claude',
    })
    expect(route.targets).toEqual(['claude'])
    expect(route.explicit).toBe(false)
  })

  it('falls back to the first participant when nobody has been addressed', () => {
    expect(parseMentions('hello', BOTH).targets).toEqual(['codex'])
  })

  it('ignores a last-addressed agent that has since left', () => {
    const route = parseMentions('still there?', {
      participants: ['claude'],
      lastAddressed: 'codex',
    })
    expect(route.targets).toEqual(['claude'])
  })

  it('routes to nobody when there are no participants', () => {
    // The caller must surface this rather than appearing to hang.
    const route = parseMentions('anyone?', { participants: [] })
    expect(route.targets).toEqual([])
    expect(describeRoute(route)).toBe('nobody')
  })
})

describe('describeRoute', () => {
  it('reads naturally for one and for several', () => {
    expect(describeRoute(parseMentions('@codex hi', BOTH))).toBe('codex')
    expect(describeRoute(parseMentions('@codex @claude hi', BOTH))).toBe('codex and claude')
  })
})
