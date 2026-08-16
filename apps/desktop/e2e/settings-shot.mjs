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

  /*
   * The first screen, not Settings.
   *
   * With no agent, `startConversation` throws, `sessions` stays empty and the
   * workspace never mounts — so there is no rail and no Settings sheet to open.
   * An earlier version of this waited a minute for `[data-rail-settings]` and
   * failed, which is how that was discovered.
   */
  await app.until(`document.querySelector('.empty-inner') !== null`, {
    timeout: 90_000,
    label: 'the first screen rendered',
  })
  // Two CLIs are probed and each has to fail; give it room.
  await wait(15_000)

  const said = await app.evaluate(`(() => {
    const help = document.querySelector('.empty-help')
    return {
      guidance: help === null ? null : help.innerText,
      rawError: document.querySelector('.notice--bad')?.innerText ?? null,
    }
  })()`)
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
  if (said.guidance === null || !said.guidance.includes('npm install -g')) {
    console.error('FAILED: no CLI found, and nothing on screen says what to install')
    process.exit(1)
  }
  console.log('the first screen says what to install')
} finally {
  await app.quit()
}
