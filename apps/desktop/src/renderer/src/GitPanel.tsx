import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  GitBoxState,
  GitCheckoutTarget,
  GitFailure,
  GitRequests,
  MrRow,
} from '../../shared/git-ipc.js'
import { isSafeHref } from '../../shared/markdown.js'

const PIPELINE_STATUSES = new Set([
  'created',
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
  'success',
  'failed',
  'canceled',
  'skipped',
  'manual',
  'scheduled',
])

function formatGitTime(timestamp: number): string {
  const date = new Date(timestamp)
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }
  if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric'
  return date.toLocaleString([], options)
}

export function GitPanel(props: {
  readonly projectId: string
  readonly collapsed: boolean
  readonly tab: 'requests' | 'branches' | undefined
  readonly onTab: (tab: 'requests' | 'branches') => void
  readonly onOpenProject: (projectId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<GitBoxState | null>(null)
  const [busy, setBusy] = useState<'fetch' | 'sync' | 'checkout' | null>(null)
  const [failure, setFailure] = useState<GitFailure | null>(null)
  const [filter, setFilter] = useState('')
  const [scope, setScope] = useState<'reviewRequested' | 'mine' | 'all'>('reviewRequested')
  const [revision, setRevision] = useState(0)
  const [requests, setRequests] = useState<GitRequests | null>(null)
  const [requestsRevision, setRequestsRevision] = useState(0)
  const request = useRef(0)
  const requestsId = useRef(0)
  const pending = useRef(false)
  const gitlab = state?.provider.kind === 'gitlab'
  const connected = state?.provider.kind === 'gitlab' && state.provider.connected
  const defaultTab = connected ? 'requests' : 'branches'
  const tab = gitlab ? (props.tab ?? defaultTab) : 'branches'

  useEffect(
    () =>
      window.chorus.onSettings(() => {
        requestsId.current++
        setRequests(null)
        setRevision((current) => current + 1)
        setRequestsRevision((current) => current + 1)
      }),
    []
  )

  useEffect(() => {
    if (props.collapsed || pending.current) return undefined
    const current = ++request.current
    window.chorus
      .readGitState({ projectId: props.projectId })
      .then((next) => {
        if (request.current !== current) return
        setState(next)
        setFailure(next.failure)
      })
      .catch(() => {
        if (request.current === current) setFailure('git-failed')
      })
    return () => {
      if (request.current === current) request.current++
    }
  }, [props.projectId, props.collapsed, revision])

  useEffect(() => {
    if (props.collapsed || !gitlab) return undefined
    const current = ++requestsId.current
    setRequests(null)
    window.chorus
      .readGitRequests({ projectId: props.projectId })
      .then((next) => {
        if (requestsId.current === current) setRequests(next)
      })
      .catch(() => {
        if (requestsId.current !== current) return
        setRequests({
          rows: [],
          complete: true,
          fetchedAt: null,
          failure: 'network',
          retryAt: null,
          username: null,
        })
      })
    return () => {
      if (requestsId.current === current) requestsId.current++
    }
  }, [props.projectId, props.collapsed, gitlab, connected, requestsRevision])

  const act = async (
    kind: 'fetch' | 'sync' | 'checkout',
    run: () => Promise<{ state: GitBoxState; failure: GitFailure | null }>
  ): Promise<void> => {
    if (pending.current) return
    pending.current = true
    const current = ++request.current
    setBusy(kind)
    setFailure(null)
    requestsId.current++
    try {
      const result = await run()
      if (request.current !== current) return
      setState(result.state)
      setFailure(result.failure)
    } catch {
      if (request.current === current) setFailure('git-failed')
    } finally {
      pending.current = false
      setBusy(null)
      if (request.current === current) setRequestsRevision((value) => value + 1)
    }
  }

  const refresh = (): Promise<void> =>
    act('fetch', async () => {
      const next = await window.chorus.fetchGit({ projectId: props.projectId })
      return { state: next, failure: next.failure }
    })

  const sync = (): Promise<void> =>
    act('sync', async () => {
      const next = await window.chorus.syncGit({ projectId: props.projectId })
      return { state: next, failure: next.failure }
    })

  const checkout = (target: GitCheckoutTarget): Promise<void> =>
    act('checkout', () => window.chorus.checkoutGit({ projectId: props.projectId, target }))

  if (state === null) {
    return (
      <div className="git-panel git-empty" aria-busy={failure === null}>
        <p className="muted" role={failure === null ? 'status' : 'alert'}>
          {t(failure === null ? 'git.loading' : 'git.failure.git-failed')}
        </p>
        {failure !== null && (
          <button
            type="button"
            onClick={() => {
              setFailure(null)
              setRevision((current) => current + 1)
            }}
          >
            {t('git.refresh')}
          </button>
        )}
      </div>
    )
  }

  if (!state.available) {
    return (
      <div className="git-panel git-empty">
        <p className="muted">
          {t(`git.failure.${failure ?? state.failure ?? 'not-a-repository'}`)}
        </p>
        {state.error !== null && <pre className="git-error">{state.error}</pre>}
        <button
          type="button"
          onClick={() => {
            setRevision((current) => current + 1)
          }}
        >
          {t('git.refresh')}
        </button>
      </div>
    )
  }

  const dirty = failure === 'dirty' || state.syncNote === 'dirty'
  const query = filter.trim().toLocaleLowerCase()
  const shown = state.branches
    .filter((branch) => branch.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.head) - Number(a.head))
  const rows = requests?.rows.filter((row) => scope === 'all' || row[scope]) ?? []
  const byBranch = new Map<string, MrRow[]>()
  if (requests?.failure === null) {
    for (const row of requests.rows) {
      if (row.fork) continue
      const matching = byBranch.get(row.sourceBranch) ?? []
      matching.push(row)
      byBranch.set(row.sourceBranch, matching)
    }
  }
  return (
    <div className="git-panel" aria-busy={busy !== null}>
      <header className="git-head">
        <span className="git-branch">{state.branch ?? t('git.detached')}</span>
        {state.track.kind === 'tracking' && (state.track.ahead > 0 || state.track.behind > 0) && (
          <span className="git-track">
            {state.track.ahead > 0 && t('git.ahead', { count: state.track.ahead })}
            {state.track.ahead > 0 && state.track.behind > 0 && ' '}
            {state.track.behind > 0 && t('git.behind', { count: state.track.behind })}
          </span>
        )}
        {state.track.kind === 'gone' && <span className="muted">{t('git.gone')}</span>}
        {state.track.kind === 'none' && state.branch !== null && (
          <span className="muted">{t('git.noUpstream')}</span>
        )}
        <button type="button" disabled={busy !== null} onClick={() => void refresh()}>
          {busy === 'fetch' ? t('git.fetching') : t('git.fetch')}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void sync()}>
          {busy === 'sync' ? t('git.syncing') : t('git.sync')}
        </button>
        {state.syncedAt !== null && (
          <span className="git-synced muted">
            {t('git.syncedAt', {
              time: formatGitTime(state.syncedAt),
            })}
          </span>
        )}
      </header>
      {gitlab && (
        <div className="git-tabs" role="group" aria-label={t('git.views')}>
          {(['requests', 'branches'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={tab === value}
              onClick={() => {
                props.onTab(value)
              }}
            >
              {t(`git.${value}`)}
            </button>
          ))}
        </div>
      )}
      {failure !== null && (
        <div role="alert" className="git-failure">
          <p>{t(`git.failure.${failure}`, { count: state.dirtyCount })}</p>
          {state.error !== null && <pre className="git-error">{state.error}</pre>}
        </div>
      )}
      {state.syncNote !== null && (
        <p className="git-note muted" role="status">
          {t(`git.syncNote.${state.syncNote}`)}
        </p>
      )}
      {dirty && (
        <div className="git-dirty">
          <ul>
            {state.dirty.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          {state.dirtyCount > state.dirty.length && (
            <p className="muted">
              {t('git.moreDirty', { count: state.dirtyCount - state.dirty.length })}
            </p>
          )}
        </div>
      )}
      {tab === 'requests' ? (
        <section className="git-requests" aria-label={t('git.requests')}>
          <div className="git-scopes" role="group" aria-label={t('git.requestFilter')}>
            {(['reviewRequested', 'mine', 'all'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                onClick={() => {
                  setScope(value)
                }}
              >
                {t(`git.scope.${value}`)}
              </button>
            ))}
          </div>
          {requests === null ? (
            <p className="git-note muted" role="status">
              {t('git.requestsLoading')}
            </p>
          ) : requests.failure !== null ? (
            <div className="git-failure" role="alert">
              <p>
                {t(
                  requests.failure === 'no-token'
                    ? 'git.connectGitlab'
                    : `git.failure.${requests.failure}`
                )}
              </p>
              {requests.failure === 'rate-limited' && requests.retryAt !== null && (
                <p>{t('git.retryAt', { time: formatGitTime(requests.retryAt) })}</p>
              )}
            </div>
          ) : (
            <>
              {!requests.complete && (
                <p className="git-note muted" role="status">
                  {t('git.requestsPartial', { count: requests.rows.length })}
                </p>
              )}
              {rows.length === 0 ? (
                <p className="git-note muted">{t('git.noMatchingRequests')}</p>
              ) : (
                <ul className="git-request-list">
                  {rows.map((row) => {
                    const pipelineStatus = row.pipeline?.status ?? 'unknown'
                    const status = PIPELINE_STATUSES.has(pipelineStatus)
                      ? pipelineStatus
                      : 'unknown'
                    return (
                      <li key={row.iid} className="git-request-row">
                        <a
                          className="git-request-title"
                          href={isSafeHref(row.webUrl) ? row.webUrl : undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t('git.requestNumber', { iid: row.iid })} {row.title}
                        </a>
                        {row.labels.map((label) => (
                          <span
                            key={label.name}
                            className="git-label"
                            style={{
                              ...(label.color === null ? {} : { backgroundColor: label.color }),
                              ...(label.textColor === null ? {} : { color: label.textColor }),
                            }}
                          >
                            {label.name}
                          </span>
                        ))}
                        {row.draft && <span className="git-request-draft">{t('git.draft')}</span>}
                        <span className="git-request-author">
                          {t('git.author', {
                            name: row.author.name,
                            username: row.author.username,
                          })}
                        </span>
                        <span className="git-request-branches">
                          {t('git.branchPair', {
                            source: row.sourceBranch,
                            target: row.targetBranch,
                          })}
                        </span>
                        <span className="git-row-date">
                          {t('git.requestUpdatedAt', { time: formatGitTime(row.updatedAt) })}
                        </span>
                        <span className="git-pipeline" data-status={status}>
                          <span className="git-pipeline-dot" aria-hidden="true" />
                          {t(`git.pipeline.${status}`)}
                        </span>
                        {row.unresolved && (
                          <span className="git-request-unresolved">{t('git.unresolved')}</span>
                        )}
                        <span className="git-request-notes">
                          {t('git.notes', { count: row.notes })}
                        </span>
                        {row.elsewhere.map((clone) => (
                          <button
                            key={clone.projectId}
                            type="button"
                            className="git-elsewhere"
                            onClick={() => {
                              props.onOpenProject(clone.projectId)
                            }}
                          >
                            {t('git.checkedOutIn', { name: clone.name })}
                          </button>
                        ))}
                        <button
                          type="button"
                          disabled={busy !== null || !/^[0-9a-f]{40}$/.test(row.sha)}
                          onClick={() => {
                            void checkout({ kind: 'mr', iid: row.iid, sha: row.sha })
                          }}
                        >
                          {t('git.checkout')}
                        </button>
                        <a
                          href={isSafeHref(row.webUrl) ? row.webUrl : undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t('git.openOnGitlab')}
                        </a>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </section>
      ) : (
        <>
          <input
            type="search"
            className="git-filter"
            aria-label={t('git.filter')}
            placeholder={t('git.filter')}
            value={filter}
            onChange={(event) => {
              setFilter(event.currentTarget.value)
            }}
          />
          {shown.length === 0 ? (
            <p className="git-note muted">
              {t(state.branches.length === 0 ? 'git.noBranches' : 'git.noMatchingBranches')}
            </p>
          ) : (
            <ul className="git-branches">
              {shown.map((branch) => {
                const time = formatGitTime(branch.changedAt * 1000)
                return (
                  <li
                    key={`${branch.kind}:${branch.name}`}
                    className="git-row"
                    data-head={branch.head}
                  >
                    <span className="git-row-name">{branch.name}</span>
                    <span className="git-row-date" title={t('git.changedAt', { time })}>
                      {time}
                    </span>
                    {branch.head && <span className="git-current">{t('git.current')}</span>}
                    {(byBranch.get(branch.name) ?? []).map((row) => (
                      <a
                        key={row.iid}
                        className="git-request-badge"
                        href={isSafeHref(row.webUrl) ? row.webUrl : undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={row.title}
                      >
                        {t('git.requestNumber', { iid: row.iid })}
                      </a>
                    ))}
                    {branch.track.kind === 'tracking' &&
                      (branch.track.ahead > 0 || branch.track.behind > 0) && (
                        <span className="git-track">
                          {branch.track.ahead > 0 && t('git.ahead', { count: branch.track.ahead })}
                          {branch.track.ahead > 0 && branch.track.behind > 0 && ' '}
                          {branch.track.behind > 0 &&
                            t('git.behind', { count: branch.track.behind })}
                        </span>
                      )}
                    {branch.track.kind === 'gone' && <span className="muted">{t('git.gone')}</span>}
                    {branch.elsewhere.map((clone) => (
                      <button
                        key={clone.projectId}
                        type="button"
                        className="git-elsewhere"
                        onClick={() => {
                          props.onOpenProject(clone.projectId)
                        }}
                      >
                        {t('git.checkedOutIn', { name: clone.name })}
                      </button>
                    ))}
                    {!branch.head && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          void checkout({ kind: branch.kind, name: branch.name })
                        }}
                      >
                        {busy === 'checkout' ? t('git.checkingOut') : t('git.checkout')}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
