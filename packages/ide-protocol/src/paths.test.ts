import { describe, expect, it } from 'vitest'
import { hasRoot, isInside, relativeInside } from './paths.js'

const isWithin = isInside
const relativeWithin = relativeInside

/**
 * Windows containment, asserted from macOS.
 *
 * Every case here is a shape that cannot be produced on the development machine
 * — drive letters, mixed drive-letter case, UNC roots — which is why these take
 * an explicit platform rather than reading `process.platform`. The security
 * boundary between an agent and the rest of the disk runs through `isWithin`,
 * and it had no Windows coverage at all.
 */
describe('isWithin on Windows', () => {
  const WIN: NodeJS.Platform = 'win32'

  it('keeps the sibling-prefix rule that is the whole point of the function', () => {
    expect(isWithin('C:\\a\\project', 'C:\\a\\project-old\\f.ts', WIN)).toBe(false)
    expect(isWithin('C:\\a\\project', 'C:\\a\\project\\f.ts', WIN)).toBe(true)
  })

  /*
   * The bug that made every file report as outside its own project. `fsPath`
   * lowercases the drive letter, `realpathSync` returns the volume's casing,
   * and the two ends of the bridge canonicalize with different code — so the
   * comparison saw `c:\` against `C:\` and said no, with no log line.
   */
  it('folds drive-letter case, which the two ends disagree about', () => {
    expect(isWithin('C:\\Users\\Me\\proj', 'c:\\users\\me\\proj\\src\\a.ts', WIN)).toBe(true)
    expect(isWithin('c:\\users\\me\\proj', 'C:\\Users\\Me\\proj', WIN)).toBe(true)
  })

  it('folds separators, because Windows accepts both and VS Code emits /', () => {
    expect(isWithin('C:\\proj', 'C:/proj/src/a.ts', WIN)).toBe(true)
  })

  it('contains a project sitting directly at a drive root', () => {
    expect(isWithin('C:\\', 'C:\\file.ts', WIN)).toBe(true)
    expect(isWithin('C:\\', 'D:\\file.ts', WIN)).toBe(false)
  })

  it('contains a project on a UNC share', () => {
    expect(isWithin('\\\\server\\share\\proj', '\\\\server\\share\\proj\\a.ts', WIN)).toBe(true)
    expect(isWithin('\\\\server\\share\\proj', '\\\\server\\other\\proj\\a.ts', WIN)).toBe(false)
  })

  it('stays case-sensitive on posix, where two casings are two files', () => {
    expect(isWithin('/a/Project', '/a/project/f.ts', 'darwin')).toBe(false)
  })
})

describe('relativeWithin', () => {
  it('does not eat a character at a drive root', () => {
    // `slice(root.length + 1)` returned "ile.ts" here.
    expect(relativeWithin('C:\\', 'C:\\file.ts', 'win32')).toBe('file.ts')
  })

  it('does not eat a character at a UNC share root', () => {
    expect(relativeWithin('\\\\server\\share\\', '\\\\server\\share\\file.ts', 'win32')).toBe(
      'file.ts'
    )
  })

  it('does not eat a character at the posix root', () => {
    expect(relativeWithin('/', '/file.ts', 'darwin')).toBe('file.ts')
  })

  it('still slices correctly below a normal root', () => {
    expect(relativeWithin('/a/proj', '/a/proj/src/x.ts', 'darwin')).toBe('src/x.ts')
    expect(relativeWithin('C:\\proj', 'C:\\proj\\src\\x.ts', 'win32')).toBe('src\\x.ts')
  })

  it('preserves the filesystem casing rather than the folded copy', () => {
    expect(relativeWithin('c:\\proj', 'C:\\proj\\Src\\App.ts', 'win32')).toBe('Src\\App.ts')
  })

  it('returns null for something outside', () => {
    expect(relativeWithin('/a/proj', '/a/other/x.ts', 'darwin')).toBeNull()
  })
})

describe('hasRoot', () => {
  it('accepts a drive-anchored path', () => {
    expect(hasRoot('C:\\src\\a.ts', 'win32')).toBe(true)
  })

  it('accepts a UNC path', () => {
    expect(hasRoot('\\\\server\\share\\a.ts', 'win32')).toBe(true)
  })

  /*
   * `\etc` is isAbsolute-true but names no drive, so resolving it borrows the
   * process's current drive — with a root on D: a legitimate \src\index.ts
   * became C:\src\index.ts.
   */
  it('rejects a rooted path with no drive, which would bind to the wrong one', () => {
    expect(hasRoot('\\etc\\passwd', 'win32')).toBe(false)
    expect(hasRoot('/etc/passwd', 'win32')).toBe(false)
  })

  it('rejects a drive-relative path, which isAbsolute already calls relative', () => {
    expect(hasRoot('C:secrets', 'win32')).toBe(false)
  })

  it('is plain isAbsolute on posix', () => {
    expect(hasRoot('/etc/passwd', 'darwin')).toBe(true)
    expect(hasRoot('src/a.ts', 'darwin')).toBe(false)
  })
})
