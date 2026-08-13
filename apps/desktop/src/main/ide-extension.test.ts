import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EXTENSION_ID,
  extensionStatus,
  installBundledExtension,
  isOlder,
  openProjectInEditor,
  parseInstalledVersion,
  readBundledVersion,
  resolveVsix,
  type ExtensionDeps,
} from './ide-extension.js'

interface Call {
  readonly bin: string
  readonly args: readonly string[]
}

function deps(overrides: Partial<ExtensionDeps> & { calls?: Call[] } = {}): ExtensionDeps {
  const calls = overrides.calls ?? []
  return {
    findCode: overrides.findCode ?? (() => Promise.resolve('/usr/local/bin/code')),
    exec:
      overrides.exec ??
      ((bin, args) => {
        calls.push({ bin, args })
        return Promise.resolve({ stdout: '' })
      }),
    vsixPath: overrides.vsixPath ?? (() => '/res/chorus-vscode.vsix'),
    bundledVersion: overrides.bundledVersion ?? (() => '0.4.0'),
  }
}

describe('parseInstalledVersion', () => {
  it('finds the extension among others', () => {
    const stdout = [
      'dbaeumer.vscode-eslint@3.0.10',
      `${EXTENSION_ID}@0.4.0`,
      'esbenp.prettier@11',
    ].join('\n')
    expect(parseInstalledVersion(stdout, EXTENSION_ID)).toBe('0.4.0')
  })

  /* VS Code lowercases ids internally, so a capital in the publisher comes back
     in a different case than it went in. */
  it('matches regardless of case', () => {
    expect(parseInstalledVersion('Chorus.Chorus-VSCode@0.4.0', EXTENSION_ID)).toBe('0.4.0')
  })

  it('returns null when it is not installed', () => {
    expect(parseInstalledVersion('other.thing@1.0.0', EXTENSION_ID)).toBeNull()
  })

  it('returns null for empty output', () => {
    expect(parseInstalledVersion('', EXTENSION_ID)).toBeNull()
  })

  it('ignores a line with no version', () => {
    expect(parseInstalledVersion(EXTENSION_ID, EXTENSION_ID)).toBeNull()
  })
})

describe('isOlder', () => {
  /* String comparison would call 0.10.0 older than 0.9.0. */
  it('compares numerically, not lexically', () => {
    expect(isOlder('0.9.0', '0.10.0')).toBe(true)
    expect(isOlder('0.10.0', '0.9.0')).toBe(false)
  })

  it('treats equal versions as current', () => {
    expect(isOlder('0.4.0', '0.4.0')).toBe(false)
  })

  it('does not offer a downgrade', () => {
    expect(isOlder('0.5.0', '0.4.0')).toBe(false)
  })

  it('survives a non-numeric segment', () => {
    expect(isOlder('0.4.0-beta', '0.4.1')).toBe(true)
  })
})

describe('extensionStatus', () => {
  it('offers nothing when the code CLI is missing', async () => {
    const status = await extensionStatus(deps({ findCode: () => Promise.resolve(null) }))
    expect(status).toMatchObject({ cliAvailable: false, need: 'none' })
  })

  it('offers install when it is not present', async () => {
    const status = await extensionStatus(deps({ exec: () => Promise.resolve({ stdout: 'a.b@1' }) }))
    expect(status).toMatchObject({ installedVersion: null, need: 'install' })
  })

  it('offers update when the installed one is older', async () => {
    const status = await extensionStatus(
      deps({ exec: () => Promise.resolve({ stdout: `${EXTENSION_ID}@0.3.0` }) })
    )
    expect(status).toMatchObject({ installedVersion: '0.3.0', need: 'update' })
  })

  it('offers nothing when it is current', async () => {
    const status = await extensionStatus(
      deps({ exec: () => Promise.resolve({ stdout: `${EXTENSION_ID}@0.4.0` }) })
    )
    expect(status.need).toBe('none')
  })

  /* A `code` that cannot list extensions cannot install one either, so do not
     offer an action that is going to fail. */
  it('reports the CLI as unavailable when it errors', async () => {
    const status = await extensionStatus(
      deps({
        exec: () => Promise.reject(new Error('boom')),
      })
    )
    expect(status).toMatchObject({ cliAvailable: false, need: 'none' })
  })

  it('offers nothing when this build carries no VSIX', async () => {
    const status = await extensionStatus(deps({ bundledVersion: () => null }))
    expect(status.need).toBe('none')
  })
})

