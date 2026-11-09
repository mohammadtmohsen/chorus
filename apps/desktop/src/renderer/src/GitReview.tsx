import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  GitResponse,
  GitReview as GitReviewResult,
  GitReviewFile,
} from '../../shared/git-ipc.js'
import { isSafeHref } from '../../shared/markdown.js'
import {
  formatGitTime,
  gitFailureKey,
  isGitRestartError,
  PIPELINE_STATUSES,
  type GitUiFailure,
} from './GitPanel.js'

type ReviewState =
  | Exclude<GitReviewResult, { kind: 'failed' }>
  | { readonly kind: 'failed'; readonly failure: GitUiFailure; readonly retryAt: number | null }

type AllDiffsState = Omit<GitResponse<'git:openAllDiffs'>, 'failure'> & {
  readonly failure: GitUiFailure | null
}

interface TreeNode {
  readonly path: string
  readonly name: string
  readonly children: Map<string, TreeNode>
  file: GitReviewFile | null
}

export type ReviewTreeRow =
  | {
      readonly kind: 'folder'
      readonly path: string
      readonly name: string
      readonly depth: number
    }
  | {
      readonly kind: 'file'
      readonly path: string
      readonly name: string
      readonly depth: number
      readonly file: GitReviewFile
    }

export function reviewTree(
  files: readonly GitReviewFile[],
  closed: ReadonlySet<string>
): ReviewTreeRow[] {
  const root: TreeNode = { path: '', name: '', children: new Map<string, TreeNode>(), file: null }
  for (const file of files) {
    let parent = root
    const parts = file.path.split('/').filter((part) => part !== '')
    for (const part of parts) {
      let child = parent.children.get(part)
      if (child === undefined) {
        child = {
          path: parent.path === '' ? part : `${parent.path}/${part}`,
          name: part,
          children: new Map<string, TreeNode>(),
          file: null,
        }
        parent.children.set(part, child)
      }
      parent = child
    }
    parent.file = file
  }
  const rows: ReviewTreeRow[] = []
  const visit = (parent: TreeNode, depth: number): void => {
    const children = [...parent.children.values()].sort(
      (a, b) => Number(b.file === null) - Number(a.file === null) || a.name.localeCompare(b.name)
    )
    for (let child of children) {
      if (child.file !== null) {
        rows.push({
          kind: 'file',
          path: child.file.path,
          name: child.name,
          depth,
          file: child.file,
        })
        continue
      }
      let name = child.name
      while (child.children.size === 1) {
        const only = child.children.values().next().value
        if (only?.file !== null) break
        name = `${name}/${only.name}`
        child = only
      }
      rows.push({ kind: 'folder', path: child.path, name, depth })
      if (!closed.has(child.path)) visit(child, depth + 1)
    }
  }
  visit(root, 0)
  return rows
}

interface RowIssue {
  readonly failure: GitUiFailure
  readonly retryAt: number | null
  readonly error: string | null
}

