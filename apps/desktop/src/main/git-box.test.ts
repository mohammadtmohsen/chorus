import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import type * as FileSystemModule from 'node:fs/promises'
import {
  EventStore,
  LOCAL_HOST,
  openSqlite,
  ProjectStore,
  ReviewMarksStore,
  type Project,
  type SqliteHandle,
} from '@chorus/event-store'
import * as workspace from '@chorus/workspace'
import type * as WorkspaceModule from '@chorus/workspace'
import type {
  GitRequest,
  GitResponse,
  GitReviewEnvelope,
  ReviewVersion,
} from '../shared/git-ipc.js'
import { GitBoxService } from './git-box.js'
import {
  GitLabDirectory,
  type GitLabReviewFile,
  type GitLabReviewSnapshot,
  type MrDiffItem,
} from './gitlab-client.js'
import type { EditorPort } from './host-ports.js'
import { testHostPorts } from './test-host-ports.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemModule>()
  return { ...actual, stat: vi.fn<typeof actual.stat>(), readFile: vi.fn<typeof actual.readFile>() }
})

vi.mock('@chorus/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceModule>()
  return {
    ...actual,
    fastForward: vi.fn<typeof actual.fastForward>(),
    fetchBranches: vi.fn<typeof actual.fetchBranches>(),
    fetchedHead: vi.fn<typeof actual.fetchedHead>(),
    fetchRef: vi.fn<typeof actual.fetchRef>(),
    hasCommit: vi.fn<typeof actual.hasCommit>(),
    readBranchInventory: vi.fn<typeof actual.readBranchInventory>(),
    readFetchRefspecs: vi.fn<typeof actual.readFetchRefspecs>(),
    readRemoteUrl: vi.fn<typeof actual.readRemoteUrl>(),
    readFileAt: vi.fn<typeof actual.readFileAt>(),
    readStatus: vi.fn<typeof actual.readStatus>(),
    switchTo: vi.fn<typeof actual.switchTo>(),
  }
})

const ROOT = '/fictional/review-project'
const NOW = 1_000
const REGULAR_FILE = { isFile: () => true } as Awaited<ReturnType<typeof stat>>
const KEY = { host: 'gitlab.com', project: 'group/project', iid: 7 }
const VERSION: ReviewVersion = {
  id: 9,
  headSha: 'b'.repeat(40),
  baseSha: 'a'.repeat(40),
  startSha: 'c'.repeat(40),
}

const latestVersion = vi.fn<GitLabDirectory['latestVersion']>()
const writeReview = vi.fn<GitLabDirectory['writeReview']>()
const hasSurface = vi.fn<EditorPort['hasSurface']>()
const openReviewDiff = vi.fn<EditorPort['openReviewDiff']>()

function reviewFile(path: string, overrides: Partial<MrDiffItem> = {}): GitLabReviewFile {
  const raw: MrDiffItem = {
    old_path: path,
    new_path: path,
    a_mode: '100644',
    b_mode: '100644',
    diff: '@@ -1 +1 @@\n-before\n+after\n',
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    ...overrides,
  }
  return {
    raw,
    summary: {
      path: raw.new_path,
      oldPath: raw.old_path,
      status: raw.new_file
        ? 'added'
        : raw.deleted_file
          ? 'removed'
          : raw.renamed_file
            ? 'renamed'
            : 'modified',
      added: raw.deleted_file ? 0 : 1,
      removed: raw.new_file ? 0 : 1,
      binary: raw.diff.startsWith('Binary files '),
      collapsed: raw.collapsed === true,
      tooLarge: raw.too_large === true,
      threads: 0,
    },
  }
}

function snapshot(overrides: Partial<GitLabReviewSnapshot> = {}): GitLabReviewSnapshot {
  return {
    mr: {
      iid: KEY.iid,
      title: 'Review recorded changes',
      description: 'A fictional merge request',
      webUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
      author: { username: 'author', name: 'Author' },
      sourceBranch: 'feature',
      targetBranch: 'main',
      labels: [],
      fork: false,
    },
    version: VERSION,
    pipeline: null,
    approvals: {
      approved: false,
      approvalsRequired: 1,
      approvalsLeft: 1,
      approvers: [],
      userHasApproved: false,
      userCanApprove: true,
    },
    files: [reviewFile('src/a.ts'), reviewFile('src/b.ts')],
    threads: [],
    complete: true,
    ...overrides,
  }
}

let db: SqliteHandle
let project: Project
let marks: ReviewMarksStore
let directory: GitLabDirectory
let current: GitLabReviewSnapshot
let editor: EditorPort
let service: GitBoxService
let network: ReturnType<typeof vi.fn<typeof fetch>>

