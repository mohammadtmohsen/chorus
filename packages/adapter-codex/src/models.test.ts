import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './codex-adapter.js'
import type { Transport } from './transport.js'

/**
 * What Codex can be asked, and what it can be told.
 *
 * `C-012` assumed this needed a parser over `codex -m` help text. It does not:
 * `model/list` reports the catalogue and each model's own reasoning efforts.
 * What it does not have is anywhere to *put* an effort — that lives on
 * `turn/start`, per turn — which is why `setEffort` here means "remember it and
 * repeat it" rather than "tell the server".
 */

const CWD = mkdtempSync(join(tmpdir(), 'chorus-models-'))
const OPTS = {
  cwd: CWD,
  sandbox: { mode: 'readOnly' as const, writableRoots: [], networkAccess: false },
}

const model = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'gpt-5.1-codex',
  model: 'gpt-5.1-codex',
  displayName: 'GPT-5.1 Codex',
  description: 'the usual',
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'quick' },
    { reasoningEffort: 'high', description: 'slow' },
  ],
  ...over,
})

/**
 * A server whose `model/list` answers from `pages`, one page per call, and which
 * records every request so a turn's parameters can be inspected.
 */
function server(
  pages: Record<string, unknown>[][] = [[model()]],
  /*
   * Which `model/list` page answers with an error instead of data.
   *
   * Added because the test that claimed to cover a mid-catalogue failure passed
   * a *successful* empty page — so the failure path had no coverage at all, and
   * the adapter swallowing every error went unnoticed.
   */
  failAtPage?: number
): {
  adapter: CodexAdapter
  sent: () => Record<string, unknown>[]
} {
  const sent: Record<string, unknown>[] = []
  let onLine: ((line: string) => void) | null = null
  let page = 0

  const transport: Transport = {
    send: (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>
      sent.push(msg)
      const id = msg['id']
      if (typeof id !== 'number') return
      const reply = (result: unknown): void => {
        queueMicrotask(() => onLine?.(JSON.stringify({ id, result })))
      }
      switch (msg['method']) {
        case 'initialize':
          reply({ userAgent: 'fake' })
          break
        case 'thread/start':
          reply({ thread: { id: 'thr_1' }, model: 'fake' })
          break
        case 'model/list': {
          if (page === failAtPage) {
            queueMicrotask(() =>
              onLine?.(JSON.stringify({ id, error: { code: -32601, message: 'no such method' } }))
            )
            break
          }
          const data = pages[page] ?? []
          const more = page < pages.length - 1
          page++
          reply({ data, nextCursor: more ? `cursor-${String(page)}` : null })
          break
        }
        case 'turn/start':
          reply({ turn: { id: 'turn_1' } })
          break
        default:
          reply({})
      }
    },
    onLine: (h) => {
      onLine = h
    },
    onClose: () => undefined,
    onStderr: () => undefined,
    close: () => undefined,
  }

  return {
    adapter: new CodexAdapter({ now: () => 1_000, createTransport: () => transport }),
    sent: () => sent,
  }
}

const turns = (sent: Record<string, unknown>[]): Record<string, unknown>[] =>
  sent
    .filter((m) => m['method'] === 'turn/start')
    .map((m) => m['params'] as Record<string, unknown>)

