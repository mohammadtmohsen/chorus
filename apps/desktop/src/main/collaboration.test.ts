import { testHostPorts } from './test-host-ports.js'
import type { AgentAdapter } from '@chorus/agent-protocol'
import { FakeAdapter, type FakeAgentSession } from '@chorus/orchestrator'
import { AGENT_IDS, Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isExpandedCollaboration, originalCollaborationText } from '../shared/collaboration.js'
import { IPC_CONTRACT } from '../shared/ipc.js'
import { applyMention, teamCommandOption } from '../renderer/src/mention-menu.js'
import { EMPTY_VIEW, reduceEvents } from '../renderer/src/transcript.js'
import { collaborationPrompt } from './collaboration-prompt.js'
import { ChorusRuntime, NAMER_INSTRUCTIONS } from './runtime.js'

let runtime: ChorusRuntime
let conversationId: string
let adapters: Map<AgentId, FakeAdapter>

const sentTo = (agent: AgentId): string[] =>
  adapters
    .get(agent)
    ?.sessions.filter((session) => session.startedWith?.instructions !== NAMER_INSTRUCTIONS)
    .flatMap((session) => session.sent.map((message) => message.text)) ?? []

const logged = (): string[] =>
  runtime.store
    .read(conversationId)
    .flatMap((event) => (event.payload.type === 'user.message' ? [event.payload.text] : []))

beforeEach(async () => {
  adapters = new Map(AGENT_IDS.map((id) => [id, new FakeAdapter({ id })]))
  runtime = ChorusRuntime.open(
    testHostPorts(mkdtempSync(join(tmpdir(), 'chorus-collaboration-'))),
    new Logger(),
    new Map<AgentId, AgentAdapter>(adapters)
  )
  const started = await runtime.startConversationIn({ agents: [...AGENT_IDS], cwd: process.cwd() })
  conversationId = started.conversationId
})

afterEach(async () => {
  await runtime.close()
})

describe('collaboration delivery', () => {
  it('logs the short task and delivers the workflow only to the first mentioned agent', async () => {
    const task = '@deepseek work with @codex on saved searches'
    const request = IPC_CONTRACT['conversation:send'].request.parse({
      conversationId,
      text: task,
      intent: 'collaborate',
    })
    const result = await runtime.send(request.conversationId, request.text, request.intent)

    expect(result.targets).toEqual(['deepseek'])
    expect(logged()).toEqual([task])
    expect(sentTo('codex')).toEqual([])
    expect(sentTo('claude')).toEqual([])
    expect(sentTo('deepseek')[0]).toContain(`# TASK\n\n${task}`)
    expect(sentTo('deepseek')[0]).toContain('Research only:')
    expect(sentTo('deepseek')[0]).toContain('Research and plan:')
    expect(sentTo('deepseek')[0]).toContain('Full build:')
  })

  it('keeps template-looking task text and attachments literal', async () => {
    const task = '@claude @codex research only: {{partner}} $t(example)\n\n"/tmp/image one.png"'
    await runtime.send(conversationId, task, 'collaborate')
    expect(logged()).toEqual([task])
    expect(sentTo('claude')[0]).toContain(`# TASK\n\n${task}\n\n# ROLES AND SCOPE`)
  })

  it('keeps a plain collaborator name as a solo task', async () => {
    const task = '@codex review what claude wrote'
    const result = await runtime.send(conversationId, task)
    expect(result.targets).toEqual(['codex'])
    expect(sentTo('codex')[0]).toContain('review what claude wrote')
    expect(sentTo('codex')[0]).not.toContain('# ROLES AND SCOPE')
    expect(sentTo('claude')).toEqual([])
  })

  it('does not introduce collaboration based on editor context without the draft intent', async () => {
    await runtime.send(conversationId, '@codex explain this file\n\nEditor context: @claude')
    expect(sentTo('codex')[0]).not.toContain('# ROLES AND SCOPE')
    expect(sentTo('claude')).toEqual([])
  })

  it('recovers an old prompt in the transcript and resends without nesting it', async () => {
    const task = '@codex @claude research and plan: saved searches'
    const extra = '\n\n"/tmp/example.png"'
    const old = collaborationPrompt({ leader: 'codex', partner: 'claude' }, task) + extra
    runtime.store.append({
      conversationId,
      actor: 'user',
      payload: { type: 'user.message', text: old },
    })
    const events = runtime.store.read(conversationId).map((event) => ({
      ...event,
      type: event.payload.type,
    }))
    const history = reduceEvents(EMPTY_VIEW, events)
      .messages.filter((message) => message.actor === 'user')
      .map((message) => message.text)
    expect(history).toEqual([task + extra])
    expect(logged()).toEqual([old])

    await runtime.send(conversationId, old, 'collaborate')
    expect(logged()).toEqual([old, task + extra])
    expect(sentTo('codex')[0]).toContain(`# TASK\n\n${task + extra}\n\n# ROLES AND SCOPE`)
    expect(sentTo('codex')[0]).not.toContain('# TASK\n\n@codex Run this task collaboratively')
  })

  it('preserves an unrecognized old envelope without adding another wrapper', async () => {
    const old = collaborationPrompt(
      { leader: 'codex', partner: 'claude' },
      '@codex @claude fix saved searches'
    ).replace('# ROLES AND SCOPE', '# ROLES')
    await runtime.send(conversationId, old, 'collaborate')
    expect(logged()).toEqual([old])
    expect(sentTo('codex')[0]).not.toContain('# ROLES AND SCOPE')
  })
})

