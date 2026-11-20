import { AgentIdSchema, redactPayload, uuidv7 } from '@chorus/shared'
import { z } from 'zod'
import {
  ChorusEventPayload,
  SCHEMA_VERSION,
  StoredEventRow,
  type AppendInput,
  type StoredEvent,
} from './events.js'
import { migrate, type MigrationResult } from './migrations.js'
import type { Database } from './port.js'
import { applyToProjections, PROJECTION_NAMES, PROJECTION_TABLES } from './projections.js'

export interface ReadOptions {
  /** Exclusive — return events with `seq` greater than this. */
  readonly afterSeq?: number
  readonly limit?: number
  readonly types?: readonly string[]
}

/** What is still waiting, and what has been spent, without folding the log. */
export interface TranscriptState {
  readonly approvals: readonly {
    readonly approvalId: string
    readonly agentId: string
    readonly kind: string
    readonly request: unknown
    readonly expiresAt: number
    readonly mode?: 'discussion'
    readonly requestId?: string
  }[]
  readonly questions: readonly {
    readonly userInputId: string
    readonly eventId: string
    readonly agentId: string
    readonly request: unknown
    readonly expiresAt: number
    readonly mode?: 'discussion'
    readonly requestId?: string
  }[]
  /** Agents whose last `turn.started` has no matching `turn.completed`. */
  readonly working: readonly string[]
  readonly workingSince?: Readonly<Record<string, number>>
  /** The latest total each agent reported. Totals, not deltas, so latest wins. */
  readonly usageByActor: Readonly<
    Record<string, { inputTokens: number; outputTokens: number; costUsd: number | null }>
  >
  readonly assignment: TranscriptAssignment
}

export interface TranscriptAssignment {
  readonly linked: boolean
  readonly boundTaskId: string | null
}

export interface LiveWorkRow {
  readonly agentId: string
  readonly generation: number
  readonly startedAt: number
  readonly evidenceAt: number
}

export interface LiveChatRow {
  readonly requestId: string
  readonly agentId: string
  readonly startedAt: number
  readonly evidenceAt: number
}

export interface LiveOperationRow {
  readonly agentId: string
  readonly requestId: string | null
  readonly generation: number
  readonly itemRef: string
  readonly kind: 'tool' | 'command'
  readonly name: string
  readonly detail: string | null
  readonly startedAt: number
}

export type LiveHandoffOutcome = 'submitted' | 'failed' | 'cancelled' | 'unavailable'

export interface LiveHandoffRow {
  readonly handoffId: string
  readonly from: string
  readonly to: string
  readonly sourceEventIds: readonly string[]
  readonly createdAt: number | null
  readonly outcome: LiveHandoffOutcome | null
  readonly outcomeAt: number | null
}

export interface LiveState {
  readonly work: readonly LiveWorkRow[]
  readonly chat: readonly LiveChatRow[]
  readonly operations: readonly LiveOperationRow[]
  readonly handoffs: readonly LiveHandoffRow[]
}

export interface LiveStateOptions {
  readonly chatRequests: readonly { readonly requestId: string; readonly agentId: string }[]
  readonly ignoredItemRefPrefixes?: readonly string[]
}

interface OperationEventRow {
  readonly type: string
  readonly payload: string
  readonly created_at: number
}

const HANDOFF_OUTCOMES: readonly LiveHandoffOutcome[] = [
  'submitted',
  'failed',
  'cancelled',
  'unavailable',
]

function textOf(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

function openOperations(
  rows: readonly OperationEventRow[],
  agentId: string,
  requestId: string | null,
  generation: number
): LiveOperationRow[] {
  const open = new Map<string, LiveOperationRow>()
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    const itemRef = textOf(payload, 'itemRef')
    if (itemRef === '') continue
    if (row.type === 'tool.completed' || row.type === 'command.completed') {
      open.delete(itemRef)
      continue
    }
    if (row.type === 'tool.started') {
      if (textOf(payload, 'parentRef') !== '') continue
      const previous = open.get(itemRef)
      const detail = textOf(payload, 'detail')
      open.set(itemRef, {
        agentId,
        requestId,
        generation,
        itemRef,
        kind: 'tool',
        name: textOf(payload, 'name'),
        detail: detail === '' ? (previous?.detail ?? null) : detail,
        startedAt: previous?.startedAt ?? row.created_at,
      })
      continue
    }
    const command = Array.isArray(payload['command']) ? payload['command'] : []
    open.set(itemRef, {
      agentId,
      requestId,
      generation,
      itemRef,
      kind: 'command',
      name: command.filter((part): part is string => typeof part === 'string').join(' '),
      detail: null,
      startedAt: row.created_at,
    })
  }
  return [...open.values()]
}

function foldHandoffs(rows: readonly OperationEventRow[]): LiveHandoffRow[] {
  const handoffs = new Map<string, LiveHandoffRow>()
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    const handoffId = textOf(payload, 'handoffId')
    if (handoffId === '') continue
    const previous = handoffs.get(handoffId)
    const sourceEventIds = Array.isArray(payload['sourceEventIds'])
      ? payload['sourceEventIds'].filter((id): id is string => typeof id === 'string')
      : []
    if (row.type === 'handoff.created') {
      handoffs.set(handoffId, {
        handoffId,
        from: textOf(payload, 'from'),
        to: textOf(payload, 'to'),
        sourceEventIds,
        createdAt: row.created_at,
        outcome: previous?.outcome ?? null,
        outcomeAt: previous?.outcomeAt ?? null,
      })
      continue
    }
    const outcome = HANDOFF_OUTCOMES.find((value) => value === payload['outcome'])
    if (outcome === undefined || (previous !== undefined && previous.outcome !== null)) continue
    handoffs.set(handoffId, {
      handoffId,
      from: previous?.from ?? textOf(payload, 'from'),
      to: previous?.to ?? textOf(payload, 'to'),
      sourceEventIds: previous?.sourceEventIds ?? sourceEventIds,
      createdAt: previous?.createdAt ?? null,
      outcome,
      outcomeAt: row.created_at,
    })
  }
  return [...handoffs.values()]
}

export interface EventRef {
  readonly seq: number
  readonly eventId: string
  readonly at: number
}

export interface ForwardedChild {
  readonly conversationId: string
  readonly created: EventRef
  readonly title: string
  readonly titleRef: EventRef
  readonly objective: string | null
  readonly sourceEventIds: readonly string[]
  readonly throughSeq: number | null
}

export interface ForwardedChildPage {
  readonly children: readonly ForwardedChild[]
  readonly total: number
  readonly skip: number
  readonly count: number
  readonly asOfSeq: number
}

export interface AssignmentBindingRecord {
  readonly ref: EventRef
  readonly taskId: string
  readonly previousTaskId: string | null
}

export interface AssignmentBinding {
  readonly current: AssignmentBindingRecord | null
  readonly history: readonly AssignmentBindingRecord[]
  readonly suggestion: (EventRef & { readonly taskId: string }) | null
  readonly asOfSeq: number
}

export interface TaskWindow {
  readonly conversationId: string
  readonly taskId: string
  readonly opened: EventRef
  readonly originEventId: string
  readonly closed: (EventRef & { readonly reason: 'completed' | 'superseded' | 'abandoned' }) | null
  readonly fromSeq: number
  readonly toSeq: number
  readonly open: boolean
  readonly latest: boolean
  readonly requestAfter: boolean
  readonly asOfSeq: number
}

export interface TaskFacts {
  readonly opened: StoredEvent
  readonly latestRevisions: readonly StoredEvent[]
  readonly closed: StoredEvent | null
}

export interface WorkObservations {
  readonly commands: readonly {
    readonly started: EventRef & { readonly actor: string; readonly command: string }
    readonly completed: (EventRef & { readonly exitCode: number | null }) | null
  }[]
  readonly files: readonly (EventRef & {
    readonly actor: string
    readonly source: 'file.change' | 'tool.patch'
    readonly path: string | null
    readonly fileCount: number
  })[]
  readonly failures: readonly (EventRef & {
    readonly kind: 'turn.failed' | 'error'
    readonly actor: string
    readonly text: string
  })[]
  readonly lastActivity: (EventRef & { readonly type: string; readonly actor: string }) | null
  readonly lastOutput: (EventRef & { readonly actor: string; readonly itemRef: string }) | null
  readonly lastReply: (EventRef & { readonly actor: string; readonly excerpt: string }) | null
}

export interface CurrentWork {
  readonly turns: readonly (EventRef & { readonly agentId: string })[]
  readonly approvals: readonly (EventRef & {
    readonly agentId: string
    readonly approvalId: string
  })[]
  readonly questions: readonly (EventRef & {
    readonly agentId: string
    readonly userInputId: string
  })[]
}

export type AssignmentRecord =
  | { readonly kind: 'fact'; readonly event: StoredEvent }
  | { readonly kind: 'observation'; readonly event: StoredEvent }
  | {
      readonly kind: 'output'
      readonly ref: EventRef
      readonly actor: string
      readonly itemRef: string
      readonly stream: string
      readonly bytes: number
    }
  | {
      readonly kind: 'boundary'
      readonly ref: EventRef
      readonly agentId: string
      readonly boundary: 'session.started' | 'session.ended'
      readonly reason: string | null
      readonly resumed: boolean
    }
  | {
      readonly kind: 'refused'
      readonly reason: 'unknown' | 'later' | 'private' | 'unrelated' | 'not-work'
    }

