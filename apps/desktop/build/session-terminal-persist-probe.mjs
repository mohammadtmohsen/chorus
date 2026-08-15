/**
 * Phase 0 spike, for `more-than-one-shell-2026-08-14`. Throwaway.
 *
 * **Why `terminal-persist-probe.mjs` was not enough**, which is the whole point
 * of this file. That probe opens the session panel, then opens *and drags the
 * global one*, then quits. The global panel's height handler calls
 * `onCommitLayout` (`Workspace.tsx:380`), which writes the **entire** snapshot —
 * so the session panel it had opened a moment earlier was persisted as a side
 * effect of an unrelated commit. Six green checks, and not one of them exercised
 * the debounced subscription in `App.tsx` that is supposed to carry terminal
 * state to disk.
 *
 * That subscription's `equalityFn` never listed `terminals` or `globalTerminal`,
 * so a change to either compared *equal* and the listener never fired. Every
 * terminal action except a global height drag was silently not persisted.
 *
 * This probe touches the **session** terminal and nothing else: open it, drag
 * it, quit, relaunch. No pane drag, no sidebar resize, no reorder, no global
 * panel — nothing with its own write path. It fails on the code as shipped in
 * 0.14.0 and passes with the `sameWorkspaceSnapshot` fix.
 *
 * Usage: pnpm --filter @chorus/desktop run build && node build/session-terminal-persist-probe.mjs
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

const panelHeight = (app, variant) =>
  app
    .evaluate(
      `String(Math.round(
        document.querySelector('.terminal-panel--${variant}')?.getBoundingClientRect().height ?? 0
      ))`
    )
    .then(Number)

/** The same user data across both launches; that is the whole point. */
const userData = mkdtempSync(join(tmpdir(), 'chorus-session-terminal-persist-'))

/** Far enough from the 212px default that a default cannot be mistaken for it. */
const DRAG_BY = 120

async function main() {
  const first = await launch({ userData, keepData: true })
  let dragged = 0
  try {
    await ready(first)

    await press(first, 'j', { meta: true })
    await first.until(`document.querySelector('.terminal-panel--session') !== null`, {
      timeout: 30_000,
    })
    check(true, 'the session panel opens on ⌘J')

    // Nothing else is touched from here on. No pane drag, no sidebar, no global
    // panel — every one of those has its own `commitLayout` path and would
    // persist the terminal state for us, which is the flaw being avoided.
    await first.evaluate(`(() => {
      const grip = document.querySelector('.terminal-panel--session .terminal-grip')
      const box = document.querySelector('.terminal-panel--session').getBoundingClientRect()
      grip.dispatchEvent(new PointerEvent('pointerdown', {
        clientY: box.top, bubbles: true, cancelable: true }))
      document.dispatchEvent(new PointerEvent('pointermove', { clientY: box.top - ${String(DRAG_BY)}, bubbles: true }))
      document.dispatchEvent(new PointerEvent('pointerup', { clientY: box.top - ${String(DRAG_BY)}, bubbles: true }))
      return true
    })()`)
    await first.settle()

    dragged = await panelHeight(first, 'session')
    check(dragged > 280, 'and can be dragged taller', `${String(dragged)}px`)

    const globalOpen = await first.evaluate(
      `String(document.querySelector('.terminal-panel--global') !== null)`
    )
    check(globalOpen === 'false', 'the global panel was never opened', 'nothing else can commit')

    // The layout write is debounced at 180ms; give it well over its window.
    await new Promise((r) => setTimeout(r, 1_200))
  } finally {
    await first.quit()
  }

  const second = await launch({ userData, keepData: true })
  try {
    await ready(second)

    const back = await second.evaluate(
      `String(document.querySelector('.terminal-panel--session') !== null)`
    )
    check(back === 'true', 'the session panel is open again after a relaunch')

    const restored = await panelHeight(second, 'session')
    check(
      back === 'true' && Math.abs(restored - dragged) <= 4,
      'at the height it was dragged to, not the default',
      `${String(restored)}px, wanted ${String(dragged)}px`
    )
  } finally {
    await second.quit()
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
