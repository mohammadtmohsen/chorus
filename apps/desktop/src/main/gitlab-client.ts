import { createHash } from 'node:crypto'
import { parseRemoteUrl, readRemoteUrl, type RemoteLocation } from '@chorus/workspace'
import { z } from 'zod'
import type { MrRow } from '../shared/git-ipc.js'
import type { GitProviderPort } from './git-box.js'

export type GitLabFailure =
  | 'no-token'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'rate-limited'
  | 'network'
  | 'invalid-response'

export type GitLabResult<T> =
  | { readonly ok: true; readonly value: T; readonly fetchedAt: number }
  | { readonly ok: false; readonly failure: GitLabFailure; readonly retryAt: number | null }

export interface Paged<T> {
  readonly items: T[]
  readonly complete: boolean
}

const FAILURE_BY_STATUS: Readonly<Record<number, GitLabFailure>> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
}

const PAGE = 100
const TTL_MS = 60_000
const DETAIL_LIMIT = 40
const DETAIL_CONCURRENCY = 4

interface CacheEntry {
  readonly project: string
  readonly at: number
  readonly value: unknown
}

interface InflightEntry {
  readonly project: string
  readonly promise: Promise<GitLabResult<unknown>>
}

export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

export class GitLabClient {
  private readonly inflight = new Map<string, InflightEntry>()
  private readonly cache = new Map<string, CacheEntry>()
  private readonly generations = new Map<string, number>()
  private coolUntil = 0

  constructor(
    private readonly host: string,
    private readonly token: string,
    private readonly now: () => number = Date.now,
    private readonly request: typeof fetch = fetch
  ) {}

  get<T>(
    project: string,
    path: string,
    schema: z.ZodType<T>,
    ttlMs: number
  ): Promise<GitLabResult<T>> {
    const key = `${project}\u0000${path}`
    const cached = this.cache.get(key)
    if (cached !== undefined && this.now() - cached.at < ttlMs) {
      return Promise.resolve({ ok: true, value: cached.value as T, fetchedAt: cached.at })
    }
    const running = this.inflight.get(key)
    if (running !== undefined) return running.promise as Promise<GitLabResult<T>>
    const generation = this.generationOf(project)
    const started = this.send('GET', path, undefined, schema).then((result) => {
      if (result.ok && this.generationOf(project) === generation) {
        this.cache.set(key, { project, at: result.fetchedAt, value: result.value })
      }
      return result
    })
    this.inflight.set(key, { project, promise: started })
    const release = (): void => {
      if (this.inflight.get(key)?.promise === started) this.inflight.delete(key)
    }
    void started.then(release, release)
    return started
  }

  async getAll<T>(
    project: string,
    path: string,
    item: z.ZodType<T>,
    ttlMs: number,
    maxPages = 20
  ): Promise<GitLabResult<Paged<T>>> {
    const items: T[] = []
    let fetchedAt = this.now()
    const separator = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.get(
        project,
        `${path}${separator}per_page=${String(PAGE)}&page=${String(page)}`,
        z.array(item),
        ttlMs
      )
      if (!result.ok) return result
      items.push(...result.value)
      fetchedAt = Math.min(fetchedAt, result.fetchedAt)
      if (result.value.length < PAGE) {
        return { ok: true, value: { items, complete: true }, fetchedAt }
      }
    }
    return { ok: true, value: { items, complete: false }, fetchedAt }
  }

  async write<T>(
    project: string,
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    schema: z.ZodType<T>
  ): Promise<GitLabResult<T>> {
    this.invalidate(project)
    const result = await this.send(method, path, body, schema)
    this.invalidate(project)
    return result
  }

  invalidate(project: string): void {
    this.generations.set(project, this.generationOf(project) + 1)
    for (const [key, entry] of this.cache) {
      if (entry.project === project) this.cache.delete(key)
    }
    for (const [key, entry] of this.inflight) {
      if (entry.project === project) this.inflight.delete(key)
    }
  }

  private generationOf(project: string): number {
    return this.generations.get(project) ?? 0
  }

  private async send<T>(
    method: string,
    path: string,
    body: unknown,
    schema: z.ZodType<T>
  ): Promise<GitLabResult<T>> {
    if (this.now() < this.coolUntil) {
      return { ok: false, failure: 'rate-limited', retryAt: this.coolUntil }
    }
    const signal = AbortSignal.timeout(20_000)
    let response: Response
    try {
      response = await this.request(`https://${this.host}/api/v4${path}`, {
        method,
        headers: {
          'PRIVATE-TOKEN': this.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
        redirect: 'error',
      })
    } catch {
      return { ok: false, failure: 'network', retryAt: null }
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'))
      const until = this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000
      this.coolUntil = Math.max(this.coolUntil, until)
      return { ok: false, failure: 'rate-limited', retryAt: this.coolUntil }
    }
    if (!response.ok) {
      return { ok: false, failure: FAILURE_BY_STATUS[response.status] ?? 'network', retryAt: null }
    }
    try {
      const decoded: unknown = response.status === 204 ? null : await response.json()
      const parsed = schema.safeParse(decoded)
      return parsed.success
        ? { ok: true, value: parsed.data, fetchedAt: this.now() }
        : { ok: false, failure: 'invalid-response', retryAt: null }
    } catch {
      return { ok: false, failure: signal.aborted ? 'network' : 'invalid-response', retryAt: null }
    }
  }
}

