import {
  toEpochMs,
  type AgentActivity,
  type AgentEvent,
  type ApprovalRequest,
  type BackgroundTask,
  type NoticeSource,
  type UsageWindow,
  type UserInputRequest,
  type UserInputResponse,
} from '@chorus/agent-protocol'
import type { AgentId, ApprovalId, UserInputId } from '@chorus/shared'

/**
 * Claude `SDKMessage` → the normalized `AgentEvent` union.
 *
 * Every shape here was read out of `sdk.d.ts@0.3.220`, not out of prose docs.
 * That distinction cost three bugs in M2, all in the places where a param shape
 * had been inferred rather than checked.
 *
 * Pure, so it can be exercised by replaying recorded messages with no process.
 */

const AGENT: AgentId = 'claude'

export interface MapContext {
  readonly seq: number
  readonly now: number
  readonly approvalTtlMs: number
  /**
   * The id from the current `message_start`.
   *
   * Every `stream_event` carries its *own* `uuid`, so keying deltas on that
   * gives each chunk a unique item and the transcript renders one message per
   * token. The block id has to come from the enclosing message instead — which
   * is also what lets the final `assistant` message replace the streamed
   * fragments rather than appending a duplicate.
   */
  readonly streamMessageRef?: string | null
  /**
   * `tool_use` ids known to be Bash calls, so their results can be reported as
   * command output rather than as an anonymous tool result.
   */
  readonly bashToolIds?: ReadonlySet<string>
  /**
   * The session's running totals, so usage reads the same as Codex's.
   *
   * Optional because `mapToolPermission` shares this context and a permission
   * request has no usage to accumulate.
   */
  readonly usageSoFar?: { inputTokens: number; outputTokens: number }
}

/** Structurally what we need, without importing the SDK's full message union. */
interface SdkMessageLike {
  type: string
  subtype?: string
  /**
   * Set only on `SDKUserMessageReplay`, and the one field that tells it from a
   * live user message — every other property is identical.
   */
  isReplay?: boolean
  session_id?: string
  message?: { id?: string; content?: unknown[] }
  event?: {
    type?: string
    delta?: { type?: string; text?: string; thinking?: string }
    index?: number
    message?: { id?: string }
  }
  parent_tool_use_id?: string | null
  /**
   * The tool's full Output object, keyed by the matching `tool_use` block's
   * name. `unknown` in `sdk.d.ts` because the shape is per-tool, and left
   * `unknown` here so `readPatch` has to check rather than trust it.
   */
  tool_use_result?: unknown
  uuid?: string
  claude_code_version?: string
  model?: string
  mcp_servers?: { name: string; status: string }[]
  is_error?: boolean
  result?: string
  usage?: { input_tokens?: number; output_tokens?: number }
  total_cost_usd?: number
  errors?: string[]
  rate_limit_info?: {
    /** The flat shape the SDK really sends. */
    rateLimitType?: string
    utilization?: number
    resetsAt?: number
    /** The nested shape the types describe, kept in case it ever arrives. */
    rate_limits?: Record<
      string,
      { utilization?: number | null; resets_at?: string | number | null } | null
    >
  }
}

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

/**
 * Returns the events one SDK message produces. Unlike Codex, a single Claude
 * message can yield several — an assistant message may carry both text and a
 * tool_use block — so this returns an array rather than one event or null.
 */
export function mapSdkMessage(msg: SdkMessageLike, ctx: MapContext): AgentEvent[] {
  const base = { agentId: AGENT, at: ctx.now, raw: msg } as const
  const at = (i: number) => ({ ...base, seq: ctx.seq + i })

  switch (msg.type) {
    case 'system':
      return mapSystem(msg, at(0))

    case 'stream_event':
      return mapStreamEvent(msg, at(0), ctx.streamMessageRef ?? null)

    case 'assistant':
      return mapAssistant(msg, base, ctx)

    case 'user':
      /*
       * Tool results come back as a user message. Dropping them left every
       * Claude command hanging in the transcript with no result, and left the
       * other agent nothing to read when asked why something failed.
       *
       * A replay is the same shape and must not be mapped. Resuming a session
       * re-sends its history, so without this a reopened conversation appends a
       * second copy of every command and tool call it already contains — the
       * log is ours and already holds them.
       */
      return msg.isReplay === true ? [] : mapToolResults(msg, base, ctx)

    case 'rate_limit_event':
      return mapRateLimits(msg, at(0))

    case 'result':
      return mapResult(msg, ctx)

    default:
      /*
       * Anything the SDK grows that we have not mapped becomes a notice rather
       * than nothing.
       *
       * This used to `return []` with a comment calling the silence a decision.
       * It was, while Chorus only had to show a finished diff — but a window
       * that is the *only* view of an agent cannot answer "what is it doing"
       * with a shrug, and every unmapped type is something the CLI would have
       * printed.
       */
      return [notice(at(0), { level: 'info', source: 'system', text: msg.type })]
  }
}

/**
 * Fields the `system` subtypes carry, read out of `sdk.d.ts@0.3.220`.
 *
 * Separate from `SdkMessageLike` and reached through a cast because
 * `permission_denied.message` is a string while `assistant.message` is an
 * object — one name, two shapes, and only one of them can be declared per
 * interface.
 */
interface SystemFields {
  subtype?: string
  hook_name?: string
  hook_event?: string
  output?: string
  stdout?: string
  stderr?: string
  outcome?: string
  content?: string
  level?: string
  tool_name?: string
  decision_reason?: string
  message?: unknown
  attempt?: number
  max_retries?: number
  error_status?: number | null
  prevent_continuation?: boolean
  task_id?: string
  tool_use_id?: string
  description?: string
  subagent_type?: string
  workflow_name?: string
  last_tool_name?: string
  summary?: string
  status?: string
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
  skip_transcript?: boolean
  /** `background_tasks_changed` only: the whole live set, replacing the last. */
  tasks?: { task_id?: string; task_type?: string; description?: string }[]
}

