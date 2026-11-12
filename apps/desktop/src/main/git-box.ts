import { readFile, stat } from 'node:fs/promises'
import {
  fastForward,
  fetchBranches,
  fetchedHead,
  fetchRef,
  hasCommit,
  isSafeRef,
  mapsBranch,
  parseRemoteUrl,
  readBranchInventory,
  readFetchRefspecs,
  readRemoteUrl,
  readFileAt,
  readStatus,
  resolveWithinRoot,
  switchTo,
  type BranchEntry,
  type RemoteLocation,
  type SwitchTarget,
} from '@chorus/workspace'
import { LOCAL_HOST, type Project, type ReviewMarksStore } from '@chorus/event-store'
import type { Logger } from '@chorus/shared'
import type {
  GitBoxState,
  GitBranch,
  GitFailure,
  GitRequest,
  GitRequests,
  GitResponse,
  GitReviewEnvelope,
  GitReviewOutcome,
  GitReviewReply,
  GitReviewReady,
  GitSyncNote,
} from '../shared/git-ipc.js'
import type { WorkbenchReviewDiffFile } from '../shared/workbench-ipc.js'
import type {
  GitLabDirectory,
  GitLabFailure,
  GitLabReviewFile,
  GitLabReviewSnapshot,
} from './gitlab-client.js'
import { positionFor } from './gitlab-client.js'
import type { EditorPort } from './host-ports.js'
import { mainT } from './i18n.js'

const MAX_REVIEW_TEXT_BYTES = 16 * 1024 * 1024

export interface GitProviderPort {
  handles(host: string): boolean
  connected(host: string): boolean
  requestOf(cwd: string, iid: number): Promise<{ fork: boolean; sourceBranch: string } | null>
}

export interface GitBoxDeps {
  readonly project: (projectId: string) => Project | null
  readonly projects: () => readonly Project[]
  readonly projectBusy: (projectId: string) => boolean
  readonly gitlab: GitLabDirectory
  readonly marks: ReviewMarksStore
  readonly editor: EditorPort
  readonly log?: Pick<Logger, 'error'>
  readonly now: () => number
}

interface Clone {
  readonly projectId: string
  readonly name: string
  readonly branch: string | null
}

interface Outcome {
  readonly state: GitBoxState
  readonly failure: GitFailure | null
}

type Resolved =
  { readonly target: SwitchTarget } | { readonly failure: GitFailure; readonly error?: string }

interface HeldReview {
  readonly root: string
  readonly location: RemoteLocation
  readonly identity: string
  readonly snapshot: GitLabReviewSnapshot
  readonly updatedSinceReview: boolean
}

type ReviewGuard =
  | { readonly session: HeldReview; readonly file: GitLabReviewFile }
  | { readonly failure: GitFailure; readonly retryAt: number | null }

type ReviewVersionGuard =
  | { readonly session: HeldReview }
  | { readonly failure: GitFailure; readonly retryAt: number | null }

export class GitBoxService {
  private readonly synced = new Map<string, number>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly reviews = new Map<string, HeldReview>()
  private readonly reviewReads = new Map<string, number>()
  private readonly fetchedReviews = new Set<string>()
  private readonly reviewRevisions = new Map<string, number>()
  private readonly reviewListeners = new Set<(state: GitReviewEnvelope) => void>()
  private revision = 0

  constructor(private readonly deps: GitBoxDeps) {}

  async state(projectId: string, note: GitSyncNote | null = null): Promise<GitBoxState> {
    const cwd = this.localRoot(projectId)
    if (cwd === null) return unavailable('not-local')
    const [status, branches, origin] = await Promise.all([
      readStatus({ cwd }),
      readBranchInventory({ cwd }),
      readRemoteUrl({ cwd, remote: 'origin' }),
    ])
    if (!status.ok) return { ...unavailable('not-a-repository'), error: status.error.message }
    if (!branches.ok) return { ...unavailable('not-a-repository'), error: branches.error.message }
    const location = origin.ok ? parseRemoteUrl(origin.value) : null
    const clones = await this.clonesOf(projectId, location)
    const head = branches.value.find((entry) => entry.head && !entry.remote)
    const gitlab = this.deps.gitlab
    return {
      available: true,
      failure: null,
      branch: status.value.branch,
      track: head?.track ?? { kind: 'none' },
      dirty: status.value.files.slice(0, 50).map((file) => file.path),
      dirtyCount: status.value.files.length,
      branches: rowsOf(branches.value, clones),
      provider:
        location !== null && gitlab.handles(location.host)
          ? {
              kind: 'gitlab',
              host: location.host,
              path: location.path,
              connected: gitlab.connected(location.host),
            }
          : { kind: 'other', host: location?.host ?? null },
      readAt: this.deps.now(),
      syncedAt: this.synced.get(projectId) ?? null,
      syncNote: note,
      error: null,
    }
  }

