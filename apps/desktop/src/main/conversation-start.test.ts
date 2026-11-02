import { FakeAdapter, FakeAgentSession } from '@chorus/orchestrator'
import type { AgentAdapter, AgentSession, SessionOpts } from '@chorus/agent-protocol'
import { Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChorusRuntime } from './runtime.js'
import { DEFAULT_SETTINGS, writeSettings } from './settings.js'
import { readOpenProjects, writeOpenProjects, type OpenConversation } from './open-projects.js'

class GatedAdapter extends FakeAdapter {
  starts = 0
  failure: Error | null = null
  private gate: Promise<void> | null = null
  private open: () => void = () => undefined
  private closeGate: Promise<void> | null = null
  private openClose: () => void = () => undefined

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve
    })
  }

  release(): void {
    this.open()
  }

  holdClose(): void {
    this.closeGate = new Promise((resolve) => {
      this.openClose = resolve
    })
  }

  releaseClose(): void {
    this.openClose()
  }

  override async start(opts: SessionOpts): Promise<AgentSession> {
    this.starts += 1
    if (this.gate !== null) await this.gate
    if (this.failure !== null) throw this.failure
    const session = await super.start(opts)
    const gate = this.closeGate
    const fake = this.sessions.at(-1)
    if (gate !== null && fake !== undefined) {
      const close = fake.close.bind(fake)
      fake.close = async () => {
        await gate
        await close()
      }
    }
    return session
  }
}

const silent = new Logger()
const CWD = process.cwd()
const BOTH: readonly AgentId[] = ['claude', 'codex']

let runtime: ChorusRuntime
let claude: GatedAdapter
let codex: GatedAdapter
let dataPath: string
let projectId: string
let shutDown: boolean

const turn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

const eventTypes = (conversationId: string): string[] =>
  runtime.store.read(conversationId).map((event) => event.payload.type)

beforeEach(() => {
  dataPath = mkdtempSync(join(tmpdir(), 'chorus-start-'))
  claude = new GatedAdapter({ id: 'claude' })
  codex = new GatedAdapter({ id: 'codex' })
  runtime = ChorusRuntime.open(
    dataPath,
    silent,
    new Map<AgentId, AgentAdapter>([
      ['claude', claude],
      ['codex', codex],
    ])
  )
  projectId = runtime.projects.adopt(CWD).project.id
  shutDown = false
})

afterEach(async () => {
  vi.restoreAllMocks()
  claude.release()
  codex.release()
  claude.releaseClose()
  codex.releaseClose()
  delete process.env['CHORUS_PROFILE_READONLY']
  if (!shutDown) await runtime.close()
})

