import { testHostPorts } from './test-host-ports.js'
import type { AgentAdapter, ProgressReport } from '@chorus/agent-protocol'
import { FakeAdapter, type FakeAgentSession } from '@chorus/orchestrator'
import { Logger, newApprovalId, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTranscriptState,
  EMPTY_VIEW,
  reduceEvents,
  reduceTranscriptRead,
} from '../renderer/src/transcript.js'
import { pulseWorking, reducePulse, type SessionPulse } from '../renderer/src/workspace/store.js'
import { IPC_CONTRACT, LiveStateShape, TranscriptEvent } from '../shared/ipc.js'
import { reduceTask } from '../shared/task-progress.js'
import { ChorusRuntime, NAMER_INSTRUCTIONS } from './runtime.js'

let runtime: ChorusRuntime
let conversationId: string
let claude: FakeAdapter
let codex: FakeAdapter

const DISCUSSION = 'You are in Discussion mode.'

const workSessions = (adapter: FakeAdapter): FakeAgentSession[] =>
  adapter.sessions.filter(
    (session) =>
      session.startedWith !== undefined &&
      session.startedWith.instructions !== NAMER_INSTRUCTIONS &&
      session.startedWith.instructions?.startsWith(DISCUSSION) !== true
  )

const workSession = (adapter: FakeAdapter = claude): FakeAgentSession => {
  const found = workSessions(adapter).at(-1)
  if (found === undefined) throw new Error('no work session')
  return found
}

const reporterOf = (session: FakeAgentSession) => {
  const progress = session.startedWith?.progress
  if (progress === undefined) throw new Error('the work session has no progress reporter')
  return progress
}

const report = async (input: ProgressReport, session: FakeAgentSession = workSession()) =>
  reporterOf(session)(input)

const taskEvents = () =>
  runtime.store.read(conversationId).filter((event) => event.type.startsWith('task.'))
const taskTypes = (): string[] => taskEvents().map((event) => event.type)
const revisions = () =>
  taskEvents().flatMap((event) => (event.payload.type === 'task.revised' ? [event.payload] : []))

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const currentTaskId = (): string => {
  const opened = taskEvents().findLast((event) => event.payload.type === 'task.opened')
  if (opened?.payload.type !== 'task.opened') throw new Error('no task')
  return opened.payload.taskId
}

const PLAN: ProgressReport = {
  steps: [
    { id: 'read', label: '1', title: 'Read the types', status: 'active', estimateMinutes: 5 },
    { id: 'write', label: '2', title: 'Write the reducer', status: 'pending', estimateMinutes: 20 },
  ],
}
const DONE: ProgressReport = {
  steps: PLAN.steps.map((step) => ({ ...step, status: 'done' as const })),
  complete: true,
}

const nativePlan = (session: FakeAgentSession, items: [string, boolean][]): void => {
  session.emit({
    type: 'plan.updated',
    steps: items.map(([text, done]) => ({ text, done })),
  })
}

beforeEach(async () => {
  claude = new FakeAdapter({ id: 'claude' })
  codex = new FakeAdapter({ id: 'codex' })
  runtime = ChorusRuntime.open(
    testHostPorts(mkdtempSync(join(tmpdir(), 'chorus-task-progress-'))),
    new Logger(),
    new Map<AgentId, AgentAdapter>([
      ['claude', claude],
      ['codex', codex],
    ])
  )
  const started = await runtime.startConversationIn({ agents: ['claude'], cwd: process.cwd() })
  conversationId = started.conversationId
})

afterEach(async () => {
  await runtime.close()
})

