import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NO_PROJECT_READER,
  NO_TRANSCRIPT_READER,
  type AgentEvent,
  type AgentSession,
  type ProjectReader,
  type SessionOpts,
  type TranscriptReader,
  type TranscriptRequest,
} from '@chorus/agent-protocol'
import { describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './codex-adapter.js'
import { mapNotification } from './mapping.js'
import type { Transport } from './transport.js'

const CWD = mkdtempSync(join(tmpdir(), 'chorus-project-tools-'))
const BASE: SessionOpts = {
  cwd: CWD,
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
}

describe('Tool-free session restrictions', () => {
  it.each(['start', 'resume', 'fork'] as const)(
    'refuses %s before starting an app-server',
    async (operation) => {
      const { adapter, connections } = fakeCodex()
      const opts: SessionOpts = { ...BASE, toolPolicy: 'none' }
      const opening =
        operation === 'start'
          ? adapter.start(opts)
          : operation === 'resume'
            ? adapter.resume('thr_existing', opts)
            : adapter.fork('thr_existing', { ...opts, inherits: 'config' })

      await expect(opening).rejects.toThrow(
        'Codex does not support tool-free sessions through this adapter.'
      )
      expect(connections).toEqual([])
    }
  )
})

describe('Discussion session restrictions', () => {
  it('disables inherited external tools and applies a read-only sandbox to every turn', async () => {
    const { adapter, connections } = fakeCodex((method) =>
      method === 'config/read'
        ? {
            result: {
              config: {
                mcp_servers: { external: {}, 'named.with.dots': {} },
                computer_use: {
                  macos: { bundle_ids: { 'com.apple.Terminal': 'allow' } },
                  windows: { aumids: { Editor: 'allow' } },
                },
              },
            },
          }
        : null
    )
    const session = await adapter.start({ ...BASE, toolPolicy: 'readOnly' })
    const start = requests(connections[0], 'thread/start')[0]
    expect(start).toMatchObject({
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
      ephemeral: true,
      config: {
        'features.apps': false,
        'features.plugins': false,
        'features.multi_agent': false,
        'features.hooks': false,
        'features.browser_use': false,
        'mcp_servers."external".enabled': false,
        'mcp_servers."named.with.dots".enabled': false,
        'computer_use.default_app_access': 'deny',
        'computer_use.macos.bundle_ids."com.apple.Terminal"': 'deny',
        'computer_use.windows.aumids."Editor"': 'deny',
      },
    })
    await session.send({ text: 'Explain the current implementation.' })
    await session.send({ text: 'Write docs/plans/feature.md.' })
    const turns = requests(connections[0], 'turn/start')
    expect(turns).toHaveLength(2)
    for (const turn of turns) {
      expect(turn).toMatchObject({
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'untrusted',
      })
    }
    await session.close()
  })

  it('refuses to open a discussion when inherited tool configuration cannot be inspected', async () => {
    const { adapter, connections } = fakeCodex((method) =>
      method === 'config/read'
        ? { error: { code: -32000, message: 'Configuration unavailable' } }
        : null
    )
    await expect(adapter.start({ ...BASE, toolPolicy: 'readOnly' })).rejects.toThrow(
      'Configuration unavailable'
    )
    expect(requests(connections[0], 'thread/start')).toHaveLength(0)
    expect(connections[0]?.closed).toBe(true)
  })
})

type Message = Record<string, unknown>

type Reply =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } }
  | { readonly exit: true }

interface Connection {
  readonly sent: Message[]
  closed: boolean
  push: (message: Message) => void
}

const ordinary = (method: string, params: Message): Reply => {
  switch (method) {
    case 'initialize':
      return { result: { userAgent: 'fake' } }
    case 'thread/start':
      return { result: { thread: { id: 'thr_new' } } }
    case 'thread/resume':
      return { result: { thread: { id: params['threadId'] } } }
    case 'thread/fork':
      return { result: { thread: { id: 'thr_branch' } } }
    default:
      return { result: {} }
  }
}

