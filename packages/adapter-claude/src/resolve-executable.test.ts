import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import type { SessionOpts } from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'

/**
 * The bug this pins, in the words the user saw:
 *
 *   Native CLI binary for darwin-arm64 not found. Reinstall
 *   @anthropic-ai/claude-agent-sdk without --omit=optional, or set
 *   options.pathToClaudeCodeExecutable.
 *
 * Nothing was wrong with the install. `resolveOnce` memoised its lookup with a
 * boolean set *before* the await, so a second caller arriving mid-lookup saw
 * "already resolved" and spawned with no `pathToClaudeCodeExecutable`. The SDK
 * then went looking for the bundled binary that `pnpm-workspace.yaml`
 * deliberately excludes, and blamed the install for a race.
 *
 * The window is wide — the lookup asks the user's shell twice with a ten-second
 * timeout each — and `health()` takes the same path, so probing agents at launch
 * overlaps with restoring conversations almost exactly.
 */

const OPTS: SessionOpts = {
  cwd: process.cwd(),
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
}

function stubQuery(): Query {
  const messages = new AsyncQueue<unknown>()
  messages.close()
  return {
    [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
    interrupt: () => Promise.resolve(undefined),
    setModel: () => Promise.resolve(),
    close: () => undefined,
  } as unknown as Query
}

function harness(lookup: () => Promise<string | null>) {
  const paths: (string | undefined)[] = []
  const adapter = new ClaudeAdapter({
    resolveExecutablePath: lookup,
    createQuery: (options: Options) => {
      paths.push((options as { pathToClaudeCodeExecutable?: string }).pathToClaudeCodeExecutable)
      return stubQuery()
    },
  })
  return { adapter, paths }
}

describe('resolving the installed claude', () => {
  it('makes a concurrent start wait for the lookup instead of spawning without a path', async () => {
    let release: (path: string | null) => void = () => undefined
    let lookups = 0
    const { adapter, paths } = harness(() => {
      lookups += 1
      return new Promise<string | null>((resolve) => {
        release = resolve
      })
    })

    // Both start while the lookup is still outstanding — launch probes agents
    // and restores conversations at the same time.
    const first = adapter.start(OPTS)
    const second = adapter.start(OPTS)
    release('/usr/local/bin/claude')
    await Promise.all([first, second])

    expect(lookups).toBe(1)
    expect(paths).toEqual(['/usr/local/bin/claude', '/usr/local/bin/claude'])
  })

  it('asks once across start, resume and health', async () => {
    let lookups = 0
    const { adapter } = harness(() => {
      lookups += 1
      return Promise.resolve('/usr/local/bin/claude')
    })

    await Promise.all([adapter.start(OPTS), adapter.resume('thread-1', OPTS), adapter.health()])
    expect(lookups).toBe(1)
  })

  it('lets a later start retry after a lookup that failed', async () => {
    // A cached failure would be permanent, and the thing that failed is a shell
    // invocation — exactly the kind that succeeds on the second attempt.
    let lookups = 0
    const { adapter, paths } = harness(() => {
      lookups += 1
      return lookups === 1
        ? Promise.reject(new Error('shell would not answer'))
        : Promise.resolve('/usr/local/bin/claude')
    })

    // The first refuses rather than spawning blind — see below for why.
    await expect(adapter.start(OPTS)).rejects.toThrow(/could not find the claude cli/i)
    await adapter.start(OPTS)

    expect(lookups).toBe(2)
    expect(paths).toEqual(['/usr/local/bin/claude'])
  })

  it('blames the missing CLI rather than letting the SDK blame its own install', () => {
    /*
     * Without a path the SDK hunts for its bundled binary — excluded on purpose
     * in `pnpm-workspace.yaml`, all eight platforms — and reports "Native CLI
     * binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk
     * without --omit=optional". Both suggestions are wrong: Chorus drives the
     * installed CLI by design, and reinstalling adds ~257 MB to work around a
     * missing PATH entry.
     */
    const { adapter } = harness(() => Promise.resolve(null))
    return expect(adapter.start(OPTS)).rejects.toThrow(/on your PATH/)
  })

  it('spawns without a path when there is no resolver, rather than hanging', async () => {
    const paths: (string | undefined)[] = []
    const adapter = new ClaudeAdapter({
      createQuery: (options: Options) => {
        paths.push((options as { pathToClaudeCodeExecutable?: string }).pathToClaudeCodeExecutable)
        return stubQuery()
      },
    })
    await adapter.start(OPTS)
    expect(paths).toEqual([undefined])
  })
})
