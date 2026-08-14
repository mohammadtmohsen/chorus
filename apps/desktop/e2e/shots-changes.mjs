import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBuilt, launch, wait } from './harness.mjs'

/**
 * The `Changes` card, photographed from a turn that really edited files.
 *
 * The card is the one thing in this plan that cannot be judged from a fixture:
 * its whole point is that the counts came off a provider's own report of what it
 * did. So this drives a scratch project, asks an agent to make two small edits,
 * and captures what the transcript drew — plus the card's contents read back out
 * of the DOM, because a screenshot of an empty card and a screenshot of a
 * correct one differ by about forty pixels.
 *
 *   node apps/desktop/e2e/shots-changes.mjs --out docs/plans/…/visuals
 *
 * The conversation runs under the `trusted` profile: an edit under the default
 * one stops on an approval card, which is a picture of the approval rather than
 * of the change.
 */

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? fallback : args[at + 1]
}

const OUT = option(
  'out',
  new URL('../../../docs/plans/transcript-design-match-2026-08-13/visuals', import.meta.url)
    .pathname
)
const NAME = option('name', '02-changes-card')
const WIDTH = Number(option('width', '1440'))
const HEIGHT = Number(option('height', '900'))

const say = (page, text) =>
  page.evaluate(`(() => {
    const ta = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      .set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.composer').requestSubmit()
    return true
  })()`)

/* A project with something to edit, and something to add beside it. */
const project = mkdtempSync(join(tmpdir(), 'chorus-changes-'))
mkdirSync(join(project, 'src'), { recursive: true })
writeFileSync(
  join(project, 'src/rate.ts'),
  ['export const RATE = 1', 'export const NAME = "payments"', ''].join('\n')
)

ensureBuilt()
mkdirSync(OUT, { recursive: true })

/*
 * Set up in one launch, drive in the next.
 *
 * A session is started with the cwd it had when it opened; setting the project
 * directory over IPC changes the store, not the agent already running under the
 * old one. `shots-rail.mjs` quits between the two for the same reason.
 */
const setup = await launch({ keepData: true })
try {
  await setup.until(`document.querySelectorAll('.pane').length > 0`)
  const id = await setup.evaluate(
    `document.querySelector('[data-workspace-tab]').dataset.workspaceTab`
  )
  await setup.evaluate(
    `window.chorus.setProjectDirectory({ conversationId: ${JSON.stringify(id)}, cwd: ${JSON.stringify(project)} }).then(() => true)`
  )
  await setup.evaluate(
    `window.chorus.setProfile({ conversationId: ${JSON.stringify(id)}, profileId: 'trusted' }).then(() => true)`
  )
  // The layout write is debounced; quitting inside that window loses the tab.
  await wait(2_000)
} finally {
  await setup.stop()
}

