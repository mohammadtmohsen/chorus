import { describe, expect, it, vi } from 'vitest'
import type { ChorusRuntime } from './runtime.js'

const showOpenDialog = vi.fn()
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp/chorus-test' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  // `settings:write` applies the appearance as it writes, because
  // `themeSource` is what `prefers-color-scheme` answers from. A plain object
  // is enough: the assignment is the whole behaviour.
  nativeTheme: { themeSource: 'system' },
}))

const { buildHandlers } = await import('./ipc.js')

function runtimeWith(cwd: string, title = 'before') {
  const setProjectDirectory = vi.fn((_id: string, next: string) => ({
    cwd: next,
    // The runtime renames an untouched conversation with the folder it moved to.
    title: next.split('/').pop() ?? next,
  }))
  const runtime = {
    projectDirectory: () => cwd,
    conversationTitle: () => title,
    setProjectDirectory,
  } as unknown as ChorusRuntime
  return { runtime, setProjectDirectory }
}

/** The handler map is keyed by channel; this is how a request reaches one. */
const choose = async (runtime: ChorusRuntime) =>
  (await (buildHandlers(runtime)['conversation:chooseCwd'] as (r: unknown) => Promise<unknown>)({
    conversationId: 'c1',
  })) as { cwd: string; changed: boolean }

/**
 * Which paths a transcript row may open, decided in main.
 *
 * The path comes off agent output by way of the renderer, and is about to be
 * handed to `code -g`. `isInside` is segment-wise on purpose — `/p/a-old` is not
 * inside `/p/a` — and these are the cases that would otherwise be found by a
 * user opening someone else's file.
 */
describe('ide:openFile', () => {
  const open = async (cwd: string, path: string) => {
    const runtime = { projectDirectory: () => cwd } as unknown as ChorusRuntime
    return (await (buildHandlers(runtime)['ide:openFile'] as (r: unknown) => Promise<unknown>)({
      conversationId: 'c1',
      path,
    })) as { ok: boolean; reason: string | null }
  }

  /*
   * `toMatchObject`, not `toEqual`: the refusal now carries the path it refused
   * and the folder it measured against, so the message can name them. What these
   * guard is the *reason*, which is unchanged.
   */
  it('refuses a path outside the project', async () => {
    expect(await open('/p/a', '/p/b/secret.ts')).toMatchObject({
      ok: false,
      reason: 'outside-project',
    })
  })

  it('refuses a sibling whose name merely starts the same', async () => {
    expect(await open('/p/a', '/p/a-old/rate.ts')).toMatchObject({
      ok: false,
      reason: 'outside-project',
    })
  })

  it('refuses an escape through ..', async () => {
    expect(await open('/p/a', '../b/secret.ts')).toMatchObject({
      ok: false,
      reason: 'outside-project',
    })
  })

  it('refuses everything when the conversation has no project folder', async () => {
    expect(await open('', '/p/a/rate.ts')).toMatchObject({ ok: false, reason: 'outside-project' })
  })

  it('refuses when the conversation is no longer open', async () => {
    const runtime = {
      projectDirectory: () => {
        throw new Error('Conversation "c1" is not active')
      },
    } as unknown as ChorusRuntime
    const result = await (
      buildHandlers(runtime)['ide:openFile'] as (r: unknown) => Promise<unknown>
    )({ conversationId: 'c1', path: '/p/a/rate.ts' })
    expect(result).toMatchObject({ ok: false, reason: 'outside-project' })
  })

  /*
   * **Only refusals are asserted here, deliberately.** A contained path reaches
   * `code -g` for real — there is no seam between this handler and
   * `extensionDeps()` — so a "lets it through" test spawns VS Code on whoever
   * runs `pnpm check`. It did, twice, before this comment replaced it.
   *
   * Nothing is lost that matters. The refusals are the half with teeth, the
   * segment-wise comparison behind them has its own tests in
   * `ide-protocol/src/paths.test.ts`, and the positive path is what driving the
   * app checks.
   */
})

