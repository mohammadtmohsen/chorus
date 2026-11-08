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
])
export type GitFailure = z.infer<typeof GitFailure>

export const GitClone = z.object({ projectId: z.string().min(1), name: z.string() })

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
  readonly fetchGit: (request: GitRequest<'git:fetch'>) => Promise<GitResponse<'git:fetch'>>
  readonly syncGit: (request: GitRequest<'git:sync'>) => Promise<GitResponse<'git:sync'>>
  readonly checkoutGit: (
    request: GitRequest<'git:checkout'>
  ) => Promise<GitResponse<'git:checkout'>>
}
