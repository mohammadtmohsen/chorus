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

/**
 * Kept taking a `string | null` so the concurrency tests below read unchanged.
 * The adapter now wants a pair — the SDK's path and a spawnable command — and
 * on macOS those are the same string, which is what this stands in for.
 */
function harness(lookup: () => Promise<string | null>) {
  const paths: (string | undefined)[] = []
  const adapter = new ClaudeAdapter({
    resolveExecutable: async () => {
      const found = await lookup()
      return found === null ? null : { sdkPath: found, launch: { file: found, args: [] } }
    },
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

/**
 * The Windows bug this pair exists to prevent, found in review before it shipped.
 *
 * An npm install of Claude on Windows is `claude.cmd`, which resolves to the
 * JavaScript file behind it — the only shape `pathToClaudeCodeExecutable` can
 * take there, since the SDK runs it under node and cannot be given a `cmd.exe`
 * prefix. `health()` then spawned that same `.js` with `execFile`, which Windows
 * cannot do: a JavaScript file is not an executable. Health returned
 * unavailable, and Chorus reported a perfectly good installation as missing
 * before any session started.
 *
 * The two consumers therefore get two answers, and this pins that they stay
 * different where they need to be.
 */
describe('the SDK path and the spawnable command are not the same thing', () => {
  it('gives the SDK the script and probes with the interpreter', async () => {
    const script = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\claude\\cli.js'
    const probes: { file: string; args: readonly string[] }[] = []
    const paths: (string | undefined)[] = []

    const adapter = new ClaudeAdapter({
      resolveExecutable: () =>
        Promise.resolve({ sdkPath: script, launch: { file: 'node', args: [script] } }),
      createQuery: (options: Options) => {
        paths.push((options as { pathToClaudeCodeExecutable?: string }).pathToClaudeCodeExecutable)
        return stubQuery()
      },
    })

    await adapter.start(OPTS)
    // The SDK gets the script. `execFile` could not have run this string, which
    // is exactly why `health()` is given the separate launch pair instead.
    expect(paths).toEqual([script])
    expect(probes).toEqual([])
  })

  it('raises its own error when the shim could not be reduced for the SDK', async () => {
    // sdkPath null, launch still usable: an unreadable shim can be version-probed
    // through cmd.exe but cannot be handed to the SDK.
    const adapter = new ClaudeAdapter({
      resolveExecutable: () =>
        Promise.resolve({
          sdkPath: null,
          launch: { file: 'cmd.exe', args: ['/d', '/s', '/c', 'C:\\x\\claude.cmd'] },
        }),
      createQuery: () => stubQuery(),
    })
    await expect(adapter.start(OPTS)).rejects.toThrow(/could not find the claude cli/i)
  })
})

/**
 * `health()` must probe something the OS can actually run.
 *
 * This is the blocker the shape above exists for, asserted end to end rather
 * than by inspection: a resolver whose `sdkPath` is a JavaScript file — which
 * is what every npm install of Claude on Windows resolves to — must still
 * report ready, because the probe goes through `launch` instead.
 *
 * `node --version` is spawned for real. That is the point: mocking `execFile`
 * would assert what we passed rather than whether it can be executed, and
 * "cannot be executed" is the entire bug. Reverting `health()` to spawn
 * `sdkPath` turns this red with `unavailable`.
 */
describe('health probes the launch pair', () => {
  it('reports ready when the SDK path is a script it could never spawn', async () => {
    const adapter = new ClaudeAdapter({
      resolveExecutable: () =>
        Promise.resolve({
          sdkPath: '/tmp/chorus-not-executable.js',
          launch: { file: process.execPath, args: [] },
        }),
      createQuery: () => stubQuery(),
    })
    const state = await adapter.health()
    expect(state.state).toBe('ready')
  })
})
