import { describe, expect, it } from 'vitest'
import type { TrafficRowShape } from '../../shared/ipc.js'
import { filterRows, followsRows, outcomeOf, PAGE, pageOf, pathOf } from './traffic-filter.js'

type HttpRow = Extract<TrafficRowShape, { source: 'http' }>
type LogRow = Extract<TrafficRowShape, { source: 'log' }>

const row = (seq: number, over: Partial<HttpRow> = {}): HttpRow => ({
  source: 'http',
  seq,
  requestId: `r${String(seq)}`,
  m: 'GET',
  u: `http://127.0.0.1:9000/n/${String(seq)}`,
  dpop: false,
  status: 200,
  aborted: false,
  parsed: true,
  code: 'OK',
  nextAction: null,
  transport: null,
  ...over,
})

const logRow = (seq: number, line: string): LogRow => ({
  source: 'log',
  seq,
  ref: { scope: 'global', id: 't1' },
  line,
  exit: null,
})

describe('outcomeOf', () => {
  it('names each situation once, in the order that matters', () => {
    expect(outcomeOf(row(1, { aborted: true, status: 400, u: '/x' }))).toBe('aborted')
    expect(outcomeOf(row(2, { status: 400, u: '/origin-form' }))).toBe('refused')
    expect(outcomeOf(row(3, { status: 502 }))).toBe('backend')
    expect(outcomeOf(row(4, { parsed: false }))).toBe('unreadable')
    expect(outcomeOf(row(5))).toBe('read')
    expect(outcomeOf(row(6, { status: null, parsed: false }))).toBe('pending')
    expect(outcomeOf(row(7, { status: null, aborted: true }))).toBe('aborted')
  })
})

describe('pathOf', () => {
  const prefix = '/api/v1/provider-online'

  it('hides a leading path prefix and drops the query for absolute and relative URLs', () => {
    const path = `${prefix}/contexts/POS-1/visits`
    expect(pathOf(`https://example.com${path}?page=2`, prefix)).toBe('/contexts/POS-1/visits')
    expect(pathOf(`${path}?page=2`, prefix)).toBe('/contexts/POS-1/visits')
    expect(pathOf(`https://example.com${path}?page=2`)).toBe(path)
  })

  it('shows the root when the prefix matches the entire path', () => {
    expect(pathOf(`https://example.com${prefix}`, prefix)).toBe('/')
    expect(pathOf(`${prefix}?page=2`, prefix)).toBe('/')
    expect(pathOf(`${prefix}/?page=2`, prefix)).toBe('/')
  })

  it('keeps different paths, partial segment matches and later occurrences intact', () => {
    expect(pathOf(`${prefix}-admin/me`, prefix)).toBe(`${prefix}-admin/me`)
    expect(pathOf(`/other${prefix}/me`, prefix)).toBe(`/other${prefix}/me`)
    expect(pathOf('/api/mobile/v1/me', prefix)).toBe('/api/mobile/v1/me')
  })

  it('tolerates surrounding whitespace and trailing slashes', () => {
    expect(pathOf(`${prefix}/me`, `  ${prefix}/  `)).toBe('/me')
  })

  it('keeps the complete path for blank, root or invalid path prefixes', () => {
    const path = `${prefix}/me`
    const url = `${path}?next=/api/v1`
    expect(pathOf(url, '   ')).toBe(path)
    expect(pathOf(url, '/')).toBe(path)
    expect(pathOf(url, 'api/v1')).toBe(path)
    expect(pathOf(url, `${prefix}/me?next=`)).toBe(path)
    expect(pathOf(url, `${prefix}/me#fragment`)).toBe(path)
  })
})

describe('filterRows', () => {
  const rows = [
    row(1, { m: 'GET', code: 'OK' }),
    row(2, { m: 'POST', status: 404, code: 'NOT_FOUND' }),
    row(3, { m: 'POST', status: null }),
    logRow(4, 'Metro waiting on 8081'),
  ]

  it('returns everything when nothing is asked, including for blank space', () => {
    expect(filterRows(rows, '')).toHaveLength(4)
    expect(filterRows(rows, '   ')).toHaveLength(4)
  })

  it('searches the fields the plan names, and not the body', () => {
    expect(filterRows(rows, 'not_found').map((each) => each.seq)).toEqual([2])
    expect(filterRows(rows, '/n/3').map((each) => each.seq)).toEqual([3])
  })

  it('searches a terminal line too, since nothing asks only about requests now', () => {
    expect(filterRows(rows, 'metro').map((each) => each.seq)).toEqual([4])
  })
})

describe('pageOf', () => {
  const rows = Array.from({ length: PAGE * 2 + 5 }, (_, index) => row(index + 1))

  it('shows the newest page when the page is not named', () => {
    const page = pageOf(rows, null)
    expect(page.count).toBe(3)
    expect(page.index).toBe(2)
    expect(page.rows).toHaveLength(5)
    expect(page.rows[0]?.seq).toBe(PAGE * 2 + 1)
  })

  it('holds a named page still rather than following the tail', () => {
    expect(pageOf(rows, 0).rows[0]?.seq).toBe(1)
    expect(pageOf(rows, 1).rows).toHaveLength(PAGE)
  })

  it('clamps a page past the end rather than showing nothing', () => {
    expect(pageOf(rows, 9).index).toBe(2)
    expect(pageOf(rows, -3).index).toBe(0)
  })

  it('is one page of nothing when there is nothing, not zero pages', () => {
    const page = pageOf([], null)
    expect(page.count).toBe(1)
    expect(page.rows).toEqual([])
  })
})

/*
 * The predicate only. Whether the effect actually scrolls is a layout question,
 * and jsdom does no layout — `scrollHeight` and `clientHeight` are both 0 there,
 * so a test of the scroll itself would pass without the effect existing at all.
 * That half is the driver's, and this is the judgement it makes.
 */
describe('followsRows', () => {
  const at = (scrollHeight: number, scrollTop: number, clientHeight: number) => ({
    scrollHeight,
    scrollTop,
    clientHeight,
  })

  it('follows while the list is at the bottom', () => {
    expect(followsRows(at(1_000, 400, 600), null)).toBe(true)
  })

  /*
   * The tolerance is the feature rather than a rounding detail. This app has a
   * zoom factor, so the three numbers are fractional and an exact comparison is
   * never true at anything but 100% — a predicate demanding equality would
   * report "not following" for a list sitting exactly at the bottom.
   */
  it('still follows from within a row of the bottom', () => {
    expect(followsRows(at(1_000, 380, 600), null)).toBe(true)
  })

  it('stops once the person has scrolled away', () => {
    expect(followsRows(at(1_000, 300, 600), null)).toBe(false)
  })

  /* The button's answer, and it outranks the distance: somebody chose this page. */
  it('does not follow while a page is pinned, however near the bottom', () => {
    expect(followsRows(at(1_000, 400, 600), 2)).toBe(false)
  })
})