describe('installBundledExtension', () => {
  it('installs with --force so it doubles as the update path', async () => {
    const calls: Call[] = []
    const result = await installBundledExtension(deps({ calls }))
    expect(result.ok).toBe(true)
    expect(calls[0]?.args).toEqual(['--install-extension', '/res/chorus-vscode.vsix', '--force'])
  })

  it('fails cleanly with no CLI', async () => {
    const result = await installBundledExtension(deps({ findCode: () => Promise.resolve(null) }))
    expect(result).toEqual({ ok: false, reason: 'cli-missing' })
  })

  it('fails cleanly with no VSIX', async () => {
    const result = await installBundledExtension(deps({ vsixPath: () => null }))
    expect(result).toEqual({ ok: false, reason: 'vsix-missing' })
  })

  it('reports a reason code rather than throwing', async () => {
    const result = await installBundledExtension(
      deps({ exec: () => Promise.reject(new Error('nope')) })
    )
    expect(result).toEqual({ ok: false, reason: 'install-failed' })
  })
})

describe('openProjectInEditor', () => {
  /* An argument array, never a shell string: a path with a space or a quote in
     it would otherwise be a command injection. */
  it('passes the path as one argument', async () => {
    const calls: Call[] = []
    await openProjectInEditor("/p/my project/'; rm -rf /", deps({ calls }))
    expect(calls[0]?.args).toEqual(["/p/my project/'; rm -rf /"])
  })

  /* Which window to use is a VS Code preference the user has already set. */
  it('adds no window flags', async () => {
    const calls: Call[] = []
    await openProjectInEditor('/p/a', deps({ calls }))
    expect(calls[0]?.args).toHaveLength(1)
  })

  it('fails cleanly with no CLI', async () => {
    const result = await openProjectInEditor(
      '/p/a',
      deps({ findCode: () => Promise.resolve(null) })
    )
    expect(result).toEqual({ ok: false, reason: 'cli-missing' })
  })
})

describe('resolveVsix', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chorus-vsix-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds the packaged resource', () => {
    writeFileSync(join(dir, 'chorus-vscode.vsix'), 'x')
    expect(resolveVsix({ packaged: true, resourcesPath: dir, appPath: '/unused' })).toBe(
      join(dir, 'chorus-vscode.vsix')
    )
  })

  /* A build with no VSIX must say so rather than hand `code` a path that is
     not there. */
  it('returns null when it is absent', () => {
    expect(resolveVsix({ packaged: true, resourcesPath: dir, appPath: '/unused' })).toBeNull()
  })
})

describe('readBundledVersion', () => {
  let dir: string
  let vsix: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chorus-vsix-'))
    vsix = join(dir, 'chorus-vscode.vsix')
    writeFileSync(vsix, 'x')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the version the VSIX build wrote beside it', () => {
    writeFileSync(`${vsix}.version`, '0.6.0\n')
    expect(readBundledVersion(vsix)).toBe('0.6.0')
  })

  it('has nothing to say when there is no VSIX', () => {
    expect(readBundledVersion(null)).toBeNull()
  })

  /* An app packaged before the sidecar existed. `null` already means "offer
     nothing", so it loses the button rather than gaining a wrong version. */
  it('has nothing to say when the sidecar is missing', () => {
    expect(readBundledVersion(vsix)).toBeNull()
  })

  it('refuses a value that is not a version', () => {
    writeFileSync(`${vsix}.version`, 'not a version\n')
    expect(readBundledVersion(vsix)).toBeNull()
  })

  /*
   * The whole point of the change, stated as a test: 0.6.0 installed against
   * 0.6.0 bundled is up to date. Reading the app's version instead made this
   * `0.6.0` against `0.12.0` — `need: 'update'`, forever, and the update
   * reinstalled 0.6.0.
   */
  it('makes an up-to-date machine report no work to do', async () => {
    writeFileSync(`${vsix}.version`, '0.6.0\n')
    const status = await extensionStatus(
      deps({
        exec: () => Promise.resolve({ stdout: `${EXTENSION_ID}@0.6.0\n` }),
        bundledVersion: () => readBundledVersion(vsix),
      })
    )
    expect(status).toMatchObject({
      installedVersion: '0.6.0',
      bundledVersion: '0.6.0',
      need: 'none',
    })
  })
})
