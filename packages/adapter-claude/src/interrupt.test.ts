import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, SessionOpts } from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'

/**
 * What a stop did not stop.
 *
 * Queued async messages outlive an interrupt by design, and `interrupt()`'s
 * receipt is the only place that says so. It was awaited and discarded, which
 * left a user who pressed Stop watching the agent begin again on something they
 * had just cancelled, with nothing anywhere explaining why.
 */

const OPTS: SessionOpts = {
  cwd: process.cwd(),
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
}

function adapterWith(interrupt: () => Promise<unknown>): ClaudeAdapter {
  return new ClaudeAdapter({
    createQuery: (_options: Options) => {
      const messages = new AsyncQueue<unknown>()
      // Left open: the session's pump must not close the event queue before the
      // notice can be read off it.
      return {
        [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
        interrupt,
        setModel: () => Promise.resolve(),
        close: () => {
          messages.close()
        },
      } as unknown as Query
    },
  })
}

/** Drains whatever the session has emitted so far, without waiting for more. */
async function emitted(events: AsyncIterable<AgentEvent>, count: number): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  if (count === 0) return seen
  for await (const event of events) {
    seen.push(event)
    if (seen.length === count) break
  }
  return seen
}

describe('interrupt', () => {
  it('says how many messages the stop did not stop', async () => {
    const session = await adapterWith(() =>
      Promise.resolve({ still_queued: ['uuid-1', 'uuid-2'] })
    ).start(OPTS)

    await session.interrupt()
    const [notice] = await emitted(session.events, 1)
    expect(notice).toMatchObject({ type: 'notice', level: 'warn', text: '2 queued' })
  })

  it('stays quiet when the stop stopped everything', async () => {
    const session = await adapterWith(() => Promise.resolve({ still_queued: [] })).start(OPTS)
    await session.interrupt()
    await session.close()
    expect(await emitted(session.events, 0)).toEqual([])
  })

  it('stays quiet on a CLI too old to send a receipt', async () => {
    // Older CLIs resolve to undefined. That is not a failure — it is a CLI that
    // cannot tell us, and inventing a number would be worse than saying nothing.
    const session = await adapterWith(() => Promise.resolve(undefined)).start(OPTS)
    await session.interrupt()
    await session.close()
    expect(await emitted(session.events, 0)).toEqual([])
  })
})
