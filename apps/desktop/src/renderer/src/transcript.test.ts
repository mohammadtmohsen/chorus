import { describe, expect, it } from 'vitest'
import type { TranscriptEvent } from '../../shared/ipc.js'
import {
  answersThinking,
  EMPTY_VIEW,
  groupedWith,
  reduceEvents,
  type TranscriptMessage,
} from './transcript.js'

let seq = 0
function event(
  type: string,
  payload: Record<string, unknown>,
  actor: TranscriptEvent['actor'] = 'codex'
): TranscriptEvent {
  seq += 1
  return {
    seq,
    id: `e${String(seq)}`,
    conversationId: 'c1',
    actor,
    type,
    payload,
    createdAt: seq,
  }
}

describe('reduceEvents', () => {
  it('stitches deltas into one growing message', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.message.delta', { itemRef: 'm1', text: 'Hel' }),
      event('agent.message.delta', { itemRef: 'm1', text: 'lo' }),
    ])
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({ text: 'Hello', status: 'streaming' })
  })

  it('lets the completed text replace the streamed fragments', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.message.delta', { itemRef: 'm1', text: 'Hel' }),
      event('agent.message.completed', { itemRef: 'm1', text: 'Hello world' }),
    ])
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({ text: 'Hello world', status: 'complete' })
  })

  it('ignores a delta that arrives after completion', () => {
    // Push and history replay can interleave; a late delta must not corrupt an
    // already-final message.
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.message.completed', { itemRef: 'm1', text: 'final' }),
      event('agent.message.delta', { itemRef: 'm1', text: ' extra' }),
    ])
    expect(view.messages[0]?.text).toBe('final')
  })

  it('deduplicates events already applied', () => {
    // The renderer receives the same events from both the live push and a
    // history replay. seq makes that a comparison rather than a guess.
    const first = reduceEvents(EMPTY_VIEW, [event('user.message', { text: 'hi' }, 'user')])
    const replayed = reduceEvents(first, first.messages.length > 0 ? [] : [])
    const again = reduceEvents(replayed, [
      { ...event('user.message', { text: 'hi' }, 'user'), seq: 1, id: 'e1' },
    ])
    expect(again.messages).toHaveLength(1)
  })

  it('tracks busy across a turn', () => {
    let view = reduceEvents(EMPTY_VIEW, [event('turn.started', { turnRef: 't1' })])
    expect(view.busy).toBe(true)
    view = reduceEvents(view, [event('turn.completed', { turnRef: 't1', status: 'completed' })])
    expect(view.busy).toBe(false)
  })

  it('says "Stopped." for a user-initiated interrupt, not an error', () => {
    // Claude reports a user stop identically to a failure on the wire (S3b);
    // the log carries userInitiated so the UI can tell the difference.
    const view = reduceEvents(EMPTY_VIEW, [
      event('turn.completed', { turnRef: 't1', status: 'interrupted', userInitiated: true }),
    ])
    expect(view.messages.at(-1)?.text).toBe('Stopped.')
  })

  it('announces an automatic decision, even though the request was pending first', () => {
    // The request is logged before policy evaluates, so an auto-decided approval
    // does briefly show as pending. Skipping the notice in that case made every
    // automatic decision invisible — a live run caught it.
    let view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a9',
        kind: 'command',
        expiresAt: 0,
        request: { command: ['rm', '-rf', './x'] },
      }),
    ])
    expect(view.approvals).toHaveLength(1)

    view = reduceEvents(view, [
      event('approval.decided', {
        approvalId: 'a9',
        outcome: 'deny',
        decidedBy: 'policy',
        policyRuleId: 'deny-recursive-delete',
      }),
    ])
    expect(view.approvals).toHaveLength(0)
    expect(view.messages.at(-1)?.text).toBe('Denied automatically · deny-recursive-delete')
  })

  it('says plainly when nobody answered in time', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.decided', { approvalId: 'a', outcome: 'timeout', decidedBy: 'system' }),
    ])
    expect(view.messages.at(-1)?.text).toBe('Denied — nobody answered in time.')
  })

  it('stays quiet when the user decided it themselves', () => {
    // They just clicked the button; narrating it back is noise.
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.decided', { approvalId: 'a', outcome: 'allow', decidedBy: 'user' }),
    ])
    expect(view.messages).toHaveLength(0)
  })

  it('surfaces and then clears an approval', () => {
    let view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a1',
        kind: 'command',
        expiresAt: 999,
        request: { command: ['git', 'status'] },
      }),
    ])
    expect(view.approvals).toHaveLength(1)
    expect(view.approvals[0]).toMatchObject({ summary: '$ git status' })

    view = reduceEvents(view, [event('approval.decided', { approvalId: 'a1', outcome: 'allow' })])
    expect(view.approvals).toHaveLength(0)
  })

  it('summarizes a file-change approval by path', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a2',
        kind: 'fileChange',
        expiresAt: 0,
        request: { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] },
      }),
    ])
    expect(view.approvals[0]?.summary).toBe('Edit src/a.ts, src/b.ts')
  })

  it('prefers the sentence the provider already wrote', () => {
    /*
     * Everything else here reconstructs a summary from a tool name and an
     * argument bag, which is guesswork about something the CLI already knows.
     */
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a10',
        kind: 'command',
        expiresAt: 0,
        request: { command: ['cat', 'foo.txt'], title: 'Claude wants to read foo.txt' },
      }),
    ])
    expect(view.approvals[0]?.summary).toBe('Claude wants to read foo.txt')
  })

  it('falls back to its own summary when the provider offers none', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a11',
        kind: 'command',
        expiresAt: 0,
        request: { command: ['git', 'status'] },
      }),
    ])
    expect(view.approvals[0]?.summary).toBe('$ git status')
  })

  it('shows why it is being asked, including a path in no argument', () => {
    // A Bash command reaching outside the allowed directories names the path
    // only in the permission request — it appears nowhere in the command.
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a12',
        kind: 'command',
        expiresAt: 0,
        request: {
          command: ['cat', '../secrets'],
          decisionReason: 'Outside the allowed directories',
          blockedPath: '/etc/secrets',
        },
      }),
    ])
    expect(view.approvals[0]?.detail).toBe('Outside the allowed directories\n/etc/secrets')
  })

  it('summarizes a catch-all approval by its tool name', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a3',
        kind: 'permissionGrant',
        expiresAt: 0,
        request: { toolName: 'Task', input: { subagent_type: 'Explore' } },
      }),
    ])
    expect(view.approvals[0]?.summary).toBe('Task')
  })

  it('does not pass a named non-MCP tool off as an MCP call', () => {
    // The MCP branch defaults an absent server to "mcp". Claiming any payload
    // with a `toolName` would render this as "mcp: Task".
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a4',
        kind: 'permissionGrant',
        expiresAt: 0,
        request: { toolName: 'Task' },
      }),
    ])
    expect(view.approvals[0]?.summary).not.toContain('mcp')
  })

  it('still summarizes an MCP call as server and tool', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('approval.requested', {
        approvalId: 'a5',
        kind: 'mcpToolCall',
        expiresAt: 0,
        request: { serverName: 'slack', toolName: 'slack_send_message' },
      }),
    ])
    expect(view.approvals[0]?.summary).toBe('slack: slack_send_message')
  })

  it('renders a notice against the agent whose turn it happened in', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event(
        'notice.raised',
        { level: 'warn', source: 'hook', text: 'lint · PreToolUse', detail: 'no semicolons' },
        'claude'
      ),
    ])
    expect(view.messages[0]).toMatchObject({
      kind: 'notice',
      actor: 'claude',
      level: 'warn',
      noticeSource: 'hook',
      text: 'lint · PreToolUse',
      detail: 'no semicolons',
    })
  })

  describe('a run of talkative hooks', () => {
    const hook = (text: string, detail: string, level = 'info') =>
      event('notice.raised', { level, source: 'hook', text, detail }, 'claude')

    /*
     * Measured on the real CLI: seven Bash hooks and one command produced six
     * durable rows between the command and its output. Folding costs one.
     */
    it('folds consecutive info notices into one row that keeps every line', () => {
      const view = reduceEvents(EMPTY_VIEW, [
        hook('pre · PreToolUse', 'noisy-pre-1'),
        hook('pre · PreToolUse', 'noisy-pre-2'),
        hook('pre · PreToolUse', 'noisy-pre-3'),
      ])
      expect(view.messages).toHaveLength(1)
      expect(view.messages[0]?.folded).toEqual([
        { text: 'pre · PreToolUse', detail: 'noisy-pre-1' },
        { text: 'pre · PreToolUse', detail: 'noisy-pre-2' },
        { text: 'pre · PreToolUse', detail: 'noisy-pre-3' },
      ])
    })

    /*
     * The whole reason the transcript carries hooks is the one that blocked
     * something. A failure is `warn` and must never be counted away.
     */
    it('never folds a hook that failed', () => {
      const view = reduceEvents(EMPTY_VIEW, [
        hook('pre · PreToolUse', 'noisy-pre-1'),
        hook('lint · PreToolUse', 'no semicolons', 'warn'),
        hook('pre · PreToolUse', 'noisy-pre-2'),
      ])
      expect(view.messages).toHaveLength(3)
      expect(view.messages.map((m) => m.level)).toEqual(['info', 'warn', 'info'])
      expect(view.messages.every((m) => m.folded === undefined)).toBe(true)
    })

    /* A group of one would read as a count where a sentence belongs. */
    it('leaves a lone notice alone', () => {
      const view = reduceEvents(EMPTY_VIEW, [hook('pre · PreToolUse', 'noisy-pre-1')])
      expect(view.messages[0]?.folded).toBeUndefined()
      expect(view.messages[0]?.text).toBe('pre · PreToolUse')
    })

    /* Anything between them is the command they gated, and it breaks the run. */
    it('does not fold across something that happened in between', () => {
      const view = reduceEvents(EMPTY_VIEW, [
        hook('pre · PreToolUse', 'noisy-pre-1'),
        event('command.started', { itemRef: 'c1', command: ['echo one'] }, 'claude'),
        hook('post · PostToolUse', 'noisy-post-1'),
      ])
      expect(view.messages.filter((m) => m.kind === 'notice')).toHaveLength(2)
    })

    /* Two agents in one room: a run belongs to whoever's turn it happened in. */
    it("does not fold one agent's hooks into another's", () => {
      const view = reduceEvents(EMPTY_VIEW, [
        hook('pre · PreToolUse', 'noisy-pre-1'),
        event('notice.raised', { level: 'info', source: 'hook', text: 'x', detail: 'y' }, 'codex'),
      ])
      expect(view.messages).toHaveLength(2)
    })

    /* Folding is for hooks; a session notice is not a repetition of anything. */
    it('does not fold notices from other sources', () => {
      const view = reduceEvents(EMPTY_VIEW, [
        event('notice.raised', { level: 'info', source: 'system', text: 'a' }, 'claude'),
        event('notice.raised', { level: 'info', source: 'system', text: 'b' }, 'claude'),
      ])
      expect(view.messages).toHaveLength(2)
    })
  })

  it('omits an empty detail rather than rendering a blank disclosure', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('notice.raised', { level: 'info', source: 'system', text: 'note', detail: '' }),
    ])
    expect(view.messages[0]?.detail).toBeUndefined()
  })

  it('falls back to info for a level it does not know', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('notice.raised', { level: 'catastrophic', source: 'system', text: 'x' }),
    ])
    expect(view.messages[0]?.level).toBe('info')
  })

  it('merges a subagent’s two announcements into one row', () => {
    // The model's `Task` call, then the provider naming it. Stacking both is
    // what this keying prevents.
    const view = reduceEvents(EMPTY_VIEW, [
      event('tool.started', { itemRef: 't9', name: 'Task', detail: 'map the adapter' }, 'claude'),
      event('tool.started', { itemRef: 't9', name: 'Explore', detail: '' }, 'claude'),
    ])
    const tools = view.messages.filter((m) => m.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ text: 'Explore', detail: 'map the adapter' })
  })

  it('shows what a running tool is doing', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('tool.started', { itemRef: 't1', name: 'Task', detail: 'audit' }, 'claude'),
      event('tool.progress', { itemRef: 't1', note: 'Grep', elapsedMs: 900 }, 'claude'),
    ])
    expect(view.messages[0]).toMatchObject({ detail: 'Grep', toolStatus: 'running' })
  })

  it('stops the row spinning when the call ends', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('tool.started', { itemRef: 't1', name: 'Read', detail: '/a.ts' }, 'claude'),
      event(
        'tool.completed',
        { itemRef: 't1', status: 'error', summary: 'no such file' },
        'claude'
      ),
    ])
    expect(view.messages[0]).toMatchObject({ toolStatus: 'error', detail: '/a.ts' })
  })

  it('carries an edit patch onto the tool row without parsing it', () => {
    // The reducer stays a pure fold: parsing is the component's job, so the
    // string arrives here untouched.
    const patch = 'diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n'
    const view = reduceEvents(EMPTY_VIEW, [
      event('tool.started', { itemRef: 't1', name: 'Edit', detail: '/a.ts' }, 'claude'),
      event('tool.completed', { itemRef: 't1', status: 'ok', patch }, 'claude'),
    ])
    expect(view.messages[0]).toMatchObject({ patch, toolStatus: 'ok' })
  })

  it('leaves the patch off a row whose tool carried none', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('tool.started', { itemRef: 't1', name: 'Read', detail: '/a.ts' }, 'claude'),
      event('tool.completed', { itemRef: 't1', status: 'ok', patch: null }, 'claude'),
    ])
    expect(view.messages[0]?.patch).toBeUndefined()
    expect(view.messages[0]?.omittedLines).toBeUndefined()
  })

  it('carries the omitted-line count for a capped new file', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('tool.started', { itemRef: 't1', name: 'Write', detail: '/new.ts' }, 'claude'),
      event(
        'tool.completed',
        { itemRef: 't1', status: 'ok', patch: 'diff --git a/n b/n\n', omittedLines: 10 },
        'claude'
      ),
    ])
    expect(view.messages[0]).toMatchObject({ omittedLines: 10 })
  })

  it('does not let a summary overwrite the subject that identifies the row', () => {
    // For a Read the summary is the first line of the file, which says less
    // than the path already shown.
    const view = reduceEvents(EMPTY_VIEW, [
      event('tool.started', { itemRef: 't1', name: 'Read', detail: '/a.ts' }, 'claude'),
      event(
        'tool.completed',
        { itemRef: 't1', status: 'ok', summary: 'import x from y' },
        'claude'
      ),
    ])
    expect(view.messages[0]?.detail).toBe('/a.ts')
  })

  it('fills an empty subject from the summary', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('tool.started', { itemRef: 't1', name: 'Task', detail: '' }, 'claude'),
      event('tool.completed', { itemRef: 't1', status: 'ok', summary: 'found three' }, 'claude'),
    ])
    expect(view.messages[0]?.detail).toBe('found three')
  })

  it('invents no row for progress on a call it never saw start', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('tool.progress', { itemRef: 'ghost', note: 'Grep' }, 'claude'),
    ])
    expect(view.messages).toHaveLength(0)
  })

  it('ignores event types it does not render', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('usage.updated', { inputTokens: 1, outputTokens: 2 }),
    ])
    expect(view.messages).toHaveLength(0)
    expect(view.lastSeq).toBeGreaterThan(0)
  })
})

