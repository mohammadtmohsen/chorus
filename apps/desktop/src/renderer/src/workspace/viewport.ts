export interface ActivityBarRect {
  readonly left: number
  readonly width: number
}

export function isCropped(viewportWidth: number, rootWidth: number): boolean {
  return rootWidth - viewportWidth > 1
}

export function horizontalRowWheel(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  pageWidth: number
): number {
  if (event.ctrlKey || event.metaKey) return 0
  if (!event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return 0
  const delta = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0
  const unit =
    event.deltaMode === 0 ? 1 : event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageWidth : 0
  const pixels = delta * unit
  return Number.isFinite(pixels) ? pixels : 0
}

export interface WheelModifiers {
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
}

const NO_MODIFIERS: WheelModifiers = { shiftKey: false, ctrlKey: false, metaKey: false }

export function trackModifiers(): {
  readonly update: (event: WheelModifiers) => void
  readonly reset: () => void
  readonly current: () => WheelModifiers
} {
  let held = NO_MODIFIERS
  return {
    update: (event) => {
      held = { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey }
    },
    reset: () => {
      held = NO_MODIFIERS
    },
    current: () => held,
  }
}

export function addsIframe(
  records: Iterable<{ readonly addedNodes: Iterable<{ readonly nodeName: string }> }>
): boolean {
  for (const record of records) {
    for (const node of record.addedNodes) if (node.nodeName === 'IFRAME') return true
  }
  return false
}

export interface WheelSource<E> {
  readonly onDidWheel: (listener: (event: E) => void) => unknown
}

export function watchWheelSources<W extends WheelSource<E>, E>(
  forward: (event: E) => void
): (sources: Iterable<W>) => void {
  const watched = new WeakSet<W>()
  let last: E | null = null
  const onWheel = (event: E): void => {
    if (event === last) return
    last = event
    forward(event)
  }
  return (sources) => {
    for (const source of sources) {
      if (watched.has(source)) continue
      watched.add(source)
      source.onDidWheel(onWheel)
    }
  }
}

export function leftActivityBarWidth(bar: ActivityBarRect | null, rootLeft: number): number {
  if (bar === null || bar.width <= 0) return 0
  if (Math.abs(bar.left - rootLeft) > 1) return 0
  return Math.round(bar.width)
}
