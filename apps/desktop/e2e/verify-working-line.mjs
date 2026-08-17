/**
 * Drives the real app for the four changes landed on 2026-08-17.
 *
 * Not part of the suite: it asks a live Claude a question that takes tool calls
 * to answer, which no runner has a CLI for. It is here rather than in /tmp
 * because the next person to touch the working line will want to run exactly
 * this, and because the harness is the only sanctioned way to attach to the app
 * (`--remote-debugging-port=0`, read back from the child's own stderr).
 *
 *   node apps/desktop/e2e/verify-working-line.mjs
 */
import { ensureBuilt, launch, wait } from './harness.mjs'

/*
 * The build first, always. `launch` runs `out/`, not `src/`, so without this it
 * drives whatever was last compiled — which is C-014, and which cost this very
 * verification a full run reporting the *old* layout as a failure of the new
 * one.
 */
ensureBuilt()

const say = (page, text) =>
  page.evaluate(`(() => {
    const ta = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      .set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.composer').requestSubmit()
    return true
  })()`)

const results = []
const check = (ok, what, detail = '') => {
  results.push({ ok, what, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail === '' ? '' : ` — ${detail}`}`)
}

const app = await launch({})
try {
  await app.until(`document.querySelectorAll('.pane').length > 0`, {
    timeout: 60_000,
    label: 'a session opened',
  })
  check(true, 'the app boots and mounts a pane')

  await app.until(`document.querySelector('.composer textarea') !== null`, { timeout: 30_000 })

  // Explain is gated on a language, and `App` reads it on mount — so it is set
  // before the turn rather than after, and the pane is reloaded to pick it up.
  await app.evaluate(
    `window.chorus.readSettings().then((s) => window.chorus.writeSettings({ ...s, explainLanguage: 'Arabic' })).then(() => true)`
  )
  await app.evaluate(`(location.reload(), true)`)
  await wait(4_000)
  await app.until(`document.querySelector('.composer textarea') !== null`, {
    timeout: 60_000,
    label: 'the pane came back after the reload',
  })

  /*
   * A question that cannot be answered without tools, because the whole bug was
   * about the stretch between rows: a prose reply streams and the avatar pulses,
   * so it never showed the failure.
   */
  await say(
    app,
    'List the files in the current directory using ls, then read package.json and tell me the name field. Use tools, do not guess.'
  )

  const seen = { thinking: false, stop: false, steering: false, words: new Set(), tail: false }
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const now = await app.evaluate(`(() => {
      const think = Array.from(document.querySelectorAll('.turn .entry--thinking'))
      const rows = Array.from(document.querySelectorAll('.turn > .entry, .turn > .turn-head'))
      const lastThink = think.length === 0 ? -1 : rows.indexOf(think[think.length - 1])
      return {
        thinking: think.length > 0,
        words: think.map(t => t.querySelector('.thinking-word')?.textContent ?? ''),
        stop: document.querySelectorAll('.send--stop').length > 0,
        steering: document.querySelectorAll('.send[data-steering="true"]').length > 0,
        // The working line must be the last thing in the turn, not pinned above.
        tail: think.length > 0 && lastThink === rows.length - 1,
        /*
         * A finished message row, not any .said element.
         *
         * The first version asked for .entry--claude .said, which the waiting
         * row satisfies -- it is .entry--claude.entry--thinking and its line is
         * a .said -- so "the turn is over" was true before the turn began, the
         * loop broke on its first pass, and the run reported a missing Stop
         * button that was there two seconds later. Suspect the driver first.
         *
         * (No backticks in here: this whole probe is a template literal.)
         */
        busyDone: document.querySelectorAll('.send--stop').length === 0
          && document.querySelectorAll('.entry--claude[data-kind="message"]').length > 0,
      }
    })()`)
    if (now.thinking) seen.thinking = true
    if (now.stop) seen.stop = true
    if (now.steering) seen.steering = true
    if (now.tail) seen.tail = true
    for (const word of now.words) if (word !== '') seen.words.add(word)
    // And never before Stop has actually been seen: a turn that has not started
    // yet is indistinguishable from one that has finished, by this measure.
    if (seen.stop && now.busyDone) break
    await wait(400)
  }

  check(seen.thinking, 'a working line is drawn during the turn')
  check(seen.tail, 'and it sits at the foot of the turn, under the newest row')
  check(seen.stop, 'the composer offers Stop while the turn runs')
  check(
    seen.words.size > 0,
    'the line says what it is doing',
    [...seen.words].join(' / ') || 'nothing'
  )

  await app.until(`document.querySelectorAll('.send--stop').length === 0`, {
    timeout: 180_000,
    label: 'the turn finished',
  })

  const after = await app.evaluate(`(() => ({
    thinking: document.querySelectorAll('.entry--thinking').length,
    explain: document.querySelectorAll('[data-entry-action="explain"]').length,
    handoff: document.querySelectorAll('[data-entry-action="handoff"]').length,
    replies: document.querySelectorAll('.entry--claude[data-kind="message"]').length,
    offer: document.querySelectorAll('.quote-offer').length,
  }))()`)

  check(after.thinking === 0, 'the working line goes when the turn ends')
  check(
    after.explain > 0,
    'Explain simply is offered under a finished reply',
    `${String(after.explain)} button(s) under ${String(after.replies)} reply/replies`
  )

  // The second turn is the one the init/result asymmetry used to break.
  await say(app, 'Now run pwd and tell me the folder name.')
  const second = { thinking: false, stop: false }
  const until = Date.now() + 120_000
  while (Date.now() < until) {
    const now = await app.evaluate(`(() => ({
      thinking: document.querySelectorAll('.turn .entry--thinking').length > 0,
      stop: document.querySelectorAll('.send--stop').length > 0,
    }))()`)
    if (now.thinking) second.thinking = true
    if (now.stop) second.stop = true
    if (second.thinking && second.stop) break
    await wait(300)
  }
  check(second.thinking, 'the SECOND turn also draws a working line')
  check(second.stop, 'and the composer still offers Stop on it')

  await app.evaluate(`(() => {
    const c = document.querySelector('[data-entry-action="explain"]')
    if (c !== null) c.click()
    return true
  })()`)
  await wait(3_000)
  const card = await app.evaluate(`(() => {
    const el = document.querySelector('.quick-card, [role="dialog"][aria-label]')
    return {
      open: el !== null,
      heading: el?.querySelector('strong')?.textContent ?? '',
      excerpt: el?.querySelectorAll('.quick-excerpt').length ?? 0,
    }
  })()`)
  check(card.open, 'the Explain card opens', card.heading)
  check(card.excerpt === 0, 'and does not repeat the whole reply back inside it')
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`)
  await app.quit()
  process.exit(failed.length === 0 ? 0 : 1)
}
