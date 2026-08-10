import {
  CONFORMANCE_CHECKS,
  CONFORMANCE_OPTS,
  collectEvents,
  type ConformanceTarget,
} from '@chorus/agent-protocol'
import { describe, expect, it } from 'vitest'
import { FakeAdapter, type FakeAgentSession } from './testing/fake-adapter.js'

/**
 * Runs the shared conformance suite against every adapter that can be driven
 * without a real provider.
 *
 * `FakeAdapter` is the reference implementation. The Codex and Claude adapters
 * run the same suite in their own packages against injected transports — same
 * assertions, three implementations. That is what makes the `AgentAdapter` port
 * a contract rather than a shape (plan §8).
 */

function fakeTarget(): ConformanceTarget {
  const adapter = new FakeAdapter({ id: 'codex' })
  const live = (): FakeAgentSession => {
    const s = adapter.sessions.at(-1)
    if (s === undefined) throw new Error('no session started')
    return s
  }
  return {
    adapter,
    emitMessage: (_session, text) => {
      live().emit({ type: 'message.delta', itemRef: 'm1', text })
    },
    killProvider: () => {
      // Ends the stream without close() — indistinguishable from a crash, which
      // is the point.
      live().end()
    },
  }
}

const TARGETS: { name: string; create: () => ConformanceTarget }[] = [
  { name: 'FakeAdapter', create: fakeTarget },
]

describe.each(TARGETS)('conformance: $name', ({ create }) => {
  it('declares its capabilities', () => {
    expect(CONFORMANCE_CHECKS.declaresCapabilities(create().adapter)).toBeNull()
  })

  it('backs every declared capability with a method', () => {
    expect(CONFORMANCE_CHECKS.backsCapabilitiesWithMethods(create().adapter)).toBeNull()
  })

  it('exposes a resumable session reference', async () => {
    const target = create()
    const session = await target.adapter.start(CONFORMANCE_OPTS)
    expect(CONFORMANCE_CHECKS.exposesSessionRef(session)).toBeNull()
  })

  it('gives a fork an id of its own, not its parent’s', async () => {
    /*
     * The hazard `ForkOpts.persist` exists for. A branch that answers to its
     * parent's ref is saved under the child's name and resumed as the parent
     * on the next relaunch — invisible for an aside, which is never written
     * down, and a lost conversation for a promoted one.
     */
    const target = create()
    if (target.adapter.fork === undefined) return
    const parent = await target.adapter.start(CONFORMANCE_OPTS)
    const forked = await target.adapter.fork(parent.sessionRef, {
      ...CONFORMANCE_OPTS,
      inherits: 'config',
      persist: true,
    })
    expect(CONFORMANCE_CHECKS.forkHasItsOwnRef(parent.sessionRef, forked)).toBeNull()
  })

  it('emits events with monotonic seq and its own agent id', async () => {
    const target = create()
    const session = await target.adapter.start(CONFORMANCE_OPTS)

    for (const text of ['a', 'b', 'c']) await target.emitMessage(session, text)
    await target.killProvider(session)

    const events = await collectEvents(session, 3)
    expect(events.length).toBeGreaterThan(0)
    expect(CONFORMANCE_CHECKS.monotonicSeq(events)).toBeNull()
    expect(CONFORMANCE_CHECKS.stampsAgentId(target.adapter, events)).toBeNull()
  })

  it('ends its event stream when the provider dies', async () => {
    const target = create()
    const session = await target.adapter.start(CONFORMANCE_OPTS)
    await target.emitMessage(session, 'before the crash')
    await target.killProvider(session)

    let ended = false
    const drain = (async () => {
      for await (const _event of session.events) {
        // drain
      }
      ended = true
    })()
    await Promise.race([drain, new Promise((r) => setTimeout(r, 2_000))])

    expect(CONFORMANCE_CHECKS.endsStreamWhenProviderDies(ended)).toBeNull()
  })

  it('reports health without throwing when the provider is missing', async () => {
    const health = await create().adapter.health()
    expect(['ready', 'unauthenticated', 'unavailable']).toContain(health.state)
  })

  it('resumes onto the same provider reference', async () => {
    const target = create()
    const first = await target.adapter.start(CONFORMANCE_OPTS)
    const resumed = await target.adapter.resume(first.sessionRef, CONFORMANCE_OPTS)
    // Resume must reattach, not silently start a new conversation — otherwise
    // crash recovery loses the thread it was meant to preserve.
    expect(resumed.sessionRef).toBe(first.sessionRef)
  })
})
