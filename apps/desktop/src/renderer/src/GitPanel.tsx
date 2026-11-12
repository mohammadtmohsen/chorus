import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  formatGitRequestTime,
  formatGitTime,
  type GitBoxState,
  type GitCheckoutTarget,
  type GitFailure,
  type GitRequests,
  type GitReviewEnvelope,
  type MrRow,
} from '../../shared/git-ipc.js'
import { isSafeHref } from '../../shared/markdown.js'
import { GitReview, type ReviewState } from './GitReview.js'
import { useOpenLink } from './workspace/web-pages.js'

export const PIPELINE_STATUSES = new Set([
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

export type GitUiFailure = GitFailure | 'restart-required'

type GitRequestsState = Omit<GitRequests, 'failure'> & {
  readonly failure: GitUiFailure | null
}

export function isGitRestartError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const plain = message
    .replace(/^Error invoking remote method 'git:[^']*':\s*/, '')
    .replace(/^(?:Error:\s*)+/, '')
  return plain === 'channel-refused' || /^Malformed response on "git:[^"]+":/.test(plain)
}

export function gitFailureKey(failure: GitUiFailure): string {
  return failure === 'restart-required' ? 'git.restartRequired' : `git.failure.${failure}`
}

const AUTHOR_HUES = 6
const DAY_MS = 24 * 60 * 60 * 1000

export function authorHue(name: string): number {
  let hash = 0
  for (const char of name.trim().toLocaleLowerCase()) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003
  }
  return hash % AUTHOR_HUES
}

export function changeAge(changedAt: number, readAt: number | null): 'day' | 'week' | 'older' {
  const elapsed = (readAt ?? changedAt) - changedAt
  if (elapsed < DAY_MS) return 'day'
  return elapsed < 7 * DAY_MS ? 'week' : 'older'
}