export interface AssignmentScope {
  readonly taskIds: readonly string[]
  readonly window: TaskWindow | null
  readonly asOfSeq: number
  readonly ignoredItemRefPrefixes: readonly string[]
}

export interface WindowMatch extends EventRef {
  readonly actor: string
  readonly type: string
  readonly snippet: string
  readonly clippedStart: boolean
  readonly clippedEnd: boolean
}

export interface WindowSearchPage {
  readonly matches: readonly WindowMatch[]
  readonly total: number
  readonly skip: number
  readonly count: number
}

export const FORWARDED_PAGE = { max: 50, fallback: 20 } as const
export const WINDOW_SEARCH = { max: 50, before: 200, after: 400 } as const
export const WINDOW_SEARCH_TYPES = [
  'agent.message.completed',
  'command.started',
  'tool.started',
  'tool.completed',
  'file.change.completed',
  'error.raised',
] as const
export const OBSERVATION_LIMITS = {
  commands: 5,
  files: 5,
  failures: 3,
  history: 20,
  excerpt: 600,
} as const

interface RefRow {
  readonly seq: number
  readonly id: string
  readonly created_at: number
}

const refOf = (row: RefRow): EventRef => ({ seq: row.seq, eventId: row.id, at: row.created_at })

interface ForwardedRow extends RefRow {
  readonly conversation_id: string
  readonly payload: string
  readonly renamed_title: string | null
  readonly renamed_seq: number | null
  readonly renamed_id: string | null
  readonly renamed_at: number | null
}

const FORWARDED_COLUMNS = `e.seq, e.id, e.conversation_id, e.created_at, e.payload,
  json_extract(r.payload, '$.title') AS renamed_title, r.seq AS renamed_seq,
  r.id AS renamed_id, r.created_at AS renamed_at`

const RENAMED_AS_OF = `LEFT JOIN events r ON r.seq = (
  SELECT MAX(n.seq) FROM events n
   WHERE n.conversation_id = e.conversation_id AND n.type = 'conversation.renamed'
     AND n.seq <= @asOfSeq
)`

const SEARCH_TEXT = `CASE e.type
  WHEN 'agent.message.completed' THEN json_extract(e.payload, '$.text')
  WHEN 'command.started'
    THEN (SELECT group_concat(w.value, ' ') FROM json_each(e.payload, '$.command') w)
  WHEN 'tool.started'
    THEN trim(COALESCE(json_extract(e.payload, '$.name'), '') || ' ' ||
              COALESCE(json_extract(e.payload, '$.detail'), '') || ' ' ||
              COALESCE(json_extract(e.payload, '$.path'), ''))
  WHEN 'tool.completed' THEN json_extract(e.payload, '$.summary')
  WHEN 'file.change.completed'
    THEN (SELECT group_concat(json_extract(f.value, '$.path'), ' ')
            FROM json_each(e.payload, '$.files') f)
  WHEN 'error.raised' THEN json_extract(e.payload, '$.message')
END`

function workClause(prefixes: readonly string[]): {
  readonly clause: string
  readonly params: Record<string, unknown>
} {
  return {
    clause: [
      `actor NOT IN ('user', 'system')`,
      `type NOT IN ('reply.status', 'agent.reasoning.delta')`,
      `COALESCE(json_extract(payload, '$.mode'), '') <> 'discussion'`,
      ...prefixes.map(
        (_, index) =>
          `substr(COALESCE(json_extract(payload, '$.itemRef'), ''), 1, @workLength${String(index)}) <> @workPrefix${String(index)}`
      ),
    ].join(' AND '),
    params: Object.fromEntries(
      prefixes.flatMap((prefix, index): [string, string | number][] => [
        [`workPrefix${String(index)}`, prefix],
        [`workLength${String(index)}`, prefix.length],
      ])
    ),
  }
}

function isWorkEvent(event: StoredEvent, prefixes: readonly string[]): boolean {
  if (event.actor === 'user' || event.actor === 'system') return false
  if (event.type === 'reply.status' || event.type === 'agent.reasoning.delta') return false
  const payload = event.payload as Record<string, unknown>
  if (payload['mode'] === 'discussion') return false
  const itemRef = typeof payload['itemRef'] === 'string' ? payload['itemRef'] : ''
  return !prefixes.some((prefix) => itemRef.startsWith(prefix))
}

const taskIdOfEvent = (event: StoredEvent): string | null =>
  event.payload.type === 'task.opened' ||
  event.payload.type === 'task.revised' ||
  event.payload.type === 'task.closed'
    ? event.payload.taskId
    : null

export const TASK_EVENT_TYPES = ['task.opened', 'task.revised', 'task.closed'] as const

export const TASK_RECORD_TYPES = [
  ...TASK_EVENT_TYPES,
  'turn.started',
  'turn.completed',
  'session.started',
  'session.ended',
  'user.message',
  'usage.blocked',
] as const

export const TASK_WAIT_TYPES = [
  'approval.requested',
  'approval.decided',
  'approval.withdrawn',
  'userinput.requested',
  'userinput.answered',
] as const

export interface TaskRecordOptions {
  readonly ignoredItemRefPrefixes?: readonly string[]
}

export interface TaskRecords {
  readonly events: readonly StoredEvent[]
  readonly evidence: readonly StoredEvent[]
}

export interface TaskOutcomeRecord {
  readonly conversationId: string
  readonly taskId: string
  readonly outcome: NonNullable<Extract<ChorusEventPayload, { type: 'task.closed' }>['outcome']>
}

/**
 * Enough to name a past conversation in a list and decide whether to reopen it.
 *
 * Not the transcript. This answers "which one was that" — the folder, when it
 * was last touched, how much was said in it — and the transcript is fetched by
 * id once one is chosen.
 */
export interface ConversationSummary {
  readonly conversationId: string
  readonly title: string
  /** The project it belongs to. Resolve this for the root, not `cwd`. */
  readonly projectId: string
  /** The last root an agent actually ran in, or empty if none ever did. */
  readonly cwd: string
  /** Every agent that ever had a session in it, not only the last ones. */
  readonly agents: readonly string[]
  readonly updatedAt: number
  readonly messages: number
}

/** One aside, as the badge on its source reply needs it. */
export interface AsideSummary {
  readonly id: string
  readonly sourceEventId: string
  readonly title: string
  readonly createdAt: number
}

/** The raw shape of a `listConversations` row, before the nulls are resolved. */
interface ConversationRow {
  id: string
  title: string
  projectId: string
  updatedAt: number
  messages: number
  agents: string | null
  cwd: string | null
}

/**
 * The append-only log plus its projections.
 *
 * The invariant that everything else leans on: an append and the projection
 * updates it causes land in **one** transaction. A projection can therefore
 * never be ahead of the log, and if it drifts behind it can be rebuilt.
 */
export class EventStore {
  private readonly listeners = new Set<(events: readonly StoredEvent[]) => void>()
  private readonly undelivered: (readonly StoredEvent[])[] = []
  private delivering = false
  /** Set by `close`, so a late write is refused rather than hitting a dead handle. */
  private closed = false
  private droppedAfterClose = 0

  private constructor(private readonly db: Database) {}

  static open(
    db: Database,
    onBeforeMigrate?: (from: number) => string | null
  ): {
    store: EventStore
    migration: MigrationResult
  } {
    const migration = migrate(db, onBeforeMigrate)
    return { store: new EventStore(db), migration }
  }