describe('the progress tool a work session is given', () => {
  it('anchors a new task at the work message that started the turn', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    const origin = runtime.store
      .read(conversationId)
      .findLast((event) => event.payload.type === 'user.message')
    expect((await report(PLAN)).ok).toBe(true)
    const [opened, revised] = taskEvents()
    expect(opened?.payload).toMatchObject({
      type: 'task.opened',
      originEventId: origin?.id,
      startedAt: origin?.createdAt,
    })
    expect(revised?.payload).toMatchObject({ type: 'task.revised', agentId: 'claude', revision: 1 })
  })

  it('comes with a Work instruction to report, and a discussion gets neither', async () => {
    expect(workSession().startedWith?.instructions).toContain('report_progress')
    const before = claude.startedOpts.length
    await runtime.send(conversationId, 'What would this take?', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(claude.startedOpts.length).toBeGreaterThan(before)
    })
    const discussion = claude.startedOpts.at(-1)
    expect(discussion?.progress).toBeUndefined()
    expect(discussion?.instructions).not.toContain('report_progress')
  })

  it('keeps revising the same task across reports and turns', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    await report(PLAN)
    workSession().emit({ type: 'turn.started', turnRef: 't1' })
    workSession().emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await tick()
    await runtime.send(conversationId, 'Carry on')
    await report({ ...PLAN, reason: 'Second pass' })
    expect(taskTypes()).toEqual(['task.opened', 'task.revised', 'task.revised'])
    expect(revisions().map((payload) => payload.revision)).toEqual([1, 2])
  })

  it('keeps one task when the agent calls work new without a new request', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    await report(PLAN)
    const result = await report({ ...PLAN, scope: 'new' })
    expect(result.text).toMatch(/stays in the current task/)
    expect(taskTypes()).toEqual(['task.opened', 'task.revised', 'task.revised'])
  })

  it('starts a different task when the agent says the work is new and it is', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    await report(PLAN)
    await runtime.send(conversationId, 'Now something else')
    await report({ ...PLAN, scope: 'new' })
    expect(taskTypes()).toEqual([
      'task.opened',
      'task.revised',
      'task.closed',
      'task.opened',
      'task.revised',
    ])
    expect(taskEvents()[2]?.payload).toMatchObject({ reason: 'superseded' })
  })

  it('refuses a completion that contradicts the steps, before anything is written', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    const result = await report({ ...PLAN, complete: true })
    expect(result.ok).toBe(false)
    expect(taskTypes()).toEqual([])
  })

  it('does not close when a turn ends without the agent saying it is done', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    workSession().emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    await report(PLAN)
    workSession().emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await tick()
    expect(taskTypes()).not.toContain('task.closed')
  })

  it('closes with a measured outcome once the agent is done and its turn settles', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    workSession().emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    await report(DONE)
    expect(taskTypes()).not.toContain('task.closed')
    workSession().emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await vi.waitFor(() => {
      expect(taskTypes()).toContain('task.closed')
    })
    const closed = taskEvents().find((event) => event.payload.type === 'task.closed')
    expect(closed?.payload).toMatchObject({ reason: 'completed' })
    const lanes = closed?.payload.type === 'task.closed' ? closed.payload.outcome?.lanes : []
    expect(lanes).toHaveLength(1)
  })

  it('does not let a completion from a failed turn close the task', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    workSession().emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    await report(DONE)
    workSession().emit({ type: 'turn.completed', turnRef: 't1', status: 'failed' })
    await tick()
    expect(taskTypes()).not.toContain('task.closed')
  })

  it('travels with the transcript state, independent of any page', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    await report(PLAN)
    const bundle = runtime.transcriptState(conversationId).task
    const snapshot = bundle === null ? null : reduceTask(bundle, Date.now())
    expect(snapshot?.steps.map((step) => step.label)).toEqual(['1', '2'])
    expect(snapshot?.forecast?.plannedMs).toBe(25 * 60_000)
  })
})

describe('who may report', () => {
  it('refuses a reporter from a session that has since been replaced', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    const stale = workSession()
    await runtime.setAnswerStyle(conversationId, true)
    await runtime.setAnswerStyle(conversationId, false)
    const current = workSession()
    expect(current).not.toBe(stale)
    const refused = await report(PLAN, stale)
    expect(refused.ok).toBe(false)
    expect(taskTypes()).toEqual([])
    expect((await report(PLAN, current)).ok).toBe(true)
    expect(taskTypes()).toEqual(['task.opened', 'task.revised'])
  })

  it('refuses a late report once the task for that request is closed', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    await report(PLAN)
    expect(runtime.closeTask(conversationId, currentTaskId(), 'abandoned')).toBe(true)
    expect((await report(PLAN)).ok).toBe(false)
    nativePlan(workSession(), [['Read the types', true]])
    await tick()
    expect(taskTypes()).toEqual(['task.opened', 'task.revised', 'task.closed'])

    await runtime.send(conversationId, 'Next piece of work')
    expect((await report(PLAN)).ok).toBe(true)
    expect(taskTypes().filter((type) => type === 'task.opened')).toHaveLength(2)
  })
})

