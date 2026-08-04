import {
  CONFORMANCE_CHECKS,
  CONFORMANCE_OPTS,
  collectEvents,
  type ConformanceTarget,
} from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'

/**
 * The shared conformance suite, run against the real `ClaudeAdapter` with the
 * SDK's `query()` replaced by a driveable stub.
 *
 * This is the point of the suite: the same assertions that `FakeAdapter` passes
 * in the orchestrator package must hold for a real adapter, or the
 * `AgentAdapter` port is a shape rather than a contract (plan §8).
 */

interface Driver {
  push: (message: unknown) => void
  /** Ends the stream without a clean close — what a dead CLI looks like. */
  kill: () => void
  interrupts: number
}

function stubTarget(): ConformanceTarget & { driver: () => Driver } {
  const drivers: Driver[] = []

  const adapter = new ClaudeAdapter({
    now: () => 1_000,
    createQuery: () => {
      const messages = new AsyncQueue<unknown>()
      const driver: Driver = {
        push: (m) => {
          messages.push(m)
        },
        kill: () => {
          messages.close()
        },
        interrupts: 0,
      }
      drivers.push(driver)

      const stub = {
        [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
        interrupt: () => {
          driver.interrupts++
          return Promise.resolve(undefined)
        },
        setModel: () => Promise.resolve(),
        close: () => undefined,
      }
      return stub as unknown as Query
    },
  })

  const latest = (): Driver => {
    const d = drivers.at(-1)
    if (d === undefined) throw new Error('no query created')
    return d
  }

  return {
    adapter,
    driver: latest,
    emitMessage: (_session, text) => {
      latest().push({
        type: 'assistant',
        uuid: `u-${text}`,
        session_id: 'sess-1',
        message: { content: [{ type: 'text', text }] },
      })
    },
    killProvider: () => {
      latest().kill()
    },
  }
}

// A real adapter needs a directory that exists; several validate it.
const OPTS = { ...CONFORMANCE_OPTS, cwd: mkdtempSync(join(tmpdir(), 'chorus-conformance-')) }
describe('conformance: ClaudeAdapter', () => {
  it('declares its capabilities', () => {
    expect(CONFORMANCE_CHECKS.declaresCapabilities(stubTarget().adapter)).toBeNull()
  })

  it('exposes a resumable session reference', async () => {
    const target = stubTarget()
    const session = await target.adapter.start(OPTS)
    expect(CONFORMANCE_CHECKS.exposesSessionRef(session)).toBeNull()
  })

  it('emits events with monotonic seq and its own agent id', async () => {
    const target = stubTarget()
    const session = await target.adapter.start(OPTS)

    for (const text of ['a', 'b', 'c']) await target.emitMessage(session, text)
    await target.killProvider(session)

    const events = await collectEvents(session, 10)
    expect(events.length).toBeGreaterThan(0)
    expect(CONFORMANCE_CHECKS.monotonicSeq(events)).toBeNull()
    expect(CONFORMANCE_CHECKS.stampsAgentId(target.adapter, events)).toBeNull()
  })

  it('ends its event stream when the provider dies', async () => {
    // The M2 bug this exists to stop recurring: a stream that stays open after
    // the process dies looks alive while doing nothing, and the supervisor
    // never restarts it.
    const target = stubTarget()
    const session = await target.adapter.start(OPTS)
    await target.emitMessage(session, 'before the crash')
    await target.killProvider(session)

    for await (const _event of session.events) {
      // Drains to completion. If the stream never ends this hangs, which vitest
      // reports as a timeout — the failure mode we want to be loud.
    }
    expect(CONFORMANCE_CHECKS.endsStreamWhenProviderDies(true)).toBeNull()
  })

  it('adopts the session id the provider reports', async () => {
    const target = stubTarget()
    const session = await target.adapter.start(OPTS)
    target
      .driver()
      .push({ type: 'system', subtype: 'init', session_id: 'real-session', uuid: 'u1' })
    target.driver().kill()
    await collectEvents(session, 5)
    // A resume needs the provider's own id, not the empty string we start with.
    expect(session.sessionRef).toBe('real-session')
  })

  it('reports health without throwing when the binary is missing', async () => {
    const adapter = new ClaudeAdapter({ command: 'claude-does-not-exist' })
    const health = await adapter.health()
    expect(health.state).toBe('unavailable')
  })
})
