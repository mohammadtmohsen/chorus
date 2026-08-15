/**
 * Phase 4 spike. Throwaway.
 *
 * The one thing unit tests cannot show: quit the app with panels open and a
 * height dragged, start it again, and see whether it comes back. Everything in
 * between — the store, the debounce, the write, the parse, the reconcile — is
 * exercised by doing it rather than by asserting each link.
 *
 * Usage: pnpm --filter @chorus/desktop run build && node build/terminal-persist-probe.mjs
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from '../e2e/harness.mjs'

const checks = []
const check = (ok, label, detail) => {
  checks.push(ok)
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const press = (app, key, { meta = false } = {}) =>
  app.evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, metaKey: ${String(meta)}, bubbles: true, cancelable: true }))
    return true
  })()`)

const ready = async (app) => {
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
  await app.until(`document.querySelectorAll('.pane').length > 0`, { timeout: 120_000 })
  await app.settle()
}

/** The same user data across both launches; that is the whole point. */
const userData = mkdtempSync(join(tmpdir(), 'chorus-terminal-persist-'))

async function main() {
  const first = await launch({ userData, keepData: true })
  try {
    await ready(first)

    await press(first, 'j', { meta: true })
    await first.until(`document.querySelector('.terminal-panel--session') !== null`, {
      timeout: 30_000,
    })
    // `[data-rail-terminal]`, not `.activity-bar button`: the activity bar became
    // the QuickRail in readable-control-rail-2026-08-13 and this spike was never
    // updated, so it threw on `undefined.click()` rather than reporting anything.
    await first.evaluate(`(() => {
      document.querySelector('[data-rail-terminal]').click()
      return true
    })()`)
    await first.until(`document.querySelector('.terminal-panel--global') !== null`, {
      timeout: 30_000,
    })
    check(true, 'both panels open in the first run')

    // Drag the global panel to a height nothing would default to.
    await first.evaluate(`(() => {
      const grip = document.querySelector('.terminal-panel--global .terminal-grip')
      const box = document.querySelector('.terminal-panel--global').getBoundingClientRect()
      grip.dispatchEvent(new PointerEvent('pointerdown', {
        clientY: box.top, bubbles: true, cancelable: true }))
      document.dispatchEvent(new PointerEvent('pointermove', { clientY: box.top - 90, bubbles: true }))
      document.dispatchEvent(new PointerEvent('pointerup', { clientY: box.top - 90, bubbles: true }))
      return true
    })()`)
    await first.settle()
    const draggedHeight = Number(
      await first.evaluate(
        `String(Math.round(document.querySelector('.terminal-panel--global').getBoundingClientRect().height))`
      )
    )
    check(draggedHeight > 260, 'the global panel can be dragged taller', `${draggedHeight}px`)

    // The layout write is debounced; give it more than its window.
    await new Promise((r) => setTimeout(r, 1_200))
  } finally {
    await first.quit()
  }

  const second = await launch({ userData, keepData: true })
  try {
    await ready(second)

    const globalBack = await second.evaluate(
      `String(document.querySelector('.terminal-panel--global') !== null)`
    )
    check(globalBack === 'true', 'the global panel is open again after a relaunch')

    const sessionBack = await second.evaluate(
      `String(document.querySelector('.terminal-panel--session') !== null)`
    )
    check(sessionBack === 'true', "and so is the session's")

    const restoredHeight = Number(
      await second.evaluate(
        `String(Math.round(document.querySelector('.terminal-panel--global').getBoundingClientRect().height))`
      )
    )
    check(
      Math.abs(restoredHeight - 240) > 20,
      'at the height it was dragged to, not the default',
      `${restoredHeight}px`
    )

    // A restored panel is a live terminal, not a picture of one.
    await second.until(
      `(document.querySelector('.terminal-panel--global .xterm-rows')?.innerText ?? '').trim().length > 0`,
      { timeout: 30_000 }
    )
    check(true, 'and it is a working shell, not a restored screenshot')
  } finally {
    await second.quit()
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
