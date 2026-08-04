import type { ApprovalDecision, ApprovalRequest } from '@chorus/agent-protocol'
import type { ApprovalId } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import type { Scheduler } from '../delta-buffer.js'
import { ApprovalQueue, type PendingEntry } from './queue.js'

function clock(): Scheduler & { advance: (ms: number) => void } {
  let time = 0
  let pending: { fn: () => void; at: number } | null = null
  return {
    setTimeout(fn, ms) {
      pending = { fn, at: time + ms }
      return 1
    },
    clearTimeout() {
      pending = null
    },
    now: () => time,
    advance(ms) {
      time += ms
      if (pending !== null && pending.at <= time) {
        const due = pending
        pending = null
        due.fn()
      }
    },
  }
}

const request = (id: string, expiresAt: number): ApprovalRequest => ({
  id: id as ApprovalId,
  agentId: 'codex',
  kind: 'command',
  command: ['npm', 'test'],
  cwd: '/repo',
  withNetwork: false,
  expiresAt,
})

function make(scheduler: Scheduler) {
  const resolved: { entry: PendingEntry; decision: ApprovalDecision; by: string }[] = []
  const queue = new ApprovalQueue({
    scheduler,
    onResolved: (entry, decision, by) => {
      resolved.push({ entry, decision, by })
    },
  })
  return { queue, resolved }
}

describe('ApprovalQueue', () => {
  it('holds several approvals at once', () => {
    // Two agents, or one batching, can be waiting together.
    const { queue } = make(clock())
    queue.add('c1', request('a', 10_000))
    queue.add('c1', request('b', 10_000))
    expect(queue.size).toBe(2)
    expect(queue.list().map((e) => e.request.id)).toEqual(['a', 'b'])
  })

  it('resolves the matching approval and leaves the rest', async () => {
    const { queue, resolved } = make(clock())
    queue.add('c1', request('a', 10_000))
    queue.add('c1', request('b', 10_000))

    await queue.resolve('a', { outcome: 'allow', scope: 'once' })
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.entry.request.id).toBe('a')
    expect(queue.size).toBe(1)
  })

  it('treats an unknown id as a no-op rather than an error', async () => {
    // A double-click resolves twice; the second must not throw.
    const { queue } = make(clock())
    queue.add('c1', request('a', 10_000))
    expect(await queue.resolve('a', { outcome: 'deny', message: 'no' })).toBe(true)
    expect(await queue.resolve('a', { outcome: 'deny', message: 'no' })).toBe(false)
  })

  it('denies on expiry — never allows', async () => {
    // Auto-allowing something nobody looked at would turn a screensaver into a
    // permission grant.
    const scheduler = clock()
    const { queue, resolved } = make(scheduler)
    queue.add('c1', request('a', 5_000))

    scheduler.advance(4_000)
    await queue.sweep()
    expect(resolved).toHaveLength(0)

    scheduler.advance(2_000)
    await queue.sweep()
    expect(resolved[0]).toMatchObject({ decision: { outcome: 'timeout' }, by: 'system' })
    expect(queue.size).toBe(0)
  })

  it('sweeps automatically without anyone calling it', async () => {
    const scheduler = clock()
    const { queue, resolved } = make(scheduler)
    queue.add('c1', request('a', 500))

    scheduler.advance(1_000)
    await Promise.resolve()
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.decision.outcome).toBe('timeout')
  })

  it('expires only what is past its deadline', async () => {
    const scheduler = clock()
    const { queue, resolved } = make(scheduler)
    queue.add('c1', request('soon', 1_000))
    queue.add('c1', request('later', 60_000))

    scheduler.advance(2_000)
    await queue.sweep()
    expect(resolved.map((r) => r.entry.request.id)).toEqual(['soon'])
    expect(queue.size).toBe(1)
  })

  it('denies everything outstanding when drained', async () => {
    // Closing a session must not leave an agent blocked on a prompt nobody
    // will ever see.
    const { queue, resolved } = make(clock())
    queue.add('c1', request('a', 60_000))
    queue.add('c1', request('b', 60_000))

    await queue.drain('Session closed')
    expect(resolved).toHaveLength(2)
    expect(resolved.every((r) => r.decision.outcome === 'deny')).toBe(true)
    expect(queue.size).toBe(0)
  })

  it('records who decided, so the audit trail can tell them apart', async () => {
    const { queue, resolved } = make(clock())
    queue.add('c1', request('a', 60_000))
    await queue.resolve('a', { outcome: 'allow', scope: 'session' }, 'policy')
    expect(resolved[0]?.by).toBe('policy')
  })
})
