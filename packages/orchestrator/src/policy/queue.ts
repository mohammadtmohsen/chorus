import type { ApprovalDecision, ApprovalRequest } from '@chorus/agent-protocol'
import type { ApprovalId } from '@chorus/shared'
import type { Scheduler } from '../delta-buffer.js'
import { realScheduler } from '../delta-buffer.js'

/**
 * Holds approvals that are waiting on a person, and makes sure none waits
 * forever.
 *
 * Neither provider imposes a deadline — the Claude SDK's permission prompt
 * blocks indefinitely by design, and an unanswered Codex `requestApproval`
 * hangs the turn (plan §2.2). Chorus owning the timeout is the only thing
 * standing between a closed laptop and a wedged session.
 *
 * An expiry always **denies**. Auto-allowing something nobody looked at would
 * turn a screensaver into a permission grant.
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
  private timer: unknown = null

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
    this.arm()
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
    if (this.pending.size === 0) this.disarm()
    await this.onResolved(entry, decision, decidedBy)
    return true
  }

  /** Denies everything past its deadline. Safe to call at any time. */
  async sweep(now = this.scheduler.now()): Promise<number> {
    const expired = [...this.pending.values()].filter((e) => e.request.expiresAt <= now)
    for (const entry of expired) {
      this.pending.delete(entry.request.id)
      await this.onResolved(entry, { outcome: 'timeout' }, 'system')
    }
    if (this.pending.size === 0) this.disarm()
    return expired.length
  }

  /** Denies everything outstanding — used when a session or the app is closing. */
  async drain(reason: string): Promise<void> {
    const entries = [...this.pending.values()]
    this.pending.clear()
    this.disarm()
    for (const entry of entries) {
      await this.onResolved(entry, { outcome: 'deny', message: reason }, 'system')
    }
  }

  dispose(): void {
    this.pending.clear()
    this.disarm()
  }

  private arm(): void {
    if (this.timer !== null) return
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null
      void this.sweep().then(() => {
        if (this.pending.size > 0) this.arm()
      })
    }, 1_000)
  }

  private disarm(): void {
    if (this.timer === null) return
    this.scheduler.clearTimeout(this.timer)
    this.timer = null
  }
}
