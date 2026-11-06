import { testHostPorts } from './test-host-ports.js'
import type { AgentAdapter } from '@chorus/agent-protocol'
import { FakeAdapter, type FakeAgentSession } from '@chorus/orchestrator'
import { AGENT_IDS, Logger, newApprovalId, newUserInputId, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isDiscussion, isLiveReply } from '../shared/live-message.js'
import { ChorusRuntime, NAMER_INSTRUCTIONS } from './runtime.js'

let runtime: ChorusRuntime
let conversationId: string
let adapters: Map<AgentId, FakeAdapter>

beforeEach(async () => {
  adapters = new Map(AGENT_IDS.map((id) => [id, new FakeAdapter({ id })]))
  runtime = ChorusRuntime.open(
    testHostPorts(mkdtempSync(join(tmpdir(), 'chorus-live-chat-'))),
    new Logger(),
    new Map<AgentId, AgentAdapter>(adapters)
  )
  const started = await runtime.startConversationIn({ agents: [...AGENT_IDS], cwd: process.cwd() })
  conversationId = started.conversationId
})

afterEach(async () => {
  await runtime.close()
})

async function working(
  agent: AgentId
): Promise<{ adapter: FakeAdapter; parent: FakeAgentSession }> {
  const adapter = adapters.get(agent)
  if (adapter === undefined) throw new Error('Missing adapter')
  await runtime.send(conversationId, `@${agent} Build the feature.`)
  const parent = adapter.sessions.find(
    (session) => session.startedWith?.instructions !== NAMER_INSTRUCTIONS
  )
  if (parent === undefined) throw new Error('Missing primary session')
  parent.emit({ type: 'turn.started', turnRef: `primary-${agent}` })
  await vi.waitFor(() => {
    expect(
      runtime.store
        .read(conversationId)
        .some((event) => event.actor === agent && event.payload.type === 'turn.started')
    ).toBe(true)
  })
  return { adapter, parent }
}

const isDiscussionSession = (session: FakeAgentSession): boolean =>
  session.startedWith?.instructions?.startsWith('You are in Discussion mode.') === true

const discussions = (agent: AgentId): FakeAgentSession[] =>
  adapters.get(agent)?.sessions.filter(isDiscussionSession) ?? []

async function forwardConversation(source: string): Promise<string> {
  const projectId = runtime
    .activeSessions()
    .find((room) => room.conversationId === source)?.projectId
  if (projectId === undefined) throw new Error('Missing source project')
  const next = await runtime.startConversation({ projectId, continueFrom: source })
  return next.conversationId
}

function primarySession(room: string, agent: AgentId): FakeAgentSession {
  const started = runtime.store
    .read(room)
    .findLast(
      (event) => event.payload.type === 'session.started' && event.payload.agentId === agent
    )
  const ref = started?.payload.type === 'session.started' ? started.payload.sessionRef : undefined
  const session = adapters
    .get(agent)
    ?.sessions.findLast((candidate) => candidate.sessionRef === ref && !candidate.closed)
  if (session === undefined) throw new Error('Missing primary session')
  return session
}

async function discussionReply(session: FakeAgentSession, text: string, turn = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(session.sent).toHaveLength(turn)
  })
  session.emit({ type: 'message.completed', itemRef: `reply-${String(turn)}`, text })
  session.emit({
    type: 'turn.completed',
    turnRef: `discussion-${String(turn)}`,
    status: 'completed',
  })
  await vi.waitFor(() => {
    expect(
      runtime.store
        .read(conversationId)
        .some(
          (event) => event.payload.type === 'agent.message.completed' && event.payload.text === text
        )
    ).toBe(true)
  })
  expect(session.closed).toBe(false)
}

function expectExcerpt(input: string | undefined, record: string): void {
  const prompt = input ?? ''
  expect(prompt).toContain(record.split('\n')[0])
  expect(prompt).toContain(record.split('\n').at(-1))
  expect(prompt).not.toContain(record)
  expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(25_000)
}

