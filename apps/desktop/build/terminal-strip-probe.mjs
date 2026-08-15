/**
 * Phase 3 spike, for `more-than-one-shell-2026-08-14`. Throwaway.
 *
 * The first probe that can do what the whole feature was asked for: two shells
 * in one panel, switch between them, and find the first one still running.
 *
 * Every check here is written against the **shell**, not the tab count. A tab is
 * a button; asserting that two buttons exist proves the store changed and
 * nothing about whether either addresses a live process. That is C-027 from the
 * inside, and this file is the place it would have happened.
 *
 * Usage: pnpm --filter @chorus/desktop run build && node build/terminal-strip-probe.mjs
 */

import { launch } from '../e2e/harness.mjs'

const checks = []
const check = (ok, label, detail) => {
  checks.push(ok)
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const ready = async (app) => {
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
  await app.until(`document.querySelectorAll('.pane').length > 0`, { timeout: 120_000 })
  await app.settle()
}

/*
 * Real key events through CDP, not synthetic ones.
 *
 * `terminal-clear-probe` learned this the hard way and left the note: xterm
 * **ignores** an `InputEvent` poked at its hidden textarea. A chord dispatched on
 * `document` would still reach `Workspace`'s capture handler, so the shortcut
 * would look like it worked while proving nothing about whether xterm swallows
 * it first — which is half of what this phase changed.
 *
 * CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
 */
const key = async (app, { key, code, modifiers = 0, autoRepeat = false, vk }) => {
  for (const type of ['keyDown', 'keyUp']) {
    await app.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      modifiers,
      autoRepeat,
      /*
       * Enter needs its virtual key code or it is never delivered as a key at
       * all, and the failure is silent: the text sits at the prompt, unrun, and
       * anything asserting on the *echo* of what you typed passes anyway. That
       * is how the first draft of this probe reported a green `echo` that had
       * never executed. `terminal-clear-probe` sets these; this did not.
       */
      ...(vk === undefined ? {} : { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
    })
  }
}

const ENTER = { key: 'Enter', code: 'Enter', vk: 13 }

const NEW_TERMINAL = { key: '~', code: 'Backquote', modifiers: 10 }
const TOGGLE_PANEL = { key: 'j', code: 'KeyJ', modifiers: 4 }

/** What the visible terminal has on screen. */
const screenText = (app) =>
  app.evaluate(
    `(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '').replace(/\\s+/g, ' ')`
  )

const tabCount = (app) =>
  app
    .evaluate(`String(document.querySelectorAll('.terminal-panel--session .terminal-tab').length)`)
    .then(Number)

const focusTerminal = (app) =>
  app.evaluate(`(() => {
    document.querySelector('.terminal-panel--session .xterm-helper-textarea').focus()
    return true
  })()`)

/**
 * Run a command in whichever terminal is showing, and wait for its **output**.
 *
 * The marker is assembled by the shell — `echo NAME_$((1+1))` types one thing
 * and prints another — so the assertion cannot be satisfied by the echo of what
 * was typed. The first draft typed `echo FIRST_SHELL_MARK` and then waited for
 * `FIRST_SHELL_MARK`, which is on screen the moment the PTY echoes the
 * characters back, Enter or no Enter. It went green against a command that had
 * never run — and the missing `Enter` above is exactly why it had not.
 */
const run = async (app, name) => {
  /*
   * Wait for a prompt before typing, which the first draft did not.
   *
   * A freshly spawned shell has not printed anything yet, and characters sent
   * before it is interactive are simply gone — no error, no echo. That made this
   * probe fail *at a different step each run* depending on how fast zsh started,
   * which reads exactly like a flaky feature and is not one. Non-empty screen
   * text is the cheapest honest signal that the shell is listening.
   */
  await app.until(
    `(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '').trim().length > 0`,
    { timeout: 30_000, label: `a prompt to type ${name} at` }
  )
  await focusTerminal(app)
  await app.send('Input.insertText', { text: `echo ${name}_$((1+1))` })
  await key(app, ENTER)
  await app.until(
    `(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '').includes('${name}_2')`,
    { timeout: 30_000, label: `${name} ran and printed its result` }
  )
}

async function main() {
  const app = await launch({})
  try {
    await ready(app)

    await key(app, TOGGLE_PANEL)
    await app.until(`document.querySelector('.terminal-panel--session') !== null`, {
      timeout: 30_000,
      label: 'the session panel opened',
    })
    check((await tabCount(app)) === 0, 'one terminal shows no strip', 'as it looked before')

    // A marker in the first shell, so switching back can be proved rather than assumed.
    await run(app, 'FIRST')
    check(true, 'the first shell runs a command')

    /*
     * ⌃⇧` — on `code`, because with Shift held `key` is `~`. If this handler
     * had been written the way every other chord in the file is written, this
     * dispatch would do nothing at all.
     */
    await focusTerminal(app)
    await key(app, NEW_TERMINAL)
    await app.until(`document.querySelectorAll('.terminal-panel--session .terminal-tab').length === 2`, {
      timeout: 30_000,
      label: 'a second terminal appeared',
    })
    check(true, 'the chord adds a terminal, matched on event.code')

    const second = await screenText(app)
    check(
      !second.includes('FIRST_2'),
      'the new tab is a different shell, not the same one re-rendered',
      second.slice(-60).trim() || '(empty)'
    )

    /*
     * The repeat guard. Holding the chord would otherwise spawn shells at the
     * OS key-repeat rate — the only way a person reaches forty terminals by
     * accident.
     */
    const before = await tabCount(app)
    for (let n = 0; n < 12; n += 1) {
      await key(app, { ...NEW_TERMINAL, autoRepeat: true })
    }
    await app.settle()
    const after = await tabCount(app)
    check(after === before, 'twelve repeats add nothing', `${String(before)} → ${String(after)}`)

    // Something running in the second shell, to prove the first survives it.
    await run(app, 'SECOND')

    /*
     * The headline: switch back and find the first shell's scrollback intact.
     *
     * Only the active tab is mounted, so this is a genuine remount restoring
     * from the headless mirror in main — not a hidden div coming back.
     */
    await app.evaluate(`(() => {
      document.querySelectorAll('.terminal-panel--session .terminal-tab')[0].click()
      return true
    })()`)
    await app.until(
      `/FIRST_2/.test(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '')`,
      { timeout: 30_000, label: 'the first shell came back' }
    )
    const back = await screenText(app)
    check(true, 'switching back restores the first shell’s scrollback')
    check(
      !back.includes('SECOND_2'),
      'and it is its own scrollback, not its neighbour’s',
      'no cross-tab output'
    )

    /*
     * The first shell is still a *live process*, not a restored picture. This is
     * the check the whole feature exists for: `pnpm dev` in tab 1 must survive
     * you working in tab 2.
     */
    await run(app, 'ALIVE')
    check(true, 'and the first shell is still running, not a snapshot')

    // ⌘J hides the panel. The roster must survive being out of sight.
    await key(app, TOGGLE_PANEL)
    await app.until(`document.querySelector('.terminal-panel--session') === null`, {
      timeout: 30_000,
      label: 'the panel hid',
    })
    await key(app, TOGGLE_PANEL)
    await app.until(`document.querySelectorAll('.terminal-panel--session .terminal-tab').length === 2`, {
      timeout: 30_000,
      label: 'both tabs came back',
    })
    check(true, 'hiding the panel keeps its roster, because its shells are still running')

    await app.until(
      `/FIRST_2/.test(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '')`,
      { timeout: 30_000, label: 'and the same shell is selected' }
    )
    check(true, 'and reopens on the terminal you were looking at')

    /*
     * Exit status belongs to a terminal, not to the dock it sits in.
     *
     * This was one `number | null` for the whole panel before Phase 3, which
     * would have shown the dead shell's code above its live neighbour and never
     * cleared it. Kill the second tab and check the mark lands on that tab only.
     */
    await app.evaluate(`(() => {
      document.querySelectorAll('.terminal-panel--session .terminal-tab')[1].click()
      return true
    })()`)
    await app.until(
      `/SECOND_2/.test(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '')`,
      { timeout: 30_000, label: 'the second shell is showing' }
    )
    await focusTerminal(app)
    await app.send('Input.insertText', { text: 'exit 7' })
    await key(app, ENTER)

    await app.until(
      `document.querySelectorAll('.terminal-panel--session .terminal-tab[data-exited]').length === 1`,
      { timeout: 30_000, label: 'the dead tab was marked' }
    )
    const markedIndex = Number(
      await app.evaluate(`String([...document.querySelectorAll('.terminal-panel--session .terminal-tab')]
        .findIndex((tab) => tab.hasAttribute('data-exited')))`)
    )
    check(markedIndex === 1, 'the exit marks the tab that died, not its neighbour', `tab ${String(markedIndex + 1)}`)

    /*
     * And it survives the panel being closed and reopened — which is the only
     * path that exercises `attach`'s `exitCode`. `TerminalPanel` unmounts with
     * ⌘J, so its per-id state starts empty and the mark can only come back from
     * main having kept the code.
     */
    await key(app, TOGGLE_PANEL)
    await app.until(`document.querySelector('.terminal-panel--session') === null`, {
      timeout: 30_000,
      label: 'the panel hid again',
    })
    await key(app, TOGGLE_PANEL)
    await app.until(
      `document.querySelectorAll('.terminal-panel--session .terminal-tab[data-exited]').length === 1`,
      { timeout: 30_000, label: 'the dead tab is still marked after a remount' }
    )
    check(true, 'a dead shell still says so after the panel is reopened', 'from attach, not the push')

    /*
     * The criterion this probe was still not proving: a shell that dies **while
     * its tab is in the background**.
     *
     * Everything above kills the terminal that is on screen, so the live `exit`
     * push does the work and `attach`'s `exitCode` is never the thing under
     * test. Here the third terminal is told to die on a timer, we switch away
     * before it does, and nobody is mounted when it goes — which is the common
     * case once only the active tab mounts, and the whole reason main keeps the
     * code at all.
     */
    await focusTerminal(app)
    await key(app, NEW_TERMINAL)
    await app.until(
      `document.querySelectorAll('.terminal-panel--session .terminal-tab').length === 3`,
      { timeout: 30_000, label: 'a third terminal appeared' }
    )
    const doomed = await app.evaluate(
      `document.querySelector('.terminal-panel--session').dataset.terminalId`
    )

    await focusTerminal(app)
    await app.send('Input.insertText', { text: 'sleep 3; exit 9' })
    await key(app, ENTER)

    // Away before it dies. From here nothing is attached to that shell.
    await app.evaluate(`(() => {
      document.querySelectorAll('.terminal-panel--session .terminal-tab')[0].click()
      return true
    })()`)
    await app.until(
      `/FIRST_2/.test(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '')`,
      { timeout: 30_000, label: 'switched to the first shell' }
    )

    await new Promise((r) => setTimeout(r, 6_000))
    const markedWhileAway = Number(
      await app.evaluate(
        `String([...document.querySelectorAll('.terminal-panel--session .terminal-tab')]
          .filter((tab) => tab.dataset.terminalId === ${JSON.stringify(doomed)} && tab.hasAttribute('data-exited')).length)`
      )
    )
    check(
      markedWhileAway === 0,
      'a background shell dying is not noticed while you are elsewhere',
      'nothing is mounted to hear the push'
    )

    // Selecting it is when it finds out, and `attach` is the only source.
    await app.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.terminal-panel--session .terminal-tab')]
        .find((t) => t.dataset.terminalId === ${JSON.stringify(doomed)})
      tab.click()
      return true
    })()`)
    await app.until(
      `[...document.querySelectorAll('.terminal-panel--session .terminal-tab')]
        .some((tab) => tab.dataset.terminalId === ${JSON.stringify(doomed)} && tab.hasAttribute('data-exited'))`,
      { timeout: 30_000, label: 'the background death was reported on selection' }
    )
    check(true, 'and is marked exited the moment its tab is selected', 'attach carried the code')

    const neighbours = Number(
      await app.evaluate(
        `String(document.querySelectorAll('.terminal-panel--session .terminal-tab[data-exited]').length)`
      )
    )
    check(neighbours === 2, 'and only the two that actually died are marked', `${String(neighbours)} of 3`)

    /*
     * The chord must not reach through a sheet.
     *
     * `useDialog` traps Tab and claims Escape; every other key still reaches the
     * document handler. Most chords there rearrange panes, which is only
     * surprising behind an overlay — this one spawns a **shell** in whichever
     * session was last focused, out of sight, with nothing on screen to say so.
     */
    const beforeSheet = await tabCount(app)
    await app.evaluate(`(() => {
      document.querySelector('[data-rail-settings]').click()
      return true
    })()`)
    await app.until(`document.querySelector('.sheet-backdrop') !== null`, {
      timeout: 30_000,
      label: 'settings opened',
    })
    await key(app, NEW_TERMINAL)
    await app.settle()
    const duringSheet = await tabCount(app)
    check(
      duringSheet === beforeSheet,
      'the chord does nothing behind a sheet, rather than spawning a hidden shell',
      `${String(beforeSheet)} → ${String(duringSheet)}`
    )

    /*
     * The strip's keyboard contract, which a screen-reader user depends on and
     * nothing else exercises: one tab in the sequential order, arrows for the
     * rest. Copied from `PaneTabStrip`, so this checks the copy took.
     */
    const roving = JSON.parse(
      await app.evaluate(`JSON.stringify(
        [...document.querySelectorAll('.terminal-panel--session .terminal-tab')].map((tab) => tab.tabIndex)
      )`)
    )
    check(
      roving.filter((index) => index === 0).length === 1 &&
        roving.filter((index) => index === -1).length === roving.length - 1,
      'exactly one tab is in the Tab order, the rest are reachable by arrow',
      roving.join(', ')
    )

    const wired = JSON.parse(
      await app.evaluate(`(() => {
        const tab = document.querySelector('.terminal-panel--session .terminal-tab[aria-selected="true"]')
        const panel = document.querySelector('.terminal-panel--session .terminal-surface')
        return JSON.stringify({
          controls: tab?.getAttribute('aria-controls') ?? null,
          panelId: panel?.id ?? null,
          role: panel?.getAttribute('role') ?? null,
          labelledBy: panel?.getAttribute('aria-labelledby') ?? null,
          tabId: tab?.id ?? null,
        })
      })()`)
    )
    check(
      wired.controls === wired.panelId && wired.role === 'tabpanel' && wired.labelledBy === wired.tabId,
      'the selected tab and the surface it controls point at each other',
      `${String(wired.role)} ${String(wired.panelId)}`
    )

    // And still works once the sheet is gone, so the guard is a guard, not a break.
    await key(app, { key: 'Escape', code: 'Escape', vk: 27 })
    await app.until(`document.querySelector('.sheet-backdrop') === null`, {
      timeout: 30_000,
      label: 'settings closed',
    })
    await focusTerminal(app)
    await key(app, NEW_TERMINAL)
    await app.until(
      `document.querySelectorAll('.terminal-panel--session .terminal-tab').length === ${String(beforeSheet + 1)}`,
      { timeout: 30_000, label: 'the chord works again once the sheet is gone' }
    )
    check(true, 'and works again the moment the sheet closes', 'a guard, not a break')

    /*
     * Phase 4 — kill. Everything below is about the shell, never the tab count.
     *
     * An idle terminal dies on the click with no question. `describe()` reports
     * `busy` as "something other than the shell itself is in the foreground", so
     * a shell sitting at its prompt has nothing to lose and asking would be the
     * friction people learn to click through.
     */
    const tabsBeforeKill = await tabCount(app)
    const survivor = await app.evaluate(
      `document.querySelector('.terminal-panel--session').dataset.terminalId`
    )
    const idle = await app.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.terminal-panel--session .terminal-tab')]
        .find((t) => t.dataset.terminalId !== ${JSON.stringify(survivor)} && !t.hasAttribute('data-exited'))
      return tab ? tab.dataset.terminalId : ''
    })()`)
    check(idle !== '', 'there is an idle terminal to kill', idle.slice(0, 8))

    await app.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.terminal-panel--session .terminal-tab')]
        .find((t) => t.dataset.terminalId === ${JSON.stringify(idle)})
      tab.querySelector('.terminal-tab-kill').click()
      return true
    })()`)
    await app.until(
      `document.querySelectorAll('.terminal-panel--session .terminal-tab').length === ${String(tabsBeforeKill - 1)}`,
      { timeout: 30_000, label: 'the idle terminal went' }
    )
    const askedForIdle = await app.evaluate(
      `String(document.querySelector('.sheet-backdrop') !== null)`
    )
    check(askedForIdle === 'false', 'killing an idle terminal does not ask', 'nothing to lose')

    /* And it is gone in main, not merely off the strip. */
    const goneInMain = await app.evaluate(
      `window.chorus.describeTerminal({ ref: { scope: 'session',
        conversationId: document.querySelector('.pane').dataset.conversation,
        id: ${JSON.stringify(idle)} } }).then((d) => String(d))`
    )
    check(goneInMain === 'null', 'and its shell is gone in main, not just its row', goneInMain)

    /*
     * A busy one asks first, and names what is running. This is the reason
     * `terminal:describe` has existed since the original plan's Phase 1 with
     * nothing calling it.
     */
    await focusTerminal(app)
    await key(app, NEW_TERMINAL)
    await app.until(
      `document.querySelectorAll('.terminal-panel--session .terminal-tab').length === ${String(tabsBeforeKill)}`,
      { timeout: 30_000, label: 'a terminal to make busy' }
    )
    const busyId = await app.evaluate(
      `document.querySelector('.terminal-panel--session').dataset.terminalId`
    )
    /*
     * Same prompt wait as `run` — a shell spawned a moment ago has not printed
     * anything yet, and characters sent before it is interactive are gone with no
     * error. Without this the terminal is never busy, `describe` says so, and the
     * kill takes the no-question path: a confirmation that "never appeared"
     * because there was nothing to confirm.
     */
    await app.until(
      `(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '').trim().length > 0`,
      { timeout: 30_000, label: 'a prompt in the terminal to make busy' }
    )
    await focusTerminal(app)
    await app.send('Input.insertText', { text: 'sleep 45' })
    await key(app, ENTER)
    await app.until(
      `window.chorus.describeTerminal({ ref: { scope: 'session',
        conversationId: document.querySelector('.pane').dataset.conversation,
        id: ${JSON.stringify(busyId)} } }).then((d) => !!d && d.busy === true)`,
      { timeout: 30_000, label: 'the shell reports itself busy' }
    )

    const tabsBeforeBusyKill = await tabCount(app)
    await app.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.terminal-panel--session .terminal-tab')]
        .find((t) => t.dataset.terminalId === ${JSON.stringify(busyId)})
      tab.querySelector('.terminal-tab-kill').click()
      return true
    })()`)
    await app.until(`document.querySelector('.sheet-backdrop') !== null`, {
      timeout: 30_000,
      label: 'the confirmation appeared',
    })
    const body = await app.evaluate(
      `document.querySelector('.sheet-backdrop .confirm-body')?.textContent ?? ''`
    )
    check(body.includes('sleep'), 'killing a busy terminal asks, and names the process', body.trim())

    /* Cancel keeps the shell. A confirmation that killed anyway would be theatre. */
    await app.evaluate(`(() => {
      document.querySelectorAll('.sheet-backdrop .confirm-actions button')[0].click()
      return true
    })()`)
    await app.until(`document.querySelector('.sheet-backdrop') === null`, {
      timeout: 30_000,
      label: 'the confirmation closed',
    })
    const afterCancel = await app.evaluate(
      `window.chorus.describeTerminal({ ref: { scope: 'session',
        conversationId: document.querySelector('.pane').dataset.conversation,
        id: ${JSON.stringify(busyId)} } }).then((d) => String(!!d && d.running))`
    )
    check(afterCancel === 'true', 'cancelling leaves the shell running', 'still there')
    check(
      (await tabCount(app)) === tabsBeforeBusyKill,
      'and leaves its tab where it was',
      `${String(tabsBeforeBusyKill)} tabs`
    )

    /* Confirming kills it, and the tab goes only after main says it is dead. */
    await app.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.terminal-panel--session .terminal-tab')]
        .find((t) => t.dataset.terminalId === ${JSON.stringify(busyId)})
      tab.querySelector('.terminal-tab-kill').click()
      return true
    })()`)
    await app.until(`document.querySelector('.sheet-backdrop') !== null`, {
      timeout: 30_000,
      label: 'the confirmation appeared again',
    })
    await app.evaluate(`(() => {
      document.querySelectorAll('.sheet-backdrop .confirm-actions button')[1].click()
      return true
    })()`)
    await app.until(
      `window.chorus.describeTerminal({ ref: { scope: 'session',
        conversationId: document.querySelector('.pane').dataset.conversation,
        id: ${JSON.stringify(busyId)} } }).then((d) => d === null)`,
      { timeout: 30_000, label: 'the busy shell was killed' }
    )
    check(true, 'confirming kills the shell', 'gone in main')
    await app.until(
      `![...document.querySelectorAll('.terminal-panel--session .terminal-tab')]
        .some((t) => t.dataset.terminalId === ${JSON.stringify(busyId)})`,
      { timeout: 30_000, label: 'and its tab went with it' }
    )
    check(true, 'and its tab goes with it, after the kill and not before')

    /*
     * Killing the last terminal hides the panel rather than leaving it open and
     * empty — which is load-bearing, not cosmetic: `normalizeTerminalPanel` mints
     * a replacement for any open panel with none, so without this, killing your
     * last terminal would silently open a new one.
     */
    /*
     * Down to nothing, using the header's kill control — which is the only one
     * that exists once a single terminal is left and the strip is gone.
     *
     * The last kill must **hide the panel**, not leave it open and empty:
     * `normalizeTerminalPanel` mints a replacement for any open panel with no
     * tabs, so without `removeTab` closing it, killing your last terminal would
     * silently open a new one.
     */
    for (let n = 0; n < 8; n += 1) {
      const open = await app.evaluate(
        `String(document.querySelector('.terminal-panel--session') !== null)`
      )
      if (open === 'false') break
      await app.evaluate(`(() => {
        document.querySelector('.terminal-panel--session .terminal-action--kill').click()
        return true
      })()`)
      await app.settle()
      // Some of these are busy shells and will ask; confirm and carry on.
      const asked = await app.evaluate(
        `String(document.querySelector('.sheet-backdrop') !== null)`
      )
      if (asked === 'true') {
        await app.evaluate(`(() => {
          document.querySelectorAll('.sheet-backdrop .confirm-actions button')[1].click()
          return true
        })()`)
      }
      await new Promise((r) => setTimeout(r, 600))
    }
    const hidden = await app.evaluate(
      `String(document.querySelector('.terminal-panel--session') === null)`
    )
    check(hidden === 'true', 'killing the last terminal hides the panel', 'rather than minting one')

    // And ⌘J brings back a fresh one rather than an empty panel.
    await key(app, TOGGLE_PANEL)
    await app.until(
      `(document.querySelector('.terminal-panel--session .xterm-rows')?.innerText ?? '').trim().length > 0`,
      { timeout: 30_000, label: 'a fresh terminal opened' }
    )
    check(true, 'and ⌘J reopens it with a new shell, not an empty dock', 'a live prompt')

  } finally {
    await app.quit()
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
