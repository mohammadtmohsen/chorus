/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useTypewriter } from './useTypewriter.js'

/**
 * The tail at the end of a turn.
 *
 * `typewriter.ts` is pure and tested as such, but the behaviour this file is
 * about is not in it: the reveal used to stop only when the animation ran out,
 * so a reply that had fully arrived kept appearing for another fraction of a
 * second — the app visibly behind an agent that had already finished. The fix
 * is a prop change driving an effect, and there is no pure part to extract, so
 * this mounts a component and re-renders it.
 *
 * `@vitest-environment jsdom` at the top, because `node` is this project's
 * default and a DOM is an exception that has to be asked for.
 */

/*
 * jsdom has no compositor, so `requestAnimationFrame` never fires on its own.
 * Left alone the paced path would advance zero characters and every assertion
 * below would pass whether or not the flush existed — the control test at the
 * end is what proves that is not what is happening.
 */
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

function Probe(props: { text: string; startWhole: boolean; complete: boolean }): React.JSX.Element {
  return (
    <span data-testid="shown">{useTypewriter(props.text, props.startWhole, props.complete)}</span>
  )
}

const shown = (container: HTMLElement): string =>
  container.querySelector('[data-testid="shown"]')?.textContent ?? ''

describe('useTypewriter', () => {
  it('shows the whole authoritative text the moment a message completes', () => {
    const { container, rerender } = render(
      <Probe text="a reply that is still arriving" startWhole={false} complete={false} />
    )
    expect(shown(container)).toBe('')

    act(() => {
      rerender(<Probe text="a reply that is still arriving" startWhole={false} complete />)
    })
    expect(shown(container)).toBe('a reply that is still arriving')
  })

  /*
   * The control, and it is the assertion that would fail if the flush were
   * removed: without frames, the paced path reveals nothing. So the test above
   * is measuring the flush rather than measuring jsdom.
   */
  it('reveals nothing while a message is still streaming and no frame runs', () => {
    const { container } = render(<Probe text="still writing" startWhole={false} complete={false} />)
    expect(shown(container)).toBe('')
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
    expect(shown(container)).toBe('one')
    act(() => {
      rerender(<Probe text="one and then some more" startWhole={false} complete />)
    })
    expect(shown(container)).toBe('one and then some more')
  })
})
