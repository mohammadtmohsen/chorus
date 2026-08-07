import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { MAX_PANES, type SplitDirection } from './layout.js'

const DRAG_START_PX = 5

interface TabGeometry {
  readonly conversationId: string
  readonly rect: DOMRect
  readonly index: number
}

interface PaneGeometry {
  readonly paneId: string
  readonly paneRect: DOMRect
  readonly contentRect: DOMRect
  readonly stripRect: DOMRect
  readonly tabs: readonly TabGeometry[]
  readonly tabCount: number
}

interface DragGeometry {
  readonly panes: readonly PaneGeometry[]
  readonly paneCount: number
  readonly sourceTabCount: number
}

export type TabDropTarget =
  | {
      kind: 'insert'
      paneId: string
      slot: number
      line: { left: number; top: number; height: number }
      disabled: false
    }
  | {
      kind: 'move'
      paneId: string
      slot: number
      rect: DOMRect
      disabled: false
    }
  | {
      kind: 'split'
      paneId: string
      direction: SplitDirection
      rect: DOMRect
      disabled: boolean
    }

export interface ActiveTabDrag {
  readonly conversationId: string
  readonly title: string
  readonly sourcePaneId: string
  readonly x: number
  readonly y: number
  readonly target: TabDropTarget | null
}

