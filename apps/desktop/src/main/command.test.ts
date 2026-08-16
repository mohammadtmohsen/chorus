import { describe, expect, it } from 'vitest'
import {
  classify,
  executableCandidates,
  parseShimTarget,
  pathExtensions,
  sdkExecutablePath,
  spawnSpec,
  UnsafeCommandArgument,
  withScriptPath,
} from './command.js'

/**
 * Windows behaviour, asserted from macOS.
 *
 * Every function here takes its platform rather than reading `process.platform`,
 * which is the only reason these run at all on the machine this is written on —
 * and the reason they will keep running in CI on both. The Windows probe job
 * added in Phase 0 is what will eventually check the same logic against a real
 * `npm install`; until then these prove the shape, not the machine.
 */

const WINDOWS: NodeJS.Platform = 'win32'
const MAC: NodeJS.Platform = 'darwin'

describe('pathExtensions', () => {
  it('falls back to what a stock Windows sets', () => {
    expect(pathExtensions({})).toEqual(['.com', '.exe', '.bat', '.cmd'])
  })

  it('reads the order out of PATHEXT, because that is the resolution order', () => {
    expect(pathExtensions({ PATHEXT: '.CMD;.EXE' })).toEqual(['.cmd', '.exe'])
  })

  it('survives the doubled and trailing semicolons real registries contain', () => {
    expect(pathExtensions({ PATHEXT: '.EXE;;.CMD;' })).toEqual(['.exe', '.cmd'])
  })

  it('drops entries that are not extensions rather than building "codex" twice', () => {
    expect(pathExtensions({ PATHEXT: '.EXE;junk;.' })).toEqual(['.exe'])
  })
})

