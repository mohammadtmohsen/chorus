import type {
  Options,
  Query,
  SDKResultError,
  SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk'
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

async function firstOfType(
  events: AsyncIterable<AgentEvent>,
  type: AgentEvent['type']
): Promise<AgentEvent | undefined> {
  for await (const event of events) {
    if (event.type === type) return event
  }
  return undefined
}

describe('interrupt', () => {
  it('says how many messages the stop did not stop', async () => {
    const session = await adapterWith(() =>
      Promise.resolve({ still_queued: ['uuid-1', 'uuid-2'] })
    ).start(OPTS)

    await session.interrupt()
    const notice = await firstOfType(session.events, 'notice')
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

const STOP_DIAGNOSTIC = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'
const OVERLOADED = 'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}'

function adapterFed(interrupt: () => Promise<unknown> = () => Promise.resolve(undefined)): {
  adapter: ClaudeAdapter
  feed: (message: unknown) => void
} {
  const messages = new AsyncQueue<unknown>()
  return {
    feed: (message: unknown) => {
      messages.push(message)
    },
    adapter: new ClaudeAdapter({
      createQuery: (_options: Options) =>
        ({
          [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
          interrupt,
          setModel: () => Promise.resolve(),
          close: () => {
            messages.close()
          },
        }) as unknown as Query,
    }),
  }
}

const R1 = '00000000-0000-4000-8000-000000000001'
const R2 = '00000000-0000-4000-8000-000000000002'

const USAGE: SDKResultError['usage'] = {
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  fallback_credit: { status: { type: 'not_applied', reason: 'not_enabled' } },
  inference_geo: 'global',
  input_tokens: 12,
  iterations: [],
  output_tokens: 3,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: 'standard',
  speed: 'standard',
}

const failedResult = (uuid: SDKResultError['uuid'], errors: string[]): SDKResultError => ({
  type: 'result',
  subtype: 'error_during_execution',
  duration_ms: 40,
  duration_api_ms: 20,
  is_error: true,
  num_turns: 1,
  stop_reason: null,
  total_cost_usd: 0.001,
  usage: USAGE,
  modelUsage: {},
  permission_denials: [],
  errors,
  uuid,
  session_id: 's1',
})

const succeededResult = (uuid: SDKResultSuccess['uuid']): SDKResultSuccess => ({
  type: 'result',
  subtype: 'success',
  duration_ms: 40,
  duration_api_ms: 20,
  is_error: false,
  num_turns: 1,
  result: 'done',
  stop_reason: 'end_turn',
  total_cost_usd: 0.001,
  usage: USAGE,
  modelUsage: {},
  permission_denials: [],
  uuid,
  session_id: 's1',
})

async function untilTurnEnds(events: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  for (;;) {
    const next = await events.next()
    if (next.done === true) return seen
    seen.push(next.value)
    if (next.value.type === 'turn.completed') return seen
  }
}

const errorsIn = (events: readonly AgentEvent[]): AgentEvent[] =>
  events.filter((event) => event.type === 'error')

const boundariesIn = (events: readonly AgentEvent[]): AgentEvent['type'][] =>
  events
    .filter((event) => event.type === 'turn.started' || event.type === 'turn.completed')
    .map((event) => event.type)

describe('the stop diagnostic', () => {
  it('ends a requested stop as interrupted without raising an error', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)
    const events = session.events[Symbol.asyncIterator]()

    await session.send({ text: 'run the build' })
    await session.interrupt()
    feed(failedResult(R1, [STOP_DIAGNOSTIC]))
    const turn = await untilTurnEnds(events)

    expect(errorsIn(turn)).toEqual([])
    expect(turn.at(-1)).toMatchObject({ type: 'turn.completed', status: 'interrupted' })
    await session.close()
  })

  it('accepts and completes the next message after a stop', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)
    const events = session.events[Symbol.asyncIterator]()

    await session.send({ text: 'run the build' })
    await session.interrupt()
    feed(failedResult(R1, [STOP_DIAGNOSTIC]))
    await untilTurnEnds(events)

    await expect(session.send({ text: 'try again' })).resolves.toBeUndefined()
    feed(succeededResult(R2))
    const next = await untilTurnEnds(events)

    expect(boundariesIn(next)).toEqual(['turn.started', 'turn.completed'])
    expect(errorsIn(next)).toEqual([])
    expect(next.at(-1)).toMatchObject({ type: 'turn.completed', status: 'completed' })
    await session.close()
  })

  it('reports the diagnostic when nobody asked to stop', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)
    const events = session.events[Symbol.asyncIterator]()

    await session.send({ text: 'run the build' })
    feed(failedResult(R1, [STOP_DIAGNOSTIC]))
    const turn = await untilTurnEnds(events)

    expect(errorsIn(turn)).toEqual([
      expect.objectContaining({ message: STOP_DIAGNOSTIC, recoverable: false }),
    ])
    expect(turn.at(-1)).toMatchObject({ type: 'turn.completed', status: 'failed' })
    await session.close()
  })

  it('reports a genuine error that arrives with a stop', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)
    const events = session.events[Symbol.asyncIterator]()

    await session.send({ text: 'run the build' })
    await session.interrupt()
    feed(failedResult(R1, [OVERLOADED]))
    const turn = await untilTurnEnds(events)

    expect(errorsIn(turn)).toEqual([expect.objectContaining({ message: OVERLOADED })])
    expect(turn.at(-1)).toMatchObject({ type: 'turn.completed', status: 'interrupted' })
    await session.close()
  })

  it('keeps the genuine error when it shares a result with the diagnostic', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)
    const events = session.events[Symbol.asyncIterator]()

    await session.send({ text: 'run the build' })
    await session.interrupt()
    feed(failedResult(R1, [STOP_DIAGNOSTIC, OVERLOADED]))
    const turn = await untilTurnEnds(events)

    expect(errorsIn(turn)).toEqual([expect.objectContaining({ message: OVERLOADED })])
    await session.close()
  })

  it('does not carry a stop that arrived as the turn finished into the next turn', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)
    const events = session.events[Symbol.asyncIterator]()

    await session.send({ text: 'run the build' })
    await session.interrupt()
    feed(succeededResult(R1))
    const finished = await untilTurnEnds(events)
    expect(finished.at(-1)).toMatchObject({ type: 'turn.completed', status: 'completed' })

    await session.send({ text: 'run it again' })
    feed(failedResult(R2, [STOP_DIAGNOSTIC]))
    const next = await untilTurnEnds(events)

    expect(errorsIn(next)).toEqual([expect.objectContaining({ message: STOP_DIAGNOSTIC })])
    expect(next.at(-1)).toMatchObject({ type: 'turn.completed', status: 'failed' })
    await session.close()
  })

  it('does not carry a refused stop into the turn', async () => {
    const { adapter, feed } = adapterFed(() => Promise.reject(new Error('Query closed')))
    const session = await adapter.start(OPTS)
    const events = session.events[Symbol.asyncIterator]()

    await session.send({ text: 'run the build' })
    await expect(session.interrupt()).rejects.toThrow('Query closed')
    feed(failedResult(R1, [STOP_DIAGNOSTIC]))
    const turn = await untilTurnEnds(events)

    expect(errorsIn(turn)).toEqual([expect.objectContaining({ message: STOP_DIAGNOSTIC })])
    expect(turn.at(-1)).toMatchObject({ type: 'turn.completed', status: 'failed' })
    await session.close()
  })

  it('does not let a stop sent to an idle agent hide the next failure', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)
    const events = session.events[Symbol.asyncIterator]()

    await session.interrupt()
    await session.send({ text: 'run the build' })
    feed(failedResult(R1, [STOP_DIAGNOSTIC]))
    const turn = await untilTurnEnds(events)

    expect(errorsIn(turn)).toEqual([
      expect.objectContaining({ message: STOP_DIAGNOSTIC, recoverable: false }),
    ])
    expect(turn.at(-1)).toMatchObject({ type: 'turn.completed', status: 'failed' })
    await session.close()
  })
})
