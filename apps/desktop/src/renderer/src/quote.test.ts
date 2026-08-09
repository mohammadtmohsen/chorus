import { describe, expect, it } from 'vitest'
import {
  anchorOf,
  asQuote,
  askableSource,
  MAX_EXCERPT_CHARS,
  withQuote,
  type SourceEntry,
} from './quote.js'

/** A completed Claude message — the one shape an aside may be asked about. */
const said = (over: Partial<SourceEntry> = {}): SourceEntry => ({
  eventId: 'e1',
  actor: 'claude',
  kind: 'message',
  status: 'complete',
  ...over,
})

const rect = (x: number, y: number, w: number, h: number): DOMRect => ({
  x,
  y,
  width: w,
  height: h,
  left: x,
  top: y,
  right: x + w,
  bottom: y + h,
  toJSON: () => ({}),
})

describe('asQuote', () => {
  it('prefixes a single line', () => {
    expect(asQuote('the parent is wrong')).toBe('> the parent is wrong')
  })

  it('prefixes every line of a passage', () => {
    expect(asQuote('one\ntwo\nthree')).toBe('> one\n> two\n> three')
  })

  it('keeps a blank line inside the passage, without a trailing space', () => {
    // A trailing space is invisible in a transcript and survives into context.
    expect(asQuote('one\n\ntwo')).toBe('> one\n>\n> two')
  })

  it('trims the selection but not the shape inside it', () => {
    expect(asQuote('  \n  one\n    indented\n  \n')).toBe('> one\n>     indented')
  })

  it('normalises CRLF', () => {
    expect(asQuote('one\r\ntwo')).toBe('> one\n> two')
  })

  it('is empty for an empty or blank selection', () => {
    expect(asQuote('')).toBe('')
    expect(asQuote('   \n  \n ')).toBe('')
  })
})

describe('withQuote', () => {
  it('starts a draft with the quote and leaves the caret below it', () => {
    expect(withQuote('', 'the parent is wrong')).toBe('> the parent is wrong\n\n')
  })

  it('appends below what is already typed, separated by a blank line', () => {
    expect(withQuote('why is', 'the parent is wrong')).toBe('why is\n\n> the parent is wrong\n\n')
  })

  it('does not pile up whitespace when the draft ends in some', () => {
    expect(withQuote('why is   \n\n', 'x')).toBe('why is\n\n> x\n\n')
  })

  it('leaves the draft untouched when the selection is blank', () => {
    expect(withQuote('why is', '   ')).toBe('why is')
    expect(withQuote('', '')).toBe('')
  })

  it('quotes a multi-line selection as one block', () => {
    expect(withQuote('', 'one\ntwo')).toBe('> one\n> two\n\n')
  })
})

describe('anchorOf', () => {
  const pane = rect(100, 50, 400, 600)

  it('reports the passage in the pane’s own coordinates, unclamped', () => {
    // Deliberately raw. The previous version clamped here against a guess at how
    // wide the offer was, which threw away the geometry anything measuring the
    // real width would have needed.
    const at = anchorOf(rect(200, 300, 100, 20), pane)
    expect(at).toEqual({ centreX: 150, top: 250, height: 20 })
  })

  it('keeps a centre outside the pane rather than pulling it in', () => {
    const at = anchorOf(rect(480, 300, 20, 20), pane)
    expect(at?.centreX).toBe(390)
  })

  it('carries the passage’s height, so anything below it can clear it', () => {
    expect(anchorOf(rect(200, 300, 100, 44), pane)?.height).toBe(44)
  })

  it('returns nothing for a selection with no rectangle', () => {
    expect(anchorOf(rect(0, 0, 0, 0), pane)).toBeNull()
  })
})

describe('askableSource', () => {
  it('offers an aside on one completed agent message', () => {
    expect(askableSource(said(), said(), 'the projection lags')).toEqual(said())
  })

  it('offers one on codex too', () => {
    const from = said({ actor: 'codex' })
    expect(askableSource(from, from, 'why that order')).toEqual(from)
  })

  it('refuses a range crossing two entries', () => {
    // The reason is routing: two entries have two authors, and an aside goes to
    // the author of the passage.
    expect(askableSource(said({ eventId: 'e1' }), said({ eventId: 'e2' }), 'across')).toBeNull()
  })

  it('refuses a reply that is still streaming', () => {
    // Not cosmetic: a fork inherits the session only as far as the last
    // completed turn, so it cannot see a reply that is still arriving.
    expect(
      askableSource(said({ status: 'streaming' }), said({ status: 'streaming' }), 'mid')
    ).toBeNull()
  })

  it.each(['user', 'system'])('refuses %s rows', (actor) => {
    const from = said({ actor })
    expect(askableSource(from, from, 'said')).toBeNull()
  })

  it.each(['reasoning', 'command', 'notice', 'handoff', 'tool'])('refuses %s rows', (kind) => {
    const from = said({ kind })
    expect(askableSource(from, from, 'said')).toBeNull()
  })

  it('refuses a selection outside any entry', () => {
    expect(askableSource(null, null, 'chrome')).toBeNull()
    expect(askableSource(said(), null, 'half in')).toBeNull()
  })

  it('refuses an entry carrying no event id', () => {
    const from = said({ eventId: '' })
    expect(askableSource(from, from, 'anonymous')).toBeNull()
  })

  it('refuses whitespace, which would ask about nothing', () => {
    expect(askableSource(said(), said(), '   \n  ')).toBeNull()
  })

  it('refuses an excerpt past the limit rather than truncating it', () => {
    // Half a passage asks a different question than the one that was selected.
    const tooLong = 'x'.repeat(MAX_EXCERPT_CHARS + 1)
    expect(askableSource(said(), said(), tooLong)).toBeNull()
    expect(askableSource(said(), said(), 'x'.repeat(MAX_EXCERPT_CHARS))).toEqual(said())
  })

  it('measures the limit after trimming', () => {
    const padded = `  ${'x'.repeat(MAX_EXCERPT_CHARS)}  `
    expect(askableSource(said(), said(), padded)).toEqual(said())
  })
})
