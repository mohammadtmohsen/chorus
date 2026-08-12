import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TerminalRefShape } from '../../shared/ipc.js'
import { TerminalView } from './TerminalView.js'

/** The bounds a drag is clamped to, and where a panel opens. */
export const TERMINAL_HEIGHT = { default: 240, min: 96, max: 720 } as const

export function clampTerminalHeight(value: number): number {
  return Math.min(TERMINAL_HEIGHT.max, Math.max(TERMINAL_HEIGHT.min, Math.round(value)))
}

export interface TerminalPanelProps {
  readonly terminal: TerminalRefShape
  readonly title: string
  readonly height: number
  /** Called once on release, not per frame. See the drag below. */
  readonly onHeightChange: (height: number) => void
  readonly onClose: () => void
  readonly onFocusAway: () => void
  /**
   * Which scope this is, as a class the keyboard handler can find.
   *
   * `⌘J` is scoped to session terminals, so it has to be able to tell — from a
   * `document`-level capture handler that only knows `document.activeElement` —
   * whether the caret is in the global panel. A class is the cheapest honest
   * answer; the alternative is threading focus state back up through the store.
   */
  readonly variant: 'global' | 'session'
  /** The combo that toggles this panel, shown in its header. */
  readonly shortcut: string
}

/**
 * The resizable dock a terminal sits in.
 *
 * Shared by both scopes: a session's panel and the global one differ in where
 * they are mounted and what they are titled, not in how they behave.
 */
export function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const shell = useRef<HTMLDivElement>(null)
  const focusTerminal = useRef<(() => void) | null>(null)
  const [exited, setExited] = useState<number | null>(null)
  const { onHeightChange } = props

  const onReady = useCallback((focus: () => void) => {
    focusTerminal.current = focus
  }, [])

  const onExit = useCallback((code: number) => {
    setExited(code)
  }, [])

  /*
   * The height is written straight to a custom property while the pointer moves
   * and only committed on release.
   *
   * The same trade `useSidebarResize` makes, and for the same reason: going
   * through React on every frame would re-render the transcript above this at
   * pointer rate to move one edge. It is *not* a fix for C-026 — `.score` is
   * observed directly, so its ResizeObserver still runs every frame — but it
   * keeps the cost to that one callback instead of a full re-render on top.
   */
  const onGrab = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = shell.current
      if (element === null) return
      event.preventDefault()
      const startY = event.clientY
      const startHeight = element.getBoundingClientRect().height
      let latest = startHeight

      const move = (moved: PointerEvent): void => {
        latest = clampTerminalHeight(startHeight - (moved.clientY - startY))
        element.style.setProperty('--terminal-height', `${String(latest)}px`)
      }
      const release = (): void => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', release)
        document.removeEventListener('pointercancel', release)
        document.body.style.userSelect = ''
        onHeightChange(latest)
      }
      document.body.style.userSelect = 'none'
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', release)
      document.addEventListener('pointercancel', release)
    },
    [onHeightChange]
  )

  const nudge = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      const next = clampTerminalHeight(props.height + (event.key === 'ArrowUp' ? 24 : -24))
      onHeightChange(next)
    },
    [props.height, onHeightChange]
  )

  return (
    <div
      className={`terminal-panel terminal-panel--${props.variant}`}
      ref={shell}
      style={{ '--terminal-height': `${String(props.height)}px` } as React.CSSProperties}
    >
      <div
        className="terminal-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('terminal.resize')}
        tabIndex={0}
        onPointerDown={onGrab}
        onKeyDown={nudge}
      />
      <div className="terminal-head">
        <span className="terminal-title">{props.title}</span>
        {exited !== null && (
          <span className="terminal-exited">{t('terminal.exited', { code: exited })}</span>
        )}
        {/*
          The shortcut, next to the control it duplicates.
        
          A person who reaches for Hide is the person who has not learned the
          key yet, so this is where it is worth saying — and saying it once, in
          the panel, rather than in a settings sheet nobody opens.
        */}
        <kbd className="terminal-shortcut" title={t('terminal.toggleHint')}>
          {props.shortcut}
        </kbd>
        <button
          type="button"
          className="terminal-action"
          onClick={() => {
            props.onFocusAway()
            props.onClose()
          }}
          title={t('terminal.hide')}
        >
          {t('terminal.hide')}
        </button>
      </div>
      <TerminalView
        terminal={props.terminal}
        label={props.title}
        onExit={onExit}
        onReady={onReady}
      />
    </div>
  )
}
