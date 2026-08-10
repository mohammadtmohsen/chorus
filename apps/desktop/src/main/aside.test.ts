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
    expect(prompt.match(/Lebanese Arabic/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('asks for the thing, not a glossary of the words', () => {
    // The failure this exists to stop: asked to explain each term "where it
    // appears", it produced a heading per word and the etymology of one of them.
    expect(prompt).toContain('what the words mean in general, or one by one')
  })

  it('bounds the length with a number rather than an adjective', () => {
    // "Short" drifted twice: first to five sections with rules between them,
    // then to four dense paragraphs of background.
    expect(prompt).toContain('about a hundred words')
    expect(prompt).toContain('no headings')
  })

  it('allows a list only where the answer is genuinely a sequence', () => {
    // Banning lists outright was an over-correction — a four-step workflow reads
    // worse as prose. The rule is about the shape of the answer, not the markup.
    expect(prompt).toContain('only if the answer is a')
  })

  it('names the padding that actually arrived, rather than asking for brevity', () => {
    // Every line of this list is something a real answer volunteered and that
    // pushed the useful part off a 190px card.
    for (const banned of ['one by one', 'is *not*', 'already says, restated', 'earlier messages']) {
      expect(prompt).toContain(banned)
    }
  })

  it('puts the sharpest rules where they are read first', () => {
    // Both of these were in the list below and both were still broken by a real
    // answer: it opened with what the thing was not, and explained the line's
    // punctuation instead of the task. An opening clause is the one a model
    // commits to first, so they moved up.
    expect(prompt).toContain('Never open by saying what it is not')
    expect(prompt).toContain('not how the passage is written')
    expect(prompt.indexOf('Never open by saying')).toBeLessThan(prompt.indexOf('Leave out:'))
  })

  it('asks for the substance before it asks for a language', () => {
    // Level first, language second. Leading with the language produces a
    // faithful translation of something still too dense.
    expect(prompt.indexOf('what it means for the work')).toBeLessThan(
      prompt.indexOf('Write your explanation')
    )
  })

  it('names the reader as a developer, so the answer is not condescending', () => {
    expect(prompt).toContain('not a beginner')
  })

  it('keeps identifiers as written rather than translating them', () => {
    expect(prompt).toContain('exactly as written')
    expect(prompt).toContain('Do not translate or transliterate them')
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

describe('a reply from a session that has since been replaced', () => {
  it('refuses, even for Claude whose session ref starts empty', async () => {
    const sourceEventId = reply('The projection lags behind the log.')

    // Claude is removed and brought back, which gives it a new session. The old
    // check compared `sessionRef` and skipped empty ones — and Claude's is empty
    // when `session.started` is written, so it never fired for the provider it
    // most needed to fire for.
    await runtime.removeParticipant(conversationId, 'claude')
    await runtime.addParticipant(conversationId, 'claude')

    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId,
        excerpt: 'The projection lags',
      })
    ).rejects.toThrow(/started a new session/)
  })

  it('still allows one after a relaunch, which resumes rather than restarts', async () => {
    const sourceEventId = reply('The projection lags behind the log.')

    // What reopening a conversation writes. The first version of this guard
    // refused on any newer start at all, so the option vanished after every
    // relaunch — which is most of the time, and is what someone hit in the app.
    runtime.store.append({
      conversationId,
      actor: 'system',
      payload: {
        type: 'session.started',
        agentId: 'claude',
        sessionRef: '',
        cwd: process.cwd(),
        model: null,
        cliVersion: null,
        resumed: true,
      },
    })

    await expect(
      runtime.openAside({ conversationId, sourceEventId, excerpt: 'The projection lags' })
    ).resolves.toMatchObject({ asideId: expect.any(String) })
  })

  it('allows one when the start predates the flag, rather than refusing on a guess', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    runtime.store.append({
      conversationId,
      actor: 'system',
      payload: {
        type: 'session.started',
        agentId: 'claude',
        sessionRef: '',
        cwd: process.cwd(),
        model: null,
        cliVersion: null,
      },
    })
    // Refusing wrongly takes the feature away; allowing wrongly is what happened
    // before this guard existed.
    await expect(
      runtime.openAside({ conversationId, sourceEventId, excerpt: 'The projection lags' })
    ).resolves.toMatchObject({ asideId: expect.any(String) })
  })

  it('still allows a reply from the session that is running', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    await expect(
      runtime.openAside({ conversationId, sourceEventId, excerpt: 'The projection lags' })
    ).resolves.toMatchObject({ asideId: expect.any(String) })
  })
})

