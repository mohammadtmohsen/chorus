import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LimitsPush, UsageWindowShape } from '../../shared/ipc.js'
import { untilReset } from './format.js'

/**
 * How full each agent's account windows are, in the masthead.
 *
 * Both providers meter subscriptions in rolling windows — five hours and a week
 * — and both will simply stop answering when one fills. Knowing that an hour
 * beforehand is the difference between finishing what you were doing and
 * discovering it mid-turn.
 *
 * Nothing is shown for an account with no plan window (an API key, Bedrock), and
 * nothing is shown before a provider has said anything. An empty header is
 * honest; a guessed one is not.
 */
export function Limits(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [byAgent, setByAgent] = useState<LimitsPush[]>([])
  // Reset times are absolute, so the countdown has to be re-rendered, not recomputed.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const stop = window.chorus.onLimits((push) => {
      setByAgent((current) => [...current.filter((c) => c.agentId !== push.agentId), push])
    })
    const tick = setInterval(() => {
      setNow(Date.now())
    }, 30_000)
    return () => {
      stop()
      clearInterval(tick)
    }
  }, [])

  if (byAgent.length === 0) return null

  return (
    <ul className="limits">
      {byAgent.map((agent) =>
        agent.windows.map((window) => (
          <li
            key={`${agent.agentId}:${window.id}`}
            className={`limit voice--${agent.agentId}`}
            /*
             * The provider's own numbers, on hover.
             *
             * The label is derived from the window's reported duration, and when
             * that disagrees with what the CLI shows you, the raw figures are
             * what settle it. Chorus should be checkable, not just believed.
             */
            title={t('limits.detail', {
              agent: agent.agentId,
              minutes: window.windowMinutes ?? '?',
              percent: window.usedPercent === null ? '—' : Math.round(window.usedPercent),
              at:
                window.resetsAt === null
                  ? t('limits.unknownReset')
                  : new Date(window.resetsAt).toLocaleString(),
            })}
          >
            <span className="voice-dot" aria-hidden="true" />
            <span className="limit-window">{describeWindow(window)}</span>
            <span
              className="limit-bar"
              aria-hidden="true"
              data-full={(window.usedPercent ?? 0) >= 90}
            >
              <i style={{ width: `${String(Math.min(window.usedPercent ?? 0, 100))}%` }} />
            </span>
            <span className="limit-percent">
              {window.usedPercent === null ? '—' : `${String(Math.round(window.usedPercent))}%`}
            </span>
            {window.resetsAt !== null && (
              <span className="limit-reset">
                {t('limits.resets', { time: untilReset(window.resetsAt, now) })}
              </span>
            )}
          </li>
        ))
      )}
    </ul>
  )
}

/**
 * The window's own length, said the way people say it.
 *
 * Derived from the duration rather than the provider's name for the slot, so
 * "5h" means five hours whichever provider reported it.
 */
function describeWindow(window: UsageWindowShape): string {
  const minutes = window.windowMinutes
  if (minutes === null) return window.id
  if (minutes % 10_080 === 0) return `${String(minutes / 10_080)}w`
  if (minutes % 1_440 === 0) return `${String(minutes / 1_440)}d`
  if (minutes % 60 === 0) return `${String(minutes / 60)}h`
  return `${String(minutes)}m`
}