/**
 * Subtypes that arrive on a timer rather than when something happens.
 *
 * The catch-all below writes a durable event for anything it does not
 * recognise, and `status` is the spinner's heartbeat — left in, it would append
 * to SQLite for as long as a turn runs. Telemetry is the one thing silence is
 * still right for, so the exemption is an explicit short list rather than a
 * default. `compact_boundary` is here because the `PostCompact` hook already
 * turns it into `context.compacted`; mapping it twice would double the row.
 */
const QUIET_SUBTYPES: ReadonlySet<string> = new Set([
  /*
   * These three are quiet **in the log** and are no longer thrown away.
   *
   * They are what the agent says it is doing — `requesting`, `compacting`, a
   * thinking-token tick, `running`/`idle`/`requires_action` — and dropping them
   * outright left the UI with nothing to say during the long stretches a turn
   * spends between rows. They now become `activity.changed`, which is state and
   * never reaches SQLite, so the reason they are listed here is untouched: the
   * catch-all below would have written a durable row for every heartbeat.
   */
  'status',
  'thinking_tokens',
  'session_state_changed',
  'control_request_progress',
  'compact_boundary',
  /*
   * `task_updated` is a patch keyed on `task_id` alone — it carries no
   * `tool_use_id`, so there is nothing to correlate it with when the task began
   * life as a `Task` tool call. `task_notification` reports the same ending and
   * does carry one, so nothing is lost by staying quiet here rather than
   * risking a row attached to the wrong id.
   */
  'task_updated',
  /*
   * Now that `includeHookEvents` is on, these two arrive for every hook on
   * every matching tool call. Neither carries an outcome — a start is not news,
   * and progress is a hook still running. `hook_response` is the one that says
   * what happened, and it is handled below.
   */
  'hook_started',
  'hook_progress',
])

/**
 * The activity a `system` subtype reports, or `undefined` when it reports none.
 *
 * `undefined` and `null` are different answers and the difference matters:
 * `undefined` means this message says nothing about activity, so whatever was
 * showing stands; `null` means the agent has explicitly stopped doing the thing
 * it named, and the word must go.
 *
 * `requires_action` is the only state read off `session_state_changed`.
 * `running` and `idle` are turn boundaries, and those belong to the log —
 * `turn.started` and `turn.completed` — where they can be replayed. A second,
 * unlogged opinion about whether a turn is open is how the two would drift.
 */
function activityOf(
  subtype: string,
  msg: Record<string, unknown>
): AgentActivity | null | undefined {
  if (subtype === 'status') {
    const status = msg['status']
    if (status === 'compacting' || status === 'requesting') return status
    // Explicitly null on the wire when the phase ends, which is what clears it.
    return null
  }
  if (subtype === 'thinking_tokens') return 'thinking'
  if (subtype === 'session_state_changed') {
    return msg['state'] === 'requires_action' ? 'awaitingInput' : undefined
  }
  return undefined
}

