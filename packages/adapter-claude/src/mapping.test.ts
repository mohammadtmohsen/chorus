import type { ApprovalId, UserInputId } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import {
  mapContextUsage,
  mapPlanUsage,
  mapSdkMessage,
  mapToolPermission,
  mapUserInputRequest,
  toClaudeUserInputResult,
  trackBashTools,
  trackStreamMessage,
  USER_INPUT_TOOL,
} from './mapping.js'

const CTX = {
  seq: 1,
  now: 1_000,
  approvalTtlMs: 60_000,
  usageSoFar: { inputTokens: 0, outputTokens: 0 },
}
const ID = 'ap-1' as ApprovalId
const perm = (tool: string, input: Record<string, unknown> = {}) =>
  mapToolPermission(tool, input, CTX, ID)

describe('message mapping', () => {
  /*
   * The failure a user actually meets: an account over its limit ends the turn
   * with no reply, and `status: 'failed'` alone renders as nothing at all.
   */
  it('says why a turn failed instead of ending it silently', () => {
    const events = mapSdkMessage(
      { type: 'result', subtype: 'error_during_execution', uuid: 'r1', session_id: 's1' },
      { seq: 1, now: 1_000, approvalTtlMs: 1_000 }
    )
    const error = events.find((e) => e.type === 'error')
    expect(error).toBeDefined()
    expect(error && 'message' in error && error.message).toContain('usage limit')
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true)
  })

  it('prefers the errors the result reported over a generic line', () => {
    const events = mapSdkMessage(
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['rate_limit: weekly quota exhausted'],
        uuid: 'r2',
        session_id: 's1',
      },
      { seq: 1, now: 1_000, approvalTtlMs: 1_000 }
    )
    const error = events.find((e) => e.type === 'error')
    expect(error && 'message' in error && error.message).toBe('rate_limit: weekly quota exhausted')
  })

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

  describe('a todo write', () => {
    const todo = (todos: unknown) =>
      mapSdkMessage(
        {
          type: 'assistant',
          uuid: 'u-todo',
          message: {
            content: [{ type: 'tool_use', id: 'tt', name: 'TodoWrite', input: { todos } }],
          },
        },
        CTX
      )[0] as { detail?: string }

    /*
     * Every other key `describeToolInput` looks for is a string, and a todo
     * write carries one array — so this row used to render as the bare word
     * `TodoWrite`, which is the least useful line the CLI has.
     */
    it('says what the agent is doing now, and how far along it is', () => {
      expect(
        todo([
          { content: 'Read the types', activeForm: 'Reading the types', status: 'completed' },
          { content: 'Fix the parser', activeForm: 'Fixing the parser', status: 'in_progress' },
          { content: 'Write a test', activeForm: 'Writing a test', status: 'pending' },
        ]).detail
      ).toBe('Fixing the parser · 1/3')
    })

    it('falls back to the first outstanding item when nothing is in progress', () => {
      expect(
        todo([
          { content: 'Read the types', status: 'completed' },
          { content: 'Fix the parser', status: 'pending' },
        ]).detail
      ).toBe('Fix the parser · 1/2')
    })

    /*
     * The schema is the tool's own and undocumented. Being wrong about it has
     * to cost the detail line and nothing else — the row still renders, named.
     */
    it('says nothing rather than guessing when the shape is not what we expect', () => {
      expect(todo([]).detail).toBeUndefined()
      expect(todo('not a list').detail).toBeUndefined()
      expect(todo([{ nothing: 'useful' }]).detail).toBeUndefined()
      expect(todo([{ content: 'all done', status: 'completed' }]).detail).toBeUndefined()
    })
  })

  /*
   * The inverse of what this used to assert, and the change is the bug fix.
   *
   * `init` describes the session — cwd, model, tools, the CLI version — and the
   * adapter holds one long-lived `query()`, so it arrives once while `result`
   * closes every turn. Read as a turn start it produced one start for a whole
   * session, and everything folding the pair believed the agent went idle after
   * the first reply. `ClaudeSession.send` raises the start now.
   */
  it('does not treat system init as the start of a turn: it describes the session', () => {
    expect(mapSdkMessage({ type: 'system', subtype: 'init', uuid: 'u3' }, CTX)).toEqual([])
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

  it('no longer stays silent for message types it does not render', () => {
    /*
     * This asserted `[]` until the transcript-fidelity pass. The silence was
     * defensible while Chorus only had to show a finished diff; it is not, now
     * that Chorus is the only window on the agent. See the `system notices`
     * suite below for the per-subtype behaviour.
     */
    for (const type of ['tool_progress', 'auth_status', 'conversation_reset']) {
      expect(mapSdkMessage({ type }, CTX)).toMatchObject([{ type: 'notice', text: type }])
    }
  })
})

