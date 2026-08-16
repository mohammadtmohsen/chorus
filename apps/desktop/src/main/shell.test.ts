import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExecutableFile, resolveShell } from './shell.js'

/**
 * Some of these need a unix *filesystem*, not merely a unix argument.
 *
 * `chmod` is a no-op on Windows and libuv synthesises the mode from the
 * read-only attribute, so a file written 0o755 reads back 0o666 there — the
 * executable bit cannot be produced at all. `/bin/zsh` and `/bin/sh` do not
 * exist either. Passing `'darwin'` makes the *function* answer for unix; it
 * cannot make the disk beneath it behave like one.
 *
 * So those cases are skipped on Windows rather than weakened to pass there. The
 * Windows behaviour they would otherwise cover is asserted directly below, with
 * an explicit platform and no reliance on a mode ever being set.
 */
const onUnixFs = it.skipIf(process.platform === 'win32')

const dir = mkdtempSync(join(tmpdir(), 'chorus-shell-'))

function file(name: string, mode: number): string {
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, mode)
  return path
}

const executable = file('runnable', 0o755)
const plain = file('not-runnable', 0o644)

describe('isExecutableFile', () => {
  onUnixFs('accepts a file with the executable bit', () => {
    expect(isExecutableFile(executable, 'darwin')).toBe(true)
  })

  /*
   * Explicitly darwin, and every unix case below with it.
   *
   * These read `process.platform` by default, so on the Windows runner they
   * asserted the *fix* — a file with no execute bit is executable there — and
   * called it a failure. A test for unix behaviour has to name unix; the host it
   * happens to run on is not an argument.
   */
  it('rejects a file without it', () => {
    expect(isExecutableFile(plain, 'darwin')).toBe(false)
  })

  /*
   * The distinction the plan's revision 2 got wrong: it said "validate the path
   * exists". A directory exists, and spawning one fails with an error that
   * blames the terminal rather than the setting.
   */
  it('rejects a directory, which merely existing would not', () => {
    expect(isExecutableFile(dir, 'darwin')).toBe(false)
  })

  it('rejects a path that is not there at all', () => {
    expect(isExecutableFile(join(dir, 'absent'), 'darwin')).toBe(false)
  })

  /*
   * The Windows half, which was broken and invisible.
   *
   * libuv never sets execute bits on Windows — a regular file is 0o666 — so the
   * mode check rejected every candidate there, including `cmd.exe`. The old
   * `resolveShell` still returned COMSPEC via its "nothing validated" fallback,
   * so the terminal opened and nothing looked wrong.
   *
   * `plain` is mode 0o644 here, which is exactly what a Windows file looks like
   * to this function: a file with no execute bit. Asserting it is accepted
   * under win32 and rejected under darwin is the whole fix in two lines.
   */
  it('accepts a file with no execute bit on windows, where none is ever set', () => {
    expect(isExecutableFile(plain, 'win32')).toBe(true)
    expect(isExecutableFile(plain, 'darwin')).toBe(false)
  })

  it('still rejects a directory on windows, which is the check that survives', () => {
    expect(isExecutableFile(dir, 'win32')).toBe(false)
  })

  it('still rejects a missing path on windows', () => {
    expect(isExecutableFile(join(dir, 'absent'), 'win32')).toBe(false)
  })
})

describe('resolveShell', () => {
  onUnixFs('uses $SHELL when it is executable', () => {
    expect(resolveShell({ SHELL: executable }, 'darwin')).toEqual({
      file: executable,
      args: ['-l'],
    })
  })

  onUnixFs('ignores a $SHELL that cannot be executed and falls back', () => {
    const choice = resolveShell({ SHELL: plain }, 'darwin')
    expect(choice.file).not.toBe(plain)
    expect(isExecutableFile(choice.file, 'darwin')).toBe(true)
  })

  it('ignores a $SHELL that is a directory', () => {
    const choice = resolveShell({ SHELL: dir }, 'darwin')
    expect(choice.file).not.toBe(dir)
  })

  onUnixFs('falls back when $SHELL is unset', () => {
    const choice = resolveShell({}, 'darwin')
    expect(isExecutableFile(choice.file, 'darwin')).toBe(true)
  })

  /*
   * `-l` is what gives the terminal the user's real PATH. Without it a Finder
   * launch opens a shell with no Homebrew and no nvm, which the user meets as
   * "brew: command not found" — the same gap `which.ts` exists to close for
   * agent CLIs.
   */
  onUnixFs('opens a login shell on unix', () => {
    expect(resolveShell({ SHELL: executable }, 'darwin').args).toEqual(['-l'])
  })

  it('passes no login flag on windows, which has no equivalent', () => {
    // `plain`, not `executable`: on a Windows host neither has an execute bit,
    // and the win32 branch does not look for one. This is the case that used to
    // pass for the wrong reason — a real 0o755 file on a macOS host.
    expect(resolveShell({ COMSPEC: plain }, 'win32')).toEqual({ file: plain, args: [] })
  })

  it('reads COMSPEC rather than SHELL on windows', () => {
    const choice = resolveShell({ SHELL: plain, COMSPEC: '' }, 'win32')
    expect(choice.file).not.toBe(plain)
  })

  /*
   * The regression this phase exists for, and the one the existing win32 tests
   * above could not catch: they pass `executable`, a real 0o755 file, so they
   * went green whether or not the mode check applied. `plain` is 0o644 — the
   * shape every Windows file has — and selecting it proves COMSPEC is chosen on
   * its merits rather than arriving through the no-shell-found fallback.
   */
  it('selects a COMSPEC with no execute bit, rather than reaching the fallback', () => {
    expect(resolveShell({ COMSPEC: plain }, 'win32')).toEqual({ file: plain, args: [] })
  })

  it('still refuses a COMSPEC that is a directory', () => {
    const choice = resolveShell({ COMSPEC: dir }, 'win32')
    expect(choice.file).not.toBe(dir)
    expect(choice.file).toBe('cmd.exe')
  })
})
