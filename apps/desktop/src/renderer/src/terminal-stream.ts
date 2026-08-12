import type { TerminalPush, TerminalRefShape } from '../../shared/ipc.js'

/**
 * Deciding which pushes belong to this view.
 *
 * Pulled out of the component because it is the whole correctness story of the
 * terminal renderer and none of it needs a DOM: one broadcast channel carries
 * every terminal's output to every window, and a view has to recognise its own
 * — by terminal, by attachment, and by position in the stream.
 */

export function sameTerminal(a: TerminalRefShape, b: TerminalRefShape): boolean {
  if (a.scope === 'global') return b.scope === 'global'
  return b.scope === 'session' && a.conversationId === b.conversationId
}

export interface Attachment {
  readonly ref: TerminalRefShape
  readonly epoch: number
  /** The last sequence number the snapshot already contains. */
  readonly seq: number
}

/**
 * Whether this view should apply a push.
 *
 * Three filters, and each one exists because of a specific way it goes wrong:
 *
 * - **wrong terminal** — the channel is a broadcast, so a session panel would
 *   otherwise print the global terminal's output.
 * - **wrong epoch** — a push aimed at an attachment this view has superseded.
 *   Applying it writes output the user already saw into a fresh screen.
 * - **already in the snapshot** — `attach` returns the screen *and* the sequence
 *   number it includes. Anything at or below that is by definition already
 *   drawn, and replaying it duplicates a line.
 *
 * A push arriving before this view has attached has no attachment to compare
 * against, so it is held rather than judged — see `pendingUntilAttached`.
 */
export function shouldApply(push: TerminalPush, attachment: Attachment): boolean {
  if (!sameTerminal(push.ref, attachment.ref)) return false
  if (push.epoch !== attachment.epoch) return false
  if (push.kind === 'exit') return true
  return push.seq > attachment.seq
}

/**
 * What to replay once the attachment lands.
 *
 * The API's ordering rule is subscribe first, attach second — anything the shell
 * writes in between would otherwise be lost, because the snapshot was taken
 * before it and no listener existed to catch it. So pushes are queued from the
 * moment the listener is live, and filtered only once there is something to
 * filter against.
 */
export function pendingUntilAttached(
  queued: readonly TerminalPush[],
  attachment: Attachment
): TerminalPush[] {
  return queued.filter((push) => shouldApply(push, attachment))
}
