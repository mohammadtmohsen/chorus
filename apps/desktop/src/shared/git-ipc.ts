import { z } from 'zod'

export const GitProject = z.object({ projectId: z.string().min(1) }).strict()

export const GitFailure = z.enum([
  'not-local',
  'not-a-repository',
  'dirty',
  'agent-busy',
  'refused-target',
  'unsupported-remote',
  'git-failed',
  'no-token',
  'unauthorized',
  'forbidden',
  'not-found',
  'rate-limited',
  'network',
  'head-moved',
  'not-gitlab',
  'not-text',
  'no-editor',
])
export type GitFailure = z.infer<typeof GitFailure>

export const GitClone = z.object({ projectId: z.string().min(1), name: z.string() })

export const MrRow = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  webUrl: z.url(),
  draft: z.boolean(),
  labels: z.array(
    z.object({ name: z.string(), color: z.string().nullable(), textColor: z.string().nullable() })
  ),
  author: z.object({ username: z.string(), name: z.string() }),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  sha: z.string(),
  fork: z.boolean(),
  updatedAt: z.number().int(),
  notes: z.number().int().nonnegative(),
  unresolved: z.boolean(),
  mine: z.boolean(),
  reviewRequested: z.boolean(),
  updatedSinceReview: z.boolean(),
  pipeline: z
    .object({
      id: z.number().int().positive(),
      projectId: z.number().int().positive(),
      status: z.string(),
      webUrl: z.url(),
    })
    .nullable(),
  elsewhere: z.array(GitClone),
})
export type MrRow = z.infer<typeof MrRow>

export const ReviewVersion = z.object({
  id: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  startSha: z.string().regex(/^[0-9a-f]{40}$/),
})
export type ReviewVersion = z.infer<typeof ReviewVersion>

export const GitReviewFile = z.object({
  path: z.string().min(1),
  oldPath: z.string(),
  status: z.enum(['added', 'removed', 'modified', 'renamed']),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  binary: z.boolean(),
  collapsed: z.boolean(),
  tooLarge: z.boolean(),
  threads: z.number().int().nonnegative(),
  viewed: z.enum(['no', 'yes', 'changed']),
})
export type GitReviewFile = z.infer<typeof GitReviewFile>

export const GitReviewReady = z.object({
  kind: z.literal('ready'),
  mr: MrRow.pick({
    iid: true,
    title: true,
    webUrl: true,
    author: true,
    sourceBranch: true,
    targetBranch: true,
    labels: true,
  }).extend({ description: z.string() }),
  version: ReviewVersion,
  pipeline: MrRow.shape.pipeline,
  approvals: z
    .object({
      approved: z.boolean(),
      approvalsRequired: z.number().int().nonnegative().nullable(),
      approvalsLeft: z.number().int().nonnegative().nullable(),
      approvers: z.array(z.string()),
      userHasApproved: z.boolean(),
      userCanApprove: z.boolean(),
    })
    .nullable(),
  files: z.array(GitReviewFile),
  complete: z.boolean(),
  updatedSinceReview: z.boolean(),
})
export type GitReviewReady = z.infer<typeof GitReviewReady>

export const GitReview = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preparing') }),
  z.object({
    kind: z.literal('failed'),
    failure: GitFailure,
    retryAt: z.number().int().nullable(),
  }),
  GitReviewReady,
])
export type GitReview = z.infer<typeof GitReview>

export const GitReviewRequest = GitProject.extend({ iid: z.number().int().positive() }).strict()
export const GitReviewVersionRequest = GitReviewRequest.extend({
  versionId: z.number().int().positive(),
}).strict()
export const GitReviewFileRequest = GitReviewVersionRequest.extend({
  path: z.string().min(1),
}).strict()

const GitDiffResult = z.object({
  failure: GitFailure.nullable(),
  retryAt: z.number().int().nullable(),
  error: z.string().nullable(),
})

export const GitRequests = z.object({
  rows: z.array(MrRow),
  complete: z.boolean(),
  fetchedAt: z.number().int().nullable(),
  failure: GitFailure.nullable(),
  retryAt: z.number().int().nullable(),
  username: z.string().nullable(),
})
export type GitRequests = z.infer<typeof GitRequests>

export const GitTrack = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('gone') }),
  z.object({
    kind: z.literal('tracking'),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
  }),
])

