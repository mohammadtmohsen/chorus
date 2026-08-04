import type { AgentEvent, ApprovalRequest } from '@chorus/agent-protocol'
import type { AgentId, ApprovalId } from '@chorus/shared'

/**
 * Codex notifications → the normalized `AgentEvent` union.
 *
 * Pure on purpose: every shape here is exercised by replaying recorded JSONL
 * without a process, which is what keeps the mapping honest as the protocol
 * moves under us (plan §8).
 */

const AGENT: AgentId = 'codex'

export interface MapContext {
  readonly seq: number
  readonly now: number
  /** How long an unanswered approval may sit before Chorus denies it (plan §4.4). */
  readonly approvalTtlMs: number
}

interface Notification {
  method: string
  params: unknown
}

export interface ThreadItem {
  type: string
  id: string
  text?: string
  command?: string[] | string
  cwd?: string
  exitCode?: number | null
  changes?: { path: string; diff?: string; patch?: string }[]
  summary?: string[]
  steps?: { text?: string; step?: string; completed?: boolean; status?: string }[]
}

/**
 * Returns `null` for notifications Chorus does not surface — MCP startup chatter,
 * remote-control status, token accounting we read elsewhere. Silence is a
 * deliberate mapping decision, not a gap.
 */
export function mapNotification(n: Notification, ctx: MapContext): AgentEvent | null {
  const p = (n.params ?? {}) as Record<string, unknown>
  const base = { agentId: AGENT, seq: ctx.seq, at: ctx.now, raw: n } as const

  switch (n.method) {
    case 'turn/started':
      return { ...base, type: 'turn.started', turnRef: turnIdOf(p) }

    case 'turn/completed': {
      const turn = p['turn'] as { id?: string; status?: string } | undefined
      return {
        ...base,
        type: 'turn.completed',
        turnRef: turn?.id ?? turnIdOf(p),
        status: mapTurnStatus(turn?.status),
      }
    }

    case 'item/agentMessage/delta':
      return {
        ...base,
        type: 'message.delta',
        itemRef: str(p['itemId'], ''),
        text: str(p['delta'], ''),
      }

    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      return {
        ...base,
        type: 'reasoning.delta',
        itemRef: str(p['itemId'], ''),
        text: str(p['delta'], ''),
      }

    case 'item/commandExecution/outputDelta':
      return {
        ...base,
        type: 'command.output',
        itemRef: str(p['itemId'], ''),
        // Codex does not split stdout from stderr in the delta stream.
        stream: 'stdout',
        chunk: decodeChunk(p['chunk'] ?? p['delta']),
      }

    case 'turn/diff/updated':
      return {
        ...base,
        type: 'diff.updated',
        unifiedDiff: str(p['unifiedDiff'] ?? p['diff'], ''),
      }

    case 'turn/plan/updated': {
      const plan = (p['plan'] ?? p) as { steps?: ThreadItem['steps'] }
      return {
        ...base,
        type: 'plan.updated',
        steps: (plan.steps ?? []).map((s) => ({
          text: s.text ?? s.step ?? '',
          done: s.completed === true || s.status === 'completed',
        })),
      }
    }

    case 'item/started':
      return mapItem(p, base, 'started')

    case 'item/completed':
      return mapItem(p, base, 'completed')

    case 'thread/tokenUsage/updated': {
      const usage = (p['usage'] ?? p) as Record<string, unknown>
      return {
        ...base,
        type: 'usage.updated',
        inputTokens: Number(usage['inputTokens'] ?? 0),
        outputTokens: Number(usage['outputTokens'] ?? 0),
      }
    }

    case 'warning':
      return {
        ...base,
        type: 'error',
        message: str(p['message'], 'warning'),
        recoverable: true,
      }

    default:
      return null
  }
}

function mapItem(
  p: Record<string, unknown>,
  base: { agentId: AgentId; seq: number; at: number; raw: unknown },
  phase: 'started' | 'completed'
): AgentEvent | null {
  const item = p['item'] as ThreadItem | undefined
  if (item === undefined) return null

  switch (item.type) {
    case 'agentMessage':
      return phase === 'completed'
        ? { ...base, type: 'message.completed', itemRef: item.id, text: item.text ?? '' }
        : null

    case 'commandExecution':
      return phase === 'started'
        ? {
            ...base,
            type: 'command.started',
            itemRef: item.id,
            command: normalizeCommand(item.command),
            cwd: item.cwd ?? '',
          }
        : { ...base, type: 'command.completed', itemRef: item.id, exitCode: item.exitCode ?? null }

    case 'fileChange':
      return phase === 'started'
        ? {
            ...base,
            type: 'file.change.proposed',
            itemRef: item.id,
            files: (item.changes ?? []).map((c) => ({
              path: c.path,
              patch: c.diff ?? c.patch ?? '',
            })),
          }
        : null

    // userMessage echoes what we already logged; reasoning and plan arrive as
    // their own delta streams.
    default:
      return null
  }
}