  /**
   * Notified after events are durably committed, never during the transaction.
   * A listener that ran mid-transaction could observe — or worse, act on —
   * state that a rollback then erases.
   */
  subscribe(listener: (events: readonly StoredEvent[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Validates, assigns position and time, writes, and projects — atomically.
   * `now` is injectable so tests are not at the mercy of the clock.
   */
  /**
   * Returns `null` once the store is closed.
   *
   * Agents keep talking while the app is shutting down — a session being torn
   * down still emits `turn.completed`, and its event pump is a loop nobody
   * awaits. Those writes used to reach a closed database and throw
   * "The database connection is not open" as an unhandled rejection, out of a
   * pump with no catch, which is a crash report for an app that was quitting
   * anyway.
   *
   * Refusing is the honest answer: the log's job is done, and what is being
   * dropped is the tail of a session that is ending regardless. It is counted,
   * so "we lost some" is a number rather than a shrug.
   */
  append(input: AppendInput, now: number = Date.now()): StoredEvent | null {
    if (this.closed) {
      this.droppedAfterClose += 1
      return null
    }
    const stored = this.appendInTransaction(input, now)
    this.notify([stored])
    return stored
  }

  private appendInTransaction(input: AppendInput, now: number): StoredEvent {
    /*
     * Redact before validate, and before anything touches disk.
     *
     * This is the only path into the log, which is the point: a caller cannot
     * opt out, and a payload type added later is covered structurally rather
     * than by remembering to list it (plan §4.4).
     */
    const payload = ChorusEventPayload.parse(redactPayload(input.payload).payload)
    const event = {
      id: uuidv7(),
      conversationId: input.conversationId,
      actor: input.actor,
      type: payload.type,
      payload,
      createdAt: now,
      schemaVersion: SCHEMA_VERSION,
    }

    const run = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO events (id, conversation_id, actor, type, payload, created_at, schema_ver)
           VALUES (@id, @conversationId, @actor, @type, @payload, @createdAt, @schemaVersion)`
        )
        .run({
          id: event.id,
          conversationId: event.conversationId,
          actor: event.actor,
          type: event.type,
          payload: JSON.stringify(event.payload),
          createdAt: event.createdAt,
          schemaVersion: event.schemaVersion,
        })

      const stored: StoredEvent = { ...event, seq: Number(info.lastInsertRowid) }
      applyToProjections(this.db, stored)
      this.bumpProjectionState(stored.seq)
      return stored
    })

    return run()
  }

  /** One transaction for the whole batch — used by the delta buffer's flush. */
  appendMany(inputs: readonly AppendInput[], now: number = Date.now()): StoredEvent[] {
    if (this.closed) {
      this.droppedAfterClose += inputs.length
      return []
    }
    const run = this.db.transaction(() => inputs.map((i) => this.appendInTransaction(i, now)))
    const stored = run()
    this.notify(stored)
    return stored
  }

  read(conversationId: string, options: ReadOptions = {}): StoredEvent[] {
    const { where, params } = eventFilter(conversationId, options)
    const limit = options.limit === undefined ? '' : ` LIMIT ${String(options.limit)}`
    const rows = this.db
      .prepare(
        `SELECT seq, id, conversation_id, actor, type, payload, created_at, schema_ver
           FROM events WHERE ${where} ORDER BY seq${limit}`
      )
      .all(params)

    return rows.flatMap((r) => toStoredEvent(r) ?? [])
  }

  count(conversationId: string, options: Pick<ReadOptions, 'afterSeq' | 'types'> = {}): number {
    const { where, params } = eventFilter(conversationId, options)
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${where}`).get(params)
    return (row as { n: number }).n
  }

  /**
   * The last `limit` events before `beforeSeq`, oldest first.
   *
   * **A suffix, because that is what opening a conversation wants.** `read` with
   * `afterSeq` answers "what has happened since", which is the live path; this
   * answers "what was said most recently", which is the first paint. Scrolling
   * back is the same call again with `beforeSeq` set to the oldest `seq` already
   * held.
   *
   * `DESC` in SQL and reversed here rather than `ORDER BY seq` with an offset:
   * an offset into a *filtered* set shifts meaning the moment the filter
   * changes, and `LIMIT` on a descending scan is the query SQLite can answer
   * from the index without walking the conversation.
   */
  readPage(
    conversationId: string,
    options: { beforeSeq?: number; limit: number; types?: readonly string[] }
  ): StoredEvent[] {
    const clauses = ['conversation_id = @conversationId']
    const params: Record<string, unknown> = { conversationId, limit: options.limit }

    if (options.beforeSeq !== undefined) {
      clauses.push('seq < @beforeSeq')
      params['beforeSeq'] = options.beforeSeq
    }
    if (options.types !== undefined && options.types.length > 0) {
      // Inlined because SQLite has no array binding; values come from our own
      // event-type union, never from user input.
      const list = options.types.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')
      clauses.push(`type IN (${list})`)
    }

    const rows = this.db
      .prepare(
        `SELECT seq, id, conversation_id, actor, type, payload, created_at, schema_ver
           FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT @limit`
      )
      .all(params)

    return rows.flatMap((r) => toStoredEvent(r) ?? []).reverse()
  }

  /**
   * Transcript state that a page cannot contain, queried rather than folded.
   *
   * **This is the answer to the plan's oldest open question.** A page is a
   * suffix, so anything derived by accumulation — an approval requested long
   * before the page, a question still waiting, what has been spent — cannot be
   * rebuilt from it. The alternative was a *checkpoint* shipped with the page,
   * and that is a snapshot of derived state: a second source of truth for
   * something the log already determines. Projections are how this codebase
   * reconciles that instead, because they commit in the same transaction as the
   * append and can always be rebuilt from the log.
   *
   * `working` and `usageByActor` are queried straight from `events` rather than
   * from a projection, because both are "the latest one of these per agent" —
   * an indexed lookup, not accumulated state, and a projection for them would be
   * a table maintaining what a query already answers.
   */
  transcriptState(conversationId: string): TranscriptState {
    const approvals = this.db
      .prepare(
        `SELECT a.id, a.agent_id, a.kind, a.request, a.expires_at,
                (SELECT e.payload FROM events e
                  WHERE e.conversation_id = a.conversation_id
                    AND e.type = 'approval.requested'
                    AND json_extract(e.payload, '$.approvalId') = a.id
                  ORDER BY e.seq DESC LIMIT 1) AS requested
           FROM approvals a WHERE a.conversation_id = @conversationId AND a.outcome IS NULL
          ORDER BY a.created_at`
      )
      .all({ conversationId }) as {
      id: string
      agent_id: string | null
      kind: string
      request: string
      expires_at: number
      requested: string | null
    }[]

    const questions = this.db
      .prepare(
        `SELECT q.id, q.agent_id, q.event_id, q.request, q.expires_at,
                e.payload AS requested
           FROM questions q LEFT JOIN events e ON e.id = q.event_id
          WHERE q.conversation_id = @conversationId AND q.answered_at IS NULL
          ORDER BY q.created_at`
      )
      .all({ conversationId }) as {
      id: string
      agent_id: string | null
      event_id: string
      request: string
      expires_at: number
      requested: string | null
    }[]

    const open = this.openTurns(conversationId)
    const working = [...open.keys()]
    const workingSince = Object.fromEntries(
      [...open.entries()].map(([actor, turn]) => [actor, turn.at] as const)
    )

    const usageRows = this.db
      .prepare(
        `SELECT actor, payload FROM events
          WHERE conversation_id = @conversationId AND type = 'usage.updated'
            AND seq IN (
              SELECT MAX(seq) FROM events
               WHERE conversation_id = @conversationId AND type = 'usage.updated'
               GROUP BY actor
            )`
      )
      .all({ conversationId }) as { actor: string; payload: string }[]

    const usageByActor: Record<
      string,
      { inputTokens: number; outputTokens: number; costUsd: number | null }
    > = {}
    for (const row of usageRows) {
      const parsed = JSON.parse(row.payload) as Record<string, unknown>
      usageByActor[row.actor] = {
        inputTokens: typeof parsed['inputTokens'] === 'number' ? parsed['inputTokens'] : 0,
        outputTokens: typeof parsed['outputTokens'] === 'number' ? parsed['outputTokens'] : 0,
        costUsd: typeof parsed['costUsd'] === 'number' ? parsed['costUsd'] : null,
      }
    }

    const safeParse = (raw: string): unknown => {
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    }

    const provenance = (raw: string | null): { mode?: 'discussion'; requestId?: string } => {
      const requested = raw === null ? null : safeParse(raw)
      if (typeof requested !== 'object' || requested === null) return {}
      const record = requested as Record<string, unknown>
      const requestId = record['requestId']
      return {
        ...(record['mode'] === 'discussion' ? { mode: 'discussion' as const } : {}),
        ...(typeof requestId === 'string' && requestId !== '' ? { requestId } : {}),
      }
    }

    return {
      approvals: approvals.map((a) => ({
        approvalId: a.id,
        agentId: a.agent_id ?? '',
        kind: a.kind,
        request: safeParse(a.request),
        expiresAt: a.expires_at,
        ...provenance(a.requested),
      })),
      questions: questions.map((q) => ({
        userInputId: q.id,
        eventId: q.event_id,
        agentId: q.agent_id ?? '',
        request: safeParse(q.request),
        expiresAt: q.expires_at,
        ...provenance(q.requested),
      })),
      working,
      workingSince,
      usageByActor,
      assignment: this.transcriptAssignment(conversationId),
    }
  }

  private transcriptAssignment(conversationId: string): TranscriptAssignment {
    const created = this.db
      .prepare(
        `SELECT json_extract(payload, '$.continuedFrom') AS parent FROM events
          WHERE conversation_id = @conversationId AND type = 'conversation.created'
          ORDER BY seq LIMIT 1`
      )
      .get({ conversationId }) as { parent: unknown } | undefined
    const parent = typeof created?.parent === 'string' ? created.parent : null
    const linked =
      parent !== null &&
      this.forwardedChild(parent, conversationId, Number.MAX_SAFE_INTEGER) !== null
    if (!linked) return { linked: false, boundTaskId: null }
    const bound = this.db
      .prepare(
        `SELECT json_extract(payload, '$.taskId') AS task_id FROM events
          WHERE conversation_id = @conversationId AND type = 'assignment.bound'
          ORDER BY seq DESC LIMIT 1`
      )
      .get({ conversationId }) as { task_id: unknown } | undefined
    return {
      linked: true,
      boundTaskId: typeof bound?.task_id === 'string' ? bound.task_id : null,
    }
  }

  liveState(conversationId: string, options: LiveStateOptions): LiveState {
    const prefixes = options.ignoredItemRefPrefixes ?? []
    const prefixParams = Object.fromEntries(
      prefixes.flatMap((prefix, index): [string, string | number][] => [
        [`prefix${String(index)}`, prefix],
        [`length${String(index)}`, prefix.length],
      ])
    )
    const ownRefs = prefixes
      .map(
        (_, index) =>
          `AND substr(COALESCE(json_extract(payload, '$.itemRef'), ''), 1, @length${String(index)}) <> @prefix${String(index)}`
      )
      .join(' ')

    const workOperations = this.db.prepare(
      `SELECT type, payload, created_at FROM events
        WHERE conversation_id = @conversationId AND actor = @actor AND seq > @after
          AND type IN ('tool.started', 'command.started', 'tool.completed', 'command.completed')
          ${ownRefs}
        ORDER BY seq`
    )
    const workEvidence = this.db.prepare(
      `SELECT MAX(created_at) AS at FROM events
        WHERE conversation_id = @conversationId AND actor = @actor AND seq >= @after
          AND type <> 'reply.status'
          AND COALESCE(json_extract(payload, '$.mode'), '') <> 'discussion'
          ${ownRefs}`
    )
    const work: LiveWorkRow[] = []
    const operations: LiveOperationRow[] = []
    for (const [agentId, turn] of this.openTurns(conversationId)) {
      const params = { conversationId, actor: agentId, after: turn.seq, ...prefixParams }
      operations.push(
        ...openOperations(
          workOperations.all(params) as OperationEventRow[],
          agentId,
          null,
          turn.seq
        )
      )
      const evidence = workEvidence.get(params) as { at: number | null } | undefined
      work.push({
        agentId,
        generation: turn.seq,
        startedAt: turn.at,
        evidenceAt: evidence?.at ?? turn.at,
      })
    }

    const chatStart = this.db.prepare(
      `SELECT MIN(seq) AS seq, MIN(created_at) AS at FROM events
        WHERE conversation_id = @conversationId AND type = 'reply.status'
          AND json_extract(payload, '$.requestId') = @requestId`
    )
    const chatOperations = this.db.prepare(
      `SELECT type, payload, created_at FROM events
        WHERE conversation_id = @conversationId AND seq > @after
          AND type IN ('tool.started', 'command.started', 'tool.completed', 'command.completed')
          AND substr(COALESCE(json_extract(payload, '$.itemRef'), ''), 1, @length) = @prefix
        ORDER BY seq`
    )
    const chatEvidence = this.db.prepare(
      `SELECT MAX(created_at) AS at FROM events
        WHERE conversation_id = @conversationId AND seq >= @after
          AND (substr(COALESCE(json_extract(payload, '$.itemRef'), ''), 1, @length) = @prefix
            OR (type IN ('reply.status', 'approval.requested', 'userinput.requested')
                AND json_extract(payload, '$.requestId') = @requestId))`
    )
    const chat: LiveChatRow[] = []
    for (const request of options.chatRequests) {
      const start = chatStart.get({ conversationId, requestId: request.requestId }) as
        { seq: number | null; at: number | null } | undefined
      const startSeq = start?.seq ?? null
      const startedAt = start?.at ?? null
      if (startSeq === null || startedAt === null) continue
      const prefix = `${request.requestId}:`
      const bounds = { conversationId, after: startSeq, prefix, length: prefix.length }
      operations.push(
        ...openOperations(
          chatOperations.all(bounds) as OperationEventRow[],
          request.agentId,
          request.requestId,
          0
        )
      )
      const evidence = chatEvidence.get({ ...bounds, requestId: request.requestId }) as
        { at: number | null } | undefined
      chat.push({
        requestId: request.requestId,
        agentId: request.agentId,
        startedAt,
        evidenceAt: evidence?.at ?? startedAt,
      })
    }

    const interaction = this.db
      .prepare(
        `SELECT MAX(seq) AS seq FROM events
          WHERE conversation_id = @conversationId AND type = 'user.message'
            AND COALESCE(json_extract(payload, '$.mode'), '') <> 'discussion'
            AND COALESCE(json_extract(payload, '$.live'), 0) <> 1`
      )
      .get({ conversationId }) as { seq: number | null } | undefined
    const handoffRows = this.db
      .prepare(
        `SELECT type, payload, created_at FROM events
          WHERE conversation_id = @conversationId AND seq > @after
            AND type IN ('handoff.created', 'handoff.outcome')
          ORDER BY seq`
      )
      .all({ conversationId, after: interaction?.seq ?? 0 }) as OperationEventRow[]

    return { work, chat, operations, handoffs: foldHandoffs(handoffRows) }
  }

  /*
   * The last turn boundary per agent. A turn that started after the last one
   * completed is a turn still running — which is what `working` means, and
   * what drives the live indicator on each voice.
   */
  private openTurns(
    conversationId: string,
    asOfSeq: number = Number.MAX_SAFE_INTEGER
  ): Map<string, { seq: number; at: number; id: string }> {
    const turns = this.db
      .prepare(
        `SELECT actor, type, MAX(seq) AS seq, created_at, id
           FROM events
          WHERE conversation_id = @conversationId AND type IN ('turn.started', 'turn.completed')
            AND seq <= @asOfSeq
          GROUP BY actor, type`
      )
      .all({ conversationId, asOfSeq }) as {
      actor: string
      type: string
      seq: number
      created_at: number
      id: string
    }[]

    const started = new Map<string, number>()
    const startedAt = new Map<string, { at: number; id: string }>()
    const completed = new Map<string, number>()
    for (const row of turns) {
      ;(row.type === 'turn.started' ? started : completed).set(row.actor, row.seq)
      if (row.type === 'turn.started') startedAt.set(row.actor, { at: row.created_at, id: row.id })
    }
    const boundaries = this.db
      .prepare(
        `SELECT json_extract(payload, '$.agentId') AS agent, MAX(seq) AS seq
           FROM events
          WHERE conversation_id = @conversationId
            AND type IN ('session.started', 'session.ended')
            AND seq <= @asOfSeq
          GROUP BY agent`
      )
      .all({ conversationId, asOfSeq }) as { agent: string | null; seq: number }[]
    const sessionBoundary = new Map(
      boundaries.flatMap((row) => (row.agent === null ? [] : [[row.agent, row.seq] as const]))
    )
    const open = new Map<string, { seq: number; at: number; id: string }>()
    for (const [actor, seq] of started) {
      if (seq <= Math.max(completed.get(actor) ?? 0, sessionBoundary.get(actor) ?? 0)) continue
      const start = startedAt.get(actor)
      if (start !== undefined) open.set(actor, { seq, at: start.at, id: start.id })
    }
    return open
  }

  taskEvents(conversationId: string): StoredEvent[] {
    const opened = this.latestTaskOpened(conversationId)
    if (opened === null) return []
    return this.read(conversationId, { afterSeq: opened.seq - 1, types: TASK_EVENT_TYPES })
  }

  taskRecords(conversationId: string, options: TaskRecordOptions = {}): TaskRecords | null {
    const opened = this.latestTaskOpened(conversationId)
    if (opened?.payload.type !== 'task.opened') return null
    return this.recordsFrom(conversationId, opened, null, options)
  }

  taskRecordsFor(window: TaskWindow, options: TaskRecordOptions = {}): TaskRecords | null {
    const opened = this.eventIn(window.conversationId, window.opened.eventId)
    if (opened?.payload.type !== 'task.opened') return null
    if (opened.payload.taskId !== window.taskId) return null
    return this.recordsFrom(window.conversationId, opened, window, options)
  }

  private recordsFrom(
    conversationId: string,
    opened: StoredEvent,
    window: TaskWindow | null,
    options: TaskRecordOptions
  ): TaskRecords {
    if (opened.payload.type !== 'task.opened') return { events: [], evidence: [] }
    const { originEventId, startedAt } = opened.payload
    const origin = this.db
      .prepare('SELECT seq FROM events WHERE id = @id AND conversation_id = @conversationId')
      .get({ id: originEventId, conversationId }) as { seq: number } | undefined
    const fromSeq = Math.min(origin?.seq ?? opened.seq, opened.seq)
    const toSeq = window?.toSeq ?? Number.MAX_SAFE_INTEGER
    const columns = 'seq, id, conversation_id, actor, type, payload, created_at, schema_ver'
    const rows = (sql: string, params: Record<string, unknown>): StoredEvent[] =>
      this.db
        .prepare(sql)
        .all(params)
        .flatMap((row) => toStoredEvent(row) ?? [])

    const recordTypes = TASK_RECORD_TYPES.map((type) => `'${type}'`).join(', ')
    const inRange =
      window === null
        ? this.read(conversationId, { afterSeq: fromSeq - 1, types: TASK_RECORD_TYPES })
        : rows(
            `SELECT ${columns} FROM events
              WHERE conversation_id = @conversationId AND seq >= @fromSeq AND seq <= @toSeq
                AND type IN (${recordTypes})
              ORDER BY seq`,
            { conversationId, fromSeq, toSeq }
          ).filter((event) => {
            const taskId = taskIdOfEvent(event)
            return taskId === null || taskId === window.taskId
          })
    const waits = rows(
      `SELECT ${columns} FROM events e
        WHERE e.conversation_id = @conversationId AND e.seq >= @fromSeq AND e.seq <= @toSeq
          AND e.type IN ('approval.requested', 'approval.decided', 'approval.withdrawn',
                         'userinput.requested', 'userinput.answered')
          AND NOT (
            e.type IN ('approval.requested', 'approval.decided') AND EXISTS (
              SELECT 1 FROM approvals a
               WHERE a.id = json_extract(e.payload, '$.approvalId') AND a.decided_by = 'policy'
            )
          )
        ORDER BY e.seq`,
      { conversationId, fromSeq, toSeq }
    )
    const pendingApprovals = rows(
      `SELECT e.seq, e.id, e.conversation_id, e.actor, e.type, e.payload, e.created_at, e.schema_ver
         FROM approvals a
         JOIN events e
           ON e.conversation_id = a.conversation_id AND e.type = 'approval.requested'
          AND json_extract(e.payload, '$.approvalId') = a.id
        WHERE a.conversation_id = @conversationId AND a.created_at <= @startedAt
          AND e.seq < @fromSeq
          AND (a.decided_by IS NULL OR a.decided_by <> 'policy')
          AND (a.decided_at IS NULL OR a.decided_at >= @startedAt)`,
      { conversationId, fromSeq, startedAt }
    )
    const pendingQuestions = rows(
      `SELECT e.seq, e.id, e.conversation_id, e.actor, e.type, e.payload, e.created_at, e.schema_ver
         FROM questions q
         JOIN events e ON e.id = q.event_id
        WHERE q.conversation_id = @conversationId AND e.seq < @fromSeq
          AND (q.answered_at IS NULL OR q.answered_at >= @startedAt)`,
      { conversationId, fromSeq, startedAt }
    )
    const before = rows(
      `SELECT ${columns} FROM events
        WHERE seq IN (
          SELECT MAX(seq) FROM events
           WHERE conversation_id = @conversationId AND seq < @fromSeq
             AND type IN ('turn.started', 'turn.completed', 'usage.blocked')
           GROUP BY actor, type
          UNION
          SELECT MAX(seq) FROM events
           WHERE conversation_id = @conversationId AND seq < @fromSeq
             AND type IN ('session.started', 'session.ended')
           GROUP BY json_extract(payload, '$.agentId'), type
        )`,
      { conversationId, fromSeq }
    )

    const prefixes = options.ignoredItemRefPrefixes ?? []
    const prefixParams = Object.fromEntries(
      prefixes.flatMap((prefix, index): [string, string | number][] => [
        [`prefix${String(index)}`, prefix],
        [`length${String(index)}`, prefix.length],
      ])
    )
    const prefixClauses = prefixes
      .map(
        (_, index) =>
          `AND substr(COALESCE(json_extract(payload, '$.itemRef'), ''), 1, @length${String(index)}) <> @prefix${String(index)}`
      )
      .join(' ')
    const lastWork = this.db.prepare(
      `SELECT ${columns} FROM events
        WHERE conversation_id = @conversationId AND actor = @actor AND seq < @markerSeq
          AND type NOT IN ('task.opened', 'task.closed')
          AND COALESCE(json_extract(payload, '$.mode'), '') <> 'discussion'
          ${prefixClauses}
        ORDER BY seq DESC LIMIT 1`
    )
    const evidence = [...before, ...inRange].flatMap((event) => {
      const { payload } = event
      const agentId =
        payload.type === 'session.started' ||
        (payload.type === 'session.ended' && payload.reason === 'crashed')
          ? payload.agentId
          : null
      if (agentId === null) return []
      const row = lastWork.get({
        conversationId,
        actor: agentId,
        markerSeq: event.seq,
        ...prefixParams,
      })
      return row === undefined ? [] : (toStoredEvent(row) ?? [])
    })

    const participants = new Set<string>()
    for (const event of [...before, ...inRange]) {
      const { payload } = event
      if (payload.type === 'session.started' || payload.type === 'session.ended') {
        participants.add(payload.agentId)
      } else if (payload.type === 'turn.started' || payload.type === 'turn.completed') {
        participants.add(event.actor)
      }
    }
    const current = [...participants].flatMap((actor) => {
      const row = lastWork.get({
        conversationId,
        actor,
        markerSeq: window === null ? Number.MAX_SAFE_INTEGER : window.toSeq + 1,
        ...prefixParams,
      })
      return row === undefined ? [] : (toStoredEvent(row) ?? [])
    })

    const bySeq = new Map<number, StoredEvent>()
    const all = [...before, ...pendingApprovals, ...pendingQuestions, ...inRange, ...waits]
    for (const event of all) bySeq.set(event.seq, event)
    const evidenceBySeq = new Map([...evidence, ...current].map((event) => [event.seq, event]))
    return {
      events: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
      evidence: [...evidenceBySeq.values()].sort((a, b) => a.seq - b.seq),
    }
  }

  forwardedChildren(
    parentConversationId: string,
    page: { readonly skip: number; readonly count: number; readonly asOfSeq: number }
  ): ForwardedChildPage {
    const skip = Math.max(0, Math.floor(page.skip))
    const count = Math.min(Math.max(1, Math.floor(page.count)), FORWARDED_PAGE.max)
    const where = `e.type = 'conversation.created' AND e.seq <= @asOfSeq
                   AND json_extract(e.payload, '$.continuedFrom') = @parent`
    const params = { parent: parentConversationId, asOfSeq: page.asOfSeq }
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM events e WHERE ${where}`).get(params) as {
        n: number
      }
    ).n
    const rows = this.db
      .prepare(
        `SELECT ${FORWARDED_COLUMNS}
           FROM events e ${RENAMED_AS_OF}
          WHERE ${where}
          ORDER BY e.seq DESC LIMIT @count OFFSET @skip`
      )
      .all({ ...params, count, skip }) as ForwardedRow[]
    return {
      children: rows.flatMap((row) => {
        const child = this.forwardedChildOf(row)
        return child === null ? [] : [child]
      }),
      total,
      skip,
      count,
      asOfSeq: page.asOfSeq,
    }
  }

  forwardedChild(
    parentConversationId: string,
    childConversationId: string,
    asOfSeq: number
  ): ForwardedChild | null {
    const row = this.db
      .prepare(
        `SELECT ${FORWARDED_COLUMNS}
           FROM events e ${RENAMED_AS_OF}
          WHERE e.conversation_id = @child AND e.type = 'conversation.created'
            AND e.seq <= @asOfSeq AND json_extract(e.payload, '$.continuedFrom') = @parent
          ORDER BY e.seq LIMIT 1`
      )
      .get({ parent: parentConversationId, child: childConversationId, asOfSeq }) as
      ForwardedRow | undefined
    return row === undefined ? null : this.forwardedChildOf(row)
  }

  assignmentBinding(childConversationId: string, asOfSeq: number): AssignmentBinding {
    const history = (
      this.db
        .prepare(
          `SELECT seq, id, created_at, payload FROM events
            WHERE conversation_id = @child AND type = 'assignment.bound' AND seq <= @asOfSeq
            ORDER BY seq DESC LIMIT @limit`
        )
        .all({
          child: childConversationId,
          asOfSeq,
          limit: OBSERVATION_LIMITS.history,
        }) as (RefRow & { payload: string })[]
    ).flatMap((row): AssignmentBindingRecord[] => {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      const taskId = payload['taskId']
      const previous = payload['previousTaskId']
      return typeof taskId === 'string'
        ? [
            {
              ref: refOf(row),
              taskId,
              previousTaskId: typeof previous === 'string' ? previous : null,
            },
          ]
        : []
    })
    const first = this.db
      .prepare(
        `SELECT seq, id, created_at, json_extract(payload, '$.taskId') AS task_id FROM events
          WHERE conversation_id = @child AND type = 'task.opened' AND seq <= @asOfSeq
          ORDER BY seq LIMIT 1`
      )
      .get({ child: childConversationId, asOfSeq }) as
      (RefRow & { task_id: string | null }) | undefined
    const suggested = first?.task_id ?? null
    return {
      current: history[0] ?? null,
      history,
      suggestion:
        first === undefined || suggested === null ? null : { ...refOf(first), taskId: suggested },
      asOfSeq,
    }
  }

  taskWindow(conversationId: string, taskId: string, asOfSeq: number): TaskWindow | null {
    const opened = this.db
      .prepare(
        `SELECT seq, id, conversation_id, actor, type, payload, created_at, schema_ver
           FROM events
          WHERE conversation_id = @conversationId AND type = 'task.opened'
            AND json_extract(payload, '$.taskId') = @taskId AND seq <= @asOfSeq
          ORDER BY seq LIMIT 1`
      )
      .get({ conversationId, taskId, asOfSeq })
    if (opened === undefined) return null
    const event = toStoredEvent(opened)
    if (event?.payload.type !== 'task.opened') return null
    const { originEventId } = event.payload
    const origin = this.db
      .prepare('SELECT seq FROM events WHERE id = @id AND conversation_id = @conversationId')
      .get({ id: originEventId, conversationId }) as { seq: number } | undefined
    const after = { conversationId, openedSeq: event.seq, asOfSeq }
    const bounds = { ...after, taskId }
    const closed = this.db
      .prepare(
        `SELECT seq, id, created_at, json_extract(payload, '$.reason') AS reason FROM events
          WHERE conversation_id = @conversationId AND type = 'task.closed'
            AND json_extract(payload, '$.taskId') = @taskId
            AND seq > @openedSeq AND seq <= @asOfSeq
          ORDER BY seq LIMIT 1`
      )
      .get(bounds) as (RefRow & { reason: string }) | undefined
    const next = this.db
      .prepare(
        `SELECT seq FROM events
          WHERE conversation_id = @conversationId AND type = 'task.opened'
            AND seq > @openedSeq AND seq <= @asOfSeq
          ORDER BY seq LIMIT 1`
      )
      .get(after) as { seq: number } | undefined
    const requestAfter =
      this.db
        .prepare(
          `SELECT 1 FROM events
            WHERE conversation_id = @conversationId AND type = 'user.message'
              AND seq > @openedSeq AND seq <= @asOfSeq
              AND COALESCE(json_extract(payload, '$.mode'), '') <> 'discussion'
              AND COALESCE(json_extract(payload, '$.live'), 0) <> 1
            LIMIT 1`
        )
        .get(after) !== undefined
    const reason =
      closed?.reason === 'completed' ||
      closed?.reason === 'superseded' ||
      closed?.reason === 'abandoned'
        ? closed.reason
        : null
    return {
      conversationId,
      taskId,
      opened: { seq: event.seq, eventId: event.id, at: event.createdAt },
      originEventId,
      closed: closed === undefined || reason === null ? null : { ...refOf(closed), reason },
      fromSeq: Math.min(origin?.seq ?? event.seq, event.seq),
      toSeq: Math.min(
        closed?.seq ?? Number.MAX_SAFE_INTEGER,
        next === undefined ? Number.MAX_SAFE_INTEGER : next.seq - 1,
        asOfSeq
      ),
      open: closed === undefined && next === undefined,
      latest: next === undefined,
      requestAfter,
      asOfSeq,
    }
  }

  taskFacts(window: TaskWindow): TaskFacts | null {
    const opened = this.eventIn(window.conversationId, window.opened.eventId)
    if (opened === null) return null
    const columns = 'seq, id, conversation_id, actor, type, payload, created_at, schema_ver'
    const scope = {
      conversationId: window.conversationId,
      taskId: window.taskId,
      toSeq: window.toSeq,
    }
    const latestRevisions = this.db
      .prepare(
        `SELECT ${columns} FROM events
          WHERE seq IN (
            SELECT MAX(seq) FROM events
             WHERE conversation_id = @conversationId AND type = 'task.revised'
               AND json_extract(payload, '$.taskId') = @taskId AND seq <= @toSeq
             GROUP BY json_extract(payload, '$.agentId')
          )
          ORDER BY seq`
      )
      .all(scope)
      .flatMap((row) => toStoredEvent(row) ?? [])
    return {
      opened,
      latestRevisions,
      closed:
        window.closed === null ? null : this.eventIn(window.conversationId, window.closed.eventId),
    }
  }

  windowObservations(
    window: TaskWindow,
    options: { readonly ignoredItemRefPrefixes: readonly string[] }
  ): WorkObservations {
    const work = workClause(options.ignoredItemRefPrefixes)
    const bounds = {
      conversationId: window.conversationId,
      fromSeq: window.fromSeq,
      toSeq: window.toSeq,
    }
    const scope = { ...bounds, ...work.params }
    const inWindow = 'conversation_id = @conversationId AND seq >= @fromSeq AND seq <= @toSeq'

    const commands = (
      this.db
        .prepare(
          `SELECT seq, id, created_at, actor, payload FROM events
            WHERE ${inWindow} AND type = 'command.started' AND ${work.clause}
            ORDER BY seq DESC LIMIT @limit`
        )
        .all({ ...scope, limit: OBSERVATION_LIMITS.commands }) as (RefRow & {
        actor: string
        payload: string
      })[]
    ).map((row) => {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      const words = Array.isArray(payload['command']) ? payload['command'] : []
      const itemRef = typeof payload['itemRef'] === 'string' ? payload['itemRef'] : ''
      const completed = this.db
        .prepare(
          `SELECT c.seq, c.id, c.created_at, json_extract(c.payload, '$.exitCode') AS exit_code
             FROM events c
            WHERE c.conversation_id = @conversationId AND c.type = 'command.completed'
              AND c.actor = @actor AND json_extract(c.payload, '$.itemRef') = @itemRef
              AND c.seq > @startedSeq AND c.seq <= @toSeq
              AND NOT EXISTS (
                SELECT 1 FROM events x
                 WHERE x.conversation_id = c.conversation_id
                   AND x.seq > @startedSeq AND x.seq < c.seq
                   AND ((x.type = 'command.started' AND x.actor = @actor
                         AND json_extract(x.payload, '$.itemRef') = @itemRef)
                        OR (x.type IN ('session.started', 'session.ended')
                            AND json_extract(x.payload, '$.agentId') = @actor))
              )
            ORDER BY c.seq LIMIT 1`
        )
        .get({
          conversationId: window.conversationId,
          actor: row.actor,
          itemRef,
          startedSeq: row.seq,
          toSeq: window.toSeq,
        }) as (RefRow & { exit_code: number | null }) | undefined
      return {
        started: {
          ...refOf(row),
          actor: row.actor,
          command: words.filter((part): part is string => typeof part === 'string').join(' '),
        },
        completed:
          completed === undefined ? null : { ...refOf(completed), exitCode: completed.exit_code },
      }
    })

    const files = (
      this.db
        .prepare(
          `SELECT seq, id, created_at, actor, type,
                  CASE WHEN type = 'file.change.completed'
                       THEN json_extract(payload, '$.files[0].path')
                       ELSE (SELECT NULLIF(json_extract(s.payload, '$.path'), '') FROM events s
                              WHERE s.conversation_id = e.conversation_id AND s.type = 'tool.started'
                                AND s.actor = e.actor
                                AND json_extract(s.payload, '$.itemRef') = json_extract(e.payload, '$.itemRef')
                                AND s.seq >= @fromSeq AND s.seq < e.seq
                                AND NOT EXISTS (
                                  SELECT 1 FROM events x
                                   WHERE x.conversation_id = e.conversation_id
                                     AND x.seq > s.seq AND x.seq < e.seq
                                     AND ((x.type = 'tool.completed' AND x.actor = e.actor
                                           AND json_extract(x.payload, '$.itemRef') = json_extract(e.payload, '$.itemRef'))
                                          OR (x.type IN ('session.started', 'session.ended')
                                              AND json_extract(x.payload, '$.agentId') = e.actor))
                                )
                              ORDER BY s.seq DESC LIMIT 1)
                  END AS path,
                  CASE WHEN type = 'file.change.completed'
                       THEN COALESCE(json_array_length(payload, '$.files'), 0)
                       ELSE 1
                  END AS file_count
             FROM events e
            WHERE ${inWindow} AND ${work.clause}
              AND ((type = 'file.change.completed' AND json_extract(payload, '$.outcome') = 'applied')
                   OR (type = 'tool.completed' AND COALESCE(json_extract(payload, '$.patch'), '') <> ''))
            ORDER BY seq DESC LIMIT @limit`
        )
        .all({ ...scope, limit: OBSERVATION_LIMITS.files }) as (RefRow & {
        actor: string
        type: string
        path: string | null
        file_count: number
      })[]
    ).map((row) => ({
      ...refOf(row),
      actor: row.actor,
      source:
        row.type === 'file.change.completed' ? ('file.change' as const) : ('tool.patch' as const),
      path: row.path,
      fileCount: row.file_count,
    }))

    const failures = (
      this.db
        .prepare(
          `SELECT seq, id, created_at, actor, type, json_extract(payload, '$.message') AS message
             FROM events
            WHERE ${inWindow}
              AND ((type = 'turn.completed' AND json_extract(payload, '$.status') = 'failed'
                    AND actor NOT IN ('user', 'system'))
                   OR type = 'error.raised')
            ORDER BY seq DESC LIMIT @limit`
        )
        .all({ ...bounds, limit: OBSERVATION_LIMITS.failures }) as (RefRow & {
        actor: string
        type: string
        message: string | null
      })[]
    ).map((row) => ({
      ...refOf(row),
      kind: row.type === 'error.raised' ? ('error' as const) : ('turn.failed' as const),
      actor: row.actor,
      text: row.message ?? '',
    }))

    const lastActivity = this.db
      .prepare(
        `SELECT seq, id, created_at, type, actor FROM events
          WHERE ${inWindow} AND ${work.clause}
          ORDER BY seq DESC LIMIT 1`
      )
      .get(scope) as (RefRow & { type: string; actor: string }) | undefined
    const lastOutput = this.db
      .prepare(
        `SELECT seq, id, created_at, actor, json_extract(payload, '$.itemRef') AS item_ref
           FROM events
          WHERE ${inWindow} AND type = 'command.output' AND ${work.clause}
          ORDER BY seq DESC LIMIT 1`
      )
      .get(scope) as (RefRow & { actor: string; item_ref: string | null }) | undefined
    const lastReply = this.db
      .prepare(
        `SELECT seq, id, created_at, actor, json_extract(payload, '$.text') AS text FROM events
          WHERE ${inWindow} AND type = 'agent.message.completed' AND ${work.clause}
          ORDER BY seq DESC LIMIT 1`
      )
      .get(scope) as (RefRow & { actor: string; text: string | null }) | undefined

    return {
      commands,
      files,
      failures,
      lastActivity:
        lastActivity === undefined
          ? null
          : { ...refOf(lastActivity), type: lastActivity.type, actor: lastActivity.actor },
      lastOutput:
        lastOutput === undefined
          ? null
          : { ...refOf(lastOutput), actor: lastOutput.actor, itemRef: lastOutput.item_ref ?? '' },
      lastReply:
        lastReply === undefined
          ? null
          : {
              ...refOf(lastReply),
              actor: lastReply.actor,
              excerpt: Array.from(lastReply.text ?? '')
                .slice(0, OBSERVATION_LIMITS.excerpt)
                .join(''),
            },
    }
  }

  currentWork(window: TaskWindow): CurrentWork | null {
    if (!window.open || !window.latest || window.requestAfter) return null
    const conversationId = window.conversationId
    const bounds = { conversationId, fromSeq: window.fromSeq, asOfSeq: window.asOfSeq }
    const turns = [...this.openTurns(conversationId, window.asOfSeq)].flatMap(([agentId, turn]) =>
      turn.seq >= window.fromSeq ? [{ seq: turn.seq, eventId: turn.id, at: turn.at, agentId }] : []
    )
    const approvals = (
      this.db
        .prepare(
          `SELECT e.seq, e.id, e.created_at, e.actor,
                  json_extract(e.payload, '$.approvalId') AS approval_id
             FROM events e
            WHERE e.conversation_id = @conversationId AND e.type = 'approval.requested'
              AND e.seq >= @fromSeq AND e.seq <= @asOfSeq
              AND COALESCE(json_extract(e.payload, '$.mode'), '') <> 'discussion'
              AND NOT EXISTS (
                SELECT 1 FROM events d
                 WHERE d.conversation_id = e.conversation_id
                   AND d.type IN ('approval.decided', 'approval.withdrawn')
                   AND d.seq > e.seq AND d.seq <= @asOfSeq
                   AND json_extract(d.payload, '$.approvalId') = json_extract(e.payload, '$.approvalId')
              )
            ORDER BY e.seq`
        )
        .all(bounds) as (RefRow & {
        actor: string
        approval_id: string
      })[]
    ).map((row) => ({ ...refOf(row), agentId: row.actor, approvalId: row.approval_id }))
    const questions = (
      this.db
        .prepare(
          `SELECT e.seq, e.id, e.created_at, e.actor,
                  json_extract(e.payload, '$.userInputId') AS user_input_id
             FROM events e
            WHERE e.conversation_id = @conversationId AND e.type = 'userinput.requested'
              AND e.seq >= @fromSeq AND e.seq <= @asOfSeq
              AND COALESCE(json_extract(e.payload, '$.mode'), '') <> 'discussion'
              AND NOT EXISTS (
                SELECT 1 FROM events d
                 WHERE d.conversation_id = e.conversation_id AND d.type = 'userinput.answered'
                   AND d.seq > e.seq AND d.seq <= @asOfSeq
                   AND json_extract(d.payload, '$.userInputId') = json_extract(e.payload, '$.userInputId')
              )
            ORDER BY e.seq`
        )
        .all(bounds) as (RefRow & {
        actor: string
        user_input_id: string
      })[]
    ).map((row) => ({ ...refOf(row), agentId: row.actor, userInputId: row.user_input_id }))
    return { turns, approvals, questions }
  }

  searchWindow(
    window: TaskWindow,
    query: string,
    options: {
      readonly skip: number
      readonly count: number
      readonly ignoredItemRefPrefixes: readonly string[]
    }
  ): WindowSearchPage {
    const skip = Math.max(0, Math.floor(options.skip))
    const count = Math.min(Math.max(1, Math.floor(options.count)), WINDOW_SEARCH.max)
    if (query === '') return { matches: [], total: 0, skip, count }
    const work = workClause(options.ignoredItemRefPrefixes)
    const types = WINDOW_SEARCH_TYPES.map((type) => `'${type}'`).join(', ')
    const hits = `WITH hits AS (
      SELECT e.seq, e.id, e.created_at, e.actor, e.type, ${SEARCH_TEXT} AS body
        FROM events e
       WHERE e.conversation_id = @conversationId AND e.seq >= @fromSeq AND e.seq <= @toSeq
         AND e.type IN (${types})
         AND (e.type = 'error.raised' OR (${work.clause}))
    )`
    const at = 'instr(lower(body), lower(@needle))'
    const start = `max(1, ${at} - @before)`
    const params = {
      conversationId: window.conversationId,
      fromSeq: window.fromSeq,
      toSeq: window.toSeq,
      needle: query,
      ...work.params,
    }
    const total = (
      this.db.prepare(`${hits} SELECT COUNT(*) AS n FROM hits WHERE ${at} > 0`).get(params) as {
        n: number
      }
    ).n
    const rows = this.db
      .prepare(
        `${hits}
         SELECT seq, id, created_at, actor, type,
                substr(body, ${start}, @before + length(@needle) + @after) AS snippet,
                ${start} > 1 AS clipped_start,
                ${start} + @before + length(@needle) + @after - 1 < length(body) AS clipped_end
           FROM hits WHERE ${at} > 0
          ORDER BY seq DESC LIMIT @count OFFSET @skip`
      )
      .all({
        ...params,
        before: WINDOW_SEARCH.before,
        after: WINDOW_SEARCH.after,
        count,
        skip,
      }) as (RefRow & {
      actor: string
      type: string
      snippet: string
      clipped_start: number
      clipped_end: number
    })[]
    return {
      matches: rows.map((row) => ({
        ...refOf(row),
        actor: row.actor,
        type: row.type,
        snippet: row.snippet,
        clippedStart: row.clipped_start === 1,
        clippedEnd: row.clipped_end === 1,
      })),
      total,
      skip,
      count,
    }
  }

  assignmentRecord(
    childConversationId: string,
    eventId: string,
    scope: AssignmentScope
  ): AssignmentRecord {
    const event = this.eventIn(childConversationId, eventId)
    if (event === null) return { kind: 'refused', reason: 'unknown' }
    if (event.seq > scope.asOfSeq) return { kind: 'refused', reason: 'later' }
    if (event.type === 'agent.reasoning.delta') return { kind: 'refused', reason: 'private' }
    if (event.type === 'assignment.bound' || event.type === 'conversation.created') {
      return { kind: 'fact', event }
    }
    if (event.type === 'conversation.renamed') {
      const title = this.db
        .prepare(
          `SELECT id FROM events
            WHERE conversation_id = @child AND type = 'conversation.renamed' AND seq <= @asOfSeq
            ORDER BY seq DESC LIMIT 1`
        )
        .get({ child: childConversationId, asOfSeq: scope.asOfSeq }) as { id: string } | undefined
      return title?.id === event.id
        ? { kind: 'fact', event }
        : { kind: 'refused', reason: 'unrelated' }
    }
    const taskId = taskIdOfEvent(event)
    if (taskId !== null) {
      return scope.taskIds.includes(taskId)
        ? { kind: 'fact', event }
        : { kind: 'refused', reason: 'unrelated' }
    }
    const { window } = scope
    if (window !== null && event.id === window.originEventId) return { kind: 'fact', event }
    if (window === null || event.seq < window.fromSeq || event.seq > window.toSeq) {
      return { kind: 'refused', reason: 'unrelated' }
    }
    if (event.type === 'error.raised') return { kind: 'observation', event }
    if (event.payload.type === 'session.started' || event.payload.type === 'session.ended') {
      const agentId = event.payload.agentId
      const cutOff = this.db
        .prepare(
          `SELECT 1 FROM events t
            WHERE t.conversation_id = @child AND t.type = 'turn.started' AND t.actor = @agentId
              AND t.seq >= @fromSeq AND t.seq < @boundarySeq
              AND NOT EXISTS (
                SELECT 1 FROM events x
                 WHERE x.conversation_id = t.conversation_id
                   AND x.seq > t.seq AND x.seq < @boundarySeq
                   AND ((x.type = 'turn.completed' AND x.actor = @agentId)
                        OR (x.type IN ('session.started', 'session.ended')
                            AND json_extract(x.payload, '$.agentId') = @agentId))
              )
            LIMIT 1`
        )
        .get({
          child: childConversationId,
          agentId,
          fromSeq: window.fromSeq,
          boundarySeq: event.seq,
        })
      if (cutOff === undefined) return { kind: 'refused', reason: 'not-work' }
      return {
        kind: 'boundary',
        ref: { seq: event.seq, eventId: event.id, at: event.createdAt },
        agentId,
        boundary: event.payload.type,
        reason: event.payload.type === 'session.ended' ? event.payload.reason : null,
        resumed: event.payload.type === 'session.started' && event.payload.resumed === true,
      }
    }
    if (!isWorkEvent(event, scope.ignoredItemRefPrefixes)) {
      return { kind: 'refused', reason: 'not-work' }
    }
    if (event.payload.type === 'command.output') {
      return {
        kind: 'output',
        ref: { seq: event.seq, eventId: event.id, at: event.createdAt },
        actor: event.actor,
        itemRef: event.payload.itemRef,
        stream: event.payload.stream,
        bytes: Buffer.byteLength(event.payload.chunk, 'utf8'),
      }
    }
    return { kind: 'observation', event }
  }

  private forwardedChildOf(row: ForwardedRow): ForwardedChild | null {
    const parsed = ChorusEventPayload.safeParse(JSON.parse(row.payload))
    if (!parsed.success || parsed.data.type !== 'conversation.created') return null
    const { forward } = parsed.data
    const renamed =
      row.renamed_seq === null || row.renamed_id === null || row.renamed_at === null
        ? null
        : { seq: row.renamed_seq, eventId: row.renamed_id, at: row.renamed_at }
    return {
      conversationId: row.conversation_id,
      created: refOf(row),
      title: renamed === null || row.renamed_title === null ? parsed.data.title : row.renamed_title,
      titleRef: renamed === null || row.renamed_title === null ? refOf(row) : renamed,
      objective: forward?.objective ?? null,
      sourceEventIds: forward?.sourceEventIds ?? [],
      throughSeq: forward?.throughSeq ?? null,
    }
  }

  private eventIn(conversationId: string, eventId: string): StoredEvent | null {
    const row = this.db
      .prepare(
        `SELECT seq, id, conversation_id, actor, type, payload, created_at, schema_ver
           FROM events WHERE id = @eventId AND conversation_id = @conversationId`
      )
      .get({ eventId, conversationId })
    return row === undefined ? null : toStoredEvent(row)
  }

  taskOutcomes(limit = 200): TaskOutcomeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT conversation_id, payload FROM events
          WHERE type = 'task.closed' ORDER BY seq DESC LIMIT @limit`
      )
      .all({ limit }) as { conversation_id: string; payload: string }[]
    return rows.flatMap((row) => {
      const parsed = ChorusEventPayload.safeParse(JSON.parse(row.payload))
      if (!parsed.success || parsed.data.type !== 'task.closed') return []
      const { outcome } = parsed.data
      if (outcome === undefined) return []
      return [{ conversationId: row.conversation_id, taskId: parsed.data.taskId, outcome }]
    })
  }

  private latestTaskOpened(conversationId: string): StoredEvent | null {
    const row = this.db
      .prepare(
        `SELECT seq, id, conversation_id, actor, type, payload, created_at, schema_ver
           FROM events
          WHERE conversation_id = @conversationId AND type = 'task.opened'
          ORDER BY seq DESC LIMIT 1`
      )
      .get({ conversationId })
    return row === undefined ? null : toStoredEvent(row)
  }

  pendingDecisionIds(conversationId: string): {
    pendingApprovalIds: string[]
    pendingQuestionIds: string[]
  } {
    const approvals = this.db
      .prepare(
        `SELECT id FROM approvals WHERE conversation_id = @conversationId AND outcome IS NULL
          ORDER BY created_at`
      )
      .all({ conversationId }) as { id: string }[]
    const questions = this.db
      .prepare(
        `SELECT id FROM questions WHERE conversation_id = @conversationId AND answered_at IS NULL
          ORDER BY created_at`
      )
      .all({ conversationId }) as { id: string }[]
    return {
      pendingApprovalIds: approvals.map((row) => row.id),
      pendingQuestionIds: questions.map((row) => row.id),
    }
  }

  lastSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM events').get()
    return (row as { m: number | null }).m ?? 0
  }

