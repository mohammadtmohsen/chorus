import { describe, expect, it } from 'vitest'
import { toSandboxMode } from './codex-adapter.js'
import { mapApprovalRequest, mapNotification, toCodexDecision } from './mapping.js'

const CTX = { seq: 1, now: 1_000, approvalTtlMs: 60_000 }
const map = (method: string, params: unknown) => mapNotification({ method, params }, CTX)

describe('sandbox translation', () => {
  it('emits the kebab-case string enum thread/start actually accepts', () => {
    // The published docs describe an object with a camelCase `type`. That shape
    // is rejected outright — verified against the server in S3a.
    expect(toSandboxMode({ mode: 'readOnly', writableRoots: [], networkAccess: false })).toBe(
      'read-only'
    )
    expect(
      toSandboxMode({ mode: 'workspaceWrite', writableRoots: ['/x'], networkAccess: false })
    ).toBe('workspace-write')
    expect(toSandboxMode({ mode: 'fullAccess', writableRoots: [], networkAccess: true })).toBe(
      'danger-full-access'
    )
  })
})

describe('streaming', () => {
  it('maps an agent message delta', () => {
    expect(map('item/agentMessage/delta', { itemId: 'm1', delta: 'Hello' })).toMatchObject({
      type: 'message.delta',
      itemRef: 'm1',
      text: 'Hello',
      agentId: 'codex',
    })
  })

  it('maps both reasoning delta streams onto one event', () => {
    for (const method of ['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta']) {
      expect(map(method, { itemId: 'r1', delta: 'thinking' })).toMatchObject({
        type: 'reasoning.delta',
        itemRef: 'r1',
      })
    }
  })

  it('maps the aggregate turn diff Codex provides natively', () => {
    expect(map('turn/diff/updated', { unifiedDiff: '--- a\n+++ b\n' })).toMatchObject({
      type: 'diff.updated',
      unifiedDiff: '--- a\n+++ b\n',
    })
  })
})

describe('turn lifecycle', () => {
  it('reads the turn id out of the nested turn object', () => {
    expect(map('turn/started', { turn: { id: 't1' } })).toMatchObject({
      type: 'turn.started',
      turnRef: 't1',
    })
  })

  it('preserves an interrupted status', () => {
    // Codex reports this explicitly; Claude does not, which is why the
    // orchestrator tracks user-initiated stops separately (S3).
    expect(map('turn/completed', { turn: { id: 't1', status: 'interrupted' } })).toMatchObject({
      type: 'turn.completed',
      status: 'interrupted',
    })
  })

  it('treats an unknown terminal status as failed rather than completed', () => {
    expect(map('turn/completed', { turn: { id: 't1', status: 'exploded' } })).toMatchObject({
      status: 'failed',
    })
  })
})

describe('items', () => {
  it('emits command.started with the command and cwd', () => {
    const e = map('item/started', {
      item: { type: 'commandExecution', id: 'c1', command: ['git', 'status'], cwd: '/repo' },
    })
    expect(e).toMatchObject({
      type: 'command.started',
      itemRef: 'c1',
      command: ['git', 'status'],
      cwd: '/repo',
    })
  })

  it('normalizes a string command into argv form', () => {
    const e = map('item/started', {
      item: { type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/' },
    })
    expect(e).toMatchObject({ command: ['ls -la'] })
  })

  it('emits message.completed only on completion, never on start', () => {
    const item = { type: 'agentMessage', id: 'm1', text: 'done' }
    expect(map('item/started', { item })).toBeNull()
    expect(map('item/completed', { item })).toMatchObject({
      type: 'message.completed',
      text: 'done',
    })
  })

  it('maps a proposed file change with its patch', () => {
    const e = map('item/started', {
      item: { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts', diff: '@@' }] },
    })
    expect(e).toMatchObject({
      type: 'file.change.proposed',
      files: [{ path: 'a.ts', patch: '@@' }],
    })
  })
})

describe('deliberate silence', () => {
  it.each([
    'mcpServer/startupStatus/updated',
    'remoteControl/status/changed',
    'thread/status/changed',
    'account/updated',
  ])('drops %s rather than surfacing noise', (method) => {
    expect(map(method, {})).toBeNull()
  })

  it('drops an item type we do not render', () => {
    expect(map('item/started', { item: { type: 'userMessage', id: 'u1' } })).toBeNull()
  })

  it('drops an item notification with no item', () => {
    expect(map('item/completed', {})).toBeNull()
  })
})

describe('approval requests', () => {
  it('maps a command approval onto the unified card', () => {
    const r = mapApprovalRequest(
      'item/commandExecution/requestApproval',
      { itemId: 'i1', command: ['rm', '-rf', '/'], cwd: '/repo', reason: 'destructive' },
      CTX
    )
    expect(r).toMatchObject({
      kind: 'command',
      id: 'i1',
      command: ['rm', '-rf', '/'],
      cwd: '/repo',
      reason: 'destructive',
      agentId: 'codex',
    })
  })

  it('sets a deadline, because Codex imposes none', () => {
    // An unanswered requestApproval hangs the turn forever (plan §4.4).
    const r = mapApprovalRequest(
      'item/fileChange/requestApproval',
      { itemId: 'i2', changes: [] },
      CTX
    )
    expect(r?.expiresAt).toBe(CTX.now + CTX.approvalTtlMs)
  })

  it('maps a permission grant request', () => {
    const r = mapApprovalRequest(
      'item/permissions/requestApproval',
      { itemId: 'i3', cwd: '/repo', permissions: { filesystem: ['/tmp'], network: true } },
      CTX
    )
    expect(r).toMatchObject({
      kind: 'permissionGrant',
      requested: { filesystem: ['/tmp'], network: true },
    })
  })

  it('returns null for a request that is not an approval', () => {
    expect(mapApprovalRequest('tool/requestUserInput', {}, CTX)).toBeNull()
  })
})

describe('decision translation', () => {
  it('distinguishes once from session', () => {
    expect(toCodexDecision('allow', 'once')).toBe('accept')
    expect(toCodexDecision('allow', 'session')).toBe('acceptForSession')
  })

  it('fails closed on a timeout', () => {
    // An expired approval must never become an accept.
    expect(toCodexDecision('timeout', 'session')).toBe('decline')
    expect(toCodexDecision('deny', 'once')).toBe('decline')
  })

  it('passes cancel through distinctly from decline', () => {
    expect(toCodexDecision('cancel', 'once')).toBe('cancel')
  })
})
