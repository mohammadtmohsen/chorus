import {
  NOTE_READ_ONLY,
  runNoteTool,
  type AgentAdapter,
  type AgentSession,
  type ForkOpts,
} from '@chorus/agent-protocol'
import { ConversationNoteStore } from '@chorus/event-store'
import { FakeAdapter, type FakeAgentSession } from '@chorus/orchestrator'
import { AGENT_IDS, EMPTY_CONVERSATION_NOTE, Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationNotePush } from '../shared/ipc.js'
import { ChorusRuntime, NAMER_INSTRUCTIONS } from './runtime.js'

class CapturingAdapter extends FakeAdapter {
  readonly forkOpts: ForkOpts[] = []

  override fork(sessionRef: string, opts: ForkOpts): Promise<AgentSession> {
    this.forkOpts.push(opts)
    return super.fork(sessionRef, opts)
  }
}

let runtime: ChorusRuntime
let conversationId: string
let adapters: Map<AgentId, CapturingAdapter>
let dataDir: string

beforeEach(async () => {
  adapters = new Map(AGENT_IDS.map((id) => [id, new CapturingAdapter({ id })]))
  dataDir = mkdtempSync(join(tmpdir(), 'chorus-conversation-note-'))
  runtime = ChorusRuntime.open(dataDir, new Logger(), new Map<AgentId, AgentAdapter>(adapters))
  const started = await runtime.startConversationIn({ agents: [...AGENT_IDS], cwd: process.cwd() })
  conversationId = started.conversationId
})

afterEach(async () => {
  await runtime.close()
})

function adapterOf(agent: AgentId): CapturingAdapter {
  const adapter = adapters.get(agent)
  if (adapter === undefined) throw new Error('Missing adapter')
  return adapter
}

async function working(agent: AgentId): Promise<FakeAgentSession> {
  const adapter = adapterOf(agent)
  await runtime.send(conversationId, `@${agent} Build the feature.`)
  const parent = adapter.sessions.find(
    (session) => session.startedWith?.instructions !== NAMER_INSTRUCTIONS
  )
  if (parent === undefined) throw new Error('Missing primary session')
  parent.emit({ type: 'turn.started', turnRef: `primary-${agent}` })
  await vi.waitFor(() => {
    expect(
      runtime.store
        .read(conversationId)
        .some((event) => event.actor === agent && event.payload.type === 'turn.started')
    ).toBe(true)
  })
  return parent
}

const PINNED = 'Keep the idempotency keys.'

describe('note access outside the Work session', () => {
  it('gives a live question a read-only binding to its own chat note', async () => {
    expect(runtime.setConversationNoteText(conversationId, PINNED, 0).status).toBe('saved')
    await working('claude')
    const adapter = adapterOf('claude')
    await runtime.send(conversationId, '@claude Why this approach?')
    await vi.waitFor(() => {
      expect(adapter.forkOpts).toHaveLength(1)
    })
    const opts = adapter.forkOpts[0]
    expect(opts?.note?.read().body).toBe(PINNED)
    expect(opts?.note?.write).toBeUndefined()
    expect(runNoteTool(opts?.note, 'write_note', { text: 'x', expectedRevision: 1 })).toEqual({
      ok: false,
      text: NOTE_READ_ONLY,
    })
    expect(opts?.instructions).toContain('except read_note')
    await vi.waitFor(() => {
      expect(adapter.forked[0]?.session.sent).toHaveLength(1)
    })
    expect(adapter.forked[0]?.session.sent[0]?.text).toContain(
      `<pinned-note>\n${PINNED}\n</pinned-note>`
    )
    expect(runtime.getConversationNote(conversationId)).toMatchObject({
      body: PINNED,
      revision: 1,
      updatedBy: 'user',
    })
  })

  it('reads the latest saved text when the live question is actually sent', async () => {
    runtime.setConversationNoteText(conversationId, PINNED, 0)
    await working('codex')
    const adapter = adapterOf('codex')
    await runtime.send(conversationId, '@codex Why this approach?')
    await vi.waitFor(() => {
      expect(adapter.forkOpts).toHaveLength(1)
    })
    runtime.setConversationNoteText(conversationId, 'Changed after the question.', 1)
    expect(adapter.forkOpts[0]?.note?.read().body).toBe('Changed after the question.')
  })

  it('gives a discussion session the note to read and nothing to write with', async () => {
    runtime.setConversationNoteText(conversationId, PINNED, 0)
    await runtime.send(conversationId, '@codex What do you think?', undefined, 'discussion')
    const discussion = (): FakeAgentSession | undefined =>
      adapterOf('codex').sessions.find(
        (session) =>
          session.startedWith?.instructions?.startsWith('You are in Discussion mode.') === true
      )
    await vi.waitFor(() => {
      expect(discussion()?.sent).toHaveLength(1)
    })
    const opened = discussion()?.startedWith
    expect(opened?.note?.read().body).toBe(PINNED)
    expect(opened?.note?.write).toBeUndefined()
    expect(discussion()?.sent[0]?.text).toContain(`<pinned-note>\n${PINNED}\n</pinned-note>`)
  })
})