describe('beginning a conversation', () => {
  it('answers with the permanent id before any event is written or agent started', async () => {
    claude.hold()
    codex.hold()
    const begun = runtime.beginConversation({ projectId, agents: BOTH })

    expect(begun).toMatchObject({ projectId, cwd: expect.any(String), participants: [] })
    expect(runtime.store.read(begun.conversationId)).toEqual([])
    expect(claude.starts + codex.starts).toBe(0)
    expect(runtime.activeSessions()).toEqual([
      expect.objectContaining({
        conversationId: begun.conversationId,
        participants: [],
        starting: true,
      }),
    ])

    await vi.waitFor(() => {
      expect(claude.starts).toBe(1)
      expect(codex.starts).toBe(1)
    })
    expect(eventTypes(begun.conversationId)).toEqual(['conversation.created'])
    expect(runtime.activeSessions()[0]?.starting).toBe(true)

    claude.release()
    codex.release()
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'ready',
      conversation: { ...begun, participants: ['claude', 'codex'] },
    })
    expect(runtime.activeSessions()).toHaveLength(1)
    expect(runtime.activeSessions()[0]?.starting).toBeUndefined()
  })

  it('composes a carried room after answering, and records it only once composed', async () => {
    const source = await runtime.startConversation({ projectId, agents: ['claude'] })
    await runtime.send(source.conversationId, 'remember the blue door')

    const begun = runtime.beginConversation({
      projectId,
      agents: ['claude'],
      continueFrom: source.conversationId,
    })
    expect(runtime.store.read(begun.conversationId)).toEqual([])

    expect(await runtime.awaitStart(begun.conversationId)).toMatchObject({ status: 'ready' })
    const created = runtime.store
      .read(begun.conversationId)
      .find((event) => event.payload.type === 'conversation.created')
    expect(created?.payload).toMatchObject({ continuedFrom: source.conversationId })
    expect(
      runtime.store
        .read(begun.conversationId)
        .some(
          (event) =>
            event.payload.type === 'notice.raised' && event.payload.code === 'contextCarried'
        )
    ).toBe(true)

    await runtime.send(begun.conversationId, 'carry on')
    const joined = runtime.store
      .read(begun.conversationId)
      .find(
        (event) => event.payload.type === 'session.started' && event.payload.agentId === 'claude'
      )
    const ref = joined?.payload.type === 'session.started' ? joined.payload.sessionRef : undefined
    const participant = claude.sessions.find((session) => session.sessionRef === ref)
    expect(ref).toBeDefined()
    expect(participant?.sent[0]?.text).toContain('remember the blue door')
  })

  it('pins a side task before asynchronous startup and keeps later parent messages explicit', async () => {
    const source = await runtime.startConversation({ projectId, agents: BOTH })
    await runtime.send(source.conversationId, '@codex Investigate API retries.')
    const decision = runtime.store.append({
      conversationId: source.conversationId,
      actor: 'codex',
      payload: {
        type: 'agent.message.completed',
        itemRef: 'api-decision',
        text: 'API calls must retry three times. Preserve authentication headers.',
      },
    })
    const pin = runtime.store.read(source.conversationId).at(-1)?.seq
    const begun = runtime.beginConversation({
      projectId,
      agents: BOTH,
      continueFrom: source.conversationId,
      objective: 'Fix API calls',
    })
    runtime.store.append({
      conversationId: source.conversationId,
      actor: 'user',
      payload: { type: 'user.message', text: 'LATER_PARENT_CHANGE: use a different retry policy.' },
    })
    await runtime.awaitStart(begun.conversationId)
    const creation = runtime.store
      .read(begun.conversationId)
      .find((entry) => entry.payload.type === 'conversation.created')
    expect(creation?.payload).toMatchObject({
      continuedFrom: source.conversationId,
      forward: { throughSeq: pin, objective: 'Fix API calls', sourceEventIds: [decision?.id] },
    })
    expect(
      runtime.store
        .read(begun.conversationId)
        .find(
          (entry) =>
            entry.payload.type === 'notice.raised' && entry.payload.code === 'contextCarried'
        )?.payload
    ).toMatchObject({ detail: 'Fix API calls' })
    expect(
      runtime.activeSessions().some((room) => room.conversationId === source.conversationId)
    ).toBe(true)
    expect(
      runtime.activeSessions().find((room) => room.conversationId === begun.conversationId)?.draft
    ).toBe('')
    const routed = await runtime.send(begun.conversationId, 'Continue the selected task.')
    expect(routed.targets).toEqual(['codex'])
    const worker = codex.sessions.findLast((session) =>
      session.sent.some((input) => input.text.includes('Continue the selected task.'))
    )
    expect(worker?.sent[0]?.text).toContain('three times')
    expect(worker?.sent[0]?.text).toContain('Fix API calls')
    expect(worker?.sent[0]?.text).not.toContain('LATER_PARENT_CHANGE')
    const snapshot = worker?.startedWith?.transcript?.({
      skip: 0,
      count: 20,
      query: 'LATER_PARENT_CHANGE',
    })
    expect(snapshot).toContain('0 matching records')
    const updates = worker?.startedWith?.transcript?.({
      skip: 0,
      count: 20,
      query: 'LATER_PARENT_CHANGE',
      scope: 'updates',
    })
    expect(updates).toContain('LATER_PARENT_CHANGE')
    expect(updates).toContain('not part of this conversation')
    expect(
      worker?.startedWith?.transcript?.({ skip: 0, count: 20, conversationId: 'unrelated' })
    ).toContain('No conversation unrelated is readable')
  })

  it('names no source when the room it continues has nothing to carry', async () => {
    const begun = runtime.beginConversation({
      projectId,
      agents: ['claude'],
      continueFrom: 'a-room-that-never-was',
    })
    await runtime.awaitStart(begun.conversationId)

    const created = runtime.store
      .read(begun.conversationId)
      .find((event) => event.payload.type === 'conversation.created')
    expect(created?.payload).not.toHaveProperty('continuedFrom')
    expect(eventTypes(begun.conversationId)).not.toContain('notice.raised')
  })

  it('opens an empty composer without claiming background when its parent is empty', async () => {
    const source = await runtime.startConversation({ projectId, agents: ['claude'] })
    const child = runtime.beginConversation({
      projectId,
      agents: ['claude'],
      continueFrom: source.conversationId,
      objective: 'Investigate API retries',
    })
    await runtime.awaitStart(child.conversationId)
    const events = runtime.store.read(child.conversationId)
    expect(
      events.find((entry) => entry.payload.type === 'conversation.created')?.payload
    ).not.toHaveProperty('continuedFrom')
    expect(
      events.some(
        (entry) => entry.payload.type === 'notice.raised' && entry.payload.code === 'contextCarried'
      )
    ).toBe(false)
    expect(
      runtime.activeSessions().find((room) => room.conversationId === child.conversationId)?.draft
    ).toBe('')
  })

  it('titles a forwarded selection by its first line without splitting its final emoji', async () => {
    const objective = `  \n  ${'x'.repeat(79)}🌍 trailing detail\nsecond line of the selection`
    const child = runtime.beginConversation({ projectId, agents: ['claude'], objective })
    await runtime.awaitStart(child.conversationId)
    expect(child.title).toBe(`${'x'.repeat(79)}🌍`)
    expect(Array.from(child.title)).toHaveLength(80)
    expect(child.title).not.toMatch(/[\uD800-\uDFFF]/u)
    expect(
      runtime.activeSessions().find((room) => room.conversationId === child.conversationId)?.draft
    ).toBe('')
  })

  it('anchors the selected messages of the parent and drops ids from anywhere else', async () => {
    const source = await runtime.startConversation({ projectId, agents: BOTH })
    const early = runtime.store.append({
      conversationId: source.conversationId,
      actor: 'user',
      payload: { type: 'user.message', text: 'Keep the bullet points on separate lines.' },
    })
    runtime.store.append({
      conversationId: source.conversationId,
      actor: 'codex',
      payload: {
        type: 'agent.message.completed',
        itemRef: 'later',
        text: 'Unrelated later reply.',
      },
    })
    const elsewhere = await runtime.startConversation({ projectId, agents: ['claude'] })
    const foreign = runtime.store.append({
      conversationId: elsewhere.conversationId,
      actor: 'user',
      payload: { type: 'user.message', text: 'Not part of the parent.' },
    })
    const child = runtime.beginConversation({
      projectId,
      agents: BOTH,
      continueFrom: source.conversationId,
      objective: 'Keep the bullet points on separate lines.',
      sourceEventIds: [early?.id ?? '', foreign?.id ?? '', early?.id ?? ''],
    })
    await runtime.awaitStart(child.conversationId)
    const created = runtime.store
      .read(child.conversationId)
      .find((entry) => entry.payload.type === 'conversation.created')
    expect(created?.payload).toMatchObject({ forward: { sourceEventIds: [early?.id] } })
  })

  it('continues with the source agent, title, profile, plan mode and answer style', async () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, styleOnByDefault: false })
    const source = await runtime.startConversation({
      projectId,
      agents: BOTH,
      title: 'Home comparison',
      profileId: 'workspace-write',
    })
    await runtime.send(source.conversationId, '@codex Remember the Home comparison.')
    await runtime.setAnswerStyle(source.conversationId, true)
    await runtime.setPlanMode(source.conversationId, true)
    const continued = await runtime.startConversation({
      projectId,
      agents: BOTH,
      continueFrom: source.conversationId,
      profileId: 'read-only',
    })
    expect(continued.title).toBe('Home comparison')
    expect(continued.profileId).toBe('workspace-write')
    expect(runtime.answerStyle(continued.conversationId)).toBe(true)
    expect(runtime.planning(continued.conversationId)).toBe(true)
    const result = await runtime.send(continued.conversationId, 'Continue the comparison.')
    expect(result.targets).toEqual(['codex'])
    const reader = runtime.store
      .read(continued.conversationId)
      .find(
        (event) => event.payload.type === 'session.started' && event.payload.agentId === 'codex'
      )
    const ref = reader?.payload.type === 'session.started' ? reader.payload.sessionRef : undefined
    const session = codex.sessions.find((candidate) => candidate.sessionRef === ref)
    expect(session?.permissionModes.at(-1)).toBe('plan')
    expect(session?.sent[0]?.text).toContain('Remember the Home comparison.')
  })

  it('refuses under the read-only flag before minting anything', () => {
    process.env['CHORUS_PROFILE_READONLY'] = '1'
    const before = runtime.store.lastSeq()

    expect(() => runtime.beginConversation({ projectId, agents: BOTH })).toThrow(
      /CHORUS_PROFILE_READONLY/
    )
    expect(runtime.activeSessions()).toEqual([])
    expect(runtime.store.lastSeq()).toBe(before)
  })

  it('answers the style captured when the room was opened', () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, styleOnByDefault: true })
    claude.hold()
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })

    expect(runtime.answerStyle(begun.conversationId)).toBe(true)
  })
})

