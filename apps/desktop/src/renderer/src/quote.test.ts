import { describe, expect, it } from 'vitest'
import {
  MAX_EXCERPT_CHARS,
  anchorOf,
  asQuote,
  askableSource,
  inPane,
  type SourceEntry,
  withQuote,
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

  it('reports the passage in the origin box’s own coordinates, unclamped', () => {
    // Deliberately raw. The previous version clamped here against a guess at how
    // wide the offer was, which threw away the geometry anything measuring the
    // real width would have needed.
    const at = anchorOf(rect(200, 300, 100, 20), pane)
    expect(at).toEqual({ space: 'content', centreX: 150, top: 250, height: 20 })
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

describe('anchorOf', () => {
  it('measures the passage against the box it will be placed in', () => {
    const at = anchorOf(rect(120, 400, 60, 20), rect(20, 100, 500, 900))
    expect(at).toMatchObject({ space: 'content', centreX: 130, top: 300, height: 20 })
  })

  it('does not add the scroll a second time', () => {
    /*
     * The mistake this pins, which a draft of the plan made: `.score-content`
     * moves with the scroller, so its rect has already fallen by the scroll
     * amount. Adding `scrollTop` on top would push the offer down the page by
     * however far you had scrolled.
     *
     * Scrolled 500px: the content's origin is 500px above the scrollport, and
     * the same passage keeps the same content coordinate.
     */
    const unscrolled = anchorOf(rect(0, 300, 100, 20), rect(0, 100, 500, 900))
    const scrolled = anchorOf(rect(0, -200, 100, 20), rect(0, -400, 500, 900))
    expect(scrolled?.top).toBe(unscrolled?.top)
  })

  it('has no anchor for a collapsed selection', () => {
    expect(anchorOf(rect(0, 0, 0, 0), rect(0, 0, 500, 900))).toBeNull()
  })
})

describe('inPane', () => {
  it('converts to where the passage is now, not where it is in the document', () => {
    // Content scrolled 500px up inside a pane at y=100: a passage 300px down the
    // content is 200px below the top of the scroller's own box.
    const content = anchorOf(rect(40, -200, 100, 20), rect(20, -400, 500, 900))
    expect(content).not.toBeNull()
    const at = inPane(content!, rect(20, -400, 500, 900), rect(0, 100, 520, 800))
    expect(at).toMatchObject({ space: 'pane', centreX: 90, top: -300 })
  })

  it('is the identity when the two boxes share an origin', () => {
    const content = anchorOf(rect(40, 300, 100, 20), rect(0, 0, 500, 900))
    const at = inPane(content!, rect(0, 0, 500, 900), rect(0, 0, 520, 800))
    expect(at.centreX).toBe(content?.centreX)
    expect(at.top).toBe(content?.top)
  })

  it('round-trips a passage back to the rectangle it came from', () => {
    // Both conversions together land where the browser said the passage was.
    const selection = rect(140, 620, 80, 24)
    const contentBox = rect(20, -380, 500, 1400)
    const paneBox = rect(0, 100, 520, 800)
    const at = inPane(anchorOf(selection, contentBox)!, contentBox, paneBox)
    expect(at.top).toBe(selection.top - paneBox.top)
    expect(at.centreX).toBe(selection.left + selection.width / 2 - paneBox.left)
  })
})
