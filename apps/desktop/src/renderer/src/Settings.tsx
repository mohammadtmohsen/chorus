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
 * Something only a live session can answer, asked until one can.
 *
 * Both callers ask the main process a question that goes through to a running
 * CLI, and both were opened by a person who has just started the app. The first
 * answer is usually empty for a reason that is not an error: the session is
 * still coming up. A single fetch on mount therefore kept the empty answer
 * forever, and the MCP panel — whose whole purpose is to end a silence — sat
 * there producing one. A screenshot of the running app is what caught it.
 *
 * Three tries over about eight seconds, stopping at the first that answers. A
 * machine with nothing to report never answers, and that is an ordinary outcome
 * rather than something to retry at forever.
 *
 * `ask` is deliberately not a dependency. It is a fresh closure every render,
 * and this is a question asked when the sheet opens, not on every paint.
 */
function useFromLiveSession<T>(ask: () => Promise<T[]>, empty: T[]): T[] {
  const [value, setValue] = useState<T[]>(empty)

  useEffect(() => {
    let live = true
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const run = (): void => {
      ask()
        .then((answer) => {
          if (!live) return
          if (answer.length > 0) {
            setValue(answer)
            return
          }
          attempt += 1
          if (attempt < 3) timer = setTimeout(run, attempt * 3_000)
        })
        .catch(() => {
          // No session to ask, or a CLI too old. Either way there is nothing to
          // report, which the caller renders as nothing at all.
        })
    }
    run()

    return () => {
      live = false
      // A closed sheet asks nothing more; without this the last retry still
      // fires, one IPC call after nobody is listening.
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  return value
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
  const servers = useFromLiveSession(
    () => window.chorus.mcpServers().then((result) => result.servers),
    []
  )

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
 * The plugins this machine gives its agents.
 *
 * A plugin loads into every session and contributes commands, agents, skills and
 * hooks — capabilities the agent has and Chorus otherwise never mentions. The
 * disabled ones are the point, for the same reason `needs-auth` is on a server:
 * configured, believed in, contributing nothing.
 *
 * Asked once rather than retried, unlike the panels above it: this comes from
 * the CLI on disk rather than from a live session, so an empty answer means
 * "none installed" and is the final answer rather than a race.
 */
function Plugins(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [plugins, setPlugins] = useState<IpcResponse<'agents:plugins'>['plugins']>([])

  useEffect(() => {
    let live = true
    window.chorus
      .plugins()
      .then((result) => {
        if (live) setPlugins(result.plugins)
      })
      .catch(() => {
        // A CLI too old for the subcommand, or none installed. Both render as
        // nothing at all.
      })
    return () => {
      live = false
    }
  }, [])

  if (plugins.length === 0) return null

  return (
    <fieldset className="settings-plugins">
      <legend>{t('plugins.heading')}</legend>
      <ul>
        {plugins.map((plugin) => (
          <li key={plugin.id} data-enabled={plugin.enabled}>
            <span className="settings-plugin-name">{plugin.name}</span>
            <span className="settings-plugin-scope">
              {plugin.scope === ''
                ? ''
                : t(`plugins.scope.${plugin.scope}`, { defaultValue: plugin.scope })}
              {plugin.version === undefined ? '' : ` · ${plugin.version}`}
            </span>
            {!plugin.enabled && (
              <span className="settings-plugin-off">{t('plugins.disabled')}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="footnote">{t('plugins.note')}</p>
    </fieldset>
  )
}

/**
 * Which account each agent is signed in as.
 *
 * The question a room running several projects at once eventually asks. The
 * plan window that fills up belongs to an account, and until now nothing in
 * Chorus could say which — the rail shows a percentage with no name on it.
 * `claude` and `codex` are separate logins and may well be different people.
 *
 * Only what the provider volunteers. Off the first-party API there is no plan
 * and no email — a Bedrock session authenticates with AWS credentials — so a
 * row shows what it has and the panel disappears entirely when nothing does.
 */
function Accounts(): React.JSX.Element | null {
  const { t } = useTranslation()
  const accounts = useFromLiveSession(
    () => window.chorus.accounts().then((result) => result.accounts),
    []
  )

  if (accounts.length === 0) return null

  return (
    <fieldset className="settings-accounts">
      <legend>{t('account.heading')}</legend>
      <ul>
        {accounts.map((account) => (
          <li key={account.agentId}>
            <span className={`settings-account-agent voice--${account.agentId}`}>
              <span className="voice-dot" aria-hidden="true" />
              {account.agentId}
            </span>
            <span className="settings-account-who">
              {account.email ?? account.organization ?? t('account.signedIn')}
            </span>
            {account.plan !== undefined && (
              <span className="settings-account-plan">{account.plan}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="footnote">{t('account.note')}</p>
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
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')

  /*
   * Asked until a session can answer, like the panels above.
   *
   * The list comes from a running CLI, and this sheet can be opened before any
   * session has started — in which case a single fetch got nothing and the whole
   * "New sessions start with" section returned null, permanently, for that
   * opening. Measured: opened at launch it did not exist; opened twelve seconds
   * later it had both rows.
   *
   * Claude's list, when there is one. It is the agent with an effort control,
   * and a single pair of selects cannot honestly speak for two providers.
   */
  const models = useFromLiveSession<{ value: string; label: string; effortLevels: string[] }>(
    () =>
      window.chorus
        .knownModels()
        .then((known) => known.agents.find((agent) => agent.agentId === 'claude')?.models ?? []),
    []
  )

  /* The saved choices are ours and on disk, so one ask is the whole story. */
  useEffect(() => {
    let live = true
    window.chorus
      .readSettings()
      .then((settings) => {
        if (!live) return
        setModel(settings.model)
        setEffort(settings.effortLevel)
      })
      .catch(() => {
        // Defaults stand, which is what the empty strings already mean.
      })
    return () => {
      live = false
    }
  }, [])

  if (models.length === 0) return null

  /*
   * The chosen model's levels, or the first row's when nothing is chosen.
   *
   * Nothing chosen means the provider's default is in force, and the first row
   * *is* that default — the CLI calls it "Default (recommended)". Matching on
   * the empty string found no row, so the effort control did not render until a
   * model had been picked, which made it look absent rather than defaulted.
   */
  const levels =
    (model === '' ? models[0] : models.find((entry) => entry.value === model))?.effortLevels ?? []

  return (
    <fieldset className="settings-models">
      <legend>{t('settings.newSessions')}</legend>
      <label>
        <span>{t('settings.model')}</span>
        <select
          value={model}
          onChange={(event) => {
            const next = event.target.value
            /*
             * The effort is reconciled with the model, not left to drift.
             *
             * Effort levels belong to a model, so choosing a different one can
             * leave the saved level absent from the new list. The select then had
             * no matching option and the browser drew it blank, while the file
             * still held the old value — the picker said one thing and disk said
             * another, which is the version of this bug that gets reported as
             * "choosing a model resets my effort".
             *
             * Cleared to the provider's default when it no longer applies, and
             * both fields are written in one call so the two cannot disagree.
             */
            const levelsFor =
              (next === '' ? models[0] : models.find((entry) => entry.value === next))
                ?.effortLevels ?? []
            const keep = effort !== '' && levelsFor.includes(effort)
            setModel(next)
            if (!keep) setEffort('')
            void window.chorus.writeSettings({
              model: next,
              ...(keep ? {} : { effortLevel: '' }),
            })
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

          <Accounts />

          <McpServers />

          <Plugins />

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