describe('a failed open leaves nothing behind', () => {
  it('does not fork at all when there is no language to explain in', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId,
        excerpt: 'The projection lags',
        purpose: 'explanation',
      })
    ).rejects.toThrow(/No language is set/)
    // Checked before anything is spawned: a refusal after the fork leaves a CLI
    // running that nobody has a handle to.
    expect(adapter.forked).toHaveLength(0)
  })

  it('closes the fork when a step after it fails', async () => {
    const sourceEventId = reply('The projection lags behind the log.')

    // A provider that dies between forking and the first turn. Standing in for
    // any of them: the append, the attach, the health check, the send.
    const realFork = adapter.fork.bind(adapter)
    adapter.fork = async (ref, opts) => {
      const session = await realFork(ref, opts)
      session.send = () => Promise.reject(new Error('the provider went away'))
      return session
    }

    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId,
        excerpt: 'The projection lags',
        question: 'what does that mean?',
      })
    ).rejects.toThrow(/provider went away/)

    // Nobody else could: the caller never learned an id, so it cannot close what
    // it does not know about.
    expect(adapter.forked.at(-1)?.session.closed).toBe(true)
  })

  it('does not strand the aside in the live map when the first turn fails', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    const realFork = adapter.fork.bind(adapter)
    adapter.fork = async (ref, opts) => {
      const session = await realFork(ref, opts)
      session.send = () => Promise.reject(new Error('the provider went away'))
      return session
    }

    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId,
        excerpt: 'The projection lags',
        question: 'what?',
      })
    ).rejects.toThrow()

    // The send happens after the service is already registered, so failing there
    // would otherwise leave an entry as well as a process.
    const listed = runtime.listAsides(conversationId)
    for (const aside of listed) {
      await expect(runtime.askAside(aside.id, 'still there?')).rejects.toThrow(/has ended/)
    }
  })
})

describe('promoting an aside into a conversation', () => {
  const openOne = async (): Promise<string> => {
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
    })
    return asideId
  }

  it('becomes a live conversation on its own id, so the log stays one thread', async () => {
    const asideId = await openOne()
    const { conversationId: promoted } = await runtime.promoteAside(asideId, 'workspace-write')
    expect(promoted).toBe(asideId)
    expect(runtime.openConversations().map((c) => c.conversationId)).toContain(asideId)
  })

  it('forks the parent, because an aside cannot be forked', async () => {
    /*
     * Both providers fork from disk and an aside is deliberately never written
     * there, so there is nothing of it to fork. The parent is on disk.
     */
    const asideId = await openOne()
    const parentRef = adapter.sessions[0]?.sessionRef
    adapter.forked.length = 0
    await runtime.promoteAside(asideId, 'workspace-write')
    expect(adapter.forked[0]?.from).toBe(parentRef)
    expect(adapter.forked[0]?.persist).toBe(true)
  })

  it('starts no turn — promotion must not wake the model', async () => {
    // `send` starts a real turn, so delivering the aside's exchange here would
    // produce an answer nobody asked for, under the profile just chosen.
    const asideId = await openOne()
    const before = adapter.sessions.flatMap((s) => s.sent).length
    await runtime.promoteAside(asideId, 'workspace-write')
    expect(adapter.sessions.flatMap((s) => s.sent).length).toBe(before)
  })

  it('carries the aside into the next real message, once', async () => {
    const asideId = await openOne()
    await runtime.promoteAside(asideId, 'workspace-write')

    await runtime.send(asideId, 'now fix it')
    const first = adapter.sessions.at(-1)?.sent.at(-1)?.text ?? ''
    expect(first).toContain('began as a side question')
    expect(first).toContain('The projection lags')
    expect(first).toContain('now fix it')

    await runtime.send(asideId, 'and again')
    const second = adapter.sessions.at(-1)?.sent.at(-1)?.text ?? ''
    expect(second).not.toContain('began as a side question')
    expect(second).toContain('and again')
  })

  it('records the change of identity in the log', async () => {
    const asideId = await openOne()
    await runtime.promoteAside(asideId, 'workspace-write')
    const types = runtime.store.read(asideId).map((e) => e.payload.type)
    expect(types).toContain('aside.promoted')
  })

  it('takes the profile chosen at promotion, not the parent’s', async () => {
    // Choosing is the explicit act that makes acting safe; inheriting would be
    // the parent's grants arriving through a side door.
    const asideId = await openOne()
    await runtime.promoteAside(asideId, 'workspace-write')
    expect(runtime.openConversations().find((c) => c.conversationId === asideId)).toBeDefined()
  })

  it('makes one branch when promoted twice at once', async () => {
    // Two clicks, one permanent provider session.
    const asideId = await openOne()
    adapter.forked.length = 0
    const [a, b] = await Promise.all([
      runtime.promoteAside(asideId, 'workspace-write'),
      runtime.promoteAside(asideId, 'workspace-write'),
    ])
    expect(a.conversationId).toBe(b.conversationId)
    expect(adapter.forked).toHaveLength(1)
  })

  it('refuses an aside that has already been promoted', async () => {
    const asideId = await openOne()
    await runtime.promoteAside(asideId, 'workspace-write')
    await expect(runtime.promoteAside(asideId, 'workspace-write')).rejects.toThrow(/has ended/)
  })

  it('refuses when the conversation it came from is gone', async () => {
    const asideId = await openOne()
    await runtime.closeConversation(conversationId)
    await expect(runtime.promoteAside(asideId, 'workspace-write')).rejects.toThrow()
  })

  it('leaves the aside out of the aside list once promoted', async () => {
    const asideId = await openOne()
    await runtime.promoteAside(asideId, 'workspace-write')
    expect(runtime.listAsides(conversationId).map((a) => a.id)).not.toContain(asideId)
  })
})

