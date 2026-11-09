import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { GitLabClient, GitLabDirectory, hunksOf } from './gitlab-client.js'
import type { MrDiffItem } from './gitlab-client.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {
    throw new Error('Promise resolver is unavailable')
  }
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

const Value = z.object({ value: z.number() })
const location = { host: 'gitlab.com', path: 'group/project' }
const version = {
  id: 9,
  headSha: 'b'.repeat(40),
  baseSha: 'a'.repeat(40),
  startSha: 'c'.repeat(40),
}

function diffItem(overrides: Partial<MrDiffItem> = {}): MrDiffItem {
  return {
    old_path: 'src/file.ts',
    new_path: 'src/file.ts',
    a_mode: '100644',
    b_mode: '100644',
    diff: '@@ -1,2 +1,2 @@\n before\n-old\n+new\n',
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    ...overrides,
  }
}

function reviewRequest(
  overrides: {
    versions?: unknown
    document?: unknown
    discussions?: unknown
    approvals?: unknown
  } = {}
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockImplementation((url) => {
    const address = urlOf(url)
    let value: unknown
    if (address.endsWith('/user')) {
      value = { username: 'me' }
    } else if (address.includes('/versions?')) {
      value = overrides.versions ?? [{ id: version.id }]
    } else if (address.endsWith(`/versions/${String(version.id)}`)) {
      value = overrides.document ?? {
        id: version.id,
        head_commit_sha: version.headSha,
        base_commit_sha: version.baseSha,
        start_commit_sha: version.startSha,
        state: 'collected',
        real_size: '1',
        diffs: [diffItem()],
      }
    } else if (address.includes('/discussions?')) {
      value = overrides.discussions ?? []
    } else if (address.endsWith('/approvals')) {
      value = overrides.approvals ?? {
        approved: true,
        approvals_required: 1,
        approvals_left: 0,
        approved_by: [{ user: { username: 'me', name: 'Reviewer Name' } }],
        user_can_approve: false,
      }
    } else if (address.endsWith('/merge_requests/7')) {
      value = {
        iid: 7,
        title: 'A recorded review',
        web_url: 'https://gitlab.com/group/project/-/merge_requests/7',
        draft: false,
        sha: 'd'.repeat(40),
        source_branch: 'feature/review',
        target_branch: 'main',
        source_project_id: 10,
        target_project_id: 10,
        updated_at: '2026-11-09T10:00:00Z',
        user_notes_count: 4,
        blocking_discussions_resolved: false,
        author: { username: 'teammate', name: 'Teammate' },
        reviewers: [{ username: 'me', name: 'Reviewer' }],
        labels: [{ name: 'In Review', color: '#123456', text_color: '#fff' }],
        description: null,
        diff_refs: null,
        head_pipeline: {
          id: 501,
          project_id: 99,
          sha: 'e'.repeat(40),
          status: 'success',
          web_url: 'https://gitlab.com/another/project/-/pipelines/501',
        },
      }
    } else {
      throw new Error(`Unexpected recorded request: ${address}`)
    }
    return Promise.resolve(new Response(JSON.stringify(value)))
  })
}

