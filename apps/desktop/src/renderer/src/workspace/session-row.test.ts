import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../Session.js'
import {
  monogramOf,
  monogramsFor,
  projectRow,
  reorderSessions,
  stateOf,
  stepSlot,
  type SessionRowState,
} from './session-row.js'

const IDLE: SessionRowState = { waiting: 0, working: [], unread: 0, failed: false }

const session = (conversationId: string, title: string): SessionInfo => ({
  conversationId,
  participants: ['claude'],
  cwd: '/tmp',
  profileId: 'read-only',
  title,
})

describe('stateOf', () => {
  it('puts a request ahead of a report', () => {
    expect(stateOf({ ...IDLE, waiting: 1, working: ['claude'] })).toBe('waiting')
  })

  it('reads working when nothing is waiting', () => {
    expect(stateOf({ ...IDLE, working: ['codex'] })).toBe('working')
  })

  /*
   * A failed turn outranks idle and is outranked by a new one starting, which
   * together mean a failure is visible until something else happens rather than
   * until the next repaint.
   */
  it('keeps a failure visible while nothing else is happening', () => {
    expect(stateOf({ ...IDLE, failed: true })).toBe('failed')
    expect(stateOf({ ...IDLE, failed: true, working: ['claude'] })).toBe('working')
  })

  it('is idle otherwise', () => {
    expect(stateOf(IDLE)).toBe('idle')
  })
})

describe('projectRow', () => {
  it('shows the waiting count rather than the unread one', () => {
    const facts = projectRow(
      session('a', 'Fix login'),
      { waiting: 2, working: [], unread: 9, failed: false },
      'offscreen',
      'FL'
    )
    expect(facts.count).toBe(2)
    expect(facts.state).toBe('waiting')
  })

  it('shows unread when nothing is waiting', () => {
    const facts = projectRow(session('a', 'Fix login'), { ...IDLE, unread: 3 }, 'open', 'FL')
    expect(facts.count).toBe(3)
    expect(facts.state).toBe('idle')
  })

  /*
   * The voice is what colours "working", and two agents at once has no single
   * owner — a row that picked one would be naming the wrong agent half the time.
   */
  it('names the working voice only when exactly one is working', () => {
    const one = projectRow(session('a', 'x'), { ...IDLE, working: ['codex'] }, 'open', 'X')
    const two = projectRow(
      session('a', 'x'),
      { ...IDLE, working: ['codex', 'claude'] },
      'open',
      'X'
    )
    expect(one.voice).toBe('codex')
    expect(two.voice).toBeNull()
  })
})

describe('monogramOf', () => {
  it('takes an initial from each of the first two words', () => {
    expect(monogramOf('Fix login')).toBe('FL')
    expect(monogramOf('refactor api client')).toBe('RA')
  })

  it('falls back to the first two characters of a single word', () => {
    expect(monogramOf('chorus')).toBe('CH')
  })

  it('does not produce a half-empty mark from a one-character title', () => {
    expect(monogramOf('x')).toBe('XX')
  })

  it('survives a title with nothing to take an initial from', () => {
    expect(monogramOf('···')).toBe('··')
    expect(monogramOf('')).toBe('··')
  })

  it('reads a path-like title as its separated parts', () => {
    expect(monogramOf('chorus-web')).toBe('CW')
  })
})

describe('monogramsFor', () => {
  /*
   * The plan's own named risk: two-letter marks collide, and colour is not
   * allowed to be the thing that distinguishes them.
   */
  it('distinguishes duplicates with a deterministic suffix', () => {
    const marks = monogramsFor([
      session('a', 'chorus-web'),
      session('b', 'chorus-worker'),
      session('c', 'chorus-wire'),
    ])
    expect([...marks.values()]).toEqual(['CW', 'CW2', 'CW3'])
  })

  it('leaves a unique mark alone', () => {
    const marks = monogramsFor([session('a', 'Fix login'), session('b', 'Refactor api')])
    expect([...marks.values()]).toEqual(['FL', 'RA'])
  })
})

/**
 * The three answers a rail drop can produce, in the terms the drop speaks.
 *
 * A gap index is not a position: dropping a card into the gap *below itself* is
 * the same list, and getting that wrong makes every drop that misses look like a
 * move by one.
 */
describe('reorderSessions from a rail drop', () => {
  it('moves a card up to the gap it was dropped in', () => {
    expect(reorderSessions(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'c', 'b'])
  })

  it('moves a card down, counting the gap it vacates', () => {
    expect(reorderSessions(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'a', 'c'])
  })

  it('is a no-op for the gaps either side of the card itself', () => {
    expect(reorderSessions(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c'])
    expect(reorderSessions(['a', 'b', 'c'], 'b', 2)).toEqual(['a', 'b', 'c'])
  })

  it('leaves the order alone for a card that is not in it', () => {
    expect(reorderSessions(['a', 'b'], 'gone', 0)).toEqual(['a', 'b'])
  })
})

describe('reorderSessions', () => {
  it('moves a session up to a gap above it', () => {
    expect(reorderSessions(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  })

  /*
   * Dropping below your own position has to discount the hole you left. Without
   * it, "move b to the gap after c" lands b before c and the row does not move.
   */
  it('discounts the hole when moving down', () => {
    expect(reorderSessions(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a'])
    expect(reorderSessions(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'a', 'c'])
  })

  it('returns the same array when nothing moves', () => {
    const order = ['a', 'b', 'c']
    expect(reorderSessions(order, 'b', 1)).toBe(order)
    expect(reorderSessions(order, 'b', 2)).toBe(order)
    expect(reorderSessions(order, 'missing', 0)).toBe(order)
  })

  it('clamps a slot beyond either end', () => {
    expect(reorderSessions(['a', 'b'], 'b', 99)).toEqual(['a', 'b'])
    expect(reorderSessions(['a', 'b'], 'b', -4)).toEqual(['b', 'a'])
  })
})

describe('stepSlot', () => {
  it('is null at the end it cannot move past', () => {
    expect(stepSlot(['a', 'b'], 'a', 'up')).toBeNull()
    expect(stepSlot(['a', 'b'], 'b', 'down')).toBeNull()
  })

  it('moves one place when there is somewhere to go', () => {
    expect(
      reorderSessions(['a', 'b', 'c'], 'b', stepSlot(['a', 'b', 'c'], 'b', 'up') ?? 0)
    ).toEqual(['b', 'a', 'c'])
    expect(
      reorderSessions(['a', 'b', 'c'], 'b', stepSlot(['a', 'b', 'c'], 'b', 'down') ?? 0)
    ).toEqual(['a', 'c', 'b'])
  })
})
