import { describe, expect, it, vi } from 'vitest'
import { dispatch, type IpcHandlers } from './ipc-handlers.js'

describe('host-free IPC dispatch', () => {
  it('rejects malformed input before calling the handler', async () => {
    const copy = vi.fn(() => Promise.resolve({ ok: true }))
    const handlers = { 'app:copyText': copy } as unknown as IpcHandlers
    await expect(dispatch(handlers, 'app:copyText', { text: 42 })).rejects.toThrow(
      'Invalid request'
    )
    expect(copy).not.toHaveBeenCalled()
  })

  it('validates handler output before returning it to any host', async () => {
    const handlers = {
      'app:copyText': () => Promise.resolve({ ok: false }),
    } as unknown as IpcHandlers
    await expect(dispatch(handlers, 'app:copyText', { text: 'hello' })).rejects.toThrow(
      'Invalid response'
    )
  })

  it('passes the parsed request and validated response through unchanged', async () => {
    const copy = vi.fn(() => Promise.resolve({ ok: true }))
    const handlers = { 'app:copyText': copy } as unknown as IpcHandlers
    await expect(dispatch(handlers, 'app:copyText', { text: 'hello' })).resolves.toEqual({
      ok: true,
    })
    expect(copy).toHaveBeenCalledExactlyOnceWith({ text: 'hello' })
  })
})
