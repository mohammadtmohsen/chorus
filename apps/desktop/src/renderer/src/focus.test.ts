import { describe, expect, it } from 'vitest'
import { mayTakeCaret, type Focused } from './focus.js'

/**
 * The reported bug, both halves of it: typing in the composer or in an aside's
 * box and losing the caret the moment an agent asked for an approval or a
 * question. The card is the right thing to focus; it was the wrong moment.
 */

const focused = (over: Partial<Focused>): Focused => ({
  tag: 'BODY',
  type: null,
  value: '',
  editable: false,
  inModal: false,
  inTerminal: false,
  ...over,
})

describe('a card may take the caret', () => {
  it('when nothing holds it', () => {
    expect(mayTakeCaret(null)).toBe(true)
  })

  it('when the caret is on the document rather than in a box', () => {
    // `document.activeElement` with nothing focused. No special case needed.
    expect(mayTakeCaret(focused({ tag: 'BODY' }))).toBe(true)
  })

  it('when the composer is focused but empty', () => {
    /*
     * The case that stops this from being a refusal to focus at all: a session
     * focuses its composer on mount and keeps it, so refusing on focus alone
     * would mean an approval was never again answerable by Enter.
     */
    expect(mayTakeCaret(focused({ tag: 'TEXTAREA', value: '' }))).toBe(true)
  })

  it('when the caret is on a button — an answered card handing it on', () => {
    expect(mayTakeCaret(focused({ tag: 'BUTTON', value: 'Allow' }))).toBe(true)
  })

  it('when a checkbox holds the caret, whose value is a setting not a sentence', () => {
    expect(mayTakeCaret(focused({ tag: 'INPUT', type: 'checkbox', value: 'on' }))).toBe(true)
  })
})

describe('a card may not take the caret', () => {
  it('out of a half-written message in the composer', () => {
    // The report: "when I am writing in the input I lose the focus".
    expect(mayTakeCaret(focused({ tag: 'TEXTAREA', value: 'please refactor the' }))).toBe(false)
  })

  it('out of a half-written question in the side chat', () => {
    // Same textarea shape; the aside's box is the second half of the report.
    expect(mayTakeCaret(focused({ tag: 'TEXTAREA', value: 'why does this' }))).toBe(false)
  })

  it('out of a text input with something in it', () => {
    expect(mayTakeCaret(focused({ tag: 'INPUT', type: 'text', value: 'a name' }))).toBe(false)
  })

  it('out of a search box, which is typed into like any other', () => {
    expect(mayTakeCaret(focused({ tag: 'INPUT', type: 'search', value: 'todo' }))).toBe(false)
  })

  it('out of a contenteditable, which is a text box wearing another tag', () => {
    expect(mayTakeCaret(focused({ tag: 'DIV', value: 'drafted', editable: true }))).toBe(false)
  })

  it('out of a box holding only whitespace, which is still someone mid-message', () => {
    /*
     * This asserted the opposite first, on the reasoning that whitespace is
     * "nothing to lose". Two blank lines inside a message are not nothing, and
     * the cost of reading them that way is the exact failure this file prevents:
     * the caret moves to Allow and the next Enter approves an unread command.
     * The composer's own case is `value: ''`, above, which is still allowed.
     */
    expect(mayTakeCaret(focused({ tag: 'TEXTAREA', value: '  \n ' }))).toBe(false)
  })
})

/**
 * A sheet covers the pane, so the dock is behind it. An approval taking the
 * caret there puts it on an Allow button nobody can see, and Enter at an open
 * dialog means "confirm this" — which would approve an unread command.
 *
 * Emptiness is not the test here. The handoff sheet opens on a `<select>`, and
 * every one of these would have been allowed by the rule above.
 */
describe('nothing behind a modal may take the caret out of it', () => {
  it('not off the handoff sheet’s "Ask them to" select', () => {
    expect(mayTakeCaret(focused({ tag: 'SELECT', value: 'codex', inModal: true }))).toBe(false)
  })

  it('not off a button inside a sheet', () => {
    expect(mayTakeCaret(focused({ tag: 'BUTTON', value: 'Send', inModal: true }))).toBe(false)
  })

  it("not off a sheet's empty text box, which the text rule would have allowed", () => {
    expect(mayTakeCaret(focused({ tag: 'TEXTAREA', value: '', inModal: true }))).toBe(false)
  })

  it('not off a checkbox in Settings', () => {
    expect(mayTakeCaret(focused({ tag: 'INPUT', type: 'checkbox', inModal: true }))).toBe(false)
  })

  it('but the same controls outside a modal are still fair game', () => {
    // The dock is not a modal, so a queue still hands focus from one card to the
    // next — the one case where a card taking the caret from a card is right.
    expect(mayTakeCaret(focused({ tag: 'SELECT', value: 'codex' }))).toBe(true)
    expect(mayTakeCaret(focused({ tag: 'BUTTON', value: 'Allow' }))).toBe(true)
  })
})

describe('a terminal keeps its caret', () => {
  /*
   * The reported bug: typing into the shell and watching the characters land in
   * the message box instead.
   *
   * xterm types into a hidden textarea it clears after every keystroke, so the
   * box is empty *by design, permanently*. Every other rule in this file reads
   * that as an idle box — "nothing in it costs nothing to leave" — which is
   * exactly backwards for someone mid-command. Emptiness cannot mean idle here.
   */
  it('even though its box is empty, which normally means idle', () => {
    expect(mayTakeCaret(focused({ tag: 'TEXTAREA', value: '', inTerminal: true }))).toBe(false)
  })

  it('and the same box outside a terminal is still fair game', () => {
    // The composer on mount, which is the case the emptiness rule exists for.
    expect(mayTakeCaret(focused({ tag: 'TEXTAREA', value: '' }))).toBe(true)
  })

  it('however the caret got there — a click, a shortcut, or a tab', () => {
    // Not keyed on the tag: xterm has moved its input proxy before now.
    expect(mayTakeCaret(focused({ tag: 'DIV', inTerminal: true }))).toBe(false)
  })
})
