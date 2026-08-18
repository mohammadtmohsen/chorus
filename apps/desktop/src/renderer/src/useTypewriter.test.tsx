/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useTypewriter } from './useTypewriter.js'

/**
 * That a reply is *typed*, to its last character.
 *
 * `typewriter.ts` is pure and tested as such, but the behaviour this file is
 * about is not in it — it is the effect: which frames run, and what happens at
 * the moment a message completes. There is no pure part to extract, so this
 * mounts a component and drives it.
 *
 * `@vitest-environment jsdom` at the top, because `node` is this project's
 * default and a DOM is an exception that has to be asked for.
 *
 * **The frames are driven by hand.** jsdom has no compositor, so a real
 * `requestAnimationFrame` never fires and the paced path would advance zero
 * characters — every assertion here would then pass without the hook doing
 * anything, which is the trap the previous version of this file documented and
 * worked around with a control test. Owning the clock is better: it tests the
 * pacing rather than testing jsdom.
 */

let now = 0
let queue: FrameRequestCallback[] = []

/** Runs the frames that are due, the way a compositor would. */
const advance = (ms: number, frameMs = 16): void => {
  for (let spent = 0; spent < ms; spent += frameMs) {
    now += frameMs
    const due = queue
    queue = []
    act(() => {
      for (const cb of due) cb(now)
    })
  }
}

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
  Object.defineProperty(window, 'requestAnimationFrame', {
    value: (cb: FrameRequestCallback) => queue.push(cb),
    configurable: true,
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    value: () => undefined,
    configurable: true,
  })
  Object.defineProperty(window.performance, 'now', { value: () => now, configurable: true })
})

beforeEach(() => {
  now = 0
  queue = []
})

afterEach(() => {
  cleanup()
})

function Probe(props: { text: string; startWhole: boolean; complete: boolean }): React.JSX.Element {
  return (
    <span data-testid="shown">{useTypewriter(props.text, props.startWhole, props.complete)}</span>
  )
}

const shown = (container: HTMLElement): string =>
  container.querySelector('[data-testid="shown"]')?.textContent ?? ''

const SENTENCE = 'a reply that is still arriving, one character after another'

describe('useTypewriter', () => {
  it('reveals a streaming reply a few characters at a time', () => {
    const { container } = render(<Probe text={SENTENCE} startWhole={false} complete={false} />)
    expect(shown(container)).toBe('')

    const lengths: number[] = []
    for (let i = 0; i < 6; i += 1) {
      advance(16)
      lengths.push(shown(container).length)
    }

    // Growing, and by a few characters a frame rather than a line at a time.
    expect(lengths[0]).toBeGreaterThan(0)
    expect(lengths.at(-1)).toBeLessThan(SENTENCE.length)
    for (let i = 1; i < lengths.length; i += 1) {
      const step = lengths[i]! - lengths[i - 1]!
      expect(step).toBeGreaterThan(0)
      expect(step).toBeLessThan(8)
    }
    // Always a prefix of what arrived: never a character the agent did not send.
    expect(SENTENCE.startsWith(shown(container))).toBe(true)
  })

  /*
   * The regression this file was rewritten for.
   *
   * Completing used to flush the whole authoritative text in one assignment, so
   * the last thing a reader saw of every reply was its tail appearing at once —
   * the most visible block of all, because it is where the eye already is. The
   * tail is now typed like the rest, just against a shorter window.
   */
  it('types the tail out instead of jumping when the message completes', () => {
    const { container, rerender } = render(
      <Probe text={SENTENCE} startWhole={false} complete={false} />
    )
    advance(48)
    const beforeCompletion = shown(container).length
    expect(beforeCompletion).toBeGreaterThan(0)
    expect(beforeCompletion).toBeLessThan(SENTENCE.length)

    act(() => {
      rerender(<Probe text={SENTENCE} startWhole={false} complete />)
    })
    // The moment of completion reveals nothing on its own.
    expect(shown(container).length).toBe(beforeCompletion)

    advance(16)
    const afterAFrame = shown(container).length
    expect(afterAFrame).toBeGreaterThan(beforeCompletion)
    expect(afterAFrame).toBeLessThan(SENTENCE.length)
  })

  it('finishes a completed message promptly', () => {
    const { container } = render(<Probe text={SENTENCE} startWhole={false} complete />)
    advance(600)
    expect(shown(container)).toBe(SENTENCE)
  })

  it('still starts whole for a message that was never watched being written', () => {
    const { container } = render(<Probe text="replayed history" startWhole complete />)
    expect(shown(container)).toBe('replayed history')
  })

  /*
   * Completing does not freeze the hook against later growth. A restarted
   * session replaces a message's text, and a hook that had latched "done" would
   * show the old length of the new string.
   */
  it('follows text that changes after completion', () => {
    const { container, rerender } = render(<Probe text="one" startWhole={false} complete />)
    advance(160)
    expect(shown(container)).toBe('one')
    act(() => {
      rerender(<Probe text="one and then some more" startWhole={false} complete />)
    })
    advance(600)
    expect(shown(container)).toBe('one and then some more')
  })

  /* Motion nobody asked for, in a thing they are trying to read. */
  it('shows everything at once for a reader who asked for less motion', () => {
    Object.defineProperty(window, 'matchMedia', {
      value: (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      configurable: true,
    })
    const { container } = render(<Probe text={SENTENCE} startWhole={false} complete={false} />)
    expect(shown(container)).toBe(SENTENCE)
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
})
