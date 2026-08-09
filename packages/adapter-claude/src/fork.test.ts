import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import type { ForkOpts, SessionOpts } from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'

/**
 * A fork must be a *branch*, and the two flags that make it one are easy to get
 * half right.
 *
 * `forkSession` without `persistSession: false` writes every throwaway question
 * into `~/.claude/projects`, so a user who asked six small things finds six
 * sessions they never started. `persistSession: false` without `forkSession` is
 * worse in the other direction — it stops the *original* session recording,
 * which is data loss rather than clutter. Neither shows up in a typecheck, and
 * neither is visible until someone goes looking at their session list, so they
 * are pinned here.
 */

const SANDBOX = { mode: 'readOnly', writableRoots: [], networkAccess: false } as const
const opts = (): SessionOpts => ({ cwd: process.cwd(), sandbox: SANDBOX })

/** The options the adapter hands the SDK for whatever `drive` asks it to do. */
function optionsFor(drive: (adapter: ClaudeAdapter) => void): Promise<Options> {
  return new Promise((resolve) => {
    const adapter = new ClaudeAdapter({
      createQuery: (options: Options) => {
        resolve(options)
        const messages = new AsyncQueue<unknown>()
        messages.close()
        return {
          [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
          interrupt: () => Promise.resolve(undefined),
          setModel: () => Promise.resolve(),
          close: () => undefined,
        } as unknown as Query
      },
    })
    drive(adapter)
  })
}

const forking = (over: Partial<ForkOpts> = {}): ForkOpts => ({
  ...opts(),
  inherits: 'config',
  ...over,
})

describe('fork', () => {
  it('branches the session rather than continuing it', async () => {
    const options = await optionsFor((a) => void a.fork('sess-1', forking()))
    expect(options.resume).toBe('sess-1')
    expect(options.forkSession).toBe(true)
  })

  it('leaves nothing behind on disk', async () => {
    const options = await optionsFor((a) => void a.fork('sess-1', forking()))
    expect(options.persistSession).toBe(false)
  })

  it('never sets either flag for an ordinary start', async () => {
    const options = await optionsFor((a) => void a.start(opts()))
    expect(options.forkSession).toBeUndefined()
    // The dangerous half: this would stop the real session recording.
    expect(options.persistSession).toBeUndefined()
    expect(options.resume).toBeUndefined()
  })

  it('never sets either flag for a resume, which must keep appending', async () => {
    const options = await optionsFor((a) => void a.resume('sess-1', opts()))
    expect(options.resume).toBe('sess-1')
    expect(options.forkSession).toBeUndefined()
    expect(options.persistSession).toBeUndefined()
  })

  it('inherits the user config by default, as a session would', async () => {
    const options = await optionsFor((a) => void a.fork('sess-1', forking({ inherits: 'config' })))
    // Omitted, not empty: omission is what loads the user's real setup.
    expect(options.settingSources).toBeUndefined()
  })

  it('isolates from user config when asked to inherit nothing', async () => {
    const options = await optionsFor((a) => void a.fork('sess-1', forking({ inherits: 'nothing' })))
    // `[]` is the SDK's documented isolation mode — no hooks, no MCP servers.
    expect(options.settingSources).toEqual([])
  })

  it('refuses to fork a session that has no id yet', async () => {
    const adapter = new ClaudeAdapter({ createQuery: () => ({}) as unknown as Query })
    // A Claude session's ref is discovered from the first message, so it is ''
    // until the CLI reports one. Forking that would silently start a fresh
    // session with none of the context the fork exists to inherit.
    await expect(adapter.fork('', forking())).rejects.toThrow(/no id yet/)
  })

  it('declares the capability it now implements', () => {
    const adapter = new ClaudeAdapter({ createQuery: () => ({}) as unknown as Query })
    expect(adapter.capabilities.fork).toBe(true)
    expect(typeof adapter.fork).toBe('function')
  })
})
