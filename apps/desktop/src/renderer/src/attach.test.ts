import { describe, expect, it } from 'vitest'
import { quotePath, splitTrailingPaths, withPaths } from './attach.js'

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

/**
 * Reading a sent message back.
 *
 * The round trip is the property worth pinning: whatever `withPaths` put on the
 * end, this has to take off again — including the case that made it necessary,
 * a pasted screenshot under `Application Support`, whose path has a space in it
 * and is therefore quoted.
 */
describe('splitTrailingPaths', () => {
  it('leaves a message with no path alone', () => {
    expect(splitTrailingPaths('what does this mean?')).toEqual({
      body: 'what does this mean?',
      paths: [],
    })
  })

  it('takes a bare path off the end', () => {
    expect(splitTrailingPaths('look at this /tmp/a.png')).toEqual({
      body: 'look at this',
      paths: ['/tmp/a.png'],
    })
  })

  it('takes a quoted path off the end, unquoted', () => {
    const path = '/Users/me/Library/Application Support/@chorus/desktop/pasted/1-image.png'
    expect(splitTrailingPaths(`why this ${quotePath(path)}`)).toEqual({
      body: 'why this',
      paths: [path],
    })
  })

  it('round-trips whatever withPaths wrote', () => {
    const paths = ['/tmp/a.png', "/tmp/o'brien's shot.png", '/tmp/b log.txt']
    expect(splitTrailingPaths(withPaths('three of them', paths))).toEqual({
      body: 'three of them',
      paths,
    })
  })

  /*
   * The rule that keeps this from editing what someone said: a path in the
   * middle of a sentence is being talked about, not attached, and turning it
   * into a picture would silently drop the words after it.
   */
  it('ignores a path that is not at the end', () => {
    expect(splitTrailingPaths('is /tmp/a.png the one you meant?')).toEqual({
      body: 'is /tmp/a.png the one you meant?',
      paths: [],
    })
  })

  it('does not take a relative path or a bare word', () => {
    // Only an absolute path is something main can be asked to preview.
    expect(splitTrailingPaths('see src/App.tsx').paths).toEqual([])
    expect(splitTrailingPaths('done').paths).toEqual([])
  })

  it('keeps a message that is nothing but a path', () => {
    expect(splitTrailingPaths('/tmp/a.png')).toEqual({ body: '', paths: ['/tmp/a.png'] })
  })
})