describe('forwarded conversation context', () => {
  it('states when the receiving native session cannot retrieve omitted records', async () => {
    await runtime.send(conversationId, '@codex Preserve the authentication headers.')
    conversationId = await forwardConversation(conversationId)
    const worker = primarySession(conversationId, 'codex')
    worker.transcriptTool = 'unavailable'
    await runtime.send(conversationId, '@codex Continue the API task.', undefined, 'work')
    expect(worker.sent[0]?.text).toContain('Records not shown here cannot be read in this session')
    expect(worker.sent[0]?.text).not.toContain('read_transcript')
  })

  it('budgets the calling reply and parent handover together during a Work handoff', async () => {
    for (let index = 0; index < 12; index += 1) {
      runtime.store.append({
        conversationId,
        actor: 'user',
        payload: {
          type: 'user.message',
          text: `API requirement ${String(index)}: ${'preserve headers '.repeat(100)}`,
        },
      })
    }
    conversationId = await forwardConversation(conversationId)
    await runtime.send(conversationId, '@claude Investigate the API task.', undefined, 'work')
    const lead = primarySession(conversationId, 'claude')
    const reply = `CALLING_REPLY_BEGIN\n${'API retry findings.\n'.repeat(2500)}CALLING_REPLY_END\n\n@codex Continue the API retry fix.`
    lead.emit({ type: 'message.completed', itemRef: 'large-handoff-reply', text: reply })
    lead.emit({ type: 'turn.completed', turnRef: 'large-handoff-turn', status: 'completed' })
    const target = primarySession(conversationId, 'codex')
    await vi.waitFor(() => {
      expect(target.sent).toHaveLength(1)
    })
    const prompt = target.sent[0]?.text ?? ''
    expect(prompt).toContain('CALLING_REPLY_BEGIN')
    expect(prompt).toContain('CALLING_REPLY_END')
    expect(prompt).toContain('Continue the API retry fix.')
    expect(prompt.split('Continue the API retry fix.')).toHaveLength(2)
    expect(prompt.indexOf('API requirement')).toBeLessThan(
      prompt.indexOf("claude's reply before calling you:")
    )
    expect(prompt).not.toContain(reply)
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(
      24_000 + Buffer.byteLength('Continue the API retry fix.', 'utf8')
    )
  })

  it('sends the pinned parent handover once when Work sends overlap', async () => {
    await runtime.send(conversationId, '@codex ROOT_PARENT_ONLY: preserve authentication headers.')
    conversationId = await forwardConversation(conversationId)
    const worker = primarySession(conversationId, 'codex')
    const send = worker.send.bind(worker)
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = true
    vi.spyOn(worker, 'send').mockImplementation(async (input) => {
      await send(input)
      if (held) {
        held = false
        await gate
      }
    })
    const first = runtime.send(conversationId, '@codex First Work request.', undefined, 'work')
    try {
      await vi.waitFor(() => {
        expect(worker.sent).toHaveLength(1)
      })
      await runtime.send(conversationId, '@codex Second Work request.', undefined, 'work')
      expect(worker.sent).toHaveLength(2)
      expect(worker.sent[0]?.text).toContain('ROOT_PARENT_ONLY')
      expect(worker.sent[1]?.text).not.toContain('ROOT_PARENT_ONLY')
      expect(worker.sent[1]?.text).not.toContain('First Work request.')
      expect(worker.sent[1]?.text).toContain('Second Work request.')
    } finally {
      release()
      await first
    }
  })

  it.each(['work', 'discussion'] as const)(
    'keeps a large parent bounded and retrieves a buried decision in %s',
    async (mode) => {
      const source = conversationId
      const decision = runtime.store.append({
        conversationId: source,
        actor: 'user',
        payload: { type: 'user.message', text: 'API retry constraint: preserve idempotency keys.' },
      })
      for (let index = 0; index < 600; index += 1) {
        runtime.store.append({
          conversationId: source,
          actor: index % 2 === 0 ? 'user' : 'claude',
          payload:
            index % 2 === 0
              ? {
                  type: 'user.message',
                  text: `Unrelated layout ${String(index)} ${'spacing '.repeat(300)}`,
                }
              : {
                  type: 'agent.message.completed',
                  itemRef: `layout-${String(index)}`,
                  text: `Layout review ${String(index)} ${'spacing '.repeat(300)}`,
                },
        })
      }
      const projectId = runtime
        .activeSessions()
        .find((room) => room.conversationId === source)?.projectId
      if (projectId === undefined) throw new Error('Missing source project')
      const child = await runtime.startConversation({
        projectId,
        continueFrom: source,
        objective: 'Fix API retry behavior',
      })
      conversationId = child.conversationId
      await runtime.send(conversationId, '@codex Continue this task.', undefined, mode)
      await vi.waitFor(() => {
        const session =
          mode === 'work' ? primarySession(conversationId, 'codex') : discussions('codex')[0]
        expect(session?.sent).toHaveLength(1)
      })
      const session =
        mode === 'work' ? primarySession(conversationId, 'codex') : discussions('codex')[0]
      if (session === undefined) throw new Error('Missing child session')
      const prompt = session.sent[0]?.text ?? ''
      expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(25_000)
      expect(prompt).toContain('preserve idempotency keys')
      expect(prompt).toContain(decision?.id)
      const lookup = session.startedWith?.transcript?.({ skip: 0, count: 5, query: 'idempotency' })
      expect(lookup).toContain(decision?.id)
      expect(lookup).toContain(source)
      if (mode === 'discussion')
        await discussionReply(session, 'The task preserves idempotency keys.')
    }
  )

  it.each([
    ['work', 'discussion'],
    ['discussion', 'work'],
  ] as const)(
    'keeps context from original %s to forwarded %s and independent later switches',
    async (sourceMode, targetMode) => {
      const source = conversationId
      const sourceAgreement = `ORIGINAL_BEGIN\n${'Original requirement.\n'.repeat(2500)}ORIGINAL_END`
      await runtime.send(source, '@codex Keep the original requirements.', undefined, sourceMode)
      await vi.waitFor(() => {
        expect(
          sourceMode === 'discussion'
            ? discussions('codex')[0]?.sent
            : primarySession(source, 'codex').sent
        ).toHaveLength(1)
      })
      const original =
        sourceMode === 'discussion' ? discussions('codex')[0] : primarySession(source, 'codex')
      if (original === undefined) throw new Error('Missing original agent')
      await discussionReply(original, sourceAgreement)

      conversationId = await forwardConversation(source)
      const forwarded = conversationId
      await runtime.send(
        forwarded,
        '@deepseek Continue the original requirements.',
        undefined,
        targetMode
      )
      await vi.waitFor(() => {
        expect(
          targetMode === 'discussion'
            ? discussions('deepseek')[0]?.sent
            : primarySession(forwarded, 'deepseek').sent
        ).toHaveLength(1)
      })
      const target =
        targetMode === 'discussion'
          ? discussions('deepseek')[0]
          : primarySession(forwarded, 'deepseek')
      if (target === undefined) throw new Error('Missing forwarded agent')
      expectExcerpt(target.sent[0]?.text, sourceAgreement)
      await discussionReply(target, 'Forwarded decision: preserve the search filters.')

      conversationId = source
      await runtime.send(source, '@codex Explain the original requirements.', undefined, targetMode)
      await vi.waitFor(() => {
        expect(
          targetMode === 'discussion'
            ? discussions('codex')[0]?.sent
            : primarySession(source, 'codex').sent
        ).toHaveLength(1)
      })
      const switchedOriginal =
        targetMode === 'discussion' ? discussions('codex')[0] : primarySession(source, 'codex')
      if (switchedOriginal === undefined) throw new Error('Missing switched original agent')
      expectExcerpt(switchedOriginal.sent[0]?.text, sourceAgreement)
      expect(switchedOriginal.sent[0]?.text).not.toContain('Forwarded decision:')
      await discussionReply(switchedOriginal, 'The original requirements remain available.')

      conversationId = forwarded
      await runtime.send(
        forwarded,
        '@deepseek Continue our forwarded decision.',
        undefined,
        sourceMode
      )
      await vi.waitFor(() => {
        expect(
          sourceMode === 'discussion'
            ? discussions('deepseek')[0]?.sent
            : primarySession(forwarded, 'deepseek').sent
        ).toHaveLength(1)
      })
      const switchedTarget =
        sourceMode === 'discussion'
          ? discussions('deepseek')[0]
          : primarySession(forwarded, 'deepseek')
      if (switchedTarget === undefined) throw new Error('Missing switched forwarded agent')
      expectExcerpt(switchedTarget.sent[0]?.text, sourceAgreement)
      expect(switchedTarget.sent[0]?.text).toContain(
        'Forwarded decision: preserve the search filters.'
      )
      await discussionReply(switchedTarget, 'Both histories are available in the forwarded room.')
    }
  )

  it('gives each Chat agent bounded excerpts once and access to original history', async () => {
    await runtime.send(conversationId, '@codex Remember our Home comparison.')
    for (let i = 0; i < 120; i += 1) {
      runtime.store.append({
        conversationId,
        actor: 'user',
        payload: {
          type: 'user.message',
          text: `Earlier requirement ${String(i)}`,
          mode: 'discussion',
        },
      })
    }
    const fullAnswer = `FULL_HISTORY_BEGIN\n${'Home comparison detail.\n'.repeat(2500)}FULL_HISTORY_END`
    runtime.store.append({
      conversationId,
      actor: 'codex',
      payload: {
        type: 'agent.message.completed',
        itemRef: 'source-home-answer',
        text: fullAnswer,
        mode: 'discussion',
      },
    })
    conversationId = await forwardConversation(conversationId)
    const routed = await runtime.send(
      conversationId,
      'Continue the Home comparison.',
      undefined,
      'discussion'
    )
    expect(routed.targets).toEqual(['codex'])
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing forwarded discussion')
    expectExcerpt(reader.sent[0]?.text, fullAnswer)
    expect(
      reader.startedWith?.transcript?.({ skip: 0, count: 5, query: 'Earlier requirement 0' })
    ).toContain('Earlier requirement 0')
    expect(reader.sent[0]?.text).toContain('Earlier requirement 119')
    await discussionReply(reader, 'The Home comparison is our current task.')

    await runtime.send(conversationId, 'Explain the next step.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(reader.sent).toHaveLength(2)
    })
    expect(reader.sent[1]?.text).not.toContain('FULL_HISTORY_BEGIN')
    await discussionReply(reader, 'Compare the search behavior next.', 2)

    await runtime.send(conversationId, '@claude Review the context.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('claude')[0]?.sent).toHaveLength(1)
    })
    const partner = discussions('claude')[0]
    if (partner === undefined) throw new Error('Missing forwarded collaborator')
    expectExcerpt(partner.sent[0]?.text, fullAnswer)
    expect(partner.sent[0]?.text).toContain('Compare the search behavior next.')
    await discussionReply(partner, 'The comparison context is complete.')

    await runtime.setAnswerStyle(conversationId, !runtime.answerStyle(conversationId))
    await runtime.send(
      conversationId,
      '@codex Continue after the style change.',
      undefined,
      'discussion'
    )
    await vi.waitFor(() => {
      expect(discussions('codex')[1]?.sent).toHaveLength(1)
    })
    const reopened = discussions('codex')[1]
    if (reopened === undefined) throw new Error('Missing replacement discussion')
    expectExcerpt(reopened.sent[0]?.text, fullAnswer)
    expect(reopened.sent[0]?.text).toContain('The comparison context is complete.')
    await discussionReply(reopened, 'The full context is still available.')
  }, 15_000)

  it('keeps the full chain through a second Forward and a later switch from Chat to Work', async () => {
    await runtime.send(
      conversationId,
      '@codex Root decision: preserve the Flutter search behavior.'
    )
    conversationId = await forwardConversation(conversationId)
    await runtime.send(conversationId, '@codex Discuss the next step.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    const first = discussions('codex')[0]
    if (first === undefined) throw new Error('Missing first continuation')
    await discussionReply(first, 'Middle agreement: match the patient-name filter.')

    conversationId = await forwardConversation(conversationId)
    await runtime.send(
      conversationId,
      '@codex Continue the same comparison.',
      undefined,
      'discussion'
    )
    await vi.waitFor(() => {
      expect(discussions('codex')[1]?.sent).toHaveLength(1)
    })
    const second = discussions('codex')[1]
    if (second === undefined) throw new Error('Missing second continuation')
    expect(second.sent[0]?.text).toContain('Root decision: preserve the Flutter search behavior.')
    expect(second.sent[0]?.text).toContain('Middle agreement: match the patient-name filter.')
    await discussionReply(second, 'Newest agreement: implement the name filter next.')

    await runtime.send(conversationId, '@codex Implement the agreed change.', undefined, 'work')
    const joined = runtime.store
      .read(conversationId)
      .find(
        (event) => event.payload.type === 'session.started' && event.payload.agentId === 'codex'
      )
    const ref = joined?.payload.type === 'session.started' ? joined.payload.sessionRef : undefined
    const worker = adapters.get('codex')?.sessions.find((session) => session.sessionRef === ref)
    expect(worker?.sent[0]?.text).toContain('Root decision: preserve the Flutter search behavior.')
    expect(worker?.sent[0]?.text).toContain('Middle agreement: match the patient-name filter.')
    expect(worker?.sent[0]?.text).toContain('Newest agreement: implement the name filter next.')
    await runtime.send(conversationId, '@codex Continue implementing.', undefined, 'work')
    expect(worker?.sent[1]?.text).not.toContain(
      'Root decision: preserve the Flutter search behavior.'
    )
  })
})