describe('executableCandidates on Windows', () => {
  const env = {
    PATH: 'C:\\tools;C:\\bin',
    PATHEXT: '.EXE;.CMD',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  }

  it('multiplies every directory by PATHEXT, since a bare name is not a filename', () => {
    const found = executableCandidates('codex', { platform: WINDOWS, env, home: 'C:\\Users\\me' })
    expect(found).toContain('C:\\tools\\codex.exe')
    expect(found).toContain('C:\\tools\\codex.cmd')
    expect(found).toContain('C:\\bin\\codex.cmd')
  })

  it('offers the bare name first, because a PATH entry may hold an extensionless file', () => {
    const found = executableCandidates('codex', { platform: WINDOWS, env, home: 'C:\\Users\\me' })
    expect(found.indexOf('C:\\tools\\codex')).toBeLessThan(found.indexOf('C:\\tools\\codex.exe'))
  })

  it('looks in %APPDATA%\\npm, which is where npm -g writes and PATH may not list', () => {
    const found = executableCandidates('claude', { platform: WINDOWS, env, home: 'C:\\Users\\me' })
    expect(found).toContain('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
  })

  it('splits PATH on ; — the one character that makes the old code wrong here', () => {
    const found = executableCandidates('codex', {
      platform: WINDOWS,
      env: { PATH: 'C:\\a;C:\\b', PATHEXT: '.EXE' },
      home: 'C:\\Users\\me',
    })
    expect(found).toContain('C:\\a\\codex.exe')
    expect(found).toContain('C:\\b\\codex.exe')
  })

  it('reads Path as well as PATH, because Windows environments carry either', () => {
    const found = executableCandidates('codex', {
      platform: WINDOWS,
      env: { Path: 'C:\\only', PATHEXT: '.EXE' },
      home: 'C:\\Users\\me',
    })
    expect(found).toContain('C:\\only\\codex.exe')
  })
})

describe('executableCandidates on macOS', () => {
  /*
   * The regression guard the plan asks for by name. These four directories, in
   * this order, are what `which.ts` searched before any of this existed; a
   * Windows change that quietly reorders or drops one would move which `codex`
   * a machine with both Homebrew and npm installs resolves to.
   */
  it('still offers the original four directories, in the original order', () => {
    const found = executableCandidates('codex', {
      platform: MAC,
      env: {},
      home: '/Users/me',
    })
    expect(found).toEqual([
      '/Users/me/.local/bin/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      '/usr/bin/codex',
    ])
  })

  it('adds PATH after them, split on : and never multiplied by an extension', () => {
    const found = executableCandidates('codex', {
      platform: MAC,
      env: { PATH: '/opt/extra/bin:/usr/bin' },
      home: '/Users/me',
    })
    expect(found).toContain('/opt/extra/bin/codex')
    expect(found.every((entry) => !entry.endsWith('.exe'))).toBe(true)
  })

  it('does not repeat a directory that PATH also names', () => {
    const found = executableCandidates('codex', {
      platform: MAC,
      env: { PATH: '/usr/bin' },
      home: '/Users/me',
    })
    expect(found.filter((entry) => entry === '/usr/bin/codex')).toHaveLength(1)
  })
})

describe('classify', () => {
  it('routes a .cmd through cmd.exe rather than spawning it directly', () => {
    // Spawning the .cmd itself is EINVAL since the CVE-2024-27980 fix.
    const resolved = classify('C:\\npm\\codex.cmd', {
      platform: WINDOWS,
      comspec: 'C:\\WINDOWS\\system32\\cmd.exe',
    })
    expect(resolved).toEqual({
      file: 'C:\\WINDOWS\\system32\\cmd.exe',
      argsPrefix: ['/d', '/s', '/c', 'C:\\npm\\codex.cmd'],
      kind: 'cmd-shim',
    })
  })

  it('falls back to cmd.exe by name when COMSPEC is missing or empty', () => {
    for (const comspec of [undefined, '']) {
      const resolved = classify('C:\\npm\\codex.cmd', { platform: WINDOWS, comspec })
      expect(resolved.file).toBe('cmd.exe')
    }
  })

  it('treats .bat the same as .cmd', () => {
    expect(classify('C:\\npm\\codex.bat', { platform: WINDOWS }).kind).toBe('cmd-shim')
  })

  it('leaves a real executable alone', () => {
    expect(classify('C:\\Program Files\\codex.exe', { platform: WINDOWS })).toEqual({
      file: 'C:\\Program Files\\codex.exe',
      argsPrefix: [],
      kind: 'native',
    })
  })

  it('recognises a JavaScript entry point as its own kind', () => {
    for (const file of ['C:\\npm\\cli.js', 'C:\\npm\\cli.mjs', 'C:\\npm\\cli.cjs']) {
      expect(classify(file, { platform: WINDOWS }).kind).toBe('node-script')
    }
  })

  it('puts node in front of a script, because Windows cannot exec a .js', () => {
    // The bug this guards: `file` being the .js makes spawnSpec return something
    // unspawnable, and the failure surfaces in agent-probe as "claude missing".
    expect(classify('C:\\npm\\cli.js', { platform: WINDOWS })).toEqual({
      file: 'node',
      argsPrefix: ['C:\\npm\\cli.js'],
      kind: 'node-script',
      scriptPath: 'C:\\npm\\cli.js',
    })
  })

  it('honours an explicit node executable, for a Finder launch with none on PATH', () => {
    expect(
      classify('C:\\npm\\cli.js', { platform: WINDOWS, nodeExecutable: 'C:\\node\\node.exe' })
    ).toMatchObject({ file: 'C:\\node\\node.exe', argsPrefix: ['C:\\npm\\cli.js'] })
  })

  it('is always native on macOS, whatever the name looks like', () => {
    // A macOS file called `codex.cmd` is not a shim; the extension means nothing
    // here, and treating it as one would prepend cmd.exe on a machine with none.
    expect(classify('/usr/local/bin/codex.cmd', { platform: MAC }).kind).toBe('native')
    expect(classify('/usr/local/bin/codex', { platform: MAC })).toEqual({
      file: '/usr/local/bin/codex',
      argsPrefix: [],
      kind: 'native',
    })
  })
})

describe('parseShimTarget', () => {
  // As npm's cmd-shim writes it. Trimmed of the parts that do not matter here,
  // but the `%dp0%\node.exe` line is kept deliberately: it is quoted, it comes
  // first, and a looser pattern returns it instead of the script.
  const CMD_SHIM = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n')

  const SH_SHIM = [
    '#!/bin/sh',
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    '',
    'case `uname` in',
    '    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;',
    'esac',
    '',
    'exec node  "$basedir/../node_modules/@anthropic-ai/claude-code/cli.js" "$@"',
  ].join('\n')

  it('finds the script a Windows shim would have run, relative to the shim', () => {
    expect(
      parseShimTarget(CMD_SHIM, 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', WINDOWS)
    ).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js')
  })

  it('is not fooled by the quoted node.exe that comes before it', () => {
    const target = parseShimTarget(CMD_SHIM, 'C:\\npm\\claude.cmd', WINDOWS)
    expect(target).not.toContain('node.exe')
    expect(target?.endsWith('cli.js')).toBe(true)
  })

  it('reads the sh flavour too, resolving its .. against the shim directory', () => {
    expect(parseShimTarget(SH_SHIM, '/usr/local/bin/claude', MAC)).toBe(
      '/usr/local/node_modules/@anthropic-ai/claude-code/cli.js'
    )
  })

  /*
   * Null is the important case. This parser is written from cmd-shim's
   * documented output rather than from a shim observed coming off a real
   * Windows `npm install`, so it has to fail in the direction that degrades
   * — the caller keeps the `cmd-shim` kind, which launches correctly for
   * everything except the SDK — rather than returning a confident wrong path.
   */
  it('returns null rather than guessing when nothing matches', () => {
    expect(
      parseShimTarget('@echo off\r\nnode "%dp0%\\thing.exe" %*', 'C:\\npm\\x.cmd', WINDOWS)
    ).toBeNull()
    expect(parseShimTarget('', 'C:\\npm\\x.cmd', WINDOWS)).toBeNull()
    expect(parseShimTarget('#!/bin/sh\nexec claude "$@"', '/usr/local/bin/claude', MAC)).toBeNull()
  })
})

describe('spawnSpec', () => {
  it('puts the prefix ahead of the caller arguments, which is the whole point', () => {
    const shim = classify('C:\\npm\\codex.cmd', { platform: WINDOWS, comspec: 'cmd.exe' })
    expect(spawnSpec(shim, ['app-server'])).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\npm\\codex.cmd', 'app-server'],
    })
  })

  it('changes nothing for a native command', () => {
    const native = classify('/usr/local/bin/codex', { platform: MAC })
    expect(spawnSpec(native, ['--version'])).toEqual({
      file: '/usr/local/bin/codex',
      args: ['--version'],
    })
  })

  it('defaults to no arguments rather than requiring an empty array', () => {
    expect(spawnSpec(classify('/usr/bin/codex', { platform: MAC }))).toEqual({
      file: '/usr/bin/codex',
      args: [],
    })
  })
})

