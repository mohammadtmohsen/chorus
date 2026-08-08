import { describe, expect, it } from 'vitest'
import {
  applyMention,
  commandOptions,
  findCommandQuery,
  findMentionQuery,
  mentionOptions,
} from './mention-menu.js'

describe('findCommandQuery', () => {
  it('opens on a slash that leads the message', () => {
    expect(findCommandQuery('/pr', 3)).toMatchObject({ trigger: '/', start: 0, query: 'pr' })
  })

  it('opens with nothing typed yet', () => {
    expect(findCommandQuery('/', 1)).toMatchObject({ query: '' })
  })

  it('does not open inside a path, which is what a slash usually is', () => {
    // The reason this rule differs from `@`: at word-start, every `src/foo` and
    // every `and/or` would open a menu.
    expect(findCommandQuery('look at src/foo', 15)).toBeNull()
    expect(findCommandQuery('read and/or write', 17)).toBeNull()
  })

  it('tolerates a leading space, which is still someone starting a command', () => {
    expect(findCommandQuery('  /compact', 10)).toMatchObject({ start: 2, query: 'compact' })
  })

  it('closes once the name ends', () => {
    expect(findCommandQuery('/pr-review the diff', 19)).toBeNull()
  })

  it('accepts the characters command names actually use', () => {
    // A plugin's command arrives as `frontend-design:frontend-design`.
    expect(findCommandQuery('/frontend-design:front', 22)).toMatchObject({
      query: 'frontend-design:front',
    })
  })
})

describe('commandOptions', () => {
  const commands = [
    { name: 'pr-review', description: 'Review a PR', argumentHint: '' },
    { name: 'code-review', description: 'Review the diff', argumentHint: '[<pr#>]' },
    { name: 'compact', description: 'Compact the context', argumentHint: '' },
  ]

  it('matches anywhere in the name, not only at the start', () => {
    // Half these names are compound; finding `code-review` by typing `review`
    // is the difference between a menu and a list you scroll.
    expect(commandOptions(commands, 'review').map((o) => o.label)).toEqual([
      'pr-review',
      'code-review',
    ])
  })

  it('offers everything when nothing is typed', () => {
    expect(commandOptions(commands, '')).toHaveLength(3)
  })

  it('shows the argument hint when there is one, and the description otherwise', () => {
    const [prReview, codeReview] = commandOptions(commands, 'review')
    expect(prReview?.detail).toBe('Review a PR')
    expect(codeReview?.detail).toBe('[<pr#>]')
  })

  it('addresses nobody, so no voice dots are drawn', () => {
    expect(commandOptions(commands, 'compact')[0]?.agents).toEqual([])
  })
})

const BOTH = ['codex', 'claude'] as const

describe('findMentionQuery', () => {
  it('finds a bare @ at the caret', () => {
    expect(findMentionQuery('@', 1)).toEqual({ trigger: '@', start: 0, query: '' })
  })

  it('finds a partly typed name', () => {
    expect(findMentionQuery('hey @cla', 8)).toEqual({ trigger: '@', start: 4, query: 'cla' })
  })

  it('lowercases the query so matching is not case sensitive', () => {
    expect(findMentionQuery('@CLA', 4)?.query).toBe('cla')
  })

  it('ignores an @ inside a word', () => {
    // An email address is an address, not an attempt to talk to Codex. Same
    // rule the router uses, so the menu cannot suggest what routing would drop.
    expect(findMentionQuery('mail me at me@codex', 19)).toBeNull()
  })

  it('closes once the word ends', () => {
    expect(findMentionQuery('@codex hello', 12)).toBeNull()
  })

  it('reads from the caret, not the end of the text', () => {
    // The caret sits after "@cl"; "audex" after it is not part of the query.
    expect(findMentionQuery('@claude and more', 3)).toEqual({ trigger: '@', start: 0, query: 'cl' })
  })

  it('returns null with no @ at all', () => {
    expect(findMentionQuery('just a message', 14)).toBeNull()
  })
})

describe('mentionOptions', () => {
  it('offers every participant on a bare @', () => {
    expect(mentionOptions(BOTH, '').map((o) => o.label)).toEqual(['codex', 'claude', 'both'])
  })

  it('filters by what has been typed', () => {
    expect(mentionOptions(BOTH, 'cl').map((o) => o.label)).toEqual(['claude'])
  })

  it('offers nothing when nothing matches', () => {
    expect(mentionOptions(BOTH, 'zz')).toEqual([])
  })

  it('has no "both" with a single agent', () => {
    expect(mentionOptions(['codex'], '').map((o) => o.label)).toEqual(['codex'])
  })

  it('puts "both" last, and inserts every name', () => {
    // A first entry that costs two agents a turn gets picked by accident.
    const both = mentionOptions(BOTH, '').at(-1)
    expect(both?.label).toBe('both')
    expect(both?.insert).toBe('codex @claude')
  })
})

describe('applyMention', () => {
  it('replaces the typed fragment and leaves a trailing space', () => {
    const mention = findMentionQuery('@cla', 4)
    const option = mentionOptions(BOTH, 'cla')[0]
    expect(applyMention('@cla', mention!, 4, option!)).toEqual({
      text: '@claude ',
      caret: 8,
    })
  })

  it('keeps whatever follows the caret', () => {
    const text = 'ask @co about the tests'
    const mention = findMentionQuery(text, 7)
    const option = mentionOptions(BOTH, 'co')[0]
    expect(applyMention(text, mention!, 7, option!)).toEqual({
      text: 'ask @codex  about the tests',
      caret: 11,
    })
  })

  it('expands "both" into one mention each', () => {
    const mention = findMentionQuery('@b', 2)
    const both = mentionOptions(BOTH, 'b')[0]
    expect(applyMention('@b', mention!, 2, both!).text).toBe('@codex @claude ')
  })
})
