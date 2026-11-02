import type { Options, PermissionResult, Query } from '@anthropic-ai/claude-agent-sdk'
import type { SessionOpts } from '@chorus/agent-protocol'
import { AsyncQueue, EMPTY_CONVERSATION_NOTE } from '@chorus/shared'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'

const BASE: SessionOpts = {
  cwd: process.cwd(),
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
  transcript: () => 'transcript',
  project: {
    terminal: () => Promise.resolve('terminal'),
    traffic: () => Promise.resolve('traffic'),
    request: () => Promise.resolve('request'),
  },
  progress: () => ({ ok: true, text: 'recorded' }),
  note: {
    read: () => EMPTY_CONVERSATION_NOTE,
    write: () => ({ status: 'saved', note: EMPTY_CONVERSATION_NOTE }),
  },
}

function harness(id: 'claude' | 'deepseek' = 'claude') {
  const opened: Options[] = []
  const adapter = new ClaudeAdapter({
    id,
    editorEdit: () => Promise.resolve({ ok: true, version: 1 }),
    createQuery: (options) => {
      opened.push(options)
      const messages = new AsyncQueue<unknown>()
      return {
        [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
        interrupt: () => Promise.resolve(undefined),
        setModel: () => Promise.resolve(),
        close: () => {
          messages.close()
        },
      } as unknown as Query
    },
  })
  const options = (): Options => {
    const latest = opened.at(-1)
    if (latest === undefined) throw new Error('No query was opened')
    return latest
  }
  return { adapter, options }
}

const ask = (options: Options, name: string): Promise<PermissionResult | null> => {
  const canUseTool = options.canUseTool
  if (canUseTool === undefined) throw new Error('No permission callback')
  return canUseTool(
    name,
    {},
    {
      signal: new AbortController().signal,
      toolUseID: `tool-${name}`,
      requestId: `request-${name}`,
    }
  )
}

describe('tool-free auxiliary sessions', () => {
  it('isolates Claude and DeepSeek from every configured tool and inherited hook', async () => {
    for (const id of ['claude', 'deepseek'] as const) {
      const target = harness(id)
      const session = await target.adapter.start({ ...BASE, toolPolicy: 'none' })
      try {
        expect(target.options(), id).toMatchObject({
          tools: [],
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          plugins: [],
          hooks: {},
          settings: { disableAllHooks: true },
          includeHookEvents: false,
        })
        expect(target.options().hooks, id).toEqual({})
        expect(Object.keys(target.options().mcpServers ?? {}), id).toEqual([])
        expect(session.transcriptTool, id).toBeUndefined()
      } finally {
        await target.adapter.dispose()
      }
    }
  })

  it('denies built-in and MCP calls even when their capabilities were supplied', async () => {
    const target = harness()
    await target.adapter.start({ ...BASE, toolPolicy: 'none' })
    try {
      for (const name of [
        'Read',
        'Bash',
        'Write',
        'Agent',
        'mcp__chorus_editor__editor_edit',
        'mcp__chorus_transcript__read_transcript',
        'mcp__chorus_project__read_terminal',
        'mcp__chorus_progress__report_progress',
        'mcp__chorus_note__read_note',
        'mcp__chorus_note__write_note',
        'mcp__external__write',
      ]) {
        expect(await ask(target.options(), name), name).toMatchObject({ behavior: 'deny' })
      }
    } finally {
      await target.adapter.dispose()
    }
  })

  it('releases closed auxiliary sessions while retaining ownership of an open one', async () => {
    const target = harness()
    const closed = []
    for (let index = 0; index < 3; index++) {
      const session = await target.adapter.start({ ...BASE, toolPolicy: 'none' })
      const close = vi.spyOn(session, 'close')
      await session.close()
      closed.push(close)
    }
    const active = await target.adapter.start({ ...BASE, toolPolicy: 'none' })
    const activeClose = vi.spyOn(active, 'close')
    await target.adapter.dispose()
    for (const close of closed) expect(close).toHaveBeenCalledTimes(1)
    expect(activeClose).toHaveBeenCalledTimes(1)
  })

  it('preserves normal tool inheritance and discussion inspection', async () => {
    const target = harness()
    try {
      await target.adapter.start(BASE)
      expect(target.options().tools).toBeUndefined()
      expect(target.options().settingSources).toBeUndefined()
      expect(target.options().strictMcpConfig).toBeUndefined()
      expect(Object.keys(target.options().mcpServers ?? {})).toEqual([
        'chorus_editor',
        'chorus_transcript',
        'chorus_project',
        'chorus_progress',
        'chorus_note',
      ])
      expect(target.options().hooks?.PostCompact).toBeDefined()

      await target.adapter.start({ ...BASE, toolPolicy: 'readOnly' })
      expect(target.options().tools).toEqual(['Read', 'Glob', 'Grep'])
      expect(target.options().hooks?.PreToolUse).toBeDefined()
      expect(Object.keys(target.options().mcpServers ?? {})).toEqual([
        'chorus_transcript',
        'chorus_project',
        'chorus_note',
      ])
      expect(await ask(target.options(), 'Read')).toMatchObject({ behavior: 'allow' })
      expect(await ask(target.options(), 'Write')).toMatchObject({ behavior: 'deny' })
    } finally {
      await target.adapter.dispose()
    }
  })
})