describe('spend', () => {
  it('starts at nothing, and at no price at all', () => {
    // Zero cost would be a claim; "not reported" is the truth.
    expect(EMPTY_VIEW.spend).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: null })
  })

  it('takes the latest total from an agent rather than adding reports up', () => {
    // Both adapters report a running total, so summing every report would count
    // the same tokens again each time.
    const view = reduceEvents(EMPTY_VIEW, [
      event('usage.updated', { inputTokens: 100, outputTokens: 20 }),
      event('usage.updated', { inputTokens: 150, outputTokens: 25 }),
    ])
    expect(view.spend.inputTokens).toBe(150)
    expect(view.spend.outputTokens).toBe(25)
  })

  it('counts each agent once and adds them together', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      { ...event('usage.updated', { inputTokens: 100, outputTokens: 10 }), actor: 'codex' },
      { ...event('usage.updated', { inputTokens: 40, outputTokens: 4 }), actor: 'claude' },
      { ...event('usage.updated', { inputTokens: 120, outputTokens: 12 }), actor: 'codex' },
    ])
    expect(view.spend.inputTokens).toBe(160)
    expect(view.spend.outputTokens).toBe(16)
  })

  it('prices only from agents that reported one', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      {
        ...event('usage.updated', { inputTokens: 1, outputTokens: 1, costUsd: 0.02 }),
        actor: 'claude',
      },
      { ...event('usage.updated', { inputTokens: 1, outputTokens: 1 }), actor: 'codex' },
    ])
    expect(view.spend.costUsd).toBeCloseTo(0.02)
  })

  it('leaves cost unreported when no agent priced anything', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('usage.updated', { inputTokens: 9, outputTokens: 9 }),
    ])
    expect(view.spend.costUsd).toBeNull()
    expect(view.spend.inputTokens).toBe(9)
  })
})