function fakeCodex(
  answer: (method: string, params: Message, attempt: number) => Reply | null = () => null
): { adapter: CodexAdapter; connections: Connection[] } {
  const connections: Connection[] = []
  const attempts = new Map<string, number>()
  const createTransport = (): Transport => {
    let onLine: ((line: string) => void) | null = null
    let onClose: ((info: { code: number | null; signal: string | null }) => void) | null = null
    const connection: Connection = {
      sent: [],
      closed: false,
      push: (message) => {
        onLine?.(JSON.stringify(message))
      },
    }
    connections.push(connection)
    return {
      send: (line) => {
        const message = JSON.parse(line) as Message
        connection.sent.push(message)
        const id = message['id']
        const method = message['method']
        if (typeof id !== 'number' || typeof method !== 'string') return
        const attempt = (attempts.get(method) ?? 0) + 1
        attempts.set(method, attempt)
        const params = (message['params'] ?? {}) as Message
        const reply = answer(method, params, attempt) ?? ordinary(method, params)
        queueMicrotask(() => {
          if ('exit' in reply) onClose?.({ code: 1, signal: null })
          else onLine?.(JSON.stringify({ id, ...reply }))
        })
      },
      onLine: (handler) => {
        onLine = handler
      },
      onClose: (handler) => {
        onClose = handler
      },
      onStderr: () => undefined,
      close: () => {
        connection.closed = true
      },
    }
  }
  return {
    adapter: new CodexAdapter({ now: () => 1_000, createTransport }),
    connections,
  }
}

const requests = (connection: Connection | undefined, method: string): Message[] =>
  (connection?.sent ?? [])
    .filter((message) => message['method'] === method)
    .map((message) => (message['params'] ?? {}) as Message)

const refusal = (message: string, code = -32600, data?: unknown): Reply => ({
  error: { code, message, ...(data === undefined ? {} : { data }) },
})

const TOOLS_GATED = 'thread/start.dynamicTools requires experimentalApi capability'
const UNKNOWN_TOOLS = 'Invalid request: unknown field `dynamicTools`, expected one of `model`'
const UNKNOWN_CAPABILITY =
  'Invalid request: unknown field `experimentalApi`, expected one of `optOutNotificationMethods`'

interface Read {
  readonly terminal: number[]
  readonly request: [string, string][]
}

const readerOf = (read: Read): ProjectReader => ({
  terminal: ({ lines }) => {
    read.terminal.push(lines)
    return Promise.resolve(`last ${String(lines)} lines`)
  },
  traffic: () => Promise.resolve('traffic'),
  request: ({ captureId, requestId }) => {
    read.request.push([captureId, requestId])
    return Promise.reject(new Error('That capture was cleared.'))
  },
})

const fresh = (): Read => ({ terminal: [], request: [] })

async function noticesOf(session: AgentSession): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  const iterator = session.events[Symbol.asyncIterator]()
  for (;;) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<'idle'>((resolve) => {
        setTimeout(() => {
          resolve('idle')
        }, 20)
      }),
    ])
    if (next === 'idle' || next.done === true) break
    out.push(next.value)
  }
  return out.filter((event) => event.type === 'notice')
}

const codeOf = (event: AgentEvent | undefined): string | undefined =>
  event?.type === 'notice' ? event.code : undefined

