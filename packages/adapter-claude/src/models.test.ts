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
