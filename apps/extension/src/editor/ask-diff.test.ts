import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AskDiffController } from './ask-diff.js'

const native = vi.hoisted(() => ({ execute: vi.fn(), close: vi.fn() }))
vi.mock('vscode', () => ({
  Uri: {
    from: (parts: { scheme: string; authority: string; path: string }) => ({
      toString: () => `${parts.scheme}://${parts.authority}${parts.path}`,
    }),
  },
  EventEmitter: class {
    readonly event = vi.fn()
    readonly fire = vi.fn()
    readonly dispose = vi.fn()
  },
  TabInputText: class {
    readonly uri = null
  },
  TabInputTextDiff: class {
    readonly original = null
    readonly modified = null
  },
  commands: { executeCommand: native.execute },
  workspace: { registerTextDocumentContentProvider: () => ({ dispose: vi.fn() }) },
  window: { tabGroups: { all: [], close: native.close }, showTextDocument: vi.fn() },
}))

beforeEach(() => {
  native.execute.mockReset().mockResolvedValue(undefined)
  native.close.mockReset().mockResolvedValue(true)
})
const place = { host: '', root: '/alpha' }
const request = {
  requestId: 'request',
  approvalId: 'approval',
  path: 'file.ts',
  before: 'old',
  proposed: 'new',
}
const fixture = (focused: () => boolean) =>
  new AskDiffController({
    focused,
    available: () => true,
    resource: () => null,
    column: () => 1,
    failed: 'failed',
    log: vi.fn(),
  })

describe('native approval diff lifecycle', () => {
  it('holds background diffs and opens them only when their project gains focus', async () => {
    let focused = false
    const controller = fixture(() => focused)
    expect(await controller.request(place, request)).toMatchObject({ ok: true })
    expect(native.execute).not.toHaveBeenCalled()
    focused = true
    controller.focusChanged()
    await vi.waitFor(() => {
      expect(native.execute).toHaveBeenCalledOnce()
    })
    expect(native.execute).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      '[claude] file.ts',
      { viewColumn: 1, preserveFocus: true, preview: true }
    )
    controller.dispose()
  })

  it('does not resurrect a diff when a slow preview arrives after approval settlement', async () => {
    const controller = fixture(() => true)
    await controller.request(place, { ...request, close: true })
    expect(await controller.request(place, request)).toMatchObject({ ok: true })
    expect(native.execute).not.toHaveBeenCalled()
    controller.dispose()
  })
})