describe('GitLabClient cache boundaries', () => {
  it('coalesces concurrent reads and reuses a successful cached response', async () => {
    const response = deferred<Response>()
    const request = vi.fn<typeof fetch>().mockReturnValue(response.promise)
    const client = new GitLabClient('gitlab.com', 'fictional-token', () => 1_000, request)
    const first = client.get('project', '/projects/project/merge_requests', Value, 60_000)
    const second = client.get('project', '/projects/project/merge_requests', Value, 60_000)
    expect(request).toHaveBeenCalledTimes(1)

    response.resolve(new Response(JSON.stringify({ value: 1 })))
    await expect(first).resolves.toMatchObject({ ok: true, value: { value: 1 } })
    await expect(second).resolves.toMatchObject({ ok: true, value: { value: 1 } })
    await expect(
      client.get('project', '/projects/project/merge_requests', Value, 60_000)
    ).resolves.toMatchObject({ ok: true, value: { value: 1 } })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ 'PRIVATE-TOKEN': 'fictional-token' })
  })

  it('does not join or cache an older read after invalidation', async () => {
    const oldResponse = deferred<Response>()
    const newResponse = deferred<Response>()
    const request = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise)
    const client = new GitLabClient('gitlab.com', 'fictional-token', () => 1_000, request)
    const path = '/projects/project/merge_requests'
    const oldRead = client.get('project', path, Value, 60_000)
    client.invalidate('project')
    const newRead = client.get('project', path, Value, 60_000)

    expect(request).toHaveBeenCalledTimes(2)
    oldResponse.resolve(new Response(JSON.stringify({ value: 1 })))
    await oldRead
    const joinedRead = client.get('project', path, Value, 60_000)
    expect(request).toHaveBeenCalledTimes(2)
    newResponse.resolve(new Response(JSON.stringify({ value: 2 })))
    await expect(newRead).resolves.toMatchObject({ ok: true, value: { value: 2 } })
    await expect(joinedRead).resolves.toMatchObject({ ok: true, value: { value: 2 } })
    await expect(client.get('project', path, Value, 60_000)).resolves.toMatchObject({
      ok: true,
      value: { value: 2 },
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps uncached reads separate from cached and in-flight reads', async () => {
    const stale = deferred<Response>()
    const request = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: 2 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: 3 })))
    const client = new GitLabClient('gitlab.com', 'fictional-token', () => 1_000, request)
    const path = '/projects/p/merge_requests/7/versions'
    const cached = client.get('p', path, Value, 60_000)
    await expect(client.getUncached(path, Value)).resolves.toMatchObject({
      ok: true,
      value: { value: 2 },
    })
    stale.resolve(new Response(JSON.stringify({ value: 1 })))
    await cached
    await expect(client.getUncached(path, Value)).resolves.toMatchObject({
      ok: true,
      value: { value: 3 },
    })
    await expect(client.get('p', path, Value, 60_000)).resolves.toMatchObject({
      ok: true,
      value: { value: 1 },
    })
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('keeps the longest cooldown shared across project requests', async () => {
    const longResponse = deferred<Response>()
    const shortResponse = deferred<Response>()
    const request = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(longResponse.promise)
      .mockReturnValueOnce(shortResponse.promise)
    const client = new GitLabClient('gitlab.com', 'fictional-token', () => 1_000, request)
    const first = client.get('one', '/projects/one/merge_requests', Value, 0)
    const second = client.get('two', '/projects/two/merge_requests', Value, 0)
    longResponse.resolve(new Response(null, { status: 429, headers: { 'Retry-After': '120' } }))
    await first
    shortResponse.resolve(new Response(null, { status: 429, headers: { 'Retry-After': '5' } }))
    await second

    await expect(client.get('three', '/projects/three/merge_requests', Value, 0)).resolves.toEqual({
      ok: false,
      failure: 'rate-limited',
      retryAt: 121_000,
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('uses a minute for non-numeric Retry-After and handles invalid JSON', async () => {
    let now = 1_000
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { 'Retry-After': 'later' } })
      )
      .mockResolvedValueOnce(new Response('not-json'))
    const client = new GitLabClient('gitlab.com', 'fictional-token', () => now, request)
    await expect(client.get('p', '/projects/p/merge_requests', Value, 0)).resolves.toEqual({
      ok: false,
      failure: 'rate-limited',
      retryAt: 61_000,
    })
    now = 61_001
    await expect(client.get('p', '/projects/p/merge_requests', Value, 0)).resolves.toEqual({
      ok: false,
      failure: 'invalid-response',
      retryAt: null,
    })
  })

  it('reports an incomplete result when pagination reaches its bound', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => i))))
    const client = new GitLabClient('gitlab.com', 'fictional-token', () => 1_000, request)
    const result = await client.getAll('p', '/projects/p/merge_requests', z.number(), 60_000, 1)
    expect(result).toMatchObject({ ok: true, value: { complete: false } })
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('GitLabDirectory credentials', () => {
  it('does not return an old account response after the token is cleared', async () => {
    const listed = deferred<Response>()
    const request = vi.fn<typeof fetch>().mockImplementation((url) => {
      if (urlOf(url).endsWith('/user')) {
        return Promise.resolve(new Response(JSON.stringify({ username: 'first' })))
      }
      return listed.promise
    })
    let token: string | null = 'fictional-first-token'
    const directory = new GitLabDirectory({ token: () => token, now: () => 1_000, request })
    const reading = directory.requests(location)
    token = null
    listed.resolve(new Response('[]'))
    await expect(reading).resolves.toEqual({ ok: false, failure: 'no-token', retryAt: null })
    await expect(directory.requests(location)).resolves.toEqual({
      ok: false,
      failure: 'no-token',
      retryAt: null,
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('uses a new account client after a token change', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((url, options) => {
      const headers = options?.headers as Record<string, string>
      const username = headers['PRIVATE-TOKEN'] === 'fictional-first-token' ? 'first' : 'second'
      const value = urlOf(url).endsWith('/user') ? { username } : []
      return Promise.resolve(new Response(JSON.stringify(value)))
    })
    let token = 'fictional-first-token'
    const directory = new GitLabDirectory({ token: () => token, now: () => 1_000, request })
    await expect(directory.requests(location)).resolves.toMatchObject({
      ok: true,
      value: { username: 'first' },
    })
    token = 'fictional-second-token'
    await expect(directory.requests(location)).resolves.toMatchObject({
      ok: true,
      value: { username: 'second' },
    })
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('keeps every MR when a detail is missing and stops after that batch', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      iid: index + 1,
      title: `Request ${String(index + 1)}`,
      web_url: `https://gitlab.com/group/project/-/merge_requests/${String(index + 1)}`,
      draft: false,
      sha: 'a'.repeat(40),
      source_branch: `feature/${String(index + 1)}`,
      target_branch: 'main',
      source_project_id: 10,
      target_project_id: 10,
      updated_at: '2026-11-08T10:00:00Z',
      user_notes_count: 0,
      blocking_discussions_resolved: true,
      author: { username: 'me', name: 'Author' },
      reviewers: [],
      labels: [],
    }))
    const detailReads: number[] = []
    const request = vi.fn<typeof fetch>().mockImplementation((url) => {
      const address = urlOf(url)
      if (address.endsWith('/user')) {
        return Promise.resolve(new Response(JSON.stringify({ username: 'me' })))
      }
      if (address.includes('merge_requests?')) {
        return Promise.resolve(new Response(JSON.stringify(items)))
      }
      const iid = Number(address.split('/').at(-1))
      detailReads.push(iid)
      if (iid === 2) return Promise.resolve(new Response(null, { status: 404 }))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...items.find((item) => item.iid === iid),
            labels: ['In Review'],
            description: null,
            diff_refs: null,
            head_pipeline: {
              id: 500 + iid,
              project_id: 10,
              sha: 'a'.repeat(40),
              status: 'success',
              web_url: `https://gitlab.com/group/project/-/pipelines/${String(500 + iid)}`,
            },
          })
        )
      )
    })
    const directory = new GitLabDirectory({
      token: () => 'fictional-token',
      now: () => 1_000,
      request,
    })
    const result = await directory.requests(location)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('The MR list should remain available')
    expect(result.value.rows.map((row) => row.iid)).toEqual([1, 2, 3, 4, 5, 6])
    expect(result.value.rows.find((row) => row.iid === 2)?.pipeline).toBeNull()
    expect(result.value.rows.find((row) => row.iid === 3)?.pipeline?.id).toBe(503)
    expect(result.value.rows.find((row) => row.iid === 5)?.pipeline).toBeNull()
    expect(detailReads).toEqual([1, 2, 3, 4])
  })

  it('shares list and detail reads between clones and keeps the MR pipeline project', async () => {
    const items = Array.from({ length: 45 }, (_, index) => ({
      iid: index + 1,
      title: `Request ${String(index + 1)}`,
      web_url: `https://gitlab.com/group/project/-/merge_requests/${String(index + 1)}`,
      draft: false,
      sha: 'a'.repeat(40),
      source_branch: `feature/${String(index + 1)}`,
      target_branch: 'main',
      source_project_id: index === 1 ? 12 : 10,
      target_project_id: 10,
      updated_at: '2026-11-08T10:00:00Z',
      user_notes_count: 2,
      blocking_discussions_resolved: false,
      author: { username: index === 0 ? 'me' : 'teammate', name: 'Author' },
      reviewers: index === 1 ? [{ username: 'me', name: 'Reviewer' }] : [],
      labels: [
        { name: 'In Review', color: '#1F75Cb', text_color: '#fff' },
        { name: 'Uncoloured' },
        { name: 'Odd colours', color: 'orange', text_color: 'url(https://example.com)' },
      ],
    }))
    let active = 0
    let peak = 0
    let detailReads = 0
    let listReads = 0
    let userReads = 0
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const address = urlOf(url)
      if (address.endsWith('/user')) {
        userReads += 1
        return new Response(JSON.stringify({ username: 'me' }))
      }
      if (address.includes('merge_requests?')) {
        listReads += 1
        expect(address).toContain('with_labels_details=true')
        return new Response(JSON.stringify(items))
      }
      const iid = Number(address.split('/').at(-1))
      const item = items.find((row) => row.iid === iid)
      active += 1
      peak = Math.max(peak, active)
      detailReads += 1
      await Promise.resolve()
      active -= 1
      return new Response(
        JSON.stringify({
          ...item,
          labels: ['In Review'],
          description: null,
          diff_refs: null,
          head_pipeline: {
            id: 500 + iid,
            project_id: 99,
            sha: 'b'.repeat(40),
            status: 'success',
            web_url: `https://gitlab.com/another/project/-/pipelines/${String(500 + iid)}`,
          },
        })
      )
    })
    const directory = new GitLabDirectory({
      token: () => 'fictional-token',
      now: () => 1_000,
      request,
    })
    const [first, second] = await Promise.all([
      directory.requests(location),
      directory.requests({ ...location }),
    ])
    expect(first).toMatchObject({
      ok: true,
      value: {
        complete: true,
        username: 'me',
        rows: expect.arrayContaining([
          expect.objectContaining({
            iid: 1,
            mine: true,
            labels: [
              { name: 'In Review', color: '#1F75Cb', textColor: '#fff' },
              { name: 'Uncoloured', color: null, textColor: null },
              { name: 'Odd colours', color: null, textColor: null },
            ],
          }),
          expect.objectContaining({
            iid: 2,
            fork: true,
            reviewRequested: true,
            pipeline: expect.objectContaining({ projectId: 99 }),
          }),
          expect.objectContaining({ iid: 45, pipeline: null }),
        ]),
      },
    })
    expect(second).toEqual(first)
    expect(userReads).toBe(1)
    expect(listReads).toBe(1)
    expect(detailReads).toBe(40)
    expect(peak).toBeLessThanOrEqual(4)
  })
})