const Person = z.object({ username: z.string(), name: z.string() })
const User = z.object({ username: z.string() })

const MrListItem = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  web_url: z.string(),
  draft: z.boolean(),
  sha: z.string().nullable(),
  source_branch: z.string(),
  target_branch: z.string(),
  source_project_id: z.number().int().nullable(),
  target_project_id: z.number().int(),
  updated_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  user_notes_count: z.number().int().nonnegative(),
  blocking_discussions_resolved: z.boolean(),
  author: Person,
  reviewers: z.array(Person),
  labels: z.array(
    z.object({
      name: z.string(),
      color: z.string().optional(),
      text_color: z.string().optional(),
    })
  ),
})

const MrDetail = MrListItem.omit({ labels: true }).extend({
  description: z.string().nullable(),
  diff_refs: z
    .object({ base_sha: z.string(), start_sha: z.string(), head_sha: z.string() })
    .nullable(),
  head_pipeline: z
    .object({
      id: z.number().int(),
      project_id: z.number().int(),
      sha: z.string(),
      status: z.string(),
      web_url: z.string(),
    })
    .nullable(),
})

interface DirectoryDeps {
  readonly token: (host: string) => string | null
  readonly now?: () => number
  readonly request?: typeof fetch
}

interface AccountClient {
  readonly fingerprint: string
  readonly client: GitLabClient
  user: Promise<GitLabResult<z.infer<typeof User>>> | null
  userFailure: GitLabFailure | null
}

interface Requests {
  rows: Omit<MrRow, 'elsewhere'>[]
  complete: boolean
  username: string
}
type Failure = Extract<GitLabResult<never>, { readonly ok: false }>

export class GitLabDirectory implements GitProviderPort {
  private readonly clients = new Map<string, AccountClient>()
  private readonly waiting: (() => void)[] = []
  private activeDetails = 0
  private readonly now: () => number
  private readonly request: typeof fetch

  constructor(private readonly deps: DirectoryDeps) {
    this.now = deps.now ?? Date.now
    this.request = deps.request ?? fetch
  }

  handles(host: string): boolean {
    return host === 'gitlab.com'
  }

  connected(host: string): boolean {
    return this.clientOf(host) !== null
  }

  async requestOf(
    cwd: string,
    iid: number
  ): Promise<{ fork: boolean; sourceBranch: string } | null> {
    const origin = await readRemoteUrl({ cwd, remote: 'origin' })
    if (!origin.ok) return null
    const location = parseRemoteUrl(origin.value)
    if (location === null) return null
    const account = this.clientOf(location.host)
    if (account === null) return null
    const detail = await this.detail(location, account, encodeURIComponent(location.path), iid)
    if (!detail.ok || this.changed(location.host, account) !== null) return null
    return {
      fork: detail.value.source_project_id !== detail.value.target_project_id,
      sourceBranch: detail.value.source_branch,
    }
  }

  invalidate(location: RemoteLocation): void {
    const account = this.clientOf(location.host)
    if (account === null) return
    account.client.invalidate(encodeURIComponent(location.path))
    if (account.userFailure !== null) {
      account.user = null
      account.userFailure = null
    }
  }

