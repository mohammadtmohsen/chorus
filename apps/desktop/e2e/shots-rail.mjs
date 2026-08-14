import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBuilt, launch, wait } from './harness.mjs'
import { existingDescriptors, FakeIde, waitForDescriptor } from './fake-ide.mjs'

/**
 * Screenshots of the workspace as it is actually built.
 *
 * A separate entry point rather than a spec, for the same reason `perf-rail.mjs`
 * is: there is no pass or fail here. It exists because the plan's visual
 * appendix is a set of *generated concept mockups* — useful for reviewing
 * hierarchy, useless for answering "does the thing that shipped look like that".
 * Everything below is the real renderer out of `out/`, driven over the debugger
 * protocol, in a fresh `userData` that has never seen another session.
 *
 *   node apps/desktop/e2e/shots-rail.mjs --out docs/plans/…/visuals
 *
 * `Page.captureScreenshot` rather than anything screen-recording, so this needs
 * no Computer Use permission and captures the window's own surface rather than
 * whatever is in front of it.
 *
 * **The composite state is the point.** The reference composition is not a
 * screenshot of a resting app: it is one workspace holding two panes, a session
 * terminal in the left one, a live editor selection in its composer, and a rail
 * session being dragged onto the right pane's edge with the split target under
 * it. Every one of those is driven here, and the drag is photographed *while it
 * is happening* — a capture after the drop is a picture of a different state.
 */

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? fallback : args[at + 1]
}

const OUT = option(
  'out',
  new URL('../../../docs/plans/readable-control-rail-2026-08-13/visuals', import.meta.url).pathname
)
const WIDTH = Number(option('width', '1440'))
const HEIGHT = Number(option('height', '900'))

/**
 * The four sessions, and why there are four.
 *
 * Two are open, one per pane, which is the composition. The other two are in the
 * list and in no pane — which is what makes the drag in the first shot a real
 * one: a session that is nowhere can be dropped onto any pane's edge, where a
 * pane's only tab dragged onto its own pane is a refused split and draws the
 * disabled target rather than the blue one.
 *
 * The monograms fall out of the titles: PA, AC, SI, DR.
 */
const SESSIONS = ['Payments API', 'API contracts', 'Search indexing', 'Docs review']
const LEFT = 'Payments API'
const RIGHT = 'Search indexing'
const DRAGGED = 'Docs review'

const shots = []

async function capture(app, name, note) {
  /*
   * Captured twice, and the second one is the file.
   *
   * A card that arrives with a CSS animation gets its own composited layer, and
   * the first surface capture after that animation settles can still carry the
   * layer at the opacity it had part-way through — the preview came out with the
   * transcript legible through it while `getComputedStyle` in the same window
   * reported `opacity: 1` on an opaque background. A discarded capture forces
   * the frame that makes the second one match what the app is drawing.
   */
  await app.send('Page.captureScreenshot', { format: 'png' })
  await app.settle()
  const { data } = await app.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  const file = join(OUT, `impl-parity-${name}.png`)
  const bytes = Buffer.from(data, 'base64')
  writeFileSync(file, bytes)
  /*
   * The PNG header, read back rather than assumed. A capture taken while the
   * window is still sizing comes out at the old dimensions, and a blank one
   * comes out tiny — both of which look like a successful run.
   */
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  shots.push({ file, width, height, bytes: bytes.length, note })
  console.log(`${file}  ${String(width)}×${String(height)}  ${String(bytes.length)} bytes`)
}

/** Every tab's conversation id, by the title on it. */
const tabsByTitle = (app) =>
  app.evaluate(`(() => Object.fromEntries(
    Array.from(document.querySelectorAll('[data-workspace-tab]'))
      .map((t) => [t.querySelector('.workspace-tab-title').textContent, t.dataset.workspaceTab])
  ))()`)

