import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { ensureBuilt, launch, wait } from './harness.mjs'

/**
 * What opening a long conversation costs in a real renderer.
 *
 * A separate entry point rather than a spec, because it is not a pass/fail
 * question — it drives one workload against the real app and writes the numbers
 * down. `profile/transcript-timeline.profile.ts` measures the CPU path from SQL
 * to reduction and cannot see past it; this measures the half that only exists
 * in a window: commit, an approximation of paint, and what the heap keeps.
 *
 * **This is the run that decides Phase 5 against Phase 6.** The CPU profile
 * established that the reduction dominates everything upstream of the DOM, and
 * that virtualising cannot touch it. It could not establish priority, because
 * priority depends on how much of the freeze the user actually sees is commit
 * and paint — which is this.
 *
 *   node apps/desktop/e2e/perf-transcript.mjs --out /tmp/paint.json
 *
 * **It launches no agent.** `CHORUS_PROFILE_READONLY=1` makes command resolution
 * return null and restore return nothing, so no `claude` or `codex` starts. That
 * is asserted here rather than assumed, by counting matching processes around
 * the run — and the event count in the database is compared before and after, so
 * a run that appended anything is a failed run rather than a quiet one.
 *
 * **Against a copy, never the live store.** The copy is made fresh each time, so
 * two runs measure the same conversation.
 */

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? fallback : args[at + 1]
}

const SOURCE = option('fixture', '/tmp/chorus-profile/fixture')
const WORK = option('work', '/tmp/chorus-profile/run')
const OUT = option('out', '/tmp/chorus-profile/paint.json')

const FIXTURES = [
  { name: 'byte-heavy', id: '019ff9c5-d999-7e66-b7af-8a0a35bde4e1' },
  { name: 'entry-heavy', id: '019fe5f6-9477-7181-ba52-3b28dcf4dece' },
]

/**
 * A small conversation, chosen from the history list at run time, doing two jobs
 * that both need a constant.
 *
 * **Warm-up.** The first fixture measured pays every one-time cost of the first
 * transcript in the process — lazy chunks, fonts, first layout — and the run
 * that taught me this reported the *smaller* conversation as taking 5.5s to
 * paint and the larger one 0.16s, which is backwards and was pure ordering.
 * Opening one first pays those costs where they are not being measured.
 *
 * **A constant neighbour.** Panes stay mounted, so "heap after backgrounding"
 * depends on whatever else is on screen. Switching to the same conversation
 * every time makes the two fixtures comparable to each other.
 *
 * Chosen from the DOM rather than hardcoded: `listConversations` caps at 200 by
 * recency, so an id picked out of the database by event count is very likely not
 * to be in the list at all — which is how the first attempt failed.
 */
let baselineId = null

const require = createRequire(import.meta.url)
// Three levels up, not two: this file is apps/desktop/e2e. The workspace root
// has no better-sqlite3 of its own — pnpm puts it under the package that
// declares it — so it is reached by path rather than by resolution.
const Database = require('../../../packages/event-store/node_modules/better-sqlite3')

/** Rows in the log, so an append during the run cannot go unnoticed. */
function eventCount(dir) {
  const db = new Database(`${dir}/chorus.db`, { readonly: true })
  try {
    return db.prepare('SELECT COUNT(*) n FROM events').get().n
  } finally {
    db.close()
  }
}

/**
 * Agent CLIs running right now.
 *
 * `pgrep -f` matches the whole command line, and the point is the *delta* rather
 * than the absolute: the user may well have a `claude` of their own open, and
 * failing the run for that would make it unrunnable on the machine it is for.
 */
function agentProcesses() {
  try {
    const out = execFileSync('pgrep', ['-fl', '(^|/)(claude|codex)( |$)'], { encoding: 'utf8' })
    return out.trim() === '' ? [] : out.trim().split('\n')
  } catch {
    // pgrep exits 1 when nothing matched, which is the common case here.
    return []
  }
}

