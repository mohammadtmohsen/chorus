import { FakeAdapter } from '@chorus/orchestrator'
import type { AgentAdapter } from '@chorus/agent-protocol'
import { Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChorusRuntime } from './runtime.js'
import { DEFAULT_SETTINGS, writeSettings } from './settings.js'
import { writeOpenSessions, type OpenSession } from './open-sessions.js'

/**
 * Which model each agent is started with, on each of the three paths.
 *
 * None of them had a test, which is how two opposite bugs lived here at once:
 * `startConversation` built its own options with no model, so the sheet headed
 * "New sessions start with" did nothing for new sessions; while reopen and
 * add-participant handed the one model anyone chose — always from Claude's list,
 * the only catalogue the sheet has — to Codex as well.
 */

const silent = new Logger()
const CWD = process.cwd()

let runtime: ChorusRuntime
let claude: FakeAdapter
let codex: FakeAdapter
let dataPath: string

/** The options each adapter was actually started or resumed with. */
const startedWith = (adapter: FakeAdapter): (string | undefined)[] =>
  adapter.startedOpts.map((o) => o.model)

beforeEach(() => {
  dataPath = mkdtempSync(join(tmpdir(), 'chorus-defaults-'))
  claude = new FakeAdapter({ id: 'claude' })
  codex = new FakeAdapter({ id: 'codex' })
  runtime = ChorusRuntime.open(
    dataPath,
    silent,
    new Map<AgentId, AgentAdapter>([
      ['claude', claude],
      ['codex', codex],
    ])
  )
})

afterEach(async () => {
  await runtime.close()
})

describe('a new conversation', () => {
  it('starts Claude with the chosen model, which it did not before', async () => {
    // The sheet says "New sessions start with". This path never called
    // `sessionOptsFor` at all, so it started with nothing.
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, model: 'sonnet' })
    await runtime.startConversation({ agents: ['claude'], cwd: CWD })
    expect(startedWith(claude)).toEqual(['sonnet'])
  })

  it('does not hand Claude’s model to Codex', async () => {
    // A value from one provider's catalogue reaching another's API.
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, model: 'sonnet' })
    await runtime.startConversation({ agents: ['claude', 'codex'], cwd: CWD })
    expect(startedWith(claude)).toEqual(['sonnet'])
    expect(startedWith(codex)).toEqual([undefined])
  })

  it('passes no model when none is chosen', async () => {
    await runtime.startConversation({ agents: ['claude'], cwd: CWD })
    expect(startedWith(claude)).toEqual([undefined])
  })
})

describe('adding an agent to a conversation', () => {
  it('gives it a genuinely new session, so the default applies', async () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, model: 'sonnet' })
    const { conversationId } = await runtime.startConversation({ agents: ['codex'], cwd: CWD })
    await runtime.addParticipant(conversationId, 'claude')
    expect(startedWith(claude)).toEqual(['sonnet'])
  })

  it('still gives Codex nothing', async () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, model: 'sonnet' })
    const { conversationId } = await runtime.startConversation({ agents: ['claude'], cwd: CWD })
    await runtime.addParticipant(conversationId, 'codex')
    expect(startedWith(codex)).toEqual([undefined])
  })
})

describe('effort', () => {
  it('is applied to Claude, whose list it came from', async () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, effortLevel: 'high' })
    await runtime.startConversation({ agents: ['claude'], cwd: CWD })
    expect(claude.sessions[0]?.efforts).toEqual(['high'])
  })

  it('is not applied to Codex, whose levels differ per model', async () => {
    // Measured against a real catalogue: `ultra` exists on some Codex models and
    // not others, so the two providers' lists are not interchangeable even where
    // they overlap.
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, effortLevel: 'high' })
    await runtime.startConversation({ agents: ['codex'], cwd: CWD })
    expect(codex.sessions[0]?.efforts).toEqual([])
  })
})

describe('the setting already on disk', () => {
  it('folds the single model onto Claude, whose list it came from', () => {
    // Not a split. Whatever is in a settings file today was chosen from Claude's
    // catalogue, because that is the only one the sheet ever showed.
    const written = writeSettings(dataPath, { ...DEFAULT_SETTINGS, model: 'sonnet' })
    expect(written.models).toEqual({ claude: 'sonnet', codex: '' })
  })

  it('folds the single effort the same way', () => {
    const written = writeSettings(dataPath, { ...DEFAULT_SETTINGS, effortLevel: 'high' })
    expect(written.efforts).toEqual({ claude: 'high', codex: '' })
  })

  it('clears the legacy field, so the fold happens exactly once', () => {
    // Left in place it would keep overwriting whatever Claude was later set to.
    const written = writeSettings(dataPath, { ...DEFAULT_SETTINGS, model: 'sonnet' })
    expect(written.model).toBe('')
  })

  it('does not overwrite a per-agent value that already exists', () => {
    const written = writeSettings(dataPath, {
      ...DEFAULT_SETTINGS,
      model: 'sonnet',
      models: { claude: 'opus', codex: '' },
    })
    expect(written.models.claude).toBe('opus')
  })

  it('leaves Codex on the provider default rather than inheriting a name', () => {
    // The whole point: a Claude model reaching Codex's API is the bug.
    const written = writeSettings(dataPath, { ...DEFAULT_SETTINGS, model: 'sonnet' })
    expect(written.models.codex).toBe('')
  })
})