describe('collaboration prompt', () => {
  const pairs = AGENT_IDS.flatMap((leader) =>
    AGENT_IDS.filter((partner) => partner !== leader).map((partner) => ({ leader, partner }))
  )

  it.each(pairs)('wraps, recovers and resends $leader leading $partner', async (pair) => {
    const { leader, partner } = pair
    const task = `@${leader} @${partner}: {{leader}} {{partner}} {{task}} $& $t(example)`
    const extra = '\n\n"/tmp/image one.png"'
    const prompt = collaborationPrompt(pair, task)
    const opening = [
      `@${leader} Run this task collaboratively with ${partner}.`,
      '# TASK',
      task,
      '# ROLES AND SCOPE',
      `You, ${leader}, are the lead and coordinator. ${partner} is your collaborator.`,
    ].join('\n\n')
    const closing = `- A reply whose next step belongs to ${partner} and which does not end with an @${partner} line stops the run.`

    expect(prompt.slice(0, opening.length)).toBe(opening)
    expect(prompt.slice(-closing.length)).toBe(closing)
    expect(isExpandedCollaboration(prompt)).toBe(true)
    expect(originalCollaborationText(prompt)).toBe(task)
    expect(originalCollaborationText(prompt + extra)).toBe(task + extra)
    expect(originalCollaborationText(collaborationPrompt(pair, prompt))).toBe(task)
    expect(prompt.length - task.length).toBeLessThan(10_000)

    const old = prompt + extra
    runtime.store.append({
      conversationId,
      actor: 'user',
      payload: { type: 'user.message', text: old },
    })
    const events = runtime.store.read(conversationId).map((event) => ({
      ...event,
      type: event.payload.type,
    }))
    const history = reduceEvents(EMPTY_VIEW, events)
      .messages.filter((message) => message.actor === 'user')
      .map((message) => message.text)
    expect(history).toEqual([task + extra])

    const result = await runtime.send(conversationId, old, 'collaborate')
    expect(result.targets).toEqual([leader])
    expect(logged()).toEqual([old, task + extra])
    expect(sentTo(leader)[0]).toContain(`# TASK\n\n${task + extra}\n\n# ROLES AND SCOPE`)
    for (const agent of AGENT_IDS.filter((id) => id !== leader)) {
      expect(sentTo(agent)).toEqual([])
    }
  })
})

