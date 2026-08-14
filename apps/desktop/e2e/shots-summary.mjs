import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBuilt, launch, wait } from './harness.mjs'

/**
 * The `Summary` card, photographed from a reply that followed the convention.
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
const NAME = option('name', '03-summary-card')
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
    'Change RATE to 2 in src/rate.ts. Then reply with one sentence, and end your ' +
      'reply with a "## Summary" heading followed by two bullet points — nothing after them.'
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
  }))()`)
  console.log(JSON.stringify(seen, null, 2))

  const card = await app.evaluate(`(() => {
    const el = document.querySelector('.summary-card')
    if (el === null) return { summaries: 0 }
    const said = el.closest('.said')
    return {
      summaries: document.querySelectorAll('.summary-card').length,
      bullets: [...el.querySelectorAll('li')].map((li) => li.textContent),
      // Lifted, not left behind: the words must not appear twice.
      bodyStillHasHeading: (said?.textContent ?? '').includes('Summary\\n'),
      changes: document.querySelectorAll('.changes-card').length,
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
