import { ensureBuilt, launch, wait } from './harness.mjs'

/**
 * Where the view lands after a split remounts the pane.
 *
 * The report: "when i drag and split workspace or reorder the tabs it scrolls to
 * top for the moved workspace". Only the moved pane remounts, which is why it is
 * the only one that jumps — so this drives the real gesture and reads the real
 * `scrollTop`, twice, because the two cases fail for different reasons:
 *
 *  - **following** — sitting at the bottom. Should come back at the bottom.
 *  - **parked** — scrolled up to read. Should come back where it was.
 *
 * A probe, not a spec: it prints what it measured and exits non-zero only if the
 * view landed at the top, which is the one answer that is wrong either way.
 *
 *   node apps/desktop/e2e/split-scroll.mjs
 */

const PANE = '.pane'
const TAB = '[data-workspace-tab]'

const started = (page) => page.until(`document.querySelectorAll('${PANE}').length > 0`)

const newSession = (page) =>
  page.evaluate(`(() => { document.querySelector('[data-rail-new]').click(); return true })()`)

const tabIds = (page) =>
  page.evaluate(`Array.from(document.querySelectorAll('${TAB}')).map(t => t.dataset.workspaceTab)`)

const clickTab = (page, id) =>
  page.evaluate(`(() => {
    document.querySelector('${TAB}[data-workspace-tab="${id}"]').click()
    return true
  })()`)

const say = (page, text) =>
  page.evaluate(`(() => {
    const ta = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      .set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.composer').requestSubmit()
    return true
  })()`)

/** The scroller belonging to one conversation, wherever its tab now lives. */
const scoreOf = (page, id) =>
  page.evaluate(`(() => {
    const tab = document.querySelector('[data-workspace-tab="${id}"]')
    if (tab === null) return null
    const group = tab.closest('[data-workspace-pane]')
    const el = group === null ? null : group.querySelector('.score')
    if (el === null) return null
    return {
      top: Math.round(el.scrollTop),
      max: Math.round(el.scrollHeight - el.clientHeight),
      height: Math.round(el.scrollHeight),
    }
  })()`)

ensureBuilt()

const app = await launch()
let failures = 0
const note = (line) => {
  console.log(line)
}

