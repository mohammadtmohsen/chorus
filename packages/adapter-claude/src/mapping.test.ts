import type { ApprovalId } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { mapSdkMessage, mapToolPermission, trackBashTools, trackStreamMessage } from './mapping.js'

const CTX = { seq: 1, now: 1_000, approvalTtlMs: 60_000 }
const ID = 'ap-1' as ApprovalId
const perm = (tool: string, input: Record<string, unknown> = {}) =>
  mapToolPermission(tool, input, CTX, ID)

describe('message mapping', () => {
  it('maps a text_delta stream event', () => {
    const events = mapSdkMessage(
      {
        type: 'stream_event',
        uuid: 'u1',
        event: { index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      },
      CTX
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'message.delta', text: 'Hi', agentId: 'claude' })
  })

  it('gives every delta of one message the same itemRef', () => {
    // The bug this exists to catch: every stream_event carries its OWN uuid, so
    // keying on that rendered "P", "ONG", "PONG" as three separate messages in
    // the live app. The key has to come from the enclosing message_start.
    const ref = trackStreamMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } },
      null
    )
    expect(ref).toBe('msg_1')

    const refs = ['P', 'ONG'].map((text, i) => {
      const events = mapSdkMessage(
        {
          type: 'stream_event',
          uuid: `different-uuid-${String(i)}`,
          event: { index: 0, delta: { type: 'text_delta', text } },
        },
        { ...CTX, streamMessageRef: ref }
      )
      return (events[0] as { itemRef: string }).itemRef
    })
    expect(refs[0]).toBe(refs[1])
  })

  it('lets the final assistant message reuse the streamed itemRef', () => {
    // Otherwise the authoritative text appears beside the streamed fragments
    // instead of replacing them.
    const ref = trackStreamMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2' } } },
      null
    )
    const streamed = mapSdkMessage(
      {
        type: 'stream_event',
        uuid: 'u-x',
        event: { index: 0, delta: { type: 'text_delta', text: 'PO' } },
      },
      { ...CTX, streamMessageRef: ref }
    )
    const completed = mapSdkMessage(
      {
        type: 'assistant',
        uuid: 'u-y',
        message: { id: 'msg_2', content: [{ type: 'text', text: 'PONG' }] },
      },
      CTX
    )
    expect((completed[0] as { itemRef: string }).itemRef).toBe(
      (streamed[0] as { itemRef: string }).itemRef
    )
  })

  it('keeps stream and completed aligned when thinking precedes the text', () => {
    // The live bug: the stream counts every content block including thinking,
    // while the final message's array often omits them — so the same reply
    // streamed as msg:1 and completed as msg:0 and rendered twice.
    const ref = trackStreamMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_3' } } },
      null
    )
    const streamed = mapSdkMessage(
      {
        type: 'stream_event',
        uuid: 'u-a',
        // index 1: a thinking block occupied index 0 in the stream.
        event: { index: 1, delta: { type: 'text_delta', text: 'Answer' } },
      },
      { ...CTX, streamMessageRef: ref }
    )
    const completed = mapSdkMessage(
      {
        type: 'assistant',
        uuid: 'u-b',
        message: { id: 'msg_3', content: [{ type: 'text', text: 'Answer' }] },
      },
      CTX
    )
    expect((completed[0] as { itemRef: string }).itemRef).toBe(
      (streamed[0] as { itemRef: string }).itemRef
    )
  })

  it('joins several text blocks of one message into one entry', () => {
    const events = mapSdkMessage(
      {
        type: 'assistant',
        uuid: 'u',
        message: {
          id: 'msg_4',
          content: [
            { type: 'text', text: 'first ' },
            { type: 'text', text: 'second' },
          ],
        },
      },
      CTX
    )
    expect(events.filter((e) => e.type === 'message.completed')).toHaveLength(1)
    expect(events[0]).toMatchObject({ text: 'first second' })
  })

  it('maps thinking deltas to reasoning, not to message text', () => {
    const events = mapSdkMessage(
      {
        type: 'stream_event',
        uuid: 'u1',
        event: { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      },
      CTX
    )
    expect(events[0]).toMatchObject({ type: 'reasoning.delta', text: 'hmm' })
  })

  it('produces several events from one assistant message', () => {
    // Unlike Codex, a single Claude message can carry both prose and a tool use.
    const events = mapSdkMessage(
      {
        type: 'assistant',
        uuid: 'u2',
        message: {
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } },
          ],
        },
      },
      CTX
    )
    expect(events.map((e) => e.type)).toEqual(['message.completed', 'command.started'])
    expect(events[1]).toMatchObject({ command: ['git status'], itemRef: 't1' })
  })

  it('treats system init as the start of a turn', () => {
    const events = mapSdkMessage({ type: 'system', subtype: 'init', uuid: 'u3' }, CTX)
    expect(events[0]).toMatchObject({ type: 'turn.started' })
  })

  it('maps a success result to completed, with usage', () => {
    const events = mapSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        uuid: 'u4',
        usage: { input_tokens: 10, output_tokens: 20 },
        total_cost_usd: 0.01,
      },
      CTX
    )
    expect(events.map((e) => e.type)).toEqual(['usage.updated', 'turn.completed'])
    expect(events[0]).toMatchObject({ inputTokens: 10, outputTokens: 20, costUsd: 0.01 })
    expect(events[1]).toMatchObject({ status: 'completed' })
  })

  it('maps error_during_execution to failed', () => {
    // The adapter relabels this to "interrupted" only when *we* asked to stop;
    // the mapping itself must stay faithful to the wire (S3b).
    const events = mapSdkMessage(
      { type: 'result', subtype: 'error_during_execution', uuid: 'u5' },
      CTX
    )
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', status: 'failed' })
  })

  it('stays silent for message types it does not render', () => {
    for (const type of ['hook_started', 'task_progress', 'status', 'api_retry']) {
      expect(mapSdkMessage({ type }, CTX)).toEqual([])
    }
  })
})

