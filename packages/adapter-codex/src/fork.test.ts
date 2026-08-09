import type { ForkOpts } from '@chorus/agent-protocol'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './codex-adapter.js'
import type { Transport } from './transport.js'

/**
 * Forking must not rejoin the thread it copies.
 *
 * `thread/resume` and `thread/fork` differ by one word at the call site and by
 * everything in effect: resume rejoins the original, so an aside asked through
 * it would land in the transcript the user is watching and in the context the
 * agent carries forward. Nothing downstream could tell the difference until it
 * appeared in the room, which is why the request itself is pinned here.
 */

const CWD = mkdtempSync(join(tmpdir(), 'chorus-fork-'))
const SANDBOX = { mode: 'readOnly', writableRoots: [], networkAccess: false } as const
const forking = (over: Partial<ForkOpts> = {}): ForkOpts => ({
  cwd: CWD,
  sandbox: SANDBOX,
  inherits: 'config',
  ...over,
})

/** Records every request, and answers the handful the adapter waits on. */
function spy(): { adapter: CodexAdapter; sent: () => Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  let onLine: ((line: string) => void) | null = null

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
          reply({ thread: { id: 'thr_original' }, model: 'fake-model' })
          break
        case 'thread/fork':
          reply({ thread: { id: 'thr_branch', forkedFromId: 'thr_original', ephemeral: true } })
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

const forkRequest = (sent: Record<string, unknown>[]): Record<string, unknown> | undefined =>
  sent.find((m) => m['method'] === 'thread/fork')?.['params'] as Record<string, unknown> | undefined

describe('fork', () => {
  it('branches with thread/fork, never thread/resume', async () => {
    const { adapter, sent } = spy()
    await adapter.fork('thr_original', forking())
    expect(sent().some((m) => m['method'] === 'thread/fork')).toBe(true)
    // The whole point: rejoining would put the aside in the original thread.
    expect(sent().some((m) => m['method'] === 'thread/resume')).toBe(false)
  })

  it('names the thread it is branching from', async () => {
    const { adapter, sent } = spy()
    await adapter.fork('thr_original', forking())
    expect(forkRequest(sent())?.['threadId']).toBe('thr_original')
  })

  it('asks for an ephemeral thread, so a throwaway question stays throwaway', async () => {
    const { adapter, sent } = spy()
    await adapter.fork('thr_original', forking())
    expect(forkRequest(sent())?.['ephemeral']).toBe(true)
  })

  it('forks at the head, never at an older turn', async () => {
    const { adapter, sent } = spy()
    await adapter.fork('thr_original', forking())
    // `lastTurnId` is available in the protocol and deliberately unused: Chorus
    // records no turn ids it could point at, and the referenced turn may not be
    // in progress.
    expect(forkRequest(sent())).not.toHaveProperty('lastTurnId')
  })

  it('returns a session on the branch, not on the original', async () => {
    const { adapter } = spy()
    const session = await adapter.fork('thr_original', forking())
    expect(session.sessionRef).toBe('thr_branch')
  })

  it('refuses to fork a thread that has no id yet', async () => {
    const { adapter } = spy()
    await expect(adapter.fork('', forking())).rejects.toThrow(/no id yet/)
  })

  it('declares the capability it now implements', () => {
    const { adapter } = spy()
    expect(adapter.capabilities.fork).toBe(true)
    expect(typeof adapter.fork).toBe('function')
  })
})

describe('what codex cannot do', () => {
  it('refuses to fork without the user configuration, rather than ignoring the request', async () => {
    const { adapter } = spy()
    // `ThreadForkParams` has no off switch for MCP servers and hooks, so
    // accepting `'nothing'` would silently give the opposite of what a caller
    // asking for isolation expects.
    await expect(adapter.fork('thr_original', forking({ inherits: 'nothing' }))).rejects.toThrow(
      /without the user configuration/
    )
  })
})
