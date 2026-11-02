import { FakeAdapter } from '@chorus/orchestrator'
import type { AgentAdapter } from '@chorus/agent-protocol'
import { Logger, newApprovalId, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChorusRuntime,
  explainPrompt,
  forwardedFromAside,
  goPrompt,
  NAMER_INSTRUCTIONS,
  translatePrompt,
} from './runtime.js'
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

/**
 * What the newest session in an actual conversation was last handed.
 *
 * **Not `sessions.at(-1)`, and the difference is a second session nobody
 * expected.** `send` fires `nameTopic`, which starts its *own* session on the
 * same adapter to turn the message into a title, and hands it `route.text`. From
 * that point `sessions.at(-1)` stopped meaning "the agent in this room" and
 * started meaning "whichever session was created last" — usually the namer's.
 *
 * The failure it caused was quiet in the worst way: an assertion that the agent
 * received the user's words still **passed**, because the namer is handed those
 * same words. Only the two claims about text the namer never sees — the `Go`
 * intent's prompt and an aside's carryover — could see the difference, and they
 * read as the feature being broken rather than the reading being wrong.
 *
 * `instructions` is set on exactly one path in the whole runtime — `startNamer`
 * — so it is the namer's own mark rather than a guess about ordering. Read off
 * the session rather than out of `adapter.startedOpts`: that array is fed by
 * `start` and `resume` but not by `fork`, so indexing it by a session's position
 * is aligned only until the first fork. An aside *is* a fork, so every test here
 * is past that point, and the skewed read still type-checks and still passes —
 * it just answers about a different session.
 */
