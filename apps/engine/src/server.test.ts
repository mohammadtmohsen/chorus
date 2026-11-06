import { createConnection, type Socket } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeAdapter } from '@chorus/orchestrator'
import type { AgentAdapter } from '@chorus/agent-protocol'
import { newApprovalId, newUserInputId, type AgentId } from '@chorus/shared'
import { EventsPush, IPC_CONTRACT } from '../../desktop/src/shared/ipc.js'
import { BROWSER_CONTRACT } from '../../desktop/src/shared/browser-ipc.js'
import { NAMER_INSTRUCTIONS } from '../../desktop/src/main/runtime.js'
import { serveEngine } from './server.js'
import { ChromeProcess } from './chrome-process.js'
import { ClientState } from './state.js'
import { encodeFrame, FrameReader } from './wire.js'
import {
  PROTOCOL_VERSION,
  ServerMessage,
  type ClientMessage,
  type EngineDescriptor,
} from './protocol.js'

class Client {
  readonly socket: Socket
  readonly received: ServerMessage[] = []
  onMessage: ((message: ServerMessage) => void) | undefined
  hostAnswer: ((method: string, params: unknown) => Promise<unknown>) | undefined
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  readonly welcome: Promise<void>

  constructor(
    descriptor: EngineDescriptor,
    readonly id: string = randomUUID(),
    workspace = 'workspace-one',
    build = descriptor.build,
    token = descriptor.token,
    cold = false
  ) {
    this.socket = createConnection(descriptor.socketPath)
    this.welcome = new Promise((resolve, reject) => {
      this.socket.once('error', reject)
      const reader = new FrameReader((raw) => {
        const message = ServerMessage.parse(raw)
        this.received.push(message)
        this.onMessage?.(message)
        if (message.kind === 'welcome') resolve()
        else if (message.kind === 'answer') {
          const pending = this.pending.get(message.id)
          this.pending.delete(message.id)
          if (message.ok) pending?.resolve(message.value)
          else pending?.reject(new Error(message.error))
        } else if (message.kind === 'hostCall') {
          void (this.hostAnswer?.(message.method, message.params) ?? Promise.resolve(true)).then(
            (value) => {
              this.send({ kind: 'hostAnswer', id: message.id, ok: true, value })
            },
            (error: unknown) => {
              this.send({ kind: 'hostAnswer', id: message.id, ok: false, error: String(error) })
            }
          )
        }
      })
      this.socket.on('data', (data) => {
        reader.push(data)
      })
      this.socket.once('connect', () => {
        this.socket.write(
          encodeFrame({
            kind: 'hello',
            token,
            protocol: PROTOCOL_VERSION,
            build,
            runtimeVersion: descriptor.runtimeVersion,
            clientId: id,
            workspaceKey: workspace,
            workspaceFolders: [],
            trusted: true,
            secrets: {
              claude: null,
              codex: null,
              deepseek: null,
              typesafe: null,
              'completion-deepseek': null,
              'completion-codestral': null,
            },
            lastSeq: 0,
            cold,
          })
        )
      })
    })
  }

  async invoke(channel: string, request: unknown, id = randomUUID()): Promise<unknown> {
    await this.welcome
    return await this.request({ kind: 'invoke', id, channel, request })
  }
  send(message: ClientMessage): void {
    this.socket.write(encodeFrame(message))
  }
  request(message: Extract<ClientMessage, { id: string }>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject })
      this.socket.write(encodeFrame(message))
    })
  }
  async close(): Promise<void> {
    if (this.socket.destroyed) return
    await new Promise<void>((resolve) => {
      this.socket.once('close', resolve)
      this.socket.destroy()
    })
  }
}

let directory: string
let engine: Awaited<ReturnType<typeof serveEngine>>
let claude: FakeAdapter
let codex: FakeAdapter
let clients: Client[]

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'chorus-engine-test-'))
  claude = new FakeAdapter({ id: 'claude' })
  codex = new FakeAdapter({ id: 'codex' })
  engine = await serveEngine({
    dataDirectory: directory,
    build: 'test-build',
    adapters: new Map<AgentId, AgentAdapter>([
      ['claude', claude],
      ['codex', codex],
    ]),
  })
  clients = []
})
afterEach(async () => {
  for (const client of clients) await client.close()
  await engine.close()
})
const connect = async (id?: string, workspace?: string, build?: string): Promise<Client> => {
  const client = new Client(engine.descriptor, id, workspace, build)
  clients.push(client)
  await client.welcome
  return client
}
const room = async (client: Client, name: string) => {
  const requested = join(directory, name)
  mkdirSync(requested)
  const root = realpathSync(requested)
  const projectId = engine.runtime.projects.adopt(root).project.id
  const response = IPC_CONTRACT['conversation:begin'].response.parse(
    await client.invoke('conversation:begin', { projectId })
  )
  await client.invoke('conversation:awaitStart', { conversationId: response.conversationId })
  return { ...response, root }
}
const session = (conversationId: string, adapter = claude) =>
  adapter.sessions.find(
    (candidate) =>
      candidate.startedWith?.cwd === engine.runtime.agentDirectory(conversationId) &&
      candidate.startedWith.instructions !== NAMER_INSTRUCTIONS
  )