try {
  /*
   * A short window rather than a tall transcript.
   *
   * Two earlier attempts tried to grow the content instead: asking an agent for
   * a long reply timed out, because a temp `CHORUS_USER_DATA` has no authed CLI
   * to answer, and one 150-line message is clamped by `Entry.tsx` to 78px of
   * scroll. Shrinking the viewport gets the same overflow from what a session
   * already has.
   *
   * It does *not* soften what is being tested, which was the reason for not
   * simply injecting a `min-height`: the transcript still measures after mount,
   * so the late-measurement window the bug lives in is intact. Only the room is
   * smaller.
   */
  await app.viewport(1000, 360)
  await started(app)
  await newSession(app)
  await app.until(`document.querySelectorAll('${TAB}').length === 2`, { timeout: 120_000 })
  const ids = await tabIds(app)
  const target = ids[ids.length - 1]
  note(`sessions: ${ids.join(', ')}  — driving ${target}`)

  /*
   * A tall transcript without waiting on an agent.
   *
   * The first attempt asked for a long reply and timed out: a fresh session in a
   * temp `CHORUS_USER_DATA` has no agent to answer. The user's *own* message is
   * rendered the moment it is sent, and 150 lines of it makes the scroller as
   * tall as any answer would — which is all this probe needs, since the bug is
   * about restoring a position, not about who wrote what is above it.
   */
  const tall = Array.from({ length: 150 }, (_, i) => `line ${String(i + 1)}`).join('\n')
  await say(app, tall)
  await app.until(
    `(() => { const el = document.querySelector('.score'); return el !== null && el.scrollHeight - el.clientHeight > 200 })()`,
    { timeout: 60_000, label: 'transcript grew tall enough to scroll' }
  )
  await wait(1500)
  await app.settle()

  // ---- case 1: parked. Scroll up with a real wheel gesture so following stops.
  await app.evaluate(`(() => {
    const el = document.querySelector('.score')
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true }))
    /*
     * Well clear of the bottom, and 120 was not. (No backticks in here: this
     * comment lives inside a template literal, and quoting an identifier would
     * close the string -- the trap CLAUDE.md records for SQL, one language over.)
     *
     * onScroll resumes following within 32px of the end, deliberately: arriving
     * at the bottom is unambiguous however you got there. The spare room
     * makeRoom holds also shrinks on remount, measured 209 to 141, so a view
     * parked at 120 became 21px from the end and re-followed correctly. The
     * probe then reported a 21px drift and called that a pass while the view sat
     * at the bottom. Parking here leaves ~100px, which no threshold claims.
     */
    el.scrollTop = 40
    return true
  })()`)
  await app.settle()
  const parkedBefore = await scoreOf(app, target)
  note(`parked  before: top=${parkedBefore.top} of max=${parkedBefore.max}`)

  /*
   * A tab switch, not a split, and the difference is what makes this assertable.
   *
   * Splitting remounts the pane *and* halves its width, so the content reflows
   * and the scroll range moves with it — measured, 209 to 141. "Came back to
   * where it was" then has no fixed meaning, and the first version of this probe
   * hid that behind an assertion that only caught landing at the very top. It
   * passed while the view sat at the bottom.
   *
   * Switching away and back unmounts and remounts at an unchanged width, so the
   * range is the same before and after and the position can simply be compared.
   * The split still exercises a superset of this; it is a worse *measurement*.
   */
  await clickTab(app, ids[0])
  await wait(400)
  await app.settle()
  await clickTab(app, target)

  /*
   * Sampled rather than measured once, because "came back wrong" and "came back
   * right and was then moved" need different fixes and look identical at rest.
   */
  const trace = []
  for (let i = 0; i < 8; i++) {
    trace.push(await scoreOf(app, target))
    await wait(120)
  }
  note(`  trace: ${trace.map((s) => (s === null ? 'x' : `${s.top}/${s.max}`)).join(' ')}`)

  await wait(600)
  await app.settle()

  const parkedAfter = await scoreOf(app, target)
  note(`parked  after:  top=${parkedAfter.top} of max=${parkedAfter.max}`)
  const drift = Math.abs(parkedAfter.top - parkedBefore.top)
  if (drift > 24) {
    const where = parkedAfter.top <= 4 ? 'at the top' : `${String(drift)}px away`
    note(`  FAIL — a parked transcript came back ${where}`)
    failures++
  } else {
    note(`  ok — position survived the remount (${String(drift)}px drift)`)
  }

  // ---- case 2: following. Sit at the bottom, switch away and back.
  await app.evaluate(`(() => {
    const el = document.querySelector('.score')
    el.scrollTop = el.scrollHeight
    return true
  })()`)
  await app.settle()
  const followBefore = await scoreOf(app, target)
  note(`follow  before: top=${followBefore.top} of max=${followBefore.max}`)

  await clickTab(app, ids[0])
  await wait(400)
  await app.settle()
  await clickTab(app, target)
  await wait(800)
  await app.settle()

  const followAfter = await scoreOf(app, target)
  note(`follow  after:  top=${followAfter.top} of max=${followAfter.max}`)
  if (followAfter.max - followAfter.top > 32) {
    note('  FAIL — a following transcript did not come back at the bottom')
    failures++
  } else {
    note('  ok — still pinned to the bottom')
  }
} finally {
  /*
   * `quit`, not `close`. The first version of this called `app.close?.()` — the
   * harness has no such method, so optional chaining made it a silent no-op and
   * every run left a live Electron behind. Five of them, before anyone noticed.
   */
  await app.quit()
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILED`)
process.exit(failures === 0 ? 0 : 1)
