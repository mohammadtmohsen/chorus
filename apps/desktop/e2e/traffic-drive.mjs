import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBuilt, launch, wait } from './harness.mjs'

const SOURCE = join(homedir(), 'Library/Application Support/@chorus/desktop-dev')
const PROJECT = 'tpa-web-1'
const VARIABLE = 'JAVA_API_DEV_BASE_URL'

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'chorus-traffic-'))
  const db = join(SOURCE, 'chorus.v2.db')
  if (!existsSync(db)) throw new Error(`no database at ${db}`)
  const copy = spawnSync('sqlite3', [db, `.backup '${join(dir, 'chorus.v2.db')}'`])
  if (copy.status !== 0) {
    throw new Error(`could not copy the database: ${String(copy.stderr)}`)
  }
  return dir
}

const say = (label, value) => {
  console.log(`\n=== ${label} ===`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
}

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

ensureBuilt()

const userData = seed()
const upstream = await new Promise((resolve) => {
  const server = createServer((request, response) => {
    // One row that carries a next action and one that carries only a code, so
    // the trailing column can be shown to hold both in the same place.
    // No code, only a next action: the row whose single trailing value is the
    // one that used to sit a column to the right of everybody else's.
    const body = JSON.stringify({ data: { nextAction: 'LOGIN' } })
    const deep = JSON.stringify({ ok: true, nested: { a: 1, b: [1, 2] }, hello: 'readable' })
    const many = {}
    for (let i = 0; i < 16; i++) many[`x-filler-${String(i)}`] = `value ${String(i)}`.repeat(4)
    /*
     * One header long enough that its value cannot fit on a single line, and
     * shaped like the things that actually are that long: a JWT has no break
     * opportunity inside it, which is the case `overflow-wrap: break-word` does
     * not cover and `anywhere` does.
     */
    many['x-refresh-token'] = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${'A'.repeat(160)}`
    if ((request.url ?? '').startsWith('/gz')) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        ...many,
      })
      response.end(gzipSync(deep))
      return
    }
    if ((request.url ?? '').startsWith('/missing')) {
      response.writeHead(404, { 'content-type': 'application/json', ...many })
      response.end(
        JSON.stringify({ code: 'MOBILE_FAMILY_CONTRACT_NOT_FOUND_AND_THEN_SOME_MORE_CHARACTERS' })
      )
      return
    }
    response.writeHead(200, { 'content-type': 'application/json', ...many })
    response.end(body)
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
})

const capturePort = await new Promise((resolve) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    const port = address !== null && typeof address === 'object' ? address.port : 0
    probe.close(() => {
      resolve(port)
    })
  })
})

const app = await launch({ userData })
try {
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
  await wait(4_000)

  /*
   * A CSS selector, not the accessible name. The setup fields name themselves
   * with a visible `<label>` now, so looking one up by `aria-label` finds nothing
   * and reports a missing field rather than a wrong one — C-069's fourth instance
   * of the same class. `[data-traffic-field="port"]` is a hook the field owns and
   * no wording change can move.
   */
  const typed = (selector, text) =>
    app.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      if (input === null) return 'missing field: ' + ${JSON.stringify(selector)}
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const readBack = input.value
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.blur()
      return { readBack, focused: document.activeElement === input }
    })()`)

  const clicked = (selector) =>
    app.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (node === null) return 'missing: ' + ${JSON.stringify(selector)}
      node.click()
      return 'clicked'
    })()`)

  /*
   * A `<select>` through React's `onChange`, which for a select is the native
   * `change` event — the setter is the prototype's own, because assigning to
   * `select.value` directly is what React's value tracking ignores.
   */
  const picked = (selector, value) =>
    app.evaluate(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)})
      if (select === null) return 'missing: ' + ${JSON.stringify(selector)}
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(select, ${JSON.stringify(value)})
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return { readBack: select.value }
    })()`)

  await app.evaluate(`(() => {
    const tile = [...document.querySelectorAll('.rail-item.rail-project')]
      .find((node) => (node.innerText || '').includes(${JSON.stringify(PROJECT)}))
    if (tile !== undefined) tile.click()
    return true
  })()`)
  await app.until(`document.querySelector('.traffic-panel') !== null`, { timeout: 60_000 })
  check('the panel opened', await app.evaluate(`document.querySelector('.traffic-panel') !== null`))

  const setup = JSON.parse(
    await app.evaluate(`(() => {
      const details = document.querySelector('.traffic-setup')
      const outside = (node) => node !== null && (details === null || !details.contains(node))
      const origin = document.querySelector('[data-traffic-field="origin"] input')
      return JSON.stringify({
        present: details !== null,
        open: details === null ? null : details.open,
        headerOutside: outside(document.querySelector('.traffic-head')),
        filtersOutside: outside(document.querySelector('[aria-label="Search the list"]')),
        originShown: origin === null ? null : origin.checkVisibility()
      })
    })()`)
  )
  say('the capture setup', setup)
  check('the capture setup starts closed', setup.present && setup.open === false)
  check(
    'the header and the list filters stay outside it',
    setup.headerOutside && setup.filtersOutside
  )
  check('and its inputs are not drawn', setup.originShown === false)

  await clicked('.traffic-setup summary')
  await wait(600)
  /*
   * The console before the reading, and the reading made total. The panel has
   * vanished between two evaluates twice in a row while this was being written —
   * C-069's undiagnosed mode — and a driver that dies on `details.open` reports
   * a stack instead of the absence plus whatever the renderer said on the way
   * down.
   */
  say('renderer console after the summary click', app.console().slice(-15).join('\n'))
  const setupOpen = JSON.parse(
    await app.evaluate(`(() => {
      const details = document.querySelector('.traffic-setup')
      if (details === null) return JSON.stringify({ present: false, open: null, originShown: null })
      const origin = document.querySelector('[data-traffic-field="origin"] input')
      return JSON.stringify({
        present: true,
        open: details.open,
        originShown: origin === null ? null : origin.checkVisibility()
      })
    })()`)
  )
  say('the capture setup, opened', setupOpen)
  check(
    'it opens on click, and its inputs appear',
    setupOpen.present === true && setupOpen.open === true && setupOpen.originShown === true
  )

  const origin = `http://127.0.0.1:${upstream.port}`
  say(
    'origin (Forward to) set to',
    `${origin} ${JSON.stringify(await typed('[data-traffic-field="origin"] input', origin))}`
  )
  say(
    'variable (Variable your app reads) set to',
    `${VARIABLE} ${JSON.stringify(await typed('[data-traffic-field="envVar"] input', VARIABLE))}`
  )
  say(
    'port set to',
    `${String(capturePort)} ${JSON.stringify(await typed('[data-traffic-field="port"] input', String(capturePort)))}`
  )
  await wait(1_500)

  say(
    'committed state in the panel',
    await app.evaluate(`JSON.stringify({
      envLine: document.querySelector('.traffic-env')?.innerText ?? null,
      header: document.querySelector('.traffic-panel')?.innerText.split('\\n').slice(0, 2).join(' | ') ?? null,
      startDisabled: document.querySelector('.traffic-panel [aria-label="Start capture"]')?.disabled ?? 'no button',
    })`)
  )

  /*
   * The reach control, read through the DOM it actually renders rather than the
   * state it was handed. The round-trip half runs with capture off, and the
   * guard half with it on, below.
   *
   * **Nothing here binds `0.0.0.0`.** The one assertion that would need it — that
   * a LAN capture reports the machine's own address — is left untested, because
   * opening a wide listener inside this run is how macOS comes up with its
   * incoming-connections prompt and a run that hangs on a system dialog is
   * exactly the failure C-069 would file as another intermittent mode.
   */
  const reachState = `JSON.stringify((() => {
    const field = document.querySelector('[data-traffic-field="access"]')
    const select = field === null ? null : field.querySelector('select')
    return {
      present: field !== null && select !== null,
      value: select === null ? null : select.value,
      options: select === null ? null : [...select.options].map((option) => option.value),
      label: field?.querySelector('.traffic-field-name')?.innerText.trim() ?? null,
      hint: field?.querySelector('.traffic-field-hint')?.innerText.trim() ?? null,
      described:
        field === null || select === null
          ? null
          : select.getAttribute('aria-describedby') === (field.querySelector('.traffic-field-hint')?.id ?? ''),
      disabled: select === null ? null : select.disabled,
      stopped: document.querySelector('.traffic-stopped')?.innerText.trim() ?? null
    }
  })())`

  /*
   * What this asserts flipped with the default: it used to claim the panel
   * opened on `loopback`, and now claims it opens on `lan`. Nothing was
   * relaxed — the two are the same assertion about which value a project
   * starts with, and the second is the one the product now means.
   *
   * The non-default choice is the one worth walking, so the round trip below
   * goes out to `loopback` and back rather than the other way round.
   */
  const reachBefore = JSON.parse(await app.evaluate(reachState))
  say('the reach control before choosing', reachBefore)
  check(
    'the reach control opens on the network — the default — with both choices and a label',
    reachBefore.present &&
      reachBefore.value === 'lan' &&
      reachBefore.options.length === 2 &&
      reachBefore.options.includes('loopback') &&
      reachBefore.label !== null &&
      reachBefore.label !== '' &&
      reachBefore.described === true,
    `value ${String(reachBefore.value)}, options [${(reachBefore.options ?? []).join(', ')}], label ${JSON.stringify(reachBefore.label)}`
  )

  say(
    'choosing this machine only',
    await picked('[data-traffic-field="access"] select', 'loopback')
  )
  await wait(1_200)
  const reachNarrow = JSON.parse(await app.evaluate(reachState))
  say('the reach control after narrowing', reachNarrow)
  check(
    'narrowing to this machine takes, and says what is left reachable',
    reachNarrow.value === 'loopback' &&
      reachNarrow.stopped === null &&
      reachNarrow.hint !== reachBefore.hint &&
      (reachNarrow.hint ?? '').includes('Only this machine'),
    `value ${String(reachNarrow.value)}, hint ${JSON.stringify(reachNarrow.hint)}`
  )

  say('back to the network', await picked('[data-traffic-field="access"] select', 'lan'))
  await wait(1_200)
  const reachBack = JSON.parse(await app.evaluate(reachState))
  say('the reach control, back on the default', reachBack)
  check(
    'and it goes back to the network, with the warning that describes it',
    reachBack.value === 'lan' &&
      reachBack.hint === reachBefore.hint &&
      (reachBack.hint ?? '').includes('incoming connections'),
    `value ${String(reachBack.value)}, hint ${JSON.stringify(reachBack.hint)}`
  )

  say(
    'preload / console calibration',
    await app.evaluate(`(() => {
      console.error('[probe] page console is captured')
      const api = window.chorus
      return JSON.stringify({
        hasOnTraffic: typeof api.onTraffic,
        preloadIsCurrent: String(api.onTraffic).includes('a push was dropped'),
        hasAck: typeof api.ackTraffic,
        hasAttach: typeof api.attachTraffic,
      })
    })()`)
  )
  await wait(500)

  say(
    'beside the panel',
    await app.evaluate(`(() => {
      window.__trafficSeen = []
      window.chorus.onTraffic((push) => {
        window.__trafficSeen.push(
          push.kind + ' rows=' + String(push.rows === undefined ? 0 : push.rows.length) +
          ' project=' + push.projectId + ' capture=' + (push.captureId ?? '-')
        )
      })
      return 'listening'
    })()`)
  )

  say('start', await clicked('.traffic-panel [aria-label="Start capture"]'))
  await wait(3_000)

  const header = await app.evaluate(`document.querySelector('.traffic-panel')?.innerText ?? ''`)
  say('header after start', header.split('\n').slice(0, 3).join(' | '))
  say('renderer console', app.console().slice(-12).join('\n'))
  say('window body', await app.evaluate(`document.body.innerText.slice(0, 200)`))
  /*
   * What this claims changed with the default, and it is not the same assertion
   * relaxed. It used to read `Listening on 127.0.0.1:` — which, now that a
   * project starts open to the network, would be the statement that the default
   * is *not* applied.
   *
   * The host is checked against this machine's own non-internal IPv4 addresses,
   * read here from Node, rather than against a pattern or against `lanAddress`'s
   * private-first search. A pattern would pass on any dotted quad including the
   * wildcard, and re-implementing the search would fail whenever the two
   * disagreed about which interface counts — neither of which is the claim.
   */
  const localAddresses = Object.values(networkInterfaces())
    .flatMap((each) => each ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => address.address)
  const listening = /Listening on ([^\s]+)/.exec(header)?.[1] ?? null
  const listeningHost = listening === null ? null : (listening.split(':')[0] ?? null)
  say('what the listener reports', listening ?? 'nothing')
  say('this machine is reachable at', localAddresses)
  check(
    'the listener bound on the network, naming an address this machine actually has',
    listeningHost !== null && listeningHost !== '0.0.0.0' && localAddresses.includes(listeningHost),
    `reported ${String(listening)}, machine has [${localAddresses.join(', ')}]`
  )

  /*
   * The port the panel reports, never a fixed one: this machine may already be
   * running another Chorus holding the port this driver would otherwise assume.
   */
  const port = await app.evaluate(`(() => {
    const line = (document.querySelector('.traffic-env')?.innerText ?? '').trim()
    const match = /:([0-9]+)$/.exec(line)
    return match === null ? null : Number(match[1])
  })()`)
  say('listening port', String(port))
  /*
   * Sent first, so it is the row the inspector opens on, and long enough that
   * the forwarded URL has to wrap. One unbreakable segment rather than a path
   * with separators in it: a path that could wrap at a slash would prove nothing
   * about a value that cannot.
   */
  const longPath = `/x-${'a'.repeat(200)}`
  const first = await fetch(`http://127.0.0.1:${String(port)}${longPath}`)
  say('the long request', `status ${first.status} ${await first.text()}`)

  /*
   * **A short list in a tall box, and it has to be here rather than later.**
   *
   * The rows came out about seventy pixels apart, because a grid stretches
   * auto-sized rows over leftover height and the list never said `align-content`
   * — the user's screenshot was thirteen rows spread down a tall panel.
   *
   * It only happens while the content is *shorter* than the box, and every other
   * check in this file runs against sixty-odd rows. The first attempt at this
   * check sat beside the table reading, where four rows already filled the 127px
   * box exactly — so there was no leftover to distribute and it passed with the
   * fix reverted. Two rows in the same box is the condition, and it exists only
   * for the first few requests of a run.
   *
   * The precondition is asserted, not assumed: if the list ever stops fitting
   * here the check fails and says so, rather than passing for having nothing to
   * measure.
   */
  await fetch(`http://127.0.0.1:${String(port)}/second`)
  await wait(1_500)
  const shortList = JSON.parse(
    await app.evaluate(`JSON.stringify((() => {
      const list = document.querySelector('.traffic-rows')
      if (list === null) return null
      const rows = [...list.querySelectorAll('.traffic-row-button')]
      return {
        rows: rows.length,
        box: Math.round(list.clientHeight),
        /*
         * **The row's own height, not the gap between rows.**
         *
         * The gap is what the eye reads as "seventy pixels apart", and it is the
         * one measurement that cannot move: row-gap is a fixed length, and the
         * stretch spends the leftover height *inside* each track rather than
         * between them. The first version of this check measured the gap and
         * passed with the fix reverted. What grows is the row, so that is what
         * is read — against a line of text inside it, which the stretch does not
         * touch.
         */
        heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
        line: Math.round(
          rows[0]?.querySelector('.traffic-method')?.getBoundingClientRect().height ?? 0
        )
      }
    })())`)
  )
  say('a short list in a tall box', shortList)
  check(
    'a row is its own height, not a share of the leftover space in the box',
    shortList !== null &&
      shortList.rows >= 2 &&
      shortList.line > 0 &&
      /* Room to stretch: several rows' worth of height with only two rows in it. */
      shortList.box > shortList.rows * 40 &&
      shortList.heights.every((height) => height <= shortList.line + 24),
    `${String(shortList?.rows)} rows in a box of ${String(shortList?.box)}, a line is ${String(shortList?.line)}px, rows [${(shortList?.heights ?? []).join(', ')}]`
  )

  /*
   * The guard, while the socket is genuinely open. `access` is read once in
   * `start` to pick the bind host and nothing rebinds, so a change taken here
   * would persist and the panel would offer a reach the listener does not have.
   * Asserting the refusal *and* that the choice did not move is the pair that
   * makes this check worth having — a refusal that stored the value anyway would
   * pass on the message alone.
   */
  say(
    'asking for this machine only, while capturing',
    await picked('[data-traffic-field="access"] select', 'loopback')
  )
  await wait(1_200)
  const reachGuard = JSON.parse(await app.evaluate(reachState))
  say('the reach control while capturing', reachGuard)
  check(
    'a change to the reach is refused mid-capture, and the choice does not move',
    reachGuard.value === 'lan' &&
      reachGuard.stopped !== null &&
      reachGuard.stopped.includes('Stop capture'),
    `value ${String(reachGuard.value)}, said ${JSON.stringify(reachGuard.stopped)}`
  )

  const answer = await fetch(`http://127.0.0.1:${String(port)}/hello`)
  say('request through the listener', `status ${answer.status} ${await answer.text()}`)

  let rows = 0
  for (let i = 0; i < 25; i++) {
    rows = await app.evaluate(
      `[...document.querySelectorAll('.traffic-panel *')].filter((n) =>
         (n.className || '').toString().includes('traffic-row')).length`
    )
    if (rows > 0) break
    await wait(400)
  }
  say(
    'pushes the renderer actually received',
    await app.evaluate(`JSON.stringify(window.__trafficSeen ?? 'never registered')`)
  )
  const text = await app.evaluate(`document.querySelector('.traffic-panel')?.innerText ?? ''`)
  say('panel text after the request', text.slice(0, 700))
  /*
   * `[0-9]+`, not `1`.
   *
   * The literal was a trap that fired: this driver sends more than one request
   * now, the panel said `5 captured`, and every check in the block below it was
   * skipped — the run ended `ALL PASSED` over fourteen checks instead of fifty.
   * A count is what "capturing" looks like; the number is not the assertion.
   * The digits matter: the button beside it reads "Close captured traffic", so a
   * bare `captured` would be true with nothing captured at all.
   */
  check(
    'a row appeared',
    /[0-9]+ captured/.test(text) || /hello/.test(text),
    `${String(rows)} row nodes`
  )

  if (/[0-9]+ captured/.test(text)) {
    say(
      'row markup',
      await app.evaluate(`(() => {
        const row = [...document.querySelectorAll('.traffic-panel *')]
          .find((n) => (n.className || '').toString().includes('traffic-row'))
        return row === undefined ? 'no row node' : row.outerHTML.slice(0, 400)
      })()`)
    )
    await wait(3_000)
    const untouched = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const box = document.querySelector('.traffic-inspector')
        return {
          empty: box === null ? null : box.classList.contains('traffic-inspector--empty'),
          selected: document.querySelectorAll('.traffic-row-button[aria-pressed="true"]').length
        }
      })())`)
    )
    say('the inspector, untouched', untouched)
    check(
      'nothing is selected until a call is clicked',
      untouched.empty === true && untouched.selected === 0,
      `${String(untouched.selected)} selected, empty ${String(untouched.empty)}`
    )

    await app.evaluate(`(() => {
      const row = [...document.querySelectorAll('.traffic-row-button')].at(-1)
      if (row !== undefined) row.click()
      return true
    })()`)
    await wait(3_000)
    const inspector = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const box = document.querySelector('.traffic-inspector')
        const head = box === null ? null : box.querySelector('.traffic-head .traffic-url')
        return {
          present: box !== null,
          empty: box === null ? null : box.classList.contains('traffic-inspector--empty'),
          url: head === null ? null : (head.innerText ?? '').trim(),
          selected: document.querySelectorAll('.traffic-row-button[aria-pressed="true"]').length
        }
      })())`)
    )
    say('the inspector, after the click', inspector)
    check(
      'clicking a call shows it in the inspector',
      inspector.present &&
        inspector.empty === false &&
        inspector.selected === 1 &&
        inspector.url !== null &&
        inspector.url.includes('://'),
      `${String(inspector.selected)} selected, empty ${String(inspector.empty)}, url ${JSON.stringify((inspector.url ?? '').slice(0, 40))}`
    )

    const boxes = JSON.parse(
      await app.evaluate(`(() => {
      const head = (side) =>
        document.querySelector('.traffic-pane[data-side=' + side + '] > .traffic-label')
      const box = (node) => (node === null ? null : Math.round(node.getBoundingClientRect().height))
      const panes = [...document.querySelectorAll('.traffic-pane')]
      return JSON.stringify({
        panes: panes.length,
        sides: panes.map((node) => node.getAttribute('data-side')),
        leftHead: box(head('"request"')),
        rightHead: box(head('"response"')),
        sideBySide:
          panes.length === 2 &&
          Math.round(panes[0].getBoundingClientRect().top) ===
            Math.round(panes[1].getBoundingClientRect().top)
      })
    })()`)
    )
    say('the two boxes', boxes)
    check(
      'the inspector is two boxes, request then response',
      boxes.panes === 2,
      boxes.sides.join(', ')
    )
    check(
      'side by side rather than stacked',
      boxes.sideBySide === true,
      `tops equal: ${String(boxes.sideBySide)}`
    )
    check(
      'and neither heading is stretched by the label rule',
      boxes.leftHead !== null &&
        boxes.leftHead < 30 &&
        boxes.rightHead !== null &&
        boxes.rightHead < 30,
      `${String(boxes.leftHead)}px / ${String(boxes.rightHead)}px`
    )

    /*
     * A detail is read, not scanned, so nothing in it may be cut off.
     *
     * `scrollWidth > clientWidth` is the measurement that matters and the text
     * is the weak half beside it: `textContent` is whole whatever the CSS does,
     * so it catches a value truncated in JavaScript and the width catches one
     * truncated by a rule. Both are here because the failure this replaces was
     * the second kind wearing the first kind's clothes — an ellipsis that looks
     * like a rendering choice.
     *
     * It reads the header now rather than the row that used to repeat it — see
     * the note on the reading itself.
     */
    /*
     * **The shape of the two panes, which nothing here asserted before.**
     *
     * Every other check passed with the panes sharing the width, each taking the
     * whole of it, and each sized to its content — the ones around this read the
     * *contents* of the panes, and contents survive a layout change. This is the
     * one that claims the layout.
     *
     * The claim is **fit, not full**: a pane is as wide as what it holds, so at
     * least one of them is narrower than the wrapper — which is what the
     * full-width version made impossible and what the sharing version got wrong
     * from the other end. The wrapper's content is therefore the sum of the two
     * rather than either one, and the wrapper is what scrolls.
     *
     * `hiding === 0` is the real risk of the shape rather than the widths. A pane
     * with no horizontal scroll that is narrower than its content clips in
     * silence, and `scrollWidth > clientWidth` is what catches it.
     */
    const panes = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const wrap = document.querySelector('.traffic-panes')
        const both = [...document.querySelectorAll('.traffic-pane')]
        if (wrap === null || both.length !== 2) return null
        const wide = (node) => Math.round(node.getBoundingClientRect().width)
        const visible = wide(wrap)
        const before = wrap.scrollLeft
        wrap.scrollLeft = wrap.scrollWidth
        const moved = Math.round(wrap.scrollLeft)
        wrap.scrollLeft = before
        const widths = both.map(wide)
        return {
          visible,
          panes: widths,
          sum: widths.reduce((total, width) => total + width, 0),
          gap: parseFloat(getComputedStyle(wrap).columnGap) || 0,
          content: Math.round(wrap.scrollWidth),
          moved,
          across: getComputedStyle(wrap).overflowX,
          hiding: both.filter((pane) => pane.scrollWidth > pane.clientWidth + 1).length,
          down: both.map((pane) => getComputedStyle(pane).overflowY)
        }
      })())`)
    )
    say('the two panes against their wrapper', panes)
    /*
     * `moved > 0` is deliberately not claimed here. Both panes are at their
     * floor in this state — the long header values are inside a closed
     * `details`, so they contribute nothing to the pane's width yet — and two
     * panes of 200 fit the wrapper, so there is nothing to scroll to. The
     * sideways scroll is proved where the content is actually wide, after the
     * fold is opened.
     */
    check(
      'the two panes are equal halves of the wrapper, and nothing scrolls or clips sideways',
      panes !== null &&
        Math.abs(panes.panes[0] - panes.panes[1]) <= 1 &&
        Math.abs(panes.sum + panes.gap - panes.visible) <= 2 &&
        panes.content <= panes.visible + 1 &&
        panes.moved === 0 &&
        panes.hiding === 0 &&
        panes.across === 'hidden' &&
        panes.down.every((axis) => axis === 'auto'),
      `panes [${(panes?.panes ?? []).join(', ')}] with a gap of ${String(panes?.gap)} in ${String(panes?.visible)}, content ${String(panes?.content)}, scrolled ${String(panes?.moved)}, overflow-x ${String(panes?.across)}, hiding ${String(panes?.hiding)}`
    )

    const values = JSON.parse(
      await app.evaluate(`(() => {
        const read = (node) =>
          node === null || node === undefined
            ? null
            : {
                clipped: node.scrollWidth > node.clientWidth,
                text: node.textContent,
                height: Math.round(node.getBoundingClientRect().height),
                line: parseFloat(getComputedStyle(node).lineHeight) || 0,
              }
        return JSON.stringify({
          /*
           * The inspector's header, not the Forwarded-to row. That row is now
           * conditional and is absent for every row this fixture produces, so
           * reading it here reported undefined twice — but the claim it was
           * making is still real and still wanted: the whole endpoint is
           * readable in the inspector, and the header is where it lives now.
           */
          forwarded: read(
            document.querySelector('.traffic-inspector .traffic-head .traffic-url')
          ),
          /*
           * Which row the inspector is describing. It reads null on a row whose
           * response has not arrived, because a pending capture has request
           * headers and no response headers at all — and this check flaked once
           * in three runs before that was visible, so it is worth keeping.
           */
          selected: document.querySelectorAll('.traffic-row-button[aria-pressed="true"]').length
        })
      })()`)
    )
    say('the values in full', values)
    check(
      'the endpoint in the header is not clipped',
      values.forwarded !== null && values.forwarded.clipped === false,
      `clipped: ${String(values.forwarded?.clipped)}`
    )
    check(
      'and it carries the whole forwarded url',
      values.forwarded?.text === `http://127.0.0.1:${String(upstream.port)}${longPath}`,
      String(values.forwarded?.text)
    )

    await wait(4_000)
    await app.evaluate(`(() => {
      const box = document.querySelector('.traffic-inspector')
      if (box !== null) box.scrollTop = box.scrollHeight
      return true
    })()`)
    await wait(800)

    const geometry = JSON.parse(
      await app.evaluate(`(() => {
        const box = document.querySelector('.traffic-inspector')
        const view = document.querySelector('.traffic-pane[data-side="request"] .traffic-body-view')
        const bar = document.querySelector('.traffic-pane[data-side="request"] .traffic-body-view .traffic-body-bar')
        const groups = [...document.querySelectorAll('.traffic-general')]
        const timing = groups.length === 0 ? null : groups[groups.length - 1]
        const rect = (node) =>
          node === null || node === undefined
            ? null
            : { top: Math.round(node.getBoundingClientRect().top), bottom: Math.round(node.getBoundingClientRect().bottom) }
        return JSON.stringify({
          inspector: rect(box),
          rows: rect(document.querySelector('.traffic-rows')),
          bodyView: rect(view),
          bodyBar: rect(bar),
          timing: rect(timing),
          lastHeader: rect(document.querySelector('.traffic-headers dd:last-of-type')),
        })
      })()`)
    )
    say('geometry', geometry)
    check(
      'the list and the detail are stacked, never side by side',
      geometry.rows !== null &&
        geometry.inspector !== null &&
        geometry.rows.bottom <= geometry.inspector.top,
      `rows bottom ${String(geometry.rows?.bottom)} vs inspector top ${String(geometry.inspector?.top)}`
    )
    check(
      'the body view is not squashed to nothing',
      geometry.bodyView !== null && geometry.bodyView.bottom > geometry.bodyView.top,
      `height ${String(geometry.bodyView === null ? 'n/a' : geometry.bodyView.bottom - geometry.bodyView.top)}`
    )
    check(
      'the body view does not run over the timing block',
      geometry.bodyBar === null ||
        geometry.timing === null ||
        geometry.bodyBar.bottom <= geometry.timing.top,
      `bar bottom ${String(geometry.bodyBar?.bottom)} vs timing top ${String(geometry.timing?.top)}`
    )

    const readFold = `(() => {
      const details = document.querySelector('.traffic-pane[data-side="request"] .traffic-fold')
      const view = document.querySelector('.traffic-pane[data-side="request"] .traffic-body-view')
      const inside = details === null ? null : details.querySelector('.traffic-general')
      const outside = [...document.querySelectorAll('.traffic-inspector > .traffic-general')]
      const carries = (node) => node !== null && (node.innerText || '').includes('bytes kept')
      return JSON.stringify({
        present: details !== null,
        open: details === null ? null : details.open,
        summary: details === null ? null : (details.querySelector('summary')?.innerText ?? null),
        payloadTop: view === null ? null : Math.round(view.getBoundingClientRect().top),
        foldTop: details === null ? null : Math.round(details.getBoundingClientRect().top),
        foldHeight: details === null ? null : Math.round(details.getBoundingClientRect().height),
        sizesInside: carries(inside),
        sizesOutside: outside.some((node) => carries(node)),
        /*
         * The Forwarded-to line used to be a fixed row and this asked whether
         * it sat outside the fold. It is conditional now — dropped whenever it
         * would repeat what the header says — so what is read is how many of
         * them exist, and the endpoint check above the fold moved to the header,
         * which is where the endpoint actually lives. No backticks in this
         * comment: it lives inside a template literal.
         */
        forwardedRows: document.querySelectorAll(
          '.traffic-pane[data-side="request"] > .traffic-general .traffic-value'
        ).length,
        headerUrl: (
          document.querySelector('.traffic-inspector .traffic-head .traffic-url')?.innerText ?? ''
        ).trim(),
        headerTop: (() => {
          const node = document.querySelector('.traffic-inspector .traffic-head')
          return node === null ? null : Math.round(node.getBoundingClientRect().top)
        })(),
        structure: [...document.querySelectorAll('.traffic-inspector > *')].map(
          (node) => node.tagName.toLowerCase() + '.' + (node.className || '')
        )
      })
    })()`

    const folded = JSON.parse(await app.evaluate(readFold))
    say('the fold, closed', folded)
    check('the request section starts closed', folded.present && folded.open === false)
    check(
      'the payload sits above it',
      folded.payloadTop !== null && folded.foldTop !== null && folded.payloadTop < folded.foldTop,
      `payload ${String(folded.payloadTop)} vs fold ${String(folded.foldTop)}`
    )
    check(
      'closed, it takes only the height of its summary',
      folded.foldHeight !== null && folded.foldHeight > 0 && folded.foldHeight < 40,
      `${String(folded.foldHeight)}px`
    )
    check('no size rows are left outside it', folded.sizesOutside === false)
    /*
     * Two claims in one, because they are the two halves of the same change: the
     * endpoint is above the fold, and the `Forwarded to` line that used to say
     * the same thing in the Request box is gone.
     *
     * Every row this fixture produces is settled, and `record` passes the
     * forward target as the row's `u` — so the header already carries it and the
     * line has nothing to add. The branch where it comes back is not reachable
     * here: it needs a row that has not settled, or one refused with no forward
     * at all, and this driver never produces either. That half is a unit test —
     * `showsForwarded` — and it is a fixture limit rather than a check that
     * passes for the wrong reason.
     */
    check(
      'the endpoint is above the fold, and the line that repeated it is gone',
      folded.forwardedRows === 0 &&
        folded.headerUrl !== '' &&
        folded.headerTop !== null &&
        folded.foldTop !== null &&
        folded.headerTop < folded.foldTop,
      `${String(folded.forwardedRows)} forwarded rows, header ${JSON.stringify(folded.headerUrl.slice(0, 40))} at ${String(folded.headerTop)} vs fold ${String(folded.foldTop)}`
    )

    const views = JSON.parse(
      await app.evaluate(`(() => {
        const bar = document.querySelector('.traffic-pane[data-side="request"] .traffic-body-view .traffic-body-bar')
        const buttons = bar === null ? [] : [...bar.querySelectorAll('.traffic-tab')]
        const label = (node) => (node.innerText || '').trim()
        return JSON.stringify({
          labels: buttons.map(label),
          pressed: buttons
            .filter((node) => node.getAttribute('aria-pressed') === 'true')
            .map(label)
        })
      })()`)
    )
    say('the body view bar', views)
    check(
      'the view buttons are gone',
      ['Raw', 'Formatted', 'Hex'].every((label) => !views.labels.includes(label)),
      views.labels.join(' | ')
    )

    await app.evaluate(`(() => {
      document.querySelector('.traffic-pane[data-side="request"] .traffic-fold summary').click()
      return true
    })()`)
    await wait(600)
    const opened = JSON.parse(await app.evaluate(readFold))
    say('the fold, opened', opened)
    check('it opens on click', opened.open === true)
    check('the request and response sizes are inside it', opened.sizesInside)
    check(
      'and it grows well past the summary',
      opened.foldHeight > folded.foldHeight + 40,
      `${String(folded.foldHeight)}px → ${String(opened.foldHeight)}px`
    )

    /*
     * **The sideways scroll, proved where there is content to need it.**
     *
     * The panes check above runs with the fold closed, where the long header
     * values are inside a `details` and contribute nothing to the pane's width —
     * so both panes sit at their floor, the pair fits the wrapper, and nothing
     * scrolls. Opening the fold is what makes the request pane wide, which is the
     * state this claims: the pane is at its content's width, that is wider than
     * the wrapper, and the wrapper is what moves to reach the end of it.
     */
    const acrossFold = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const wrap = document.querySelector('.traffic-panes')
        const both = [...document.querySelectorAll('.traffic-pane')]
        if (wrap === null || both.length !== 2) return null
        const widths = both.map((pane) => Math.round(pane.getBoundingClientRect().width))
        const before = wrap.scrollLeft
        wrap.scrollLeft = wrap.scrollWidth
        const moved = Math.round(wrap.scrollLeft)
        wrap.scrollLeft = before
        return {
          panes: widths,
          sum: widths.reduce((total, width) => total + width, 0),
          gap: parseFloat(getComputedStyle(wrap).columnGap) || 0,
          content: Math.round(wrap.scrollWidth),
          visible: Math.round(wrap.getBoundingClientRect().width),
          moved,
          across: getComputedStyle(wrap).overflowX,
          hiding: both.filter((pane) => pane.scrollWidth > pane.clientWidth + 1).length,
          down: both.map((pane) => getComputedStyle(pane).overflowY)
        }
      })())`)
    )
    say('the panes once the fold is open', acrossFold)
    check(
      'with the headers open the halves stay equal, and nothing scrolls or clips sideways',
      acrossFold !== null &&
        Math.abs(acrossFold.panes[0] - acrossFold.panes[1]) <= 1 &&
        Math.abs(acrossFold.sum + acrossFold.gap - acrossFold.visible) <= 2 &&
        acrossFold.content <= acrossFold.visible + 1 &&
        acrossFold.moved === 0 &&
        acrossFold.hiding === 0 &&
        acrossFold.across === 'hidden' &&
        acrossFold.down.every((axis) => axis === 'auto'),
      `panes [${(acrossFold?.panes ?? []).join(', ')}] with a gap of ${String(acrossFold?.gap)} in ${String(acrossFold?.visible)}, content ${String(acrossFold?.content)}, scrolled ${String(acrossFold?.moved)}, overflow-x ${String(acrossFold?.across)}, hiding ${String(acrossFold?.hiding)}`
    )
    check(
      'opening the headers does not change the width of either pane',
      acrossFold !== null &&
        panes !== null &&
        Math.abs(acrossFold.panes[0] - panes.panes[0]) <= 1 &&
        Math.abs(acrossFold.panes[1] - panes.panes[1]) <= 1,
      `closed [${(panes?.panes ?? []).join(', ')}], open [${(acrossFold?.panes ?? []).join(', ')}]`
    )

    const longHeader = JSON.parse(
      await app.evaluate(`(() => {
        const read = (node) =>
          node === null || node === undefined
            ? null
            : {
                clipped: node.scrollWidth > node.clientWidth,
                text: node.textContent,
                height: Math.round(node.getBoundingClientRect().height),
                line: parseFloat(getComputedStyle(node).lineHeight) || 0,
              }
        const named = [...document.querySelectorAll('.traffic-header')].find(
          (row) => (row.querySelector('dt')?.textContent ?? '') === 'x-refresh-token'
        )
        return JSON.stringify({
          header: read(named === undefined ? null : named.querySelector('dd'))
        })
      })()`)
    )
    say('the long header once the fold is open', longHeader)
    check(
      'a long header value is not clipped',
      longHeader.header !== null && longHeader.header.clipped === false,
      `clipped: ${String(longHeader.header?.clipped)}`
    )
    check(
      'and it took more than one line to say in full',
      longHeader.header !== null &&
        longHeader.header.line > 0 &&
        longHeader.header.height > longHeader.header.line * 1.5,
      `${String(longHeader.header?.height)}px tall, one line is ${String(longHeader.header?.line)}px`
    )

    /*
     * `clearState`, and **not** `clearDisabled`.
     *
     * The old control was always there and disabled when the field was empty, so
     * the state worth asserting was its `disabled` flag. The X arrives with the
     * text, which makes absence a *correct* state rather than a failure — the
     * distinction this driver has already got wrong twice, and the one C-069's
     * guard paragraph is about. So absence is written as its own expected value,
     * asserted at the moment it is expected, rather than as a hook that failed
     * to resolve.
     */
    const listState = `JSON.stringify({
      rows: document.querySelectorAll('.traffic-rows .traffic-row').length,
      searched: document.querySelector('[aria-label="Search the list"]')?.value ?? null,
      clearState: document.querySelector('[data-traffic-clear="search"]') === null
        ? 'absent'
        : 'offered',
      empty: (document.querySelector('.traffic-panel')?.innerText ?? '').includes('Nothing matches')
    })`

    const quiet = JSON.parse(await app.evaluate(listState))
    check(
      'no X before there is a search to clear',
      quiet.clearState === 'absent',
      `X ${String(quiet.clearState)} with ${String(quiet.rows)} rows`
    )

    say('before searching', await typed('.traffic-find', 'zzz-nothing'))
    await wait(900)
    const narrowed = JSON.parse(await app.evaluate(listState))
    say('the list, searched', narrowed)
    check(
      'the search narrows the list, and the X arrives with it',
      narrowed.rows === 0 && narrowed.empty && narrowed.clearState === 'offered',
      `${String(narrowed.rows)} rows, X ${String(narrowed.clearState)}`
    )

    await app.evaluate(`(() => {
      const button = document.querySelector('[data-traffic-clear="search"]')
      if (button === null) return false
      button.click()
      return true
    })()`)
    await wait(900)
    const cleared = JSON.parse(await app.evaluate(listState))
    say('the list, cleared', cleared)
    check(
      'the X empties the search and goes with it, and the rows come back',
      cleared.searched === '' && cleared.rows > 0 && cleared.clearState === 'absent',
      `${String(cleared.rows)} rows, X ${String(cleared.clearState)}`
    )

    await fetch(`http://127.0.0.1:${String(port)}/missing`)
    await fetch(`http://127.0.0.1:${String(port)}/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ posting: true }),
    })
    /*
     * **A long path made of hyphenated words, which is the only shape that can
     * tell the two wrap properties apart.**
     *
     * `overflow-wrap: anywhere` fills every line of an unbroken run like
     * `/x-aaaaaa…`, so the check below would pass with the property the user
     * just asked to have replaced. What it does not do is break a *word* that
     * would otherwise fit — it prefers the hyphen — so a path of hyphenated
     * words comes out ragged, with the rest of each line empty. That is the
     * reported complaint, and it needs this request to exist.
     */
    await fetch(`http://127.0.0.1:${String(port)}/${'medical-history-'.repeat(12)}`)
    await wait(2_500)

    const table = JSON.parse(
      await app.evaluate(`(() => {
        const colour = (node) => (node === null ? null : getComputedStyle(node).color)
        const cells = [...document.querySelectorAll('.traffic-row-button .traffic-status')]
        const lefts = cells.map((node) => Math.round(node.getBoundingClientRect().left))
        const methods = [...document.querySelectorAll('.traffic-row-button .traffic-method')]
        return JSON.stringify({
          rows: cells.length,
          lefts,
          aligned: new Set(lefts).size === 1,
          /*
           * Scoped to the row, because data-class lives on the row's box now
           * rather than on the status cell — that is what lets the endpoint read
           * the same signal the status is coloured by. No backticks in this
           * comment: it is inside a template literal and one would end it.
           */
          twoHundred: colour(
            document.querySelector('.traffic-row-button[data-class="2xx"] .traffic-status')
          ),
          fourHundred: colour(
            document.querySelector('.traffic-row-button[data-class="4xx"] .traffic-status')
          ),
          urlOk: colour(document.querySelector('.traffic-row-button[data-class="2xx"] .traffic-url')),
          urlFailed: colour(
            document.querySelector('.traffic-row-button[data-class="4xx"] .traffic-url')
          ),
          methods: methods.map((node) => ({
            m: node.innerText.trim(),
            colour: getComputedStyle(node).color
          })),
          urls: [...document.querySelectorAll('.traffic-row-button .traffic-url')].map((node) => ({
            text: node.innerText.slice(0, 40),
            w: Math.round(node.getBoundingClientRect().width)
          })),
          columns: getComputedStyle(
            document.querySelector('.traffic-row-button')
          ).gridTemplateColumns,
          widths: (() => {
            const box = (selector) => {
              const node = document.querySelector(selector)
              return node === null ? null : Math.round(node.getBoundingClientRect().width)
            }
            /*
             * The row itself is not measured any more: it is display: contents
             * so the whole list can share one set of column tracks, and a
             * box-less element measures zero. A diagnostic reading 0 for a row
             * that is plainly 1,300px wide is worse than not reading it. The
             * button is the row's box now.
             */
            return {
              panel: box('.traffic-panel'),
              rows: box('.traffic-rows'),
              button: box('.traffic-row-button'),
              step: getComputedStyle(document.querySelector('.traffic-row-button')).gap
            }
          })()
        })
      })()`)
    )
    say('the list as a table', table)
    check(
      'every status sits in one column, across rows',
      table.aligned && table.rows >= 2,
      `${String(table.rows)} rows at [${table.lefts.join(', ')}]`
    )
    check(
      'a 2xx and a 4xx are coloured differently',
      table.twoHundred !== null &&
        table.fourHundred !== null &&
        table.twoHundred !== table.fourHundred,
      `${String(table.twoHundred)} vs ${String(table.fourHundred)}`
    )
    /*
     * The endpoint, red with the status it failed on.
     *
     * Asserted against the *status cell's own colour* rather than against a
     * literal red, because the claim is that the two cannot disagree: both read
     * the one `data-class` on the row's box. A literal would pass with the URL
     * coloured from a second, separately-derived idea of failure.
     */
    check(
      'the endpoint goes red with the status it failed on',
      table.urlOk !== null &&
        table.urlFailed !== null &&
        table.fourHundred !== null &&
        table.urlOk !== table.urlFailed &&
        table.urlFailed === table.fourHundred,
      `2xx endpoint ${String(table.urlOk)} | 4xx endpoint ${String(table.urlFailed)} | 4xx status ${String(table.fourHundred)}`
    )

    /*
     * **The inspector's header describes the same call, so it has to look like
     * it.** It carried the right class names and none of the attributes those
     * classes are keyed on, so it was grey whatever the row said.
     *
     * Opened on a failed row on purpose: a 2xx proves nothing about the method
     * colours, and the red endpoint is the case the user was looking at. Split
     * across two evaluates with a wait, because the inspector renders from the
     * selection and whether that commit has landed by the time `click()` returns
     * is a batching detail this check should not rest on.
     */
    say(
      'opening the inspector on a failed call',
      await app.evaluate(`(() => {
        const row = document.querySelector('.traffic-row-button[data-class="4xx"]')
        if (row === null) return 'no failed row is listed'
        row.click()
        return 'clicked'
      })()`)
    )
    await wait(1_200)
    const headerColours = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const colour = (node) => (node === null ? null : getComputedStyle(node).color)
        const pick = (root) =>
          root === null
            ? null
            : {
                method: colour(root.querySelector('.traffic-method')),
                url: colour(root.querySelector('.traffic-url')),
                status: colour(root.querySelector('.traffic-status'))
              }
        const selected = [...document.querySelectorAll('.traffic-row-button')].find(
          (row) => row.getAttribute('aria-pressed') === 'true'
        )
        return {
          row: pick(selected ?? null),
          head: pick(document.querySelector('.traffic-inspector .traffic-head')),
          className: selected?.getAttribute('data-class') ?? null
        }
      })())`)
    )
    say('the header against the row it describes', headerColours)
    check(
      'the inspector header is coloured like the row it describes',
      headerColours.row !== null &&
        headerColours.head !== null &&
        headerColours.className === '4xx' &&
        headerColours.head.method !== null &&
        headerColours.head.method === headerColours.row.method &&
        headerColours.head.status === headerColours.row.status &&
        headerColours.head.url === headerColours.row.url,
      `row ${JSON.stringify(headerColours.row)} | head ${JSON.stringify(headerColours.head)}`
    )

    /*
     * **Visible is a magnitude, not a difference.**
     *
     * Comparing the selected row's background against a neighbour's would pass
     * on the two-percent mix that was there before, because a whisper is still a
     * difference. What makes it readable is how far the fill steps away from the
     * ground it sits on, so this measures that step — and the accent, which the
     * old rule did not have at all.
     */
    const selection = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const list = document.querySelector('.traffic-rows')
        const buttons = [...document.querySelectorAll('.traffic-row-button')]
        const selected = buttons.find((row) => row.getAttribute('aria-pressed') === 'true')
        const other = buttons.find((row) => row.getAttribute('aria-pressed') !== 'true')
        if (list === null || selected === undefined || other === undefined) return null
        /*
         * The first ancestor that actually paints. The walk starts at the
         * *parent*: starting at the row itself finds the fill under test and
         * reports a step of zero against itself, which is what the first version
         * of this did.
         */
        const groundOf = (node) => {
          let at = node.parentElement
          while (at !== null) {
            const fill = getComputedStyle(at).backgroundColor
            if (fill !== 'rgba(0, 0, 0, 0)' && fill !== 'transparent') return fill
            at = at.parentElement
          }
          return 'rgb(0, 0, 0)'
        }
        const rgb = (value) => (value.match(/[0-9]+/g) ?? []).slice(0, 3).map(Number)
        const fill = getComputedStyle(selected).backgroundColor
        const ground = rgb(groundOf(selected))
        const step = Math.max(...rgb(fill).map((each, at) => Math.abs(each - (ground[at] ?? 0))))
        return {
          fill,
          ground: groundOf(selected),
          step,
          neighbour: getComputedStyle(other).backgroundColor,
          shadow: getComputedStyle(selected).boxShadow,
          otherShadow: getComputedStyle(other).boxShadow
        }
      })())`)
    )
    say('the selected row against its ground', selection)
    check(
      'the selected row steps away from the ground, and carries an accent',
      selection !== null &&
        selection.step >= 10 &&
        selection.shadow !== 'none' &&
        selection.otherShadow === 'none',
      `fill ${String(selection?.fill)} on ${String(selection?.ground)} — a step of ${String(selection?.step)}; accent ${String(selection?.shadow)}`
    )

    /*
     * **The header wraps rather than clipping, and the panes survive it.**
     *
     * The user reported the endpoint on two lines *and* ellipsised, which is a
     * pair that should not occur and did: the table's `white-space: nowrap` is on
     * the list, so the header wrapped, and `text-overflow` fires anyway for a run
     * with no break opportunity that overflows its line box. The layout moved the
     * endpoint into a column of its own, which is most of the answer, and this is
     * the measurement that the rest of it holds.
     *
     * Opened on the longest endpoint in the fixture on purpose — the row with the
     * 200-character segment. A short one would wrap nowhere and prove nothing.
     */
    say(
      'opening the inspector on the hyphenated path',
      await app.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.traffic-row-button')]
        const wanted = rows.find((row) =>
          (row.querySelector('.traffic-url')?.getAttribute('title') ?? '').includes('medical-history')
        )
        if (wanted === undefined) return 'the hyphenated request is not listed'
        wanted.click()
        return 'clicked'
      })()`)
    )
    await wait(1_200)
    const header = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const node = document.querySelector('.traffic-inspector .traffic-head .traffic-url')
        const box = document.querySelector('.traffic-inspector')
        const panes = document.querySelector('.traffic-panes')
        if (node === null || box === null || panes === null) return null
        const style = getComputedStyle(node)
        const head = document.querySelector('.traffic-inspector .traffic-head')
        const tall = (selector) => {
          const found = document.querySelector(selector)
          return found === null ? null : Math.round(found.getBoundingClientRect().height)
        }
        return {
          title: (node.getAttribute('title') ?? '').length,
          /*
           * clientWidth is zero on an inline element, so the clipping test that
           * works on a block reports false here whatever the CSS does — a
           * passing check for the wrong reason. The endpoint is inline text
           * now, so what is asserted is the text it draws and the rules that
           * could hide any of it. No backticks in this comment: it is inside a
           * template literal and one would end it.
           */
          text: (node.textContent ?? '').length,
          overflow: style.overflow,
          ellipsis: style.textOverflow,
          height: Math.round(node.getBoundingClientRect().height),
          panes: Math.round(panes.getBoundingClientRect().height),
          inside: Math.round(panes.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom),
          /* The whole chain, so a header that outgrows its box says so itself. */
          chain: {
            panel: tall('.traffic-panel'),
            split: tall('.traffic-split'),
            inspector: Math.round(box.getBoundingClientRect().height),
            head: tall('.traffic-inspector .traffic-head'),
            line: tall('.traffic-inspector .traffic-head-line')
          },
          /*
           * **The claim the user actually made: every line but the last is
           * full.**
           *
           * A height in pixels says it wrapped and proves nothing about where.
           * An inline element broken across lines gives one rect per line box
           * from a Range, so the lines are measured directly and compared with
           * the width they had to fill — one character of slack, since not every
           * character is the same width and the last one never lands exactly on
           * the edge. No backticks in this comment: it is inside a template
           * literal and one would end it.
           */
          lines: (() => {
            const range = document.createRange()
            range.selectNodeContents(node)
            const boxes = [...range.getClientRects()].map((rect) => Math.round(rect.width))
            const content =
              head === null
                ? null
                : Math.round(
                    head.clientWidth -
                      parseFloat(getComputedStyle(head).paddingLeft) -
                      parseFloat(getComputedStyle(head).paddingRight)
                  )
            const first = node.firstChild
            let character = 0
            if (first !== null) {
              const probe = document.createRange()
              probe.setStart(first, 0)
              probe.setEnd(first, 1)
              character = probe.getBoundingClientRect().width
            }
            /*
             * The first line box is excluded as well as the last, and it has to
             * be: the endpoint begins *beside* GET 200 on the header's first
             * line, so that box is short by the width of the verb and the status
             * rather than by a break opportunity. Only the lines that start at
             * the header's left edge can be asked to reach its right edge — and
             * at least one of those has to exist or the claim is empty.
             */
            const interior = boxes.slice(1, -1)
            return {
              count: boxes.length,
              checked: interior.length,
              shortest: interior.length === 0 ? null : Math.round(Math.min(...interior)),
              content,
              character: Math.round(character * 10) / 10,
              short: interior.filter((width) => width < (content ?? 0) - character * 1.5).length
            }
          })()
        }
      })())`)
    )
    say('the header with the hyphenated endpoint in it', header)
    check(
      'the header draws the whole endpoint, wraps rather than clipping, and leaves the panes their room',
      header !== null &&
        header.title > 100 &&
        header.text === header.title &&
        header.overflow === 'visible' &&
        header.ellipsis !== 'ellipsis' &&
        header.height > 20 &&
        header.panes > 40 &&
        header.inside <= 1 &&
        /*
         * At least one interior line, so the claim is not empty; and none of
         * them falls short of the width available.
         */
        header.lines.count >= 3 &&
        header.lines.checked >= 1 &&
        header.lines.content !== null &&
        header.lines.short === 0,
      `endpoint ${String(header?.title)} chars, text ${String(header?.text)}, drawn ${String(header?.height)}px tall, overflow ${String(header?.overflow)}, text-overflow ${String(header?.ellipsis)}, panes ${String(header?.panes)}px, overhang ${String(header?.inside)}, ${String(header?.lines.count)} lines of ${String(header?.lines.content)}px, shortest of ${String(header?.lines.checked)} checked ${String(header?.lines.shortest)}px, ${String(header?.lines.short)} short`
    )

    const methodColour = (name) => table.methods.find((each) => each.m === name)?.colour ?? null
    const methodColours = new Set(table.methods.map((each) => each.colour))
    check(
      'each method has a colour of its own',
      methodColour('GET') !== null &&
        methodColour('POST') !== null &&
        methodColour('GET') !== methodColour('POST') &&
        methodColours.size === new Set(table.methods.map((each) => each.m)).size,
      table.methods.map((each) => `${each.m} ${each.colour}`).join(' | ')
    )

    const trailing = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const firsts = [...document.querySelectorAll('.traffic-row-button')].map((row) =>
          ['code', 'next']
            .map((kind) => row.querySelector('.traffic-' + kind))
            .filter((node) => node !== null && (node.innerText ?? '').trim() !== '')
            .map((node) => ({
              text: (node.innerText ?? '').trim(),
              left: Math.round(node.getBoundingClientRect().left)
            }))[0] ?? null
        ).filter((each) => each !== null)
        return {
          rows: firsts.length,
          lefts: [...new Set(firsts.map((each) => each.left))],
          values: [...new Set(firsts.map((each) => each.text))].length
        }
      })())`)
    )
    say('every trailing value', trailing)
    check(
      'a code and a next action start in the same column',
      trailing.rows >= 3 && trailing.lefts.length === 1 && trailing.values >= 2,
      `${String(trailing.rows)} rows at [${trailing.lefts.join(', ')}]`
    )

    const leaked = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const rows = [...document.querySelectorAll('.traffic-row-button')]
        return {
          rows: rows.length,
          offenders: rows
            .map((row) => (row.textContent ?? '').trim())
            .filter((text) => text.includes('/*'))
        }
      })())`)
    )
    /*
     * **Two checks inverted here, and the claims are what changed.**
     *
     * The first asked that no cell hide its text and that the list be *wider*
     * than its window — the un-truncated, sideways-scrolling table. The second
     * asked that scrolling to the far end reveal the longest URL, which only
     * means anything if there is a far end to scroll to. The user has now seen
     * that table and asked for the opposite: bounded rows, no horizontal scroll,
     * and the endpoint ellipsised inside it.
     *
     * So this is the same measurement pointed the other way. Every row fits the
     * list, the list does not scroll sideways, and the longest endpoint is
     * genuinely clipped rather than merely short — with the whole URL still in
     * the title, which is what keeps the cut from being a loss.
     */
    const bounded = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const list = document.querySelector('.traffic-rows')
        const rows = [...document.querySelectorAll('.traffic-row-button')]
        if (list === null || rows.length === 0) return null
        const endpoints = [...document.querySelectorAll('.traffic-row-button .traffic-url')]
        const longest = endpoints.reduce(
          (best, node) =>
            (node.innerText ?? '').length > (best?.innerText ?? '').length ? node : best,
          null
        )
        return {
          rows: rows.length,
          listClient: list.clientWidth,
          listScroll: list.scrollWidth,
          widest: Math.round(
            Math.max(...rows.map((row) => row.getBoundingClientRect().width))
          ),
          drawn: longest === null ? null : (longest.innerText ?? '').length,
          title: longest === null ? null : (longest.getAttribute('title') ?? '').length,
          clipped: longest === null ? null : longest.scrollWidth > longest.clientWidth + 1,
          ellipsis: longest === null ? null : getComputedStyle(longest).textOverflow
        }
      })())`)
    )
    say('the row against the box it has to fit', bounded)
    check(
      'every row fits the list, and the longest endpoint is ellipsised inside it',
      bounded !== null &&
        bounded.listScroll <= bounded.listClient + 1 &&
        bounded.widest <= bounded.listClient + 1 &&
        bounded.clipped === true &&
        bounded.ellipsis === 'ellipsis' &&
        bounded.drawn !== null &&
        bounded.title !== null &&
        bounded.title > bounded.drawn,
      `list ${String(bounded?.listScroll)} in ${String(bounded?.listClient)}, widest row ${String(bounded?.widest)}, endpoint drawn ${String(bounded?.drawn)} of a title of ${String(bounded?.title)}`
    )

    /*
     * What replaced the sideways scroll: the origin is not drawn, and the whole
     * URL is still reachable.
     *
     * Both halves matter and the second is the half a later edit breaks — the
     * inspector draws the same row's `u` and must keep drawing it whole, so this
     * is the check that says "table only" was the request and stayed the
     * behaviour.
     */
    const origins = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const endpoints = [...document.querySelectorAll('.traffic-row-button .traffic-url')]
        const drawn = endpoints.map((node) => (node.innerText ?? '').trim())
        const titles = endpoints.map((node) => node.getAttribute('title') ?? '')
        const inspector = document.querySelector('.traffic-inspector .traffic-head .traffic-url')
        return {
          rows: endpoints.length,
          withScheme: drawn.filter((text) => text.includes('://')).length,
          notPath: drawn.filter((text) => !text.startsWith('/')).length,
          titlesWhole: titles.filter((text) => text.includes('://')).length,
          inspector: inspector === null ? null : (inspector.innerText ?? '').trim()
        }
      })())`)
    )
    say('the endpoint with the origin taken off', origins)
    check(
      'the origin is gone from the table, the title keeps it, and the inspector still shows it',
      origins.rows >= 2 &&
        origins.withScheme === 0 &&
        origins.notPath === 0 &&
        origins.titlesWhole === origins.rows &&
        origins.inspector !== null &&
        origins.inspector.includes('://'),
      `${String(origins.rows)} endpoints, ${String(origins.withScheme)} drawn with a scheme, ${String(origins.notPath)} not a path, ${String(origins.titlesWhole)} titles whole, inspector ${JSON.stringify(origins.inspector)}`
    )

    /*
     * The claim that survives unchanged, and the one that proves the header:
     * every column sits on the same line in every row, and the header is on
     * those lines too.
     *
     * The check this replaces asserted each cell's text started at its own box's
     * left edge — which the inter-column rules changed, since four of the five
     * cells now have a border and its padding. The edges moved; the lines they
     * moved to are shared, and that is what was ever worth asserting.
     */
    const columns = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const leftsOf = (root) =>
          root === null
            ? null
            : [...root.children].map((cell) => Math.round(cell.getBoundingClientRect().left))
        const rows = [...document.querySelectorAll('.traffic-row-button')]
        const head = document.querySelector('.traffic-head-row')
        if (rows.length < 2 || head === null) return null
        return {
          cells: [...head.children].length,
          head: leftsOf(head),
          first: leftsOf(rows[0]),
          second: leftsOf(rows[1])
        }
      })())`)
    )
    say('the column lines, header and rows', columns)
    check(
      'every column sits on one line across rows, and the header sits on those lines',
      columns !== null &&
        columns.cells === 5 &&
        columns.head.join(',') === columns.first.join(',') &&
        columns.first.join(',') === columns.second.join(','),
      `head [${(columns?.head ?? []).join(', ')}] first [${(columns?.first ?? []).join(', ')}] second [${(columns?.second ?? []).join(', ')}]`
    )

    say('literal comments in the rows', leaked)
    check(
      'no row renders a comment as text',
      leaked.rows > 0 && leaked.offenders.length === 0,
      leaked.offenders.slice(0, 2).join(' | ')
    )

    /*
     * **What this claims changed with the feature, so the check changed too.**
     *
     * It used to assert the arrows "walk the rows without opening anything" —
     * focus moved and the panes did not, which was the behaviour and is now the
     * defect. The claim is now the one the user asked for: the inspector names
     * the row the arrow landed on, at every step rather than only at the end.
     *
     * Read one step at a time, from Node, rather than in a single synchronous
     * loop inside the page. The selection is set by the keydown handler and the
     * header renders from it, and whether that render has been committed by the
     * time `dispatchEvent` returns is a batching detail this check should not
     * depend on. A wait between steps makes it a fact.
     */
    const walkState = `JSON.stringify((() => {
      const buttons = [...document.querySelectorAll('.traffic-row-button')]
      if (buttons.length === 0) return null
      const at = buttons.indexOf(document.activeElement)
      const head = document.querySelector('.traffic-inspector .traffic-head .traffic-url')
      return {
        count: buttons.length,
        at,
        url:
          at === -1
            ? null
            : (buttons[at].querySelector('.traffic-url')?.innerText ?? '').trim(),
        /*
         * Whitespace flattened, because the header's endpoint wraps now and this
         * comparison is about which row it names rather than where the lines
         * broke. The doubled backslash is not a typo: this is inside a template
         * literal, where a single one would be eaten and the regex would come out
         * as the letters s+.
         */
        head:
          head === null ? null : (head.innerText || '').replace(/\\s+/g, ' ').trim(),
        pressed: buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true')
      }
    })())`

    await app.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.traffic-row-button')]
      if (buttons.length > 0) buttons[0].focus()
      return true
    })()`)
    await wait(500)

    const walk = [JSON.parse(await app.evaluate(walkState))]
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
      await app.evaluate(`(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })
        )
        return true
      })()`)
      await wait(500)
      walk.push(JSON.parse(await app.evaluate(walkState)))
    }

    say('the arrows', walk)
    /*
     * The first reading is the one before any arrow: focus is on row 0 and
     * nothing has selected it, which is the state the walk starts from. The
     * three after it are the arrows, and every one of them has to have moved
     * both — focus, selection, and the row the inspector names.
     *
     * **The comparison changed with the table, and it had to.** This asserted
     * the inspector's header text equalled the row's drawn text, which held
     * while both drew `row.u`. The table now draws the path with the origin
     * stripped and the inspector still draws the whole URL on purpose, so the
     * claim is that the header *ends with* the path the row shows — and that
     * what precedes it is one and the same origin at every step, which is what
     * stops a matching suffix from standing in for the wrong row.
     */
    const steps = walk.slice(1)
    const prefixes = steps
      .filter((each) => each.head !== null && each.url !== null)
      .map((each) => (each.head ?? '').slice(0, (each.head ?? '').length - (each.url ?? '').length))
    check(
      'the arrows walk the rows, and the inspector names the row they land on',
      walk.map((each) => each.at).join(',') === '0,1,2,1' &&
        steps.length === 3 &&
        steps.every((each) => each.pressed === each.at) &&
        steps.every(
          (each) =>
            each.url !== null &&
            each.url !== '' &&
            each.head !== null &&
            each.head.endsWith(each.url)
        ) &&
        prefixes.length === 3 &&
        new Set(prefixes).size === 1,
      walk
        .map(
          (each) => `${String(each.at)}/${String(each.pressed)}:${(each.head ?? 'none').slice(-28)}`
        )
        .join(' | ')
    )

    /*
     * Following the newest row, while the person is still at the bottom.
     *
     * **The list has to be genuinely scrollable or none of this means
     * anything** — a container whose content fits reports the same three numbers
     * whatever it does, and every assertion below would hold with the feature
     * removed. So the precondition is checked rather than assumed.
     */
    for (let i = 0; i < 60; i++) {
      await fetch(`http://127.0.0.1:${String(port)}/fill/${String(i)}`)
    }
    await wait(2_500)

    /*
     * **The header sticks, and this is measured rather than assumed.**
     *
     * `position: sticky` on a grid item of a list whose rows are `display:
     * contents` is exactly the kind of rule that reads correctly in a stylesheet
     * and does nothing on screen — a sticky element sticks within its scrolling
     * ancestor, and whether this one has a scrollport to stick in depends on a
     * structure two elements away. A header that scrolls away is visible only to
     * somebody who has not scrolled yet, which is nobody who needs it.
     *
     * `scrolled > 100` is the control: without it this passes on a list that
     * never moved, which is the failure mode the whole check exists to catch.
     */
    const sticky = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const list = document.querySelector('.traffic-rows')
        const head = document.querySelector('.traffic-head-row')
        if (list === null || head === null) return null
        const offset = () =>
          Math.round(head.getBoundingClientRect().top - list.getBoundingClientRect().top)
        const atRest = offset()
        const before = list.scrollTop
        list.scrollTop = 400
        const scrolled = Math.round(list.scrollTop)
        const whileScrolled = offset()
        list.scrollTop = before
        return { atRest, scrolled, whileScrolled }
      })())`)
    )
    say('the header while the rows scroll under it', sticky)
    check(
      'the header holds the top of the list while the rows scroll under it',
      sticky !== null &&
        sticky.scrolled > 100 &&
        Math.abs(sticky.whileScrolled - sticky.atRest) <= 2,
      `at rest ${String(sticky?.atRest)}px from the top; scrolled ${String(sticky?.scrolled)}px it is ${String(sticky?.whileScrolled)}px`
    )

    /*
     * **The bottom, stated rather than inherited.**
     *
     * The arrow walk above focuses a row, and focusing scrolls the list to it —
     * which it should. Following is a claim about a list the person is standing
     * at the bottom of, so the bottom is the precondition, and leaving it to
     * whatever the previous check happened to leave behind made this pass or
     * fail for a reason that has nothing to do with following. It also makes the
     * walk's own consequence explicit rather than accidental: arrow away from
     * the bottom and following stops, which is the behaviour the check three
     * below this one asserts on purpose.
     */
    await app.evaluate(`(() => {
      const list = document.querySelector('.traffic-rows')
      if (list !== null) list.scrollTop = list.scrollHeight
      return true
    })()`)
    await wait(400)

    const scrolled = () =>
      app.evaluate(`(() => {
        const list = document.querySelector('.traffic-rows')
        return list === null
          ? null
          : {
              scrollHeight: list.scrollHeight,
              clientHeight: list.clientHeight,
              scrollTop: Math.round(list.scrollTop),
              fromBottom: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight),
            }
      })()`)

    /*
     * **Not the predicate's 24px.** A zoomed list needs that much slack to keep
     * following at all, but a list that has *followed* is at the bottom — and
     * asserting the slack is what let this check pass with the feature removed:
     * measured, five rows moved the list exactly 24px, so a list that never
     * followed satisfied "within 24px of the bottom". The two numbers are
     * deliberately different, and this is the smaller one because it is the one
     * that can fail.
     */
    const AT_BOTTOM_PX = 4

    const filled = await scrolled()
    check(
      'the list is long enough to scroll, or following proves nothing',
      filled !== null && filled.scrollHeight > filled.clientHeight,
      `content ${String(filled?.scrollHeight)} vs box ${String(filled?.clientHeight)}`
    )

    /*
     * Several rows, not one, and the arithmetic is why: this list is 261px tall
     * holding about 1,500px of rows, so a single row is roughly 23px — under the
     * 24px tolerance that keeps a zoomed list following at all. One row would
     * land inside the slack and the check would pass with the feature removed
     * entirely, which is the failure mode this whole exercise is about.
     */
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${String(port)}/followed/${String(i)}`)
    }
    await wait(1_500)
    const followed = await scrolled()
    check(
      'a new row keeps the list at the bottom while it is following',
      followed !== null && followed.fromBottom <= AT_BOTTOM_PX,
      `${String(followed?.fromBottom)}px from the bottom`
    )

    await app.evaluate(`(() => {
      document.querySelector('.traffic-rows').scrollTop = 0
      return true
    })()`)
    await wait(400)
    const parked = await scrolled()
    say('parked at the top before the rows arrive', parked)
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${String(port)}/while-reading/${String(i)}`)
    }
    await wait(1_500)
    const stayed = await scrolled()
    say('after the rows while parked', stayed)
    check(
      'and it does not move a list somebody has scrolled away from',
      parked !== null && stayed !== null && stayed.scrollTop === parked.scrollTop,
      `scrollTop ${String(parked?.scrollTop)} to ${String(stayed?.scrollTop)}`
    )

    await app.evaluate(`(() => {
      const list = document.querySelector('.traffic-rows')
      list.scrollTop = list.scrollHeight
      return true
    })()`)
    await wait(400)
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${String(port)}/resumed/${String(i)}`)
    }
    await wait(1_500)
    const resumed = await scrolled()
    check(
      'and scrolling back down resumes it',
      resumed !== null && resumed.fromBottom <= AT_BOTTOM_PX,
      `${String(resumed?.fromBottom)}px from the bottom`
    )

    /*
     * Clearing the history, which was built end to end and had no button.
     *
     * Written so that "there is no button" is **its own answer** rather than a
     * thrown TypeError: before this change nothing matched the selector at all,
     * and a driver that crashes on the missing element cannot say which of its
     * expectations went unmet — it reports a stack instead of an absence. The
     * two checks are separate for the same reason: the button existing and the
     * button working are different claims.
     *
     * Found by its `data-` hook, not by its text. Both Clear buttons used to be
     * looked up by the word they happened to display, and renaming one of them
     * made two checks report a wrong value instead of failing — see C-069.
     */
    const pressed = JSON.parse(
      await app.evaluate(`(() => {
        const button = document.querySelector('[data-traffic-clear="captured"]')
        if (button === null) return JSON.stringify({ found: false, beside: false })
        const row = button.closest('.traffic-source-row')
        button.click()
        return JSON.stringify({
          found: true,
          beside: row !== null && row.querySelector('[aria-label="Search the list"]') !== null,
        })
      })()`)
    )
    await wait(1_500)
    const emptied = JSON.parse(
      await app.evaluate(`(() => {
        const count = document.querySelector('.traffic-count')
        return JSON.stringify({
          rows: document.querySelectorAll('.traffic-row').length,
          count: count === null ? null : count.innerText,
        })
      })()`)
    )
    say('after the capture Clear', emptied)
    check(
      'a Clear that acts on the capture is offered, beside the search field',
      pressed.found === true && pressed.beside === true,
      pressed.found === true
        ? `found, in the search row: ${String(pressed.beside)}`
        : 'no button carrying data-traffic-clear="captured"'
    )
    check(
      'and pressing it empties the rows and takes the count to zero',
      emptied.rows === 0 && (emptied.count || '').includes('0 captured'),
      `${String(emptied.rows)} rows, count ${String(emptied.count)}`
    )

    /*
     * The header holds no Clear at all, and that is a stronger claim than the
     * one it replaces.
     *
     * "Clear is 42px from Stop" was the property while Clear lived in the
     * header. The user moved it out, so the property becomes an absence — and an
     * absence cannot be eroded by a reflow, which is the argument for stating it
     * this way rather than deleting the check along with the spacer it guarded.
     * A gap measuring nothing is the tail this repo's own note warns about.
     *
     * **The width precondition stays, and it is worth more than the check it was
     * written for.** It is what caught a vacuous pass of its predecessor: the
     * panel takes its width from the Chorus column and not from the viewport, so
     * an `Emulation` override measured the same layout twice and the narrow half
     * proved nothing at all. Here it guards the absence — a header never laid
     * out narrow would not show the crowding this is about.
     */
    const headerClear = () =>
      app.evaluate(`(() => {
        const header = document.querySelector('.traffic-head')
        const panel = document.querySelector('.traffic-panel')
        if (header === null || panel === null) return null
        return {
          inside: header.querySelector('[data-traffic-clear]') !== null,
          panel: Math.round(panel.getBoundingClientRect().width),
        }
      })()`)

    const wide = await headerClear()
    /*
     * **The narrow width is set on the panel itself, and that is deliberate
     * rather than a shortcut.** The panel's width comes from the Chorus column —
     * a value the person drags and the app stores — and not from the viewport,
     * which is why an `Emulation` override changed nothing and measured the same
     * layout twice at 417px. This supplies the container's width, and the
     * assertion that the panel actually got narrower is what stops the injection
     * from hiding a reflow that never happened.
     */
    const restoredWidth = await app.evaluate(`(() => {
      const panel = document.querySelector('.traffic-panel')
      if (panel === null) return null
      const before = panel.style.width
      panel.style.width = '300px'
      return before
    })()`)
    await wait(700)
    const narrow = await headerClear()

    /*
     * The shape of the capture setup: one name per field, the hints attached as
     * descriptions, and the columns in each row actually separated. Read at 300px
     * because that is where a label that does not fit and a row with no gap show
     * up first.
     *
     * `control.labels` is the browser's own association — the `<label for>` to
     * `id` link, already made — and not a re-derivation from the markup. Reading
     * it is the difference between "there is a label element nearby" and "this
     * control's accessible name is that text"; only the second is what the
     * `aria-label` removal was for.
     */
    const fieldShape = `JSON.stringify((() => {
      const panel = document.querySelector('.traffic-panel')
      if (panel === null) return { present: false }
      const setup = panel.querySelector('.traffic-setup')
      const right = (node) => Math.round(node.getBoundingClientRect().right)
      const fields = [...panel.querySelectorAll('[data-traffic-field]')].map((field) => {
        const control = field.querySelector('input, select')
        const hint = field.querySelector('.traffic-field-hint')
        const described = control === null ? null : control.getAttribute('aria-describedby')
        return {
          key: field.getAttribute('data-traffic-field'),
          drawn: control !== null && control.checkVisibility(),
          label: field.querySelector('.traffic-field-name')?.innerText.trim() ?? null,
          names: control === null || control.labels === null
            ? []
            : [...control.labels].map((node) => node.innerText.trim()),
          aria: control === null ? null : control.getAttribute('aria-label'),
          hint: hint === null ? null : hint.innerText.trim(),
          described: described !== null && hint !== null && described === hint.id,
          right: control === null ? null : right(control)
        }
      })
      const rows = [...panel.querySelectorAll('.traffic-source-row')]
      const gaps = rows
        .map((row) => [...row.children].map((node) => node.getBoundingClientRect()))
        .filter((boxes) => boxes.length > 1)
        .map((boxes) => Math.round(boxes[1].left - boxes[0].right))
      /*
       * Between the rows, and measured child to child rather than box to box:
       * two adjacent block boxes are flush at zero, because the padding that
       * separates them is inside both of them. The children sit in the content
       * area, so their boxes are what actually moved apart.
       */
      const stacked = rows
        .slice(1)
        .map((row, index) => {
          const above = rows[index].lastElementChild
          const below = row.firstElementChild
          if (above === null || below === null) return null
          return Math.round(
            below.getBoundingClientRect().top - above.getBoundingClientRect().bottom
          )
        })
        .filter((gap) => gap !== null)
      return {
        present: true,
        open: setup === null ? null : setup.open,
        fields,
        gaps,
        stacked,
        overflow: [...panel.querySelectorAll('.traffic-setup input, .traffic-setup select')]
          .filter((node) => right(node) > right(panel))
          .map((node) => node.id)
      }
    })())`

    const setSetupOpen = async (open) => {
      await app.evaluate(`(() => {
        const setup = document.querySelector('.traffic-setup')
        if (setup !== null) setup.open = ${String(open)}
        return true
      })()`)
      await wait(700)
    }

    const fieldsOpen = JSON.parse(await app.evaluate(fieldShape))
    await setSetupOpen(false)
    const fieldsShut = JSON.parse(await app.evaluate(fieldShape))
    await setSetupOpen(true)

    await app.evaluate(`(() => {
      const panel = document.querySelector('.traffic-panel')
      if (panel !== null) panel.style.width = ${JSON.stringify(restoredWidth ?? '')}
      return true
    })()`)
    await wait(700)
    say('Clear in the header', { wide, narrow })
    check(
      'the header holds no Clear at all, at this width or a narrower one',
      wide !== null &&
        narrow !== null &&
        !wide.inside &&
        !narrow.inside &&
        narrow.panel < wide.panel,
      `in header ${String(wide?.inside)} at ${String(wide?.panel)}px, ${String(narrow?.inside)} at ${String(narrow?.panel)}px`
    )

    const openFields = fieldsOpen.fields ?? []
    const hinted = openFields.filter((field) => field.hint !== null && field.hint !== '')
    const describe = (field) =>
      `${String(field.key)}: ${JSON.stringify(field.label)} -> [${field.names.join(', ')}]`
    say('the capture setup at 300px, open', fieldsOpen)
    check(
      'every field in the setup names itself with a visible label, tied to its control',
      fieldsOpen.open === true &&
        openFields.length === 5 &&
        openFields.every(
          (field) =>
            field.drawn && field.label !== null && field.label !== '' && field.names.length === 1
        ) &&
        openFields.every((field) => field.names[0] === field.label),
      openFields.map(describe).join(' | ')
    )
    check(
      'and no field carries a second name beside the visible one',
      openFields.every((field) => field.aria === null),
      openFields
        .filter((field) => field.aria !== null)
        .map((field) => `${String(field.key)}: ${String(field.aria)}`)
        .join(' | ') || 'none'
    )
    check(
      'the hints are descriptions, on origin, port, the variable and the reach',
      ['origin', 'port', 'envVar'].every((key) => hinted.some((field) => field.key === key)) &&
        hinted.every((field) => field.described === true),
      hinted
        .map(
          (field) =>
            `${String(field.key)}: ${JSON.stringify(field.hint)} described=${String(field.described)}`
        )
        .join(' | ')
    )
    check(
      'the two columns in a row are separated, and nothing spills past the panel',
      fieldsOpen.gaps.length >= 2 &&
        fieldsOpen.gaps.every((gap) => gap >= 6) &&
        fieldsOpen.overflow.length === 0,
      `gaps [${fieldsOpen.gaps.join(', ')}]px, overflowing [${fieldsOpen.overflow.join(', ')}]`
    )
    check(
      'and the rows stack with room between them, not flush',
      fieldsOpen.stacked.length >= 2 && fieldsOpen.stacked.every((gap) => gap >= 10),
      `stacked [${fieldsOpen.stacked.join(', ')}]px between rows`
    )
    say('the capture setup at 300px, closed', fieldsShut)
    check(
      'and it still collapses at that width, taking its fields with it',
      fieldsShut.open === false &&
        (fieldsShut.fields ?? []).length === 5 &&
        (fieldsShut.fields ?? []).every((field) => field.drawn === false),
      `open ${String(fieldsShut.open)}, drawn ${String((fieldsShut.fields ?? []).filter((field) => field.drawn).length)} of 5`
    )

    await fetch(`http://127.0.0.1:${String(port)}/gz`)
    await wait(2_500)
    /*
     * Found on the button, not the list item. The row is display: contents now,
     * so it has no box — and innerText is *rendered* text, which for a box-less
     * element is not the same guarantee. A row that matched nothing would leave
     * this click doing nothing at all and every check below it failing for a
     * reason three steps away, which is C-069's exact shape.
     */
    await app.evaluate(`(() => {
      const row = [...document.querySelectorAll('.traffic-row-button')]
        .find((node) => (node.innerText || '').includes('/gz'))
      if (row === undefined) return 'the gzipped request is not listed'
      row.click()
      return 'showing the gzipped request'
    })()`)
    await wait(2_000)
    await wait(4_000)

    const treeState = `JSON.stringify({
      present: document.querySelector('.traffic-pane[data-side="response"] .traffic-tree') !== null,
      flat: document.querySelector('.traffic-pane[data-side="response"] .traffic-body-text') !== null,
      rows: document.querySelectorAll('.traffic-pane[data-side="response"] .traffic-node').length,
      focus: document.activeElement?.getAttribute('data-path') ?? null,
      keys: document.querySelectorAll('.traffic-pane[data-side="response"] .traffic-node .tok--property').length,
      strings: document.querySelectorAll('.traffic-pane[data-side="response"] .traffic-node .tok--string').length,
      keywords: document.querySelectorAll('.traffic-pane[data-side="response"] .traffic-node .tok--keyword').length,
      text: document.querySelector('.traffic-pane[data-side="response"] .traffic-tree')?.innerText ?? null
    })`

    const tree = JSON.parse(await app.evaluate(treeState))
    say('a gzipped response body', tree)
    check(
      'a JSON body is a tree, coloured, not flat text',
      tree.present && !tree.flat && tree.keys >= 3 && tree.strings >= 1 && tree.keywords >= 1,
      `keys ${String(tree.keys)}, strings ${String(tree.strings)}, keywords ${String(tree.keywords)}`
    )
    check(
      'and it shows the values the wire carried',
      typeof tree.text === 'string' && tree.text.includes('readable'),
      JSON.stringify(tree.text)
    )
    check(
      'every row is drawn when nothing is folded, braces and all',
      tree.rows === 11,
      `${String(tree.rows)} rows`
    )

    await app.evaluate(`(() => {
      const node = document.querySelector('.traffic-pane[data-side="response"] .traffic-node[data-path="/1"]')
      if (node === null) return false
      node.focus()
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
      return true
    })()`)
    await wait(600)
    const treeFolded = JSON.parse(await app.evaluate(treeState))
    check(
      'ArrowLeft folds the focused node',
      treeFolded.rows === 5,
      `${String(treeFolded.rows)} rows`
    )

    await app.evaluate(`(() => {
      document
        .querySelector('.traffic-pane[data-side="response"] .traffic-node[data-path="/1"]')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      return true
    })()`)
    await wait(600)
    const unfolded = JSON.parse(await app.evaluate(treeState))
    check('ArrowRight unfolds it again', unfolded.rows === 11, `${String(unfolded.rows)} rows`)

    await app.evaluate(`(() => {
      document
        .querySelector('.traffic-pane[data-side="response"] .traffic-node[data-path="/1"]')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      return true
    })()`)
    await wait(500)

    const nesting = JSON.parse(
      await app.evaluate(`(() => {
        const contentLeft = (selector) => {
          const row = document.querySelector(selector)
          if (row === null) return null
          const style = getComputedStyle(row)
          return Math.round(row.getBoundingClientRect().left + parseFloat(style.paddingLeft))
        }
        const key = document.querySelector('.traffic-pane[data-side="response"] .traffic-node[data-path="/1"] .tok--property')
        return JSON.stringify({
          parentKey: key === null ? null : Math.round(key.getBoundingClientRect().left),
          child: contentLeft('.traffic-pane[data-side="response"] .traffic-node[data-path="/1/0"]'),
          closer: contentLeft('.traffic-pane[data-side="response"] .traffic-node[data-path="/1/>"]')
        })
      })()`)
    )
    say('the nesting', nesting)
    check(
      'a child is indented past the key that holds it',
      nesting.child !== null && nesting.parentKey !== null && nesting.child > nesting.parentKey,
      `child ${String(nesting.child)} vs key ${String(nesting.parentKey)}`
    )
    check(
      'and the closing bracket lands on that key',
      nesting.closer !== null &&
        nesting.parentKey !== null &&
        Math.abs(nesting.closer - nesting.parentKey) <= 2,
      `closer ${String(nesting.closer)} vs key ${String(nesting.parentKey)}`
    )

    const stepped = JSON.parse(await app.evaluate(treeState))
    check(
      'ArrowDown moves into the node it opened',
      stepped.focus === '/1/0',
      `focus at ${String(stepped.focus)}`
    )

    const { data } = await app.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    writeFileSync('/tmp/traffic-drive.png', Buffer.from(data, 'base64'))
    say('screenshot', '/tmp/traffic-drive.png')
  }
  const strip = `JSON.stringify(
    [...document.querySelectorAll('.conversation-dock-tab')].map((node) => {
      const box = node.getBoundingClientRect()
      return {
        traffic: node.getAttribute('data-traffic-tab') === 'true',
        title: (node.innerText || '').split('\\n')[0],
        x: Math.round(box.left + box.width / 2),
        left: Math.round(box.left),
        right: Math.round(box.right),
        y: Math.round(box.top + box.height / 2)
      }
    })
  )`

  const addTab = () =>
    app.evaluate(`(() => {
      const add = [...document.querySelectorAll('.conversation-dock-add')]
        .find((node) => (node.innerText || '').trim() === '+')
      if (add === undefined) return false
      add.click()
      return true
    })()`)

  /*
   * A real pointer owns the capture and a dispatched one cannot claim it, so the
   * three capture calls are stubbed for the length of the gesture. Everything
   * else — the threshold, the target, the layout and the store — runs for real.
   */
  /*
   * `yMode` picks where the pointer is when it lets go.
   *
   * `tab` is the tab strip's own row, which for a short column lies inside that
   * column's top split band — so a drop there is a split, and always was, for a
   * conversation tab as much as for this one. `column` aims at the middle of the
   * column instead, below both bands, which is where the slot list is reachable.
   */
  const gesture = (from, to, at, side, yMode) => `(() => {
    const tab = document.querySelector(${JSON.stringify(from)})
    const other = [...document.querySelectorAll(${JSON.stringify(to)})][${String(at)}]
    if (tab === null || other === undefined) return 'missing a tab'
    const here = tab.getBoundingClientRect()
    const there = other.getBoundingClientRect()
    const column = document.querySelector('.conversation-column').getBoundingClientRect()
    const fromX = Math.round(here.left + here.width / 2)
    const y =
      ${JSON.stringify(yMode)} === 'column'
        ? Math.round(column.top + column.height / 2)
        : Math.round(here.top + here.height / 2)
    const toX =
      ${JSON.stringify(side)} === 'left'
        ? Math.round(there.left + 4)
        : ${JSON.stringify(side)} === 'right'
          ? Math.round(there.right - 4)
          : Math.round(there.left + there.width / 2 + 20)
    const proto = Element.prototype
    const saved = [proto.setPointerCapture, proto.releasePointerCapture, proto.hasPointerCapture]
    proto.setPointerCapture = function () {}
    proto.releasePointerCapture = function () {}
    proto.hasPointerCapture = function () {
      return false
    }
    const send = (type, x) => {
      tab.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: x,
          clientY: y
        })
      )
    }
    send('pointerdown', fromX)
    for (let step = 1; step <= 8; step++) {
      send('pointermove', Math.round(fromX + ((toX - fromX) * step) / 8))
    }
    send('pointerup', toX)
    proto.setPointerCapture = saved[0]
    proto.releasePointerCapture = saved[1]
    proto.hasPointerCapture = saved[2]
    return 'from ' + String(fromX) + ' to ' + String(toX)
  })()`

  const CONVERSATION_TAB =
    '.conversation-dock-tab:not([data-traffic-tab]) .conversation-dock-tab-main'
  const TRAFFIC_TAB = '.conversation-dock-tab[data-traffic-tab="true"] .conversation-dock-tab-main'

  await addTab()
  await wait(1_500)
  await addTab()
  await wait(2_500)

  const before = JSON.parse(await app.evaluate(strip))
  say('the tab strip', before)
  const at = before.findIndex((each) => each.traffic)

  /*
   * Both measured in this one column, because the active tab is drawn
   * differently in a focused column than in an unfocused one — dashed and
   * tinted back at 55% — and a comparison across two columns would be reading
   * the focus state rather than the tab.
   */
  const look = `JSON.stringify((() => {
    const node = document.querySelector('.conversation-dock-tab[data-active="true"]')
    if (node === null) return null
    const style = getComputedStyle(node)
    const close = node.querySelector('.conversation-dock-tab-close')
    return {
      traffic: node.getAttribute('data-traffic-tab') === 'true',
      border: style.borderTopColor,
      style: style.borderTopStyle,
      ground: style.backgroundColor,
      ink: style.color,
      close: close === null ? null : getComputedStyle(close).opacity
    }
  })())`

  await app.evaluate(`(() => {
    const tab = document.querySelector('.conversation-dock-tab[data-traffic-tab] .conversation-dock-tab-main')
    if (tab !== null) tab.click()
    return true
  })()`)
  await wait(1_200)
  const trafficLook = JSON.parse(await app.evaluate(look))

  await app.evaluate(`(() => {
    const tab = document.querySelector('.conversation-dock-tab:not([data-traffic-tab]) .conversation-dock-tab-main')
    if (tab !== null) tab.click()
    return true
  })()`)
  await wait(1_200)
  const conversationLook = JSON.parse(await app.evaluate(look))
  say('the tab chrome, both in one column', {
    traffic: trafficLook,
    conversation: conversationLook,
  })
  check(
    'the traffic tab wears the same active chrome as a conversation tab',
    trafficLook !== null &&
      conversationLook !== null &&
      trafficLook.traffic === true &&
      conversationLook.traffic === false &&
      trafficLook.border === conversationLook.border &&
      trafficLook.style === conversationLook.style &&
      trafficLook.ground === conversationLook.ground &&
      trafficLook.ink === conversationLook.ink &&
      trafficLook.close === conversationLook.close,
    `traffic ${JSON.stringify(trafficLook)} vs conversation ${JSON.stringify(conversationLook)}`
  )

  if (before.length >= 3 && at > 0) {
    /*
     * Aimed at the midpoint of the *second* conversation tab, and that is not
     * arbitrary: a column's strip sits inside that column's own edge bands, so
     * a drop anywhere over its first or last tab splits instead of taking a
     * slot. The middle of the strip is the only place the slot list is
     * reachable — for a conversation tab as much as for this one.
     */
    say(
      'the slot drag',
      await app.evaluate(gesture(CONVERSATION_TAB, '.conversation-dock-tab', 1, 'mid', 'column'))
    )
    await wait(1_200)
    const after = JSON.parse(await app.evaluate(strip))
    say('the strip after dropping a conversation before the traffic tab', after)
    const trafficAt = after.findIndex((each) => each.traffic)
    const columns = await app.evaluate(`document.querySelectorAll('.conversation-column').length`)
    check(
      'a conversation is slotted in before the traffic tab',
      trafficAt > 0 && after.length === before.length,
      after.map((each) => (each.traffic ? 'traffic' : each.title)).join(' | ')
    )
    check(
      'and that drop took a slot rather than splitting',
      columns === 1 && after.length === before.length,
      `${String(columns)} column(s), ${String(after.length)} tabs`
    )
    check(
      'the dragged tab landed immediately before the traffic tab',
      trafficAt > 0 &&
        after[trafficAt - 1]?.traffic === false &&
        after.filter((each) => each.traffic).length === 1,
      after.map((each) => (each.traffic ? 'traffic' : each.title)).join(' | ')
    )
  } else {
    check('the strip offered three tabs to reorder', false, `${String(before.length)} tabs`)
  }

  const splitBefore = JSON.parse(await app.evaluate(strip))
  const last = splitBefore.length - 1
  if (splitBefore.length >= 2 && splitBefore[last]?.traffic === true) {
    say(
      'the split drag',
      await app.evaluate(gesture(TRAFFIC_TAB, '.conversation-column', 0, 'left', 'tab'))
    )
    await wait(1_200)
    const split = JSON.parse(
      await app.evaluate(`JSON.stringify({
        columns: document.querySelectorAll('.conversation-column').length,
        first: (() => {
          const column = document.querySelector('.conversation-column')
          if (column === null) return null
          return [...column.querySelectorAll('[data-tab-id]')].map((node) =>
            node.getAttribute('data-traffic-tab') === 'true' ? 'traffic' : node.innerText.split('\\n')[0]
          )
        })(),
        trafficTabs: document.querySelectorAll('[data-tab-id="traffic"]').length
      })`)
    )
    say('the columns after dragging the traffic tab to the edge', split)
    check(
      'the traffic tab splits out into its own group',
      split.columns === 2 && split.first !== null && split.first.includes('traffic'),
      `columns ${String(split.columns)}, first ${String(split.first)}`
    )
    check('and it moved rather than copied', split.trafficTabs === 1)

    // Moving the tab to a new column remounts the panel, which clears the
    // selected row, so one is chosen again before the details exist to measure.
    await app.evaluate(`(() => {
      const row = document.querySelector('.traffic-row-button')
      if (row !== null) row.click()
      return true
    })()`)
    await wait(3_000)

    const box = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const list = document.querySelector('.traffic-split')
        const details = document.querySelector('.traffic-inspector')
        if (list === null || details === null) return null
        return {
          list: Math.round(list.getBoundingClientRect().height),
          details: Math.round(details.getBoundingClientRect().height),
          window: window.innerHeight
        }
      })())`)
    )
    /*
     * **The share changed, so the number in the check changed with it — and one
     * of the two clauses could not survive.**
     *
     * This asserted `details == list / 2` and `|details - window / 2| > 2`: the
     * first said the details are sized by the box they sit in, the second said
     * that box is not the screen — which was a real bug once, when the rule was
     * `50vh` and a split pane gave the details more than half of a shorter
     * column.
     *
     * At seventy percent the two numbers collide here: 70% of a 612px split is
     * 428, and half of an 860px window is 430. They are the same to within the
     * tolerance, so that clause cannot tell the two rules apart at this window
     * size and is not kept as if it could. What is left is the claim the user
     * actually made — the details take the share of their box — plus the fact
     * that the box is shorter than the window, which is the condition under
     * which a viewport-sized value would have been wrong in the first place.
     */
    const DETAIL_SHARE = 0.7
    say('the details against their box', box)
    check(
      'the details take the share of their box that the panel asks for',
      box !== null &&
        Math.abs(box.details - Math.round(box.list * DETAIL_SHARE)) <= 2 &&
        box.list < box.window,
      `details ${String(box?.details)} of list ${String(box?.list)} (70% is ${String(Math.round((box?.list ?? 0) * DETAIL_SHARE))}), window ${String(box?.window)}`
    )

    say(
      'the rectangles after a split',
      JSON.parse(
        await app.evaluate(`JSON.stringify((() => {
        const box = (selector) => {
          const node = document.querySelector(selector)
          if (node === null) return null
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return {
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            widthCss: style.width,
            minWidth: style.minWidth,
            flexShrink: style.flexShrink,
            flexBasis: style.flexBasis,
            overflow: style.overflow,
            scrollWidth: node.scrollWidth
          }
        }
        return {
          window: window.innerWidth + 'x' + window.innerHeight,
          full: document.querySelector('.workspace-pane-chorus')?.getAttribute('data-full') ?? null,
          surface: box('[data-workbench-surface]'),
          chorus: box('.workspace-pane-chorus'),
          content: box('.workspace-pane-content'),
          pane: box('.workspace-pane')
        }
      })())`)
      )
    )
  } else {
    check(
      'the traffic tab was last, where a split starts from',
      false,
      `${String(splitBefore.length)} tabs`
    )
  }
} finally {
  await app.quit()
  upstream.server.close()
}

console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
