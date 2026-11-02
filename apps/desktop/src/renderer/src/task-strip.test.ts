import { describe, expect, it } from 'vitest'
import type { AgentId } from '@chorus/shared'
import { reduceTask, type TaskMark, type TaskSnapshot } from '../../shared/task-progress.js'
import {
  elapsedParts,
  liveStrip,
  taskStrip,
  tickingLive,
  tickingStrip,
  workDurationParts,
  type DurationPart,
  type LiveSource,
  type StripModel,
} from './task-strip.js'
import type { LiveHandoff, LiveOperation, PendingReply } from './transcript.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = 1_700_000_000_000
const time = (minutes: number): number => T0 + minutes * MINUTE

const text = (parts: readonly DurationPart[]): string =>
  parts.map((part) => `${String(part.value)}${part.unit}`).join(' ')

let seq = 0
const at = (minutes: number) => ({ at: time(minutes), seq: ++seq })

type Step = Extract<TaskMark, { kind: 'revised' }>['steps'][number]
const step = (
  id: string,
  status: Step['status'],
  estimateMinutes?: number,
  extra: Partial<Step> = {}
): Step => ({
  id,
  title: `Title ${id}`,
  status,
  ...(estimateMinutes === undefined ? {} : { estimateMinutes }),
  ...extra,
})

const opened = (): TaskMark => ({
  kind: 'opened',
  ...at(0),
  taskId: 't',
  originEventId: 'u',
  startedAt: time(0),
})
const started = (minutes: number, agentId: AgentId = 'claude'): TaskMark => ({
  kind: 'turnStarted',
  ...at(minutes),
  agentId,
})
const completed = (minutes: number, agentId: AgentId = 'claude'): TaskMark => ({
  kind: 'turnCompleted',
  ...at(minutes),
  agentId,
  status: 'completed',
  userInitiated: false,
})
const revised = (
  minutes: number,
  steps: Step[],
  extra: Partial<Extract<TaskMark, { kind: 'revised' }>> = {}
): TaskMark => ({
  kind: 'revised',
  ...at(minutes),
  taskId: 't',
  agentId: 'claude',
  revision: 1,
  source: 'chorus',
  steps,
  ...extra,
})

const snapshotOf = (marks: TaskMark[], nowMinutes: number): TaskSnapshot => {
  const snapshot = reduceTask({ marks, history: [] }, time(nowMinutes))
  if (snapshot === null) throw new Error('expected a task')
  return snapshot
}

const strip = (
  snapshot: TaskSnapshot | null,
  options: Partial<{
    syncing: boolean
    working: string[]
    workingSince: Record<string, number>
    now: number
  }> = {}
): StripModel | null =>
  taskStrip({
    snapshot,
    syncing: options.syncing ?? false,
    working: options.working ?? [],
    workingSince: options.workingSince ?? {},
    now: options.now ?? time(30),
  })

const taskModel = (model: StripModel | null) => {
  if (model?.kind !== 'task') throw new Error('expected a task model')
  return model
}

describe('forecast durations', () => {
  it('uses days, hours and minutes, never seconds, and coarser steps as it grows', () => {
    expect(text(workDurationParts(0))).toBe('1m')
    expect(text(workDurationParts(25 * MINUTE + 10_000))).toBe('26m')
    expect(text(workDurationParts(59 * MINUTE + 30_000))).toBe('1h')
    expect(text(workDurationParts(HOUR + 7 * MINUTE))).toBe('1h')
    expect(text(workDurationParts(HOUR + 23 * MINUTE))).toBe('1h 30m')
    expect(text(workDurationParts(DAY + 15 * HOUR + 31 * MINUTE))).toBe('1d 15h 30m')
    expect(text(workDurationParts(2 * DAY + 10 * MINUTE))).toBe('2d')
    for (const ms of [5_000, 42 * MINUTE, 5 * HOUR + 17 * MINUTE, 3 * DAY]) {
      expect(workDurationParts(ms).some((part) => part.unit === 's')).toBe(false)
    }
  })
})

describe('elapsed time', () => {
  it('ticks in seconds until it is a day long', () => {
    expect(text(elapsedParts(0))).toBe('0s')
    expect(text(elapsedParts(45_000))).toBe('45s')
    expect(text(elapsedParts(8 * MINUTE + 24_000))).toBe('8m 24s')
    expect(text(elapsedParts(HOUR + 2 * MINUTE + 5_000))).toBe('1h 2m 5s')
    expect(text(elapsedParts(DAY + 3 * HOUR + 4 * MINUTE + 5_000))).toBe('1d 3h 4m')
  })
})