describe('system notices', () => {
  /** The subtypes carry fields `SdkMessageLike` does not declare. */
  const sys = (fields: Record<string, unknown>) =>
    mapSdkMessage(fields as unknown as Parameters<typeof mapSdkMessage>[0], {
      seq: 1,
      now: 1_000,
      approvalTtlMs: 1_000,
    })

  // Silent rather than a notice: the default arm raises a low-level `notice` so
  // an unknown subtype degrades to a muted line, and `init` is known — it is
  // simply not something the transcript has anything to say about.
  it('says nothing about init, which is session detail rather than a turn', () => {
    expect(sys({ type: 'system', subtype: 'init', uuid: 'u1' })).toEqual([])
  })

  it('reports a hook that failed', () => {
    expect(
      sys({
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'lint',
        hook_event: 'PreToolUse',
        outcome: 'error',
        output: 'no semicolons please',
        stdout: '',
        stderr: '',
      })
    ).toMatchObject([
      {
        type: 'notice',
        level: 'warn',
        source: 'hook',
        text: 'lint · PreToolUse',
        detail: 'no semicolons please',
      },
    ])
  })

  it('stays quiet about a hook that succeeded with nothing to say', () => {
    /*
     * A hook fires per matching tool call. A repo with a dozen of them would
     * put a dozen rows between every command and its output.
     */
    expect(
      sys({
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'noop',
        outcome: 'success',
        output: '',
        stdout: '',
        stderr: '   ',
      })
    ).toEqual([])
  })

  it('surfaces a tool denied by a rule, which used to leave no trace', () => {
    expect(
      sys({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        decision_reason: 'blocked by deny rule',
        message: 'not allowed',
      })
    ).toMatchObject([
      {
        type: 'notice',
        level: 'warn',
        source: 'denial',
        text: 'Bash',
        detail: 'blocked by deny rule',
      },
    ])
  })

  it('counts a retry, so a storm is distinguishable from a hang', () => {
    expect(
      sys({
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 5,
        error_status: 529,
      })
    ).toMatchObject([
      { type: 'notice', level: 'warn', source: 'retry', text: '2/5', detail: 'HTTP 529' },
    ])
  })

  it('shows the output of a local slash command', () => {
    expect(
      sys({ type: 'system', subtype: 'local_command_output', content: 'usage: 41%' })
    ).toMatchObject([{ type: 'notice', source: 'command', text: 'usage: 41%' }])
  })

  it('raises the level when a hook stops the loop', () => {
    expect(
      sys({
        type: 'system',
        subtype: 'informational',
        content: 'Stop hook denied continuation',
        level: 'info',
        prevent_continuation: true,
      })
    ).toMatchObject([{ type: 'notice', level: 'error' }])
  })

  it('degrades an unmapped subtype to a notice rather than to silence', () => {
    // The point of the phase: a subtype added by a future SDK is still visible.
    expect(sys({ type: 'system', subtype: 'some_future_subtype' })).toMatchObject([
      { type: 'notice', level: 'info', source: 'system', text: 'some_future_subtype' },
    ])
  })

  it('says nothing for a hook starting or still running', () => {
    /*
     * These only began arriving when `includeHookEvents` was turned on, and
     * neither carries an outcome: a start is not news and progress is a hook
     * still going. A repo with a dozen hooks would otherwise put two rows
     * around every tool call.
     */
    for (const subtype of ['hook_started', 'hook_progress']) {
      expect(sys({ type: 'system', subtype, hook_name: 'lint' })).toEqual([])
    }
  })

  it('writes nothing durable for the heartbeat subtypes', () => {
    /*
     * `status` ticks for as long as a turn runs, and every notice is a durable
     * row — so none of these may become one. What changed is that they are no
     * longer *thrown away*: they become `activity.changed`, which is state and
     * never reaches SQLite, so the working line can say what the agent says it
     * is doing instead of a rotating word invented here.
     */
    for (const subtype of ['status', 'thinking_tokens', 'session_state_changed']) {
      const events = sys({ type: 'system', subtype })
      expect(events.every((e) => e.type === 'activity.changed')).toBe(true)
    }
    expect(sys({ type: 'system', subtype: 'control_request_progress' })).toEqual([])
  })

  it('reads the provider’s own words off `status`, and clears them when it stops', () => {
    // The two words the SDK sends, verbatim. `compacting` is the one worth
    // having: it is slow, and the line used to say "considering" throughout.
    expect(sys({ type: 'system', subtype: 'status', status: 'compacting' })).toMatchObject([
      { type: 'activity.changed', activity: 'compacting' },
    ])
    expect(sys({ type: 'system', subtype: 'status', status: 'requesting' })).toMatchObject([
      { type: 'activity.changed', activity: 'requesting' },
    ])
    // Null on the wire when the phase ends, and null is what clears the word.
    expect(sys({ type: 'system', subtype: 'status', status: null })).toMatchObject([
      { type: 'activity.changed', activity: null },
    ])
  })

  it('reads only `requires_action` off the session state, never the turn boundaries', () => {
    /*
     * `running` and `idle` are turn boundaries, and those live in the log as
     * `turn.started` / `turn.completed` where they can be replayed. A second
     * opinion arriving on a channel nothing persists is how the two drift.
     */
    expect(
      sys({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' })
    ).toMatchObject([{ type: 'activity.changed', activity: 'awaitingInput' }])
    for (const state of ['running', 'idle']) {
      expect(sys({ type: 'system', subtype: 'session_state_changed', state })).toEqual([])
    }
  })

  it('leaves compaction to the PostCompact hook rather than double-reporting it', () => {
    expect(sys({ type: 'system', subtype: 'compact_boundary' })).toEqual([])
  })

  it('turns the running-tasks snapshot into state rather than a notice', () => {
    /*
     * The default arm used to make this a durable notice reading, in full,
     * `background_tasks_changed`. It is state — "every live background task
     * after the change. REPLACE semantics" — so it becomes an event the
     * conversation service pushes and never appends.
     */
    const [event] = sys({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 't1', task_type: 'shell', description: 'sleep 60' },
        { task_id: 't2', task_type: 'subagent', description: 'Explore' },
      ],
    })
    expect(event).toMatchObject({
      type: 'tasks.changed',
      tasks: [
        { id: 't1', kind: 'shell', description: 'sleep 60' },
        { id: 't2', kind: 'subagent', description: 'Explore' },
      ],
    })
  })

  it('reports an emptied list, because that is what clears the indicator', () => {
    // Under replace semantics an empty payload is the only way to learn that
    // the last task finished. Dropping it would leave the count stuck forever.
    expect(sys({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })).toMatchObject([
      { type: 'tasks.changed', tasks: [] },
    ])
  })

  it('drops a task with no id rather than showing one nothing can stop', () => {
    expect(
      sys({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_type: 'shell', description: 'no id' }, { task_id: 'ok' }],
      })
    ).toMatchObject([
      { type: 'tasks.changed', tasks: [{ id: 'ok', kind: 'task', description: '' }] },
    ])
  })

  it('degrades an unmapped top-level type to a notice', () => {
    expect(sys({ type: 'tool_progress' })).toMatchObject([
      { type: 'notice', source: 'system', text: 'tool_progress' },
    ])
  })
})

