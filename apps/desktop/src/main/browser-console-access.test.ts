import { testHostPorts } from './test-host-ports.js'
import type { AgentAdapter, BrowserConsoleAccess } from '@chorus/agent-protocol'
import { FakeAdapter } from '@chorus/orchestrator'
import { Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserConsoles } from './browser-console.js'
import { ChorusRuntime } from './runtime.js'

interface Ran {
  readonly projectId: string
  readonly actor: string
  readonly expression: string
}

let runtime: ChorusRuntime
let adapter: FakeAdapter
let conversationId: string
let projectId: string
let ran: Ran[]
let disposed: string[]

function fakeConsoles(): BrowserConsoles {
  return {
    read: (id: string) => JSON.stringify({ projectId: id, rows: [] }),
    run: (id: string, request: { readonly expression: string; readonly actor: string }) => {
      ran.push({ projectId: id, actor: request.actor, expression: request.expression })
      return Promise.resolve('{"status":"ok"}')
    },
    dispose: (id: string) => {
      disposed.push(id)
    },
  } as unknown as BrowserConsoles
}

async function browserAccess(): Promise<BrowserConsoleAccess> {
  await vi.waitFor(() => {
    expect(adapter.startedOpts.some((opts) => opts.browser !== undefined)).toBe(true)
  })
  const access = adapter.startedOpts.find((opts) => opts.browser !== undefined)?.browser
  if (access === undefined) throw new Error('The agent was started without Browser access')
  return access
}

function runner(access: BrowserConsoleAccess): NonNullable<BrowserConsoleAccess['run']> {
  const run = access.run
  if (run === undefined) throw new Error('The Work session was given read-only Browser access')
  return run
}

beforeEach(async () => {
  ran = []
  disposed = []
  adapter = new FakeAdapter({ id: 'claude' })
  runtime = ChorusRuntime.open(
    testHostPorts(mkdtempSync(join(tmpdir(), 'chorus-browser-console-'))),
    new Logger(),
    new Map<AgentId, AgentAdapter>([['claude', adapter]])
  )
  runtime.attachBrowserConsoles(fakeConsoles())
  const started = await runtime.startConversationIn({
    agents: ['claude'],
    cwd: process.cwd(),
    profileId: 'workspace-write',
  })
  conversationId = started.conversationId
  projectId = started.projectId
})

afterEach(async () => {
  await runtime.close()
})

describe('agent access to the project Browser Console', () => {
  it('runs in a writable Work conversation and tags the command with the agent', async () => {
    const run = runner(await browserAccess())
    await run({ expression: 'document.title', timeoutMs: 1_000 })
    expect(ran).toEqual([{ projectId, actor: 'claude', expression: 'document.title' }])
  })

  it('refuses at invocation once the project is made read-only', async () => {
    const run = runner(await browserAccess())
    runtime.setProjectProfile(projectId, 'read-only')
    await expect(run({ expression: '1', timeoutMs: 1_000 })).rejects.toThrow()
    runtime.setProfile(conversationId, 'workspace-write')
    await expect(run({ expression: '1', timeoutMs: 1_000 })).rejects.toThrow()
    expect(ran).toEqual([])
  })

  it('refuses while the conversation is planning', async () => {
    const run = runner(await browserAccess())
    await runtime.setPlanMode(conversationId, true)
    await expect(run({ expression: '1', timeoutMs: 1_000 })).rejects.toThrow()
    expect(ran).toEqual([])
  })

  it('refuses reads and runs from a conversation that has closed', async () => {
    const access = await browserAccess()
    const run = runner(access)
    await runtime.closeConversation(conversationId)
    await expect(run({ expression: '1', timeoutMs: 1_000 })).rejects.toThrow()
    await expect(access.read({ count: 10, skip: 0 })).rejects.toThrow()
    expect(ran).toEqual([])
  })

  it('disposes the project Console when the project is forgotten', async () => {
    await runtime.forgetProject(projectId)
    expect(disposed).toContain(projectId)
  })
})