describe('before a task exists', () => {
  it('shows the work running now, timed from its real start', () => {
    const model = strip(null, { working: ['claude'], workingSince: { claude: time(20) } })
    expect(model).toEqual({ kind: 'activity', agents: ['claude'], elapsedMs: 10 * MINUTE })
    expect(tickingStrip(model)).toBe(true)
  })

  it('shows no clock rather than invent a start it was not given', () => {
    const model = strip(null, { working: ['claude'] })
    expect(model).toEqual({ kind: 'activity', agents: ['claude'], elapsedMs: null })
    expect(tickingStrip(model)).toBe(false)
  })

  it('shows nothing when nothing is running', () => {
    expect(strip(null)).toBeNull()
  })

  it('shows the running work while the task is being fetched', () => {
    const snapshot = snapshotOf([opened(), revised(0, [step('a', 'active', 10)])], 5)
    expect(strip(snapshot, { syncing: true, working: ['claude'] })?.kind).toBe('activity')
  })

  it('does not show the last task as complete once a new request is running', () => {
    const closed = [
      opened(),
      started(0),
      revised(0, [step('a', 'done', 5)], { complete: true }),
      completed(2),
      { kind: 'closed', ...at(3), taskId: 't', reason: 'completed' } as TaskMark,
    ]
    const finished = taskModel(strip(snapshotOf(closed, 4)))
    expect(finished.state).toBe('complete')
    expect(finished.closed).toBe(true)
    expect(finished.lanes).toEqual([])
    expect(tickingStrip(finished)).toBe(false)
    const newerTurn = { working: ['claude'], workingSince: { claude: time(5) } }
    expect(strip(snapshotOf(closed, 4), newerTurn)?.kind).toBe('activity')
    const sameTurn = { working: ['claude'], workingSince: { claude: time(1) } }
    expect(strip(snapshotOf(closed, 4), sameTurn)?.kind).toBe('task')
    const asked = snapshotOf([...closed, { kind: 'user', ...at(5), eventId: 'u2', work: true }], 6)
    expect(strip(asked)).toBeNull()
  })
})

describe('the forecast', () => {
  it('counts down while work runs, and is held, rough and partial when it should be', () => {
    const marks = [
      opened(),
      started(0),
      revised(0, [step('a', 'active', 30), step('b', 'pending')]),
    ]
    const running = taskModel(strip(snapshotOf(marks, 10)))
    expect(running.forecast).toMatchObject({
      kind: 'remaining',
      pointMs: 20 * MINUTE,
      rough: true,
      partial: true,
      frozen: false,
    })
    const held = taskModel(strip(snapshotOf([...marks, completed(10)], 25)))
    expect(held.forecast).toMatchObject({ kind: 'remaining', pointMs: 20 * MINUTE, frozen: true })
  })

  it('says how far over the estimate it is instead of showing zero', () => {
    const model = taskModel(
      strip(snapshotOf([opened(), started(0), revised(0, [step('a', 'active', 10)])], 25))
    )
    expect(model.forecast).toEqual({ kind: 'over', overMs: 15 * MINUTE, partial: false })
  })

  it('says it is finishing up when every step is done but the turn goes on', () => {
    const marks = [opened(), started(0), revised(0, [step('a', 'done', 10)])]
    expect(taskModel(strip(snapshotOf(marks, 12))).forecast).toEqual({ kind: 'finishing' })
    expect(taskModel(strip(snapshotOf([...marks, completed(12)], 13))).forecast).toEqual({
      kind: 'stepsDone',
    })
  })

  it('marks a forecast that filled steps from the agent’s pace', () => {
    const marks = [opened(), started(0), revised(0, [step('a', 'done'), step('b', 'active')])]
    expect(taskModel(strip(snapshotOf(marks, 10))).forecast).toMatchObject({
      kind: 'remaining',
      pointMs: 10 * MINUTE,
      paced: true,
      rough: true,
      partial: false,
    })
  })

  it('has no estimate for a checklist without one', () => {
    const model = taskModel(
      strip(
        snapshotOf(
          [opened(), started(0), revised(0, [step('1', 'active')], { source: 'native' })],
          3
        )
      )
    )
    expect(model.forecast).toEqual({ kind: 'none' })
    expect(model.progress).toEqual({ done: 0, total: 1 })
  })
})