describe('team introduction', () => {
  it('keeps the command in history and broadcasts the introduction on send and resend', async () => {
    const option = teamCommandOption(AGENT_IDS, 'te', { detail: 'Team' })[0]
    if (option === undefined) throw new Error('missing team option')
    const draft = applyMention(
      '/te',
      { trigger: '/', start: 0, query: 'te' },
      3,
      option
    ).text.trim()
    expect(draft).toBe('/team')

    const first = await runtime.send(conversationId, draft)
    const second = await runtime.send(conversationId, logged()[0] ?? '')
    expect(first.targets).toEqual(AGENT_IDS)
    expect(second.targets).toEqual(AGENT_IDS)
    expect(logged()).toEqual(['/team', '/team'])
    for (const agent of AGENT_IDS) {
      expect(sentTo(agent)).toHaveLength(2)
      expect(sentTo(agent)[0]).toContain('This conversation has')
      expect(sentTo(agent)[0]).not.toContain('# ROLES AND SCOPE')
    }
  })
})

describe('what became of a Work handoff', () => {
  const DISCUSSION = 'You are in Discussion mode.'
  const HANDOFF = 'Drafted.\n\n@codex Review the parser.'

  const workSession = (agent: AgentId): FakeAgentSession => {
    const found = adapters
      .get(agent)
      ?.sessions.filter(
        (session) =>
          session.startedWith !== undefined &&
          session.startedWith.instructions !== NAMER_INSTRUCTIONS &&
          session.startedWith.instructions?.startsWith(DISCUSSION) !== true
      )
      .at(-1)
    if (found === undefined) throw new Error(`no work session for ${agent}`)
    return found
  }

  const answer = (agent: AgentId, turnRef: string, text: string): void => {
    const session = workSession(agent)
    session.emit({ type: 'turn.started', turnRef })
    session.emit({ type: 'message.completed', itemRef: `${turnRef}-reply`, text })
    session.emit({ type: 'turn.completed', turnRef, status: 'completed' })
  }

  const payloads = () => runtime.store.read(conversationId).map((event) => event.payload)
  const created = () =>
    payloads().flatMap((payload) => (payload.type === 'handoff.created' ? [payload] : []))
  const outcomes = () =>
    payloads().flatMap((payload) => (payload.type === 'handoff.outcome' ? [payload] : []))
  const replyId = (text: string): string | undefined =>
    runtime.store
      .read(conversationId)
      .find(
        (event) => event.payload.type === 'agent.message.completed' && event.payload.text === text
      )?.id

  const onlyClaudeSeated = async (): Promise<FakeAdapter> => {
    await runtime.closeConversation(conversationId)
    const started = await runtime.startConversationIn({ agents: ['claude'], cwd: process.cwd() })
    conversationId = started.conversationId
    const codex = adapters.get('codex')
    if (codex === undefined) throw new Error('no codex adapter')
    return codex
  }

  it('records a submitted outcome against the handoff it created, and nothing for later turns', async () => {
    await runtime.send(conversationId, '@claude Draft the parser.')
    answer('claude', 'c1', HANDOFF)
    await vi.waitFor(() => {
      expect(outcomes()).toHaveLength(1)
    })
    const [made] = created()
    expect(made?.sourceEventIds).toEqual([replyId(HANDOFF)])
    expect(outcomes()).toEqual([
      {
        type: 'handoff.outcome',
        handoffId: made?.handoffId,
        from: 'claude',
        to: 'codex',
        sourceEventIds: [replyId(HANDOFF)],
        outcome: 'submitted',
      },
    ])
    expect(
      payloads()
        .map((payload) => payload.type)
        .filter((type) => type.startsWith('handoff.'))
    ).toEqual(['handoff.created', 'handoff.outcome'])
    expect(sentTo('codex').some((text) => text.includes('Review the parser.'))).toBe(true)

    answer('codex', 'x1', 'Reviewed, nothing to change.')
    await vi.waitFor(() => {
      expect(replyId('Reviewed, nothing to change.')).toBeDefined()
    })
    expect(outcomes()).toHaveLength(1)
  })

  it('records a failed outcome when the recipient session refuses the input', async () => {
    await runtime.send(conversationId, '@claude Draft the parser.')
    vi.spyOn(workSession('codex'), 'send').mockRejectedValueOnce(new Error('pipe closed'))
    answer('claude', 'c1', HANDOFF)
    await vi.waitFor(() => {
      expect(outcomes()).toHaveLength(1)
    })
    expect(created()).toHaveLength(1)
    expect(outcomes()[0]).toMatchObject({
      handoffId: created()[0]?.handoffId,
      to: 'codex',
      outcome: 'failed',
    })
    expect(
      payloads().some(
        (payload) => payload.type === 'error.raised' && payload.message.includes('pipe closed')
      )
    ).toBe(true)
  })

  it('records an unavailable outcome, with no created handoff, when the recipient cannot be seated', async () => {
    const codex = await onlyClaudeSeated()
    vi.spyOn(codex, 'start').mockRejectedValue(new Error('codex is not installed'))
    await runtime.send(conversationId, '@claude Draft the parser.')
    answer('claude', 'c1', HANDOFF)
    await vi.waitFor(() => {
      expect(outcomes()).toHaveLength(1)
    })
    expect(created()).toEqual([])
    expect(outcomes()[0]).toMatchObject({
      from: 'claude',
      to: 'codex',
      sourceEventIds: [replyId(HANDOFF)],
      outcome: 'unavailable',
    })
  })

  it('records a cancelled outcome tied to its source reply when the user redirected first', async () => {
    await runtime.send(conversationId, '@claude Draft the parser.')
    const claude = workSession('claude')
    claude.emit({ type: 'turn.started', turnRef: 'c1' })
    await runtime.send(conversationId, '@codex Use the cached grammar instead.')
    claude.emit({ type: 'message.completed', itemRef: 'c1-reply', text: HANDOFF })
    claude.emit({ type: 'turn.completed', turnRef: 'c1', status: 'completed' })
    await vi.waitFor(() => {
      expect(outcomes()).toHaveLength(1)
    })
    expect(created()).toEqual([])
    expect(outcomes()[0]).toMatchObject({
      from: 'claude',
      to: 'codex',
      sourceEventIds: [replyId(HANDOFF)],
      outcome: 'cancelled',
    })
    expect(outcomes()[0]?.handoffId).not.toBe('')
  })

  it('records cancelled, not submitted, when Stop lands while the recipient is being seated', async () => {
    const codex = await onlyClaudeSeated()
    await runtime.send(conversationId, '@claude Draft the parser.')
    let release = (): void => undefined
    const seated = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = codex.start.bind(codex)
    const starting = vi.spyOn(codex, 'start').mockImplementation(async (opts) => {
      if (opts.instructions !== NAMER_INSTRUCTIONS) await seated
      return start(opts)
    })
    answer('claude', 'c1', HANDOFF)
    await vi.waitFor(() => {
      expect(starting.mock.calls.some(([opts]) => opts.instructions !== NAMER_INSTRUCTIONS)).toBe(
        true
      )
    })
    const stopping = runtime.interrupt(conversationId)
    release()
    await stopping
    await vi.waitFor(() => {
      expect(outcomes()).toHaveLength(1)
    })
    expect(created()).toEqual([])
    expect(outcomes()[0]).toMatchObject({ to: 'codex', outcome: 'cancelled' })
  })

  it('records cancelled, not submitted, when Stop lands while the input is being delivered', async () => {
    await runtime.send(conversationId, '@claude Draft the parser.')
    let release = (): void => undefined
    const delivered = new Promise<void>((resolve) => {
      release = resolve
    })
    const sending = vi.spyOn(workSession('codex'), 'send').mockImplementationOnce(async () => {
      await delivered
    })
    answer('claude', 'c1', HANDOFF)
    await vi.waitFor(() => {
      expect(sending).toHaveBeenCalled()
    })
    const stopping = runtime.interrupt(conversationId)
    release()
    await stopping
    await vi.waitFor(() => {
      expect(outcomes()).toHaveLength(1)
    })
    expect(created()).toHaveLength(1)
    expect(outcomes()[0]).toMatchObject({
      handoffId: created()[0]?.handoffId,
      outcome: 'cancelled',
    })
  })

  it('cancels a handoff whose Stop landed after it was scheduled and before it began', async () => {
    const codex = await onlyClaudeSeated()
    await runtime.send(conversationId, '@claude Draft the parser.')
    const starting = vi.spyOn(codex, 'start')
    let stopping: Promise<void> | undefined
    runtime.subscribe((events) => {
      const ended = events.some(
        (event) =>
          event.conversationId === conversationId &&
          event.actor === 'claude' &&
          event.payload.type === 'turn.completed'
      )
      if (ended && stopping === undefined) stopping = runtime.interrupt(conversationId)
    })
    answer('claude', 'c1', HANDOFF)
    await vi.waitFor(() => {
      expect(outcomes()).toHaveLength(1)
    })
    await stopping
    expect(outcomes()[0]).toMatchObject({
      from: 'claude',
      to: 'codex',
      sourceEventIds: [replyId(HANDOFF)],
      outcome: 'cancelled',
    })
    expect(created()).toEqual([])
    const workStarts = starting.mock.calls.filter(
      ([opts]) => opts.instructions !== NAMER_INSTRUCTIONS
    )
    expect(workStarts).toEqual([])
    expect(sentTo('codex')).toEqual([])
  })

  it('records cancelled, not failed, when the recipient was replaced before its send rejected', async () => {
    await runtime.send(conversationId, '@claude Draft the parser.')
    const original = workSession('codex')
    let refuse: (error: Error) => void = () => undefined
    const refused = new Promise<void>((_resolve, reject) => {
      refuse = reject
    })
    const sending = vi.spyOn(original, 'send').mockImplementationOnce(() => refused)
    answer('claude', 'c1', HANDOFF)
    await vi.waitFor(() => {
      expect(sending).toHaveBeenCalled()
    })
    await runtime.setAnswerStyle(conversationId, true)
    expect(workSession('codex')).not.toBe(original)
    refuse(new Error('session closed'))
    await vi.waitFor(() => {
      expect(outcomes()).toHaveLength(1)
    })
    expect(created()).toHaveLength(1)
    expect(outcomes()[0]).toMatchObject({
      handoffId: created()[0]?.handoffId,
      outcome: 'cancelled',
    })
    expect(
      payloads().some(
        (payload) => payload.type === 'error.raised' && payload.message.includes('session closed')
      )
    ).toBe(true)
  }, 15_000)

  it('keeps each of several handoffs with its own id and outcome', async () => {
    await runtime.send(conversationId, '@claude Draft the parser.')
    answer('claude', 'c1', HANDOFF)
    await vi.waitFor(() => {
      expect(outcomes()).toHaveLength(1)
    })
    answer('codex', 'x1', 'Reviewed.\n\n@claude Apply the two fixes.')
    await vi.waitFor(() => {
      expect(outcomes()).toHaveLength(2)
    })
    const ids = created().map((payload) => payload.handoffId)
    expect(new Set(ids).size).toBe(2)
    expect(
      outcomes().map((payload) => [payload.handoffId, payload.from, payload.to, payload.outcome])
    ).toEqual([
      [ids[0], 'claude', 'codex', 'submitted'],
      [ids[1], 'codex', 'claude', 'submitted'],
    ])
  })
})
