import { describe, expect, it, vi } from 'vitest'
import { createChorusApi, type ShellTransport } from './create-chorus-api.js'
import { SCALE_PUSH_CHANNEL } from './ipc.js'

function setup(): {
  transport: ShellTransport
  listeners: Map<string, (payload: unknown) => void>
} {
  const listeners = new Map<string, (payload: unknown) => void>()
  return {
    listeners,
    transport: {
      invoke: vi.fn(() => Promise.resolve({ ok: true })),
      on: (channel, listener) => {
        listeners.set(channel, listener)
        return () => {
          listeners.delete(channel)
        }
      },
      pathForFile: () => '/picked/file.png',
      noteJournal: vi.fn(() => ({ ok: true, matched: true, current: null })),
    },
  }
}

describe('shared Chorus API', () => {
  it('validates responses from any host transport', async () => {
    const { transport } = setup()
    const api = createChorusApi(transport)
    await expect(api.copyText({ text: 'hello' })).resolves.toEqual({ ok: true })
    expect(transport.invoke).toHaveBeenCalledWith('app:copyText', { text: 'hello' })
    await expect(api.getAppInfo()).rejects.toThrow('Malformed response')
  })

  it('filters malformed pushes and removes the actual subscription', () => {
    const { transport, listeners } = setup()
    const listener = vi.fn()
    const stop = createChorusApi(transport).onScale(listener)
    listeners.get(SCALE_PUSH_CHANNEL)?.(Number.NaN)
    listeners.get(SCALE_PUSH_CHANNEL)?.('1.5')
    expect(listener).not.toHaveBeenCalled()
    listeners.get(SCALE_PUSH_CHANNEL)?.(1.5)
    expect(listener).toHaveBeenCalledExactlyOnceWith(1.5)
    stop()
    expect(listeners.has(SCALE_PUSH_CHANNEL)).toBe(false)
  })

  it('validates synchronous note journal replies and keeps invalid requests off the transport', () => {
    const { transport } = setup()
    const api = createChorusApi(transport)
    expect(api.readConversationNoteJournal({ conversationId: 'conversation-1' })).toEqual({
      ok: true,
      matched: true,
      current: null,
    })
    expect(api.readConversationNoteJournal({ conversationId: '' }).ok).toBe(false)
    expect(transport.noteJournal).toHaveBeenCalledTimes(1)
    transport.noteJournal = () => ({ ok: true, secret: 'unexpected' })
    expect(api.readConversationNoteJournal({ conversationId: 'conversation-1' }).ok).toBe(false)
  })
})
