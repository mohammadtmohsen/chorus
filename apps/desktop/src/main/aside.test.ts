import { FakeAdapter } from '@chorus/orchestrator'
import type { AgentAdapter } from '@chorus/agent-protocol'
import { Logger, newApprovalId, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChorusRuntime, explainPrompt } from './runtime.js'
import { DEFAULT_SETTINGS, writeSettings } from './settings.js'

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
let dataPath: string

const adapters = (): Map<AgentId, AgentAdapter> => {
  adapter = new FakeAdapter({ id: 'claude' })
  return new Map<AgentId, AgentAdapter>([['claude', adapter]])
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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
  dataPath = mkdtempSync(join(tmpdir(), 'chorus-aside-'))
  runtime = ChorusRuntime.open(dataPath, silent, adapters())
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

describe('the fork boots before there is a question', () => {
  it('opens without one, so the CLI starts while the user types', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
    })
    // Forked and attached, but nothing asked yet. Two thirds of the measured
    // wait was this happening after Enter rather than before it.
    expect(adapter.forked).toHaveLength(1)
    expect(adapter.forked[0]?.session.sent).toHaveLength(0)
    expect(asideId).not.toBe('')
  })

  it('anchors every follow-up to the passage, not just the first', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
    })
    await runtime.askAside(asideId, 'what does that mean?')
    await runtime.askAside(asideId, 'and how far behind?')

    const sent = adapter.forked[0]?.session.sent ?? []
    expect(sent).toHaveLength(2)
    // A follow-up three turns in should still be about the passage rather than
    // about whatever was said most recently.
    for (const message of sent) {
      expect(message.text).toContain('> The projection lags')
      expect(message.text).toContain('do not continue the work')
    }
    expect(sent[1]?.text).toContain('and how far behind?')
  })
})

describe('an aside may explain, not act', () => {
  it('does not inherit a grant the user gave in the parent conversation', async () => {
    const publish = {
      kind: 'command' as const,
      command: ['npm', 'publish'],
      cwd: process.cwd(),
      withNetwork: false,
      expiresAt: 5 * 60_000,
    }

    // The user allows it once, always, in the room.
    const parentSession = adapter.sessions[0]
    const granted = newApprovalId()
    parentSession?.emit({
      type: 'approval.requested',
      request: { id: granted, ...publish },
    } as never)
    await tick()
    await runtime.decideApproval(conversationId, 'claude', granted, {
      outcome: 'allow',
      scope: 'always',
    })

    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
    })

    // The same command, now inside the fork. A grant outranks `ask`, and an
    // aside never asks — so carrying the parent's grants would have let this run
    // silently in a window nobody is watching.
    const fork = adapter.forked[0]?.session
    fork?.emit({
      type: 'approval.requested',
      request: { id: newApprovalId(), ...publish },
    } as never)
    await tick()

    const verdicts = runtime.store
      .read(asideId)
      .filter((e) => e.payload.type === 'approval.decided')
      .map((e) => (e.payload as unknown as { outcome: string }).outcome)
    expect(verdicts).toEqual(['deny'])
  })
})

describe('explainPrompt', () => {
  const prompt = explainPrompt('The projection lags behind the log.', 'Lebanese Arabic')

  it('quotes the passage, so the fork is anchored to it', () => {
    expect(prompt).toContain('> The projection lags behind the log.')
  })

  it('names the language, more than once', () => {
    // Once is a suggestion. The measured failure is drifting back to English
    // after the first sentence, and the prompt has to still be arguing by then.
    expect(prompt.match(/Lebanese Arabic/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('asks for plain language before it asks for a language', () => {
    // Level first, language second. Leading with the language produces a
    // faithful translation of something still too dense.
    expect(prompt.indexOf('Short sentences')).toBeLessThan(prompt.indexOf('Write every word'))
  })

  it('names the reader as a developer, so the answer is not condescending', () => {
    expect(prompt).toContain('not a beginner')
  })

  it('keeps identifiers as written rather than translating them', () => {
    expect(prompt).toContain('exactly as written')
  })

  it('carries the do-not-work clause', () => {
    // Without it a fork treats the request as the next turn of the work, which
    // no permission rule catches because reading files is allowed.
    expect(prompt).toContain('Do not continue the work')
  })

  it('quotes a multi-line passage as one block', () => {
    expect(explainPrompt('one\n\ntwo', 'Arabic')).toContain('> one\n>\n> two')
  })
})

describe('opening an explanation', () => {
  const withLanguage = (language: string): void => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, explainLanguage: language })
  }

  it('refuses when no language is set, rather than guessing one', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId,
        excerpt: 'The projection lags',
        purpose: 'explanation',
      })
    ).rejects.toThrow(/No language is set/)
  })

  it('asks the fork immediately, because there is nothing to type', async () => {
    withLanguage('Arabic')
    const sourceEventId = reply('The projection lags behind the log.')
    await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'explanation',
    })
    const sent = adapter.forked[0]?.session.sent ?? []
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('Arabic')
    expect(sent[0]?.text).toContain('> The projection lags')
  })

  it('logs the intent in the user’s words, not the instruction', async () => {
    withLanguage('Arabic')
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'explanation',
    })
    const said = runtime.store
      .read(asideId)
      .filter((e) => e.payload.type === 'user.message')
      .map((e) => (e.payload as unknown as { text: string }).text)
    // What someone reopening this in a week needs to see — not four paragraphs
    // of prompt they never wrote.
    expect(said).toEqual(['Explain this in Arabic.'])
  })

  it('records the purpose and the language as they were', async () => {
    withLanguage('Arabic')
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'explanation',
    })

    // Changing the setting afterwards must not rewrite history.
    withLanguage('French')
    const created = runtime.store
      .read(asideId)
      .find((e) => e.payload.type === 'conversation.created')
    const aside = (created?.payload as unknown as { aside: Record<string, unknown> }).aside
    expect(aside).toMatchObject({ purpose: 'explanation', language: 'Arabic' })
  })

  it('reads an aside opened without a purpose as a question', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
    })
    const created = runtime.store
      .read(asideId)
      .find((e) => e.payload.type === 'conversation.created')
    const aside = (created?.payload as unknown as { aside: { purpose: string } }).aside
    expect(aside.purpose).toBe('question')
  })
})
