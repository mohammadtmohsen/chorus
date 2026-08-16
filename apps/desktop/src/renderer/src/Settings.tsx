import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MAX_EXPLAIN_LANGUAGE,
  normaliseExplainLanguage,
  type AgentProbeResult,
  type IpcResponse,
} from '../../shared/ipc.js'
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
/**
 * The language an explanation comes back in.
 *
 * Its own fieldset, deliberately **outside** `DefaultModel`, which returns
 * `null` whenever no live Claude model list exists. A language field placed in
 * there would silently vanish on a machine whose CLI has not been asked yet —
 * and this is the only surface the feature is discoverable from, so vanishing
 * takes the feature with it.
 *
 * A text field rather than a picker: "Lebanese Arabic" and "simple Arabic" are
 * answers a locale list cannot express, and the person reading is the one who
 * knows which they want.
 */
function ExplainLanguage(): React.JSX.Element {
  const { t } = useTranslation()
  const [language, setLanguage] = useState('')

  useEffect(() => {
    let live = true
    window.chorus
      .readSettings()
      .then((settings) => {
        if (live) setLanguage(settings.explainLanguage)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  return (
    <fieldset className="settings-language">
      <legend>{t('settings.explainHeading')}</legend>
      <label>
        <span>{t('settings.explainLanguage')}</span>
        <input
          type="text"
          value={language}
          maxLength={MAX_EXPLAIN_LANGUAGE}
          placeholder={t('settings.explainPlaceholder')}
          /*
           * Persisted on every change, like the model and effort rows, rather
           * than on blur. Blur is not guaranteed: closing the sheet with Escape
           * loses whatever was typed, and a preference that silently fails to
           * save is worse than one that saves a keystroke early.
           *
           * What is *displayed* stays raw until blur, though. Normalising every
           * keystroke would collapse the space in "Lebanese Arabic" the instant
           * it was typed, making the second word impossible to start.
           */
          onChange={(e) => {
            setLanguage(e.target.value)
            void window.chorus.writeSettings({
              explainLanguage: normaliseExplainLanguage(e.target.value),
            })
          }}
          onBlur={() => {
            setLanguage(normaliseExplainLanguage(language))
          }}
        />
      </label>
      {/*
        Persistent, not a placeholder. What the field accepts is wider than the
        word "language" suggests, and a hint that vanishes on the first keystroke
        is one nobody reads twice.
      */}
      <p className="footnote">{t('settings.explainNote')}</p>
    </fieldset>
  )
}

/**
 * One agent's model and effort, for new sessions.
 *
 * Per agent because the two providers share no model. One pair of selects for
 * both was not a simplification: it sent a name from Claude's catalogue to
 * Codex's API, because Claude's list was the only one this sheet ever showed.
 *
 * Codex's effort levels differ *per model* — `ultra` exists on some and not
 * others — which is why the levels come off the chosen model rather than any
 * list held globally.
 */
function AgentDefaults({
  agentId,
  status,
  models,
  model,
  effort,
  onChange,
}: {
  agentId: 'codex' | 'claude'
  status: 'unqueried' | 'loading' | 'ready' | 'failed'
  /* Taken from the response rather than restated, so the two cannot drift. */
  models: IpcResponse<'agents:models'>['agents'][number]['models']
  model: string
  effort: string
  onChange: (next: { model?: string; effort?: string }) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  /*
   * Which row "the provider's default" actually means.
   *
   * The declared default when there is one, and only then the first row. Codex
   * reports `isDefault`; Claude has no such field and instead puts its default
   * first and labels it "Default (recommended)". Reading position alone offered
   * the effort levels of whichever model happened to sort first, which is a
   * control that lies as soon as a catalogue is reordered.
   */
  const providerDefault = models.find((entry) => entry.isDefault === true) ?? models[0]
  const levels =
    (model === '' ? providerDefault : models.find((entry) => entry.value === model))
      ?.effortLevels ?? []

  return (
    <div className="settings-agent">
      <span className={`settings-agent-name voice--${agentId}`}>{agentId}</span>

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
             * leave the saved level absent from the new list. The select then
             * had no matching option and the browser drew it blank, while the
             * file still held the old value — the picker said one thing and disk
             * said another, which is the version of this bug that gets reported
             * as "choosing a model resets my effort".
             */
            const levelsFor =
              (next === '' ? providerDefault : models.find((entry) => entry.value === next))
                ?.effortLevels ?? []
            const keep = effort !== '' && levelsFor.includes(effort)
            onChange({ model: next, ...(keep ? {} : { effort: '' }) })
          }}
        >
          {/*
            Always first and always reachable, including when discovery failed
            and this is the only option there is. A saved model the CLI no longer
            accepts can stop a session starting — which is exactly when the
            catalogue cannot be fetched, and exactly when someone needs a way
            back to "nothing chosen".
          */}
          <option value="">{t('settings.providerDefault')}</option>
          {models.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
          {/*
            A saved value the catalogue does not contain still has to be
            selectable, or the control silently shows something other than what
            is on disk.
          */}
          {model !== '' && !models.some((entry) => entry.value === model) && (
            <option value={model}>{model}</option>
          )}
        </select>
      </label>

      {levels.length > 0 && (
        <label>
          <span>{t('settings.effort')}</span>
          <select
            value={effort}
            onChange={(event) => {
              onChange({ effort: event.target.value })
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

      {/*
        Why the list is what it is, rather than an empty control that looks
        broken. These were one silence until discovery began recording a state.
      */}
      {status !== 'ready' && <p className="footnote">{t(`settings.catalogue.${status}`)}</p>}
      {status === 'ready' && models.length === 0 && (
        <p className="footnote">{t('settings.catalogue.none')}</p>
      )}
    </div>
  )
}

function DefaultModel(): React.JSX.Element {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<IpcResponse<'agents:models'>['agents']>([])
  const [chosen, setChosen] = useState<{
    models: Record<string, string>
    efforts: Record<string, string>
  }>({ models: {}, efforts: {} })

  /*
   * Re-asked while the sheet is open, because the catalogue comes from a running
   * CLI and this can be opened before any session has started. A single fetch
   * got nothing and the whole section stayed empty for that opening.
   */
  useEffect(() => {
    let live = true
    const read = (): void => {
      void window.chorus.knownModels().then(
        (known) => {
          if (live) setAgents(known.agents)
        },
        () => undefined
      )
    }
    read()
    const timer = setInterval(read, 4_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let live = true
    window.chorus
      .readSettings()
      .then((settings) => {
        if (live) setChosen({ models: settings.models, efforts: settings.efforts })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  return (
    <fieldset className="settings-models">
      <legend>{t('settings.newSessions')}</legend>
      {agents.map((agent) => (
        <AgentDefaults
          key={agent.agentId}
          agentId={agent.agentId}
          status={agent.status}
          models={agent.models}
          model={chosen.models[agent.agentId] ?? ''}
          effort={chosen.efforts[agent.agentId] ?? ''}
          onChange={(next) => {
            setChosen((current) => ({
              models: {
                ...current.models,
                ...(next.model === undefined ? {} : { [agent.agentId]: next.model }),
              },
              efforts: {
                ...current.efforts,
                ...(next.effort === undefined ? {} : { [agent.agentId]: next.effort }),
              },
            }))
            /*
             * One key per map, which main merges a level deeper. A shallow
             * spread there would replace the whole map and drop the other
             * agent's value.
             */
            void window.chorus.writeSettings({
              ...(next.model === undefined ? {} : { models: { [agent.agentId]: next.model } }),
              ...(next.effort === undefined ? {} : { efforts: { [agent.agentId]: next.effort } }),
            })
          }}
        />
      ))}
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
 *
 * It is one row per agent rather than one pair of selects, which is not a
 * cosmetic change: a single pair spoke for two providers that share no model,
 * and sent a name from Claude's catalogue to Codex's API.
 */
/**
 * How each CLI is installed, copied from `docs/install-windows.md` rather than
 * from memory — a wrong package name in an error message is worse than no
 * message, because it is followed.
 */
export const INSTALL: Record<'codex' | 'claude', string> = {
  codex: 'npm install -g @openai/codex',
  claude: 'npm install -g @anthropic-ai/claude-code',
}

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
                <div key={id} className="cast-entry">
                  <p className={`cast-member voice--${id}`} data-on={installed}>
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
                  {/*
                    What to do about it, where the bad news is.

                    "not installed" was the whole of what this said, and it is
                    the one place a person looks when Chorus will not start. The
                    two failures need different advice and the probe now tells
                    them apart: nothing found anywhere is an install, something
                    found that will not run is not — telling someone to install
                    what they already have sends them round a loop they have
                    just been through.
                  */}
                  {props.probes !== null && !installed && (
                    <p className="cast-help">
                      {probe?.reason === 'failed' && probe.foundAt !== null ? (
                        t('agents.failedHelp', { path: probe.foundAt })
                      ) : (
                        <>
                          {t('agents.missingHelp')}{' '}
                          <code className="cast-install">{INSTALL[id]}</code>
                        </>
                      )}
                    </p>
                  )}
                </div>
              )
            })}
          </fieldset>

          <Accounts />

          <McpServers />

          <Plugins />

          <DefaultModel />

          <ExplainLanguage />

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