describe('tool calls', () => {
  const CTX_T = { seq: 1, now: 1_000, approvalTtlMs: 1_000 }
  const assistant = (blocks: unknown[], parent?: string) =>
    mapSdkMessage(
      {
        type: 'assistant',
        message: { id: 'm1', content: blocks },
        ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
      },
      CTX_T
    )

  it('reports a tool that is not Bash, which used to produce nothing', () => {
    expect(
      assistant([{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'TODO' } }])
    ).toMatchObject([{ type: 'tool.started', itemRef: 't1', name: 'Grep', detail: 'TODO' }])
  })

  it('leaves Bash on the command path, where output and an exit code are real', () => {
    const events = assistant([
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } },
    ])
    expect(events).toMatchObject([{ type: 'command.started', itemRef: 'b1' }])
  })

  it('does not give AskUserQuestion a tool row next to the question it is', () => {
    expect(assistant([{ type: 'tool_use', id: 'q1', name: USER_INPUT_TOOL, input: {} }])).toEqual(
      []
    )
  })

  /*
   * The path travels beside the line, not as the line.
   *
   * `detail` is a display string — whichever input best identifies the call, cut
   * to 120 characters — so a row you can click to open a file cannot use it. A
   * deep path is a prefix of itself by the time it is stored, and a `Grep` row's
   * detail is a regex. Both are why `path` exists.
   */
  describe('the file a row names', () => {
    const long = `/Users/someone/code/tpa/tpa-web-2/src/features/${'insurance-info/'.repeat(9)}pricing.ts`

    it('carries the whole path even when the line beside it was truncated', () => {
      const [event] = assistant([
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: long } },
      ])
      expect(long.length).toBeGreaterThan(120)
      expect(event).toMatchObject({ type: 'tool.started', path: long })
      // The visible line is still cut, which is the whole reason for two fields.
      expect((event as { detail?: string }).detail?.endsWith('…')).toBe(true)
    })

    it('names no file for a search, whose subject is the pattern', () => {
      const [event] = assistant([
        { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'TODO', path: '/p/src' } },
      ])
      // `pattern` wins the line, so the row reads as the search it is — and a
      // click that opened the directory it searched would not match what it says.
      expect(event).toMatchObject({ detail: 'TODO' })
      expect(event).not.toHaveProperty('path')
    })

    it('names no file for a subagent brief or a URL', () => {
      const [brief] = assistant([
        { type: 'tool_use', id: 't3', name: 'Task', input: { description: 'map the adapter' } },
      ])
      expect(brief).not.toHaveProperty('path')
      const [fetched] = assistant([
        { type: 'tool_use', id: 't4', name: 'WebFetch', input: { url: 'https://example.com/x' } },
      ])
      expect(fetched).not.toHaveProperty('path')
    })

    it('takes a notebook path too', () => {
      expect(
        assistant([
          {
            type: 'tool_use',
            id: 't5',
            name: 'NotebookEdit',
            input: { notebook_path: '/a.ipynb' },
          },
        ])
      ).toMatchObject([{ path: '/a.ipynb' }])
    })
  })

  it('carries the enclosing call, so a subagent’s work can be nested', () => {
    expect(
      assistant([{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a.ts' } }], 'p1')
    ).toMatchObject([{ type: 'tool.started', parentRef: 'p1', detail: '/a.ts' }])
  })

  it('prefers the field that identifies the call', () => {
    // A subagent's brief says more than the file it happens to name.
    expect(
      assistant([
        {
          type: 'tool_use',
          id: 't3',
          name: 'Task',
          input: { file_path: '/a.ts', description: 'audit the adapter' },
        },
      ])
    ).toMatchObject([{ detail: 'audit the adapter' }])
  })

  it('closes a non-Bash call so its row stops spinning', () => {
    const events = mapSdkMessage(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      },
      CTX_T
    )
    expect(events).toMatchObject([{ type: 'tool.completed', itemRef: 't1', status: 'ok' }])
  })

  it('marks a failed tool result as an error', () => {
    const events = mapSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
        },
      },
      CTX_T
    )
    expect(events).toMatchObject([{ type: 'tool.completed', status: 'error' }])
  })

  it('ignores a replayed tool result, which the log already holds', () => {
    /*
     * Resuming a session re-sends its history, and a replay is byte-identical
     * to a live user message apart from this flag. Mapped, a reopened
     * conversation appends a second copy of every command and tool call it
     * already contains.
     */
    const events = mapSdkMessage(
      {
        type: 'user',
        isReplay: true,
        message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'out' }] },
      },
      { ...CTX_T, bashToolIds: new Set(['b1']) }
    )
    expect(events).toEqual([])
  })

  it('still routes a known Bash id to command output', () => {
    const events = mapSdkMessage(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'out' }] },
      },
      { ...CTX_T, bashToolIds: new Set(['b1']) }
    )
    expect(events.map((e) => e.type)).toEqual(['command.output', 'command.completed'])
  })
})

