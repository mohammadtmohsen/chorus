import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { AgentId, SessionInfo } from '../Session.js'
import { SessionSettings } from './SessionSettings.js'

/**
 * One menu for the whole list, opened against whichever row asked for it.
 *
 * Every row used to mount its own configuration: a folder editor, a profile
 * picker, two agent switches, a Plan toggle, Summary, Review, Restart and End.
 * With twenty sessions that is a hundred and sixty controls in a column 248px
 * wide, of which you wanted one. This is the same set of things, mounted once,
 * for the session you actually asked about.
 *
 * The durable route, deliberately: everything here is reachable by mouse,
 * keyboard and assistive technology, which is why the preview is allowed to be
 * read-only. Escape closes and puts focus back where it came from.
 */

export interface MenuTarget {
  readonly conversationId: string
  readonly anchor: DOMRect
  /** Where focus goes when the menu closes. */
  readonly trigger: HTMLElement | null
}

export interface SessionMenuProps {
  readonly target: MenuTarget
  readonly session: SessionInfo
  readonly home: string
  readonly profiles: readonly {
    readonly id: string
    readonly name: string
    readonly summary: string
  }[]
  readonly installed: readonly AgentId[]
  readonly onClose: () => void
  readonly onToggleAgent: (agentId: AgentId, present: boolean) => Promise<void>
  readonly onChooseFolder: () => Promise<void>
  readonly onSetFolder: (cwd: string) => Promise<void>
  readonly onChooseProfile: (profileId: string) => Promise<void>
}

export function SessionMenu(props: SessionMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const surface = useRef<HTMLDivElement | null>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)

  const close = props.onClose
  const trigger = props.target.trigger
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      trigger?.focus()
      close()
    }
    const onPointerDown = (event: Event): void => {
      if (surface.current?.contains(event.target as Node) === true) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [close, trigger])

  /*
   * Measured, then held — the same rule the profile picker already followed and
   * for the same reason: the menu's height depends on how many profiles this
   * machine has, and a row near the foot of a long list would otherwise open a
   * menu into the space below the window.
   */
  useLayoutEffect(() => {
    if (surface.current === null) return
    const box = surface.current.getBoundingClientRect()
    const margin = 8
    setPlaced({
      left: Math.round(
        Math.min(props.target.anchor.left, Math.max(margin, window.innerWidth - box.width - margin))
      ),
      top: Math.round(
        Math.min(
          props.target.anchor.bottom + 4,
          Math.max(margin, window.innerHeight - box.height - margin)
        )
      ),
    })
  }, [props.target.anchor])

  /*
   * Focus lands in the surface so arrows and Escape work without a click.
   *
   * Not before it is placed: the surface is `visibility: hidden` until its
   * position is measured, and a hidden element cannot take focus — so focusing
   * on mount silently did nothing and the first arrow key went to the page.
   */
  useEffect(() => {
    if (placed === null) return
    surface.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  }, [placed])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [
      ...(surface.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []),
    ]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    const next = (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  return createPortal(
    <div
      ref={surface}
      className="session-menu"
      role="menu"
      aria-label={t('menu.label', { title: props.session.title })}
      style={{
        left: placed?.left ?? 0,
        top: placed?.top ?? 0,
        visibility: placed === null ? 'hidden' : 'visible',
      }}
      onKeyDown={onKeyDown}
    >
      <SessionSettings
        session={props.session}
        home={props.home}
        profiles={props.profiles}
        installed={props.installed}
        onToggleAgent={props.onToggleAgent}
        onChooseFolder={props.onChooseFolder}
        onSetFolder={props.onSetFolder}
        onChooseProfile={props.onChooseProfile}
      />
    </div>,
    document.body
  )
}
