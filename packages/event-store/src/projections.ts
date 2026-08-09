import type { StoredEvent } from './events.js'
import type { Database } from './port.js'

/**
 * Projections are derived state. They are updated in the same transaction as
 * the append, and can always be dropped and rebuilt from the log — which is the
 * property `rebuildProjections` in store.ts depends on.
 *
 * Every applier must be a pure function of the event and the rows already
 * projected from earlier events. Nothing here may read the clock or generate
 * ids, or a rebuild would produce different output than the live path.
 */

export const PROJECTION_NAMES = [
  'conversations',
  'messages',
  'agent_sessions',
  'approvals',
  'handoffs',
] as const

export const PROJECTION_TABLES = PROJECTION_NAMES

export function applyToProjections(db: Database, event: StoredEvent): void {
  const { payload } = event
  const base = { conversationId: event.conversationId, seq: event.seq, at: event.createdAt }

  switch (payload.type) {
    case 'conversation.created':
      db.prepare(
        `INSERT INTO conversations
           (id, project_id, title, created_at, updated_at, kind, parent_id, source_event_id)
         VALUES (@id, @projectId, @title, @at, @at, @kind, @parentId, @sourceEventId)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`
      ).run({
        id: base.conversationId,
        projectId: payload.projectId,
        title: payload.title,
        at: base.at,
        /*
         * `?? null` rather than omitted: the three columns are nullable and a
         * missing bind parameter is an error in better-sqlite3, not a null. An
         * event appended before asides existed carries none of them and must
         * still project — which is the property `rebuildProjections` leans on.
         */
        kind: payload.kind ?? null,
        parentId: payload.parentId ?? null,
        sourceEventId: payload.sourceEventId ?? null,
      })
      break

    case 'session.started':
      db.prepare(
        `INSERT INTO agent_sessions
           (id, conversation_id, agent_id, session_ref, cwd, model, cli_version, status, started_at)
         VALUES (@id, @conversationId, @agentId, @sessionRef, @cwd, @model, @cliVersion, 'active', @at)
         ON CONFLICT (id) DO NOTHING`
      ).run({
        id: event.id,
        conversationId: base.conversationId,
        agentId: payload.agentId,
        sessionRef: payload.sessionRef,
        cwd: payload.cwd,
        model: payload.model,
        cliVersion: payload.cliVersion,
        at: base.at,
      })
      break

    case 'session.ended':
      db.prepare(
        `UPDATE agent_sessions SET status = @status
         WHERE conversation_id = @conversationId AND session_ref = @sessionRef`
      ).run({
        status: payload.reason === 'crashed' ? 'crashed' : 'ended',
        conversationId: base.conversationId,
        sessionRef: payload.sessionRef,
      })
      break

    case 'user.message':
      db.prepare(
        `INSERT INTO messages (id, conversation_id, seq, actor, item_ref, content, status, created_at)
         VALUES (@id, @conversationId, @seq, @actor, @itemRef, @content, 'complete', @at)
         ON CONFLICT (conversation_id, item_ref) DO NOTHING`
      ).run({
        id: event.id,
        conversationId: base.conversationId,
        seq: base.seq,
        actor: event.actor,
        itemRef: event.id,
        content: payload.text,
        at: base.at,
      })
      break

    /**
     * The delta path is why the log exists (S3): Codex will not return partial
     * assistant output after a crash, so each chunk is appended here as it
     * arrives. `content || excluded.content` makes replay order-dependent but
     * deterministic, which is exactly what a rebuild needs.
     */
    case 'agent.message.delta':
      db.prepare(
        `INSERT INTO messages (id, conversation_id, seq, actor, item_ref, content, status, created_at)
         VALUES (@id, @conversationId, @seq, @actor, @itemRef, @text, 'streaming', @at)
         ON CONFLICT (conversation_id, item_ref)
         DO UPDATE SET content = content || excluded.content`
      ).run({
        id: event.id,
        conversationId: base.conversationId,
        seq: base.seq,
        actor: event.actor,
        itemRef: payload.itemRef,
        text: payload.text,
        at: base.at,
      })
      break

    /**
     * The completed event carries the provider's authoritative final text, which
     * replaces the accumulated deltas rather than appending to them — the two
     * would otherwise duplicate.
     */
    case 'agent.message.completed':
      db.prepare(
        `INSERT INTO messages (id, conversation_id, seq, actor, item_ref, content, status, created_at)
         VALUES (@id, @conversationId, @seq, @actor, @itemRef, @text, 'complete', @at)
         ON CONFLICT (conversation_id, item_ref)
         DO UPDATE SET content = excluded.content, status = 'complete'`
      ).run({
        id: event.id,
        conversationId: base.conversationId,
        seq: base.seq,
        actor: event.actor,
        itemRef: payload.itemRef,
        text: payload.text,
        at: base.at,
      })
      break

    case 'approval.requested':
      db.prepare(
        `INSERT INTO approvals
           (id, conversation_id, agent_id, kind, request, expires_at, created_at)
         VALUES (@id, @conversationId, @agentId, @kind, @request, @expiresAt, @at)
         ON CONFLICT (id) DO NOTHING`
      ).run({
        id: payload.approvalId,
        conversationId: base.conversationId,
        agentId: event.actor === 'user' || event.actor === 'system' ? null : event.actor,
        kind: payload.kind,
        request: JSON.stringify(payload.request ?? null),
        expiresAt: payload.expiresAt,
        at: base.at,
      })
      break

    case 'approval.decided':
      db.prepare(
        `UPDATE approvals
            SET outcome = @outcome, scope = @scope, decided_by = @decidedBy,
                decided_at = @at, policy_rule_id = @policyRuleId
          WHERE id = @id`
      ).run({
        id: payload.approvalId,
        outcome: payload.outcome,
        scope: payload.scope,
        decidedBy: payload.decidedBy,
        policyRuleId: payload.policyRuleId,
        at: base.at,
      })
      break

    /*
     * Deliberately not projected into a table of their own.
     *
     * Approvals get one because policy queries them — "what has this profile
     * auto-allowed" is a question asked of the projection, not of the log.
     * Nothing asks that of a question set: the only reader is the UI, which
     * rebuilds what is still pending by replaying the log. A table here would be
     * a schema migration maintaining state nobody reads.
     */
    case 'userinput.requested':
    case 'userinput.answered':
      break

    case 'handoff.created':
      db.prepare(
        `INSERT INTO handoffs
           (id, conversation_id, from_agent, to_agent, brief, source_event_ids, created_at)
         VALUES (@id, @conversationId, @from, @to, @brief, @sourceEventIds, @at)
         ON CONFLICT (id) DO NOTHING`
      ).run({
        id: payload.handoffId,
        conversationId: base.conversationId,
        from: payload.from,
        to: payload.to,
        brief: payload.brief,
        sourceEventIds: JSON.stringify(payload.sourceEventIds),
        at: base.at,
      })
      break

    // Streamed detail that the transcript reads back off the log directly.
    // Giving each of these a table would add write cost for no query we make.
    case 'turn.started':
    case 'turn.completed':
    case 'agent.reasoning.delta':
    case 'command.started':
    case 'command.output':
    case 'command.completed':
    case 'file.change.proposed':
    case 'diff.updated':
    case 'usage.updated':
    case 'conversation.renamed':
    case 'project.changed':
    case 'policy.changed':
    case 'context.compacted':
    case 'error.raised':
    case 'notice.raised':
    case 'tool.started':
    case 'tool.progress':
    case 'tool.completed':
      // A notice is read back off the log with the rest of the transcript; no
      // query asks "which notices", so a table would be write cost for nothing.
      break
  }

  // Any event touching a conversation makes it the most recently active one.
  db.prepare('UPDATE conversations SET updated_at = @at WHERE id = @id').run({
    id: base.conversationId,
    at: base.at,
  })
}