describe('registering the project tools', () => {
  it('asks for nothing experimental when the session has no reader', async () => {
    const { adapter, connections } = fakeCodex()
    const session = await adapter.start(BASE)
    expect(requests(connections[0], 'initialize')[0]?.['capabilities']).toEqual({})
    expect(requests(connections[0], 'thread/start')[0]).not.toHaveProperty('dynamicTools')
    expect(await noticesOf(session)).toEqual([])
  })

  it('opts into the experimental API and registers the namespace on thread/start', async () => {
    const { adapter, connections } = fakeCodex()
    const session = await adapter.start({ ...BASE, project: readerOf(fresh()) })
    expect(connections).toHaveLength(1)
    expect(requests(connections[0], 'initialize')[0]?.['capabilities']).toEqual({
      experimentalApi: true,
      requestAttestation: false,
    })
    const tools = requests(connections[0], 'thread/start')[0]?.['dynamicTools'] as Message[]
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ type: 'namespace', name: 'chorus_project' })
    expect((tools[0]?.['tools'] as Message[]).map((tool) => [tool['type'], tool['name']])).toEqual([
      ['function', 'read_terminal'],
      ['function', 'read_traffic'],
      ['function', 'read_request'],
    ])
    expect(session.sessionRef).toBe('thr_new')
    expect(await noticesOf(session)).toEqual([])
  })

  it('retries on a new connection when initialize refuses the capability as unknown', async () => {
    const { adapter, connections } = fakeCodex((method, _params, attempt) =>
      method === 'initialize' && attempt === 1 ? refusal(UNKNOWN_CAPABILITY) : null
    )
    const session = await adapter.start({ ...BASE, project: readerOf(fresh()) })
    expect(connections).toHaveLength(2)
    expect(connections[0]?.closed).toBe(true)
    expect(connections[1]?.closed).toBe(false)
    expect(requests(connections[0], 'thread/start')).toEqual([])
    expect(requests(connections[1], 'initialize')[0]?.['capabilities']).toEqual({})
    expect(requests(connections[1], 'thread/start')[0]).not.toHaveProperty('dynamicTools')
    const notices = await noticesOf(session)
    expect(notices.map(codeOf)).toEqual(['projectToolsUnavailable'])
    expect(notices[0]).toMatchObject({ level: 'warn', source: 'system' })
  })

  it('does not retry an initialize failure that is not an identified refusal', async () => {
    for (const reply of [
      refusal('server is shutting down'),
      refusal(UNKNOWN_CAPABILITY, -32602),
      refusal(UNKNOWN_CAPABILITY, -32603),
      refusal('Invalid request', -32600, { field: 'experimentalApi' }),
      refusal('experimentalApi is not supported'),
    ]) {
      const { adapter, connections } = fakeCodex((method) =>
        method === 'initialize' ? reply : null
      )
      await expect(adapter.start({ ...BASE, project: readerOf(fresh()) })).rejects.toThrow()
      expect(connections, JSON.stringify(reply)).toHaveLength(1)
      expect(connections[0]?.closed).toBe(true)
    }
  })

  it('closes the fallback connection when its own initialize fails', async () => {
    const { adapter, connections } = fakeCodex((method, _params, attempt) => {
      if (method !== 'initialize') return null
      return attempt === 1 ? refusal(UNKNOWN_CAPABILITY) : refusal('Server is draining')
    })
    await expect(adapter.start({ ...BASE, project: readerOf(fresh()) })).rejects.toThrow(/draining/)
    expect(connections).toHaveLength(2)
    expect(connections.map((connection) => connection.closed)).toEqual([true, true])
  })

  it('retries thread/start once without tools on either identified refusal', async () => {
    for (const message of [TOOLS_GATED, UNKNOWN_TOOLS]) {
      const { adapter, connections } = fakeCodex((method, _params, attempt) =>
        method === 'thread/start' && attempt === 1 ? refusal(message) : null
      )
      const session = await adapter.start({ ...BASE, project: readerOf(fresh()) })
      const starts = requests(connections[0], 'thread/start')
      expect(connections).toHaveLength(1)
      expect(starts, message).toHaveLength(2)
      expect(starts[0]).toHaveProperty('dynamicTools')
      expect(starts[1]).not.toHaveProperty('dynamicTools')
      expect(starts[1]?.['cwd']).toBe(CWD)
      expect(session.sessionRef).toBe('thr_new')
      expect(connections[0]?.closed).toBe(false)
      expect((await noticesOf(session)).map(codeOf)).toEqual(['projectToolsUnavailable'])
    }
  })

  it('never retries a thread/start failure that is not an identified refusal', async () => {
    const failures: Reply[] = [
      refusal('failed to persist dynamicTools metadata', -32603),
      refusal('Invalid request: dynamicTools[0].name must not be empty'),
      refusal(UNKNOWN_TOOLS, -32602),
      refusal(TOOLS_GATED, -32603),
      refusal('Invalid request', -32600, { field: 'dynamicTools', reason: TOOLS_GATED }),
      refusal('not signed in', -32000),
      refusal('model not found'),
      { exit: true },
    ]
    for (const reply of failures) {
      const { adapter, connections } = fakeCodex((method) =>
        method === 'thread/start' ? reply : null
      )
      await expect(adapter.start({ ...BASE, project: readerOf(fresh()) })).rejects.toThrow()
      expect(requests(connections[0], 'thread/start'), JSON.stringify(reply)).toHaveLength(1)
      expect(connections).toHaveLength(1)
      expect(connections[0]?.closed).toBe(true)
    }
  })

  it('fails the start, closing its connection, when the single fallback fails too', async () => {
    const { adapter, connections } = fakeCodex((method, _params, attempt) => {
      if (method !== 'thread/start') return null
      return attempt === 1 ? refusal(TOOLS_GATED) : refusal('failed to start thread', -32603)
    })
    await expect(adapter.start({ ...BASE, project: readerOf(fresh()) })).rejects.toThrow(
      /failed to start thread/
    )
    expect(requests(connections[0], 'thread/start')).toHaveLength(2)
    expect(connections[0]?.closed).toBe(true)
  })

  it('hands a successful connection to the session, which closes it when it closes', async () => {
    const { adapter, connections } = fakeCodex()
    const session = await adapter.start({ ...BASE, project: readerOf(fresh()) })
    expect(connections[0]?.closed).toBe(false)
    await session.close()
    expect(connections[0]?.closed).toBe(true)
  })
})

