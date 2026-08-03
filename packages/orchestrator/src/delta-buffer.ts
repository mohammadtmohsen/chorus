/**
 * Write-side coalescing for streamed text.
 *
 * S3 established that partial assistant output must be durable as it arrives —
 * Codex will not hand it back after a crash. But one log row per token is a lot
 * of rows for no recovery benefit, so deltas are batched and flushed on a bound.
 *
 * The bound is deliberately two-sided, for the same reason S5 concluded the
 * renderer cannot coalesce on `requestAnimationFrame` alone: a size-only trigger
 * strands the tail of a slow stream indefinitely, and a time-only trigger lets a
 * fast stream buffer without limit. Whichever fires first wins.
 *
 * The worst-case loss window on a hard kill is therefore bounded by
 * `maxAgeMs` — one flush interval, not the whole turn.
 */

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => {
    globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>)
  },
  now: () => Date.now(),
}

export interface DeltaBufferOptions<M> {
  /** Flush a key once it has accumulated this many characters. */
  readonly maxChars?: number
  /** Flush everything this long after the oldest pending chunk arrived. */
  readonly maxAgeMs?: number
  /**
   * Hard ceiling across all keys. Reaching it forces an immediate flush — this
   * is the backstop for the case S5 found, where the flush trigger stops firing
   * (a backgrounded window, a stalled timer) while data keeps arriving.
   */
  readonly maxTotalChars?: number
  readonly onFlush: (entries: readonly FlushEntry<M>[]) => void
  readonly scheduler?: Scheduler
}

export interface FlushEntry<M> {
  readonly key: string
  readonly text: string
  readonly meta: M
}

interface Pending<M> {
  text: string
  meta: M
  since: number
}

export class DeltaBuffer<M> {
  private readonly pending = new Map<string, Pending<M>>()
  private readonly maxChars: number
  private readonly maxAgeMs: number
  private readonly maxTotalChars: number
  private readonly onFlush: (entries: readonly FlushEntry<M>[]) => void
  private readonly scheduler: Scheduler
  private timer: unknown = null
  private totalChars = 0

  constructor(options: DeltaBufferOptions<M>) {
    this.maxChars = options.maxChars ?? 2_048
    this.maxAgeMs = options.maxAgeMs ?? 250
    this.maxTotalChars = options.maxTotalChars ?? 64_000
    this.onFlush = options.onFlush
    this.scheduler = options.scheduler ?? realScheduler
  }

  push(key: string, text: string, meta: M): void {
    if (text === '') return

    const existing = this.pending.get(key)
    if (existing === undefined) {
      this.pending.set(key, { text, meta, since: this.scheduler.now() })
    } else {
      existing.text += text
      existing.meta = meta
    }
    this.totalChars += text.length

    const entry = this.pending.get(key)
    if (entry !== undefined && entry.text.length >= this.maxChars) {
      this.flushKey(key)
    } else if (this.totalChars >= this.maxTotalChars) {
      this.flushAll()
    } else {
      this.arm()
    }
  }

  /** Flush one key — used when its item completes and the final text supersedes it. */
  flushKey(key: string): void {
    const entry = this.pending.get(key)
    if (entry === undefined) return
    this.pending.delete(key)
    this.totalChars -= entry.text.length
    if (this.pending.size === 0) this.disarm()
    this.onFlush([{ key, text: entry.text, meta: entry.meta }])
  }

  /**
   * Flush everything, in insertion order.
   *
   * Callers must do this before appending any lifecycle event — a command
   * starting, a turn completing, an approval being requested. Otherwise the log
   * records those as happening before text the agent had already emitted, and
   * the transcript replays out of order.
   */
  flushAll(): void {
    if (this.pending.size === 0) return
    const entries = [...this.pending].map(([key, e]) => ({ key, text: e.text, meta: e.meta }))
    this.pending.clear()
    this.totalChars = 0
    this.disarm()
    this.onFlush(entries)
  }

  pendingChars(): number {
    return this.totalChars
  }

  pendingKeys(): string[] {
    return [...this.pending.keys()]
  }

  /** Release the timer without emitting. For shutdown paths that already flushed. */
  dispose(): void {
    this.pending.clear()
    this.totalChars = 0
    this.disarm()
  }

  private arm(): void {
    if (this.timer !== null) return
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null
      this.flushAll()
    }, this.maxAgeMs)
  }

  private disarm(): void {
    if (this.timer === null) return
    this.scheduler.clearTimeout(this.timer)
    this.timer = null
  }
}