  /**
   * Every conversation the log has ever held, most recently active first.
   *
   * A projection query rather than a log scan: `conversations.updated_at` is
   * already touched by every append, so "what was I working on" is one indexed
   * read instead of a walk over the whole history.
   *
   * This is what makes an ended conversation findable again. Before it, the
   * transcript stayed in SQLite forever and nothing could name it — the only
   * list was the file recording which windows were open, and ending one removed
   * it from that.
   */
  listConversations(limit = 200): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.id                AS id,
                c.title             AS title,
                c.project_id        AS projectId,
                c.updated_at        AS updatedAt,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messages,
                (SELECT GROUP_CONCAT(DISTINCT s.agent_id) FROM agent_sessions s
                  WHERE s.conversation_id = c.id) AS agents,
                -- The directory it was last worked in, which can differ from the
                -- one it started in: a project.changed event moves it mid-run.
                (SELECT s2.cwd FROM agent_sessions s2 WHERE s2.conversation_id = c.id
                  ORDER BY s2.started_at DESC LIMIT 1) AS cwd
           FROM conversations c
          -- Asides are not sessions. They belong to one passage of one reply and
          -- are reached from it; listing them here would put "what did you mean
          -- by that" in the sidebar beside the work it was about.
          WHERE c.kind IS NULL
          ORDER BY c.updated_at DESC
          LIMIT @limit`
      )
      .all({ limit })

    return (rows as ConversationRow[]).map((row) => ({
      conversationId: row.id,
      title: row.title,
      projectId: row.projectId,
      /*
       * Empty when no agent ever started and recorded one, and the caller
       * resolves the real root from `projectId`.
       *
       * This used to fall back to `project_id` itself, which was honest while
       * that column held the directory a conversation was created in. It holds a
       * project **id** now, so the old fallback would have put a UUID in a field
       * every caller treats as a path — and `describeDirectory` would have
       * reported that the folder does not exist.
       */
      cwd: row.cwd ?? '',
      agents: row.agents === null || row.agents === '' ? [] : row.agents.split(','),
      updatedAt: row.updatedAt,
      messages: row.messages,
    }))
  }

  /**
   * The asides taken on one conversation, oldest first.
   *
   * By `parent_id` rather than by scanning payloads: `read` filters on
   * conversation, seq and type only, so "which asides belong to this reply" is
   * not a question the log can answer directly. That is the whole reason asides
   * are conversations with a projection row rather than events tagged with a
   * source id — the projection is what makes them findable.
   *
   * `sourceEventId` narrows to one reply, for the badge that offers to reopen
   * them; omitted, it answers for the whole conversation.
   */
  listAsides(parentId: string, sourceEventId?: string): AsideSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, source_event_id AS sourceEventId, title, created_at AS createdAt
           FROM conversations
          WHERE kind = 'aside'
            AND parent_id = @parentId
            AND (@sourceEventId IS NULL OR source_event_id = @sourceEventId)
          ORDER BY created_at ASC`
      )
      .all({ parentId, sourceEventId: sourceEventId ?? null })

    return rows as AsideSummary[]
  }

  /**
   * Drop every projection and replay the whole log.
   *
   * This is the guarantee that makes the log authoritative rather than merely
   * a nice audit trail: if a projection is corrupt, or a projector gains a bug
   * that is later fixed, the fix is a rebuild rather than a data-loss event.
   */
  rebuildProjections(): { events: number; lastSeq: number } {
    const run = this.db.transaction(() => {
      for (const table of PROJECTION_TABLES) this.db.exec(`DELETE FROM ${table}`)
      this.db.exec('DELETE FROM projection_state')

      const rows = this.db
        .prepare(
          `SELECT seq, id, conversation_id, actor, type, payload, created_at, schema_ver
             FROM events ORDER BY seq`
        )
        .all()

      let last = 0
      for (const row of rows) {
        const event = toStoredEvent(row)
        if (event !== null) applyToProjections(this.db, event)
        last = StoredEventRow.parse(row).seq
      }
      this.bumpProjectionState(last)
      return { events: rows.length, lastSeq: last }
    })
    return run()
  }

  /**
   * Closes sessions the log still believes are running.
   *
   * A crash leaves `session.started` with no matching `session.ended`, so on the
   * next boot the projection claims agents are alive that died with the process.
   * Reconciling is an append, not an UPDATE: the log is the record, and quietly
   * editing a projection would make the two disagree.
   */
  reconcileOrphanedSessions(now: number = Date.now()): { closed: number } {
    const rows = this.db
      .prepare(
        `SELECT conversation_id, agent_id, session_ref FROM agent_sessions WHERE status = 'active'`
      )
      .all()

    let closed = 0
    for (const row of rows) {
      const parsed = OrphanedSessionRow.safeParse(row)
      if (!parsed.success) continue
      this.append(
        {
          conversationId: parsed.data.conversation_id,
          actor: 'system',
          payload: {
            type: 'session.ended',
            agentId: parsed.data.agent_id,
            sessionRef: parsed.data.session_ref,
            reason: 'crashed',
          },
        },
        now
      )
      closed += 1
    }
    return { closed }
  }

  /** A projection behind the log means an append was interrupted mid-transaction. */
  projectionDrift(): { name: string; lastSeq: number; logSeq: number }[] {
    const logSeq = this.lastSeq()
    return PROJECTION_NAMES.map((name) => {
      const row = this.db
        .prepare('SELECT last_seq FROM projection_state WHERE name = @name')
        .get({ name })
      return { name, lastSeq: (row as { last_seq?: number } | undefined)?.last_seq ?? 0, logSeq }
    }).filter((s) => s.lastSeq !== logSeq)
  }

  /** How many writes arrived after closing; zero unless shutdown raced a turn. */
  droppedWrites(): number {
    return this.droppedAfterClose
  }

  close(): void {
    // Flagged before the handle goes, so nothing can slip between the two.
    this.closed = true
    this.db.close()
  }

  /** A throwing listener must not roll back or abort a committed append. */
  private notify(events: readonly StoredEvent[]): void {
    if (events.length === 0) return
    this.undelivered.push(events)
    if (this.delivering) return
    this.delivering = true
    try {
      for (
        let batch = this.undelivered.shift();
        batch !== undefined;
        batch = this.undelivered.shift()
      ) {
        for (const listener of this.listeners) {
          try {
            listener(batch)
          } catch {
            // Intentionally swallowed: the write already succeeded, and one bad
            // subscriber should not take down the others.
          }
        }
      }
    } finally {
      this.delivering = false
    }
  }

  private bumpProjectionState(seq: number): void {
    const stmt = this.db.prepare(
      `INSERT INTO projection_state (name, last_seq) VALUES (@name, @seq)
       ON CONFLICT (name) DO UPDATE SET last_seq = excluded.last_seq`
    )
    for (const name of PROJECTION_NAMES) stmt.run({ name, seq })
  }
}