describe('how a start ends', () => {
  it('fails with every reason when no agent starts, and gives the failure out once', async () => {
    claude.failure = new Error('claude fell over')
    codex.failure = new Error('codex fell over')
    const begun = runtime.beginConversation({ projectId, agents: BOTH })

    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'failed',
      message: 'claude fell over; codex fell over',
    })
    expect(runtime.activeSessions()).toEqual([])
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({ status: 'cancelled' })
  })

  it('keeps the agents that started and says why the other is missing', async () => {
    codex.failure = new Error('codex fell over')
    const begun = runtime.beginConversation({ projectId, agents: BOTH })

    expect(await runtime.awaitStart(begun.conversationId)).toMatchObject({
      status: 'ready',
      conversation: { participants: ['claude'] },
    })
    expect(
      runtime.store
        .read(begun.conversationId)
        .some(
          (event) =>
            event.payload.type === 'error.raised' && event.payload.message === 'codex fell over'
        )
    ).toBe(true)
  })

  it('answers an await that arrives after the start already settled', async () => {
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })
    await vi.waitFor(() => {
      expect(runtime.activeSessions()[0]?.starting).toBeUndefined()
    })

    expect(await runtime.awaitStart(begun.conversationId)).toMatchObject({
      status: 'ready',
      conversation: { conversationId: begun.conversationId, participants: ['claude'] },
    })
  })

  it('answers a late await for a failure, then forgets it', async () => {
    claude.failure = new Error('claude fell over')
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })
    await vi.waitFor(() => {
      expect(runtime.activeSessions()).toEqual([])
    })

    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'failed',
      message: 'claude fell over',
    })
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({ status: 'cancelled' })
  })

  it('keeps only the newest sixty-four unclaimed failures', async () => {
    claude.failure = new Error('claude fell over')
    const ids = Array.from(
      { length: 65 },
      () => runtime.beginConversation({ projectId, agents: ['claude'] }).conversationId
    )
    await vi.waitFor(() => {
      expect(runtime.activeSessions()).toEqual([])
    })

    expect(await runtime.awaitStart(ids[0] ?? '')).toEqual({ status: 'cancelled' })
    expect(await runtime.awaitStart(ids[1] ?? '')).toMatchObject({ status: 'failed' })
    expect(await runtime.awaitStart(ids[64] ?? '')).toMatchObject({ status: 'failed' })
  })

  it('closes a session whose attachment threw, once, and keeps the original error', async () => {
    const append = runtime.store.append.bind(runtime.store)
    vi.spyOn(runtime.store, 'append').mockImplementation((input, now) => {
      if (input.payload.type === 'session.started') throw new Error('the log fell over')
      return append(input, now)
    })
    const closes = vi.spyOn(FakeAgentSession.prototype, 'close')
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })

    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'failed',
      message: 'the log fell over',
    })
    expect(claude.sessions[0]?.closed).toBe(true)
    expect(closes).toHaveBeenCalledTimes(1)
    expect(runtime.activeSessions()).toEqual([])
  })

  it('closes the agents it started when preparing the room fails afterwards', async () => {
    codex.failure = new Error('codex fell over')
    const append = runtime.store.append.bind(runtime.store)
    vi.spyOn(runtime.store, 'append').mockImplementation((input, now) => {
      if (input.payload.type === 'error.raised') throw new Error('the log fell over')
      return append(input, now)
    })
    const begun = runtime.beginConversation({ projectId, agents: BOTH })

    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'failed',
      message: 'the log fell over',
    })
    await vi.waitFor(() => {
      expect(claude.sessions[0]?.closed).toBe(true)
    })
    expect(runtime.activeSessions()).toEqual([])
  })

  it('rolls back a room whose registration failed, and closes its agents', async () => {
    let armed = false
    runtime.onConversationsChanged(() => {
      if (!armed) return
      armed = false
      throw new Error('the listener fell over')
    })
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })
    armed = true

    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'failed',
      message: 'the listener fell over',
    })
    await vi.waitFor(() => {
      expect(claude.sessions[0]?.closed).toBe(true)
    })
    expect(runtime.activeSessions()).toEqual([])
    expect(readOpenProjects(dataPath).projects).toEqual([])
  })

  it('still resolves and rejects the awaited start the way existing callers expect', async () => {
    expect(await runtime.startConversation({ projectId, agents: ['claude'] })).toMatchObject({
      participants: ['claude'],
      projectId,
    })

    claude.failure = new Error('claude fell over')
    await expect(runtime.startConversation({ projectId, agents: ['claude'] })).rejects.toThrow(
      'claude fell over'
    )
  })
})