describe('GitLab review files', () => {
  it('parses placeholder headers and keeps real paths containing a diff separator', () => {
    const file = diffItem({ old_path: 'old b/name.ts', new_path: 'new b/name.ts' })
    expect(hunksOf(file)).toMatchObject({
      path: 'new b/name.ts',
      oldPath: 'old b/name.ts',
      added: 1,
      removed: 1,
      hunks: [
        {
          lines: [
            { kind: 'context', before: 1, after: 1 },
            { kind: 'removed', before: 2 },
            { kind: 'added', after: 2 },
          ],
        },
      ],
    })
  })
})

describe('GitLabDirectory review snapshots', () => {
  it('finds the highest version across every page and never caches the newest-version read', async () => {
    let newest = 900
    const request = vi.fn<typeof fetch>().mockImplementation((url) => {
      const address = urlOf(url)
      const items = address.endsWith('page=1')
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
        : [{ id: newest }]
      return Promise.resolve(new Response(JSON.stringify(items)))
    })
    const directory = new GitLabDirectory({ token: () => 'fictional-token', request })
    await expect(directory.latestVersion(location, 7)).resolves.toMatchObject({
      ok: true,
      value: 900,
    })
    newest = 950
    await expect(directory.latestVersion(location, 7)).resolves.toMatchObject({
      ok: true,
      value: 950,
    })
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('refuses to claim the newest version when the page bound is reached', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })))
          )
        )
      )
    const directory = new GitLabDirectory({ token: () => 'fictional-token', request })
    await expect(directory.latestVersion(location, 7)).resolves.toEqual({
      ok: false,
      failure: 'invalid-response',
      retryAt: null,
    })
    expect(request).toHaveBeenCalledTimes(20)
  })

  it('holds the version document and counts each matching non-system diff discussion once', async () => {
    const position = {
      head_sha: version.headSha,
      base_sha: version.baseSha,
      start_sha: version.startSha,
      old_path: 'src/file.ts',
      new_path: 'src/file.ts',
    }
    const note = { system: false, type: 'DiffNote', position }
    const request = reviewRequest({
      versions: [{ id: 3 }, { id: 9 }, { id: 5 }],
      discussions: [
        { id: 'current', notes: [note, note] },
        {
          id: 'old-head',
          notes: [{ ...note, position: { ...position, head_sha: 'd'.repeat(40) } }],
        },
        {
          id: 'old-base',
          notes: [{ ...note, position: { ...position, base_sha: 'd'.repeat(40) } }],
        },
        {
          id: 'old-start',
          notes: [{ ...note, position: { ...position, start_sha: 'd'.repeat(40) } }],
        },
        { id: 'system', notes: [{ ...note, system: true }] },
        { id: 'ordinary', notes: [{ ...note, type: 'DiscussionNote' }] },
        {
          id: 'other-path',
          notes: [{ ...note, position: { ...position, new_path: 'other.ts' } }],
        },
      ],
    })
    const directory = new GitLabDirectory({ token: () => 'fictional-token', request })
    await expect(directory.review(location, 7)).resolves.toMatchObject({
      ok: true,
      value: {
        kind: 'ready',
        snapshot: {
          mr: {
            iid: 7,
            description: '',
            labels: [{ name: 'In Review', color: '#123456', textColor: '#fff' }],
            fork: false,
          },
          version,
          pipeline: { id: 501, projectId: 99, status: 'success' },
          approvals: {
            approved: true,
            approvalsRequired: 1,
            approvalsLeft: 0,
            approvers: ['Reviewer Name'],
            userHasApproved: true,
            userCanApprove: false,
          },
          files: [
            {
              raw: diffItem(),
              summary: {
                path: 'src/file.ts',
                status: 'modified',
                added: 1,
                removed: 1,
                threads: 1,
              },
            },
          ],
          complete: true,
        },
      },
    })
    expect(request.mock.calls.filter(([url]) => urlOf(url).endsWith('/versions/9'))).toHaveLength(1)
    expect(request.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true)
  })

  it.each([401, 403, 404])('retains review files when approvals return %i', async (status) => {
    const fallback = reviewRequest()
    const request = vi.fn<typeof fetch>().mockImplementation((url, options) => {
      if (urlOf(url).endsWith('/approvals')) {
        return Promise.resolve(new Response(null, { status }))
      }
      return fallback(url, options)
    })
    const directory = new GitLabDirectory({ token: () => 'fictional-token', request })
    await expect(directory.review(location, 7)).resolves.toMatchObject({
      ok: true,
      value: {
        kind: 'ready',
        snapshot: {
          approvals: null,
          files: [{ summary: { path: 'src/file.ts', added: 1, removed: 1 } }],
        },
      },
    })
  })

  it('retains review files when the approvals response is invalid', async () => {
    const directory = new GitLabDirectory({
      token: () => 'fictional-token',
      request: reviewRequest({ approvals: {} }),
    })
    await expect(directory.review(location, 7)).resolves.toMatchObject({
      ok: true,
      value: {
        kind: 'ready',
        snapshot: { approvals: null, files: [{ summary: { path: 'src/file.ts' } }] },
      },
    })
  })

  it.each(['network', 'rate-limited'] as const)(
    'keeps an approvals %s failure as a review failure',
    async (failure) => {
      const fallback = reviewRequest()
      const request = vi.fn<typeof fetch>().mockImplementation((url, options) => {
        if (urlOf(url).endsWith('/approvals')) {
          return failure === 'network'
            ? Promise.reject(new Error('Recorded network failure'))
            : Promise.resolve(new Response(null, { status: 429, headers: { 'Retry-After': '60' } }))
        }
        return fallback(url, options)
      })
      const directory = new GitLabDirectory({
        token: () => 'fictional-token',
        now: () => 1_000,
        request,
      })
      await expect(directory.review(location, 7)).resolves.toEqual({
        ok: false,
        failure,
        retryAt: failure === 'rate-limited' ? 61_000 : null,
      })
    }
  )

  it('discards a review when the token changes during an unavailable approvals read', async () => {
    const fallback = reviewRequest()
    const pending = deferred<Response>()
    const started = deferred<undefined>()
    const request = vi.fn<typeof fetch>().mockImplementation((url, options) => {
      if (urlOf(url).endsWith('/approvals')) {
        started.resolve(undefined)
        return pending.promise
      }
      return fallback(url, options)
    })
    let token = 'fictional-first-token'
    const directory = new GitLabDirectory({ token: () => token, request })
    const reading = directory.review(location, 7)
    await started.promise
    token = 'fictional-second-token'
    pending.resolve(new Response(null, { status: 404 }))
    await expect(reading).resolves.toEqual({
      ok: false,
      failure: 'unauthorized',
      retryAt: null,
    })
  })

  it('shares snapshot and annotation reads between clones and repeated reviews', async () => {
    const request = reviewRequest()
    const directory = new GitLabDirectory({
      token: () => 'fictional-token',
      now: () => 1_000,
      request,
    })
    const [first, second] = await Promise.all([
      directory.review(location, 7),
      directory.review({ ...location }, 7),
    ])
    expect(first).toMatchObject({ ok: true, value: { kind: 'ready' } })
    expect(second).toEqual(first)
    await expect(directory.review(location, 7)).resolves.toEqual(first)
    expect(request.mock.calls.filter(([url]) => urlOf(url).includes('/versions?'))).toHaveLength(3)
    for (const suffix of [
      '/versions/9',
      '/merge_requests/7',
      '/discussions?per_page=100&page=1',
      '/approvals',
      '/user',
    ]) {
      expect(request.mock.calls.filter(([url]) => urlOf(url).endsWith(suffix))).toHaveLength(1)
    }
  })

  it('refreshes a collecting version without waiting for the cache TTL', async () => {
    const fallback = reviewRequest()
    let versionReads = 0
    const request = vi.fn<typeof fetch>().mockImplementation((url, options) => {
      if (urlOf(url).endsWith('/versions/9')) {
        versionReads += 1
        if (versionReads === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: version.id,
                head_commit_sha: version.headSha,
                base_commit_sha: version.baseSha,
                start_commit_sha: version.startSha,
                state: 'collecting',
                real_size: '0',
                diffs: [],
              })
            )
          )
        }
      }
      return fallback(url, options)
    })
    const directory = new GitLabDirectory({ token: () => 'fictional-token', request })
    await expect(directory.review(location, 7)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'preparing' },
    })
    await expect(directory.review(location, 7)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'ready', snapshot: { complete: true } },
    })
    expect(versionReads).toBe(2)
  })

  it('retries a failed user read on review refresh and retains the successful user', async () => {
    const fallback = reviewRequest()
    let userReads = 0
    const request = vi.fn<typeof fetch>().mockImplementation((url, options) => {
      if (urlOf(url).endsWith('/user')) {
        userReads += 1
        if (userReads === 1) return Promise.reject(new Error('Recorded transient failure'))
      }
      return fallback(url, options)
    })
    const directory = new GitLabDirectory({ token: () => 'fictional-token', request })
    await expect(directory.review(location, 7)).resolves.toEqual({
      ok: false,
      failure: 'network',
      retryAt: null,
    })
    await expect(directory.review(location, 7)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'ready' },
    })
    await expect(directory.review(location, 7)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'ready' },
    })
    expect(userReads).toBe(2)
  })

  it('answers preparing before requesting annotations when there is no version', async () => {
    const request = reviewRequest({ versions: [] })
    const directory = new GitLabDirectory({ token: () => 'fictional-token', request })
    await expect(directory.review(location, 7)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'preparing' },
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    { state: 'overflow' },
    { overflow: true },
    { real_size: '2' },
    { diffs: [diffItem({ collapsed: true })] },
    { diffs: [diffItem({ too_large: true })] },
  ])('keeps an incomplete diff from claiming a complete snapshot: %o', async (overrides) => {
    const request = reviewRequest({
      document: {
        id: version.id,
        head_commit_sha: version.headSha,
        base_commit_sha: version.baseSha,
        start_commit_sha: version.startSha,
        state: 'collected',
        real_size: '1',
        diffs: [diffItem()],
        ...overrides,
      },
    })
    const directory = new GitLabDirectory({ token: () => 'fictional-token', request })
    await expect(directory.review(location, 7)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'ready', snapshot: { complete: false } },
    })
  })

  it('keeps a bounded discussion list from claiming a complete snapshot', async () => {
    const request = reviewRequest({
      discussions: Array.from({ length: 100 }, (_, index) => ({
        id: String(index),
        notes: [],
      })),
    })
    const directory = new GitLabDirectory({ token: () => 'fictional-token', request })
    await expect(directory.review(location, 7)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'ready', snapshot: { complete: false } },
    })
    expect(request.mock.calls.filter(([url]) => urlOf(url).includes('/discussions?'))).toHaveLength(
      20
    )
  })

  it('discards a version read after an account switch and exposes the current identity', async () => {
    const pending = deferred<Response>()
    const request = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    let token: string | null = 'fictional-first-token'
    const directory = new GitLabDirectory({ token: () => token, request })
    const first = directory.identity('gitlab.com')
    const reading = directory.latestVersion(location, 7)
    token = 'fictional-second-token'
    expect(directory.identity('gitlab.com')).not.toBe(first)
    pending.resolve(new Response(JSON.stringify([{ id: 9 }])))
    await expect(reading).resolves.toEqual({
      ok: false,
      failure: 'unauthorized',
      retryAt: null,
    })
    token = null
    expect(directory.identity('gitlab.com')).toBeNull()
  })
})
