import type { ChorusEventType } from '@chorus/event-store'

/**
 * Which stored events the transcript actually draws.
 *
 * **Measured, not guessed.** On the author's database, the types marked
 * `ignore` below were **51,801 events and 51,949,730 bytes — 30.6% of all
 * stored payload**. Every one of them was read from SQLite, `JSON.parse`d,
 * validated against `ChorusEventPayload`, validated *again* crossing the IPC
 * boundary, structured-cloned into the renderer, and then dropped on the floor
 * by a reducer with no case for it. `command.output` alone was 34 MB.
 *
 * **This is a read filter, not a change to the log.** Every event is still
 * appended and still stored; the log remains the source of truth. What narrows
 * is one query, for one consumer — see `conversation:transcript`. Raw
 * `conversation:history` is untouched, because `SummaryPanel` counts failures
 * from `command.completed` and the e2e specs assert on `repo.changed.byUser`,
 * and both would break silently if this filtered the shared channel.
 *
 * **`Record<ChorusEventType, …>` is the whole design.** A plain array of type
 * names would be a second list to keep in step with the reducer, wrong the
 * first time somebody forgot it, and the symptom would be an entry that
 * silently stops appearing. Written as a total map over the union, a new event
 * type fails to compile until it is *classified* — which is the same discipline
 * the five downstream switches already enforce, for the same reason.
 *
 * An earlier draft of the plan said this list could be "derived from the
 * reducer's switch". It cannot: `TranscriptEvent.type` is `z.string()` and
 * `reduceEvents` ends in a `default:` arm, so there is nothing exhaustive to
 * derive from. The map is where exhaustiveness has to live instead.
 */
export const TRANSCRIPT_DISPOSITION: Record<ChorusEventType, 'render' | 'ignore'> = {
  'agent.message.completed': 'render',
  'agent.message.delta': 'render',
  'agent.reasoning.delta': 'render',
  'approval.decided': 'render',
  'approval.requested': 'render',
  'aside.promoted': 'render',
  'context.compacted': 'render',
  'error.raised': 'render',
  'file.change.completed': 'render',
  'file.edited.byUser': 'render',
  'handoff.created': 'render',
  'notice.raised': 'render',
  'policy.changed': 'render',
  'project.changed': 'render',
  'session.ended': 'render',
  'session.started': 'render',
  'tool.completed': 'render',
  'tool.progress': 'render',
  'tool.started': 'render',
  'turn.completed': 'render',
  'turn.started': 'render',
  'usage.updated': 'render',
  'user.message': 'render',
  'userinput.answered': 'render',
  'userinput.requested': 'render',
  'command.started': 'render',

  /*
   * The 30.6%. Each of these has no case in `reduceEvents`, and the reason is
   * the same in every instance: another surface owns it.
   *
   * `command.output` and `command.completed` — the transcript shows that a
   * command ran, from `command.started`; its output belongs to the command's
   * own row, which reads it when opened.
   * `diff.updated` — the Changes panel reads git, not the log. 15.7 MB here.
   * `file.change.proposed` — superseded by `file.change.completed`, which is
   * the one that says what actually happened.
   * `conversation.created` / `conversation.renamed` — session metadata; the
   * tab and the history sheet draw these.
   * `repo.changed.byUser` — the panel's own state, and what the e2e log
   * assertions read from raw history.
   */
  'command.output': 'ignore',
  'command.completed': 'ignore',
  'diff.updated': 'ignore',
  'file.change.proposed': 'ignore',
  'conversation.created': 'ignore',
  'conversation.renamed': 'ignore',
  'repo.changed.byUser': 'ignore',
}

/**
 * The types a transcript read asks SQLite for, derived from the map above.
 *
 * Derived rather than written out, so the two can never disagree — the failure
 * that would cause is an entry vanishing from the transcript with nothing
 * anywhere reporting a problem.
 */
export const TRANSCRIPT_TYPES: readonly ChorusEventType[] = Object.entries(TRANSCRIPT_DISPOSITION)
  .filter(([, disposition]) => disposition === 'render')
  .map(([type]) => type as ChorusEventType)