  async fetch(projectId: string): Promise<GitBoxState> {
    const cwd = this.localRoot(projectId)
    if (cwd === null) return unavailable('not-local')
    const fetched = await fetchBranches({ cwd, remote: 'origin' })
    await this.invalidateRequests(cwd)
    if (!fetched.ok) {
      return {
        ...(await this.state(projectId)),
        failure: 'git-failed',
        error: fetched.error.message,
      }
    }
    this.synced.set(projectId, this.deps.now())
    return this.state(projectId, 'fetched')
  }

  async sync(projectId: string): Promise<GitBoxState> {
    const cwd = this.localRoot(projectId)
    if (cwd === null) return unavailable('not-local')
    const fetched = await fetchBranches({ cwd, remote: 'origin' })
    await this.invalidateRequests(cwd)
    if (!fetched.ok) {
      return {
        ...(await this.state(projectId)),
        failure: 'git-failed',
        error: fetched.error.message,
      }
    }
    this.synced.set(projectId, this.deps.now())
    const outcome = await this.exclusive(cwd, async (): Promise<Outcome> => {
      const note = await this.forwardable(projectId, cwd)
      if (note !== null) return { state: await this.state(projectId, note), failure: null }
      const forwarded = await fastForward({ cwd })
      return forwarded.ok
        ? { state: await this.state(projectId, 'fast-forwarded'), failure: null }
        : {
            state: { ...(await this.state(projectId)), error: forwarded.error.message },
            failure: 'git-failed',
          }
    })
    return { ...outcome.state, failure: outcome.failure }
  }

  async requests(projectId: string): Promise<GitRequests> {
    const empty: GitRequests = {
      rows: [],
      complete: true,
      fetchedAt: null,
      failure: null,
      retryAt: null,
      username: null,
      protectedBranches: [],
      defaultBranch: null,
    }
    const cwd = this.localRoot(projectId)
    if (cwd === null) return { ...empty, failure: 'not-gitlab' }
    const origin = await readRemoteUrl({ cwd, remote: 'origin' })
    const location = origin.ok ? parseRemoteUrl(origin.value) : null
    const gitlab = this.deps.gitlab
    if (location === null || !gitlab.handles(location.host)) {
      return { ...empty, failure: 'not-gitlab' }
    }
    if (!gitlab.connected(location.host)) return { ...empty, failure: 'no-token' }
    const result = await gitlab.requests(location)
    if (!result.ok) {
      const failure =
        result.failure === 'invalid-response' || result.failure === 'conflict'
          ? 'git-failed'
          : result.failure
      return { ...empty, failure, retryAt: result.retryAt }
    }
    const clones = await this.clonesOf(projectId, location)
    return {
      rows: result.value.rows.map((row) => ({
        ...row,
        updatedSinceReview: this.updatedSinceReview(location, row.iid, row.sha),
        elsewhere: row.fork
          ? []
          : clones
              .filter((clone) => clone.branch === row.sourceBranch)
              .map((clone) => ({ projectId: clone.projectId, name: clone.name })),
      })),
      complete: result.value.complete,
      fetchedAt: result.fetchedAt,
      failure: null,
      retryAt: null,
      username: result.value.username,
      protectedBranches: result.value.protectedBranches,
      defaultBranch: result.value.defaultBranch,
    }
  }

  subscribe(listener: (state: GitReviewEnvelope) => void): () => void {
    this.reviewListeners.add(listener)
    return () => {
      this.reviewListeners.delete(listener)
    }
  }

  activeReview(projectId: string): GitReviewEnvelope {
    const session = this.reviews.get(projectId)
    return {
      projectId,
      revision: this.reviewRevisions.get(projectId) ?? 0,
      review: session === undefined ? null : this.reviewState(session),
    }
  }

  closeReview(projectId: string): GitReviewEnvelope {
    this.reviewReads.set(projectId, (this.reviewReads.get(projectId) ?? 0) + 1)
    this.reviews.delete(projectId)
    return this.publishReview(projectId)
  }