function notice(
  base: Omit<AgentEvent, 'type'> & { seq: number },
  fields: { level: 'info' | 'warn' | 'error'; source: NoticeSource; text: string; detail?: string }
): AgentEvent {
  return {
    ...base,
    type: 'notice',
    level: fields.level,
    source: fields.source,
    text: fields.text,
    ...(fields.detail === undefined || fields.detail === '' ? {} : { detail: fields.detail }),
  }
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function mapSystem(
  msg: SdkMessageLike,
  base: Omit<AgentEvent, 'type'> & { seq: number }
): AgentEvent[] {
  const subtype = msg.subtype ?? ''

  /*
   * `init` describes the **session**, not a turn, and reading it as one was a
   * bug rather than a simplification.
   *
   * Its own fields say so — cwd, model, tools, MCP servers, slash commands,
   * skills, plugins, the CLI version — and `sdk.d.ts` is where that was finally
   * read rather than assumed. The adapter runs one long-lived `query()` in
   * streaming-input mode, so this frame arrives once while `result` closes every
   * turn: one start, many completions. From the second turn on, everything that
   * folds the pair believed the agent was idle — no working line, no Stop
   * button, no sidebar mark — which is what was reported as "silent periods with
   * no working indicator at all".
   *
   * `ClaudeSession.send` raises the start now, once per turn, because that is
   * the moment a turn begins and it depends on no frame ordering. Nothing is
   * lost here: no consumer reads anything else off `init`.
   */
  if (subtype === 'init') return []

  /*
   * What the agent says it is doing, read before the quiet list swallows it.
   *
   * Three messages, one output. `status` carries the provider's own two words;
   * `session_state_changed` is documented in `sdk.d.ts` as the authoritative
   * turn-over signal and is read here only for `requires_action`, because the
   * turn boundaries are the log's and this must not become a second opinion
   * about them; `thinking_tokens` is a token count that means one thing to a
   * person waiting — it is thinking.
   *
   * `null` is emitted rather than nothing, so a finished compaction clears the
   * word instead of leaving it standing. The shapes come from `sdk.d.ts`
   * (`SDKStatusMessage`, `SDKSessionStateChangedMessage`), not from memory.
   */
  const activity = activityOf(subtype, msg as unknown as Record<string, unknown>)
  if (activity !== undefined) return [{ ...base, type: 'activity.changed', activity }]
  if (QUIET_SUBTYPES.has(subtype)) return []

  const s = msg as unknown as SystemFields

  switch (subtype) {
    case 'hook_response': {
      /*
       * Only when it has something to say.
       *
       * A hook fires per matching tool call, and a repo with a dozen of them
       * would otherwise put a dozen rows between a command and its output for
       * every command. A hook that succeeded silently did not affect the turn;
       * one that failed, was cancelled, or printed something did.
       */
      const detail = firstNonEmpty(s.output, s.stderr, s.stdout)
      const failed = s.outcome === 'error' || s.outcome === 'cancelled'
      if (!failed && detail === undefined) return []
      const name = firstNonEmpty(s.hook_name) ?? ''
      const event = firstNonEmpty(s.hook_event)
      return [
        notice(base, {
          level: failed ? 'warn' : 'info',
          source: 'hook',
          text: event === undefined ? name : `${name} · ${event}`,
          ...(detail === undefined ? {} : { detail }),
        }),
      ]
    }

    case 'permission_denied': {
      const why = firstNonEmpty(
        s.decision_reason,
        typeof s.message === 'string' ? s.message : undefined
      )
      return [
        notice(base, {
          level: 'warn',
          source: 'denial',
          text: firstNonEmpty(s.tool_name) ?? '',
          ...(why === undefined ? {} : { detail: why }),
        }),
      ]
    }

    case 'api_retry':
      /*
       * A retry storm and a hung process look identical from outside, and the
       * second is the one worth acting on. Counting the attempt is what tells
       * them apart, so the text is `2/5` and never a sentence — the renderer
       * owns the word in front of it.
       */
      return [
        notice(base, {
          level: 'warn',
          source: 'retry',
          text: `${String(s.attempt ?? 0)}/${String(s.max_retries ?? 0)}`,
          ...(typeof s.error_status === 'number'
            ? { detail: `HTTP ${String(s.error_status)}` }
            : {}),
        }),
      ]

    case 'local_command_output': {
      // Output from a slash command. The SDK says to render it as assistant
      // text; a notice is where it goes until there is a better home for it.
      const content = firstNonEmpty(s.content)
      return content === undefined
        ? []
        : [notice(base, { level: 'info', source: 'command', text: content })]
    }

    case 'informational': {
      const content = firstNonEmpty(s.content)
      if (content === undefined) return []
      // `prevent_continuation` means the loop stops here — a Stop hook denying
      // continuation is the case that matters, and it is not merely a banner.
      const level =
        s.prevent_continuation === true ? 'error' : s.level === 'warning' ? 'warn' : 'info'
      return [notice(base, { level, source: 'system', text: content })]
    }

    /*
     * A subagent, reported against the tool call that spawned it.
     *
     * `tool_use_id` is what ties this to the `Task` row `mapAssistant` already
     * produced, so the reducer merges rather than doubling. Workflow tasks
     * arrive with no `tool_use_id` and fall back to `task_id`, which gives them
     * a row of their own — correct, since no tool call preceded them.
     *
     * `skip_transcript` is the SDK asking us not to show housekeeping tasks
     * inline, and it is honoured: ignoring it is how a transcript fills with
     * work nobody asked about.
     */
    case 'task_started': {
      if (s.skip_transcript === true) return []
      const ref = firstNonEmpty(s.tool_use_id, s.task_id)
      if (ref === undefined) return []
      const detail = firstNonEmpty(s.description)
      return [
        {
          ...base,
          type: 'tool.started',
          itemRef: ref,
          name: firstNonEmpty(s.subagent_type, s.workflow_name) ?? 'Task',
          ...(detail === undefined ? {} : { detail }),
        },
      ]
    }

    case 'task_progress': {
      const ref = firstNonEmpty(s.tool_use_id, s.task_id)
      if (ref === undefined) return []
      // `last_tool_name` is the most useful thing a running subagent can say:
      // it is the difference between "working" and "working on what".
      const note = firstNonEmpty(s.last_tool_name, s.summary, s.description)
      const elapsed = s.usage?.duration_ms
      return [
        {
          ...base,
          type: 'tool.progress',
          itemRef: ref,
          ...(note === undefined ? {} : { note }),
          ...(typeof elapsed === 'number' ? { elapsedMs: elapsed } : {}),
        },
      ]
    }

    /*
     * A snapshot of what is still running, taken straight to the push channel.
     *
     * Never a log row: the payload is documented as "every live background task
     * after the change. REPLACE semantics", which makes it state in the same
     * family as `limits` and `context.usage`. Before this it fell to the default
     * arm and became a durable notice whose entire text was the string
     * `background_tasks_changed`.
     *
     * An empty list is emitted rather than dropped, because "nothing is running
     * any more" is exactly the update that clears the indicator — and under
     * replace semantics it is the only thing that can.
     */
    case 'background_tasks_changed':
      return [
        {
          ...base,
          type: 'tasks.changed',
          tasks: (Array.isArray(s.tasks) ? s.tasks : []).flatMap((entry): BackgroundTask[] => {
            const row = entry as { task_id?: unknown; task_type?: unknown; description?: unknown }
            if (typeof row.task_id !== 'string' || row.task_id === '') return []
            return [
              {
                id: row.task_id,
                kind: typeof row.task_type === 'string' ? row.task_type : 'task',
                description: typeof row.description === 'string' ? row.description : '',
              },
            ]
          }),
        },
      ]

    case 'task_notification': {
      if (s.skip_transcript === true) return []
      const ref = firstNonEmpty(s.tool_use_id, s.task_id)
      if (ref === undefined) return []
      const summary = firstNonEmpty(s.summary)
      return [
        {
          ...base,
          type: 'tool.completed',
          itemRef: ref,
          status: s.status === 'completed' ? 'ok' : 'error',
          ...(summary === undefined ? {} : { summary }),
        },
      ]
    }

    case 'model_refusal_fallback':
    case 'model_refusal_no_fallback':
      return [
        notice(base, {
          level: subtype === 'model_refusal_no_fallback' ? 'error' : 'warn',
          source: 'system',
          text: subtype,
        }),
      ]

    default:
      return [notice(base, { level: 'info', source: 'system', text: subtype })]
  }
}

function mapStreamEvent(
  msg: SdkMessageLike,
  base: Omit<AgentEvent, 'type'> & { seq: number },
  messageRef: string | null
): AgentEvent[] {
  const delta = msg.event?.delta
  if (delta === undefined) return []

  // Keyed on the enclosing message, never on `msg.uuid` — every stream_event
  // has its own uuid, so that would give each token its own message row.
  const itemRef = messageRef ?? msg.session_id ?? 'stream'

  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
    return [{ ...base, type: 'message.delta', itemRef, text: delta.text }]
  }
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return [{ ...base, type: 'reasoning.delta', itemRef, text: delta.thinking }]
  }
  return []
}

/** Reads the message id out of a `message_start`, so deltas can be attributed. */
export function trackStreamMessage(msg: SdkMessageLike, current: string | null): string | null {
  if (msg.type !== 'stream_event') return current
  if (msg.event?.type === 'message_start') return msg.event.message?.id ?? current
  return current
}

