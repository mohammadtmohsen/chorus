import { describe, expect, it } from 'vitest'
import {
  anchorFor,
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

describe('anchorFor', () => {
  const pane = rect(100, 50, 400, 600)

  it('centres the button on the selection, above it', () => {
    // Selection 200..300 across, so centred at 250 → 150 inside the pane, which
    // clears the two-action pill's half-width and so is not clamped.
    const at = anchorFor(rect(200, 300, 100, 20), pane)
    expect(at).toEqual({ left: 150, top: 242, placement: 'above' })
  })

  it('hangs the button from the selection, never over it', () => {
    // The bug this exists to stop: anchored by its top edge above the passage,
    // the button covers the words it is offering to quote. `placement` is what
    // tells CSS to hang it upward instead.
    const at = anchorFor(rect(200, 300, 100, 20), pane)
    expect(at?.placement).toBe('above')
    // The anchor is the selection's own top edge, less the gap — so nothing is
    // drawn between it and the text.
    expect(at?.top).toBe(300 - pane.top - 8)
  })

  it('drops below the selection when there is no room above', () => {
    // Near the top of the pane: above would be clipped by the scroller.
    const at = anchorFor(rect(200, 55, 100, 20), pane)
    expect(at).toMatchObject({ placement: 'below', top: 33 })
  })

  it('clamps to the left edge of a narrow pane', () => {
    // Half the pill (120) plus the 4px margin the clamp keeps.
    const at = anchorFor(rect(100, 300, 10, 20), pane)
    expect(at?.left).toBe(124)
  })

  it('clamps to the right edge', () => {
    const at = anchorFor(rect(480, 300, 20, 20), pane)
    expect(at?.left).toBe(276)
  })

  it('centres the offer in a pane too narrow to hold it', () => {
    // Measured at a 200px pane: clamping the left edge on screen pushed a 237px
    // offer from 5 to 243. Centred, the overflow is symmetric and the CSS
    // `max-width` makes what renders fit.
    const at = anchorFor(rect(0, 300, 10, 20), rect(0, 0, 200, 600))
    expect(at?.left).toBe(100)
  })

  it('survives a pane narrower than the button', () => {
    const at = anchorFor(rect(0, 300, 10, 20), rect(0, 0, 40, 600))
    expect(at).not.toBeNull()
    expect(Number.isFinite(at?.left)).toBe(true)
  })

  it('returns nothing for a selection with no rectangle', () => {
    expect(anchorFor(rect(0, 0, 0, 0), pane)).toBeNull()
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