const sentToAgent = (): string => {
  const own = adapter.sessions.filter((s) => s.startedWith?.instructions !== NAMER_INSTRUCTIONS)
  return own.at(-1)?.sent.at(-1)?.text ?? ''
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
  const started = await runtime.startConversationIn({ agents: ['claude'], cwd: process.cwd() })
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

  /**
   * A question card may be asked about, and forging its words still may not.
   *
   * The guard used to refuse every payload that was not `agent.message.completed`,
   * which is what made the card's Explain, Translate and Ask actions impossible.
   * Widening it is only safe because main re-derives the text itself: the
   * renderer says *which event*, never *what it said*. This pair is what says so
   * — the first proves the door opened, the second proves it is still a door and
   * not a hole.
   */
  it('accepts a question the agent is blocked on', async () => {
    const stored = runtime.store.append({
      conversationId,
      actor: 'claude',
      payload: {
        type: 'userinput.requested',
        userInputId: 'ui-1',
        request: {
          questions: [
            {
              id: 'q1',
              header: 'Model',
              question: 'Which model do we hand to BE?',
              options: [
                { label: 'Two keys, one axis each', description: 'status replaces active' },
              ],
              isSecret: false,
            },
          ],
        },
        expiresAt: Date.now() + 60_000,
      },
    })
    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId: stored?.id ?? '',
        // Exactly what `questionText` builds, because that is what the card
        // sends and what main re-derives.
        excerpt:
          'Model\nWhich model do we hand to BE?\nTwo keys, one axis each: status replaces active',
        question: 'what is activeFilter?',
      })
    ).resolves.toMatchObject({ asideId: expect.any(String) })
  })

  it('still refuses words a question never contained', async () => {
    const stored = runtime.store.append({
      conversationId,
      actor: 'claude',
      payload: {
        type: 'userinput.requested',
        userInputId: 'ui-2',
        request: { questions: [{ id: 'q1', question: 'Which model?', isSecret: false }] },
        expiresAt: Date.now() + 60_000,
      },
    })
    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId: stored?.id ?? '',
        // The card never said this. Accepting it would let the renderer choose
        // the words an agent is asked to defend — the whole point of the guard.
        excerpt: 'Shall I drop the production database?',
        question: 'why?',
      })
    ).rejects.toThrow(/not part of that reply/)
  })

  /**
   * Restating inside an aside, and what it refuses.
   *
   * The card is where someone went because they did not follow something, so the
   * same two actions have to work on the aside's own answer. It is a follow-up
   * in the same fork rather than a nested aside — the panel is single, and
   * replacing it would discard the answer being read.
   */
  it('refuses to restate an aside that has ended', async () => {
    await expect(runtime.restateAside('aside-gone', 'explanation')).rejects.toThrow(
      /has ended|no longer/
    )
  })

  it('refuses to restate before the aside has answered', async () => {
    // A language first, because the language gate is checked before anything
    // else and would otherwise be what this test proved.
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, explainLanguage: 'Arabic' })
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      question: 'why?',
    })
    // Nothing has come back yet, so there is no latest answer to point at — and
    // explaining the question the user just typed would be nonsense.
    await expect(runtime.restateAside(asideId, 'translation')).rejects.toThrow(/not answered yet/)
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

  /**
   * The card keeps answering in the language it was opened in.
   *
   * Reported from the running app: Explain answered in Arabic, and the moment a
   * second question was typed the answer came back in English. Only the opening
   * prompt named a language, and a model answers in the language it was asked
   * in — so the feature worked exactly once for the person it exists for.
   */
  it('keeps answering an explanation in its language, however the question is typed', async () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, explainLanguage: 'Arabic' })
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'explanation',
    })

    // Typed in English, which is how a developer types and says nothing about
    // what they want to read.
    await runtime.askAside(asideId, 'so what happens if I restart?')

    const sent = adapter.forked[0]?.session.sent ?? []
    const followUp = sent[1]?.text ?? ''
    expect(followUp).toContain('Answer in Arabic')
    expect(followUp).toContain('whatever language the')
    // The identifiers stay put, as they do in the opening prompt.
    expect(followUp).toContain('Do not translate or transliterate them')
  })

  it('carries the language of a translation card too', async () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, explainLanguage: 'Arabic' })
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'translation',
    })
    await runtime.askAside(asideId, 'and the second sentence?')
    expect(adapter.forked[0]?.session.sent[1]?.text).toContain('Answer in Arabic')
  })

  /*
   * An ordinary "Ask about this" names no language, and inventing one would
   * answer a plain question in a language nobody chose.
   */
  it('says nothing about language in a card that was never given one', async () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, explainLanguage: 'Arabic' })
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'question',
    })
    await runtime.askAside(asideId, 'what does that mean?')
    expect(adapter.forked[0]?.session.sent.at(-1)?.text).not.toContain('Answer in Arabic')
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
    // pushed the useful part off the bottom of a card this size.
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
    expect(prompt).toContain('not how the reply is written')
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

  /**
   * The vocabulary stays in English, not only the names.
   *
   * Identifiers and paths were already protected — a translated name points at
   * nothing. The words *around* them were not, so `event`, `status` and
   * `variable` came back rendered into the target language, and the reader had
   * to translate them back before they could search for them or match them
   * against the code. Reported from the running app.
   */
  it('keeps the technical vocabulary in English, not just the identifiers', () => {
    expect(prompt).toContain('Keep the technical vocabulary in English')
    for (const term of ['event, status, variable', 'endpoint']) {
      expect(prompt).toContain(term)
    }
    expect(prompt).toContain('Keep identifiers, file names and paths')
  })

  it('says the subject is the whole reply, and holds the length against it', () => {
    /*
     * Explain is asked from a button under a reply now rather than from a drag,
     * so what arrives here is a whole answer. A model told it has a *passage*
     * treats a long one as a request for a long explanation — which is a second
     * long answer to read instead of a way through the first.
     */
    expect(prompt).toContain('your reply below')
    expect(prompt).toContain('However long the reply is')
    expect(prompt).not.toContain('the passage below')
  })
})

/**
 * The same rule, in the other two places prose comes back in another language.
 * One constant feeds all three; these are what would notice if a copy appeared.
 */
describe('the terms rule reaches every prompt that translates', () => {
  it('is in a translation', () => {
    const prompt = translatePrompt('The projection lags.', 'Arabic')
    expect(prompt).toContain('Keep the technical vocabulary in English')
  })

  it('is in a follow-up inside a card that has a language', async () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, explainLanguage: 'Arabic' })
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'explanation',
    })
    await runtime.askAside(asideId, 'and the status field?')
    expect(adapter.forked[0]?.session.sent[1]?.text).toContain(
      'Keep the technical vocabulary in English'
    )
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