describe('a provider plan without the tool', () => {
  it('opens a step-only task, records changes only, and closes when all are done', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    const session = workSession()
    session.emit({ type: 'turn.started', turnRef: 't1' })
    nativePlan(session, [
      ['Read the types', true],
      ['Write the reducer', false],
    ])
    nativePlan(session, [
      ['Read the types', true],
      ['Write the reducer', false],
    ])
    await tick()
    expect(taskTypes()).toEqual(['task.opened', 'task.revised'])
    expect(revisions()[0]).toMatchObject({ source: 'native' })
    expect(revisions()[0]?.steps[0]).not.toHaveProperty('estimateMinutes')

    nativePlan(session, [
      ['Read the types', true],
      ['Write the reducer', true],
    ])
    session.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await vi.waitFor(() => {
      expect(taskTypes()).toEqual(['task.opened', 'task.revised', 'task.revised', 'task.closed'])
    })

    nativePlan(session, [
      ['Read the types', true],
      ['Write the reducer', true],
    ])
    await tick()
    expect(taskTypes()).toEqual(['task.opened', 'task.revised', 'task.revised', 'task.closed'])
  })

  it('keeps the task when the next request replaces every step', async () => {
    await runtime.send(conversationId, 'Research the parser')
    nativePlan(workSession(), [
      ['Read the parser', true],
      ['Write notes', false],
    ])
    await tick()
    await runtime.send(conversationId, 'Now implement it')
    nativePlan(workSession(), [
      ['Change the grammar', false],
      ['Add tests', false],
    ])
    await tick()
    expect(taskTypes()).toEqual(['task.opened', 'task.revised', 'task.revised'])
  })

  it('keeps each step’s id when the provider reorders its list', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    nativePlan(workSession(), [
      ['Read the types', false],
      ['Write the reducer', false],
    ])
    nativePlan(workSession(), [
      ['Write the reducer', false],
      ['Read the types', true],
    ])
    await tick()
    const [first, second] = revisions()
    const ids = (steps: readonly { id: string; title: string }[] | undefined) =>
      Object.fromEntries((steps ?? []).map((step) => [step.title, step.id]))
    expect(ids(second?.steps)).toEqual(ids(first?.steps))
  })

  it('is ignored once the agent has published its own plan', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    await report(PLAN)
    nativePlan(workSession(), [['Something else', false]])
    await tick()
    expect(taskTypes()).toEqual(['task.opened', 'task.revised'])
  })
})

describe('a task shared by two agents', () => {
  it('closes only when every lane has finished its own plan and settled', async () => {
    await runtime.closeConversation(conversationId)
    const started = await runtime.startConversationIn({
      agents: ['claude', 'codex'],
      cwd: process.cwd(),
    })
    conversationId = started.conversationId
    await runtime.send(conversationId, '@claude build the countdown')
    const lead = workSession(claude)
    const helper = workSession(codex)
    lead.emit({ type: 'turn.started', turnRef: 'c1' })
    helper.emit({ type: 'turn.started', turnRef: 'x1' })
    await tick()
    await report(DONE, lead)
    nativePlan(helper, [
      ['Review the reducer', false],
      ['Report back', false],
    ])
    lead.emit({ type: 'turn.completed', turnRef: 'c1', status: 'completed' })
    await tick()
    expect(taskTypes()).not.toContain('task.closed')

    nativePlan(helper, [
      ['Review the reducer', true],
      ['Report back', true],
    ])
    helper.emit({ type: 'turn.completed', turnRef: 'x1', status: 'completed' })
    await vi.waitFor(() => {
      expect(taskTypes()).toContain('task.closed')
    })
  })
})

