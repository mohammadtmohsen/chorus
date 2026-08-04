import {
  toEpochMs,
  type AgentEvent,
  type ApprovalRequest,
  type UsageWindow,
} from '@chorus/agent-protocol'
import type { AgentId, ApprovalId } from '@chorus/shared'

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
  session_id?: string
  message?: { id?: string; content?: unknown[] }
  event?: {
    type?: string
    delta?: { type?: string; text?: string; thinking?: string }
    index?: number
    message?: { id?: string }
  }
  parent_tool_use_id?: string | null
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
      // `init` is the start of a turn's work and carries the CLI version we
      // record on session.started (plan §2.5).
      return msg.subtype === 'init'
        ? [{ ...at(0), type: 'turn.started', turnRef: msg.uuid ?? msg.session_id ?? '' }]
        : []

    case 'stream_event':
      return mapStreamEvent(msg, at(0), ctx.streamMessageRef ?? null)

    case 'assistant':
      return mapAssistant(msg, base, ctx)

    case 'user':
      // Tool results come back as a user message. Dropping them left every
      // Claude command hanging in the transcript with no result, and left the
      // other agent nothing to read when asked why something failed.
      return mapToolResults(msg, base, ctx)

    case 'rate_limit_event':
      return mapRateLimits(msg, at(0))

    case 'result':
      return mapResult(msg, ctx)

    default:
      // Hooks, task progress, retries, rate-limit notices and the rest are not
      // rendered. Silence here is a decision, not a gap.
      return []
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
    if (block.type === 'tool_use' && block.name === 'Bash') {
      const command = block.input?.['command']
      events.push({
        ...base,
        seq: ctx.seq + events.length,
        type: 'command.started',
        itemRef: block.id ?? '',
        command: typeof command === 'string' ? [command] : [],
        cwd: '',
      })
    }
  }

  return events
}

/**
 * `tool_result` blocks → `command.output` and `command.completed`.
 *
 * Only for tool calls we already reported as commands; every other tool's result
 * is the agent's own working, and the agent narrates what it found.
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
  const known = ctx.bashToolIds
  if (known === undefined || known.size === 0) return []

  const events: AgentEvent[] = []
  for (const block of (msg.message?.content ?? []) as ContentBlock[]) {
    const ref = block.tool_use_id
    if (block.type !== 'tool_result' || ref === undefined || !known.has(ref)) continue

    const text = readResultText(block.content)
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
  const info = msg.rate_limit_info
  if (info === undefined) return []

  const windows: UsageWindow[] = []

  // What the SDK actually sends: one window, named by `rateLimitType`.
  if (typeof info.rateLimitType === 'string') {
    windows.push({
      id: info.rateLimitType,
      usedPercent: typeof info.utilization === 'number' ? info.utilization * 100 : null,
      windowMinutes: WINDOW_MINUTES[info.rateLimitType] ?? null,
      resetsAt: toEpochMs(info.resetsAt),
    })
  }

  // What the types describe, should it ever arrive.
  for (const [id, window] of Object.entries(info.rate_limits ?? {})) {
    if (window == null || windows.some((w) => w.id === id)) continue
    windows.push({
      id,
      usedPercent: typeof window.utilization === 'number' ? window.utilization : null,
      windowMinutes: WINDOW_MINUTES[id] ?? null,
      resetsAt: toEpochMs(
        typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : window.resets_at
      ),
    })
  }

  return windows.length === 0 ? [] : [{ ...base, type: 'limits', windows }]
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

  events.push({
    ...base,
    seq: ctx.seq + events.length,
    type: 'turn.completed',
    turnRef: msg.uuid ?? msg.session_id ?? '',
    status: msg.subtype === 'success' ? 'completed' : 'failed',
  })

  return events
}

/**
 * `canUseTool` arguments → the unified approval card.
 *
 * Claude routes *everything* through one callback, so the kind is inferred from
 * the tool name. MCP tools are namespaced `mcp__server__tool`, and those are the
 * outward-facing ones a permission profile may never auto-allow (plan §2.6).
 */
export function mapToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  ctx: MapContext,
  id: ApprovalId
): ApprovalRequest {
  const expiresAt = ctx.now + ctx.approvalTtlMs

  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName)
  if (mcp !== null) {
    const target = describeTarget(input)
    return {
      id,
      agentId: AGENT,
      kind: 'mcpToolCall',
      expiresAt,
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
      files: typeof path === 'string' ? [{ path, patch: describePatch(input) }] : [],
    }
  }

  // Anything else — WebFetch, a plugin tool, a tool added by a future release.
  // Modelled as a permission grant so it still surfaces a card rather than
  // silently falling through.
  return {
    id,
    agentId: AGENT,
    kind: 'permissionGrant',
    expiresAt,
    cwd: typeof input['cwd'] === 'string' ? input['cwd'] : '',
    requested: { network: toolName === 'WebFetch' || toolName === 'WebSearch' },
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