describe('sdkExecutablePath', () => {
  it('refuses an unreadable cmd shim, because the SDK spawns it without a shell', () => {
    expect(sdkExecutablePath(classify('C:\\npm\\claude.cmd', { platform: WINDOWS }))).toBeNull()
  })

  it('hands over the script a shim pointed at, never the shim itself', () => {
    const shim = classify('C:\\npm\\claude.cmd', { platform: WINDOWS })
    const withScript = withScriptPath(shim, 'C:\\npm\\node_modules\\claude-code\\cli.js')
    expect(sdkExecutablePath(withScript)).toBe('C:\\npm\\node_modules\\claude-code\\cli.js')
    /*
     * ...and the spawnable form is `node`, not cmd.exe.
     *
     * This asserted `cmd.exe` until review found that routing every launch
     * through cmd is a command-injection surface. Reading the shim tells us the
     * interpreter and the script, which is strictly more information than the
     * shim itself — so there is no reason left to go through cmd at all.
     */
    expect(spawnSpec(withScript, ['--version']).file).toBe('node')
  })

  it('gives the script rather than the interpreter for a node-script', () => {
    // `file` is `node` here, and handing the SDK `node` would be nonsense.
    expect(sdkExecutablePath(classify('C:\\npm\\cli.js', { platform: WINDOWS }))).toBe(
      'C:\\npm\\cli.js'
    )
  })

  it('hands over a real executable unchanged', () => {
    expect(sdkExecutablePath(classify('/usr/local/bin/claude', { platform: MAC }))).toBe(
      '/usr/local/bin/claude'
    )
  })
})

