import { describe, expect, it } from 'vitest'
import { enableBrowserArguments } from './browser-arguments.js'

describe('browser runtime arguments', () => {
  it('preserves JSONC comments and other proposed API extensions', () => {
    const source =
      '{\n  // Keep the user setting\n  "disable-hardware-acceleration": true,\n  "enable-proposed-api": ["other.extension"],\n}\n'
    const next = enableBrowserArguments(source)
    expect(next).toContain('// Keep the user setting')
    expect(next).toContain('other.extension')
    expect(next).toContain('mohammadtmohsen.chorus')
    expect(enableBrowserArguments(next)).toBe(next)
  })
  it('refuses malformed existing arguments without replacing them', () => {
    expect(() => enableBrowserArguments('{ broken')).toThrow()
  })
})
