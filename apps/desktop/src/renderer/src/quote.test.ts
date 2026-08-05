import { describe, expect, it } from 'vitest'
import { anchorFor, asQuote, withQuote } from './quote.js'

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
    // Selection 200..300 across, so centred at 250 → 150 inside the pane.
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
    const at = anchorFor(rect(100, 300, 10, 20), pane)
    expect(at?.left).toBe(52)
  })

  it('clamps to the right edge', () => {
    const at = anchorFor(rect(480, 300, 20, 20), pane)
    expect(at?.left).toBe(348)
  })

  it('survives a pane narrower than the button', () => {
    // Clamping must not produce a left greater than the right bound.
    const at = anchorFor(rect(0, 300, 10, 20), rect(0, 0, 40, 600))
    expect(at).not.toBeNull()
    expect(Number.isFinite(at?.left)).toBe(true)
  })

  it('returns nothing for a selection with no rectangle', () => {
    expect(anchorFor(rect(0, 0, 0, 0), pane)).toBeNull()
  })
})