/**
 * Codex's three approval requests → one `ApprovalRequest`, so a single card
 * renders all of them (plan §4.2).
 */
export function mapApprovalRequest(
  method: string,
  params: unknown,
  ctx: MapContext,
  /**
   * Looks up a previously streamed item by id. `item/fileChange/requestApproval`
   * carries **no** changes — only `itemId` — so without this the card renders
   * "Edit " with no paths. Verified against the generated bindings after the
   * live app showed exactly that.
   */
  lookupItem?: (itemId: string) => ThreadItem | undefined
): ApprovalRequest | null {
  const p = (params ?? {}) as Record<string, unknown>
  const itemId = str(p['itemId'], '')
  // Several approvals can share one itemId (the zsh-exec-bridge case), so a
  // distinct approvalId wins when the server supplies one.
  const id = (str(p['approvalId'], '') || itemId || str(p['callId'], '')) as ApprovalId
  const expiresAt = ctx.now + ctx.approvalTtlMs
  const reason = typeof p['reason'] === 'string' ? { reason: p['reason'] } : {}

  switch (method) {
    case 'item/commandExecution/requestApproval':
      return {
        id,
        agentId: AGENT,
        kind: 'command',
        ...reason,
        expiresAt,
        command: normalizeCommand(p['command']),
        cwd: str(p['cwd'], ''),
        withNetwork: p['networkAccess'] === true,
      }

    case 'item/fileChange/requestApproval': {
      const item = lookupItem?.(itemId)
      return {
        id,
        agentId: AGENT,
        kind: 'fileChange',
        ...reason,
        expiresAt,
        files: (item?.changes ?? []).map((c) => ({
          path: c.path,
          patch: c.diff ?? c.patch ?? '',
        })),
      }
    }

    case 'item/permissions/requestApproval': {
      const requested = (p['permissions'] ?? p['requested'] ?? {}) as Record<string, unknown>
      const filesystem = Array.isArray(requested['filesystem'])
        ? {
            filesystem: (requested['filesystem'] as unknown[]).filter((v) => typeof v === 'string'),
          }
        : {}
      return {
        id,
        agentId: AGENT,
        kind: 'permissionGrant',
        ...reason,
        expiresAt,
        cwd: str(p['cwd'], ''),
        requested: { ...filesystem, network: requested['network'] === true },
      }
    }

    default:
      return null
  }
}

/**
 * Our decision → Codex's wire vocabulary.
 *
 * A timeout maps to `decline`, never to `accept` — an unanswered approval must
 * fail closed (plan §4.4).
 */
export function toCodexDecision(
  outcome: 'allow' | 'deny' | 'cancel' | 'timeout',
  scope: 'once' | 'session'
): string {
  switch (outcome) {
    case 'allow':
      return scope === 'session' ? 'acceptForSession' : 'accept'
    case 'deny':
    case 'timeout':
      return 'decline'
    case 'cancel':
      return 'cancel'
  }
}

function mapTurnStatus(status: string | undefined): 'completed' | 'interrupted' | 'failed' {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'interrupted':
      return 'interrupted'
    // A missing status is a turn that never reported one — treat that as a
    // failure rather than quietly claiming success.
    case undefined:
    default:
      return 'failed'
  }
}

function turnIdOf(p: Record<string, unknown>): string {
  const turn = p['turn'] as { id?: string } | undefined
  return turn?.id ?? str(p['turnId'], '')
}

/**
 * Narrow rather than coerce. `String(someObject)` yields "[object Object]",
 * which would land verbatim in a transcript; an unexpected shape should read as
 * absent, not as garbage.
 */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function normalizeCommand(command: unknown): string[] {
  if (Array.isArray(command)) return command.filter((c) => typeof c === 'string')
  if (typeof command === 'string') return [command]
  return []
}

/** `command/exec/outputDelta` is base64; the item-level delta is plain text. */
function decodeChunk(chunk: unknown): string {
  if (typeof chunk !== 'string') return ''
  return chunk
}
