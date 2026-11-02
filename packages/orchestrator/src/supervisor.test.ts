import type { AgentEvent, AgentSession } from '@chorus/agent-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('rejects a resumed stream that ends before the startup window expires', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    const resuming = SupervisedSession.resume(adapter, 'thread-1', OPTS, POLICY)
    await tick()
    adapter.sessions[0]?.end()
    await expect(resuming).rejects.toThrow(/closed while resuming/)
    expect(adapter.sessions[0]?.closed).toBe(true)
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

  it('delivers the first event after the probe expires once and in order', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    const resuming = SupervisedSession.resume(adapter, 'thread-1', OPTS, POLICY)
    await tick()
    adapter.sessions[0]?.emit({ type: 'message.delta', itemRef: 'm1', text: 'before' })
    const sup = await resuming

    adapter.sessions[0]?.emit({ type: 'message.delta', itemRef: 'm2', text: 'after' })
    adapter.sessions[0]?.emit({ type: 'message.delta', itemRef: 'm3', text: 'later' })
    await sup.close()

    const events: AgentEvent[] = []
    for await (const event of sup.events) events.push(event)
    expect(events).toMatchObject([
      { type: 'message.delta', itemRef: 'm1', text: 'before' },
      { type: 'message.delta', itemRef: 'm2', text: 'after' },
      { type: 'message.delta', itemRef: 'm3', text: 'later' },
    ])
  })
})

