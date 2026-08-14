import { writeFileSync } from 'node:fs'
import { ensureBuilt, launch, wait } from './harness.mjs'

/**
 * The readable-control-rail performance scenario.
 *
 * A separate entry point rather than a spec, because it is not a pass/fail
 * question. It drives one workload against the real app and writes the numbers
 * down, so "the rail is faster" can be a measurement instead of an impression.
 *
 * Run it before a change and after it:
 *
 *   node apps/desktop/e2e/perf-rail.mjs --sessions 6 --out /tmp/before.json
 *   node apps/desktop/e2e/perf-rail.mjs --sessions 6 --out /tmp/after.json
 *
 * Selectors are resolved with fallbacks on purpose. The whole point is to
 * compare the collapsed rail against the activity bar it replaces, and a script
 * that only knows the new names can only measure the new build.
 */

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? fallback : args[at + 1]
}

const SESSIONS = Number(option('sessions', '6'))
const OUT = option('out', null)

/*
 * Budgets from the plan, kept here so a run says whether it met them rather
 * than leaving that to whoever reads the JSON.
 *
 * `interaction` is the product target; 200ms is the published INP "good"
 * ceiling and the point at which a reading is a failure rather than a regret.
 */
const BUDGET = { interaction: 100, ceiling: 200, preview: 100, droppedFrames: 1 }

/** Chrome's own counters, which is where layout and style time actually live. */
async function metrics(app) {
  const { metrics: values } = await app.send('Performance.getMetrics')
  return Object.fromEntries(values.map((m) => [m.name, m.value]))
}

function delta(before, after, keys) {
  return Object.fromEntries(
    keys.map((key) => [key, Number((((after[key] ?? 0) - (before[key] ?? 0)) * 1000).toFixed(2))])
  )
}

const TIMED = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']

/**
 * How long from an interaction to the paint that answers it.
 *
 * Two frames rather than one: the first callback runs before the commit that
 * the interaction caused has been painted, so measuring there reports the
 * scheduling delay and not the thing a person sees.
 */
const INTERACTION = (body) => `(async () => {
  const start = performance.now();
  ${body};
  await new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(resolve) }) });
  return Math.round(performance.now() - start)
})()`

/** Counts frames longer than two 120Hz frames while `body` runs. */
const FRAMES = (ms) => `(async () => {
  const gaps = []
  let last = performance.now()
  let stop = false
  const tick = (now) => { gaps.push(now - last); last = now; if (!stop) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  await new Promise((resolve) => { setTimeout(resolve, ${String(ms)}) })
  stop = true
  const dropped = gaps.filter((g) => g > 16.7).length
  return {
    frames: gaps.length,
    dropped,
    droppedPercent: gaps.length === 0 ? null : Number(((dropped / gaps.length) * 100).toFixed(2)),
    p95: gaps.length === 0 ? null : Number(gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length * 0.95)].toFixed(2)),
  }
})()`

/** The rail, whichever generation of it this build has. */
const RAIL = `(document.querySelector('.quick-rail') ?? document.querySelector('.activity-bar'))`
const DRAWER = `(document.querySelector('.session-drawer') ?? document.querySelector('.workspace-sidebar'))`
const NEW_SESSION = `(document.querySelector('[data-rail-new]')
  ?? document.querySelectorAll('.activity-group:first-child .activity-item')[1])`
const DRAWER_TOGGLE = `(document.querySelector('[data-rail-drawer]')
  ?? document.querySelectorAll('.activity-group:first-child .activity-item')[0])`

async function newSession(app) {
  await app.evaluate(`(() => { ${NEW_SESSION}.click(); return true })()`)
}

