/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WaitingRow } from './Session.js'

/**
 * What the row under a sent message says, in both states.
 *
 * Mounted rather than driven, and that is forced rather than chosen: against a
 * healthy agent this row exists for under a frame — `working` fills within tens
 * of milliseconds of the send — so the state that matters, the one after the
 * deadline, cannot be reached by driving the app. Two runs were spent proving
 * that before this file existed.
 *
 * `@vitest-environment jsdom` at the top, because `node` is this project's
 * default and a DOM is an exception that has to be asked for.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

/* The rotating word freezes for anyone who asked for less motion, so it asks
   that media query on mount. jsdom has no `matchMedia` at all. */
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
})

const row = (container: HTMLElement) => container.querySelector('.said.thinking')

describe('the waiting row', () => {
  it('says a turn is on its way, with dots', () => {
    const { container } = render(<WaitingRow soleAgent="claude" stalled={false} />)
    const said = row(container)
    expect(said?.getAttribute('data-stalled')).toBeNull()
    expect(container.querySelectorAll('.thinking-dots i')).toHaveLength(3)
    expect(said?.textContent).not.toContain('noAnswer')
  })

  /*
   * The regression this file was written for.
   *
   * The deadline used to hide the row, leaving a message alone under a
   * transcript with nothing to say anything had been expected — reported as
   * "still no thinking indicators when asking", which is a fair reading of a
   * screen with nothing on it. It also destroyed the only evidence a user
   * could send, which C-043 names as the cost of the deadline.
   */
  it('says the message may not have arrived once the wait outlasts a start', () => {
    const { container } = render(<WaitingRow soleAgent="claude" stalled />)
    const said = row(container)
    expect(said?.getAttribute('data-stalled')).toBe('true')
    expect(said?.textContent).toBe('conversation.noAnswer')
    // No dots: three that never resolve are the claim being withdrawn.
    expect(container.querySelectorAll('.thinking-dots i')).toHaveLength(0)
  })

  it('names the one agent there is, and nobody when there are two', () => {
    const { container } = render(<WaitingRow soleAgent="claude" stalled={false} />)
    expect(container.querySelector('.speaker')?.textContent).toBe('actor.claude')
    expect(container.querySelector('.entry')?.className).not.toContain('entry--unnamed')

    cleanup()
    const two = render(<WaitingRow soleAgent={undefined} stalled={false} />)
    // No head at all rather than an empty one, or the dot sits a row above its
    // own word — `.entry` spends its first grid row on the head either way.
    expect(two.container.querySelector('.entry-head')).toBeNull()
    expect(two.container.querySelector('.entry')?.className).toContain('entry--unnamed')
  })

  /* Both states are announced: the agent is blocked either way. */
  it('stays a live region in both states', () => {
    for (const stalled of [false, true]) {
      const { container } = render(<WaitingRow soleAgent="claude" stalled={stalled} />)
      expect(row(container)?.getAttribute('role')).toBe('status')
      cleanup()
    }
  })
})
