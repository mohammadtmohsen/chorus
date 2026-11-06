import { flushSync } from 'react-dom'
import { insideWebsiteSurface } from '../website-surface.js'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  BOX_WIDTH,
  CONSOLE_WIDTH,
  EDITOR_WIDTH,
  PROJECT_TERMINAL_WIDTH,
  TRAFFIC_WIDTH,
} from '../../../shared/workspace-layout.js'
import { horizontalRowWheel } from './viewport.js'
import { clampEditorWidth, pushDivider } from './layout.js'

const TAB_STRIPS = '.conversation-dock-tabs, .terminal-tabs'

function tabStripAt(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(TAB_STRIPS) : null
}

function stripCanMove(strip: HTMLElement, delta: number): boolean {
  const end = strip.scrollWidth - strip.clientWidth
  return delta < 0 ? strip.scrollLeft >= 1 : strip.scrollLeft <= end - 1
}

export function routeRowWheel(row: HTMLElement): () => void {
  const onWheel = (event: WheelEvent): void => {
    if (event.shiftKey && insideWebsiteSurface(event.target)) return
    if (event.defaultPrevented) return
    const delta = horizontalRowWheel(event, row.clientWidth)
    if (delta === 0) return
    const strip = tabStripAt(event.target)
    const scrolled = strip !== null && stripCanMove(strip, delta) ? strip : row
    event.preventDefault()
    event.stopPropagation()
    scrolled.scrollLeft += delta
  }
  row.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => {
    row.removeEventListener('wheel', onWheel, { capture: true })
  }
}

export function startEditorResize(
  event: ReactPointerEvent<HTMLDivElement>,
  width: number,
  windowWidth: number,
  apply: (width: number) => void,
  commit: () => void
): void {
  if (event.button !== 0 || windowWidth <= 0) return
  const sash = event.currentTarget
  const originX = event.clientX
  const pointerId = event.pointerId
  let dragged = false
  let stopped = false
  sash.setPointerCapture(pointerId)
  const move = (moved: PointerEvent): void => {
    if (moved.pointerId !== pointerId || (moved.clientX === originX && !dragged)) return
    dragged = true
    flushSync(() => {
      apply(clampEditorWidth(width + moved.clientX - originX, windowWidth))
    })
  }
  const stop = (ended: PointerEvent): void => {
    if (ended.pointerId !== pointerId || stopped) return
    stopped = true
    sash.removeEventListener('pointermove', move)
    sash.removeEventListener('pointerup', stop)
    sash.removeEventListener('pointercancel', stop)
    sash.removeEventListener('lostpointercapture', stop)
    if (sash.hasPointerCapture(pointerId)) sash.releasePointerCapture(pointerId)
    if (dragged) commit()
  }
  sash.addEventListener('pointermove', move)
  sash.addEventListener('pointerup', stop)
  sash.addEventListener('pointercancel', stop)
  sash.addEventListener('lostpointercapture', stop)
}

export function stepEditorResize(
  event: ReactKeyboardEvent<HTMLDivElement>,
  width: number,
  windowWidth: number,
  apply: (width: number) => void
): void {
  const step = event.shiftKey ? 40 : 8
  const wanted =
    event.key === 'Home'
      ? EDITOR_WIDTH.min
      : event.key === 'End'
        ? windowWidth
        : event.key === 'ArrowLeft'
          ? width - step
          : event.key === 'ArrowRight'
            ? width + step
            : null
  if (wanted === null) return
  event.preventDefault()
  flushSync(() => {
    apply(clampEditorWidth(wanted, windowWidth))
  })
}

export interface RowWidths {
  readonly boxes: number[]
  readonly traffic: number | null
  readonly terminal: number | null
  readonly console: number | null
}

type RowItemKind = 'box' | 'traffic' | 'terminal' | 'console' | 'fixed'

interface RowItems {
  readonly kinds: readonly RowItemKind[]
  readonly frozen: readonly number[]
  readonly minimums: readonly number[]
  readonly index: number
}

const isSash = (element: Element): boolean => element.classList.contains('conversation-sash')