export const GitBranch = z.object({
  name: z.string().min(1),
  kind: z.enum(['local', 'remote']),
  head: z.boolean(),
  sha: z.string(),
  changedAt: z.number().int(),
  upstream: z.string().nullable(),
  track: GitTrack,
  elsewhere: z.array(GitClone),
})
export type GitBranch = z.infer<typeof GitBranch>

export const GitProvider = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('gitlab'),
    host: z.string(),
    path: z.string(),
    connected: z.boolean(),
  }),
  z.object({ kind: z.literal('other'), host: z.string().nullable() }),
])

export const GitSyncNote = z.enum([
  'fetched',
  'fast-forwarded',
  'up-to-date',
  'ahead',
  'diverged',
  'dirty',
  'no-upstream',
  'gone',
  'other-remote',
  'agent-busy',
])
export type GitSyncNote = z.infer<typeof GitSyncNote>

export const GitBoxState = z.object({
  available: z.boolean(),
  failure: GitFailure.nullable(),
  branch: z.string().nullable(),
  track: GitTrack,
  dirty: z.array(z.string()).max(50),
  dirtyCount: z.number().int().nonnegative(),
  branches: z.array(GitBranch),
  provider: GitProvider,
  syncedAt: z.number().int().nullable(),
  syncNote: GitSyncNote.nullable(),
  error: z.string().nullable(),
})
export type GitBoxState = z.infer<typeof GitBoxState>

export const GitCheckoutTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), name: z.string().min(1) }),
  z.object({ kind: z.literal('remote'), name: z.string().min(1) }),
  z.object({
    kind: z.literal('mr'),
    iid: z.number().int().positive(),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
  }),
])
export type GitCheckoutTarget = z.infer<typeof GitCheckoutTarget>

export const GIT_CONTRACT = {
  'git:state': { request: GitProject, response: GitBoxState },
  'git:requests': { request: GitProject, response: GitRequests },
  'git:review': { request: GitReviewRequest, response: GitReview },
  'git:viewed': {
    request: GitReviewFileRequest.extend({ viewed: z.boolean() }).strict(),
    response: GitReview,
  },
  'git:openDiff': {
    request: GitReviewFileRequest,
    response: GitDiffResult,
  },
  'git:openAllDiffs': {
    request: GitReviewVersionRequest,
    response: GitDiffResult.extend({ skipped: z.number().int().nonnegative() }),
  },
  'git:fetch': { request: GitProject, response: GitBoxState },
  'git:sync': { request: GitProject, response: GitBoxState },
  'git:checkout': {
    request: GitProject.extend({ target: GitCheckoutTarget }).strict(),
    response: z.object({ state: GitBoxState, failure: GitFailure.nullable() }),
  },
} as const

export type GitContract = typeof GIT_CONTRACT
export type GitChannel = keyof GitContract
export type GitRequest<C extends GitChannel> = z.infer<GitContract[C]['request']>
export type GitResponse<C extends GitChannel> = z.infer<GitContract[C]['response']>
export const GIT_CHANNELS = Object.keys(GIT_CONTRACT) as GitChannel[]

export interface GitApi {
  readonly readGitState: (request: GitRequest<'git:state'>) => Promise<GitResponse<'git:state'>>
  readonly readGitRequests: (
    request: GitRequest<'git:requests'>
  ) => Promise<GitResponse<'git:requests'>>
  readonly readGitReview: (request: GitRequest<'git:review'>) => Promise<GitResponse<'git:review'>>
  readonly setGitViewed: (request: GitRequest<'git:viewed'>) => Promise<GitResponse<'git:viewed'>>
  readonly openGitDiff: (
    request: GitRequest<'git:openDiff'>
  ) => Promise<GitResponse<'git:openDiff'>>
  readonly openGitAllDiffs: (
    request: GitRequest<'git:openAllDiffs'>
  ) => Promise<GitResponse<'git:openAllDiffs'>>
  readonly fetchGit: (request: GitRequest<'git:fetch'>) => Promise<GitResponse<'git:fetch'>>
  readonly syncGit: (request: GitRequest<'git:sync'>) => Promise<GitResponse<'git:sync'>>
  readonly checkoutGit: (
    request: GitRequest<'git:checkout'>
  ) => Promise<GitResponse<'git:checkout'>>
}
