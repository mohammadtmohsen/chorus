import { describe, expect, it } from 'vitest'
import { quotePath, withPaths } from './attach.js'

describe('quotePath', () => {
  it('leaves an ordinary path alone', () => {
    // A transcript full of quotation marks around plain paths reads worse.
    expect(quotePath('/Users/me/code/chorus/README.md')).toBe('/Users/me/code/chorus/README.md')
  })

  it('quotes a path with spaces', () => {
    expect(quotePath('/Users/me/My Files/notes.txt')).toBe("'/Users/me/My Files/notes.txt'")
  })

  it('quotes the characters a shell would act on', () => {
    for (const path of ['/tmp/a$b', '/tmp/a;b', '/tmp/a&b', '/tmp/a(b)', '/tmp/a*b']) {
      expect(quotePath(path).startsWith("'")).toBe(true)
    }
  })

  it('survives a quote in the name', () => {
    expect(quotePath("/tmp/it's here.png")).toBe(`'/tmp/it'\\''s here.png'`)
  })
})

describe('withPaths', () => {
  it('returns the draft untouched when nothing was dropped', () => {
    expect(withPaths('hello', [])).toBe('hello')
  })

  it('starts a draft with the path and a space to type after', () => {
    expect(withPaths('', ['/tmp/a.png'])).toBe('/tmp/a.png ')
  })

  it('appends rather than inserting at the caret', () => {
    // A drop lands where the pointer was, which is not where you were typing.
    expect(withPaths('look at this', ['/tmp/a.png'])).toBe('look at this /tmp/a.png ')
  })

  it('does not double the spacing of a draft that ends in one', () => {
    expect(withPaths('look at ', ['/tmp/a.png'])).toBe('look at /tmp/a.png ')
  })

  it('takes several at once', () => {
    expect(withPaths('', ['/tmp/a.png', '/tmp/b log.txt'])).toBe("/tmp/a.png '/tmp/b log.txt' ")
  })
})