describe('tool permission mapping', () => {
  it('maps Bash to a command approval', () => {
    expect(perm('Bash', { command: 'rm -rf /', cwd: '/repo' })).toMatchObject({
      kind: 'command',
      command: ['rm -rf /'],
      cwd: '/repo',
    })
  })

  it('maps Edit and Write to a file change with the path', () => {
    expect(
      perm('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })
    ).toMatchObject({
      kind: 'fileChange',
      files: [{ path: '/repo/a.ts', patch: '- a\n+ b' }],
    })
    expect(perm('Write', { file_path: '/repo/new.ts', content: 'hello' })).toMatchObject({
      kind: 'fileChange',
      files: [{ path: '/repo/new.ts', patch: 'hello' }],
    })
  })

  it('recognises an MCP tool from its namespaced name', () => {
    // Inheriting the user's config means agents get outward-facing tools, and
    // these are the ones a permission profile may never auto-allow (plan §2.6).
    expect(perm('mcp__slack__slack_send_message', { channel: '#engineering' })).toMatchObject({
      kind: 'mcpToolCall',
      serverName: 'slack',
      toolName: 'slack_send_message',
      target: '#engineering',
    })
  })

  it('handles an MCP server name containing underscores', () => {
    expect(perm('mcp__my_server__do_thing', {})).toMatchObject({
      kind: 'mcpToolCall',
      serverName: 'my_server',
      toolName: 'do_thing',
    })
  })

  it('surfaces an unknown tool rather than letting it through silently', () => {
    // A tool added by a future release must still produce a card.
    expect(perm('SomeFutureTool', {})).toMatchObject({ kind: 'permissionGrant' })
  })

  it('flags network intent for web tools', () => {
    expect(perm('WebFetch', { url: 'https://example.com' })).toMatchObject({
      kind: 'permissionGrant',
      requested: { network: true },
    })
  })

  it('sets a deadline, because canUseTool blocks indefinitely', () => {
    // sdk.d.ts: "blocked indefinitely — permission prompts have no park
    // deadline". Chorus owns the timeout on both providers (plan §4.4).
    expect(perm('Bash', { command: 'ls' }).expiresAt).toBe(CTX.now + CTX.approvalTtlMs)
  })
})

describe('tool results', () => {
  const CTX = { seq: 0, now: 1_000, approvalTtlMs: 60_000 }

  const bashCall = (id: string, command: string): Record<string, unknown> => ({
    type: 'assistant',
    message: { id: 'm1', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  })

  const toolResult = (id: string, content: unknown, isError = false): Record<string, unknown> => ({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  })

  it('reports a Bash result as command output and completion', () => {
    // Without this every Claude command hung in the transcript with no result.
    const ids = trackBashTools(bashCall('t1', 'pnpm test') as never, new Set())
    const events = mapSdkMessage(toolResult('t1', 'all green') as never, {
      ...CTX,
      bashToolIds: ids,
    })

    expect(events.map((e) => e.type)).toEqual(['command.output', 'command.completed'])
    expect(events[0]).toMatchObject({ itemRef: 't1', stream: 'stdout', chunk: 'all green' })
    expect(events[1]).toMatchObject({ itemRef: 't1', exitCode: 0 })
  })

  it('marks a failed result as stderr and a non-zero exit', () => {
    // Claude reports success or failure, never a number; "did it fail" is real.
    const ids = trackBashTools(bashCall('t1', 'ls /nope') as never, new Set())
    const events = mapSdkMessage(toolResult('t1', 'No such file or directory', true) as never, {
      ...CTX,
      bashToolIds: ids,
    })

    expect(events[0]).toMatchObject({ stream: 'stderr' })
    expect(events[1]).toMatchObject({ exitCode: 1 })
  })

  it('reads content given as blocks rather than a string', () => {
    const ids = trackBashTools(bashCall('t1', 'echo hi') as never, new Set())
    const events = mapSdkMessage(toolResult('t1', [{ type: 'text', text: 'hi' }]) as never, {
      ...CTX,
      bashToolIds: ids,
    })
    expect(events[0]).toMatchObject({ chunk: 'hi' })
  })

  it('ignores results from tools that were not commands', () => {
    // Another tool's result is the agent's own working, and it narrates that.
    const ids = trackBashTools(bashCall('t1', 'ls') as never, new Set())
    expect(
      mapSdkMessage(toolResult('t9', 'file contents') as never, { ...CTX, bashToolIds: ids })
    ).toEqual([])
  })

  it('emits nothing when the result carries no output', () => {
    const ids = trackBashTools(bashCall('t1', 'true') as never, new Set())
    const events = mapSdkMessage(toolResult('t1', '') as never, { ...CTX, bashToolIds: ids })
    expect(events.map((e) => e.type)).toEqual(['command.completed'])
  })
})
