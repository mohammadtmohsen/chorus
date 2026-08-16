import type { ApprovalDecision, ApprovalRequest } from '@chorus/agent-protocol'
import type { ApprovalId } from '@chorus/shared'
import type { Scheduler } from '../delta-buffer.js'
import { realScheduler } from '../delta-buffer.js'

/**
 * Holds approvals that are waiting on a person, for as long as that takes.
 *
 * **Nothing expires here, and that is a decision rather than an omission.**
 *
 * Neither provider imposes a deadline — the Claude SDK's permission prompt
 * blocks indefinitely by design, and an unanswered Codex `requestApproval`
 * hangs the turn (plan §2.2). The five-minute window this used to enforce was
 * therefore Chorus's own invention, and it existed to stop a closed laptop
 * wedging a session.
 *
 * It bought that at a price nobody chose. An expiry always **denied**, and a
 * denial is a real answer: walking away for six minutes silently told the agent
 * no, and the turn carried on as though you had meant it. Asked for directly —
 * "no expiry at all, never count the time, wait until the user answers no
 * matter how long it takes."
 *
 * What replaces it is not nothing. `drain` still resolves everything
 * outstanding when a session ends or the app closes, so quitting stays clean;
 * and a turn you no longer want is ended by the interrupt control, which is a
 * person deciding rather than a clock deciding for them. The timer's real job —
 * never leave a session with no way out — was already done by a button.
 *
 * `expiresAt` is still carried on the request and still written to the log. It
 * records what the adapter proposed. Nothing reads it back.
 */

export interface PendingEntry {
  readonly request: ApprovalRequest
  readonly conversationId: string
  readonly requestedAt: number
}

export interface ApprovalQueueOptions {
  readonly scheduler?: Scheduler
  /** Called for every resolution, including timeouts, so it can be logged. */
  readonly onResolved: (
    entry: PendingEntry,
    decision: ApprovalDecision,
    decidedBy: 'user' | 'policy' | 'system'
  ) => void | Promise<void>
}

export class ApprovalQueue {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly scheduler: Scheduler
  private readonly onResolved: ApprovalQueueOptions['onResolved']

  constructor(options: ApprovalQueueOptions) {
    this.scheduler = options.scheduler ?? realScheduler
    this.onResolved = options.onResolved
  }

  /** Several approvals can be outstanding at once — two agents, or one agent batching. */
  add(conversationId: string, request: ApprovalRequest): void {
    this.pending.set(request.id, {
      request,
      conversationId,
      requestedAt: this.scheduler.now(),
    })
  }

  get size(): number {
    return this.pending.size
  }

  list(): PendingEntry[] {
    return [...this.pending.values()]
  }

  get(id: ApprovalId | string): PendingEntry | undefined {
    return this.pending.get(id)
  }

  /** Resolves one approval. Unknown ids are ignored — a double-click is not an error. */
  async resolve(
    id: ApprovalId | string,
    decision: ApprovalDecision,
    decidedBy: 'user' | 'policy' | 'system' = 'user'
  ): Promise<boolean> {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    this.pending.delete(id)
    await this.onResolved(entry, decision, decidedBy)
    return true
  }

  /** Denies everything outstanding — used when a session or the app is closing. */
  async drain(reason: string): Promise<void> {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      await this.onResolved(entry, { outcome: 'deny', message: reason }, 'system')
    }
  }

  dispose(): void {
    this.pending.clear()
  }
}