  async review(projectId: string, iid: number): Promise<GitReviewReply> {
    const ticket = (this.reviewReads.get(projectId) ?? 0) + 1
    this.reviewReads.set(projectId, ticket)
    const finish = (outcome: GitReviewOutcome): GitReviewReply => {
      if (this.reviewReads.get(projectId) !== ticket) {
        return { ...this.activeReview(projectId), outcome: reviewFailed('head-moved') }
      }
      if (this.reviews.get(projectId)?.snapshot.mr.iid === iid) {
        return { ...this.activeReview(projectId), outcome }
      }
      this.reviews.delete(projectId)
      return { ...this.publishReview(projectId), outcome }
    }
    const cwd = this.localRoot(projectId)
    if (cwd === null) return finish(reviewFailed('not-local'))
    const origin = await readRemoteUrl({ cwd, remote: 'origin' })
    const location = origin.ok ? parseRemoteUrl(origin.value) : null
    const gitlab = this.deps.gitlab
    if (location === null || !gitlab.handles(location.host)) {
      return finish(reviewFailed('not-gitlab'))
    }
    const identity = gitlab.identity(location.host)
    if (identity === null) return finish(reviewFailed('no-token'))
    const result = await gitlab.review(location, iid)
    if (this.reviewReads.get(projectId) !== ticket) return finish(reviewFailed('head-moved'))
    if (!result.ok) return finish(reviewFailed(gitFailure(result.failure), result.retryAt))
    if (result.value.kind === 'preparing') return finish(result.value)
    if (gitlab.identity(location.host) !== identity) return finish(reviewFailed('head-moved'))
    const { snapshot } = result.value
    const session: HeldReview = {
      root: cwd,
      location,
      identity,
      snapshot,
      updatedSinceReview: this.updatedSinceReview(location, iid, snapshot.version.headSha),
    }
    this.deps.marks.setSeen(
      { host: location.host, project: location.path, iid },
      snapshot.version.id,
      snapshot.version.headSha,
      this.deps.now()
    )
    this.reviews.set(projectId, session)
    return { ...this.publishReview(projectId), outcome: { kind: 'ready' } }
  }

  private publishReview(projectId: string): GitReviewEnvelope {
    this.reviewRevisions.set(projectId, ++this.revision)
    const state = this.activeReview(projectId)
    for (const listener of this.reviewListeners) listener(state)
    return state
  }

  comment(request: GitRequest<'git:comment'>): Promise<GitResponse<'git:comment'>> {
    const key = `review:${request.projectId}`
    return this.exclusive(key, async (): Promise<GitResponse<'git:comment'>> => {
      const guarded = await this.guardReview(request)
      if ('failure' in guarded) return { ...guarded, error: null }
      const { session, file } = guarded
      const position = positionFor(session.snapshot.version, file.raw, request.side, request.line)
      if (position === null) return { failure: 'refused-target', retryAt: null, error: null }
      return this.writeReview(request.projectId, session, 'POST', '/discussions', {
        body: request.body,
        position,
      })
    })
  }

  reply(request: GitRequest<'git:reply'>): Promise<GitResponse<'git:reply'>> {
    const key = `review:${request.projectId}`
    return this.exclusive(key, async (): Promise<GitResponse<'git:reply'>> => {
      const guarded = await this.guardDiscussion(request)
      if ('failure' in guarded) return { ...guarded, error: null }
      return this.writeReview(
        request.projectId,
        guarded.session,
        'POST',
        `/discussions/${encodeURIComponent(request.discussionId)}/notes`,
        { body: request.body }
      )
    })
  }

  resolve(request: GitRequest<'git:resolve'>): Promise<GitResponse<'git:resolve'>> {
    const key = `review:${request.projectId}`
    return this.exclusive(key, async (): Promise<GitResponse<'git:resolve'>> => {
      const guarded = await this.guardDiscussion(request)
      if ('failure' in guarded) return { ...guarded, error: null }
      return this.writeReview(
        request.projectId,
        guarded.session,
        'PUT',
        `/discussions/${encodeURIComponent(request.discussionId)}`,
        { resolved: request.resolved }
      )
    })
  }

  approve(request: GitRequest<'git:approve'>): Promise<GitResponse<'git:approve'>> {
    const key = `review:${request.projectId}`
    return this.exclusive(key, async (): Promise<GitResponse<'git:approve'>> => {
      const guarded = await this.guardReviewVersion(request)
      if ('failure' in guarded) return { ...guarded, error: null }
      return this.writeReview(
        request.projectId,
        guarded.session,
        'POST',
        request.approve ? '/approve' : '/unapprove',
        request.approve ? { sha: guarded.session.snapshot.version.headSha } : {},
        request.approve
      )
    })
  }

  private async writeReview(
    projectId: string,
    session: HeldReview,
    method: 'POST' | 'PUT',
    suffix: string,
    body: unknown,
    approving = false
  ): Promise<GitResponse<'git:approve'>> {
    if (
      this.reviews.get(projectId) !== session ||
      this.deps.gitlab.identity(session.location.host) !== session.identity
    ) {
      return { failure: 'head-moved', retryAt: null, error: null }
    }
    const result = await this.deps.gitlab.writeReview(
      session.location,
      session.snapshot.mr.iid,
      method,
      suffix,
      body
    )
    if (!result.ok) {
      return {
        failure:
          approving && result.failure === 'conflict' ? 'head-moved' : gitFailure(result.failure),
        retryAt: result.retryAt,
        error: result.error ?? null,
      }
    }
    const posted = mainT('git.review.writeRefreshFailed')
    if (
      this.reviews.get(projectId) !== session ||
      this.deps.gitlab.identity(session.location.host) !== session.identity
    ) {
      return { failure: 'head-moved', retryAt: null, error: posted }
    }
    const refreshed = await this.deps.gitlab.review(session.location, session.snapshot.mr.iid, true)
    if (!refreshed.ok) {
      return {
        failure: gitFailure(refreshed.failure),
        retryAt: refreshed.retryAt,
        error: [posted, refreshed.error].filter((part) => part !== undefined).join('\n'),
      }
    }
    if (
      refreshed.value.kind !== 'ready' ||
      refreshed.value.snapshot.version.id !== session.snapshot.version.id ||
      this.reviews.get(projectId) !== session ||
      this.deps.gitlab.identity(session.location.host) !== session.identity
    ) {
      return { failure: 'head-moved', retryAt: null, error: posted }
    }
    this.reviews.set(projectId, { ...session, snapshot: refreshed.value.snapshot })
    this.publishReview(projectId)
    return { failure: null, retryAt: null, error: null }
  }

