/**
 * `⌘K` clears the terminal, and stays cleared. Throwaway.
 *
 * The second half is the point. Scrollback lives in a headless mirror in main,
 * and that mirror is what a remount restores from — so clearing only the view
 * looks right until you close the panel and open it again, and every cleared
 * line is back.
 *
 * Usage: pnpm --filter @chorus/desktop run build && node build/terminal-clear-probe.mjs
 */

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

const screen = (app) =>
  app.evaluate(
    `document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '(no panel)'`
  )

const MARKER = 'chorus-clear-me-9317'

async function main() {
  const app = await launch({})
  try {
    await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
    await app.until(`document.querySelectorAll('.pane').length > 0`, { timeout: 120_000 })
    await app.settle()

    await press(app, 'j', { meta: true })
    await app.until(`document.querySelector('.terminal-panel--session .xterm-rows') !== null`, {
      timeout: 30_000,
    })

    // Put something on screen that could not be there by accident, typed the
    // way a person types it: real key events through CDP, not a synthetic
    // InputEvent poked at xterm's hidden textarea (which it ignores).
    await app.evaluate(`(() => {
      document.querySelector('.terminal-panel--session .xterm-helper-textarea').focus()
      return true
    })()`)
    await app.send('Input.insertText', { text: `echo ${MARKER}` })
    for (const type of ['keyDown', 'keyUp']) {
      await app.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
    }
    await app.until(
      `(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '').includes('${MARKER}')`,
      { timeout: 30_000 }
    )
    check(true, 'the marker is on screen')

    // ⌘K, aimed where a person's keystroke would land.
    await app.evaluate(`(() => {
      const ta = document.querySelector('.terminal-panel--session .xterm-helper-textarea')
      ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k', metaKey: true, bubbles: true, cancelable: true }))
      return true
    })()`)
    await app.settle()

    const afterClear = await screen(app)
    check(!afterClear.includes(MARKER), 'and gone after ⌘K', JSON.stringify(afterClear.trim().slice(-40)))

    /*
     * Close and reopen the panel. This unmounts the view and re-attaches, so the
     * screen is rebuilt from main's mirror — the copy that clearing only the view
     * would have left untouched.
     */
    await press(app, 'j', { meta: true })
    await app.until(`document.querySelector('.terminal-panel--session') === null`, {
      timeout: 30_000,
    })
    await press(app, 'j', { meta: true })
    await app.until(`document.querySelector('.terminal-panel--session .xterm-rows') !== null`, {
      timeout: 30_000,
    })
    await app.settle()

    const restored = await screen(app)
    check(
      !restored.includes(MARKER),
      'still gone after closing and reopening the panel',
      JSON.stringify(restored.trim().slice(-40))
    )

    // And the shell is untouched — clearing is a display action.
    const alive = await app.evaluate(
      `window.chorus.describeTerminal({ ref: { scope: 'session', conversationId: document.querySelector('.pane').dataset.conversation, id: document.querySelector('.terminal-panel--session').dataset.terminalId } }).then(d => JSON.stringify(d))`
    )
    check(JSON.parse(alive)?.running === true, 'the shell is still running', alive)
  } finally {
    await app.quit()
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
