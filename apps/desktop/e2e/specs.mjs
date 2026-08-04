import { launch, wait } from './harness.mjs'

/**
 * What each spec is here to catch.
 *
 * Every one of these corresponds to a bug that reached the app and was found by
 * hand. They are written as the smallest question that would have caught it.
 */

const PANE = '.pane'
const started = (page) => page.until(`document.querySelectorAll('${PANE}').length > 0`)

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
        await app.evaluate(`(() => {
          const ta = document.querySelector('.composer textarea')
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
            .set.call(ta, 'Reply with exactly: ok')
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          document.querySelector('.composer').requestSubmit()
          return true
        })()`)
        await app.until(`!!document.querySelector('.spend')`, {
          timeout: 180_000,
          label: 'the spend appears once an agent reports usage',
        })
        const shown = await app.evaluate(`document.querySelector('.spend').textContent`)
        assert(/\d/.test(shown), `spend reads as a number: ${shown}`)
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
     */
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await wait(6_000)
        const windows = await app.evaluate(`(() => {
          const now = Date.now()
          return Array.from(document.querySelectorAll('.limit')).map(l => ({
            percent: parseInt(l.querySelector('.limit-percent').textContent, 10),
            reset: l.querySelector('.limit-reset')?.textContent ?? null,
          }))
        })()`)

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
    name: 'panes reorder by drag, and settle',
    // Live sorting thrashed: the axis came from the pane's shape rather than the
    // grid's columns, and decisions were made against panes still animating.
    async run(assert) {
      const app = await launch()
      try {
        await started(app)
        await app.evaluate(
          `Array.from(document.querySelectorAll('.masthead-actions button'))
             .find(b => b.textContent.includes('New session')).click(), true`
        )
        await app.until(`document.querySelectorAll('${PANE}').length === 2`, { timeout: 120_000 })

        const before = await app.evaluate(
          `Array.from(document.querySelectorAll('${PANE}')).map(p => p.dataset.conversation).join(',')`
        )
        const orders = await app.evaluate(`(async () => {
          const panes = document.querySelectorAll('${PANE}')
          const dt = new DataTransfer()
          Object.defineProperty(dt, 'setDragImage', { value: () => {} })
          panes[0].querySelector('.pane-title')
            .dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
          const seen = []
          for (let i = 0; i < 25; i++) {
            const box = document.querySelectorAll('${PANE}')[1].getBoundingClientRect()
            document.querySelectorAll('${PANE}')[1].dispatchEvent(new DragEvent('dragover', {
              bubbles: true, cancelable: true, dataTransfer: dt,
              clientX: box.left + box.width * 0.9, clientY: box.top + box.height / 2,
            }))
            await new Promise((r) => setTimeout(r, 40))
            const now = Array.from(document.querySelectorAll('${PANE}')).map(p => p.dataset.conversation).join(',')
            if (seen[seen.length - 1] !== now) seen.push(now)
          }
          panes[0].querySelector('.pane-title')
            .dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
          return seen
        })()`)

        assert(
          orders.length === 1,
          `one rearrangement across 25 events, not ${String(orders.length)}`
        )
        assert(orders[0] !== before, 'and the order actually changed')
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
]
