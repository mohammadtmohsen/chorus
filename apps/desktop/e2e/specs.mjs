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

/** The ＋ in the sidenav header. It left the masthead when the shell arrived. */
const newSession = (page) =>
  page.evaluate(`(() => {
    // The activity bar's plus, the head having gone.
    document.querySelectorAll('.activity-group:first-child .activity-item')[1].click()
    return true
  })()`)

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

const tabIds = (page) =>
  page.evaluate(
    `Array.from(document.querySelectorAll('${TAB}')).map(t => t.dataset.workspaceTab)`
  )

const clickTab = (page, conversationId) =>
  page.evaluate(`(() => {
    document.querySelector('${TAB}[data-workspace-tab="${conversationId}"]').click()
    return true
  })()`)

const clickSidebarRow = (page, conversationId) =>
  page.evaluate(`(() => {
    document.querySelector('[data-sidebar-conversation="${conversationId}"] .workspace-session-main').click()
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
         * The spend is on the session's card, not under the composer.
         *
         * It moved with the rest of what describes a session rather than a
         * message, and it had to be reduced a second time to get there: the
         * transcript belongs to a mounted pane, and most cards in the list are
         * for sessions that do not have one.
         */
        await app.evaluate(`(() => {
          const ta = document.querySelector('.composer textarea')
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
            .set.call(ta, 'Reply with exactly: ok')
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          document.querySelector('.composer').requestSubmit()
          return true
        })()`)
        await app.until(`!!document.querySelector('.workspace-session-spend')`, {
          timeout: 180_000,
          label: 'the card learns what the session cost',
        })
        const shown = await app.evaluate(
          `document.querySelector('.workspace-session-spend').textContent`
        )
        assert(/\d/.test(shown), `spend reads as a number: ${shown}`)
        await app.settle()


        const both = await app.evaluate(`(() => ({
          card: document.querySelector('.workspace-session-spend')?.textContent ?? null,
          buttons: [...document.querySelectorAll('.workspace-session-output-button')]
            .map(b => b.textContent),
          leftInComposer: document.querySelectorAll(
            '.composer-actions .spend, .composer-actions .voice, .composer-actions .path,' +
            ' .composer-actions .profile-chip, .composer-actions .summary-open'
          ).length,
        }))()`)
        assert(
          both.buttons.length === 2,
          `the card offers both ways to read it, got ${both.buttons.join(',')}`
        )
        /*
         * The composer keeps the one control that acts on what is typed in it.
         *
         * Everything else answers for a session rather than for a message, and
         * a session is what the sidenav lists — so those controls belong to a
         * card, where they exist for all six sessions rather than the one on
         * screen.
         */
        assert(
          both.leftInComposer === 0,
          `and the composer kept none of them, found ${String(both.leftInComposer)}`
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
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await wait(6_000)

        // No panel at all is the API-key case, and saying nothing is right.
        if (!(await app.evaluate(`!!document.querySelector('.activity-usage')`))) {
          assert(true, 'no plan window on this account, and nothing claimed')
          return
        }

        await app.evaluate(`(() => {
          // React derives enter/leave from delegated pointerover/pointerout, so
          // a synthetic pointerenter never reaches the handler.
          document.querySelector('.activity-usage')
            .dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
          return true
        })()`)
        await app.until(`!!document.querySelector('.usage-tip')`, {
          timeout: 10_000,
          label: 'the usage detail opened',
        })
        const windows = await app.evaluate(`(() =>
          Array.from(document.querySelectorAll('.usage-tip .limit')).map((l) => ({
            percent: parseInt(l.querySelector('.limit-percent').textContent, 10),
            reset: l.querySelector('.limit-reset')?.textContent ?? null,
          })))()`)

        if (windows.length === 0) {
          assert(true, 'no plan window on this account, and nothing claimed')
          return
        }
        assert(
          windows.every((w) => Number.isNaN(w.percent) || (w.percent >= 0 && w.percent <= 100)),
          `every percentage in range: ${JSON.stringify(windows)}`
        )
        assert(
          windows.every((w) => w.reset === null || !w.reset.includes('now')),
          'no window resetting "now", which is what seconds read as milliseconds looks like'
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'the voice rail runs through its own dots',
    // It sat 15px to the left for months: the rail was measured from the
    // scroller and every dot from its entry.
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await app.until(`document.querySelectorAll('.tick').length > 0`)
        const offsets = await app.evaluate(`(() => {
          const rail = document.querySelector('.rail').getBoundingClientRect()
          const centre = rail.left + rail.width / 2
          return Array.from(document.querySelectorAll('.tick')).map(t => {
            const r = t.getBoundingClientRect()
            return Math.abs(r.left + r.width / 2 - centre)
          })
        })()`)
        assert(
          offsets.every((off) => off <= 1),
          `every dot on the rail (worst ${String(Math.max(...offsets))}px)`
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
          `document.querySelector('[data-sidebar-conversation="${first}"]').dataset.state`
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
          (await app.evaluate(
            `document.querySelector('.split-branch').dataset.orientation`
          )) === 'row',
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
        await app.until(
          `document.querySelector('${PANE}')?.dataset.conversation === '${first}'`
        )
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
        await app.until(
          `document.querySelector('${PANE}')?.dataset.conversation === '${second}'`
        )
        assert(
          (await app.evaluate(
            `!document.querySelector('${PANE}[data-conversation="${first}"]')`
          )) === true,
          'the background session left the DOM entirely'
        )

        await clickTab(app, first)
        await app.until(
          `document.querySelector('${PANE}')?.dataset.conversation === '${first}'`
        )
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
    name: 'a sidenav row renames inline and drags into a new order',
    /*
     * Both gestures live on the same element and can smother each other: the
     * row is a button that opens a session on click, so a rename that did not
     * replace it would have the button eating the caret, and a drag that did
     * not suppress its click would open the session it was only being moved
     * past. Asserted together for that reason.
     */
    async run(assert) {
      const app = await launch()
      try {
        const [first] = await twoSessions(app)
        const order = () =>
          app.evaluate(
            `Array.from(document.querySelectorAll('[data-sidebar-conversation]'))
               .map(r => r.dataset.sidebarConversation)`
          )
        const before = await order()
        assert(before.length === 2, `both sessions are listed flat, got ${before.length}`)
        assert(
          (await app.evaluate(`document.querySelectorAll('.workspace-group-label').length`)) === 0,
          'and not under a folder heading'
        )

        /*
         * The card carries what the composer's footer says about a session, and
         * its own Restart and End — the tab's context menu is gone, so this is
         * where those live. A wrapper with a button inside it, because a button
         * cannot contain buttons; the nesting check is the part that would fail
         * silently in the DOM rather than loudly in a test.
         */
        const card = await app.evaluate(`(() => {
          const row = document.querySelector('[data-sidebar-conversation="${first}"]')
          const main = row.querySelector('.workspace-session-main')
          return {
            path: row.querySelector('.workspace-session-path')?.textContent ?? null,
            profile: row.querySelector('.workspace-session-profile')?.textContent ?? null,
            actions: [...row.querySelectorAll('.workspace-session-action')].length,
            agents: row.querySelectorAll('.workspace-session-agents .voice').length,
            agentsAreButtons: [...row.querySelectorAll('.workspace-session-agents .voice')]
              .every(b => b.tagName === 'BUTTON' && b.hasAttribute('aria-pressed')),
            nestedButtons: main.querySelectorAll('button').length,
            actionsVisible:
              getComputedStyle(row.querySelector('.workspace-session-actions')).opacity === '1',
            /* clientWidth, not the bounding box: the card is border-box, so
               the head spans its inner width and is 2px narrower. */
            headIsFullWidth:
              Math.round(row.querySelector('.workspace-session-main').getBoundingClientRect().width) ===
              row.clientWidth,
            headCursor: getComputedStyle(row.querySelector('.workspace-session-main')).cursor,
            menus: document.querySelectorAll('.workspace-context-menu').length,
          }
        })()`)
        assert(card.path !== null && card.profile !== null, 'the row shows its path and profile')
        assert(card.agents === 2, `and every agent, seated or not (${String(card.agents)})`)
        assert(card.agentsAreButtons, 'as the composer\'s own switches, not labels')

        /*
         * Three lines, and every one of them fits at the narrowest the sidebar
         * can be dragged to.
         *
         * On two lines the agents shared a row with the path and the profile,
         * which overflowed a 240px card by 31px — the action buttons hold their
         * width at rest, so the row does not jump when a pointer crosses it, and
         * that is what squeezed it. A line each removed the need for the
         * container query that had been shedding the agents' names to fit.
         * Setting the variable stands in for the drag the resize spec covers.
         */
        const narrow = await app.evaluate(`(() => {
          document.documentElement.style.setProperty('--sidebar', '240px')
          const row = document.querySelector('.workspace-session-row')
          const over = (s) => {
            const e = row.querySelector(s)
            return e.scrollWidth - e.clientWidth
          }
          return {
            lines: [
              over('.workspace-session-line'),
              over('.workspace-session-agents'),
              over('.workspace-session-body'),
            ],
            namesStillShown:
              getComputedStyle(row.querySelector('.workspace-session-agents .voice')).fontSize !==
              '0px',
          }
        })()`)
        assert(
          narrow.lines.every((n) => n === 0),
          `at 240px no line overflows (${narrow.lines.join(',')})`
        )
        assert(narrow.namesStillShown, 'and the agents keep their names')
        await app.evaluate(
          `(document.documentElement.style.removeProperty('--sidebar'), true)`
        )
        assert(card.actions === 2, `Restart and End sit on it, got ${String(card.actions)}`)
        assert(card.nestedButtons === 0, 'and no button is nested inside another')
        assert(card.actionsVisible, 'and are visible without hovering the row')
        assert(
          card.headIsFullWidth,
          'the head is the whole band, so a click near the name lands on it'
        )
        assert(card.headCursor === 'pointer', 'and says so with the pointer')

        /*
         * A folder can be typed, and a session can have none.
         *
         * The runtime has always read an empty directory as "start at home" — a
         * directory is a starting point, not a boundary — but it resolved that
         * before the renderer saw it, so a session that was never given a
         * project looked exactly like one deliberately pointed at home, and
         * there was no way to say "no particular folder" back. The card names
         * that state and can return to it.
         */
        const folder = () =>
          app.evaluate(`(() => {
            const el = document.querySelector('[data-sidebar-conversation="${first}"] .workspace-session-path')
            return { tag: el.tagName, text: el.textContent || el.value, empty: el.dataset.empty ?? null }
          })()`)
        const editFolder = async (value) => {
          await app.evaluate(`(() => {
            document.querySelector('[data-sidebar-conversation="${first}"] .workspace-session-path')
              .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
            return true
          })()`)
          await app.until(
            `document.querySelector('[data-sidebar-conversation="${first}"] .workspace-session-path').tagName === 'INPUT'`,
            { timeout: 15_000, label: 'the folder field opened' }
          )
          await app.evaluate(`(() => {
            const f = document.querySelector('[data-sidebar-conversation="${first}"] .workspace-session-path')
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
              .set.call(f, ${JSON.stringify(value)})
            f.dispatchEvent(new Event('input', { bubbles: true }))
            f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
            return true
          })()`)
        }

        const atStart = await folder()
        assert(
          atStart.empty === 'true',
          `a session starts with no folder of its own, got ${atStart.text}`
        )

        await editFolder('/tmp')
        await app.until(
          `document.querySelector('[data-sidebar-conversation="${first}"] .workspace-session-path').dataset.empty === 'false'`,
          { timeout: 20_000, label: 'the typed folder took' }
        )
        assert(true, 'and a path can be typed rather than only picked')

        /*
         * And one click gives it back.
         *
         * Emptying the field works and nobody finds it — "double-click, select
         * all, delete, Enter" is not a gesture. The × only exists when there is
         * a folder to drop, and sits beside the path rather than in the actions
         * column, because the card's other × ends the session.
         */
        const clear = await app.evaluate(`(() => {
          const row = document.querySelector('[data-sidebar-conversation="${first}"]')
          const x = row.querySelector('.workspace-session-folder-clear')
          const end = row.querySelector('.workspace-session-action--end')
          return {
            present: x !== null,
            clearOfTheEndButton:
              x && end ? end.getBoundingClientRect().left - x.getBoundingClientRect().right > 40 : false,
          }
        })()`)
        assert(clear.present, 'a folder can be dropped without editing anything')
        assert(clear.clearOfTheEndButton, 'and its × is nowhere near the one that ends the session')

        await app.evaluate(`(() => {
          document.querySelector('[data-sidebar-conversation="${first}"] .workspace-session-folder-clear').click()
          return true
        })()`)
        await app.until(
          `document.querySelector('[data-sidebar-conversation="${first}"] .workspace-session-path').dataset.empty === 'true'`,
          { timeout: 20_000, label: 'the folder went back to none' }
        )
        assert(
          (await app.evaluate(
            `!document.querySelector('[data-sidebar-conversation="${first}"] .workspace-session-folder-clear')`
          )) === true,
          'and the × goes with it, there being nothing left to clear'
        )

        /*
         * The profile menu has to leave the sidebar's subtree entirely.
         *
         * The sidebar carries a `transform` for its slide, which makes it the
         * containing block for anything `position: fixed` inside it — so a
         * fixed menu was positioned against the sidebar and then clipped by its
         * `overflow`. Being wider than the sidebar, it lost its right-hand
         * half. Only a portal escapes both that and the list's own scrolling.
         */
        await app.evaluate(`(() => {
          const chip = document.querySelector('.workspace-session-profile .profile-chip')
          chip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
          chip.click()
          return true
        })()`)
        await app.until(`!!document.querySelector('.workspace-session-profile-menu')`, {
          timeout: 15_000,
          label: 'the profile menu opened',
        })
        const menu = await app.evaluate(`(() => {
          const el = document.querySelector('.workspace-session-profile-menu')
          const m = el.getBoundingClientRect()
          const side = document.querySelector('.workspace-sidebar').getBoundingClientRect()
          return {
            inSidebar: document.querySelector('.workspace-sidebar').contains(el),
            spillsPastSidebar: m.right > side.right,
            fitsWindow: m.left >= 0 && m.right <= innerWidth && m.top >= 0 && m.bottom <= innerHeight,
            options: el.querySelectorAll('.profile-option-summary').length,
          }
        })()`)
        assert(!menu.inSidebar, 'the profile menu is portalled clear of the sidebar')
        assert(
          menu.spillsPastSidebar,
          'reaching past its right edge, which is what used to be cut off'
        )
        assert(menu.fitsWindow, 'and it is placed inside the window')
        assert(menu.options >= 2, `with what each profile permits, not just its name (${String(menu.options)})`)
        await app.evaluate(`(() => {
          document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
          return true
        })()`)
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelectorAll('.workspace-session-profile-menu').length`)) === 0,
          'and a click anywhere else closes it'
        )

        // Right-clicking a tab used to open a menu. It should do nothing now.
        await app.evaluate(`(() => {
          document.querySelector('${TAB}')
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
          return true
        })()`)
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelectorAll('.workspace-context-menu').length`)) === 0,
          'and the tab context menu is gone'
        )

        // Double-click swaps the row for a field, which is the only way a
        // caret can land inside what is otherwise a button.
        await app.evaluate(`(() => {
          document.querySelector('[data-sidebar-conversation="${first}"] .workspace-session-main')
            .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          return true
        })()`)
        await app.until(`!!document.querySelector('.workspace-session-rename')`, {
          label: 'the rename field opened',
        })
        await app.evaluate(`(() => {
          const field = document.querySelector('.workspace-session-rename')
          field.value = 'renamed-inline'
          field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          return true
        })()`)
        await app.until(
          `document.querySelector('[data-sidebar-conversation="${first}"]')
             ?.innerText.includes('renamed-inline')`,
          { label: 'the new name reached the row' }
        )

        // Drag the first row past the second. The row midpoints are snapshotted
        // at drag start, so the pointer only has to clear the lower one.
        await app.evaluate(`(() => {
          const rows = document.querySelectorAll('[data-sidebar-conversation]')
          const from = rows[0].getBoundingClientRect()
          const to = rows[1].getBoundingClientRect()
          const x = from.left + from.width / 2
          /*
           * Grabbed by the body, not the head.
           *
           * The grip used to be the head alone — a third of the card — so the
           * other two thirds looked draggable and were not, and a spec that
           * always grabbed the head could never see it.
           */
          rows[0].querySelector('.workspace-session-body').dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1, button: 0, bubbles: true, cancelable: true,
            clientX: x, clientY: from.top + from.height / 2,
          }))
          document.dispatchEvent(new PointerEvent('pointermove', {
            pointerId: 1, bubbles: true, clientX: x, clientY: to.bottom + 4,
          }))
          document.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 1, bubbles: true, clientX: x, clientY: to.bottom + 4,
          }))
          return true
        })()`)
        await app.settle()
        const after = await order()
        assert(
          after[0] === before[1] && after[1] === before[0],
          `the dragged row took the other's place, got ${after.join(',')}`
        )
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'the sidenav docks at every width and never floats over the editor',
    /*
     * It used to go over the editor below 760px. That is gone: a panel that
     * changes what it *is* at a width boundary is a second layout to learn, and
     * the one it changed into covered the thing you were reading.
     *
     * What replaces it is arithmetic rather than a second mode — `fitSidebar`
     * holds the width to half the window on every resize, so a narrow window
     * gets a narrower sidenav instead of a sidenav and nowhere to read.
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        const shell = () =>
          app.evaluate(`(() => {
            const side = document.querySelector('.workspace-sidebar')
            const editor = document.querySelector('.workspace-editor')
            const handle = document.querySelector('.workspace-sidebar-resize')
            return {
              window: innerWidth,
              editorLeft: Math.round(editor.getBoundingClientRect().left),
              sidebarRight: Math.round(side.getBoundingClientRect().right),
              sidebar: Math.round(side.getBoundingClientRect().width),
              handle: handle === null ? 'absent' : getComputedStyle(handle).display,
            }
          })()`)

        /*
         * Waits for the width the *new* window allows, not merely for the
         * column to agree with the variable.
         *
         * Agreement is already true the instant the viewport changes — nothing
         * has moved yet — so waiting on it measured the old width and passed
         * whenever the refit happened to land first. It did in isolation and
         * did not in a full run, which is the failure telling the truth.
         */
        const settled = async () => {
          await app.until(
            `(() => {
              const ceiling = Math.max(240, Math.round(innerWidth / 2))
              const want = Math.min(
                Math.round(parseFloat(
                  getComputedStyle(document.documentElement).getPropertyValue('--sidebar'))),
                ceiling
              )
              const have = Math.round(
                document.querySelector('.workspace-sidebar').getBoundingClientRect().width)
              return have <= ceiling && Math.abs(have - want) <= 2
            })()`,
            { timeout: 15_000, label: 'the column refitted to the window' }
          )
          return shell()
        }

        for (const width of [1280, 700, 480]) {
          if (width !== 1280) await app.viewport(width, 800)
          const now = await settled()
          assert(
            now.editorLeft === now.sidebarRight && now.sidebarRight > 0,
            `at ${String(now.window)}px the editor still starts where the sidenav ends (${String(now.editorLeft)} vs ${String(now.sidebarRight)})`
          )
          assert(
            now.handle === 'block',
            `and its edge is still draggable at ${String(now.window)}px`
          )
          /*
           * Half the window or the 240px floor, whichever is larger — the floor
           * wins on the narrowest windows, which is deliberate: a sidenav too
           * narrow to read a session name in is not worth the space it saves.
           */
          const ceiling = Math.max(240, Math.round(now.window / 2))
          assert(
            now.sidebar <= ceiling,
            `and it leaves room to read: ${String(now.sidebar)} of ${String(now.window)}`
          )
        }

        await app.viewport()
      } finally {
        await app.quit()
      }
    },
  },

  {
    name: 'the sidenav resizes, clamps, and comes back that width',
    /*
     * The width is the one piece of sidebar state that does not go through
     * React while it is changing — the drag writes `--sidebar` straight onto
     * the document element so a live transcript is not re-rendered sixty times
     * a second, and only commits to the store on release. That split is easy to
     * get half right: an edge that moves and never persists, or one that
     * persists and does not move.
     */
    async run(assert) {
      const first = await launch({ keepData: true })
      const dataPath = first.dataPath
      try {
        await started(first)
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
            /*
             * Where the card's edge actually landed, not what the variable
             * says. The variable is the column's own width and the pointer is a
             * window coordinate; those stopped being the same number when the
             * activity bar took the first 60px, and asserting on the variable
             * quietly encoded the old geometry.
             */
            const during = Math.round(
              document.querySelector('.workspace-sidebar').getBoundingClientRect().right)
            document.dispatchEvent(new PointerEvent('pointerup', {
              pointerId: 1, bubbles: true, clientX: ${String(toX)}, clientY: y,
            }))
            return during
          })()`)
        const editorLeft = () =>
          first.evaluate(
            `Math.round(document.querySelector('.workspace-editor').getBoundingClientRect().left)`
          )

        const sidebarRight = () =>
          first.evaluate(
            `Math.round(document.querySelector('.workspace-sidebar').getBoundingClientRect().right)`
          )

        const before = await editorLeft()
        const during = await drag(500)
        assert(
          Math.abs(during - 500) <= 2,
          `the edge lands under the pointer mid-drag, got ${String(during)} for 500`
        )
        await first.settle()
        const after = await editorLeft()
        assert(after !== before, `the editor moved with it (${before} → ${after})`)
        /*
         * Against the card's own edge rather than a fixed number: the editor
         * starts after the activity bar as well as the card now, so the pixel
         * the drag asked for is no longer the pixel the editor lands on. The
         * invariant that survives the layout is that they meet.
         */
        assert(
          after === (await sidebarRight()),
          `and lands against it, not at some absolute (${after})`
        )

        // Well past the maximum: a width nobody can read past is refused.
        await drag(2000)
        await first.settle()
        /*
         * The stored width itself, rather than a number derived from where the
         * editor starts: the editor's left is the bar, plus the column's
         * margin, plus the card — so deriving the width back out of it merely
         * re-states the layout arithmetic, and gets it wrong by a margin.
         */
        const clampedWidth = await first.evaluate(
          `Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar')))`
        )
        assert(
          clampedWidth === 640,
          `dragged past the limit, the column clamps to 640, got ${String(clampedWidth)}`
        )

        /*
         * A width remembered from a wide window must not swallow a narrow one.
         * An unfitted 640 in a 900px window leaves the editor a sliver — the
         * stored value is kept, but what is shown is fitted to the room, which
         * is half the window.
         */
        await first.viewport(900, 800)
        /*
         * Wait on the editor, which is the last link in the chain.
         *
         * The refit runs off a resize listener and writes the sidebar variable,
         * which the column reads through a 300ms width transition. Waiting for
         * the variable and then measuring the editor
         * catches it mid-animation — which is a slower, quieter version of the
         * fixed sleep this replaced.
         */
        await first.until(
          `(() => {
            const side = document.querySelector('.workspace-sidebar').getBoundingClientRect()
            const editor = document.querySelector('.workspace-editor').getBoundingClientRect()
            // Half of 900, with the editor against its edge.
            return Math.abs(Math.round(side.width) - 450) <= 2 &&
              Math.round(editor.left) === Math.round(side.right)
          })()`,
          { timeout: 15_000, label: 'the sidebar refitted and the editor followed it' }
        )
        const fitted = await first.evaluate(
          `getComputedStyle(document.documentElement).getPropertyValue('--sidebar').trim()`
        )
        assert(fitted === '450px', `fitted to half a narrower window, got ${fitted}`)
        // Against the column's edge — the editor starts after the bar as well.
        assert(
          (await editorLeft()) === (await sidebarRight()),
          `and the editor keeps the rest (${String(await editorLeft())})`
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
        // 640 rather than the 450 it was fitted to: what gets remembered is
        // the width chosen, not the compromise a smaller window imposed.
        assert(restored === '640px', `the width survived the relaunch, got ${restored}`)
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
        await app.until(`!!document.querySelector('.turn-head .entry--thinking')`, {
          label: 'an agent is thinking under the question',
        })
        await wait(400)

        const waiting = await app.evaluate(`(() => {
          const score = document.querySelector('.score').getBoundingClientRect()
          const head = document.querySelector('.turn-head')
          const asked = head.querySelector('.entry--user')
          const think = head.querySelectorAll('.entry--thinking')
          const rail = document.querySelector('.rail').getBoundingClientRect()
          const mine = document.querySelector('.rail--turn')?.getBoundingClientRect() ?? null
          return {
            heads: document.querySelectorAll('.turn-head').length,
            says: asked.innerText.includes('markdown numbered list'),
            offTop: Math.abs(head.getBoundingClientRect().top - score.top),
            gaps: Array.from(think).map(t =>
              t.getBoundingClientRect().top - asked.getBoundingClientRect().bottom),
            speakers: Array.from(think).map(t => t.querySelector('.speaker').textContent),
            offRail: mine === null
              ? null
              : Math.abs(rail.left + rail.width / 2 - (mine.left + mine.width / 2)),
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
        assert(waiting.offRail !== null, 'the rail is redrawn through the pinned header')
        assert(
          waiting.offRail <= 1,
          `and on the same line as the rest of it (${String(waiting.offRail)}px off)`
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
            waiting: Array.from(head.querySelectorAll('.entry--thinking')).map(named),
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
          const rail = document.querySelector('.rail--turn')?.getBoundingClientRect() ?? null
          const tick = asked.querySelector('.tick').getBoundingClientRect()
          return {
            width: score.clientWidth,
            offTop: Math.abs(head.getBoundingClientRect().top - box.top),
            sideways: score.scrollWidth - score.clientWidth,
            spills: asked.getBoundingClientRect().right - box.right,
            offRail: rail === null
              ? null
              : Math.abs(rail.left + rail.width / 2 - (tick.left + tick.width / 2)),
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
          narrow.offRail !== null && narrow.offRail <= 1,
          `the rail still runs through its dot in the compact gutter (${String(narrow.offRail)}px off)`
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
         * Claude is the agent whose AskUserQuestion tool this path serves.
         *
         * Waited for rather than sampled. The chip is disabled until the probe
         * that finds the CLIs comes back, so reading `disabled` on the first
         * frame calls an installed agent missing — and the spec then skips
         * itself and reports green, which is the one outcome worse than failing.
         */
        const chip = `Array.from(document.querySelectorAll('.voices--pane .voice'))
          .find(b => b.textContent.trim() === 'claude')`
        let usable = true
        try {
          await app.until(`(() => { const b = ${chip}; return !!b && !b.disabled })()`, {
            timeout: 60_000,
            label: 'the claude chip settled',
          })
        } catch {
          usable = false
        }
        if (!usable) {
          assert(true, 'claude is not installed on this machine, and nothing is claimed')
          return
        }
        await app.evaluate(`(() => {
          const btn = ${chip}
          if (btn.dataset.on !== 'true') btn.click()
          return true
        })()`)
        await app.until(
          `Array.from(document.querySelectorAll('.voices--pane .voice'))
             .some(b => b.textContent.trim() === 'claude' && b.dataset.on === 'true')`,
          { timeout: 120_000, label: 'claude joined the conversation' }
        )

        await say(
          app,
          '@claude Use your AskUserQuestion tool right now to ask me one question: "Which colour?" with options Red and Blue. Do not answer it yourself, just ask.'
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
         * The point of the whole path: the agent is unblocked, and it was the
         * answer that unblocked it.
         *
         * Asserted as "the turn finished and nothing expired" rather than by
         * looking for the chosen word in the reply. An agent is free to
         * acknowledge a choice without repeating it, and a spec that requires it
         * to fails on a turn of phrase — which says nothing about whether the
         * answer arrived. The deadline is the thing being ruled out, and it
         * writes itself into the transcript when it fires.
         */
        await app.until(`!document.querySelector('.send--stop')`, {
          timeout: 180_000,
          label: 'the agent finished its turn',
        })
        const expired = await app.evaluate(
          `Array.from(document.querySelectorAll('.entry--system')).some(e => /unanswered in time/.test(e.innerText))`
        )
        assert(expired === false, 'the answer reached the agent rather than the deadline')
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
          buttons: document.querySelectorAll('.composer-tools button').length,
        }))()`)
        assert(typed.send && !typed.stop, 'and typing turns that same button into Send')
        assert(typed.buttons === 1, `never two of them, got ${String(typed.buttons)}`)

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
        await say(app, 'Run these three bash commands one at a time: pwd ; date ; echo hello. Then reply with a one sentence summary.')
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
        assert(
          folds.expanded === 0,
          `every one of them is folded, ${folds.expanded} were not`
        )
        assert(
          folds.heights.every((h) => h < 40),
          `and each is a line rather than a block, got ${folds.heights.join(',')}`
        )

        // The fold is a fold, not a truncation.
        await app.evaluate(`(() => { document.querySelector('.command-summary').click(); return true })()`)
        await app.settle()
        assert(
          (await app.evaluate(`document.querySelectorAll('.command-fold pre.command').length`)) === 1,
          'and opens on click'
        )

        const answer = await app.evaluate(`(() => {
          const final = document.querySelector('.entry[data-final="true"]')
          if (!final) return null
          const agentMessages = [...document.querySelectorAll('.entry--message')]
            .filter(e => e.classList.contains('entry--codex') || e.classList.contains('entry--claude'))
          const said = getComputedStyle(final.querySelector('.said'))
          return {
            isLast: final === agentMessages.at(-1),
            count: document.querySelectorAll('.entry[data-final="true"]').length,
            /* Must out-rank \`data-answer\`, which every reply after a block of
               thinking already carries — a filled panel, not a hairline. */
            border: said.borderLeftWidth,
            filled: said.backgroundColor !== 'rgba(0, 0, 0, 0)',
          }
        })()`)
        assert(answer !== null, 'the finished turn marks a final answer')
        assert(answer.count === 1, `exactly one, got ${String(answer?.count)}`)
        assert(answer.isLast, 'and it is the last thing the agent said')
        assert(
          answer.filled && answer.border === '3px',
          `drawn as a panel rather than another bordered line (${String(answer?.border)}, filled ${String(answer?.filled)})`
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
        const [root] = await ide.awaitRoots()

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
]
