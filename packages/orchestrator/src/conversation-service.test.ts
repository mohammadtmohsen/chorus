import { EventStore, openSqlite, type SqliteHandle } from '@chorus/event-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationService } from './conversation-service.js'
import type { Scheduler } from './delta-buffer.js'
import { FakeAdapter, type FakeAgentSession } from './testing/fake-adapter.js'

const CONV = 'conv-1'
const OPTS = {
  cwd: '/tmp/project',
  sandbox: { mode: 'readOnly' as const, writableRoots: [], networkAccess: false },
}

/** Never fires on its own; tests decide when the time bound trips. */
function manualScheduler(): Scheduler & { fire: () => void } {
  let pending: (() => void) | null = null
  return {
    setTimeout(fn) {
      pending = fn
      return 1
    },
    clearTimeout() {
      pending = null
    },
    now: () => 0,
    fire() {
      const p = pending
      pending = null
      p?.()
    },
  }
}

let db: SqliteHandle
let store: EventStore
let adapter: FakeAdapter
let service: ConversationService
let scheduler: ReturnType<typeof manualScheduler>

/** Yields to the event pump — `emit` queues, the service consumes asynchronously. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const types = (): string[] => store.read(CONV).map((e) => e.payload.type)
const messages = (): { content: string; status: string }[] =>
  db.prepare('SELECT content, status FROM messages ORDER BY seq').all() as never

beforeEach(async () => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  store.append({
    conversationId: CONV,
    actor: 'user',
    payload: { type: 'conversation.created', projectId: 'p1', title: 'Test' },
  })
  adapter = new FakeAdapter({ id: 'claude', version: '2.1.220' })
  scheduler = manualScheduler()
  service = new ConversationService({
    store,
    conversationId: CONV,
    adapter,
    scheduler,
    maxChars: 10_000,
  })
  await service.start(OPTS)
})

afterEach(() => {
  db.close()
})

function session(): FakeAgentSession {
  const s = adapter.sessions[0]
  if (s === undefined) throw new Error('no session')
  return s
}

describe('session start', () => {
  it('records the agent CLI version so a breaking upgrade is visible in the log', () => {
    const started = store.read(CONV, { types: ['session.started'] })[0]
    expect(started?.payload).toMatchObject({
      type: 'session.started',
      agentId: 'claude',
      cliVersion: '2.1.220',
      cwd: '/tmp/project',
    })
  })
})

describe('streaming', () => {
  it('persists partial output rather than waiting for the message to complete', async () => {
    // The whole point of the buffer: Codex will not return partial output after
    // a crash (S3), so it has to be durable here first.
    const s = session()
    s.emit({ type: 'message.delta', itemRef: 'm1', text: 'Hello ' })
    s.emit({ type: 'message.delta', itemRef: 'm1', text: 'world' })
    s.end()
    await service.drain()

    expect(store.read(CONV, { types: ['agent.message.delta'] })).toHaveLength(1)
    expect(messages().at(-1)).toMatchObject({ content: 'Hello world', status: 'streaming' })
  })

  it('coalesces many deltas into far fewer log rows', async () => {
    const s = session()
    for (let i = 0; i < 500; i++) s.emit({ type: 'message.delta', itemRef: 'm1', text: 'tok ' })
    s.end()
    await service.drain()

    const rows = store.read(CONV, { types: ['agent.message.delta'] })
    expect(rows.length).toBeLessThan(10)
    expect(messages().at(-1)?.content).toHaveLength(2_000)
  })

  it('flushes on the time bound when the stream is slow', async () => {
    const s = session()
    s.emit({ type: 'message.delta', itemRef: 'm1', text: 'trickle' })
    await tick() // let the service's event pump consume the emitted event
    expect(store.read(CONV, { types: ['agent.message.delta'] })).toHaveLength(0)

    scheduler.fire()
    expect(store.read(CONV, { types: ['agent.message.delta'] })).toHaveLength(1)

    s.end()
    await service.drain()
  })

  it('lets the completed text supersede the buffered fragments', async () => {
    const s = session()
    s.emit({ type: 'message.delta', itemRef: 'm1', text: 'Hel' })
    s.emit({ type: 'message.completed', itemRef: 'm1', text: 'Hello world' })
    s.end()
    await service.drain()

    // One message row, final text, no duplication of the fragment.
    expect(messages().at(-1)).toMatchObject({ content: 'Hello world', status: 'complete' })
  })
})

describe('ordering', () => {
  it('flushes pending deltas before a lifecycle event is logged', async () => {
    const s = session()
    s.emit({ type: 'message.delta', itemRef: 'm1', text: 'Let me check the repo.' })
    s.emit({
      type: 'command.started',
      itemRef: 'c1',
      command: ['git', 'status'],
      cwd: '/tmp/project',
    })
    s.end()
    await service.drain()

    const order = types()
    const delta = order.indexOf('agent.message.delta')
    const command = order.indexOf('command.started')
    // Otherwise the transcript shows the command before the sentence that
    // introduced it.
    expect(delta).toBeGreaterThan(-1)
    expect(delta).toBeLessThan(command)
  })
})

describe('interrupt', () => {
  it('reports a user-initiated stop as interrupted, not as an error', async () => {
    // Claude signals a user stop as error_during_execution with no distinct
    // status (S3b). Only Chorus knows the user pressed the button.
    const s = session()
    s.emit({ type: 'turn.started', turnRef: 't1' })
    await service.interrupt()
    s.emit({ type: 'turn.completed', turnRef: 't1', status: 'failed' })
    s.end()
    await service.drain()

    const completed = store.read(CONV, { types: ['turn.completed'] })[0]
    expect(completed?.payload).toMatchObject({ status: 'interrupted', userInitiated: true })
    expect(s.interruptRequested).toBe(true)
  })

  it('leaves a genuine failure reported as failed', async () => {
    const s = session()
    s.emit({ type: 'turn.started', turnRef: 't1' })
    s.emit({ type: 'turn.completed', turnRef: 't1', status: 'failed' })
    s.end()
    await service.drain()

    expect(store.read(CONV, { types: ['turn.completed'] })[0]?.payload).toMatchObject({
      status: 'failed',
      userInitiated: false,
    })
  })
})

describe('crash recovery', () => {
  it('keeps everything streamed before the process died', async () => {
    // Mirrors the S3a scenario: a SIGKILL mid-turn. Codex would return only the
    // userMessage from thread/read; our log must still hold the agent's text.
    await service.sendUserMessage('list the files')
    const s = session()
    s.emit({ type: 'turn.started', turnRef: 't1' })
    s.emit({ type: 'message.delta', itemRef: 'm1', text: 'Sure — checking' })
    await tick()
    scheduler.fire() // the flush that happened before the crash

    s.end() // process dies; no turn.completed ever arrives
    await service.drain()

    const rebuilt = store.rebuildProjections()
    expect(rebuilt.events).toBeGreaterThan(0)

    const contents = messages().map((m) => m.content)
    expect(contents).toContain('list the files')
    expect(contents).toContain('Sure — checking')
  })

  it('survives a projection wipe because the log is the source of truth', async () => {
    await service.sendUserMessage('hello')
    const s = session()
    s.emit({ type: 'message.delta', itemRef: 'm1', text: 'hi there' })
    s.end()
    await service.drain()

    const before = messages()
    db.exec('DELETE FROM messages')
    store.rebuildProjections()
    expect(messages()).toEqual(before)
  })
})

describe('approval decisions', () => {
  it('records the decision in the log, not just on the wire', async () => {
    // Answering the session directly would satisfy the agent while leaving no
    // trace -- and the UI clears its card on approval.decided, so the card would
    // also hang around forever. Both were real, found by driving the live app.
    const s = session()
    await service.decideApproval('ap1', { outcome: 'allow', scope: 'once' })

    const decided = store.read(CONV, { types: ['approval.decided'] })[0]
    expect(decided?.payload).toMatchObject({
      approvalId: 'ap1',
      outcome: 'allow',
      scope: 'once',
      decidedBy: 'user',
      policyRuleId: null,
    })
    expect(s.decisions).toEqual([{ id: 'ap1', decision: { outcome: 'allow', scope: 'once' } }])
  })

  it('attributes an auto-decision to the rule that made it', async () => {
    await service.decideApproval(
      'ap2',
      { outcome: 'deny', message: 'outside project root' },
      'policy',
      'deny-outside-root'
    )
    expect(store.read(CONV, { types: ['approval.decided'] })[0]?.payload).toMatchObject({
      decidedBy: 'policy',
      policyRuleId: 'deny-outside-root',
      scope: null,
    })
  })

  it('flushes pending deltas before recording the decision', async () => {
    const s = session()
    s.emit({ type: 'message.delta', itemRef: 'm1', text: 'I need to write a file.' })
    await tick()
    await service.decideApproval('ap3', { outcome: 'allow', scope: 'session' })

    const order = types()
    expect(order.indexOf('agent.message.delta')).toBeLessThan(order.indexOf('approval.decided'))
  })
})

describe('close', () => {
  it('flushes pending text and records why the session ended', async () => {
    const s = session()
    s.emit({ type: 'message.delta', itemRef: 'm1', text: 'unflushed tail' })
    await tick()
    await service.close('crashed')

    expect(messages().at(-1)?.content).toBe('unflushed tail')
    const ended = store.read(CONV, { types: ['session.ended'] })[0]
    expect(ended?.payload).toMatchObject({ reason: 'crashed' })
    expect(db.prepare('SELECT status FROM agent_sessions').get()).toMatchObject({
      status: 'crashed',
    })
  })
})