describe('opening a translation', () => {
  const withLanguage = (language: string): void => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, explainLanguage: language })
  }
  const created = (asideId: string): Record<string, unknown> => {
    const event = runtime.store.read(asideId).find((e) => e.payload.type === 'conversation.created')
    return (event?.payload as unknown as { aside: Record<string, unknown> }).aside
  }

  it('refuses before forking when no language is set', async () => {
    const sourceEventId = reply('The projection lags behind the log.')
    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId,
        excerpt: 'The projection lags',
        purpose: 'translation',
      })
    ).rejects.toThrow(/No language is set to translate into/)
    // Before, not after: a refusal past the fork leaves a CLI running that
    // nobody holds a handle to.
    expect(adapter.forked).toHaveLength(0)
  })

  it('sends exactly one turn, and it is the translation', async () => {
    withLanguage('Arabic')
    const sourceEventId = reply('The projection lags behind the log.')
    await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'translation',
    })
    const sent = adapter.forked[0]?.session.sent ?? []
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('> The projection lags')
    expect(sent[0]?.text).toContain('standard written form')
    // The branch above it in the same if/else chain.
    expect(sent[0]?.text).not.toContain('Do not restate the passage')
  })

  it('logs the intent in the user’s words, not the instruction', async () => {
    withLanguage('Arabic')
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'translation',
    })
    const said = runtime.store
      .read(asideId)
      .filter((e) => e.payload.type === 'user.message')
      .map((e) => (e.payload as unknown as { text: string }).text)
    expect(said).toEqual(['Translate this into Arabic.'])
  })

  it('records the purpose and the language as they were', async () => {
    withLanguage('Arabic')
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'translation',
    })
    withLanguage('French')
    expect(created(asideId)).toMatchObject({ purpose: 'translation', language: 'Arabic' })
  })

  it('echoes back the language main actually used', async () => {
    withLanguage('Arabic')
    const sourceEventId = reply('The projection lags behind the log.')
    const opened = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'translation',
    })
    expect(opened.language).toBe('Arabic')
  })

  /*
   * A third arm on a shared chain is a chance to change the other two, and the
   * language read and the turn dispatch are both shared. These are the
   * regression, not the feature.
   */
  it('leaves an explanation alone', async () => {
    withLanguage('Arabic')
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      purpose: 'explanation',
    })
    const sent = adapter.forked[0]?.session.sent ?? []
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('Do not restate the reply')
    expect(created(asideId)).toMatchObject({ purpose: 'explanation', language: 'Arabic' })
  })

  it('leaves a question alone, and still reads no purpose as one', async () => {
    withLanguage('Arabic')
    const sourceEventId = reply('The projection lags behind the log.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      question: 'why?',
    })
    const sent = adapter.forked[0]?.session.sent ?? []
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('short side question')
    expect(created(asideId)['purpose']).toBe('question')
  })

  it('does not read the language for a question, which has no use for one', async () => {
    // The read is shared; only two of the three purposes want it. A question
    // must not start refusing because a preference is empty.
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, explainLanguage: '' })
    const sourceEventId = reply('The projection lags behind the log.')
    const opened = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'The projection lags',
      question: 'why?',
    })
    expect(opened.language).toBe('')
  })
})

