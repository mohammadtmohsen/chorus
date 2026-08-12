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
})
