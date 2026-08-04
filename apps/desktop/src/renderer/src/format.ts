/**
 * Numbers a person can read at a glance.
 *
 * Exact figures are for the log; these are for a header you look at while
 * deciding whether to keep going.
 */

/** 1.2k, 340k, 3.4M — thousands are the unit a token count is thought in. */
export function compactTokens(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/**
 * Money, at the precision the amount deserves.
 *
 * Under a dollar, cents are the whole story and rounding to two decimals would
 * turn most of a session into $0.00. Over it, cents are noise.
 */
export function money(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 1) return `$${usd.toFixed(2)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString()}`
}

/**
 * How long until a moment, in the largest unit that still says something.
 *
 * "2h" rather than "2h 14m 3s": a limit resetting is something you plan around,
 * not something you count down to.
 */
export function untilReset(resetsAt: number, now: number): string {
  const ms = resetsAt - now
  if (ms <= 0) return 'now'

  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${String(Math.max(minutes, 1))}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`
  }

  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${String(days)}d` : `${String(days)}d ${String(restHours)}h`
}
