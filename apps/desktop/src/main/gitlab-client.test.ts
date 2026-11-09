import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { GitLabClient, GitLabDirectory } from './gitlab-client.js'

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