  private async guardDiscussion(
    request: GitRequest<'git:reply'> | GitRequest<'git:resolve'>
  ): Promise<ReviewVersionGuard> {
    const session = this.reviews.get(request.projectId)
    if (
      session?.snapshot.mr.iid !== request.iid ||
      !session.snapshot.threads.some((thread) => thread.id === request.discussionId)
    ) {
      return { failure: 'head-moved', retryAt: null }
    }
    return this.guardReviewVersion({
      projectId: request.projectId,
      iid: request.iid,
      versionId: session.snapshot.version.id,
    })
  }

  async openDiff(request: GitRequest<'git:openDiff'>): Promise<GitResponse<'git:openDiff'>> {
    const guarded = this.localReviewFile(request)
    if ('failure' in guarded) {
      return { failure: guarded.failure, retryAt: guarded.retryAt, error: null }
    }
    const { session, file } = guarded
    if (!this.deps.editor.hasSurface({ host: LOCAL_HOST, root: session.root })) {
      return { failure: 'no-editor', retryAt: null, error: null }
    }
    if (file.summary.binary || file.summary.tooLarge) {
      return { failure: 'not-text', retryAt: null, error: null }
    }
    const fetched = await this.exclusive(session.root, () => this.ensureReviewRefs(session))
    if (fetched.failure !== null) return fetched
    const editable = await this.onReviewBranch(session)
    const workspace = await this.workspaceReviewFile(session, file, editable)
    const matches = !workspace || (await this.matchesReviewHead(session, file))
    const { version } = session.snapshot
    const [before, after] = await Promise.all([
      file.summary.status === 'added'
        ? Promise.resolve({ ok: true, value: { kind: 'text', text: '' } } as const)
        : readFileAt({ cwd: session.root, ref: version.baseSha, path: file.summary.oldPath }),
      workspace || file.summary.status === 'removed'
        ? Promise.resolve({ ok: true, value: { kind: 'text', text: '' } } as const)
        : readFileAt({ cwd: session.root, ref: version.headSha, path: file.summary.path }),
    ])
    if (!before.ok) return { failure: 'git-failed', retryAt: null, error: before.error.message }
    if (!after.ok) return { failure: 'git-failed', retryAt: null, error: after.error.message }
    if (before.value.kind === 'absent' || after.value.kind === 'absent') {
      return { failure: 'git-failed', retryAt: null, error: null }
    }
    if (before.value.kind !== 'text' || after.value.kind !== 'text') {
      return { failure: 'not-text', retryAt: null, error: null }
    }
    if (
      this.reviews.get(request.projectId) !== session ||
      this.deps.gitlab.identity(session.location.host) !== session.identity
    ) {
      return { failure: 'head-moved', retryAt: null, error: null }
    }
    try {
      const result = await this.deps.editor.openReviewDiff(session.root, {
        iid: request.iid,
        versionId: version.id,
        path: file.summary.path,
        oldPath: file.summary.oldPath,
        before: before.value.text,
        after: after.value.text,
        workspace,
        matches,
        ...(request.replace === undefined ? {} : { replace: request.replace }),
      })
      const failure = result.failure === 'no-editor' ? 'no-editor' : 'git-failed'
      return {
        failure: result.ok ? null : failure,
        retryAt: null,
        error: result.message ?? null,
      }
    } catch {
      return { failure: 'no-editor', retryAt: null, error: null }
    }
  }

