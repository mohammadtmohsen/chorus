import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserTabCdp } from './cdp-session.js'
import { FakeSession } from './test/fixtures.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserTabCdp', () => {
  it('attaches at browser level and sends page commands with the flattened session', async () => {
    const session = new FakeSession()
    const transport = new BrowserTabCdp(session, { url: () => session.pageUrl })
    const received: unknown[] = []
    transport.onMessage((method, params) => received.push({ method, params }))
    await transport.attach('1.3')
    await transport.sendCommand('Runtime.evaluate', { expression: 'document.title' })
    expect(session.requests.slice(0, 2)).toEqual([
      { id: 1, method: 'Target.getTargets', params: {} },
      {
        id: 2,
        method: 'Target.attachToTarget',
        params: { targetId: 'page-target', flatten: true },
      },
    ])
    expect(session.requests.at(-1)).toMatchObject({
      method: 'Runtime.evaluate',
      sessionId: 'page-session',
    })
    session.event('Runtime.consoleAPICalled', { type: 'log' }, 'unrelated-session')
    session.messages.fire({ method: 'Runtime.consoleAPICalled', params: { type: 'debug' } })
    session.event('Runtime.consoleAPICalled', { type: 'info' })
    expect(received).toEqual([{ method: 'Runtime.consoleAPICalled', params: { type: 'info' } }])
    transport.dispose()
  })

  it('ignores a response carrying another target session', async () => {
    const session = new FakeSession()
    const transport = new BrowserTabCdp(session)
    await transport.attach()
    let request: (typeof session.requests)[number] | undefined
    session.handle = (value) => {
      request = value
    }
    const result = transport.sendCommand('Runtime.evaluate', {})
    const pending = request!
    session.messages.fire({ id: pending.id, result: 'wrong', sessionId: 'other' })
    session.reply(pending, 'right')
    await expect(result).resolves.toBe('right')
    transport.dispose()
  })

  it('rejects outstanding work once when its page session detaches', async () => {
    const session = new FakeSession()
    const transport = new BrowserTabCdp(session)
    const detached = vi.fn()
    transport.onDetached(detached)
    await transport.attach()
    session.handle = () => undefined
    const result = transport.sendCommand('Runtime.evaluate', {})
    const rejection = expect(result).rejects.toMatchObject({ code: 'detached' })
    session.messages.fire({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'page-session', targetId: 'page-target' },
    })
    await rejection
    session.closed.fire()
    expect(detached).toHaveBeenCalledTimes(1)
    expect(transport.isAttached()).toBe(false)
  })

  it('cancels document-bound work on navigation while retaining navigation commands', async () => {
    const session = new FakeSession()
    const transport = new BrowserTabCdp(session)
    await transport.attach()
    session.handle = () => undefined
    const evaluation = transport.sendCommand('Runtime.evaluate', {})
    const rejection = expect(evaluation).rejects.toMatchObject({ code: 'navigated' })
    const navigation = transport.sendCommand('Page.navigate', { url: 'https://next.test/' })
    session.event('Page.frameNavigated', {
      frame: { id: 'root', loaderId: 'next-document', url: 'https://next.test/' },
    })
    await rejection
    session.reply(session.requests.at(-1)!, { frameId: 'root' })
    await expect(navigation).resolves.toEqual({ frameId: 'root' })
    transport.dispose()
  })

  it('times out commands and cancels an explicit abort', async () => {
    vi.useFakeTimers()
    const session = new FakeSession()
    const transport = new BrowserTabCdp(session, { timeoutMs: 50 })
    await transport.attach()
    session.handle = () => undefined
    const timeout = transport.sendCommand('Runtime.evaluate', {})
    const timedOut = expect(timeout).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await timedOut
    const cancellation = new AbortController()
    const aborted = transport.sendCommand('Runtime.evaluate', {}, cancellation.signal)
    const cancelled = expect(aborted).rejects.toMatchObject({ code: 'aborted' })
    cancellation.abort()
    await cancelled
    transport.dispose()
  })

  it('rejects ambiguous page targets and ignores worker and prerender targets', async () => {
    const session = new FakeSession()
    session.targetInfos = [
      { targetId: 'worker', type: 'service_worker', url: session.pageUrl },
      { targetId: 'prerender', type: 'page', subtype: 'prerender', url: session.pageUrl },
      { targetId: 'first', type: 'page', url: session.pageUrl },
      { targetId: 'second', type: 'page', url: session.pageUrl },
    ]
    const transport = new BrowserTabCdp(session, { url: () => session.pageUrl })
    await expect(transport.attach()).rejects.toMatchObject({ code: 'ambiguous-target' })
    expect(session.requests).toHaveLength(1)
    transport.dispose()
  })

  it('does not let callers address browser-level targets through the page transport', async () => {
    const session = new FakeSession()
    const transport = new BrowserTabCdp(session)
    await transport.attach()
    await expect(transport.sendCommand('Target.getTargets', {})).rejects.toMatchObject({
      code: 'unsupported',
    })
    expect(session.requests).toHaveLength(2)
    transport.dispose()
  })

  it('cancels evaluation on a target crash without forwarding another target crash', async () => {
    const session = new FakeSession()
    const transport = new BrowserTabCdp(session)
    const crashed = vi.fn()
    transport.onCrashed(crashed)
    await transport.attach()
    session.handle = () => undefined
    const evaluation = transport.sendCommand('Runtime.evaluate', {})
    const rejection = expect(evaluation).rejects.toMatchObject({ code: 'crashed' })
    session.messages.fire({
      method: 'Target.targetCrashed',
      params: { targetId: 'another-page', status: 'crashed' },
    })
    expect(crashed).not.toHaveBeenCalled()
    session.event('Inspector.targetCrashed', {})
    await rejection
    expect(crashed).toHaveBeenCalledTimes(1)
    transport.dispose()
  })
})