describe('thinking, combined', () => {
  it('joins a run of reasoning items into one block', () => {
    // The provider's item boundaries are how it streams, not something the
    // reader asked to see: three items used to mean three dots and three
    // toggles.
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.reasoning.delta', { itemRef: 'r1', text: 'first ' }),
      event('agent.reasoning.delta', { itemRef: 'r2', text: 'second ' }),
      event('agent.reasoning.delta', { itemRef: 'r3', text: 'third' }),
    ])
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({
      kind: 'reasoning',
      text: 'first second third',
    })
  })

  it('keeps thinking either side of a reply as two blocks', () => {
    // Joining these would misrepresent the order the agent worked in.
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.reasoning.delta', { itemRef: 'r1', text: 'before' }),
      event('agent.message.delta', { itemRef: 'm1', text: 'partial answer' }),
      event('agent.reasoning.delta', { itemRef: 'r2', text: 'after' }),
    ])
    expect(view.messages.map((m) => m.kind)).toEqual(['reasoning', 'message', 'reasoning'])
    expect(view.messages[0]?.text).toBe('before')
    expect(view.messages[2]?.text).toBe('after')
  })

  it('does not join two agents thinking in the same room', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.reasoning.delta', { itemRef: 'r1', text: 'codex thinks' }, 'codex'),
      event('agent.reasoning.delta', { itemRef: 'r2', text: 'claude thinks' }, 'claude'),
    ])
    expect(view.messages).toHaveLength(2)
    expect(view.messages.map((m) => m.actor)).toEqual(['codex', 'claude'])
  })

  it('survives a replay without doubling the block', () => {
    const events = [
      event('agent.reasoning.delta', { itemRef: 'r1', text: 'a' }),
      event('agent.reasoning.delta', { itemRef: 'r2', text: 'b' }),
    ]
    const once = reduceEvents(EMPTY_VIEW, events)
    const twice = reduceEvents(once, events)
    expect(twice.messages).toHaveLength(1)
    expect(twice.messages[0]?.text).toBe('ab')
  })
})