  async openAllDiffs(
    request: GitRequest<'git:openAllDiffs'>
  ): Promise<GitResponse<'git:openAllDiffs'>> {
    const guarded = this.localReviewVersion(request)
    if ('failure' in guarded) {
      return { failure: guarded.failure, retryAt: guarded.retryAt, error: null, skipped: 0 }
    }
    const { session } = guarded
    if (!this.deps.editor.hasSurface({ host: LOCAL_HOST, root: session.root })) {
      return { failure: 'no-editor', retryAt: null, error: null, skipped: 0 }
    }
    const fetched = await this.exclusive(session.root, () => this.ensureReviewRefs(session))
    if (fetched.failure !== null) return { ...fetched, skipped: 0 }
    const editable = await this.onReviewBranch(session)
    const { version } = session.snapshot
    const files: WorkbenchReviewDiffFile[] = []
    let skipped = 0
    let bytes = 0
    for (const [index, file] of session.snapshot.files.entries()) {
      if (file.summary.binary || file.summary.tooLarge) {
        skipped++
        continue
      }
      const workspace = await this.workspaceReviewFile(session, file, editable)
      const matches = !workspace || (await this.matchesReviewHead(session, file))
      const [before, after] = await Promise.all([
        file.summary.status === 'added'
          ? Promise.resolve({ ok: true, value: { kind: 'text', text: '' } } as const)
          : readFileAt({ cwd: session.root, ref: version.baseSha, path: file.summary.oldPath }),
        workspace || file.summary.status === 'removed'
          ? Promise.resolve({ ok: true, value: { kind: 'text', text: '' } } as const)
          : readFileAt({ cwd: session.root, ref: version.headSha, path: file.summary.path }),
      ])
      if (!before.ok) {
        return { failure: 'git-failed', retryAt: null, error: before.error.message, skipped }
      }
      if (!after.ok) {
        return { failure: 'git-failed', retryAt: null, error: after.error.message, skipped }
      }
      if (before.value.kind !== 'text' || after.value.kind !== 'text') {
        skipped++
        continue
      }
      const size = Buffer.byteLength(before.value.text) + Buffer.byteLength(after.value.text)
      if (bytes + size > MAX_REVIEW_TEXT_BYTES) {
        skipped += session.snapshot.files.length - index
        break
      }
      bytes += size
      files.push({
        path: file.summary.path,
        oldPath: file.summary.oldPath,
        before: before.value.text,
        after: after.value.text,
        workspace,
        matches,
      })
    }
    if (
      this.reviews.get(request.projectId) !== session ||
      this.deps.gitlab.identity(session.location.host) !== session.identity
    ) {
      return { failure: 'head-moved', retryAt: null, error: null, skipped }
    }
    if (files.length === 0) return { failure: null, retryAt: null, error: null, skipped }
    try {
      const result = await this.deps.editor.openReviewDiff(session.root, {
        iid: request.iid,
        versionId: version.id,
        title: mainT('git.review.allChangesTitle', { iid: request.iid }),
        files,
      })
      const failure = result.failure === 'no-editor' ? 'no-editor' : 'git-failed'
      return {
        failure: result.ok ? null : failure,
        retryAt: null,
        error: result.message ?? null,
        skipped,
      }
    } catch {
      return { failure: 'no-editor', retryAt: null, error: null, skipped }
    }
  }

  checkout(projectId: string, target: GitRequest<'git:checkout'>['target']): Promise<Outcome> {
    const cwd = this.localRoot(projectId)
    if (cwd === null)
      return Promise.resolve({ state: unavailable('not-local'), failure: 'not-local' })
    return this.exclusive(cwd, async (): Promise<Outcome> => {
      if (this.deps.projectBusy(projectId)) return this.refused(projectId, 'agent-busy')
      const status = await readStatus({ cwd })
      if (!status.ok) return this.refused(projectId, 'not-a-repository', status.error.message)
      if (!status.value.clean) return this.refused(projectId, 'dirty')
      const resolved = await this.resolveTarget(cwd, target)
      if ('failure' in resolved) return this.refused(projectId, resolved.failure, resolved.error)
      const current = await readStatus({ cwd })
      if (!current.ok) return this.refused(projectId, 'git-failed', current.error.message)
      if (!current.value.clean) return this.refused(projectId, 'dirty')
      if (current.value.branch !== status.value.branch)
        return this.refused(projectId, 'refused-target')
      if (this.deps.projectBusy(projectId)) return this.refused(projectId, 'agent-busy')
      const switched = await switchTo({ cwd, target: resolved.target })
      return switched.ok
        ? { state: await this.state(projectId), failure: null }
        : {
            state: { ...(await this.state(projectId)), error: switched.error.message },
            failure: 'git-failed',
          }
    }).then((outcome) => {
      if (outcome.failure === null) {
        void this.reopenReview(projectId).catch((error: unknown) => {
          this.deps.log?.error('review diff could not be reopened after checkout', error, {
            projectId,
          })
        })
      }
      return outcome
    })
  }

  private async reopenReview(projectId: string): Promise<void> {
    const session = this.reviews.get(projectId)
    if (session === undefined || !(await this.onReviewBranch(session))) return
    if (this.reviews.get(projectId) !== session) return
    const result = await this.deps.editor.openReviewDiff(session.root, {
      kind: 'reopenActive',
      iid: session.snapshot.mr.iid,
      versionId: session.snapshot.version.id,
    })
    if (!result.ok) {
      this.deps.log?.error('review diff could not be reopened after checkout', undefined, {
        projectId,
        failure: result.failure,
        message: result.message,
      })
    }
  }

