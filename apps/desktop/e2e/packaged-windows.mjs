import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './harness.mjs'

/**
 * The Windows counterpart to `packaged.mjs`, and deliberately a second file.
 *
 * Teaching the macOS verifier to accept both layouts was the other option and it
 * is the worse one: the two bundles differ in almost every particular the
 * verifier exists to check — `Chorus.app/Contents/Resources/app.asar.unpacked`
 * against `win-unpacked/resources/app.asar.unpacked`, a `spawn-helper` that only
 * exists on Unix against four PE files that only exist on Windows — so a shared
 * script would be two scripts wearing one name, with every check wrapped in a
 * platform branch. The first time one of those branches was wrong, it would
 * report a pass for a bundle it had not looked at.
 *
 * ## What this proves, and what it does not
 *
 * The same four questions `packaged.mjs` asks — does the bundle start, does the
 * native module load from outside the asar, is the renderer served from inside
 * it, does an agent actually start — plus the native-file inventory that is
 * Windows-specific.
 *
 * It proves nothing about the **installer**. This drives `win-unpacked`, which
 * is what electron-builder lays out before NSIS wraps it. Install, upgrade,
 * uninstall and the data that must survive them are Phase 6, they need clean
 * VMs, and no part of this file should be read as covering them.
 */

const APP = new URL('..', import.meta.url).pathname
const UNPACKED_ROOT = join(APP, 'release/win-unpacked')
const BUNDLE = join(UNPACKED_ROOT, 'Chorus.exe')
const UNPACKED = join(UNPACKED_ROOT, 'resources/app.asar.unpacked')

/**
 * The binaries that must be outside the asar, named individually.
 *
 * A `.node` cannot be `dlopen`'d from inside an archive, and node-pty's Windows
 * prebuild is not one file but four: `pty.node` and `conpty.node` are the
 * bindings, `winpty.dll` is the library `pty.node` links against, and
 * `winpty-agent.exe` is a separate process it spawns. Miss any one and the
 * failure arrives at the first `⌘J`, as a terminal that never opens.
 *
 * Listed rather than globbed, because a glob that matches nothing passes.
 */
const REQUIRED = [
  ['node_modules/better-sqlite3/prebuilds/win32-x64.node', 'the SQLite binding'],
  ['node_modules/node-pty/prebuilds/win32-x64/pty.node', "node-pty's binding"],
  ['node_modules/node-pty/prebuilds/win32-x64/conpty.node', 'the ConPTY binding'],
  ['node_modules/node-pty/prebuilds/win32-x64/winpty.dll', 'the winpty library'],
  ['node_modules/node-pty/prebuilds/win32-x64/winpty-agent.exe', "winpty's agent process"],
]

/**
 * Symbols and vendored source must **not** ship.
 *
 * ~28 MB of `.pdb` beside the prebuilds and the whole `deps/winpty` C++ tree,
 * excluded in `electron-builder.yml`. Asserted here because a `files:` exclusion
 * is easy to break silently — the installer simply gets larger, and nobody reads
 * an installer's size.
 */
const FORBIDDEN = [
  ['node_modules/node-pty/prebuilds/win32-x64/pty.pdb', 'debug symbols'],
  ['node_modules/node-pty/deps', 'the vendored winpty source'],
]

function checkNativeFiles(check) {
  for (const [relative, what] of REQUIRED) {
    check(existsSync(join(UNPACKED, relative)), `${what} is in the bundle, outside the asar`)
  }
  for (const [relative, what] of FORBIDDEN) {
    check(!existsSync(join(UNPACKED, relative)), `${what} did not ship`)
  }
}

/**
 * The VSIX, which lives beside the asar rather than inside it.
 *
 * `code --install-extension` needs a real path it can open and an asar is not a
 * directory. Checked here because a missing VSIX makes the editor integration
 * quietly unavailable rather than broken — the pill reports "not running" and
 * nothing says why.
 */
function checkVsix(check) {
  const resources = join(UNPACKED_ROOT, 'resources')
  check(existsSync(join(resources, 'chorus-vscode.vsix')), 'the VS Code extension shipped')
  check(
    existsSync(join(resources, 'chorus-vscode.vsix.version')),
    'the extension version file shipped, so Settings can compare'
  )
}

async function main() {
  if (!existsSync(BUNDLE)) {
    console.error(`no packaged app at ${BUNDLE}\n  run: pnpm package`)
    process.exit(1)
  }

  const checks = []
  const check = (ok, label) => {
    checks.push({ ok, label })
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  }

  // Before the app boots: a bad bundle should say so in milliseconds rather
  // than after a three-minute agent handshake.
  checkNativeFiles(check)
  checkVsix(check)

  const app = await launch({ executable: BUNDLE })
  try {
    await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
    check(true, 'the bundle starts and serves its renderer')

    await app.until(`document.querySelectorAll('.pane').length > 0`, { timeout: 120_000 })
    check(true, 'the event store opens, so better-sqlite3 loaded')

    await app.settle()
    check(
      (await app.evaluate(`document.querySelector('.composer textarea') !== null`)) === true,
      'the composer is there to type into'
    )

    /*
     * A terminal is the check with no macOS equivalent worth reusing. ConPTY is
     * a different implementation from the Unix path — different binding,
     * different agent process — and `winpty.dll` being present on disk says
     * nothing about whether it loads. Opening one is the only thing that does.
     */
    await app.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }))`
    )
    await app.until(`document.querySelector('.xterm') !== null`, { timeout: 60_000 })
    check(true, 'a terminal opens, so ConPTY and winpty loaded')

    await app.until(
      `Array.from(document.querySelectorAll('.entry')).some(e => /joined/i.test(e.innerText))`,
      { timeout: 180_000 }
    )
    check(true, 'an agent joins, so the SDK found its own files')
  } finally {
    await app.quit()
  }

  const failed = checks.filter((c) => !c.ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