describe('the model catalogue’s state', () => {
  it('reports a row per adapter, even before any session has run', async () => {
    // Seeded from the adapters rather than from what discovery recorded, so the
    // sheet can draw a row for an agent that has never started.
    expect(
      runtime
        .knownModels()
        .map((a) => a.agentId)
        .sort()
    ).toEqual(['claude', 'codex'])
    expect(runtime.knownModels().every((a) => a.status === 'unqueried')).toBe(true)
    await Promise.resolve()
  })

  it('tells an empty answer apart from a failed one', async () => {
    // These were one silence: an empty result was discarded and a failure
    // swallowed, so a sheet could not say which had happened.
    await runtime.startConversation({ agents: ['claude'], cwd: CWD })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const claudeRow = runtime.knownModels().find((a) => a.agentId === 'claude')
    expect(claudeRow?.status).toBe('ready')
    expect(claudeRow?.models).toEqual([])

    const codexRow = runtime.knownModels().find((a) => a.agentId === 'codex')
    expect(codexRow?.status).toBe('unqueried')
  })
})

describe('reopening the app', () => {
  /**
   * The three ways a *fresh* session is born on the reopen path.
   *
   * Reopening asks for options "as a resume", which deliberately strips the
   * model: a rejoined thread already carries the one it was started with. But
   * resolving that once, outside the decision, meant every fresh start reached
   * from here got no model at all — including the two cases below, which are
   * not resumes in any sense.
   */
  const saved = (over: Partial<OpenSession> = {}): OpenSession => ({
    conversationId: 'conv-1',
    agents: ['claude'],
    cwd: CWD,
    profileId: 'read-only',
    title: 'a conversation',
    sessionRefs: { claude: 'thread-1' },
    lastSeenSeq: 0,
    draft: '',
    ...over,
  })

  it('does not re-point a thread it is genuinely resuming', () => {
    // The behaviour the strip exists for, and which must survive the fix.
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, model: 'sonnet' })
    writeOpenSessions(dataPath, { sessions: [saved()], workspace: null })
    return runtime.restoreOpenConversations().then(() => {
      expect(startedWith(claude)).toEqual([undefined])
    })
  })

  it('gives an agent with no saved thread the configured model', async () => {
    // Claude's session id only arrives with its first message, so an agent that
    // joined and never spoke is written down with `""` — a fresh start, not a
    // resume, and it should begin where the sheet says.
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, model: 'sonnet' })
    writeOpenSessions(dataPath, {
      sessions: [saved({ sessionRefs: { claude: '' } })],
      workspace: null,
    })
    await runtime.restoreOpenConversations()
    expect(startedWith(claude)).toEqual(['sonnet'])
  })

  it('gives a failed resume the configured model when it falls back', async () => {
    // A thread the provider has forgotten is a normal thing to find after a day
    // away. The fallback is a new session and starts like one.
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, model: 'sonnet' })
    claude.failResume = true
    writeOpenSessions(dataPath, { sessions: [saved()], workspace: null })
    await runtime.restoreOpenConversations()
    expect(startedWith(claude)).toEqual(['sonnet'])
  })

  it('still keeps the two agents apart', async () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, model: 'sonnet' })
    writeOpenSessions(dataPath, {
      sessions: [saved({ agents: ['claude', 'codex'], sessionRefs: { claude: '', codex: '' } })],
      workspace: null,
    })
    await runtime.restoreOpenConversations()
    expect(startedWith(claude)).toEqual(['sonnet'])
    expect(startedWith(codex)).toEqual([undefined])
  })
})

describe('a catalogue that fails', () => {
  it('is recorded as failed, not as an agent with nothing to offer', async () => {
    /*
     * The state that shipped unreachable. Both production adapters caught every
     * error and returned `[]`, so a request that failed drew as "It offers no
     * model choice" — the exact ambiguity the four states were added to remove.
     */
    const broken = new FakeAdapter({ id: 'claude', models: new Error('the CLI fell over') })
    const other = ChorusRuntime.open(
      mkdtempSync(join(tmpdir(), 'chorus-broken-')),
      silent,
      new Map<AgentId, AgentAdapter>([['claude', broken]])
    )
    try {
      await other.startConversation({ agents: ['claude'], cwd: CWD })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(other.knownModels().find((a) => a.agentId === 'claude')?.status).toBe('failed')
    } finally {
      await other.close()
    }
  })
})