describe('answersThinking', () => {
  const reasoning = { kind: 'reasoning', actor: 'codex' } as const
  const reply = { kind: 'message', actor: 'codex' } as const

  const message = (m: { kind: string; actor: string }): TranscriptMessage =>
    ({ key: 'k', eventId: 'e', text: 't', status: 'complete', ...m }) as TranscriptMessage

  it('marks a reply that follows the same agent thinking', () => {
    expect(answersThinking(message(reasoning), message(reply))).toBe(true)
  })

  it('marks nothing when no thinking arrived', () => {
    // Every turn both CLIs currently produce. Marking every message would mark
    // nothing, so this is the right answer rather than a degraded one.
    expect(answersThinking(undefined, message(reply))).toBe(false)
    expect(answersThinking(message({ kind: 'message', actor: 'user' }), message(reply))).toBe(false)
  })

  it('does not credit one agent with another agent thinking', () => {
    expect(answersThinking(message({ kind: 'reasoning', actor: 'claude' }), message(reply))).toBe(
      false
    )
  })

  it('never marks the user or the system', () => {
    expect(answersThinking(message(reasoning), message({ kind: 'message', actor: 'user' }))).toBe(
      false
    )
    expect(answersThinking(message(reasoning), message({ kind: 'message', actor: 'system' }))).toBe(
      false
    )
  })

  it('only marks a message, not a command or a notice', () => {
    for (const kind of ['command', 'notice', 'handoff', 'reasoning']) {
      expect(answersThinking(message(reasoning), message({ kind, actor: 'codex' }))).toBe(false)
    }
  })
})