  async clonesOf(projectId: string, wanted: RemoteLocation | null): Promise<Clone[]> {
    if (wanted === null) return []
    const others = this.deps
      .projects()
      .filter((project) => project.id !== projectId && project.host === LOCAL_HOST)
    const clones = await Promise.all(others.map((project) => cloneOf(project, wanted)))
    return clones.filter((clone): clone is Clone => clone !== null)
  }

  private async onReviewBranch(session: HeldReview): Promise<boolean> {
    if (session.snapshot.mr.fork) return false
    const status = await readStatus({ cwd: session.root })
    return status.ok && status.value.branch === session.snapshot.mr.sourceBranch
  }

  private async matchesReviewHead(session: HeldReview, file: GitLabReviewFile): Promise<boolean> {
    const resolved = resolveWithinRoot(session.root, file.summary.path)
    if (!resolved.ok) return false
    try {
      const [working, head] = await Promise.all([
        readFile(resolved.value, 'utf8'),
        readFileAt({
          cwd: session.root,
          ref: session.snapshot.version.headSha,
          path: file.summary.path,
        }),
      ])
      return head.ok && head.value.kind === 'text' && working === head.value.text
    } catch {
      return false
    }
  }

  private async workspaceReviewFile(
    session: HeldReview,
    file: GitLabReviewFile,
    editable: boolean
  ): Promise<boolean> {
    if (!editable || file.summary.status === 'removed') return false
    const resolved = resolveWithinRoot(session.root, file.summary.path)
    if (!resolved.ok) return false
    try {
      return (await stat(resolved.value)).isFile()
    } catch {
      return false
    }
  }

  async reviewFile(request: GitRequest<'git:reviewFile'>): Promise<GitResponse<'git:reviewFile'>> {
    const guarded = this.localReviewVersion(request)
    if ('failure' in guarded) return { ...guarded, error: null, text: null }
    const { session } = guarded
    const file = session.snapshot.files.find((entry) =>
      request.side === 'original'
        ? entry.summary.oldPath === request.path
        : entry.summary.path === request.path
    )
    if (file === undefined) {
      return { failure: 'refused-target', retryAt: null, error: null, text: null }
    }
    if (file.summary.binary || file.summary.tooLarge) {
      return { failure: 'not-text', retryAt: null, error: null, text: null }
    }
    const fetched = await this.exclusive(session.root, () => this.ensureReviewRefs(session))
    if (fetched.failure !== null) return { ...fetched, text: null }
    const original = request.side === 'original'
    const empty =
      (original && file.summary.status === 'added') ||
      (!original && file.summary.status === 'removed')
    const content = empty
      ? ({ ok: true, value: { kind: 'text', text: '' } } as const)
      : await readFileAt({
          cwd: session.root,
          ref: original ? session.snapshot.version.baseSha : session.snapshot.version.headSha,
          path: original ? file.summary.oldPath : file.summary.path,
        })
    if (
      this.reviews.get(request.projectId) !== session ||
      session.root !== this.localRoot(request.projectId) ||
      this.deps.gitlab.identity(session.location.host) !== session.identity
    ) {
      return { failure: 'head-moved', retryAt: null, error: null, text: null }
    }
    if (!content.ok) {
      return { failure: 'git-failed', retryAt: null, error: content.error.message, text: null }
    }
    if (content.value.kind !== 'text') {
      return {
        failure: content.value.kind === 'absent' ? 'git-failed' : 'not-text',
        retryAt: null,
        error: null,
        text: null,
      }
    }
    return { failure: null, retryAt: null, error: null, text: content.value.text }
  }

  private localReviewFile(request: GitRequest<'git:openDiff'>): ReviewGuard {
    const guarded = this.localReviewVersion(request)
    if ('failure' in guarded) return guarded
    const { session } = guarded
    const file = session.snapshot.files.find((entry) => entry.summary.path === request.path)
    return file === undefined ? { failure: 'refused-target', retryAt: null } : { session, file }
  }

  private async guardReview(request: GitRequest<'git:openDiff'>): Promise<ReviewGuard> {
    const guarded = await this.guardReviewVersion(request)
    if ('failure' in guarded) return guarded
    const { session } = guarded
    const file = session.snapshot.files.find((entry) => entry.summary.path === request.path)
    return file === undefined ? { failure: 'refused-target', retryAt: null } : { session, file }
  }

  private localReviewVersion(request: GitRequest<'git:openAllDiffs'>): ReviewVersionGuard {
    const session = this.reviews.get(request.projectId)
    if (session === undefined) return { failure: 'head-moved', retryAt: null }
    if (
      session.root !== this.localRoot(request.projectId) ||
      session.snapshot.mr.iid !== request.iid ||
      session.snapshot.version.id !== request.versionId
    ) {
      return { failure: 'head-moved', retryAt: null }
    }
    const identity = this.deps.gitlab.identity(session.location.host)
    if (identity === null) return { failure: 'no-token', retryAt: null }
    if (identity !== session.identity) return { failure: 'head-moved', retryAt: null }
    return { session }
  }