describe('engine socket and runtime', () => {
  it('routes editor reports and snapshots by project rather than the window workspace', async () => {
    const client = await connect()
    const a = await room(client, 'alpha')
    const b = await room(client, 'beta')
    const project = engine.runtime.projects.list().find((entry) => entry.canonicalRoot === a.root)
    if (project === undefined) throw new Error('missing project')
    client.send({
      kind: 'focus',
      viewVisible: true,
      focused: true,
      attentive: true,
      projectIds: [project.id],
      focusedProjectId: project.id,
      lastSeq: 0,
    })
    const context = {
      relativePath: 'buffer.ts',
      provenance: { kind: 'worktree' as const },
      scheme: 'file',
      editorTypeId: 'vscode.TextEditor',
      reason: 'ok' as const,
      startLine: 1,
      endLine: 1,
      isEmpty: false,
      isDirty: true,
      languageId: 'typescript',
      selectedBytes: 9,
      version: 3,
    }
    client.hostAnswer = (method, raw) => {
      if (method !== 'editor.snapshot') return Promise.resolve(true)
      const request = z.object({ place: z.object({ root: z.string() }) }).parse(raw)
      return Promise.resolve(
        request.place.root === a.root ? { ...context, text: 'selection' } : null
      )
    }
    client.send({ kind: 'editorContext', report: { host: '', projectRoot: a.root, context } })
    await vi.waitFor(() => {
      const pushes = client.received.filter(
        (message) => message.kind === 'push' && message.channel === 'ide:context'
      )
      expect(pushes).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            conversationId: a.conversationId,
            file: expect.objectContaining({ relativePath: 'buffer.ts' }),
          }),
        })
      )
      expect(pushes).not.toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            conversationId: b.conversationId,
            file: expect.anything(),
          }),
        })
      )
    })
    expect(await client.invoke('ide:snapshot', { conversationId: a.conversationId })).toMatchObject(
      { outcome: 'ok', text: 'selection', relativePath: 'buffer.ts' }
    )
    expect(
      await client.invoke('ide:snapshot', { conversationId: b.conversationId })
    ).not.toMatchObject({ outcome: 'ok' })
  })

  it('shares Browser box identity by project and requires peers to attach without starting Chrome', async () => {
    const startChrome = vi
      .spyOn(ChromeProcess.prototype, 'start')
      .mockRejectedValue(new Error('unexpected-browser-start'))
    try {
      const first = await connect()
      const a = await room(first, 'alpha')
      const b = await room(first, 'beta')
      const projectA = engine.runtime.projects
        .list()
        .find((entry) => entry.canonicalRoot === a.root)
      const projectB = engine.runtime.projects
        .list()
        .find((entry) => entry.canonicalRoot === b.root)
      if (projectA === undefined || projectB === undefined) throw new Error('missing project')
      const attached = BROWSER_CONTRACT['browser:attach'].response.parse(
        await first.invoke('browser:attach', { projectId: projectA.id })
      )
      const other = BROWSER_CONTRACT['browser:attach'].response.parse(
        await first.invoke('browser:attach', { projectId: projectB.id })
      )
      expect(other.browserId).not.toBe(attached.browserId)
      const second = await connect()
      await expect(
        second.invoke('browser:selection', { browserId: attached.browserId })
      ).rejects.toThrow()
      const shared = BROWSER_CONTRACT['browser:attach'].response.parse(
        await second.invoke('browser:attach', { projectId: projectA.id })
      )
      expect(shared.browserId).toBe(attached.browserId)
      expect(await second.invoke('browser:selection', { browserId: shared.browserId })).toEqual({
        text: '',
      })
      await second.close()
      const reconnected = await connect(second.id)
      await expect(
        reconnected.invoke('browser:selection', { browserId: shared.browserId })
      ).rejects.toThrow()
      expect(await reconnected.invoke('browser:attach', { projectId: projectA.id })).toMatchObject({
        browserId: attached.browserId,
      })
      expect(startChrome).not.toHaveBeenCalled()
    } finally {
      startChrome.mockRestore()
    }
  })

  it('streams reconnect history in bounded ordered batches while new events arrive', async () => {
    const first = await connect('replay-client')
    const a = await room(first, 'alpha')
    const b = await room(first, 'beta')
    await first.close()
    engine.runtime.store.appendMany(
      Array.from({ length: 240 }, (_, index) => ({
        conversationId: index % 2 === 0 ? a.conversationId : b.conversationId,
        actor: 'user' as const,
        payload: { type: 'user.message' as const, text: `${String(index)}:${'x'.repeat(10_000)}` },
      }))
    )
    const expected = new Set(
      engine.runtime.store
        .read(a.conversationId)
        .concat(engine.runtime.store.read(b.conversationId))
        .map((event) => event.seq)
    )
    let appended = false
    const second = new Client(engine.descriptor, 'replay-client')
    clients.push(second)
    second.onMessage = (message) => {
      if (appended || message.kind !== 'push' || message.channel !== 'conversation:events') return
      appended = true
      const event = engine.runtime.store.append({
        conversationId: a.conversationId,
        actor: 'user',
        payload: { type: 'user.message', text: 'live during reconnect' },
      })
      if (event === null) throw new Error('missing replay fixture event')
      expected.add(event.seq)
    }
    await second.welcome
    const pushes = () =>
      second.received.filter(
        (message): message is Extract<ServerMessage, { kind: 'push' }> =>
          message.kind === 'push' && message.channel === 'conversation:events'
      )
    await vi.waitFor(() => {
      expect(pushes().flatMap((message) => EventsPush.parse(message.payload))).toHaveLength(
        expected.size
      )
    })
    const seqs = pushes().flatMap((message) =>
      EventsPush.parse(message.payload).map((event) => event.seq)
    )
    expect(seqs).toEqual([...expected].sort((a, b) => a - b))
    expect(pushes().length).toBeGreaterThan(3)
    expect(
      pushes().every((message) => Buffer.byteLength(JSON.stringify(message)) < 513 * 1024)
    ).toBe(true)
  })

  it('lets a cold renderer use transcript pages without replaying old history', async () => {
    const first = await connect('cold-client')
    const started = await room(first, 'project')
    engine.runtime.store.append({
      conversationId: started.conversationId,
      actor: 'user',
      payload: { type: 'user.message', text: 'saved history' },
    })
    await first.close()
    const second = new Client(
      engine.descriptor,
      'cold-client',
      'workspace-one',
      engine.descriptor.build,
      engine.descriptor.token,
      true
    )
    clients.push(second)
    await second.welcome
    const restored = IPC_CONTRACT['conversation:restore'].response.parse(
      await second.invoke('conversation:restore', {})
    )
    expect(restored.sessions[0]?.conversationId).toBe(started.conversationId)
    const page = IPC_CONTRACT['conversation:transcript'].response.parse(
      await second.invoke('conversation:transcript', { conversationId: started.conversationId })
    )
    expect(page.events.some((event) => event.payload['text'] === 'saved history')).toBe(true)
    expect(
      second.received.some(
        (message) => message.kind === 'push' && message.channel === 'conversation:events'
      )
    ).toBe(false)
  })

  it('does not rewrite client layouts when reading transcripts', async () => {
    const first = await connect()
    const started = await room(first, 'project')
    const remember = vi.spyOn(ClientState.prototype, 'remember')
    try {
      await first.invoke('conversation:history', { conversationId: started.conversationId })
      await first.invoke('project:list', {})
      expect(remember).not.toHaveBeenCalled()
    } finally {
      remember.mockRestore()
    }
  })

  it('refuses unauthenticated invokes before touching the runtime', async () => {
    const socket = createConnection(engine.descriptor.socketPath)
    await new Promise<void>((resolve) => {
      socket.once('connect', () => {
        socket.write(
          encodeFrame({
            kind: 'invoke',
            id: 'unauthenticated',
            channel: 'project:list',
            request: {},
          })
        )
      })
      socket.once('close', resolve)
    })
    expect(engine.runtime.projects.list()).toEqual([])
  })

  it('exits after its idle grace period with no connected clients', async () => {
    await engine.close()
    engine = await serveEngine({ dataDirectory: directory, build: 'idle-build', idleTimeoutMs: 60 })
    const client = await connect()
    await client.close()
    await vi.waitFor(() => {
      expect(existsSync(join(directory, 'engine.json'))).toBe(false)
    })
  })

  it('counts native background work even after the foreground turn ends', async () => {
    const client = await connect()
    const started = await room(client, 'project')
    const running = session(started.conversationId)
    if (running === undefined) throw new Error('missing fake session')
    running.emit({ type: 'turn.started', turnRef: 'foreground' })
    running.emit({
      type: 'tasks.changed',
      tasks: [{ id: 'background', kind: 'shell', description: 'background task' }],
    })
    running.emit({ type: 'turn.completed', turnRef: 'foreground', status: 'completed' })
    await vi.waitFor(() => {
      expect(engine.runtime.activeWork().conversations).toContain(started.conversationId)
    })
    running.emit({ type: 'tasks.changed', tasks: [] })
    await vi.waitFor(() => {
      expect(engine.runtime.activeWork().conversations).not.toContain(started.conversationId)
    })
  })

  it('hands an agent reply to its named collaborator over the same socket-backed runtime', async () => {
    const client = await connect()
    const started = await room(client, 'project')
    await client.invoke('conversation:send', {
      conversationId: started.conversationId,
      text: '@claude inspect the project',
    })
    const lead = session(started.conversationId)
    lead?.emit({
      type: 'message.completed',
      itemRef: 'handoff',
      text: 'The directory is ready.\n\n@codex Continue the review.',
    })
    lead?.emit({ type: 'turn.completed', turnRef: 'handoff-turn', status: 'completed' })
    await vi.waitFor(() => {
      expect(session(started.conversationId, codex)?.sent[0]?.text).toContain(
        'Continue the review.'
      )
    })
  })

  it('keeps two project directories and window layouts separate', async () => {
    const first = await connect('one', 'workspace-one')
    const second = await connect('two', 'workspace-two')
    const a = await room(first, 'alpha')
    const b = await room(second, 'beta')
    expect(session(a.conversationId)?.startedWith?.cwd).toBe(a.root)
    expect(session(b.conversationId)?.startedWith?.cwd).toBe(b.root)
    const restoredA = IPC_CONTRACT['conversation:restore'].response.parse(
      await first.invoke('conversation:restore', {})
    )
    const restoredB = IPC_CONTRACT['conversation:restore'].response.parse(
      await second.invoke('conversation:restore', {})
    )
    expect(restoredA.sessions.map((entry) => entry.conversationId)).toEqual([a.conversationId])
    expect(restoredB.sessions.map((entry) => entry.conversationId)).toEqual([b.conversationId])
  })

  it('reattaches mid-turn without starting duplicate agents or losing pending decisions', async () => {
    const first = await connect('stable-client')
    const started = await room(first, 'project')
    const { conversationId } = started
    await first.invoke('conversation:send', { conversationId, text: '@claude report progress' })
    const running = session(conversationId)
    if (running === undefined) throw new Error('missing fake session')
    running.emit({ type: 'turn.started', turnRef: 'turn-one' })
    running.emit({ type: 'message.delta', text: 'still working', itemRef: 'reply' })
    const approval = newApprovalId()
    running.emit({
      type: 'approval.requested',
      request: {
        id: approval,
        agentId: 'claude',
        kind: 'mcpToolCall',
        serverName: 'fixture',
        toolName: 'wait',
        input: {},
        expiresAt: Date.now() + 60_000,
      },
    })
    await vi.waitFor(() => {
      expect(engine.runtime.activeWork().approvals).toBe(1)
    })
    const count = claude.sessions.length
    await first.close()
    const second = await connect('stable-client')
    for (let repetition = 0; repetition < 2; repetition += 1) {
      const restored = IPC_CONTRACT['conversation:restore'].response.parse(
        await second.invoke('conversation:restore', {})
      )
      expect(restored.sessions[0]?.pendingApprovalIds).toEqual([approval])
    }
    expect(claude.sessions).toHaveLength(count)
    expect(engine.runtime.activeWork().conversations).toContain(conversationId)
    expect(
      second.received.some(
        (message) => message.kind === 'push' && message.channel === 'conversation:events'
      )
    ).toBe(true)
    await second.invoke('approval:decide', {
      conversationId,
      agentId: 'claude',
      approvalId: approval,
      outcome: 'allow',
      scope: 'once',
    })
    expect(running.decisions[0]?.decision.outcome).toBe('allow')
    const question = newUserInputId()
    running.emit({
      type: 'userinput.requested',
      request: {
        id: question,
        agentId: 'claude',
        expiresAt: Date.now() + 60_000,
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question: 'Choose',
            options: [{ label: 'A', description: '' }],
            multiSelect: false,
            allowOther: true,
            isSecret: false,
          },
        ],
      },
    })
    await vi.waitFor(() => {
      expect(engine.runtime.activeWork().questions).toBe(1)
    })
    await second.invoke('userinput:answer', {
      conversationId,
      agentId: 'claude',
      userInputId: question,
      outcome: 'answered',
      answers: [{ questionId: 'choice', values: ['A'] }],
    })
    expect(running.userInputResponses[0]?.response.outcome).toBe('answered')
    await second.invoke('conversation:interrupt', { conversationId })
    expect(running.interruptRequested).toBe(true)
  })

  it('deduplicates retried commands after reconnect', async () => {
    const first = await connect('stable-client')
    const started = await room(first, 'project')
    const id = randomUUID()
    const request = { conversationId: started.conversationId, text: '@claude once only' }
    await first.invoke('conversation:send', request, id)
    await first.close()
    const second = await connect('stable-client')
    await second.invoke('conversation:send', request, id)
    expect(session(started.conversationId)?.sent).toHaveLength(1)
  })

  it('fences a second writer independently of build and keeps busy old builds usable', async () => {
    const first = await connect()
    const started = await room(first, 'project')
    await first.invoke('conversation:send', {
      conversationId: started.conversationId,
      text: '@claude wait',
    })
    session(started.conversationId)?.emit({ type: 'turn.started', turnRef: 'busy' })
    await vi.waitFor(() => {
      expect(engine.runtime.activeWork().busy).toBe(true)
    })
    await expect(serveEngine({ dataDirectory: directory, build: 'second-build' })).rejects.toThrow(
      'engine-lock-held'
    )
    const second = await connect('new-build', 'workspace-one', 'new-build')
    expect(second.received.some((message) => message.kind === 'restartRequired')).toBe(true)
    expect(
      IPC_CONTRACT['conversation:active'].response.parse(
        await second.invoke('conversation:active', {})
      ).sessions
    ).toHaveLength(1)
    expect(statSync(join(directory, 'engine.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(directory, 'engine-lock.sqlite')).mode & 0o777).toBe(0o600)
  })

  it('reopens saved rooms after the engine closes without starting providers eagerly', async () => {
    const first = await connect()
    const started = await room(first, 'project')
    const savedClient = join(
      directory,
      'clients',
      createHash('sha256').update('workspace-one').digest('hex'),
      'open-projects.json'
    )
    expect(JSON.parse(readFileSync(savedClient, 'utf8')) as unknown).toMatchObject({
      projects: [{ conversations: [{ conversationId: started.conversationId }] }],
    })
    await first.close()
    expect(
      engine.runtime.snapshotOpenProjects().projects[0]?.conversations[0]?.conversationId
    ).toBe(started.conversationId)
    await engine.close()
    expect(JSON.parse(readFileSync(savedClient, 'utf8')) as unknown).toMatchObject({
      projects: [{ conversations: [{ conversationId: started.conversationId }] }],
    })
    expect(
      JSON.parse(readFileSync(join(directory, 'engine-sessions.json'), 'utf8')) as unknown
    ).toMatchObject({ projects: [{ conversations: [{ conversationId: started.conversationId }] }] })
    const fresh = new FakeAdapter({ id: 'claude' })
    engine = await serveEngine({
      dataDirectory: directory,
      build: 'next-build',
      adapters: new Map<AgentId, AgentAdapter>([
        ['claude', fresh],
        ['codex', codex],
      ]),
    })
    expect([...new ClientState(directory, 'workspace-one').conversationIds]).toEqual([
      started.conversationId,
    ])
    const second = await connect()
    const restored = IPC_CONTRACT['conversation:restore'].response.parse(
      await second.invoke('conversation:restore', {})
    )
    expect(engine.runtime.activeSessions().map((entry) => entry.conversationId)).toEqual([
      started.conversationId,
    ])
    expect(restored.sessions[0]?.conversationId).toBe(started.conversationId)
    expect(fresh.sessions).toHaveLength(0)
  })
})
