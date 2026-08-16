import { FakeAdapter } from '@chorus/orchestrator'
import type { AgentAdapter } from '@chorus/agent-protocol'
import type { StoredEvent } from '@chorus/event-store'
import { Logger, newApprovalId, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ChorusRuntime,
  explainPrompt,
  forwardedFromAside,
  goPrompt,
  recapLedger,
  recapPrompt,
  taskAnchor,
  translatePrompt,
  type RecapLedger,
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

/**
 * A recap is the one purpose whose excerpt never reaches its prompt, and the one
 * whose prompt is built out of the log rather than out of the passage.
 */
describe('opening a recap', () => {
  /** A user turn in the parent, as `runtime.send` would log it — mention and all. */
  const asked = (text: string): void => {
    runtime.store.append({
      conversationId,
      actor: 'user',
      payload: { type: 'user.message', text },
    })
  }
  /*
   * `sessions`, not `forked`. A recap starts a session rather than branching one,
   * so nothing lands in `forked` at all — and asserting on `forked` here is what
   * would silently stop testing anything if the spawn ever went back to a fork.
   */
  const sentToReader = (): string => adapter.sessions.at(-1)?.sent.at(0)?.text ?? ''

  it('anchors on the user, and does not quote the reply back', async () => {
    asked('@claude make the phone field match the API contract')
    const sourceEventId = reply('A long scattered reply about four other things.')

    await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'A long scattered reply about four other things.',
      purpose: 'recap',
    })

    const prompt = sentToReader()
    expect(prompt).toContain('> make the phone field match the API contract')
    // The whole design. A prompt carrying the reply would summarise the reply,
    // which is the failure this exists to fix rather than a smaller version.
    expect(prompt).not.toContain('four other things')
  })

  it('strips the routing mention, which is scaffolding rather than task', async () => {
    asked('@claude make the phone field match the API contract')
    const sourceEventId = reply('Something.')
    await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'Something.',
      purpose: 'recap',
    })
    expect(sentToReader()).not.toContain('@claude make')
  })

  it('logs a short line and delivers the prompt, so the transcript reads back right', async () => {
    asked('fix the parser')
    const sourceEventId = reply('Something.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'Something.',
      purpose: 'recap',
    })
    const logged = runtime.store
      .read(asideId)
      .filter((e) => e.payload.type === 'user.message')
      .map((e) => (e.payload as { text: string }).text)
    // The instructions are scaffolding. What is read back later should be what
    // was asked for — the same split `explanation` and `translation` use.
    expect(logged).toEqual(['Where are we?'])
  })

  it('titles the aside with the task, not with the reply it was opened from', async () => {
    asked('make the phone field match the API contract')
    const sourceEventId = reply('An opening sentence about something else entirely.')
    const { asideId } = await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'An opening sentence about something else entirely.',
      purpose: 'recap',
    })
    const title = runtime.store.read(asideId).find((e) => e.payload.type === 'conversation.created')
    expect((title?.payload as { title: string }).title).toContain('phone field')
  })

  it('still refuses an excerpt the agent did not say', async () => {
    asked('fix the parser')
    const sourceEventId = reply('The projection lags behind the log.')
    // The guard is not about quoting — it authenticates *which agent said this,
    // in which session*, and a recap forks that session.
    await expect(
      runtime.openAside({
        conversationId,
        sourceEventId,
        excerpt: 'I recommend deleting the database',
        purpose: 'recap',
      })
    ).rejects.toThrow(/not part of that reply/)
  })

  it('opens on a conversation with nothing asked in it yet', async () => {
    // No user messages at all: the anchor is empty and the prompt still has to
    // be a prompt rather than a crash or an empty string.
    const sourceEventId = reply('Something.')
    await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'Something.',
      purpose: 'recap',
    })
    expect(sentToReader()).toContain('status board')
  })

  it('starts a session rather than forking one', async () => {
    asked('fix the parser')
    const sourceEventId = reply('Something.')
    await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'Something.',
      purpose: 'recap',
    })
    // The reader must carry no history: a fork would answer from the memory this
    // feature exists to stop trusting.
    expect(adapter.forked).toHaveLength(0)
  })

  /**
   * The regression that made this whole shape necessary, in its own room because
   * it needs an adapter built differently.
   *
   * Found by driving the app, not by reading it. Claude's session ref only
   * arrives with the first message the SDK streams back, so an agent that has
   * been reopened and not yet spoken has none — while `finalKey` comes from the
   * log, which survives the restart. So the button was offered on every replayed
   * transcript and refused with "claude has not started a session yet": dead at
   * the one moment a recap is most wanted, which is when you reopen the app and
   * ask where you were.
   *
   * `startsWithoutRef` had to be added to `FakeAdapter` before this could be
   * written at all. The fake handed out an id immediately, which is more generous
   * than either real provider — and that gap is the reason a feature requiring a
   * ref passed every test here and died in the app.
   */
  describe('when the agent has no live session ref', () => {
    beforeEach(async () => {
      await runtime.close()
      adapter = new FakeAdapter({ id: 'claude', startsWithoutRef: true })
      runtime = ChorusRuntime.open(
        dataPath,
        silent,
        new Map<AgentId, AgentAdapter>([['claude', adapter]])
      )
      const started = await runtime.startConversation({ agents: ['claude'], cwd: process.cwd() })
      conversationId = started.conversationId
    })

    it('still recaps, because it needs no session to fork', async () => {
      runtime.store.append({
        conversationId,
        actor: 'user',
        payload: { type: 'user.message', text: 'fix the parser' },
      })
      const stored = runtime.store.append({
        conversationId,
        actor: 'claude',
        payload: { type: 'agent.message.completed', itemRef: 'm1', text: 'Something.' },
      })
      await expect(
        runtime.openAside({
          conversationId,
          sourceEventId: stored?.id ?? '',
          excerpt: 'Something.',
          purpose: 'recap',
        })
      ).resolves.toMatchObject({ language: '' })
    })

    it('still refuses to explain, which is the guard doing its job', async () => {
      // The check was never wrong — an explanation genuinely needs the agent's
      // memory, so it genuinely needs a session. Only a recap does not.
      const stored = runtime.store.append({
        conversationId,
        actor: 'claude',
        payload: { type: 'agent.message.completed', itemRef: 'm1', text: 'Something.' },
      })
      await expect(
        runtime.openAside({
          conversationId,
          sourceEventId: stored?.id ?? '',
          excerpt: 'Something.',
          question: 'why?',
        })
      ).rejects.toThrow(/has not started a session yet/)
    })
  })

  it('carries the log’s counted facts, not just the user’s words', async () => {
    asked('fix the parser')
    // An absolute path under the conversation's cwd, which is what a provider
    // really reports — and what makes the ledger render it project-relative.
    runtime.store.append({
      conversationId,
      actor: 'claude',
      payload: {
        type: 'tool.started',
        itemRef: 't1',
        name: 'Edit',
        parentRef: null,
        detail: join(process.cwd(), 'src/parse.ts'),
      },
    })
    runtime.store.append({
      conversationId,
      actor: 'claude',
      payload: { type: 'command.started', itemRef: 'c1', command: ['pnpm check'], cwd: '.' },
    })
    runtime.store.append({
      conversationId,
      actor: 'claude',
      payload: { type: 'command.completed', itemRef: 'c1', exitCode: 1 },
    })

    const sourceEventId = reply('Something.')
    await runtime.openAside({
      conversationId,
      sourceEventId,
      excerpt: 'Something.',
      purpose: 'recap',
    })

    const prompt = sentToReader()
    // Same reason as project-match: the path in the prompt is a host-relative one,
    // so it carries the platform separator.
    expect(prompt).toContain(join('src', 'parse.ts'))
    expect(prompt).toContain('pnpm check → exit 1')
  })
})