describe('closing a room that is still starting', () => {
  it('writes nothing and starts nothing when closed before preparation', async () => {
    const begun = runtime.beginConversation({ projectId, agents: BOTH })
    await runtime.closeConversation(begun.conversationId)
    await turn()
    await turn()

    expect(runtime.store.read(begun.conversationId)).toEqual([])
    expect(claude.starts + codex.starts).toBe(0)
    expect(runtime.activeSessions()).toEqual([])
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({ status: 'cancelled' })
  })

  it('closes started agents and waits for late startup cleanup', async () => {
    codex.hold()
    const begun = runtime.beginConversation({ projectId, agents: BOTH })
    await vi.waitFor(() => {
      expect(claude.sessions).toHaveLength(1)
    })
    await turn()
    await turn()

    const closing = runtime.closeConversation(begun.conversationId)
    await vi.waitFor(() => {
      expect(claude.sessions[0]?.closed).toBe(true)
    })
    expect(codex.sessions).toHaveLength(0)

    codex.release()
    await closing
    await vi.waitFor(() => {
      expect(codex.sessions[0]?.closed).toBe(true)
    })
    expect(claude.sessions).toHaveLength(1)
    expect(runtime.activeSessions()).toEqual([])
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({ status: 'cancelled' })
  })

  it('rejects the awaited start of a room closed while it was starting', async () => {
    claude.hold()
    const pending = runtime.startConversation({ projectId, agents: ['claude'] })
    const conversationId = runtime.activeSessions()[0]?.conversationId ?? ''
    const refused = expect(pending).rejects.toThrow(/closed before its agents started/)

    const closing = runtime.closeConversation(conversationId)
    claude.release()
    await closing
    await refused
  })

  it('cancels the starting rooms of a project that is forgotten', async () => {
    claude.hold()
    codex.hold()
    const begun = runtime.beginConversation({ projectId, agents: BOTH })
    await vi.waitFor(() => {
      expect(claude.starts + codex.starts).toBe(2)
    })

    await runtime.forgetProject(projectId)
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({ status: 'cancelled' })

    claude.release()
    codex.release()
    await vi.waitFor(() => {
      expect(claude.sessions[0]?.closed).toBe(true)
      expect(codex.sessions[0]?.closed).toBe(true)
    })
    expect(runtime.activeSessions()).toEqual([])
  })
})

