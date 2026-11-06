import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnginePeer, PeerRegistry } from './peers.js'
import type { Hello } from './protocol.js'
import type { ClientState } from './state.js'

const peerIn = (registry: PeerRegistry): EnginePeer => {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableLength: 0,
    write: () => true,
  }) as unknown as Socket
  const peer = new EnginePeer(socket, { lastSeq: 0 } as Hello, {} as ClientState)
  peer.ready = true
  registry.peers.add(peer)
  return peer
}

describe('PeerRegistry', () => {
  it('reports no focused client when nobody is looking at Chorus', () => {
    const registry = new PeerRegistry()
    const window = peerIn(registry)
    registry.focus(window, true, ['p'], 0, 'p', false)
    expect(registry.focused()).toBeNull()
    expect(registry.choose('p')).toBe(window)
  })

  it('reports the client whose Chorus tab is showing in the focused window', () => {
    const registry = new PeerRegistry()
    peerIn(registry)
    const window = peerIn(registry)
    registry.focus(window, true, ['p'], 0, 'p', true)
    expect(registry.focused()).toBe(window)
  })

  it('routes to the most recently focused window even while its Chorus tab is hidden', () => {
    const registry = new PeerRegistry()
    const first = peerIn(registry)
    const second = peerIn(registry)
    registry.focus(first, true, ['p'], 0, 'p', false)
    registry.focus(second, true, ['p'], 0, 'p', false)
    expect(registry.choose('p')).toBe(second)
  })
})

describe('EnginePeer.requestHost', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a host call that never answers', async () => {
    vi.useFakeTimers()
    const call = peerIn(new PeerRegistry()).requestHost('editor.snapshot', {})
    const rejected = expect(call).rejects.toThrow('host-timeout')
    await vi.advanceTimersByTimeAsync(300_000)
    await rejected
  })

  it.each(['pickDirectory', 'pickFiles'])(
    'waits on %s for as long as the person takes, until the window goes away',
    async (method) => {
      vi.useFakeTimers()
      const peer = peerIn(new PeerRegistry())
      const settled = vi.fn()
      peer.requestHost(method, {}).then(settled, settled)
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(settled).not.toHaveBeenCalled()
      ;(peer.socket as unknown as EventEmitter).emit('close')
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toHaveBeenCalledWith(new Error('host-disconnected'))
    }
  )
})