export function GitPanel(props: {
  readonly projectId: string
  readonly collapsed: boolean
  readonly tab: 'requests' | 'branches' | undefined
  readonly onTab: (tab: 'requests' | 'branches') => void
  readonly onOpenProject: (projectId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const followLink = useOpenLink()
  const [state, setState] = useState<GitBoxState | null>(null)
  const [busy, setBusy] = useState<'fetch' | 'sync' | 'checkout' | null>(null)
  const [failure, setFailure] = useState<GitUiFailure | null>(null)
  const [filter, setFilter] = useState('')
  const [revision, setRevision] = useState(0)
  const [requests, setRequests] = useState<GitRequestsState | null>(null)
  const [requestsRevision, setRequestsRevision] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [reviewIid, setReviewIid] = useState<number | null>(null)
  const [heldReview, setHeldReview] = useState<GitReviewEnvelope | null>(null)
  const [reviewOutcome, setReviewOutcome] = useState<ReviewState | { kind: 'ready' } | null>(null)
  const reviewScope = useRef(props.projectId)
  const reviewRevision = useRef(-1)
  const reviewTicket = useRef(0)
  const reviewPending = useRef(false)
  const selectedReview = useRef<number | null>(null)
  const request = useRef(0)
  const requestsId = useRef(0)
  const pending = useRef(false)
  const gitlab = state?.provider.kind === 'gitlab'
  const connected = state?.provider.kind === 'gitlab' && state.provider.connected
  const defaultTab = connected ? 'requests' : 'branches'
  const tab = gitlab ? (props.tab ?? defaultTab) : 'branches'

  useEffect(() => {
    if (props.collapsed || reviewIid !== null) return undefined
    setNow(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 60_000)
    return () => {
      clearInterval(timer)
    }
  }, [props.collapsed, tab, reviewIid])

  const acceptReview = useCallback(
    (next: GitReviewEnvelope, select: boolean): boolean => {
      if (
        reviewScope.current !== props.projectId ||
        next.projectId !== props.projectId ||
        next.revision < reviewRevision.current
      ) {
        return false
      }
      reviewRevision.current = next.revision
      setHeldReview(next)
      if (select && !reviewPending.current) {
        const iid = next.review?.mr.iid ?? null
        selectedReview.current = iid
        setReviewIid(iid)
        setReviewOutcome(next.review === null ? null : { kind: 'ready' })
      }
      return true
    },
    [props.projectId]
  )

  const loadReview = useCallback(
    async (iid: number): Promise<void> => {
      setFailure(null)
      const ticket = ++reviewTicket.current
      reviewPending.current = true
      selectedReview.current = iid
      setReviewIid(iid)
      setReviewOutcome(null)
      try {
        const next = await window.chorus.readGitReview({ projectId: props.projectId, iid })
        if (reviewTicket.current !== ticket || reviewScope.current !== props.projectId) return
        acceptReview(next, false)
        setReviewOutcome(next.outcome)
      } catch (error) {
        if (reviewTicket.current === ticket && reviewScope.current === props.projectId) {
          setReviewOutcome({
            kind: 'failed',
            failure: isGitRestartError(error) ? 'restart-required' : 'network',
            retryAt: null,
          })
        }
      } finally {
        if (reviewTicket.current === ticket) reviewPending.current = false
      }
    },
    [props.projectId, acceptReview]
  )

  useEffect(() => {
    let live = true
    let engineConnected: boolean | null = null
    reviewScope.current = props.projectId
    reviewRevision.current = -1
    reviewTicket.current++
    reviewPending.current = false
    selectedReview.current = null
    setReviewIid(null)
    setReviewOutcome(null)
    setHeldReview(null)
    const read = (): void => {
      void window.chorus
        .readActiveGitReview({ projectId: props.projectId })
        .then((next) => {
          if (live) acceptReview(next, true)
        })
        .catch((error: unknown) => {
          if (live) setFailure(isGitRestartError(error) ? 'restart-required' : 'git-failed')
        })
    }
    const unsubscribe = window.chorus.onGitReviewChanged((next) => {
      if (live) acceptReview(next, true)
    })
    const unsubscribeEngine = window.chorusDesktop?.onEngineStatus(({ state: status }) => {
      if (!live) return
      if (status === 'connected') {
        if (engineConnected === false) {
          reviewTicket.current++
          reviewPending.current = false
          reviewRevision.current = -1
          read()
        }
        engineConnected = true
      } else {
        engineConnected = false
      }
    })
    read()
    return () => {
      live = false
      reviewTicket.current++
      unsubscribe()
      unsubscribeEngine?.()
    }
  }, [props.projectId, acceptReview])

  const closeReview = async (): Promise<void> => {
    const ticket = ++reviewTicket.current
    reviewPending.current = false
    try {
      const next = await window.chorus.closeGitReview({ projectId: props.projectId })
      if (reviewTicket.current !== ticket || reviewScope.current !== props.projectId) return
      acceptReview(next, true)
      setRequestsRevision((current) => current + 1)
    } catch (error) {
      if (reviewTicket.current === ticket && reviewScope.current === props.projectId) {
        setReviewOutcome({
          kind: 'failed',
          failure: isGitRestartError(error) ? 'restart-required' : 'git-failed',
          retryAt: null,
        })
      }
    }
  }

  useEffect(
    () =>
      window.chorus.onSettings(() => {
        requestsId.current++
        setRequests(null)
        setRevision((current) => current + 1)
        setRequestsRevision((current) => current + 1)
        if (selectedReview.current !== null) void loadReview(selectedReview.current)
      }),
    [loadReview]
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
      .catch((error: unknown) => {
        if (request.current === current) {
          setFailure(isGitRestartError(error) ? 'restart-required' : 'git-failed')
        }
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
      .catch((error: unknown) => {
        if (requestsId.current !== current) return
        setRequests({
          rows: [],
          complete: true,
          fetchedAt: null,
          failure: isGitRestartError(error) ? 'restart-required' : 'network',
          retryAt: null,
          username: null,
          protectedBranches: [],
          defaultBranch: null,
        })
      })
    return () => {
      if (requestsId.current === current) requestsId.current++
    }
  }, [props.projectId, props.collapsed, gitlab, connected, requestsRevision])

  const act = async (
    kind: 'fetch' | 'sync' | 'checkout',
    run: () => Promise<{ state: GitBoxState; failure: GitFailure | null }>
  ): Promise<boolean> => {
    if (pending.current) return false
    pending.current = true
    const current = ++request.current
    setBusy(kind)
    setFailure(null)
    requestsId.current++
    try {
      const result = await run()
      if (request.current !== current) return false
      setState(result.state)
      setFailure(result.failure)
      return result.failure === null
    } catch (error) {
      if (request.current === current) {
        setFailure(isGitRestartError(error) ? 'restart-required' : 'git-failed')
      }
      return false
    } finally {
      pending.current = false
      setBusy(null)
      if (request.current === current) setRequestsRevision((value) => value + 1)
    }
  }

  const refresh = (): Promise<boolean> =>
    act('fetch', async () => {
      const next = await window.chorus.fetchGit({ projectId: props.projectId })
      return { state: next, failure: next.failure }
    })

  const sync = (): Promise<boolean> =>
    act('sync', async () => {
      const next = await window.chorus.syncGit({ projectId: props.projectId })
      return { state: next, failure: next.failure }
    })

  const checkout = (target: GitCheckoutTarget): Promise<boolean> =>
    act('checkout', () => window.chorus.checkoutGit({ projectId: props.projectId, target }))

  const checkoutAndReview = async (row: MrRow): Promise<void> => {
    if (pending.current) return
    const checkedOut =
      (!row.fork && state?.branch === row.sourceBranch) ||
      (await checkout({ kind: 'mr', iid: row.iid, sha: row.sha }))
    if (checkedOut) await loadReview(row.iid)
  }

  if (state === null) {
    return (
      <div className="git-panel git-empty" aria-busy={failure === null}>
        <p className="muted" role={failure === null ? 'status' : 'alert'}>
          {t(failure === null ? 'git.loading' : gitFailureKey(failure))}
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
        <p className="muted">{t(gitFailureKey(failure ?? state.failure ?? 'not-a-repository'))}</p>
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

  let shownReview: ReviewState | null = null
  if (reviewOutcome?.kind === 'ready') {
    if (heldReview?.projectId === props.projectId && heldReview.review?.mr.iid === reviewIid) {
      shownReview = heldReview.review
    }
  } else {
    shownReview = reviewOutcome
  }

  if (reviewIid !== null) {
    const currentReview = shownReview
    const onReviewBranch =
      currentReview?.kind === 'ready' &&
      !currentReview.mr.fork &&
      state.branch === currentReview.mr.sourceBranch
    const branchDiffers =
      currentReview?.kind === 'ready' &&
      onReviewBranch &&
      state.branches.some(
        (branch) =>
          branch.head &&
          branch.kind === 'local' &&
          branch.name === currentReview.mr.sourceBranch &&
          branch.sha !== currentReview.version.headSha
      )
    return (
      <GitReview
        key={`${props.projectId}:${String(reviewIid)}`}
        projectId={props.projectId}
        iid={reviewIid}
        review={shownReview}
        branchDiffers={branchDiffers}
        onReviewBranch={onReviewBranch}
        busy={busy}
        failure={failure}
        error={state.error}
        dirtyCount={state.dirtyCount}
        onCheckout={() => {
          if (currentReview?.kind !== 'ready') return
          void checkout({
            kind: 'mr',
            iid: currentReview.mr.iid,
            sha: currentReview.version.headSha,
          })
        }}
        onFailure={(next, retryAt) => {
          setReviewOutcome({ kind: 'failed', failure: next, retryAt })
        }}
        onRefresh={() => {
          void loadReview(reviewIid)
        }}
        onBack={() => {
          void closeReview()
        }}
      />
    )
  }

  const dirty = failure === 'dirty' || state.syncNote === 'dirty'
  const query = filter.trim().toLocaleLowerCase()
  const shown = state.branches
    .filter((branch) => branch.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.head) - Number(a.head))
  const byBranch = new Map<string, MrRow[]>()
  const protectedBranches = new Set(requests?.failure === null ? requests.protectedBranches : [])
  const defaultBranch = requests?.failure === null ? requests.defaultBranch : null
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
              {value === 'requests' && requests?.failure === null && (
                <>
                  {' '}
                  <span className="git-request-badge">
                    {t(requests.complete ? 'git.requestsCount' : 'git.requestsCountPartial', {
                      count: requests.rows.length,
                    })}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {failure !== null && (
        <div role="alert" className="git-failure">
          <p>{t(gitFailureKey(failure), { count: state.dirtyCount })}</p>
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
                    : gitFailureKey(requests.failure)
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
              {requests.rows.length === 0 ? (
                <p className="git-note muted">{t('git.noRequests')}</p>
              ) : (
                <ul className="git-request-list">
                  {requests.rows.map((row) => {
                    const created = formatGitRequestTime(row.createdAt, now, 'Created')
                    const updated = formatGitRequestTime(row.updatedAt, now)
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
                          onClick={followLink}
                        >
                          {t('git.requestNumber', { iid: row.iid })} {row.title}
                        </a>
                        {(row.labels.length > 0 || row.draft) && (
                          <div className="git-row-line">
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
                            {row.draft && (
                              <span className="git-request-draft">{t('git.draft')}</span>
                            )}
                          </div>
                        )}
                        <span className="git-request-author" data-hue={authorHue(row.author.name)}>
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
                        <div className="git-row-line">
                          <span
                            className="git-row-date"
                            data-age={changeAge(row.createdAt, requests.fetchedAt)}
                            title={formatGitTime(row.createdAt)}
                          >
                            {t(created.key, created.values)}
                          </span>
                        </div>
                        <div className="git-row-line">
                          <span
                            className="git-row-date"
                            data-age={changeAge(row.updatedAt, requests.fetchedAt)}
                            title={formatGitTime(row.updatedAt)}
                          >
                            {t(updated.key, updated.values)}
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
                          {row.diff !== null && (
                            <span className="git-request-diff">
                              <span className="git-request-added">
                                {t('git.linesAdded', { count: row.diff.added })}
                              </span>
                              <span className="git-request-removed">
                                {t('git.linesRemoved', { count: row.diff.removed })}
                              </span>
                              <span>{t('git.changedFiles', { count: row.diff.files })}</span>
                            </span>
                          )}
                          {row.updatedSinceReview && (
                            <span className="git-updated">{t('git.updatedSinceReview')}</span>
                          )}
                          <div className="git-row-actions">
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => {
                                void loadReview(row.iid)
                              }}
                            >
                              {t('git.review.open')}
                            </button>
                            <button
                              type="button"
                              disabled={busy !== null || !/^[0-9a-f]{40}$/.test(row.sha)}
                              onClick={() => {
                                void checkout({ kind: 'mr', iid: row.iid, sha: row.sha })
                              }}
                            >
                              {t('git.checkout')}
                            </button>
                            <button
                              type="button"
                              disabled={busy !== null || !/^[0-9a-f]{40}$/.test(row.sha)}
                              onClick={() => {
                                void checkoutAndReview(row)
                              }}
                            >
                              {t('git.checkoutAndReview')}
                            </button>
                          </div>
                        </div>
                        {row.elsewhere.length > 0 && (
                          <div className="git-row-line">
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
                          </div>
                        )}
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
                const updated = formatGitRequestTime(branch.changedAt * 1000, now)
                return (
                  <li
                    key={`${branch.kind}:${branch.name}`}
                    className="git-row"
                    data-head={branch.head}
                  >
                    <div className="git-row-line">
                      <span
                        className="git-row-name"
                        data-protected={protectedBranches.has(branch.name)}
                      >
                        {branch.name}
                      </span>
                      {protectedBranches.has(branch.name) && (
                        <span className="git-branch-flag" data-flag="protected">
                          {t('git.protected')}
                        </span>
                      )}
                      {defaultBranch === branch.name && (
                        <span className="git-branch-flag">{t('git.defaultBranch')}</span>
                      )}
                    </div>
                    {branch.author !== null && (
                      <span className="git-row-author" data-hue={authorHue(branch.author)}>
                        {branch.author}
                      </span>
                    )}
                    <div className="git-row-line">
                      <span
                        className="git-row-date"
                        data-age={changeAge(branch.changedAt * 1000, state.readAt)}
                        title={t('git.changedAt', { time })}
                      >
                        {t(updated.key, updated.values)}
                      </span>
                      {(byBranch.get(branch.name) ?? []).map((row) => (
                        <span key={row.iid} className="git-branch-request">
                          <a
                            className="git-request-badge"
                            href={isSafeHref(row.webUrl) ? row.webUrl : undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={row.title}
                            onClick={followLink}
                          >
                            {t('git.requestNumber', { iid: row.iid })}
                          </a>
                          {row.diff !== null && (
                            <span className="git-request-diff">
                              <span className="git-request-added">
                                {t('git.linesAdded', { count: row.diff.added })}
                              </span>
                              <span className="git-request-removed">
                                {t('git.linesRemoved', { count: row.diff.removed })}
                              </span>
                            </span>
                          )}
                        </span>
                      ))}
                      {branch.track.kind === 'tracking' && branch.track.ahead > 0 && (
                        <span className="git-track" data-direction="ahead">
                          {t('git.ahead', { count: branch.track.ahead })}
                        </span>
                      )}
                      {branch.track.kind === 'tracking' && branch.track.behind > 0 && (
                        <span className="git-track" data-direction="behind">
                          {t('git.behind', { count: branch.track.behind })}
                        </span>
                      )}
                      {branch.track.kind === 'gone' && (
                        <span className="git-track" data-direction="gone">
                          {t('git.gone')}
                        </span>
                      )}
                      <div className="git-row-actions">
                        {branch.head ? (
                          <span className="git-current">{t('git.current')}</span>
                        ) : (
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
                      </div>
                    </div>
                    {branch.elsewhere.length > 0 && (
                      <div className="git-row-line">
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
                      </div>
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