describe('a room that is still starting, seen from elsewhere', () => {
  it('reopens without starting its agents a second time, and lists as open', async () => {
    claude.hold()
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })
    await vi.waitFor(() => {
      expect(claude.starts).toBe(1)
    })

    expect(await runtime.reopenConversation(begun.conversationId)).toMatchObject({
      conversationId: begun.conversationId,
      participants: [],
      starting: true,
    })
    expect(
      runtime
        .listConversations()
        .find((conversation) => conversation.conversationId === begun.conversationId)?.open
    ).toBe(true)

    claude.release()
    await runtime.awaitStart(begun.conversationId)
    expect(claude.starts).toBe(1)
  })

  it('refuses to move its project', () => {
    claude.hold()
    runtime.beginConversation({ projectId, agents: ['claude'] })

    expect(() => runtime.relocateProject(projectId, tmpdir())).toThrow(/open conversation/)
  })

  it('keeps a draft typed while starting, through to the reopen list', async () => {
    claude.hold()
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })
    runtime.rememberDraft(begun.conversationId, 'half a thought')
    expect(runtime.activeSessions()[0]?.draft).toBe('half a thought')

    claude.release()
    await runtime.awaitStart(begun.conversationId)
    expect(runtime.activeSessions()[0]?.draft).toBe('half a thought')
    expect(readOpenProjects(dataPath).projects[0]?.conversations[0]?.draft).toBe('half a thought')
  })
})

