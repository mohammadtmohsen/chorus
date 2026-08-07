import { z } from 'zod'

/**
 * The domain event log. This is the source of truth for a conversation —
 * not the providers'.
 *
 * S3 (2026-08-03) established why: Codex discards partial assistant output when
 * a turn is interrupted or its process dies, returning only the `userMessage`
 * from `thread/read`. Claude preserves it. Since the transcript cannot be
 * rebuilt from the providers, everything an agent streams must be durable here
 * as it arrives. See docs/research/spikes-2026-08-03.md.
 */

export const SCHEMA_VERSION = 1

const actor = z.enum(['user', 'system', 'codex', 'claude'])

/**
 * `itemRef` is the provider's id for a streaming item. It is how a run of
 * deltas is stitched back into one message during projection.
 */
const itemRef = z.string().min(1)

export const ChorusEventPayload = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('conversation.created'),
    projectId: z.string(),
    title: z.string(),
  }),

  /**
   * CLI versions are recorded here on purpose (plan §2.5). Chorus drives the
   * user's installed `codex` and `claude`, which self-update, so a break after
   * an upgrade should be visible in the log instead of a guess.
   */
  z.object({
    type: z.literal('session.started'),
    agentId: z.enum(['codex', 'claude']),
    sessionRef: z.string(),
    cwd: z.string(),
    model: z.string().nullable(),
    cliVersion: z.string().nullable(),
    /**
     * True when this is the app reopening a conversation rather than an agent
     * joining one. Optional, because events written before it existed have no
     * opinion and must still parse.
     */
    resumed: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('session.ended'),
    agentId: z.enum(['codex', 'claude']),
    sessionRef: z.string(),
    /** `shutdown` is the app quitting; the rest are things that happened to it. */
    reason: z.enum(['closed', 'crashed', 'replaced', 'shutdown']),
  }),

  z.object({ type: z.literal('user.message'), text: z.string() }),

  z.object({ type: z.literal('turn.started'), turnRef: z.string() }),
  z.object({
    type: z.literal('turn.completed'),
    turnRef: z.string(),
    status: z.enum(['completed', 'interrupted', 'failed']),
    /**
     * True when Chorus asked for the interrupt. Claude reports a user-initiated
     * stop as `error_during_execution` with no distinct status, so without this
     * the UI would show an error card for pressing Stop (S3b).
     */
    userInitiated: z.boolean().default(false),
  }),

  z.object({ type: z.literal('agent.message.delta'), itemRef, text: z.string() }),
  z.object({ type: z.literal('agent.message.completed'), itemRef, text: z.string() }),
  z.object({ type: z.literal('agent.reasoning.delta'), itemRef, text: z.string() }),

  z.object({
    type: z.literal('command.started'),
    itemRef,
    command: z.array(z.string()),
    cwd: z.string(),
  }),
  z.object({
    type: z.literal('command.output'),
    itemRef,
    stream: z.enum(['stdout', 'stderr']),
    chunk: z.string(),
  }),
  z.object({
    type: z.literal('command.completed'),
    itemRef,
    exitCode: z.number().int().nullable(),
  }),

  z.object({
    type: z.literal('file.change.proposed'),
    itemRef,
    files: z.array(z.object({ path: z.string(), patch: z.string() })),
  }),
  z.object({ type: z.literal('diff.updated'), unifiedDiff: z.string() }),

  z.object({
    type: z.literal('approval.requested'),
    approvalId: z.string(),
    kind: z.enum(['command', 'fileChange', 'permissionGrant', 'mcpToolCall']),
    request: z.unknown(),
    expiresAt: z.number().int(),
  }),
  z.object({
    type: z.literal('approval.decided'),
    approvalId: z.string(),
    outcome: z.enum(['allow', 'deny', 'cancel', 'timeout']),
    scope: z.enum(['once', 'session']).nullable(),
    decidedBy: z.enum(['user', 'policy', 'system']),
    /** Which rule auto-decided this. Null means a human chose (plan §4.4). */
    policyRuleId: z.string().nullable(),
  }),

  z.object({
    type: z.literal('userinput.requested'),
    userInputId: z.string(),
    /**
     * The normalized `UserInputRequest`. Secret questions are recorded — the
     * user must be able to see later that they were asked — but their *answers*
     * never are (see `userinput.answered`).
     */
    request: z.unknown(),
    expiresAt: z.number().int(),
  }),
  z.object({
    type: z.literal('userinput.answered'),
    userInputId: z.string(),
    outcome: z.enum(['answered', 'cancel', 'timeout']),
    /**
     * Answers, with every secret question's values replaced by null before this
     * ever reaches the store.
     *
     * Null rather than omitted: "you answered this, and it is not written down"
     * is a different fact from "you never answered", and replay has to be able
     * to tell them apart.
     */
    answers: z
      .array(z.object({ questionId: z.string(), values: z.array(z.string()).nullable() }))
      .nullable(),
    answeredBy: z.enum(['user', 'system']),
  }),

  z.object({
    type: z.literal('handoff.created'),
    handoffId: z.string(),
    from: z.enum(['codex', 'claude']),
    to: z.enum(['codex', 'claude']),
    sourceEventIds: z.array(z.string()),
    brief: z.string(),
  }),

  /**
   * The agent summarised its own history to fit the context window.
   *
   * No payload: the codex notification carries only encrypted content, and the
   * fact is the whole of what a reader needs. It marks the point above which
   * the transcript and the agent's memory of it stop being the same thing.
   */
  z.object({ type: z.literal('context.compacted') }),

  z.object({
    type: z.literal('usage.updated'),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    costUsd: z.number().nullable(),
  }),
  /**
   * The conversation's permission profile changed mid-session.
   *
   * Logged rather than kept in memory: "human controlled" is only auditable if
   * widening what agents may do leaves a mark next to what they then did.
   */
  /**
   * The project directory changed mid-session.
   *
   * Recorded because it changes what "the diff" means: the review panel and any
   * handoff brief follow it, so a diff read later is only interpretable against
   * the directory in force at the time.
   */
  /** The conversation was given a name. Its default is the folder it opened in. */
  z.object({
    type: z.literal('conversation.renamed'),
    title: z.string(),
    previousTitle: z.string(),
  }),

  z.object({
    type: z.literal('project.changed'),
    cwd: z.string(),
    previousCwd: z.string(),
  }),

  z.object({
    type: z.literal('policy.changed'),
    profileId: z.string(),
    previousProfileId: z.string(),
  }),

  z.object({
    type: z.literal('error.raised'),
    message: z.string(),
    recoverable: z.boolean(),
  }),
])

export type ChorusEventPayload = z.infer<typeof ChorusEventPayload>
export type ChorusEventType = ChorusEventPayload['type']

/** What a caller hands to `append`. Ids, ordering, and time are the store's job. */
export interface AppendInput {
  readonly conversationId: string
  readonly actor: z.infer<typeof actor>
  readonly payload: ChorusEventPayload
}

/** What comes back out — the envelope plus its assigned position in the log. */
export interface StoredEvent {
  readonly seq: number
  readonly id: string
  readonly conversationId: string
  readonly actor: z.infer<typeof actor>
  readonly type: ChorusEventType
  readonly payload: ChorusEventPayload
  readonly createdAt: number
  readonly schemaVersion: number
}

export const StoredEventRow = z.object({
  seq: z.number().int(),
  id: z.string(),
  conversation_id: z.string(),
  actor,
  type: z.string(),
  payload: z.string(),
  created_at: z.number().int(),
  schema_ver: z.number().int(),
})