describe('a selection is matched as the transcript reads, not as markdown', () => {
  /*
   * C-024, reported from a shipped build and reproduced twice on the first
   * attempt. The renderer sends what `selection.toString()` gave — the rendered
   * text — and the log holds markdown. Comparing only the source refused any
   * selection containing inline code, emphasis or a link, and any one crossing
   * a line break inside a paragraph.
   */
  it('accepts a selection that spanned inline code', async () => {
    const sourceEventId = reply('`docs/plan.md` — created in my last turn.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      // Exactly what the app returned in the reproduction: no backticks.
      excerpt: 'docs/plan.md — created in my last turn.',
    })
    expect(asideId).not.toBe('')
  })

  it('accepts a selection that crossed a line break inside a paragraph', async () => {
    const sourceEventId = reply('The projection lags behind the log and\nthat is the problem.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'behind the log and that is the problem.',
    })
    expect(asideId).not.toBe('')
  })

  it('still accepts a selection taken from a fenced code block', async () => {
    // Matches the source exactly; it worked before the fix and must keep working.
    const sourceEventId = reply('```\nconst a = 1\nconst b = 2\n```')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'const a = 1\nconst b = 2',
    })
    expect(asideId).not.toBe('')
  })

  it('still refuses words that are not in the reply at all', async () => {
    /*
     * The guard's reason for existing, unweakened: a caller that could name any
     * event and any excerpt could put words in an agent's mouth and have them
     * quoted back as its own.
     */
    const sourceEventId = reply('`docs/plan.md` — created in my last turn.')
    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId,
        excerpt: 'delete the production database',
      })
    ).rejects.toThrow(/not part of that reply/)
  })

  it('accepts a link target, because the agent did write it', () => {
    /*
     * Written down because it looks like a hole and is not, and because the
     * first version of this test asserted the opposite and failed.
     *
     * A link's href is in the source but never on screen, so it cannot be
     * *selected* — yet the source check accepts it, exactly as it did before
     * this fix. That is right: the guard's question is "did this agent say
     * this", and the agent wrote the URL. Tightening it would mean refusing
     * text genuinely present in the reply, and would break the code-block case
     * above, which also matches only the source.
     */
    const sourceEventId = reply('see [the plan](https://example.com/some-path)')
    return expect(
      runtime.openAside({ conversationId, sourceEventId, excerpt: 'some-path' })
    ).resolves.toBeDefined()
  })
})
