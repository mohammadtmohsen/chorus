import { useEffect, useRef } from 'react'

/**
 * Makes a modal behave like one for a keyboard user.
 *
 * Three things, all of which are broken by default in a hand-rolled dialog:
 *
 *  - **Focus moves in.** Otherwise focus stays on the button that opened the
 *    dialog, and a screen reader announces nothing.
 *  - **Focus stays in.** Tabbing out of a modal leaves the user editing the
 *    transcript behind an overlay they cannot see past.
 *  - **Focus comes back.** On close, focus returns to whatever opened it, so
 *    the keyboard position is not lost.
 *
 * Escape closes, because a dialog with no keyboard exit is a trap.
 */
export function useDialog<T extends HTMLElement>(onClose: () => void): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)

  /*
   * The callback, held in a ref so the effect below can depend on nothing.
   *
   * Every caller passes an inline arrow — `onClose={() => { setHandoff(null) }}`
   * — which is a new function on every render of the parent. The effect used to
   * list it as a dependency, so **every re-render of the parent tore the effect
   * down and set it up again**: cleanup put focus back on whatever had opened
   * the dialog, then setup moved it to the dialog's first control.
   *
   * A `Session` re-renders on every delta an agent streams, so the reported
   * symptom was a handoff whose caret jumped out of the box being typed into and
   * onto the "Ask them to" select, over and over, while an agent was talking.
   *
   * Reading it through a ref keeps the latest callback without making the
   * dialog's lifecycle depend on the caller's render count. Mount, unmount, and
   * nothing in between — which is what "focus moves in, then comes back" always
   * meant.
   */
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])

  useEffect(() => {
    const container = ref.current
    if (container === null) return

    const previous = document.activeElement as HTMLElement | null
    focusables(container)[0]?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close.current()
        return
      }
      if (event.key !== 'Tab') return

      const items = focusables(container)
      const first = items[0]
      const last = items.at(-1)
      if (first === undefined || last === undefined) return

      // Wrap manually: the browser would otherwise move focus to the page
      // behind the overlay.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus()
    }
    // Mount and unmount only. See `close` above for why this list is empty.
  }, [])

  return ref
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}
