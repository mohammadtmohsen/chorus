import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, wait } from './harness.mjs'
import { existingDescriptors, FakeIde, waitForDescriptor } from './fake-ide.mjs'

/**
 * What each spec is here to catch.
 *
 * Every one of these corresponds to a bug that reached the app and was found by
 * hand. They are written as the smallest question that would have caught it.
 */

/*
 * `.pane` is a *mounted* session, and since the workspace shell arrived that is
 * no longer the same thing as an editor group: only a group's active tab is
 * mounted, so two sessions sharing one group means two tabs and one `.pane`.
 * That distinction is the mount policy, so the selectors keep them apart.
 */
const PANE = '.pane'
const GROUP = '[data-workspace-pane]'
const TAB = '[data-workspace-tab]'
const started = (page) => page.until(`document.querySelectorAll('${PANE}').length > 0`)

/** The ＋ on the quick rail. It is part of the daily loop, so it never collapses. */
const newSession = (page) =>
  page.evaluate(`(() => {
    document.querySelector('[data-rail-new]').click()
    return true
  })()`)

/**
 * The drawer, opened.
 *
 * The app starts collapsed now — the rail is the primary state — so anything
 * asserting about rows, search or Arrange has to ask for the drawer first. A
 * spec that assumed it was open would find an empty list rather than a failure
 * it could read.
 */
const openDrawer = async (page) => {
  if (
    (await page.evaluate(`document.querySelector('.session-drawer').dataset.hidden`)) !== 'true'
  ) {
    return
  }
  await page.evaluate(
    `(() => { document.querySelector('[data-rail-drawer]').click(); return true })()`
  )
  await page.until(`document.querySelector('.session-drawer').dataset.hidden !== 'true'`, {
    timeout: 10_000,
    label: 'the drawer opened',
  })
}

/**
 * A shortcut, as the app's own listener sees it.
 *
 * Dispatched on `document` because that is where the capture-phase handler
 * lives; sending it to the focused element would test bubbling instead.
 */
