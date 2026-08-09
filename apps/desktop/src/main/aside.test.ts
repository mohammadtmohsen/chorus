import { FakeAdapter } from '@chorus/orchestrator'
import type { AgentAdapter } from '@chorus/agent-protocol'
import { Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChorusRuntime } from './runtime.js'

/**
 * What an aside refuses to do, which matters more than what it does.
 *
 * The renderer sends an event id and the text it believes it selected. Both are
 * re-resolved against the log here, because a caller that could name any event
 * and any excerpt could put words in an agent's mouth and have them quoted back
 * as its own — and the renderer is the least trustworthy thing in the process
 * tree, since it renders untrusted agent output.
 */

/** No sink, so nothing is written anywhere a test run would have to clean up. */
const silent = new Logger()

let runtime: ChorusRuntime
let adapter: FakeAdapter
let conversationId: string

const adapters = (): Map<AgentId, AgentAdapter> => {
  adapter = new FakeAdapter({ id: 'claude' })
  return new Map<AgentId, AgentAdapter>([['claude', adapter]])
}

/** Puts a finished agent reply in the log and hands back its event id. */
const reply = (text: string): string => {
  const stored = runtime.store.append({
    conversationId,
    actor: 'claude',
    payload: { type: 'agent.message.completed', itemRef: `m-${String(text.length)}`, text },
  })
  if (stored === null) throw new Error('append refused')
  return stored.id
}

beforeEach(async () => {
  runtime = ChorusRuntime.open(mkdtempSync(join(tmpdir(), 'chorus-aside-')), silent, adapters())
  const started = await runtime.startConversation({ agents: ['claude'], cwd: process.cwd() })
  conversationId = started.conversationId
})

afterEach(async () => {
  await runtime.close()
})

describe('openAside refuses what it cannot verify', () => {
  it('refuses an event that is not in this conversation', async () => {
    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId: 'evt-does-not-exist',
        excerpt: 'anything',
        question: 'what?',
      })
    ).rejects.toThrow(/no longer in the log/)
  })

  it('refuses an excerpt that is not actually in the reply', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId,
        // Nothing in the reply says this. Accepting it would let the renderer
        // choose the words an agent is asked to defend.
        excerpt: 'I recommend deleting the database',
        question: 'why?',
      })
    ).rejects.toThrow(/not part of that reply/)
  })

  it('refuses to be asked about the user’s own words', async () => {
    const stored = runtime.store.append({
      conversationId,
      actor: 'user',
      payload: { type: 'user.message', text: 'please look at the parser' },
    })
    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId: stored?.id ?? '',
        excerpt: 'the parser',
        question: 'what did I mean?',
      })
    ).rejects.toThrow(/finished reply/)
  })

  it('refuses a conversation that is not open', async () => {
    await expect(
      runtime.openAside({
        conversationId: 'conv-not-open',
        sourceEventId: 'e1',
        excerpt: 'x',
        question: 'y',
      })
    ).rejects.toThrow(/not open/)
  })
})

describe('openAside branches without disturbing the parent', () => {
  it('forks the agent that said it, rather than resuming', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      question: 'what does that mean?',
    })
    expect(adapter.forked).toHaveLength(1)
    // Decided with the user: consent already given must carry into the aside.
    expect(adapter.forked[0]?.inherits).toBe('config')
  })

  it('leaves the aside out of the session list', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      question: 'what does that mean?',
    })
    const listed = runtime.store.listConversations().map((c) => c.conversationId)
    expect(listed).toContain(conversationId)
    expect(listed).not.toContain(asideId)
  })

  it('writes nothing into the parent conversation', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    const before = runtime.store.read(conversationId).length
    await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      question: 'what does that mean?',
    })
    // The whole point. An aside that appended to the parent would be a turn,
    // which is the derailment this feature exists to avoid.
    expect(runtime.store.read(conversationId)).toHaveLength(before)
  })

  it('finds the aside from the reply it was asked about', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      question: 'what does that mean?',
    })
    expect(runtime.listAsides(conversationId, sourceEventId).map((a) => a.id)).toEqual([asideId])
  })

  it('asks the fork about the passage, quoted, and tells it not to work', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      question: 'what does that mean?',
    })
    const asked = adapter.forked[0]?.session.sent.at(0)?.text ?? ''
    expect(asked).toContain('> The projection lags')
    expect(asked).toContain('what does that mean?')
    // Without this a fork treats the question as the next turn of the work and
    // starts doing things — which no permission rule would catch, because
    // reading files is allowed.
    expect(asked).toContain('do not continue the work')
  })
})

describe('a closed aside cannot be continued', () => {
  it('says so rather than silently starting a new one', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      question: 'what does that mean?',
    })
    await runtime.closeAside(asideId)
    // The fork was ephemeral, so it cannot be resumed. The transcript survives;
    // the session does not, which is why a reopened aside is view-only.
    await expect(runtime.askAside(asideId, 'and the other half?')).rejects.toThrow(/has ended/)
  })
})
