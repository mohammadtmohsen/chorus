import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import type { SessionOpts } from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'

/**
 * The shapes here were read off the installed CLI, not out of the types.
 *
 * `supportsEffort` and `supportedEffortLevels` are separate fields, and the
 * levels are per model — which is why the picker reads them from the chosen row
 * rather than offering a fixed five everywhere.
 */

const OPTS: SessionOpts = {
  cwd: process.cwd(),
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
}

function adapterWith(over: Partial<Record<string, unknown>>): ClaudeAdapter {
  return new ClaudeAdapter({
    createQuery: (_options: Options) => {
      const messages = new AsyncQueue<unknown>()
      messages.close()
      return {
        [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
        interrupt: () => Promise.resolve(undefined),
        setModel: () => Promise.resolve(),
        close: () => undefined,
        ...over,
      } as unknown as Query
    },
  })
}

describe('supportedModels', () => {
  it('carries the effort levels a model reports', async () => {
    const session = await adapterWith({
      supportedModels: () =>
        Promise.resolve([
          {
            value: 'default',
            displayName: 'Default (recommended)',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ]),
    }).start(OPTS)

    expect(await session.supportedModels?.()).toEqual([
      {
        value: 'default',
        label: 'Default (recommended)',
        effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ])
  })

  it('offers no effort control for a model that does not support it', async () => {
    // The flag and the list are separate fields. Offering `max` on a model that
    // silently downgrades it would be a control that lies.
    const session = await adapterWith({
      supportedModels: () =>
        Promise.resolve([
          {
            value: 'small',
            displayName: 'Small',
            supportsEffort: false,
            supportedEffortLevels: [],
          },
        ]),
    }).start(OPTS)

    expect(await session.supportedModels?.()).toEqual([{ value: 'small', label: 'Small' }])
  })

  it('falls back to the id when the provider names nothing', async () => {
    const session = await adapterWith({
      supportedModels: () => Promise.resolve([{ value: 'opus[1m]' }]),
    }).start(OPTS)

    expect(await session.supportedModels?.()).toEqual([{ value: 'opus[1m]', label: 'opus[1m]' }])
  })

  it('drops a row with no id, which nothing could be set to', async () => {
    const session = await adapterWith({
      supportedModels: () => Promise.resolve([{ displayName: 'Nameless' }, { value: '' }]),
    }).start(OPTS)

    expect(await session.supportedModels?.()).toEqual([])
  })

  it('offers no choice at all when the CLI cannot be asked', async () => {
    // An older CLI has no such control, and a session must not fail because a
    // picker could not be populated.
    const session = await adapterWith({}).start(OPTS)
    expect(await session.supportedModels?.()).toEqual([])
  })

  it('survives a provider that answers with nonsense', async () => {
    const session = await adapterWith({
      supportedModels: () => Promise.resolve('not a list'),
    }).start(OPTS)
    expect(await session.supportedModels?.()).toEqual([])
  })
})

describe('setEffort', () => {
  it('goes through the flag-settings layer, which is where the CLI takes it', async () => {
    const applied: Record<string, unknown>[] = []
    const session = await adapterWith({
      applyFlagSettings: (settings: Record<string, unknown>) => {
        applied.push(settings)
        return Promise.resolve()
      },
    }).start(OPTS)

    await session.setEffort?.('xhigh')
    expect(applied).toEqual([{ effortLevel: 'xhigh' }])
  })

  it('does nothing on a CLI too old to have the control', async () => {
    const session = await adapterWith({}).start(OPTS)
    await expect(session.setEffort?.('high')).resolves.toBeUndefined()
  })
})

/**
 * MCP health, and why it is worth surfacing at all.
 *
 * `settingSources` is omitted so agents inherit the user's own servers — and
 * their failures. None is loud: a server needing authentication is not an error
 * and nothing retries it, so the only symptom is an agent quietly lacking a
 * capability you believe it has.
 */
describe('mcpServerStatus', () => {
  it('reports a server that needs authenticating, which is the silent one', async () => {
    const session = await adapterWith({
      mcpServerStatus: () => Promise.resolve([{ name: 'slack', status: 'needs-auth' }]),
    }).start(OPTS)

    expect(await session.mcpServerStatus?.()).toEqual([{ name: 'slack', status: 'needs-auth' }])
  })

  it('carries the reason a server failed, and how much a working one contributes', async () => {
    const session = await adapterWith({
      mcpServerStatus: () =>
        Promise.resolve([
          { name: 'broken', status: 'failed', error: 'spawn ENOENT' },
          { name: 'github', status: 'connected', tools: [{ name: 'a' }, { name: 'b' }] },
        ]),
    }).start(OPTS)

    expect(await session.mcpServerStatus?.()).toEqual([
      { name: 'broken', status: 'failed', error: 'spawn ENOENT' },
      { name: 'github', status: 'connected', tools: 2 },
    ])
  })

  it('reads an unfamiliar status as pending, which claims least', async () => {
    const session = await adapterWith({
      mcpServerStatus: () => Promise.resolve([{ name: 'odd', status: 'reticulating' }]),
    }).start(OPTS)

    expect(await session.mcpServerStatus?.()).toEqual([{ name: 'odd', status: 'pending' }])
  })

  it('drops a server with no name, which nothing could display', async () => {
    const session = await adapterWith({
      mcpServerStatus: () => Promise.resolve([{ status: 'connected' }]),
    }).start(OPTS)

    expect(await session.mcpServerStatus?.()).toEqual([])
  })

  it('offers nothing on a CLI that cannot be asked', async () => {
    const session = await adapterWith({}).start(OPTS)
    expect(await session.mcpServerStatus?.()).toEqual([])
  })
})
