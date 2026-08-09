import {
  CONFORMANCE_CHECKS,
  CONFORMANCE_OPTS,
  collectEvents,
  type ConformanceTarget,
} from '@chorus/agent-protocol'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './codex-adapter.js'
import type { Transport } from './transport.js'

/**
 * The shared conformance suite, run against the real `CodexAdapter` over a fake
 * transport.
 *
 * With this, all three implementations — `FakeAdapter`, `ClaudeAdapter` and
 * `CodexAdapter` — run the same assertions. That is what makes the
 * `AgentAdapter` port a contract rather than a shape (plan §8), and it is the
 * half that was missing when M3 first landed.
 */

interface Wire {
  /** Push a server notification, as the app-server would. */
  notify: (method: string, params: unknown) => void
  /** Push a server-initiated request (an approval). */
  request: (id: number, method: string, params: unknown) => void
  /** Ends the connection without a clean close — a dead app-server. */
  kill: () => void
  sent: Record<string, unknown>[]
}

/**
 * Answers the handshake and `thread/start` the way the real server does, so the
 * adapter under test is exercised rather than stubbed out.
 */
function fakeTransport(): { transport: Transport; wire: Wire } {
  let onLine: ((line: string) => void) | null = null
  let onClose: ((i: { code: number | null; signal: string | null }) => void) | null = null
  const sent: Record<string, unknown>[] = []

  const deliver = (message: unknown): void => {
    onLine?.(JSON.stringify(message))
  }

  const transport: Transport = {
    send: (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>
      sent.push(msg)
      const id = msg['id']
      if (typeof id !== 'number') return

      const reply = (result: unknown): void => {
        queueMicrotask(() => {
          deliver({ id, result })
        })
      }

      switch (msg['method']) {
        case 'initialize':
          reply({ userAgent: 'fake' })
          break
        case 'thread/start':
          reply({ thread: { id: 'thr_conformance' }, model: 'fake-model' })
          break
        case 'thread/resume':
          reply({ thread: { id: 'thr_conformance' } })
          break
        default:
          reply({})
      }
    },
    onLine: (h) => {
      onLine = h
    },
    onClose: (h) => {
      onClose = h
    },
    onStderr: () => undefined,
    close: () => {
      onClose?.({ code: 0, signal: null })
    },
  }

  return {
    transport,
    wire: {
      notify: (method, params) => {
        deliver({ method, params })
      },
      request: (id, method, params) => {
        deliver({ id, method, params })
      },
      kill: () => {
        onClose?.({ code: 137, signal: 'SIGKILL' })
      },
      sent,
    },
  }
}

function codexTarget(): ConformanceTarget & { wire: () => Wire } {
  const wires: Wire[] = []
  const adapter = new CodexAdapter({
    now: () => 1_000,
    createTransport: () => {
      const { transport, wire } = fakeTransport()
      wires.push(wire)
      return transport
    },
  })

  const latest = (): Wire => {
    const w = wires.at(-1)
    if (w === undefined) throw new Error('no transport created')
    return w
  }

  return {
    adapter,
    wire: latest,
    emitMessage: (_session, text) => {
      latest().notify('item/agentMessage/delta', { itemId: 'm1', delta: text })
    },
    killProvider: () => {
      latest().kill()
    },
  }
}

// A real adapter needs a directory that exists; several validate it.
const OPTS = { ...CONFORMANCE_OPTS, cwd: mkdtempSync(join(tmpdir(), 'chorus-conformance-')) }
describe('conformance: CodexAdapter', () => {
  it('declares its capabilities', () => {
    expect(CONFORMANCE_CHECKS.declaresCapabilities(codexTarget().adapter)).toBeNull()
  })

  it('backs every declared capability with a method', () => {
    expect(CONFORMANCE_CHECKS.backsCapabilitiesWithMethods(codexTarget().adapter)).toBeNull()
  })

  it('exposes a resumable session reference', async () => {
    const session = await codexTarget().adapter.start(OPTS)
    expect(CONFORMANCE_CHECKS.exposesSessionRef(session)).toBeNull()
    expect(session.sessionRef).toBe('thr_conformance')
  })

  it('emits events with monotonic seq and its own agent id', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)

    for (const text of ['a', 'b', 'c']) await target.emitMessage(session, text)
    await target.killProvider(session)

    const events = await collectEvents(session, 10)
    expect(events.length).toBeGreaterThan(0)
    expect(CONFORMANCE_CHECKS.monotonicSeq(events)).toBeNull()
    expect(CONFORMANCE_CHECKS.stampsAgentId(target.adapter, events)).toBeNull()
  })

  it('ends its event stream when the provider dies', async () => {
    // The M2 bug in its original form: JsonRpcClient failed its promises but
    // nothing closed the session stream, so the supervisor never restarted it.
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)
    await target.emitMessage(session, 'before the crash')
    await target.killProvider(session)

    for await (const _event of session.events) {
      // Drains to completion; a stream that never ends hangs, which vitest
      // reports as a timeout.
    }
    expect(CONFORMANCE_CHECKS.endsStreamWhenProviderDies(true)).toBeNull()
  })

  it('resumes onto the same provider reference', async () => {
    const target = codexTarget()
    const first = await target.adapter.start(OPTS)
    const resumed = await target.adapter.resume(first.sessionRef, OPTS)
    expect(resumed.sessionRef).toBe(first.sessionRef)
  })

  it('completes the handshake before starting a thread', async () => {
    // The server rejects everything sent before `initialized` (plan §2.1).
    const target = codexTarget()
    await target.adapter.start(OPTS)
    const methods = target.wire().sent.map((m) => m['method'])
    expect(methods.slice(0, 3)).toEqual(['initialize', 'initialized', 'thread/start'])
  })

  it('sends the sandbox as the kebab-case string enum thread/start accepts', async () => {
    const target = codexTarget()
    await target.adapter.start(OPTS)
    const start = target.wire().sent.find((m) => m['method'] === 'thread/start')
    expect((start?.['params'] as { sandbox?: unknown }).sandbox).toBe('read-only')
  })

  it('surfaces an approval request as an event', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)

    target.wire().request(99, 'item/commandExecution/requestApproval', {
      itemId: 'i1',
      command: 'git status',
      cwd: '/repo',
    })

    const events = await collectEvents(session, 1)
    expect(events[0]).toMatchObject({
      type: 'approval.requested',
      request: { kind: 'command', command: ['git status'] },
    })
  })

  it('answers the pending approval request on the wire', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)
    target.wire().request(99, 'item/commandExecution/requestApproval', { itemId: 'i1' })

    const [event] = await collectEvents(session, 1)
    if (event?.type !== 'approval.requested') throw new Error('expected an approval')
    await session.respondToApproval(event.request.id, { outcome: 'allow', scope: 'session' })

    await new Promise((r) => setTimeout(r, 0))
    const reply = target.wire().sent.find((m) => m['id'] === 99 && m['result'] !== undefined)
    expect(reply?.['result']).toEqual({ decision: 'acceptForSession' })
  })
})