describe('closing a chat', () => {
  it('deletes its note and journal, announces it first, and refuses late writes', async () => {
    runtime.setConversationNoteText(conversationId, PINNED, 0)
    runtime.setConversationNoteView(conversationId, { visible: true, x: 0.3 })
    runtime.compareConversationNoteJournal(conversationId, null, 'pending draft')
    const order: string[] = []
    const pushes: ConversationNotePush[] = []
    runtime.onNoteChanged((push) => {
      pushes.push(push)
      order.push('note')
    })
    runtime.onConversationsChanged(() => {
      order.push('conversations')
    })

    await runtime.closeConversation(conversationId)

    expect(pushes).toEqual([{ conversationId, note: null }])
    expect(order[0]).toBe('note')
    expect(runtime.getConversationNote(conversationId)).toEqual(EMPTY_CONVERSATION_NOTE)
    expect(runtime.readConversationNoteJournal(conversationId)).toBeNull()

    expect(() => runtime.setConversationNoteText(conversationId, 'late text', 0)).toThrow()
    expect(() => runtime.setConversationNoteView(conversationId, { visible: true })).toThrow()
    expect(() =>
      runtime.compareConversationNoteJournal(conversationId, null, 'late draft')
    ).toThrow()
    expect(runtime.getConversationNote(conversationId)).toEqual(EMPTY_CONVERSATION_NOTE)
    expect(runtime.readConversationNoteJournal(conversationId)).toBeNull()
    expect(pushes).toHaveLength(1)
    expect(
      runtime.store
        .read(conversationId)
        .some((event) => event.payload.type === 'conversation.created')
    ).toBe(true)
  })

  it('refuses a write from the closed chat’s agent session', async () => {
    runtime.setConversationNoteText(conversationId, PINNED, 0)
    const parent = await working('claude')
    const write = parent.startedWith?.note?.write
    if (write === undefined) throw new Error('Missing agent writer')
    await runtime.closeConversation(conversationId)
    expect(() => write('late agent text', 1)).toThrow()
    expect(runtime.getConversationNote(conversationId)).toEqual(EMPTY_CONVERSATION_NOTE)
  })

  it('leaves another chat’s note untouched', async () => {
    const other = await runtime.startConversationIn({ agents: [...AGENT_IDS], cwd: process.cwd() })
    runtime.setConversationNoteText(conversationId, PINNED, 0)
    runtime.setConversationNoteText(other.conversationId, 'Other chat.', 0)
    runtime.compareConversationNoteJournal(other.conversationId, null, 'other draft')
    await runtime.closeConversation(conversationId)
    expect(runtime.getConversationNote(other.conversationId).body).toBe('Other chat.')
    expect(runtime.readConversationNoteJournal(other.conversationId)).toBe('other draft')
    expect(runtime.setConversationNoteText(other.conversationId, 'Still writable.', 1).status).toBe(
      'saved'
    )
  })

  it('retains a chat for retry after its note cleanup fails', async () => {
    runtime.setConversationNoteText(conversationId, PINNED, 0)
    const parent = await working('claude')
    const pushes: ConversationNotePush[] = []
    runtime.onNoteChanged((push) => {
      pushes.push(push)
    })
    const failing = vi.spyOn(ConversationNoteStore.prototype, 'delete').mockImplementation(() => {
      throw new Error('the note could not be deleted')
    })
    try {
      await expect(runtime.closeConversation(conversationId)).rejects.toThrow(
        'the note could not be deleted'
      )
    } finally {
      failing.mockRestore()
    }
    expect(pushes).toEqual([{ conversationId, note: null }])
    expect(parent.closed).toBe(true)
    expect(runtime.activeSessions().some((room) => room.conversationId === conversationId)).toBe(
      true
    )
    expect(() => runtime.setConversationNoteText(conversationId, 'late text', 1)).toThrow()
    expect(runtime.getConversationNote(conversationId).body).toBe(PINNED)
    await runtime.closeConversation(conversationId)
    expect(runtime.activeSessions().some((room) => room.conversationId === conversationId)).toBe(
      false
    )
    expect(() => runtime.setConversationNoteView(conversationId, { visible: true })).toThrow()
    expect(() =>
      runtime.compareConversationNoteJournal(conversationId, null, 'late draft')
    ).toThrow()
    expect(runtime.getConversationNote(conversationId).body).toBe('')
  })

  it('keeps the note of a chat left open across a shutdown and relaunch', async () => {
    runtime.setConversationNoteText(conversationId, PINNED, 0)
    runtime.setConversationNoteView(conversationId, { visible: true, width: 0.4 })
    runtime.compareConversationNoteJournal(conversationId, null, 'pending draft')
    await runtime.close()
    runtime = ChorusRuntime.open(
      dataDir,
      new Logger(),
      new Map<AgentId, AgentAdapter>(AGENT_IDS.map((id) => [id, new FakeAdapter({ id })]))
    )
    expect(runtime.getConversationNote(conversationId)).toMatchObject({
      body: PINNED,
      visible: true,
      width: 0.4,
    })
    expect(runtime.readConversationNoteJournal(conversationId)).toBe('pending draft')
  })
})
