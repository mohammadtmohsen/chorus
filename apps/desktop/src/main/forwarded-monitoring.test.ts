import { testHostPorts } from './test-host-ports.js'
import type { AgentAdapter, ProgressReport, TranscriptRequest } from '@chorus/agent-protocol'
import { FakeAdapter, type FakeAgentSession } from '@chorus/orchestrator'
import { Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { utf8Length } from './forwarded-work.js'
import { ChorusRuntime, NAMER_INSTRUCTIONS } from './runtime.js'

const CWD = process.cwd()
const MARK = 'Split the release into A, B and C'
const LONE_SURROGATE = /[\uD800-\uDFFF]/u

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

let directory: string
let runtime: ChorusRuntime
let claude: FakeAdapter
let parentId: string
let projectId: string
let parentSession: FakeAgentSession

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const open = (adapter: FakeAdapter): ChorusRuntime =>
  ChorusRuntime.open(
    testHostPorts(directory),
    new Logger(),
    new Map<AgentId, AgentAdapter>([['claude', adapter]])
  )

const sessionSaying = (adapter: FakeAdapter, text: string): FakeAgentSession => {
  const found = adapter.sessions.findLast(
    (session) =>
      session.startedWith !== undefined &&
      session.startedWith.instructions !== NAMER_INSTRUCTIONS &&
      session.sent.some((input) => input.text.includes(text))
  )
  if (found === undefined) throw new Error(`no work session was sent "${text}"`)
  return found
}

const read = (
  request: Partial<TranscriptRequest> = {},
  maximum?: number,
  session: FakeAgentSession = parentSession
): string =>
  session.startedWith?.transcript?.(
    { skip: 0, count: 20, scope: 'forwarded', ...request },
    maximum
  ) ?? ''

const report = async (session: FakeAgentSession, input: ProgressReport) => {
  const progress = session.startedWith?.progress
  if (progress === undefined) throw new Error('the work session has no progress reporter')
  return await progress(input)
}

const forward = async (objective = 'Do B'): Promise<string> => {
  const child = await runtime.startConversation({
    projectId,
    agents: ['claude'],
    continueFrom: parentId,
    objective,
  })
  return child.conversationId
}

const latestTaskId = (conversationId: string): string => {
  const opened = runtime.store
    .read(conversationId)
    .findLast((event) => event.payload.type === 'task.opened')
  if (opened?.payload.type !== 'task.opened') throw new Error('no task')
  return opened.payload.taskId
}

const bindings = (conversationId: string): [string, string | null][] =>
  runtime.store
    .read(conversationId)
    .flatMap((event) =>
      event.payload.type === 'assignment.bound'
        ? [[event.payload.taskId, event.payload.previousTaskId] as [string, string | null]]
        : []
    )

const eventIdOf = (conversationId: string, type: string, needle = ''): string => {
  const found = runtime.store
    .read(conversationId)
    .findLast((event) => event.type === type && JSON.stringify(event.payload).includes(needle))
  if (found === undefined) throw new Error(`no ${type} event`)
  return found.id
}

const workOnB = async (childId: string): Promise<{ b: string; worker: FakeAgentSession }> => {
  await runtime.send(childId, 'Build B')
  const worker = sessionSaying(claude, 'Build B')
  worker.emit({ type: 'turn.started', turnRef: 't1' })
  await tick()
  await report(worker, PLAN)
  worker.emit({ type: 'command.started', itemRef: 'c1', command: ['pnpm', 'test'], cwd: CWD })
  worker.emit({ type: 'command.output', itemRef: 'c1', stream: 'stdout', chunk: 'SECRET_OUTPUT' })
  worker.emit({ type: 'command.completed', itemRef: 'c1', exitCode: 0 })
  await tick()
  await report(worker, DONE)
  worker.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
  await tick()
  const b = latestTaskId(childId)
  runtime.closeTask(childId, b, 'completed')
  return { b, worker }
}

const workOnC = async (childId: string, worker: FakeAgentSession): Promise<void> => {
  await runtime.send(childId, 'Now C')
  worker.emit({ type: 'turn.started', turnRef: 't2' })
  await tick()
  await report(worker, PLAN)
  worker.emit({ type: 'command.started', itemRef: 'c2', command: ['rm', 'LATER_C'], cwd: CWD })
  await tick()
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'chorus-forwarded-'))
  claude = new FakeAdapter({ id: 'claude' })
  runtime = open(claude)
  const parent = await runtime.startConversationIn({ agents: ['claude'], cwd: CWD })
  parentId = parent.conversationId
  projectId = parent.projectId
  await runtime.send(parentId, MARK)
  parentSession = sessionSaying(claude, MARK)
})

