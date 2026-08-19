import { useEffect, useState } from 'react'
import type { AgentId } from '@chorus/shared'
import type { LimitsPush } from '../../../shared/ipc.js'
import { untilReset } from '../format.js'

/**
 * What is left of each account, as four readings rather than one.
 *
 * Both providers meter in rolling windows and simply stop answering when one
 * fills. That used to be reported as a single worst-case figure, which answers
 * "am I about to be cut off" and nothing else — not which account, not which
 * window, not whether the wait is an hour or a week. The rail has room for the
 * four separate readings, so it shows them: Codex 5-hour, Codex weekly, Claude
 * 5-hour, Claude weekly, in that order, every time.
 *
 * **The four slots exist whether or not anything has been pushed into them**,
 * and that is the whole point of this file. Deriving the list from the pushes
 * that have arrived produced a rail that showed two readings at startup, three
 * a second later, and four eventually — with Claude above Codex, because the
 * agent ids were sorted alphabetically. A monitoring column whose rows move is
 * one you have to read rather than glance at, and the figure in the top slot
 * meant a different thing from one look to the next.
 *
 * An unreported window reads as unavailable and never as `0%`. Zero is a claim:
 * it says the account is empty, which is the opposite of "nothing has said yet".
 *
 * Moved out of `ActivityBar` when the quick rail replaced it. It is state about
 * an account rather than conversation history, so it lives in a hook and never
 * reaches the event log — see the "State is not history" rule.
 */

/**
 * The two windows every slot list names, and the order they are read in.
 *
 * Declared here rather than imported from `Session.tsx`: that module is a
 * component, and this one is pure enough to be tested without React. The order
 * is the approved one and is not derived from anything — sorting agent ids put
 * Claude first, which is exactly what this constant exists to stop.
 */
const ACCOUNTS: readonly AgentId[] = ['codex', 'claude']

/**
 * Short is anything under a week; long is a week or more.
 *
 * Classified by the reported duration rather than by position in the array, so
 * a provider that pushes its weekly window first still lands in the weekly
 * slot. Both providers report exactly these two; a third would show in neither,
 * which is a deliberate limit of a fixed four-slot rail rather than an
 * oversight — adding one is an edit to `SLOTS` and to the plan that named them.
 */
const WEEK_MINUTES = 10_080

/** The duration each slot stands for when nothing has been reported into it. */
const SLOTS = [
  { kind: 'short', minutes: 300 },
  { kind: 'long', minutes: WEEK_MINUTES },
] as const

export type UsageWindowKind = (typeof SLOTS)[number]['kind']

/** One of the four fixed readings. */
export interface UsageReading {
  readonly agentId: AgentId
  readonly kind: UsageWindowKind
  /** The provider's own window label when it reported one; the slot's otherwise. */
  readonly label: string
  /** Null when nothing has been reported. Never 0, which would be a claim. */
  readonly percent: number | null
  readonly reset: string
  readonly full: string
  /** The raw moment, so a reading can be checked rather than parsed back. */
  readonly resetsAt: number | null
  readonly reported: boolean
  /**
   * How far through the window this reading sits, 0-100.
   *
   * Null when the window's length or its reset moment went unreported: pace is a
   * comparison and it takes both, and a tick drawn from a guess would be a claim
   * about the provider's window that the provider never made.
   */
  readonly elapsedPercent: number | null
  /**
   * Minutes at the end of the window the remaining allowance will not reach, at
   * an even pace. 0 when on or under pace, null when pace is unknowable.
   */
  readonly dryMinutes: number | null
  /** `dryMinutes` in the same shorthand as `reset`; an em dash when not dry. */
  readonly dry: string
}

/**
 * How far through the window, and how much of its end the allowance will not reach.
 *
 * The two sides are shares of the same window — `usedPercent` a share of the
 * allowance, `elapsed` a share of the duration — which is what makes them
 * comparable at all, and it is the comparison the rail could not previously make.
 * Spending faster than the clock shows up as the first overtaking the second.
 *
 * The shortfall is that overtake, and it is exact rather than an estimate: what
 * is left of the allowance (`100 - used`) falls short of what is left of the
 * window (`100 - elapsed`) by precisely `used - elapsed`. At 100% used it is the
 * whole remaining window, which is the plain truth — the account is shut until
 * the reset.
 */
