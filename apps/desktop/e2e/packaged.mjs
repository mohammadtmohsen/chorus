import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './harness.mjs'

/**
 * Drives the app a user would install, rather than the one the specs drive.
 *
 * The 26 specs run `electron .` against `out/`, which is the same source and a
 * different program: `out/` is a directory tree, and the bundle is an asar with
 * two things deliberately outside it — `better-sqlite3`, which is native and
 * cannot be loaded from an archive, and the Claude SDK, which resolves its own
 * files at runtime. Nothing in the suite touched either arrangement, so for
 * several releases "all 26 passed" said nothing about whether the thing on the
 * DMG could open its own database.
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

const APP = new URL('..', import.meta.url).pathname
const BUNDLE = join(APP, 'release/mac-arm64/Chorus.app/Contents/MacOS/Chorus')

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
