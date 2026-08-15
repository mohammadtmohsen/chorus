import { describe, expect, it } from 'vitest'
import {
  descriptorFor,
  descriptorIsPrivate,
  endpointFor,
  endpointIsFile,
  runtimeDirectory,
} from './endpoint.js'

const WIN: NodeJS.Platform = 'win32'
const MAC: NodeJS.Platform = 'darwin'

describe('endpointFor', () => {
  it('is a socket file on unix', () => {
    expect(endpointFor('/tmp/chorus-ide', 4242, MAC)).toBe('/tmp/chorus-ide/4242.sock')
  })

  /*
   * A named pipe is a name in the `\\.\pipe\` namespace, not a filesystem path.
   * The old code produced `<tmp>\chorus-ide\4242.sock`, which is a perfectly
   * valid filename and an invalid pipe name — `listen` would create a file
   * nothing could ever dial.
   */
  it('is a pipe name on windows, not a path under the runtime directory', () => {
    const endpoint = endpointFor('C:\\Temp\\chorus-ide', 4242, WIN)
    expect(endpoint).toBe('\\\\.\\pipe\\chorus-ide-4242')
    expect(endpoint).not.toContain('chorus-ide\\4242')
  })

  it('keys on the pid, so two Chorus instances cannot collide', () => {
    expect(endpointFor('C:\\Temp', 1, WIN)).not.toBe(endpointFor('C:\\Temp', 2, WIN))
  })
})

describe('descriptorFor', () => {
  it('stays a real file on both platforms — it is what carries the token', () => {
    expect(descriptorFor('/tmp/chorus-ide', 7)).toBe('/tmp/chorus-ide/7.json')
  })
})

describe('runtimeDirectory', () => {
  it('is the one definition both ends now share', () => {
    // Previously two bare join(tmpdir(), 'chorus-ide') expressions that agreed
    // only by luck.
    expect(runtimeDirectory('/tmp')).toBe('/tmp/chorus-ide')
  })
})

describe('endpointIsFile', () => {
  it('says a unix socket needs unlinking and a pipe does not', () => {
    expect(endpointIsFile(MAC)).toBe(true)
    // rmSync and chmodSync on a `\\.\pipe\` name look in the wrong namespace;
    // chmod throws ENOENT outright.
    expect(endpointIsFile(WIN)).toBe(false)
  })
})

describe('descriptorIsPrivate', () => {
  it('accepts a 0600 file owned by this user', () => {
    expect(descriptorIsPrivate({ mode: 0o100600, uid: 501 }, 501, MAC)).toBe(true)
  })

  it('rejects a file others can read', () => {
    expect(descriptorIsPrivate({ mode: 0o100644, uid: 501 }, 501, MAC)).toBe(false)
  })

  it('rejects a file owned by someone else', () => {
    expect(descriptorIsPrivate({ mode: 0o100600, uid: 0 }, 501, MAC)).toBe(false)
  })

  /*
   * The double failure that made the bridge dead on Windows. libuv synthesises
   * mode from the read-only attribute alone, so a normal file is 0o666 and the
   * 0o077 mask never clears; and `process.getuid` is undefined there, so the
   * ownership test was `0 !== undefined` — always true. The bridge threw into a
   * catch that only logs; the extension skipped every descriptor. Two silent
   * failures that presented as one missing feature.
   */
  it('cannot judge on windows, and admits it rather than rejecting everything', () => {
    expect(descriptorIsPrivate({ mode: 0o100666, uid: 0 }, undefined, WIN)).toBe(true)
  })

  it('still rejects a world-readable file on unix when getuid is unavailable', () => {
    expect(descriptorIsPrivate({ mode: 0o100666, uid: 0 }, undefined, MAC)).toBe(false)
  })
})