  private async guardReviewVersion(
    request: GitRequest<'git:openAllDiffs'>
  ): Promise<ReviewVersionGuard> {
    const guarded = this.localReviewVersion(request)
    if ('failure' in guarded) return guarded
    const { session } = guarded
    const latest = await this.deps.gitlab.latestVersion(session.location, request.iid)
    if (!latest.ok) return { failure: gitFailure(latest.failure), retryAt: latest.retryAt }
    if (
      latest.value !== request.versionId ||
      this.reviews.get(request.projectId) !== session ||
      this.deps.gitlab.identity(session.location.host) !== session.identity
    ) {
      return { failure: 'head-moved', retryAt: null }
    }
    return { session }
  }

  private reviewState(session: HeldReview): GitReviewReady {
    const { snapshot } = session
    return {
      kind: 'ready',
      mr: snapshot.mr,
      version: snapshot.version,
      pipeline: snapshot.pipeline,
      approvals: snapshot.approvals,
      files: snapshot.files.map((entry) => entry.summary),
      threads: snapshot.threads,
      complete: snapshot.complete,
      updatedSinceReview: session.updatedSinceReview,
    }
  }

  private updatedSinceReview(location: RemoteLocation, iid: number, sha: string): boolean {
    const seen = this.deps.marks.readSeen({ host: location.host, project: location.path, iid })
    return seen !== null && seen.headSha !== sha
  }

  private async ensureReviewRefs(session: HeldReview): Promise<GitResponse<'git:openDiff'>> {
    const { version, mr } = session.snapshot
    const key = `${session.root}\u0000${version.headSha}`
    const cwd = session.root
    if (!this.fetchedReviews.has(key) || !(await hasCommit({ cwd, sha: version.headSha }))) {
      const fetched = await fetchRef({
        cwd,
        remote: 'origin',
        ref: `refs/merge-requests/${String(mr.iid)}/head`,
      })
      if (!fetched.ok) return { failure: 'git-failed', retryAt: null, error: fetched.error.message }
      const head = await fetchedHead({ cwd })
      if (!head.ok) return { failure: 'git-failed', retryAt: null, error: head.error.message }
      if (head.value !== version.headSha)
        return { failure: 'head-moved', retryAt: null, error: null }
      this.fetchedReviews.add(key)
    }
    if (!(await hasCommit({ cwd, sha: version.baseSha }))) {
      const fetched = await fetchRef({
        cwd,
        remote: 'origin',
        ref: `refs/heads/${mr.targetBranch}`,
      })
      if (!fetched.ok) return { failure: 'git-failed', retryAt: null, error: fetched.error.message }
      if (!(await hasCommit({ cwd, sha: version.baseSha }))) {
        return { failure: 'git-failed', retryAt: null, error: null }
      }
    }
    return { failure: null, retryAt: null, error: null }
  }

  private async forwardable(projectId: string, cwd: string): Promise<GitSyncNote | null> {
    const [status, branches] = await Promise.all([
      readStatus({ cwd }),
      readBranchInventory({ cwd }),
    ])
    const head = branches.ok
      ? branches.value.find((entry) => entry.head && !entry.remote)
      : undefined
    const upstream = head?.upstream ?? null
    if (!status.ok || head === undefined || upstream === null) return 'no-upstream'
    if (head.name !== status.value.branch) return 'no-upstream'
    if (!upstream.startsWith('origin/')) return 'other-remote'
    if (head.track.kind === 'gone') return 'gone'
    if (head.track.kind !== 'tracking') return 'no-upstream'
    if (head.track.behind === 0) return head.track.ahead > 0 ? 'ahead' : 'up-to-date'
    if (head.track.ahead > 0) return 'diverged'
    if (!status.value.clean) return 'dirty'
    return this.deps.projectBusy(projectId) ? 'agent-busy' : null
  }

  private async resolveTarget(
    cwd: string,
    target: GitRequest<'git:checkout'>['target']
  ): Promise<Resolved> {
    if (target.kind === 'local') return this.resolveBranch(cwd, target.name, 'local')
    if (target.kind === 'remote') return this.resolveBranch(cwd, target.name, 'remote')
    const request = await this.deps.gitlab.requestOf(cwd, target.iid)
    if (request === null) return { failure: 'not-gitlab' }
    if (!request.fork) return this.resolveBranch(cwd, request.sourceBranch, 'any')
    const fetched = await fetchRef({
      cwd,
      remote: 'origin',
      ref: `refs/merge-requests/${String(target.iid)}/head`,
    })
    if (!fetched.ok) return { failure: 'git-failed', error: fetched.error.message }
    const fetchedSha = await fetchedHead({ cwd })
    if (!fetchedSha.ok) return { failure: 'git-failed', error: fetchedSha.error.message }
    return fetchedSha.value === target.sha
      ? { target: { kind: 'detach', sha: target.sha } }
      : { failure: 'head-moved' }
  }

