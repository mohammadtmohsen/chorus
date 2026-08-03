/**
 * Explicit success/failure at layer boundaries. Throwing is still correct for
 * programmer errors; this is for expected failures the caller must handle —
 * an agent that won't start, a path outside the project root, a denied approval.
 */
export type Result<T, E = Error> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export const isOk = <T, E>(r: Result<T, E>): r is { readonly ok: true; readonly value: T } => r.ok

export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value
  throw r.error instanceof Error ? r.error : new Error(String(r.error))
}