function mapAssistant(
  msg: SdkMessageLike,
  base: { agentId: AgentId; at: number; raw: unknown },
  ctx: MapContext
): AgentEvent[] {
  const blocks = (msg.message?.content ?? []) as ContentBlock[]
  const events: AgentEvent[] = []

  /*
   * All text blocks of one message become ONE completed event, keyed on the
   * message id alone.
   *
   * Indexing by block was wrong in a way only a live run exposed: the stream's
   * `event.index` counts every content block including thinking, while the
   * final message's array often omits them — so a reply preceded by thinking
   * streamed as `msg:1` and completed as `msg:0`, and the transcript showed the
   * same answer twice. Keying on the message removes the whole class of
   * misalignment, and joining the text is what a reader wants anyway.
   */
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('')

  if (text !== '') {
    events.push({
      ...base,
      seq: ctx.seq,
      type: 'message.completed',
      itemRef: msg.message?.id ?? msg.uuid ?? '',
      text,
    })
  }

  for (const block of blocks) {
    if (block.type !== 'tool_use') continue

    if (block.name === 'Bash') {
      const command = block.input?.['command']
      events.push({
        ...base,
        seq: ctx.seq + events.length,
        type: 'command.started',
        itemRef: block.id ?? '',
        command: typeof command === 'string' ? [command] : [],
        cwd: '',
      })
      continue
    }

    /*
     * Every other tool, which used to produce nothing at all.
     *
     * A turn that read six files and ran two searches showed as a pause, and
     * the only honest answer to "what is it doing" was that we had thrown the
     * answer away one line earlier.
     *
     * `AskUserQuestion` is the exception: it already has a surface of its own,
     * and a second row for it would put a tool call next to the question it
     * *is*. The id guard is for the store, which requires a non-empty itemRef.
     */
    if (block.name === undefined || block.name === USER_INPUT_TOOL) continue
    if (block.id === undefined || block.id === '') continue

    const described = describeToolInput(block.input ?? {})
    events.push({
      ...base,
      seq: ctx.seq + events.length,
      type: 'tool.started',
      itemRef: block.id,
      name: block.name,
      ...(typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id !== ''
        ? { parentRef: msg.parent_tool_use_id }
        : {}),
      ...(described?.detail === undefined ? {} : { detail: described.detail }),
      /*
       * Only when the line really is a path, and untruncated.
       *
       * `detail` is a display string: it may be a regex, a URL or a subagent's
       * brief, and it is cut to `MAX_TOOL_DETAIL` before it is stored. A row you
       * can click to open a file needs the path as data, and needs to know that
       * the row names one at all — clicking a grep pattern should do nothing.
       */
      ...(described?.path === undefined ? {} : { path: described.path }),
    })
  }

  return events
}

/** How long a one-line subject may be before it stops being one. */
const MAX_TOOL_DETAIL = 120

/**
 * The one field of a tool's input worth putting next to its name.
 *
 * Ordered by how much it identifies the call: a subagent's brief beats the file
 * it happens to name, and a pattern beats a path for a search. Anything not
 * listed shows as the bare tool name, which is still infinitely more than the
 * nothing this replaced.
 */
function describeToolInput(
  input: Record<string, unknown>
): { detail: string; path?: string } | undefined {
  /*
   * `TodoWrite` first, because its input has no string field at all.
   *
   * Every key below is a string, and a todo write carries one array named
   * `todos` — so it matched nothing and rendered as a bare tool name. In a
   * window that is the only view of an agent that is the wrong row to leave
   * blank: what the agent has decided to do next is the most useful line the
   * CLI prints, and Chorus was printing "TodoWrite".
   *
   * The one in progress, because a checklist has exactly one answer to "what is
   * it doing"; the first outstanding item when nothing is marked yet. This does
   * commit to a private tool schema, which is why every step of it is guarded
   * and the fallback is the bare name it already showed — a schema change costs
   * a line of detail, not a broken row.
   */
  // A checklist names no file, so it carries a line and nothing to open.
  const todo = describeTodos(input['todos'])
  if (todo !== undefined) return { detail: todo }

  for (const key of [
    // First, because when a tool has one it *is* the request: `ExitPlanMode`
    // carries the whole plan here and nothing else worth showing.
    'plan',
    'description',
    'pattern',
    'file_path',
    'notebook_path',
    'path',
    'query',
    'url',
    'prompt',
  ]) {
    const value = input[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    const text = value.trim().replace(/\s+/g, ' ')
    return {
      detail: text.length > MAX_TOOL_DETAIL ? `${text.slice(0, MAX_TOOL_DETAIL - 1)}…` : text,
      /*
       * The path travels beside the line, whole, and only from a key that is
       * one. `pattern` beats `path` for a search, so the row reads as the search
       * it is — and then `path` here would open the directory it searched, which
       * is not what the row says. Whichever key won is the one that decides.
       */
      ...(PATH_KEYS.has(key) ? { path: value.trim() } : {}),
    }
  }
  return undefined
}

/** Input keys that name a file, as opposed to describing the call. */
const PATH_KEYS: ReadonlySet<string> = new Set(['file_path', 'notebook_path', 'path'])

/**
 * What a todo list is currently on, as one line.
 *
 * `activeForm` before `content` because the tool carries both and the first is
 * written to be read while it happens — "Fixing the parser" rather than "Fix
 * the parser". Counting the rest so the line says how much is left without
 * becoming the list itself.
 */
function describeTodos(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined

  const rows = value.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null
  )
  if (rows.length === 0) return undefined

  const text = (row: Record<string, unknown> | undefined): string | undefined => {
    for (const key of ['activeForm', 'content']) {
      const found = row?.[key]
      if (typeof found === 'string' && found.trim() !== '') return found.trim().replace(/\s+/g, ' ')
    }
    return undefined
  }

  const current =
    text(rows.find((row) => row['status'] === 'in_progress')) ??
    text(rows.find((row) => row['status'] !== 'completed'))
  if (current === undefined) return undefined

  const done = rows.filter((row) => row['status'] === 'completed').length
  const line = `${current} · ${String(done)}/${String(rows.length)}`
  return line.length > MAX_TOOL_DETAIL ? `${line.slice(0, MAX_TOOL_DETAIL - 1)}…` : line
}