describe('steps', () => {
  it('names the agent, the main step position and the full nested label', () => {
    const model = taskModel(
      strip(
        snapshotOf(
          [
            opened(),
            started(0),
            revised(0, [
              step('s1', 'done', undefined, { label: '1' }),
              step('s2', 'done', undefined, { label: '2' }),
              step('s3', 'done', undefined, { label: '3' }),
              step('s4', 'active', undefined, { label: '4' }),
              step('s41', 'done', undefined, { parentId: 's4', label: '4.1' }),
              step('s42', 'active', undefined, { parentId: 's4', label: '4.2' }),
              step('s43', 'pending', undefined, { parentId: 's4', label: '4.3' }),
              step('s5', 'pending', undefined, { label: '5' }),
              step('s6', 'pending', undefined, { label: '6' }),
              step('s7', 'pending', undefined, { label: '7' }),
            ]),
          ],
          1
        )
      )
    )
    expect(model.lanes).toEqual([
      {
        agentId: 'claude',
        mainIndex: 4,
        mainTotal: 7,
        label: '4.2',
        title: 'Title s42',
        substeps: { done: 1, total: 3 },
      },
    ])
    expect(model.progress).toEqual({ done: 3, total: 7 })
  })

  it('shows no bar when there is no checklist', () => {
    const snapshot = snapshotOf([opened(), started(0)], 1)
    expect(taskModel(strip(snapshot)).progress).toBeNull()
  })
})

describe('what the strip says about the state', () => {
  it('says what kind of answer the task is waiting for', () => {
    const model = taskModel(
      strip(
        snapshotOf(
          [
            opened(),
            started(0),
            revised(0, [step('a', 'active', 30)]),
            { kind: 'waitStarted', ...at(2), agentId: 'claude', waitId: 'w', wait: 'question' },
          ],
          4
        )
      )
    )
    expect(model.state).toBe('waiting')
    expect(model.waiting).toBe('question')
    expect(model.waitingMs).toBe(2 * MINUTE)
  })

  it('shows a limit reset only when the provider supplied one', () => {
    const paused = (resetsAt: number | null) =>
      taskModel(
        strip(
          snapshotOf(
            [
              opened(),
              started(0),
              revised(0, [step('a', 'active', 30)]),
              { kind: 'paused', ...at(2), agentId: 'claude', resetsAt },
            ],
            4
          )
        )
      )
    expect(paused(time(90)).state).toBe('paused')
    expect(paused(time(90)).resetsAt).toBe(time(90))
    expect(paused(null).resetsAt).toBeNull()
  })

  it('keeps the reason for a material revision, and ignores a trivial one', () => {
    const marks = [
      opened(),
      started(0),
      revised(0, [step('a', 'active', 10)]),
      revised(1, [step('a', 'active', 10), step('b', 'pending', 20)], {
        reason: 'Found the parser too',
      }),
    ]
    expect(taskModel(strip(snapshotOf(marks, 2))).change).toEqual({
      deltaMs: 20 * MINUTE,
      added: 1,
      removed: 0,
      split: 0,
      reason: 'Found the parser too',
    })
    const trivial = [
      opened(),
      started(0),
      revised(0, [step('a', 'active', 10)]),
      revised(1, [step('a', 'active', 10)]),
    ]
    expect(taskModel(strip(snapshotOf(trivial, 2))).change).toBeNull()
  })
})

describe('a forecast that has run out before the work has', () => {
  const partial = [opened(), started(0), revised(0, [step('a', 'done', 10), step('b', 'active')])]

  it('has no estimate for the remaining steps until a pace exists, while working and while idle', () => {
    const working = taskModel(strip(snapshotOf(partial, 0)))
    expect(working.forecast).toEqual({ kind: 'unestimated' })
    expect(working.progress).toEqual({ done: 1, total: 2 })
    const idle = taskModel(strip(snapshotOf([...partial, completed(0)], 2)))
    expect(idle.forecast).toEqual({ kind: 'unestimated' })
  })

  it('fills the remaining steps from pace once the agent has worked', () => {
    expect(taskModel(strip(snapshotOf(partial, 12))).forecast).toMatchObject({
      kind: 'remaining',
      pointMs: 12 * MINUTE,
      paced: true,
      rough: true,
      partial: false,
    })
  })

  it('reports an overrun of estimated work beside unestimated steps as a partial overrun', () => {
    const model = taskModel(
      strip(
        snapshotOf(
          [opened(), started(0), revised(0, [step('a', 'active', 10), step('b', 'pending')])],
          25
        )
      )
    )
    expect(model.forecast).toEqual({ kind: 'over', overMs: 15 * MINUTE, partial: true })
  })

  it('never says every step is done while one is still open', () => {
    for (const now of [10, 12, 40]) {
      const forecast = taskModel(strip(snapshotOf(partial, now))).forecast
      expect(forecast.kind === 'finishing' || forecast.kind === 'stepsDone', String(now)).toBe(
        false
      )
    }
  })

  it('reads an estimate used up exactly as reached, not as done', () => {
    const model = taskModel(
      strip(snapshotOf([opened(), started(0), revised(0, [step('a', 'active', 10)])], 10))
    )
    expect(model.forecast).toEqual({ kind: 'over', overMs: 0, partial: false })
  })
})