describe('a reply from a session that has since been replaced', () => {
  it('refuses, even for Claude whose session ref starts empty', async () => {
    const sourceEventId = reply('The projection lags behind the log.')

    /*
     * A fresh start for an agent that was already here — written, not driven.
     *
     * This used to remove Claude and bring it back, and that operation is gone:
     * the cast is fixed, so nothing takes an agent out any more. The guard reads
     * the log rather than the live session, so the event is the whole input, and
     * the sibling test below already drives it this way for the resumed case.
     *
     * `sessionRef: ''` is the point of the test. Claude's real id arrives with
     * its first message, so a start is written with an empty ref — and the old
     * check compared refs and skipped empty ones, which meant it never fired for
     * the provider it most needed to fire for.
     */
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
        resumed: false,
      },
    })

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
    const first = sentToAgent()
    expect(first).toContain('began as a side question')
    expect(first).toContain('The projection lags')
    expect(first).toContain('now fix it')

    await runtime.send(asideId, 'and again')
    const second = sentToAgent()
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

/**
 * A translation is the opposite of an explanation, so the assertions are too.
 *
 * `explainPrompt` above is asserted on for what it refuses to produce; this is
 * asserted on for producing the passage itself. The two prompts sharing a string
 * would mean one of these suites fixing a bad answer by breaking the other.
 */
describe('translatePrompt', () => {
  const prompt = translatePrompt('The projection lags behind the log.', 'Arabic')

  it('quotes the passage, so the fork is anchored to it', () => {
    expect(prompt).toContain('> The projection lags behind the log.')
  })

  it('names the language more than once', () => {
    // Same measured failure as explaining: one mention is a suggestion, and the
    // drift back to the source language happens after the first sentence.
    expect(prompt.match(/Arabic/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('asks for the passage rather than an account of it', () => {
    // The line explain gets its value from — "Do not restate the passage" — is
    // exactly the job here, so its absence is the assertion.
    expect(prompt).not.toContain('Do not restate the passage')
    expect(prompt).toContain('Your reply is the passage itself, in another language')
    expect(prompt).toContain('Do not explain it, summarise it, expand it')
  })

  it('asks for the standard written form, not a dialect or a reading level', () => {
    // The shared setting accepts "Lebanese Arabic" and "simple Arabic". Asked
    // for as "standard arabic translation", so the prompt says which it wants
    // rather than inheriting whichever qualifier was typed for explanations.
    expect(prompt).toContain('standard written form')
    expect(prompt).toContain('not a regional dialect and not a simplified reading level')
  })

  it('takes its register from the passage', () => {
    expect(prompt).toContain('terse stays terse')
  })

  it('separates code from prose, because "keep code exactly" would forbid both', () => {
    // Comments are part of a code block, so one rule cannot both preserve code
    // and translate comments. Two rules can.
    expect(prompt).toContain('translate natural-language comments and docstrings')
    expect(prompt).toContain('reproduce identifiers, keywords, file names, paths, string literals')
    expect(prompt).toContain('so the code still runs')
  })

  it('refuses a paraphrase when the passage is already in the language', () => {
    // Otherwise it comes back reworded, which looks like a translation and is
    // the one output that cannot be told apart from a correct one.
    expect(prompt).toContain('If the passage is already in Arabic')
    expect(prompt).toContain('Do not paraphrase it.')
  })

  it('carries the do-not-work clause every aside prompt carries', () => {
    // Not explanation-specific tuning: without it a fork treats the request as
    // the next turn of the work and starts doing things, which no permission
    // rule catches because reading files is allowed. A translation request looks
    // more like a task than a question does.
    expect(prompt).toContain('Do not continue the work or change anything. Answer this and stop.')
  })

  it('leaves no room for a preamble', () => {
    expect(prompt).toContain('No preamble')
  })
})

/**
 * The `Go` intent, which is the one place `send` delivers something other than
 * what it logged.
 *
 * Driving the app proves the chip appears and that `@claude Go ahead.` is what
 * the transcript keeps. It cannot see the other half — what actually reached the
 * agent — and that half is the whole point of the intent.
 */
describe('sending with the go intent', () => {
  const logged = (): string[] =>
    runtime.store
      .read(conversationId)
      .filter((e) => e.payload.type === 'user.message')
      .map((e) => (e.payload as { text: string }).text)

  it('logs the short line and delivers the instruction', async () => {
    await runtime.send(conversationId, '@claude Go ahead.', 'go')

    // What a reader sees later is a line they would recognise as their own.
    expect(logged()).toEqual(['@claude Go ahead.'])
    // What the agent reads is the actual instruction.
    expect(sentToAgent()).toContain('Go ahead with what you just proposed')
    expect(sentToAgent()).toContain('do not restate it and do not re-plan it')
  })

  it('carries the clause that survives a wrong guess', async () => {
    // The trigger is a heuristic over prose. Without this the worst misfire is
    // an agent choosing an option nobody picked.
    await runtime.send(conversationId, '@claude Go ahead.', 'go')
    expect(sentToAgent()).toContain('If you were asking me something rather than offering to act')
    expect(sentToAgent()).toContain('Do not guess at what I would have chosen')
  })

  it('leaves an ordinary message exactly as it was', async () => {
    await runtime.send(conversationId, '@claude have a look at the parser')
    expect(sentToAgent()).toContain('have a look at the parser')
    expect(sentToAgent()).not.toContain('Go ahead with what you just proposed')
  })

  it('still routes from the logged text, so the mention picks the agent', async () => {
    // The mention is why the button reaches the reply's author rather than
    // whoever happens to be `lastAddressed`.
    const { targets } = await runtime.send(conversationId, '@claude Go ahead.', 'go')
    expect(targets).toEqual(['claude'])
  })
})

describe('goPrompt', () => {
  const prompt = goPrompt()

  it('asks for the doing, not for the plan again', () => {
    expect(prompt.startsWith('Go ahead with what you just proposed.')).toBe(true)
    expect(prompt).toContain('Start with the doing')
  })

  it('bounds where it may stop', () => {
    expect(prompt).toContain('Stop before the end only if a decision')
    expect(prompt).toContain('ask that one question and nothing else')
  })

  it('is short, unlike its neighbours', () => {
    // `explainPrompt` and `recapPrompt` are long because they ask for a shape a
    // model would not otherwise produce. This asks for what the agent already
    // said it would do, so most of what could be added would re-specify work
    // that is specified one message up.
    expect(prompt.length).toBeLessThan(explainPrompt('x', 'Arabic').length / 2)
  })
})

describe('forwardedFromAside', () => {
  /*
   * The one that is a bug rather than a preference.
   *
   * `parseMentions` only reads mentions at the start of the text, so anything
   * placed above the directive silently costs the message its routing: it stops
   * addressing the agent the user named and falls back to `lastAddressed`. That
   * is a wrong *recipient*, not a wrong-looking message, and nothing downstream
   * would report it — the send succeeds and the wrong agent answers.
   */
  it('keeps the directive first, so a leading mention still routes', () => {
    const out = forwardedFromAside('@codex run the tests', 'the projection lags behind the log')
    expect(out.startsWith('@codex run the tests')).toBe(true)
  })

  it('names the passage it came from, without carrying the side transcript', () => {
    const out = forwardedFromAside('continue', 'the projection lags behind the log')
    expect(out).toContain('from a side question about')
    expect(out).toContain('the projection lags behind the log')
  })

  it('flattens the excerpt, because provenance is one line', () => {
    // A selected passage arrives with whatever newlines it had on screen. Left
    // alone they turn a one-line annotation into a quoted block that buries the
    // instruction it is annotating.
    expect(forwardedFromAside('go on', 'one\n\n  two   three')).toContain('“one two three”')
  })

  it('clips a long excerpt rather than pasting it', () => {
    const long = 'x'.repeat(400)
    const out = forwardedFromAside('go on', long)
    expect(out).toContain('…')
    expect(out.length).toBeLessThan(200)
  })

  it('is just the directive when there is nothing to cite', () => {
    expect(forwardedFromAside('  hold on  ', '   ')).toBe('hold on')
  })
})

describe('naming a conversation', () => {
  let fakes: { claude: FakeAdapter; deepseek: FakeAdapter; codex: FakeAdapter }

  const namerOf = (fake: FakeAdapter): FakeAdapter['sessions'] =>
    fake.sessions.filter((s) => s.startedWith?.instructions?.includes('tab label') === true)

  const titles = (): string[] =>
    runtime.store
      .read(conversationId)
      .filter((e) => e.payload.type === 'conversation.renamed')
      .map((e) => (e.payload as { title: string }).title)

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await tick()
  }

  const flushPromises = async (): Promise<void> => {
    for (let i = 0; i < 100; i += 1) await Promise.resolve()
  }

  beforeEach(async () => {
    await runtime.close()
    fakes = {
      claude: new FakeAdapter({ id: 'claude' }),
      deepseek: new FakeAdapter({ id: 'deepseek' }),
      codex: new FakeAdapter({ id: 'codex' }),
    }
    runtime = ChorusRuntime.open(
      dataPath,
      silent,
      new Map<AgentId, AgentAdapter>([
        ['claude', fakes.claude],
        ['deepseek', fakes.deepseek],
        ['codex', fakes.codex],
      ])
    )
    const started = await runtime.startConversationIn({ agents: ['codex'], cwd: process.cwd() })
    conversationId = started.conversationId
  })

  it('asks Claude first', async () => {
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    const claude = namerOf(fakes.claude)[0]
    expect(claude?.sent.at(-1)?.text).toContain('fix the parser')
    expect(claude?.startedWith?.toolPolicy).toBe('none')
    expect(claude?.startedWith?.sandbox).toEqual({
      mode: 'readOnly',
      writableRoots: [],
      networkAccess: false,
    })
    claude?.emit({ type: 'message.completed', itemRef: 'n1', text: 'Parser fix' })
    await flush()
    expect(titles()).toEqual([])
    claude?.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await flush()
    expect(titles()).toEqual(['Parser fix'])
    expect(claude?.closed).toBe(true)
    expect(namerOf(fakes.deepseek)).toHaveLength(0)
    expect(namerOf(fakes.codex)).toHaveLength(0)
  })

  it('starts each namer on the model chosen for that agent', async () => {
    writeSettings(dataPath, {
      ...DEFAULT_SETTINGS,
      models: { ...DEFAULT_SETTINGS.models, claude: 'opus' },
    })
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    expect(namerOf(fakes.claude)[0]?.startedWith?.model).toBe('opus')
  })

  it('falls back to DeepSeek when Claude’s naming turn fails', async () => {
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    const claude = namerOf(fakes.claude)[0]
    claude?.emit({ type: 'turn.completed', turnRef: 't1', status: 'failed' })
    await flush()
    const deepseek = namerOf(fakes.deepseek)[0]
    expect(claude?.closed).toBe(true)
    expect(deepseek?.sent.at(-1)?.text).toContain('fix the parser')
    deepseek?.emit({ type: 'message.completed', itemRef: 'n1', text: 'Parser fix' })
    deepseek?.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await flush()
    expect(titles()).toEqual(['Parser fix'])
    expect(namerOf(fakes.codex)).toHaveLength(0)
  })

  it('falls through to Codex when the others cannot start', async () => {
    fakes.claude.start = () => Promise.reject(new Error('claude is unavailable'))
    fakes.deepseek.start = () =>
      Promise.reject(new Error('DeepSeek needs an API key. Add one in Settings.'))
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    const codex = namerOf(fakes.codex)[0]
    expect(codex?.sent.at(-1)?.text).toContain('fix the parser')
    codex?.emit({ type: 'message.completed', itemRef: 'n1', text: 'Parser fix' })
    codex?.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await flush()
    expect(titles()).toEqual(['Parser fix'])
  })

  it('skips a demoted agent and tells a fresh helper the current title', async () => {
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    namerOf(fakes.claude)[0]?.emit({ type: 'turn.completed', turnRef: 't1', status: 'failed' })
    await flush()
    const deepseek = namerOf(fakes.deepseek)[0]
    deepseek?.emit({ type: 'message.completed', itemRef: 'n1', text: 'Parser fix' })
    deepseek?.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await flush()

    await runtime.send(conversationId, '@codex and the lexer too')
    await flush()
    expect(namerOf(fakes.claude)).toHaveLength(1)
    expect(namerOf(fakes.deepseek)).toHaveLength(2)
    expect(deepseek?.closed).toBe(true)
    const next = namerOf(fakes.deepseek)[1]
    expect(next?.sent.at(-1)?.text).toMatch(/^Current title: Parser fix\n\n/)
    expect(next?.sent.at(-1)?.text).toContain('the lexer too')
  })

  it('discards quota messages and falls through to Codex when both other naming turns fail', async () => {
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()

    for (const fake of [fakes.claude, fakes.deepseek]) {
      const namer = namerOf(fake)[0]
      expect(namer?.sent.at(-1)?.text).toContain('fix the parser')
      namer?.emit({
        type: 'message.completed',
        itemRef: 'quota',
        text: "You've hit your weekly limit · resets 9pm (Asia/Amman)",
      })
      await flush()
      expect(titles()).toEqual([])
      namer?.emit({ type: 'turn.completed', turnRef: 't1', status: 'failed' })
      await flush()
      expect(namer?.closed).toBe(true)
      expect(titles()).toEqual([])
    }

    const codex = namerOf(fakes.codex)[0]
    expect(codex?.sent.at(-1)?.text).toContain('fix the parser')
    codex?.emit({ type: 'message.completed', itemRef: 'n1', text: 'Parser fix' })
    codex?.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await flush()
    expect(titles()).toEqual(['Parser fix'])
  })

  it('tries the next namer immediately after a fatal error', async () => {
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    const claude = namerOf(fakes.claude)[0]
    claude?.emit({ type: 'error', message: 'Weekly quota exhausted', recoverable: false })
    await flush()

    const deepseek = namerOf(fakes.deepseek)[0]
    expect(claude?.closed).toBe(true)
    expect(deepseek?.sent.at(-1)?.text).toContain('fix the parser')
    deepseek?.emit({ type: 'message.completed', itemRef: 'n1', text: 'Parser fix' })
    deepseek?.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await flush()
    expect(titles()).toEqual(['Parser fix'])
  })

  it('tries another namer when a successful turn contains no usable title', async () => {
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    const claude = namerOf(fakes.claude)[0]
    claude?.emit({ type: 'message.completed', itemRef: 'n1', text: '""' })
    claude?.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await flush()

    const deepseek = namerOf(fakes.deepseek)[0]
    expect(claude?.closed).toBe(true)
    expect(deepseek?.sent.at(-1)?.text).toContain('fix the parser')
    expect(titles()).toEqual([])
    deepseek?.emit({ type: 'message.completed', itemRef: 'n1', text: 'Parser fix' })
    deepseek?.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
    await flush()
    expect(titles()).toEqual(['Parser fix'])
  })

  it('keeps the current title when every naming turn fails', async () => {
    runtime.renameConversation(conversationId, 'Existing title')
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()

    for (const fake of [fakes.claude, fakes.deepseek, fakes.codex]) {
      const namer = namerOf(fake)[0]
      expect(namer?.sent.at(-1)?.text).toContain('fix the parser')
      namer?.emit({ type: 'message.completed', itemRef: 'quota', text: 'Weekly quota exhausted' })
      namer?.emit({ type: 'turn.completed', turnRef: 't1', status: 'failed' })
      await flush()
      expect(namer?.closed).toBe(true)
      expect(titles()).toEqual(['Existing title'])
    }

    expect(runtime.conversationTitle(conversationId)).toBe('Existing title')
  })

  it('waits for helper cleanup before starting the next request', async () => {
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    const first = namerOf(fakes.claude)[0]
    if (first === undefined) throw new Error('the first title helper did not start')
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const close = first.close.bind(first)
    vi.spyOn(first, 'close').mockImplementation(async () => {
      await held
      await close()
    })
    try {
      await runtime.send(conversationId, '@codex now fix the lexer')
      first.emit({ type: 'message.completed', itemRef: 'n1', text: 'Parser fix' })
      first.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
      await flush()
      expect(namerOf(fakes.claude)).toHaveLength(1)
      release()
      await flush()
      expect(first.closed).toBe(true)
      expect(namerOf(fakes.claude)).toHaveLength(2)
      expect(namerOf(fakes.claude)[1]?.sent.at(-1)?.text).toContain('now fix the lexer')
    } finally {
      release()
    }
  })

  it('starts no replacement helper after its previous process cleanup failed', async () => {
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    const first = namerOf(fakes.claude)[0]
    if (first === undefined) throw new Error('the first title helper did not start')
    const close = vi
      .spyOn(first, 'close')
      .mockRejectedValue(new Error('helper process still exists'))
    try {
      first.emit({ type: 'message.completed', itemRef: 'n1', text: 'Parser fix' })
      first.emit({ type: 'turn.completed', turnRef: 't1', status: 'completed' })
      await flush()
      expect(first.closed).toBe(false)
      await runtime.send(conversationId, '@codex now fix the lexer')
      await flush()
      expect(namerOf(fakes.claude)).toHaveLength(1)
      expect(first.sent).toHaveLength(1)
      expect(namerOf(fakes.deepseek)).toHaveLength(0)
      expect(namerOf(fakes.codex)).toHaveLength(0)
    } finally {
      close.mockRestore()
    }
    await runtime.closeConversation(conversationId)
    expect(first.closed).toBe(true)
  })

  it('closes a timed-out reply before trying the next provider', async () => {
    vi.useFakeTimers()
    try {
      await runtime.send(conversationId, '@codex fix the parser')
      await flushPromises()
      const first = namerOf(fakes.claude)[0]
      expect(first?.sent).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(20_000)
      await flushPromises()
      expect(first?.closed).toBe(true)
      expect(namerOf(fakes.deepseek)[0]?.sent.at(-1)?.text).toContain('fix the parser')
      expect(titles()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains one timed-out startup until its late helper is closed', async () => {
    const start = fakes.claude.start.bind(fakes.claude)
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    fakes.claude.start = async (opts) => {
      const session = await start(opts)
      await held
      return session
    }
    vi.useFakeTimers()
    try {
      await runtime.send(conversationId, '@codex fix the parser')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(20_000)
      await flushPromises()
      await runtime.send(conversationId, '@codex inspect the lexer')
      await runtime.send(conversationId, '@codex inspect the scanner')
      await flushPromises()
      expect(namerOf(fakes.claude)).toHaveLength(1)
      expect(namerOf(fakes.deepseek)).toHaveLength(0)
      release()
      await flushPromises()
      expect(namerOf(fakes.claude)[0]?.closed).toBe(true)
      expect(titles()).toEqual([])
      await runtime.send(conversationId, '@codex now fix the scanner')
      await flushPromises()
      expect(namerOf(fakes.claude)).toHaveLength(2)
      expect(namerOf(fakes.claude)[1]?.sent.at(-1)?.text).toContain('now fix the scanner')
    } finally {
      release()
      vi.useRealTimers()
    }
  })

  it('closes a late helper after its conversation has closed', async () => {
    const start = fakes.claude.start.bind(fakes.claude)
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    fakes.claude.start = async (opts) => {
      const session = await start(opts)
      await held
      return session
    }
    try {
      await runtime.send(conversationId, '@codex fix the parser')
      await flush()
      const closing = runtime.closeConversation(conversationId)
      release()
      await closing
      await flush()
      expect(namerOf(fakes.claude)[0]?.closed).toBe(true)
      expect(namerOf(fakes.claude)[0]?.sent).toEqual([])
      expect(namerOf(fakes.deepseek)).toHaveLength(0)
      expect(titles()).toEqual([])
    } finally {
      release()
    }
  })

  it('cancels a pending reply and skips queued naming after chat closure', async () => {
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    await runtime.send(conversationId, '@codex now fix the lexer')
    await runtime.closeConversation(conversationId)
    await flush()
    expect(namerOf(fakes.claude)).toHaveLength(1)
    expect(namerOf(fakes.claude)[0]?.closed).toBe(true)
    expect(namerOf(fakes.deepseek)).toHaveLength(0)
    expect(titles()).toEqual([])
  })

  it('closes the title helper before disposing adapters during shutdown', async () => {
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    const helper = namerOf(fakes.claude)[0]
    const dispose = fakes.claude.dispose.bind(fakes.claude)
    vi.spyOn(fakes.claude, 'dispose').mockImplementation(async () => {
      expect(helper?.closed).toBe(true)
      await dispose()
    })
    try {
      await runtime.close()
    } finally {
      runtime = ChorusRuntime.open(dataPath, silent, new Map())
    }
  })

  it('keeps the current title when no provider supports an available tool-free helper', async () => {
    runtime.renameConversation(conversationId, 'Existing title')
    const start = fakes.codex.start.bind(fakes.codex)
    fakes.claude.start = () => Promise.reject(new Error('Claude is unavailable'))
    fakes.deepseek.start = () => Promise.reject(new Error('DeepSeek is unavailable'))
    fakes.codex.start = (opts) =>
      opts.toolPolicy === 'none'
        ? Promise.reject(
            new Error('Codex does not support tool-free sessions through this adapter.')
          )
        : start(opts)
    await runtime.send(conversationId, '@codex fix the parser')
    await flush()
    expect(namerOf(fakes.codex)).toHaveLength(0)
    expect(runtime.conversationTitle(conversationId)).toBe('Existing title')
    expect(titles()).toEqual(['Existing title'])
  })
})

describe('project reads from an aside', () => {
  const READ_ONLY = { mode: 'readOnly', writableRoots: [], networkAccess: false }

  it('gives question, explanation and translation asides the parent project reader', async () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, explainLanguage: 'Arabic' })
    const fork = vi.spyOn(adapter, 'fork')
    const purposes = ['question', 'explanation', 'translation'] as const
    for (const [index, purpose] of purposes.entries()) {
      const sourceEventId = reply(`The projection lags behind the log${'.'.repeat(index + 1)}`)
      await runtime.openAside({
        conversationId,
        sourceEventId,
        excerpt: 'The projection lags',
        purpose,
        ...(purpose === 'question' ? { question: 'why?' } : {}),
      })
    }
    expect(fork).toHaveBeenCalledTimes(3)
    for (const [, opts] of fork.mock.calls) {
      expect(opts.project).toBeDefined()
      expect(opts.sandbox).toEqual(READ_ONLY)
      expect(opts.instructions).toBeUndefined()
      expect(opts.transcript).toBeUndefined()
      const text = (await opts.project?.terminal({ lines: 5 })) ?? ''
      const header = JSON.parse(text.slice(0, text.indexOf('\n'))) as unknown
      expect(header).toMatchObject({ run: 'idle', lines: 0 })
    }
  })

  it('gives an aside in a remote project no reader', async () => {
    const agentCwd = mkdtempSync(join(tmpdir(), 'chorus-aside-remote-'))
    const { project } = runtime.projects.adoptRemote({ host: 'tpa-be', root: 'C:/api', agentCwd })
    const remote = await runtime.startConversation({ projectId: project.id, agents: ['claude'] })
    const stored = runtime.store.append({
      conversationId: remote.conversationId,
      actor: 'claude',
      payload: { type: 'agent.message.completed', itemRef: 'm-remote', text: 'Remote reply.' },
    })
    if (stored === null) throw new Error('append refused')
    const fork = vi.spyOn(adapter, 'fork')
    await runtime.openAside({
      conversationId: remote.conversationId,
      sourceEventId: stored.id,
      excerpt: 'Remote reply.',
      question: 'why?',
    })
    expect(fork).toHaveBeenCalledTimes(1)
    expect(fork.mock.calls[0]?.[1].project).toBeUndefined()
  })
})