afterEach(async () => {
  await runtime.close()
})

describe('the original reading work it forwarded', () => {
  it('reads the marked task after later work in the child, and again after a reopen', async () => {
    const childId = await forward()
    const { b, worker } = await workOnB(childId)
    expect(runtime.bindAssignment(childId, b)).toMatchObject({
      outcome: 'bound',
      taskId: b,
      previousTaskId: null,
    })
    await workOnC(childId, worker)

    const list = read()
    expect(list).toContain(childId)
    expect(list).toContain(`Marked task ${b}`)
    expect(list).toContain('completion recorded')

    const detail = read({ conversationId: childId })
    expect(detail).toContain(`Completion was recorded for task ${b}.`)
    expect(detail).toContain("Every agent's latest plan revision declares it complete.")
    expect(detail).toContain('ran `pnpm test`, exit code 0')
    expect(detail).toContain('Objective recorded when it was forwarded: "Do B"')
    expect(detail).not.toContain('LATER_C')
    expect(detail).not.toContain('SECRET_OUTPUT')
    expect(detail).toMatch(/as of #\d+/u)

    await runtime.close()
    const after = new FakeAdapter({ id: 'claude' })
    runtime = open(after)
    await runtime.restoreOpenConversations()
    await runtime.send(parentId, 'How is B going?')
    const reopened = read({ conversationId: childId }, undefined, sessionSaying(after, 'How is B'))
    expect(reopened).toContain(`Completion was recorded for task ${b}.`)
    expect(reopened).toContain('ran `pnpm test`, exit code 0')
    expect(reopened).not.toContain('LATER_C')
  })

  it('keeps an unmarked child to a suggestion, even once its first task completes', async () => {
    const childId = await forward()
    await workOnB(childId)
    const detail = read({ conversationId: childId })
    expect(detail).toContain('Unconfirmed suggestion: task')
    expect(detail).toContain('no status is reported')
    expect(detail).not.toContain('Completion was recorded')
    expect(detail).not.toContain('declares it complete')
  })

  it('keeps the marking when guidance preceded the first plan, and claims no idleness', async () => {
    const childId = await forward()
    await runtime.send(childId, 'Build B')
    const worker = sessionSaying(claude, 'Build B')
    worker.emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    await runtime.send(childId, 'Use the v2 endpoint', undefined, 'guide')
    await report(worker, PLAN)
    const b = latestTaskId(childId)
    const guidance = eventIdOf(childId, 'user.message', 'Use the v2 endpoint')
    const opened = runtime.store
      .read(childId)
      .findLast((event) => event.payload.type === 'task.opened')
    expect(opened?.payload).toMatchObject({ originEventId: guidance })
    expect(runtime.bindAssignment(childId, b)).toMatchObject({ outcome: 'bound' })

    const detail = read({ conversationId: childId })
    expect(detail).toContain(`The user marked task ${b} as this forwarded work.`)
    expect(detail).toContain(`Task ${b} is open: no close is recorded for it.`)
    expect(detail).toContain(
      "No running turn or open wait that began in this task's tracked window"
    )
    expect(detail).toContain('That does not show the conversation is idle')
    expect(detail).not.toContain('has a turn running there.')
    expect(detail).not.toContain('Nothing is running')
  })

  it('stops claiming current work for B once a later request arrives before its plan', async () => {
    const childId = await forward()
    await runtime.send(childId, 'Build B')
    const worker = sessionSaying(claude, 'Build B')
    await report(worker, PLAN)
    const b = latestTaskId(childId)
    runtime.bindAssignment(childId, b)
    worker.emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    expect(read({ conversationId: childId })).toContain('claude has a turn running there.')

    worker.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await tick()
    await runtime.send(childId, 'Also do C', undefined, 'work')
    worker.emit({ type: 'turn.started', turnRef: 't2' })
    worker.emit({ type: 'command.started', itemRef: 'c9', command: ['echo', 'FOR_C'], cwd: CWD })
    await tick()
    expect(latestTaskId(childId)).toBe(b)
    const detail = read({ conversationId: childId })
    expect(detail).toContain('the user made another request there')
    expect(detail).toContain('ran `echo FOR_C`')
    expect(detail).not.toContain('has a turn running there.')
  })

  it('reads cited records and searches only within the marked task', async () => {
    const childId = await forward()
    const { b, worker } = await workOnB(childId)
    runtime.bindAssignment(childId, b)
    await workOnC(childId, worker)

    const marking = eventIdOf(childId, 'assignment.bound')
    const binding = read({ conversationId: childId, eventId: marking })
    expect(binding).toContain('The user’s marking of the forwarded work')
    const output = read({ conversationId: childId, eventId: eventIdOf(childId, 'command.output') })
    expect(output).toContain(`${String(utf8Length('SECRET_OUTPUT'))} bytes`)
    expect(output).not.toContain('SECRET_OUTPUT')
    const later = read({
      conversationId: childId,
      eventId: eventIdOf(childId, 'command.started', 'LATER_C'),
    })
    expect(later).toContain('not among the marked task’s records')
    expect(later).not.toContain('rm LATER_C')

    const found = read({ conversationId: childId, query: 'pnpm' })
    expect(found).toContain('1 matching records')
    expect(found).toContain('pnpm test')
    expect(read({ conversationId: childId, query: 'LATER_C' })).toContain('0 matching records')
    expect(read({ conversationId: childId, query: 'SECRET_OUTPUT' })).toContain(
      '0 matching records'
    )

    const digest = read({ conversationId: childId })
    const citations = [...digest.matchAll(/\[#\d+ ([^\]\s]+)\]/gu)].map((match) => match[1] ?? '')
    expect(citations.length).toBeGreaterThan(5)
    for (const cited of new Set(citations)) {
      expect(read({ conversationId: childId, eventId: cited }), cited).not.toMatch(
        /not readable here|No record|written after this read/u
      )
    }

    const stranger = read({ conversationId: 'stranger' })
    expect(stranger).toContain('No forwarded conversation stranger is readable here')
    expect(stranger).toContain(childId)
    expect(read({ conversationId: parentId })).toContain(
      `No forwarded conversation ${parentId} is readable here`
    )
    expect(read({ query: 'B' })).toContain('not accepted when listing forwarded conversations')
  })

  it('leaves snapshot and updates reads as they were', async () => {
    const childId = await forward()
    await workOnB(childId)
    const plain = (request: Partial<TranscriptRequest>): string =>
      parentSession.startedWith?.transcript?.({ skip: 0, count: 20, ...request }) ?? ''
    expect(plain({})).toContain(MARK)
    expect(plain({ query: 'Build B' })).toContain('0 matching records')
    expect(plain({ scope: 'updates' })).toContain('There are no later records to read')
    expect(plain({ conversationId: childId })).toContain(
      `No conversation ${childId} is readable here`
    )
  })

  it('keeps a forwarded answer within the caller’s byte budget, on whole characters', async () => {
    const childId = await forward(`هدف 🌙 ${'نص 🌙 '.repeat(300)}`)
    const { b } = await workOnB(childId)
    runtime.bindAssignment(childId, b)
    for (const [request, maximum] of [
      [{ conversationId: childId }, 700],
      [{ conversationId: childId }, 2_000],
      [{}, 500],
      [{ conversationId: childId, query: 'pnpm' }, 400],
    ] as const) {
      const text = read(request, maximum)
      expect(utf8Length(text), JSON.stringify(request)).toBeLessThanOrEqual(maximum)
      expect(text).not.toMatch(LONE_SURROGATE)
    }
  })
})

describe('marking the forwarded work', () => {
  it('marks only the task the strip shows, keeps corrections, and never repeats one', async () => {
    expect(runtime.bindAssignment(parentId, 'anything')).toEqual({
      outcome: 'refused',
      reason: 'not-forwarded',
    })
    const childId = await forward()
    expect(runtime.bindAssignment(childId, 'nothing-yet')).toEqual({
      outcome: 'refused',
      reason: 'no-task',
    })
    await runtime.send(childId, 'Build B')
    const worker = sessionSaying(claude, 'Build B')
    await report(worker, PLAN)
    const b = latestTaskId(childId)
    expect(runtime.bindAssignment(childId, 'not-a-task')).toEqual({
      outcome: 'refused',
      reason: 'not-latest',
    })
    expect(runtime.bindAssignment(childId, b)).toMatchObject({
      outcome: 'bound',
      taskId: b,
      previousTaskId: null,
    })
    expect(runtime.bindAssignment(childId, b)).toMatchObject({ outcome: 'unchanged', taskId: b })

    await runtime.send(childId, 'Now C')
    await report(worker, { ...PLAN, scope: 'new' })
    const c = latestTaskId(childId)
    expect(c).not.toBe(b)
    expect(runtime.bindAssignment(childId, b)).toEqual({ outcome: 'refused', reason: 'not-latest' })
    expect(runtime.bindAssignment(childId, c)).toMatchObject({
      outcome: 'bound',
      taskId: c,
      previousTaskId: b,
    })
    expect(bindings(childId)).toEqual([
      [b, null],
      [c, b],
    ])
    expect(bindings(parentId)).toEqual([])
  })
})
