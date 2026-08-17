import { describe, expect, it } from 'vitest'
import { isSafeHref } from '../shared/markdown.js'

/**
 * What the transcript draws as a link, and what the app will actually open.
 *
 * These were two allowlists over one decision. The renderer drew anything
 * `isSafeHref` admits — `http:`, `https:`, `mailto:` — while
 * `setWindowOpenHandler` opened only `https:` and denied the rest, so a plain
 * `http` link was underlined, coloured, clickable, and dead. Nothing said so:
 * `deny` has no user-visible half.
 *
 * Reported as _"on click on ticket link or any reference link nothing
 * happened"_, and measured before it was fixed — a plain-`http` link opened
 * zero TCP connections while an `https` one opened four.
 *
 * The repair was to share the predicate rather than to widen the second copy, so
 * what needs guarding now is that nobody adds a third opinion. These are about
 * the *rule*, which is why they live beside main rather than beside the parser.
 */

describe('what may be drawn is what may be opened', () => {
  it('admits the three schemes a transcript can usefully carry', () => {
    expect(isSafeHref('https://example.com/browse/TPA-614')).toBe(true)
    expect(isSafeHref('http://127.0.0.1:8080/x')).toBe(true)
    expect(isSafeHref('mailto:someone@example.com')).toBe(true)
  })

  it('refuses the schemes that would make a link an exploit', () => {
    // `javascript:` and `data:` are the live ones; `file:` and a custom app
    // scheme are the quieter ones — `shell.openExternal` hands those to whatever
    // the OS has registered, which is not a browser.
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vscode://file/etc/passwd',
      'chorus://open',
      'ftp://example.com/x',
    ]) {
      expect(isSafeHref(href)).toBe(false)
    }
  })

  it('is not fooled by leading whitespace or a scheme in the middle', () => {
    expect(isSafeHref(' https://example.com')).toBe(false)
    expect(isSafeHref('javascript:void(https://example.com)')).toBe(false)
  })

  it('accepts the schemes case-insensitively, because a URL may shout', () => {
    expect(isSafeHref('HTTPS://EXAMPLE.COM')).toBe(true)
    expect(isSafeHref('MailTo:someone@example.com')).toBe(true)
  })
})
