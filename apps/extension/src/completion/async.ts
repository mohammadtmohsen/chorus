export function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | null): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = (): void => {
      finish(null)
    }
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve()
      .then(() => (signal.aborted ? null : work()))
      .then(finish, () => {
        finish(null)
      })
  })
}

export async function runBounded<T>(
  work: readonly (() => Promise<T>)[],
  concurrency: number,
  signal: AbortSignal
): Promise<T[]> {
  const results: T[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (!signal.aborted && next < work.length) {
      const index = next
      next += 1
      const task = work[index]
      if (task !== undefined) results[index] = await task()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker))
  return results
}
