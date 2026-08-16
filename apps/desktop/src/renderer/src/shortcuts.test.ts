import { describe, expect, it } from 'vitest'
import {
  formatShortcut,
  isPrimary,
  isPrimaryAlt,
  isPrimaryOnly,
  isPrimaryShift,
  type ModifierState,
} from './shortcuts.js'

const none: ModifierState = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }
const held = (over: Partial<ModifierState>): ModifierState => ({ ...none, ...over })

describe('isPrimary', () => {
  it('is Command on macOS and Ctrl on Windows', () => {
    expect(isPrimary(held({ metaKey: true }), 'darwin')).toBe(true)
    expect(isPrimary(held({ ctrlKey: true }), 'win32')).toBe(true)
  })

  /*
   * The reason this is not `metaKey || ctrlKey`. On macOS `⌃K` is "kill line"
   * and the terminal has to forward it to the shell; treating Ctrl as primary
   * there would clear the scrollback instead.
   */
  it('does not treat Ctrl as primary on macOS', () => {
    expect(isPrimary(held({ ctrlKey: true }), 'darwin')).toBe(false)
  })

  /*
   * The other direction, and the worse one: metaKey on Windows is the Windows
   * key. Treating it as primary would bind Win+W to closing a tab, on a chord
   * the OS already owns.
   */
  it('does not treat the Windows key as primary on Windows', () => {
    expect(isPrimary(held({ metaKey: true }), 'win32')).toBe(false)
  })

  it('requires the other platform modifier to be absent, so ⌃⇧` stays distinct', () => {
    expect(isPrimary(held({ metaKey: true, ctrlKey: true }), 'darwin')).toBe(false)
    expect(isPrimary(held({ metaKey: true, ctrlKey: true }), 'win32')).toBe(false)
  })

  it('treats linux like Windows', () => {
    expect(isPrimary(held({ ctrlKey: true }), 'linux')).toBe(true)
  })
})

describe('the modifier combinations', () => {
  it('isPrimaryOnly rejects Alt and Shift', () => {
    expect(isPrimaryOnly(held({ metaKey: true }), 'darwin')).toBe(true)
    expect(isPrimaryOnly(held({ metaKey: true, altKey: true }), 'darwin')).toBe(false)
    expect(isPrimaryOnly(held({ metaKey: true, shiftKey: true }), 'darwin')).toBe(false)
  })

  it('isPrimaryShift wants Shift and refuses Alt', () => {
    expect(isPrimaryShift(held({ ctrlKey: true, shiftKey: true }), 'win32')).toBe(true)
    expect(isPrimaryShift(held({ ctrlKey: true }), 'win32')).toBe(false)
    expect(isPrimaryShift(held({ ctrlKey: true, shiftKey: true, altKey: true }), 'win32')).toBe(
      false
    )
  })

  it('isPrimaryAlt wants Alt and tolerates Shift, for the reorder gestures', () => {
    expect(isPrimaryAlt(held({ metaKey: true, altKey: true }), 'darwin')).toBe(true)
    expect(isPrimaryAlt(held({ metaKey: true, altKey: true, shiftKey: true }), 'darwin')).toBe(true)
    expect(isPrimaryAlt(held({ metaKey: true }), 'darwin')).toBe(false)
  })
})

describe('formatShortcut', () => {
  /*
   * Apple's order is Control, Option, Shift, Command — macOS itself renders New
   * Folder as ⇧⌘N, not ⌘⇧N. `en.json` had `⌘⇧J` hardcoded, which is the other
   * way round; generating the label from parts corrects it as a side effect.
   */
  it('uses glyphs in the macOS order, ⌃⌥⇧⌘ then the key', () => {
    expect(formatShortcut({ primary: true, key: 'j' }, 'darwin')).toBe('⌘J')
    expect(formatShortcut({ primary: true, shift: true, key: 'j' }, 'darwin')).toBe('⇧⌘J')
    expect(formatShortcut({ primary: true, alt: true, shift: true, key: '↑' }, 'darwin')).toBe(
      '⌥⇧⌘↑'
    )
  })

  it('spells the modifiers out on Windows, joined with +', () => {
    expect(formatShortcut({ primary: true, key: 'j' }, 'win32')).toBe('Ctrl+J')
    expect(formatShortcut({ primary: true, shift: true, key: 'j' }, 'win32')).toBe('Ctrl+Shift+J')
  })

  /*
   * `⌃⇧\`` is Ctrl-based on both platforms because it is VS Code's binding. On
   * Windows the primary modifier *is* Ctrl, so a naive implementation prints
   * "Ctrl+Ctrl+Shift+`".
   */
  it('does not print Ctrl twice when a Ctrl shortcut meets a Ctrl primary', () => {
    expect(formatShortcut({ control: true, shift: true, key: '`' }, 'win32')).toBe('Ctrl+Shift+`')
    expect(formatShortcut({ primary: true, control: true, key: 'x' }, 'win32')).toBe('Ctrl+X')
  })

  it('keeps ⌃ and ⌘ distinct on macOS, where they are different keys', () => {
    expect(formatShortcut({ control: true, shift: true, key: '`' }, 'darwin')).toBe('⌃⇧`')
    expect(formatShortcut({ primary: true, shift: true, key: '`' }, 'darwin')).toBe('⇧⌘`')
  })
})
