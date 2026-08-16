import { describe, expect, it } from 'vitest'
import {
  asideHeading,
  asideState,
  fitCard,
  opensWithATurn,
  promotion,
  recapPromotion,
} from './aside.js'
import { EMPTY_VIEW, type TranscriptMessage, type TranscriptView } from './transcript.js'

const said = (over: Partial<TranscriptMessage>): TranscriptMessage => ({
  key: 'k',
  actor: 'claude',
  kind: 'message',
  text: '',
  status: 'complete',
  eventId: 'e',
  at: 0,
  ...over,
})

const view = (over: Partial<TranscriptView>): TranscriptView => ({ ...EMPTY_VIEW, ...over })

describe('asideState', () => {
  it('is empty before anything comes back', () => {
    expect(asideState(EMPTY_VIEW)).toMatchObject({ answer: '', working: false, answered: false })
  })

  it('shows what the agent said', () => {
    const state = asideState(view({ messages: [said({ text: 'It lags by one turn.' })] }))
    expect(state.answer).toBe('It lags by one turn.')
    expect(state.answered).toBe(true)
  })

  /*
   * The card is a two-way exchange, and these are the properties that make it
   * one. Before this the reducer kept only the agent's half, joined end to end —
   * so a second question had nowhere to appear and its answer ran on from the
   * first, which read as the follow-up having overwritten what it followed.
   */
  it('keeps both sides, in the order they were said', () => {
    const state = asideState(
      view({
        messages: [
          said({ key: 'a', actor: 'user', text: 'where are we?' }),
          said({ key: 'b', text: 'The projection lags.' }),
          said({ key: 'c', actor: 'user', text: 'run the tests' }),
          said({ key: 'd', text: 'All green.' }),
        ],
      })
    )
    expect(state.turns.map((t) => `${t.actor}:${t.text}`)).toEqual([
      'user:where are we?',
      'agent:The projection lags.',
      'user:run the tests',
      'agent:All green.',
    ])
  })

  it('leaves the system half of the log out of the exchange', () => {
    // `joined` and the like are real messages in an aside's log, and neither of
    // the two people in the card said them.
    const state = asideState(
      view({
        messages: [
          said({ key: 'a', actor: 'system', text: 'claude joined' }),
          said({ key: 'b', text: 'It lags.' }),
        ],
      })
    )
    expect(state.turns).toHaveLength(1)
    expect(state.turns[0]?.actor).toBe('agent')
  })

  it('marks a turn that is still arriving, so the card can show a caret', () => {
    const state = asideState(view({ busy: true, messages: [said({ status: 'streaming' })] }))
    expect(state.turns[0]?.streaming).toBe(true)
  })

  /*
   * `answer` is what `promotion` seeds a real conversation with, so it stays the
   * agent's words alone. A seed containing the user's own questions back would
   * open the promoted room by telling the agent what it had just been asked.
   */
  it('keeps `answer` to the agent half, even though `turns` has both', () => {
    const state = asideState(
      view({
        messages: [
          said({ key: 'a', actor: 'user', text: 'where are we?' }),
          said({ key: 'b', text: 'It lags.' }),
        ],
      })
    )
    expect(state.answer).toBe('It lags.')
    expect(state.turns).toHaveLength(2)
  })

  it('drops reasoning and tool rows, which two-way did not change', () => {
    const state = asideState(
      view({
        messages: [
          said({ key: 'a', kind: 'reasoning', text: 'thinking' }),
          said({ key: 'b', kind: 'command', text: 'ls' }),
          said({ key: 'c', text: 'It lags.' }),
        ],
      })
    )
    expect(state.turns.map((t) => t.text)).toEqual(['It lags.'])
  })

  it('is working, not answered, while the turn is open', () => {
    const state = asideState(view({ busy: true, messages: [said({ text: 'It lags' })] }))
    expect(state.working).toBe(true)
    // The card shows a pending state rather than a half-sentence presented as
    // the answer.
    expect(state.answered).toBe(false)
  })

  it('drops the agent’s working, which the card has no room for', () => {
    const state = asideState(
      view({
        messages: [
          said({ kind: 'reasoning', text: 'thinking about the projection' }),
          said({ kind: 'command', text: 'git log' }),
          said({ kind: 'tool', text: 'Read' }),
          said({ text: 'It lags by one turn.' }),
        ],
      })
    )
    expect(state.answer).toBe('It lags by one turn.')
  })

  it('ignores the question it was asked', () => {
    const state = asideState(
      view({
        messages: [
          said({ actor: 'user', text: 'what does that mean?' }),
          said({ text: 'It lags.' }),
        ],
      })
    )
    expect(state.answer).toBe('It lags.')
  })

  it('surfaces a refusal, because silence reads as a bug', () => {
    const state = asideState(
      view({ messages: [said({ kind: 'notice', level: 'error', text: 'It declined to act.' })] })
    )
    expect(state.failed).toBe('It declined to act.')
  })

  it('shows the latest failure, not the one that was recovered from', () => {
    const state = asideState(
      view({
        messages: [
          said({ kind: 'notice', level: 'error', text: 'first' }),
          said({ kind: 'notice', level: 'error', text: 'second' }),
        ],
      })
    )
    expect(state.failed).toBe('second')
  })
})

