import { describe, expect, it, vi } from 'vitest'
import type { Memento } from 'vscode'
import { BrowserHostCore, BROWSER_HOST_STORAGE_KEY } from './host.js'
import type { BrowserHostEvent } from './host.js'
import { FakeTab, FakeWindow } from './test/fixtures.js'

class MemoryState implements Memento {
  readonly values = new Map<string, unknown>()
  get<T = unknown>(key: string, fallback?: T): T | undefined
  get<T>(key: string, fallback: T): T
  get<T>(key: string, fallback?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : fallback
  }
  keys(): readonly string[] {
    return [...this.values.keys()]
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
    return Promise.resolve()
  }
}

function fixture(platform = new FakeWindow(), workspaceState = new MemoryState()) {
  let focused = 'project-a'
  const events: BrowserHostEvent[] = []
  const log = vi.fn()
  const host = new BrowserHostCore(
    {
      workspaceState,
      focusedProject: () => focused,
      emit: (event) => events.push(event),
      log,
    },
    platform,
    -2
  )
  return {
    host,
    platform,
    workspaceState,
    events,
    log,
    focus: (project: string) => {
      focused = project
    },
  }
}

describe('BrowserHostCore', () => {
  it('keeps the explicit opener when the open event precedes the open response', async () => {
    const f = fixture()
    await f.host.restore()
    f.focus('project-b')
    const opened = await f.host.open('project-a', 'https://project.test/', 'browser-id')
    expect(opened).toMatchObject({ tabId: 'browser-id', projectId: 'project-a' })
    expect(f.platform.options).toEqual([{ viewColumn: -2, preserveFocus: true }])
    f.focus('project-c')
    const tab = f.platform.browserTabs[0]!
    tab.title = 'New title'
    f.platform.changed.fire(tab)
    expect(f.events.at(-1)).toMatchObject({ state: { projectId: 'project-a' } })
    f.host.dispose()
  })

  it('assigns an external tab to the focus captured when it opens', async () => {
    const f = fixture()
    await f.host.restore()
    f.focus('project-a')
    f.platform.external(new FakeTab())
    f.focus('project-b')
    await vi.waitFor(() => {
      expect(f.events.some((event) => event.kind === 'state')).toBe(true)
    })
    expect(f.events.filter((event) => event.kind === 'state')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: expect.objectContaining({ projectId: 'project-a' }) }),
      ])
    )
    f.host.dispose()
  })

  it('restores the persisted owner and tab identity by native target across Reload Window', async () => {
    const first = fixture()
    await first.host.restore()
    const original = await first.host.open('project-a', 'https://project.test/', 'retained-id')
    await vi.waitFor(() => {
      expect(first.workspaceState.values.has(BROWSER_HOST_STORAGE_KEY)).toBe(true)
    })
    first.host.dispose()
    const platform = new FakeWindow()
    platform.browserTabs.push(new FakeTab('https://project.test/', 'page-1'))
    const second = fixture(platform, first.workspaceState)
    second.focus('project-b')
    await second.host.restore()
    expect(second.events).toContainEqual(
      expect.objectContaining({
        kind: 'state',
        state: expect.objectContaining({
          tabId: original.tabId,
          projectId: 'project-a',
        }),
      })
    )
    second.host.dispose()
  })

  it('does not transfer saved ownership to another tab at the same URL', async () => {
    const first = fixture()
    await first.host.restore()
    await first.host.open('project-a', 'https://project.test/', 'lost-tab')
    first.host.dispose()
    const platform = new FakeWindow()
    platform.browserTabs.push(new FakeTab('https://project.test/', 'different-native-target'))
    const second = fixture(platform, first.workspaceState)
    second.focus('project-b')
    await second.host.restore()
    expect(second.events).toContainEqual(
      expect.objectContaining({
        kind: 'state',
        state: expect.objectContaining({
          tabId: 'lost-tab',
          projectId: 'project-a',
          error: expect.any(String),
          closed: true,
        }),
      })
    )
    expect(second.events).toContainEqual(
      expect.objectContaining({
        kind: 'state',
        state: expect.objectContaining({ projectId: null, error: expect.any(String) }),
      })
    )
    second.host.dispose()
  })

  it('invalidates the document generation even for a reload at the same URL', async () => {
    const f = fixture()
    await f.host.restore()
    const state = await f.host.open('project-a', 'https://project.test/')
    const tab = f.platform.browserTabs[0]!
    tab.session.event('Page.frameNavigated', {
      frame: { id: 'root', loaderId: 'new-document', url: state.url },
    })
    expect(f.events).toContainEqual(
      expect.objectContaining({
        kind: 'navigated',
        tabId: state.tabId,
        projectId: state.projectId,
        generation: state.generation + 1,
      })
    )
    f.host.dispose()
  })

  it('ignores title-only changes and child frame navigations for document generation', async () => {
    const f = fixture()
    await f.host.restore()
    const state = await f.host.open('project-a', 'https://project.test/')
    const tab = f.platform.browserTabs[0]!
    tab.title = 'Changed title'
    f.platform.changed.fire(tab)
    tab.session.event('Page.frameNavigated', {
      frame: {
        id: 'child',
        parentId: 'root',
        loaderId: 'child-document',
        url: 'https://child.test/',
      },
    })
    expect(f.events.filter((event) => event.kind === 'navigated')).toHaveLength(0)
    expect(f.events.at(-1)).toMatchObject({ generation: state.generation })
    f.host.dispose()
  })

  it('reports a missing browser proposal without failing restoration', async () => {
    const events: BrowserHostEvent[] = []
    const host = new BrowserHostCore(
      {
        workspaceState: new MemoryState(),
        focusedProject: () => null,
        emit: (event) => events.push(event),
        log: vi.fn(),
      },
      {},
      -2
    )
    expect(host.available).toBe(false)
    await host.restore()
    await expect(host.open(null, 'https://project.test/')).rejects.toThrow()
    expect(events).toEqual([])
    host.dispose()
  })

  it('treats guarded proposal getters as unavailable without failing activation', async () => {
    const platform = new FakeWindow()
    Object.defineProperty(platform, 'browserTabs', {
      get: () => {
        throw new Error('proposal disabled')
      },
    })
    const host = new BrowserHostCore(
      {
        workspaceState: new MemoryState(),
        focusedProject: () => null,
        emit: vi.fn(),
        log: vi.fn(),
      },
      platform,
      -2
    )
    expect(host.available).toBe(false)
    await host.restore()
    host.dispose()
  })

  it('does not register a tab closed before openBrowserTab resolves', async () => {
    const f = fixture()
    await f.host.restore()
    const listener = f.platform.opened.event((tab) => {
      f.platform.closed.fire(tab)
    })
    await expect(
      f.host.open('project-a', 'https://project.test/', 'closed-during-open')
    ).rejects.toMatchObject({ code: 'closed' })
    expect(f.events).toEqual([])
    listener.dispose()
    f.host.dispose()
  })

  it('uses CDP navigation history for back and forward', async () => {
    const f = fixture()
    await f.host.restore()
    const state = await f.host.open('project-a', 'https://project.test/')
    const tab = f.platform.browserTabs[0]!
    tab.session.handle = (request) => {
      if (request.method === 'Page.getNavigationHistory') {
        tab.session.reply(request, { currentIndex: 1, entries: [{ id: 7 }, { id: 8 }, { id: 9 }] })
      } else {
        tab.session.reply(request, {})
      }
    }
    await f.host.action(state.tabId, 'back')
    expect(tab.session.requests).toContainEqual(
      expect.objectContaining({ method: 'Page.navigateToHistoryEntry', params: { entryId: 7 } })
    )
    await f.host.action(state.tabId, 'forward')
    expect(tab.session.requests).toContainEqual(
      expect.objectContaining({ method: 'Page.navigateToHistoryEntry', params: { entryId: 9 } })
    )
    f.host.dispose()
  })

  it('coalesces concurrent opens for the same browser identity', async () => {
    const f = fixture()
    await f.host.restore()
    const [first, second] = await Promise.all([
      f.host.open('project-a', 'https://project.test/', 'one-browser'),
      f.host.open('project-a', 'https://project.test/', 'one-browser'),
    ])
    expect(first.tabId).toBe(second.tabId)
    expect(f.platform.browserTabs).toHaveLength(1)
    f.host.dispose()
  })

  it('does not keep same-document navigation in a loading state', async () => {
    const f = fixture()
    await f.host.restore()
    const state = await f.host.open('project-a', 'https://project.test/')
    const tab = f.platform.browserTabs[0]!
    tab.session.event('Page.navigatedWithinDocument', {
      frameId: 'root',
      url: 'https://project.test/#section',
    })
    expect(f.events).toContainEqual(
      expect.objectContaining({
        kind: 'state',
        state: expect.objectContaining({
          tabId: state.tabId,
          loading: false,
          generation: state.generation + 1,
        }),
      })
    )
    f.host.dispose()
  })

  it('deduplicates the API and CDP notifications for one navigation', async () => {
    const f = fixture()
    await f.host.restore()
    const state = await f.host.open('project-a', 'https://project.test/')
    const tab = f.platform.browserTabs[0]!
    tab.url = 'https://project.test/next'
    f.platform.changed.fire(tab)
    tab.session.event('Page.frameNavigated', {
      frame: { id: 'root', loaderId: 'next-document', url: tab.url },
    })
    expect(f.events.filter((event) => event.kind === 'navigated')).toEqual([
      {
        kind: 'navigated',
        tabId: state.tabId,
        projectId: state.projectId,
        generation: state.generation + 1,
        url: tab.url,
      },
    ])
    f.host.dispose()
  })

  it('replays live states after socket reconnect without opening another tab or CDP session', async () => {
    const f = fixture()
    await f.host.restore()
    const state = await f.host.open('project-a', 'https://project.test/')
    f.events.length = 0
    await f.host.restore()
    expect(f.events).toContainEqual({ kind: 'state', state })
    expect(f.platform.browserTabs).toHaveLength(1)
    expect(f.platform.browserTabs[0]!.starts).toBe(1)
    f.host.dispose()
  })

  it('reports focus unavailable without opening a duplicate browser tab', async () => {
    const f = fixture()
    await f.host.restore()
    const state = await f.host.open('project-a', 'https://project.test/')
    await expect(f.host.focus(state.tabId)).rejects.toMatchObject({ code: 'unsupported' })
    expect(f.platform.browserTabs).toHaveLength(1)
    f.host.dispose()
  })

  it('cancels pending CDP when the VS Code tab closes', async () => {
    const f = fixture()
    await f.host.restore()
    const state = await f.host.open('project-a', 'https://project.test/')
    const tab = f.platform.browserTabs[0]!
    tab.session.handle = () => undefined
    const evaluation = f.host.cdp(state.tabId, 'Runtime.evaluate', {})
    const rejected = expect(evaluation).rejects.toMatchObject({ code: 'closed' })
    f.platform.closed.fire(tab)
    await rejected
    expect(f.events.at(-1)).toMatchObject({ kind: 'gone', tabId: state.tabId })
    f.host.dispose()
  })
})