describe('shutting down while a room is starting', () => {
  it('waits a bounded time, then closes a late agent without registering it', async () => {
    codex.hold()
    runtime.beginConversation({ projectId, agents: BOTH })
    await vi.waitFor(() => {
      expect(claude.sessions).toHaveLength(1)
      expect(codex.starts).toBe(1)
    })

    const began = Date.now()
    await runtime.close()
    shutDown = true
    expect(Date.now() - began).toBeGreaterThanOrEqual(2_900)
    expect(claude.sessions[0]?.closed).toBe(true)
    expect(() => runtime.beginConversation({ projectId, agents: BOTH })).toThrow(/shutting down/)

    codex.release()
    await vi.waitFor(() => {
      expect(codex.sessions[0]?.closed).toBe(true)
    })
    expect(runtime.activeSessions()).toEqual([])
  }, 10_000)

  it('drops the writes of an agent whose cleanup finishes after the deadline', async () => {
    codex.hold()
    claude.holdClose()
    runtime.beginConversation({ projectId, agents: BOTH })
    await vi.waitFor(() => {
      expect(claude.sessions).toHaveLength(1)
      expect(codex.starts).toBe(1)
    })
    await turn()
    await turn()

    await runtime.close()
    shutDown = true
    expect(claude.sessions[0]?.closed).toBe(false)
    expect(runtime.store.droppedWrites()).toBe(0)

    claude.releaseClose()
    codex.release()
    await vi.waitFor(() => {
      expect(claude.sessions[0]?.closed).toBe(true)
      expect(codex.sessions[0]?.closed).toBe(true)
      expect(runtime.store.droppedWrites()).toBeGreaterThan(0)
    })
    expect(runtime.activeSessions()).toEqual([])
  }, 10_000)

  it('does not wait when nothing is starting', async () => {
    const began = Date.now()
    await runtime.close()
    shutDown = true
    expect(Date.now() - began).toBeLessThan(2_900)
  })

  it('skips the remaining saved rooms instead of failing the restore once quit begins', async () => {
    const saved = (conversationId: string): OpenConversation => ({
      conversationId,
      agents: ['claude'],
      profileId: 'read-only',
      title: conversationId,
      sessionRefs: {},
      lastSeenSeq: 0,
      draft: '',
    })
    writeOpenProjects(dataPath, {
      projects: [{ projectId, conversations: [saved('conv-1'), saved('conv-2')] }],
      workspace: null,
    })
    claude.hold()
    const restoring = runtime.restoreOpenConversations()
    await vi.waitFor(() => {
      expect(claude.starts).toBe(1)
    })

    const closing = runtime.close()
    shutDown = true
    claude.release()

    await expect(restoring).resolves.toMatchObject({ sessions: [] })
    await closing
    expect(claude.starts).toBe(1)
  })
})

