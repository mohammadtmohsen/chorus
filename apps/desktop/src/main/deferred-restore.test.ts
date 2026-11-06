import { testHostPorts } from './test-host-ports.js'
import type { AgentAdapter, AgentSession, HealthStatus, SessionOpts } from '@chorus/agent-protocol'
import { FakeAdapter } from '@chorus/orchestrator'
import { Logger, newApprovalId, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readOpenProjects, writeOpenProjects, type OpenConversation } from './open-projects.js'
import { ChorusRuntime, NAMER_INSTRUCTIONS } from './runtime.js'

type FakeSession = FakeAdapter['sessions'][number]

const held = (): { readonly wait: Promise<void>; readonly release: () => void } => {
  let release: () => void = () => undefined
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

class GatedAdapter extends FakeAdapter {
  healthChecks = 0
  resumes = 0
  starts = 0
  unhealthy = false
  failModes = false
  refuseGated = false
  readonly modeRequests: string[] = []
  private readonly releases: (() => void)[] = []
  private resumeHold: Promise<void> = Promise.resolve()
  private modeHold: Promise<void> = Promise.resolve()

  gate(): () => void {
    const { wait, release } = held()
    this.resumeHold = wait
    this.releases.push(release)
    return release
  }

  holdModes(): () => void {
    const { wait, release } = held()
    this.modeHold = wait
    this.releases.push(release)
    return release
  }

  releaseAll(): void {
    for (const release of this.releases.splice(0)) release()
  }

  override health(): Promise<HealthStatus> {
    this.healthChecks += 1
    if (this.unhealthy) return Promise.resolve({ state: 'unavailable', reason: 'offline' })
    return super.health()
  }

  override start(opts: SessionOpts): Promise<AgentSession> {
    this.starts += 1
    return super.start(opts)
  }

  override resume(sessionRef: string, opts: SessionOpts): Promise<AgentSession> {
    this.resumes += 1
    const before = this.sessions.length
    const session = super.resume(sessionRef, opts)
    const created = this.sessions.length > before ? this.sessions.at(-1) : undefined
    if (created !== undefined) this.gateModes(created)
    return this.resumeHold.then(() =>
      this.refuseGated ? Promise.reject(new Error('the thread is gone')) : session
    )
  }

  private gateModes(session: FakeSession): void {
    const record = session.setPermissionMode.bind(session)
    session.setPermissionMode = async (mode: string): Promise<void> => {
      this.modeRequests.push(mode)
      await this.modeHold
      if (this.failModes) throw new Error('the mode was refused')
      await record(mode)
    }
  }
}

const silent = new Logger()
const CWD = process.cwd()

let dataPath: string
let claude: GatedAdapter
let codex: GatedAdapter
let runtime: ChorusRuntime
let projectId: string
let running = false

const boot = (deferRestoredAgents: boolean): void => {
  runtime = ChorusRuntime.open(
    testHostPorts(dataPath),
    silent,
    new Map<AgentId, AgentAdapter>([
      ['claude', claude],
      ['codex', codex],
    ]),
    { deferRestoredAgents }
  )
  projectId = runtime.projects.adopt(CWD).project.id
  running = true
}

const quit = async (): Promise<void> => {
  running = false
  await runtime.close()
}

beforeEach(() => {
  dataPath = mkdtempSync(join(tmpdir(), 'chorus-deferred-'))
  claude = new GatedAdapter({ id: 'claude' })
  codex = new GatedAdapter({ id: 'codex' })
  boot(true)
})

afterEach(async () => {
  vi.useRealTimers()
  claude.releaseAll()
  codex.releaseAll()
  if (running) await quit()
})

const saved = (over: Partial<OpenConversation> = {}): OpenConversation => ({
  conversationId: 'conv-1',
  agents: ['claude', 'codex'],
  profileId: 'read-only',
  title: 'a conversation',
  sessionRefs: { claude: 'thread-1', codex: 'thread-2' },
  lastSeenSeq: 0,
  draft: 'half a thought',
  ...over,
})

const restoreWith = (...conversations: OpenConversation[]) => {
  writeOpenProjects(dataPath, { projects: [{ projectId, conversations }], workspace: null })
  return runtime.restoreOpenConversations()
}

const persisted = (): OpenConversation | undefined =>
  readOpenProjects(dataPath).projects[0]?.conversations[0]

const own = (adapter: FakeAdapter): FakeSession[] =>
  adapter.sessions.filter((session) => session.startedWith?.instructions !== NAMER_INSTRUCTIONS)

const firstText = (adapter: FakeAdapter): string => own(adapter)[0]?.sent[0]?.text ?? ''

const said = (text: string): void => {
  runtime.store.append({
    conversationId: 'conv-1',
    actor: 'user',
    payload: { type: 'user.message', text },
  })
}

const settled = (work: Promise<unknown>): Promise<'started' | 'cancelled'> =>
  work.then(
    () => 'started' as const,
    () => 'cancelled' as const
  )

const until = async (ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 4_000
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  if (!ready()) throw new Error('the awaited state never arrived')
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve()
}

describe('deferred restore', () => {
  it('reopens a room without any provider work', async () => {
    const restored = await restoreWith(saved())
    expect(restored.sessions.map((session) => session.conversationId)).toEqual(['conv-1'])
    expect(claude.healthChecks + codex.healthChecks).toBe(0)
    expect([...claude.startedOpts, ...codex.startedOpts]).toEqual([])
    expect(claude.sessions.length + codex.sessions.length).toBe(0)
  })

  it('keeps the cast, the draft and the saved threads from the first write', async () => {
    const restored = await restoreWith(saved())
    expect(restored.sessions[0]?.participants).toEqual(['codex', 'claude', 'deepseek'])
    expect(restored.sessions[0]?.draft).toBe('half a thought')
    expect(runtime.openConversations()[0]?.participants).toEqual(['codex', 'claude', 'deepseek'])
    expect(persisted()?.agents).toEqual(['codex', 'claude'])
    expect(persisted()?.sessionRefs).toEqual({ claude: 'thread-1', codex: 'thread-2' })
  })

  it('sends an unaddressed first message to a resumed Claude that knows the team', async () => {
    said('an earlier question')
    await restoreWith(saved())
    await runtime.send('conv-1', 'where were we?')
    expect(own(claude).map((session) => session.sessionRef)).toEqual(['thread-1'])
    expect(own(codex)).toHaveLength(0)
    expect(firstText(claude)).toContain('Agents in this conversation: claude, codex, deepseek.')
    expect(firstText(claude)).toContain('where were we?')
    expect(firstText(claude)).not.toContain('an earlier question')
  })

  it('falls back to a fresh session that catches up when the saved thread is gone', async () => {
    said('an earlier question')
    claude.failResume = true
    await restoreWith(saved())
    await runtime.send('conv-1', '@claude hello again')
    const [fresh] = own(claude)
    expect(own(claude)).toHaveLength(1)
    expect(fresh?.sessionRef).not.toBe('thread-1')
    expect(firstText(claude)).toContain('an earlier question')
    expect(persisted()?.sessionRefs['claude']).toBe(fresh?.sessionRef)
  })

  it('restores bounded excerpts of its own replies after a missing-thread fallback', async () => {
    said('Keep the complete original requirements.')
    const fullReply = `OWN_HISTORY_BEGIN\n${'Earlier implementation detail.\n'.repeat(2500)}OWN_HISTORY_END`
    runtime.store.append({
      conversationId: 'conv-1',
      actor: 'claude',
      payload: { type: 'agent.message.completed', itemRef: 'earlier-work', text: fullReply },
    })
    claude.refuseResumeOnStream = true
    await restoreWith(saved())
    await runtime.send('conv-1', '@claude Continue the earlier work.', undefined, 'work')
    const fresh = own(claude).find((session) => session.sessionRef !== 'thread-1')
    expect(fresh?.sent[0]?.text).toContain('OWN_HISTORY_BEGIN')
    expect(fresh?.sent[0]?.text).toContain('OWN_HISTORY_END')
    expect(fresh?.sent[0]?.text).not.toContain(fullReply)
    expect(Buffer.byteLength(fresh?.sent[0]?.text ?? '', 'utf8')).toBeLessThanOrEqual(25_000)
    expect(fresh?.sent[0]?.text).toContain('Keep the complete original requirements.')
    expect(persisted()?.sessionRefs['claude']).toBe(fresh?.sessionRef)
  })

  it('recovers a late missing-session failure without logging the pending message twice', async () => {
    said('Remember that launch is Friday.')
    for (let index = 0; index < 7; index += 1) {
      said(`Release notes evidence ${String(index)}: ${'document '.repeat(170)}`)
    }
    runtime.store.append({
      conversationId: 'conv-1',
      actor: 'claude',
      payload: {
        type: 'agent.message.completed',
        itemRef: 'earlier-chat',
        text: 'We agreed to finish release notes first.',
        mode: 'discussion',
      },
    })
    await restoreWith(saved())
    await runtime.send('conv-1', '@claude Continue the release notes.', undefined, 'work')
    const stale = own(claude)[0]
    let usageReceived = false
    runtime.onContextUsageReported(() => {
      usageReceived = true
    })
    stale?.emit({
      type: 'context.usage',
      usedTokens: 65_000,
      maxTokens: 66_000,
      percentUsed: 98,
      autoCompactThreshold: null,
      autoCompactPercent: null,
      autoCompactEnabled: true,
    })
    await until(() => usageReceived)
    stale?.emit({ type: 'turn.started', turnRef: 'lost-turn' })
    stale?.emit({
      type: 'message.delta',
      itemRef: 'lost-partial',
      text: 'PARTIAL_OUTPUT_FROM_LOST_TURN',
    })
    stale?.emit({
      type: 'error',
      message: 'No conversation found with session ID: thread-1',
      recoverable: false,
    })
    await until(() => own(claude)[1]?.sent.length === 1)
    const fresh = own(claude)[1]
    expect(stale?.closed).toBe(true)
    expect(fresh?.sent[0]?.text).toContain('Remember that launch is Friday.')
    expect(fresh?.sent[0]?.text).toContain('We agreed to finish release notes first.')
    expect(fresh?.sent[0]?.text).toContain('Continue the release notes.')
    const prompt = fresh?.sent[0]?.text ?? ''
    expect(prompt.split('Continue the release notes.')).toHaveLength(2)
    expect(prompt).not.toContain('PARTIAL_OUTPUT_FROM_LOST_TURN')
    expect(prompt).toContain('read_transcript')
    expect(prompt).toContain('--- this conversation:')
    expect(prompt).not.toContain('authorize nothing now')
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(8_000)
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(24_000)
    expect(fresh?.transcriptTool).toBe('registered')
    expect(persisted()?.sessionRefs['claude']).toBe(fresh?.sessionRef)
    const events = runtime.store.read('conv-1')
    expect(
      events.filter(
        (event) =>
          event.payload.type === 'user.message' &&
          event.payload.text === '@claude Continue the release notes.'
      )
    ).toHaveLength(1)
    expect(
      events.filter(
        (event) =>
          event.payload.type === 'notice.raised' && event.payload.text.includes('Restoring claude')
      )
    ).toHaveLength(1)
    expect(
      events.some(
        (event) => event.payload.type === 'turn.completed' && event.payload.turnRef === 'lost-turn'
      )
    ).toBe(true)
  })

  it('rebuilds bounded Chat context with original history after quitting and reopening', async () => {
    said('The same conversation survives a relaunch.')
    const fullReply = `RELAUNCH_BEGIN\n${'Keep this implementation detail.\n'.repeat(2500)}RELAUNCH_END`
    runtime.store.append({
      conversationId: 'conv-1',
      actor: 'claude',
      payload: { type: 'agent.message.completed', itemRef: 'before-quit', text: fullReply },
    })
    await restoreWith(saved())
    await quit()
    boot(true)
    await runtime.restoreOpenConversations()
    await runtime.send('conv-1', '@claude Where were we?', undefined, 'discussion')
    await until(() =>
      claude.sessions.some(
        (session) =>
          session.startedWith?.instructions?.startsWith('You are in Discussion mode.') === true &&
          session.sent.length === 1
      )
    )
    const reader = claude.sessions.find(
      (session) =>
        session.startedWith?.instructions?.startsWith('You are in Discussion mode.') === true
    )
    expect(reader?.sent[0]?.text).toContain('RELAUNCH_BEGIN')
    expect(reader?.sent[0]?.text).toContain('RELAUNCH_END')
    expect(reader?.sent[0]?.text).not.toContain(fullReply)
    expect(
      reader?.startedWith?.transcript?.({ skip: 0, count: 1, query: 'RELAUNCH_BEGIN' })
    ).toContain('RELAUNCH_BEGIN')
    expect(reader?.sent[0]?.text).toContain('The same conversation survives a relaunch.')
    reader?.emit({
      type: 'message.completed',
      itemRef: 'after-reopen',
      text: 'The history is available.',
    })
    reader?.emit({ type: 'turn.completed', turnRef: 'after-reopen', status: 'completed' })
    await flush()
  })

  it('keeps the threads of agents not yet started, through a partial start and quit', async () => {
    await restoreWith(saved())
    await runtime.send('conv-1', '@claude only you')
    expect(persisted()?.sessionRefs).toEqual({ claude: 'thread-1', codex: 'thread-2' })
    await quit()
    expect([...(persisted()?.agents ?? [])].sort()).toEqual(['claude', 'codex'])
    expect(persisted()?.sessionRefs).toEqual({ claude: 'thread-1', codex: 'thread-2' })
  })

  it('keeps a failed start dormant, so the next message retries the saved thread', async () => {
    claude.unhealthy = true
    await restoreWith(saved())
    await runtime.send('conv-1', '@claude are you there?')
    expect(own(claude)).toHaveLength(0)
    expect(persisted()?.sessionRefs['claude']).toBe('thread-1')
    claude.unhealthy = false
    await runtime.send('conv-1', '@claude and now?')
    expect(own(claude).map((session) => session.sessionRef)).toEqual(['thread-1'])
  })

  it('carries full context to the first Work agent after restoring a Chat-only continuation', async () => {
    runtime.store.append({
      conversationId: 'parent-1',
      actor: 'user',
      payload: { type: 'conversation.created', projectId, title: 'the earlier room' },
    })
    runtime.store.append({
      conversationId: 'parent-1',
      actor: 'user',
      payload: { type: 'user.message', text: 'the launch is on Friday' },
    })
    runtime.store.append({
      conversationId: 'conv-1',
      actor: 'user',
      payload: {
        type: 'conversation.created',
        projectId,
        title: 'a conversation',
        continuedFrom: 'parent-1',
      },
    })
    runtime.store.append({
      conversationId: 'conv-1',
      actor: 'user',
      payload: { type: 'user.message', text: 'What did we decide?', mode: 'discussion' },
    })
    runtime.store.append({
      conversationId: 'conv-1',
      actor: 'claude',
      payload: {
        type: 'agent.message.completed',
        itemRef: 'discussion:earlier-answer',
        text: 'We agreed to finish the release notes first.',
        mode: 'discussion',
      },
    })
    await restoreWith(saved())
    await runtime.send('conv-1', '@claude pick it up')
    expect(firstText(claude)).toContain('the launch is on Friday')
    expect(firstText(claude)).toContain('We agreed to finish the release notes first.')
  })

  it('lets an aside be asked before anything is sent', async () => {
    await restoreWith(saved())
    const reply = runtime.store.append({
      conversationId: 'conv-1',
      actor: 'claude',
      payload: { type: 'agent.message.completed', itemRef: 'item-1', text: 'We ship on Friday.' },
    })
    await runtime.openAside({
      conversationId: 'conv-1',
      sourceEventId: reply?.id ?? '',
      excerpt: 'ship on Friday',
    })
    expect(claude.forked.map((fork) => fork.from)).toEqual(['thread-1'])
  })

  it('applies plan mode chosen before first use to the agent that starts', async () => {
    await restoreWith(saved())
    await runtime.setPlanMode('conv-1', true)
    await runtime.send('conv-1', '@claude plan it first')
    expect(own(claude)[0]?.permissionModes.at(-1)).toBe('plan')
    expect(own(claude)[0]?.sent).toHaveLength(1)
  })

  it('joins in the mode the room ends on when plan mode is toggled mid-start', async () => {
    await restoreWith(saved())
    await runtime.setPlanMode('conv-1', true)
    const release = claude.holdModes()
    const seating = settled(runtime.addParticipant('conv-1', 'claude'))
    await until(() => claude.modeRequests.length === 1)
    await runtime.setPlanMode('conv-1', false)
    release()
    expect(await seating).toBe('started')
    expect(claude.modeRequests).toEqual(['plan', 'default'])
    expect(own(claude)[0]?.permissionModes.at(-1)).toBe('default')
  }, 10_000)

  it('leaves an agent unseated, with its thread kept, when its mode cannot be set', async () => {
    await restoreWith(saved())
    await runtime.setPlanMode('conv-1', true)
    claude.failModes = true
    expect(await settled(runtime.addParticipant('conv-1', 'claude'))).toBe('cancelled')
    await until(() => own(claude)[0]?.closed === true)
    expect(persisted()?.sessionRefs['claude']).toBe('thread-1')
    claude.failModes = false
    await runtime.addParticipant('conv-1', 'claude')
    expect(own(claude).map((session) => session.sessionRef)).toEqual(['thread-1', 'thread-1'])
  }, 10_000)

  it('holds a starting agent to the profile the room switched to while it started', async () => {
    await restoreWith(saved({ profileId: 'workspace-write' }))
    const release = claude.gate()
    const seating = settled(runtime.addParticipant('conv-1', 'claude'))
    await until(() => own(claude).length === 1)
    runtime.setProfile('conv-1', 'read-only')
    release()
    expect(await seating).toBe('started')
    own(claude)[0]?.emit({
      type: 'approval.requested',
      request: {
        id: newApprovalId(),
        agentId: 'claude',
        kind: 'fileChange',
        files: [{ path: join(CWD, 'src', 'a.ts'), patch: '@@' }],
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    })
    await until(() => runtime.store.pendingDecisionIds('conv-1').pendingApprovalIds.length === 1)
    const outcomes = own(claude)[0]?.decisions.map((entry) => entry.decision.outcome)
    expect(outcomes).not.toContain('allow')
  })

  it('starts one session when two first uses race', async () => {
    await restoreWith(saved())
    const release = claude.gate()
    const first = runtime.addParticipant('conv-1', 'claude')
    const second = runtime.addParticipant('conv-1', 'claude')
    release()
    await Promise.all([first, second])
    expect(own(claude)).toHaveLength(1)
  })

  it('closes a session that arrives after its room was closed', async () => {
    await restoreWith(saved())
    const release = claude.gate()
    const seating = settled(runtime.addParticipant('conv-1', 'claude'))
    await until(() => own(claude).length === 1)
    const closing = runtime.closeConversation('conv-1')
    release()
    await closing
    expect(await seating).toBe('cancelled')
    await until(() => own(claude)[0]?.closed === true)
  })

  it('closes a session that arrives after quit began, and keeps its thread', async () => {
    await restoreWith(saved())
    const release = claude.gate()
    const seating = settled(runtime.addParticipant('conv-1', 'claude'))
    await until(() => own(claude).length === 1)
    const closing = quit()
    release()
    await closing
    expect(await seating).toBe('cancelled')
    expect(own(claude).map((session) => session.closed)).toEqual([true])
    expect(persisted()?.sessionRefs).toEqual({ claude: 'thread-1', codex: 'thread-2' })
  })

  it('forgets a saved thread that never answered, so the next use starts fresh', async () => {
    await restoreWith(saved())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    claude.gate()
    const first = settled(runtime.addParticipant('conv-1', 'claude'))
    await flush()
    expect(claude.resumes).toBe(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await first).toBe('cancelled')
    vi.useRealTimers()
    expect(persisted()?.sessionRefs['claude']).toBeUndefined()
    expect(persisted()?.sessionRefs['codex']).toBe('thread-2')
    expect(persisted()?.agents).toContain('claude')
    await runtime.addParticipant('conv-1', 'claude')
    expect(claude.resumes).toBe(1)
    expect(claude.starts).toBe(1)
    const [stale, fresh] = own(claude)
    claude.releaseAll()
    await until(() => stale?.closed === true)
    await runtime.send('conv-1', '@claude still there?')
    expect(fresh?.sent).toHaveLength(1)
    expect(fresh?.closed).toBe(false)
  }, 10_000)

  it('starts no fallback for a resume refused after its room closed', async () => {
    await restoreWith(saved())
    claude.gate()
    claude.refuseGated = true
    const seating = settled(runtime.addParticipant('conv-1', 'claude'))
    await until(() => claude.resumes === 1)
    const closing = runtime.closeConversation('conv-1')
    claude.releaseAll()
    await closing
    expect(await seating).toBe('cancelled')
    expect(claude.starts).toBe(0)
  })
})

describe('confirmed closure during provider replacement', () => {
  it('waits for a style respawn to release its old provider and starts no replacement', async () => {
    await restoreWith(saved())
    await runtime.addParticipant('conv-1', 'claude')
    const first = own(claude)[0]
    if (first === undefined) throw new Error('the first provider did not start')
    const gate = held()
    const close = first.close.bind(first)
    let closingOld = false
    first.close = async () => {
      closingOld = true
      await gate.wait
      await close()
    }
    try {
      const changing = settled(runtime.setAnswerStyle('conv-1', !runtime.answerStyle('conv-1')))
      await until(() => closingOld)
      let acknowledged = false
      const closing = runtime.closeProject(projectId).then(() => {
        acknowledged = true
      })
      await flush()
      expect(acknowledged).toBe(false)
      expect(first.closed).toBe(false)
      gate.release()
      await closing
      expect(await changing).toBe('cancelled')
      expect(first.closed).toBe(true)
      expect(own(claude)).toHaveLength(1)
      expect(runtime.activeSessions()).toEqual([])
    } finally {
      gate.release()
    }
  })

  it('closes ready and late providers when a history reopen races project closure', async () => {
    const room = await runtime.startConversation({ projectId, agents: ['claude', 'codex'] })
    await runtime.closeConversation(room.conversationId)
    const gate = held()
    const start = codex.start.bind(codex)
    codex.start = async (opts) => {
      const session = await start(opts)
      await gate.wait
      return session
    }
    try {
      const opening = settled(runtime.reopenConversation(room.conversationId))
      await until(() => own(claude).length === 2 && own(codex).length === 2)
      await until(
        () =>
          runtime.store
            .read(room.conversationId)
            .filter(
              (event) =>
                event.payload.type === 'session.started' && event.payload.agentId === 'claude'
            ).length === 2
      )
      let acknowledged = false
      const closing = runtime.closeProject(projectId).then(() => {
        acknowledged = true
      })
      await until(() => own(claude)[1]?.closed === true)
      expect(acknowledged).toBe(false)
      gate.release()
      await closing
      expect(await opening).toBe('cancelled')
      expect(own(claude)[1]?.closed).toBe(true)
      expect(own(codex)[1]?.closed).toBe(true)
      expect(runtime.activeSessions()).toEqual([])
    } finally {
      gate.release()
      codex.start = start
    }
  })
})

describe('default restore', () => {
  it('still starts every restored agent at once', async () => {
    await quit()
    boot(false)
    await restoreWith(saved())
    expect(own(claude).map((session) => session.sessionRef)).toEqual(['thread-1'])
    expect(own(codex).map((session) => session.sessionRef)).toEqual(['thread-2'])
    expect(claude.healthChecks).toBe(1)
  })
})