function createService(): GitBoxService {
  return new GitBoxService({
    project: (id) => (id === project.id ? project : null),
    projects: () => [project],
    projectBusy: () => false,
    gitlab: directory,
    marks,
    editor,
    now: () => NOW,
  })
}

function fileRequest(path = 'src/a.ts'): GitRequest<'git:openDiff'> {
  return { projectId: project.id, iid: KEY.iid, versionId: current.version.id, path }
}

function allRequest(): GitRequest<'git:openAllDiffs'> {
  return { projectId: project.id, iid: KEY.iid, versionId: current.version.id }
}

function checkedOut(branch: string | null): void {
  vi.mocked(workspace.readStatus).mockResolvedValue({
    ok: true,
    value: { branch, upstream: null, ahead: 0, behind: 0, files: [], clean: true },
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  db = openSqlite({ path: ':memory:' })
  EventStore.open(db)
  project = new ProjectStore(db).create({
    name: 'Review project',
    host: LOCAL_HOST,
    root: ROOT,
    canonicalRoot: ROOT,
    now: NOW,
  })
  marks = new ReviewMarksStore(db)
  current = snapshot()
  network = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected GitLab request'))
  directory = new GitLabDirectory({
    token: () => 'fictional-token',
    now: () => NOW,
    request: network,
  })
  vi.spyOn(directory, 'review').mockImplementation(() =>
    Promise.resolve({
      ok: true,
      value: { kind: 'ready', snapshot: current },
      fetchedAt: NOW,
    })
  )
  latestVersion.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      value: current.version.id,
      fetchedAt: NOW,
    })
  )
  vi.spyOn(directory, 'latestVersion').mockImplementation(latestVersion)
  writeReview.mockResolvedValue({ ok: true, value: {}, fetchedAt: NOW })
  vi.spyOn(directory, 'writeReview').mockImplementation(writeReview)
  hasSurface.mockReturnValue(true)
  openReviewDiff.mockResolvedValue({ requestId: 'test-review', ok: true })
  editor = {
    ...testHostPorts(ROOT).editor,
    hasSurface,
    openReviewDiff,
  }
  vi.mocked(workspace.readRemoteUrl).mockResolvedValue({
    ok: true,
    value: 'git@gitlab.com:group/project.git',
  })
  vi.mocked(workspace.fetchRef).mockResolvedValue({ ok: true, value: undefined })
  vi.mocked(workspace.fetchedHead).mockResolvedValue({ ok: true, value: VERSION.headSha })
  vi.mocked(workspace.hasCommit).mockResolvedValue(true)
  vi.mocked(workspace.readFileAt).mockImplementation(({ ref, path }) =>
    Promise.resolve({ ok: true, value: { kind: 'text', text: `${ref}:${path}` } })
  )
  checkedOut('main')
  vi.mocked(stat).mockResolvedValue(REGULAR_FILE)
  vi.mocked(readFile).mockImplementation((path) =>
    Promise.resolve(
      `${current.version.headSha}:${typeof path === 'string' ? path.slice(ROOT.length + 1) : ''}`
    )
  )
  service = createService()
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
  expect(network).not.toHaveBeenCalled()
})