const press = (app, key, { meta = false, shift = false } = {}) =>
  app.evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
      metaKey: ${String(meta)}, shiftKey: ${String(shift)},
    }))
    return true
  })()`)

const project = mkdtempSync(join(tmpdir(), 'chorus-shot-'))
mkdirSync(join(project, 'src'), { recursive: true })
writeFileSync(join(project, 'src/payments.ts'), 'export const rate = 1\n')

ensureBuilt()
mkdirSync(OUT, { recursive: true })

/*
 * Set up in one launch, photograph in the next.
 *
 * `setProjectDirectory` and `renameConversation` are applied to the renderer's
 * session list by whichever control called them — there is no push — so calling
 * them over IPC changes the store and leaves the window showing the old title
 * and "No folder". Quitting and coming back reads both from the store, which is
 * also the more honest picture: this is what a session looks like when you open
 * the app, not what it looks like immediately after you renamed it.
 */
const setup = await launch({ keepData: true })
try {
  await setup.until(`document.querySelectorAll('.pane').length > 0`)
  for (let i = 1; i < SESSIONS.length; i++) {
    await setup.evaluate(
      `(() => { document.querySelector('[data-rail-new]').click(); return true })()`
    )
    await setup.until(
      `document.querySelectorAll('[data-workspace-tab]').length === ${String(i + 1)}`,
      { timeout: 180_000 }
    )
  }
  const ids = await setup.evaluate(
    `Array.from(document.querySelectorAll('[data-workspace-tab]')).map((t) => t.dataset.workspaceTab)`
  )
  /* The project goes to the first, which is the pane the composition details. */
  await setup.evaluate(
    `window.chorus.setProjectDirectory({ conversationId: ${JSON.stringify(ids[0])}, cwd: ${JSON.stringify(project)} }).then(() => true)`
  )
  /* After the folder, not before it: taking a folder renames an untitled session. */
  for (const [at, title] of SESSIONS.entries()) {
    await setup.evaluate(
      `window.chorus.renameConversation({ conversationId: ${JSON.stringify(ids[at])}, title: ${JSON.stringify(title)} }).then(() => true)`
    )
  }
  /* The layout write is debounced; a quit inside that window loses a tab. */
  await wait(2_000)
} finally {
  await setup.stop()
}

const before = existingDescriptors()
const app = await launch({ userData: setup.dataPath })
let ide = null
try {
  await app.until(`document.querySelectorAll('.pane').length > 0`)
  await app.until(
    `document.querySelectorAll('[data-workspace-tab]').length === ${String(SESSIONS.length)}`,
    { timeout: 180_000 }
  )
  /*
   * Read the ids again rather than reusing the ones from the setup launch: a
   * restored conversation is a *new* conversation carrying the old transcript,
   * which is what `replaceSession` in the store is for. Matched by title, since
   * that is the thing that survived.
   */
  const byTitle = await tabsByTitle(app)
  for (const title of SESSIONS) {
    if (byTitle[title] === undefined) {
      throw new Error(`the restored sessions are not the ones set up: ${JSON.stringify(byTitle)}`)
    }
  }
  await app.bringToFront()
  await app.viewport(WIDTH, HEIGHT)
  await app.settle()

  /*
   * Two of the four go back to being sessions that are open nowhere.
   *
   * Closing a tab does not end a session — it stays in the list, on the rail,
   * running in main — which is exactly the state a dragged session is in.
   */
  for (const title of SESSIONS.filter((name) => name !== LEFT && name !== RIGHT)) {
    await app.evaluate(`(() => {
      document.querySelector('[data-workspace-tab="${byTitle[title]}"]').click()
      return true
    })()`)
    await app.settle()
    await press(app, 'w', { meta: true })
    await app.until(`!document.querySelector('[data-workspace-tab="${byTitle[title]}"]')`, {
      timeout: 20_000,
    })
  }

  /* Two panes, one session each: the right-hand session splits out to the right. */
  await app.evaluate(`(() => {
    document.querySelector('[data-workspace-tab="${byTitle[RIGHT]}"]').click()
    return true
  })()`)
  await app.settle()
  await press(app, '\\', { meta: true })
  await app.until(`document.querySelectorAll('[data-workspace-pane]').length === 2`)

  /* The session terminal, in the pane that owns the left session and nowhere else. */
  await app.evaluate(`(() => {
    document.querySelector('[data-workspace-tab="${byTitle[LEFT]}"]').click()
    return true
  })()`)
  await app.settle()
  await press(app, 'j', { meta: true })
  await app.until(`!!document.querySelector('.terminal-panel--session')`, { timeout: 20_000 })

  /*
   * A real exchange in each pane, **before** any editor selection exists.
   *
   * The composition is a picture of a conversation, and a conversation with
   * nothing in it is a picture of an empty pane. These are real messages to the
   * real agent in the session, so what is photographed is the transcript this
   * app actually draws; nothing fake is put into the product to make a
   * screenshot look better.
   *
   * The order is the fix for a red error in the first attempt. Send re-asks the
   * editor for the selection rather than trusting the pill — which is correct,
   * and which a fake IDE that has not been told what to answer refuses — so a
   * message sent while a selection was attached failed with `Could not read the
   * editor selection` and put that in the transcript instead of a reply. The
   * selection is reported after the talking, for the composer evidence, and the
   * fake window is given a real answer to give in case anything asks again.
   *
   * Best effort: if an agent is slow or unavailable the shot is still taken, and
   * the log below says which panes answered.
   */
  for (const [title, ask] of [
    [LEFT, 'In one sentence, what does an idempotency key protect against?'],
    [RIGHT, 'In one sentence, why batch writes when indexing?'],
  ]) {
    await app.evaluate(`(() => {
      document.querySelector('[data-workspace-tab="${byTitle[title]}"]').click()
      return true
    })()`)
    await app.settle()
    await app.evaluate(`(() => {
      const pane = document.querySelector('.pane[data-conversation="${byTitle[title]}"]')
      const ta = pane.querySelector('.composer textarea')
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
        .set.call(ta, ${JSON.stringify(ask)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      pane.querySelector('.composer').requestSubmit()
      return true
    })()`)
  }
  for (const title of [LEFT, RIGHT]) {
    const answered = await app
      .until(
        `document.querySelectorAll('.pane[data-conversation="${byTitle[title]}"] .entry--claude').length > 0`,
        { timeout: 120_000, label: `${title} answered` }
      )
      .then(() => true)
      .catch(() => false)
    console.log(`${title}: ${answered ? 'answered' : 'no reply in two minutes'}`)
  }
  const failures = await app.evaluate(
    `document.querySelectorAll('.notice--bad, .entry--error').length`
  )
  if (failures > 0) {
    throw new Error(
      `the transcript carries ${String(failures)} error notices — fix before shooting`
    )
  }

  /*
   * Only now the editor selection, and with an answer ready for Send.
   *
   * `onSnapshot` is what a real VS Code window replies with when Chorus asks at
   * Send time; without it the fake window refuses and the composer says so.
   */
  const descriptor = await waitForDescriptor(before)
  ide = await FakeIde.connect(descriptor)
  const roots = await ide.awaitRoots()
  const root = roots.find((candidate) => candidate.endsWith(project.split('/').pop()))
  ide.onSnapshot((asked) => ({
    outcome: 'ok',
    snapshot: {
      source: 'current',
      filePath: join(asked, 'src/payments.ts'),
      fileUrl: `file://${join(asked, 'src/payments.ts')}`,
      languageId: 'typescript',
      documentVersion: 1,
      isDirty: false,
      provenance: { kind: 'worktree' },
      selection: {
        start: { line: 41, character: 0 },
        end: { line: 67, character: 4 },
        isEmpty: false,
        selectedBytes: 22,
        text: 'export const rate = 1\n',
      },
    },
  }))
  ide.report(root, { file: join(root, 'src/payments.ts'), startLine: 41, endLine: 67 })
  await app.until(`!!document.querySelector('.ide-pill')`, { timeout: 20_000 })

  /* Long enough for both providers to answer, so the account column is real. */
  await wait(8_000)
  await app.settle()

  const geometry = await app.evaluate(`(() => {
    const box = (sel, root = document) => {
      const r = root.querySelector(sel)?.getBoundingClientRect()
      return r === undefined
        ? null
        : { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }
    }
    const left = document.querySelector('.pane[data-conversation="${byTitle[LEFT]}"]')
    return {
      masthead: box('.masthead'),
      rail: box('.quick-rail'),
      tile: box('[data-rail-session]'),
      usage: box('.rail-usage'),
      tab: box('.workspace-tab[data-active="true"]'),
      paneBody: box('[data-pane-content]'),
      terminal: box('.terminal-panel--session'),
      composer: box('.composer', left),
      pill: box('.ide-pill', left),
    }
  })()`)
  console.log(`geometry: ${JSON.stringify(geometry, null, 2)}`)

  await capture(app, '04-collapsed-settled', 'the same composition at rest, with no drag over it')

  /*
   * The drag, photographed while it is happening.
   *
   * Started on the shortcut and moved twice: the drag's document listeners are
   * attached by an effect, so React has to have rendered between the move that
   * starts it and the move that positions it. No `pointerup` — the shot is of
   * the target, and a drop would be a picture of the split it made instead.
   */
  const dragging = await app.evaluate(`(() => {
    const tile = document.querySelector('[data-rail-session="${byTitle[DRAGGED]}"]')
    const from = tile.getBoundingClientRect()
    const panes = [...document.querySelectorAll('[data-pane-content]')]
    const content = panes[panes.length - 1].getBoundingClientRect()
    /*
     * Inside the right band and clear of the window edge.
     *
     * The band is a quarter of the pane up to 120px, so anything within 120 of
     * the right edge resolves to a right split. 110 keeps the pointer — and the
     * 46px tile that follows it 12px behind — fully on screen, which the shot
     * needs and a drop does not care about.
     */
    window.__to = {
      x: Math.round(content.right - 110),
      y: Math.round(content.top + content.height / 2),
    }
    tile.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 9, button: 0, isPrimary: true, bubbles: true, cancelable: true,
      clientX: Math.round(from.left + from.width / 2),
      clientY: Math.round(from.top + from.height / 2),
    }))
    tile.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 9, bubbles: true, clientX: window.__to.x, clientY: window.__to.y,
    }))
    return true
  })()`)
  if (dragging !== true) throw new Error('the drag never started')
  await app.settle()
  await app.evaluate(`(() => {
    document.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 9, bubbles: true, clientX: window.__to.x, clientY: window.__to.y,
    }))
    return true
  })()`)
  await app.until(`!!document.querySelector('.workspace-drop-overlay')`, {
    timeout: 10_000,
    label: 'the split target appeared',
  })
  const target = await app.evaluate(`(() => {
    const overlay = document.querySelector('.workspace-drop-overlay')
    const ghost = document.querySelector('.workspace-drag-ghost')
    return {
      label: overlay?.textContent ?? null,
      disabled: overlay?.dataset.disabled ?? null,
      ghost: ghost?.textContent ?? null,
      shape: ghost?.dataset.shape ?? null,
    }
  })()`)
  console.log(`drag target: ${JSON.stringify(target)}`)
  if (target.disabled !== 'false') {
    throw new Error(`the split target is refused, not offered: ${JSON.stringify(target)}`)
  }
  await capture(
    app,
    '01-composite-drag-split',
    'collapsed rail, two panes, left session terminal, VS Code pill, and a live rail drag on the right pane’s split target'
  )

  /*
   * Cancelled rather than dropped. The remaining shots are of the workspace this
   * one photographed, and a drop would rearrange it.
   */
  await app.evaluate(`(() => {
    document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 9, bubbles: true }))
    return true
  })()`)
  await app.until(`!document.querySelector('.workspace-drag-ghost')`, { timeout: 10_000 })
  await app.settle()

  // The drawer, with the preview up over a row.
  await app.evaluate(`(() => {
    if (document.querySelector('.session-drawer').dataset.hidden === 'true') {
      document.querySelector('[data-rail-drawer]').click()
    }
    return true
  })()`)
  await app.until(`document.querySelector('.session-drawer').dataset.hidden !== 'true'`)
  await app.evaluate(`(() => {
    document.querySelector('[data-sidebar-conversation="${byTitle[LEFT]}"] .session-row-main')
      .dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    return true
  })()`)
  await app.until(`!!document.querySelector('.session-preview')`, { timeout: 20_000 })
  /*
   * Past the 120ms fade, not one frame into it. `settle` waits for a frame,
   * which lands mid-animation — the first attempt at this shot came out with the
   * transcript legible through the card, which is a photograph of a transition
   * rather than of the app.
   */
  await wait(400)
  await capture(
    app,
    '02-expanded-drawer-preview',
    'the drawer open over the same workspace, with the read-only preview anchored to a row'
  )

  // And the menu, which is where every action that left the row now lives.
  await app.evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.querySelector('[data-session-more="${byTitle[LEFT]}"]').click()
    return true
  })()`)
  await app.until(`!!document.querySelector('.session-menu')`, { timeout: 20_000 })
  await wait(400)
  await capture(
    app,
    '03-expanded-drawer-menu',
    'the same drawer with the session menu open, End last and behind a divider'
  )

  console.log(`\n${String(shots.length)} screenshots written to ${OUT}`)
} finally {
  ide?.close()
  await app.viewport()
  await app.quit()
}