const press = (page, key, { meta = false, shift = false, alt = false } = {}) =>
  page.evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
      metaKey: ${String(meta)}, shiftKey: ${String(shift)}, altKey: ${String(alt)},
    }))
    return true
  })()`)

/** Types without sending, so the draft is still unsent when the pane unmounts. */
const draft = (page, text) =>
  page.evaluate(`(() => {
    const ta = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      .set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

/**
 * A key as the *composer* sees it.
 *
 * `press` dispatches on `document`, which is where the app's global shortcuts
 * listen — a keydown sent there never reaches the textarea's own handler, since
 * React delegates from the root and the target would be the document. Recall
 * lives on the box, so the event has to start there.
 */
const pressIn = (page, key) =>
  page.evaluate(`(() => {
    const ta = document.querySelector('.composer textarea')
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
    }))
    return true
  })()`)

/**
 * A token's hex as `getComputedStyle` reports a colour, so the two can be
 * compared without writing either theme's palette into a spec.
 */
const hexToRgb = (hex) => {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`
}

const tabIds = (page) =>
  page.evaluate(`Array.from(document.querySelectorAll('${TAB}')).map(t => t.dataset.workspaceTab)`)

const clickTab = (page, conversationId) =>
  page.evaluate(`(() => {
    document.querySelector('${TAB}[data-workspace-tab="${conversationId}"]').click()
    return true
  })()`)

/** Opens a session from the rail, which is reachable whether or not the drawer is. */
const clickSidebarRow = (page, conversationId) =>
  page.evaluate(`(() => {
    document.querySelector('[data-rail-session="${conversationId}"]').click()
    return true
  })()`)

/** Two sessions, which is the smallest workspace where tabs and splits mean anything. */
async function twoSessions(app) {
  await started(app)
  await newSession(app)
  await app.until(`document.querySelectorAll('${TAB}').length === 2`, { timeout: 120_000 })
  return tabIds(app)
}

/**
 * Types into the composer and sends, the way the app's own handlers see it.
 *
 * The native value setter rather than `ta.value =`: React tracks the last value
 * it wrote, and an assignment it did not see is discarded on the next render —
 * the field would clear and the message would never leave.
 */
const say = (page, text) =>
  page.evaluate(`(() => {
    const ta = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      .set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.composer').requestSubmit()
    return true
  })()`)

/**
 * The quote offer as it is actually drawn: where, how many rows, and whether
 * each action is clickable where it appears.
 *
 * A helper because the width at which the bar wraps depends on how many actions
 * it has, so the spec has to measure at more than one width rather than trusting
 * a number written down when there were four of them.
 */
const measureOffer = (page) =>
  page.evaluate(`(() => {
    const bar = document.querySelector('.quote-offer')
    if (bar === null) return { offer: false, rows: 0 }
    const r = bar.getBoundingClientRect()
    const score = document.querySelector('.score').getBoundingClientRect()
    const btns = [...bar.querySelectorAll('.quote-offer-action')]
    return {
      offer: true,
      count: btns.length,
      rows: new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size,
      inside: r.top >= score.top - 1 && r.bottom <= score.bottom + 1,
      hits: btns.every((b) => {
        const q = b.getBoundingClientRect()
        const el = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2)
        return el !== null && b.contains(el)
      }),
    }
  })()`)

/**
 * Selects the first substantial run of text inside an entry and tells the pane.
 *
 * A real `mouseup` on `.score` rather than a call into React: the offer is
 * decided by `readSelection`, and driving anything else would test a path no
 * user takes. Dispatched so it bubbles, since React delegates from the root.
 */
const selectInside = (page, selector) =>
  page.evaluate(`(() => {
    const entry = document.querySelector(${'`'}${'$'}{${JSON.stringify(selector)}}${'`'})
    if (entry === null) return ''
    const walk = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT)
    let node = null
    while (walk.nextNode()) {
      if (walk.currentNode.textContent.trim().length > 8) { node = walk.currentNode; break }
    }
    if (node === null) return ''
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, node.textContent.length)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.querySelector('.score').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return sel.toString()
  })()`)

/** What the offer is showing, in order. */
/**
 * A menu wait that says which state it timed out in.
 *
 * These two specs used to fail as `never became true: a leading slash opened the
 * menu`, which is every possible cause at once — a list still arriving, a list
 * that gave up, a directory git cannot search, or a genuine bug in the menu. The
 * composer now reports which, on `.mention-status[data-lookup]`, and a run that
 * fails is the only chance anyone gets to read it (C-003).
 *
 * **The assertion is unchanged.** This does not accept `asking` as an outcome —
 * it fails exactly as before and adds a word to the message. A spec that passed
 * because a menu said "looking…" would be worse than one that timed out.
 *
 * Its callers wait on `.mention-menu .mention-name` rather than `.mention-menu`,
 * and that is not a tidy-up. The menu now opens to carry the status row, so the
 * old selector would be satisfied by a menu that had found **nothing** — turning
 * the exact failure these specs exist to catch into a pass.
 */
const untilMenu = async (page, expression, options) => {
  try {
    await page.until(expression, options)
  } catch (error) {
    /*
     * Everything the failure could turn on, read at the moment it gives up.
     *
     * The first version of this reported only the menu's own status, which on
     * the first real failure came back `no status row` — nothing in flight and
     * nothing given up. That ruled out waiting and left the composer's own view
     * of what was typed, which nothing here could see. So: what the box holds,
     * where the caret is, what the composer parsed it as, and how many commands
     * it had to offer.
     *
     * `commands: 0` with `mention: /0:` would mean the list never arrived and
     * the re-ask gave up silently. `mention: none` with the box holding `/`
     * would mean the query was never recognised at all — a different bug, and
     * the one the evidence currently points at.
     */
    const at = await page.evaluate(`(() => {
      const form = document.querySelector('.composer')
      const box = document.querySelector('.composer textarea')
      return JSON.stringify({
        lookup: document.querySelector('.mention-status')?.dataset.lookup ?? 'no status row',
        mention: form?.dataset.mention ?? 'no composer',
        commands: form?.dataset.commands ?? '?',
        draftLen: form?.dataset.draftLen ?? '?',
        dismissed: form?.dataset.dismissed ?? '?',
        value: box?.value ?? null,
        caret: box?.selectionStart ?? null,
        focused: document.activeElement === box,
        composers: document.querySelectorAll('.composer').length,
        rows: document.querySelectorAll('.mention-menu .mention-name').length,
      })
    })()`)
    throw new Error(`${error.message} — composer at failure: ${at}`, { cause: error })
  }
}

const offerLabels = (page) =>
  page.evaluate(
    `Array.from(document.querySelectorAll('.quote-offer-action')).map((b) => b.textContent.trim())`
  )

/**
 * Waits until the transcript has stopped moving.
 *
 * A selection is a DOM Range over text nodes, so a re-render that replaces them
 * collapses it and the offer goes with it. `data-status="complete"` means the
 * message is finished, not that the pane has stopped settling — under a loaded
 * machine the tail of a turn is still arriving, which is how a spec that passed
 * alone failed in the suite.
 *
 * Waits for a stable content height rather than for an event, because it is the
 * layout that has to be still, and that is what can be observed from out here.
 *
 * **Says whether it worked, and that is the point** (C-027, one level down).
 * This used to `return` on success and fall out of the loop on timeout — the
 * same `undefined` either way. A caller that had waited fifteen seconds without
 * the pane ever holding still went on to select against a moving transcript and
 * failed somewhere downstream, with the real cause upstream and invisible. Both
 * passage specs depend on this, and both are on C-029's list.
 *
 * The numbers come back with the verdict so a failure carries a record rather
 * than a shrug, which is what turned C-003 from an afternoon into three lines.
 */
const settled = async (page, { timeout = 15_000 } = {}) => {
  const height = () => page.evaluate(`document.querySelector('.score-content').offsetHeight`)
  const started = Date.now()
  const deadline = started + timeout
  let last = await height()
  let samples = 1
  let stable = 0
  const record = (still) => ({
    still,
    height: last,
    samples,
    waited: Date.now() - started,
  })
  while (Date.now() < deadline) {
    await wait(150)
    const now = await height()
    samples += 1
    stable = now === last ? stable + 1 : 0
    last = now
    if (stable >= 3) return record(true)
  }
  return record(false)
}

/** Reads a `settled()` record back as the sentence a spec asserts. */
const stillness = (r) =>
  `the transcript stopped moving (${String(r.height)}px, ${String(r.samples)} samples, ${String(r.waited)}ms)`

export const specs = [
  {
    name: 'opens straight into a session',
    // It once showed a blank window forever: restore never settled and the UI
    // waited on it with nothing drawn.
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        assert(
          (await app.evaluate(`document.querySelectorAll('${PANE}').length`)) === 1,
          'one pane on a first launch'
        )
        assert(
          (await app.evaluate(`!document.querySelector('.empty-inner')`)) === true,
          'no start screen to click through'
        )
        assert(
          (await app.evaluate(`document.activeElement.tagName`)) === 'TEXTAREA',
          'the composer has the caret'
        )
        /*
         * The composer is the floor of the pane.
         *
         * `.pane` used to lay its children out on a three-row grid, which meant
         * the row that stretched was chosen by position rather than by name —
         * so removing the title bar handed the slack to the composer instead of
         * the transcript, and it floated up under the last message with the
         * rest of the pane empty beneath it. The same template did it whenever
         * an error notice appeared, since that is a conditional first child.
         */
        const floor = await app.evaluate(`(() => {
          const pane = document.querySelector('${PANE}').getBoundingClientRect()
          const dock = document.querySelector('.dock').getBoundingClientRect()
          return Math.round(pane.bottom - dock.bottom)
        })()`)
        assert(floor === 0, `the composer sits on the floor of the pane (${floor}px above it)`)
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'reopens the same session, and only one of it',
    // One session became three across restarts: a grace timer was read as
    // "nothing was open" while restore was still running.
    async run(assert) {
      const first = await launch({ keepData: true })
      let dataPath
      let id
      try {
        await started(first)
        dataPath = first.dataPath
        id = await first.evaluate(`document.querySelector('${PANE}').dataset.conversation`)
      } finally {
        await first.stop()
      }

      for (const round of [1, 2]) {
        const again = await launch({ userData: dataPath, keepData: round === 1 })
        try {
          await started(again)
          await wait(1_500)
          assert(
            (await again.evaluate(`document.querySelectorAll('${PANE}').length`)) === 1,
            `still one pane on relaunch ${String(round)}`
          )
          assert(
            (await again.evaluate(`document.querySelector('${PANE}').dataset.conversation`)) === id,
            'the same conversation, not a new one'
          )
        } finally {
          if (round === 1) await again.stop()
          else await again.quit()
        }
      }
    },
  },

  {
    name: 'a message reaches an agent and comes back',
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await app.evaluate(`(() => {
          const ta = document.querySelector('.composer textarea')
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
            .set.call(ta, 'Reply with exactly: PONG')
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          document.querySelector('.composer').requestSubmit()
          return true
        })()`)
        await app.until(
          `Array.from(document.querySelectorAll('.entry')).some(e =>
             /CODEX|CLAUDE/i.test(e.querySelector('.speaker')?.textContent ?? '') &&
             e.innerText.includes('PONG'))`,
          { timeout: 180_000, label: 'an agent answered' }
        )
        assert(true, 'the answer came from an agent, not from the echo of the prompt')
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'shows what the conversation has used',
    // Usage was recorded from the start and shown nowhere.
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        /*
         * The spend answers for a session rather than for a message, so it is
         * neither under the composer nor permanently on a row. It is in the
         * preview, shown on demand — a figure that reads the same all day is one
         * you stop seeing, and a list of six of them is six things not to read.
         *
         * It still has to be reduced separately from the transcript: the
         * transcript belongs to a mounted pane and most sessions do not have one.
         */
        await app.evaluate(`(() => {
          const ta = document.querySelector('.composer textarea')
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
            .set.call(ta, 'Reply with exactly: ok')
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          document.querySelector('.composer').requestSubmit()
          return true
        })()`)
        await app.until(`document.querySelectorAll('.said').length > 0`, {
          timeout: 180_000,
          label: 'the agent answered',
        })
        await app.settle()

        const conversationId = (await tabIds(app))[0]
        await app.evaluate(`(() => {
          document.querySelector('[data-rail-session="${conversationId}"]')
            .dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
          return true
        })()`)
        await app.until(`!!document.querySelector('.session-preview .session-preview-figure')`, {
          timeout: 30_000,
          label: 'the preview learns what the session cost',
        })
        const shown = await app.evaluate(
          `document.querySelector('.session-preview .session-preview-figure').textContent`
        )
        assert(/\d/.test(shown), `spend reads as a number: ${shown}`)

        /*
         * The composer keeps the one control that acts on what is typed in it.
         *
         * Everything else answers for a session, and a session is what the rail
         * lists — so those live in the menu, where they exist for every session
         * rather than only the one on screen.
         */
        const leftInComposer = await app.evaluate(`document.querySelectorAll(
          '.composer-actions .spend, .composer-actions .voice, .composer-actions .path,' +
          ' .composer-actions .profile-chip, .composer-actions .summary-open'
        ).length`)
        assert(
          leftInComposer === 0,
          `and the composer kept none of them, found ${String(leftInComposer)}`
        )

        // Summary and Review are both still reachable, from the one menu.
        await openDrawer(app)
        await app.evaluate(`(() => {
          document.querySelector('[data-session-more="${conversationId}"]').click()
          return true
        })()`)
        await app.until(`!!document.querySelector('.session-menu')`, {
          timeout: 10_000,
          label: 'the session menu opened',
        })
        const outputs = await app.evaluate(
          `[...document.querySelectorAll('.session-menu button')].map((b) => b.textContent)`
        )
        assert(
          outputs.includes('Summary') && outputs.includes('Review changes'),
          `both ways to read it are in the menu, got ${outputs.join(' / ')}`
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'account limits read as limits, if the account has any',
    /*
     * Asserted as a shape, not a value: an API-key account has no plan window
     * and shows nothing, which is correct. What must never happen again is a
     * number that is wrong — a fraction shown as a percentage, or seconds read
     * as milliseconds, which put the reset time in 1970.
     *
     * The figures moved from the masthead to the activity bar, where the detail
     * is behind a hover. Reading `.limit` off the page without opening it would
     * find nothing and take the empty-account branch — passing while checking
     * no number at all.
     */
    /*
     * Skips rather than asserting `true`, and that is C-027.
     *
     * The remaining branch is legitimate — an API-key account genuinely has no
     * plan window to check — but written as `assert(true, …)` it printed a tick,
     * which made "all 30 passed" a claim nobody could check.
     *
     * There used to be two skip sites. The first checked whether the control
     * existed at all, and it cannot fire now: the four slots are always mounted
     * and an unreported one says so, which is the fix this spec was updated for.
     * The second is the real one, and a run reports `30 passed` or
     * `29 passed, 1 skipped`.
     */
    async run(assert, skip) {
      const app = await launch()
      try {
        await started(app)
        await wait(6_000)

        assert(
          (await app.evaluate(`!!document.querySelector('.rail-usage')`)) === true,
          'the account column is mounted whether or not the account has plan windows'
        )

        await app.evaluate(`(() => {
          // React derives enter/leave from delegated pointerover/pointerout, so
          // a synthetic pointerenter never reaches the handler.
          document.querySelector('.rail-usage')
            .dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
          return true
        })()`)
        await app.until(`!!document.querySelector('.usage-tip')`, {
          timeout: 10_000,
          label: 'the usage detail opened',
        })
        const rows = await app.evaluate(`(() =>
          Array.from(document.querySelectorAll('.usage-tip .limit')).map((l) => ({
            agent: l.dataset.agent,
            window: l.dataset.window,
            reported: l.dataset.reported === 'true',
            percent: parseInt(l.querySelector('.limit-percent')?.textContent ?? '', 10),
            reset: l.querySelector('.limit-reset')?.textContent ?? null,
            resetsAt: Number(l.querySelector('.limit-reset')?.dataset.resetsAt ?? 0) || null,
            unreported: l.querySelector('.limit-unreported')?.textContent ?? null,
          })))()`)

        /* The detail keeps the same four rows in the same order as the rail. */
        assert(
          JSON.stringify(rows.map((r) => `${r.agent}:${r.window}`)) ===
            JSON.stringify(['codex:short', 'codex:long', 'claude:short', 'claude:long']),
          `the detail lists the same four windows in the same order, got ${rows
            .map((r) => `${r.agent}:${r.window}`)
            .join(' / ')}`
        )
        assert(
          rows.every((r) => r.reported || (r.unreported !== null && r.percent !== 0)),
          `an unreported window says so rather than reading 0%: ${JSON.stringify(rows)}`
        )

        const windows = rows.filter((r) => r.reported)
        if (windows.length === 0) {
          skip('the panel is there but this account carries no plan window')
        }
        assert(
          windows.every((w) => w.percent >= 0 && w.percent <= 100),
          `every reported percentage in range: ${JSON.stringify(windows)}`
        )
        /*
         * Checked as a moment, not as a phrase.
         *
         * This read `!reset.includes('now')`, and "now" is what `untilReset`
         * says for anything already past — so it fired on a five-hour window
         * whose boundary had simply gone, while the seven-day one beside it
         * formatted perfectly. That is the opposite of the bug being hunted: a
         * seconds-for-milliseconds mistake lands every window in 1970 together,
         * because they come through one mapping.
         *
         * A day's grace, which no clock skew or stale push reaches and 1970
         * misses by fifty-five years.
         */
        const floor = Date.now() - 24 * 60 * 60 * 1000
        assert(
          windows.every((w) => w.resetsAt === null || w.resetsAt > floor),
          `no reset in the distant past, which is what seconds read as milliseconds looks like: ${JSON.stringify(windows.map((w) => w.resetsAt))}`
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'every dot sits on the mark it belongs to',
    /*
     * This spec used to assert that every dot was centred on the vertical rail,
     * which it was — the rail was measured from the scroller and every dot from
     * its entry, and they disagreed by 15px for months.
     *
     * There is no rail now. The approved composition draws none, so a message is
     * an avatar with the dot on its corner and a step is a small mark in the same
     * column. The invariant that replaces "on the line" is "inside the thing it
     * marks": a dot that escapes its avatar is the same class of mistake in the
     * new layout, and it is the only geometry here worth pinning.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await app.until(`document.querySelectorAll('.tick').length > 0`)
        const escaped = await app.evaluate(`(() => {
          return Array.from(document.querySelectorAll('.tick')).map(t => {
            const holder = t.closest('.entry-avatar, .entry-mark')
            if (holder === null) return { orphan: true }
            const h = holder.getBoundingClientRect()
            const r = t.getBoundingClientRect()
            return {
              orphan: false,
              // Half the dot may overhang the disc's edge — that is the corner
              // treatment. Wholly outside it is the failure.
              out: r.left > h.right || r.right < h.left || r.top > h.bottom || r.bottom < h.top,
            }
          })
        })()`)
        assert(escaped.length > 0, `there are dots to check (${String(escaped.length)})`)
        assert(
          escaped.every((d) => !d.orphan),
          'every dot hangs off an avatar or a mark, not off the entry'
        )
        assert(
          escaped.every((d) => !d.out),
          'no dot has escaped the thing it marks'
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'a second session is a tab, and only its own tab',
    /*
     * The invariant the whole shell rests on: one session, at most one tab
     * anywhere. The old grid gave every session a column, so "open it again"
     * and "show it" were the same gesture and nothing could tell them apart.
     * Here the sidenav must focus what is already open rather than making a
     * second view of a session that can only have one composer.
     */
    async run(assert) {
      const app = await launch()
      try {
        const [first, second] = await twoSessions(app)

        assert(
          (await app.evaluate(`document.querySelectorAll('${GROUP}').length`)) === 1,
          'two sessions share one editor group'
        )
        assert(
          (await app.evaluate(`document.querySelectorAll('${PANE}').length`)) === 1,
          'and only the active tab is mounted — the background one costs nothing'
        )
        assert(
          (await app.evaluate(`document.querySelector('${PANE}').dataset.conversation`)) === second,
          'the session just started is the one on screen'
        )

        // Asking for a session that is already open focuses it in place.
        await clickSidebarRow(app, first)
        await app.settle()
        assert((await tabIds(app)).length === 2, 'still two tabs, not three')
        assert(
          (await app.evaluate(`document.querySelector('${PANE}').dataset.conversation`)) === first,
          'the sidenav moved the caret rather than opening a duplicate'
        )

        /*
         * A tab stops shrinking before it stops being a name.
         *
         * The strip has always had `overflow-x: auto`, but tabs shrank to 84px
         * first — so a crowded pane showed a column of identical truncated
         * stubs and the scroll never engaged, because nothing ever overflowed.
         * Squeezed below what two tabs need, they hold 160px and the strip
         * scrolls instead.
         */
        await app.viewport(340, 700)
        // Waited for rather than slept through: emulation, the resize event and
        // the reflow do not land on any fixed schedule, and under a loaded
        // machine a sleep that is usually long enough silently is not.
        await app.until(
          `[...document.querySelectorAll('.workspace-tab')]
             .every(t => Math.round(t.getBoundingClientRect().width) === 160)`,
          { timeout: 15_000, label: 'the strip reflowed to the narrow window' }
        )
        const strip = await app.evaluate(`(() => {
          const tabs = document.querySelector('.workspace-tabs')
          return {
            widths: [...document.querySelectorAll('.workspace-tab')]
              .map(t => Math.round(t.getBoundingClientRect().width)),
            overflows: tabs.scrollWidth > tabs.clientWidth,
          }
        })()`)
        assert(
          strip.widths.every((w) => w === 160),
          `tabs hold their minimum rather than squashing, got ${strip.widths.join(',')}`
        )
        assert(strip.overflows, 'and the strip scrolls instead')
        await app.viewport()
        await wait(300)

        // Closing a view leaves the agent running and the session in the tree.
        await press(app, 'w', { meta: true })
        await app.until(`document.querySelectorAll('${TAB}').length === 1`, {
          label: '⌘W closed the tab',
        })
        const state = await app.evaluate(
          `document.querySelector('[data-rail-session="${first}"]').dataset.placement`
        )
        assert(state === 'offscreen', `the closed session is still listed, got ${state}`)

        await clickSidebarRow(app, first)
        await app.until(`document.querySelectorAll('${TAB}').length === 2`, {
          label: 'the closed session comes back',
        })
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'splitting moves the tab into its own group, and refuses to empty one',
    /*
     * Chorus splits by moving, not by duplicating as VS Code does, so a pane
     * whose active tab is its only tab cannot split itself — the gesture would
     * create a group and empty the old one, which normalisation then removes.
     * That has to be refused outright rather than collapsing into a no-op the
     * user has to interpret.
     */
    async run(assert) {
      const app = await launch()
      try {
        await twoSessions(app)

        await press(app, '\\', { meta: true })
        await app.until(`document.querySelectorAll('${GROUP}').length === 2`, {
          label: 'the split made a second group',
        })
        assert(
          (await app.evaluate(`document.querySelectorAll('${PANE}').length`)) === 2,
          'both sessions are now mounted, one per group'
        )
        assert(
          (await app.evaluate(
            `Array.from(document.querySelectorAll('${GROUP}'))
               .every(g => g.querySelectorAll('${TAB}').length === 1)`
          )) === true,
          'the tab moved rather than being copied — one each, not two and one'
        )
        assert(
          (await app.evaluate(`document.querySelector('.split-branch').dataset.orientation`)) ===
            'row',
          '⌘\\ split sideways'
        )

        // Each group now holds a single tab, so neither may split again.
        await press(app, '\\', { meta: true })
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelectorAll('${GROUP}').length`)) === 2,
          'splitting a one-tab group is refused, not silently collapsed'
        )

        // The sash drags, and the sizes it writes are the ones that render.
        const before = await app.evaluate(
          `getComputedStyle(document.querySelector('.split-child')).flexGrow`
        )
        await app.evaluate(`(() => {
          const sash = document.querySelector('.workspace-sash')
          const box = sash.getBoundingClientRect()
          const x = box.left + box.width / 2
          const y = box.top + box.height / 2
          sash.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1, button: 0, bubbles: true, cancelable: true, clientX: x, clientY: y,
          }))
          document.dispatchEvent(new PointerEvent('pointermove', {
            pointerId: 1, bubbles: true, clientX: x - 120, clientY: y,
          }))
          document.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 1, bubbles: true, clientX: x - 120, clientY: y,
          }))
          return true
        })()`)
        await app.settle()
        const after = await app.evaluate(
          `getComputedStyle(document.querySelector('.split-child')).flexGrow`
        )
        assert(
          Number(after) < Number(before) - 0.01,
          `the sash narrowed the first group (${before} → ${after})`
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'a gesture survives a quit that gives the debounce no time',
    /*
     * Layout is written 180ms after it changes, which is right for a sash
     * moving under the pointer — `setSizes` fires every frame — and wrong for
     * the moment the pointer comes up. Quitting inside that window put the
     * panes back where they were, and the only tell was that your arrangement
     * quietly did not survive lunch.
     *
     * Nothing here waits. The relaunch is the assertion.
     */
    async run(assert) {
      const first = await launch({ keepData: true })
      const dataPath = first.dataPath
      try {
        await twoSessions(first)
        await press(first, '\\', { meta: true })
        await first.until(`document.querySelectorAll('${GROUP}').length === 2`, {
          label: 'the split happened',
        })
        await first.evaluate(`(() => {
          const sash = document.querySelector('.workspace-sash')
          const b = sash.getBoundingClientRect()
          const x = b.left + b.width / 2
          const y = b.top + b.height / 2
          sash.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1, button: 0, bubbles: true, cancelable: true, clientX: x, clientY: y,
          }))
          document.dispatchEvent(new PointerEvent('pointermove', {
            pointerId: 1, bubbles: true, clientX: x - 150, clientY: y,
          }))
          document.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 1, bubbles: true, clientX: x - 150, clientY: y,
          }))
          return true
        })()`)
      } finally {
        // Straight to quit: no settle, no wait, nothing that would let a
        // debounce land on its own.
        await first.stop()
      }

      const again = await launch({ userData: dataPath })
      try {
        await started(again)
        await again.settle()
        const restored = await again.evaluate(`(() => {
          const kids = [...document.querySelectorAll('.split-child')]
          return {
            groups: document.querySelectorAll('${GROUP}').length,
            sizes: kids.map(c => Number(getComputedStyle(c).flexGrow)),
          }
        })()`)
        assert(restored.groups === 2, `the split came back, got ${String(restored.groups)} groups`)
        assert(
          restored.sizes.length === 2 && Math.abs(restored.sizes[0] - 0.5) > 0.05,
          `and the sash where it was left, not at the default (${restored.sizes.join(',')})`
        )
      } finally {
        await again.quit()
      }
    },
  },

  {
    name: 'a backgrounded session keeps its transcript and its unsent draft',
    /*
     * Unmounting a background tab is what makes the shell affordable, and it is
     * the one change that can lose work: the transcript comes back from the
     * event store, but a half-typed message exists nowhere but the component
     * being torn down. If the carry map is wrong this is data loss rather than
     * a glitch, which is why it is asserted end to end rather than in a unit.
     */
    async run(assert) {
      const app = await launch()
      try {
        const [first, second] = await twoSessions(app)

        await clickTab(app, first)
        await app.until(`document.querySelector('${PANE}')?.dataset.conversation === '${first}'`)
        await say(app, 'Reply with exactly: KEPT')
        /*
         * An *agent* entry, not any entry: the prompt says "KEPT" too, so
         * matching `.entry` alone resolves the moment the user's own message
         * renders. The count taken then is of a turn still in flight, and the
         * reply lands while the tabs are being switched — which reads at the
         * end as a transcript that came back the wrong size.
         */
        await app.until(
          `Array.from(document.querySelectorAll('.entry--codex, .entry--claude'))
             .some(e => e.innerText.includes('KEPT'))`,
          { timeout: 180_000, label: 'an agent answered' }
        )
        // And idle, so no thinking row is still to resolve underneath it.
        await app.until(`!document.querySelector('.send--stop')`, {
          timeout: 180_000,
          label: 'the turn finished',
        })
        await app.settle()
        const entries = await app.evaluate(`document.querySelectorAll('.entry').length`)
        await draft(app, 'half a thought')

        // Away, which unmounts it outright rather than hiding it.
        await clickTab(app, second)
        await app.until(`document.querySelector('${PANE}')?.dataset.conversation === '${second}'`)
        assert(
          (await app.evaluate(
            `!document.querySelector('${PANE}[data-conversation="${first}"]')`
          )) === true,
          'the background session left the DOM entirely'
        )

        await clickTab(app, first)
        await app.until(`document.querySelector('${PANE}')?.dataset.conversation === '${first}'`)
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelector('.composer textarea').value`)) ===
            'half a thought',
          'the unsent draft survived the unmount'
        )
        const back = await app.evaluate(`document.querySelectorAll('.entry').length`)
        assert(
          back === entries,
          `and the transcript came back whole, not truncated (${entries} → ${back})`
        )
        // The `afterSeq` restore asks only for what it missed, so a replay that
        // started from zero would show the answer twice rather than not at all.
        const kept = await app.evaluate(
          `Array.from(document.querySelectorAll('.entry--codex, .entry--claude'))
             .filter(e => e.innerText.includes('KEPT')).length`
        )
        assert(kept === 1, `and not doubled by the incremental restore (${kept} copies)`)
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'the collapsed rail runs the day on its own',
    /*
     * The 60px rail is the primary state, so everything the daily loop needs has
     * to survive the drawer being shut: reaching any session in a stable place,
     * starting one, opening a terminal, reading both accounts, and settings.
     *
     * This is the spec that replaced "a sidenav row shows its path, profile, two
     * agent switches, Plan, Summary, Review, Restart and End". That one asserted
     * the density on purpose; the density was the problem.
     */
    async run(assert) {
      const app = await launch()
      try {
        const [first, second] = await twoSessions(app)

        const rail = await app.evaluate(`(() => {
          const rail = document.querySelector('.quick-rail')
          const shortcuts = [...rail.querySelectorAll('[data-rail-session]')]
          const box = (el) => el.getBoundingClientRect()
          return {
            width: Math.round(box(rail).width),
            drawerHidden: document.querySelector('.session-drawer').dataset.hidden,
            editorLeft: Math.round(box(document.querySelector('.workspace-editor')).left),
            shortcuts: shortcuts.length,
            monograms: shortcuts.map((s) => s.querySelector('.rail-session-monogram').textContent),
            names: shortcuts.map((s) => s.getAttribute('aria-label')),
            marks: shortcuts.map((s) => s.querySelector('.state-mark')?.dataset.state ?? null),
            /* One tab stop for the group, not one per session. */
            tabStops: shortcuts.filter((s) => s.tabIndex === 0).length,
            sizes: shortcuts.map((s) => Math.round(box(s).height)),
            drawerToggle: !!rail.querySelector('[data-rail-drawer]'),
            newSession: !!rail.querySelector('[data-rail-new]'),
            terminal: !!rail.querySelector('[data-rail-terminal]'),
            settings: !!rail.querySelector('[data-rail-settings]'),
            /* No More, no grip, no destructive control at this width. */
            menus: rail.querySelectorAll('[data-session-more]').length,
            /*
             * Four readings, always, in one order — Codex 5-hour, Codex weekly,
             * Claude 5-hour, Claude weekly. Asserting only that a usage control
             * "may exist" is what let the old version through: it derived its
             * rows from the pushes that had arrived and sorted the agent ids, so
             * a fresh window showed nothing, then two, then four with Claude
             * above Codex.
             */
            usage: !!rail.querySelector('[data-rail-usage]'),
            slots: [...rail.querySelectorAll('.rail-window')].map((w) => ({
              agent: w.dataset.agent,
              window: w.dataset.window,
              reported: w.dataset.reported,
              text: w.querySelector('.rail-window-percent').textContent,
            })),
            /*
             * The shape the reference composition is drawn in, and the shape the
             * first implementation was rejected for not being. Every number here
             * is a geometry a screenshot would show and a behaviour test would
             * not: an unbordered mark reads as texture, a 40px header row eats a
             * transcript, and a provider name set on its side cannot be read.
             */
            masthead: (() => {
              const bar = document.querySelector('.masthead')
              if (bar === null) return null
              const r = bar.getBoundingClientRect()
              return {
                height: Math.round(r.height),
                top: Math.round(r.top),
                wordmark: !!bar.querySelector('.wordmark-logo'),
                version: bar.querySelector('[data-app-version]')?.textContent ?? null,
                /* Quiet: a name and a build, and nothing to press. */
                buttons: bar.querySelectorAll('button, a, input').length,
              }
            })(),
            /* Bordered tiles, not marks floating on the chrome. */
            tiles: shortcuts.map((s) => {
              const style = getComputedStyle(s)
              return {
                size: [Math.round(box(s).width), Math.round(box(s).height)],
                border: Math.round(Number.parseFloat(style.borderTopWidth)),
                radius: Math.round(Number.parseFloat(style.borderTopLeftRadius)),
                gutter: Math.round(box(s).left - box(rail).left),
              }
            }),
            /* The account blocks read across, so nothing in them is rotated. */
            accountUpright: [...rail.querySelectorAll('.rail-account-name')].every(
              (n) => getComputedStyle(n).writingMode === 'horizontal-tb'
            ),
            meters: rail.querySelectorAll('.rail-meter').length,
          }
        })()`)

        /* 64 now: a 44px tile needs a 10px gutter either side to read as a card. */
        assert(rail.width === 64, `the rail is 64px, got ${String(rail.width)}`)
        assert(
          rail.drawerHidden === 'true' && rail.editorLeft === 64,
          `and it starts collapsed with the editor against it (${String(rail.editorLeft)})`
        )
        assert(rail.shortcuts === 2, `every session has a shortcut, got ${String(rail.shortcuts)}`)
        assert(
          rail.sizes.every((h) => h >= 44),
          `each is at least 44px tall, got ${rail.sizes.join(',')}`
        )
        assert(rail.tabStops === 1, `one roving tab stop, got ${String(rail.tabStops)}`)
        assert(
          rail.marks.every((m) => m !== null),
          `each carries a state mark, got ${rail.marks.join(',')}`
        )
        /*
         * The monogram is two letters and two sessions in one folder produce the
         * same two. The suffix is what distinguishes them without using colour,
         * and the accessible name is the whole title regardless.
         */
        assert(
          new Set(rail.monograms).size === rail.monograms.length,
          `duplicate titles still get distinct marks, got ${rail.monograms.join(',')}`
        )
        assert(
          rail.names.every((n) => typeof n === 'string' && n.length > 0),
          `and each says what it is in words: ${rail.names.join(' / ')}`
        )
        assert(
          rail.drawerToggle && rail.newSession && rail.terminal && rail.settings,
          'the drawer toggle, new session, terminal and settings all survive the collapse'
        )
        assert(rail.menus === 0, 'and nothing destructive or overflowing sits in the rail')

        /*
         * The account column, whatever the machine's accounts happen to be. This
         * runs on a build machine that may have no plan window at all, which is
         * exactly the case the old code hid the whole control for.
         */
        assert(rail.usage, 'the account column is there before anything has been pushed')
        assert(
          rail.slots.length === 4,
          `four readings, got ${String(rail.slots.length)}: ${JSON.stringify(rail.slots)}`
        )
        assert(
          JSON.stringify(rail.slots.map((s) => `${s.agent}:${s.window}`)) ===
            JSON.stringify(['codex:short', 'codex:long', 'claude:short', 'claude:long']),
          `in the locked order, got ${rail.slots.map((s) => `${s.agent}:${s.window}`).join(' / ')}`
        )
        /*
         * And an empty slot says nothing rather than zero. `0%` claims the
         * account is empty, which is the opposite of "nobody has answered".
         */
        assert(
          rail.slots.every((s) => (s.reported === 'true' ? /^\d+%$/.test(s.text) : s.text === '—')),
          `an unreported window reads as an em dash and never as 0%: ${JSON.stringify(rail.slots)}`
        )

        /*
         * The composition, as geometry. These are the readings the first
         * implementation was rejected on, so each is asserted as a number rather
         * than left to a screenshot nobody diffs.
         */
        assert(
          rail.masthead !== null && rail.masthead.top === 0,
          'the compact header is the first row in the window'
        )
        assert(
          rail.masthead.height >= 30 && rail.masthead.height <= 32,
          `and it is 30–32px, got ${String(rail.masthead.height)}`
        )
        assert(
          rail.masthead.wordmark && rail.masthead.version !== null,
          `carrying the wordmark and the real version, got ${String(rail.masthead.version)}`
        )
        assert(
          rail.masthead.buttons === 0,
          `and nothing else — no actions, no widgets (${String(rail.masthead.buttons)} controls)`
        )
        assert(
          rail.width >= 60 && rail.width <= 64,
          `the rail is 60–64px, got ${String(rail.width)}`
        )
        assert(
          rail.tiles.every((t) => t.size[0] === 44 && t.size[1] === 44),
          `every shortcut is 44×44, got ${JSON.stringify(rail.tiles.map((t) => t.size))}`
        )
        assert(
          rail.tiles.every((t) => t.border >= 1 && t.radius >= 6 && t.radius <= 8),
          `each with a 1px boundary and a 6–8px radius, got ${JSON.stringify(rail.tiles.map((t) => [t.border, t.radius]))}`
        )
        assert(
          rail.tiles.every((t) => t.gutter >= 8 && t.gutter <= 10),
          `and an 8–10px gutter, got ${JSON.stringify(rail.tiles.map((t) => t.gutter))}`
        )
        assert(
          rail.accountUpright,
          'the provider names are set horizontally rather than on their side'
        )
        assert(rail.meters === 2, `one progress bar per provider, got ${String(rail.meters)}`)

        // Clicking a shortcut opens or focuses that session.
        await app.evaluate(`(() => {
          document.querySelector('[data-rail-session="${second}"]').click()
          return true
        })()`)
        await app.settle()
        assert(
          (await app.evaluate(
            `document.querySelector('[data-rail-session="${second}"]').getAttribute('aria-current')`
          )) === 'true',
          'clicking a shortcut makes that session the active one'
        )

        /*
         * Arrow keys move within the group and Home/End reach its ends, which is
         * what one roving tab stop buys: the settings gear stays two presses
         * away rather than twenty-two.
         */
        await app.evaluate(`(() => {
          const first = document.querySelector('[data-rail-session="${first}"]')
          first.focus()
          first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
          return true
        })()`)
        await app.settle()
        assert(
          (await app.evaluate(`document.activeElement?.dataset.railSession`)) === second,
          'ArrowDown moves to the next shortcut'
        )

        // Twenty sessions scroll the middle and leave the fixed groups alone.
        const footTop = () =>
          app.evaluate(
            `Math.round(document.querySelector('.quick-rail-group--foot').getBoundingClientRect().top)`
          )
        const restingFoot = await footTop()
        await app.evaluate(`(() => {
          const scroller = document.querySelector('[data-rail-scroll]')
          scroller.scrollTop = scroller.scrollHeight
          return true
        })()`)
        await app.settle()
        assert(
          (await footTop()) === restingFoot,
          'scrolling the shortcut list does not move the foot group'
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'a session is one row, one preview and one menu',
    /*
     * The drawer row has a single primary target and a single overflow. Every
     * fact that used to be a permanent control on the card is now either in the
     * read-only preview or in the menu, and the preview is *read-only* on
     * purpose — a surface that closes when the pointer crosses a 6px gap is the
     * wrong home for "End session".
     */
    async run(assert) {
      const app = await launch()
      try {
        const [first] = await twoSessions(app)
        await openDrawer(app)

        const row = await app.evaluate(`(() => {
          const row = document.querySelector('[data-sidebar-conversation="${first}"]')
          const main = row.querySelector('.session-row-main')
          return {
            height: Math.round(row.getBoundingClientRect().height),
            primaryTargets: row.querySelectorAll('.session-row-main').length,
            overflow: row.querySelectorAll('[data-session-more]').length,
            nestedButtons: main.querySelectorAll('button').length,
            name: main.getAttribute('aria-label'),
            /* Nothing that configures or ends a session lives on the row. */
            leftovers: row.querySelectorAll(
              '.path, .profile-chip, .voice, [aria-label*="End"], [aria-label*="Restart"]'
            ).length,
            moreReachable: row.querySelector('[data-session-more]').tabIndex !== -1,
            titleSize: getComputedStyle(row.querySelector('.session-row-title')).fontSize,
          }
        })()`)
        assert(row.height === 44, `a row is 44px, got ${String(row.height)}`)
        assert(row.primaryTargets === 1, 'with exactly one primary target')
        assert(row.overflow === 1, 'and exactly one overflow action')
        assert(row.nestedButtons === 0, 'and no button nested inside another')
        assert(row.leftovers === 0, 'no folder, profile, cast switch, restart or end on the row')
        assert(row.moreReachable, 'the overflow is keyboard reachable rather than hover-only')
        assert(row.titleSize === '13px', `the title is 13px, got ${row.titleSize}`)

        /*
         * The preview opens from hover *and* from keyboard focus, survives the
         * pointer travelling into it, and closes on Escape. WCAG 2.2 asks for
         * all three of hoverable, dismissible and persistent.
         */
        const listGeometry = () =>
          app.evaluate(`(() => {
            const rows = [...document.querySelectorAll('.session-rows .session-row')]
            return rows.map((r) => Math.round(r.getBoundingClientRect().top))
          })()`)
        const beforePreview = await listGeometry()

        await app.evaluate(`(() => {
          // React derives enter/leave from delegated pointerover, so a synthetic
          // pointerenter never reaches the handler.
          document.querySelector('[data-sidebar-conversation="${first}"] .session-row-main')
            .dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
          return true
        })()`)
        await app.until(`!!document.querySelector('.session-preview')`, {
          timeout: 10_000,
          label: 'the preview opened on hover',
        })
        const preview = await app.evaluate(`(() => {
          const card = document.querySelector('.session-preview')
          const box = card.getBoundingClientRect()
          return {
            portalled: !document.querySelector('.session-drawer').contains(card),
            fitsWindow:
              box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
            facts: [...card.querySelectorAll('dt')].map((d) => d.textContent),
            hasPath: !!card.querySelector('.session-preview-path'),
            /* Read-only: nothing in it can be pressed. */
            controls: card.querySelectorAll('button, input, select, a').length,
          }
        })()`)
        assert(preview.portalled, 'the preview is portalled clear of the drawer')
        assert(preview.fitsWindow, 'and placed inside the window')
        assert(preview.hasPath, 'it names the project path the row no longer shows')
        assert(
          preview.facts.length >= 3,
          `and the facts that left the card: ${preview.facts.join(', ')}`
        )
        assert(preview.controls === 0, 'and it is read-only — every action is in the menu')
        assert(
          JSON.stringify(await listGeometry()) === JSON.stringify(beforePreview),
          'opening it does not reflow the list'
        )

        await app.evaluate(`(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          return true
        })()`)
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelectorAll('.session-preview').length`)) === 0,
          'Escape dismisses it'
        )

        /*
         * And the same card from keyboard focus alone.
         *
         * Blurred first, because `focus()` on the element that already has it
         * fires no event — and whether it already has it depends on what the
         * step before happened to leave focused, which is not what this is
         * asserting. A person arriving by Tab always generates the event.
         *
         * Frontmost first, for a larger version of the same problem. In a window
         * Chromium does not consider focused, `focus()` fires *no* event however
         * this is sequenced, and `setTimeout` is throttled past the preview's
         * 200ms dwell — so this step failed two runs in three on a machine where
         * another window happened to be in front, and reported it as "never
         * became true". That is the driver, not the app: the same path was
         * driven by hand and works.
         */
        assert(await app.bringToFront(), 'the window can be brought to the front to drive focus')
        await app.evaluate(`(() => {
          document.activeElement?.blur()
          document.querySelector('[data-sidebar-conversation="${first}"] .session-row-main').focus()
          return true
        })()`)
        await app.until(`!!document.querySelector('.session-preview')`, {
          timeout: 10_000,
          label: 'the preview opened from focus',
        })
        assert(true, 'focus opens the same preview as hover')
        await app.evaluate(`(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          return true
        })()`)

        /*
         * The menu is the durable route, and End is at the bottom behind a
         * divider rather than an icon beside the thing that opens the session.
         */
        await app.evaluate(`(() => {
          document.querySelector('[data-session-more="${first}"]').click()
          return true
        })()`)
        await app.until(`!!document.querySelector('.session-menu')`, {
          timeout: 10_000,
          label: 'the menu opened',
        })
        const menu = await app.evaluate(`(() => {
          const menu = document.querySelector('.session-menu')
          const items = [...menu.querySelectorAll('button')]
          const box = menu.getBoundingClientRect()
          const danger = menu.querySelector('.session-menu-danger')
          const ordinary = items.find((b) => b.textContent === 'Rename')
          return {
            portalled: !document.querySelector('.session-drawer').contains(menu),
            fitsWindow:
              box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
            labels: items.map((b) => b.textContent),
            endIsLast: items.at(-1) === danger,
            separators: menu.querySelectorAll('.session-menu-separator').length,
            role: menu.getAttribute('role'),
            /*
             * The colour the app actually paints, not the one the sheet asks
             * for. \`.session-menu button\` is a class and a type and
             * \`.session-menu-danger\` was one class, so End resolved to
             * --text-primary and read exactly like Rename. Compared against the
             * token and against a neighbouring item, because a hard-coded hex
             * here would only re-assert whatever the theme happens to be.
             */
            endColour: getComputedStyle(danger).color,
            ordinaryColour: getComputedStyle(ordinary).color,
            dangerToken: getComputedStyle(document.documentElement)
              .getPropertyValue('--danger').trim(),
          }
        })()`)
        assert(menu.portalled && menu.fitsWindow, 'the menu is portalled and inside the window')
        assert(menu.role === 'menu', 'and says what it is')
        assert(menu.endIsLast, 'End is the last thing in it')
        assert(menu.separators >= 1, 'behind a divider')
        assert(
          menu.endColour !== menu.ordinaryColour,
          `End does not read like Rename (End ${menu.endColour}, Rename ${menu.ordinaryColour})`
        )
        assert(
          menu.endColour === hexToRgb(menu.dangerToken),
          `End is painted in --danger (${menu.dangerToken} → ${hexToRgb(menu.dangerToken)}), got ${menu.endColour}`
        )
        for (const wanted of [
          'Rename',
          'Session settings',
          'Move Up',
          'Move Down',
          'Open in Pane',
        ]) {
          assert(
            menu.labels.some((label) => label === wanted),
            `the menu offers ${wanted}, got ${menu.labels.join(' / ')}`
          )
        }

        // Escape closes it and gives focus back to the control that opened it.
        await app.evaluate(`(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          return true
        })()`)
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelectorAll('.session-menu').length`)) === 0,
          'Escape closes the menu'
        )
        assert(
          (await app.evaluate(`document.activeElement?.dataset.sessionMore ?? null`)) === first,
          'and focus returns to the button that opened it'
        )

        /*
         * Double-click still renames in place.
         *
         * The plan keeps the fast path as well as the menu command, and the two
         * gestures live on the same element: the row is a button that opens a
         * session on click, so a rename that did not *replace* the button would
         * have the button eating the caret.
         */
        await app.evaluate(`(() => {
          document.querySelector('[data-sidebar-conversation="${first}"] .session-row-main')
            .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          return true
        })()`)
        await app.until(`!!document.querySelector('.session-row-rename')`, {
          timeout: 10_000,
          label: 'the rename field opened',
        })
        assert(
          (await app.evaluate(
            `document.querySelector('[data-sidebar-conversation="${first}"] .session-row-main') === null`
          )) === true,
          'the field replaces the button rather than nesting inside it'
        )
        await app.evaluate(`(() => {
          const field = document.querySelector('.session-row-rename')
          field.value = 'renamed-inline'
          field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          return true
        })()`)
        await app.until(
          `document.querySelector('[data-sidebar-conversation="${first}"]')
             ?.innerText.includes('renamed-inline')`,
          { label: 'the new name reached the row' }
        )

        /*
         * Search filters and never reorders, and Arrange refuses to run while it
         * is live — a gap index between two *visible* rows does not describe a
         * position in the real list, and committing one would shuffle rows the
         * user cannot see.
         */
        await app.evaluate(`(() => {
          const input = document.querySelector('.session-drawer input[type="search"]')
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
            .set.call(input, 'renamed-inline')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
        await app.until(`document.querySelectorAll('.session-drawer .session-row').length === 1`, {
          timeout: 10_000,
          label: 'the search filtered the list',
        })
        assert(
          (await app.evaluate(`document.querySelector('[data-arrange-toggle]').disabled`)) === true,
          'Arrange is refused while a search is filtering the list'
        )
        await app.evaluate(`(() => {
          const input = document.querySelector('.session-drawer input[type="search"]')
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
            .set.call(input, '')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
        await app.until(`document.querySelectorAll('.session-drawer .session-row').length === 2`, {
          timeout: 10_000,
          label: 'clearing the search brought the list back',
        })

        // Session settings mounts for the selected session only.
        await app.evaluate(`(() => {
          document.querySelector('[data-session-more="${first}"]').click()
          return true
        })()`)
        await app.until(`!!document.querySelector('.session-menu')`, { timeout: 10_000 })
        await app.evaluate(`(() => {
          const open = [...document.querySelectorAll('.session-menu button')]
            .find((b) => b.textContent === 'Session settings')
          open.click()
          return true
        })()`)
        await app.until(`!!document.querySelector('.session-settings')`, {
          timeout: 10_000,
          label: 'session settings opened',
        })
        const settings = await app.evaluate(`(() => ({
          panels: document.querySelectorAll('.session-settings').length,
          agents: document.querySelectorAll('.session-settings-agents .voice').length,
          path: !!document.querySelector('.session-settings-path'),
          profiles: document.querySelectorAll('.session-settings-profiles .profile-option').length,
          plan: !!document.querySelector('.session-settings-plan'),
        }))()`)
        assert(settings.panels === 1, 'one settings panel, not one per session')
        assert(settings.agents === 2, 'it carries the cast')
        assert(settings.path, 'the folder')
        assert(settings.profiles >= 2, 'the profiles')
        assert(settings.plan, 'and Plan mode')
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'a rail drag places a session, and only Arrange reorders',
    /*
     * The same source, two deliberately different destinations. Outside Arrange
     * a drag reaches the workspace through the existing tab-drag target
     * language — insert, move, and four edge splits — and cannot change the
     * list's order. Inside Arrange it reorders and cannot reach the workspace.
     *
     * The old behaviour was that any pointer movement over any part of a card
     * reordered the list, which is why "drag a session into a pane" did not
     * exist at all.
     */
    async run(assert) {
      const app = await launch()
      try {
        const ids = await twoSessions(app)
        const [first, second] = ids
        const order = () =>
          app.evaluate(
            `[...document.querySelectorAll('.quick-rail [data-rail-session]')]
               .map((s) => s.dataset.railSession)`
          )
        const before = await order()

        /*
         * A drag from the rail to a pane's right edge splits.
         *
         * Started on the element, finished on the document: the drag's document
         * listeners are attached by an effect, so React has to have rendered in
         * between. A test that dispatched all four events in one tick would find
         * the pointerup landing before anything was listening for it — and would
         * pass as "no split", which is the wrong answer for the right reason.
         */
        const dragTo = async (railId, point) => {
          await app.evaluate(`(() => {
            const s = document.querySelector('[data-rail-session="${railId}"]')
            const from = s.getBoundingClientRect()
            const content = document.querySelector('[data-pane-content]').getBoundingClientRect()
            const to = ${point}
            window.__drop = to
            s.dispatchEvent(new PointerEvent('pointerdown', {
              pointerId: 9, button: 0, isPrimary: true, bubbles: true, cancelable: true,
              clientX: Math.round(from.left + from.width / 2),
              clientY: Math.round(from.top + from.height / 2),
            }))
            s.dispatchEvent(new PointerEvent('pointermove', {
              pointerId: 9, bubbles: true, clientX: to.x, clientY: to.y,
            }))
            return true
          })()`)
          await app.settle()
          const feedback = await app.evaluate(`(() => {
            const overlay = document.querySelector('.workspace-drop-overlay')
            const ghost = document.querySelector('.workspace-drag-ghost')
            const content = document.querySelector('[data-pane-content]').getBoundingClientRect()
            return {
              ghost: document.querySelectorAll('.workspace-drag-ghost').length,
              overlay: overlay?.textContent ?? null,
              disabled: overlay?.dataset.disabled ?? null,
              /*
               * The painted target is a strip on the edge, not the half-pane the
               * drop will make. A translucent slab over half a transcript reads
               * as a selection; a strip reads as the seam a pane opens along —
               * which is what the approved composition draws.
               */
              strip:
                overlay === null
                  ? null
                  : {
                      width: Math.round(overlay.getBoundingClientRect().width),
                      paneWidth: Math.round(content.width),
                      dashed: getComputedStyle(overlay).borderLeftStyle,
                    },
              /* And what is being carried is drawn as what it is. */
              shape: ghost?.dataset.shape ?? null,
              inWindow:
                ghost === null
                  ? null
                  : Math.round(ghost.getBoundingClientRect().right) <= window.innerWidth,
            }
          })()`)
          await app.evaluate(`(() => {
            const to = window.__drop
            document.dispatchEvent(new PointerEvent('pointermove', {
              pointerId: 9, bubbles: true, clientX: to.x, clientY: to.y,
            }))
            document.dispatchEvent(new PointerEvent('pointerup', {
              pointerId: 9, bubbles: true, clientX: to.x, clientY: to.y,
            }))
            return true
          })()`)
          await app.settle()
          return feedback
        }

        const split = await dragTo(
          second,
          `{ x: Math.round(content.right - 20), y: Math.round(content.top + content.height / 2) }`
        )
        assert(split.ghost === 1, 'the drag shows a ghost that follows the pointer')
        assert(
          split.overlay !== null && /split/i.test(split.overlay),
          `and names the target it is over, got ${String(split.overlay)}`
        )
        /*
         * Inverted on 2026-08-14, and the old assertion is worth recording.
         *
         * It read `width <= 56 && width < paneWidth / 3` — "painted as an edge
         * strip, not half the pane" — which held the composition accepted in
         * STATUS §8. The user then asked for the opposite: a target that covers
         * the area the new pane will actually occupy. `target.rect` always was
         * that area, so only the paint changed.
         *
         * The bounds are a *range* rather than `=== paneWidth / 2`, because the
         * rect comes from a live layout with a sash and a border in it. Too loose
         * and it passes on the old strip; 40% of the pane is comfortably above
         * the 52px the strip drew at any window this suite runs at.
         */
        assert(
          split.strip.width > split.strip.paneWidth * 0.4 &&
            split.strip.width <= split.strip.paneWidth * 0.6,
          `the target covers the half it will become, not an edge strip (${String(split.strip.width)} of ${String(split.strip.paneWidth)})`
        )
        assert(
          split.strip.dashed === 'dashed',
          `with the seam dashed along the edge the split opens on, got ${String(split.strip.dashed)}`
        )
        assert(
          split.shape === 'tile' && split.inWindow === true,
          `and a session tile carried inside the window (${String(split.shape)}, in window: ${String(split.inWindow)})`
        )
        assert(
          (await app.evaluate(`document.querySelectorAll('${GROUP}').length`)) === 2,
          'dropping on an edge splits the workspace'
        )
        assert(
          (await app.evaluate(
            `new Set([...document.querySelectorAll('${TAB}')].map((t) => t.dataset.workspaceTab)).size`
          )) === 2,
          'and the session moved rather than being duplicated'
        )
        assert(
          JSON.stringify(await order()) === JSON.stringify(before),
          'and the list order is untouched — a workspace drop is not a reorder'
        )

        // A closed session can be dropped into a pane and opens there.
        await press(app, 'w', { meta: true })
        await app.until(`document.querySelectorAll('${TAB}').length === 1`, {
          label: 'one session closed',
        })
        const closed = (await tabIds(app))[0] === first ? second : first
        await dragTo(
          closed,
          `{ x: Math.round(content.left + content.width / 2), y: Math.round(content.top + content.height / 2) }`
        )
        assert(
          (await app.evaluate(
            `new Set([...document.querySelectorAll('${TAB}')].map((t) => t.dataset.workspaceTab)).size`
          )) === 2,
          'a closed session dropped into a pane opens there, exactly once'
        )

        /*
         * Arrange is the only state in which the list reorders, and it exposes a
         * grip and Move Up/Move Down so dragging is never the only way.
         */
        await openDrawer(app)
        await app.evaluate(`(() => {
          document.querySelector('[data-arrange-toggle]').click()
          return true
        })()`)
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelectorAll('[data-arrange-grip]').length`)) === 2,
          'Arrange gives every row a grip'
        )

        const listOrder = () =>
          app.evaluate(
            `[...document.querySelectorAll('.session-drawer [data-sidebar-conversation]')]
               .map((r) => r.dataset.sidebarConversation)`
          )
        const listBefore = await listOrder()
        await app.evaluate(`(() => {
          const rows = document.querySelectorAll('.session-drawer .session-row')
          const from = rows[0].getBoundingClientRect()
          const to = rows[1].getBoundingClientRect()
          const x = from.left + from.width / 2
          const grip = rows[0].querySelector('[data-arrange-grip]')
          grip.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 3, button: 0, bubbles: true, cancelable: true,
            clientX: x, clientY: from.top + from.height / 2,
          }))
          document.dispatchEvent(new PointerEvent('pointermove', {
            pointerId: 3, bubbles: true, clientX: x, clientY: to.bottom + 4,
          }))
          document.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 3, bubbles: true, clientX: x, clientY: to.bottom + 4,
          }))
          return true
        })()`)
        await app.settle()
        const listAfter = await listOrder()
        assert(
          listAfter[0] === listBefore[1] && listAfter[1] === listBefore[0],
          `an Arrange drag reorders the list, got ${listAfter.join(',')}`
        )

        // Escape leaves the mode.
        await app.evaluate(`(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          return true
        })()`)
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelectorAll('[data-arrange-grip]').length`)) === 0,
          'Escape leaves Arrange'
        )

        // And the non-drag alternative puts it back.
        await app.evaluate(`(() => {
          document.querySelector('[data-session-more="${listAfter[1]}"]').click()
          return true
        })()`)
        await app.until(`!!document.querySelector('.session-menu')`, { timeout: 10_000 })
        await app.evaluate(`(() => {
          const up = [...document.querySelectorAll('.session-menu button')]
            .find((b) => b.textContent === 'Move Up')
          up.click()
          return true
        })()`)
        await app.settle()
        assert(
          JSON.stringify(await listOrder()) === JSON.stringify(listBefore),
          'Move Up does by menu what the drag does by pointer'
        )
        assert(
          (
            await app.evaluate(
              `document.querySelector('.session-drawer [role="status"]')?.textContent ?? ''`
            )
          ).length > 0,
          'and says so, for anything that cannot see the list move'
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'a terminal belongs to one session, and the global one is a different thing',
    /*
     * The requirement was a terminal for *one session*, not a terminal for the
     * workspace, and the two are separate panels with separate shells: `⌘J`
     * opens the focused pane's, `⌘⇧J` opens the one that belongs to nobody.
     *
     * Everything here is a claim the plan makes about the composite review state
     * and nothing else checked: that the session panel mounts inside its own
     * pane between that session's transcript and its composer, that it stops at
     * the pane divider so a split neighbour keeps its full height, that the
     * global panel opens and closes without touching it, and that the owning
     * composer still shows which VS Code selection will be sent with a message.
     *
     * The last of those is why the fake IDE is here: collapsing the drawer must
     * not be able to take the path with it, and a terminal appearing between the
     * transcript and the composer must not either.
     */
    async run(assert) {
      const before = existingDescriptors()
      const app = await launch()
      let ide = null
      try {
        const [first] = await twoSessions(app)

        // A project for the owning session, so it has a root to follow.
        const project = mkdtempSync(join(tmpdir(), 'chorus-e2e-term-'))
        mkdirSync(join(project, 'src'), { recursive: true })
        writeFileSync(join(project, 'src/a.ts'), 'const a = 1\n')
        await app.evaluate(
          `window.chorus.setProjectDirectory({ conversationId: ${JSON.stringify(first)}, cwd: ${JSON.stringify(project)} }).then(() => true)`
        )

        // Two panes, one session each.
        await press(app, '\\', { meta: true })
        await app.until(`document.querySelectorAll('${GROUP}').length === 2`, {
          label: 'the split made a second group',
        })

        /* Focus the pane that holds `first`, which is what ⌘J resolves against. */
        await clickTab(app, first)
        await app.settle()
        assert(
          (await app.evaluate(`(() => {
            const pane = document.querySelector('${GROUP}[data-focused="true"]')
            return pane?.querySelector('${PANE}')?.dataset.conversation ?? null
          })()`)) === first,
          'the pane holding the first session has the focus'
        )

        const geometry = () =>
          app.evaluate(`(() => {
            const groups = [...document.querySelectorAll('${GROUP}')]
            const box = (el) => {
              const r = el?.getBoundingClientRect()
              return r === undefined ? null : {
                top: Math.round(r.top), bottom: Math.round(r.bottom),
                height: Math.round(r.height),
              }
            }
            return {
              session: document.querySelectorAll('.terminal-panel--session').length,
              global: document.querySelectorAll('.terminal-panel--global').length,
              panes: groups.map((group) => {
                const tab = group.querySelector('[data-workspace-tab]')?.parentElement
                const tabStyle = tab === undefined || tab === null ? null : getComputedStyle(tab)
                const bodyStyle = getComputedStyle(group.querySelector('[data-pane-content]'))
                return {
                  conversationId: group.querySelector('${PANE}')?.dataset.conversation ?? null,
                  terminals: group.querySelectorAll('.terminal-panel').length,
                  pane: box(group.querySelector('${PANE}')),
                  transcript: box(group.querySelector('.score')),
                  terminal: box(group.querySelector('.terminal-panel')),
                  terminalHead: box(group.querySelector('.terminal-head')),
                  composer: box(group.querySelector('.composer')),
                  pill: group.querySelector('.ide-pill-what')?.textContent ?? null,
                  /*
                   * The header is a tab-shaped card, not a strip across the pane:
                   * rounded at the top, square at the bottom where it meets the
                   * body, and narrower than the pane it sits on.
                   */
                  tab:
                    tab === null || tab === undefined
                      ? null
                      : {
                          width: Math.round(tab.getBoundingClientRect().width),
                          paneWidth: Math.round(group.getBoundingClientRect().width),
                          radius: [
                            Math.round(Number.parseFloat(tabStyle.borderTopLeftRadius)),
                            Math.round(Number.parseFloat(tabStyle.borderBottomLeftRadius)),
                          ],
                          title: Math.round(
                            Number.parseFloat(
                              getComputedStyle(tab.querySelector('.workspace-tab-title')).fontSize
                            )
                          ),
                          icon: tab.querySelectorAll('.workspace-tab-icon').length,
                          close: tab.querySelectorAll('.workspace-tab-close').length,
                        },
                  /* A bounded body, which is what stops the panes reading as one page. */
                  bodyBorder: Math.round(Number.parseFloat(bodyStyle.borderTopWidth)),
                  bodyRadius: Math.round(Number.parseFloat(bodyStyle.borderBottomRightRadius)),
                }
              }),
            }
          })()`)

        const closed = await geometry()
        assert(closed.session === 0 && closed.global === 0, 'no terminal is open to begin with')
        const neighbourBefore = closed.panes.find((p) => p.conversationId !== first)
        assert(neighbourBefore !== undefined, 'the split produced a second, different session')

        // ⌘J opens the focused pane's own terminal.
        await press(app, 'j', { meta: true })
        await app.until(`!!document.querySelector('.terminal-panel--session')`, {
          timeout: 20_000,
          label: 'the session terminal opened',
        })
        await app.settle()
        const open = await geometry()

        assert(
          open.session === 1 && open.global === 0,
          `exactly one terminal, and it is not the global one (session ${String(open.session)}, global ${String(open.global)})`
        )
        const owner = open.panes.find((p) => p.conversationId === first)
        const neighbour = open.panes.find((p) => p.conversationId !== first)
        assert(
          owner?.terminals === 1 && neighbour?.terminals === 0,
          `it is inside the owning pane only (owner ${String(owner?.terminals)}, other ${String(neighbour?.terminals)})`
        )
        /*
         * Between the transcript and the composer, measured rather than read off
         * the DOM order: what matters is where it is drawn.
         */
        assert(
          owner.terminal.top >= owner.transcript.bottom - 1 &&
            owner.terminal.bottom <= owner.composer.top + 1,
          `between the transcript and the composer (transcript ends ${String(owner.transcript.bottom)}, terminal ${String(owner.terminal.top)}–${String(owner.terminal.bottom)}, composer starts ${String(owner.composer.top)})`
        )
        /*
         * And it stops at the pane divider. The neighbour keeps the height it
         * had — it does not inherit the panel, mirror it, or make room for it.
         */
        assert(
          neighbour.pane.height === neighbourBefore.pane.height &&
            neighbour.pane.bottom === neighbourBefore.pane.bottom,
          `the other pane keeps its full height (${String(neighbourBefore.pane.height)} → ${String(neighbour.pane.height)})`
        )
        assert(
          owner.transcript.height < neighbourBefore.pane.height,
          'and the room came out of the owning transcript'
        )

        /*
         * The composition, as geometry.
         *
         * Every reading here is one the approved reference fixes and the first
         * implementation missed — a terminal at an arbitrary height with an
         * unreadable header, and a pane header drawn as a hairline strip across
         * the whole width.
         *
         * The composer used to be pinned at 175–195px here, on the reading that
         * "a place to write, not a line" meant holding four lines open. Driven,
         * that came out the other way: an empty box four lines tall is mostly
         * emptiness with a placeholder in it. It now starts at one line and grows
         * with what is typed, so what is asserted is the ceiling — it must not go
         * back to reserving the room — and the growth itself is driven in
         * `shots-composer.mjs`.
         */
        assert(
          owner.terminal.height >= 205 && owner.terminal.height <= 220,
          `the terminal is 205–220px tall, got ${String(owner.terminal.height)}`
        )
        assert(
          owner.terminalHead.height >= 36 && owner.terminalHead.height <= 40,
          `with a 36–40px header, got ${String(owner.terminalHead.height)}`
        )
        assert(
          owner.composer.height <= 120,
          `an empty composer holds no room it is not using — got ${String(owner.composer.height)}px`
        )
        for (const pane of open.panes) {
          assert(
            pane.tab.width < pane.tab.paneWidth - 40,
            `a header is a card, not a strip (tab ${String(pane.tab.width)} of ${String(pane.tab.paneWidth)})`
          )
          assert(
            pane.tab.radius[0] >= 6 && pane.tab.radius[1] === 0,
            `rounded on top and square where it meets the body, got ${JSON.stringify(pane.tab.radius)}`
          )
          assert(
            pane.tab.title >= 13 && pane.tab.title <= 14,
            `its title is 13–14px, got ${String(pane.tab.title)}`
          )
          assert(
            pane.tab.icon === 1 && pane.tab.close === 1,
            'with the conversation mark and a close affordance on it'
          )
          assert(
            pane.bodyBorder >= 1 && pane.bodyRadius >= 8,
            `and the body below it is bounded (${String(pane.bodyBorder)}px, r${String(pane.bodyRadius)})`
          )
        }

        /*
         * The global terminal is a separate panel with a separate shell, opened
         * and closed by its own chord, and it leaves the session's alone.
         */
        await press(app, 'j', { meta: true, shift: true })
        await app.until(`!!document.querySelector('.terminal-panel--global')`, {
          timeout: 20_000,
          label: 'the global terminal opened',
        })
        await app.settle()
        const both = await geometry()
        assert(
          both.session === 1 && both.global === 1,
          `the global terminal is a second, separate panel (session ${String(both.session)}, global ${String(both.global)})`
        )
        assert(
          both.panes.every((p) => p.terminals <= 1),
          'and it is not inside either pane — it belongs to no conversation'
        )

        await press(app, 'j', { meta: true, shift: true })
        await app.until(`!document.querySelector('.terminal-panel--global')`, {
          timeout: 20_000,
          label: 'the global terminal closed',
        })
        await app.settle()
        const afterGlobal = await geometry()
        assert(
          afterGlobal.global === 0 && afterGlobal.session === 1,
          'closing the global one leaves the session terminal open'
        )

        /*
         * The composer still says which selection will be sent. The pill is
         * beneath the terminal now, which is exactly why it is checked here.
         */
        const descriptor = await waitForDescriptor(before)
        ide = await FakeIde.connect(descriptor)
        const roots = await ide.awaitRoots()
        const root = roots.find((candidate) => candidate.endsWith(project.split('/').pop()))
        assert(
          root !== undefined,
          `Chorus published the owning session's root, got ${roots.join()}`
        )
        ide.report(root, { file: join(root, 'src/a.ts'), startLine: 11, endLine: 13 })
        await app.until(`!!document.querySelector('.ide-pill')`, {
          timeout: 20_000,
          label: 'the pill appears',
        })
        await app.settle()

        const withPill = await geometry()
        const owning = withPill.panes.find((p) => p.conversationId === first)
        assert(
          owning?.pill === 'src/a.ts:12-14',
          `the owning composer still names the file and lines, got ${String(owning?.pill)}`
        )
        assert(withPill.session === 1, 'and the session terminal is still the only one of its kind')
      } finally {
        ide?.close()
        await app.quit()
      }
    },
  },

  {
    name: 'the drawer docks, resizes within its range, and comes back that width',
    /*
     * The drawer is a temporary panel now, so its range is 220–320 rather than
     * 240–640, and below 700px it covers the editor rather than squeezing it.
     * That last part is a reversal of the old rule and it is deliberate: what
     * made covering unacceptable before was that closing the panel left nothing
     * to navigate with. The rail is that something.
     */
    async run(assert) {
      const first = await launch({ keepData: true })
      const dataPath = first.dataPath
      try {
        await started(first)
        await openDrawer(first)
        const drag = (toX) =>
          first.evaluate(`(() => {
            const h = document.querySelector('.workspace-sidebar-resize')
            const b = h.getBoundingClientRect()
            const y = b.top + 120
            h.dispatchEvent(new PointerEvent('pointerdown', {
              pointerId: 1, button: 0, bubbles: true, cancelable: true,
              clientX: b.left + b.width / 2, clientY: y,
            }))
            document.dispatchEvent(new PointerEvent('pointermove', {
              pointerId: 1, bubbles: true, clientX: ${String(toX)}, clientY: y,
            }))
            const during = Math.round(
              document.querySelector('.session-drawer').getBoundingClientRect().right)
            document.dispatchEvent(new PointerEvent('pointerup', {
              pointerId: 1, bubbles: true, clientX: ${String(toX)}, clientY: y,
            }))
            return during
          })()`)
        const editorLeft = () =>
          first.evaluate(
            `Math.round(document.querySelector('.workspace-editor').getBoundingClientRect().left)`
          )
        const drawerRight = () =>
          first.evaluate(
            `Math.round(document.querySelector('.session-drawer').getBoundingClientRect().right)`
          )

        const before = await editorLeft()
        // 64px rail plus a 276px drawer, which is inside the range.
        const during = await drag(340)
        assert(
          Math.abs(during - 340) <= 2,
          `the edge lands under the pointer mid-drag, got ${String(during)} for 340`
        )
        await first.settle()
        const after = await editorLeft()
        assert(after !== before, `the editor moved with it (${before} → ${after})`)
        assert(after === (await drawerRight()), `and lands against it (${after})`)

        // Well past the maximum: a temporary panel does not get to take over.
        await drag(2000)
        await first.settle()
        const clamped = await first.evaluate(
          `Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar')))`
        )
        assert(clamped === 320, `dragged past the limit it clamps to 320, got ${String(clamped)}`)

        /*
         * Narrow: the drawer floats over the editor and the rail keeps its 64px.
         * Nothing becomes unreachable, which is the condition that makes this an
         * acceptable trade rather than the old bug.
         */
        await first.viewport(560, 800)
        await first.until(
          `(() => {
            const drawer = document.querySelector('.session-drawer').getBoundingClientRect()
            const editor = document.querySelector('.workspace-editor').getBoundingClientRect()
            return Math.round(editor.left) === 64 && drawer.width <= Math.max(220, innerWidth / 2)
          })()`,
          { timeout: 15_000, label: 'the drawer floated and fitted to the narrow window' }
        )
        assert(true, 'below 700px the drawer covers the editor rather than squeezing it')
        assert(
          (await first.evaluate(
            `Math.round(document.querySelector('.quick-rail').getBoundingClientRect().width)`
          )) === 64,
          'and the rail keeps its full width, so every session is still reachable'
        )
        await first.viewport()
        await wait(300)
      } finally {
        await first.stop()
      }

      const again = await launch({ userData: dataPath })
      try {
        await started(again)
        await again.settle()
        const restored = await again.evaluate(
          `getComputedStyle(document.documentElement).getPropertyValue('--sidebar').trim()`
        )
        assert(restored === '320px', `the width survived the relaunch, got ${restored}`)
      } finally {
        await again.quit()
      }
    },
  },

  {
    name: 'the question stays at the top of the answer it asked for',
    /*
     * A long reply pushed the question out of the window inside a paragraph,
     * leaving a screen of prose with nothing on it to say what it was for — and
     * a question asked at the foot of a long history had nowhere to rise to, so
     * it stayed halfway up until the answer happened to be tall enough.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)

        // A first exchange, so the second question has history above it to be
        // lifted clear of — which is the case that had nowhere to scroll.
        await say(app, 'Reply with exactly: FIRST')
        await app.until(
          `Array.from(document.querySelectorAll('.entry--codex, .entry--claude'))
             .some(e => e.innerText.includes('FIRST'))`,
          { timeout: 180_000, label: 'the first question was answered' }
        )
        // Idle before asking again, so the two turns cannot interleave and leave
        // the measurements describing a moment nobody would ever see.
        await app.until(`!document.querySelector('.send--stop')`, {
          timeout: 180_000,
          label: 'the first turn finished',
        })
        await wait(600)

        /*
         * A short answer must sit *below* the pinned question, not behind it.
         *
         * The turn holds a view of room open beneath itself, and the scroller
         * has its own bottom padding under that — so the end of the scroll range
         * fell a padding's width past the point where the question reaches the
         * top, and a reader sitting at the bottom had that much of the reply's
         * first line hidden behind the header. On a one-line answer that is most
         * of the answer. Only visible on a reply shorter than the view, which is
         * every first exchange.
         */
        const firstReply = await app.evaluate(`(() => {
          const score = document.querySelector('.score').getBoundingClientRect()
          const head = document.querySelector('.turn-head').getBoundingClientRect()
          const reply = Array.from(document.querySelectorAll('.turn .entry--message'))
            .find(e => !e.classList.contains('entry--user'))
          if (!reply) return null
          const said = reply.querySelector('.said').getBoundingClientRect()
          return {
            offTop: Math.abs(head.top - score.top),
            behindHeader: Math.round(head.bottom - said.top),
          }
        })()`)

        assert(firstReply !== null, 'the first answer is inside the current turn')
        assert(
          firstReply.offTop <= 1,
          `the question is pinned for a short answer too (${String(firstReply.offTop)}px off)`
        )
        assert(
          firstReply.behindHeader <= 0,
          `and none of the answer hides behind it (${String(firstReply.behindHeader)}px swallowed)`
        )

        /*
         * A list, not "count to sixty": markdown folds bare lines into one
         * paragraph, so counting came back three lines tall and never outgrew
         * the view at all. A list is one rendered line per item, which is the
         * shape this spec needs the answer to have.
         */
        await say(
          app,
          'Reply with only a markdown numbered list of the numbers 1 to 40, one item per line. No other text.'
        )
        /*
         * `.turn`, not `.turn-head`. The working line moved to the foot of the
         * turn: pinned under the question it was at the top of the window while
         * the reader watched output arrive at the bottom, which is how a running
         * turn came to look silent. It is still inside the turn and still below
         * the question, which is what the geometry below actually checks.
         */
        await app.until(`!!document.querySelector('.turn .entry--thinking')`, {
          label: 'an agent is thinking under the question',
        })
        await wait(400)

        const waiting = await app.evaluate(`(() => {
          const score = document.querySelector('.score').getBoundingClientRect()
          const head = document.querySelector('.turn-head')
          const asked = head.querySelector('.entry--user')
          const think = document.querySelectorAll('.turn .entry--thinking')
          return {
            heads: document.querySelectorAll('.turn-head').length,
            says: asked.innerText.includes('markdown numbered list'),
            offTop: Math.abs(head.getBoundingClientRect().top - score.top),
            gaps: Array.from(think).map(t =>
              t.getBoundingClientRect().top - asked.getBoundingClientRect().bottom),
            speakers: Array.from(think).map(t => t.querySelector('.speaker').textContent),
          }
        })()`)

        assert(waiting.heads === 1, `one current turn, not ${String(waiting.heads)}`)
        assert(waiting.says, 'and it is the question that was just asked')
        assert(
          waiting.offTop <= 1,
          `pinned to the top of the transcript (${String(waiting.offTop)}px off)`
        )
        assert(
          waiting.gaps.length > 0 && waiting.gaps.every((gap) => gap >= 0),
          `every thinking row sits below the question, none over it: ${JSON.stringify(waiting.gaps)}`
        )
        assert(
          waiting.speakers.every((name) => /CODEX|CLAUDE/i.test(name)),
          `each says who is waiting: ${JSON.stringify(waiting.speakers)}`
        )

        // An answer past a viewful of its own: the held-open room is spent, which
        // is exactly when the question used to be carried off the top.
        await app.until(`document.querySelector('.turn-tail')?.offsetHeight === 0`, {
          timeout: 180_000,
          label: 'the answer outgrew the view',
        })

        const answering = await app.evaluate(`(() => {
          const score = document.querySelector('.score')
          const box = score.getBoundingClientRect()
          const head = document.querySelector('.turn-head')
          const r = head.getBoundingClientRect()
          const named = (e) => e.querySelector('.speaker')?.textContent ?? ''
          return {
            offTop: Math.abs(r.top - box.top),
            visible: r.bottom > box.top && r.top < box.bottom,
            sideways: score.scrollWidth - score.clientWidth,
            waiting: Array.from(document.querySelectorAll('.turn .entry--thinking')).map(named),
            writing: Array.from(document.querySelectorAll('.turn .entry'))
              .filter(e => e.querySelector('.said[data-streaming="true"]'))
              .map(named),
          }
        })()`)

        assert(
          answering.offTop <= 1,
          `still pinned under a long answer (${String(answering.offTop)}px off)`
        )
        assert(answering.visible, 'so the question is still readable beside its own answer')
        assert(
          answering.sideways <= 1,
          `nothing overflows sideways (${String(answering.sideways)}px)`
        )
        assert(
          answering.writing.every((name) => !answering.waiting.includes(name)),
          `nobody both writes and waits: ${JSON.stringify(answering)}`
        )

        // Reading back through history must not be undone by the next token.
        await app.evaluate(`(document.querySelector('.score').scrollTop = 0, true)`)
        await wait(1_500)
        const back = await app.evaluate(`(() => {
          const score = document.querySelector('.score')
          const head = document.querySelector('.turn-head')
          const first = document.querySelector('.entry--user')
          return {
            top: score.scrollTop,
            bottom: score.scrollHeight - score.clientHeight,
            letGo: head.getBoundingClientRect().top - score.getBoundingClientRect().top,
            firstIsCurrent: first.closest('.turn-head') !== null,
          }
        })()`)

        assert(
          back.top <= 32,
          `the reader was left where they scrolled, not dragged to ${String(back.top)} of ${String(back.bottom)}`
        )
        assert(back.letGo > 1, 'the pin lets go in history rather than following you up')
        assert(!back.firstIsCurrent, 'and the first question was never the pinned one')

        // The next question takes the pin, from wherever you were reading.
        await say(app, 'Reply with exactly: THIRD')
        await app.until(
          `document.querySelector('.turn-head .entry--user')?.innerText.includes('THIRD') === true`,
          { label: 'the new question became the current turn' }
        )
        await wait(400)

        const handed = await app.evaluate(`(() => {
          const score = document.querySelector('.score').getBoundingClientRect()
          const head = document.querySelector('.turn-head')
          return {
            heads: document.querySelectorAll('.turn-head').length,
            offTop: Math.abs(head.getBoundingClientRect().top - score.top),
            previousIsCurrent: Array.from(document.querySelectorAll('.entry--user'))
              .some(e => e.innerText.includes('markdown numbered list') && e.closest('.turn-head') !== null),
          }
        })()`)

        assert(handed.heads === 1, `still exactly one pinned question, not ${String(handed.heads)}`)
        assert(handed.offTop <= 1, `the new one took the top (${String(handed.offTop)}px off)`)
        assert(!handed.previousIsCurrent, 'and the one before it gave the pin up')

        /*
         * And at phone width, where the speaker column collapses and the rail
         * moves to a 4px gutter. The pinned header is the one row drawn from two
         * different origins — its own box for the background, each entry's box
         * for the dots — so it is exactly where a gutter change would come apart.
         */
        // Settled first: this asks what the narrow layout looks like, not what
        // it looks like halfway through a turn arriving into a resize.
        await app.until(`!document.querySelector('.send--stop')`, {
          timeout: 180_000,
          label: 'the last turn finished',
        })
        await app.viewport(390, 780)
        await wait(1_200)
        /*
         * Back to the live end first, deliberately.
         *
         * A resize moves the scroller under the reader, and the app reads that
         * as having been scrolled away from the bottom — so following stops, as
         * it does for any other scroll it did not make. That is the existing
         * bargain about who owns the scroll position, not something this layout
         * decides, so the spec puts the reader back where the question would be
         * pinned and asks about the layout from there.
         */
        await app.evaluate(
          `(document.querySelector('.score').scrollTop = document.querySelector('.score').scrollHeight, true)`
        )
        await wait(600)
        const narrow = await app.evaluate(`(() => {
          const score = document.querySelector('.score')
          const box = score.getBoundingClientRect()
          const head = document.querySelector('.turn-head')
          const asked = head.querySelector('.entry--user')
          const avatar = asked.querySelector('.entry-avatar').getBoundingClientRect()
          const said = asked.querySelector('.said').getBoundingClientRect()
          return {
            width: score.clientWidth,
            offTop: Math.abs(head.getBoundingClientRect().top - box.top),
            sideways: score.scrollWidth - score.clientWidth,
            spills: asked.getBoundingClientRect().right - box.right,
            // The words start beside the face, never under it: the compact
            // gutter is where a column layout collapses into an overlap.
            overlaps: Math.round(avatar.right - said.left),
          }
        })()`)
        await app.viewport()

        assert(narrow.width < 420, `the pane really is narrow (${String(narrow.width)}px)`)
        assert(narrow.offTop <= 1, `still pinned at phone width (${String(narrow.offTop)}px off)`)
        assert(narrow.sideways <= 1, `nothing overflows sideways (${String(narrow.sideways)}px)`)
        assert(
          narrow.spills <= 1,
          `the question stays inside the pane (${String(narrow.spills)}px over)`
        )
        assert(
          narrow.overlaps <= 0,
          `the words clear the avatar at phone width (${String(narrow.overlaps)}px into it)`
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'an agent can ask a question and get an answer back',
    /*
     * The whole path existed except its last step. The adapter mapped
     * `AskUserQuestion`, the orchestrator logged the request and held it open —
     * and nothing in the renderer read the event, so every question an agent
     * asked was invisible until its deadline passed and the agent was told
     * nobody had answered. Two unit tests cover the reducer; this is the only
     * check that would have noticed the missing half, because every piece it
     * spans was individually correct.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)

        /*
         * Claude is the agent whose AskUserQuestion tool this path serves, and a
         * fresh session already has it: the default roster is `['claude']`, and
         * `startConversation` refuses to open a room with nobody in it. There is
         * nothing to switch on.
         *
         * There used to be a preflight here that waited for a chip and clicked
         * it, and it failed in the worst available way. Its selector
         * (`.voices--pane .voice`) had stopped matching anything — nothing in
         * the renderer has carried `voices--pane` for some time, and only the
         * orphaned CSS rule survives — so it timed out after 60s, hit a `catch`
         * that read every possible failure as "claude is not installed", and
         * passed. The spec reported green while testing none of its own subject,
         * on a machine with claude installed, and cost a minute a run to do it.
         * That is precisely the outcome the comment here used to warn about.
         *
         * So it is an assertion now, not a wait: a room without claude fails on
         * this line, rather than further down where `@claude` goes unanswered
         * and the timeout blames the question path.
         */
        /*
         * Read off the active tab's voice dots.
         *
         * The cast used to be a pair of switches on every sidenav card, which is
         * where this looked. Those moved into the session menu, and a menu that
         * has to be opened is a poor precondition check — so this asks the one
         * place that names a session's participants without being opened.
         */
        const inTheRoom = await app.evaluate(
          `document.querySelector('.workspace-tab[data-active="true"] .voice-dot.voice--claude') !== null`
        )
        assert(inTheRoom, 'claude is in the room, as a fresh session gives it')

        await say(
          app,
          '@claude Use your AskUserQuestion tool right now to ask me one question: "Which colour?" ' +
            'with options Red and Blue. Do not answer it yourself, just ask. ' +
            'Once I have answered, reply with exactly GOT-<my choice in capitals> and nothing else, ' +
            'for example GOT-GREEN if I had chosen green.'
        )

        await app.until(`!!document.querySelector('.question')`, {
          timeout: 240_000,
          label: 'the question reached the window',
        })
        await wait(500)

        const card = await app.evaluate(`(() => {
          const q = document.querySelector('.question')
          return {
            head: q.querySelector('.question-head strong')?.textContent ?? '',
            ask: q.querySelector('.question-ask')?.textContent ?? '',
            options: Array.from(q.querySelectorAll('.question-option-label')).map(o => o.textContent),
            sendDisabled: q.querySelector('.btn--go').disabled,
            focused: document.activeElement?.className ?? '',
          }
        })()`)

        assert(/claude/i.test(card.head), `the card says who is asking: ${card.head}`)
        assert(card.ask.length > 0, `and what was asked: ${card.ask}`)
        assert(
          card.options.length >= 2,
          `the agent's own options are offered, not invented ones: ${JSON.stringify(card.options)}`
        )
        // Nothing is a truer answer than a wrong one: an empty send would tell
        // the agent something the user never chose.
        assert(card.sendDisabled === true, 'and it cannot be sent until it is answered')
        assert(
          card.focused.includes('question-option'),
          `the keyboard can answer it without reaching for the mouse (focus: ${card.focused})`
        )

        // Read before clicking, so the acknowledgement below is checked against
        // the option actually chosen rather than one this spec assumed.
        const chosen = await app.evaluate(
          `document.querySelectorAll('.question-option')[0].querySelector('.question-option-label').textContent.trim()`
        )
        await app.evaluate(`(document.querySelectorAll('.question-option')[0].click(), true)`)
        await wait(400)
        assert(
          (await app.evaluate(`document.querySelector('.question .btn--go').disabled`)) === false,
          'picking an option arms the send'
        )

        await app.evaluate(`(document.querySelector('.question .btn--go').click(), true)`)
        await app.until(`!document.querySelector('.question')`, {
          timeout: 60_000,
          label: 'the card cleared once answered',
        })
        assert(true, 'answering clears the card')

        /*
         * The point of the whole path: the agent got the answer — the words of
         * it, not merely the absence of a deadline.
         *
         * This used to assert "the turn finished and nothing expired", on the
         * reasoning that an agent may acknowledge a choice without repeating it
         * and a spec demanding the word would fail on a turn of phrase. The
         * reasoning was sound and the conclusion was still too weak, because of
         * C-019: `userinput.answered` is written when *Chorus sends* the answer,
         * not when the provider takes it (`conversation-service.ts`). So the
         * card clearing and no timeout notice are both satisfied by an answer
         * the provider rejected — which is exactly the state this spec existed
         * to rule out, and for a while the state the app was actually in.
         *
         * The turn-of-phrase objection is answered by *asking* for the format
         * rather than hoping for it, and by checking the option that was really
         * clicked instead of one assumed here. If the answer does not arrive,
         * the agent has nothing to put after `GOT-` and this fails.
         */
        const token = new RegExp(`GOT-${chosen.toUpperCase()}`, 'i')
        await app.until(
          `Array.from(document.querySelectorAll('.entry--claude')).some(e => ${String(token)}.test(e.innerText))`,
          {
            timeout: 180_000,
            label: `claude acknowledged the answer as GOT-${chosen.toUpperCase()}`,
          }
        )
        assert(
          true,
          `the agent received the answer itself, and said so: GOT-${chosen.toUpperCase()}`
        )

        await app.until(`!document.querySelector('.send--stop')`, {
          timeout: 180_000,
          label: 'the agent finished its turn',
        })
        const expired = await app.evaluate(
          `Array.from(document.querySelectorAll('.entry--system')).some(e => /unanswered in time/.test(e.innerText))`
        )
        assert(expired === false, 'and the deadline never fired')
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'a message sent mid-turn steers the agent rather than stopping it',
    /*
     * This always worked and was impossible to discover. `onSubmit` has never
     * had a busy guard, both adapters declare `steer`, and `runtime.send`
     * pushes into the running turn — but the only visible control turned into
     * Stop the moment an agent started, so the way to say "actually, do it
     * this way" looked exactly like the way to abandon the turn, and clicking
     * it did abandon the turn. Both buttons now show at once, and this pins the
     * behaviour they promise.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await say(app, 'Count slowly from 1 to 30, one number per line, nothing else.')
        await app.until(`!!document.querySelector('.send--stop')`, {
          timeout: 120_000,
          label: 'the turn started',
        })

        /*
         * One button, and what it does follows what is in the box.
         *
         * Empty and something running, the only thing left to want is to stop
         * it. Type anything and the same button sends — because sending
         * mid-turn steers rather than restarts, which is what makes one control
         * honest where a Send/Stop pair implied a choice between opposites.
         */
        const idle = await app.evaluate(`(() => ({
          stop: !!document.querySelector('.send--stop'),
          send: !!document.querySelector('.composer-tools button[type="submit"]'),
        }))()`)
        assert(idle.stop && !idle.send, 'working with an empty box offers Stop')

        await draft(app, 'a change of mind')
        await app.settle()
        const typed = await app.evaluate(`(() => ({
          stop: !!document.querySelector('.send--stop'),
          send: !!document.querySelector('.composer-tools button[type="submit"]'),
          /*
           * The primary action, not every button on the row.
           *
           * This counted every button under .composer-tools and expected one,
           * which was true while Send was the only thing in the row. The row
           * also carries the @ and # mention triggers now — utilities that put a
           * character in the box, and never a second way to send. Counting them
           * made a passing product look like a regression, which is the failure
           * mode a count over a container always has. The .send class is carried
           * by the submit button and by the stop button, and by nothing else.
           *
           * No backticks in here: this comment lives inside a template literal,
           * and one quoting a selector ends the string. Same trap as the SQL one.
           */
          primary: document.querySelectorAll('.composer-tools .send').length,
        }))()`)
        assert(typed.send && !typed.stop, 'and typing turns that same button into Send')
        assert(
          typed.primary === 1,
          `never two of them — one Send-or-Stop and no more, got ${String(typed.primary)}`
        )

        await say(app, 'Change of plan: stop counting and reply with exactly STEERED')
        await app.until(
          `Array.from(document.querySelectorAll('.entry--codex, .entry--claude'))
             .some(e => e.innerText.includes('STEERED'))`,
          { timeout: 180_000, label: 'the agent took the new direction' }
        )

        const notices = await app.evaluate(
          `Array.from(document.querySelectorAll('.notice-line'))
             .map(n => n.textContent).filter(t => /Stopped|Interrupted/.test(t))`
        )
        assert(
          notices.length === 0,
          `and the turn was never interrupted to do it, got ${JSON.stringify(notices)}`
        )
        assert(
          (await app.evaluate(`document.querySelectorAll('.entry--user').length`)) === 2,
          'both instructions are in the transcript'
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'steps fold to a line, and the answer reads as the answer',
    /*
     * A turn is mostly work. Every command used to render as its own
     * syntax-highlighted block, so a turn that ran four of them buried the
     * reply under four blocks — and the reply was set in the same type at the
     * same indent as everything above it.
     *
     * Folded rather than folding-on-completion: a transcript that reflowed the
     * moment an agent stopped would move the pinned question, resize the rail,
     * and change the measurement `makeRoom` uses to find the bottom.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        const conversationId = await app.evaluate(
          `document.querySelector('${PANE}').dataset.conversation`
        )
        // Read-only is the default and refuses to run anything.
        await app.evaluate(
          `window.chorus.setProfile({ conversationId: ${JSON.stringify(conversationId)}, profileId: 'trusted' }).then(() => true)`
        )
        await say(
          app,
          'Run these three bash commands one at a time: pwd ; date ; echo hello. Then reply with a one sentence summary.'
        )
        await app.until(`document.querySelectorAll('.command-fold').length >= 2`, {
          timeout: 240_000,
          label: 'the commands ran',
        })
        await app.until(`!document.querySelector('.send--stop')`, {
          timeout: 240_000,
          label: 'the turn finished',
        })
        await app.settle()

        const folds = await app.evaluate(`(() => {
          const all = [...document.querySelectorAll('.command-fold')]
          return {
            count: all.length,
            heights: all.map(f => Math.round(f.getBoundingClientRect().height)),
            expanded: document.querySelectorAll('.command-fold pre.command').length,
          }
        })()`)
        assert(folds.count >= 2, `several commands ran, got ${folds.count}`)
        assert(folds.expanded === 0, `every one of them is folded, ${folds.expanded} were not`)
        assert(
          folds.heights.every((h) => h < 40),
          `and each is a line rather than a block, got ${folds.heights.join(',')}`
        )

        // The fold is a fold, not a truncation.
        await app.evaluate(
          `(() => { document.querySelector('.command-summary').click(); return true })()`
        )
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelectorAll('.command-fold pre.command').length`)) ===
            1,
          'and opens on click'
        )

        const answer = await app.evaluate(`(() => {
          const final = document.querySelector('.entry[data-final="true"]')
          if (!final) return null
          const agentMessages = [...document.querySelectorAll('.entry--message')]
            .filter(e => e.classList.contains('entry--codex') || e.classList.contains('entry--claude'))
          const said = getComputedStyle(final.querySelector('.said'))
          const muted = document.querySelector('.entry--message:not([data-final="true"]) .said .md-p')
          return {
            isLast: final === agentMessages.at(-1),
            count: document.querySelectorAll('.entry[data-final="true"]').length,
            /* The panel and its edge went with the bubble — a message is an
               unboxed row now. What marks the answer is brightness, so the test
               is that its prose is lit where the working around it is not. */
            boxed: said.borderLeftWidth !== '0px' || said.backgroundColor !== 'rgba(0, 0, 0, 0)',
            lit: getComputedStyle(final.querySelector('.said .md-p')).color,
            around: muted === null ? null : getComputedStyle(muted).color,
          }
        })()`)
        assert(answer !== null, 'the finished turn marks a final answer')
        assert(answer.count === 1, `exactly one, got ${String(answer?.count)}`)
        assert(answer.isLast, 'and it is the last thing the agent said')
        assert(!answer.boxed, 'the answer is a row, not a panel with an edge')
        assert(
          answer.around === null || answer.lit !== answer.around,
          `and it is lit where the working around it is not (${String(answer?.lit)} vs ${String(answer?.around)})`
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'quits cleanly with an agent mid-turn',
    // Shutdown closed the database while event pumps were still writing, which
    // surfaced as an unhandled rejection.
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await app.evaluate(`(() => {
          const ta = document.querySelector('.composer textarea')
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
            .set.call(ta, 'Count slowly from 1 to 60, one number per line.')
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          document.querySelector('.composer').requestSubmit()
          return true
        })()`)
        await app.until(`!!document.querySelector('.send--stop')`, {
          label: 'an agent started working',
        })
        await app.stop()
        await wait(2_000)
        const noise = app.output()
        assert(
          !/not open|Unhandled promise|UnhandledPromiseRejection/.test(noise),
          'no database errors on the way out'
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'follows the editor for its own project, and only that one',
    /*
     * The whole path, end to end: descriptor discovery, the token handshake,
     * root filtering, and the pill. Everything until now was unit-level, and a
     * unit test cannot tell you the socket is actually reachable from a
     * packaged main process.
     */
    async run(assert) {
      const before = existingDescriptors()
      const app = await launch()
      let ide = null
      try {
        await started(app)

        const project = mkdtempSync(join(tmpdir(), 'chorus-e2e-proj-'))
        mkdirSync(join(project, 'src'), { recursive: true })
        writeFileSync(join(project, 'src/a.ts'), 'const a = 1\n')

        const conversationId = await app.evaluate(
          `document.querySelector('.pane').dataset.conversation`
        )
        await app.evaluate(
          `window.chorus.setProjectDirectory({ conversationId: ${JSON.stringify(conversationId)}, cwd: ${JSON.stringify(project)} }).then(() => true)`
        )

        const descriptor = await waitForDescriptor(before)
        assert(typeof descriptor.token === 'string', 'the descriptor carries a token')
        ide = await FakeIde.connect(descriptor)

        const roots = await ide.awaitRoots()
        // The root arrives canonicalized: on macOS the temp dir is reached
        // through /var, which is a symlink to /private/var.
        assert(roots.length === 1, 'Chorus published exactly one root')
        const root = roots[0]

        ide.report(root, { file: join(root, 'src/a.ts'), startLine: 11, endLine: 13 })
        await app.until(`!!document.querySelector('.ide-pill')`, { label: 'the pill appears' })
        const shown = await app.evaluate(`document.querySelector('.ide-pill-what').textContent`)
        assert(shown === 'src/a.ts:12-14', `the pill names the file and lines, got ${shown}`)

        // A file from somewhere else must not reach this pane, even as a name.
        const other = mkdtempSync(join(tmpdir(), 'chorus-e2e-other-'))
        writeFileSync(join(other, 'secret.ts'), 'const s = 1\n')
        ide.report(root, { file: join(other, 'secret.ts') })
        await wait(600)
        const after = await app.evaluate(
          `document.querySelector('.ide-pill-what')?.textContent ?? ''`
        )
        assert(!after.includes('secret'), `no foreign path reaches the pane, got ${after}`)
      } finally {
        ide?.close()
        await app.quit()
      }
    },
  },

  {
    name: 'a merge request selection says which version it is',
    /*
     * Protocol 2, through the real socket. A `gl-review` document is a real
     * text editor whose *content* is a committed blob, so `src/a.ts:12-14` on
     * its own points an agent at lines that have moved. The pill has to say so,
     * and `cached` has to be visible too — it travelled on the wire since the
     * feature shipped and was dropped on the way to the renderer until now.
     *
     * The fake IDE sends what a real window would send after `resolveDocument`
     * parsed the URI; what this proves is the half a unit test cannot — that
     * the frame survives the socket, the broker, and the IPC boundary with its
     * provenance intact.
     */
    async run(assert) {
      const before = existingDescriptors()
      const app = await launch()
      let ide = null
      try {
        await started(app)

        const project = mkdtempSync(join(tmpdir(), 'chorus-e2e-mr-'))
        mkdirSync(join(project, 'src'), { recursive: true })
        writeFileSync(join(project, 'src/a.ts'), 'const a = 1\n')

        const conversationId = await app.evaluate(
          `document.querySelector('.pane').dataset.conversation`
        )
        await app.evaluate(
          `window.chorus.setProjectDirectory({ conversationId: ${JSON.stringify(conversationId)}, cwd: ${JSON.stringify(project)} }).then(() => true)`
        )

        const descriptor = await waitForDescriptor(before)
        ide = await FakeIde.connect(descriptor)
        const [root] = await ide.awaitRoots(project)

        ide.report(root, {
          file: join(root, 'src/a.ts'),
          startLine: 11,
          endLine: 13,
          source: 'cached',
          provenance: { kind: 'review', commit: 'a1b2c3d4e5f6' },
        })
        await app.until(`!!document.querySelector('.ide-pill-mark')`, {
          label: 'the version marker appears',
        })

        const shown = await app.evaluate(`document.querySelector('.ide-pill-what').textContent`)
        assert(shown === 'src/a.ts:12-14', `the pill still names the file and lines, got ${shown}`)

        const mark = await app.evaluate(`document.querySelector('.ide-pill-mark').textContent`)
        // The short sha, and never `!456`: the number a human sees is `iid`,
        // which the review URI does not carry.
        assert(mark.includes('a1b2c3d'), `the marker names the commit, got ${mark}`)
        assert(!mark.includes('a1b2c3d4e5f6'), `the marker is shortened, got ${mark}`)
        assert(mark.includes('remembered'), `a cached selection says so, got ${mark}`)
      } finally {
        ide?.close()
        await app.quit()
      }
    },
  },

  {
    name: 'Send asks the editor again rather than trusting the pill',
    /*
     * The pill is debounced, so it can be a few hundred milliseconds behind.
     * Attaching the lines the user *was* looking at is worse than attaching
     * none, and only a live round trip can prove the fresh ones win.
     */
    async run(assert) {
      const before = existingDescriptors()
      const app = await launch()
      let ide = null
      try {
        await started(app)
        const project = mkdtempSync(join(tmpdir(), 'chorus-e2e-fresh-'))
        mkdirSync(join(project, 'src'), { recursive: true })
        writeFileSync(join(project, 'src/b.ts'), 'const b = 2\n')

        const conversationId = await app.evaluate(
          `document.querySelector('.pane').dataset.conversation`
        )
        await app.evaluate(
          `window.chorus.setProjectDirectory({ conversationId: ${JSON.stringify(conversationId)}, cwd: ${JSON.stringify(project)} }).then(() => true)`
        )

        const descriptor = await waitForDescriptor(before)
        ide = await FakeIde.connect(descriptor)
        const [root] = await ide.awaitRoots(project)

        // The pill says lines 1-3 ...
        ide.report(root, { file: join(root, 'src/b.ts'), startLine: 0, endLine: 2 })
        await app.until(`!!document.querySelector('.ide-pill')`, { label: 'the pill appears' })

        // ... and by the time Send runs, the selection has moved to 40-41 and
        // the buffer is unsaved.
        ide.onSnapshot(() => ({
          outcome: 'ok',
          snapshot: {
            source: 'current',
            filePath: join(root, 'src/b.ts'),
            fileUrl: `file://${join(root, 'src/b.ts')}`,
            languageId: 'typescript',
            documentVersion: 2,
            isDirty: true,
            provenance: { kind: 'worktree' },
            selection: {
              start: { line: 39, character: 0 },
              end: { line: 40, character: 3 },
              isEmpty: false,
              selectedBytes: 7,
              text: '  x = 1',
            },
          },
        }))

        const result = await app.evaluate(
          `window.chorus.ideSnapshot({ conversationId: ${JSON.stringify(conversationId)} })`
        )
        assert(result.outcome === 'ok', `the snapshot came back, got ${result.outcome}`)
        assert(
          result.startLine === 40 && result.endLine === 41,
          'the fresh range wins over the pill'
        )
        assert(result.relativePath === 'src/b.ts', 'the path is relative to the project')
        assert(result.text === '  x = 1', 'the text is exact, indentation included')
        assert(result.isDirty === true, 'an unsaved buffer is reported as one')

        // The one place a token or a path may never end up.
        const diagnostics = await app.evaluate(`window.chorus.readDiagnostics()`)
        const dumped = JSON.stringify(diagnostics)
        assert(!dumped.includes(descriptor.token), 'the token is absent from diagnostics')
        assert(!dumped.includes('x = 1'), 'no selected source text is in diagnostics')
      } finally {
        ide?.close()
        await app.quit()
      }
    },
  },

  {
    name: 'typing a slash offers the commands this project actually has',
    /*
     * The list is the project's, not the app's: its own `.claude/commands`, its
     * skills, its plugins. So this asserts against whatever the CLI reports for
     * the directory the session opened in, rather than a name baked in here —
     * a fixture would pass on a machine where the feature is broken.
     *
     * The rule that matters is the one that differs from `@`: a slash is a path
     * separator far more often than a command, so the menu must stay shut
     * inside `src/foo` and open only when a command leads the message.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await app.until(`document.querySelector('.composer textarea') !== null`)

        await draft(app, 'look at src/foo')
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelector('.mention-menu') === null`)) === true,
          'a path does not open the menu'
        )

        await draft(app, '/')
        await untilMenu(app, `document.querySelector('.mention-menu .mention-name') !== null`, {
          timeout: 60_000,
          label: 'a leading slash opened the menu',
        })
        const offered = await app.evaluate(
          `Array.from(document.querySelectorAll('.mention-menu .mention-name')).map(n => n.textContent)`
        )
        assert(offered.length > 0, `it offered ${String(offered.length)} commands`)
        assert(
          offered.every((name) => name.startsWith('/')),
          `and each is written as a command, e.g. ${String(offered[0])}`
        )

        // Narrowing has to reach a compound name by its tail, which is how half
        // of these are actually remembered.
        await draft(app, '/re')
        await app.settle()
        const narrowed = await app.evaluate(
          `Array.from(document.querySelectorAll('.mention-menu .mention-name')).map(n => n.textContent)`
        )
        assert(
          narrowed.length > 0 && narrowed.length <= offered.length,
          `typing narrows it, ${String(offered.length)} → ${String(narrowed.length)}`
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'an @ offers the cast, then the project’s files',
    /*
     * `@` meant agents. It now means both, and the ordering is the whole design:
     * two agents against thousands of files, so counting would bury what `@`
     * originally did. A bare `@` shows the cast; typing past a name starts
     * finding files.
     *
     * The search is git's, so this asserts against whatever the repository
     * actually contains rather than a fixture — which is also the only way to
     * catch the search being wired to nothing.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await app.until(`document.querySelector('.composer textarea') !== null`)

        /*
         * Point it at a repository first.
         *
         * A fresh session opens with no project directory, which resolves to
         * home — and file completion is asked of `git ls-files`, so outside a
         * repository there is correctly nothing to offer. The first draft of
         * this spec asserted against that and read as a broken search.
         */
        const id = (await tabIds(app))[0]
        await app.evaluate(
          `window.chorus.setProjectDirectory({ conversationId: ${JSON.stringify('__ID__')}, cwd: ${JSON.stringify(process.cwd())} }).then(() => true)`.replace(
            '__ID__',
            id
          )
        )
        await app.settle()

        await draft(app, '@')
        await untilMenu(app, `document.querySelector('.mention-menu .mention-name') !== null`, {
          label: 'a bare @ opened the menu',
        })
        const cast = await app.evaluate(
          `Array.from(document.querySelectorAll('.mention-menu .mention-detail')).map(n => n.textContent)`
        )
        assert(
          cast.length > 0 && cast.every((detail) => detail !== 'file'),
          `a bare @ offers the cast and no files, got ${JSON.stringify(cast)}`
        )

        /*
         * And it is actually on the screen, which is a different question.
         *
         * Everything above passes on a menu the user cannot see. `.dock` carries
         * `overflow-y: auto` so a tall approval card's buttons stay reachable,
         * and while the menu rendered inside the composer that clip cut it down
         * to about 5px of its 35.5 — present in the DOM, painted almost nowhere.
         * A screenshot of the running app is the only thing that caught it.
         *
         * `elementFromPoint` is the cheapest thing that asks Chromium rather
         * than the DOM: it hit-tests against what was composited, so a row
         * behind a clip, under an opaque ancestor, or off-screen answers with
         * something that is not part of the listbox.
         */
        await app.settle()
        const painted = await app.evaluate(`(() => {
          const menu = document.querySelector('.mention-menu')
          const row = menu?.querySelector('.mention-option')
          if (!row) return { ok: false, why: 'no row to sample' }
          const at = row.getBoundingClientRect()
          const hit = document.elementFromPoint(
            Math.round(at.left + at.width / 2),
            Math.round(at.top + at.height / 2)
          )
          const dock = document.querySelector('.dock')?.getBoundingClientRect()
          return {
            ok: hit !== null && menu.contains(hit),
            why: hit === null ? 'nothing at that point' : hit.className || hit.tagName,
            row: { top: Math.round(at.top), bottom: Math.round(at.bottom) },
            dockTop: dock === undefined ? null : Math.round(dock.top),
          }
        })()`)
        assert(
          painted.ok === true,
          `the first row is hit-testable where it is drawn, got ${JSON.stringify(painted)}`
        )

        // `mention-menu` is the app's own source file, so the repository is
        // guaranteed to contain it — no fixture, and it must come from git.
        await draft(app, '@mention-menu')
        await untilMenu(
          app,
          `Array.from(document.querySelectorAll('.mention-menu .mention-detail')).some(n => n.textContent === 'file')`,
          { timeout: 30_000, label: 'typing a name found files' }
        )
        const found = await app.evaluate(
          `Array.from(document.querySelectorAll('.mention-menu .mention-name')).map(n => n.textContent)`
        )
        assert(
          found.some((name) => name.includes('mention-menu')),
          `and the file it names, got ${JSON.stringify(found.slice(0, 3))}`
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'a half-typed message survives quitting the app',
    /*
     * Drafts lived in an in-memory carry map and died with the process. A
     * backgrounded tab kept one — that was already asserted — but quitting lost
     * it, which is the case that actually costs you something: everything else
     * in the note about what was open is recoverable by clicking, and a
     * half-written question is not.
     *
     * Written a second after typing stops, so this waits for that rather than
     * quitting into the debounce.
     */
    async run(assert) {
      const first = await launch({ keepData: true })
      const dataPath = first.dataPath
      try {
        await started(first)
        await first.until(`document.querySelector('.composer textarea') !== null`)
        await draft(first, 'half a question about the')
        // Past the write debounce; quitting inside it is a different test.
        await wait(2_000)
      } finally {
        await first.stop()
      }

      const again = await launch({ userData: dataPath })
      try {
        await started(again)
        await again.until(`document.querySelector('.composer textarea') !== null`)
        await again.settle()
        const restored = await again.evaluate(`document.querySelector('.composer textarea').value`)
        assert(
          restored === 'half a question about the',
          `the draft came back, got ${JSON.stringify(restored)}`
        )
      } finally {
        await again.quit()
      }
    },
  },

  {
    name: 'the box brings back what was said before',
    /*
     * Up-arrow recall, and the rule that makes it safe: it only engages from an
     * empty box. In a draft being written the arrows have to keep moving the
     * caret — a field that jumps to last week's message because the caret
     * reached line one is worse than having no recall.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await say(app, 'the first thing')
        await app.until(
          `Array.from(document.querySelectorAll('.entry--user')).some(e => e.innerText.includes('the first thing'))`,
          { timeout: 120_000, label: 'the first message is in the transcript' }
        )

        await pressIn(app, 'ArrowUp')
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelector('.composer textarea').value`)) ===
            'the first thing',
          'up from an empty box brings back what was said'
        )

        await pressIn(app, 'ArrowDown')
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelector('.composer textarea').value`)) === '',
          'and down walks back to the empty box'
        )

        // The rule that keeps it out of the way: with something typed, the
        // arrows belong to the caret.
        await draft(app, 'something new')
        await pressIn(app, 'ArrowUp')
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelector('.composer textarea').value`)) ===
            'something new',
          'and a draft being written is left alone'
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'a card still says what it missed after a relaunch',
    /*
     * Unread lived only in memory, so every launch claimed nothing had happened
     * while you were away — which makes the whole point of running four agents
     * at once a lie: you come back and the app has forgotten why you left.
     *
     * The number is not stored. What is stored is how far each card had been
     * read, and the count is asked of the log against that — so this asserts the
     * watermark round-trips through a real file and a real restart, which is the
     * only place the two halves meet.
     */
    async run(assert) {
      const first = await launch({ keepData: true })
      const dataPath = first.dataPath
      let background
      try {
        const ids = await twoSessions(first)
        // The original, now sitting behind the one just created.
        background = ids[0]

        /*
         * Spoken to directly rather than through the composer.
         *
         * Its pane is not mounted — that is the state being tested — so there is
         * no textarea to type into. This is the same call the composer makes.
         */
        await first.evaluate(
          `window.chorus.sendMessage({ conversationId: ${JSON.stringify(background)}, text: 'Reply with exactly: ok' }).then(() => true)`
        )
        await first.until(
          `document.querySelector('[data-rail-session="${background}"] .rail-badge') !== null`,
          { timeout: 180_000, label: 'the background session counted an unread' }
        )
      } finally {
        await first.stop()
      }

      const again = await launch({ userData: dataPath })
      try {
        await started(again)
        await again.settle()
        const badge = await again.evaluate(`(() => {
          const el = document.querySelector('[data-rail-session="${background}"] .rail-badge')
          return el === null ? null : el.textContent
        })()`)
        assert(
          badge !== null && Number(badge) > 0,
          `the count came back after a relaunch, got ${String(badge)}`
        )
      } finally {
        await again.quit()
      }
    },
  },

  {
    name: 'an ended conversation can be found again and reopened',
    /*
     * Ending one used to lose it. The transcript stayed in SQLite forever — the
     * log never deletes — but the only list of conversations was the note of
     * what was on screen, and ending took it out of that. It survived under an
     * id nothing displayed.
     *
     * Asserted end to end because the interesting part is not the query: it is
     * that reopening starts agents again and the transcript is still underneath
     * them.
     */
    async run(assert) {
      const app = await launch()
      try {
        const ids = await twoSessions(app)
        const ended = ids[0]

        /*
         * Through the menu, because that is the only route now.
         *
         * End used to be an icon button on every row, two pixels from the one
         * that opens the session. It is the last item in one menu, behind a
         * divider — which is the whole of why an accidental click can no longer
         * end a conversation.
         */
        await openDrawer(app)
        await app.evaluate(`(() => {
          document.querySelector('[data-session-more="${ended}"]').click()
          return true
        })()`)
        await app.until(`!!document.querySelector('.session-menu-danger')`, {
          timeout: 10_000,
          label: 'the session menu offered End',
        })
        // Idle, so End takes one press — it only asks twice while an agent is
        // working, which is the one moment there is anything to lose.
        await app.evaluate(`(() => {
          document.querySelector('.session-menu-danger').click()
          return true
        })()`)
        await app.until(`document.querySelectorAll('${TAB}').length === 1`, {
          label: 'the conversation ended',
        })
        assert(
          (await app.evaluate(
            `document.querySelector('[data-sidebar-conversation="${ended}"]') === null`
          )) === true,
          'and left the sidebar, so nothing on screen still names it'
        )

        await app.evaluate(`(() => {
          const history = [...document.querySelectorAll('.session-drawer-tool')]
            .find((b) => b.getAttribute('aria-label') === 'Past conversations')
          history.click()
          return true
        })()`)
        await app.until(`document.querySelector('.history-row') !== null`, {
          label: 'the history sheet listed the log',
        })

        const row = `[data-history-conversation="${ended}"]`
        assert(
          (await app.evaluate(`document.querySelector('${row}') !== null`)) === true,
          'the ended conversation is in the list'
        )

        await app.evaluate(`(() => { document.querySelector('${row}').click(); return true })()`)
        // Reopening starts its agents, which is a real provider launch.
        await app.until(
          `document.querySelector('${TAB}[data-workspace-tab="${ended}"]') !== null`,
          {
            timeout: 180_000,
            label: 'it came back as a tab',
          }
        )

        const messages = await app.evaluate(`document.querySelectorAll('.entry').length`)
        assert(messages > 0, `and brought its transcript with it, ${String(messages)} entries`)
      } finally {
        await app.quit()
      }
    },
  },
  {
    name: 'offers only the actions a passage can actually take',
    /*
     * The selection toolbar had no test at all until this one, while growing to
     * four actions gated on two different conditions — whether the passage has a
     * single finished agent author, and whether a language is set. Both gates
     * are invisible until they are wrong, and being wrong means either an action
     * that fails when clicked or one that is silently missing.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await app.until(`document.querySelector('.composer textarea') !== null`)
        const id = (await tabIds(app))[0]
        await app.evaluate(
          `window.chorus.setProjectDirectory({ conversationId: ${JSON.stringify('__ID__')}, cwd: ${JSON.stringify(process.cwd())} }).then(() => true)`.replace(
            '__ID__',
            id
          )
        )
        // Start with no language, so the two language-gated actions are absent
        // for a reason the spec sets rather than inherits from the machine.
        await app.evaluate(
          `window.chorus.readSettings().then((s) => window.chorus.writeSettings({ ...s, explainLanguage: '' })).then(() => true)`
        )
        await app.settle()

        await say(
          app,
          'Reply with exactly this sentence and nothing else: The parser reads the header.'
        )
        await app.until(
          `document.querySelector('.entry[data-kind="message"][data-actor="claude"][data-status="complete"]') !== null`,
          { timeout: 180_000, label: 'the reply landed' }
        )
        const rest = await settled(app)
        assert(rest.still, stillness(rest))
        const own = await selectInside(app, '.entry[data-actor="user"]')
        assert(own !== '', 'a passage of your own message can be selected')
        await app.until(`document.querySelector('.quote-offer') !== null`, {
          label: 'the offer appears for your own words',
        })
        assert(
          JSON.stringify(await offerLabels(app)) === JSON.stringify(['Quote in message']),
          'and offers only quoting, because there is nobody to ask'
        )
        assert(
          (await app.evaluate(`document.querySelector('.quote-offer').dataset.askable ?? null`)) ===
            null,
          'and says so in the DOM, so a wrong answer is assertable'
        )

        // A finished agent reply can be asked about, but not explained or
        // translated while no language is set.
        await selectInside(
          app,
          '.entry[data-kind="message"][data-actor="claude"][data-status="complete"]'
        )
        await app.until(`document.querySelector('.quote-offer[data-askable="true"]') !== null`, {
          label: 'a finished reply is askable',
        })
        assert(
          JSON.stringify(await offerLabels(app)) ===
            JSON.stringify(['Quote in message', 'Ask about this']),
          'and translating stays away until a language is set'
        )

        await app.evaluate(
          `window.chorus.readSettings().then((s) => window.chorus.writeSettings({ ...s, explainLanguage: 'Arabic' })).then(() => true)`
        )
        /*
         * The write reaches an open pane without anything being reopened, which
         * is the behaviour this now also guards.
         *
         * The language used to be re-read on every selection, so a fresh drag
         * picked one up. It is `App`'s now, because it decides whether an Explain
         * button exists under *every* reply and no selection can be waited on for
         * that — and when this spec first ran against that change it hung here,
         * because a pane that reads its preferences once is stale the moment
         * anything else writes. Main echoes every settings write to every window
         * (`settings:changed`) precisely so this passes.
         *
         * Three, not four: Explain left the offer for a button on the reply.
         */
        await selectInside(
          app,
          '.entry[data-kind="message"][data-actor="claude"][data-status="complete"]'
        )
        await app.until(`document.querySelectorAll('.quote-offer-action').length === 3`, {
          label: 'setting a language offers translating',
        })
        assert(
          JSON.stringify(await offerLabels(app)) ===
            JSON.stringify(['Quote in message', 'Ask about this', 'Translate']),
          'three, and Explain is not among them — it is a button under the reply now'
        )

        /*
         * One row, and the dividers between them.
         *
         * The hairlines are the container showing through one-pixel gaps, which
         * is what makes them work when the bar wraps — a border on the buttons
         * cannot, because CSS cannot tell a wrapped flex item from an unwrapped
         * one. If someone reinstates one, this is what notices.
         */
        const bar = await app.evaluate(`(() => {
          const el = document.querySelector('.quote-offer')
          const btns = [...el.querySelectorAll('.quote-offer-action')]
          const cs = getComputedStyle(el)
          return {
            rows: new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size,
            gap: cs.columnGap,
            borders: btns.some((b) => getComputedStyle(b).borderLeftWidth !== '0px'),
            opaque: btns.every((b) => getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)'),
          }
        })()`)
        assert(bar.rows === 1, 'every action still fits one row on a wide pane')
        assert(bar.gap === '1px' && !bar.borders, 'divided by gaps, not by borders on the buttons')
        assert(bar.opaque, 'and the buttons are opaque, or the divider colour floods them')
      } finally {
        await app.quit()
      }
    },
  },
  {
    name: 'keeps the offer when the transcript scrolls under it',
    /*
     * C-025. The offer used to be positioned against the pane while the passage
     * moved with the scroller, so any scroll left the two disagreeing and the
     * handler threw the offer away. On a narrow pane that happened several times
     * a second — the follow logic never settles there — so three shipped actions
     * and one new one were unreachable, silently.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await app.until(`document.querySelector('.composer textarea') !== null`)
        const id = (await tabIds(app))[0]
        await app.evaluate(
          `window.chorus.setProjectDirectory({ conversationId: ${JSON.stringify('__ID__')}, cwd: ${JSON.stringify(process.cwd())} }).then(() => true)`.replace(
            '__ID__',
            id
          )
        )
        await app.evaluate(
          `window.chorus.readSettings().then((s) => window.chorus.writeSettings({ ...s, explainLanguage: 'Arabic' })).then(() => true)`
        )
        await app.settle()

        await say(
          app,
          'Reply with exactly this sentence and nothing else: The parser reads the header before it reads the body of the message.'
        )
        await app.until(
          `document.querySelector('.entry[data-kind="message"][data-actor="claude"][data-status="complete"]') !== null`,
          { timeout: 180_000, label: 'the reply landed' }
        )
        const rest = await settled(app)
        assert(rest.still, stillness(rest))

        await selectInside(
          app,
          '.entry[data-kind="message"][data-actor="claude"][data-status="complete"]'
        )
        await app.until(`document.querySelector('.quote-offer') !== null`, {
          label: 'the offer appears',
        })

        await app.evaluate(
          `(() => { document.querySelector('.score').scrollTop -= 40; return true })()`
        )
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelector('.quote-offer') !== null`)) === true,
          'scrolling no longer destroys it'
        )

        /*
         * Narrow enough that the bar wraps and the follow logic churns, which is
         * where this was not merely annoying but total.
         *
         * **Stepped rather than fixed at 460.** A single width bakes in how many
         * actions the bar happens to have: it wrapped at 460 with four, and when
         * Explain moved out from under the selection to a button on the reply,
         * three fitted on one line and this failed for a reason that had nothing
         * to do with what it guards. So it narrows until the bar genuinely wraps
         * and asserts there — and still fails if it never does, because the
         * wrapped case is the case.
         */
        let narrow = { offer: false, rows: 0 }
        for (const width of [460, 400, 340]) {
          await app.viewport(width, 900)
          for (let i = 0; i < 4; i += 1) await app.settle()
          await selectInside(
            app,
            '.entry[data-kind="message"][data-actor="claude"][data-status="complete"]'
          )
          for (let i = 0; i < 6; i += 1) await app.settle()
          narrow = await measureOffer(app)
          if (narrow.rows > 1) break
        }

        assert(narrow.offer === true, 'a narrow pane still offers something at all')
        assert(narrow.inside === true, 'and keeps it inside the scrollport')
        /*
         * Clickable, not merely present. Asserting the element exists would pass
         * with an offer sitting outside the scrollport or under something else,
         * which is the failure this whole plan is about.
         */
        assert(narrow.hits === true, 'and every action is where it is drawn')
        assert(
          narrow.rows > 1,
          `and the bar wrapped, as it must at this width (${String(narrow.rows)} rows)`
        )
        await app.viewport()
      } finally {
        await app.quit()
      }
    },
  },
  {
    name: 'a terminal renders ANSI in the theme, and re-reads it when the scheme changes',
    /*
     * Nothing guarded the terminal's colour, and the gap cost a full diagnosis.
     *
     * A report of "monochrome output" was chased through three layers on the
     * assumption it was real: the PTY environment, then `node-pty`'s `TERM`, then
     * the renderer. It was none of them — the shell was BSD `ls` with `CLICOLOR`
     * unset, which is monochrome in every terminal on macOS. Proving that took
     * driving the app by hand, because no spec could answer "does a terminal
     * paint colour" and so the question stayed open the whole way.
     *
     * So this is the answer, written down. It types a *deterministic* escape
     * sequence rather than running a program: what a given tool decides to emit
     * depends on its own capability detection, and a spec that shipped that
     * decision would fail the day someone set `NO_COLOR`.
     *
     * The assertion is equality with the tokens, not "more than one colour". A
     * count passes with the palette wired to the wrong theme, and passes again
     * with the light block ignored entirely — which is the specific bug the
     * `--ansi-*` tokens exist to prevent, and the one `readTheme` is here for.
     * `styles.css` already carries a comment saying that asserting the tokens
     * *resolved* would have shipped the black-viewport bug; asserting the
     * rendered cell is the version of that check that could have caught it.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)

        await app.bringToFront()

        /*
         * Opened from the rail, and clicked until it sticks.
         *
         * Both parts are forced by races rather than chosen. ⌘⇧J is out because
         * its listener is registered in a `useEffect`, so there is a window
         * where `.pane` exists — which is all `started` waits for — and the
         * handler does not. A keydown sent into it is dropped in silence.
         *
         * The retry is the more interesting one. `hydrate` applies its result
         * with `set({ ...reconcileWorkspace(saved) })`, and `workspace-layout`
         * always produces a `globalTerminal` — closed, on a fresh profile. So a
         * toggle that lands before hydration is not merely early, it is
         * *overwritten*, and the panel never appears however long the spec then
         * waits. Measured at roughly half of runs.
         *
         * That is a real defect and it is filed as C-038: a person who clicks
         * the terminal in the first moment after launch gets nothing at all. It
         * is not what this spec asks about, so it is worked around rather than
         * asserted.
         *
         * **Delete this loop when C-038 is fixed.** It will not remove itself —
         * it will pass on the first attempt and go on sitting here, reading as
         * though the toggle were unreliable when it no longer is.
         */
        await app.until(`!!document.querySelector('[data-rail-terminal]')`, {
          timeout: 30_000,
          label: 'the rail offers a global terminal',
        })
        let opened = false
        for (let attempt = 0; attempt < 10 && !opened; attempt += 1) {
          await app.evaluate(
            `(() => { document.querySelector('[data-rail-terminal]').click(); return true })()`
          )
          await wait(1000)
          opened =
            (await app.evaluate(`!!document.querySelector('.terminal-panel--global')`)) === true
        }
        assert(opened, 'the global terminal opened')
        await app.settle()
        // The shell has to reach its first prompt, or the write lands in a pty
        // that is still starting and zsh's own init clears it.
        await wait(3000)

        /*
         * Typed at the shell, because the emulator is not reachable from the DOM.
         *
         * Writing to the `Terminal` directly would be the tighter test — it is
         * the same call the push channel makes — but xterm keeps no back
         * reference from its element to the instance, and `_core` is reached
         * from the terminal rather than the node. Tried and returned undefined.
         *
         * `printf` with literal escapes rather than a program whose output is
         * coloured: this has to stay a question about rendering. A spec that ran
         * `git log` would be asserting git's capability detection too, and would
         * fail the day someone exported `NO_COLOR`.
         */
        const paint = async () => {
          const focused = await app.evaluate(`(() => {
            const ta = document.querySelector('.terminal-panel--global .xterm-helper-textarea')
            if (ta === null) return false
            ta.focus()
            return true
          })()`)
          if (focused !== true) return false
          await app.send('Input.insertText', {
            text: `clear; printf '\\033[31mRED\\033[0m \\033[32mGRN\\033[0m \\033[34mBLU\\033[0m\\n'`,
          })
          for (const type of ['keyDown', 'keyUp']) {
            await app.send('Input.dispatchKeyEvent', {
              type,
              key: 'Enter',
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
              text: '\r',
            })
          }
          return true
        }

        const read = () =>
          app.evaluate(`(() => {
            const panel = document.querySelector('.terminal-panel--global')
            const found = {}
            for (const row of panel.querySelectorAll('.xterm-rows > div')) {
              for (const span of row.querySelectorAll('span')) {
                const text = (span.textContent ?? '').trim()
                if (text === 'RED' || text === 'GRN' || text === 'BLU') {
                  found[text] = getComputedStyle(span).color
                }
              }
            }
            const s = getComputedStyle(document.documentElement)
            return {
              found,
              tokens: {
                RED: s.getPropertyValue('--ansi-red').trim(),
                GRN: s.getPropertyValue('--ansi-green').trim(),
                BLU: s.getPropertyValue('--ansi-blue').trim(),
              },
            }
          })()`)

        const schemes = {}
        for (const scheme of ['dark', 'light']) {
          await app.send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-color-scheme', value: scheme }],
          })
          // The theme is re-read on a `matchMedia` change, so the write has to
          // come after the scheme moves or the cells keep the old palette.
          await wait(1200)
          assert((await paint()) === true, `the ${scheme} terminal accepted a write`)
          await wait(2500)
          const { found, tokens } = await read()
          schemes[scheme] = tokens

          for (const cell of ['RED', 'GRN', 'BLU']) {
            const want = hexToRgb(tokens[cell])
            assert(
              found[cell] === want,
              `${scheme}: ${cell} renders its token (${tokens[cell]} -> ${want}), got ${String(found[cell])}`
            )
          }
        }

        /*
         * The control, and the reason the loop above cannot pass vacuously.
         *
         * Both schemes assert "the cell equals the token", which is satisfied by
         * a palette that never changes if the tokens never change either. This is
         * what proves the two palettes are genuinely different, so the equality
         * above is measuring a re-read rather than a constant. C-027 from the
         * inside, again.
         */
        assert(
          schemes.dark.RED !== schemes.light.RED,
          `the two schemes define different reds (dark ${schemes.dark.RED}, light ${schemes.light.RED})`
        )
        await app.send('Emulation.setEmulatedMedia', { features: [] })
      } finally {
        await app.quit()
      }
    },
  },
]