describe('conversation:chooseCwd', () => {
  it('applies the folder that was picked', () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/picked'] })
    const { runtime, setProjectDirectory } = runtimeWith('/tmp/before')

    return choose(runtime).then((result) => {
      // Through the runtime, so a picked path is validated and recorded exactly
      // as a typed one is.
      expect(setProjectDirectory).toHaveBeenCalledWith('c1', '/tmp/picked')
      // The title follows the folder's last piece, which is what names a project.
      expect(result).toEqual({ cwd: '/tmp/picked', title: 'picked', changed: true })
    })
  })

  it('changes nothing when the dialog is cancelled', async () => {
    // The case a driver cannot reach: a native modal cannot be dismissed by one.
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const { runtime, setProjectDirectory } = runtimeWith('/tmp/before')

    expect(await choose(runtime)).toEqual({ cwd: '/tmp/before', title: 'before', changed: false })
    expect(setProjectDirectory).not.toHaveBeenCalled()
  })

  it('treats an empty selection as a cancel', async () => {
    // `canceled: false` with no paths should not reach the runtime as undefined.
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] })
    const { runtime, setProjectDirectory } = runtimeWith('/tmp/before')

    expect(await choose(runtime)).toEqual({ cwd: '/tmp/before', title: 'before', changed: false })
    expect(setProjectDirectory).not.toHaveBeenCalled()
  })

  it('reports no change when the same folder is picked again', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/before'] })
    const { runtime } = runtimeWith('/tmp/before')

    expect(await choose(runtime)).toEqual({ cwd: '/tmp/before', title: 'before', changed: false })
  })

  it('opens the panel where the conversation already is', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const { runtime } = runtimeWith('/tmp/before')
    await choose(runtime)

    expect(showOpenDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        defaultPath: '/tmp/before',
        properties: ['openDirectory', 'createDirectory'],
      })
    )
  })
})

describe('settings:write and the per-agent maps', () => {
  const write = async (patch: unknown): Promise<{ models: Record<string, string> }> => {
    const handler = buildHandlers({} as unknown as ChorusRuntime)['settings:write'] as unknown as (
      r: unknown
    ) => Promise<{ models: Record<string, string> }>
    return handler(patch)
  }

  it('keeps the other agent’s model when only one is sent', async () => {
    /*
     * The shape of the bug: `{ ...current, ...request }` is shallow, so a patch
     * naming one agent replaces the whole map and clears the other's value —
     * with nothing on screen to show it had happened.
     */
    await write({ models: { claude: 'opus' } })
    await write({ models: { codex: 'gpt-5.6-sol' } })
    const after = await write({})
    expect(after.models).toEqual({ claude: 'opus', codex: 'gpt-5.6-sol' })
  })

  it('keeps the other agent’s effort too', async () => {
    await write({ efforts: { claude: 'high' } })
    const after = await write({ efforts: { codex: 'ultra' } })
    expect(after).toMatchObject({ efforts: { claude: 'high', codex: 'ultra' } })
  })
})

/**
 * The transcript read, and the one ordering that makes it correct.
 *
 * `throughSeq` is taken **before** the rows are read. That is not incidental: it
 * is the value the renderer advances `lastSeq` to, and it is what stops a
 * conversation whose newest events are all ignored types from re-querying the
 * same range on every push, forever.
 *
 * Taking it *after* the read would be the tempting simplification and is wrong
 * in the other direction — it would claim to have covered an event appended
 * during the read that the read did not return, and that event would then never
 * be fetched. Before-the-read can only ever under-claim, and under-claiming
 * costs one redundant query rather than a missing message.
 */
