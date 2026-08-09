import { FakeAdapter } from '@chorus/orchestrator'
import type { AgentAdapter } from '@chorus/agent-protocol'
import { Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChorusRuntime } from './runtime.js'
import { DEFAULT_SETTINGS, writeSettings } from './settings.js'

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
