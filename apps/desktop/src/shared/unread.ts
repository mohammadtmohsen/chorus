/**
 * What counts as something you have not read yet.
 *
 * Shared because two sides answer the same question and must not drift: the
 * renderer counts these live as pushes arrive, and the main process counts them
 * back out of the log at launch to restore the number. Two lists would mean a
 * card that says 3 before a restart and 5 after it, with nothing having changed.
 *
 * Deliberately short. Unread means "work happened that you have not seen", not
 * "bytes arrived" — a turn's deltas, tool calls, notices and usage reports are
 * the agent working, and a badge that counted them would be a progress bar with
 * no top. What is left is the three things a person would say happened: it
 * answered, it broke, or it handed off.
 */
export const UNREAD_EVENT_TYPES = [
  'agent.message.completed',
  'error.raised',
  'handoff.created',
] as const

export function countsAsUnread(type: string): boolean {
  return (UNREAD_EVENT_TYPES as readonly string[]).includes(type)
}