const OrphanedSessionRow = z.object({
  conversation_id: z.string(),
  agent_id: AgentIdSchema,
  session_ref: z.string(),
})

function eventFilter(
  conversationId: string,
  options: Pick<ReadOptions, 'afterSeq' | 'types'>
): { where: string; params: Record<string, unknown> } {
  const clauses = ['conversation_id = @conversationId']
  const params: Record<string, unknown> = { conversationId }

  if (options.afterSeq !== undefined) {
    clauses.push('seq > @afterSeq')
    params['afterSeq'] = options.afterSeq
  }
  if (options.types !== undefined && options.types.length > 0) {
    // Inlined because SQLite has no array binding; values come from our own
    // event-type union, never from user input.
    const list = options.types.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')
    clauses.push(`type IN (${list})`)
  }

  return { where: clauses.join(' AND '), params }
}

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(
  ChorusEventPayload.options.map((option) => option.shape.type.value)
)

function toStoredEvent(row: unknown): StoredEvent | null {
  const parsed = StoredEventRow.parse(row)
  if (!KNOWN_EVENT_TYPES.has(parsed.type)) return null
  return {
    seq: parsed.seq,
    id: parsed.id,
    conversationId: parsed.conversation_id,
    actor: parsed.actor,
    type: parsed.type as StoredEvent['type'],
    payload: ChorusEventPayload.parse(JSON.parse(parsed.payload)),
    createdAt: parsed.created_at,
    schemaVersion: parsed.schema_ver,
  }
}
