import { describe, expect, it } from 'vitest'
import { applyMention, findMentionQuery, mentionOptions } from './mention-menu.js'

const BOTH = ['codex', 'claude'] as const

describe('findMentionQuery', () => {
  it('finds a bare @ at the caret', () => {
    expect(findMentionQuery('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('finds a partly typed name', () => {
    expect(findMentionQuery('hey @cla', 8)).toEqual({ start: 4, query: 'cla' })
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
    expect(findMentionQuery('@claude and more', 3)).toEqual({ start: 0, query: 'cl' })
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
