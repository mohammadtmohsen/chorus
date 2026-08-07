import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@chorus/shared'
import type { LimitsPush } from '../../../shared/ipc.js'
import { untilReset } from '../format.js'

/**
 * The strip down the left edge: the session list, and what is left of the
 * accounts that run it.
 *
 * Modelled on an editor's activity bar, but it does not only navigate. An
 * activity bar's real value is being the thing you glance at without opening
 * anything, and the question most worth answering that way is "am I about to be
 * cut off" — both providers meter in rolling windows and simply stop answering
 * when one fills. That was already reported, in a thin bar in the masthead, and
 * it went unread until an account hit its ceiling mid-task. Here it is a ring
 * in a fixed place that fills as the window does.
 */
export function ActivityBar(props: {
  /** How many sessions have an agent working in them right now. */
  readonly working: number
  readonly sidebarHidden: boolean
  readonly onToggleSidebar: () => void
  readonly starting: boolean
  readonly onNewSession: () => void
  readonly onOpenSettings: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const usage = useUsage()
  const [refreshing, setRefreshing] = useState(false)
  const usageRef = useRef<HTMLButtonElement>(null)
  const [detail, setDetail] = useState<{ top: number; left: number } | null>(null)

  const showDetail = (): void => {
    const box = usageRef.current?.getBoundingClientRect()
    if (box === undefined) return
    /*
     * Measured at open, not tracked: the bar does not move while a pointer is
     * over it, and a listener that followed it would run on every scroll for a
     * panel that is almost never up.
     */
    setDetail({ top: Math.round(box.top), left: Math.round(box.right + 8) })
  }
  const hideDetail = (): void => {
    setDetail(null)
  }

  return (
    <nav className="activity-bar" aria-label={t('activity.label')}>
      <ul className="activity-group">
        <li>
          <button
            type="button"
            className="activity-item"
            data-active={props.sidebarHidden ? undefined : 'true'}
            aria-pressed={!props.sidebarHidden}
            title={props.sidebarHidden ? t('activity.show') : t('activity.hide')}
            onClick={props.onToggleSidebar}
          >
            <SessionsIcon />
            <span className="sr-only">
              {props.sidebarHidden ? t('activity.show') : t('activity.hide')}
            </span>
            {/*
              A count of what is running, on the one icon that stands for all of
              it. With the list closed this is the only thing still saying that
              anything is happening at all.
            */}
            {props.working > 0 && (
              <span className="activity-badge" aria-hidden="true">
                {props.working}
              </span>
            )}
          </button>
        </li>
        {/*
          Starting a session is the one thing you do more often than anything
          else here, and it was only reachable inside the list — which the
          button above can now close. It lives on the bar so it survives that.
        */}
        <li>
          <button
            type="button"
            className="activity-item"
            disabled={props.starting}
            title={t('conversation.newSession')}
            onClick={props.onNewSession}
          >
            <PlusIcon />
            <span className="sr-only">{t('conversation.newSession')}</span>
          </button>
        </li>
      </ul>

      <ul className="activity-group activity-group--foot">
        {usage.length > 0 && (
          <li>
            {/*
              The figures themselves, stacked.
              
              A ring showed one window as an arc, which is a shape you have to
              already know how to read — and it hid the other window entirely.
              Two lines of text per window fit this column and say the thing
              outright: how long the window is, and how much of it is gone.
            */}
            <button
              type="button"
              className="activity-item activity-usage"
              ref={usageRef}
              data-refreshing={refreshing ? 'true' : undefined}
              disabled={refreshing}
              title={t('activity.refresh')}
              onPointerEnter={showDetail}
              onPointerLeave={hideDetail}
              onFocus={showDetail}
              onBlur={hideDetail}
              onClick={() => {
                setRefreshing(true)
                window.chorus
                  .refreshLimits()
                  .catch(() => undefined)
                  .finally(() => {
                    // Held briefly: the read usually returns faster than a
                    // frame, and a spinner nobody sees is a click that looks
                    // like it did nothing.
                    setTimeout(() => {
                      setRefreshing(false)
                    }, 450)
                  })
              }}
            >
              {usage.map((account) => (
                <span key={account.agentId} className="activity-account" data-agent={account.agentId}>
                  {/*
                    Whose account this is, turned on its side.
                    
                    The windows belong to an account, not to the app, and with
                    two agents installed there are two sets of them — unlabelled,
                    the four figures read as one account's. Rotated because the
                    column has 12px to spare across and a name needs more than
                    that lying down.
                  */}
                  <span className="activity-account-name" aria-hidden="true">
                    {account.agentId}
                  </span>
                  <span className="activity-account-windows">
                    {account.windows.map((window) => (
                      <span
                        key={window.label}
                        className="activity-window"
                        data-spent={window.percent >= 90 ? 'nearly' : undefined}
                      >
                        <span className="activity-window-label">{window.label}</span>
                        <span className="activity-window-percent">{window.percent}%</span>
                        {/*
                          When it comes back, to the nearest whole unit.
                          
                          "3h 57m" does not fit this column and does not need
                          to: at a glance the question is whether the wait is
                          hours or days, and the exact minute is in the hover.
                        */}
                        <span className="activity-window-reset">{window.remaining}</span>
                      </span>
                    ))}
                  </span>
                </span>
              ))}
              <span className="sr-only">
                {usage
                  .flatMap((account) =>
                    account.windows.map((window) =>
                      t('activity.usage', {
                        agent: account.agentId,
                        percent: window.percent,
                        window: window.label,
                        reset: window.reset,
                      })
                    )
                  )
                  .join('. ')}
              </span>
            </button>
            {/*
              The full reading, on hover.
              
              The column has room for a number and not for what it means — which
              window, how long until it comes back. Portalled to the body
              because the shell clips its overflow, and a panel that renders
              inside the bar is a panel with 60px to live in.
            */}
            {detail !== null &&
              createPortal(
                <div className="usage-tip" style={{ top: detail.top, left: detail.left }} role="tooltip">
                  <ul className="limits">
                    {usage.flatMap((account) =>
                      account.windows.map((window) => (
                        <li
                          key={`${account.agentId}:${window.label}`}
                          className={`limit voice--${account.agentId}`}
                        >
                          <span className="voice-dot" aria-hidden="true" />
                          <span className="limit-window">{window.label}</span>
                          <span className="limit-bar" aria-hidden="true" data-full={window.percent >= 90}>
                            <i style={{ width: `${String(window.percent)}%` }} />
                          </span>
                          <span className="limit-percent">{window.percent}%</span>
                          <span className="limit-reset">
                            {t('limits.resets', { time: window.full })}
                          </span>
                        </li>
                      ))
                    )}
                  </ul>
                </div>,
                document.body
              )}
          </li>
        )}
        <li>
          <button
            type="button"
            className="activity-item"
            title={t('settings.open')}
            onClick={props.onOpenSettings}
          >
            <GearIcon />
            <span className="sr-only">{t('settings.open')}</span>
          </button>
        </li>
      </ul>
    </nav>
  )
}

/*
 * Drawn rather than typed.
 *
 * A glyph from the text font is sized by that font's metrics and sits on its
 * baseline, so it lands off-centre next to a stroked icon and changes size with
 * the type scale rather than with the button.
 */
function SessionsIcon(): React.JSX.Element {
  return (
    <svg className="activity-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="6" rx="2" />
      <rect x="3.5" y="14" width="17" height="6" rx="2" />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg className="activity-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function GearIcon(): React.JSX.Element {
  return (
    <svg className="activity-icon" viewBox="0 0 24 24" aria-hidden="true">
      {/* Teeth, not rays: eight spokes radiating from a circle reads as a sun. */}
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

/**
 * The fullest window across every agent, which is the one that will stop you.
 *
 * Deliberately not a per-agent breakdown: at this width there is room for one
 * number, and the number that matters is the worst one — the masthead still
 * carries the full picture for anyone who wants it.
 */
function useUsage(): {
  agentId: AgentId
  windows: {
    percent: number
    label: string
    reset: string
    remaining: string
    full: string
  }[]
}[] {
  const [pushes, setPushes] = useState<LimitsPush[]>([])
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

  /*
   * Grouped by account, each account's windows shortest first.
   *
   * Kept per agent rather than flattened: two installed agents report two sets
   * of windows, and merged they read as one account's. Shortest first rather
   * than fullest first, because the order has to be the same every time you
   * look or the number in the top slot means something different from one
   * glance to the next. A window with no reported percentage is dropped — it
   * would read as 0% used, which is a claim.
   */
  return pushes
    .map((push) => ({
      agentId: push.agentId,
      windows: push.windows
        .filter((window) => window.usedPercent !== null)
        .sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))
        .map((window) => ({
          percent: Math.round(Math.min(window.usedPercent ?? 0, 100)),
          label: describeWindow(window.windowMinutes),
          // Two readings of the same moment: a phrase for the tooltip's
          // sentence, and a tight one for the column.
          reset: window.resetsAt === null ? '—' : untilReset(window.resetsAt, now),
          remaining: compactRemaining(window.resetsAt, now),
          full: fullRemaining(window.resetsAt, now),
        })),
    }))
    .filter((account) => account.windows.length > 0)
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
}

/**
 * Every unit, spaced out: `5d 18h 17m`.
 *
 * The strip trades the third unit for width; the tooltip has no such
 * constraint, and it is where someone goes when the rounded figure is not
 * enough. Saying "5d 18h" in both places would make opening it pointless.
 */
function fullRemaining(resetsAt: number | null, now: number): string {
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

/**
 * The wait to two units: `12m`, `2h12m`, `5d19h`.
 *
 * Two rather than three because the third never changes a decision — nobody
 * waits differently for 5d19h than for 5d19h17m — and it is the difference
 * between fitting this column and not. The precise moment is in the tooltip.
 *
 * Separate from `untilReset`, which gives the same two units with a space in
 * them: right for a sentence, too wide for a 60px strip.
 */
function compactRemaining(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return '—'
  const ms = resetsAt - now
  if (ms <= 0) return 'now'
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const rest = minutes % 60
  if (days > 0) return `${String(days)}d${String(hours)}h`
  if (hours > 0) return `${String(hours)}h${String(rest)}m`
  return `${String(rest)}m`
}

/** The window's own duration, in the shortest form that stays honest. */
function describeWindow(minutes: number | null): string {
  if (minutes === null) return '?'
  if (minutes % 10_080 === 0) return `${String(minutes / 10_080)}w`
  if (minutes % 1_440 === 0) return `${String(minutes / 1_440)}d`
  if (minutes % 60 === 0) return `${String(minutes / 60)}h`
  return `${String(minutes)}m`
}