  async requests(location: RemoteLocation): Promise<GitLabResult<Requests>> {
    const account = this.clientOf(location.host)
    if (account === null) return { ok: false, failure: 'no-token', retryAt: null }
    const project = encodeURIComponent(location.path)
    const [user, listed] = await Promise.all([
      this.userOf(account),
      account.client.getAll(
        project,
        `/projects/${project}/merge_requests?state=opened&scope=all` +
          '&order_by=updated_at&sort=desc&with_labels_details=true',
        MrListItem,
        TTL_MS
      ),
    ])
    const changed = this.changed(location.host, account)
    if (changed !== null) return changed
    if (!user.ok) return user
    if (!listed.ok) return listed
    const visible = listed.value.items.slice(0, DETAIL_LIMIT)
    const pipelines = new Map<number, z.infer<typeof MrDetail>['head_pipeline']>()
    let fetchedAt = listed.fetchedAt
    for (let start = 0; start < visible.length; start += DETAIL_CONCURRENCY) {
      const details = await Promise.all(
        visible
          .slice(start, start + DETAIL_CONCURRENCY)
          .map((item) => this.detail(location, account, project, item.iid))
      )
      const switched = this.changed(location.host, account)
      if (switched !== null) return switched
      let failed = false
      for (const detail of details) {
        if (!detail.ok) {
          failed = true
          continue
        }
        pipelines.set(detail.value.iid, detail.value.head_pipeline)
        fetchedAt = Math.min(fetchedAt, detail.fetchedAt)
      }
      if (failed) break
    }
    const username = user.value.username
    const rows: Omit<MrRow, 'elsewhere'>[] = listed.value.items.map((item) => {
      const pipeline = pipelines.get(item.iid)
      return {
        iid: item.iid,
        title: item.title,
        webUrl: item.web_url,
        draft: item.draft,
        labels: item.labels.map((label) => ({
          name: label.name,
          color:
            label.color !== undefined && /^#[0-9a-fA-F]{3,8}$/.test(label.color)
              ? label.color
              : null,
          textColor:
            label.text_color !== undefined && /^#[0-9a-fA-F]{3,8}$/.test(label.text_color)
              ? label.text_color
              : null,
        })),
        author: item.author,
        sourceBranch: item.source_branch,
        targetBranch: item.target_branch,
        sha: item.sha ?? '',
        fork: item.source_project_id !== item.target_project_id,
        updatedAt: Date.parse(item.updated_at),
        notes: item.user_notes_count,
        unresolved: !item.blocking_discussions_resolved,
        mine: item.author.username === username,
        reviewRequested: item.reviewers.some((reviewer) => reviewer.username === username),
        pipeline:
          pipeline === undefined || pipeline === null
            ? null
            : {
                id: pipeline.id,
                projectId: pipeline.project_id,
                status: pipeline.status,
                webUrl: pipeline.web_url,
              },
      }
    })
    return {
      ok: true,
      value: { rows, complete: listed.value.complete, username },
      fetchedAt,
    }
  }

  private clientOf(host: string): AccountClient | null {
    if (!this.handles(host)) return null
    const token = this.deps.token(host)
    if (token === null || token.length === 0) {
      this.clients.delete(host)
      return null
    }
    const identity = fingerprint(token)
    const previous = this.clients.get(host)
    if (previous?.fingerprint === identity) return previous
    const account: AccountClient = {
      fingerprint: identity,
      client: new GitLabClient(host, token, this.now, this.request),
      user: null,
      userFailure: null,
    }
    this.clients.set(host, account)
    return account
  }

  private changed(host: string, account: AccountClient): Failure | null {
    const current = this.clientOf(host)
    if (current === account) return null
    return { ok: false, failure: current === null ? 'no-token' : 'unauthorized', retryAt: null }
  }

  private userOf(account: AccountClient): Promise<GitLabResult<z.infer<typeof User>>> {
    account.user ??= account.client.get('', '/user', User, Infinity).then((result) => {
      account.userFailure = result.ok ? null : result.failure
      return result
    })
    return account.user
  }

  private async detail(
    location: RemoteLocation,
    account: AccountClient,
    project: string,
    iid: number
  ): Promise<GitLabResult<z.infer<typeof MrDetail>>> {
    if (this.activeDetails >= DETAIL_CONCURRENCY) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve)
      })
    } else {
      this.activeDetails += 1
    }
    try {
      const changed = this.changed(location.host, account)
      if (changed !== null) return changed
      const result = await account.client.get(
        project,
        `/projects/${project}/merge_requests/${String(iid)}`,
        MrDetail,
        TTL_MS
      )
      return this.changed(location.host, account) ?? result
    } finally {
      const next = this.waiting.shift()
      if (next === undefined) this.activeDetails -= 1
      else next()
    }
  }
}