/**
 * Questions were logged, held, and never drawn.
 *
 * The adapter mapped `AskUserQuestion` correctly and the orchestrator held the
 * request open — but nothing in the renderer read the event, so every question
 * an agent asked sat invisible until its deadline passed and the agent was told
 * nobody had answered. These are the smallest checks that would have caught it.
 */
describe('questions', () => {
  const ask = (overrides: Record<string, unknown> = {}): TranscriptEvent =>
    event('userinput.requested', {
      userInputId: 'q1',
      expiresAt: 999,
      request: {
        id: 'q1',
        questions: [
          {
            id: '0',
            header: 'Auth method',
            question: 'Which auth method?',
            options: [
              { label: 'OAuth', description: 'Redirect flow' },
              { label: 'API key', description: 'A header' },
            ],
            multiSelect: false,
            allowOther: true,
            isSecret: false,
          },
        ],
        ...overrides,
      },
    })

  it('surfaces a question set and then clears it', () => {
    let view = reduceEvents(EMPTY_VIEW, [ask()])
    expect(view.questions).toHaveLength(1)
    expect(view.questions[0]).toMatchObject({ userInputId: 'q1', agentId: 'codex' })
    expect(view.questions[0]?.questions[0]).toMatchObject({
      header: 'Auth method',
      question: 'Which auth method?',
      multiSelect: false,
      allowOther: true,
      isSecret: false,
    })
    expect(view.questions[0]?.questions[0]?.options).toHaveLength(2)

    view = reduceEvents(view, [
      event('userinput.answered', {
        userInputId: 'q1',
        outcome: 'answered',
        answeredBy: 'user',
      }),
    ])
    expect(view.questions).toHaveLength(0)
    // Answering is its own evidence; the agent's next words are the result.
    expect(view.messages).toHaveLength(0)
  })

  it('leaves a line when a question runs out of time', () => {
    // The silence this fixes: an unanswered question used to leave no trace at
    // all, so a reply that had quietly assumed something looked like a reply.
    let view = reduceEvents(EMPTY_VIEW, [ask()])
    view = reduceEvents(view, [
      event('userinput.answered', {
        userInputId: 'q1',
        outcome: 'timeout',
        answeredBy: 'system',
      }),
    ])
    expect(view.questions).toHaveLength(0)
    expect(view.messages.at(-1)?.text).toBe('A question went unanswered in time.')
  })

  it('reads no options as free text rather than inventing a choice', () => {
    // Codex says "type something" by sending no options. Offering a synthetic
    // option would produce an answer the provider cannot take back.
    const view = reduceEvents(EMPTY_VIEW, [
      ask({
        questions: [
          {
            id: '0',
            header: 'Token',
            question: 'Paste the token',
            options: null,
            multiSelect: false,
            allowOther: false,
            isSecret: true,
          },
        ],
      }),
    ])
    expect(view.questions[0]?.questions[0]?.options).toEqual([])
    expect(view.questions[0]?.questions[0]?.isSecret).toBe(true)
  })

  it('treats an unreadable secret flag as secret', () => {
    // Fails closed: a credential shown once cannot be unshown by fixing this.
    const view = reduceEvents(EMPTY_VIEW, [
      ask({
        questions: [{ id: '0', header: 'K', question: 'Key?', options: [] }],
      }),
    ])
    expect(view.questions[0]?.questions[0]?.isSecret).toBe(true)
  })

  it('drops a set with nothing answerable in it', () => {
    const view = reduceEvents(EMPTY_VIEW, [ask({ questions: [] })])
    expect(view.questions).toHaveLength(0)
  })
})

/**
 * The card that says what a turn wrote.
 *
 * Every test here folds events the way production does — one `reduceEvents` per
 * push, not one call holding the whole turn — because the state that keeps a
 * card open between events is the part that can be got wrong.
 */
