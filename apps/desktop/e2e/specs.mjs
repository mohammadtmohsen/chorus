import { launch, wait } from './harness.mjs'

/**
 * What each spec is here to catch.
 *
 * Every one of these corresponds to a bug that reached the app and was found by
 * hand. They are written as the smallest question that would have caught it.
 */

const PANE = '.pane'
const started = (page) => page.until(`document.querySelectorAll('${PANE}').length > 0`)

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

        // Claude is the agent whose AskUserQuestion tool this path serves.
        const added = await app.evaluate(`(() => {
          const btn = Array.from(document.querySelectorAll('.voices--pane .voice'))
            .find(b => b.textContent.trim() === 'claude')
          if (!btn || btn.disabled) return 'unavailable'
          if (btn.dataset.on === 'true') return 'already here'
          btn.click()
          return 'clicked'
        })()`)
        if (added === 'unavailable') {
          assert(true, 'claude is not installed on this machine, and nothing is claimed')
          return
        }
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

        // The point of the whole path: the agent is unblocked and has the answer.
        await app.until(
          `Array.from(document.querySelectorAll('.entry--claude')).some(e => /red/i.test(e.innerText))`,
          { timeout: 180_000, label: 'the agent received the answer' }
        )
        assert(true, 'and the answer reached the agent, which is what was broken')
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