function rowItemKind(element: Element): RowItemKind {
  if (element.getAttribute('data-collapsed') === 'true') return 'fixed'
  if (element.classList.contains('console-box')) return 'console'
  if (element.classList.contains('conversation-slot')) return 'box'
  if (element.classList.contains('traffic-box')) return 'traffic'
  if (element.classList.contains('project-terminal-box')) return 'terminal'
  return 'fixed'
}

function declaredMinimum(item: Element | undefined, floor: number): number {
  const declared = Number(item?.getAttribute('data-min-width'))
  return Number.isFinite(declared) && declared > floor ? declared : floor
}

function rowItems(sash: HTMLElement): RowItems | null {
  const row = sash.parentElement
  if (row === null) return null
  const children = [...row.children]
  const items = children.filter((child) => !isSash(child))
  const kinds = items.map(rowItemKind)
  const frozen = items.map((item) => item.getBoundingClientRect().width)
  const minimums = kinds.map((kind, at) => {
    if (kind === 'box') return BOX_WIDTH.min
    if (kind === 'traffic') return declaredMinimum(items[at], TRAFFIC_WIDTH.min)
    if (kind === 'terminal') return declaredMinimum(items[at], PROJECT_TERMINAL_WIDTH.min)
    if (kind === 'console') return CONSOLE_WIDTH.min
    return frozen[at] ?? 0
  })
  const index = children.slice(0, children.indexOf(sash)).filter((child) => !isSash(child)).length
  return { kinds, frozen, minimums, index }
}

function rowWidths(items: RowItems, pushed: readonly number[]): RowWidths {
  const trafficAt = items.kinds.indexOf('traffic')
  const terminalAt = items.kinds.indexOf('terminal')
  const consoleAt = items.kinds.indexOf('console')
  return {
    boxes: pushed.filter((_, at) => items.kinds[at] === 'box'),
    traffic: trafficAt < 0 ? null : (pushed[trafficAt] ?? null),
    terminal: terminalAt < 0 ? null : (pushed[terminalAt] ?? null),
    console: consoleAt < 0 ? null : (pushed[consoleAt] ?? null),
  }
}

function rowScroll(items: RowItems, scroll: number): number {
  return items.kinds[items.index] === 'fixed' ? 0 : scroll
}

export function startRowPush(
  event: ReactPointerEvent<HTMLDivElement>,
  apply: (row: RowWidths) => void,
  commit: () => void
): void {
  if (event.button !== 0) return
  const sash = event.currentTarget
  const scroller = sash.parentElement
  const items = rowItems(sash)
  if (scroller === null || items === null) return
  const originX = event.clientX
  const originScroll = scroller.scrollLeft
  let dragged = false
  sash.setPointerCapture(event.pointerId)
  const move = (moved: PointerEvent): void => {
    if (moved.clientX === originX && !dragged) return
    dragged = true
    const pushed = pushDivider(items.frozen, items.index, moved.clientX - originX, items.minimums)
    const row = rowWidths(items, pushed.widths)
    flushSync(() => {
      apply(row)
    })
    scroller.scrollLeft = originScroll + rowScroll(items, pushed.scroll)
  }
  const stop = (): void => {
    sash.removeEventListener('pointermove', move)
    sash.removeEventListener('pointerup', stop)
    sash.removeEventListener('pointercancel', stop)
    sash.releasePointerCapture(event.pointerId)
    if (dragged) commit()
  }
  sash.addEventListener('pointermove', move)
  sash.addEventListener('pointerup', stop)
  sash.addEventListener('pointercancel', stop)
}

export function stepRow(
  event: ReactKeyboardEvent<HTMLDivElement>,
  apply: (row: RowWidths) => void
): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const sash = event.currentTarget
  const scroller = sash.parentElement
  const items = rowItems(sash)
  if (scroller === null || items === null) return
  event.preventDefault()
  const step = event.shiftKey ? 40 : 8
  const pushed = pushDivider(
    items.frozen,
    items.index,
    event.key === 'ArrowLeft' ? -step : step,
    items.minimums
  )
  flushSync(() => {
    apply(rowWidths(items, pushed.widths))
  })
  scroller.scrollLeft += rowScroll(items, pushed.scroll)
}