  private async resolveBranch(
    cwd: string,
    name: string,
    kind: 'local' | 'remote' | 'any'
  ): Promise<Resolved> {
    if (!isSafeRef(name)) return { failure: 'refused-target' }
    const branches = await readBranchInventory({ cwd })
    if (!branches.ok) return { failure: 'not-a-repository', error: branches.error.message }
    const local = branches.value.some((entry) => !entry.remote && entry.name === name)
    if (local && kind !== 'remote') return { target: { kind: 'local', name } }
    const remote = branches.value.some((entry) => entry.remote && entry.name === `origin/${name}`)
    if (!remote || kind === 'local') return { failure: 'refused-target' }
    const specs = await readFetchRefspecs({ cwd, remote: 'origin' })
    if (!specs.ok) return { failure: 'unsupported-remote', error: specs.error.message }
    return mapsBranch(specs.value, 'origin', name)
      ? { target: { kind: 'track', remote: 'origin', name } }
      : { failure: 'unsupported-remote' }
  }

  private exclusive<T>(root: string, run: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(root) ?? Promise.resolve()).then(run, run)
    const tail = next.then(
      () => undefined,
      () => undefined
    )
    this.locks.set(root, tail)
    void tail.then(() => {
      if (this.locks.get(root) === tail) this.locks.delete(root)
    })
    return next
  }

  private async refused(projectId: string, failure: GitFailure, error?: string): Promise<Outcome> {
    return { state: { ...(await this.state(projectId)), failure, error: error ?? null }, failure }
  }

  private async invalidateRequests(cwd: string): Promise<void> {
    const origin = await readRemoteUrl({ cwd, remote: 'origin' })
    const location = origin.ok ? parseRemoteUrl(origin.value) : null
    if (location !== null && this.deps.gitlab.handles(location.host)) {
      this.deps.gitlab.invalidate(location)
    }
  }

  private localRoot(projectId: string): string | null {
    const project = this.deps.project(projectId)
    if (project === null) throw new Error(`No project ${projectId}`)
    return project.host === LOCAL_HOST ? project.canonicalRoot : null
  }
}

function gitFailure(failure: GitLabFailure): GitFailure {
  return failure === 'invalid-response' || failure === 'conflict' ? 'git-failed' : failure
}

function reviewFailed(
  failure: GitFailure,
  retryAt: number | null = null
): Extract<GitReviewOutcome, { kind: 'failed' }> {
  return { kind: 'failed', failure, retryAt }
}

async function cloneOf(project: Project, wanted: RemoteLocation): Promise<Clone | null> {
  const cwd = project.canonicalRoot
  const [origin, status] = await Promise.all([
    readRemoteUrl({ cwd, remote: 'origin' }),
    readStatus({ cwd }),
  ])
  const location = origin.ok ? parseRemoteUrl(origin.value) : null
  if (location?.host !== wanted.host || location.path !== wanted.path) return null
  return {
    projectId: project.id,
    name: project.name,
    branch: status.ok ? status.value.branch : null,
  }
}

function rowsOf(entries: readonly BranchEntry[], clones: readonly Clone[]): GitBranch[] {
  const local = entries.filter((entry) => !entry.remote)
  const remoteRefs = new Map<string, BranchEntry>(
    entries.filter((entry) => entry.remote).map((entry) => [entry.name, entry])
  )
  const named = new Set(local.map((entry) => entry.name))
  const remote = entries
    .filter((entry) => entry.remote && entry.name.startsWith('origin/'))
    .map((entry) => ({ ...entry, name: entry.name.slice('origin/'.length) }))
    .filter((entry) => !named.has(entry.name))
  return [...local, ...remote]
    .map<GitBranch>(({ remote: isRemote, committedAt, author, ...entry }) => {
      const counterpart = isRemote
        ? undefined
        : remoteRefs.get(entry.upstream ?? `origin/${entry.name}`)
      const newer =
        counterpart !== undefined && counterpart.committedAt > committedAt ? counterpart : null
      const latestAuthor = newer?.author ?? author
      return {
        ...entry,
        kind: isRemote ? 'remote' : 'local',
        changedAt: newer?.committedAt ?? committedAt,
        author: latestAuthor === '' ? null : latestAuthor,
        elsewhere: clones
          .filter((clone) => clone.branch === entry.name)
          .map((clone) => ({ projectId: clone.projectId, name: clone.name })),
      }
    })
    .sort((a, b) => b.changedAt - a.changedAt)
}

function unavailable(failure: GitFailure): GitBoxState {
  return {
    available: false,
    failure,
    branch: null,
    track: { kind: 'none' },
    dirty: [],
    dirtyCount: 0,
    branches: [],
    provider: { kind: 'other', host: null },
    readAt: null,
    syncedAt: null,
    syncNote: null,
    error: null,
  }
}