describe('Discussion prompts', () => {
  it.each(['work', 'discussion'] as const)(
    'delivers at exhausted %s headroom and retries deferred history after compaction',
    async (mode) => {
      await runtime.send(conversationId, '@codex Begin the API task.', undefined, mode)
      await vi.waitFor(() => {
        expect(
          mode === 'work'
            ? primarySession(conversationId, 'codex').sent
            : discussions('codex')[0]?.sent
        ).toHaveLength(1)
      })
      const session =
        mode === 'work' ? primarySession(conversationId, 'codex') : discussions('codex')[0]
      if (session === undefined) throw new Error('Missing native session')
      if (mode === 'discussion') await discussionReply(session, 'The task is started.')
      const decision = runtime.store.append({
        conversationId,
        actor: 'claude',
        payload: {
          type: 'agent.message.completed',
          itemRef: 'deferred-decision',
          text: 'DEFERRED_DECISION: preserve idempotency keys.',
        },
      })
      if (decision === null) throw new Error('Missing decision')
      const read = (): string =>
        session.startedWith?.transcript?.({ skip: 0, count: 1, eventId: decision.id }) ?? ''
      session.emit({
        type: 'context.usage',
        usedTokens: 65_000,
        maxTokens: 66_000,
        percentUsed: 98,
        autoCompactThreshold: null,
        autoCompactPercent: null,
        autoCompactEnabled: true,
      })
      await vi.waitFor(() => {
        expect(read()).not.toContain('DEFERRED_DECISION')
      })
      await runtime.send(conversationId, '@codex Continue the current task.', undefined, mode)
      await vi.waitFor(() => {
        expect(session.sent).toHaveLength(2)
      })
      expect(session.sent[1]?.text).toContain('Additional recorded history is deferred')
      expect(session.sent[1]?.text).toContain('Continue the current task.')
      expect(session.sent[1]?.text).not.toContain('DEFERRED_DECISION')
      expect(Buffer.byteLength(session.sent[1]?.text ?? '', 'utf8')).toBeLessThan(2_000)
      if (mode === 'discussion')
        await discussionReply(session, 'I can continue from existing context.', 2)
      session.emit({
        type: 'context.usage',
        usedTokens: 1_000,
        maxTokens: 66_000,
        percentUsed: 2,
        autoCompactThreshold: null,
        autoCompactPercent: null,
        autoCompactEnabled: true,
      })
      await vi.waitFor(() => {
        expect(read()).toContain('DEFERRED_DECISION')
      })
      await runtime.send(conversationId, '@codex Apply the missing decision.', undefined, mode)
      await vi.waitFor(() => {
        expect(session.sent).toHaveLength(3)
      })
      expect(session.sent[2]?.text).toContain('DEFERRED_DECISION')
      expect(session.sent[2]?.text).not.toContain('Continue the current task.')
      if (mode === 'discussion') await discussionReply(session, 'The decision is available.', 3)
    }
  )

  it('keeps Work and Chat headroom independent for the same agent', async () => {
    await runtime.send(conversationId, '@codex Start the investigation.', undefined, 'work')
    const worker = primarySession(conversationId, 'codex')
    for (let index = 0; index < 80; index += 1) {
      runtime.store.append({
        conversationId,
        actor: 'user',
        payload: {
          type: 'user.message',
          text: `API evidence ${String(index)} ${'payload '.repeat(200)}`,
        },
      })
    }
    const readWork = (): string => worker.startedWith?.transcript?.({ skip: 0, count: 50 }) ?? ''
    worker.emit({
      type: 'context.usage',
      usedTokens: 50_000,
      maxTokens: 66_000,
      percentUsed: 76,
      autoCompactThreshold: null,
      autoCompactPercent: null,
      autoCompactEnabled: true,
    })
    await vi.waitFor(() => {
      expect(Buffer.byteLength(readWork(), 'utf8')).toBeLessThanOrEqual(5_760)
    })

    await runtime.send(conversationId, '@codex Discuss this evidence.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing Chat reader')
    expect(Buffer.byteLength(reader.sent[0]?.text ?? '', 'utf8')).toBeGreaterThan(6_000)
    await discussionReply(reader, 'The evidence is understood.')
    const readChat = (): string => reader.startedWith?.transcript?.({ skip: 0, count: 50 }) ?? ''
    reader.emit({
      type: 'context.usage',
      usedTokens: 65_000,
      maxTokens: 66_000,
      percentUsed: 98,
      autoCompactThreshold: null,
      autoCompactPercent: null,
      autoCompactEnabled: true,
    })
    await vi.waitFor(() => {
      expect(Buffer.byteLength(readChat(), 'utf8')).toBeLessThan(2_000)
    })
    expect(Buffer.byteLength(readWork(), 'utf8')).toBeGreaterThan(2_000)
    expect(Buffer.byteLength(readWork(), 'utf8')).toBeLessThanOrEqual(5_760)
    await runtime.send(conversationId, '@codex Apply the next step.', undefined, 'work')
    expect(Buffer.byteLength(worker.sent[1]?.text ?? '', 'utf8')).toBeGreaterThan(2_000)
    expect(Buffer.byteLength(worker.sent[1]?.text ?? '', 'utf8')).toBeLessThanOrEqual(6_000)
  })

  it.each(['work', 'discussion'] as const)(
    'uses the %s session headroom to bound the next context and history-tool reply',
    async (mode) => {
      await runtime.send(conversationId, '@codex Start the API investigation.', undefined, mode)
      await vi.waitFor(() => {
        const candidate =
          mode === 'work' ? primarySession(conversationId, 'codex') : discussions('codex')[0]
        expect(candidate?.sent).toHaveLength(1)
      })
      const session =
        mode === 'work' ? primarySession(conversationId, 'codex') : discussions('codex')[0]
      if (session === undefined) throw new Error('Missing session')
      if (mode === 'discussion') await discussionReply(session, 'API investigation started.')
      for (let index = 0; index < 80; index += 1) {
        runtime.store.append({
          conversationId,
          actor: 'user',
          payload: {
            type: 'user.message',
            text: `API evidence ${String(index)} ${'payload '.repeat(200)}`,
          },
        })
      }
      const read = (): string => session.startedWith?.transcript?.({ skip: 0, count: 50 }) ?? ''
      expect(Buffer.byteLength(read(), 'utf8')).toBeGreaterThan(6_000)
      session.emit({
        type: 'context.usage',
        usedTokens: 50_000,
        maxTokens: 66_000,
        percentUsed: 76,
        autoCompactThreshold: null,
        autoCompactPercent: null,
        autoCompactEnabled: true,
      })
      await vi.waitFor(() => {
        expect(Buffer.byteLength(read(), 'utf8')).toBeLessThanOrEqual(5_760)
      })
      await runtime.send(conversationId, '@codex Continue the investigation.', undefined, mode)
      await vi.waitFor(() => {
        expect(session.sent).toHaveLength(2)
      })
      expect(Buffer.byteLength(session.sent[1]?.text ?? '', 'utf8')).toBeLessThanOrEqual(6_000)
      if (mode === 'discussion') await discussionReply(session, 'The next step is ready.', 2)
    }
  )

  it('keeps bounded context and original-history retrieval through repeated mode switches', async () => {
    const { parent } = await working('codex')
    const firstWork = `WORK_BEGIN\n${'Work result detail.\n'.repeat(2500)}WORK_END`
    parent.emit({ type: 'message.completed', itemRef: 'work-result-1', text: firstWork })
    parent.emit({ type: 'turn.completed', turnRef: 'primary-codex', status: 'completed' })
    await vi.waitFor(() => {
      expect(
        runtime.store
          .read(conversationId)
          .some(
            (event) =>
              event.payload.type === 'turn.completed' && event.payload.turnRef === 'primary-codex'
          )
      ).toBe(true)
    })

    await runtime.send(conversationId, '@codex Discuss the result.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing Chat reader')
    expectExcerpt(reader.sent[0]?.text, firstWork)
    const plan = `CHAT_PLAN_BEGIN\n${'Agreed implementation detail.\n'.repeat(2500)}CHAT_PLAN_END`
    await discussionReply(reader, plan)

    await runtime.send(conversationId, '@codex Apply the agreed plan.', undefined, 'work')
    expectExcerpt(parent.sent[1]?.text, plan)
    const latestWork = `LATEST_WORK_BEGIN\n${'Updated implementation.\n'.repeat(2500)}LATEST_WORK_END`
    parent.emit({ type: 'message.completed', itemRef: 'work-result-2', text: latestWork })
    parent.emit({ type: 'turn.completed', turnRef: 'work-2', status: 'completed' })
    await vi.waitFor(() => {
      expect(
        runtime.store
          .read(conversationId)
          .some(
            (event) =>
              event.payload.type === 'agent.message.completed' && event.payload.text === latestWork
          )
      ).toBe(true)
    })

    await runtime.send(conversationId, '@codex Explain the latest result.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(reader.sent).toHaveLength(2)
    })
    expect(discussions('codex')).toHaveLength(1)
    expectExcerpt(reader.sent[1]?.text, latestWork)
    expect(reader.sent[1]?.text).not.toContain('CHAT_PLAN_BEGIN')
    expect(reader.sent[1]?.text).not.toContain(firstWork)
    await discussionReply(reader, 'The implementation follows the agreed plan.', 2)
  })

  it('keeps a team discussion out of the implementation routing path', async () => {
    const agent = AGENT_IDS[0]
    await runtime.send(conversationId, '/team Discuss the design.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions(agent)).toHaveLength(1)
    })
    const reader = discussions(agent)[0]
    if (reader === undefined) throw new Error('Missing team discussion session')
    await vi.waitFor(() => {
      expect(reader.sent).toHaveLength(1)
    })
    expect(reader.sent[0]?.text).toContain('other discussion agents')
    await discussionReply(reader, 'Here is the team discussion.')
    for (const adapter of adapters.values()) {
      for (const session of adapter.sessions) {
        if (!isDiscussionSession(session)) expect(session.sent).toHaveLength(0)
      }
    }
  })

  it.each(AGENT_IDS)(
    'keeps %s as the recipient when switching from Chat to Work',
    async (agent) => {
      const previousAgent = agent === 'claude' ? 'codex' : 'claude'
      const { parent } = await working(previousAgent)
      const original = [...parent.sent]
      await runtime.send(conversationId, `@${agent} Explain the approach.`, undefined, 'discussion')
      await vi.waitFor(() => {
        expect(discussions(agent)[0]?.sent).toHaveLength(1)
      })
      const reader = discussions(agent)[0]
      if (reader === undefined) throw new Error('Missing discussion session')
      await discussionReply(reader, 'The approach is ready to implement.')

      const continued = await runtime.send(
        conversationId,
        'Implement that approach.',
        undefined,
        'work'
      )
      expect(continued.targets).toEqual([agent])
      expect(parent.sent).toEqual(original)
      const worker = adapters
        .get(agent)
        ?.sessions.find(
          (session) =>
            !isDiscussionSession(session) &&
            session.startedWith?.instructions !== NAMER_INSTRUCTIONS
        )
      expect(worker?.sent.at(-1)?.text).toContain('Implement that approach.')

      const chosen = await runtime.send(
        conversationId,
        `@${previousAgent} Continue the task.`,
        undefined,
        'work'
      )
      expect(chosen.targets).toEqual([previousAgent])
      parent.emit({
        type: 'message.completed',
        itemRef: 'latest-work-answer',
        text: 'The task is updated.',
      })
      await vi.waitFor(() => {
        expect(
          runtime.store
            .read(conversationId)
            .some(
              (event) =>
                event.payload.type === 'agent.message.completed' &&
                event.payload.text === 'The task is updated.'
            )
        ).toBe(true)
      })

      const followUp = await runtime.send(
        conversationId,
        'Explain that update.',
        undefined,
        'discussion'
      )
      expect(followUp.targets).toEqual([previousAgent])
    }
  )

  it('continues with the last Chat answer despite a later pending question to another agent', async () => {
    await runtime.send(conversationId, '@codex Explain the approach.', undefined, 'discussion')
    await runtime.send(conversationId, '@claude Review the approach.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    await vi.waitFor(() => {
      expect(discussions('claude')[0]?.sent).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing discussion session')
    await discussionReply(reader, 'This is the most recent answer.')

    const continued = await runtime.send(
      conversationId,
      'Implement that approach.',
      undefined,
      'work'
    )
    expect(continued.targets).toEqual(['codex'])
    expect(discussions('claude')[0]?.sent).toHaveLength(1)
  })

  it('continues Work with the agent who answered the final Chat handoff', async () => {
    await runtime.send(conversationId, '@codex Discuss the approach.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    const lead = discussions('codex')[0]
    if (lead === undefined) throw new Error('Missing discussion lead')
    await discussionReply(lead, '@claude Review the approach.')
    await vi.waitFor(() => {
      expect(discussions('claude')[0]?.sent).toHaveLength(1)
    })
    const collaborator = discussions('claude')[0]
    if (collaborator === undefined) throw new Error('Missing discussion collaborator')
    await discussionReply(collaborator, 'The reviewed approach is ready.')

    const continued = await runtime.send(
      conversationId,
      'Implement the reviewed approach.',
      undefined,
      'work'
    )
    expect(continued.targets).toEqual(['claude'])
  })

  it.each(AGENT_IDS)('keeps the %s task running and preserves configured tools', async (agent) => {
    const { parent } = await working(agent)
    const original = [...parent.sent]
    await runtime.send(
      conversationId,
      `@${agent} Write docs/plans/feature.md.`,
      undefined,
      'discussion'
    )
    await vi.waitFor(() => {
      expect(discussions(agent)).toHaveLength(1)
    })
    const reader = discussions(agent)[0]
    if (reader === undefined) throw new Error('Missing discussion session')
    expect(reader.startedWith?.sandbox).toEqual(parent.startedWith?.sandbox)
    expect(reader.startedWith).not.toHaveProperty('toolPolicy')
    expect(reader.startedWith?.instructions).toContain('use configured MCP tools')
    expect(reader.startedWith?.instructions).toContain('Keep plans in chat.')
    expect(reader.startedWith?.instructions).toContain(
      'Do not create, edit, delete or rename files'
    )
    expect(reader.startedWith?.instructions).toContain('Wait for Work mode before implementing.')
    await vi.waitFor(() => {
      expect(reader.sent).toHaveLength(1)
    })
    const approvalId = newApprovalId()
    reader.emit({
      type: 'approval.requested',
      request: {
        id: approvalId,
        agentId: agent,
        kind: 'mcpToolCall',
        expiresAt: Date.now() + 30_000,
        serverName: 'project-reader',
        toolName: 'inspect',
        input: { path: 'docs/plans/feature.md' },
      },
    })
    await vi.waitFor(() => {
      expect(
        runtime.store
          .transcriptState(conversationId)
          .approvals.some((entry) => entry.approvalId === approvalId)
      ).toBe(true)
    })
    expect(reader.decisions).toEqual([])
    await runtime.decideApproval(conversationId, agent, approvalId, {
      outcome: 'allow',
      scope: 'once',
    })
    expect(reader.decisions).toEqual([
      {
        id: approvalId,
        decision: { outcome: 'allow', scope: 'once' },
      },
    ])
    await discussionReply(reader, 'We can discuss the plan here without saving it.')
    expect(parent.sent).toEqual(original)
    expect(parent.interruptRequested).toBe(false)
    expect(parent.closed).toBe(false)
    expect(parent.permissionModes).toEqual([])
    const events = runtime.store.read(conversationId)
    expect(
      events.some(
        (event) => event.payload.type === 'user.message' && event.payload.mode === 'discussion'
      )
    ).toBe(true)
    expect(
      events.some(
        (event) =>
          event.payload.type === 'agent.message.completed' &&
          event.payload.mode === 'discussion' &&
          isDiscussion(event.payload.itemRef)
      )
    ).toBe(true)
  })

  it('uses the same Discussion instructions while idle and despite a collaboration intent', async () => {
    await runtime.send(
      conversationId,
      '@codex Discuss this with @claude.',
      'collaborate',
      'discussion'
    )
    await vi.waitFor(() => {
      expect(discussions('codex')).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing discussion session')
    expect(adapters.get('codex')?.forked).toHaveLength(0)
    await discussionReply(reader, 'Here is the discussion.')
    for (const adapter of adapters.values()) {
      for (const session of adapter.sessions) {
        if (!isDiscussionSession(session)) expect(session.sent).toHaveLength(0)
      }
    }
  })

  it('routes a discussion handoff with configured tools without touching either task', async () => {
    const primary = await working('codex')
    const partner = await working('claude')
    const original = [...primary.parent.sent]
    const partnerOriginal = [...partner.parent.sent]
    await runtime.send(
      conversationId,
      '@codex Ask @claude to review the plan.',
      'collaborate',
      'discussion'
    )
    await vi.waitFor(() => {
      expect(discussions('codex')).toHaveLength(1)
    })
    const lead = discussions('codex')[0]
    if (lead === undefined) throw new Error('Missing discussion lead')
    await discussionReply(
      lead,
      'Review only.\n\n@claude Review this plan without changing any files.'
    )
    await vi.waitFor(() => {
      expect(discussions('claude')).toHaveLength(1)
    })
    const collaborator = discussions('claude')[0]
    if (collaborator === undefined) throw new Error('Missing discussion collaborator')
    expect(collaborator.startedWith).not.toHaveProperty('toolPolicy')
    expect(collaborator.startedWith?.instructions).toContain('use configured MCP tools')
    expect(collaborator.sent[0]?.text).toContain("The user's current discussion question:")
    expect(collaborator.sent[0]?.text).toContain('Ask @claude to review the plan.')
    await discussionReply(collaborator, 'The approach is sound.')
    expect(primary.parent.sent).toEqual(original)
    expect(partner.parent.sent).toEqual(partnerOriginal)
    expect(primary.parent.interruptRequested).toBe(false)
    expect(partner.parent.interruptRequested).toBe(false)
    expect(
      runtime.store.read(conversationId).some((event) => event.payload.type === 'handoff.created')
    ).toBe(false)
  })

  it('reuses the native reader and its existing answer for a queued follow-up', async () => {
    await runtime.send(conversationId, '@codex Explain the plan.', undefined, 'discussion')
    await runtime.send(conversationId, '@codex Explain the second point.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')).toHaveLength(1)
    })
    const first = discussions('codex')[0]
    if (first === undefined) throw new Error('Missing first discussion')
    await discussionReply(first, 'The second point is the immutable submission mode.')
    await vi.waitFor(() => {
      expect(first.sent).toHaveLength(2)
    })
    expect(discussions('codex')).toHaveLength(1)
    expect(first.sent[1]?.text).toContain('Explain the second point.')
    expect(first.sent[1]?.text).not.toContain('immutable submission mode')
    expect(first.startedWith).not.toHaveProperty('toolPolicy')
    await discussionReply(first, 'Each prompt keeps its submitted mode.', 2)
  })

  it('keeps the submitted Discussion instructions when a Work prompt guides the task', async () => {
    const { parent } = await working('codex')
    await runtime.send(conversationId, '@codex Explain the plan.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing discussion session')
    await runtime.send(conversationId, '@codex Continue implementing.', undefined, 'work')
    expect(parent.sent).toHaveLength(2)
    expect(reader.startedWith).not.toHaveProperty('toolPolicy')
    expect(reader.startedWith?.instructions).toContain('Wait for Work mode before implementing.')
    expect(reader.closed).toBe(false)
    await discussionReply(reader, 'I will keep this reply to discussion and inspection.')
    parent.emit({
      type: 'message.completed',
      itemRef: 'work-update',
      text: 'The implementation now uses explicit request states.',
    })
    parent.emit({ type: 'turn.completed', turnRef: 'primary-codex', status: 'completed' })
    await vi.waitFor(() => {
      expect(
        runtime.store
          .read(conversationId)
          .some(
            (event) =>
              event.payload.type === 'agent.message.completed' &&
              event.payload.text.includes('implementation now')
          )
      ).toBe(true)
    })
    await runtime.send(conversationId, '@codex Explain the latest change.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(reader.sent).toHaveLength(2)
    })
    expect(discussions('codex')).toHaveLength(1)
    expect(reader.sent[1]?.text).toContain('explicit request states')
    await discussionReply(reader, 'The latest change tracks request states.', 2)
  })

  it('keeps Chat pending through notices without changing the Work lifecycle', async () => {
    const { parent } = await working('codex')
    await runtime.send(conversationId, '@codex Explain the design.', undefined, 'discussion')
    expect(runtime.transcriptState(conversationId).replies).toHaveLength(1)
    expect(runtime.transcriptState(conversationId).working).toContain('codex')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing discussion session')
    reader.emit({ type: 'turn.started', turnRef: 'chat-turn' })
    await vi.waitFor(() => {
      expect(runtime.transcriptState(conversationId).replies[0]?.payload).toMatchObject({
        phase: 'thinking',
      })
    })
    parent.emit({ type: 'turn.completed', turnRef: 'primary-codex', status: 'completed' })
    await vi.waitFor(() => {
      expect(runtime.transcriptState(conversationId).working).toEqual([])
    })
    expect(runtime.transcriptState(conversationId).replies).toHaveLength(1)
    await discussionReply(reader, 'The design keeps Chat and Work independent.')
    await vi.waitFor(() => {
      expect(runtime.transcriptState(conversationId).replies).toEqual([])
    })
  })

  it('routes a Chat approval without a Work request and inherits project permissions', async () => {
    runtime.setProfile(conversationId, 'workspace-write')
    await runtime.send(conversationId, '@codex Inspect the endpoint.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing discussion session')
    expect(reader.startedWith?.sandbox.mode).toBe('workspaceWrite')
    const approvalId = newApprovalId()
    reader.emit({
      type: 'approval.requested',
      request: {
        id: approvalId,
        agentId: 'codex',
        kind: 'mcpToolCall',
        expiresAt: Date.now() + 30_000,
        serverName: 'project-reader',
        toolName: 'inspect',
        input: {},
      },
    })
    await vi.waitFor(() => {
      expect(
        runtime
          .transcriptState(conversationId)
          .approvals.some((entry) => entry.approvalId === approvalId)
      ).toBe(true)
    })
    await runtime.decideApproval(conversationId, 'codex', approvalId, {
      outcome: 'allow',
      scope: 'once',
    })
    expect(reader.decisions).toContainEqual({
      id: approvalId,
      decision: { outcome: 'allow', scope: 'once' },
    })
    await discussionReply(reader, 'The endpoint is available.')
  })

  it('serializes a handoff behind another request using the same Chat session', async () => {
    await runtime.send(conversationId, '@codex Ask claude to review.', undefined, 'discussion')
    await runtime.send(conversationId, '@claude Explain the design.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    await vi.waitFor(() => {
      expect(discussions('claude')[0]?.sent).toHaveLength(1)
    })
    const lead = discussions('codex')[0]
    const collaborator = discussions('claude')[0]
    if (lead === undefined || collaborator === undefined) throw new Error('Missing Chat sessions')
    await discussionReply(lead, '@claude Review the approach.')
    await vi.waitFor(() => {
      expect(
        runtime
          .transcriptState(conversationId)
          .replies.some(
            (event) =>
              event.payload.type === 'reply.status' &&
              event.payload.agentId === 'claude' &&
              event.payload.phase === 'waiting'
          )
      ).toBe(true)
    })
    expect(collaborator.sent).toHaveLength(1)
    await discussionReply(collaborator, 'The design is described here.')
    await vi.waitFor(() => {
      expect(collaborator.sent).toHaveLength(2)
    })
    expect(discussions('claude')).toHaveLength(1)
    await discussionReply(collaborator, 'The approach is sound.', 2)
  })

  it('shows and answers a Chat question instead of silently cancelling it', async () => {
    await runtime.send(conversationId, '@codex Discuss the approach.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing Chat session')
    const userInputId = newUserInputId()
    reader.emit({
      type: 'userinput.requested',
      request: {
        id: userInputId,
        agentId: 'codex',
        expiresAt: Date.now() + 30_000,
        questions: [
          {
            id: 'scope',
            header: 'Scope',
            question: 'Which part?',
            options: [],
            multiSelect: false,
            allowOther: true,
            isSecret: false,
          },
        ],
      },
    })
    await vi.waitFor(() => {
      expect(
        runtime
          .transcriptState(conversationId)
          .questions.some((entry) => entry.userInputId === userInputId)
      ).toBe(true)
    })
    expect(reader.userInputResponses).toEqual([])
    const response = {
      outcome: 'answered' as const,
      answers: [{ questionId: 'scope', values: ['The mode switch.'] }],
    }
    await runtime.answerUserInput(conversationId, 'codex', userInputId, response)
    expect(reader.userInputResponses).toEqual([{ id: userInputId, response }])
    await discussionReply(reader, 'The switch applies to the next message.')
  })

  it('saves a partial Chat reply and clears its pending state on Stop', async () => {
    await runtime.send(conversationId, '@codex Explain the approach.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing Chat session')
    reader.emit({ type: 'message.delta', itemRef: 'partial', text: 'The partial explanation' })
    await runtime.interrupt(conversationId)
    expect(reader.closed).toBe(true)
    expect(runtime.transcriptState(conversationId).replies).toEqual([])
    expect(
      runtime.store
        .read(conversationId)
        .some(
          (event) =>
            event.payload.type === 'agent.message.completed' &&
            event.payload.mode === 'discussion' &&
            event.payload.text === 'The partial explanation'
        )
    ).toBe(true)
  })

  it('cancels a Chat startup without sending its question afterward', async () => {
    const adapter = adapters.get('codex')
    if (adapter === undefined) throw new Error('Missing adapter')
    const originalStart = adapter.start.bind(adapter)
    let release = (): void => undefined
    const opening = new Promise<void>((resolve) => {
      release = resolve
    })
    let starting = false
    vi.spyOn(adapter, 'start').mockImplementation(async (opts) => {
      if (opts.instructions?.startsWith('You are in Discussion mode.')) {
        starting = true
        await opening
      }
      return originalStart(opts)
    })
    await runtime.send(conversationId, '@codex Explain the design.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(starting).toBe(true)
    })
    try {
      await runtime.interrupt(conversationId)
      expect(runtime.transcriptState(conversationId).replies).toEqual([])
    } finally {
      release()
    }
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.closed).toBe(true)
    })
    expect(discussions('codex')[0]?.sent).toEqual([])
  })

  it('clears a failed Chat request and can answer the next question', async () => {
    const adapter = adapters.get('codex')
    if (adapter === undefined) throw new Error('Missing adapter')
    vi.spyOn(adapter, 'start').mockRejectedValueOnce(new Error('Provider startup failed'))
    await runtime.send(conversationId, '@codex Explain the design.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(runtime.transcriptState(conversationId).replies).toEqual([])
    })
    expect(
      runtime.store
        .read(conversationId)
        .some((event) => event.payload.type === 'reply.status' && event.payload.phase === 'error')
    ).toBe(true)
    await runtime.send(conversationId, '@codex Try the explanation again.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing retry session')
    await discussionReply(reader, 'Here is the explanation.')
  })

  it('stops implementation only when explicitly asked to stop and discuss', async () => {
    const { parent } = await working('codex')
    await runtime.send(
      conversationId,
      '@codex Stop the task and discuss this approach.',
      undefined,
      'discussion'
    )
    expect(parent.interruptRequested).toBe(true)
    await vi.waitFor(() => {
      expect(discussions('codex')).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing discussion session')
    expect(reader.startedWith).not.toHaveProperty('toolPolicy')
    await discussionReply(reader, 'We can discuss the approach now.')
  })
})

