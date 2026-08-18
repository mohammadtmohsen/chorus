import { describe, expect, it } from 'vitest'
import { MAX_CODE_SPAN, shortenCodeSpan } from './shorten.js'

/**
 * The case this was written for, from a real message.
 *
 * The VS Code context block for a file open in a merge-request diff: the path
 * three times, the sha twice, and the question itself lost inside four wrapped
 * lines of monospace.
 */
const PATH = 'src/features/network-package/clinical-privileges/utils/clinicalPrivilegeLookups.ts'
const SHA = 'e81e4ca2b006fef0c69a31a7641e7b5abf1fa054'

describe('shortenCodeSpan', () => {
  it('leaves a short span exactly as it was', () => {
    for (const span of ['src/App.tsx:12-18', 'pnpm check', 'HEAD~1', ''])
      expect(shortenCodeSpan(span)).toBe(span)
  })

  it('keeps the file name and the lines of a long reference', () => {
    expect(shortenCodeSpan(`${PATH}:4-31`)).toBe('…/utils/clinicalPrivilegeLookups.ts:4-31')
  })

  it('shortens a commit to what every git UI shows', () => {
    expect(shortenCodeSpan(`${SHA}:${PATH}`)).toBe('e81e4ca:…/utils/clinicalPrivilegeLookups.ts')
  })

  /*
   * A bare sha is forty characters, which is under the length threshold — so
   * without the unconditional pass it survived whole. It is also the one case
   * where the short form is not a compromise: seven is what git itself prints.
   */
  it('shortens a sha that is the whole span', () => {
    expect(shortenCodeSpan(SHA)).toBe('e81e4ca')
  })

  /*
   * The span that forced shas to be handled before length: this is neither a
   * sha nor a path, so the middle-elide kept twenty-one characters of commit
   * and still wrapped.
   */
  it('shortens a git show argument to something readable', () => {
    expect(shortenCodeSpan(`git show ${SHA}:${PATH}`)).toBe(
      'git show e81e4ca:…/utils/clinicalPrivilegeLookups.ts'
    )
  })

  it('leaves a hex-looking word that is not a commit', () => {
    // Eight characters is a word, not a sha; the threshold is well above it.
    expect(shortenCodeSpan('deadbeef')).toBe('deadbeef')
  })

  it('never returns something longer than what it was given', () => {
    for (const span of [PATH, SHA, `${SHA}:${PATH}`, `${PATH}:4-31`, 'x'.repeat(200)])
      expect(shortenCodeSpan(span).length).toBeLessThanOrEqual(span.length)
  })

  /*
   * A path is cut at a separator, so what is left is a real suffix of it. Half
   * a directory name would read as a different file.
   */
  it('cuts a path at a slash', () => {
    const shortened = shortenCodeSpan(PATH)
    expect(shortened.startsWith('…/')).toBe(true)
    expect(PATH.endsWith(shortened.slice(2))).toBe(true)
  })

  it('falls back to the file name when two segments still do not fit', () => {
    // Non-hex letters on purpose: a 40-character run of `a` is a valid hex
    // string, so the sha pass would shorten it and this would test nothing.
    const deep = `src/${'z'.repeat(40)}/${'y'.repeat(40)}/file.ts`
    expect(shortenCodeSpan(deep)).toBe('…/file.ts')
  })

  it('keeps both ends of something that is neither a path nor a sha', () => {
    const long = `${'start'.repeat(8)}-${'end'.repeat(8)}`
    const shortened = shortenCodeSpan(long)
    expect(shortened).toContain('…')
    expect(shortened.length).toBeLessThanOrEqual(MAX_CODE_SPAN)
    expect(long.startsWith(shortened.split('…')[0] ?? '')).toBe(true)
  })
})
