import {
  toEpochMs,
  type AgentEvent,
  type ApprovalRequest,
  type UsageWindow,
  type UserInputRequest,
  type UserInputResponse,
} from '@chorus/agent-protocol'
import type { AgentId, ApprovalId, UserInputId } from '@chorus/shared'
import type { PatchApplyStatus } from './generated/v2/PatchApplyStatus.js'
import type { PatchChangeKind } from './generated/v2/PatchChangeKind.js'

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
  /*
   * `kind` and `status` are typed by the generated bindings rather than restated
   * here, which is the point: they are the two fields this file used to drop on
   * the floor, and a hand-written copy of an enum is how that happens. If Codex
   * adds an arm to either, regenerating turns the switches below into compile
   * errors instead of into a silent default.
   *
   * Everything else stays optional and loosely read, because the CLI on the
   * machine can be older or newer than the bindings in the repo.
   */
  changes?: { path: string; diff?: string; patch?: string; kind?: PatchChangeKind }[]
  status?: PatchApplyStatus
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

    /*
     * `primary` and `secondary`, named by their own durations.
     *
     * Codex does not say which window is which — only how long each is — so the
     * id comes from `windowDurationMins` when it is there. That is also the
     * honest mapping: a "5h limit" is a five-hour window whatever the provider
     * happens to call the slot it arrived in.
     */
    case 'account/rateLimits/updated': {
      const snapshot = record(p['rateLimits'])
      const windows: UsageWindow[] = []
      for (const slot of ['primary', 'secondary'] as const) {
        const window = record(snapshot[slot])
        if (Object.keys(window).length === 0) continue
        const minutes =
          typeof window['windowDurationMins'] === 'number' ? window['windowDurationMins'] : null
        windows.push({
          id: minutes === null ? slot : `${String(minutes)}m`,
          usedPercent: typeof window['usedPercent'] === 'number' ? window['usedPercent'] : null,
          windowMinutes: minutes,
          // Seconds on the wire; the helper recognises which it was given.
          resetsAt: toEpochMs(window['resetsAt'] as number | null | undefined),
        })
      }
      return windows.length === 0 ? null : { ...base, type: 'limits', windows }
    }

    /*
     * `tokenUsage.total`, not `usage`.
     *
     * There is no `usage` key on this notification — the counts live under
     * `tokenUsage`, split into `total` for the thread and `last` for the turn.
     * Reading the wrong one meant every Codex usage event carried zero, silently,
     * for as long as this adapter has existed. It was found by putting the number
     * on screen: nothing ever appeared.
     *
     * `total` because it is cumulative and idempotent — a notification arriving
     * twice cannot inflate it, which per-turn deltas would.
     */
    case 'thread/tokenUsage/updated': {
      const total = record(record(p['tokenUsage'])['total'])
      return {
        ...base,
        type: 'usage.updated',
        inputTokens: Number(total['inputTokens'] ?? 0),
        outputTokens: Number(total['outputTokens'] ?? 0),
      }
    }

    /*
     * Codex has always sent this and nothing has ever read it. The payload
     * carries only encrypted content, so there is nothing to show but the
     * fact — which is the part that matters.
     */
    case 'thread/compacted':
      return { ...base, type: 'context.compacted' }

    /*
     * A turn that failed, said out loud.
     *
     * Codex sends this and the mapper had no case for it, so it fell through to
     * `null` — which is why a turn refused for hitting an account limit showed
     * nothing at all: no reply, no notice, an idle composer. `willRetry` is the
     * difference between "waiting" and "over", and both are worth saying.
     */
    case 'error': {
      const error = record(p['error'])
      const detail = str(error['additionalDetails'], '')
      return {
        ...base,
        type: 'error',
        message:
          detail === ''
            ? str(error['message'], 'The agent stopped without saying why')
            : `${str(error['message'], 'Error')} — ${detail}`,
        recoverable: p['willRetry'] === true,
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
        : {
            ...base,
            type: 'file.change.completed',
            itemRef: item.id,
            files: (item.changes ?? []).map(normalizeChange),
            outcome: mapPatchStatus(item.status),
          }

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

/** The one server request that is a question rather than a permission. */
export const USER_INPUT_METHOD = 'item/tool/requestUserInput'

/**
 * `item/tool/requestUserInput` → the normalized question set.
 *
 * Returns null for anything else, so the caller can keep treating an
 * unrecognised method as "not ours". Two Codex-isms are worth naming:
 *
 *  - **No multi-select flag.** Codex expresses it by accepting an array of
 *    answers. There is nothing on the question saying whether more than one is
 *    allowed, so we report `multiSelect: false` and let the answer array carry
 *    the truth. Claiming otherwise would put checkboxes on single-answer
 *    questions.
 *  - **`options: null` means free text**, not "no options yet". Normalising it
 *    to an empty array keeps the renderer from having to know that.
 */
export function mapUserInputRequest(
  method: string,
  params: unknown,
  ctx: MapContext
): UserInputRequest | null {
  if (method !== USER_INPUT_METHOD) return null

  const p = (params ?? {}) as Record<string, unknown>
  const raw = Array.isArray(p['questions']) ? p['questions'] : []

  const questions = raw
    .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
    .map((q) => {
      const options = Array.isArray(q['options']) ? q['options'] : []
      return {
        id: str(q['id'], ''),
        header: str(q['header'], ''),
        question: str(q['question'], ''),
        options: options
          .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
          .map((o) => ({ label: str(o['label'], ''), description: str(o['description'], '') })),
        multiSelect: false,
        allowOther: q['isOther'] === true,
        isSecret: q['isSecret'] === true,
      }
    })
    // A question with no id cannot be answered: the response is keyed by id, so
    // it would be dropped on the way back with no way to tell the user why.
    .filter((q) => q.id !== '')

  if (questions.length === 0) return null

  const autoMs = p['autoResolutionMs']
  return {
    id: str(p['itemId'], '') as UserInputId,
    agentId: AGENT,
    questions,
    expiresAt: ctx.now + ctx.approvalTtlMs,
    ...(typeof autoMs === 'number' && autoMs > 0 ? { autoResolvesAt: ctx.now + autoMs } : {}),
  }
}

/**
 * Our answers → Codex's response payload.
 *
 * Shaped as `{ answers: { [questionId]: { answers: string[] } } }`. A cancel or
 * timeout sends an empty map rather than inventing answers — Codex treats an
 * absent id as unanswered, which is exactly what happened.
 */
export function toCodexUserInputResponse(response: UserInputResponse): {
  answers: Record<string, { answers: string[] }>
} {
  if (response.outcome !== 'answered') return { answers: {} }
  const answers: Record<string, { answers: string[] }> = {}
  for (const a of response.answers) answers[a.questionId] = { answers: [...a.values] }
  return { answers }
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
/** A plain object, or an empty one — a sparse update may omit anything. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * One of Codex's file changes, in the protocol's own terms.
 *
 * Two things stop here rather than crossing the adapter boundary.
 *
 * **`PatchChangeKind`**, because it is a tagged object whose rename is expressed
 * as an `update` carrying `move_path`. Letting it through would put Codex's
 * spelling of "rename" into everyone's types.
 *
 * **The direction of a rename**, which is the easy thing to get backwards:
 * `path` is where the file *was* and `move_path` is where it *went*, so the two
 * cross on the way out. Both are strings, so swapping them fails nothing at the
 * type level and everything on screen.
 */
function normalizeChange(change: {
  path: string
  diff?: string
  patch?: string
  kind?: PatchChangeKind
}): {
  path: string
  oldPath?: string
  change: 'added' | 'removed' | 'modified' | 'renamed'
  added: number
  removed: number
  patch: string
  omittedLines?: number
} {
  const body = change.diff ?? change.patch ?? ''
  const kind = change.kind

  if (kind?.type === 'add') {
    return {
      path: change.path,
      change: 'added',
      ...countBody(body, 'added'),
      ...wholeFilePatch(change.path, body, 'added'),
    }
  }
  if (kind?.type === 'delete') {
    return {
      path: change.path,
      change: 'removed',
      ...countBody(body, 'removed'),
      ...wholeFilePatch(change.path, body, 'removed'),
    }
  }
  if (kind?.type === 'update' && typeof kind.move_path === 'string' && kind.move_path !== '') {
    return {
      path: kind.move_path,
      oldPath: change.path,
      change: 'renamed',
      ...countDiff(body),
      patch: withHeader(change.path, kind.move_path, body),
    }
  }
  // No `kind` at all is an older CLI than the bindings: an edit is the safe
  // reading, and the counts still come out of whatever body arrived.
  return {
    path: change.path,
    change: 'modified',
    ...countDiff(body),
    patch: withHeader(change.path, change.path, body),
  }
}

/**
 * How much of a whole file is worth showing when it was added or deleted.
 *
 * The same number and the same reasoning as `adapter-claude`'s create path: a
 * long block fills the pane and scrolls the row that says which file it belongs
 * to off the top, so the diff loses the one thing identifying it. Enough to
 * recognise a file beats enough to read it, and the omitted count carries the
 * rest honestly.
 */
const MAX_WHOLE_FILE_LINES = 12

/**
 * A header, so `parseDiff` can read what Codex sent.
 *
 * An `update` arrives as a bare unified body — hunks and nothing else — and
 * `parseDiff` skips every line until it sees `diff --git`. Without this the diff
 * is not "wrong", it is *absent*: zero files, zero counts, an empty card.
 *
 * A body that already carries its own header is left alone, because a future CLI
 * sending a complete diff should not have a second one stapled to it.
 */
function withHeader(oldPath: string, path: string, body: string): string {
  if (body === '') return ''
  if (/^diff --git /m.test(body)) return body
  const header = [`diff --git a/${oldPath} b/${path}`]
  if (oldPath !== path) header.push(`rename from ${oldPath}`, `rename to ${path}`)
  return `${header.join('\n')}\n${body}`
}

/**
 * A whole file, as a diff of it appearing or disappearing.
 *
 * Codex sends the file's *content* for an add or a delete, not a diff — so the
 * one has to be built from the other, with the mode line that lets a status
 * letter be read back off it. Bounded, and the bound is reported: a card that
 * silently showed the first twelve lines of a four-hundred-line file would be
 * lying about what the turn wrote.
 */
function wholeFilePatch(
  path: string,
  body: string,
  side: 'added' | 'removed'
): { patch: string; omittedLines?: number } {
  if (body === '') return { patch: '' }
  if (/^@@ /m.test(body)) return { patch: withHeader(path, path, body) }

  const all = body.replace(/\n$/, '').split('\n')
  const shown = all.slice(0, MAX_WHOLE_FILE_LINES)
  const omitted = all.length - shown.length
  const sign = side === 'added' ? '+' : '-'
  const mode = side === 'added' ? 'new file mode 100644' : 'deleted file mode 100644'
  const from = side === 'added' ? '/dev/null' : `a/${path}`
  const to = side === 'added' ? `b/${path}` : '/dev/null'
  const range =
    side === 'added'
      ? `@@ -0,0 +1,${String(shown.length)} @@`
      : `@@ -1,${String(shown.length)} +0,0 @@`

  return {
    patch: [
      `diff --git a/${path} b/${path}`,
      mode,
      `--- ${from}`,
      `+++ ${to}`,
      range,
      ...shown.map((line) => `${sign}${line}`),
      '',
    ].join('\n'),
    ...(omitted > 0 ? { omittedLines: omitted } : {}),
  }
}

/**
 * The `+`/`−` lines of a unified diff.
 *
 * `+++`/`---` are file headers rather than content — counting them adds one to
 * every file that happens to arrive with them, which is a number nobody can
 * explain later.
 */
function countDiff(body: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of body.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

/**
 * A whole file's worth of lines, on the side the change happened.
 *
 * An `add` and a `delete` carry the file's *content* where an `update` carries
 * hunks — so parsing the body as a diff would return zero for exactly the two
 * kinds whose numbers are the largest. A body that does turn out to be a diff is
 * counted as one, since which of the two arrives has changed between CLI
 * versions before.
 */
function countBody(body: string, side: 'added' | 'removed'): { added: number; removed: number } {
  if (/^@@ /m.test(body)) return countDiff(body)
  const lines = body === '' ? 0 : body.replace(/\n$/, '').split('\n').length
  return side === 'added' ? { added: lines, removed: 0 } : { added: 0, removed: lines }
}

/** Whether the patch landed. Anything not `completed` did not. */
function mapPatchStatus(status: PatchApplyStatus | undefined): 'applied' | 'failed' | 'declined' {
  switch (status) {
    case 'completed':
      return 'applied'
    case 'declined':
      return 'declined'
    case 'failed':
      return 'failed'
    /*
     * `inProgress` on a *completed* item means the CLI told us the operation
     * finished without saying how. Reporting that as applied would put a file in
     * a card on the strength of a missing field.
     */
    case 'inProgress':
    case undefined:
      return 'failed'
  }
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
