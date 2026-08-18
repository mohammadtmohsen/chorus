import { describe, expect, it } from 'vitest'
import { shortName } from './Attachments.js'

/**
 * The caption under a thumbnail tile.
 *
 * The case that made this a function rather than a CSS ellipsis is the first
 * one: pasted images are named for the millisecond they arrived, so cutting
 * from the front keeps the half nobody can read and drops the extension, and
 * two screenshots pasted a second apart caption identically.
 */
describe('shortName', () => {
  it('keeps the extension and cuts the stem', () => {
    expect(shortName('1787033349300-3-image.png')).toBe('17870….png')
  })

  /*
   * The width is the reason `STEM` is 5 rather than a rounder number, so it is
   * asserted rather than left to a comment: eleven characters is what a 56px
   * tile holds at 9px, and one more brought the CSS ellipsis back — which cuts
   * from the *other* end and takes the extension with it.
   */
  it('fits the tile', () => {
    expect(shortName('1787033349300-3-image.png').length).toBeLessThanOrEqual(11)
  })

  it('leaves a name that already fits', () => {
    expect(shortName('logo.png')).toBe('logo.png')
  })

  it('cuts a name with no extension', () => {
    expect(shortName('a-very-long-name-with-no-dot')).toBe('a-ver…')
  })

  it('treats a dotfile as a name rather than a bare extension', () => {
    expect(shortName('.env')).toBe('.env')
  })
})