describe('live chat for every agent', () => {
  it('retains a live answer that arrives while a Work send is awaiting acknowledgement', async () => {
    const { adapter, parent } = await working('codex')
    const send = parent.send.bind(parent)
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = true
    vi.spyOn(parent, 'send').mockImplementation(async (input) => {
      await send(input)
      if (held) {
        held = false
        await gate
      }
    })
    const pending = runtime.send(conversationId, '@codex Keep implementing.', undefined, 'work')
    try {
      await vi.waitFor(() => {
        expect(parent.sent).toHaveLength(2)
      })
      await runtime.send(conversationId, '@codex Why API retries?')
      await vi.waitFor(() => {
        expect(adapter.forked[0]?.session.sent).toHaveLength(1)
      })
      const reader = adapter.forked[0]?.session
      if (reader === undefined) throw new Error('Missing live reader')
      reader.emit({
        type: 'message.completed',
        itemRef: 'during-send',
        text: 'LATEST_LIVE_ANSWER: preserve idempotency keys.',
      })
      reader.emit({ type: 'turn.completed', turnRef: 'during-send', status: 'completed' })
      await vi.waitFor(() => {
        expect(reader.closed).toBe(true)
      })
    } finally {
      release()
      await pending
    }
    await runtime.send(conversationId, '@codex Apply the latest answer.', undefined, 'work')
    expect(parent.sent[2]?.text).toContain('LATEST_LIVE_ANSWER: preserve idempotency keys.')
  })

  it.each(AGENT_IDS)('answers a live question without ending the %s task', async (agent) => {
    const { adapter, parent } = await working(agent)
    const before = [...parent.sent]
    const fork = vi.spyOn(adapter, 'fork')
    await runtime.send(conversationId, `@${agent} Why this approach?`)
    await vi.waitFor(() => {
      expect(adapter.forked).toHaveLength(1)
    })
    expect(fork).toHaveBeenCalledWith(
      parent.sessionRef,
      expect.objectContaining({
        sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
      })
    )
    const reader = adapter.forked[0]?.session
    if (reader === undefined) throw new Error('Missing live reader')
    await vi.waitFor(() => {
      expect(reader.sent).toHaveLength(1)
    })
    const approvalId = newApprovalId()
    reader.emit({
      type: 'approval.requested',
      request: {
        id: approvalId,
        agentId: agent,
        kind: 'fileChange',
        expiresAt: Date.now() + 30_000,
        files: [{ path: 'file.ts', patch: 'an unwanted edit' }],
      },
    })
    reader.emit({
      type: 'message.completed',
      itemRef: 'reply',
      text: 'This keeps the change small.',
    })
    reader.emit({ type: 'turn.completed', turnRef: 'live', status: 'completed' })
    await vi.waitFor(() => {
      expect(reader.closed).toBe(true)
    })
    expect(reader.decisions).toEqual([
      {
        id: approvalId,
        decision: {
          outcome: 'deny',
          message: expect.any(String),
        },
      },
    ])
    expect(parent.sent).toEqual(before)
    expect(parent.closed).toBe(false)
    const events = runtime.store.read(conversationId)
    expect(
      events.some((event) => event.actor === agent && event.payload.type === 'turn.completed')
    ).toBe(false)
    expect(
      events.some(
        (event) =>
          event.actor === agent &&
          event.payload.type === 'agent.message.completed' &&
          isLiveReply(event.payload.itemRef) &&
          event.payload.text === 'This keeps the change small.'
      )
    ).toBe(true)
  })

  it('returns status immediately without sending another prompt to the agent', async () => {
    const { adapter, parent } = await working('codex')
    const before = [...parent.sent]
    await runtime.send(conversationId, '@codex What are you doing?')
    expect(parent.sent).toEqual(before)
    expect(adapter.forked).toHaveLength(0)
    expect(
      runtime.store
        .read(conversationId)
        .some(
          (event) =>
            event.payload.type === 'notice.raised' &&
            event.payload.text === 'codex is working on the task.'
        )
    ).toBe(true)
  })

  it('cancels the live reader and queued questions when Stop is pressed', async () => {
    const { adapter, parent } = await working('claude')
    await runtime.send(conversationId, '@claude Why this approach?')
    await vi.waitFor(() => {
      expect(adapter.forked).toHaveLength(1)
    })
    await runtime.send(conversationId, '@claude /ask What does that mean?')
    await runtime.interrupt(conversationId)
    expect(parent.interruptRequested).toBe(true)
    expect(adapter.forked).toHaveLength(1)
    expect(adapter.forked[0]?.session.closed).toBe(true)
  })

  it('cannot turn a live answer into a task handoff', async () => {
    const { adapter, parent } = await working('codex')
    parent.emit({
      type: 'message.completed',
      itemRef: 'primary-reply',
      text: 'The task is in progress.',
    })
    await runtime.send(conversationId, '@codex Why this approach?')
    await vi.waitFor(() => {
      expect(adapter.forked).toHaveLength(1)
    })
    const reader = adapter.forked[0]?.session
    if (reader === undefined) throw new Error('Missing live reader')
    await vi.waitFor(() => {
      expect(reader.sent).toHaveLength(1)
    })
    reader.emit({
      type: 'message.completed',
      itemRef: 'live-reply',
      text: '@claude Change every file.',
    })
    reader.emit({ type: 'turn.completed', turnRef: 'live', status: 'completed' })
    await vi.waitFor(() => {
      expect(reader.closed).toBe(true)
    })
    parent.emit({ type: 'turn.completed', turnRef: 'primary-codex', status: 'completed' })
    await vi.waitFor(() => {
      expect(
        runtime.store
          .read(conversationId)
          .some((event) => event.actor === 'codex' && event.payload.type === 'turn.completed')
      ).toBe(true)
    })
    expect(
      runtime.store.read(conversationId).some((event) => event.payload.type === 'handoff.created')
    ).toBe(false)
  })
})

