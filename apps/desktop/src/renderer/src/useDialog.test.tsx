/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useDialog } from './useDialog.js'

/**
 * The reported bug: a handoff sheet whose caret jumped out of the box being
 * typed into and onto the "Ask them to" select, over and over, while an agent
 * was talking.
 *
 * It has no pure part to test. The defect was the effect's dependency array —
 * every caller passes an inline arrow, so listing `onClose` tore the effect down
 * and set it up again on every render of the parent, and a `Session` re-renders
 * on every delta an agent streams. Cleanup restored focus to whatever opened the
 * dialog; setup moved it to the first control. So this mounts a component and
 * re-renders it, because that is the only place the behaviour exists.
 */

/**
 * jsdom does no layout, so `offsetParent` is `null` for everything — and
 * `focusables()` filters on it to skip hidden controls. Left alone, the hook
 * would find nothing focusable and the test would assert against a dialog that
 * never moved focus in the first place, which is a pass for the wrong reason.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    get(this: HTMLElement) {
      return this.parentElement
    },
    configurable: true,
  })
})

const closed: string[] = []

/*
 * Unmounted by hand, because Testing Library only registers its own cleanup when
 * vitest runs with `globals: true`, and this project does not. Without it every
 * sheet stayed mounted with its `keydown` listener still on `document`, and one
 * Escape closed all of them — which showed up as the newest callback being
 * right and two older ones firing alongside it.
 */
afterEach(() => {
  cleanup()
  closed.length = 0
})

/**
 * A sheet, with the two controls that matter: the one the hook focuses on mount
 * and the one the user moves to. `onClose` is an inline arrow, as every real
 * caller writes it, so its identity changes on every render — which is the whole
 * mechanism under test.
 */
function Sheet({ note }: { note: string }): React.JSX.Element {
  const ref = useDialog<HTMLDivElement>(() => {
    closed.push(note)
  })
  return (
    <div ref={ref}>
      <select data-testid="first" defaultValue="codex">
        <option value="codex">codex</option>
      </select>
      <textarea data-testid="brief" />
    </div>
  )
}

describe('useDialog', () => {
  it('moves focus into the sheet on mount', () => {
    const { getByTestId } = render(<Sheet note="a" />)
    expect(document.activeElement).toBe(getByTestId('first'))
  })

  it('leaves the caret alone when the caller re-renders', () => {
    const { getByTestId, rerender } = render(<Sheet note="a" />)

    // The user moves to the box they actually want to write in.
    const brief = getByTestId('brief') as HTMLTextAreaElement
    brief.focus()
    expect(document.activeElement).toBe(brief)

    /*
     * Three renders, each with a fresh `onClose` identity — the shape of an
     * agent streaming underneath an open sheet.
     *
     * `rerender` rather than clicking something that calls `setState`: a raw
     * `.click()` is not wrapped in `act`, so React had not flushed the update
     * by the time the assertion ran and the test passed against a component
     * that never re-rendered at all. It passed with the bug reinstated, which
     * is how that was found.
     */
    rerender(<Sheet note="a" />)
    rerender(<Sheet note="a" />)
    rerender(<Sheet note="a" />)

    expect(document.activeElement).toBe(brief)
  })

  it('still closes on Escape, with the newest callback rather than the first', () => {
    const { rerender } = render(<Sheet note="first" />)
    rerender(<Sheet note="latest" />)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    // The guard on the fix itself: reading the callback through a ref is what
    // lets the effect depend on nothing, and a ref that is never updated would
    // close over the render that mounted — calling back with stale state and
    // looking correct in every test that only counts the calls.
    expect(closed).toEqual(['latest'])
  })

  it('gives focus back to whatever opened it', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()

    const { unmount } = render(<Sheet note="a" />)
    expect(document.activeElement).not.toBe(opener)

    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