/**
 * Opens a past conversation the way a person does.
 *
 * The rail's history button was missing when this was first written — the
 * redesign in `debaae0` dropped `onOpenHistory` and nothing set `showingHistory`
 * any more, so `HistoryPanel` rendered for nobody. Restoring that button is what
 * made this route exist; seeding the restore list was the workaround and it is
 * gone.
 */
async function openHistorySheet(app) {
  await app.evaluate(
    `(() => { document.querySelector('[data-rail-history]').click(); return true })()`
  )
  await app.until(`document.querySelector('.history-row') !== null`, {
    timeout: 60_000,
    label: 'the history sheet listed the log',
  })
}

/** The last row in the list that is not one of the fixtures — the oldest of them. */
async function pickBaseline(app) {
  await openHistorySheet(app)
  const ids = JSON.parse(
    await app.evaluate(`JSON.stringify(
      [...document.querySelectorAll('[data-history-conversation]')]
        .map((e) => e.getAttribute('data-history-conversation'))
    )`)
  )
  const fixtures = new Set(FIXTURES.map((f) => f.id))
  const found = [...ids].reverse().find((id) => !fixtures.has(id))
  if (found === undefined)
    throw new Error('no conversation in the history list to use as a baseline')
  return found
}

async function openFromHistory(app, id) {
  await openHistorySheet(app)
  const row = `[data-history-conversation="${id}"]`
  const present = await app.evaluate(`document.querySelector('${row}') !== null`)
  if (present !== true) throw new Error(`${id} is not in the history list`)
  await app.evaluate(`(() => { document.querySelector('${row}').click(); return true })()`)
}

/** Chromium's own collector, then its own heap number. Not `performance.memory`. */
async function heapAfterGc(app) {
  await app.send('HeapProfiler.collectGarbage')
  // Twice, with a beat: the first pass frees the objects, the second frees what
  // only became unreachable once the first had run.
  await wait(300)
  await app.send('HeapProfiler.collectGarbage')
  const usage = await app.send('Runtime.getHeapUsage')
  return Math.round(usage.usedSize)
}

/**
 * One fixture, mounted from cold and measured.
 *
 * The sink is armed *before* the switch, and each measurement is a remount
 * rather than the app's very first paint — by the time a debugger can arm
 * anything the initial mount has already happened. A remount reduces and commits
 * the same transcript, which is the cost being measured.
 */
/** Rows and DOM nodes across every mounted pane — a delta, not an absolute. */
async function counts(app) {
  const raw = await app.evaluate(`JSON.stringify({
    rows: document.querySelectorAll('.entry').length,
    nodes: document.querySelectorAll('.score-content *').length
  })`)
  return JSON.parse(raw)
}