describe('Git box seen reviews', () => {
  it('returns the review files when approvals are unavailable', async () => {
    current = snapshot({ approvals: null })
    await expect(service.review(project.id, KEY.iid)).resolves.toMatchObject({
      outcome: { kind: 'ready' },
      review: {
        kind: 'ready',
        approvals: null,
        files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      },
    })
  })

  it('refuses moved heads without changing marks, git or the editor', async () => {
    await service.review(project.id, KEY.iid)
    latestVersion.mockResolvedValue({
      ok: true,
      value: VERSION.id + 1,
      fetchedAt: NOW,
    })
    const setSeen = vi.spyOn(marks, 'setSeen')

    await expect(service.openDiff(fileRequest())).resolves.toEqual({
      failure: 'head-moved',
      retryAt: null,
      error: null,
    })
    await expect(service.openAllDiffs(allRequest())).resolves.toEqual({
      failure: 'head-moved',
      retryAt: null,
      error: null,
      skipped: 0,
    })
    expect(setSeen).not.toHaveBeenCalled()
    expect(workspace.fetchRef).not.toHaveBeenCalled()
    expect(workspace.readFileAt).not.toHaveBeenCalled()
    expect(openReviewDiff).not.toHaveBeenCalled()
  })

  it('records the first open and leaves an unchanged head unflagged on reopening', async () => {
    const setSeen = vi.spyOn(marks, 'setSeen')
    await expect(service.review(project.id, KEY.iid)).resolves.toMatchObject({
      outcome: { kind: 'ready' },
      review: { updatedSinceReview: false },
    })
    expect(marks.readSeen(KEY)).toEqual({
      versionId: VERSION.id,
      headSha: VERSION.headSha,
      seenAt: NOW,
    })

    await expect(service.review(project.id, KEY.iid)).resolves.toMatchObject({
      outcome: { kind: 'ready' },
      review: { updatedSinceReview: false },
    })
    expect(setSeen).toHaveBeenCalledTimes(2)
  })

  it('retains the previous seen flag for the session and clears it on the next open', async () => {
    await service.review(project.id, KEY.iid)
    const next = { ...VERSION, id: 10, headSha: 'd'.repeat(40) }
    current = snapshot({ version: next })
    marks = new ReviewMarksStore(db)
    service = createService()

    await expect(service.review(project.id, KEY.iid)).resolves.toMatchObject({
      outcome: { kind: 'ready' },
      review: {
        kind: 'ready',
        updatedSinceReview: true,
        files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      },
    })
    expect(marks.readSeen(KEY)).toEqual({
      versionId: next.id,
      headSha: next.headSha,
      seenAt: NOW,
    })
    const setSeen = vi.spyOn(marks, 'setSeen')
    expect(service.activeReview(project.id).review?.updatedSinceReview).toBe(true)
    expect(setSeen).not.toHaveBeenCalled()

    await expect(service.review(project.id, KEY.iid)).resolves.toMatchObject({
      outcome: { kind: 'ready' },
      review: { updatedSinceReview: false },
    })
    expect(service.activeReview(project.id).review?.updatedSinceReview).toBe(false)
  })

  it('records a ready review as seen even when the snapshot is incomplete', async () => {
    current = snapshot({ complete: false })
    await expect(service.review(project.id, KEY.iid)).resolves.toMatchObject({
      outcome: { kind: 'ready' },
      review: { complete: false, updatedSinceReview: false },
    })
    expect(marks.readSeen(KEY)).toEqual({
      versionId: VERSION.id,
      headSha: VERSION.headSha,
      seenAt: NOW,
    })
  })

  it.each(['preparing', 'failed'] as const)('does not mark a %s review seen', async (kind) => {
    const setSeen = vi.spyOn(marks, 'setSeen')
    const answer: Awaited<ReturnType<GitLabDirectory['review']>> =
      kind === 'preparing'
        ? { ok: true, value: { kind: 'preparing' }, fetchedAt: NOW }
        : { ok: false, failure: 'network', retryAt: null }
    vi.spyOn(directory, 'review').mockResolvedValue(answer)

    await expect(service.review(project.id, KEY.iid)).resolves.toMatchObject({
      outcome: { kind },
      review: null,
    })
    expect(setSeen).not.toHaveBeenCalled()
    expect(marks.readSeen(KEY)).toBeNull()
  })

  it('does not mark a ready snapshot seen when the token changes during its read', async () => {
    const setSeen = vi.spyOn(marks, 'setSeen')
    vi.spyOn(directory, 'review').mockImplementationOnce(() => {
      vi.spyOn(directory, 'identity').mockReturnValue('another-account')
      return Promise.resolve({
        ok: true,
        value: { kind: 'ready', snapshot: current },
        fetchedAt: NOW,
      })
    })

    await expect(service.review(project.id, KEY.iid)).resolves.toMatchObject({
      outcome: { kind: 'failed', failure: 'head-moved' },
      review: null,
    })
    expect(setSeen).not.toHaveBeenCalled()
    expect(marks.readSeen(KEY)).toBeNull()
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let finish: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    finish = resolve
  })
  return {
    promise,
    resolve: (value) => {
      finish(value)
    },
  }
}

describe('the active review', () => {
  it('numbers every change across projects and stops pushing after unsubscribe', async () => {
    const listener = vi.fn<(state: GitReviewEnvelope) => void>()
    const unsubscribe = service.subscribe(listener)
    expect(service.activeReview(project.id)).toEqual({
      projectId: project.id,
      revision: 0,
      review: null,
    })
    const ready = await service.review(project.id, KEY.iid)
    const reopened = await service.review(project.id, KEY.iid)
    const other = service.closeReview('another-project')
    const closed = service.closeReview(project.id)

    expect([ready.revision, reopened.revision, other.revision, closed.revision]).toEqual([
      1, 2, 3, 4,
    ])
    expect(listener.mock.calls.map(([state]) => state.revision)).toEqual([1, 2, 3, 4])
    expect(reopened.review).toEqual(ready.review)
    expect(service.activeReview(project.id)).toEqual(closed)
    unsubscribe()
    service.closeReview(project.id)
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('does not let a pending read restore a closed review', async () => {
    const setSeen = vi.spyOn(marks, 'setSeen')
    const pending = deferred<Awaited<ReturnType<GitLabDirectory['review']>>>()
    const entered = deferred<undefined>()
    vi.spyOn(directory, 'review').mockImplementationOnce(() => {
      entered.resolve(undefined)
      return pending.promise
    })
    const listener = vi.fn<(state: GitReviewEnvelope) => void>()
    service.subscribe(listener)
    const reading = service.review(project.id, KEY.iid)
    await entered.promise
    const closed = service.closeReview(project.id)
    pending.resolve({ ok: true, value: { kind: 'ready', snapshot: current }, fetchedAt: NOW })

    await expect(reading).resolves.toEqual({
      ...closed,
      outcome: { kind: 'failed', failure: 'head-moved', retryAt: null },
    })
    expect(service.activeReview(project.id)).toEqual(closed)
    expect(listener).toHaveBeenCalledExactlyOnceWith(closed)
    expect(setSeen).not.toHaveBeenCalled()
    expect(marks.readSeen(KEY)).toBeNull()
  })

  it('keeps a newer selection when an earlier read completes last', async () => {
    const setSeen = vi.spyOn(marks, 'setSeen')
    const first = current
    const pending = deferred<Awaited<ReturnType<GitLabDirectory['review']>>>()
    const entered = deferred<undefined>()
    vi.spyOn(directory, 'review').mockImplementationOnce(() => {
      entered.resolve(undefined)
      return pending.promise
    })
    const reading = service.review(project.id, KEY.iid)
    await entered.promise
    current = snapshot({ mr: { ...first.mr, iid: 8 } })
    const newer = await service.review(project.id, 8)
    pending.resolve({ ok: true, value: { kind: 'ready', snapshot: first }, fetchedAt: NOW })

    await expect(reading).resolves.toMatchObject({
      revision: newer.revision,
      review: { mr: { iid: 8 } },
      outcome: { kind: 'failed', failure: 'head-moved' },
    })
    expect(service.activeReview(project.id).review?.mr.iid).toBe(8)
    expect(service.activeReview(project.id).revision).toBe(newer.revision)
    expect(marks.readSeen(KEY)).toBeNull()
    expect(marks.readSeen({ ...KEY, iid: 8 })).toEqual({
      versionId: VERSION.id,
      headSha: VERSION.headSha,
      seenAt: NOW,
    })
    expect(setSeen).toHaveBeenCalledTimes(1)
  })

  it.each(['preparing', 'failed'] as const)(
    'keeps the last good snapshot after a same-MR %s outcome and clears it for another MR',
    async (kind) => {
      await service.review(project.id, KEY.iid)
      const setSeen = vi.spyOn(marks, 'setSeen')
      const held = service.activeReview(project.id)
      const listener = vi.fn<(state: GitReviewEnvelope) => void>()
      service.subscribe(listener)
      const answer: Awaited<ReturnType<GitLabDirectory['review']>> =
        kind === 'preparing'
          ? { ok: true, value: { kind: 'preparing' }, fetchedAt: NOW }
          : { ok: false, failure: 'network', retryAt: null }
      vi.spyOn(directory, 'review').mockResolvedValue(answer)

      const same = await service.review(project.id, KEY.iid)
      expect(same).toMatchObject({ ...held, outcome: { kind } })
      expect(listener).not.toHaveBeenCalled()
      const different = await service.review(project.id, 8)
      expect(different.review).toBeNull()
      expect(different.revision).toBe(held.revision + 1)
      expect(different.outcome.kind).toBe(kind)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(setSeen).not.toHaveBeenCalled()
      expect(marks.readSeen({ ...KEY, iid: 8 })).toBeNull()
    }
  )

  it('refuses stale file actions without changing marks, the snapshot or the revision', async () => {
    await service.review(project.id, KEY.iid)
    const held = service.activeReview(project.id)
    const listener = vi.fn<(state: GitReviewEnvelope) => void>()
    const setSeen = vi.spyOn(marks, 'setSeen')
    service.subscribe(listener)
    await expect(
      service.openDiff({
        ...fileRequest(),
        versionId: VERSION.id + 1,
      })
    ).resolves.toEqual({
      failure: 'head-moved',
      retryAt: null,
      error: null,
    })
    await expect(service.openDiff({ ...fileRequest(), iid: KEY.iid + 1 })).resolves.toEqual({
      failure: 'head-moved',
      retryAt: null,
      error: null,
    })
    expect(setSeen).not.toHaveBeenCalled()
    expect(latestVersion).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expect(service.activeReview(project.id)).toEqual(held)
  })
})

describe('Git box review writes', () => {
  const thread = {
    id: 'discussion-1',
    path: 'src/a.ts',
    oldPath: 'src/a.ts',
    oldLine: 1,
    newLine: 1,
    resolved: false,
    notes: [
      {
        id: 1,
        body: 'Existing',
        author: { name: 'Author', username: 'author' },
        createdAt: NOW,
      },
    ],
  }
  const kinds = ['comment', 'reply', 'resolve', 'reopen', 'approve', 'unapprove'] as const
  const invoke = (kind: (typeof kinds)[number]): Promise<GitResponse<'git:approve'>> => {
    const base = { projectId: project.id, iid: KEY.iid }
    switch (kind) {
      case 'comment':
        return service.comment({ ...fileRequest(), side: 'modified', line: 1, body: 'New comment' })
      case 'reply':
        return service.reply({ ...base, discussionId: thread.id, body: 'A reply' })
      case 'resolve':
      case 'reopen':
        return service.resolve({ ...base, discussionId: thread.id, resolved: kind === 'resolve' })
      case 'approve':
      case 'unapprove':
        return service.approve({ ...base, versionId: VERSION.id, approve: kind === 'approve' })
    }
  }

  it.each(kinds)('sends %s and publishes the refreshed snapshot', async (kind) => {
    current = snapshot({ threads: [thread] })
    await service.review(project.id, KEY.iid)
    const reviews = vi.spyOn(directory, 'review')
    reviews.mockClear()
    const listener = vi.fn<(state: GitReviewEnvelope) => void>()
    service.subscribe(listener)
    writeReview.mockImplementationOnce(() => {
      current = { ...current, mr: { ...current.mr, title: 'After write' } }
      return Promise.resolve({ ok: true, value: {}, fetchedAt: NOW })
    })
    await expect(invoke(kind)).resolves.toEqual({ failure: null, retryAt: null, error: null })
    const writes = {
      comment: {
        method: 'POST',
        suffix: '/discussions',
        body: {
          body: 'New comment',
          position: {
            position_type: 'text',
            base_sha: VERSION.baseSha,
            start_sha: VERSION.startSha,
            head_sha: VERSION.headSha,
            old_path: 'src/a.ts',
            new_path: 'src/a.ts',
            new_line: 1,
          },
        },
      },
      reply: {
        method: 'POST',
        suffix: '/discussions/discussion-1/notes',
        body: { body: 'A reply' },
      },
      resolve: { method: 'PUT', suffix: '/discussions/discussion-1', body: { resolved: true } },
      reopen: { method: 'PUT', suffix: '/discussions/discussion-1', body: { resolved: false } },
      approve: { method: 'POST', suffix: '/approve', body: { sha: VERSION.headSha } },
      unapprove: { method: 'POST', suffix: '/unapprove', body: {} },
    } as const
    const expected = writes[kind]
    expect(writeReview).toHaveBeenCalledExactlyOnceWith(
      { host: KEY.host, path: KEY.project },
      KEY.iid,
      expected.method,
      expected.suffix,
      expected.body
    )
    expect(reviews).toHaveBeenCalledExactlyOnceWith(
      { host: KEY.host, path: KEY.project },
      KEY.iid,
      true
    )
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        revision: 2,
        review: expect.objectContaining({
          mr: expect.objectContaining({ title: 'After write' }),
        }),
      })
    )
  })

  it.each(kinds)('refuses %s after the review head moves', async (kind) => {
    current = snapshot({ threads: [thread] })
    await service.review(project.id, KEY.iid)
    latestVersion.mockResolvedValue({ ok: true, value: VERSION.id + 1, fetchedAt: NOW })
    const listener = vi.fn<(state: GitReviewEnvelope) => void>()
    service.subscribe(listener)
    await expect(invoke(kind)).resolves.toEqual({
      failure: 'head-moved',
      retryAt: null,
      error: null,
    })
    expect(writeReview).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  it('maps approval conflicts to head-moved and retains GitLab error text', async () => {
    await service.review(project.id, KEY.iid)
    writeReview.mockResolvedValue({
      ok: false,
      failure: 'conflict',
      retryAt: null,
      error: 'SHA changed',
    })
    await expect(invoke('approve')).resolves.toEqual({
      failure: 'head-moved',
      retryAt: null,
      error: 'SHA changed',
    })
  })

  it('keeps a refused position message and does not publish a failed write', async () => {
    await service.review(project.id, KEY.iid)
    const listener = vi.fn<(state: GitReviewEnvelope) => void>()
    service.subscribe(listener)
    writeReview.mockResolvedValue({
      ok: false,
      failure: 'invalid-response',
      retryAt: null,
      error: 'Position is invalid',
    })
    await expect(invoke('comment')).resolves.toEqual({
      failure: 'git-failed',
      retryAt: null,
      error: 'Position is invalid',
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('reports that a write was submitted when the following refresh fails', async () => {
    await service.review(project.id, KEY.iid)
    vi.spyOn(directory, 'review').mockResolvedValueOnce({
      ok: false,
      failure: 'network',
      retryAt: null,
    })
    await expect(invoke('comment')).resolves.toMatchObject({
      failure: 'network',
      error: expect.stringContaining('submitted to GitLab'),
    })
    expect(writeReview).toHaveBeenCalledTimes(1)
  })
})

describe('Git box editor diffs', () => {
  it('keeps edit mode but blocks comments when workspace content differs from the head', async () => {
    checkedOut('feature')
    vi.mocked(readFile).mockResolvedValue('edited on disk')
    await service.review(project.id, KEY.iid)
    await service.openDiff(fileRequest())
    expect(openReviewDiff).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ workspace: true, matches: false, after: '' })
    )
  })

  it('opens workspace text without sending it and checks whether it matches the head', async () => {
    checkedOut('feature')
    await service.review(project.id, KEY.iid)

    await expect(service.openDiff(fileRequest())).resolves.toMatchObject({ failure: null })

    expect(stat).toHaveBeenCalledExactlyOnceWith(`${ROOT}/src/a.ts`)
    expect(workspace.readFileAt).toHaveBeenCalledTimes(2)
    expect(workspace.readFileAt).toHaveBeenCalledWith({
      cwd: ROOT,
      ref: VERSION.baseSha,
      path: 'src/a.ts',
    })
    expect(openReviewDiff).toHaveBeenCalledExactlyOnceWith(ROOT, {
      iid: KEY.iid,
      versionId: VERSION.id,
      path: 'src/a.ts',
      oldPath: 'src/a.ts',
      before: `${VERSION.baseSha}:src/a.ts`,
      after: '',
      workspace: true,
      matches: true,
    })
  })

  it.each(['main', null])('keeps the review read-only on branch %s', async (branch) => {
    checkedOut(branch)
    await service.review(project.id, KEY.iid)
    await service.openDiff(fileRequest())

    expect(openReviewDiff).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ after: `${VERSION.headSha}:src/a.ts`, workspace: false })
    )
    expect(stat).not.toHaveBeenCalled()
  })

  it('keeps a fork read-only even when its source branch name matches', async () => {
    checkedOut('feature')
    current = snapshot({ mr: { ...current.mr, fork: true } })
    await service.review(project.id, KEY.iid)
    await service.openDiff(fileRequest())

    expect(openReviewDiff).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ after: `${VERSION.headSha}:src/a.ts`, workspace: false })
    )
    expect(stat).not.toHaveBeenCalled()
  })

  it.each(['missing', 'directory'] as const)(
    'keeps a %s workspace file read-only',
    async (kind) => {
      checkedOut('feature')
      if (kind === 'missing') vi.mocked(stat).mockRejectedValue(new Error('File missing'))
      else {
        vi.mocked(stat).mockResolvedValue({
          isFile: () => false,
        } as Awaited<ReturnType<typeof stat>>)
      }
      await service.review(project.id, KEY.iid)
      await service.openDiff(fileRequest())

      expect(openReviewDiff).toHaveBeenCalledWith(
        ROOT,
        expect.objectContaining({ after: `${VERSION.headSha}:src/a.ts`, workspace: false })
      )
    }
  )

  it('keeps a path outside the project read-only', async () => {
    checkedOut('feature')
    current = snapshot({ files: [reviewFile('../outside.ts')] })
    await service.review(project.id, KEY.iid)
    await service.openDiff(fileRequest('../outside.ts'))

    expect(openReviewDiff).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ after: `${VERSION.headSha}:../outside.ts`, workspace: false })
    )
    expect(stat).not.toHaveBeenCalled()
  })

  it('rechecks the branch when the same review file is opened again', async () => {
    checkedOut('feature')
    await service.review(project.id, KEY.iid)
    await service.openDiff(fileRequest())
    checkedOut('main')
    await service.openDiff(fileRequest())

    expect(openReviewDiff).toHaveBeenNthCalledWith(
      1,
      ROOT,
      expect.objectContaining({ workspace: true, after: '' })
    )
    expect(openReviewDiff).toHaveBeenNthCalledWith(
      2,
      ROOT,
      expect.objectContaining({ workspace: false, after: `${VERSION.headSha}:src/a.ts` })
    )
  })

  it('mixes editable and read-only files in one multi-file diff', async () => {
    checkedOut('feature')
    current = snapshot({
      files: [
        reviewFile('editable.ts'),
        reviewFile('removed.ts', { deleted_file: true }),
        reviewFile('missing.ts'),
        reviewFile('../outside.ts'),
      ],
    })
    vi.mocked(stat).mockImplementation((path) =>
      String(path).endsWith('/missing.ts')
        ? Promise.reject(new Error('File missing'))
        : Promise.resolve(REGULAR_FILE)
    )
    await service.review(project.id, KEY.iid)
    await expect(service.openAllDiffs(allRequest())).resolves.toEqual({
      failure: null,
      retryAt: null,
      error: null,
      skipped: 0,
    })

    expect(openReviewDiff).toHaveBeenCalledExactlyOnceWith(ROOT, {
      iid: KEY.iid,
      versionId: VERSION.id,
      title: '!7 changes',
      files: [
        {
          path: 'editable.ts',
          oldPath: 'editable.ts',
          before: `${VERSION.baseSha}:editable.ts`,
          after: '',
          workspace: true,
          matches: true,
        },
        {
          path: 'removed.ts',
          oldPath: 'removed.ts',
          before: `${VERSION.baseSha}:removed.ts`,
          after: '',
          workspace: false,
          matches: true,
        },
        {
          path: 'missing.ts',
          oldPath: 'missing.ts',
          before: `${VERSION.baseSha}:missing.ts`,
          after: `${VERSION.headSha}:missing.ts`,
          workspace: false,
          matches: true,
        },
        {
          path: '../outside.ts',
          oldPath: '../outside.ts',
          before: `${VERSION.baseSha}:../outside.ts`,
          after: `${VERSION.headSha}:../outside.ts`,
          workspace: false,
          matches: true,
        },
      ],
    })
    expect(workspace.readFileAt).toHaveBeenCalledWith({
      cwd: ROOT,
      ref: VERSION.headSha,
      path: 'editable.ts',
    })
    expect(workspace.readStatus).toHaveBeenCalledExactlyOnceWith({ cwd: ROOT })
  })

  it('counts skipped files and stops a multi-file diff at the UTF-8 text bound', async () => {
    const paths = ['first.ts', 'second.ts', 'third.ts', 'fourth.ts']
    const text = 'é'.repeat(1024 * 1024)
    current = snapshot({
      files: [
        reviewFile('image.png', { diff: 'Binary files a/image.png and b/image.png differ\n' }),
        reviewFile('large.ts', { too_large: true }),
        reviewFile('absent.ts'),
        reviewFile('detected.png'),
        ...paths.map((path) => reviewFile(path)),
        reviewFile('overflow.ts'),
        reviewFile('unread.ts'),
      ],
    })
    vi.mocked(workspace.readFileAt).mockImplementation(({ path }) => {
      if (path === 'absent.ts') return Promise.resolve({ ok: true, value: { kind: 'absent' } })
      if (path === 'detected.png') return Promise.resolve({ ok: true, value: { kind: 'binary' } })
      return Promise.resolve({ ok: true, value: { kind: 'text', text } })
    })
    await service.review(project.id, KEY.iid)

    await expect(service.openAllDiffs(allRequest())).resolves.toEqual({
      failure: null,
      retryAt: null,
      error: null,
      skipped: 6,
    })
    expect(openReviewDiff).toHaveBeenCalledExactlyOnceWith(ROOT, {
      iid: KEY.iid,
      versionId: VERSION.id,
      title: '!7 changes',
      files: paths.map((path) => ({
        path,
        oldPath: path,
        before: text,
        after: text,
        workspace: false,
        matches: true,
      })),
    })
    for (const path of ['image.png', 'large.ts', 'unread.ts']) {
      expect(workspace.readFileAt).not.toHaveBeenCalledWith(expect.objectContaining({ path }))
    }
    expect(workspace.fetchRef).toHaveBeenCalledTimes(1)
  })

  it('fetches a review head once for multiple files of the same version', async () => {
    await service.review(project.id, KEY.iid)
    await expect(service.openDiff(fileRequest('src/a.ts'))).resolves.toMatchObject({
      failure: null,
    })
    await expect(service.openDiff(fileRequest('src/b.ts'))).resolves.toMatchObject({
      failure: null,
    })

    expect(workspace.fetchRef).toHaveBeenCalledExactlyOnceWith({
      cwd: ROOT,
      remote: 'origin',
      ref: 'refs/merge-requests/7/head',
    })
    expect(workspace.fetchedHead).toHaveBeenCalledTimes(1)
    expect(workspace.readFileAt).toHaveBeenCalledTimes(4)
    expect(openReviewDiff).toHaveBeenCalledTimes(2)
  })

  it('reads a rename from the old base path and the new head path', async () => {
    current = snapshot({
      files: [reviewFile('src/new.ts', { old_path: 'src/old.ts', renamed_file: true })],
    })
    await service.review(project.id, KEY.iid)
    await service.openDiff(fileRequest('src/new.ts'))

    expect(workspace.readFileAt).toHaveBeenNthCalledWith(1, {
      cwd: ROOT,
      ref: VERSION.baseSha,
      path: 'src/old.ts',
    })
    expect(workspace.readFileAt).toHaveBeenNthCalledWith(2, {
      cwd: ROOT,
      ref: VERSION.headSha,
      path: 'src/new.ts',
    })
    expect(openReviewDiff).toHaveBeenCalledWith(ROOT, {
      iid: KEY.iid,
      versionId: VERSION.id,
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      before: `${VERSION.baseSha}:src/old.ts`,
      after: `${VERSION.headSha}:src/new.ts`,
      workspace: false,
      matches: true,
    })
  })

  it('opens an added file with an empty before side and reads only the head', async () => {
    current = snapshot({ files: [reviewFile('added.ts', { new_file: true })] })
    await service.review(project.id, KEY.iid)
    await service.openDiff(fileRequest('added.ts'))

    expect(workspace.readFileAt).toHaveBeenCalledExactlyOnceWith({
      cwd: ROOT,
      ref: VERSION.headSha,
      path: 'added.ts',
    })
    expect(openReviewDiff).toHaveBeenCalledWith(ROOT, {
      iid: KEY.iid,
      versionId: VERSION.id,
      path: 'added.ts',
      oldPath: 'added.ts',
      before: '',
      after: `${VERSION.headSha}:added.ts`,
      workspace: false,
      matches: true,
    })
  })

  it('opens a deleted file with an empty after side and reads only the base', async () => {
    checkedOut('feature')
    current = snapshot({ files: [reviewFile('deleted.ts', { deleted_file: true })] })
    await service.review(project.id, KEY.iid)
    await service.openDiff(fileRequest('deleted.ts'))

    expect(workspace.readFileAt).toHaveBeenCalledExactlyOnceWith({
      cwd: ROOT,
      ref: VERSION.baseSha,
      path: 'deleted.ts',
    })
    expect(openReviewDiff).toHaveBeenCalledWith(ROOT, {
      iid: KEY.iid,
      versionId: VERSION.id,
      path: 'deleted.ts',
      oldPath: 'deleted.ts',
      before: `${VERSION.baseSha}:deleted.ts`,
      after: '',
      workspace: false,
      matches: true,
    })
  })

  it('refuses a binary file before fetching refs or opening an editor', async () => {
    current = snapshot({
      files: [
        reviewFile('image.png', { diff: 'Binary files a/image.png and b/image.png differ\n' }),
      ],
    })
    await service.review(project.id, KEY.iid)

    await expect(service.openDiff(fileRequest('image.png'))).resolves.toEqual({
      failure: 'not-text',
      retryAt: null,
      error: null,
    })
    expect(workspace.fetchRef).not.toHaveBeenCalled()
    expect(workspace.readFileAt).not.toHaveBeenCalled()
    expect(openReviewDiff).not.toHaveBeenCalled()
  })

  it('refuses binary content discovered by git even when the summary looked textual', async () => {
    await service.review(project.id, KEY.iid)
    vi.mocked(workspace.readFileAt).mockResolvedValueOnce({ ok: true, value: { kind: 'binary' } })

    await expect(service.openDiff(fileRequest())).resolves.toMatchObject({ failure: 'not-text' })
    expect(openReviewDiff).not.toHaveBeenCalled()
  })

  it('requires a running editor before fetching refs or reading file contents', async () => {
    await service.review(project.id, KEY.iid)
    hasSurface.mockReturnValue(false)

    await expect(service.openDiff(fileRequest())).resolves.toEqual({
      failure: 'no-editor',
      retryAt: null,
      error: null,
    })
    await expect(service.openAllDiffs(allRequest())).resolves.toEqual({
      failure: 'no-editor',
      retryAt: null,
      error: null,
      skipped: 0,
    })
    expect(workspace.fetchRef).not.toHaveBeenCalled()
    expect(workspace.readFileAt).not.toHaveBeenCalled()
    expect(openReviewDiff).not.toHaveBeenCalled()
  })
})
