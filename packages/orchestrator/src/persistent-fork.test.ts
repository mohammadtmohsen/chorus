import type { AgentAdapter } from '@chorus/agent-protocol'
import { describe, expect, it } from 'vitest'
import { SupervisedSession } from './supervisor.js'
import { FakeAdapter } from './testing/fake-adapter.js'

/**
 * A persistent fork, supervised.
 *
 * Phase 1 of docs/plans/aside-that-acts-2026-08-10/part-b.md. An aside's fork is
 * thrown away with its question, so a raw session is right for it. A branch that
 * becomes a conversation is not: it is saved, resumed after a relaunch, and
 * restarted after a crash — all of which depend on it knowing its own id.
 */

const OPTS = {
  cwd: process.cwd(),
  sandbox: { mode: 'readOnly' as const, writableRoots: [], networkAccess: false },
  inherits: 'config' as const,
}

describe('SupervisedSession.fork', () => {
  it('supervises the branch, so a crash does not lose the room', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    const session = await SupervisedSession.fork(adapter, 'parent-1', { ...OPTS, persist: true })
    expect(session.sessionRef).not.toBe('parent-1')
    expect(adapter.forked[0]?.from).toBe('parent-1')
    expect(adapter.forked[0]?.persist).toBe(true)
  })

  it('refuses a fork still carrying its parent’s id', async () => {
    /*
     * The hazard this phase exists for. Claude's query-based fork reports the
     * parent's ref until the child announces itself; an aside is never written
     * down so it does not matter, but a persistent branch is saved to
     * open-sessions.json — and the restart path resumes `sessionRef`, so the
     * first crash would put the user back in the conversation they branched
     * away from, believing it was the branch.
     */
    const adapter = new FakeAdapter({ id: 'claude' })
    adapter.forkKeepsParentRef = true
    await expect(
      SupervisedSession.fork(adapter, 'parent-1', { ...OPTS, persist: true })
    ).rejects.toThrow(/own id/)
  })

  it('refuses an adapter that cannot fork, rather than failing later', async () => {
    // The capability flag and the method are checked together by conformance;
    // here the point is that a missing implementation is a refusal, not a crash
    // three steps later inside the supervisor.
    const adapter = new FakeAdapter({ id: 'claude', capabilities: { fork: false } })
    const noFork: AgentAdapter = {
      id: adapter.id,
      capabilities: adapter.capabilities,
      start: (o) => adapter.start(o),
      resume: (r, o) => adapter.resume(r, o),
      health: () => adapter.health(),
      dispose: () => adapter.dispose(),
    }
    await expect(
      SupervisedSession.fork(noFork, 'parent-1', { ...OPTS, persist: true })
    ).rejects.toThrow(/cannot be forked/)
  })

  it('passes persistence through, so an aside stays ephemeral', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    await SupervisedSession.fork(adapter, 'parent-1', OPTS)
    expect(adapter.forked[0]?.persist).toBe(false)
  })
})