describe('confirmed chat and project closure', () => {
  it('keeps a closing chat visible and single-flights until the provider exits', async () => {
    claude.holdClose()
    const room = await runtime.startConversation({ projectId, agents: ['claude'] })
    const closing = runtime.closeConversation(room.conversationId)
    expect(runtime.closeConversation(room.conversationId)).toBe(closing)
    await turn()
    expect(
      runtime.activeSessions().some((session) => session.conversationId === room.conversationId)
    ).toBe(true)
    await expect(runtime.send(room.conversationId, 'late message')).rejects.toThrow(/closing/)
    claude.releaseClose()
    await closing
    expect(runtime.activeSessions()).toEqual([])
    expect(claude.sessions[0]?.closed).toBe(true)
  })

  it('retains failed process cleanup for a retry', async () => {
    const room = await runtime.startConversation({ projectId, agents: ['claude'] })
    const session = claude.sessions[0]
    if (session === undefined) throw new Error('Missing fake session')
    const close = session.close.bind(session)
    let refuse = true
    session.close = async () => {
      if (refuse) throw new Error('owned child is still running')
      await close()
    }
    await expect(runtime.closeConversation(room.conversationId)).rejects.toThrow(
      /owned child is still running/
    )
    expect(runtime.activeSessions().map((session) => session.conversationId)).toContain(
      room.conversationId
    )
    refuse = false
    await runtime.closeConversation(room.conversationId)
    expect(runtime.activeSessions()).toEqual([])
  })

  it('keeps history and waits for editor cleanup before allowing a project to reopen', async () => {
    const room = await runtime.startConversation({ projectId, agents: ['claude'] })
    let release: () => void = () => undefined
    const editorExit = new Promise<void>((resolve) => {
      release = resolve
    })
    const closing = runtime.closeProject(projectId, () => editorExit)
    expect(() => runtime.beginConversation({ projectId, agents: ['claude'] })).toThrow(/closing/)
    await turn()
    release()
    await closing
    expect(runtime.projects.get(projectId)).not.toBeNull()
    expect(runtime.store.read(room.conversationId).length).toBeGreaterThan(0)
    expect(runtime.activeSessions()).toEqual([])
    await runtime.startConversation({ projectId, agents: ['claude'] })
    expect(runtime.activeSessions()).toHaveLength(1)
  })

  it('retains the project close barrier after editor shutdown fails', async () => {
    await runtime.startConversation({ projectId, agents: ['claude'] })
    await expect(
      runtime.closeProject(projectId, () =>
        Promise.reject(new Error('extension host still running'))
      )
    ).rejects.toThrow(/extension host still running/)
    expect(() => runtime.beginConversation({ projectId, agents: ['claude'] })).toThrow(/closing/)
    await runtime.closeProject(projectId, () => Promise.resolve())
    await runtime.startConversation({ projectId, agents: ['claude'] })
    expect(runtime.activeSessions()).toHaveLength(1)
  })

  it('reopens a closed project for its editor without starting a chat', async () => {
    await runtime.startConversation({ projectId, agents: ['claude'] })
    await runtime.closeProject(projectId, () => Promise.resolve())
    const alreadyClosed = vi.fn(() => Promise.resolve())
    await runtime.closeProject(projectId, alreadyClosed)
    expect(alreadyClosed).not.toHaveBeenCalled()
    const starts = claude.starts
    const listed = runtime.listConversations().length

    runtime.openProject(projectId)

    expect(claude.starts).toBe(starts)
    expect(runtime.activeSessions()).toEqual([])
    expect(runtime.listConversations()).toHaveLength(listed)
    const reopenedCleanup = vi.fn(() => Promise.resolve())
    await runtime.closeProject(projectId, reopenedCleanup)
    expect(reopenedCleanup).toHaveBeenCalledTimes(1)
  })

  it('refuses to reopen a project while its close is pending or has failed', async () => {
    await runtime.startConversation({ projectId, agents: ['claude'] })
    let release: () => void = () => undefined
    const editorExit = new Promise<void>((resolve) => {
      release = resolve
    })
    const closing = runtime.closeProject(projectId, () => editorExit)
    expect(() => {
      runtime.openProject(projectId)
    }).toThrow(/retry its close action/)
    await turn()
    release()
    await closing
    runtime.openProject(projectId)

    await runtime.startConversation({ projectId, agents: ['claude'] })
    await expect(
      runtime.closeProject(projectId, () =>
        Promise.reject(new Error('extension host still running'))
      )
    ).rejects.toThrow(/extension host still running/)
    expect(() => {
      runtime.openProject(projectId)
    }).toThrow(/retry its close action/)
    await runtime.closeProject(projectId, () => Promise.resolve())
    expect(() => {
      runtime.openProject(projectId)
    }).not.toThrow()
  })

  it('validates the project and the app before reopening anything', async () => {
    expect(() => {
      runtime.openProject('no-such-project')
    }).toThrow()
    await runtime.close()
    shutDown = true
    expect(() => {
      runtime.openProject(projectId)
    }).toThrow(/shutting down/)
  })

  it('keeps a closed project’s messages and reopens the same conversation, before and after a restart', async () => {
    const room = await runtime.startConversation({ projectId, agents: ['claude'] })
    const said = (type: 'user.message' | 'agent.message.completed'): string[] =>
      runtime.store
        .read(room.conversationId)
        .flatMap(({ payload }) =>
          (payload.type === 'user.message' || payload.type === 'agent.message.completed') &&
          payload.type === type
            ? [payload.text]
            : []
        )
    const listed = (): { projectId: string; open: boolean } | undefined =>
      runtime
        .listConversations()
        .find((conversation) => conversation.conversationId === room.conversationId)

    await runtime.send(room.conversationId, 'Fix the parser crash.')
    const session = claude.sessions[0]
    if (session === undefined) throw new Error('Missing fake session')
    session.emit({ type: 'turn.started', turnRef: 't1' })
    session.emit({ type: 'message.completed', itemRef: 'm1', text: 'Patched the parser.' })
    session.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await vi.waitFor(() => {
      expect(said('agent.message.completed')).toContain('Patched the parser.')
    })
    expect(said('user.message')).toContain('Fix the parser crash.')

    await runtime.closeProject(projectId, () => Promise.resolve())

    expect(runtime.activeSessions()).toEqual([])
    expect(runtime.projects.get(projectId)).not.toBeNull()
    expect(listed()).toMatchObject({ projectId, open: false })
    expect(said('user.message')).toContain('Fix the parser crash.')
    expect(said('agent.message.completed')).toContain('Patched the parser.')

    const starts = claude.starts
    const reopened = await runtime.reopenConversation(room.conversationId)
    expect(reopened).toMatchObject({ conversationId: room.conversationId, projectId })
    expect([...reopened.participants].sort()).toEqual([...BOTH].sort())
    expect(claude.starts).toBe(starts + 1)
    expect(listed()).toMatchObject({ projectId, open: true })
    expect(said('user.message')).toContain('Fix the parser crash.')
    expect(said('agent.message.completed')).toContain('Patched the parser.')

    await runtime.closeProject(projectId, () => Promise.resolve())
    await runtime.close()
    claude = new GatedAdapter({ id: 'claude' })
    codex = new GatedAdapter({ id: 'codex' })
    runtime = ChorusRuntime.open(
      dataPath,
      silent,
      new Map<AgentId, AgentAdapter>([
        ['claude', claude],
        ['codex', codex],
      ])
    )

    expect(runtime.projects.get(projectId)).not.toBeNull()
    expect(listed()).toMatchObject({ projectId, open: false })
    expect(said('user.message')).toContain('Fix the parser crash.')
    expect(said('agent.message.completed')).toContain('Patched the parser.')
    const restored = await runtime.reopenConversation(room.conversationId)
    expect(restored).toMatchObject({ conversationId: room.conversationId, projectId })
    expect([...restored.participants].sort()).toEqual([...BOTH].sort())
    expect(said('user.message')).toContain('Fix the parser crash.')
    expect(said('agent.message.completed')).toContain('Patched the parser.')
  })
})
