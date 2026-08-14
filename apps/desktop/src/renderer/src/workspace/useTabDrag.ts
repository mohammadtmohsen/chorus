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

/** The rail's scrollport and the cards in it, in the order they are drawn. */
interface RailGeometry {
  readonly rect: DOMRect
  readonly cards: readonly { readonly conversationId: string; readonly rect: DOMRect }[]
}

interface DragGeometry {
  readonly panes: readonly PaneGeometry[]
  readonly paneCount: number
  readonly sourceTabCount: number
  readonly rail: RailGeometry | null
}

export type TabDropTarget =
  | {
      /**
       * A new place in the rail's own order.
       *
       * Only ever resolved for a gesture that started in the rail: dragging a
       * *tab* over the rail should not silently reorder a list the gesture was
       * never about.
       */
      kind: 'rail-insert'
      slot: number
      line: { left: number; top: number; width: number }
      disabled: false
    }
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
  /**
   * The pane the drag started in, or null when it started in the rail or the
   * drawer and the session has no tab anywhere.
   *
   * Null is not "unknown". It is the fact that decides two things: nothing can
   * disappear to make room for a split, and the drop has to open the session
   * rather than move it.
   */
  readonly sourcePaneId: string | null
  /**
   * Where the gesture started, which is not what `sourcePaneId` says.
   *
   * That field is *resolved* — a rail drag of a session that happens to be open
   * is given the pane it is open in, so the drop rules can treat it exactly like
   * its own tab being dragged. Which is right for the rules and wrong for the
   * ghost: the thing under the pointer is the 44px tile the rail draws, whether
   * or not the session also has a tab somewhere.
   */
  readonly fromRail: boolean
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
  const scroller = document.querySelector<HTMLElement>('[data-rail-scroll]')
  const rail: RailGeometry | null =
    scroller === null
      ? null
      : {
          rect: scroller.getBoundingClientRect(),
          cards: [...scroller.querySelectorAll<HTMLElement>('[data-reorder-id]')].flatMap(
            (card) => {
              const conversationId = card.dataset['reorderId']
              return conversationId === undefined
                ? []
                : [{ conversationId, rect: card.getBoundingClientRect() }]
            }
          ),
        }
  return { panes, paneCount: panes.length, sourceTabCount: 0, rail }
}

/**
 * The gap a pointer at `y` is pointing at, by the cards' own midpoints.
 *
 * Pure and exported so the arithmetic can be tested without a DOM: the geometry
 * around it is the part that needs a running app, and this is the part that gets
 * the answer wrong.
 *
 * Returns a *gap* index in `reorderSessions`' terms — 0 is above the first card,
 * `cards.length` is below the last.
 */
export function railSlotAt(midpoints: readonly number[], y: number): number {
  let slot = midpoints.length
  for (const [index, midpoint] of midpoints.entries()) {
    if (y < midpoint) {
      slot = index
      break
    }
  }
  return slot
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
  sourcePaneId: string | null,
  conversationId: string,
  x: number,
  y: number,
  fromRail: boolean
): TabDropTarget | null {
  /*
   * The rail answers first, and only for its own gestures.
   *
   * One gesture does both jobs: while the pointer is still over the list it is a
   * reorder, and the moment it leaves for a pane the existing move/split rules
   * take over unchanged.
   */
  const rail = dragGeometry.rail
  if (fromRail && rail !== null && contains(rail.rect, x, y) && rail.cards.length > 0) {
    const slot = railSlotAt(
      rail.cards.map((card) => card.rect.top + card.rect.height / 2),
      y
    )
    const before = rail.cards[slot]
    const last = rail.cards.at(-1)
    const top = before?.rect.top ?? (last === undefined ? rail.rect.top : last.rect.bottom)
    const left = (before ?? last)?.rect.left ?? rail.rect.left
    const width = (before ?? last)?.rect.width ?? rail.rect.width
    return {
      kind: 'rail-insert',
      slot,
      line: { left, top: Math.round(top) - 1, width },
      disabled: false,
    }
  }

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

/**
 * Keeps a long rail moving under a drag that has reached its edge.
 *
 * Without it a card can only be moved within the part of the list already on
 * screen, which is the case the feature is for: a rail short enough to see whole
 * is a rail you can reorder in one gesture anyway.
 */
function railAutoScroll(rail: RailGeometry | null, y: number): void {
  if (rail === null) return
  const scroller = document.querySelector<HTMLElement>('[data-rail-scroll]')
  if (scroller === null) return
  const zone = 48
  if (y < rail.rect.top + zone) scroller.scrollTop -= Math.max(4, (rail.rect.top + zone - y) / 3)
  else if (y > rail.rect.bottom - zone)
    scroller.scrollTop += Math.max(4, (y - (rail.rect.bottom - zone)) / 3)
}

export function useTabDrag(options: {
  onInsert: (conversationId: string, paneId: string, slot: number) => void
  onSplit: (conversationId: string, paneId: string, direction: SplitDirection) => void
  /** A card dropped back into the rail, at a gap in its own order. */
  onReorder: (conversationId: string, slot: number) => void
}): {
  drag: ActiveTabDrag | null
  onPointerDown: (
    conversationId: string,
    title: string,
    paneId: string | null,
    event: ReactPointerEvent<HTMLElement>
  ) => void
  consumeSuppressedClick: () => boolean
} {
  const pending = useRef<{
    conversationId: string
    title: string
    paneId: string | null
    /** Whether the gesture began on a rail shortcut or a drawer row. */
    fromRail: boolean
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
            event.clientY,
            current.fromRail
          )
          if (target?.kind === 'rail-insert') {
            options.onReorder(current.conversationId, target.slot)
          } else if (target?.kind === 'insert' || target?.kind === 'move') {
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
        event.clientY,
        current.fromRail
      )
      railAutoScroll(current.geometry.rail, event.clientY)
      setDrag({
        conversationId: current.conversationId,
        title: current.title,
        sourcePaneId: current.paneId,
        fromRail: current.fromRail,
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
      paneId: string | null,
      event: ReactPointerEvent<HTMLElement>
    ) => {
      if (event.button !== 0) return
      const start = {
        conversationId,
        title,
        paneId,
        /* Read before `paneId` is resolved against the panes; see `fromRail`. */
        fromRail: paneId === null,
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
        /*
         * A rail drag has no pane of its own, but the session might still have
         * one — you can drag an already-open session out of the list.
         *
         * Resolving that here rather than at the call site is what lets the
         * target rules below stay one set: an open session dragged from the rail
         * behaves exactly like its own tab being dragged, including the rule
         * that a one-tab pane disappears when its only tab leaves. A closed
         * session resolves to no source pane and no source tabs, which is the
         * honest description of a session that is nowhere.
         */
        const sourcePaneId =
          paneId ??
          measured.panes.find((pane) =>
            pane.tabs.some((tab) => tab.conversationId === conversationId)
          )?.paneId ??
          null
        const source = measured.panes.find((pane) => pane.paneId === sourcePaneId)
        const captured = {
          ...start,
          paneId: sourcePaneId,
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
          sourcePaneId,
          fromRail: start.fromRail,
          x: move.clientX,
          y: move.clientY,
          target: resolveTarget(
            captured.geometry,
            sourcePaneId,
            conversationId,
            move.clientX,
            move.clientY,
            start.fromRail
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