describe('resuming and forking with the project tools', () => {
  it('resumes the same thread with no tools sent, and says the tools are unconfirmed', async () => {
    const { adapter, connections } = fakeCodex()
    const session = await adapter.resume('thr_saved', { ...BASE, project: readerOf(fresh()) })
    expect(requests(connections[0], 'initialize')[0]?.['capabilities']).toMatchObject({
      experimentalApi: true,
    })
    const resumed = requests(connections[0], 'thread/resume')
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.['threadId']).toBe('thr_saved')
    expect(resumed[0]).not.toHaveProperty('dynamicTools')
    expect(requests(connections[0], 'thread/start')).toEqual([])
    expect(requests(connections[0], 'thread/fork')).toEqual([])
    expect(session.sessionRef).toBe('thr_saved')
    const notices = await noticesOf(session)
    expect(notices.map(codeOf)).toEqual(['projectToolsUnconfirmed'])
    expect(notices[0]).toMatchObject({ level: 'info', source: 'system' })
  })

  it('closes a reader-enabled connection whose resume or fork fails', async () => {
    const resumeFails = fakeCodex((method) =>
      method === 'thread/resume' ? refusal('no rollout found for thread id thr_saved') : null
    )
    await expect(
      resumeFails.adapter.resume('thr_saved', { ...BASE, project: readerOf(fresh()) })
    ).rejects.toThrow(/no rollout found/)
    expect(resumeFails.connections.map((connection) => connection.closed)).toEqual([true])

    const forkFails = fakeCodex((method) =>
      method === 'thread/fork' ? refusal('failed to fork', -32603) : null
    )
    await expect(
      forkFails.adapter.fork('thr_saved', {
        ...BASE,
        project: readerOf(fresh()),
        inherits: 'config',
      })
    ).rejects.toThrow(/failed to fork/)
    expect(forkFails.connections.map((connection) => connection.closed)).toEqual([true])
  })

  it('keeps the thread id through the initialize fallback, and says tools are gone', async () => {
    const { adapter, connections } = fakeCodex((method, _params, attempt) =>
      method === 'initialize' && attempt === 1 ? refusal(UNKNOWN_CAPABILITY) : null
    )
    const session = await adapter.resume('thr_saved', { ...BASE, project: readerOf(fresh()) })
    expect(connections).toHaveLength(2)
    expect(requests(connections[0], 'thread/resume')).toEqual([])
    expect(requests(connections[1], 'thread/resume')[0]?.['threadId']).toBe('thr_saved')
    expect(requests(connections[1], 'thread/start')).toEqual([])
    expect(session.sessionRef).toBe('thr_saved')
    expect((await noticesOf(session)).map(codeOf)).toEqual(['projectToolsUnavailable'])
  })

  it('says a fork may not carry the tools, since that is not established', async () => {
    const { adapter, connections } = fakeCodex()
    const session = await adapter.fork('thr_saved', {
      ...BASE,
      project: readerOf(fresh()),
      inherits: 'config',
      persist: true,
    })
    expect(requests(connections[0], 'thread/fork')[0]).not.toHaveProperty('dynamicTools')
    expect(session.sessionRef).toBe('thr_branch')
    const notices = await noticesOf(session)
    expect(notices.map(codeOf)).toEqual(['projectToolsUnconfirmed'])
    expect(notices[0]).toMatchObject({ level: 'info' })
  })

  it('announces nothing on a resume or fork without a reader', async () => {
    const { adapter, connections } = fakeCodex()
    const resumed = await adapter.resume('thr_saved', BASE)
    const forked = await adapter.fork('thr_saved', { ...BASE, inherits: 'config' })
    expect(requests(connections[0], 'initialize')[0]?.['capabilities']).toEqual({})
    expect(requests(connections[1], 'initialize')[0]?.['capabilities']).toEqual({})
    expect(await noticesOf(resumed)).toEqual([])
    expect(await noticesOf(forked)).toEqual([])
  })
})