describe('changes card', () => {
  const wrote = (
    files: { path: string; change?: string; added?: number; removed?: number; oldPath?: string }[],
    outcome = 'applied'
  ): TranscriptEvent =>
    event('file.change.completed', {
      itemRef: 'i1',
      outcome,
      files: files.map((f) => ({
        change: 'modified',
        added: 1,
        removed: 0,
        ...f,
      })),
    })

  const card = (view: { messages: readonly TranscriptMessage[] }): TranscriptMessage | undefined =>
    view.messages.find((m) => m.kind === 'changes')

  it('holds one card open across separate reductions', () => {
    // A push can deliver the change, the reply and the turn's end in three
    // calls. Folding them in one proves nothing about the case production hits.
    const a = reduceEvents(EMPTY_VIEW, [wrote([{ path: 'src/a.ts', added: 4, removed: 1 }])])
    const b = reduceEvents(a, [wrote([{ path: 'src/b.ts', added: 2 }])])
    const c = reduceEvents(b, [event('agent.message.completed', { itemRef: 'm1', text: 'done' })])
    const d = reduceEvents(c, [event('turn.completed', { turnRef: 't1', status: 'completed' })])

    expect(d.messages.filter((m) => m.kind === 'changes')).toHaveLength(1)
    expect(card(d)?.changes).toMatchObject([
      { path: 'src/a.ts', added: 4, removed: 1 },
      { path: 'src/b.ts', added: 2 },
    ])
  })

  it('replays to exactly the view the pushes built', () => {
    // The property a card built out of hidden state would fail.
    const events = [
      wrote([{ path: 'src/a.ts', added: 4 }]),
      event('agent.message.completed', { itemRef: 'm1', text: 'done' }),
      wrote([{ path: 'src/b.ts', added: 2 }]),
      event('turn.completed', { turnRef: 't1', status: 'completed' }),
    ]
    const incremental = events.reduce((view, e) => reduceEvents(view, [e]), EMPTY_VIEW)
    const replayed = reduceEvents(EMPTY_VIEW, events)
    expect(replayed).toEqual(incremental)
  })

  it('sits below the reply even when the edits came first', () => {
    // Agents edit before they narrate, so the card is written before the words
    // that explain it. The composition puts it underneath.
    const view = [
      wrote([{ path: 'src/a.ts' }]),
      event('agent.message.completed', { itemRef: 'm1', text: 'I changed a file' }),
    ].reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)

    expect(view.messages.map((m) => m.kind)).toEqual(['message', 'changes'])
  })

  /*
   * The exception `liftChangesAboveFinal` exists for.
   *
   * Mid-turn the card belongs under the words explaining it. After the *last*
   * reply it does not: a receipt printed below the conclusion means the
   * conclusion is not the last thing in the turn, which is the property
   * `data-final` is there to assert.
   */
  it('rises back above the reply once the turn is over', () => {
    const events = [
      event('turn.started', { turnRef: 't1' }),
      wrote([{ path: 'src/a.ts' }]),
      event('agent.message.completed', { itemRef: 'm1', text: 'Done.' }),
    ]
    const midTurn = events.reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)
    expect(midTurn.messages.map((m) => m.kind)).toEqual(['message', 'changes'])

    const ended = reduceEvents(midTurn, [
      event('turn.completed', { turnRef: 't1', status: 'completed' }),
    ])
    expect(ended.messages.map((m) => m.kind)).toEqual(['changes', 'message'])
  })

  /* Narration in the middle of a turn keeps the card underneath it — only the
     last hop is undone, not every one. */
  it('stays under a reply that is not the last one', () => {
    const view = [
      event('turn.started', { turnRef: 't1' }),
      wrote([{ path: 'src/a.ts' }]),
      event('agent.message.completed', { itemRef: 'm1', text: 'Editing now' }),
      event('agent.message.completed', { itemRef: 'm2', text: 'Done.' }),
      event('turn.completed', { turnRef: 't1', status: 'completed' }),
    ].reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)

    // m1, then the card it explains, then the final reply last.
    expect(view.messages.map((m) => m.kind)).toEqual(['message', 'changes', 'message'])
    expect(view.messages.at(-1)?.text).toBe('Done.')
  })

  it('sums a file edited twice in one turn', () => {
    const view = [
      wrote([{ path: 'src/a.ts', added: 3, removed: 1 }]),
      wrote([{ path: 'src/a.ts', added: 2, removed: 4 }]),
    ].reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)

    expect(card(view)?.changes).toMatchObject([{ path: 'src/a.ts', added: 5, removed: 5 }])
  })

  it('starts a second card for a second turn', () => {
    const view = [
      wrote([{ path: 'src/a.ts' }]),
      event('turn.completed', { turnRef: 't1', status: 'completed' }),
      wrote([{ path: 'src/b.ts' }]),
    ].reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)

    expect(view.messages.filter((m) => m.kind === 'changes')).toHaveLength(2)
  })

  it('closes the card on session.ended, which is appended as the system', () => {
    /*
     * `reconcileOrphanedSessions` appends this with `actor: 'system'` and the
     * agent in the payload. Clearing by actor would clear an entry under
     * `system` that never existed, and the agent's card would stay open across
     * a crash recovery and grow into the next session's work.
     */
    // Built inline, in order: `event` stamps an increasing seq, and
    // `reduceEvents` skips anything at or below the last one it saw — so an
    // event hoisted into a `const` above the array is silently dropped.
    const view = [
      wrote([{ path: 'src/a.ts' }]),
      {
        ...event('session.ended', { agentId: 'codex', sessionRef: 's1', reason: 'crashed' }),
        actor: 'system' as const,
      },
      wrote([{ path: 'src/b.ts' }]),
    ].reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)

    expect(view.messages.filter((m) => m.kind === 'changes')).toHaveLength(2)
  })

  it('draws nothing for a patch that never landed', () => {
    const declined = reduceEvents(EMPTY_VIEW, [wrote([{ path: 'src/a.ts' }], 'declined')])
    const failed = reduceEvents(EMPTY_VIEW, [wrote([{ path: 'src/a.ts' }], 'failed')])
    expect(card(declined)).toBeUndefined()
    expect(card(failed)).toBeUndefined()
  })

  it('ignores a proposal, which is not a change', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('file.change.proposed', { itemRef: 'i1', files: [{ path: 'src/a.ts', patch: '' }] }),
    ])
    expect(card(view)).toBeUndefined()
  })

  it('reads a renamed file onto the row it already had', () => {
    const view = [
      wrote([{ path: 'src/was.ts', added: 2 }]),
      wrote([{ path: 'src/is.ts', oldPath: 'src/was.ts', change: 'renamed', added: 1 }]),
    ].reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)

    expect(card(view)?.changes).toMatchObject([
      { path: 'src/is.ts', oldPath: 'src/was.ts', change: 'renamed', added: 3 },
    ])
  })

  it('counts an edit that arrived as a tool result, which is how Claude reports one', () => {
    /*
     * Claude emits no file-change event at all — an edit is a tool result, and
     * the patch on it is the only record of what it did. Both halves of the card
     * come out of different events for that reason.
     */
    const view = [
      event('tool.started', { itemRef: 't1', name: 'Edit' }),
      event('tool.completed', {
        itemRef: 't1',
        status: 'ok',
        patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n',
      }),
    ].reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)

    expect(card(view)?.changes).toMatchObject([
      { path: 'src/a.ts', change: 'modified', added: 2, removed: 1 },
    ])
  })

  it('letters a file Claude created as added, not modified', () => {
    // The mode line adapter-claude now writes is what makes this an `A`; without
    // it a new file is indistinguishable from a rewritten one.
    const view = [
      event('tool.started', { itemRef: 't1', name: 'Write' }),
      event('tool.completed', {
        itemRef: 't1',
        status: 'ok',
        patch:
          'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n',
      }),
    ].reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)

    expect(card(view)?.changes).toMatchObject([{ path: 'src/new.ts', change: 'added', added: 2 }])
  })

  it('does not count a tool call that failed', () => {
    const view = [
      event('tool.started', { itemRef: 't1', name: 'Edit' }),
      event('tool.completed', {
        itemRef: 't1',
        status: 'error',
        patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      }),
    ].reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)

    expect(card(view)).toBeUndefined()
  })

  it('carries each file its own diff', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('file.change.completed', {
        itemRef: 'i1',
        outcome: 'applied',
        files: [
          {
            path: 'src/a.ts',
            change: 'modified',
            added: 1,
            removed: 1,
            patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
          },
        ],
      }),
    ])
    expect(card(view)?.changes?.[0]?.patch).toContain('@@ -1 +1 @@')
  })

  it('shows the latest diff for a file edited twice, and the summed counts', () => {
    /*
     * Counts are what the turn wrote and add up. A patch does not: two hunks
     * from two edits stitched together would describe a file that never existed,
     * so the most recent one is the honest single answer.
     */
    const patchOf = (line: string): string =>
      `diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+${line}\n`
    const view = [
      wrote([{ path: 'src/a.ts', added: 1, removed: 1 }]),
      event('file.change.completed', {
        itemRef: 'i1',
        outcome: 'applied',
        files: [
          { path: 'src/a.ts', change: 'modified', added: 2, removed: 0, patch: patchOf('second') },
        ],
      }),
    ].reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)

    expect(card(view)?.changes?.[0]).toMatchObject({ added: 3, removed: 1 })
    expect(card(view)?.changes?.[0]?.patch).toContain('+second')
  })

  it('gives a Claude edit the tool patch as its own diff', () => {
    const patch = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n'
    const view = [
      event('tool.started', { itemRef: 't1', name: 'Edit' }),
      event('tool.completed', { itemRef: 't1', status: 'ok', patch }),
    ].reduce((v, e) => reduceEvents(v, [e]), EMPTY_VIEW)

    expect(card(view)?.changes?.[0]?.patch).toBe(patch)
  })

  it('leaves a row from an older log without a diff rather than an empty frame', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('file.change.completed', {
        itemRef: 'i1',
        outcome: 'applied',
        files: [{ path: 'src/a.ts', change: 'modified', added: 1, removed: 0 }],
      }),
    ])
    expect(card(view)?.changes?.[0]?.patch).toBeUndefined()
  })

  it('survives a payload from an older build', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('file.change.completed', {
        itemRef: 'i1',
        outcome: 'applied',
        files: [{ path: 'src/a.ts' }, { nothing: true }, 'rubbish'],
      }),
    ])
    expect(card(view)?.changes).toMatchObject([
      { path: 'src/a.ts', change: 'modified', added: 0, removed: 0 },
    ])
  })
})

