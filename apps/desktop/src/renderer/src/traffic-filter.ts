import type { TrafficRowShape } from '../../shared/ipc.js'
import { isRefusal } from './traffic-stream.js'

export const PAGE = 200

export type TrafficOutcome = 'read' | 'refused' | 'backend' | 'unreadable' | 'aborted' | 'pending'

type HttpRow = Extract<TrafficRowShape, { source: 'http' }>

export const isPending = (row: HttpRow): boolean => !row.aborted && row.status === null

/**
 * What a request turned out to be, in one word.
 *
 * **One function, used by the label and by the filter.** Two copies would agree
 * until one of them was edited, and the failure would be a row that says
 * "refused" while a filter for refusals hides it — a contradiction that looks
 * like a bug in the data rather than in the code.
 */
export const outcomeOf = (row: HttpRow): TrafficOutcome => {
  if (row.aborted) return 'aborted'
  if (isPending(row)) return 'pending'
  if (isRefusal(row)) return 'refused'
  /*
   * Two ways to be a backend failure, and the second is not the first restated.
   *
   * A 502 is this side's own verdict when it could not reach upstream at all.
   * A `transport` reason means the exchange failed — which includes the case the
   * status cannot express: headers already sent, the socket dying part-way
   * through the body. That one carries the upstream's real status, so without
   * this line it read as a successful exchange whose body merely stopped.
   */
  if (row.transport !== null) return 'backend'
  if (row.status === 502) return 'backend'
  if (!row.parsed) return 'unreadable'
  return 'read'
}

/**
 * The status family a row's `data-class` is keyed on — `2xx`, `4xx`, `none`.
 *
 * Moved here from the panel when the inspector's header began carrying the same
 * attribute: the header has to name the same family the row does, and two copies
 * of this would agree until one was edited, at which point a failed endpoint
 * would be red in the list and grey in the header describing it.
 */
export const statusClassOf = (row: HttpRow): string => {
  if (row.aborted || row.status === null) return 'none'
  return `${String(Math.floor(row.status / 100))}xx`
}

/**
 * What the table draws for an endpoint: the path, without the origin or the query.
 *
 * Every row of a real capture begins with the same twenty-six characters —
 * `http://88.99.104.107:30081` — so the part that differs starts a quarter of the
 * way across the line, and the origin is the same string on every row. Dropping
 * it is what makes the column narrow enough to bound.
 *
 * **Display only, and deliberately not a change to `row.u`.** `isRefusal` tests
 * `isAbsolute(row.u)` and `filterRows` searches the whole value, so searching
 * for the host still has to find its rows even though the host is no longer
 * drawn. The full URL stays in the cell's `title`, and the inspector is
 * untouched — the request was for the table only.
 *
 * A line that is not an absolute URL — the 400 a proxy request without a target
 * produces — loses only its query, because there is no origin to remove.
 */
export const pathOf = (url: string, hiddenPathPrefix = ''): string => {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    const [beforeQuery = ''] = url.split('?', 1)
    path = beforeQuery
  }
  const prefix = hiddenPathPrefix.trim().replace(/\/+$/, '')
  if (!prefix.startsWith('/') || /[?#]/.test(prefix)) return path
  if (path === prefix) return '/'
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path
}

export const filterRows = (
  rows: readonly TrafficRowShape[],
  search: string
): readonly TrafficRowShape[] => {
  const needle = search.trim().toLowerCase()
  if (needle === '') return rows

  return rows.filter((row) =>
    row.source !== 'http'
      ? row.line.toLowerCase().includes(needle)
      : row.m.toLowerCase().includes(needle) ||
        row.u.toLowerCase().includes(needle) ||
        (row.code ?? '').toLowerCase().includes(needle) ||
        (row.nextAction ?? '').toLowerCase().includes(needle) ||
        (row.transport ?? '').toLowerCase().includes(needle)
  )
}

export interface TrafficPage {
  readonly rows: readonly TrafficRowShape[]
  readonly index: number
  readonly count: number
}

/**
 * One page of the list, in start-time order.
 *
 * `page: null` means the last page, which is the one a person watching wants —
 * and it stays the last page as rows arrive, so a live capture does not scroll
 * out from under them. Naming a page fixes it, so paging back through history
 * holds still while new requests land above.
 *
 * A page is a slice with its bounds reported, never a truncation: the tail that
 * is not on this page is on the next one, and the control says which.
 */
export const pageOf = (
  rows: readonly TrafficRowShape[],
  page: number | null,
  size = PAGE
): TrafficPage => {
  const count = Math.max(1, Math.ceil(rows.length / size))
  const index = page === null ? count - 1 : Math.min(Math.max(page, 0), count - 1)
  return { rows: rows.slice(index * size, (index + 1) * size), index, count }
}

/**
 * How far from the bottom still counts as following the newest row.
 *
 * **A tolerance rather than equality, and the reason is measurable rather than
 * defensive.** `scrollHeight - scrollTop - clientHeight` is fractional, and this
 * app has a zoom factor — at anything but 100% the three numbers round to
 * different fractions and an exact comparison is never true. A list that never
 * follows looks exactly like a list where the feature was never wired up, which
 * is the wrong thing to spend an afternoon on. About one row: far enough to
 * absorb the rounding, near enough that a person a row away is not still
 * following.
 */
export const FOLLOW_SLACK_PX = 24

/** The three numbers a scroll container reports, and all this asks of it. */
export interface RowScroll {
  readonly scrollHeight: number
  readonly scrollTop: number
  readonly clientHeight: number
}

/**
 * Whether the list should keep following the newest row.
 *
 * The page half is the button's answer: `page !== null` means somebody
 * deliberately went back through history, and nothing may move under them while
 * that holds. The distance half is the person's own — they scrolled up, so stop,
 * and they scroll back down, so resume.
 */
export const followsRows = (metrics: RowScroll, page: number | null): boolean =>
  page === null &&
  metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= FOLLOW_SLACK_PX
