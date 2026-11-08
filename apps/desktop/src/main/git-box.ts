import {
  fastForward,
  fetchBranches,
  fetchedHead,
  fetchRef,
  isSafeRef,
  mapsBranch,
  parseRemoteUrl,
  readBranchInventory,
  readFetchRefspecs,
  readRemoteUrl,
  readStatus,
  switchTo,
  type BranchEntry,
  type RemoteLocation,
  type SwitchTarget,
} from '@chorus/workspace'
import { LOCAL_HOST, type Project } from '@chorus/event-store'
import type {
  GitBoxState,
  GitBranch,
  GitFailure,
  GitRequest,
  GitSyncNote,
} from '../shared/git-ipc.js'

export interface GitProviderPort {
  handles(host: string): boolean
  connected(host: string): boolean
  requestOf(cwd: string, iid: number): Promise<{ fork: boolean; sourceBranch: string } | null>
}

export interface GitBoxDeps {
  readonly project: (projectId: string) => Project | null
  readonly projects: () => readonly Project[]
  readonly projectBusy: (projectId: string) => boolean
  readonly gitlab: GitProviderPort | null
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

export class GitBoxService {
  private readonly synced = new Map<string, number>()
  private readonly locks = new Map<string, Promise<void>>()

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
        gitlab !== null && location !== null && gitlab.handles(location.host)
          ? {
              kind: 'gitlab',
              host: location.host,
              path: location.path,
              connected: gitlab.connected(location.host),
            }
          : { kind: 'other', host: location?.host ?? null },
      syncedAt: this.synced.get(projectId) ?? null,
      syncNote: note,
      error: null,
    }
  }

  async fetch(projectId: string): Promise<GitBoxState> {
    const cwd = this.localRoot(projectId)
    if (cwd === null) return unavailable('not-local')
    const fetched = await fetchBranches({ cwd, remote: 'origin' })
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
    })
  }

  async clonesOf(projectId: string, wanted: RemoteLocation | null): Promise<Clone[]> {
    if (wanted === null) return []
    const others = this.deps
      .projects()
      .filter((project) => project.id !== projectId && project.host === LOCAL_HOST)
    const clones = await Promise.all(others.map((project) => cloneOf(project, wanted)))
    return clones.filter((clone): clone is Clone => clone !== null)
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
    const request =
      this.deps.gitlab === null ? null : await this.deps.gitlab.requestOf(cwd, target.iid)
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

  private localRoot(projectId: string): string | null {
    const project = this.deps.project(projectId)
    if (project === null) throw new Error(`No project ${projectId}`)
    return project.host === LOCAL_HOST ? project.canonicalRoot : null
  }
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
  const remoteDates = new Map<string, number>(
    entries.filter((entry) => entry.remote).map((entry) => [entry.name, entry.committedAt])
  )
  const named = new Set(local.map((entry) => entry.name))
  const remote = entries
    .filter((entry) => entry.remote && entry.name.startsWith('origin/'))
    .map((entry) => ({ ...entry, name: entry.name.slice('origin/'.length) }))
    .filter((entry) => !named.has(entry.name))
  return [...local, ...remote]
    .map<GitBranch>(({ remote: isRemote, committedAt, ...entry }) => ({
      ...entry,
      kind: isRemote ? 'remote' : 'local',
      changedAt: isRemote
        ? committedAt
        : Math.max(
            committedAt,
            remoteDates.get(entry.upstream ?? `origin/${entry.name}`) ?? committedAt
          ),
      elsewhere: clones
        .filter((clone) => clone.branch === entry.name)
        .map((clone) => ({ projectId: clone.projectId, name: clone.name })),
    }))
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
    syncedAt: null,
    syncNote: null,
    error: null,
  }
}