async function measure(app, fixture) {
  /*
   * Counted before and after, because `.entry` spans every mounted pane and up
   * to four stay mounted. An absolute count here was 5,502 rows for a
   * conversation the CPU profile reduces to 1,219 — it was counting the
   * neighbours. The delta is this fixture's contribution.
   */
  const before = await counts(app)
  await app.evaluate(`(() => { window.__chorusProfile = {}; return true })()`)

  const openedAt = Date.now()
  await openFromHistory(app, fixture.id)

  try {
    await app.until(`(window.__chorusProfile ?? {}).paintedApprox !== undefined`, {
      // 180s, not 60s. Lowering this while adding the console dump made the
      // failure alternate between fixtures run to run, which reads like a
      // nondeterministic bug and was a deadline that a cold first mount on a
      // large fixture simply outruns.
      timeout: 180_000,
      label: `${fixture.name}: the transcript committed and two frames followed`,
    })
  } catch (error) {
    // What the renderer said on the way down. Without this the difference
    // between "slow" and "threw during render" is invisible from out here.
    const said = app.console().slice(-25).join('\n')
    throw new Error(`${error.message}\n\n--- renderer console ---\n${said}`, { cause: error })
  }
  const wallMs = Date.now() - openedAt

  const marks = JSON.parse(await app.evaluate(`JSON.stringify(window.__chorusProfile)`))
  const after = await counts(app)
  const heapMountedBytes = await heapAfterGc(app)

  /*
   * Correctness, not speed. Mounting 34 of 4,276 rows is only an improvement if
   * the other 4,242 are still reachable — a window that silently dropped them
   * would look identical on every number above.
   *
   * These run in Chromium because none of them can be checked anywhere else:
   * jsdom does no layout, so `scrollHeight` is 0, `ResizeObserver` never fires
   * and a selection across nodes is not modelled.
   */
  /*
   * Driven from Node, one short evaluate at a time.
   *
   * This used to be a single async `Runtime.evaluate` that waited on frames and
   * timers inside the page. Chromium throttles both in a window it considers
   * occluded, so the whole block would sit there until the 120s command timeout
   * whenever another Electron had the foreground -- reported as a timeout naming
   * the expression, which says nothing about the cause. The repo already records
   * this trap for `bringToFront`; the fix is to keep the waiting out here.
   */
  const scroller = `document.querySelector('[data-conversation="${fixture.id}"] .score')`
  // Rows are mounted in full again -- Phase 6 is deferred -- so there is no
  // `data-row-index` to read and the count is the thing that moves.
  const rowsIn = `document.querySelectorAll('[data-conversation="${fixture.id}"] .entry').length`
  const read = async (expression) => JSON.parse(await app.evaluate(`JSON.stringify(${expression})`))
  const settle = async (times = 3) => {
    for (let i = 0; i < times; i++) await wait(140)
  }

  const scrollable = await read(
    `(() => { const el = ${scroller}; return el.scrollHeight - el.clientHeight })()`
  )
  const rowsAtStart = await read(rowsIn)
  const heightBeforePaging = await read(`${scroller}.scrollHeight`)

  // A wheel first: following stops on a GESTURE, not a position, so assigning
  // scrollTop alone leaves the pane following and rendering its tail.
  await app.evaluate(
    `(() => { const el = ${scroller}; el.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true })); el.scrollTop = 0; return true })()`
  )
  await settle()
  const rowsAtTop = await read(rowsIn)

  let grewBy = (await read(`${scroller}.scrollHeight`)) - heightBeforePaging
  for (let i = 0; i < 40 && grewBy <= 0; i++) {
    await wait(150)
    grewBy = (await read(`${scroller}.scrollHeight`)) - heightBeforePaging
    if (grewBy <= 0) await app.evaluate(`(() => { ${scroller}.scrollTop = 0; return true })()`)
  }

  await app.evaluate(
    `(() => { const el = ${scroller}; el.scrollTop = el.scrollHeight; return true })()`
  )
  await settle()
  await app.evaluate(
    `(() => { const el = ${scroller}; el.scrollTop = el.scrollHeight; return true })()`
  )
  await settle()
  const rowsBackAtBottom = await read(rowsIn)
  const followingResumed = await read(
    `(() => { const el = ${scroller}; return el.scrollHeight - el.scrollTop - el.clientHeight <= 32 })()`
  )

  // Selection across the window boundary: select near the top, scroll far away,
  // and require the rows to still be mounted.
  await app.evaluate(
    `(() => { const el = ${scroller}; el.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true })); el.scrollTop = 0; return true })()`
  )
  await settle()
  const selected = await read(`(() => {
    const early = [...document.querySelectorAll('[data-conversation="${fixture.id}"] .entry')].slice(0, 3)
    if (early.length < 2) return { held: [], length: 0 }
    const selection = window.getSelection()
    const range = document.createRange()
    range.setStart(early[0], 0)
    range.setEnd(early[early.length - 1], early[early.length - 1].childNodes.length)
    selection.removeAllRanges()
    selection.addRange(range)
    return { held: early.length, length: selection.toString().length }
  })()`)
  await settle(2)
  await app.evaluate(
    `(() => { const el = ${scroller}; el.scrollTop = el.scrollHeight; return true })()`
  )
  await settle()
  const selectionSurvived = await read(`window.getSelection().toString().length`)
  await app.evaluate(`(() => { window.getSelection().removeAllRanges(); return true })()`)

  const checks = {
    scrollable,
    rowsAtStart,
    rowsAtTop,
    rowsBackAtBottom,
    followingResumed,
    pagedInPx: grewBy,
    copiedLength: selected.length,
    // Fully mounted, so nothing can unmount a selection -- what matters is that
    // the text is still there after scrolling away from it.
    selectionPinned: selected.held === 0 ? null : selectionSurvived > 0,
  }

  /*
   * Scroll restore across a remount -- the piece with no coverage at all.
   *
   * `SessionCarry` stopped storing a pixel offset in Phase 6 and stores a row
   * anchor instead, precisely because a pixel offset stops meaning anything once
   * rows above the viewport are estimates. Nothing had ever exercised that
   * across a real unmount: switching panes destroys the component, and the
   * restore effect has to put the reader back using `scrollTopFor`.
   *
   * The assertion is the ROW, not the pixel. Heights are re-measured on the way
   * back, so the exact offset legitimately moves; landing on the same row is
   * what "where I was reading" means.
   */
  await app.evaluate(`(() => {
    const pane = document.querySelector('[data-conversation="${fixture.id}"]')
    const el = pane.querySelector('.score')
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true }))
    el.scrollTop = Math.round(el.scrollHeight * 0.4)
    return true
  })()`)
  await wait(700)
  const wasReading = JSON.parse(
    await app.evaluate(`(() => {
      const pane = document.querySelector('[data-conversation="${fixture.id}"]')
      const el = pane.querySelector('.score')
      return JSON.stringify({ scrollTop: Math.round(el.scrollTop), rows: pane.querySelectorAll('.entry').length })
    })()`)
  )

  await openFromHistory(app, baselineId)
  await wait(600)

  await openFromHistory(app, fixture.id)
  await wait(1_500)

  const cameBack = JSON.parse(
    await app.evaluate(`(() => {
      const pane = document.querySelector('[data-conversation="${fixture.id}"]')
      if (pane === null) return JSON.stringify({ error: 'pane gone' })
      const el = pane.querySelector('.score')
      return JSON.stringify({
        scrollTop: Math.round(el.scrollTop),
        rows: pane.querySelectorAll('.entry').length,
        atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 32,
        carryOut: window.__carryOut ?? null,
        carryIn: window.__carryIn ?? null,
      })
    })()`)
  )

  const restore = { before: wasReading, after: cameBack }

  /*
   * Retention: switch to the baseline conversation, which unmounts this pane and
   * leaves only what `SessionCarry` keeps. Closing instead would measure
   * teardown and say nothing about what a background tab holds. The same
   * neighbour every time, so the two fixtures can be compared.
   */
  await openFromHistory(app, baselineId)
  await wait(800)
  const heapBackgroundedBytes = await heapAfterGc(app)

  return {
    fixture: fixture.name,
    conversationId: fixture.id,
    marks,
    rows: after.rows - before.rows,
    nodes: after.nodes - before.nodes,
    wallMs,
    heapMountedBytes,
    heapBackgroundedBytes,
    checks,
    restore,
  }
}

