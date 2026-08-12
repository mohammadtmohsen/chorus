import { describe, expect, it } from 'vitest'
import {
  applyMention,
  commandOptions,
  findCommandQuery,
  findMentionQuery,
  liveMention,
  mentionOptions,
  menuVisible,
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

/*
 * C-003, as the two pure decisions it comes apart into.
 *
 * The bug was that `onBlur` expressed "close the menu" by discarding "what is
 * being typed", and nothing re-derived it when focus came back. Reproduced at
 * the OS level — steal the window's focus with another app and give it back, and
 * the menu never returns — and the fix is that these two questions are now asked
 * separately.
 */
describe('menuVisible', () => {
  const slash = { trigger: '/', start: 0, query: '' } as const

  it('shows the menu when the box has the caret and there are rows', () => {
    expect(menuVisible(true, 50, slash, null)).toBe(true)
  })

  /*
   * The half that closes the menu. A menu floating over the transcript should
   * not outlive the box being left — this is the part `onBlur` was right about.
   */
  it('hides the menu the moment the box loses the caret', () => {
    expect(menuVisible(false, 50, slash, null)).toBe(false)
  })

  it('opens with no rows to say a lookup is still running', () => {
    expect(menuVisible(true, 0, slash, 'asking')).toBe(true)
  })

  it('stays shut with no rows and nothing in flight', () => {
    expect(menuVisible(true, 0, slash, null)).toBe(false)
  })

  it('does not show a status row to a box that is not focused', () => {
    expect(menuVisible(false, 0, slash, 'asking')).toBe(false)
  })
})

describe('liveMention', () => {
  const slash = { trigger: '/', start: 0, query: '' } as const

  it('is the mention while the draft is the text it was read from', () => {
    expect(liveMention({ query: slash, from: '/' }, '/')).toBe(slash)
  })

  it('is nothing when there is no mention', () => {
    expect(liveMention(null, '/')).toBeNull()
  })

  /*
   * The case that made the stamp necessary, and it is data loss rather than a
   * cosmetic bug.
   *
   * `quote` and `insert` write the draft from a control outside the textarea and
   * then refocus it, firing no change event on the way. Without the stamp the
   * menu would reopen against rewritten text, and choosing a row would splice at
   * an offset belonging to the old string — deleting whatever now sits there.
   */
  it('is nothing once something rewrote the draft from outside the box', () => {
    expect(liveMention({ query: slash, from: '@ali' }, '> quoted passage\n\n@ali')).toBeNull()
  })

  it('is nothing after send clears the draft', () => {
    expect(liveMention({ query: slash, from: '/re' }, '')).toBeNull()
  })
})