async function run() {
  ensureBuilt()
  const app = await launch()
  const report = { sessions: SESSIONS, budgets: BUDGET, readings: {} }
  try {
    // Without this every counter reads zero, which looks like a very fast app.
    await app.send('Performance.enable', { timeDomain: 'timeTicks' })
    await app.until(`document.querySelectorAll('.pane').length > 0`, {
      timeout: 120_000,
      label: 'the first session opened',
    })

    for (let i = 1; i < SESSIONS; i++) {
      await newSession(app)
      await app.until(
        `document.querySelectorAll('[data-workspace-tab]').length === ${String(i + 1)}`,
        {
          timeout: 120_000,
          label: `session ${String(i + 1)} opened`,
        }
      )
    }
    await app.settle()

    report.readings.shortcutCount = await app.evaluate(
      `${RAIL}.querySelectorAll('[data-rail-session]').length`
    )
    report.readings.rowCount = await app.evaluate(
      `document.querySelectorAll('[data-sidebar-conversation]').length`
    )

    /*
     * Every workload is measured the same way: reset the render counters, take
     * Chrome's metrics, do the thing, take them again.
     */
    const workload = async (name, expression) => {
      await app.evaluate(`(window.__chorusRenderCounts = {}, true)`)
      const before = await metrics(app)
      const painted = await app.evaluate(INTERACTION(expression))
      const after = await metrics(app)
      await app.settle()
      report.readings[name] = {
        paintedMs: painted,
        withinTarget: painted <= BUDGET.interaction,
        withinCeiling: painted <= BUDGET.ceiling,
        ...delta(before, after, TIMED),
        renders: await app.evaluate(`window.__chorusRenderCounts ?? null`),
      }
    }

    /* Switching between two sessions from the rail, which is the daily loop. */
    await workload(
      'railSwitch',
      `const shortcuts = ${RAIL}.querySelectorAll('[data-rail-session]')
       const rows = document.querySelectorAll('[data-sidebar-conversation]')
       const target = shortcuts[1] ?? rows[1]?.querySelector('button')
       target?.click()`
    )

    await workload('railScroll', `${RAIL}.querySelector('[data-rail-scroll]')?.scrollBy(0, 240)`)

    await workload('drawerToggle', `${DRAWER_TOGGLE}.click()`)
    await workload('drawerToggleBack', `${DRAWER_TOGGLE}.click()`)

    await workload(
      'search',
      `const input = ${DRAWER}?.querySelector('input[type="search"]')
       if (input !== null && input !== undefined) {
         Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'e')
         input.dispatchEvent(new Event('input', { bubbles: true }))
       }`
    )

    await workload(
      'previewOpen',
      `const trigger = ${RAIL}.querySelector('[data-rail-session]')
         ?? document.querySelector('[data-sidebar-conversation] button')
       // React derives enter/leave from delegated pointerover, so a synthetic
       // pointerenter never reaches the handler.
       trigger?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
       trigger?.focus()`
    )
    /*
     * The preview has an intentional dwell before it opens, so the reading that
     * matters is how long the paint takes *after* that — measured by waiting the
     * dwell out and then timing the frame the card lands in.
     */
    await wait(400)
    report.readings.previewPresent = await app.evaluate(
      `document.querySelectorAll('.session-preview').length > 0`
    )
    await workload(
      'previewClose',
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )

    await workload(
      'splitPane',
      `document.dispatchEvent(new KeyboardEvent('keydown', {
         key: '\\\\', metaKey: true, bubbles: true, cancelable: true }))`
    )
    report.readings.paneCount = await app.evaluate(
      `document.querySelectorAll('[data-workspace-pane]').length`
    )

    await workload(
      'terminalOpen',
      `document.dispatchEvent(new KeyboardEvent('keydown', {
         key: 'j', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))`
    )
    await wait(600)
    await workload(
      'terminalClose',
      `document.dispatchEvent(new KeyboardEvent('keydown', {
         key: 'j', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))`
    )

    /* Idle frames, as the control the streaming reading is compared against. */
    report.readings.idleFrames = await app.evaluate(FRAMES(2_000))

    /*
     * The reading the whole exercise is about: what the rail, the drawer and the
     * shell cost *while an agent streams*.
     *
     * Not deterministic — it needs a real agent and a real reply — so it is
     * reported separately and skipped when no agent answers. Every interaction
     * above is measured on an idle machine and every one of them already met the
     * budget before any of this work; the complaint was never about those.
     */
    await app.evaluate(`(window.__chorusRenderCounts = {}, true)`)
    const streamBefore = await metrics(app)
    const asked = await app.evaluate(`(() => {
      const box = document.querySelector('.composer textarea')
      if (box === null) return false
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
        .set.call(box, 'Write about 2000 characters of markdown prose about ropes.')
      box.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.composer').requestSubmit()
      return true
    })()`)
    if (asked === true) {
      const frames = await app.evaluate(FRAMES(20_000))
      const streamAfter = await metrics(app)
      report.readings.streaming = {
        ...frames,
        ...delta(streamBefore, streamAfter, TIMED),
        renders: await app.evaluate(`window.__chorusRenderCounts ?? null`),
        said: await app.evaluate(`document.querySelectorAll('.said').length`),
      }
    } else {
      report.readings.streaming = null
    }

    const idleBefore = await metrics(app)
    await wait(3_000)
    const idleAfter = await metrics(app)
    report.readings.idleCost = delta(idleBefore, idleAfter, TIMED)
  } finally {
    await app.quit()
  }

  const json = JSON.stringify(report, null, 2)
  if (OUT !== null) writeFileSync(OUT, `${json}\n`)
  process.stdout.write(`${json}\n`)
}

await run()
