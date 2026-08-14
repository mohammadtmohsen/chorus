import { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureBuilt, launch, wait } from './harness.mjs'

/**
 * A photograph of the transcript, for the plan that is rebuilding it.
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
const NAME = option('name', '01-message-row')
const WIDTH = Number(option('width', '1440'))
const HEIGHT = Number(option('height', '900'))
const ASK = option(
  'ask',
  'In one short sentence, say what a transcript is. No preamble, no list, no code.'
)

const say = (page, text) =>
  page.evaluate(`(() => {
    const ta = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      .set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.composer').requestSubmit()
    return true
  })()`)

ensureBuilt()
mkdirSync(OUT, { recursive: true })

const app = await launch()
try {
  await app.until(`document.querySelectorAll('.pane').length > 0`)
  await app.bringToFront()
  await app.viewport(WIDTH, HEIGHT)
  await app.settle()

  await say(app, ASK)
  // The question is a row the moment it is sent; the answer is what takes time.
  await app.until(`document.querySelectorAll('.entry--user').length > 0`, { timeout: 30_000 })
  await app.until(
    `Array.from(document.querySelectorAll('.entry--message'))
       .some((e) => !e.classList.contains('entry--user') && e.dataset.status === 'complete')`,
    { timeout: 180_000, label: 'an agent finished a reply' }
  )
  // Long enough for the typewriter to run out, so the capture is of a settled
  // row rather than of one still being written into.
  await wait(2_500)
  await app.settle()

  const rows = await app.evaluate(`(() => {
    const first = document.querySelector('.entry--message')
    const avatar = first?.querySelector('.entry-avatar')?.getBoundingClientRect() ?? null
    const said = first?.querySelector('.said')?.getBoundingClientRect() ?? null
    return {
      entries: document.querySelectorAll('.entry').length,
      times: Array.from(document.querySelectorAll('.entry-time')).map((t) => t.textContent),
      avatars: document.querySelectorAll('.entry-avatar').length,
      rails: document.querySelectorAll('.rail').length,
      // The body starts beside the face and below the name — the two numbers
      // that say this is a row rather than a bubble with a label.
      clearsAvatar: avatar !== null && said !== null ? Math.round(said.left - avatar.right) : null,
      belowHead: avatar !== null && said !== null ? Math.round(said.top - avatar.top) : null,
    }
  })()`)

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
  console.log(JSON.stringify(rows, null, 2))
} finally {
  await app.quit()
}