describe('a stale working flag', () => {
  const closed = [
    opened(),
    started(0),
    revised(0, [step('a', 'done', 5)], { complete: true }),
    completed(2),
    { kind: 'closed', ...at(3), taskId: 't', reason: 'completed' } as TaskMark,
  ]

  it('cannot displace a completed task with a turn that started before it closed', () => {
    const model = strip(snapshotOf(closed, 4), {
      working: ['claude'],
      workingSince: { claude: time(1) },
    })
    expect(model?.kind).toBe('task')
  })

  it('gives way to a turn that genuinely started after the close', () => {
    const model = strip(snapshotOf(closed, 6), {
      working: ['claude'],
      workingSince: { claude: time(5) },
      now: time(6),
    })
    expect(model).toEqual({ kind: 'activity', agents: ['claude'], elapsedMs: MINUTE })
  })

  it('shows nothing once the session behind the work has ended', () => {
    expect(strip(null, { working: [], workingSince: {} })).toBeNull()
  })
})

describe('live rows', () => {
  const CHAT = 'discussion:s1:codex:0'
  const OTHER = 'discussion:s2:codex:0'
  const NOTHING: LiveSource = {
    working: [],
    workingSince: {},
    turns: {},
    replies: [],
    operations: [],
    evidenceAt: {},
    handoffs: [],
    approvals: [],
    questions: [],
    activity: {},
  }
  const source = (extra: Partial<LiveSource>): LiveSource => ({ ...NOTHING, ...extra })
  const reply = (
    requestId: string,
    phase: PendingReply['phase'] = 'thinking',
    agentId: AgentId = 'codex'
  ): PendingReply => ({
    requestId,
    sourceId: requestId,
    agentId,
    phase,
    startedAt: time(1),
    phaseSince: time(2),
    from: null,
  })
  const operation = (
    itemRef: string,
    minutes: number,
    extra: Partial<LiveOperation> = {}
  ): LiveOperation => ({
    agentId: 'claude',
    requestId: null,
    generation: 1,
    itemRef,
    kind: 'tool',
    name: 'Read',
    detail: null,
    startedAt: time(minutes),
    ...extra,
  })
  const working = (agentId: AgentId = 'claude'): Partial<LiveSource> => ({
    working: [agentId],
    workingSince: { [agentId]: time(0) },
    turns: { [agentId]: { generation: 1, startedAt: time(0) } },
  })

  it('gives one agent with no plan a row saying what it is doing', () => {
    const live = liveStrip(
      source({
        ...working(),
        operations: [operation('r1', 5, { detail: 'src/a.ts' })],
        evidenceAt: { 'work:claude': time(9) },
      }),
      time(10)
    )
    expect(live.rows).toEqual([
      {
        key: 'work:claude',
        agentId: 'claude',
        mode: 'work',
        phase: 'working',
        blocked: null,
        operation: { kind: 'tool', name: 'Read', detail: 'src/a.ts', forMs: 5 * MINUTE },
        moreOperations: 0,
        from: null,
        elapsedMs: 10 * MINUTE,
        updatedMs: MINUTE,
      },
    ])
    expect(live.mixed).toBe(false)
    expect(tickingLive(live)).toBe(true)
  })

  it('falls back to the provider word, then to a plain phase, never to silence', () => {
    const word = liveStrip(source({ ...working(), activity: { claude: 'compacting' } }), time(3))
    expect(word.rows[0]?.phase).toBe('compacting')
    const plain = liveStrip(source({ ...working(), activity: { claude: null } }), time(3))
    expect(plain.rows[0]).toMatchObject({ phase: 'working', operation: null, updatedMs: null })
  })

  it('keeps Work and Chat for one agent apart, each with its own wait', () => {
    const live = liveStrip(
      source({
        ...working('codex'),
        replies: [reply(CHAT, 'waiting')],
        approvals: [{ agentId: 'codex' }],
        questions: [{ agentId: 'codex', mode: 'chat', requestId: CHAT }],
      }),
      time(4)
    )
    expect(live.mixed).toBe(true)
    expect(live.rows.map((row) => [row.key, row.mode, row.phase, row.blocked])).toEqual([
      ['work:codex', 'work', 'working', 'approval'],
      [CHAT, 'chat', 'queued', 'question'],
    ])
    expect(live.rows[1]?.elapsedMs).toBe(3 * MINUTE)
  })

  it('blocks only the Chat request its wait names', () => {
    const named = liveStrip(
      source({
        replies: [reply(CHAT), reply(OTHER, 'waiting')],
        approvals: [{ agentId: 'codex', mode: 'chat', requestId: CHAT }],
      }),
      time(4)
    )
    expect(named.rows.map((row) => [row.key, row.blocked])).toEqual([
      [CHAT, 'approval'],
      [OTHER, null],
    ])
    const unnamed = { agentId: 'codex', mode: 'chat' as const }
    const ambiguous = liveStrip(
      source({ replies: [reply(CHAT), reply(OTHER)], approvals: [unnamed] }),
      time(4)
    )
    expect(ambiguous.rows.map((row) => row.blocked)).toEqual([null, null])
    const single = liveStrip(source({ replies: [reply(CHAT)], approvals: [unnamed] }), time(4))
    expect(single.rows[0]?.blocked).toBe('approval')
  })

  it('keeps a running operation beside a wait, and counts the others still running', () => {
    const live = liveStrip(
      source({
        ...working(),
        operations: [
          operation('r1', 1),
          operation('r2', 3, { name: 'Grep' }),
          operation('chat-op', 4, { agentId: 'codex', requestId: CHAT, generation: 0 }),
        ],
        approvals: [{ agentId: 'claude' }],
      }),
      time(5)
    )
    expect(live.rows).toHaveLength(1)
    expect(live.rows[0]).toMatchObject({
      blocked: 'approval',
      operation: { name: 'Grep', forMs: 2 * MINUTE },
      moreOperations: 1,
    })
  })

  it('shows handoff history without counting it as anyone being busy', () => {
    const handoff = (id: string, minutes: number, outcome: LiveHandoff['outcome']) => ({
      handoffId: id,
      from: 'claude' as const,
      to: 'codex' as const,
      sourceEventIds: [],
      createdAt: time(minutes),
      outcome,
      outcomeAt: outcome === null ? null : time(minutes + 1),
    })
    const live = liveStrip(
      source({
        handoffs: [
          handoff('h1', 1, 'submitted'),
          handoff('h4', 7, null),
          handoff('h2', 3, 'failed'),
          handoff('h3', 5, 'cancelled'),
        ],
      }),
      time(10)
    )
    expect(live.rows).toEqual([])
    expect(live.handoffs.map((line) => [line.handoffId, line.outcome, line.ageMs])).toEqual([
      ['h2', 'failed', 6 * MINUTE],
      ['h3', 'cancelled', 4 * MINUTE],
      ['h4', 'pending', 3 * MINUTE],
    ])
    expect(tickingLive(liveStrip(NOTHING, time(10)))).toBe(false)
  })

  it('bounds a long operation to one line', () => {
    const live = liveStrip(
      source({
        ...working(),
        operations: [
          operation('c1', 1, { kind: 'command', name: 'echo a\necho b', detail: 'x'.repeat(400) }),
        ],
      }),
      time(2)
    )
    expect(live.rows[0]?.operation?.name).toBe('echo a')
    expect(live.rows[0]?.operation?.detail).toHaveLength(160)
    expect(live.rows[0]?.operation?.detail?.endsWith('…')).toBe(true)
  })

  it('says the Work task is complete while a Chat request is still running', () => {
    const closed = [
      opened(),
      started(0),
      revised(0, [step('a', 'done', 5)], { complete: true }),
      completed(2),
      { kind: 'closed', ...at(3), taskId: 't', reason: 'completed' } as TaskMark,
    ]
    const model = taskModel(strip(snapshotOf(closed, 4)))
    expect(model.state).toBe('complete')
    const live = liveStrip(source({ replies: [reply(CHAT)] }), time(4))
    expect(live.rows.map((row) => [row.mode, row.phase])).toEqual([['chat', 'thinking']])
  })

  it('says tracking ended while the agent it tracked keeps working', () => {
    const abandoned = [
      opened(),
      started(0),
      revised(0, [step('a', 'active', 5)]),
      { kind: 'closed', ...at(3), taskId: 't', reason: 'abandoned' } as TaskMark,
    ]
    const model = taskModel(
      strip(snapshotOf(abandoned, 4), {
        working: ['claude'],
        workingSince: { claude: time(0) },
        now: time(4),
      })
    )
    expect(model.state).toBe('closed')
    const live = liveStrip(source(working()), time(4))
    expect(live.rows.map((row) => [row.mode, row.phase, row.elapsedMs])).toEqual([
      ['work', 'working', 4 * MINUTE],
    ])
  })
})
