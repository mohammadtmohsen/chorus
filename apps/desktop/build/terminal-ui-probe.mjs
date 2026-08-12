/**
 * Phase 3 spike. Throwaway — folded into `specs.mjs` once the suite can go red.
 *
 * Drives the real app and looks at the terminal panels: the activity-bar button,
 * `⌘J`, that a shell actually draws into xterm, that the `⌘K` chord no longer
 * steals an arrow when the caret is in a terminal, and that the ANSI palette
 * comes from tokens rather than a hardcoded set.
 *
 * Usage: pnpm --filter @chorus/desktop run build && node build/terminal-ui-probe.mjs
 */

import { launch } from '../e2e/harness.mjs'

const checks = []
const check = (ok, label, detail) => {
  checks.push(ok)
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** The app's global shortcuts listen on `document` in the capture phase. */
const press = (app, key, { meta = false, shift = false } = {}) =>
  app.evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, metaKey: ${String(meta)}, shiftKey: ${String(shift)},
      bubbles: true, cancelable: true,
    }))
    'sent'
  `)

async function main() {
  const app = await launch({})
  try {
    await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
    await app.until(`document.querySelectorAll('.pane').length > 0`, { timeout: 120_000 })
    await app.settle()

    // --- the session terminal, from ⌘J --------------------------------------
    await press(app, 'j', { meta: true })
    await app.until(`document.querySelector('.terminal-panel--session') !== null`, {
      timeout: 30_000,
    })
    check(true, '⌘J opens the focused session’s terminal')

    const inPane = await app.evaluate(`
      String(document.querySelector('.pane .terminal-panel--session') !== null)
    `)
    check(inPane === 'true', 'and it lands inside the pane, above the dock')

    const order = await app.evaluate(`
      const pane = document.querySelector('.pane')
      const kids = [...pane.children].map(c => c.className.split(' ')[0])
      JSON.stringify(kids)
    `)
    check(
      order.includes('terminal-panel') && order.indexOf('terminal-panel') < order.indexOf('dock'),
      'between the transcript and the dock',
      order
    )

    await press(app, 'j', { meta: true })
    await app.until(`document.querySelector('.terminal-panel--session') === null`, {
      timeout: 30_000,
    })
    check(true, '⌘J again closes it')

    // --- the global terminal, from the activity bar -------------------------
    check(
      (await app.evaluate(
        `document.querySelectorAll('.activity-bar button').length >= 3`
      )) === true,
      'the activity bar carries a terminal button'
    )

    await app.evaluate(`
      const buttons = [...document.querySelectorAll('.activity-bar button')]
      const terminal = buttons.find(b => /terminal/i.test(b.title))
      terminal.click()
      'clicked'
    `)
    await app.until(`document.querySelector('.terminal-panel--global') !== null`, {
      timeout: 30_000,
    })
    check(true, 'the button opens the global panel')

    await app.until(`document.querySelector('.terminal-panel--global .xterm-rows') !== null`, {
      timeout: 30_000,
    })
    check(true, 'xterm mounts inside it')

    // A prompt means a real shell reached a real emulator.
    await app.until(
      `(document.querySelector('.terminal-panel--global .xterm-rows')?.innerText ?? '').trim().length > 0`,
      { timeout: 30_000 }
    )
    const prompt = await app.evaluate(
      `document.querySelector('.terminal-panel--global .xterm-rows').innerText.trim().slice(0, 40)`
    )
    check(prompt.length > 0, 'a shell draws its prompt into it', JSON.stringify(prompt))

    // It sits in the editor area, beside the sidebar rather than under it.
    const beside = await app.evaluate(`
      const panel = document.querySelector('.terminal-panel--global').getBoundingClientRect()
      const bar = document.querySelector('.activity-bar').getBoundingClientRect()
      String(panel.left >= bar.right)
    `)
    check(beside === 'true', 'it spans the editor area, not the sidebar')

    // --- the ANSI palette comes from tokens ---------------------------------
    const themed = await app.evaluate(`
      const s = getComputedStyle(document.documentElement)
      String(s.getPropertyValue('--ansi-red').trim().length > 0 && s.getPropertyValue('--ansi-bright-white').trim().length > 0)
    `)
    check(themed === 'true', 'the sixteen ANSI colours are CSS tokens')

    // --- the ⌘K chord no longer steals an arrow in a terminal ---------------
    await app.evaluate(`
      document.querySelector('.terminal-panel--global .xterm-helper-textarea')?.focus()
      'focused'
    `)
    const focusedInTerminal = await app.evaluate(
      `String(document.activeElement?.closest('.terminal-panel') !== null)`
    )
    check(focusedInTerminal === 'true', 'the caret can be put in the terminal')

    /*
     * Whether the arrow was *consumed*, not whether a pane appeared.
     *
     * The first version of this check counted panes, and it could never fail:
     * splitting a pane that holds its only tab is a legitimate no-op, and this
     * fixture has one session. It passed with the guard removed — a test that
     * proves nothing, which is exactly what C-027 is about. `defaultPrevented`
     * is the behaviour actually under test.
     */
    const arrowConsumed = async () =>
      await app.evaluate(`(() => {
        const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
        document.dispatchEvent(arrow)
        return String(arrow.defaultPrevented)
      })()`)

    // Control: with the caret in the composer, an armed chord *does* take the
    // arrow. Without this the assertion below could pass for any reason at all.
    await app.evaluate(`document.querySelector('.composer textarea')?.focus(); 'ok'`)
    await press(app, 'k', { meta: true })
    check(
      (await arrowConsumed()) === 'true',
      'control: an armed ⌘K chord does consume → in the composer'
    )

    await app.evaluate(`
      document.querySelector('.terminal-panel--global .xterm-helper-textarea')?.focus()
      'focused'
    `)
    await press(app, 'k', { meta: true })
    check(
      (await arrowConsumed()) === 'false',
      '⌘K then → reaches the shell instead, when the caret is in a terminal'
    )

    // The case revision 2 missed: armed elsewhere, then focus moves in.
    await app.evaluate(`document.querySelector('.composer textarea')?.focus(); 'ok'`)
    await press(app, 'k', { meta: true })
    await app.evaluate(`
      document.querySelector('.terminal-panel--global .xterm-helper-textarea')?.focus()
      'focused'
    `)
    check(
      (await arrowConsumed()) === 'false',
      'and when the chord was armed before focus moved into it'
    )

    // --- light mode, looked at rather than assumed --------------------------
    const viewportBg = () =>
      app.evaluate(
        `getComputedStyle(document.querySelector('.terminal-panel--global .xterm')).backgroundColor`
      )
    const darkRed = await app.evaluate(
      `getComputedStyle(document.documentElement).getPropertyValue('--ansi-red').trim()`
    )
    const darkBg = await viewportBg()

    await app.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    })
    await app.settle()
    const lightRed = await app.evaluate(
      `getComputedStyle(document.documentElement).getPropertyValue('--ansi-red').trim()`
    )
    const lightBg = await viewportBg()

    check(darkRed !== lightRed, 'the ANSI palette changes with the scheme', `${darkRed} → ${lightRed}`)
    /*
     * The emulator repaints too, not just the stylesheet. xterm is handed a
     * theme object once at construction, so without the media listener in
     * `TerminalView` the surface would keep its dark background on a light
     * ground — the one place in the app that ignored the light block.
     */
    check(darkBg !== lightBg, 'and the terminal surface repaints with it', `${darkBg} → ${lightBg}`)
    check(
      (await app.evaluate(
        `getComputedStyle(document.querySelector('.terminal-panel--global .xterm-viewport')).backgroundColor`
      )) === 'rgba(0, 0, 0, 0)',
      'the viewport does not paint black over the themed surface'
    )

    await app.send('Emulation.setEmulatedMedia', { features: [] })
    await app.settle()

    // --- ⌘J is inert while the global terminal holds the caret --------------
    await press(app, 'j', { meta: true })
    await app.settle()
    const sessionPanel = await app.evaluate(
      `String(document.querySelector('.terminal-panel--session') !== null)`
    )
    check(
      sessionPanel === 'false',
      '⌘J does nothing while the caret is in the global terminal'
    )
  } finally {
    await app.quit()
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