async function main() {
  await ensureBuilt('production')

  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  /*
   * `open-sessions.json` is not optional, and leaving it out cost a run.
   *
   * The database holds the transcripts; that file holds *which conversations
   * were open*, and it is what restore reads. Without it the app boots with no
   * sessions, `App.tsx` stays on its `aria-busy` empty screen, and there is no
   * drawer to open — which looks exactly like the profiling flag being broken.
   */
  for (const file of [
    'chorus.db',
    'chorus.db-shm',
    'chorus.db-wal',
    'open-sessions.json',
    'settings.json',
  ]) {
    cpSync(`${SOURCE}/${file}`, `${WORK}/${file}`)
  }

  const eventsBefore = eventCount(WORK)
  const agentsBefore = agentProcesses().length

  // Read by `launch` through the inherited environment. Both are required: the
  // first points the app at the copy, the second is what stops it starting
  // anything.
  process.env.CHORUS_PROFILE_READONLY = '1'

  const results = []
  const app = await launch({ userData: WORK, keepData: true })
  try {
    await app.bringToFront()
    // Whatever the fixture had open comes back; the rail is the baseline state.
    await app.until(`document.querySelector('[data-rail-history]') !== null`, {
      timeout: 120_000,
      label: 'the app restored and the rail is up',
    })
    /*
     * The warm-up open, measured and thrown away. Whatever the first transcript
     * in a process costs once — chunks, fonts, first layout — is paid here.
     */
    await app.evaluate(`(() => { window.__chorusProfile = {}; return true })()`)
    baselineId = await pickBaseline(app)
    await openFromHistory(app, baselineId)
    await app.until(`(window.__chorusProfile ?? {}).paintedApprox !== undefined`, {
      timeout: 180_000,
      label: 'the warm-up conversation painted',
    })
    await wait(500)
    const heapAtStart = await heapAfterGc(app)

    for (const fixture of FIXTURES) {
      results.push({ heapAtStartBytes: heapAtStart, ...(await measure(app, fixture)) })
    }
  } finally {
    await app.stop()
  }

  const eventsAfter = eventCount(WORK)
  const agentsAfter = agentProcesses().length

  const report = {
    fixtureSource: SOURCE,
    eventsBefore,
    eventsAfter,
    appendedDuringRun: eventsAfter - eventsBefore,
    agentProcessDelta: agentsAfter - agentsBefore,
    results,
  }

  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)

  // Printed rather than only written, because these two are the run's own
  // preconditions and a reader should not have to open the file to check them.
  console.log(`appended during run: ${report.appendedDuringRun} (must be 0)`)
  console.log(`agent process delta: ${report.agentProcessDelta} (must be 0)`)
  for (const r of report.results) {
    const m = r.marks
    const line = (label, from, to) =>
      `  ${label.padEnd(24)}${`${(to - from).toFixed(1)} ms`.padStart(10)}`
    console.log(`\n${r.fixture} — ${String(r.rows)} rows, ${String(r.nodes)} DOM nodes`)
    console.log(line('received → reduced', m.transcriptReceived, m.reduced))
    console.log(line('reduced → committed', m.reduced, m.committed))
    console.log(line('committed → painted≈', m.committed, m.paintedApprox))
    console.log(`  ${'click → painted≈ (wall)'.padEnd(24)}${`${String(r.wallMs)} ms`.padStart(10)}`)
    const c = r.checks
    const r2 = r.restore
    console.log(
      `  restore: left at ${String(r2.before.scrollTop)}px; ` +
        `came back at ${String(r2.after.scrollTop)}px` +
        `${r2.after.atBottom ? ' — SNAPPED TO BOTTOM' : ''}`
    )
    console.log(
      `  paging: ${c.pagedInPx > 0 ? `an earlier page loaded at the top (+${String(Math.round(c.pagedInPx))}px)` : 'NO EARLIER PAGE ARRIVED'}`
    )
    console.log(
      `  selection: ${c.selectionPinned === null ? 'not exercised' : c.selectionPinned ? `held across the window (${String(c.copiedLength)} chars)` : 'LOST WHEN SCROLLED AWAY'}`
    )
    console.log(
      `  reachable: ${String(Math.round(c.scrollable))}px of scroll; ` +
        `${String(c.rowsAtStart)} rows mounted, ` +
        `following ${c.followingResumed ? 'resumed' : 'DID NOT RESUME'}`
    )
    console.log(
      `  heap: ${(r.heapAtStartBytes / 1048576).toFixed(1)} MB at start → ` +
        `${(r.heapMountedBytes / 1048576).toFixed(1)} MB mounted → ` +
        `${(r.heapBackgroundedBytes / 1048576).toFixed(1)} MB backgrounded`
    )
  }
  console.log(`\nwritten to ${OUT}`)
}

await main()
