import type { AgentEvent } from '@chorus/agent-protocol'
import { describe, expect, it } from 'vitest'
import type { Scheduler } from './delta-buffer.js'
import { SupervisedSession, type SupervisorPolicy } from './supervisor.js'
import { FakeAdapter } from './testing/fake-adapter.js'

const OPTS = {
  cwd: '/tmp/project',
  sandbox: { mode: 'readOnly' as const, writableRoots: [], networkAccess: false },
}

const POLICY: SupervisorPolicy = {
  maxRestarts: 2,
  windowMs: 60_000,
  baseBackoffMs: 10,
  maxBackoffMs: 100,
  /* Short, because these tests drive fakes that answer instantly — a real
     window would spend two seconds per resume waiting for silence. */
  resumeVerdictMs: 20,
}

/** Runs timers immediately so backoff does not make the suite slow. */
function immediateScheduler(): Scheduler {
  return {
    setTimeout: (fn) => {
      queueMicrotask(fn)
      return 1
    },
    clearTimeout: () => undefined,
    now: () => 0,
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function collect(session: SupervisedSession, until: number): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  for await (const event of session.events) {
    seen.push(event)
    if (seen.length >= until) break
  }
  return seen
}

describe('SupervisedSession.resume, when the thread is gone', () => {
  /*
   * The failure that used to arrive too late to act on.
   *
   * `adapter.resume` returns as soon as a process exists; whether the provider
   * found the thread comes back on the event stream afterwards. So a resume of a
   * deleted session resolved happily, the caller recorded success, and the
   * refusal turned up later as an error in the transcript — past the `catch` in
   * `runtime.ts` that exists to fall back to a fresh session.
   */
  it('rejects when the provider says the thread is gone', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    /* Real timers here, unlike the restart tests: these are *about* the verdict
       window, and a scheduler that fires it immediately closes it before the
       fake can answer. `POLICY.resumeVerdictMs` is 20ms so this stays quick. */
    const resuming = SupervisedSession.resume(adapter, 'thread-1', OPTS, POLICY)
    await tick()
    adapter.sessions[0]?.emit({
      type: 'error',
      message: 'No conversation found with session ID: c39bee04',
      recoverable: false,
    })
    await expect(resuming).rejects.toThrow(/No conversation found/)
  })

  /* A turn that ran out of turns is recoverable and says nothing about whether
     the thread exists — resuming must not treat it as a dead session. */
  it('does not reject on a recoverable error', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    /* Real timers here, unlike the restart tests: these are *about* the verdict
       window, and a scheduler that fires it immediately closes it before the
       fake can answer. `POLICY.resumeVerdictMs` is 20ms so this stays quick. */
    const resuming = SupervisedSession.resume(adapter, 'thread-1', OPTS, POLICY)
    await tick()
    adapter.sessions[0]?.emit({ type: 'error', message: 'max turns', recoverable: true })
    await expect(resuming).resolves.toBeDefined()
  })

  /*
   * Silence is success, and it has to be: a thread that is fine emits nothing
   * until someone prompts it, so there is no positive signal to wait for.
   */
  it('resolves when the provider says nothing at all', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    const sup = await SupervisedSession.resume(adapter, 'thread-1', OPTS, POLICY)
    expect(sup.sessionRef).toBe('thread-1')
  })

  /*
   * Peeking consumes, so the peeked events have to be put back.
   *
   * Without the replay the events a provider sent while the verdict was being
   * decided would be read by the check and never reach the transcript — silent
   * loss, and worst exactly when a provider is chatty on reconnect.
   */
  it('loses nothing it read while deciding', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    /* Real timers here, unlike the restart tests: these are *about* the verdict
       window, and a scheduler that fires it immediately closes it before the
       fake can answer. `POLICY.resumeVerdictMs` is 20ms so this stays quick. */
    const resuming = SupervisedSession.resume(adapter, 'thread-1', OPTS, POLICY)
    await tick()
    adapter.sessions[0]?.emit({ type: 'message.delta', itemRef: 'm1', text: 'still here' })
    const sup = await resuming

    const events = await collect(sup, 1)
    expect(events[0]).toMatchObject({ type: 'message.delta', text: 'still here' })
  })
})