const app = await launch({ userData: setup.dataPath })
try {
  await app.until(`document.querySelectorAll('.pane').length > 0`)
  await app.bringToFront()
  await app.viewport(WIDTH, HEIGHT)
  await app.settle()

  await say(
    app,
    'Two edits, no commentary beyond one sentence: change RATE to 2 in src/rate.ts, ' +
      'and create src/fee.ts containing `export const FEE = 0.3`. Then say what you did in one sentence.'
  )

  /*
   * Waiting on the reply rather than on the card, and never throwing on it: if
   * nothing appears, what the transcript *did* get is the finding, and a
   * timeout that hides it is a wasted two-minute run.
   */
  try {
    /*
     * Started, *then* ended — and both halves are needed.
     *
     * "A reply completed" is not the end of a turn: an agent that says "I'll
     * make both edits" before touching anything satisfies it while the work that
     * draws the card has not begun. And "no stop button" is true in the gap
     * between submitting and the turn starting, so waiting only for that returns
     * instantly. Two runs were spent on those two mistakes.
     */
    await app.until(`!!document.querySelector('.send--stop')`, {
      timeout: 120_000,
      label: 'the turn started',
    })
    await app.until(`!document.querySelector('.send--stop')`, {
      timeout: 300_000,
      label: 'the turn ended',
    })
  } catch (error) {
    console.log(`turn did not run to completion: ${String(error)}`)
  }
  await wait(3_000)
  await app.settle()

  const seen = await app.evaluate(`(() => ({
    kinds: [...document.querySelectorAll('.entry')].map((e) => e.dataset.kind),
    tools: [...document.querySelectorAll('.entry--tool')].map((e) => ({
      name: e.querySelector('.said')?.textContent?.slice(0, 40) ?? '',
      patch: !!e.querySelector('.tool-patch'),
    })),
    approvals: document.querySelectorAll('.approval').length,
    // A run of one agent's work should caption itself once, with no rules
    // drawn between the rows of it.
    speakers: [...document.querySelectorAll('.entry .speaker:not(.sr-only)')].length,
    grouped: document.querySelectorAll('.entry[data-grouped="true"]').length,
    dividersInsideRuns: [...document.querySelectorAll('.entry[data-grouped="true"]')].filter(
      (e) => getComputedStyle(e).borderTopWidth !== '0px'
    ).length,
    // The dot belongs on the line it marks, not above it.
    dotOffsets: [...document.querySelectorAll('.entry[data-grouped="true"]')].map((e) => {
      const dot = e.querySelector('.tick')?.getBoundingClientRect()
      const body = e.querySelector('.said, .notice-line, .command-fold')?.getBoundingClientRect()
      if (!dot || !body) return null
      return Math.round(dot.top + dot.height / 2 - body.top)
    }),
    // Nothing may be auto-placed outside the grid: an orphaned grid-area is
    // silent, and it put two controls against the right edge of the pane.
    strays: [...document.querySelectorAll('.entry > *')].filter((el) => {
      const entry = el.closest('.entry').getBoundingClientRect()
      const box = el.getBoundingClientRect()
      return box.width > 0 && box.right > entry.right - 4 && box.left > entry.left + entry.width / 2
    }).length,
    ruleAfterMessage: (() => {
      const message = [...document.querySelectorAll('.entry[data-kind="message"]')].pop()
      const next = message?.nextElementSibling
      return next === null || next === undefined
        ? null
        : getComputedStyle(next).borderTopWidth
    })(),
    // What the column actually looks like: the gap between consecutive rows of
    // one run, and whether each dot sits on its own first line.
    runGaps: (() => {
      const rows = [...document.querySelectorAll('.entry[data-grouped="true"]')]
      return rows.slice(1).map((row, i) => {
        const above = rows[i].getBoundingClientRect()
        return Math.round(row.getBoundingClientRect().top - above.bottom)
      })
    })(),
    markedRows: [...document.querySelectorAll('.entry[data-grouped="true"]')].map((e) => {
      const dot = e.querySelector('.tick')?.getBoundingClientRect()
      const body = e.querySelector('.said, .notice-line, .command-fold')
      const box = body?.getBoundingClientRect()
      if (!dot || !box) return null
      const lh = parseFloat(getComputedStyle(body).lineHeight) || 20
      // Zero means the dot's centre is on the first line's centre.
      return {
        kind: e.dataset.kind,
        offFirstLine: Math.round(dot.top + dot.height / 2 - (box.top + lh / 2)),
      }
    }),
    // Dot, body and action on one line: three tops within a line of each other.
    // Every time in the column ends at the same x, whatever else is on its row.
    timeRights: [...document.querySelectorAll('.entry-time')].map((t) =>
      Math.round(t.getBoundingClientRect().right)
    ),
    handoffRows: [...document.querySelectorAll('.entry:has(.handoff-action)')].map((e) => {
      const dot = e.querySelector('.tick')?.getBoundingClientRect()
      const body = e.querySelector('.said, .notice-line, .command-fold')?.getBoundingClientRect()
      const action = e.querySelector('.handoff-action').getBoundingClientRect()
      return {
        kind: e.dataset.kind,
        grouped: e.dataset.grouped ?? 'no',
        dotToBody: dot && body ? Math.round(dot.top - body.top) : null,
        actionToBody: body ? Math.round(action.top - body.top) : null,
        colour: getComputedStyle(e.querySelector('.handoff-action')).color,
      }
    }),
    markProbe: (() => {
      const e = document.querySelector('.entry[data-grouped="true"]')
      if (e === null) return null
      const mark = e.querySelector('.entry-mark')
      const body = e.querySelector('.said, .notice-line, .command-fold')
      const ms = getComputedStyle(mark)
      return {
        headHidden: getComputedStyle(e.querySelector('.entry-head')).display,
        markRow: ms.gridRowStart,
        markPadTop: ms.paddingTop,
        markTop: Math.round(mark.getBoundingClientRect().top),
        bodyTop: Math.round(body.getBoundingClientRect().top),
        entryTop: Math.round(e.getBoundingClientRect().top),
      }
    })(),
    thinkingColour: (() => {
      const mark = document.querySelector('.entry--reasoning .tick')
      const toggle = document.querySelector('.reasoning-toggle')
      return mark === null
        ? null
        : {
            border: getComputedStyle(mark).borderTopColor,
            toggle: toggle === null ? null : getComputedStyle(toggle).color,
            voice: getComputedStyle(mark.closest('.entry')).getPropertyValue('--voice').trim(),
          }
    })(),
  }))()`)
  console.log(JSON.stringify(seen, null, 2))

  const card = await app.evaluate(`(() => {
    const el = document.querySelector('.changes-card')
    if (el === null) return null
    const entry = el.closest('.entry')
    const rows = [...el.querySelectorAll('.changes-row')].map((r) => ({
      letter: r.querySelector('.changes-letter').textContent,
      path: r.querySelector('.changes-path').textContent,
      added: r.querySelector('.changes-added')?.textContent ?? null,
      removed: r.querySelector('.changes-removed')?.textContent ?? null,
    }))
    const kinds = [...document.querySelectorAll('.entry')].map((e) => e.dataset.kind)
    return {
      rows,
      cards: document.querySelectorAll('.changes-card').length,
      // The composition puts the card under the words that describe it.
      afterMessage: kinds[kinds.indexOf('changes') - 1] ?? null,
      actor: entry?.dataset.actor ?? null,
    }
  })()`)

  await app.send('Page.captureScreenshot', { format: 'png' })
  await app.settle()
  const { data } = await app.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  const bytes = Buffer.from(data, 'base64')
  const file = join(OUT, `${NAME}.png`)
  writeFileSync(file, bytes)

  console.log(
    `${file}  ${String(bytes.readUInt32BE(16))}×${String(bytes.readUInt32BE(20))}  ${String(bytes.length)} bytes`
  )
  console.log(JSON.stringify(card, null, 2))
  console.log(`project: ${project}`)
} finally {
  await app.quit()
}
