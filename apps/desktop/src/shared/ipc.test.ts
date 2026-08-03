import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, IPC_CONTRACT, isIpcChannel } from './ipc.js'
import { extractVersion } from '../main/agent-probe.js'

describe('IPC contract', () => {
  it('gives every channel both a request and a response schema', () => {
    // A channel without both would skip validation on one side, which is the
    // hole the contract exists to close (plan §4.4).
    for (const channel of IPC_CHANNELS) {
      expect(IPC_CONTRACT[channel].request).toBeDefined()
      expect(IPC_CONTRACT[channel].response).toBeDefined()
    }
  })

  it('rejects channels outside the contract', () => {
    expect(isIpcChannel('app:getInfo')).toBe(true)
    expect(isIpcChannel('fs:readFile')).toBe(false)
    expect(isIpcChannel('__proto__')).toBe(false)
  })

  it('rejects a malformed response payload', () => {
    const result = IPC_CONTRACT['app:getInfo'].response.safeParse({ appVersion: 1 })
    expect(result.success).toBe(false)
  })
})

describe('extractVersion', () => {
  it('parses the real output of both CLIs', () => {
    expect(extractVersion('codex-cli 0.146.0')).toBe('0.146.0')
    expect(extractVersion('2.1.220 (Claude Code)')).toBe('2.1.220')
  })

  it('handles prerelease suffixes and surrounding whitespace', () => {
    expect(extractVersion('  1.2.3-beta.4  \n')).toBe('1.2.3-beta.4')
  })

  it('returns null when there is no version to find', () => {
    expect(extractVersion('command not found')).toBeNull()
  })
})