/**
 * `tool_result` blocks → `command.*` for Bash, `tool.completed` for the rest.
 *
 * Bash keeps the richer treatment because its output is the point. Every other
 * tool's result is the agent's own working — the agent narrates what it found —
 * so what the transcript needs is that the call ended and whether it failed,
 * which is what stops a row spinning forever.
 *
 * Claude reports success or failure, never an exit code, so `is_error` becomes 1
 * and anything else 0. The number is not real, but "did it fail" is, and that is
 * the question the transcript has to be able to answer.
 */
function mapToolResults(
  msg: SdkMessageLike,
  base: { agentId: AgentId; at: number; raw: unknown },
  ctx: MapContext
): AgentEvent[] {
  const known = ctx.bashToolIds ?? new Set<string>()
  const events: AgentEvent[] = []
  const blocks = (msg.message?.content ?? []) as ContentBlock[]

  /*
   * `tool_use_result` is one field on the message, so attaching it is only
   * unambiguous while the message carries one result.
   *
   * It always has: the SDK splits an assistant turn into one message per content
   * block, so even tool calls the model issued in parallel — same `message.id` —
   * come back as separate user messages with a single `tool_result` each. That
   * was measured rather than assumed. This guard is what makes it a checked
   * invariant instead of a bet, and if a future SDK batches results the diff
   * quietly stops appearing rather than landing under the wrong file.
   */
  const patch =
    blocks.filter((b) => b.type === 'tool_result').length === 1
      ? readPatch(msg.tool_use_result)
      : undefined

  for (const block of blocks) {
    const ref = block.tool_use_id
    if (block.type !== 'tool_result' || ref === undefined || ref === '') continue

    const text = readResultText(block.content)

    if (!known.has(ref)) {
      const summary = firstNonEmpty(text.split('\n')[0])
      const failed = block.is_error === true
      events.push({
        ...base,
        seq: ctx.seq + events.length,
        type: 'tool.completed',
        itemRef: ref,
        status: failed ? 'error' : 'ok',
        ...(summary === undefined
          ? {}
          : {
              summary:
                summary.length > MAX_TOOL_DETAIL
                  ? `${summary.slice(0, MAX_TOOL_DETAIL - 1)}…`
                  : summary,
            }),
        // A failed edit changed nothing, so a diff of it would be fiction.
        ...(patch === undefined || failed ? {} : patch),
      })
      continue
    }

    if (text !== '') {
      events.push({
        ...base,
        seq: ctx.seq + events.length,
        type: 'command.output',
        itemRef: ref,
        stream: block.is_error === true ? 'stderr' : 'stdout',
        chunk: text,
      })
    }
    events.push({
      ...base,
      seq: ctx.seq + events.length,
      type: 'command.completed',
      itemRef: ref,
      exitCode: block.is_error === true ? 1 : 0,
    })
  }
  return events
}

/**
 * How much of a created file's body is worth writing down.
 *
 * Only the synthesized path is capped. An `Edit`'s hunks are already bounded by
 * the change plus three lines of context, however large the file — measured, not
 * assumed — so they are stored and rendered whole.
 *
 * This was 40, and 40 was wrong: driven in the real app, a 40-line block filled
 * the transcript pane and scrolled its own `Write …/big.ts` row off the top, so
 * the diff lost the one thing that said which file it belonged to. Enough to
 * recognise a file beats enough to read it — what you are usually checking about
 * a new file is that it appeared and roughly what it is, and the omitted count
 * carries the rest honestly.
 */
const MAX_CREATE_PATCH_LINES = 12

interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/**
 * `structuredPatch` → unified diff text.
 *
 * `parseDiff` needs only the `diff --git` line and `@@` headers; it ignores
 * `index`, `---` and `+++`, and `lines` already carry their `+`/`-`/` ` prefix.
 * An absolute path makes the header read `a//tmp/x`, which looks odd and parses
 * correctly — `FILE_HEADER` captures everything after `a/`.
 */
function toUnifiedDiff(
  filePath: string,
  hunks: readonly PatchHunk[],
  /**
   * A created file has to *say* it was created.
   *
   * Without the mode line a new file is a diff whose every line is an addition,
   * which is indistinguishable from rewriting an existing one — so anything
   * deriving a status letter from the patch reads `M` where the file is new.
   * `/dev/null` on the old side is the other half of the convention, and both
   * are what `git` itself writes.
   */
  created = false
): string {
  const out: string[] = [`diff --git a/${filePath} b/${filePath}`]
  if (created) {
    out.push('new file mode 100644', '--- /dev/null', `+++ b/${filePath}`)
  }
  for (const h of hunks) {
    out.push(
      `@@ -${String(h.oldStart)},${String(h.oldLines)} ` +
        `+${String(h.newStart)},${String(h.newLines)} @@`
    )
    out.push(...h.lines)
  }
  return `${out.join('\n')}\n`
}

function isPatchHunk(value: unknown): value is PatchHunk {
  if (typeof value !== 'object' || value === null) return false
  const h = value as Record<string, unknown>
  return (
    typeof h['oldStart'] === 'number' &&
    typeof h['oldLines'] === 'number' &&
    typeof h['newStart'] === 'number' &&
    typeof h['newLines'] === 'number' &&
    Array.isArray(h['lines']) &&
    h['lines'].every((l) => typeof l === 'string')
  )
}

/**
 * The diff a file-mutating tool produced, read off `tool_use_result`.
 *
 * `tool_use_result` is the tool's full Output object and the SDK's own types say
 * to render from it rather than parse the result text — which is what the
 * `summary` above does, capped at 120 characters.
 *
 * The shape is `unknown` by design (it is per-tool), so every field is checked
 * rather than trusted. A tool we do not recognise, or an SDK that moves the
 * field, yields `undefined` and the row keeps today's behaviour.
 *
 * Creating a file is the one case with no diff to read: `structuredPatch` comes
 * back empty and the text exists only in `content`, so an all-added hunk is
 * synthesized here — the only patch in this file we author rather than relay,
 * and the only one that needs a cap.
 */