/**
 * The injection this phase closed, found in review before it shipped.
 *
 * Node quotes an argument only when it contains a space or a quote. `a&calc`
 * has neither, so it reached `cmd.exe` bare, cmd read the `&` as a separator,
 * and `calc` ran. Agent output reaches these arguments — a file path, a plugin
 * name, a project directory — so this was arbitrary execution on Windows.
 */
describe('cmd.exe is not on the path for a shim we can read', () => {
  const shim = classify('C:\\npm\\claude.cmd', { platform: WINDOWS, comspec: 'cmd.exe' })

  it('promotes a readable shim to node, removing cmd from the launch entirely', () => {
    const promoted = withScriptPath(shim, 'C:\\npm\\node_modules\\claude\\cli.js')
    expect(promoted.kind).toBe('node-script')
    expect(promoted.file).toBe('node')
    expect(spawnSpec(promoted, ['--version'])).toEqual({
      file: 'node',
      args: ['C:\\npm\\node_modules\\claude\\cli.js', '--version'],
    })
  })

  it('lets metacharacters through harmlessly once cmd is gone', () => {
    // The C runtime has no metacharacters, so this is just an argument.
    const promoted = withScriptPath(shim, 'C:\\npm\\cli.js')
    expect(spawnSpec(promoted, ['C:\\R&D\\project']).args).toContain('C:\\R&D\\project')
  })

  it('still hands the SDK the script rather than the interpreter', () => {
    const promoted = withScriptPath(shim, 'C:\\npm\\cli.js')
    expect(sdkExecutablePath(promoted)).toBe('C:\\npm\\cli.js')
  })
})

describe('an unreadable shim refuses rather than guessing', () => {
  /*
   * VS Code's `code.cmd` is hand-written rather than an npm shim, so
   * `parseShimTarget` cannot reduce it and cmd.exe stays in the path. There is
   * no safe general escaping available there — Node's conditional quoting
   * breaks `^`-escaping for exactly the arguments that need it — so this fails
   * closed. A verbatim command line is the real fix and needs a Windows machine
   * to verify against.
   */
  const shim = classify('C:\\VS Code\\bin\\code.cmd', { platform: WINDOWS, comspec: 'cmd.exe' })

  it.each(['C:\\R&D\\proj', 'a|b', 'a>b', 'a%USERNAME%b', 'a^b', 'a(b)', 'a!b', 'a"b'])(
    'refuses %s',
    (argument) => {
      expect(() => spawnSpec(shim, [argument])).toThrow(UnsafeCommandArgument)
    }
  )

  it('allows an ordinary path, including one with spaces', () => {
    expect(() => spawnSpec(shim, ['C:\\Users\\me\\my project'])).not.toThrow()
    expect(spawnSpec(shim, ['C:\\Users\\me\\my project']).args).toEqual([
      '/d',
      '/s',
      '/c',
      'C:\\VS Code\\bin\\code.cmd',
      'C:\\Users\\me\\my project',
    ])
  })

  it('never refuses on macOS, where cmd.exe does not exist', () => {
    const native = classify('/usr/local/bin/code', { platform: MAC })
    expect(() => spawnSpec(native, ['/p/R&D/proj', 'a|b'])).not.toThrow()
  })
})