describe('subagents', () => {
  const sys = (fields: Record<string, unknown>) =>
    mapSdkMessage(fields as unknown as Parameters<typeof mapSdkMessage>[0], {
      seq: 1,
      now: 1_000,
      approvalTtlMs: 1_000,
    })

  it('names a subagent against the call that spawned it', () => {
    expect(
      sys({
        type: 'system',
        subtype: 'task_started',
        task_id: 'k1',
        tool_use_id: 't9',
        description: 'map the adapter',
        subagent_type: 'Explore',
      })
    ).toMatchObject([
      { type: 'tool.started', itemRef: 't9', name: 'Explore', detail: 'map the adapter' },
    ])
  })

  it('falls back to the task id when no tool call preceded it', () => {
    // Workflow tasks arrive with no `tool_use_id` and deserve a row of their own.
    expect(
      sys({
        type: 'system',
        subtype: 'task_started',
        task_id: 'k2',
        description: 'run the spec',
        workflow_name: 'spec',
      })
    ).toMatchObject([{ type: 'tool.started', itemRef: 'k2', name: 'spec' }])
  })

  it('honours skip_transcript rather than filling the log with housekeeping', () => {
    expect(
      sys({
        type: 'system',
        subtype: 'task_started',
        task_id: 'k3',
        description: 'ambient',
        skip_transcript: true,
      })
    ).toEqual([])
  })

  it('says what a running subagent is doing, not merely that it is running', () => {
    expect(
      sys({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'k1',
        tool_use_id: 't9',
        description: 'map the adapter',
        last_tool_name: 'Grep',
        usage: { total_tokens: 10, tool_uses: 2, duration_ms: 4200 },
      })
    ).toMatchObject([{ type: 'tool.progress', itemRef: 't9', note: 'Grep', elapsedMs: 4200 }])
  })

  it('closes a subagent with its summary', () => {
    expect(
      sys({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'k1',
        tool_use_id: 't9',
        status: 'completed',
        output_file: '/tmp/out',
        summary: 'found three',
      })
    ).toMatchObject([
      { type: 'tool.completed', itemRef: 't9', status: 'ok', summary: 'found three' },
    ])
  })

  it('treats a stopped subagent as an error, not a success', () => {
    expect(
      sys({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'k1',
        tool_use_id: 't9',
        status: 'stopped',
        output_file: '/tmp/out',
        summary: 'gave up',
      })
    ).toMatchObject([{ status: 'error' }])
  })

  it('stays quiet for task_updated, which has no id to correlate', () => {
    // It is keyed on task_id alone; task_notification reports the same ending
    // and does carry a tool_use_id.
    expect(
      sys({ type: 'system', subtype: 'task_updated', task_id: 'k1', patch: { status: 'failed' } })
    ).toEqual([])
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

  it('names the tool on the catch-all card', () => {
    // Without this the card reads "permissionGrant" and nothing else, so
    // spawning a subagent and writing a todo list look identical.
    expect(perm('Task', { subagent_type: 'Explore' })).toMatchObject({
      kind: 'permissionGrant',
      toolName: 'Task',
    })
  })

  it('carries the arguments of an unnamed tool, so the card has a detail', () => {
    expect(perm('ExitPlanMode', { plan: 'do the thing' })).toMatchObject({
      kind: 'permissionGrant',
      input: { plan: 'do the thing' },
    })
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
  const CTX = {
    seq: 0,
    now: 1_000,
    approvalTtlMs: 60_000,
    usageSoFar: { inputTokens: 0, outputTokens: 0 },
  }

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

  it('closes a non-command tool without reporting its output as output', () => {
    /*
     * This asserted `[]` before the transcript-fidelity pass. Another tool's
     * result is still the agent's own working — which is why the *content* does
     * not become `command.output` — but the call ending is a fact the row needs,
     * or it spins forever.
     */
    const ids = trackBashTools(bashCall('t1', 'ls') as never, new Set())
    expect(
      mapSdkMessage(toolResult('t9', 'file contents') as never, { ...CTX, bashToolIds: ids })
    ).toMatchObject([{ type: 'tool.completed', itemRef: 't9', status: 'ok' }])
  })

  it('emits nothing when the result carries no output', () => {
    const ids = trackBashTools(bashCall('t1', 'true') as never, new Set())
    const events = mapSdkMessage(toolResult('t1', '') as never, { ...CTX, bashToolIds: ids })
    expect(events.map((e) => e.type)).toEqual(['command.completed'])
  })
})

describe('context usage', () => {
  const BASE = { agentId: 'claude' as const, seq: 1, at: 1_000 }

  it('reports how full the window is', () => {
    expect(mapContextUsage({ totalTokens: 90_000, maxTokens: 200_000 }, BASE)).toMatchObject([
      { type: 'context.usage', usedTokens: 90_000, maxTokens: 200_000, percentUsed: 45 },
    ])
  })

  it('derives the percentage rather than trusting the reported one', () => {
    /*
     * The response carries `percentage` and the types do not say whether it is a
     * fraction or a percentage. The rate-limit shapes in this file already cost
     * a release to that exact ambiguity, so it is ignored: a wrong unit here
     * would read as a full window at 0.45.
     */
    expect(
      mapContextUsage({ totalTokens: 90_000, maxTokens: 200_000, percentage: 0.45 }, BASE)
    ).toMatchObject([{ percentUsed: 45 }])
  })

  it('never reports more than full', () => {
    expect(mapContextUsage({ totalTokens: 250_000, maxTokens: 200_000 }, BASE)).toMatchObject([
      { percentUsed: 100 },
    ])
  })

  it('says nothing when the numbers are missing or unusable', () => {
    for (const usage of [
      undefined,
      {},
      { totalTokens: 10 },
      { maxTokens: 200_000 },
      { totalTokens: 10, maxTokens: 0 },
      { totalTokens: -1, maxTokens: 200_000 },
    ]) {
      expect(mapContextUsage(usage, BASE)).toEqual([])
    }
  })
})

describe('rate limits', () => {
  const CTX = { seq: 0, now: 1_000, approvalTtlMs: 60_000 }

  /*
   * Captured from a live `rate_limit_event`, not written from sdk.d.ts.
   *
   * The types describe `rate_limits_available` and a nested `rate_limits`
   * object; this is what actually arrives. Mapping from the types alone meant
   * Claude's limits never appeared at all.
   */
  const LIVE = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      resetsAt: 1_786_039_200,
      rateLimitType: 'seven_day',
      utilization: 0.85,
      isUsingOverage: false,
      surpassedThreshold: 0.75,
    },
  }

  it('reads the shape the SDK actually sends', () => {
    const [event] = mapSdkMessage(LIVE, CTX)
    expect(event?.type).toBe('limits')
    expect(event?.type === 'limits' && event.windows).toEqual([
      {
        id: 'seven_day',
        // A fraction on the wire, a percentage everywhere else.
        usedPercent: 85,
        windowMinutes: 10_080,
        // Seconds on the wire, milliseconds everywhere else.
        resetsAt: 1_786_039_200_000,
      },
    ])
  })

  it('still reads the shape the types describe', () => {
    const [event] = mapSdkMessage(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          rate_limits: { five_hour: { utilization: 42, resets_at: '2026-08-05T10:00:00.000Z' } },
        },
      },
      CTX
    )
    expect(event?.type === 'limits' && event.windows[0]).toEqual({
      id: 'five_hour',
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: Date.parse('2026-08-05T10:00:00.000Z'),
    })
  })

  it('says nothing when there is nothing to say', () => {
    expect(mapSdkMessage({ type: 'rate_limit_event' }, CTX)).toEqual([])
  })
})

