import type { InlineCompletionContext } from 'vscode'
import { describe, expect, it } from 'vitest'
import type { CompletionReply } from '../../../desktop/src/shared/workbench-ipc.js'
import { cancellation, deferred, fixture, position, range, uri } from './fixtures.test-support.js'
import { InlineCompletionProvider } from './provider.js'

const context: InlineCompletionContext = { triggerKind: 1, selectedCompletionInfo: undefined }

describe('the VS Code inline completion provider', () => {
  it('asks for a configured, contained document and returns an insertion at its cursor', async () => {
    const f = fixture()
    const provider = new InlineCompletionProvider(f.port, f.host)
    const at = f.active().position
    const result = await provider.provideInlineCompletionItems(
      f.source,
      at,
      context,
      cancellation().token
    )

    expect(result).toHaveLength(1)
    expect(result?.[0]?.insertText).toBe('answer')
    expect(result?.[0]?.range?.start.isEqual(at)).toBe(true)
    expect(result?.[0]?.range?.end.isEqual(at)).toBe(true)
    expect(f.request.mock.calls[0]?.[1]).toMatchObject({
      path: 'main.ts',
      languageId: 'typescript',
      prefix: 'const result = ',
    })
    expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'returned' }))
  })

  it('uses the host membership check for remote project documents', async () => {
    const f = fixture()
    f.source.uri = uri('/project/main.ts', 'vscode-remote', 'ssh-remote+host')
    f.move(f.active().position, f.source.uri)
    const provider = new InlineCompletionProvider(f.port, f.host)
    const result = await provider.provideInlineCompletionItems(
      f.source,
      f.active().position,
      context,
      cancellation().token
    )
    expect(result?.[0]?.insertText).toBe('answer')
    expect(f.request).toHaveBeenCalledTimes(1)
  })

  it('does not inspect language providers or request generation for uncontained files', async () => {
    const f = fixture()
    f.source.uri = uri('/elsewhere/private.ts')
    const provider = new InlineCompletionProvider(f.port, f.host)
    expect(
      await provider.provideInlineCompletionItems(
        f.source,
        f.active().position,
        context,
        cancellation().token
      )
    ).toBeUndefined()
    expect(f.configured).not.toHaveBeenCalled()
    expect(f.definitions).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
  })

  it('does not collect context without a configured provider or when inline completion is disabled', async () => {
    const f = fixture()
    const provider = new InlineCompletionProvider(f.port, f.host)
    f.configured.mockResolvedValue(false)
    expect(
      await provider.provideInlineCompletionItems(
        f.source,
        f.active().position,
        context,
        cancellation().token
      )
    ).toBeUndefined()
    expect(f.definitions).not.toHaveBeenCalled()
    f.enabled.mockReturnValue(false)
    await provider.provideInlineCompletionItems(
      f.source,
      f.active().position,
      context,
      cancellation().token
    )
    expect(f.configured).toHaveBeenCalledTimes(1)
    expect(f.request).not.toHaveBeenCalled()
  })

  it('forwards cancellation while a request is pending and discards a late reply', async () => {
    const f = fixture()
    const reply = deferred<CompletionReply>()
    const sent = deferred<AbortSignal>()
    f.request.mockImplementation((_id, _payload, signal) => {
      sent.resolve(signal)
      return reply.promise
    })
    const token = cancellation()
    const provider = new InlineCompletionProvider(f.port, f.host)
    const pending = provider.provideInlineCompletionItems(
      f.source,
      f.active().position,
      context,
      token.token
    )
    const signal = await sent.promise
    token.cancel()
    expect(signal.aborted).toBe(true)
    expect(await pending).toBeUndefined()
    reply.resolve({ configured: true, text: 'late' })
    expect(f.report).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'returned' }))
  })

  it('rejects a reply after the document version changes', async () => {
    const f = fixture()
    const reply = deferred<CompletionReply>()
    const sent = deferred<undefined>()
    f.request.mockImplementation(() => {
      sent.resolve(undefined)
      return reply.promise
    })
    const provider = new InlineCompletionProvider(f.port, f.host)
    const pending = provider.provideInlineCompletionItems(
      f.source,
      f.active().position,
      context,
      cancellation().token
    )
    await sent.promise
    f.source.version += 1
    reply.resolve({ configured: true, text: 'stale' })
    expect(await pending).toBeUndefined()
  })

  it('rejects a reply after the cursor or active document changes', async () => {
    for (const otherDocument of [false, true]) {
      const f = fixture()
      const reply = deferred<CompletionReply>()
      const sent = deferred<undefined>()
      f.request.mockImplementation(() => {
        sent.resolve(undefined)
        return reply.promise
      })
      const provider = new InlineCompletionProvider(f.port, f.host)
      const pending = provider.provideInlineCompletionItems(
        f.source,
        f.active().position,
        context,
        cancellation().token
      )
      await sent.promise
      f.move(position(0, 0), otherDocument ? uri('/project/other.ts') : f.source.uri)
      reply.resolve({ configured: true, text: 'stale' })
      expect(await pending).toBeUndefined()
    }
  })

  it('aborts an older request when a newer request is made for the same document', async () => {
    const f = fixture()
    const sent = deferred<AbortSignal>()
    const reply = deferred<CompletionReply>()
    f.request.mockImplementationOnce((_id, _payload, signal) => {
      sent.resolve(signal)
      return reply.promise
    })
    const provider = new InlineCompletionProvider(f.port, f.host)
    const first = provider.provideInlineCompletionItems(
      f.source,
      f.active().position,
      context,
      cancellation().token
    )
    const signal = await sent.promise
    const second = provider.provideInlineCompletionItems(
      f.source,
      f.active().position,
      context,
      cancellation().token
    )
    expect(signal.aborted).toBe(true)
    expect(await first).toBeUndefined()
    expect((await second)?.[0]?.insertText).toBe('answer')
    reply.resolve({ configured: true, text: 'old' })
  })

  it('suppresses text already present in the suffix', async () => {
    const f = fixture('answer')
    f.move(position(0, 0))
    const provider = new InlineCompletionProvider(f.port, f.host)
    expect(
      await provider.provideInlineCompletionItems(
        f.source,
        position(0, 0),
        context,
        cancellation().token
      )
    ).toBeUndefined()
  })

  it('extends the selected completion using its exact replacement range', async () => {
    const f = fixture('con')
    f.request.mockResolvedValue({ configured: true, text: 'sole.log()' })
    const selectedRange = range(position(0, 0), position(0, 3))
    const provider = new InlineCompletionProvider(f.port, f.host)
    const result = await provider.provideInlineCompletionItems(
      f.source,
      position(0, 3),
      { ...context, selectedCompletionInfo: { range: selectedRange, text: 'console' } },
      cancellation().token
    )
    expect(result?.[0]).toEqual({ range: selectedRange, insertText: 'console.log()' })
  })

  it('honors a host snooze without requesting configuration or context', async () => {
    const f = fixture()
    f.port.snoozed = () => true
    const provider = new InlineCompletionProvider(f.port, f.host)
    expect(
      await provider.provideInlineCompletionItems(
        f.source,
        f.active().position,
        context,
        cancellation().token
      )
    ).toBeUndefined()
    expect(f.configured).not.toHaveBeenCalled()
  })
})