describe('waits from a discussion', () => {
  it('are logged as discussion, so they never pause the work clock', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    workSession().emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    await report(PLAN)
    await runtime.send(conversationId, 'What would this take?', undefined, 'discussion')
    const discussion = await vi.waitFor(() => {
      const found = claude.sessions.find(
        (session) =>
          session.startedWith?.instructions?.startsWith(DISCUSSION) === true &&
          session.sent.length > 0
      )
      if (found === undefined) throw new Error('no discussion turn yet')
      return found
    })
    discussion.emit({
      type: 'approval.requested',
      request: {
        id: newApprovalId(),
        agentId: 'claude',
        kind: 'command',
        command: ['ls'],
        cwd: process.cwd(),
        withNetwork: false,
        expiresAt: Date.now() + 60_000,
      },
    })
    await vi.waitFor(() => {
      const logged = runtime.store
        .read(conversationId)
        .find((event) => event.payload.type === 'approval.requested')
      expect(logged?.payload).toMatchObject({ mode: 'discussion' })
    })
    const bundle = runtime.transcriptState(conversationId).task
    const snapshot = bundle === null ? null : reduceTask(bundle, Date.now() + 60_000)
    expect(snapshot?.state).toBe('working')
    expect(snapshot?.waitingOn).toEqual([])
  })
})

describe('a hard kill', () => {
  it('ends work at the last stored event, even before any agent is resumed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chorus-task-kill-'))
    const before = new FakeAdapter({ id: 'claude' })
    const killed = ChorusRuntime.open(
      testHostPorts(directory),
      new Logger(),
      new Map<AgentId, AgentAdapter>([['claude', before]])
    )
    const room = await killed.startConversationIn({ agents: ['claude'], cwd: process.cwd() })
    await killed.send(room.conversationId, 'Build the countdown')
    const session = workSession(before)
    session.emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    await reporterOf(session)(PLAN)
    session.emit({ type: 'tool.started', itemRef: 'read-1', name: 'Read' })
    await tick()
    const lastWork = killed.store.read(room.conversationId).at(-1)?.createdAt ?? 0

    const after = new FakeAdapter({ id: 'claude' })
    const reopened = ChorusRuntime.open(
      testHostPorts(directory),
      new Logger(),
      new Map<AgentId, AgentAdapter>([['claude', after]]),
      { deferRestoredAgents: true }
    )
    try {
      const bundle = reopened.transcriptState(room.conversationId).task
      const later = Date.now() + 3_600_000
      const snapshot = bundle === null ? null : reduceTask(bundle, later)
      expect(snapshot?.state).toBe('unknown')
      expect(snapshot?.clocks.workingMs).toBeLessThanOrEqual(lastWork - (snapshot?.startedAt ?? 0))
      expect(snapshot?.clocks.unknownMs).toBeGreaterThan(3_000_000)
      expect(snapshot?.clocks.elapsedMs).toBeGreaterThan(3_600_000)
      expect(after.sessions).toEqual([])

      await reopened.restoreOpenConversations()
      await reopened.send(room.conversationId, 'Carry on')
      workSession(after).emit({ type: 'turn.started', turnRef: 't2' })
      await tick()
      const resumed = reopened.transcriptState(room.conversationId).task
      const now = resumed === null ? null : reduceTask(resumed, Date.now())
      expect(now?.taskId).toBe(snapshot?.taskId)
      expect(now?.state).toBe('working')
    } finally {
      await reopened.close()
      await killed.close()
    }
  })
})

describe('ending tracking from the strip', () => {
  it('closes only the task the click was about, and never its replacement', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    await report(PLAN)
    const first = currentTaskId()
    await runtime.send(conversationId, 'Now something else')
    await report({ ...PLAN, scope: 'new' })
    const second = currentTaskId()
    expect(second).not.toBe(first)
    expect(runtime.closeTask(conversationId, first, 'abandoned')).toBe(false)
    expect(taskTypes().at(-1)).toBe('task.revised')
    expect(runtime.closeTask(conversationId, second, 'abandoned')).toBe(true)
    expect(taskEvents().at(-1)?.payload).toMatchObject({ type: 'task.closed', reason: 'abandoned' })
    expect(runtime.closeTask(conversationId, second, 'abandoned')).toBe(false)
  })

  it('validates the request it accepts', () => {
    const request = IPC_CONTRACT['task:close'].request
    expect(
      request.safeParse({ conversationId: 'c', taskId: 't', reason: 'abandoned' }).success
    ).toBe(true)
    expect(request.safeParse({ conversationId: 'c', reason: 'abandoned' }).success).toBe(false)
    const empty = { conversationId: 'c', taskId: '', reason: 'abandoned' }
    expect(request.safeParse(empty).success).toBe(false)
    const interrupt = { conversationId: 'c', taskId: 't', reason: 'interrupt' }
    expect(request.safeParse(interrupt).success).toBe(false)
  })

  it('reads the full task for a pane that comes back', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    await report(PLAN)
    const bundle = runtime.taskState(conversationId)
    expect(bundle?.marks.some((mark) => mark.kind === 'opened')).toBe(true)
    const response = { task: bundle, throughSeq: runtime.logPosition() }
    expect(IPC_CONTRACT['task:state'].response.safeParse(response).success).toBe(true)
    expect(IPC_CONTRACT['task:state'].response.safeParse({ task: bundle }).success).toBe(false)
  })
})