describe('promotion', () => {
  const staged = promotion('claude', 'The projection lags', 'It lags by one turn, then catches up.')

  it('mentions the author, because routing is by mention', () => {
    // `runtime.send` falls back to `lastAddressed` without one, which in a
    // two-agent room is not a guarantee of reaching the passage's author.
    expect(staged.startsWith('@claude')).toBe(true)
  })

  it('carries the passage and the answer, so it stands alone', () => {
    expect(staged).toContain('> The projection lags')
    expect(staged).toContain('> It lags by one turn, then catches up.')
  })

  it('says the answer came from somewhere the agent cannot remember', () => {
    // Without this the agent is handed an explanation in its own voice that its
    // context has no record of it giving.
    expect(staged).toContain('not in this conversation')
  })

  it('quotes a multi-line answer as one block', () => {
    const multi = promotion('codex', 'x', 'one\n\ntwo')
    expect(multi).toContain('> one\n>\n> two')
  })
})

describe('fitCard', () => {
  /** A band starting at zero — what a box positioned in the pane sees. */
  const pane = { width: 800, top: 0, bottom: 600 }
  const card = { width: 400, height: 350 }
  /** A passage 22px tall, centred horizontally, with its top at `top`. */
  const passage = (top: number, centreX = 400) =>
    ({ space: 'pane', centreX, top, height: 22 }) as const

  it('hangs above the passage when there is room', () => {
    const at = fitCard(passage(500), pane, card)
    expect(at.top).toBe(500 - 350 - 8)
    expect(at.left).toBe(200)
  })

  it('clears the passage when it cannot fit above', () => {
    // The bug two positioners used to produce between them: dropping to the
    // anchor put the box on top of the very words it was quoting.
    const at = fitCard(passage(60), pane, card)
    expect(at.top).toBeGreaterThanOrEqual(60 + 22)
  })

  it('never leaves it clipped off the top', () => {
    expect(fitCard(passage(20), pane, card).top).toBeGreaterThanOrEqual(4)
  })

  it('never leaves it hanging off the bottom', () => {
    const at = fitCard(passage(590), pane, card)
    expect(at.top + card.height).toBeLessThanOrEqual(pane.bottom)
  })

  it('clamps to the left edge', () => {
    expect(fitCard(passage(500, 10), pane, card).left).toBe(4)
  })

  it('clamps to the right edge', () => {
    expect(fitCard(passage(500, 790), pane, card).left).toBe(800 - 400 - 4)
  })

  it('centres a box wider than its pane', () => {
    // Measured once at a 200px pane: clamping the left edge on screen pushed a
    // 237px offer off the right. Centring is the only placement symmetric about
    // an overflow that cannot be removed.
    const at = fitCard(passage(400, 100), { width: 300, top: 0, bottom: 600 }, card)
    expect(at.left).toBe((300 - 400) / 2)
  })

  it('is fully visible even when it fits neither above nor below', () => {
    const tight = { width: 800, top: 0, bottom: 400 }
    const at = fitCard(passage(200), tight, card)
    expect(at.top).toBeGreaterThanOrEqual(4)
    expect(at.top + card.height).toBeLessThanOrEqual(tight.bottom)
  })

  /*
   * The case that could not happen before the offer moved into the scroller,
   * and the one the whole coordinate change turns on: what is visible is a
   * window partway down a much taller box, so the band does not start at zero.
   * Reading it as a height would park the offer at the top of the transcript.
   */
  describe('a band that does not start at zero', () => {
    // Scrolled 1000px down a long transcript; 15px of scroller padding means the
    // visible band begins a little above the content box's own origin.
    const scrolled = { width: 800, top: 985, bottom: 1585 }

    it('hangs above a passage that is far down the content', () => {
      const at = fitCard(passage(1400), scrolled, card)
      expect(at.top).toBe(1400 - 350 - 8)
    })

    it('clamps to the top of what is visible, not to the top of the content', () => {
      // The failure this pins: `Math.max(margin, …)` against a zero-based band
      // returns 4, which is a thousand pixels above the scrollport.
      const at = fitCard(passage(1000), scrolled, card)
      expect(at.top).toBeGreaterThanOrEqual(scrolled.top + 4)
    })

    it('clamps to the bottom of what is visible', () => {
      const at = fitCard(passage(1575), scrolled, card)
      expect(at.top + card.height).toBeLessThanOrEqual(scrolled.bottom)
    })
  })

  it('positions a small box from the same passage', () => {
    // The offer and the card go through this together now. One positioner cannot
    // disagree with itself about which edge `top` means.
    const at = fitCard(passage(500), pane, { width: 240, height: 30 })
    expect(at.top).toBe(500 - 30 - 8)
    expect(at.left).toBe(400 - 120)
  })
})