describe('SupervisedSession', () => {
  it('passes events through when nothing goes wrong', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      scheduler: immediateScheduler(),
    })

    const first = adapter.sessions[0]
    first?.emit({ type: 'message.delta', itemRef: 'm1', text: 'hello' })
    first?.end()

    const events = await collect(sup, 1)
    expect(events[0]).toMatchObject({ type: 'message.delta', text: 'hello' })
  })

  it('restarts and resumes the same thread after an unexpected exit', async () => {
    // S3a: the provider does not announce its own death. A stream that ends
    // when we did not ask it to is the only signal there is.
    const adapter = new FakeAdapter({ id: 'codex' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      scheduler: immediateScheduler(),
      random: () => 0,
    })
    const ref = sup.sessionRef

    adapter.sessions[0]?.emit({ type: 'message.delta', itemRef: 'm1', text: 'before' })
    adapter.sessions[0]?.end() // crash
    await tick()

    expect(adapter.sessions).toHaveLength(2)
    // resume() is given the original ref, so the provider thread is reattached
    // rather than a fresh conversation being started.
    expect(adapter.sessions[1]?.sessionRef).toBe(ref)

    adapter.sessions[1]?.emit({ type: 'message.delta', itemRef: 'm2', text: 'after' })
    adapter.sessions[1]?.end()
    await tick()

    const events = await collect(sup, 3)
    expect(events.map((e) => e.type)).toEqual(['message.delta', 'error', 'message.delta'])
    expect(events[1]).toMatchObject({ recoverable: true })
    expect(sup.stats().restarts).toBeGreaterThanOrEqual(1)
  })

  it('keeps sequence numbers monotonic across a restart', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      scheduler: immediateScheduler(),
      random: () => 0,
    })

    adapter.sessions[0]?.emit({ type: 'message.delta', itemRef: 'm1', text: 'a' })
    adapter.sessions[0]?.end()
    await tick()
    adapter.sessions[1]?.emit({ type: 'message.delta', itemRef: 'm2', text: 'b' })
    adapter.sessions[1]?.end()
    await tick()

    const events = await collect(sup, 3)
    const seqs = events.map((e) => e.seq)
    // A restarted provider resets its own counter; ours must not, or the
    // orchestrator would see events go backwards.
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('gives up after too many crashes in the window', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      scheduler: immediateScheduler(),
      random: () => 0,
    })

    // Crash more times than the policy allows.
    for (let i = 0; i < 4; i++) {
      adapter.sessions.at(-1)?.end()
      await tick()
      await tick()
    }

    const seen: AgentEvent[] = []
    for await (const event of sup.events) seen.push(event)

    const last = seen.at(-1)
    expect(last).toMatchObject({ type: 'error', recoverable: false })
    expect((last as { message: string }).message).toMatch(/giving up/)
    expect(sup.stats().givenUp).toBe(true)
  })

  it('does not treat an intentional close as a crash', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      scheduler: immediateScheduler(),
    })

    await sup.close()
    await tick()

    expect(adapter.sessions).toHaveLength(1)
    expect(sup.stats().restarts).toBe(0)

    const seen: AgentEvent[] = []
    for await (const event of sup.events) seen.push(event)
    expect(seen.filter((e) => e.type === 'error')).toHaveLength(0)
  })

  it('does not restart when the adapter says the failure is unrecoverable', async () => {
    // A missing working directory fails identically every time. Retrying it
    // produced six identical errors in a row and buried the real message.
    const adapter = new FakeAdapter({ id: 'claude' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      scheduler: immediateScheduler(),
      random: () => 0,
    })

    adapter.sessions[0]?.emit({
      type: 'error',
      message: 'Working directory does not exist: /nope',
      recoverable: false,
    })
    adapter.sessions[0]?.end()
    await tick()
    await tick()

    expect(adapter.sessions).toHaveLength(1)
    expect(sup.stats()).toMatchObject({ restarts: 0, givenUp: true })
  })

  it('still restarts after a recoverable error', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      scheduler: immediateScheduler(),
      random: () => 0,
    })

    adapter.sessions[0]?.emit({ type: 'error', message: 'transient', recoverable: true })
    adapter.sessions[0]?.end()
    await tick()

    expect(adapter.sessions).toHaveLength(2)
    expect(sup.stats().givenUp).toBe(false)
  })

  it('surfaces a failed resume instead of looping on it', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    adapter.resume = () => Promise.reject(new Error('thread not found'))

    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      scheduler: immediateScheduler(),
      random: () => 0,
    })
    adapter.sessions[0]?.end()
    await tick()

    const seen: AgentEvent[] = []
    for await (const event of sup.events) seen.push(event)

    expect(seen.at(-1)).toMatchObject({ type: 'error', recoverable: false })
    expect((seen.at(-1) as { message: string }).message).toMatch(/thread not found/)
  })

  it('delegates send and interrupt to the live session after a restart', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      scheduler: immediateScheduler(),
      random: () => 0,
    })

    adapter.sessions[0]?.end()
    await tick()

    await sup.send({ text: 'after restart' })
    await sup.interrupt()

    const live = adapter.sessions[1]!
    expect(live.sent).toEqual([{ text: 'after restart' }])
    expect(live.interruptRequested).toBe(true)
  })
})