describe('a usage limit inside a discussion', () => {
  it('is dropped, so it can never pause the work', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    workSession().emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    await report(PLAN)
    await runtime.send(conversationId, 'What would this take?', undefined, 'discussion')
    const discussion = await vi.waitFor(() => {
      const found = claude.sessions.find(
        (session) =>
          session.startedWith?.instructions?.startsWith(DISCUSSION) === true &&
          session.sent.length > 0
      )
      if (found === undefined) throw new Error('no discussion turn yet')
      return found
    })
    discussion.emit({ type: 'usage.blocked', resetsAt: null })
    discussion.emit({ type: 'message.completed', itemRef: 'm1', text: 'It is blocked.' })
    await vi.waitFor(() => {
      expect(
        runtime.store
          .read(conversationId)
          .some((event) => event.payload.type === 'agent.message.completed')
      ).toBe(true)
    })
    expect(runtime.store.read(conversationId).map((event) => event.type)).not.toContain(
      'usage.blocked'
    )
  })
})

describe('what a later subscriber sees when a task closes itself', () => {
  const PULSE: SessionPulse = {
    lastSeq: 0,
    unread: 0,
    working: [],
    approvalIds: [],
    questionIds: [],
    usageByActor: {},
    tokens: 0,
    costUsd: null,
    contextByActor: {},
    tasksByActor: {},
    activityByActor: {},
    failed: false,
  }

  const observe = (): ((id: string) => TranscriptEvent[][]) => {
    const batches: TranscriptEvent[][] = []
    runtime.subscribe((events) => {
      batches.push(events.map((event) => TranscriptEvent.parse(event)))
    })
    return (id) =>
      batches
        .map((batch) => batch.filter((event) => event.conversationId === id))
        .filter((batch) => batch.length > 0)
  }

  const fold = (batches: readonly TranscriptEvent[][]) => ({
    view: batches.reduce((view, batch) => reduceEvents(view, batch), EMPTY_VIEW),
    pulse: batches.flat().reduce((pulse, event) => reducePulse(pulse, event, true), PULSE),
  })

  const finishTracked = async (): Promise<void> => {
    workSession().emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await vi.waitFor(() => {
      expect(taskTypes()).toContain('task.closed')
    })
  }

  it('delivers the turn end first, so busy clears with no further message', async () => {
    const seen = observe()
    await runtime.send(conversationId, 'Build the countdown')
    workSession().emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    await report(DONE)
    await finishTracked()

    const received = seen(conversationId).flat()
    const seqs = received.map((event) => event.seq)
    const types = received.map((event) => event.type)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(types).toContain('turn.completed')
    expect(types.indexOf('turn.completed')).toBeLessThan(types.indexOf('task.closed'))

    const { view, pulse } = fold(seen(conversationId))
    expect(view.working).toEqual([])
    expect(view.workingSince).toEqual({})
    expect(view.busy).toBe(false)
    expect(pulseWorking(pulse)).toEqual([])
  })

  it('keeps a pending Chat reply busy after the Work task closes', async () => {
    const seen = observe()
    await runtime.send(conversationId, 'Build the countdown')
    workSession().emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    await runtime.send(conversationId, 'What would this take?', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(Object.keys(fold(seen(conversationId)).view.replies)).not.toEqual([])
    })
    await report(DONE)
    await finishTracked()

    const { view, pulse } = fold(seen(conversationId))
    expect(view.working).toEqual([])
    expect(Object.values(view.replies).map((reply) => reply.agentId)).toEqual(['claude'])
    expect(view.busy).toBe(true)
    expect(pulseWorking(pulse)).toEqual(['claude'])
  })

  it('keeps the other agent busy until its own turn ends, then clears both', async () => {
    await runtime.closeConversation(conversationId)
    const started = await runtime.startConversationIn({
      agents: ['claude', 'codex'],
      cwd: process.cwd(),
    })
    conversationId = started.conversationId
    const seen = observe()
    await runtime.send(conversationId, '@claude build the countdown')
    const lead = workSession(claude)
    const helper = workSession(codex)
    lead.emit({ type: 'turn.started', turnRef: 'c1' })
    helper.emit({ type: 'turn.started', turnRef: 'x1' })
    await tick()
    await report(DONE, lead)
    nativePlan(helper, [['Review the reducer', false]])
    lead.emit({ type: 'turn.completed', turnRef: 'c1', status: 'completed' })
    await tick()
    expect(taskTypes()).not.toContain('task.closed')
    expect(fold(seen(conversationId)).view.working).toEqual(['codex'])

    nativePlan(helper, [['Review the reducer', true]])
    helper.emit({ type: 'turn.completed', turnRef: 'x1', status: 'completed' })
    await vi.waitFor(() => {
      expect(taskTypes()).toContain('task.closed')
    })
    const { view, pulse } = fold(seen(conversationId))
    expect(view.working).toEqual([])
    expect(view.busy).toBe(false)
    expect(pulseWorking(pulse)).toEqual([])
  })

  it('still shows a newer turn as working after the close', async () => {
    const seen = observe()
    await runtime.send(conversationId, 'Build the countdown')
    workSession().emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    await report(DONE)
    await finishTracked()

    await runtime.send(conversationId, 'Carry on')
    workSession().emit({ type: 'turn.started', turnRef: 't2' })
    await vi.waitFor(() => {
      expect(fold(seen(conversationId)).view.working).toEqual(['claude'])
    })
    const { view, pulse } = fold(seen(conversationId))
    expect(view.busy).toBe(true)
    expect(pulseWorking(pulse)).toEqual(['claude'])
  })
})

