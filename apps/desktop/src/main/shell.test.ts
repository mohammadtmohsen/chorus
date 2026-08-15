import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExecutableFile, resolveShell } from './shell.js'

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
  it('accepts a file with the executable bit', () => {
    expect(isExecutableFile(executable)).toBe(true)
  })

  it('rejects a file without it', () => {
    expect(isExecutableFile(plain)).toBe(false)
  })

  /*
   * The distinction the plan's revision 2 got wrong: it said "validate the path
   * exists". A directory exists, and spawning one fails with an error that
   * blames the terminal rather than the setting.
   */
  it('rejects a directory, which merely existing would not', () => {
    expect(isExecutableFile(dir)).toBe(false)
  })

  it('rejects a path that is not there at all', () => {
    expect(isExecutableFile(join(dir, 'absent'))).toBe(false)
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
  it('uses $SHELL when it is executable', () => {
    expect(resolveShell({ SHELL: executable }, 'darwin')).toEqual({
      file: executable,
      args: ['-l'],
    })
  })

  it('ignores a $SHELL that cannot be executed and falls back', () => {
    const choice = resolveShell({ SHELL: plain }, 'darwin')
    expect(choice.file).not.toBe(plain)
    expect(isExecutableFile(choice.file)).toBe(true)
  })

  it('ignores a $SHELL that is a directory', () => {
    const choice = resolveShell({ SHELL: dir }, 'darwin')
    expect(choice.file).not.toBe(dir)
  })

  it('falls back when $SHELL is unset', () => {
    const choice = resolveShell({}, 'darwin')
    expect(isExecutableFile(choice.file)).toBe(true)
  })

  /*
   * `-l` is what gives the terminal the user's real PATH. Without it a Finder
   * launch opens a shell with no Homebrew and no nvm, which the user meets as
   * "brew: command not found" — the same gap `which.ts` exists to close for
   * agent CLIs.
   */
  it('opens a login shell on unix', () => {
    expect(resolveShell({ SHELL: executable }, 'darwin').args).toEqual(['-l'])
  })

  it('passes no login flag on windows, which has no equivalent', () => {
    expect(resolveShell({ COMSPEC: executable }, 'win32')).toEqual({
      file: executable,
      args: [],
    })
  })

  it('reads COMSPEC rather than SHELL on windows', () => {
    const choice = resolveShell({ SHELL: executable, COMSPEC: '' }, 'win32')
    expect(choice.file).not.toBe(executable)
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
