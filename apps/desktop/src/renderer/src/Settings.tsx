import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProbeResult, IpcResponse } from '../../shared/ipc.js'
import { useDialog } from './useDialog.js'

type AgentId = 'codex' | 'claude'
const AGENTS: AgentId[] = ['codex', 'claude']

export interface Defaults {
  agents: AgentId[]
  cwd: string
  profileId: string
}

/**
 * Whether the MCP servers this machine gives its agents are any use.
 *
 * `settingSources` is deliberately omitted so agents inherit the user's full
 * config — their servers, and their servers' failures. None of those failures is
 * loud: a server that needs authenticating is not an error and nothing retries
 * it, and the only symptom is an agent quietly lacking a capability you believe
 * it has. That is the entire reason this exists.
 *
 * Here rather than on a card, because the servers are the machine's and not the
 * conversation's. Asked live each time it opens, since health is exactly the
 * thing that changes.
 */
function McpServers(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [servers, setServers] = useState<IpcResponse<'agents:mcp'>['servers']>([])

  useEffect(() => {
    let live = true
    window.chorus
      .mcpServers()
      .then((result) => {
        if (live) setServers(result.servers)
      })
      .catch(() => {
        // No session to ask, or a CLI too old. Either way there is nothing to
        // report, which this renders as nothing at all.
      })
    return () => {
      live = false
    }
  }, [])

  if (servers.length === 0) return null

  return (
    <fieldset className="settings-mcp">
      <legend>{t('mcp.heading')}</legend>
      <ul>
        {servers.map((server) => (
          <li key={server.name} data-status={server.status}>
            <span className="settings-mcp-name">{server.name}</span>
            <span className="settings-mcp-status">
              {t(`mcp.status.${server.status}`)}
              {server.status === 'connected' && server.tools !== undefined
                ? ` · ${t('mcp.tools', { count: server.tools })}`
                : ''}
            </span>
            {server.error !== undefined && (
              <span className="settings-mcp-error" title={server.error}>
                {server.error}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="footnote">{t('mcp.note')}</p>
    </fieldset>
  )
}

/**
 * What a *new* session's agents start as.
 *
 * The one place this sheet still keeps a default, and it is labelled as one.
 * The comment above explains why the cast, directory and profile left: two
 * controls with the same name doing different things is worse than one. This is
 * not that — a conversation's own picker changes the conversation you are
 * looking at, and this changes the next one you open. The wording has to carry
 * that distinction or it becomes the thing this sheet got rid of.
 *
 * The list is whatever a running session last reported. `supportedModels()` is a
 * control request to a live CLI and this sheet can be opened with nothing
 * running, so nothing is asked here — a machine that has not started a session
 * yet simply has no list, and the control says so rather than pretending.
 */
function DefaultModel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [models, setModels] = useState<{ value: string; label: string; effortLevels: string[] }[]>(
    []
  )
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')

  useEffect(() => {
    let live = true
    Promise.all([window.chorus.knownModels(), window.chorus.readSettings()])
      .then(([known, settings]) => {
        if (!live) return
        // Claude's, when there is one: it is the agent with an effort control,
        // and a single pair of selects cannot honestly speak for two providers.
        setModels(known.agents.find((agent) => agent.agentId === 'claude')?.models ?? [])
        setModel(settings.model)
        setEffort(settings.effortLevel)
      })
      .catch(() => {
        // Nothing to offer is a state this renders, not an error it reports.
      })
    return () => {
      live = false
    }
  }, [])

  if (models.length === 0) return null

  const levels = models.find((entry) => entry.value === model)?.effortLevels ?? []

  return (
    <fieldset className="settings-models">
      <legend>{t('settings.newSessions')}</legend>
      <label>
        <span>{t('settings.model')}</span>
        <select
          value={model}
          onChange={(event) => {
            const next = event.target.value
            setModel(next)
            void window.chorus.writeSettings({ model: next })
          }}
        >
          <option value="">{t('settings.providerDefault')}</option>
          {models.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      {levels.length > 0 && (
        <label>
          <span>{t('settings.effort')}</span>
          <select
            value={effort}
            onChange={(event) => {
              const next = event.target.value
              setEffort(next)
              void window.chorus.writeSettings({ effortLevel: next })
            }}
          >
            <option value="">{t('settings.providerDefault')}</option>
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="footnote">{t('settings.newSessionsNote')}</p>
    </fieldset>
  )
}

/**
 * What only this sheet can tell you.
 *
 * It used to hold the cast, the directory and the permission profile — all three
 * now live in the pane that owns them, where changing one affects the
 * conversation you are looking at rather than the next one you open. Two
 * controls with the same name doing different things is worse than one, so the
 * duplicates are gone and a new session simply starts where the last one was.
 *
 * What is left is what a session cannot answer: which agents this machine has
 * and at what version, and the way into the log — plus `DefaultModel` above,
 * which is the one default that came back. It earns its place by naming itself
 * one: "new sessions start with", against a card control that changes the
 * conversation in front of you. If that wording ever slips, it becomes exactly
 * the duplicate this sheet got rid of.
 */
export function Settings(props: {
  probes: AgentProbeResult[] | null
  onClose: () => void
  onOpenLogs: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(props.onClose)

  /*
   * The companion VS Code extension.
   *
   * Here rather than in a pane: it is a property of the machine, like which
   * agent CLIs are installed, not of the conversation you happen to be looking
   * at. Installing is always an explicit press — Chorus ships the VSIX but
   * never puts anything into another application on its own.
   */
  const [ext, setExt] = useState<IpcResponse<'ide:extensionStatus'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refreshExt = useCallback(() => {
    window.chorus
      .ideExtensionStatus()
      .then(setExt)
      .catch(() => {
        // An optional integration must not be able to break this sheet.
        setExt(null)
      })
  }, [])

  useEffect(refreshExt, [refreshExt])

  const install = useCallback(() => {
    setBusy(true)
    setNote(t('ide.extension.working'))
    window.chorus
      .ideInstallExtension()
      .then((result) => {
        setNote(
          result.ok
            ? t('ide.extension.done')
            : t('ide.extension.failed', { reason: result.reason ?? 'unknown' })
        )
        refreshExt()
      })
      .catch(() => {
        setNote(t('ide.extension.failed', { reason: 'unknown' }))
      })
      .finally(() => {
        setBusy(false)
      })
  }, [refreshExt, t])

  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialog}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.heading')}
      >
        <header className="sheet-head">
          <strong>{t('settings.heading')}</strong>
          <span className="hint">{t('settings.subhead')}</span>
        </header>

        <div className="sheet-body">
          {ext !== null && (
            <fieldset className="cast">
              <legend>{t('ide.extension.title')}</legend>
              <p className="hint">
                {!ext.cliAvailable
                  ? t('ide.extension.missing')
                  : ext.bundledVersion === null
                    ? t('ide.extension.unavailable')
                    : ext.need === 'install'
                      ? t('ide.extension.none')
                      : ext.need === 'update'
                        ? t('ide.extension.outdated', {
                            installed: ext.installedVersion ?? '',
                            bundled: ext.bundledVersion,
                          })
                        : t('ide.extension.installed', { version: ext.installedVersion ?? '' })}
              </p>
              {ext.cliAvailable && ext.need !== 'none' && (
                <button type="button" className="btn" disabled={busy} onClick={install}>
                  {ext.need === 'update' ? t('ide.extension.update') : t('ide.extension.install')}
                </button>
              )}
              {note !== null && <p className="hint">{note}</p>}
            </fieldset>
          )}

          <fieldset className="cast">
            <legend>{t('settings.installed')}</legend>
            {AGENTS.map((id) => {
              const probe = props.probes?.find((p) => p.id === id)
              const installed = probe?.installed ?? false
              return (
                <p key={id} className={`cast-member voice--${id}`} data-on={installed}>
                  <span className="voice-dot" aria-hidden="true" />
                  <span className="cast-name">{id}</span>
                  <span className="cast-version">
                    {props.probes === null
                      ? t('agents.probing')
                      : installed
                        ? (probe?.version ?? t('agents.unknownVersion'))
                        : t('agents.notFound', { agent: id })}
                  </span>
                </p>
              )
            })}
          </fieldset>

          <McpServers />

          <DefaultModel />

          <p className="footnote">{t('settings.paneNote')}</p>
        </div>

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={props.onOpenLogs}>
            {t('logs.open')}
          </button>
          <button type="button" className="btn btn--go" onClick={props.onClose}>
            {t('settings.done')}
          </button>
        </div>
      </section>
    </div>
  )
}