/**
 * The `Summary` card, lifted out of the reply that carried it.
 *
 * The scanner's own rules are covered in `markdown.test.ts`; these are about the
 * reducer — when it runs, and what it leaves behind in the body.
 */
describe('summary lift', () => {
  it('cuts a trailing summary off a completed message', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.message.completed', {
        itemRef: 'm1',
        text: 'Did the work.\n\n## Summary\n- one\n- two\n',
      }),
    ])
    expect(view.messages[0]?.summary).toEqual(['one', 'two'])
    expect(view.messages[0]?.text).toBe('Did the work.')
  })

  it('leaves a streaming message alone', () => {
    // A card that appeared mid-stream would arrive as the bullets were written
    // and then move as the rest of the reply landed under it.
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.message.delta', { itemRef: 'm1', text: 'Did it.\n\n## Summary\n- one\n' }),
    ])
    expect(view.messages[0]?.status).toBe('streaming')
    expect(view.messages[0]?.summary).toBeUndefined()
    expect(view.messages[0]?.text).toContain('## Summary')
  })

  it('carries no summary field when a reply has none', () => {
    // Absent, not empty: an empty card and no card are different things.
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.message.completed', { itemRef: 'm1', text: 'Just an answer.' }),
    ])
    expect(view.messages[0]?.summary).toBeUndefined()
    expect(view.messages[0]?.text).toBe('Just an answer.')
  })

  it('does not lift an example out of a fenced block', () => {
    const said = 'Write it like this:\n\n```md\n## Summary\n- one\n```\n'
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.message.completed', { itemRef: 'm1', text: said }),
    ])
    expect(view.messages[0]?.summary).toBeUndefined()
    expect(view.messages[0]?.text).toBe(said)
  })
})