function contains(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

function geometry(): DragGeometry {
  const panes = [...document.querySelectorAll<HTMLElement>('[data-workspace-pane]')].flatMap(
    (pane): PaneGeometry[] => {
      const paneId = pane.dataset['workspacePane']
      const strip = pane.querySelector<HTMLElement>('[data-tab-strip]')
      const content = pane.querySelector<HTMLElement>('[data-pane-content]')
      if (paneId === undefined || strip === null || content === null) return []
      const tabs = [...strip.querySelectorAll<HTMLElement>('[data-workspace-tab]')].flatMap(
        (tab, index): TabGeometry[] => {
          const conversationId = tab.dataset['workspaceTab']
          return conversationId === undefined
            ? []
            : [{ conversationId, index, rect: tab.getBoundingClientRect() }]
        }
      )
      return [
        {
          paneId,
          paneRect: pane.getBoundingClientRect(),
          contentRect: content.getBoundingClientRect(),
          stripRect: strip.getBoundingClientRect(),
          tabs,
          tabCount: tabs.length,
        },
      ]
    }
  )
  return { panes, paneCount: panes.length, sourceTabCount: 0 }
}

function edgeTarget(
  pane: PaneGeometry,
  x: number,
  y: number
): { direction: SplitDirection; rect: DOMRect } | null {
  const { contentRect: rect } = pane
  const horizontalBand = Math.min(rect.width * 0.25, 120)
  const verticalBand = Math.min(rect.height * 0.25, 120)
  const candidates: { direction: SplitDirection; penetration: number }[] = [
    { direction: 'left', penetration: (horizontalBand - (x - rect.left)) / horizontalBand },
    { direction: 'right', penetration: (horizontalBand - (rect.right - x)) / horizontalBand },
    { direction: 'up', penetration: (verticalBand - (y - rect.top)) / verticalBand },
    { direction: 'down', penetration: (verticalBand - (rect.bottom - y)) / verticalBand },
  ]
  const winner = candidates
    .filter(({ penetration }) => penetration > 0)
    .sort((a, b) => b.penetration - a.penetration)[0]
  if (winner === undefined) return null

  const width =
    winner.direction === 'left' || winner.direction === 'right' ? rect.width / 2 : rect.width
  const height =
    winner.direction === 'up' || winner.direction === 'down' ? rect.height / 2 : rect.height
  const left = winner.direction === 'right' ? rect.left + rect.width / 2 : rect.left
  const top = winner.direction === 'down' ? rect.top + rect.height / 2 : rect.top
  return { direction: winner.direction, rect: new DOMRect(left, top, width, height) }
}

function resolveTarget(
  dragGeometry: DragGeometry,
  sourcePaneId: string,
  conversationId: string,
  x: number,
  y: number
): TabDropTarget | null {
  for (const pane of dragGeometry.panes) {
    if (!contains(pane.stripRect, x, y)) continue
    let slot = pane.tabs.length
    for (const tab of pane.tabs) {
      if (tab.conversationId === conversationId && pane.paneId === sourcePaneId) continue
      if (x < tab.rect.left + tab.rect.width / 2) {
        slot = tab.index
        break
      }
    }
    const before = pane.tabs[slot]
    const last = pane.tabs.at(-1)
    const left = before?.rect.left ?? last?.rect.right ?? pane.stripRect.left + 6
    return {
      kind: 'insert',
      paneId: pane.paneId,
      slot,
      line: { left, top: pane.stripRect.top + 4, height: Math.max(0, pane.stripRect.height - 8) },
      disabled: false,
    }
  }

  for (const pane of dragGeometry.panes) {
    if (!contains(pane.contentRect, x, y)) continue
    const edge = edgeTarget(pane, x, y)
    if (edge === null) {
      return {
        kind: 'move',
        paneId: pane.paneId,
        slot: pane.tabCount,
        rect: pane.contentRect,
        disabled: false,
      }
    }
    const sourceDisappears = dragGeometry.sourceTabCount === 1 && sourcePaneId !== pane.paneId
    const disabled =
      (sourcePaneId === pane.paneId && dragGeometry.sourceTabCount === 1) ||
      (dragGeometry.paneCount >= MAX_PANES && !sourceDisappears)
    return {
      kind: 'split',
      paneId: pane.paneId,
      direction: edge.direction,
      rect: edge.rect,
      disabled,
    }
  }
  return null
}

export function useTabDrag(options: {
  onInsert: (conversationId: string, paneId: string, slot: number) => void
  onSplit: (conversationId: string, paneId: string, direction: SplitDirection) => void
}): {
  drag: ActiveTabDrag | null
  onPointerDown: (
    conversationId: string,
    title: string,
    paneId: string,
    event: ReactPointerEvent<HTMLElement>
  ) => void
  consumeSuppressedClick: () => boolean
} {
  const pending = useRef<{
    conversationId: string
    title: string
    paneId: string
    pointerId: number
    x: number
    y: number
    element: HTMLElement
  } | null>(null)
  const active = useRef<(NonNullable<typeof pending.current> & { geometry: DragGeometry }) | null>(
    null
  )
  const suppressClick = useRef(false)
  const [drag, setDrag] = useState<ActiveTabDrag | null>(null)

  const finish = useCallback(
    (event: PointerEvent | null, commit: boolean) => {
      const current = active.current
      if (current !== null) {
        try {
          current.element.releasePointerCapture(current.pointerId)
        } catch {
          // Capture may already have been released by the OS.
        }
        if (commit && event !== null) {
          const target = resolveTarget(
            current.geometry,
            current.paneId,
            current.conversationId,
            event.clientX,
            event.clientY
          )
          if (target?.kind === 'insert' || target?.kind === 'move') {
            options.onInsert(current.conversationId, target.paneId, target.slot)
          } else if (target?.kind === 'split' && !target.disabled) {
            options.onSplit(current.conversationId, target.paneId, target.direction)
          }
        }
        suppressClick.current = true
      }
      pending.current = null
      active.current = null
      setDrag(null)
      document.body.style.removeProperty('user-select')
    },
    [options]
  )

  useLayoutEffect(() => {
    if (drag === null) return
    const onMove = (event: PointerEvent): void => {
      const current = active.current
      if (event.pointerId !== current?.pointerId) return
      const target = resolveTarget(
        current.geometry,
        current.paneId,
        current.conversationId,
        event.clientX,
        event.clientY
      )
      setDrag({
        conversationId: current.conversationId,
        title: current.title,
        sourcePaneId: current.paneId,
        x: event.clientX,
        y: event.clientY,
        target,
      })
    }
    const onUp = (event: PointerEvent): void => {
      if (event.pointerId === active.current?.pointerId) finish(event, true)
    }
    const onCancel = (event: PointerEvent): void => {
      if (event.pointerId === active.current?.pointerId) finish(null, false)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
    }
  }, [drag === null, finish])

  useEffect(
    () => () => {
      document.body.style.removeProperty('user-select')
    },
    []
  )

  const onPointerDown = useCallback(
    (
      conversationId: string,
      title: string,
      paneId: string,
      event: ReactPointerEvent<HTMLElement>
    ) => {
      if (event.button !== 0) return
      const start = {
        conversationId,
        title,
        paneId,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        element: event.currentTarget,
      }
      pending.current = start

      const onMove = (move: PointerEvent): void => {
        if (pending.current !== start || move.pointerId !== start.pointerId) return
        if (
          Math.abs(move.clientX - start.x) <= DRAG_START_PX &&
          Math.abs(move.clientY - start.y) <= DRAG_START_PX
        ) {
          return
        }
        cleanup()
        const measured = geometry()
        const source = measured.panes.find((pane) => pane.paneId === paneId)
        const captured = {
          ...start,
          geometry: { ...measured, sourceTabCount: source?.tabCount ?? 0 },
        }
        active.current = captured
        try {
          start.element.setPointerCapture(start.pointerId)
        } catch {
          // The document listeners below still give the drag one cleanup path.
        }
        document.body.style.userSelect = 'none'
        setDrag({
          conversationId,
          title,
          sourcePaneId: paneId,
          x: move.clientX,
          y: move.clientY,
          target: resolveTarget(
            captured.geometry,
            paneId,
            conversationId,
            move.clientX,
            move.clientY
          ),
        })
      }
      const onEnd = (end: PointerEvent): void => {
        if (end.pointerId !== start.pointerId) return
        cleanup()
        if (pending.current === start) pending.current = null
      }
      const cleanup = (): void => {
        start.element.removeEventListener('pointermove', onMove)
        start.element.removeEventListener('pointerup', onEnd)
        start.element.removeEventListener('pointercancel', onEnd)
      }
      start.element.addEventListener('pointermove', onMove)
      start.element.addEventListener('pointerup', onEnd)
      start.element.addEventListener('pointercancel', onEnd)
    },
    []
  )

  return {
    drag,
    onPointerDown,
    consumeSuppressedClick: () => {
      if (!suppressClick.current) return false
      suppressClick.current = false
      return true
    },
  }
}
