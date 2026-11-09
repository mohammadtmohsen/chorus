import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import type { GitRequest, ReviewVersion } from '../shared/git-ipc.js'
import { GitBoxService } from './git-box.js'
import {
  fileDigest,
  GitLabDirectory,
  type GitLabReviewFile,
  type GitLabReviewSnapshot,
  type MrDiffItem,
} from './gitlab-client.js'
import type { EditorPort } from './host-ports.js'
import { testHostPorts } from './test-host-ports.js'

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
const KEY = { host: 'gitlab.com', project: 'group/project', iid: 7 }
const VERSION: ReviewVersion = {
  id: 9,
  headSha: 'b'.repeat(40),
  baseSha: 'a'.repeat(40),
  startSha: 'c'.repeat(40),
}

const latestVersion = vi.fn<GitLabDirectory['latestVersion']>()
const hasSurface = vi.fn<EditorPort['hasSurface']>()
const openReviewDiff = vi.fn<EditorPort['openReviewDiff']>()

function reviewFile(
  path: string,
  overrides: Partial<MrDiffItem> = {},
  version: ReviewVersion = VERSION
): GitLabReviewFile {
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
    digest: fileDigest(version, raw),
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
  service = createService()
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
  expect(network).not.toHaveBeenCalled()
})

describe('Git box review marks', () => {
  it('returns the review files when approvals are unavailable', async () => {
    current = snapshot({ approvals: null })
    await expect(service.review(project.id, KEY.iid)).resolves.toMatchObject({
      kind: 'ready',
      approvals: null,
      files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    })
  })

  it('refuses a moved head before writing marks or touching git or the editor', async () => {
    await service.review(project.id, KEY.iid)
    latestVersion.mockResolvedValue({
      ok: true,
      value: VERSION.id + 1,
      fetchedAt: NOW,
    })
    const setViewed = vi.spyOn(marks, 'setViewed')
    const setSeen = vi.spyOn(marks, 'setSeen')

    await expect(service.viewed({ ...fileRequest(), viewed: true })).resolves.toEqual({
      kind: 'failed',
      failure: 'head-moved',
      retryAt: null,
    })
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
    expect(setViewed).not.toHaveBeenCalled()
    expect(setSeen).not.toHaveBeenCalled()
    expect(workspace.fetchRef).not.toHaveBeenCalled()
    expect(workspace.readFileAt).not.toHaveBeenCalled()
    expect(openReviewDiff).not.toHaveBeenCalled()
  })

  it('restores unchanged marks and reports changed files after a newer version', async () => {
    await service.review(project.id, KEY.iid)
    await service.viewed({ ...fileRequest('src/a.ts'), viewed: true })
    await service.viewed({ ...fileRequest('src/b.ts'), viewed: true })
    const next = { ...VERSION, id: 10, headSha: 'd'.repeat(40) }
    current = snapshot({
      version: next,
      files: [
        reviewFile('src/a.ts', {}, next),
        reviewFile('src/b.ts', { diff: '@@ -1 +1 @@\n-before\n+changed again\n' }, next),
      ],
    })
    marks = new ReviewMarksStore(db)
    service = createService()

    await expect(service.review(project.id, KEY.iid)).resolves.toMatchObject({
      kind: 'ready',
      updatedSinceReview: true,
      files: [
        { path: 'src/a.ts', viewed: 'yes' },
        { path: 'src/b.ts', viewed: 'changed' },
      ],
    })
    expect(marks.readSeen(KEY)?.headSha).toBe(VERSION.headSha)
  })

  it('records a seen version only after every file in a complete review is viewed', async () => {
    await service.review(project.id, KEY.iid)
    await service.viewed({ ...fileRequest('src/a.ts'), viewed: true })
    expect(marks.readSeen(KEY)).toBeNull()

    await service.viewed({ ...fileRequest('src/b.ts'), viewed: true })
    expect(marks.readSeen(KEY)).toEqual({
      versionId: VERSION.id,
      headSha: VERSION.headSha,
      seenAt: NOW,
    })
  })

  it('keeps an incomplete review unseen when every returned file is viewed', async () => {
    current = snapshot({ complete: false })
    await service.review(project.id, KEY.iid)
    await service.viewed({ ...fileRequest('src/a.ts'), viewed: true })
    await service.viewed({ ...fileRequest('src/b.ts'), viewed: true })

    expect(marks.readViewed(KEY).size).toBe(2)
    expect(marks.readSeen(KEY)).toBeNull()
  })
})

describe('Git box editor diffs', () => {
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
      files: paths.map((path) => ({ path, oldPath: path, before: text, after: text })),
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
    })
  })

  it('opens a deleted file with an empty after side and reads only the base', async () => {
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
