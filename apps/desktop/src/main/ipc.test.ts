import { describe, expect, it, vi } from 'vitest'
import type { ChorusRuntime } from './runtime.js'

const showOpenDialog = vi.fn()
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp/chorus-test' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
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
