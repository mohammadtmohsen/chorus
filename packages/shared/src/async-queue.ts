/**
 * A single-consumer push queue exposed as an async iterable.
 *
 * Agent event streams are all shaped this way — a producer pushes whenever the
 * provider emits, and one consumer drains. Hand-rolling the queue-plus-waiter
 * dance at each site is how off-by-one and lost-wakeup bugs get in, so it lives
 * here once.
 *
 * Single consumer by design: two iterators would race for items and each would
 * see an arbitrary half of the stream.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiter: (() => void) | null = null
  private closed = false
  private consumed = false

  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.wake()
  }

  /** Ends the stream once buffered items have been drained. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.wake()
  }

  get isClosed(): boolean {
    return this.closed
  }

  get size(): number {
    return this.items.length
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    if (this.consumed) throw new Error('AsyncQueue supports a single consumer')
    this.consumed = true

    for (;;) {
      while (this.items.length > 0) {
        const next = this.items.shift()
        // `shift` can only return undefined on an empty array, which the loop
        // guard excludes — but `noUncheckedIndexedAccess` cannot know that.
        if (next !== undefined) yield next
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }

  private wake(): void {
    const w = this.waiter
    this.waiter = null
    w?.()
  }
}
