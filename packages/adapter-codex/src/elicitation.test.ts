import {
  CONFORMANCE_OPTS,
  collectEvents,
  type AgentSession,
  type ApprovalDecision,
  type ApprovalRequest,
} from '@chorus/agent-protocol'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './codex-adapter.js'
import type { JsonValue } from './generated/serde_json/JsonValue.js'
import type { ItemStartedNotification } from './generated/v2/ItemStartedNotification.js'
import type { McpServerElicitationRequestParams } from './generated/v2/McpServerElicitationRequestParams.js'
import type { McpToolCallStatus } from './generated/v2/McpToolCallStatus.js'
import type { ThreadItem } from './generated/v2/ThreadItem.js'
import { ELICITATION_METHOD } from './mapping.js'
import type { Transport } from './transport.js'

interface Wire {
  notify: (method: string, params: unknown) => void
  request: (id: number, method: string, params: unknown) => void
  kill: () => void
  sent: Record<string, unknown>[]
}

const MAIN = 'thr_main'
const WORKER = 'thr_worker'
const MESSAGE = 'Allow the jira MCP server to run tool "jira_get"?'
const TICKET = { issueIdOrKey: 'TPA-1021' }
const OPTS = { ...CONFORMANCE_OPTS, cwd: mkdtempSync(join(tmpdir(), 'chorus-elicitation-')) }
const RESULTS: Record<string, unknown> = {
  initialize: { userAgent: 'fake' },
  'thread/start': { thread: { id: MAIN }, model: 'fake-model' },
}

function fakeTransport(): { transport: Transport; wire: Wire } {
  let onLine: ((line: string) => void) | null = null
  let onClose: ((i: { code: number | null; signal: string | null }) => void) | null = null
  const sent: Record<string, unknown>[] = []

  const deliver = (message: unknown): void => {
    onLine?.(JSON.stringify(message))
  }

  const transport: Transport = {
    send: (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>
      sent.push(msg)
      const id = msg['id']
      const method = msg['method']
      if (typeof id !== 'number' || typeof method !== 'string') return
      const result = RESULTS[method] ?? {}
      queueMicrotask(() => {
        deliver({ id, result })
      })
    },
    onLine: (h) => {
      onLine = h
    },
    onClose: (h) => {
      onClose = h
    },
    onStderr: () => undefined,
    close: () => {
      onClose?.({ code: 0, signal: null })
    },
  }

  return {
    transport,
    wire: {
      notify: (method, params) => {
        deliver({ method, params })
      },
      request: (id, method, params) => {
        deliver({ id, method, params })
      },
      kill: () => {
        onClose?.({ code: 137, signal: 'SIGKILL' })
      },
      sent,
    },
  }
}

async function open(): Promise<{ session: AgentSession; wire: Wire }> {
  const wires: Wire[] = []
  const adapter = new CodexAdapter({
    now: () => 1_000,
    createTransport: () => {
      const { transport, wire } = fakeTransport()
      wires.push(wire)
      return transport
    },
  })
  const session = await adapter.start(OPTS)
  const wire = wires.at(-1)
  if (wire === undefined) throw new Error('no transport created')
  return { session, wire }
}

function mcpCall(
  id: string,
  tool: string,
  args: JsonValue,
  status: McpToolCallStatus = 'inProgress'
): ThreadItem {
  return {
    type: 'mcpToolCall',
    id,
    server: 'jira',
    tool,
    status,
    arguments: args,
    appContext: null,
    pluginId: null,
    readOnlyHint: null,
    result: null,
    error: null,
    durationMs: null,
  }
}

function started(threadId: string, item: ThreadItem): ItemStartedNotification {
  return { item, threadId, turnId: 'turn_1', startedAtMs: 1_000 }
}

function approval(
  threadId: string,
  meta: Record<string, JsonValue> = {}
): McpServerElicitationRequestParams {
  return {
    threadId,
    turnId: 'turn_1',
    serverName: 'jira',
    mode: 'form',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
      tool_params: TICKET,
      ...meta,
    },
    message: MESSAGE,
    requestedSchema: { type: 'object', properties: {} },
  }
}

async function nextApproval(session: AgentSession): Promise<ApprovalRequest> {
  for await (const event of session.events) {
    if (event.type === 'approval.requested') return event.request
  }
  throw new Error('the stream ended without an approval')
}