describe('answering item/tool/call', () => {
  const call = async (
    project: ProjectReader | undefined,
    params: Message
  ): Promise<Record<string, unknown>> => {
    const { adapter, connections } = fakeCodex()
    await adapter.start(project === undefined ? BASE : { ...BASE, project })
    const connection = connections[0]
    if (connection === undefined) throw new Error('no connection')
    connection.push({ id: 9_001, method: 'item/tool/call', params })
    return vi.waitFor(() => {
      const reply = connection.sent.find(
        (message) => message['id'] === 9_001 && message['method'] === undefined
      )
      if (reply === undefined) throw new Error('not answered yet')
      return reply
    })
  }

  const valid = {
    threadId: 'thr_new',
    turnId: 'turn_1',
    callId: 'call_1',
    namespace: 'chorus_project',
    tool: 'read_terminal',
    arguments: { lines: 12 },
  }

  it('reads through the session reader and answers with the text', async () => {
    const read = fresh()
    const reply = await call(readerOf(read), valid)
    expect(reply['result']).toEqual({
      contentItems: [{ type: 'inputText', text: 'last 12 lines' }],
      success: true,
    })
    expect(read.terminal).toEqual([12])
  })

  it('refuses a call for another thread without reading', async () => {
    const read = fresh()
    const reply = await call(readerOf(read), { ...valid, threadId: 'thr_other' })
    expect(reply['result']).toMatchObject({ success: false })
    expect(read.terminal).toEqual([])
  })

  it('refuses another namespace, a missing namespace and an unknown tool', async () => {
    for (const params of [
      { ...valid, namespace: 'other' },
      { ...valid, namespace: null },
      { ...valid, tool: 'run' },
      { ...valid, tool: 7 },
    ]) {
      const read = fresh()
      const reply = await call(readerOf(read), params)
      expect(reply['result'], JSON.stringify(params)).toMatchObject({ success: false })
      expect(read.terminal).toEqual([])
    }
  })

  it('refuses invalid arguments with the validation message', async () => {
    const read = fresh()
    const reply = await call(readerOf(read), { ...valid, arguments: { lines: 0 } })
    const result = reply['result'] as { contentItems: { text: string }[]; success: boolean }
    expect(result.success).toBe(false)
    expect(result.contentItems[0]?.text).toMatch(/^Invalid arguments: /)
    expect(read.terminal).toEqual([])
  })

  it('reports a failed read as a failed call', async () => {
    const read = fresh()
    const reply = await call(readerOf(read), {
      ...valid,
      tool: 'read_request',
      arguments: { captureId: 'cap_old', requestId: 'req_1' },
    })
    expect(reply['result']).toEqual({
      contentItems: [{ type: 'inputText', text: 'That capture was cleared.' }],
      success: false,
    })
    expect(read.request).toEqual([['cap_old', 'req_1']])
  })

  it('fails a call to a session with no reader instead of answering empty', async () => {
    const reply = await call(undefined, valid)
    expect(reply['result']).toEqual({
      contentItems: [{ type: 'inputText', text: NO_PROJECT_READER }],
      success: false,
    })
  })
})

