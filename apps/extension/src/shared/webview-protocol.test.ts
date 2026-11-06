import { describe, expect, it } from 'vitest'
import {
  ClientMessage,
  PERSON_PACED_CHANNELS,
  ServerMessage,
  WebviewMessage,
} from '../../../engine/src/protocol.js'
import { ShellHostMessage, SHELL_CHANNELS } from './webview-protocol.js'

const serialized = (message: unknown): unknown => JSON.parse(JSON.stringify(message))

describe('messages that lose an undefined field in JSON', () => {
  it('keeps a request with no value on every channel, from the webview and to the engine', () => {
    for (const channel of SHELL_CHANNELS) {
      const sent = serialized({ kind: 'invoke', id: 'a', channel, request: undefined })
      expect(WebviewMessage.safeParse(sent).success, channel).toBe(true)
      expect(ClientMessage.safeParse(sent).success, channel).toBe(true)
    }
  })

  it('keeps a push with no payload, from the engine and to the webview', () => {
    const push = serialized({ kind: 'push', channel: 'a', payload: undefined })
    expect(ServerMessage.safeParse(push).success).toBe(true)
    expect(ShellHostMessage.safeParse(push).success).toBe(true)
  })

  it('keeps a host call and a browser event with no params', () => {
    expect(
      ServerMessage.safeParse(serialized({ kind: 'hostCall', id: 'a', method: 'b' })).success
    ).toBe(true)
    expect(
      ClientMessage.safeParse(
        serialized({
          kind: 'browserEvent',
          event: { kind: 'cdp', tabId: 't', projectId: 'p', generation: 0, method: 'm' },
        })
      ).success
    ).toBe(true)
  })
})

describe('calls that wait on a person', () => {
  it('names only channels that exist', () => {
    for (const channel of PERSON_PACED_CHANNELS)
      expect(SHELL_CHANNELS.has(channel), channel).toBe(true)
  })
})
