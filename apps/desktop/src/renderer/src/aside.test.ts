import { describe, expect, it } from 'vitest'
import { asideState, fitCard, promotion } from './aside.js'
import { EMPTY_VIEW, type TranscriptMessage, type TranscriptView } from './transcript.js'

const said = (over: Partial<TranscriptMessage>): TranscriptMessage => ({
  key: 'k',
  actor: 'claude',
  kind: 'message',
  text: '',
  status: 'complete',
  eventId: 'e',
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
  const pane = { width: 800, height: 600 }
  const card = { width: 400, height: 350 }
  // `anchorFor` hands back a hanging edge, not a corner: for 'above' it is the
  // selection's top less the 8px gap.
  const above = (top: number) => ({ left: 400, top, placement: 'above' as const })
  const below = (top: number) => ({ left: 400, top, placement: 'below' as const })

  it('hangs its bottom edge from the anchor when it fits above', () => {
    const at = fitCard(above(500), pane, card)
    expect(at.top).toBe(150)
    expect(at.left).toBe(200)
  })

  it('clears the passage when it cannot fit above', () => {
    // The bug: falling back to the anchor put the card on top of the very words
    // it was quoting, because an 'above' anchor *is* the top of the selection.
    const selectionHeight = 22
    const at = fitCard(above(60), pane, card, selectionHeight)
    expect(at.top).toBeGreaterThanOrEqual(60 + selectionHeight)
  })

  it('takes a below anchor at face value', () => {
    // Already past the selection — adding the crossing again would leave a gap
    // the size of the passage.
    const at = fitCard(below(100), pane, card)
    expect(at.top).toBe(100)
  })

  it('never leaves the card clipped off the top', () => {
    expect(fitCard(above(20), pane, card).top).toBeGreaterThanOrEqual(4)
  })

  it('never leaves it hanging off the bottom', () => {
    const at = fitCard(below(590), pane, card)
    expect(at.top + card.height).toBeLessThanOrEqual(pane.height)
  })

  it('clamps to the left edge', () => {
    expect(fitCard({ ...above(500), left: 10 }, pane, card).left).toBe(4)
  })

  it('clamps to the right edge', () => {
    expect(fitCard({ ...above(500), left: 790 }, pane, card).left).toBe(800 - 400 - 4)
  })

  it('sits at the margin when the card is wider than the pane', () => {
    // Clamping must not produce a negative offset, which would push it off the
    // left edge in the name of keeping it on the right one.
    const at = fitCard({ ...above(400), left: 100 }, { width: 300, height: 600 }, card)
    expect(at.left).toBe(4)
  })

  it('is fully visible even when it fits neither above nor below', () => {
    const tight = { width: 800, height: 400 }
    const at = fitCard(above(200), tight, card)
    expect(at.top).toBeGreaterThanOrEqual(4)
    expect(at.top + card.height).toBeLessThanOrEqual(tight.height)
  })
})
