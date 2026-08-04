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

  useEffect(() => {
    const container = ref.current
    if (container === null) return

    const previous = document.activeElement as HTMLElement | null
    focusables(container)[0]?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
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
  }, [onClose])

  return ref
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}
