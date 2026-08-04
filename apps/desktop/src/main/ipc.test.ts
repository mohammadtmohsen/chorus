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