async function approvalsUntilEnd(session: AgentSession, wire: Wire): Promise<number> {
  wire.kill()
  const events = await collectEvents(session, 100)
  return events.filter((event) => event.type === 'approval.requested').length
}

function reply(wire: Wire, id: number): unknown {
  return wire.sent.find((m) => m['id'] === id && m['result'] !== undefined)?.['result']
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const CANCEL = { action: 'cancel', content: null, _meta: null }

describe('MCP tool approvals sent as elicitations', () => {
  it('shows an mcpToolCall card and holds the request open until the answer', async () => {
    const { session, wire } = await open()
    wire.notify('item/started', started(MAIN, mcpCall('call_1', 'jira_get', TICKET)))
    wire.request(7, ELICITATION_METHOD, approval(MAIN))

    const request = await nextApproval(session)
    expect(request).toMatchObject({
      kind: 'mcpToolCall',
      serverName: 'jira',
      toolName: 'jira_get',
      title: MESSAGE,
      input: TICKET,
    })
    await tick()
    expect(reply(wire, 7)).toBeUndefined()

    await session.respondToApproval(request.id, { outcome: 'allow', scope: 'once' })
    await tick()
    expect(reply(wire, 7)).toEqual({ action: 'accept', content: null, _meta: null })
  })

  it('matches the arguments whatever order their keys arrive in', async () => {
    const { session, wire } = await open()
    const args = { a: 1, b: { c: 2, d: 3 } }
    const reordered = { b: { d: 3, c: 2 }, a: 1 }
    wire.notify('item/started', started(MAIN, mcpCall('call_1', 'jira_get', args)))
    wire.request(7, ELICITATION_METHOD, approval(MAIN, { tool_params: reordered }))

    expect(await nextApproval(session)).toMatchObject({ toolName: 'jira_get' })
  })

  it.each<[string, ApprovalDecision, JsonValue, unknown]>([
    [
      'session, offered',
      { outcome: 'allow', scope: 'session' },
      ['session', 'always'],
      { action: 'accept', content: null, _meta: { persist: 'session' } },
    ],
    [
      'always, sent as session',
      { outcome: 'allow', scope: 'always' },
      ['session', 'always'],
      { action: 'accept', content: null, _meta: { persist: 'session' } },
    ],
    [
      'session, not offered',
      { outcome: 'allow', scope: 'session' },
      null,
      { action: 'accept', content: null, _meta: null },
    ],
    [
      'always, when only always is offered',
      { outcome: 'allow', scope: 'always' },
      'always',
      { action: 'accept', content: null, _meta: null },
    ],
    [
      'deny',
      { outcome: 'deny', message: 'no' },
      ['session', 'always'],
      { action: 'decline', content: null, _meta: null },
    ],
    ['cancel', { outcome: 'cancel' }, ['session', 'always'], CANCEL],
    [
      'timeout',
      { outcome: 'timeout' },
      ['session', 'always'],
      { action: 'decline', content: null, _meta: null },
    ],
  ])('answers %s with the typed elicitation response', async (_, decision, persist, expected) => {
    const { session, wire } = await open()
    wire.notify('item/started', started(MAIN, mcpCall('call_1', 'jira_get', TICKET)))
    wire.request(7, ELICITATION_METHOD, approval(MAIN, { persist }))

    const request = await nextApproval(session)
    await session.respondToApproval(request.id, decision)
    await tick()
    expect(reply(wire, 7)).toEqual(expected)
  })

  it('gives concurrent requests their own ids and answers only the one decided', async () => {
    const { session, wire } = await open()
    const search = { jql: 'project = TPA' }
    wire.notify('item/started', started(MAIN, mcpCall('call_1', 'jira_get', TICKET)))
    wire.notify('item/started', started(MAIN, mcpCall('call_2', 'jira_search', search)))
    wire.request(7, ELICITATION_METHOD, approval(MAIN))
    wire.request(8, ELICITATION_METHOD, approval(MAIN, { tool_params: search }))

    const first = await nextApproval(session)
    const second = await nextApproval(session)
    expect(first.id).not.toBe(second.id)
    expect(first).toMatchObject({ toolName: 'jira_get' })
    expect(second).toMatchObject({ toolName: 'jira_search' })

    await session.respondToApproval(second.id, { outcome: 'deny', message: 'no' })
    await tick()
    expect(reply(wire, 8)).toEqual({ action: 'decline', content: null, _meta: null })
    expect(reply(wire, 7)).toBeUndefined()

    await session.respondToApproval(first.id, { outcome: 'allow', scope: 'once' })
    await tick()
    expect(reply(wire, 7)).toEqual({ action: 'accept', content: null, _meta: null })
  })

  it('gives the same tool asked twice two distinct cards', async () => {
    const { session, wire } = await open()
    wire.notify('item/started', started(MAIN, mcpCall('call_1', 'jira_get', TICKET)))
    wire.request(7, ELICITATION_METHOD, approval(MAIN))
    wire.request(8, ELICITATION_METHOD, approval(MAIN))

    const first = await nextApproval(session)
    const second = await nextApproval(session)
    expect(first.id).not.toBe(second.id)
  })

  it('uses a tool name Codex supplies', async () => {
    const { session, wire } = await open()
    wire.request(7, ELICITATION_METHOD, approval(MAIN, { tool_name: 'jira_get' }))

    expect(await nextApproval(session)).toMatchObject({ toolName: 'jira_get' })
  })

  it.each<[string, ThreadItem[], string]>([
    ['no call is in flight', [], MAIN],
    ['the only call has finished', [mcpCall('call_1', 'jira_get', TICKET, 'completed')], MAIN],
    ['the arguments differ', [mcpCall('call_1', 'jira_get', { issueIdOrKey: 'TPA-1' })], MAIN],
    [
      'two tools share the arguments',
      [mcpCall('call_1', 'jira_get', TICKET), mcpCall('call_2', 'jira_comment', TICKET)],
      MAIN,
    ],
    ['the call belongs to another thread', [mcpCall('call_1', 'jira_get', TICKET)], WORKER],
  ])('cancels without a card when %s', async (_, items, requestThread) => {
    const { session, wire } = await open()
    for (const item of items) wire.notify('item/started', started(MAIN, item))
    wire.request(7, ELICITATION_METHOD, approval(requestThread))

    await tick()
    expect(reply(wire, 7)).toEqual(CANCEL)
    expect(await approvalsUntilEnd(session, wire)).toBe(0)
  })

  it('correlates a worker approval with the worker call', async () => {
    const { session, wire } = await open()
    wire.notify('item/started', started(WORKER, mcpCall('call_w', 'jira_get', TICKET)))
    wire.request(7, ELICITATION_METHOD, approval(WORKER))

    expect(await nextApproval(session)).toMatchObject({ toolName: 'jira_get' })
  })

  it('cancels a pending MCP approval on close and leaves a command approval alone', async () => {
    const { session, wire } = await open()
    wire.notify('item/started', started(MAIN, mcpCall('call_1', 'jira_get', TICKET)))
    wire.request(7, ELICITATION_METHOD, approval(MAIN))
    await nextApproval(session)
    wire.request(9, 'item/commandExecution/requestApproval', { itemId: 'cmd_1', command: 'ls' })
    await nextApproval(session)

    await session.close()
    await tick()
    expect(reply(wire, 7)).toEqual(CANCEL)
    expect(reply(wire, 9)).toBeUndefined()
  })

  it.each<[string, Partial<McpServerElicitationRequestParams>]>([
    ['URL mode', { mode: 'url', url: 'https://example.test/auth', elicitationId: 'e1' }],
    ['openai/form', { mode: 'openai/form' }],
    ['a form with no approval kind', { _meta: null }],
    ['another approval kind', { _meta: { codex_approval_kind: 'browser_auth', tool_name: 'x' } }],
  ])('cancels %s without a card', async (_, override) => {
    const { session, wire } = await open()
    wire.notify('item/started', started(MAIN, mcpCall('call_1', 'jira_get', TICKET)))
    wire.request(7, ELICITATION_METHOD, { ...approval(MAIN), ...override })

    await tick()
    expect(reply(wire, 7)).toEqual(CANCEL)
    expect(await approvalsUntilEnd(session, wire)).toBe(0)
  })
})