describe('dynamicToolCall items', () => {
  const CTX = { seq: 1, now: 1_000, approvalTtlMs: 60_000 }
  const item = (over: Message): Message => ({
    type: 'dynamicToolCall',
    id: 'call_7',
    namespace: 'chorus_project',
    tool: 'read_traffic',
    arguments: { count: 5 },
    status: 'inProgress',
    contentItems: null,
    success: null,
    durationMs: null,
    ...over,
  })
  const mapped = (method: string, over: Message = {}): AgentEvent | null =>
    mapNotification({ method, params: { item: item(over) } }, CTX)

  it('starts a tool row named by namespace and tool, with the arguments on one line', () => {
    expect(mapped('item/started')).toMatchObject({
      type: 'tool.started',
      itemRef: 'call_7',
      name: 'chorus_project.read_traffic',
      detail: '{"count":5}',
    })
  })

  it('names a tool without a namespace by itself, and bounds a long argument line', () => {
    const event = mapped('item/started', {
      namespace: null,
      arguments: { captureId: 'c'.repeat(300) },
    })
    expect(event).toMatchObject({ type: 'tool.started', name: 'read_traffic' })
    expect(event?.type === 'tool.started' ? event.detail?.length : 0).toBe(120)
  })

  it('completes ok only when the call completed and succeeded', () => {
    expect(mapped('item/completed', { status: 'completed', success: true })).toMatchObject({
      type: 'tool.completed',
      itemRef: 'call_7',
      status: 'ok',
    })
    for (const over of [
      { status: 'completed', success: false },
      { status: 'completed', success: null },
      { status: 'failed', success: true },
      { status: 'failed', success: false },
    ]) {
      expect(mapped('item/completed', over), JSON.stringify(over)).toMatchObject({
        type: 'tool.completed',
        status: 'error',
      })
    }
  })
})

