import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useShellOverlay } from './workspace/overlay.js'

export function TrafficEndpoint(props: { readonly label: string }): React.JSX.Element {
  const id = useId()
  const [anchor, setAnchor] = useState<CSSProperties | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismiss = useCallback(() => {
    setAnchor(null)
  }, [])
  const hold = (): void => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const leave = (): void => {
    hold()
    closeTimer.current = setTimeout(dismiss, 120)
  }

  useShellOverlay(anchor !== null)

  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    },
    []
  )

  useEffect(() => {
    if (anchor === null) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [anchor, dismiss])

  return (
    <>
      <span
        className="traffic-url"
        aria-describedby={anchor === null ? undefined : id}
        onPointerEnter={(event) => {
          if (event.pointerType === 'touch') return
          hold()
          const cell = event.currentTarget
          const box = cell.getBoundingClientRect()
          const style = window.getComputedStyle(cell)
          const leftInset =
            (Number.parseFloat(style.borderLeftWidth) || 0) +
            (Number.parseFloat(style.paddingLeft) || 0)
          const rightInset =
            (Number.parseFloat(style.borderRightWidth) || 0) +
            (Number.parseFloat(style.paddingRight) || 0)
          let backgroundColor = 'var(--bg-chrome)'
          for (
            let surface: HTMLElement | null = cell;
            surface !== null;
            surface = surface.parentElement
          ) {
            const background = window.getComputedStyle(surface).backgroundColor
            if (background && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)') {
              backgroundColor = background
              break
            }
          }
          setAnchor({
            left: box.left + leftInset,
            top:
              box.top +
              (Number.parseFloat(style.borderTopWidth) || 0) +
              (Number.parseFloat(style.paddingTop) || 0),
            minWidth: Math.max(0, box.width - leftInset - rightInset),
            backgroundColor,
            color: style.color,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontStyle: style.fontStyle,
            fontWeight: style.fontWeight,
            fontStretch: style.fontStretch,
            fontVariant: style.fontVariant,
            fontFeatureSettings: style.fontFeatureSettings,
            fontVariationSettings: style.fontVariationSettings,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            wordSpacing: style.wordSpacing,
          })
        }}
        onPointerLeave={leave}
      >
        {props.label}
      </span>
      {anchor !== null &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="traffic-url traffic-endpoint-tooltip"
            style={anchor}
          >
            {props.label}
          </div>,
          document.body
        )}
    </>
  )
}