function readPatch(result: unknown): { patch: string; omittedLines?: number } | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const r = result as Record<string, unknown>

  const filePath = r['filePath']
  const hunks = r['structuredPatch']
  if (typeof filePath !== 'string' || filePath === '' || !Array.isArray(hunks)) return undefined

  if (hunks.length > 0) {
    if (!hunks.every(isPatchHunk)) return undefined
    return { patch: toUnifiedDiff(filePath, hunks) }
  }

  // No hunks and a `create` with body text: a new file.
  const content = r['content']
  if (r['type'] !== 'create' || typeof content !== 'string' || content === '') return undefined

  const all = content.split('\n')
  // A trailing newline yields a final empty element that is not a line.
  if (all.at(-1) === '') all.pop()
  const shown = all.slice(0, MAX_CREATE_PATCH_LINES)
  const omitted = all.length - shown.length

  return {
    patch: toUnifiedDiff(
      filePath,
      [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: shown.length,
          lines: shown.map((l) => `+${l}`),
        },
      ],
      true
    ),
    ...(omitted > 0 ? { omittedLines: omitted } : {}),
  }
}

/** `content` is a string on the simple path and blocks on the rich one. */
function readResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && 'text' in part
        ? ((part as { text?: unknown }).text ?? '')
        : ''
    )
    .filter((part): part is string => typeof part === 'string')
    .join('')
}

/**
 * Remembers which `tool_use` ids were Bash calls.
 *
 * Kept for the life of the session rather than cleared on completion: a result
 * can arrive after an interrupt, and one string per command run is not a leak
 * worth the ordering subtleties of removing them.
 */
export function trackBashTools(msg: SdkMessageLike, current: ReadonlySet<string>): Set<string> {
  const next = new Set(current)
  if (msg.type !== 'assistant') return next
  for (const block of (msg.message?.content ?? []) as ContentBlock[]) {
    if (block.type === 'tool_use' && block.name === 'Bash' && block.id !== undefined) {
      next.add(block.id)
    }
  }
  return next
}

/**
 * `rate_limit_event` → the normalised window.
 *
 * The payload is **not** what `sdk.d.ts` describes. The types declare
 * `rate_limits_available` and a nested `rate_limits.five_hour`; what the SDK
 * actually sends is flat:
 *
 *   { status, resetsAt, rateLimitType: 'seven_day', utilization: 0.85, … }
 *
 * Read from the types alone, the mapping checked `rate_limits_available`, never
 * found it, and returned nothing — so Claude's limits never appeared at all. The
 * shape below was read off a live event; the documented one is still accepted in
 * case a later SDK starts sending it.
 *
 * `utilization` is a fraction here and a percentage there, and `resetsAt` is in
 * seconds. Both are converted once, so nothing downstream has to know.
 */
function mapRateLimits(msg: SdkMessageLike, base: Omit<AgentEvent, 'type'>): AgentEvent[] {
  const windows = usageWindows(msg.rate_limit_info)
  return windows.length === 0 ? [] : [{ ...base, type: 'limits', windows }]
}

/**
 * The `/usage` payload → every window the plan has.
 *
 * `rate_limit_event` only fires once usage crosses a warning threshold, and it
 * carries the single window that tripped it — so the five-hour figure was
 * invisible until you were already near the end of it, which is too late to be
 * worth showing. Asking gives both windows whenever we like.
 *
 * The method is marked experimental and says it may be removed without notice,
 * so it is called defensively and its absence is not an error: the event path
 * still works, and the header simply says less.
 */
export function mapPlanUsage(usage: unknown, base: Omit<AgentEvent, 'type'>): AgentEvent[] {
  const info = usage as
    { rate_limits_available?: boolean; rate_limits?: RateLimitRecord } | undefined
  if (info?.rate_limits_available !== true) return []

  const windows = usageWindows(info)
  return windows.length === 0 ? [] : [{ ...base, type: 'limits', windows }]
}

/**
 * `getContextUsage()` → how full the window is.
 *
 * `percentage` is on the response and is deliberately ignored: the types do not
 * say whether it is a fraction or a percentage, and the rate-limit shapes in
 * this file already proved that guessing costs a release. `totalTokens` over
 * `maxTokens` is unambiguous, and computing it here means nothing downstream has
 * to know.
 *
 * `maxTokens` rather than `rawMaxTokens`: the former is the ceiling the agent
 * actually compacts against, which is the question being asked.
 */
export function mapContextUsage(usage: unknown, base: Omit<AgentEvent, 'type'>): AgentEvent[] {
  const info = usage as { totalTokens?: unknown; maxTokens?: unknown } | undefined
  const used = typeof info?.totalTokens === 'number' ? info.totalTokens : null
  const max = typeof info?.maxTokens === 'number' ? info.maxTokens : null
  if (used === null || max === null || max <= 0 || used < 0) return []

  const percentUsed = Math.min(100, Math.round((used / max) * 100))
  return [{ ...base, type: 'context.usage', usedTokens: used, maxTokens: max, percentUsed }]
}

type RateLimitRecord = Record<
  string,
  { utilization?: number | null; resets_at?: string | number | null } | null | undefined
>

/**
 * Both shapes, because the SDK sends one and documents the other.
 *
 * The flat one arrives on `rate_limit_event` with `utilization` as a fraction;
 * the nested one comes back from `/usage` with it as a percentage. Converting
 * each where it is recognised is why nothing downstream has to know.
 */
function usageWindows(
  info:
    | {
        rateLimitType?: string
        utilization?: number
        resetsAt?: number
        rate_limits?: RateLimitRecord
      }
    | undefined
): UsageWindow[] {
  if (info === undefined) return []
  const windows: UsageWindow[] = []

  if (typeof info.rateLimitType === 'string') {
    windows.push({
      id: info.rateLimitType,
      // A fraction here; a percentage in the other shape.
      usedPercent: typeof info.utilization === 'number' ? info.utilization * 100 : null,
      windowMinutes: WINDOW_MINUTES[info.rateLimitType] ?? null,
      resetsAt: toEpochMs(info.resetsAt),
    })
  }

  for (const [id, window] of Object.entries(info.rate_limits ?? {})) {
    // Most of the named windows are null for any given plan.
    if (window == null || windows.some((w) => w.id === id)) continue
    if (WINDOW_MINUTES[id] === undefined) continue
    windows.push({
      id,
      usedPercent: typeof window.utilization === 'number' ? window.utilization : null,
      windowMinutes: WINDOW_MINUTES[id] ?? null,
      resetsAt: toEpochMs(
        typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : window.resets_at
      ),
    })
  }

  // Shortest first: the window that runs out soonest is the one you plan around.
  return windows.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))
}