export function GitReview(props: {
  readonly projectId: string
  readonly iid: number
  readonly collapsed: boolean
  readonly onBack: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [review, setReview] = useState<ReviewState | null>(null)
  const [revision, setRevision] = useState(0)
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [issues, setIssues] = useState<Record<string, RowIssue>>({})
  const [allDiffs, setAllDiffs] = useState<AllDiffsState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const generation = useRef(0)
  const pending = useRef<symbol | null>(null)

  useEffect(
    () =>
      window.chorus.onSettings(() => {
        generation.current++
        setReview(null)
        setRevision((value) => value + 1)
      }),
    []
  )

  useEffect(() => {
    if (props.collapsed) return undefined
    const current = ++generation.current
    pending.current = null
    setBusy(null)
    setReview(null)
    setIssues({})
    setAllDiffs(null)
    window.chorus
      .readGitReview({ projectId: props.projectId, iid: props.iid })
      .then((next) => {
        if (generation.current === current) setReview(next)
      })
      .catch((error: unknown) => {
        if (generation.current === current) {
          setReview({
            kind: 'failed',
            failure: isGitRestartError(error) ? 'restart-required' : 'network',
            retryAt: null,
          })
        }
      })
    return () => {
      if (generation.current === current) generation.current++
    }
  }, [props.projectId, props.iid, props.collapsed, revision])

  const act = async (kind: 'open' | 'viewed', file: GitReviewFile): Promise<void> => {
    if (review?.kind !== 'ready' || pending.current !== null) return
    const ticket = Symbol(file.path)
    pending.current = ticket
    const current = generation.current
    setBusy(`${kind}:${file.path}`)
    setIssues((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => key !== file.path))
    )
    const request = {
      projectId: props.projectId,
      iid: props.iid,
      versionId: review.version.id,
      path: file.path,
    }
    try {
      if (kind === 'viewed') {
        const next = await window.chorus.setGitViewed({ ...request, viewed: file.viewed !== 'yes' })
        if (generation.current === current && pending.current === ticket) setReview(next)
      } else {
        const result = await window.chorus.openGitDiff(request)
        if (generation.current !== current || pending.current !== ticket) return
        if (result.failure === 'head-moved') {
          setReview({ kind: 'failed', failure: result.failure, retryAt: result.retryAt })
        } else if (result.failure !== null) {
          const failure = result.failure
          setIssues((previous) => ({ ...previous, [file.path]: { ...result, failure } }))
        }
      }
    } catch (error) {
      if (generation.current === current && pending.current === ticket) {
        const failure = isGitRestartError(error) ? 'restart-required' : 'git-failed'
        setIssues((previous) => ({
          ...previous,
          [file.path]: {
            failure,
            retryAt: null,
            error: null,
          },
        }))
      }
    } finally {
      if (pending.current === ticket) {
        pending.current = null
        setBusy(null)
      }
    }
  }

  const openAll = async (): Promise<void> => {
    if (review?.kind !== 'ready' || pending.current !== null) return
    const ticket = Symbol('all')
    pending.current = ticket
    const current = generation.current
    setBusy('all')
    setAllDiffs(null)
    try {
      const result = await window.chorus.openGitAllDiffs({
        projectId: props.projectId,
        iid: props.iid,
        versionId: review.version.id,
      })
      if (generation.current !== current || pending.current !== ticket) return
      if (result.failure === 'head-moved') {
        setReview({ kind: 'failed', failure: result.failure, retryAt: result.retryAt })
      } else {
        setAllDiffs(result)
      }
    } catch (error) {
      if (generation.current === current && pending.current === ticket) {
        setAllDiffs({
          failure: isGitRestartError(error) ? 'restart-required' : 'git-failed',
          retryAt: null,
          error: null,
          skipped: 0,
        })
      }
    } finally {
      if (pending.current === ticket) {
        pending.current = null
        setBusy(null)
      }
    }
  }

  if (review?.kind !== 'ready') {
    return (
      <div className="git-panel git-review">
        <header className="git-head">
          <button type="button" onClick={props.onBack}>
            {t('git.review.back')}
          </button>
          <span>{t('git.requestNumber', { iid: props.iid })}</span>
        </header>
        {review === null && (
          <p className="git-note muted" role="status">
            {t('git.review.loading')}
          </p>
        )}
        {review?.kind === 'preparing' && (
          <p className="git-note muted" role="status">
            {t('git.review.preparing')}
          </p>
        )}
        {review?.kind === 'failed' && (
          <div className="git-failure" role="alert">
            <p>{t(gitFailureKey(review.failure))}</p>
            {review.retryAt !== null && (
              <p>{t('git.retryAt', { time: formatGitTime(review.retryAt) })}</p>
            )}
          </div>
        )}
        {review !== null && (
          <button
            type="button"
            className="git-review-reload"
            onClick={() => {
              setRevision((value) => value + 1)
            }}
          >
            {t(
              review.kind === 'failed' && review.failure === 'head-moved'
                ? 'git.review.loadNewVersion'
                : 'git.refresh'
            )}
          </button>
        )}
      </div>
    )
  }

  const rows = reviewTree(review.files, closed)
  const viewed = review.files.filter((file) => file.viewed === 'yes').length
  const pipeline = review.pipeline?.status ?? 'unknown'
  const status = PIPELINE_STATUSES.has(pipeline) ? pipeline : 'unknown'
  const approvals = review.approvals
  const approvalsRequired = approvals?.approvalsRequired ?? null
  const approvalsLeft = approvals?.approvalsLeft ?? null
  const approvalCount =
    approvalsRequired === null || approvalsLeft === null
      ? null
      : Math.max(0, approvalsRequired - approvalsLeft)
  const allResult = allDiffs ?? { failure: null, retryAt: null, error: null, skipped: 0 }
  return (
    <div className="git-panel git-review" aria-busy={busy !== null}>
      <div className="git-review-overview">
        <header className="git-head git-review-head">
          <button type="button" onClick={props.onBack}>
            {t('git.review.back')}
          </button>
          <span className="git-request-title">
            {t('git.requestNumber', { iid: review.mr.iid })} {review.mr.title}
          </span>
          <span className="git-request-author">
            {t('git.author', {
              name: review.mr.author.name,
              username: review.mr.author.username,
            })}
          </span>
          <span className="git-request-branches">
            {t('git.branchPair', {
              source: review.mr.sourceBranch,
              target: review.mr.targetBranch,
            })}
          </span>
          {review.mr.labels.map((label) => (
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
          <span className="git-pipeline" data-status={status}>
            <span className="git-pipeline-dot" aria-hidden="true" />
            {t(`git.pipeline.${status}`)}
          </span>
          {approvals === null ? (
            <span>{t('git.review.approvalsUnknown')}</span>
          ) : (
            <>
              {approvals.approvers.length > 0 && (
                <span>{t('git.review.approvedBy', { names: approvals.approvers.join(', ') })}</span>
              )}
              {approvals.approvalsRequired === 0 && (
                <span>{t('git.review.noApprovalsRequired')}</span>
              )}
              {approvals.approvalsRequired !== 0 && approvalCount !== null && (
                <span>
                  {t('git.review.approvalProgress', {
                    approved: approvalCount,
                    required: approvals.approvalsRequired,
                  })}
                </span>
              )}
              {approvals.approvalsRequired !== 0 &&
                approvalCount === null &&
                approvals.approvers.length === 0 && (
                  <span>
                    {t(approvals.approved ? 'git.review.approved' : 'git.review.noApprovals')}
                  </span>
                )}
            </>
          )}
          {review.updatedSinceReview && (
            <span className="git-updated">{t('git.updatedSinceReview')}</span>
          )}
          <span className="git-review-sha" title={review.version.headSha}>
            {review.version.headSha.slice(0, 8)}
          </span>
          <a
            href={isSafeHref(review.mr.webUrl) ? review.mr.webUrl : undefined}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('git.openOnGitlab')}
          </a>
          <button
            type="button"
            disabled={busy !== null || review.files.length === 0}
            onClick={() => {
              void openAll()
            }}
          >
            {t(busy === 'all' ? 'git.review.openingAllDiffs' : 'git.review.openAll')}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setRevision((value) => value + 1)
            }}
          >
            {t('git.refresh')}
          </button>
        </header>
        {allResult.failure !== null && (
          <div className="git-failure" role="alert">
            <p>{t(gitFailureKey(allResult.failure))}</p>
            {allResult.error !== null && <pre className="git-error">{allResult.error}</pre>}
            {allResult.retryAt !== null && (
              <p>{t('git.retryAt', { time: formatGitTime(allResult.retryAt) })}</p>
            )}
            <a
              href={isSafeHref(review.mr.webUrl) ? review.mr.webUrl : undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('git.openOnGitlab')}
            </a>
          </div>
        )}
        {review.mr.description !== '' && (
          <details className="git-review-description">
            <summary>{t('git.review.description')}</summary>
            <p>{review.mr.description}</p>
          </details>
        )}
      </div>
      <p className="git-note muted" role="status">
        {t('git.review.progress', { viewed, total: review.files.length })}
      </p>
      {allResult.skipped > 0 && (
        <p className="git-note muted" role="status">
          <a
            href={isSafeHref(review.mr.webUrl) ? review.mr.webUrl : undefined}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('git.review.skipped', { count: allResult.skipped })}
          </a>
        </p>
      )}
      {!review.complete && (
        <p className="git-note muted" role="status">
          {t('git.review.incomplete')}
        </p>
      )}
      {review.files.length === 0 ? (
        <p className="git-note muted">{t('git.review.empty')}</p>
      ) : (
        <ul className="git-review-tree" role="tree" aria-label={t('git.review.files')}>
          {rows.map((row) => {
            if (row.kind === 'folder') {
              const expanded = !closed.has(row.path)
              return (
                <li
                  key={row.path}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={expanded}
                >
                  <button
                    type="button"
                    className="git-review-folder"
                    style={{ paddingInlineStart: `${String(12 + row.depth * 16)}px` }}
                    onClick={() => {
                      setClosed((previous) => {
                        const next = new Set(previous)
                        if (next.has(row.path)) next.delete(row.path)
                        else next.add(row.path)
                        return next
                      })
                    }}
                  >
                    <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {row.name}
                  </button>
                </li>
              )
            }
            const { file } = row
            const issue = issues[file.path]
            return (
              <li
                key={row.path}
                role="treeitem"
                aria-level={row.depth + 1}
                className="git-review-file"
                data-viewed={file.viewed}
                style={{ paddingInlineStart: `${String(12 + row.depth * 16)}px` }}
              >
                <input
                  type="checkbox"
                  checked={file.viewed === 'yes'}
                  disabled={busy !== null}
                  aria-label={t('git.review.viewedFile', { path: file.path })}
                  onChange={() => {
                    void act('viewed', file)
                  }}
                />
                <span
                  className="git-review-status"
                  title={t(`git.review.statusName.${file.status}`)}
                >
                  {t(`git.review.status.${file.status}`)}
                </span>
                <button
                  type="button"
                  className="git-review-filename"
                  disabled={busy !== null}
                  title={file.path}
                  onClick={() => {
                    void act('open', file)
                  }}
                >
                  {row.name}
                </button>
                <span className="git-review-counts">
                  {t('git.review.changes', { added: file.added, removed: file.removed })}
                </span>
                {file.threads > 0 && (
                  <span>{t('git.review.threads', { count: file.threads })}</span>
                )}
                {file.viewed === 'changed' && (
                  <span className="git-updated">{t('git.review.changed')}</span>
                )}
                {(file.binary || file.tooLarge || file.collapsed) && (
                  <a
                    href={isSafeHref(review.mr.webUrl) ? review.mr.webUrl : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('git.openOnGitlab')}
                  </a>
                )}
                {busy === `open:${file.path}` && (
                  <span role="status">{t('git.review.openingDiff')}</span>
                )}
                {issue !== undefined && (
                  <div className="git-review-file-issue" role="alert">
                    <span>{t(gitFailureKey(issue.failure))}</span>
                    {issue.error !== null && <pre className="git-error">{issue.error}</pre>}
                    {issue.retryAt !== null && (
                      <span>{t('git.retryAt', { time: formatGitTime(issue.retryAt) })}</span>
                    )}
                    <a
                      href={isSafeHref(review.mr.webUrl) ? review.mr.webUrl : undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('git.openOnGitlab')}
                    </a>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
