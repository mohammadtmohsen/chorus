import { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureBuilt, launch } from './harness.mjs'

/**
 * The chrome: the pane's tab strip, the split target, and the terminal's title.
 *
 * Same reason `shots-rail.mjs` exists and the same shape: no pass, no fail, just
 * the real renderer out of `out/` driven over the debugger protocol so a phase's
 * "does it look like the golden" can be answered by two files side by side
 * instead of by a sentence claiming it does.
 *
 *   node apps/desktop/e2e/shots-transcript.mjs --out docs/plans/…/visuals --name 01-message-row
 *
 * **A real exchange, not a fixture.** The rows being judged are the ones the
 * reducer builds from a real turn — an avatar, a name, a time that came off the
 * event's `createdAt`, and a reply that streamed. Faking the transcript would
 * photograph markup rather than the thing that ships, which is precisely the gap
 * this plan exists to close.
 */

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? fallback : args[at + 1]
}

const OUT = option(
  'out',
  new URL('../../../docs/plans/transcript-design-match-2026-08-13/visuals', import.meta.url)
    .pathname
)
const NAME = option('name', '05-chrome')
const WIDTH = Number(option('width', '1440'))
const HEIGHT = Number(option('height', '900'))
ensureBuilt()
mkdirSync(OUT, { recursive: true })

const app = await launch()
try {
  await app.until(`document.querySelectorAll('.pane').length > 0`)
  await app.bringToFront()
  await app.viewport(WIDTH, HEIGHT)
  await app.settle()

  /*
   * No turn here: the composer is the subject, and an agent working would put a
   * Stop button where Send belongs. Everything below drives controls only.
   */
  const chrome = await app.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const out = {}

    // The pane's own close is gone; the tab keeps its own.
    out.paneCloses = document.querySelectorAll('.workspace-pane-close').length
    // The tab's own close is a sibling of the tab button, not a child of it.
    // The first run of this asserted on the wrong selector and read 0, which
    // looks exactly like "the last way to close a tab is gone".
    out.tabCloses = document.querySelectorAll('.workspace-tab-close').length

    // Opening the session terminal is what puts a title on screen.
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'j', metaKey: true, bubbles: true, cancelable: true,
    }))
    await wait(600)
    const head = document.querySelector('.terminal-title, .terminal-head strong, .terminal-panel-title')
    out.terminalTitle = head?.textContent ?? null
    out.tabTitle = document.querySelector('.workspace-tab-title')?.textContent ?? null

    // The unread badge and the split target belong to the rail work; this only
    // records that they are here, since the plan lists them as already shipped.
    out.railBadgeExists = !!document.querySelector('.rail-badge') || 'none unread right now'
    out.unreportedTooltips = [...document.querySelectorAll('.rail-window-percent')]
      .filter((el) => el.textContent.trim() === '—')
      .map((el) => el.getAttribute('title'))
    return out
  })()`)
  console.log(JSON.stringify(chrome, null, 2))
  await app.settle()

  await app.send('Page.captureScreenshot', { format: 'png' })
  await app.settle()
  const { data } = await app.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  const bytes = Buffer.from(data, 'base64')
  const file = join(OUT, `${NAME}.png`)
  writeFileSync(file, bytes)

  console.log(
    `${file}  ${String(bytes.readUInt32BE(16))}×${String(bytes.readUInt32BE(20))}  ${String(bytes.length)} bytes`
  )
} finally {
  await app.quit()
}