function pace(
  percent: number,
  windowMinutes: number | null,
  resetsAt: number | null,
  now: number
): { elapsedPercent: number | null; dryMinutes: number | null } {
  if (windowMinutes === null || windowMinutes <= 0 || resetsAt === null) {
    return { elapsedPercent: null, dryMinutes: null }
  }
  /*
   * Clamped at both ends. A reset already past reads as a finished window rather
   * than as a negative one, and a provider that reports a moment further out than
   * its own window is long would otherwise put the tick off the left of the bar.
   */
  const left = Math.min(Math.max((resetsAt - now) / (windowMinutes * 60_000), 0), 1)
  const elapsed = 1 - left
  return {
    elapsedPercent: Math.round(elapsed * 100),
    dryMinutes: Math.round(Math.max(percent / 100 - elapsed, 0) * windowMinutes),
  }
}

export function useUsage(): readonly UsageReading[] {
  const [pushes, setPushes] = useState<readonly LimitsPush[]>([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const stop = window.chorus.onLimits((push) => {
      setPushes((current) => [...current.filter((c) => c.agentId !== push.agentId), push])
    })
    // Reset times are absolute, so the countdown is re-rendered rather than recomputed.
    const tick = setInterval(() => {
      setNow(Date.now())
    }, 30_000)
    return () => {
      stop()
      clearInterval(tick)
    }
  }, [])

  return usageReadings(pushes, now)
}

/**
 * The four readings, in the fixed order, from whatever has arrived.
 *
 * Pure and exported because the order and the empty slots are the behaviour
 * worth testing, and neither needs a component to be true. `pushes` may hold
 * one provider, both, in any order, or none.
 */
export function usageReadings(pushes: readonly LimitsPush[], now: number): readonly UsageReading[] {
  return ACCOUNTS.flatMap((agentId) => {
    const push = pushes.find((candidate) => candidate.agentId === agentId)
    /*
     * A window with no reported percentage counts as unreported rather than as
     * a reading of nothing — it would otherwise fill its slot and leave the
     * reading that *did* arrive with nowhere to go.
     */
    const windows = (push?.windows ?? [])
      .filter((window) => window.usedPercent !== null)
      .toSorted((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))

    return SLOTS.map((slot): UsageReading => {
      const found = windows.find((window) =>
        slot.kind === 'long'
          ? (window.windowMinutes ?? 0) >= WEEK_MINUTES
          : (window.windowMinutes ?? 0) < WEEK_MINUTES
      )
      if (found === undefined) {
        return {
          agentId,
          kind: slot.kind,
          label: describeWindow(slot.minutes),
          percent: null,
          reset: '—',
          full: '—',
          resetsAt: null,
          reported: false,
          elapsedPercent: null,
          dryMinutes: null,
          dry: '—',
        }
      }
      const percent = Math.round(Math.min(found.usedPercent ?? 0, 100))
      const { elapsedPercent, dryMinutes } = pace(percent, found.windowMinutes, found.resetsAt, now)
      return {
        agentId,
        kind: slot.kind,
        label: describeWindow(found.windowMinutes),
        percent,
        reset: found.resetsAt === null ? '—' : untilReset(found.resetsAt, now),
        full: fullRemaining(found.resetsAt, now),
        resetsAt: found.resetsAt,
        reported: true,
        elapsedPercent,
        dryMinutes,
        /*
         * Formatted through `untilReset` rather than by a second formatter, so a
         * shortfall and a countdown cannot drift into different shapes — the one
         * that says `1d 3h` must not have a neighbour saying `27h`.
         */
        dry:
          dryMinutes === null || dryMinutes <= 0 ? '—' : untilReset(now + dryMinutes * 60_000, now),
      }
    })
  })
}

/**
 * Every unit, spaced out: `5d 18h 17m`.
 *
 * The rail trades the third unit for width; the popover has no such constraint,
 * and it is where someone goes when the rounded figure is not enough. Saying
 * "5d 18h" in both places would make opening it pointless.
 */
export function fullRemaining(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return '—'
  const ms = resetsAt - now
  if (ms <= 0) return 'now'
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const rest = minutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${String(days)}d`)
  if (days > 0 || hours > 0) parts.push(`${String(hours)}h`)
  parts.push(`${String(rest)}m`)
  return parts.join(' ')
}

/** The window's own duration, in the shortest form that stays honest. */
export function describeWindow(minutes: number | null): string {
  if (minutes === null) return '?'
  if (minutes % 10_080 === 0) return `${String(minutes / 10_080)}w`
  if (minutes % 1_440 === 0) return `${String(minutes / 1_440)}d`
  if (minutes % 60 === 0) return `${String(minutes / 60)}h`
  return `${String(minutes)}m`
}
