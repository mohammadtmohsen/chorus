/**
 * The two things this plan promised and never measured. Throwaway.
 *
 * 1. **A command survives its view.** The central claim of putting the PTY in
 *    main: "a `pnpm build` must not die because you clicked another tab." Every
 *    test so far has closed an *idle* panel. This closes one with a command
 *    running in it.
 *
 * 2. **What a terminal costs the transcript (C-026).** That entry measured a
 *    resize at ~38 layout-and-observer cycles over ~2s, and the plan has said
 *    "not re-measured" for four phases. Measured here as a proxy — frames until
 *    `.score`'s geometry stops moving — because the original instrument wrapped
 *    the app's own ResizeObserver, which cannot be reached after load. Stated as
 *    a proxy rather than passed off as the same number.
 *
 * Usage: pnpm --filter @chorus/desktop run build && node build/terminal-survival-probe.mjs
 */

import { launch } from '../e2e/harness.mjs'

const checks = []
const check = (ok, label, detail) => {
  checks.push(ok)
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const note = (label, detail) => {
  console.log(`  · ${label} — ${detail}`)
}

const press = (app, key, { meta = false, shift = false } = {}) =>
  app.evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, metaKey: ${String(meta)}, shiftKey: ${String(shift)},
      bubbles: true, cancelable: true }))
    return true
  })()`)

const screen = (app) =>
  app.evaluate(
    `document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '(no panel)'`
  )

/** The highest tick-N currently on screen. */
const ticks = async (app) => {
  const text = await screen(app)
  const found = [...text.matchAll(/tick-(\d+)/g)].map((m) => Number(m[1]))
  return found.length === 0 ? 0 : Math.max(...found)
}

/**
 * Frames until `.score` stops moving.
 *
 * Polls the three numbers the transcript's own follow-observer reacts to. Not
 * the observer's callback count, which is what C-026 measured — see the header.
 */
const settleFrames = (app, trigger) =>
  app.evaluate(`(async () => {
    const score = document.querySelector('.pane .score')
    if (score === null) return 'no score'
    const read = () => score.clientHeight + ':' + score.scrollHeight + ':' + Math.round(score.scrollTop)
    let frames = 0
    let quiet = 0
    let last = read();
    ${trigger};
    await new Promise((resolve) => {
      const step = () => {
        frames += 1
        const now = read()
        if (now === last) { quiet += 1 } else { quiet = 0; last = now }
        // Ten consecutive still frames, or give up at three seconds of them.
        if (quiet >= 10 || frames > 180) { resolve(); return }
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
    return String(frames - 10)
  })()`)

async function main() {
  const app = await launch({})
  try {
    await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
    await app.until(`document.querySelectorAll('.pane').length > 0`, { timeout: 120_000 })
    await app.settle()

    // --- 1. a command survives its view ------------------------------------
    await press(app, 'j', { meta: true })
    await app.until(`document.querySelector('.terminal-panel--session .xterm-rows') !== null`, {
      timeout: 30_000,
    })
    await app.evaluate(
      `document.querySelector('.terminal-panel--session .xterm-helper-textarea').focus(); 'ok'`
    )
    await app.send('Input.insertText', {
      text: 'for i in $(seq 1 90); do echo tick-$i; sleep 1; done',
    })
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
      `(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '').includes('tick-2')`,
      { timeout: 30_000 }
    )
    const before = await ticks(app)
    check(before >= 2, 'a long command is running in the panel', `at tick-${String(before)}`)

    // Close the panel. The view unmounts; the shell must not care.
    await press(app, 'j', { meta: true })
    await app.until(`document.querySelector('.terminal-panel--session') === null`, {
      timeout: 30_000,
    })
    const busyWhileHidden = JSON.parse(
      await app.evaluate(`
        window.chorus.describeTerminal({
          ref: { scope: 'session', conversationId: document.querySelector('.pane').dataset.conversation },
        }).then(d => JSON.stringify(d))
      `)
    )
    check(
      busyWhileHidden?.running === true,
      'the shell is still running with no view attached',
      `foreground ${busyWhileHidden?.foreground}`
    )

    await new Promise((r) => setTimeout(r, 6_000))
    const stillBusy = JSON.parse(
      await app.evaluate(`
        window.chorus.describeTerminal({
          ref: { scope: 'session', conversationId: document.querySelector('.pane').dataset.conversation },
        }).then(d => JSON.stringify(d))
      `)
    )
    check(
      stillBusy?.running === true,
      'and six seconds later the shell is still there',
      `foreground ${stillBusy?.foreground}`
    )
    /*
     * `busy` is an instantaneous sample, not a claim about the next second.
     *
     * This asserted `busy === true` first and failed with foreground `zsh` while
     * the loop was demonstrably still running — because between `sleep`s the
     * foreground *is* the shell. Worth knowing before `busy` is used to decide
     * whether killing a terminal would lose work: sampled at the wrong moment it
     * says "nothing running" mid-loop.
     */
    note('describe().busy', `sampled ${String(stillBusy?.busy)} mid-loop — it alternates`)

    await press(app, 'j', { meta: true })
    await app.until(`document.querySelector('.terminal-panel--session .xterm-rows') !== null`, {
      timeout: 30_000,
    })
    /*
     * Wait for a tick *past* the one we left on, rather than comparing counts.
     *
     * `ticks` reads what is rendered, and xterm renders only the visible rows —
     * so the highest number on screen depends on scroll position, and comparing
     * before/after reported the command going backwards on one run. A tick that
     * did not exist when we closed the panel cannot be produced by scrolling.
     */
    const target = before + 4
    await app.until(
      `(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '').includes('tick-${String(target)}')`,
      { timeout: 30_000 }
    )
    check(
      true,
      'and output past where we left it is on screen',
      `left at tick-${String(before)}, saw tick-${String(target)}`
    )

    /*
     * C-026 is *still* not re-measured, and now the reason is specific.
     *
     * The proxy tried here — counting frames until `.score`'s geometry stops
     * moving — cannot work in a driven window: Electron throttles
     * requestAnimationFrame when the window is not frontmost, so the counter
     * either hangs or counts a number that means nothing. Two runs produced 0
     * and 1 frames and then a timeout, which is the shape of an instrument that
     * is not measuring.
     *
     * Measuring it properly needs what the original did — wrapping the app's own
     * ResizeObserver — which has to be installed before the renderer's scripts
     * run, and this harness attaches after load. That is a change to the harness,
     * not to this probe, and it is the honest next step rather than a number
     * invented here.
     */
    note('C-026', 'not measured — rAF is throttled in a driven window; see the comment')

  } finally {
    await app.quit()
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
