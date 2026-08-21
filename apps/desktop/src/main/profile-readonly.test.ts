import { FakeAdapter } from '@chorus/orchestrator'
import type { AgentAdapter, HealthStatus } from '@chorus/agent-protocol'
import { Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChorusRuntime } from './runtime.js'

/**
 * The flag that lets the transcript be measured without launching anything.
 *
 * **Tested through the runtime, not through the switch.** An earlier version of
 * this file asserted on the two command *resolvers* and passed while the mode
 * was wide open — because `startParticipant` calls `adapter.health()` before any
 * resolver is consulted, and both real adapters answer that by running
 * `claude --version` / `codex --version`. A review found it. The doors that
 * matter are the ones every agent path goes through, so those are what these
 * drive: `startConversation`, `addParticipant`, and restore.
 *
 * `health()` is counted rather than mocked away. If the guard is ever moved back
 * below it, these fail — which is the whole point, since in production that call
 * is a child process.
 */
const FLAG = 'CHORUS_PROFILE_READONLY'
const silent = new Logger()
const CWD = process.cwd()

/** A `FakeAdapter` that remembers whether anything asked it to check itself. */
class CountingAdapter extends FakeAdapter {
  healthCalls = 0

  override health(): Promise<HealthStatus> {
    this.healthCalls++
    return super.health()
  }
}

let runtime: ChorusRuntime
let claude: CountingAdapter
let codex: CountingAdapter
let dataPath: string

function open(): void {
  dataPath = mkdtempSync(join(tmpdir(), 'chorus-readonly-'))
  claude = new CountingAdapter({ id: 'claude' })
  codex = new CountingAdapter({ id: 'codex' })
  runtime = ChorusRuntime.open(
    dataPath,
    silent,
    new Map<AgentId, AgentAdapter>([
      ['claude', claude],
      ['codex', codex],
    ])
  )
}

beforeEach(() => {
  delete process.env['CHORUS_PROFILE_READONLY']
})

afterEach(async () => {
  delete process.env['CHORUS_PROFILE_READONLY']
  await runtime.close()
})

describe('read-only profiling mode', () => {
  it('starts no agent and never even asks one whether it is healthy', async () => {
    process.env[FLAG] = '1'
    open()

    await expect(
      runtime.startConversation({ agents: ['claude', 'codex'], cwd: CWD })
    ).rejects.toThrow(/CHORUS_PROFILE_READONLY/)
    expect(claude.startedOpts).toHaveLength(0)
    expect(codex.startedOpts).toHaveLength(0)
    // The guard sits *above* health, because health is itself a spawn.
    expect(claude.healthCalls).toBe(0)
    expect(codex.healthCalls).toBe(0)
  })

  it('is off unless the value is exactly "1"', async () => {
    // Not a formality: a guard that treats any non-empty value as on would turn
    // itself on for someone who set it to 'false'.
    process.env[FLAG] = 'true'
    open()

    const { conversationId } = await runtime.startConversation({ agents: ['claude'], cwd: CWD })
    expect(conversationId).toBeTruthy()
    expect(claude.startedOpts).toHaveLength(1)
  })

  it('is the control: the same call starts an agent with the flag absent', async () => {
    open()
    await runtime.startConversation({ agents: ['claude'], cwd: CWD })
    expect(claude.startedOpts).toHaveLength(1)
    expect(claude.healthCalls).toBeGreaterThan(0)
  })

  it('refuses to add an agent to an existing conversation', async () => {
    open()
    const { conversationId } = await runtime.startConversation({ agents: ['claude'], cwd: CWD })

    process.env[FLAG] = '1'
    await expect(runtime.addParticipant(conversationId, 'codex')).rejects.toThrow(
      /CHORUS_PROFILE_READONLY/
    )
    expect(codex.startedOpts).toHaveLength(0)
    expect(codex.healthCalls).toBe(0)
  })

  it('appends nothing to the log while it is on', async () => {
    open()
    const before = runtime.logPosition()

    process.env[FLAG] = '1'
    await runtime.restoreOpenConversations()
    await runtime.startConversation({ agents: ['claude'], cwd: CWD }).catch(() => null)

    /*
     * The measurement runs against a copy of a real database, and a run that
     * appended would make the second measurement describe a different
     * conversation from the first. `conversation.created` is written before the
     * guarded start fails, so this is the assertion that would have caught it.
     */
    expect(runtime.logPosition()).toBe(before)
  })
})