describe('plan usage', () => {
  const BASE = { agentId: 'claude' as const, seq: 1, at: 1_000 }

  /* Captured from the SDK's own `/usage` response on a Max plan. */
  const LIVE = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 2, resets_at: '2026-08-04T23:50:00.163284+00:00' },
      seven_day: { utilization: 86, resets_at: '2026-08-06T17:59:59.163318+00:00' },
      seven_day_opus: null,
      tangelo: null,
    },
  }

  it('reports both windows, shortest first', () => {
    const [event] = mapPlanUsage(LIVE, BASE)
    expect(event?.type === 'limits' && event.windows).toEqual([
      {
        id: 'five_hour',
        // Already a percentage here, unlike the fraction on rate_limit_event.
        usedPercent: 2,
        windowMinutes: 300,
        resetsAt: Date.parse('2026-08-04T23:50:00.163284+00:00'),
      },
      {
        id: 'seven_day',
        usedPercent: 86,
        windowMinutes: 10_080,
        resetsAt: Date.parse('2026-08-06T17:59:59.163318+00:00'),
      },
    ])
  })

  it('ignores the windows a plan does not have', () => {
    // Most of the named ones are null, and a couple are not windows we know.
    const [event] = mapPlanUsage(LIVE, BASE)
    expect(event?.type === 'limits' && event.windows.map((w) => w.id)).not.toContain('tangelo')
  })

  it('says nothing for an account with no plan windows', () => {
    // API key, Bedrock, Vertex: `rate_limits_available` is false.
    expect(mapPlanUsage({ rate_limits_available: false, rate_limits: null }, BASE)).toEqual([])
    expect(mapPlanUsage(undefined, BASE)).toEqual([])
  })
})