/** The windows Claude names, in minutes, so the UI can label them itself. */
const WINDOW_MINUTES: Record<string, number> = {
  five_hour: 300,
  seven_day: 10_080,
  seven_day_oauth_apps: 10_080,
  seven_day_opus: 10_080,
  seven_day_sonnet: 10_080,
}

function mapResult(msg: SdkMessageLike, ctx: MapContext): AgentEvent[] {
  const base = { agentId: AGENT, at: ctx.now, raw: msg } as const
  const events: AgentEvent[] = []

  if (msg.usage !== undefined) {
    /*
     * Cumulative, to match Codex.
     *
     * A `result` carries one turn's usage while Codex reports a running total,
     * and a reader cannot be expected to know which is which. Adding them up
     * here means `usage.updated` always means "this session so far", whoever
     * sent it. `total_cost_usd` is already cumulative, which is the shape being
     * matched.
     */
    const running = ctx.usageSoFar ?? { inputTokens: 0, outputTokens: 0 }
    running.inputTokens += msg.usage.input_tokens ?? 0
    running.outputTokens += msg.usage.output_tokens ?? 0
    events.push({
      ...base,
      seq: ctx.seq,
      type: 'usage.updated',
      inputTokens: running.inputTokens,
      outputTokens: running.outputTokens,
      ...(typeof msg.total_cost_usd === 'number' ? { costUsd: msg.total_cost_usd } : {}),
    })
  }

  /*
   * A failed turn says why, before it says it is over.
   *
   * `status: 'failed'` alone renders as nothing: the composer goes idle and no
   * reply arrives, which is indistinguishable from an agent that ignored you.
   * The result already carries `errors` and `subtype` — hitting an account
   * limit came through here and was thrown away.
   */
  if (msg.subtype !== undefined && msg.subtype !== 'success') {
    const reported = Array.isArray(msg.errors)
      ? msg.errors.filter((e): e is string => typeof e === 'string')
      : []
    events.push({
      ...base,
      seq: ctx.seq + events.length,
      type: 'error',
      message: reported.length > 0 ? reported.join('; ') : describeFailure(msg.subtype),
      // The turn is over either way; what varies is whether trying again helps.
      recoverable: msg.subtype === 'error_max_turns',
    })
  }

  events.push({
    ...base,
    seq: ctx.seq + events.length,
    type: 'turn.completed',
    turnRef: msg.uuid ?? msg.session_id ?? '',
    status: msg.subtype === 'success' ? 'completed' : 'failed',
  })

  return events
}

/** The SDK's subtype, in words a reader can act on. */
function describeFailure(subtype: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'The agent reached its turn limit before finishing.'
    case 'error_max_budget_usd':
      return 'The agent reached its spend limit before finishing.'
    case 'error_max_structured_output_retries':
      return 'The agent could not produce a valid structured answer.'
    default:
      // Covers `error_during_execution`, which is what an account over its
      // usage limit arrives as.
      return 'The turn ended without an answer — the account may be over its usage limit.'
  }
}

/**
 * `canUseTool` arguments → the unified approval card.
 *
 * Claude routes *everything* through one callback, so the kind is inferred from
 * the tool name. MCP tools are namespaced `mcp__server__tool`, and those are the
 * outward-facing ones a permission profile may never auto-allow (plan §2.6).
 */
/** The one tool that is a question rather than an action needing permission. */
export const USER_INPUT_TOOL = 'AskUserQuestion'

/**
 * `AskUserQuestion` → the normalized question set.
 *
 * Kept out of `mapToolPermission` deliberately. That function is on the path
 * every single tool takes, and a question is not a permission — routing it
 * there is what makes Claude questions render today as an approval card saying
 * "claude needs approval", with Allow/Deny and no way to answer. Returning null
 * for every other tool lets the caller branch once, at the top, and leave the
 * approval path untouched.
 *
 * Claude's schema is narrower than Codex's: it has `multiSelect`, and it has no
 * notion of a secret answer or of free text. Those come back as `false` and as
 * a non-empty option list respectively — the renderer reads the flags, so it
 * degrades on its own without knowing which provider it is drawing.
 */
export function mapUserInputRequest(
  toolName: string,
  input: Record<string, unknown>,
  ctx: MapContext,
  id: UserInputId
): UserInputRequest | null {
  if (toolName !== USER_INPUT_TOOL) return null

  const raw = Array.isArray(input['questions']) ? input['questions'] : []
  const questions = raw
    .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
    .map((q, index) => {
      const options = Array.isArray(q['options']) ? q['options'] : []
      return {
        /*
         * Claude's questions carry no id, so position is the identity, and it
         * only has to be stable within the one request — which it is.
         *
         * The id is **not** what goes back. The CLI keys answers by the
         * question's own text, so this is an index used to look that text up in
         * the original input; see `toClaudeUserInputResult`. This comment used
         * to claim the answer returned as a positional array, which was true of
         * an older CLI and is how C-018 survived review.
         */
        id: String(index),
        header: typeof q['header'] === 'string' ? q['header'] : '',
        question: typeof q['question'] === 'string' ? q['question'] : '',
        options: options
          .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
          .map((o) => ({
            label: typeof o['label'] === 'string' ? o['label'] : '',
            description: typeof o['description'] === 'string' ? o['description'] : '',
          })),
        multiSelect: q['multiSelect'] === true,
        // The harness always offers "Other"; the schema has no flag for it.
        allowOther: true,
        isSecret: false,
      }
    })

  if (questions.length === 0) return null

  return { id, agentId: AGENT, questions, expiresAt: ctx.now + ctx.approvalTtlMs }
}