describe('supportedModels', () => {
  it('reports the catalogue, with each model’s own efforts', async () => {
    const { adapter } = server()
    const session = await adapter.start(OPTS)
    expect(await session.supportedModels?.()).toEqual([
      {
        value: 'gpt-5.1-codex',
        label: 'GPT-5.1 Codex',
        effortLevels: ['low', 'high'],
        isDefault: true,
      },
    ])
  })

  it('uses `model` as the value, not `id`', async () => {
    // They come back identical from the live catalogue, so no run distinguishes
    // them. Codex's own model-override code uses `model` as the slug.
    const { adapter } = server([[model({ id: 'internal-id-42', model: 'gpt-5.1-codex' })]])
    const session = await adapter.start(OPTS)
    expect((await session.supportedModels?.())?.[0]?.value).toBe('gpt-5.1-codex')
  })

  it('follows the cursor, because one page is not the catalogue', async () => {
    const { adapter } = server([
      [model({ model: 'first' })],
      [model({ model: 'second' })],
      [model({ model: 'third' })],
    ])
    const session = await adapter.start(OPTS)
    expect((await session.supportedModels?.())?.map((m) => m.value)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('skips models the provider hides from its own picker', async () => {
    const { adapter } = server([
      [model({ model: 'shown' }), model({ model: 'gone', hidden: true })],
    ])
    const session = await adapter.start(OPTS)
    expect((await session.supportedModels?.())?.map((m) => m.value)).toEqual(['shown'])
  })

  it('falls back to the slug when there is no display name', async () => {
    const { adapter } = server([[model({ displayName: '' })]])
    const session = await adapter.start(OPTS)
    expect((await session.supportedModels?.())?.[0]?.label).toBe('gpt-5.1-codex')
  })

  it('omits effortLevels entirely for a model that reports none', async () => {
    // Absent rather than empty: `ModelChoice` treats a missing list as "no such
    // control", and an empty array would draw a select with nothing in it.
    const { adapter } = server([[model({ supportedReasoningEfforts: [] })]])
    const session = await adapter.start(OPTS)
    expect((await session.supportedModels?.())?.[0]).not.toHaveProperty('effortLevels')
  })

  it('keeps whatever pages arrived when a later one fails', async () => {
    // A catalogue that died on page two has still told us something truer than
    // an empty picker, so the pages that arrived are kept and not reported as a
    // failure.
    const { adapter } = server([[model({ model: 'first' })], [model({ model: 'second' })]], 1)
    const session = await adapter.start(OPTS)
    expect((await session.supportedModels?.())?.map((m) => m.value)).toEqual(['first'])
  })

  it('rejects when the very first page fails, rather than reporting no models', async () => {
    /*
     * The distinction the settings sheet is built on. Swallowing this returned
     * `[]`, which drew as "It offers no model choice" — a confident statement
     * about a request that never succeeded. The previous version of this test
     * passed a successful empty page, so it proved nothing.
     */
    const { adapter } = server([[model()]], 0)
    const session = await adapter.start(OPTS)
    await expect(session.supportedModels?.()).rejects.toThrow()
  })

  it('reports the model the provider calls its default', async () => {
    // Carried rather than inferred from row order: the renderer shows the
    // default's effort levels, and position is the provider's to change.
    const { adapter } = server([[model({ model: 'a', isDefault: false }), model({ model: 'b' })]])
    const session = await adapter.start(OPTS)
    const models = await session.supportedModels?.()
    expect(models?.find((m) => m.isDefault === true)?.value).toBe('b')
    expect(models?.[0]?.isDefault).toBeUndefined()
  })
})

describe('setEffort', () => {
  it('reaches the turn, since there is nowhere else to put it', async () => {
    const { adapter, sent } = server()
    const session = await adapter.start(OPTS)
    await session.setEffort?.('high')
    await session.send({ text: 'go' })
    expect(turns(sent())[0]?.['effort']).toBe('high')
  })

  it('carries to every later turn, not just the next one', async () => {
    // The failure this exists to stop: effort lives on `turn/start`, so a session
    // that applied it once would silently revert to the model's default.
    const { adapter, sent } = server()
    const session = await adapter.start(OPTS)
    await session.setEffort?.('low')
    await session.send({ text: 'one' })
    await session.send({ text: 'two' })
    expect(turns(sent()).map((t) => t['effort'])).toEqual(['low', 'low'])
  })

  it('sends no effort at all when none was chosen', async () => {
    // Absent, not empty: the model's own default is a real answer and must not
    // be overridden by a blank.
    const { adapter, sent } = server()
    const session = await adapter.start(OPTS)
    await session.send({ text: 'go' })
    expect(turns(sent())[0]).not.toHaveProperty('effort')
  })

  it('clears back to the provider default when set to empty', async () => {
    const { adapter, sent } = server()
    const session = await adapter.start(OPTS)
    await session.setEffort?.('high')
    await session.setEffort?.('')
    await session.send({ text: 'go' })
    expect(turns(sent())[0]).not.toHaveProperty('effort')
  })

  it('exists at all, so the supervisor does not optional-chain it away', () => {
    // `SupervisedSession.setEffort` calls `this.current.setEffort?.(level)`. With
    // no method here that is a silent no-op, and a chosen effort is saved,
    // displayed, and never sent.
    const { adapter } = server()
    return adapter.start(OPTS).then((session) => {
      expect(typeof session.setEffort).toBe('function')
    })
  })
})
