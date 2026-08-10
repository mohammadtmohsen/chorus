import type { UserInputRequest } from '@chorus/agent-protocol'
import { EventStore, openSqlite, type SqliteHandle } from '@chorus/event-store'
import type { UserInputId } from '@chorus/shared'
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
function manualScheduler(): Scheduler & { fire: () => void; peek: () => (() => void) | null } {
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
    /**
     * The pending callback, without removing it.
     *
     * For the one case `clearTimeout` cannot model: a real `setTimeout` that has
     * already been dequeued for execution runs whatever `clearTimeout` does
     * afterwards. Holding the callback and invoking it after an extension is the
     * only way to reproduce that here.
     */
    peek: () => pending,
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
    // The rule id comes from the engine, never from the caller — an allow that
    // cannot be traced back to a rule is indistinguishable from no policy.
    const s = session()
    s.emit({
      type: 'approval.requested',
      request: {
        id: 'ap-auto' as never,
        agentId: 'claude',
        kind: 'command',
        command: ['rm', '-rf', '/tmp/x'],
        cwd: '/tmp',
        withNetwork: false,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    })
    await tick()

    const decided = store.read(CONV, { types: ['approval.decided'] })[0]
    expect(decided?.payload).toMatchObject({
      approvalId: 'ap-auto',
      outcome: 'deny',
      decidedBy: 'policy',
      policyRuleId: 'deny-recursive-delete',
    })
  })

  it('auto-allows an inspection command without asking', async () => {
    const s = session()
    s.emit({
      type: 'approval.requested',
      request: {
        id: 'ap-read' as never,
        agentId: 'claude',
        kind: 'command',
        command: ['git', 'status'],
        cwd: '/repo',
        withNetwork: false,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    })
    await tick()

    expect(store.read(CONV, { types: ['approval.decided'] })[0]?.payload).toMatchObject({
      outcome: 'allow',
      decidedBy: 'policy',
      policyRuleId: 'allow-read-only-inspection',
    })
    expect(s.decisions.at(-1)?.decision).toMatchObject({ outcome: 'allow' })
    expect(service.pendingApprovals()).toHaveLength(0)
  })

  it('queues anything policy will not decide, and answers it on the wire', async () => {
    const s = session()
    s.emit({
      type: 'approval.requested',
      request: {
        id: 'ap-ask' as never,
        agentId: 'claude',
        kind: 'command',
        command: ['npm', 'install'],
        cwd: '/repo',
        withNetwork: false,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    })
    await tick()

    expect(service.pendingApprovals().map((p) => p.id)).toEqual(['ap-ask'])
    expect(store.read(CONV, { types: ['approval.decided'] })).toHaveLength(0)

    await service.decideApproval('ap-ask', { outcome: 'allow', scope: 'session' })
    expect(store.read(CONV, { types: ['approval.decided'] })[0]?.payload).toMatchObject({
      outcome: 'allow',
      decidedBy: 'user',
    })
    // Granted for the session, so the same command is not asked again.
    expect(service.sessionGrants()).toHaveLength(1)
  })

  it('hands edits to the provider once the user says always, so the next file is not asked', async () => {
    /*
     * A grant is keyed on its subject, and for a file change that is the paths
     * it touched — so on its own "always" answers for this file and asks again
     * for the next one. For a command the subject *is* the action; for editing,
     * the next file is the same act.
     */
    const s = session()
    s.emit({
      type: 'approval.requested',
      request: {
        id: 'ap-edit' as never,
        agentId: 'codex',
        kind: 'fileChange',
        files: [{ path: '/repo/src/a.ts', patch: '@@' }],
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    })
    await tick()

    await service.decideApproval('ap-edit', { outcome: 'allow', scope: 'session' })
    await tick()

    expect(s.permissionModes).toEqual(['acceptEdits'])
  })

  it('leaves plan mode when the plan is approved', async () => {
    /*
     * `ExitPlanMode` is the agent saying it has finished reasoning and would
     * like to act. Approving the plan and separately having to leave the mode
     * would be two decisions for one intention, and the second is the kind that
     * gets forgotten — leaving an approved plan that never runs.
     */
    const s = session()
    let exited = false
    service = new ConversationService({
      store,
      conversationId: CONV,
      adapter,
      scheduler,
      onPlanExited: () => {
        exited = true
      },
    })
    await service.attach(s, OPTS, { state: 'ready', version: '1' })

    s.emit({
      type: 'approval.requested',
      request: {
        id: 'ap-plan' as never,
        agentId: 'codex',
        kind: 'permissionGrant',
        toolName: 'ExitPlanMode',
        cwd: '/tmp/project',
        requested: {},
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    })
    await tick()

    await service.decideApproval('ap-plan', { outcome: 'allow', scope: 'once' })
    await tick()

    expect(s.permissionModes).toEqual(['default'])
    expect(exited).toBe(true)
  })

  it('keeps planning when the plan is rejected', async () => {
    // A rejected plan means keep planning, not start doing.
    const s = session()
    s.emit({
      type: 'approval.requested',
      request: {
        id: 'ap-plan-no' as never,
        agentId: 'codex',
        kind: 'permissionGrant',
        toolName: 'ExitPlanMode',
        cwd: '/tmp/project',
        requested: {},
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    })
    await tick()

    await service.decideApproval('ap-plan-no', { outcome: 'deny', message: 'not yet' })
    await tick()

    expect(s.permissionModes).toEqual([])
  })

  it('does not hand edits over for a once-only allow', async () => {
    // "Just this one" is the answer that means the next one still asks.
    const s = session()
    s.emit({
      type: 'approval.requested',
      request: {
        id: 'ap-edit-once' as never,
        agentId: 'codex',
        kind: 'fileChange',
        files: [{ path: '/repo/src/a.ts', patch: '@@' }],
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    })
    await tick()

    await service.decideApproval('ap-edit-once', { outcome: 'allow', scope: 'once' })
    await tick()

    expect(s.permissionModes).toEqual([])
  })

  it('does not hand edits over because a command was allowed for the session', async () => {
    // Allowing `npm test` forever says nothing about writing to disk.
    const s = session()
    await service.decideApproval('ap3', { outcome: 'allow', scope: 'session' })
    await tick()

    expect(s.permissionModes).toEqual([])
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

describe('agent questions', () => {
  const ASK: UserInputRequest = {
    id: 'q1' as UserInputId,
    agentId: 'claude' as const,
    expiresAt: 60_000,
    questions: [
      {
        id: 'db',
        header: 'Database',
        question: 'Which database?',
        options: [{ label: 'Postgres', description: 'Relational' }],
        multiSelect: false,
        allowOther: false,
        isSecret: false,
      },
      {
        id: 'token',
        header: 'Token',
        question: 'API token?',
        options: [],
        multiSelect: false,
        allowOther: false,
        isSecret: true,
      },
    ],
  }

  const ask = async (): Promise<void> => {
    session().emit({ type: 'userinput.requested', request: ASK })
    await tick()
  }

  it('logs the question and waits, rather than letting policy answer it', async () => {
    await ask()
    // A profile decides whether an *action* is allowed. What the user wants is
    // not something a rule may decide on their behalf.
    expect(types()).toContain('userinput.requested')
    expect(types()).not.toContain('userinput.answered')
    expect(service.pendingQuestions()).toHaveLength(1)
  })

  it('forwards the answers to the agent so the turn continues', async () => {
    await ask()
    await service.answerUserInput('q1', {
      outcome: 'answered',
      answers: [
        { questionId: 'db', values: ['Postgres'] },
        { questionId: 'token', values: ['sk-secret-value'] },
      ],
    })

    expect(session().userInputResponses).toHaveLength(1)
    expect(session().userInputResponses[0]?.response).toMatchObject({
      outcome: 'answered',
      answers: [
        { questionId: 'db', values: ['Postgres'] },
        // The agent still receives the real value; only the log is redacted.
        { questionId: 'token', values: ['sk-secret-value'] },
      ],
    })
  })

  it('never writes a secret answer to the event log', async () => {
    await ask()
    await service.answerUserInput('q1', {
      outcome: 'answered',
      answers: [
        { questionId: 'db', values: ['Postgres'] },
        { questionId: 'token', values: ['sk-secret-value'] },
      ],
    })

    const logged = store.read(CONV, { types: ['userinput.answered'] })[0]?.payload
    expect(logged).toMatchObject({
      outcome: 'answered',
      answers: [
        { questionId: 'db', values: ['Postgres'] },
        // Null, not missing: "answered but not recorded" differs from "unanswered".
        { questionId: 'token', values: null },
      ],
    })
    // The strongest form of the assertion: the secret appears nowhere at all.
    expect(JSON.stringify(store.read(CONV))).not.toContain('sk-secret-value')
  })

  it('clears the question once answered, and a double submit is harmless', async () => {
    // A complete answer set, because an `answered` outcome that names none of
    // the questions is now refused — see the test below for why.
    const full = {
      outcome: 'answered' as const,
      answers: [
        { questionId: 'db', values: ['Postgres'] },
        { questionId: 'token', values: ['x'] },
      ],
    }
    await ask()
    await service.answerUserInput('q1', full)
    expect(service.pendingQuestions()).toHaveLength(0)

    // A UI that fires twice must not throw at the user or tell the agent twice.
    await service.answerUserInput('q1', full)
    expect(session().userInputResponses).toHaveLength(1)
    expect(store.read(CONV, { types: ['userinput.answered'] })).toHaveLength(1)
  })

  it('refuses an answer that does not name the questions asked', async () => {
    /*
     * The log entry is written *before* the provider is told, so an unvalidated
     * response becomes a permanent `answered` record for something the provider
     * may reject — which is how C-018 stayed invisible for weeks. A renderer
     * left open across a new request produces exactly this.
     */
    await ask()
    await service.answerUserInput('q1', {
      outcome: 'answered',
      answers: [{ questionId: 'not-a-question', values: ['x'] }],
    })

    expect(store.read(CONV, { types: ['userinput.answered'] })).toHaveLength(0)
    expect(session().userInputResponses).toHaveLength(0)
  })

  it('leaves the question pending so it can be answered again', async () => {
    // Not resolved as `cancel`: the user did not cancel, and saying they did
    // would be a different lie. The deadline still bounds it.
    await ask()
    await service.answerUserInput('q1', { outcome: 'answered', answers: [] })
    expect(service.pendingQuestions()).toHaveLength(1)
  })

  it('still accepts a timeout, which names no questions by design', async () => {
    // The completeness rule applies only to `answered`. A timeout carries no
    // answers and must stay able to resolve the card.
    await ask()
    await service.answerUserInput('q1', { outcome: 'timeout' }, 'system')
    expect(service.pendingQuestions()).toHaveLength(0)
    expect(store.read(CONV, { types: ['userinput.answered'] })).toHaveLength(1)
  })

  it('records a cancel without inventing answers', async () => {
    await ask()
    await service.answerUserInput('q1', { outcome: 'cancel' })
    expect(store.read(CONV, { types: ['userinput.answered'] })[0]?.payload).toMatchObject({
      outcome: 'cancel',
      answers: null,
    })
  })
})

describe('agent question deadlines', () => {
  const ASK_TTL: UserInputRequest = {
    id: 'q-ttl' as UserInputId,
    agentId: 'claude',
    expiresAt: 60_000,
    questions: [
      {
        id: 'a',
        header: 'H',
        question: 'Q?',
        options: [],
        multiSelect: false,
        allowOther: false,
        isSecret: false,
      },
    ],
  }

  it('times out rather than holding the turn open forever', async () => {
    // Neither provider imposes a deadline, so an unanswered question would
    // block the agent indefinitely with nothing left to answer it.
    session().emit({ type: 'userinput.requested', request: ASK_TTL })
    await tick()
    expect(service.pendingQuestions()).toHaveLength(1)

    scheduler.fire()
    await tick()

    expect(service.pendingQuestions()).toHaveLength(0)
    expect(session().userInputResponses[0]?.response).toMatchObject({ outcome: 'timeout' })
    expect(store.read(CONV, { types: ['userinput.answered'] })[0]?.payload).toMatchObject({
      outcome: 'timeout',
      // A timeout never invents an answer.
      answers: null,
      answeredBy: 'system',
    })
  })

  it('cancels an unanswered question when the session closes', async () => {
    session().emit({ type: 'userinput.requested', request: ASK_TTL })
    await tick()
    await service.close()

    expect(session().userInputResponses[0]?.response).toMatchObject({ outcome: 'cancel' })
  })
})

describe('a deadline that responds to the person', () => {
  /*
   * C-013. The clock measured time since the *agent asked*: nothing restarted
   * it, answering was not an input to it, and a card could be on screen,
   * focused and half-filled when it went. 10 of 25 question sets in the real
   * log died at exactly 300.0s.
   */
  /** Local, because `ASK_TTL` belongs to another block. Same shape. */
  const ASKED: UserInputRequest = {
    id: 'q-ttl' as UserInputId,
    agentId: 'claude',
    expiresAt: 60_000,
    questions: [
      {
        id: 'a',
        header: 'H',
        question: 'Q?',
        options: [],
        multiSelect: false,
        allowOther: false,
        isSecret: false,
      },
    ],
  }

  const ask = async (): Promise<void> => {
    session().emit({ type: 'userinput.requested', request: ASKED })
    await tick()
  }

  it('pushes the deadline out when the person does something', async () => {
    await ask()
    const before = service.pendingQuestions()[0]?.expiresAt ?? 0
    const after = service.extendUserInput('q-ttl', true)
    expect(after).not.toBeNull()
    expect(after ?? 0).toBeGreaterThan(before)
  })

  it('reads without changing anything when nothing was done', async () => {
    // A remounting card asks this way. Mounting is not evidence of a person —
    // the card focuses itself — so it must be able to say "I am back, what is
    // the deadline" without claiming attention it cannot prove.
    await ask()
    const first = service.extendUserInput('q-ttl', false)
    const second = service.extendUserInput('q-ttl', false)
    expect(first).toBe(second)
    expect(first).toBe(service.pendingQuestions()[0]?.expiresAt)
  })

  it('never pulls a deadline back towards now', async () => {
    // A gesture late in a long grace period must not shorten what it already
    // bought.
    await ask()
    const long = service.extendUserInput('q-ttl', true) ?? 0
    const again = service.extendUserInput('q-ttl', true) ?? 0
    expect(again).toBeGreaterThanOrEqual(long)
  })

  it('stops extending at a ceiling, so a stuck renderer cannot wedge a turn', async () => {
    await ask()
    let last = 0
    for (let i = 0; i < 200; i++) last = service.extendUserInput('q-ttl', true) ?? 0
    expect(last).toBeLessThanOrEqual(ASKED.expiresAt + 30 * 60_000)
  })

  it('does not extend a question that is already gone', async () => {
    await ask()
    await service.answerUserInput('q-ttl', { outcome: 'timeout' }, 'system')
    expect(service.extendUserInput('q-ttl', true)).toBeNull()
  })

  it('survives an expiry that fires after an extension was granted', async () => {
    /*
     * The race the re-arm exists for: a queued `setTimeout` cannot be
     * un-queued, so an extension arriving in the same tick as the expiry would
     * otherwise resolve against a deadline that has already moved — which is
     * this bug again with extra steps.
     */
    await ask()
    // Held before the extension, exactly as the runtime would already have it
    // queued. `clearTimeout` cannot call this back.
    const alreadyQueued = scheduler.peek()
    service.extendUserInput('q-ttl', true)
    alreadyQueued?.()
    await tick()

    expect(service.pendingQuestions()).toHaveLength(1)
    expect(store.read(CONV, { types: ['userinput.answered'] })).toHaveLength(0)
  })

  it('still times out once the extended deadline is reached', async () => {
    // The TTL is not the bug and must survive the fix.
    await ask()
    service.extendUserInput('q-ttl', true)
    scheduler.fire()
    await tick()
    scheduler.fire()
    await tick()

    expect(service.pendingQuestions()).toHaveLength(0)
    expect(store.read(CONV, { types: ['userinput.answered'] })[0]?.payload).toMatchObject({
      outcome: 'timeout',
    })
  })
})
