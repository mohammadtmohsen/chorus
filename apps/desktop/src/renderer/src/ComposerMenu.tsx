import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * A small menu hung off a control in the composer.
 *
 * One implementation rather than three: the `+` button, the `Included` chip and
 * anything else that grows a caret all need the same six behaviours, and three
 * copies of them is three chances to get Escape wrong.
 *
 * The keys are the ones `SessionMenu` already uses — arrows move, Enter chooses,
 * Escape closes and hands focus back to the trigger — because a second
 * convention inside one app is worse than either convention.
 *
 * Portalled and `position: fixed`, like `SessionMenu` and the mention menu: the
 * dock clips, and a menu that opens inside a scroller is a menu with a scrollbar
 * through it.
 */

export interface MenuItem {
  readonly key: string
  readonly label: string
  /** A second line under the label — what the item will actually do. */
  readonly detail?: string
  /** Drawn with a tick, for an item that reports a state as well as setting one. */
  readonly checked?: boolean
  readonly disabled?: boolean
  readonly onChoose: () => void
}

export function ComposerMenu({
  items,
  anchor,
  trigger,
  label,
  onClose,
}: {
  readonly items: readonly MenuItem[]
  readonly anchor: DOMRect
  /** Where focus goes when the menu closes. */
  readonly trigger: HTMLElement | null
  readonly label: string
  readonly onClose: () => void
}): React.JSX.Element {
  const surface = useRef<HTMLDivElement | null>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)

  /*
   * Measured, then placed, then shown.
   *
   * The composer sits at the bottom of the pane, so a menu opened downwards from
   * it would open into the window's edge. It is drawn above the trigger when
   * there is no room below, which is only knowable after it has a height.
   */
  useLayoutEffect(() => {
    const box = surface.current?.getBoundingClientRect()
    if (box === undefined) return
    const margin = 8
    const below = anchor.bottom + 4
    const fitsBelow = below + box.height + margin <= window.innerHeight
    setPlaced({
      left: Math.round(
        Math.min(anchor.left, Math.max(margin, window.innerWidth - box.width - margin))
      ),
      top: Math.round(fitsBelow ? below : Math.max(margin, anchor.top - box.height - 4)),
    })
  }, [anchor])

  /*
   * Focused *after* it is placed, not on mount.
   *
   * The surface is `visibility: hidden` until its position is measured, and a
   * hidden element cannot take focus — so focusing on mount silently did
   * nothing and the first arrow key went to the page. Measured: the menu opened
   * with `document.activeElement` still on the trigger.
   */
  useEffect(() => {
    if (placed === null) return
    surface.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  }, [placed])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      trigger?.focus()
      onClose()
    }
    const onPointerDown = (event: Event): void => {
      if (surface.current?.contains(event.target as Node) === true) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [onClose, trigger])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = [
      ...(surface.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []),
    ]
    if (buttons.length === 0) return
    event.preventDefault()
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const step = event.key === 'ArrowDown' ? 1 : buttons.length - 1
    buttons[(at + step + buttons.length) % buttons.length]?.focus()
  }

  return createPortal(
    <div
      ref={surface}
      className="composer-menu"
      role="menu"
      aria-label={label}
      style={{
        left: placed?.left ?? 0,
        top: placed?.top ?? 0,
        visibility: placed === null ? 'hidden' : 'visible',
      }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          data-menu-item={item.key}
          data-checked={item.checked === true ? 'true' : undefined}
          onClick={() => {
            item.onChoose()
            trigger?.focus()
            onClose()
          }}
        >
          <span className="composer-menu-label">{item.label}</span>
          {item.detail !== undefined && <span className="composer-menu-detail">{item.detail}</span>}
        </button>
      ))}
    </div>,
    document.body
  )
}