describe('missing native session recovery', () => {
  const opened: SupervisedSession[] = []

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((session) => session.close()))
  })

  it.each(['claude', 'deepseek', 'codex'] as const)(
    'recovers a late missing %s session with context and pending input once',
    async (agentId) => {
      const adapter = new FakeAdapter({ id: agentId })
      const onRecovery = vi.fn()
      const sup = await SupervisedSession.resume(adapter, 'old-thread', OPTS, POLICY, {
        recover: () => ({ opts: { ...OPTS, model: 'preferred-model' }, context: 'Full history' }),
        onRecovery,
      })
      opened.push(sup)
      await sup.setEffort('high')
      await sup.setPermissionMode('plan')
      await sup.send({ text: 'Continue the agreed task.' })
      const old = adapter.sessions[0]
      old?.emit({ type: 'turn.started', turnRef: 'old-turn' })
      old?.emit({
        type: 'error',
        message: 'No conversation found with session ID: old-thread',
        recoverable: false,
      })
      await vi.waitFor(() => {
        expect(adapter.sessions[1]?.sent).toHaveLength(1)
      })
      const fresh = adapter.sessions[1]
      expect(old?.closed).toBe(true)
      expect(fresh?.sessionRef).not.toBe('old-thread')
      expect(fresh?.sent[0]?.text).toBe('Full history\n\nContinue the agreed task.')
      expect(fresh?.startedWith?.model).toBe('preferred-model')
      expect(fresh?.efforts).toEqual(['high'])
      expect(fresh?.permissionModes).toEqual(['plan'])
      expect(onRecovery.mock.calls).toEqual([['starting'], ['ready']])
      fresh?.emit({ type: 'turn.started', turnRef: 'fresh-turn' })
      fresh?.emit({ type: 'turn.completed', turnRef: 'fresh-turn', status: 'completed' })
      await tick()
      await sup.send({ text: 'The next message.' })
      expect(fresh?.sent[1]?.text).toBe('The next message.')
      await sup.close()
      const events: AgentEvent[] = []
      for await (const event of sup.events) events.push(event)
      expect(events.filter((event) => event.type === 'turn.completed')).toMatchObject([
        { turnRef: 'old-turn', status: 'failed' },
        { turnRef: 'fresh-turn', status: 'completed' },
      ])
      expect(events.filter((event) => event.type === 'error')).toEqual([])
    }
  )

  it('keeps recovered context for the next message when no task was pending', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      recover: () => ({ opts: OPTS, context: 'Earlier decisions' }),
    })
    opened.push(sup)
    adapter.sessions[0]?.emit({
      type: 'error',
      message: 'No conversation found with session ID: deleted-thread',
      recoverable: false,
    })
    await vi.waitFor(() => {
      expect(adapter.sessions).toHaveLength(2)
    })
    await sup.send({ text: 'Continue now.' })
    expect(adapter.sessions[1]?.sent).toEqual([{ text: 'Earlier decisions\n\nContinue now.' }])
  })

  it('retains fresh recovery history when preparing the next input throws', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      recover: () => ({ opts: OPTS, context: 'Recorded task decisions.' }),
    })
    opened.push(sup)
    adapter.sessions[0]?.emit({
      type: 'error',
      message: 'no rollout found for thread id gone',
      recoverable: false,
    })
    await vi.waitFor(() => {
      expect(adapter.sessions).toHaveLength(2)
    })
    await expect(
      sup.send({
        text: 'First attempt.',
        prepare: () => {
          throw new Error('Preparation failed')
        },
      })
    ).rejects.toThrow('Preparation failed')
    expect(adapter.sessions[1]?.sent).toEqual([])
    await sup.send({ text: 'Continue the pending task.' })
    expect(adapter.sessions[1]?.sent).toEqual([
      { text: 'Recorded task decisions.\n\nContinue the pending task.' },
    ])
  })

  it('recomposes recovery context against the fresh tool state without replaying the old preamble', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    const compose = vi.fn((input: string) => `Fresh bounded context for ${input}`)
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      recover: () => ({ opts: OPTS, context: compose }),
    })
    opened.push(sup)
    const old = adapter.sessions[0]
    Object.defineProperty(old, 'transcriptTool', { value: 'unavailable' })
    expect(sup.transcriptTool).toBe('unavailable')
    await sup.send({
      text: 'OLD_CONTEXT_PREAMBLE\nContinue API retries.',
      recoveryText: 'Continue API retries.',
    })
    old?.emit({
      type: 'error',
      message: 'no rollout found for thread id missing',
      recoverable: false,
    })
    await vi.waitFor(() => {
      expect(adapter.sessions[1]?.sent).toHaveLength(1)
    })
    const fresh = adapter.sessions[1]
    expect(compose).toHaveBeenCalledWith('Continue API retries.', fresh)
    expect(fresh?.sent[0]?.text).toBe(
      'Fresh bounded context for Continue API retries.\n\nContinue API retries.'
    )
    expect(fresh?.sent[0]?.text).not.toContain('OLD_CONTEXT_PREAMBLE')
    Object.defineProperty(fresh, 'transcriptTool', { value: 'registered' })
    expect(sup.transcriptTool).toBe('registered')
  })

  it('recovers a missing-thread rejection from send without logging another user message', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      recover: () => ({ opts: OPTS, context: 'Recorded decisions' }),
    })
    opened.push(sup)
    const old = adapter.sessions[0]
    if (old === undefined) throw new Error('Missing original session')
    old.send = () => Promise.reject(new Error('thread not found: deleted'))
    await sup.send({ text: 'Continue the pending task.' })
    expect(old.closed).toBe(true)
    expect(adapter.sessions[1]?.sent).toEqual([
      { text: 'Recorded decisions\n\nContinue the pending task.' },
    ])
  })

  it('rebuilds a queued input after recovery and keeps delivery metadata out of the provider input', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    const compose = vi.fn(
      (input: string, _session: AgentSession, beforeSeq?: number) =>
        `Recovered before #${String(beforeSeq)}: ${input}`
    )
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      recover: () => ({ opts: OPTS, context: compose }),
    })
    opened.push(sup)
    await sup.send({
      text: 'OLD_PREAMBLE\nFirst request.',
      recoveryText: 'First request.',
      recoveryBeforeSeq: 12,
    })
    const originalStart = adapter.start.bind(adapter)
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let recovering = false
    vi.spyOn(adapter, 'start').mockImplementation(async (opts) => {
      recovering = true
      await gate
      return originalStart(opts)
    })
    adapter.sessions[0]?.emit({
      type: 'error',
      message: 'no rollout found for thread id gone',
      recoverable: false,
    })
    const prepare = vi.fn(
      (session: AgentSession) => `Prepared for ${session.sessionRef}: Second request.`
    )
    try {
      await vi.waitFor(() => {
        expect(recovering).toBe(true)
      })
      const queued = sup.send({
        text: 'STALE_QUEUE_PREAMBLE',
        recoveryText: 'Second request.',
        recoveryBeforeSeq: 15,
        prepare,
      })
      expect(prepare).not.toHaveBeenCalled()
      release()
      await queued
      const fresh = adapter.sessions[1]
      expect(compose).toHaveBeenCalledWith('First request.', fresh, 12)
      expect(prepare).toHaveBeenCalledWith(fresh)
      expect(fresh?.sent).toEqual([
        { text: 'Recovered before #12: First request.\n\nFirst request.' },
        { text: `Prepared for ${String(fresh?.sessionRef)}: Second request.` },
      ])
    } finally {
      release()
    }
  })

  it('uses the earliest pending message boundary when recovery merges queued requests', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    const compose = vi.fn(() => 'History before both requests.')
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      recover: () => ({ opts: OPTS, context: compose }),
    })
    opened.push(sup)
    await sup.send({ text: 'OLD_A', recoveryText: 'Request A', recoveryBeforeSeq: 7 })
    await sup.send({ text: 'OLD_B', recoveryText: 'Request B', recoveryBeforeSeq: 9 })
    adapter.sessions[0]?.emit({
      type: 'error',
      message: 'no rollout found for thread id gone',
      recoverable: false,
    })
    await vi.waitFor(() => {
      expect(adapter.sessions[1]?.sent).toHaveLength(1)
    })
    expect(compose).toHaveBeenCalledWith('Request A\n\nRequest B', adapter.sessions[1], 7)
    expect(adapter.sessions[1]?.sent).toEqual([
      { text: 'History before both requests.\n\nRequest A\n\nRequest B' },
    ])
  })

  it('recovers when a crash restart cannot find the original thread', async () => {
    const adapter = new FakeAdapter({ id: 'codex' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      scheduler: immediateScheduler(),
      recover: () => ({ opts: OPTS, context: 'Earlier task context' }),
    })
    opened.push(sup)
    await sup.send({ text: 'Finish the task.' })
    adapter.resume = () => Promise.reject(new Error('thread not found: deleted'))
    adapter.sessions[0]?.end()
    await vi.waitFor(() => {
      expect(adapter.sessions[1]?.sent).toHaveLength(1)
    })
    expect(adapter.sessions[1]?.sent[0]?.text).toBe('Earlier task context\n\nFinish the task.')
    expect(sup.stats().givenUp).toBe(false)
  })

  it('shows a fresh-start failure and rejects subsequent sends', async () => {
    const adapter = new FakeAdapter({ id: 'deepseek' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      recover: () => ({ opts: OPTS, context: 'Recorded history' }),
    })
    opened.push(sup)
    await sup.send({ text: 'Continue.' })
    adapter.start = () => Promise.reject(new Error('Provider unavailable'))
    adapter.sessions[0]?.emit({
      type: 'error',
      message: 'No conversation found with session ID: lost-thread',
      recoverable: false,
    })
    await vi.waitFor(() => {
      expect(sup.stats().givenUp).toBe(true)
    })
    const events: AgentEvent[] = []
    for await (const event of sup.events) events.push(event)
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: 'Provider unavailable',
      recoverable: false,
    })
    await expect(sup.send({ text: 'Do not silently accept this.' })).rejects.toThrow(
      'Provider unavailable'
    )
    expect(adapter.sessions).toHaveLength(1)
  })

  it('does not repeatedly recreate a missing session before a successful turn', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
      recover: () => ({ opts: OPTS, context: 'History' }),
    })
    opened.push(sup)
    await sup.send({ text: 'Continue.' })
    const failure = {
      type: 'error' as const,
      message: 'No conversation found with session ID: missing',
      recoverable: false,
    }
    adapter.sessions[0]?.emit(failure)
    await vi.waitFor(() => {
      expect(adapter.sessions[1]?.sent).toHaveLength(1)
    })
    adapter.sessions[1]?.emit(failure)
    adapter.sessions[1]?.end()
    await vi.waitFor(() => {
      expect(sup.stats().givenUp).toBe(true)
    })
    expect(adapter.sessions).toHaveLength(2)
    await expect(sup.send({ text: 'Another message.' })).rejects.toThrow(/No conversation found/)
  })

  it.each(['stop', 'close'] as const)(
    'cancels pending replay on %s during recovery',
    async (action) => {
      const adapter = new FakeAdapter({ id: 'claude' })
      const sup = await SupervisedSession.start(adapter, OPTS, POLICY, {
        recover: () => ({ opts: OPTS, context: 'History' }),
      })
      opened.push(sup)
      await sup.send({ text: 'The cancelled task.' })
      let release = (): void => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const start = adapter.start.bind(adapter)
      adapter.start = async (opts) => {
        await gate
        return start(opts)
      }
      adapter.sessions[0]?.emit({
        type: 'error',
        message: 'No conversation found with session ID: missing',
        recoverable: false,
      })
      try {
        await vi.waitFor(() => {
          expect(adapter.sessions[0]?.closed).toBe(true)
        })
        const stopping = action === 'stop' ? sup.interrupt() : sup.close()
        release()
        await stopping
        expect(adapter.sessions[1]?.sent ?? []).toEqual([])
        if (action === 'close') expect(adapter.sessions[1]?.closed).toBe(true)
        else {
          await sup.send({ text: 'A new task.' })
          expect(adapter.sessions[1]?.sent[0]?.text).toBe('History\n\nA new task.')
        }
      } finally {
        release()
      }
    }
  )

  it('does not recover authentication or configuration failures', async () => {
    const adapter = new FakeAdapter({ id: 'claude' })
    const recover = vi.fn(() => ({ opts: OPTS, context: '' }))
    const sup = await SupervisedSession.start(adapter, OPTS, POLICY, { recover })
    opened.push(sup)
    adapter.sessions[0]?.emit({
      type: 'error',
      message: 'Authentication failed',
      recoverable: false,
    })
    adapter.sessions[0]?.end()
    await vi.waitFor(() => {
      expect(sup.stats().givenUp).toBe(true)
    })
    expect(recover).not.toHaveBeenCalled()
    expect(adapter.sessions).toHaveLength(1)
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

it('closes a provider whose resume event stream fails before attachment', async () => {
  const adapter = new FakeAdapter({ id: 'claude' })
  const first = await adapter.start(OPTS)
  const close = vi.fn(() => first.close())
  vi.spyOn(adapter, 'resume').mockResolvedValue(
    new Proxy(first, {
      get(target, key) {
        if (key === 'close') return close
        if (key === 'events')
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.reject(new Error('resume stream failed')),
            }),
          }
        const value = Reflect.get(target, key) as unknown
        return typeof value === 'function' ? (value.bind(target) as unknown) : value
      },
    })
  )
  await expect(SupervisedSession.resume(adapter, 'previous', OPTS, POLICY)).rejects.toThrow(
    'resume stream failed'
  )
  expect(close).toHaveBeenCalledTimes(1)
})

it('closes a rejected persistent fork before reporting the invalid session id', async () => {
  const adapter = new FakeAdapter({ id: 'claude' })
  const first = await adapter.start(OPTS)
  vi.spyOn(adapter, 'fork').mockResolvedValue(first)
  await expect(
    SupervisedSession.fork(
      adapter,
      first.sessionRef,
      { ...OPTS, inherits: 'config', persist: true },
      POLICY
    )
  ).rejects.toThrow(/own id/)
  expect(adapter.sessions[0]?.closed).toBe(true)
})
