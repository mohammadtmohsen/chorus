import { fileURLToPath } from 'node:url'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './harness.mjs'

/**
 * Drives the app a user would install, rather than the one the specs drive.
 *
 * The specs run `electron .` against `out/`, which is the same source and a
 * different program: `out/` is a directory tree, and the bundle is an asar with
 * two things deliberately outside it — `better-sqlite3`, which is native and
 * cannot be loaded from an archive, and the Claude SDK, which resolves its own
 * files at runtime. Nothing in the suite touched either arrangement, so for
 * several releases a green suite said nothing about whether the thing on the
 * DMG could open its own database.
 *
 * The count used to be written here — "the 26 specs", then wrong by six. A total
 * in prose is a number nobody updates when they add a spec, so it is gone rather
 * than corrected.
 *
 * This asks the four questions the suite cannot:
 *
 *  1. does the bundle start at all,
 *  2. does the native module load from outside the asar,
 *  3. does the renderer get built and served from inside it,
 *  4. does a real session start — which needs the SDK to find its own files.
 *
 * Deliberately not a spec in `specs.mjs`. Those run against one build made once;
 * this needs `pnpm package`, which is minutes and a code-signing step, and it
 * belongs at a release rather than on every change.
 */

// See the note in `packaged-windows.mjs`: `.pathname` keeps its leading
// slash. This verifier is macOS-only, but the two should not differ here.
const APP = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = join(APP, 'release/mac-arm64/Chorus.app/Contents/MacOS/Chorus')
const UNPACKED = join(APP, 'release/mac-arm64/Chorus.app/Contents/Resources/app.asar.unpacked')

/**
 * node-pty's `spawn-helper` ships mode 0644 and electron-builder copies the mode
 * through verbatim, so without the repair in `build/sign-adhoc.cjs` the packaged
 * terminal dies with a bare `posix_spawnp failed.` — measured on 2026-08-12, not
 * inferred.
 *
 * Checked as a file rather than by driving a terminal because the failure is in
 * the packaging arrangement, and a file check catches it before the app boots. A
 * node-pty bump that reorganises `prebuilds/` fails here too, which is the point:
 * the repair hard-codes a path, and a silent miss would restore the bug.
 */
function checkSpawnHelper(check) {
  const helper = join(
    UNPACKED,
    'node_modules/node-pty/prebuilds',
    `darwin-${process.arch}`,
    'spawn-helper'
  )
  if (!existsSync(helper)) {
    check(false, `spawn-helper is in the bundle (looked in ${helper})`)
    return
  }
  check(true, 'spawn-helper is in the bundle, outside the asar')
  check(
    (statSync(helper).mode & 0o111) !== 0,
    'spawn-helper is executable, so a PTY can actually spawn'
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

  // Before the app boots: nothing here needs a window, and a bad bundle should
  // say so in milliseconds rather than after a three-minute agent handshake.
  checkSpawnHelper(check)

  const app = await launch({ executable: BUNDLE })
  try {
    // A window at all means the asar was read and the renderer was served.
    await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
    check(true, 'the bundle starts and serves its renderer')

    /*
     * A pane means the runtime opened SQLite and started a conversation, which
     * is the native module loading from outside the asar. It is the check most
     * likely to fail on a packaging change and the one with no other coverage.
     */
    await app.until(`document.querySelectorAll('.pane').length > 0`, { timeout: 120_000 })
    check(true, 'the event store opens, so the native module loaded')

    await app.settle()
    check(
      (await app.evaluate(`document.querySelector('.composer textarea') !== null`)) === true,
      'the composer is there to type into'
    )

    /*
     * `session.started` is the SDK resolving its own files at runtime — the
     * other thing kept outside the asar. An agent that cannot start leaves the
     * card without a voice, which no amount of renderer testing would show.
     */
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
