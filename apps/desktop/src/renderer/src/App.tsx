import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProbeResult, AppInfo } from '../../shared/ipc.js'

/**
 * M0 shell. This is deliberately a diagnostics view rather than a mock of the
 * conversation UI: it proves the contextBridge round-trip works and that the
 * "drive the installed CLIs" decision (plan §2.5) holds from inside a sandboxed
 * renderer. The real conversation surface lands in M4.
 */
export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [agents, setAgents] = useState<AgentProbeResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load(): Promise<void> {
      const [appInfo, probes] = await Promise.all([
        window.chorus.getAppInfo(),
        window.chorus.probeAgents(),
      ])
      setInfo(appInfo)
      setAgents(probes)
    }
    load().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    })
  }, [])

  return (
    <main className="shell">
      <h1>{t('app.name')}</h1>
      <p className="tagline">{t('app.tagline')}</p>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section>
        <h2>{t('agents.heading')}</h2>
        {agents === null ? (
          <p className="muted">{t('agents.probing')}</p>
        ) : (
          <ul className="agents">
            {agents.map((agent) => (
              <li key={agent.id}>
                <span className={agent.installed ? 'dot ok' : 'dot bad'} aria-hidden="true" />
                <span className="name">{agent.id}</span>
                <span className="muted">
                  {agent.installed
                    ? (agent.version ?? t('agents.unknownVersion'))
                    : t('agents.notFound')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>{t('runtime.heading')}</h2>
        {info === null ? (
          <p className="muted">{t('runtime.loading')}</p>
        ) : (
          <dl className="runtime">
            <dt>{t('runtime.electron')}</dt>
            <dd>{info.electronVersion}</dd>
            <dt>{t('runtime.chromium')}</dt>
            <dd>{info.chromeVersion}</dd>
            <dt>{t('runtime.node')}</dt>
            <dd>{info.nodeVersion}</dd>
            <dt>{t('runtime.platform')}</dt>
            <dd>{info.platform}</dd>
          </dl>
        )}
      </section>
    </main>
  )
}