describe('user input requests', () => {
  const id = 'u1' as UserInputId
  const ask = (input: Record<string, unknown>) =>
    mapUserInputRequest(USER_INPUT_TOOL, input, CTX, id)

  it('maps a question set', () => {
    const r = ask({
      questions: [
        {
          question: 'Which auth method?',
          header: 'Auth',
          multiSelect: false,
          options: [
            { label: 'OAuth', description: 'Third party' },
            { label: 'Password', description: 'Local' },
          ],
        },
      ],
    })

    expect(r).toMatchObject({
      id,
      agentId: 'claude',
      expiresAt: CTX.now + CTX.approvalTtlMs,
      questions: [
        {
          id: '0',
          header: 'Auth',
          question: 'Which auth method?',
          multiSelect: false,
          // The harness always offers Other, and Claude has no secret concept.
          allowOther: true,
          isSecret: false,
          options: [
            { label: 'OAuth', description: 'Third party' },
            { label: 'Password', description: 'Local' },
          ],
        },
      ],
    })
  })

  it('carries multiSelect through, which Codex cannot express', () => {
    const r = ask({
      questions: [
        { question: 'Which features?', header: 'Features', multiSelect: true, options: [] },
      ],
    })
    expect(r?.questions[0]?.multiSelect).toBe(true)
  })

  it('identifies questions by position, since Claude sends no ids', () => {
    const r = ask({
      questions: [
        { question: 'First?', header: 'A', options: [] },
        { question: 'Second?', header: 'B', options: [] },
      ],
    })
    expect(r?.questions.map((q) => q.id)).toEqual(['0', '1'])
  })

  it('leaves every other tool to the approval path', () => {
    // The whole point of the split: Bash must never come back as a question.
    expect(mapUserInputRequest('Bash', { command: 'ls' }, CTX, id)).toBeNull()
    expect(mapUserInputRequest('Edit', { file_path: '/a.ts' }, CTX, id)).toBeNull()
    expect(mapUserInputRequest('mcp__slack__post', {}, CTX, id)).toBeNull()
  })

  it('returns null when there are no questions, so the caller can fall through', () => {
    expect(ask({ questions: [] })).toBeNull()
    expect(ask({})).toBeNull()
  })

  it('still reaches the approval mapper for non-question tools', () => {
    // Guards the regression this split exists to prevent: routing questions out
    // of mapToolPermission must not stop ordinary tools producing approvals.
    expect(mapToolPermission('Bash', { command: 'ls' }, CTX, 'a1' as ApprovalId)).toMatchObject({
      kind: 'command',
    })
  })
})