describe('asideHeading', () => {
  it('names the agent for a question, which has no language', () => {
    expect(asideHeading('question', '', 'claude')).toEqual({
      key: 'aside.heading',
      vars: { agent: 'claude' },
    })
  })

  it('says a whole sentence while the language is still resolving', () => {
    // Main is authoritative about which language was used and takes a moment to
    // say so. "Translating into " with a hole in it would be the staleness the
    // indirection exists to prevent, just briefer.
    expect(asideHeading('explanation', '', 'claude').key).toBe('aside.explainingPending')
    expect(asideHeading('translation', '', 'claude').key).toBe('aside.translatingPending')
  })

  it('names the language once main has said which it was', () => {
    expect(asideHeading('explanation', 'Arabic', 'claude')).toEqual({
      key: 'aside.explaining',
      vars: { language: 'Arabic' },
    })
    expect(asideHeading('translation', 'Arabic', 'claude')).toEqual({
      key: 'aside.translating',
      vars: { language: 'Arabic' },
    })
  })

  it('gives a translation its own heading, not the explanation one', () => {
    // The regression this pins: the shape it replaced was
    // `purpose !== 'explanation' ? ask : explain`, which read every new purpose
    // as a question and would have labelled a translation "Ask claude about
    // this".
    expect(asideHeading('translation', 'Arabic', 'claude').key).not.toBe('aside.heading')
    expect(asideHeading('translation', 'Arabic', 'claude').key).not.toBe('aside.explaining')
  })

  it('returns keys, never words — the reducer has no translator', () => {
    for (const purpose of ['question', 'explanation', 'translation', 'recap'] as const) {
      expect(asideHeading(purpose, 'Arabic', 'claude').key).toMatch(/^aside\./)
    }
  })

  it('gives a recap the same heading on its first frame as on its last', () => {
    // The only purpose of the four with nothing to resolve: no language, no
    // passage. So there is no pending variant, and asserting the language is
    // ignored is what stops one being added by copying the pair above.
    expect(asideHeading('recap', '', 'claude')).toEqual({
      key: 'aside.recapping',
      vars: { agent: 'claude' },
    })
    expect(asideHeading('recap', 'Arabic', 'claude')).toEqual(asideHeading('recap', '', 'claude'))
  })
})

describe('opensWithATurn', () => {
  it('is false only for a question, which waits to be typed', () => {
    expect(opensWithATurn('question')).toBe(false)
    expect(opensWithATurn('explanation')).toBe(true)
    expect(opensWithATurn('translation')).toBe(true)
    // A recap asks itself, so the answer region shows from the first frame and
    // the follow-up box stays hidden until there is a board to follow up on.
    expect(opensWithATurn('recap')).toBe(true)
  })
})

/**
 * Promoting a recap is not promoting an answer, and the difference is the
 * sentence after the quote rather than the missing excerpt.
 */
describe('recapPromotion', () => {
  const staged = recapPromotion('claude', 'Task — ship the phone shape\nNext — delete the branch')

  it('mentions the author, because routing is by mention', () => {
    expect(staged.startsWith('@claude')).toBe(true)
  })

  it('carries the board as one quoted block', () => {
    expect(staged).toContain('> Task — ship the phone shape\n> Next — delete the branch')
  })

  it('says the board came from somewhere the agent cannot remember', () => {
    expect(staged).toContain('not in this conversation')
  })

  it('instructs, where promotion only informs', () => {
    // The whole reason to promote a recap: the next turn should start from the
    // board rather than from the tangent the board was written to escape.
    expect(staged).toContain('Stay on the task it names')
  })

  it('carries no excerpt, because a recap has no passage', () => {
    // The reply is the thing being escaped. Quoting it back would put it in the
    // composer, one step from being the next turn's context again.
    expect(staged).not.toContain('You explained this')
  })

  it('quotes a blank line inside the board rather than breaking out of it', () => {
    expect(recapPromotion('codex', 'one\n\ntwo')).toContain('> one\n>\n> two')
  })
})