describe('the live state a returning pane reads', () => {
  it('matches what folding the same log live produces', async () => {
    await runtime.send(conversationId, 'Build the countdown')
    const session = workSession()
    session.emit({ type: 'turn.started', turnRef: 't1' })
    session.emit({ type: 'tool.started', itemRef: 'read-1', name: 'Read', detail: 'src/a.ts' })
    session.emit({ type: 'tool.started', itemRef: 'read-2', name: 'Read' })
    session.emit({ type: 'tool.completed', itemRef: 'read-2', status: 'ok' })
    await vi.waitFor(() => {
      expect(
        runtime.store.read(conversationId).some((event) => event.payload.type === 'tool.completed')
      ).toBe(true)
    })

    const replayed = reduceEvents(
      EMPTY_VIEW,
      runtime.store.read(conversationId).map((event) => TranscriptEvent.parse(event))
    )
    const state = runtime.transcriptState(conversationId)
    const restored = applyTranscriptState(
      reduceTranscriptRead(EMPTY_VIEW, [], runtime.logPosition()),
      {
        ...state,
        replies: state.replies.map((event) => TranscriptEvent.parse(event)),
        live: LiveStateShape.parse(state.live),
      }
    )
    expect(Object.keys(restored.operations)).toEqual(['work:claude|read-1'])
    expect(restored.operations).toEqual(replayed.operations)
    expect(restored.turns).toEqual(replayed.turns)
    expect(restored.evidenceAt).toEqual(replayed.evidenceAt)
  })
})

describe('provider activity from a replaced session', () => {
  it('is dropped, while the session that replaced it is heard', async () => {
    const pushes: { agentId: string; activity: string | null }[] = []
    runtime.onActivityReported((push) => {
      pushes.push({ agentId: push.agentId, activity: push.activity })
    })
    await runtime.send(conversationId, 'Build the countdown')
    const previous = workSession()
    previous.emit({ type: 'activity.changed', activity: 'thinking' })
    await vi.waitFor(() => {
      expect(pushes).toEqual([{ agentId: 'claude', activity: 'thinking' }])
    })

    previous.emit({ type: 'activity.changed', activity: 'compacting' })
    await runtime.setAnswerStyle(conversationId, true)
    const current = workSession()
    expect(current).not.toBe(previous)
    current.emit({ type: 'activity.changed', activity: 'requesting' })
    await vi.waitFor(() => {
      expect(pushes.at(-1)).toEqual({ agentId: 'claude', activity: 'requesting' })
    })
    expect(pushes.map((push) => push.activity)).not.toContain('compacting')
  })
})
