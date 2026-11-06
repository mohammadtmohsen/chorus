import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CompletionClient,
  isCompletionPayload,
  type CompletionSecretId,
} from './completion-core.js'
import { DEFAULT_SETTINGS, writeSettings } from './settings.js'
import type { CompletionPayload } from '../shared/workbench-ipc.js'

const payload: CompletionPayload = {
  prefix: 'const result = ',
  suffix: '\n',
  languageId: 'typescript',
  path: 'src/example.ts',
  context: [{ text: 'declare const answer: number', path: 'src/types.ts' }],
}

function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'chorus-completion-core-'))
  const keys: Partial<Record<CompletionSecretId, string>> = {}
  const readSecret = vi.fn((_directory: string, id: CompletionSecretId) => keys[id] ?? null)
  const client = new CompletionClient(userData, readSecret)
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  return { userData, keys, readSecret, client, fetcher }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the host-independent completion client', () => {
  it('selects DeepSeek first in auto mode and preserves its request and response shape', async () => {
    const { client, keys, readSecret, fetcher } = fixture()
    keys['completion-deepseek'] = 'fixture-deepseek'
    keys['completion-codestral'] = 'fixture-codestral'
    fetcher.mockResolvedValue(new Response(JSON.stringify({ choices: [{ text: 'answer  ' }] })))

    expect(client.configured()).toBe(true)
    expect(await client.request('first', payload, new AbortController().signal)).toEqual({
      configured: true,
      text: 'answer',
    })
    expect(readSecret.mock.calls.map((call) => call[1])).toEqual(['completion-deepseek'])
    const [url, options] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/beta/completions')
    expect(options?.headers).toMatchObject({ authorization: 'Bearer fixture-deepseek' })
    const body: unknown = JSON.parse(options?.body as string)
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      suffix: '\n',
      max_tokens: 64,
      temperature: 0,
      stop: ['\n\n'],
      stream: false,
    })
    expect(body).toHaveProperty(
      'prompt',
      '// src/types.ts\n// declare const answer: number\nconst result = '
    )
  })

  it('keeps an explicit provider selection when its key is absent', async () => {
    const { userData, client, keys, readSecret, fetcher } = fixture()
    writeSettings(userData, { ...DEFAULT_SETTINGS, completionProvider: 'codestral' })
    keys['completion-deepseek'] = 'fixture-deepseek'

    expect(client.configured()).toBe(false)
    expect(await client.request('missing', payload, new AbortController().signal)).toEqual({
      configured: false,
      text: null,
    })
    expect(readSecret.mock.calls.map((call) => call[1])).toEqual(['completion-codestral'])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('re-reads a rotated credential after invalidation', async () => {
    const { client, keys, fetcher } = fixture()
    keys['completion-deepseek'] = 'fixture-before'
    fetcher.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ choices: [{ text: 'answer' }] })))
    )
    expect(client.configured()).toBe(true)
    keys['completion-deepseek'] = 'fixture-after'
    await client.request('cached', payload, new AbortController().signal)
    client.invalidate()
    await client.request('rotated', payload, new AbortController().signal)

    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer fixture-before',
    })
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer fixture-after',
    })
  })

  it('re-reads the chosen provider and parses Codestral after invalidation', async () => {
    const { userData, client, keys, fetcher } = fixture()
    keys['completion-deepseek'] = 'fixture-deepseek'
    keys['completion-codestral'] = 'fixture-codestral'
    expect(client.configured()).toBe(true)
    writeSettings(userData, { ...DEFAULT_SETTINGS, completionProvider: 'codestral' })
    client.invalidate()
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'answer\n' } }] }))
    )

    expect(await client.request('chosen', payload, new AbortController().signal)).toEqual({
      configured: true,
      text: 'answer',
    })
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.mistral.ai/v1/fim/completions')
    const body: unknown = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)
    expect(body).toHaveProperty('model', 'codestral-latest')
  })

  it('invalidates a cached missing credential when a key is added', () => {
    const { client, keys } = fixture()
    expect(client.configured()).toBe(false)
    keys['completion-codestral'] = 'fixture-added'
    expect(client.configured()).toBe(false)
    client.invalidate()
    expect(client.configured()).toBe(true)
  })

  it('validates the same payload limits without importing the desktop secret store', () => {
    expect(isCompletionPayload(payload)).toBe(true)
    expect(isCompletionPayload({ ...payload, prefix: 'x'.repeat(2401) })).toBe(false)
    expect(isCompletionPayload({ ...payload, context: [{ text: 1, path: null }] })).toBe(false)
  })
})