describe('user input results', () => {
  it('keys answers by the question text, which is what the CLI matches on', () => {
    /*
     * C-018. This asserted `answers: [['Postgres']]` and passed, while the
     * installed CLI rejected that shape outright — "expected as a `record` but
     * was provided as an `array`" — so the agent was told the question came
     * back unanswered. The test was written from the same assumption as the
     * code, which is why it confirmed rather than caught it.
     *
     * The shape is the CLI's own: "question text -> answer string".
     */
    const input = { questions: [{ question: 'Which?', header: 'H', options: [] }] }
    expect(
      toClaudeUserInputResult(input, {
        outcome: 'answered',
        answers: [{ questionId: '0', values: ['Postgres'] }],
      })
    ).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which?': 'Postgres' } },
    })
  })

  it('joins a multi-select with commas, as the schema asks', () => {
    const input = {
      questions: [
        { question: 'Which databases?', options: [] },
        { question: 'Which cache?', options: [] },
      ],
    }
    expect(
      toClaudeUserInputResult(input, {
        outcome: 'answered',
        answers: [
          { questionId: '0', values: ['a', 'b'] },
          { questionId: '1', values: ['c'] },
        ],
      })
    ).toMatchObject({
      updatedInput: { answers: { 'Which databases?': 'a,b', 'Which cache?': 'c' } },
    })
  })

  it('denies rather than dropping an answer whose question it cannot name', () => {
    /*
     * This dropped the entry and returned `allow` with an empty record, which
     * the CLI reads as "the user chose nothing" — an answer that never lands,
     * logged as `answered`. That is C-018's shape exactly, so a stale renderer
     * or a future id regression would recreate it silently.
     *
     * A deny is recoverable: the agent is told nothing was chosen, which is the
     * same thing the timeout path says and for the same reason.
     */
    expect(
      toClaudeUserInputResult(
        { questions: [{ question: 'Which?', options: [] }] },
        { outcome: 'answered', answers: [{ questionId: '7', values: ['x'] }] }
      )
    ).toMatchObject({ behavior: 'deny' })
  })

  it('denies a partially resolvable set rather than sending half of it', () => {
    // Half an answer is not a smaller answer; it is a wrong one.
    expect(
      toClaudeUserInputResult(
        { questions: [{ question: 'Which?', options: [] }] },
        {
          outcome: 'answered',
          answers: [
            { questionId: '0', values: ['ok'] },
            { questionId: '9', values: ['nope'] },
          ],
        }
      )
    ).toMatchObject({ behavior: 'deny' })
  })

  it('survives a question the agent called __proto__', () => {
    /*
     * The keys are text the agent wrote, so this is reachable input. Assigning
     * `answers['__proto__']` on a plain object sets the prototype instead of an
     * own property and serialises to `{}` — the answer would disappear with no
     * error anywhere, which is the same silent loss C-018 caused.
     */
    const result = toClaudeUserInputResult(
      { questions: [{ question: '__proto__', options: [] }] },
      { outcome: 'answered', answers: [{ questionId: '0', values: ['kept'] }] }
    )
    if (result.behavior !== 'allow') throw new Error('expected the answer to be allowed')
    const answers = result.updatedInput['answers']
    expect(Object.prototype.hasOwnProperty.call(answers, '__proto__')).toBe(true)
    /*
     * Round-tripped, because what reaches the CLI is JSON — and read back with
     * `hasOwnProperty` rather than compared to a literal. An expected value
     * written `{ __proto__: 'kept' }` is the same footgun: the literal sets a
     * prototype and evaluates to `{}`, so the assertion fails against correct
     * code. It did, while this test was being written.
     */
    const roundTripped: unknown = JSON.parse(JSON.stringify(answers))
    expect((roundTripped as Record<string, string>)['__proto__']).toBe('kept')
    expect(Object.keys(roundTripped as Record<string, string>)).toEqual(['__proto__'])
  })

  it('denies rather than fabricating an answer on cancel or timeout', () => {
    // A made-up choice is unrecoverable; being told nothing was chosen is not.
    for (const outcome of ['cancel', 'timeout'] as const) {
      expect(toClaudeUserInputResult({}, { outcome })).toMatchObject({ behavior: 'deny' })
    }
  })
})

/**
 * The diff an edit carried.
 *
 * Shapes here are copied from a recorded session against claude 2.1.226, not
 * from `sdk-tools.d.ts` — `tool_use_result` is `unknown` in the types, and this
 * codebase has been wrong five times about what the SDK actually sends.
 */
