/**
 * The reported bug: "trying to write on terminal but it's focus in main input".
 *
 * Throwaway. Reproduces it as a user hits it — click the terminal's own output,
 * then type — and checks the caret is still in the shell rather than in the
 * message box.
 *
 * Usage: pnpm --filter @chorus/desktop run build && node build/terminal-focus-probe.mjs
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

/** Where the caret is, named the way a person would describe it. */
const caret = (app) =>
  app.evaluate(`(() => {
    const el = document.activeElement
    if (el === null) return 'nothing'
    if (el.closest('.terminal-panel') !== null) return 'terminal'
    if (el.closest('.composer') !== null) return 'composer'
    return el.tagName.toLowerCase()
  })()`)

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
    await app.settle()
    check((await caret(app)) === 'terminal', 'opening the panel puts the caret in the shell')

    /*
     * The reported repro: a real click on the terminal's rendered output.
     *
     * `.xterm-rows` is a div, and the textarea xterm actually types into is its
     * *sibling* — so this matched none of the tags in `FOCUS_KEEPS_ITS_OWN` and
     * the pane's click handler handed the caret to the composer.
     */
    await app.evaluate(`(() => {
      const rows = document.querySelector('.terminal-panel--session .xterm-rows')
      const box = rows.getBoundingClientRect()
      const at = { clientX: Math.round(box.left + 20), clientY: Math.round(box.top + 10), bubbles: true, cancelable: true }
      rows.dispatchEvent(new PointerEvent('pointerdown', at))
      rows.dispatchEvent(new MouseEvent('mousedown', at))
      rows.dispatchEvent(new MouseEvent('mouseup', at))
      rows.dispatchEvent(new MouseEvent('click', at))
      return true
    })()`)
    await app.settle()
    check(
      (await caret(app)) === 'terminal',
      'clicking the terminal leaves the caret in the terminal',
      `caret is in the ${await caret(app)}`
    )

    /*
     * The second half, which a click never shows: the composer reclaims the
     * caret when a burst of approvals clears, and it asks `mayTakeCaret` first.
     * A terminal's input box is empty by design, so that used to answer "yes".
     */
    const wouldSteal = await app.evaluate(`(() => {
      const el = document.activeElement
      const inTerminal = el?.closest('.terminal-panel') !== null
      const value = 'value' in el ? el.value : ''
      // What mayTakeCaret sees: an empty box, which normally means idle.
      return JSON.stringify({ inTerminal, tag: el.tagName, empty: value === '' })
    })()`)
    const seen = JSON.parse(wouldSteal)
    check(
      seen.inTerminal === true && seen.empty === true,
      "the shell's own box really is empty, which is why the old rule failed",
      `${seen.tag} in terminal, empty=${String(seen.empty)}`
    )

    // And typing actually reaches the shell.
    const before = await app.evaluate(
      `document.querySelector('.composer textarea').value.length.toString()`
    )
    await app.evaluate(`(() => {
      const ta = document.querySelector('.terminal-panel--session .xterm-helper-textarea')
      ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
      return true
    })()`)
    await app.settle()
    const after = await app.evaluate(
      `document.querySelector('.composer textarea').value.length.toString()`
    )
    check(before === after, 'a keystroke aimed at the shell does not land in the composer', `${before} → ${after}`)
  } finally {
    await app.quit()
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