/**
 * When a row says it happened.
 *
 * The row shows when it *began*. Completion rebuilds the message from scratch,
 * so the only thing keeping the opening time is this carry — and a test that
 * only asserts "a time is present" passes with it removed, which is why each of
 * these asserts the specific event's `createdAt`.
 */
describe('message times', () => {
  it('keeps the first delta time through completion', () => {
    const opened = event('agent.message.delta', { itemRef: 'm1', text: 'Hel' })
    const view = reduceEvents(EMPTY_VIEW, [
      opened,
      event('agent.message.delta', { itemRef: 'm1', text: 'lo' }),
      event('agent.message.completed', { itemRef: 'm1', text: 'Hello' }),
    ])
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]?.status).toBe('complete')
    expect(view.messages[0]?.at).toBe(opened.createdAt)
  })

  it('carries the opening time across separate reductions', () => {
    // Production folds each push into the previous view; a carry that only works
    // inside one call is not a carry.
    const opened = event('agent.message.delta', { itemRef: 'm1', text: 'Hi' })
    const streaming = reduceEvents(EMPTY_VIEW, [opened])
    const done = reduceEvents(streaming, [
      event('agent.message.completed', { itemRef: 'm1', text: 'Hi there' }),
    ])
    expect(done.messages[0]?.at).toBe(opened.createdAt)
  })

  it('takes its own time when a message completes without streaming', () => {
    const done = event('agent.message.completed', { itemRef: 'm1', text: 'Short' })
    const view = reduceEvents(EMPTY_VIEW, [done])
    expect(view.messages[0]?.at).toBe(done.createdAt)
  })

  it('keeps the opening time of a run of reasoning', () => {
    const opened = event('agent.reasoning.delta', { text: 'first' })
    const view = reduceEvents(EMPTY_VIEW, [
      opened,
      event('agent.reasoning.delta', { text: ' second' }),
    ])
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]?.at).toBe(opened.createdAt)
  })

  it('stamps a user message with its own time', () => {
    const said = event('user.message', { text: 'hi' }, 'user')
    const view = reduceEvents(EMPTY_VIEW, [said])
    expect(view.messages[0]?.at).toBe(said.createdAt)
  })

  it('leaves a run of reasoning streaming forever, which is what the dot must not follow', () => {
    /*
     * Nothing completes a reasoning row — no case sets it to `complete`. A
     * pulse bound to `status` alone would therefore pulse on every block of
     * thinking in the conversation, for the life of the session. `Entry` scopes
     * the pulse to `kind === 'message'`, and this is the fact that makes that
     * necessary rather than defensive.
     */
    const view = reduceEvents(EMPTY_VIEW, [
      event('agent.reasoning.delta', { text: 'thinking' }),
      event('agent.message.completed', { itemRef: 'm1', text: 'answer' }),
    ])
    expect(view.messages[0]?.kind).toBe('reasoning')
    expect(view.messages[0]?.status).toBe('streaming')
  })
})

/**
 * A run of one agent's work reads as one block.
 *
 * Eleven rows each captioned "Claude" is what a long turn actually looked like:
 * a command, a tool call, a notice, another command — every one repeating a name
 * that had not changed, with a rule drawn between them.
 */
describe('groupedWith', () => {
  const row = (over: Partial<TranscriptMessage>): TranscriptMessage => ({
    key: 'k',
    eventId: 'e',
    at: 0,
    actor: 'claude',
    kind: 'tool',
    text: '',
    status: 'complete',
    ...over,
  })

  it('groups a step under the same speaker', () => {
    expect(groupedWith(row({ kind: 'command' }), row({ kind: 'tool' }))).toBe(true)
  })

  it('does not group across speakers', () => {
    expect(groupedWith(row({ actor: 'codex' }), row({ actor: 'claude' }))).toBe(false)
    // A system notice between two of an agent's own rows breaks the run, which
    // is right: something else spoke.
    expect(groupedWith(row({ actor: 'system', kind: 'notice' }), row({}))).toBe(false)
  })

  it('never groups a message, however many rows precede it', () => {
    /*
     * The avatar, the name and the time *are* the message row, and the time is
     * the one thing in it that cannot be recovered from the row above.
     */
    expect(groupedWith(row({ kind: 'tool' }), row({ kind: 'message' }))).toBe(false)
    expect(groupedWith(row({ kind: 'message' }), row({ kind: 'message' }))).toBe(false)
  })

  it('never groups a handoff, which is a seam by definition', () => {
    expect(groupedWith(row({}), row({ kind: 'handoff' }))).toBe(false)
  })

  it('leaves the first row of a transcript alone', () => {
    expect(groupedWith(undefined, row({}))).toBe(false)
  })
})