describe('the chorus_transcript tool', () => {
  const history =
    (asked: TranscriptRequest[]): TranscriptReader =>
    (request) => {
      asked.push(request)
      return `history ${String(request.skip)}`
    }

  const answered = async (
    opts: SessionOpts,
    params: Message
  ): Promise<{ contentItems: { text: string }[]; success: boolean }> => {
    const { adapter, connections } = fakeCodex()
    await adapter.start(opts)
    const connection = connections[0]
    if (connection === undefined) throw new Error('no connection')
    connection.push({ id: 9_101, method: 'item/tool/call', params })
    const reply = await vi.waitFor(() => {
      const found = connection.sent.find(
        (message) => message['id'] === 9_101 && message['method'] === undefined
      )
      if (found === undefined) throw new Error('not answered yet')
      return found
    })
    return reply['result'] as { contentItems: { text: string }[]; success: boolean }
  }

  const transcriptCall = {
    threadId: 'thr_new',
    turnId: 'turn_1',
    callId: 'call_1',
    namespace: 'chorus_transcript',
    tool: 'read_transcript',
  }

  it('registers the namespace beside the project tools and reports it registered', async () => {
    const { adapter, connections } = fakeCodex()
    const session = await adapter.start({
      ...BASE,
      project: readerOf(fresh()),
      transcript: history([]),
    })
    const tools = requests(connections[0], 'thread/start')[0]?.['dynamicTools'] as Message[]
    expect(tools.map((tool) => tool['name'])).toEqual(['chorus_project', 'chorus_transcript'])
    expect((tools[1]?.['tools'] as Message[]).map((tool) => [tool['type'], tool['name']])).toEqual([
      ['function', 'read_transcript'],
    ])
    expect(session.transcriptTool).toBe('registered')
    expect(await noticesOf(session)).toEqual([])
  })

  it('opts into the experimental API for a transcript reader alone', async () => {
    const { adapter, connections } = fakeCodex()
    const session = await adapter.start({ ...BASE, transcript: history([]) })
    expect(requests(connections[0], 'initialize')[0]?.['capabilities']).toEqual({
      experimentalApi: true,
      requestAttestation: false,
    })
    const tools = requests(connections[0], 'thread/start')[0]?.['dynamicTools'] as Message[]
    expect(tools.map((tool) => tool['name'])).toEqual(['chorus_transcript'])
    expect(session.transcriptTool).toBe('registered')
    expect(await noticesOf(session)).toEqual([])
  })

  it('says the tool is unavailable when the provider refuses dynamic tools', async () => {
    for (const message of [TOOLS_GATED, UNKNOWN_TOOLS]) {
      const { adapter, connections } = fakeCodex((method, _params, attempt) =>
        method === 'thread/start' && attempt === 1 ? refusal(message) : null
      )
      const session = await adapter.start({ ...BASE, transcript: history([]) })
      const starts = requests(connections[0], 'thread/start')
      expect(starts, message).toHaveLength(2)
      expect(starts[1]).not.toHaveProperty('dynamicTools')
      expect(session.transcriptTool).toBe('unavailable')
      expect(await noticesOf(session)).toEqual([])
    }
  })

  it('says unavailable after the initialize fallback, and unconfirmed on resume and fork', async () => {
    const refused = fakeCodex((method, _params, attempt) =>
      method === 'initialize' && attempt === 1 ? refusal(UNKNOWN_CAPABILITY) : null
    )
    const fallback = await refused.adapter.start({ ...BASE, transcript: history([]) })
    expect(requests(refused.connections[1], 'thread/start')[0]).not.toHaveProperty('dynamicTools')
    expect(fallback.transcriptTool).toBe('unavailable')

    const { adapter } = fakeCodex()
    const resumed = await adapter.resume('thr_saved', { ...BASE, transcript: history([]) })
    expect(resumed.transcriptTool).toBe('unconfirmed')
    const forked = await adapter.fork('thr_saved', {
      ...BASE,
      transcript: history([]),
      inherits: 'config',
    })
    expect(forked.transcriptTool).toBe('unconfirmed')
  })

  it('leaves the state unset for a session with no reader', async () => {
    const { adapter } = fakeCodex()
    expect((await adapter.start(BASE)).transcriptTool).toBeUndefined()
  })

  it('answers through the reader with every field it parsed', async () => {
    const asked: TranscriptRequest[] = []
    const result = await answered(
      { ...BASE, transcript: history(asked) },
      {
        ...transcriptCall,
        arguments: {
          query: 'retry',
          eventId: 'evt-1',
          offset: 4_096,
          scope: 'updates',
          conversationId: 'conv-1',
        },
      }
    )
    expect(result).toEqual({
      contentItems: [{ type: 'inputText', text: 'history 0' }],
      success: true,
    })
    expect(asked).toEqual([
      {
        skip: 0,
        count: 20,
        conversationId: 'conv-1',
        query: 'retry',
        eventId: 'evt-1',
        offset: 4_096,
        scope: 'updates',
      },
    ])
  })

  it('refuses invalid arguments without reading', async () => {
    for (const args of [{ count: 0 }, { scope: 'everything' }, { pattern: '.*' }]) {
      const asked: TranscriptRequest[] = []
      const result = await answered(
        { ...BASE, transcript: history(asked) },
        { ...transcriptCall, arguments: args }
      )
      expect(result.success, JSON.stringify(args)).toBe(false)
      expect(result.contentItems[0]?.text).toMatch(/^Invalid arguments: /)
      expect(asked).toEqual([])
    }
  })

  it('fails a transcript call on a session with no transcript reader', async () => {
    const result = await answered(
      { ...BASE, project: readerOf(fresh()) },
      { ...transcriptCall, arguments: {} }
    )
    expect(result).toEqual({
      contentItems: [{ type: 'inputText', text: NO_TRANSCRIPT_READER }],
      success: false,
    })
  })

  it('still routes project calls on a session that has both readers', async () => {
    const read = fresh()
    const result = await answered(
      { ...BASE, project: readerOf(read), transcript: history([]) },
      {
        ...transcriptCall,
        namespace: 'chorus_project',
        tool: 'read_terminal',
        arguments: { lines: 3 },
      }
    )
    expect(result).toEqual({
      contentItems: [{ type: 'inputText', text: 'last 3 lines' }],
      success: true,
    })
    expect(read.terminal).toEqual([3])
  })
})