describe('conversation:transcript', () => {
  const EVENTS = [
    {
      seq: 1,
      id: 'e1',
      conversationId: 'c1',
      actor: 'claude',
      type: 'user.message',
      payload: {},
      createdAt: 1,
    },
    {
      seq: 2,
      id: 'e2',
      conversationId: 'c1',
      actor: 'claude',
      type: 'agent.message.completed',
      payload: {},
      createdAt: 2,
    },
  ]

  const EMPTY_STATE = { approvals: [], questions: [], working: [], usageByActor: {} }

  function runtimeFor(lastSeq: number) {
    const calls: {
      kind: 'history' | 'page'
      conversationId: string
      afterSeq?: number
      beforeSeq?: number
      limit?: number
      at: number
    }[] = []
    let position = lastSeq
    const runtime = {
      // Reading moves the log on, so a handler that asked for the position
      // afterwards would get a different — and wrong — answer.
      transcriptHistory: (conversationId: string, afterSeq?: number) => {
        calls.push({
          kind: 'history',
          conversationId,
          ...(afterSeq === undefined ? {} : { afterSeq }),
          at: position,
        })
        position += 5
        return EVENTS
      },
      transcriptPage: (conversationId: string, limit: number, beforeSeq?: number) => {
        calls.push({
          kind: 'page',
          conversationId,
          limit,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          at: position,
        })
        position += 5
        return EVENTS
      },
      transcriptState: () => EMPTY_STATE,
      logPosition: () => position,
    } as unknown as ChorusRuntime
    return { runtime, calls }
  }

  const read = async (runtime: ChorusRuntime, request: unknown) =>
    (await (buildHandlers(runtime)['conversation:transcript'] as (r: unknown) => Promise<unknown>)(
      request
    )) as { events: { seq: number }[]; throughSeq: number }

  it('reports the log position from before the read, not after', async () => {
    const { runtime } = runtimeFor(42)
    const result = await read(runtime, { conversationId: 'c1' })
    // 42, not 47: the read moved the log on and the mark predates it.
    expect(result.throughSeq).toBe(42)
  })

  it('returns the conversation the caller asked for', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c9', afterSeq: 3 })
    expect(calls).toEqual([{ kind: 'history', conversationId: 'c9', afterSeq: 3, at: 10 }])
  })

  it('omits afterSeq entirely on a first read rather than sending zero', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c1' })
    expect(calls[0]).not.toHaveProperty('afterSeq')
  })

  /*
   * Three questions on one channel, and they must not blur into each other.
   * `afterSeq` is "what has happened since"; `limit` is "the newest page";
   * neither is "the whole conversation", which is what no `limit` still means.
   */
  it('reads a page when asked for one, not the whole conversation', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c1', limit: 400 })
    expect(calls).toEqual([{ kind: 'page', conversationId: 'c1', limit: 400, at: 10 }])
  })

  it('walks backwards with beforeSeq', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c1', beforeSeq: 900, limit: 400 })
    expect(calls[0]).toMatchObject({ kind: 'page', beforeSeq: 900, limit: 400 })
  })

  it('sends state on a cold read, because a page cannot contain it', async () => {
    const { runtime } = runtimeFor(10)
    const result = (await read(runtime, { conversationId: 'c1', limit: 400 })) as unknown as {
      state?: unknown
    }
    expect(result.state).toEqual(EMPTY_STATE)
  })

  it('withholds state from a catch-up, which would overwrite live cards', async () => {
    /*
     * An incremental read is folded into a view that already holds the state,
     * and the queried snapshot is from a moment ago — re-applying it would put
     * back an approval the user has just decided.
     */
    const { runtime } = runtimeFor(10)
    const result = (await read(runtime, { conversationId: 'c1', afterSeq: 3 })) as unknown as {
      state?: unknown
    }
    expect(result.state).toBeUndefined()
  })

  it('flattens the rows the renderer draws', async () => {
    const { runtime } = runtimeFor(10)
    const result = await read(runtime, { conversationId: 'c1' })
    expect(result.events.map((e) => e.seq)).toEqual([1, 2])
  })
})