/**
 * What the log can prove, as opposed to what an agent remembers.
 *
 * Pure, so it is tested here rather than through a fork. The judgement in it is
 * which events count as evidence — a proposal is not a change, and a command's
 * name and its exit code arrive on different events.
 */
describe('recapLedger', () => {
  let seq = 0
  const event = (actor: 'claude' | 'user', payload: unknown): StoredEvent =>
    ({
      seq: (seq += 1),
      id: `e${String(seq)}`,
      conversationId: 'c',
      actor,
      type: (payload as { type: string }).type,
      payload,
      createdAt: seq,
      schemaVersion: 1,
    }) as StoredEvent

  it('counts a completed change and ignores a mere proposal', () => {
    // A proposal that a denied approval stopped is not work done, and a `Done`
    // line built from one claims something that never happened.
    const ledger = recapLedger([
      event('claude', {
        type: 'file.change.proposed',
        itemRef: 'p1',
        files: [{ path: 'never.ts', patch: '' }],
      }),
      event('claude', {
        type: 'file.change.completed',
        itemRef: 'f1',
        outcome: 'applied',
        files: [{ path: 'real.ts', change: 'modified', added: 1, removed: 0 }],
      }),
    ])
    expect(ledger.files).toEqual(['real.ts'])
  })

  it('ignores a write that failed or the user declined', () => {
    /*
     * `file.change.completed` is written for `failed` and `declined` too — a
     * refused write is still a completed *attempt*. Counting those puts a file
     * on `Done` that was never changed, which is the worst line for a board to
     * get wrong: it is the one a reader acts on without re-checking.
     *
     * Missed on the first pass and caught by the schema rejecting a fixture that
     * omitted `outcome`, not by reading the code.
     */
    const attempt = (path: string, outcome: string): StoredEvent =>
      event('claude', {
        type: 'file.change.completed',
        itemRef: path,
        outcome,
        files: [{ path, change: 'modified', added: 1, removed: 0 }],
      })
    const ledger = recapLedger([
      attempt('applied.ts', 'applied'),
      attempt('failed.ts', 'failed'),
      attempt('declined.ts', 'declined'),
    ])
    expect(ledger.files).toEqual(['applied.ts'])
  })

  it('moves a file touched twice to the end rather than listing it twice', () => {
    // A reader looks at the end of the list for current work.
    const touch = (path: string, ref: string): StoredEvent =>
      event('claude', {
        type: 'file.change.completed',
        itemRef: ref,
        outcome: 'applied',
        files: [{ path, change: 'modified', added: 1, removed: 0 }],
      })
    expect(recapLedger([touch('a.ts', '1'), touch('b.ts', '2'), touch('a.ts', '3')]).files).toEqual(
      ['b.ts', 'a.ts']
    )
  })

  /*
   * Everything in this block was written after driving the ledger over the real
   * store — 183MB, 454 conversations — rather than after reading the schema.
   * Each case is a shape that actually dominated the output.
   */
  it('reads a written file off the tool that wrote it, not off file.change.completed', () => {
    // The finding that reshaped this function: `file.change.completed` has never
    // been written once in the whole store. Files arrive as Edit/Write tool
    // calls whose `detail` is the absolute path.
    const ledger = recapLedger(
      [
        event('claude', {
          type: 'tool.started',
          itemRef: 't1',
          name: 'Edit',
          parentRef: null,
          detail: '/work/src/parse.ts',
        }),
        event('claude', {
          type: 'tool.started',
          itemRef: 't2',
          name: 'Read',
          parentRef: null,
          detail: '/work/src/other.ts',
        }),
      ],
      '/work'
    )
    // Read is not a change. Only the writing tools count.
    expect(ledger.files).toEqual(['src/parse.ts'])
  })

  it('ignores a file written outside the project', () => {
    // Half the busiest conversation's file list was `/tmp/promote.mjs` and other
    // throwaway probes, crowding the real source files out of a bounded list.
    const ledger = recapLedger(
      [
        event('claude', {
          type: 'tool.started',
          itemRef: 't1',
          name: 'Write',
          parentRef: null,
          detail: '/tmp/probe.mjs',
        }),
      ],
      '/work'
    )
    expect(ledger.files).toEqual([])
  })

  it('reports a simple failure and drops a compound one', () => {
    /*
     * The rule that made this list usable. Every non-zero exit in four real
     * conversations belonged to a line like
     * `cd … && python3 - <<'PY' … | grep -E "×" | head` — whose status is the
     * status of the trailing grep. Twenty of twenty sampled were noise.
     */
    const ran = (ref: string, line: string, exitCode: number): StoredEvent[] => [
      event('claude', { type: 'command.started', itemRef: ref, command: [line], cwd: '.' }),
      event('claude', { type: 'command.completed', itemRef: ref, exitCode }),
    ]
    const ledger = recapLedger([
      ...ran('a', "/bin/zsh -lc 'pnpm check'", 1),
      ...ran('b', "cd /x && python3 - <<'PY' | grep -E 'x' | head", 1),
    ])
    // The shell wrapper is stripped too: left on, every line begins with the
    // same fourteen characters and the useful part falls off the trim.
    expect(ledger.failed).toEqual(['pnpm check → exit 1'])
  })

  it('drops the supervisor’s own noise from the errors', () => {
    // `agent claude exited unexpectedly; restarting` was the most common
    // `error.raised` in every conversation sampled. True, and not news about
    // where the task stands.
    const ledger = recapLedger([
      event('claude', {
        type: 'error.raised',
        message: 'agent claude exited unexpectedly; restarting',
        recoverable: true,
      }),
      event('claude', {
        type: 'error.raised',
        message: 'the parser rejected the shape',
        recoverable: false,
      }),
    ])
    expect(ledger.errors).toEqual(['the parser rejected the shape'])
  })

  it('names a failed command, which needs both of its events', () => {
    // The command line is only on `started` and the exit code only on
    // `completed`, so without the join the failure can be counted and not named.
    const ledger = recapLedger([
      event('claude', {
        type: 'command.started',
        itemRef: 'c1',
        command: ['pnpm', 'check'],
        cwd: '.',
      }),
      event('claude', { type: 'command.completed', itemRef: 'c1', exitCode: 2 }),
    ])
    expect(ledger.failed).toEqual(['pnpm check → exit 2'])
  })

  it('ignores a command that succeeded, and one still running', () => {
    const ledger = recapLedger([
      event('claude', { type: 'command.started', itemRef: 'ok', command: ['ls'], cwd: '.' }),
      event('claude', { type: 'command.completed', itemRef: 'ok', exitCode: 0 }),
      event('claude', { type: 'command.started', itemRef: 'run', command: ['sleep'], cwd: '.' }),
      event('claude', { type: 'command.completed', itemRef: 'nul', exitCode: null }),
    ])
    expect(ledger.failed).toEqual([])
  })

  it('keeps the newest facts when there are more than a board can hold', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      event('claude', {
        type: 'file.change.completed',
        itemRef: `f${String(i)}`,
        outcome: 'applied',
        files: [{ path: `f${String(i)}.ts`, change: 'modified', added: 1, removed: 0 }],
      })
    )
    const ledger = recapLedger(many)
    expect(ledger.files).toHaveLength(12)
    expect(ledger.files.at(-1)).toBe('f29.ts')
  })

  it('is empty for a conversation that only talked', () => {
    const ledger = recapLedger([event('user', { type: 'user.message', text: 'hello' })])
    expect(ledger).toEqual({ files: [], failed: [], errors: [] })
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
    expect(sent[0]?.text).toContain('Do not restate the passage')
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
 * The anchor, which is the half of a recap that is not a prompt.
 *
 * Asserted separately because the judgement is here: which end survives the
 * budget, what happens at the boundary, and whether a single over-long message
 * anchors the recap or leaves it with no task in it at all.
 */
describe('taskAnchor', () => {
  it('keeps everything when the budget is not touched', () => {
    const { kept, omitted } = taskAnchor(['first', 'second', 'third'])
    expect(kept).toEqual(['first', 'second', 'third'])
    expect(omitted).toBe(0)
  })

  it('drops the oldest first, because the task is defined by the latest ask', () => {
    // A recap anchored on message one of forty would describe a task that
    // finished hours ago.
    const { kept, omitted } = taskAnchor(['oldest', 'middle', 'newest'], 16)
    expect(kept).toEqual(['middle', 'newest'])
    expect(omitted).toBe(1)
  })

  it('returns what it kept in the order it was asked, not the order it spent', () => {
    // Newest-first is how the budget is spent, not how the result reads. A
    // sequence of requests is a narrowing, and reversing it reverses that — so
    // the budget has to bind here, or this passes on an untouched input.
    const { kept, omitted } = taskAnchor(['drop me', 'ask one', 'ask two'], 16)
    expect(kept).toEqual(['ask one', 'ask two'])
    expect(omitted).toBe(1)
  })

  it('keeps one message even when it alone exceeds the whole budget', () => {
    // The `kept.length > 0` guard, which `catchup.ts` carries for the same
    // reason: a prompt with no task in it is worse than a trimmed one.
    const { kept, omitted } = taskAnchor(['x'.repeat(500)], 10, 500)
    expect(kept).toHaveLength(1)
    expect(omitted).toBe(0)
  })

  it('trims a long message from both ends rather than its head', () => {
    // The close of a request usually carries the actual ask, which is the half
    // a task anchor can least afford to lose.
    const { kept } = taskAnchor([`START${'.'.repeat(200)}END`], 4_000, 60)
    expect(kept[0]).toContain('START')
    expect(kept[0]).toContain('END')
    expect(kept[0]).toContain('… [trimmed] …')
  })

  it('discards messages that are only whitespace', () => {
    const { kept, omitted } = taskAnchor(['  ', 'real', '\n\n'])
    expect(kept).toEqual(['real'])
    // Blank messages were never candidates, so they are not "omitted" either —
    // a count that included them would report a truncation that never happened.
    expect(omitted).toBe(0)
  })
})

/**
 * A recap is not an explanation of the whole conversation.
 *
 * Explain answers _what does this mean_ about a passage in front of you; recap
 * answers _where are we_, and its subject is the thing the conversation has
 * drifted away from. So the assertions here are mostly about what the prompt
 * refuses to lean on — the last reply — and about the two numbers that keep the
 * board a board.
 */
describe('recapPrompt', () => {
  const NOTHING: RecapLedger = { files: [], failed: [], errors: [] }
  const prompt = recapPrompt(['Make the phone field match the API contract.'], NOTHING)

  it('quotes the user, and only the user', () => {
    // The whole mechanism against drift. The reply that triggered the recap is
    // deliberately absent: summarising it is the failure this feature exists for.
    expect(prompt).toContain('> Make the phone field match the API contract.')
    expect(prompt).toContain('what the user asked for, in their own words')
  })

  it('tells the reader it was not there, so it does not write "I did X"', () => {
    // The reader is a fresh session with no history. A model told a transcript
    // is its own claims the work; told it is reading one, it reports.
    expect(prompt).toContain('You were not part of it')
    expect(prompt).toContain('everything you know about it is below')
  })

  it('fences the log off from the judgement, and attributes it', () => {
    expect(prompt).toContain("what Chorus's log records. These are facts, not your recollection")
    expect(prompt).toContain('--- end of what you know ---')
  })

  it('refuses to let a changed file become a working one', () => {
    // The sharpest thing the log cannot say. `file.change.completed` proves a
    // file was written and nothing about whether the change was right.
    expect(prompt).toContain('never that the change was correct')
    expect(prompt).toContain('no line here may claim')
  })

  it('says what an empty ledger section means, rather than leaving a blank', () => {
    // "No failed commands" and "no commands were run" are different states, and
    // a model handed a blank picks the flattering one.
    expect(prompt).toContain('Files changed: none recorded.')
    expect(prompt).toContain('This does not mean the tests passed')
  })

  it('carries the ledger when there is one', () => {
    const withFacts = recapPrompt(['fix the parser'], {
      files: ['src/parse.ts', 'src/parse.test.ts'],
      failed: ['pnpm check → exit 1'],
      errors: ['the provider closed the stream'],
    })
    expect(withFacts).toContain('src/parse.ts, src/parse.test.ts')
    expect(withFacts).toContain('- pnpm check → exit 1')
    expect(withFacts).toContain('- the provider closed the stream')
  })

  it('says so when nothing has been asked yet', () => {
    // Otherwise the task section is a heading with nothing under it, which reads
    // as truncation rather than as an empty conversation.
    expect(recapPrompt([], NOTHING)).toContain('nothing has been asked in this conversation yet')
  })

  it('commits to a board in its opening clause', () => {
    // `explainPrompt` records the lesson: a rule stated only in the list below
    // was still broken by a real answer, because the opening clause is the one
    // the model commits to first.
    expect(prompt).toContain('Your reply is a status board, not a message.')
    expect(prompt.indexOf('status board')).toBeLessThan(prompt.indexOf('Leave out:'))
  })

  it('fixes the headings and their order', () => {
    expect(prompt).toContain('Task, Done, Open, Next')
    expect(prompt).toContain('Nothing before them and nothing after them')
  })

  it('bounds lines and words, not just one of them', () => {
    // A cap on lines alone produces four very long lines, which is the same
    // wall of text one heading further in.
    expect(prompt).toContain('up to four lines')
    expect(prompt).toContain('up to three lines')
    expect(prompt).toContain('exactly one line')
    expect(prompt).toContain('Fifteen words a line at most')
  })

  it('takes the task from the user rather than from the last reply', () => {
    expect(prompt).toContain('taken from the user’s own words')
    expect(prompt).toContain('the most recent one wins')
  })

  it('gives the off-task material somewhere bounded to go', () => {
    // Asked for as "useful but scattered". With no home for it, it leaks back
    // into Done and the board stops being one.
    expect(prompt).toContain('Parked')
    expect(prompt).toContain('up to two')
    expect(prompt).toContain('Anything off-task goes there and nowhere else')
  })

  it('asks for "unverified" rather than trusting a Done line', () => {
    // "Done" and "done and checked" are exactly what a recap is read to tell
    // apart, and the difference is invisible unless it is asked for.
    expect(prompt).toContain('not checked with "unverified"')
  })

  it('names the padding rather than asking for brevity', () => {
    for (const banned of [
      'not one of the five things above',
      'why a decision was right',
      'offers nobody asked for',
      'praise, apology',
      "restating the user's request",
    ]) {
      expect(prompt).toContain(banned)
    }
  })

  it('forbids padding a section that has nothing true in it', () => {
    expect(prompt).toContain('never pad a section to fill it')
    expect(prompt).toContain('leave the line out')
  })

  it('carries the do-not-work clause every aside prompt carries', () => {
    // A request for a status board looks more like a task than any of the other
    // three, so this matters here most.
    expect(prompt).toContain('Do not continue the work or change anything.')
  })

  it('discloses a truncated anchor instead of reading as a complete one', () => {
    const long = Array.from({ length: 40 }, (_, i) => `request ${String(i)} ${'.'.repeat(300)}`)
    expect(recapPrompt(long, NOTHING)).toContain('earlier messages omitted)')
  })

  it('says nothing about omissions when there were none', () => {
    expect(prompt).not.toContain('omitted)')
  })

  it('separates quoted messages, so a narrowing does not arrive as one paragraph', () => {
    // Consecutive `>` lines are a single blockquote to every markdown reader and
    // to both CLIs.
    expect(recapPrompt(['first ask', 'then narrower'], NOTHING)).toContain(
      '> first ask\n\n> then narrower'
    )
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
  const sentToAgent = (): string => adapter.sessions.at(-1)?.sent.at(-1)?.text ?? ''
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