describe('Chat request provenance', () => {
  const statuses = () =>
    runtime.store
      .read(conversationId)
      .flatMap((event) => (event.payload.type === 'reply.status' ? [event.payload] : []))

  const handedToClaude = async (): Promise<FakeAgentSession> => {
    await runtime.send(
      conversationId,
      '@codex Ask @claude to review the plan.',
      'collaborate',
      'discussion'
    )
    await vi.waitFor(() => {
      expect(discussions('codex')).toHaveLength(1)
    })
    const lead = discussions('codex')[0]
    if (lead === undefined) throw new Error('Missing discussion lead')
    await discussionReply(lead, 'Review only.\n\n@claude Review this plan without changing files.')
    await vi.waitFor(() => {
      expect(discussions('claude')[0]?.sent).toHaveLength(1)
    })
    const collaborator = discussions('claude')[0]
    if (collaborator === undefined) throw new Error('Missing discussion collaborator')
    return collaborator
  }

  it('stamps a Chat approval and question with the request that asked them', async () => {
    await runtime.send(conversationId, '@codex Inspect the endpoint.', undefined, 'discussion')
    await vi.waitFor(() => {
      expect(discussions('codex')[0]?.sent).toHaveLength(1)
    })
    const reader = discussions('codex')[0]
    if (reader === undefined) throw new Error('Missing discussion session')
    reader.emit({
      type: 'approval.requested',
      request: {
        id: newApprovalId(),
        agentId: 'codex',
        kind: 'mcpToolCall',
        expiresAt: Date.now() + 30_000,
        serverName: 'project-reader',
        toolName: 'inspect',
        input: {},
      },
    })
    reader.emit({
      type: 'userinput.requested',
      request: {
        id: newUserInputId(),
        agentId: 'codex',
        expiresAt: Date.now() + 30_000,
        questions: [
          {
            id: 'scope',
            header: 'Scope',
            question: 'Which part?',
            options: [],
            multiSelect: false,
            allowOther: true,
            isSecret: false,
          },
        ],
      },
    })
    const waits = () =>
      runtime.store
        .read(conversationId)
        .flatMap((event) =>
          event.payload.type === 'approval.requested' ||
          event.payload.type === 'userinput.requested'
            ? [event.payload]
            : []
        )
    await vi.waitFor(() => {
      expect(waits()).toHaveLength(2)
    })
    const requestId = statuses().find((status) => status.agentId === 'codex')?.requestId
    expect(requestId).toMatch(/^discussion:.+:codex:0$/)
    expect(waits().map((wait) => [wait.mode, wait.requestId])).toEqual([
      ['discussion', requestId],
      ['discussion', requestId],
    ])
  })

  it('names the agent whose parsed handoff chose a round, on every status of that round only', async () => {
    const collaborator = await handedToClaude()
    collaborator.emit({ type: 'turn.started', turnRef: 'review' })
    await discussionReply(collaborator, 'The approach is sound.')
    await vi.waitFor(() => {
      expect(
        statuses().some((status) => status.agentId === 'claude' && status.phase === 'done')
      ).toBe(true)
    })
    const lead = statuses().filter((status) => status.agentId === 'codex')
    const round = statuses().filter((status) => status.agentId === 'claude')
    expect(lead.length).toBeGreaterThan(0)
    expect(lead.every((status) => status.from === undefined)).toBe(true)
    expect(round.map((status) => status.phase)).toEqual(['waiting', 'thinking', 'replying', 'done'])
    expect(round.every((status) => status.from === 'codex')).toBe(true)
    const requestIds = [...new Set(round.map((status) => status.requestId))]
    expect(requestIds).toHaveLength(1)
    expect(requestIds[0]).toMatch(/:claude:1$/)
  })

  it('keeps the source on a handed-off round that Stop cancels', async () => {
    await handedToClaude()
    await runtime.interrupt(conversationId)
    const cancelled = statuses().filter((status) => status.phase === 'cancelled')
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]).toMatchObject({ agentId: 'claude', from: 'codex' })
  })

  it('keeps the source on a handed-off round whose reader cannot start', async () => {
    const claude = adapters.get('claude')
    if (claude === undefined) throw new Error('Missing adapter')
    const start = claude.start.bind(claude)
    vi.spyOn(claude, 'start').mockImplementation((opts) =>
      opts.instructions?.startsWith('You are in Discussion mode.') === true
        ? Promise.reject(new Error('Provider startup failed'))
        : start(opts)
    )
    await runtime.send(
      conversationId,
      '@codex Ask @claude to review the plan.',
      'collaborate',
      'discussion'
    )
    await vi.waitFor(() => {
      expect(discussions('codex')).toHaveLength(1)
    })
    const lead = discussions('codex')[0]
    if (lead === undefined) throw new Error('Missing discussion lead')
    await discussionReply(lead, '@claude Review this plan without changing files.')
    await vi.waitFor(() => {
      expect(statuses().some((status) => status.phase === 'error')).toBe(true)
    })
    const round = statuses().filter((status) => status.agentId === 'claude')
    expect(round.map((status) => status.phase)).toEqual(['waiting', 'error'])
    expect(round.every((status) => status.from === 'codex')).toBe(true)
  })
})
