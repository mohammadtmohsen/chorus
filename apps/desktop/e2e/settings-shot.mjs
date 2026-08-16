import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { launch, wait } from './harness.mjs'

/**
 * What a new machine actually sees in Settings.
 *
 * Written for the Windows probe, where the runner genuinely has no `codex` or
 * `claude` before the install step — the one condition that cannot be staged on
 * a developer's Mac, because `executableCandidates` lists `~/.local/bin`,
 * `/opt/homebrew/bin` and `/usr/local/bin` statically and a CLI installed in any
 * of them is found however `PATH` is trimmed.
 *
 * Drives the packaged bundle rather than `out/`, so what is photographed is what
 * a user would install.
 */
const APP = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = join(APP, 'release/win-unpacked/Chorus.exe')
const OUT = join(APP, 'release/shots')

const app = await launch({ executable: BUNDLE })
try {
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })

  // Settings is reachable from the rail whether or not a session ever opened,
  // which matters here: with no CLI there is no session.
  await app.until(`document.querySelector('[data-rail-settings]') !== null`, {
    timeout: 60_000,
    label: 'the rail rendered',
  })
  await app.evaluate(`(document.querySelector('[data-rail-settings]').click(), true)`)
  await app.until(`document.querySelectorAll('.cast-member').length > 0`, {
    timeout: 60_000,
    label: 'the agents block rendered',
  })
  // The probe spawns two CLIs and waits on each; give it room to fail properly.
  await wait(15_000)

  const said =
    await app.evaluate(`(() => Array.from(document.querySelectorAll('.cast-entry')).map(e => ({
    name: e.querySelector('.cast-name')?.textContent ?? '',
    state: e.querySelector('.cast-version')?.textContent ?? '',
    help: e.querySelector('.cast-help')?.innerText ?? null,
  })))()`)
  console.log(JSON.stringify(said, null, 1))

  mkdirSync(OUT, { recursive: true })
  const { data } = await app.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  writeFileSync(join(OUT, 'settings-no-cli.png'), Buffer.from(data, 'base64'))
  console.log(`shot: ${join(OUT, 'settings-no-cli.png')}`)

  // The whole point of running this here: guidance a person can act on, on a
  // machine that genuinely has nothing installed.
  const helpful = said.every((row) => (row.help ?? '').length > 0)
  if (!helpful) {
    console.error('FAILED: an agent reported as absent with no advice beside it')
    process.exit(1)
  }
  console.log('every absent agent carried advice')
} finally {
  await app.quit()
}
