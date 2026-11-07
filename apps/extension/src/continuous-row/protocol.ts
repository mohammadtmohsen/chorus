export const CONTINUOUS_ROW = 'chorus-continuous-row'
export const CHORUS_COMPOSITE = 'workbench.view.extension.chorus-sidebar'
export const CHORUS_EXTENSION_ID = 'mohammadtmohsen.chorus'
export const WORKBENCH_MIN = 500
export const EDITOR_PART_MIN = 220
export const CHORUS_MIN = 180
export const BROWSER_VIEW_WHEEL = 'vscode:chorusBrowserWheel'

interface Envelope {
  readonly source: typeof CONTINUOUS_ROW
}

export type RowMessage = Envelope &
  (
    | { readonly kind: 'hello'; readonly session: number }
    | {
        readonly kind: 'row'
        readonly session: number
        readonly generation: number
        readonly row: number
        readonly rowMax: number
        readonly applied: number
      }
    | { readonly kind: 'page-target'; readonly seq: number; readonly page: number }
  )

export type PageMessage = Envelope &
  (
    | {
        readonly kind: 'page'
        readonly page: number
        readonly extra: number
        readonly inset: number
        readonly applied: number
      }
    | {
        readonly kind: 'row-target'
        readonly seq: number
        readonly generation: number
        readonly row: number
      }
  )

export interface Strip {
  readonly page: number
  readonly extra: number
  readonly row: number
  readonly rowMax: number
}

export interface RowBounds {
  readonly barRight: number
  readonly floor: number
  readonly widest: number
}

function envelope(data: unknown): object | null {
  return typeof data === 'object' && data !== null && Reflect.get(data, 'source') === CONTINUOUS_ROW
    ? data
    : null
}

function numbers<K extends string>(data: object, keys: readonly K[]): Record<K, number> | null {
  const picked: Partial<Record<K, number>> = {}
  for (const key of keys) {
    const value: unknown = Reflect.get(data, key)
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    picked[key] = value
  }
  return picked as Record<K, number>
}

export function readRowMessage(data: unknown): RowMessage | null {
  const message = envelope(data)
  if (message === null) return null
  const kind: unknown = Reflect.get(message, 'kind')
  if (kind === 'hello') {
    const read = numbers(message, ['session'])
    return read === null ? null : { source: CONTINUOUS_ROW, kind, ...read }
  }
  if (kind === 'row') {
    const read = numbers(message, ['session', 'generation', 'row', 'rowMax', 'applied'])
    return read === null ? null : { source: CONTINUOUS_ROW, kind, ...read }
  }
  if (kind === 'page-target') {
    const read = numbers(message, ['seq', 'page'])
    return read === null ? null : { source: CONTINUOUS_ROW, kind, ...read }
  }
  return null
}

export function readPageMessage(data: unknown): PageMessage | null {
  const message = envelope(data)
  if (message === null) return null
  const kind: unknown = Reflect.get(message, 'kind')
  if (kind === 'page') {
    const read = numbers(message, ['page', 'extra', 'inset', 'applied'])
    return read === null ? null : { source: CONTINUOUS_ROW, kind, ...read }
  }
  if (kind === 'row-target') {
    const read = numbers(message, ['seq', 'generation', 'row'])
    return read === null ? null : { source: CONTINUOUS_ROW, kind, ...read }
  }
  return null
}

export function rowBounds(screen: number, barRight: number, sideRight: number): RowBounds {
  return {
    barRight,
    floor: Math.max(WORKBENCH_MIN, sideRight + EDITOR_PART_MIN),
    widest: screen - CHORUS_MIN,
  }
}

export function editorEdge(left: number, bounds: RowBounds): number {
  return Math.max(bounds.floor, Math.min(bounds.widest, left))
}

export function stripOf(left: number, bounds: RowBounds): { page: number; extra: number } {
  return {
    page: Math.round(bounds.widest - left),
    extra: Math.max(0, Math.round(bounds.widest - bounds.barRight)),
  }
}

export function slideStrip(strip: Strip, delta: number): Strip {
  if (delta > 0) {
    const page = Math.min(strip.extra, strip.page + delta)
    const row = Math.min(strip.rowMax, strip.row + delta - (page - strip.page))
    return { ...strip, page, row }
  }
  const row = Math.max(0, strip.row + delta)
  const page = Math.max(0, strip.page + delta - (row - strip.row))
  return { ...strip, page, row }
}