/**
 * Our answers → the `updatedInput` Claude expects back.
 *
 * The original input is preserved and `answers` added alongside: the CLI
 * matches the response against the questions it sent, so dropping them would
 * leave it unable to line the two up.
 *
 * **A record keyed by the question's own text**, not a positional array. Read
 * out of the installed CLI's own schema description, which says exactly this:
 *
 *   "The answers provided by the user (question text -> answer string;
 *    multi-select answers are comma-separated)"
 *
 * This shipped as `[[label]]` and the CLI rejected it — "the `answers`
 * parameter is expected as a `record` but was provided as an `array`" — so the
 * agent was told the question came back unanswered while Chorus logged an
 * `answered` outcome. C-018. The positional form was probably right once; the
 * lesson is that it is not ours to assume, and the schema is in the binary.
 */
export function toClaudeUserInputResult(
  input: Record<string, unknown>,
  response: UserInputResponse
):
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string } {
  if (response.outcome !== 'answered') {
    // Never fabricate an answer. Denying lets the agent carry on knowing it was
    // not told, which is recoverable; a made-up choice is not.
    return { behavior: 'deny', message: 'The user did not answer the question.' }
  }
  /*
   * Keyed by the question text the CLI sent, which means reading it back out of
   * `input` — our own `questionId` is a position we invented, because Claude's
   * questions carry no id of their own.
   */
  // `Array.isArray` narrows `unknown` to `any[]`, so the element type is stated
  // rather than inherited — an `any` here would spread into everything below.
  const asked: unknown[] = Array.isArray(input['questions'])
    ? (input['questions'] as unknown[])
    : []
  const entries: [string, string][] = []
  for (const answer of response.answers) {
    const question = asked[Number(answer.questionId)]
    const text =
      typeof question === 'object' && question !== null
        ? (question as Record<string, unknown>)['question']
        : undefined
    /*
     * An answer we cannot name denies the whole set rather than being dropped.
     *
     * Dropping it sends a partial or empty record, which the CLI reads as "the
     * user chose nothing" — the exact shape of C-018: an `allow` carrying an
     * answer that never lands, logged as `answered`. A deny is the one outcome
     * the agent recovers from, and it is what the timeout path already does for
     * the same reason.
     */
    if (typeof text !== 'string' || text === '') {
      return { behavior: 'deny', message: 'The answer could not be matched to the question.' }
    }
    entries.push([text, answer.values.join(',')])
  }

  /*
   * `fromEntries`, not assignment into `{}`.
   *
   * The keys are question text the agent wrote, so `__proto__` is reachable —
   * and `obj['__proto__'] = x` on a plain object sets the prototype rather than
   * an own property, serialising to `{}`. The answer would vanish with no error
   * anywhere. `fromEntries` defines the property directly.
   */
  return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(entries) } }
}

/**
 * What the CLI itself says about a permission request.
 *
 * Every field is optional and every one is better than what this file can
 * reconstruct: `title` is the sentence the bridge already rendered, and
 * `blockedPath` names a path that appears nowhere in the tool's arguments —
 * a Bash command reaching outside the allowed directories has it only here.
 */
export interface PromptDetail {
  readonly title?: string
  readonly description?: string
  readonly blockedPath?: string
  readonly decisionReason?: string
}

/** Drops what the provider did not answer, so an absent field stays absent. */
function stated(prompt: PromptDetail | undefined): PromptDetail {
  const kept: Record<string, string> = {}
  for (const key of ['title', 'description', 'blockedPath', 'decisionReason'] as const) {
    const value = prompt?.[key]
    if (typeof value === 'string' && value !== '') kept[key] = value
  }
  return kept
}

export function mapToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  ctx: MapContext,
  id: ApprovalId,
  prompt?: PromptDetail
): ApprovalRequest {
  const expiresAt = ctx.now + ctx.approvalTtlMs
  const said = stated(prompt)

  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName)
  if (mcp !== null) {
    const target = describeTarget(input)
    return {
      id,
      agentId: AGENT,
      kind: 'mcpToolCall',
      expiresAt,
      ...said,
      serverName: mcp[1] ?? 'unknown',
      toolName: mcp[2] ?? toolName,
      ...(target === undefined ? {} : { target }),
      input,
    }
  }

  if (toolName === 'Bash') {
    const command = input['command']
    return {
      id,
      agentId: AGENT,
      kind: 'command',
      expiresAt,
      ...said,
      command: typeof command === 'string' ? [command] : [],
      cwd: typeof input['cwd'] === 'string' ? input['cwd'] : '',
      withNetwork: false,
    }
  }

  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    const path = input['file_path'] ?? input['notebook_path']
    return {
      id,
      agentId: AGENT,
      kind: 'fileChange',
      expiresAt,
      ...said,
      files: typeof path === 'string' ? [{ path, patch: describePatch(input) }] : [],
    }
  }

  // Anything else — Task, TodoWrite, ExitPlanMode, WebFetch, a plugin tool, a
  // tool added by a future release. Modelled as a permission grant so it still
  // surfaces a card rather than silently falling through.
  //
  // `toolName` and `input` are carried because without them the card renders
  // the kind and nothing else, which is indistinguishable between a subagent
  // being spawned and a todo list being written.
  return {
    id,
    agentId: AGENT,
    kind: 'permissionGrant',
    expiresAt,
    ...said,
    toolName,
    cwd: typeof input['cwd'] === 'string' ? input['cwd'] : '',
    requested: { network: toolName === 'WebFetch' || toolName === 'WebSearch' },
    input,
  }
}

function describeTarget(input: Record<string, unknown>): string | undefined {
  for (const key of ['channel', 'channel_id', 'issueKey', 'issue_key', 'repo', 'url', 'path']) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function describePatch(input: Record<string, unknown>): string {
  const oldText = input['old_string']
  const newText = input['new_string'] ?? input['content']
  if (typeof oldText === 'string' && typeof newText === 'string') {
    return `- ${oldText}\n+ ${newText}`
  }
  return typeof newText === 'string' ? newText : ''
}
