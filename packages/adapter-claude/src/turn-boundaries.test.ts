import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, SessionOpts } from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'

/**
 * One `turn.started` per turn, which Claude does not send and this adapter owes.
 *
 * Codex has `turn/started`. The SDK's nearest frame is `system/init`, which
 * describes the *session* — cwd, model, tools, MCP servers, the CLI version —
 * and this adapter holds one long-lived `query()` in streaming-input mode, so it
 * arrives once while `result` closes every turn. Reading it as a turn start
 * produced one start for a whole session's worth of completions, and every
 * consumer that folds the pair reported the agent idle from the second turn on:
 * no working line in the transcript, no Stop in the composer, no sidebar mark.
 *
 * These tests are about the *pairing*, which is what nothing asserted before.
 */

const OPTS: SessionOpts = {
  cwd: process.cwd(),
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
}

/** A query whose messages this test pushes by hand, so turns are deterministic. */
function adapterFed(): { adapter: ClaudeAdapter; feed: (message: unknown) => void } {
  const messages = new AsyncQueue<unknown>()
  return {
    feed: (message: unknown) => {
      messages.push(message)
    },
    adapter: new ClaudeAdapter({
      createQuery: (_options: Options) =>
        ({
          [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
          interrupt: () => Promise.resolve(undefined),
          setModel: () => Promise.resolve(),
          close: () => {
            messages.close()
          },
        }) as unknown as Query,
    }),
  }
}

const result = (uuid: string): unknown => ({
  type: 'result',
  subtype: 'success',
  uuid,
  usage: { input_tokens: 1, output_tokens: 1 },
})

/**
 * The turn boundaries out of the stream, stopping once `count` have arrived.
 *
 * Filtered rather than taken in order: a `result` maps to `usage.updated` as
 * well as `turn.completed`, and a test that asserted adjacency would be pinning
 * the mapping's output order rather than the pairing it is about.
 */
async function boundaries(events: AsyncIterable<AgentEvent>, count: number): Promise<string[]> {
  const seen: string[] = []
  if (count === 0) return seen
  for await (const event of events) {
    if (event.type !== 'turn.started' && event.type !== 'turn.completed') continue
    seen.push(event.type)
    if (seen.length === count) break
  }
  return seen
}

/**
 * Everything the session emits, collected as it arrives.
 *
 * One iterator, started once. Draining twice would need a second one over the
 * same queue, and a test that reads a turn and then drives another needs the
 * stream to stay open between the two.
 */
function collector(events: AsyncIterable<AgentEvent>): string[] {
  const seen: string[] = []
  void (async () => {
    for await (const event of events) {
      if (event.type === 'turn.started' || event.type === 'turn.completed') seen.push(event.type)
    }
  })()
  return seen
}

/** Lets the pump run: the queue is async, so a result lands a tick later. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('turn boundaries', () => {
  it('starts a turn on every send, not once per session', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)

    /*
     * The result is let through the pump before the next send, which is what a
     * person does: you read the reply, then you type again. **The flag is
     * cleared by the pump, not by the send**, so a second message pushed in the
     * same tick as an unread result folds into the turn still recorded as open —
     * the steering case below, arrived at by racing rather than by intent. That
     * is a real edge and it fails safe: one start, one completion, no stuck
     * "working" line.
     */
    const seen = collector(session.events)

    await session.send({ text: 'first' })
    feed(result('r1'))
    await settle()

    await session.send({ text: 'second' })
    feed(result('r2'))
    await settle()

    expect(seen).toEqual(['turn.started', 'turn.completed', 'turn.started', 'turn.completed'])
  })

  it('does not open a second turn when a message steers a running one', async () => {
    /*
     * Sending mid-turn is steering, deliberately: the agent keeps working and
     * takes the message in, and one `result` still ends it. A second start here
     * would leave the balance permanently positive — the mirror of the bug being
     * fixed, and the one that shows an agent working forever.
     */
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)

    await session.send({ text: 'do the thing' })
    await session.send({ text: 'actually, prefer the other way' })
    feed(result('r1'))

    expect(await boundaries(session.events, 2)).toEqual(['turn.started', 'turn.completed'])
  })

  it('says nothing about init, so it cannot double-count the first turn', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)

    feed({ type: 'system', subtype: 'init', uuid: 'i1', session_id: 's1' })
    await session.send({ text: 'first' })
    feed(result('r1'))

    expect(await boundaries(session.events, 2)).toEqual(['turn.started', 'turn.completed'])
  })
})
