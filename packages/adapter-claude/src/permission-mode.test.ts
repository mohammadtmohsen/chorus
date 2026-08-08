import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import type { SandboxPolicy, SessionOpts } from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'

/**
 * `acceptEdits` makes the CLI auto-accept file edits *without calling the
 * permission callback*, so Chorus's policy engine never sees them. Set for any
 * profile above read-only, it made every rule matching a `fileChange` dead —
 * including the credential rule, which exists to stop an agent writing to an
 * env file or an ssh key unasked.
 *
 * The permission decision belongs in one place. This pins it there.
 */

function optionsFor(sandbox: SandboxPolicy): Promise<Options> {
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
    const opts: SessionOpts = { cwd: process.cwd(), sandbox }
    void adapter.start(opts)
  })
}

describe('permissionMode', () => {
  it('routes every tool through the permission callback, in every profile', async () => {
    for (const sandbox of [
      { mode: 'readOnly', writableRoots: [], networkAccess: false },
      { mode: 'workspaceWrite', writableRoots: ['/repo'], networkAccess: false },
      { mode: 'fullAccess', writableRoots: ['/repo'], networkAccess: true },
    ] satisfies SandboxPolicy[]) {
      const options = await optionsFor(sandbox)
      expect(options.permissionMode).toBe('default')
    }
  })

  it('still hands the callback over, or nothing would be asked at all', async () => {
    const options = await optionsFor({ mode: 'readOnly', writableRoots: [], networkAccess: false })
    expect(typeof options.canUseTool).toBe('function')
  })
})