describe('mapping: edit patches', () => {
  const CTX = { seq: 1, now: 1_000, approvalTtlMs: 1_000 }

  const result = (toolUseResult: unknown, opts: { isError?: boolean } = {}) =>
    mapSdkMessage(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'ok',
              ...(opts.isError === true ? { is_error: true } : {}),
            },
          ],
        },
        tool_use_result: toolUseResult,
      },
      CTX
    )

  /** The fields under test, read off the first event without re-deriving the union. */
  interface PatchView {
    patch?: string
    omittedLines?: number
    status?: string
  }
  const first = (toolUseResult: unknown, opts: { isError?: boolean } = {}): PatchView =>
    result(toolUseResult, opts)[0] as unknown as PatchView

  const EDIT = {
    filePath: '/repo/alpha.ts',
    oldString: '  const base = 1',
    newString: '  const base = 2',
    originalFile: 'x',
    userModified: false,
    replaceAll: false,
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 5,
        newStart: 1,
        newLines: 5,
        lines: [
          ' export function widgetCount(): number {',
          '-  const base = 1',
          '+  const base = 2',
          '   const extra = 1',
        ],
      },
    ],
  }

  it('serializes an edit into a diff parseDiff can read', () => {
    const event = first(EDIT)
    expect(event.patch).toBe(
      'diff --git a//repo/alpha.ts b//repo/alpha.ts\n' +
        '@@ -1,5 +1,5 @@\n' +
        ' export function widgetCount(): number {\n' +
        '-  const base = 1\n' +
        '+  const base = 2\n' +
        '   const extra = 1\n'
    )
  })

  it('keeps every hunk when replace_all touched several places', () => {
    const hunks = [1, 9, 18].map((start) => ({
      oldStart: start,
      oldLines: 1,
      newStart: start,
      newLines: 1,
      lines: ['-const a = "TOKEN"', '+const a = "MARKER"'],
    }))
    const event = first({ ...EDIT, replaceAll: true, structuredPatch: hunks })
    expect(event.patch?.match(/^@@ /gm)).toHaveLength(3)
    expect(event.patch).toContain('@@ -18,1 +18,1 @@')
  })

  it('synthesizes an all-added diff for a created file, capped and counted', () => {
    const body = Array.from({ length: 50 }, (_, i) => `line ${String(i + 1)}`).join('\n')
    const event = first({
      type: 'create',
      filePath: '/repo/new.ts',
      content: body,
      originalFile: null,
      structuredPatch: [],
      userModified: false,
    })

    expect(event.omittedLines).toBe(38)
    expect(event.patch).toContain('@@ -0,0 +1,12 @@')
    expect(event.patch).toContain('+line 12')
    expect(event.patch).not.toContain('+line 13')
  })

  it('does not count omitted lines when a created file fits', () => {
    const event = first({
      type: 'create',
      filePath: '/repo/small.ts',
      content: 'a\nb\n',
      originalFile: null,
      structuredPatch: [],
      userModified: false,
    })

    expect(event.omittedLines).toBeUndefined()
    expect(event.patch).toContain('@@ -0,0 +1,2 @@')
  })

  it('says a created file was created, so it is not lettered as an edit', () => {
    /*
     * Without the mode line a new file is a diff whose every line is an
     * addition — which is exactly what rewriting an existing file looks like.
     * Anything deriving a status from the patch reads `M` where the file is new,
     * and no assertion about hunks or counts catches it.
     */
    const event = first({
      type: 'create',
      filePath: '/repo/fresh.ts',
      content: 'a\n',
      originalFile: null,
      structuredPatch: [],
      userModified: false,
    })

    expect(event.patch).toBe(
      'diff --git a//repo/fresh.ts b//repo/fresh.ts\n' +
        'new file mode 100644\n' +
        '--- /dev/null\n' +
        '+++ b//repo/fresh.ts\n' +
        '@@ -0,0 +1,1 @@\n' +
        '+a\n'
    )
  })

  it('leaves an ordinary edit without a mode line, so it stays an edit', () => {
    expect(first(EDIT).patch).not.toContain('new file mode')
  })

  it('carries no patch for a failed edit, which changed nothing', () => {
    const event = first(EDIT, { isError: true })
    expect(event.status).toBe('error')
    expect(event.patch).toBeUndefined()
  })

  it.each([
    ['absent', undefined],
    ['not an object', 'nope'],
    ['missing structuredPatch', { filePath: '/a.ts' }],
    ['a malformed hunk', { filePath: '/a.ts', structuredPatch: [{ oldStart: 'one' }] }],
    ['a tool that touches no file', { type: 'text', file: { content: 'x' } }],
  ])('carries no patch when tool_use_result is %s', (_label, value) => {
    const event = first(value)
    expect(event.patch).toBeUndefined()
  })

  it('attaches nothing when a message carries more than one result', () => {
    /*
     * `tool_use_result` is one field on the message, so it is only unambiguous
     * while there is one result to own it. The SDK splits parallel calls into
     * separate messages, which is why this is a guard rather than a code path —
     * but a wrong diff under the wrong file is worse than no diff.
     */
    const events = mapSdkMessage(
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
          ],
        },
        tool_use_result: EDIT,
      },
      CTX
    ) as unknown as PatchView[]

    expect(events).toHaveLength(2)
    expect(events.every((e) => e.patch === undefined)).toBe(true)
  })
})
