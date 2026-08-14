import { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureBuilt, launch } from './harness.mjs'

/**
 * The composer's bottom row, and proof that each control does its job.
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
const NAME = option('name', '04-composer')
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
  const opened = await app.evaluate(
    `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const out = {}
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    // The ` +
      ` opens a menu, and the menu lists what can be added.
    const plus = document.querySelector('.composer-more')
    out.plusExpandedBefore = plus.getAttribute('aria-expanded')
    click(plus)
    await wait(120)
    out.plusExpandedAfter = plus.getAttribute('aria-expanded')
    out.addItems = [...document.querySelectorAll('.composer-menu [data-menu-item]')]
      .map((b) => b.dataset.menuItem)
    out.focusedOnOpen = document.activeElement?.dataset?.menuItem ?? null

    // Escape closes it and hands focus back to the control that opened it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(120)
    out.menuAfterEscape = document.querySelectorAll('.composer-menu').length
    out.focusReturned = document.activeElement === plus

    // One primary action, and it is Send rather than Stop with an idle agent.
    out.sends = document.querySelectorAll('.send').length
    out.stops = document.querySelectorAll('.send--stop').length
    out.placeholder = document.querySelector('.composer textarea').placeholder

    // The four session actions, in the row where the work happens.
    out.actions = [...document.querySelectorAll('.composer-tools button')]
      .map((b) => b.getAttribute('aria-label'))
      .filter(Boolean)
    out.endArmed = document.querySelector('.composer-end')?.dataset.armed ?? 'idle'

    // Summary opens its panel from here, not only from the drawer's menu.
    click([...document.querySelectorAll('.composer-tools button')]
      .find((b) => b.getAttribute('aria-label') === 'Summary'))
    await wait(400)
    out.summaryOpen = !!document.querySelector('.sheet[aria-label], .summary-sheet')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(250)

    // The cast chips are gone: who answers is one of the things the settings
    // control decides, for both agents at once.
    out.chips = document.querySelectorAll('.composer-cast-who').length

    // The usage block must fit inside the rail rather than under its border.
    const rail = document.querySelector('.quick-rail').getBoundingClientRect()
    out.railWidth = Math.round(rail.width)
    // Where the active tab ends and the pane begins: a connected tab needs the
    // first to overlap the second, not to hover above it.
    out.tabJoin = (() => {
      const tab = document.querySelector('.workspace-tab[data-active="true"]')
      const body = document.querySelector('.workspace-pane-content')
      const strip = document.querySelector('.workspace-tab-strip')
      const scroller = document.querySelector('.workspace-tabs')
      if (!tab || !body) return null
      return {
        tabBottom: Math.round(tab.getBoundingClientRect().bottom),
        bodyTop: Math.round(body.getBoundingClientRect().top),
        stripBottom: Math.round(strip.getBoundingClientRect().bottom),
        scrollerBottom: Math.round(scroller.getBoundingClientRect().bottom),
        scrollerOverflow: getComputedStyle(scroller).overflowY,
        // The tab must start past the body's corner radius, or its bottom edge
        // meets a curve rather than a straight edge.
        tabInset: Math.round(
          tab.getBoundingClientRect().left - body.getBoundingClientRect().left
        ),
        bodyRadius: getComputedStyle(body).borderTopLeftRadius,
      }
    })()
    // Nothing a tile hangs off itself may reach the tile above or below it.
    out.tileGaps = (() => {
      const tiles = [...document.querySelectorAll('.quick-rail-group > li')]
      return tiles.slice(1).map((li, i) =>
        Math.round(li.getBoundingClientRect().top - tiles[i].getBoundingClientRect().bottom)
      )
    })()
    out.usageOverflow = [...document.querySelectorAll('.rail-usage, .rail-account, .rail-meter')].map(
      (el) => Math.round(el.getBoundingClientRect().right - rail.right)
    )

    /*
     * The box is the message's height, not the frame's.
     *
     * Empty, typed into, and emptied again — the third reading is the one that
     * catches a grow-only field, which is what scrollHeight gives you without
     * the reset to auto before measuring.
     */
    const box = document.querySelector('.composer textarea')
    const type = (text) => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
        .set.call(box, text)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    }
    out.emptyBox = Math.round(box.getBoundingClientRect().height)
    out.emptyComposer = Math.round(document.querySelector('.composer').getBoundingClientRect().height)
    type(['one', 'two', 'three', 'four', 'five'].join(String.fromCharCode(10)))
    await wait(150)
    out.grownBox = Math.round(box.getBoundingClientRect().height)
    type('')
    await wait(150)
    out.shrunkBox = Math.round(box.getBoundingClientRect().height)

    // The sliders are the one route to the cast now, so what matters is that it
    // opens on the settings and that both agents are on it.
    click(document.querySelector('.composer-settings'))
    await wait(250)
    out.settingsView = document.querySelector('.session-menu')?.dataset.view ?? null
    out.agentsOffered = [...document.querySelectorAll('.session-settings-agents button')].map(
      (b) => b.textContent.trim()
    )

    // Closed again, so the photograph is of the composer rather than of a menu
    // over it. The menus have their own captures if they ever need one.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(200)
    out.menusLeftOpen =
      document.querySelectorAll('.session-menu, .composer-menu').length
    return out
  })()`
  )
  console.log(JSON.stringify(opened, null, 2))
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
