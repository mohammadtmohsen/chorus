import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_HOST } from '@chorus/event-store'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKBENCH_ACTIVITY_BAR_PUSH_CHANNEL,
  WORKBENCH_ACTIVITY_BAR_REPORT_CHANNEL,
  WORKBENCH_ASK_DIFF_RESULT_CHANNEL,
  WORKBENCH_CONNECTION_CHANNEL,
  WORKBENCH_EDIT_RESULT_CHANNEL,
  WORKBENCH_FOCUS_CHANNEL,
  WORKBENCH_LAYOUT_CHANNEL,
  WORKBENCH_REVEAL_RESULT_CHANNEL,
  WORKBENCH_ROW_REQUEST_CHANNEL,
  WORKBENCH_ROW_REVEAL_PUSH_CHANNEL,
  WORKBENCH_ROW_SCROLL_REQUEST_CHANNEL,
  WORKBENCH_ROW_SCROLL_PUSH_CHANNEL,
  WORKBENCH_STORAGE_FLUSH_CHANNEL,
  WORKBENCH_STORAGE_FLUSH_RESULT_CHANNEL,
  WORKBENCH_TERMINAL_ENV_CHANNEL,
  WorkbenchConnection,
} from '../shared/workbench-ipc.js'
import type { WorkbenchTerminalEnvSource } from './workbench-surface.js'

/**
 * The whole class of defect here is a control that appears to exist because it
 * exists somewhere else.
 *
 * A `WebContentsView` inherits nothing: not the shell's session, not its CSP, not
 * its permission handlers, not its navigation lock, and — the one round 2 of the
 * preflight left unnamed — not its preload. Two of those failures are loud (no
 * preload at all means the surface never receives its connection) and the rest
 * are silent, which is why they are asserted here rather than looked for by hand.
 *
 * The second class, added after the containment slice was reviewed, is a control
 * that exists but is asked the wrong question: an operation authorised by the
 * *name* of a thing rather than by the *identity of the caller*, and a project
 * root that is whatever string a renderer sent.
 *
 * The third, added after the seventh round, is a control that answers a different
 * question from the one it looks like it answers. `realpathSync` was standing in
 * for authorisation — it canonicalises a path, which makes it well-formed and says
 * nothing about whether this window may open it. The tests below are written so
 * that both refusals fail loudly if the capability is taken back out: a forged but
 * real directory, and a capability minted for another window.
 */

const defaultSession = { id: 'default' }
const showOpenDialog = vi.fn()
const partitions = new Map<string, Record<string, unknown>>()

const fromPartition = vi.fn((name: string) => {
  const existing = partitions.get(name)
  if (existing !== undefined) return existing
  const created = {
    id: name,
    webRequest: { onHeadersReceived: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  }
  partitions.set(name, created)
  return created
})

/** Every view constructed during a test, with the preferences it was given. */
const constructed: { webPreferences: Record<string, unknown> }[] = []

const captureStill = (): { isEmpty: () => boolean; toJPEG: (quality: number) => Buffer } => ({
  isEmpty: () => false,
  toJPEG: () => Buffer.from('still'),
})

const shellSenders = vi.hoisted(() => new WeakSet<object>())

class FakeWebContents {
  constructor() {
    shellSenders.add(this)
  }
  readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  readonly sent: unknown[] = []
  readonly mainFrame = { processId: 1, frameToken: randomUUID() }
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  once(event: string, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener)
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((each) => each !== listener)
    )
    return this
  }
  readonly setWindowOpenHandler = vi.fn()
  /**
   * Recorded for the same reason `setBounds` is: the factor a workbench view is
   * drawn at is product behaviour, not bookkeeping.
   */
  zoomFactor: number | null = null
  setZoomFactor(next: number): void {
    this.zoomFactor = next
  }

  captureCount = 0
  capturePage(): Promise<{ isEmpty: () => boolean; toJPEG: (quality: number) => Buffer }> {
    this.captureCount += 1
    return Promise.resolve(captureStill())
  }

  readonly channels: string[] = []
  send(channel: string, payload?: unknown): void {
    this.channels.push(channel)
    this.sent.push(payload)
    if (channel === WORKBENCH_STORAGE_FLUSH_CHANNEL) {
      pushes.get(WORKBENCH_STORAGE_FLUSH_RESULT_CHANNEL)?.({ sender: this }, payload, null)
    }
  }
  sentOn(channel: string): unknown[] {
    return this.sent.filter((_payload, index) => this.channels[index] === channel)
  }
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  loadFile(): Promise<void> {
    return Promise.resolve()
  }
  /** Flippable, because "the window went away mid-acquire" needs *this* object to go. */
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  readonly close = vi.fn()
  /** Arguments are forwarded: `did-start-navigation` is only readable with them. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

class FakeWebContentsView {
  readonly webContents = new FakeWebContents()
  bounds: unknown = null
  constructor(options: { webPreferences: Record<string, unknown> }) {
    shellSenders.delete(this.webContents)
    constructed.push(options)
  }
  setBounds(rect: unknown): void {
    this.bounds = rect
  }
  /**
   * Recorded rather than swallowed, because hiding a view is product behaviour
   * and not bookkeeping: it is how the Editor switch turns a workbench off and
   * how `workspace/overlay.ts` keeps a native view from being drawn over a
   * dialog. A `vi.fn()` would have satisfied the call and thrown the value away.
   */
  visible: boolean | null = null
  setVisible(next: boolean): void {
    this.visible = next
  }
  getVisible(): boolean {
    return this.visible === true
  }
}

const handlers = new Map<string, (event: unknown, request?: unknown) => unknown>()

/**
 * `ipcMain.on` listeners, kept in their own map because `on` and `handle` are
 * different mechanisms rather than two spellings of one: `handle` answers an
 * `invoke` and returns a value, `on` receives a `send` and returns nothing.
 *
 * It exists because the context channel — a surface reporting the file and
 * selection it is showing — is one-way, and the mock only had `handle`. The
 * result was not a failing assertion but `TypeError: ipcMain.on is not a
 * function` thrown while `registerWorkbenchHandlers` was still being called,
 * which took the entire file down: vitest reported `(0 test)`, so a suite of
 * around forty checks was reported as neither passing nor failing. A mock that
 * is missing a method the production code calls is a suite that silently stops
 * covering anything, which is worth more comment than the two lines below.
 */
const pushes = new Map<string, (event: unknown, ...payload: unknown[]) => void>()

/**
 * Unpackaged by default, which is what makes the gate's seeded chooser reachable
 * from here at all — and **flippable**, because the one control the trust waiver
 * rests on is the packaging check, and a control that cannot be turned off cannot
 * be tested. A getter rather than a literal so the flag is read at call time; the
 * value is captured once by a plain property and the test would then be asserting
 * against the state at mock-construction.
 */
const appState = { isPackaged: false }

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged
    },
  },
  BrowserWindow: {
    fromWebContents: () => fakeWindow,
    getAllWindows: () => [fakeWindow],
  },
  WebContentsView: FakeWebContentsView,
  dialog: { showOpenDialog },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, request?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, listener: (event: unknown, ...payload: unknown[]) => void) => {
      pushes.set(channel, listener)
    }),
  },
  session: {
    get defaultSession() {
      return defaultSession
    },
    fromPartition,
  },
  shell: { openExternal: vi.fn() },
}))

/**
 * The shared server, faked — because `openSurface` now takes its lease before it
 * creates a view, and the real `acquire` downloads 76 MB, verifies a checksum,
 * unpacks 257 MB and spawns a Node process. None of that is what this file is
 * about, and a unit test that did it would be measuring the network.
 *
 * The descriptor is still asserted end to end: what these tests check is that
 * whatever the host returns reaches **that one surface** and no other.
 */
const RUNTIME = {
  remoteAuthority: '127.0.0.1:51515',
  connectionToken: 'a-token-the-shell-must-never-see',
  commit: '987c9597516278c9fcf10d963a0592ce1384ab93',
  quality: 'stable',
}
const LOCAL_RUNTIME = { ...RUNTIME, processNonce: expect.any(String) as string }
/** How many views existed when the lease was taken — see the ordering test below. */
let viewsAtAcquire = -1
/*
 * The root is declared even though nothing here reads it, and that is the fix
 * for a real red gate rather than a tidy-up.
 *
 * `vi.fn` infers a mock's call signature from the implementation it is given, so
 * an implementation with no parameters produced a mock that could not be called
 * with one — `Expected 0 arguments, but got 1` at the forwarding line below, plus
 * an unsafe `any` return where the failed call's type collapsed. It was invisible
 * because `pnpm check` stops at its first failing leg and turbo was replaying a
 * cached green typecheck from an older hash; editing this file busted the cache.
 * Naming the parameter is what makes `acquireWorkbenchRuntime(root)` legal, and
 * the assertions that read `toHaveBeenCalledWith` a root depend on it arriving.
 */
const acquireWorkbenchRuntime = vi.fn((_root: string) => {
  viewsAtAcquire = constructed.length
  return Promise.resolve(RUNTIME)
})
const releaseWorkbenchRuntime = vi.fn((_root: string) => undefined)

const acquireRemoteWorkbenchRuntime = vi.fn((_host: string, _root: string) =>
  Promise.resolve({ ...RUNTIME, remoteAuthority: '127.0.0.1:48000' })
)
const releaseRemoteWorkbenchRuntime = vi.fn((_host: string, _root: string) => Promise.resolve())

vi.mock('./remote-workbench.js', () => ({
  acquireRemoteWorkbenchRuntime: (host: string, root: string) =>
    acquireRemoteWorkbenchRuntime(host, root),
  releaseRemoteWorkbenchRuntime: (host: string, root: string) =>
    releaseRemoteWorkbenchRuntime(host, root),
}))

vi.mock('./shell-windows.js', () => ({
  isShellSender: (event: { readonly sender: object }) => shellSenders.has(event.sender),
  shellWindows: () => [],
  focusedShellWindow: () => null,
  registerShellWindow: () => undefined,
}))

vi.mock('./workbench-host.js', () => ({
  acquireWorkbenchRuntime: (root: string) => acquireWorkbenchRuntime(root),
  // Braces, because the mock returns void and a shorthand arrow returning a void
  // expression is forbidden — the forwarding is the point, not the value.
  releaseWorkbenchRuntime: (root: string) => {
    releaseWorkbenchRuntime(root)
  },
  workbenchHostLog: () => ({ info: () => undefined, warn: () => undefined }),
  serverDataDir: () => tmpdir(),
  stopIdleWorkbenchHost: () => Promise.resolve(),
  workbenchServerPid: () => null,
}))

/**
 * One window, with the focus state it reports.
 *
 * The focus members are here because main binds `focus` and `blur` on the owning
 * `BrowserWindow` and reads `isFocused()` when it pushes. A double without them
 * does not fail an assertion — it throws `TypeError: window.on is not a
 * function` while `openSurface` is still running, taking thirty-five tests down
 * at once. That is the same shape the `ipcMain.on` note above describes: a fake
 * missing a method the production code calls reports as a broken suite rather
 * than as a broken fake, which is the more expensive of the two to diagnose.
 *
 * `focused` and `gone` are flippable rather than fixed, because the two things
 * worth asserting about a window here — the value a surface is told, and the
 * teardown when its window closes under it — are both about a window *changing*.
 */
const fakeWindow = {
  contentView: {
    children: [] as unknown[],
    addChildView(view: unknown) {
      this.children.push(view)
    },
    removeChildView(view: unknown) {
      this.children = this.children.filter((child) => child !== view)
    },
  },
  /* The shell's own webContents, which zoom is applied to. */
  webContents: new FakeWebContents(),
  listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  },
  off(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((held) => held !== listener)
    )
  },
  /** A copy, because a listener that unbinds itself must not skip its neighbour. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  },
  focused: true,
  isFocused(): boolean {
    return this.focused
  },
  gone: false,
  isDestroyed(): boolean {
    return this.gone
  },
}

/**
 * Real directories, because main now decides what a project root is rather than
 * repeating what it was told, and a made-up string is exactly what it refuses.
 *
 * `realpathSync` on the way in: on macOS `tmpdir()` is itself behind a symlink
 * (`/var` → `/private/var`), so without this every descriptor assertion below
 * would be re-testing the canonicalisation rule by accident instead of the thing
 * it is about.
 */
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'chorus-workbench-surface-')))
const root = (name: string): string => {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return path
}

const ROOT_A = root('a')
const ROOT_B = root('b')

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const surface = await import('./workbench-surface.js')
const scale = await import('./scale.js')

// Registered once, because the chooser is only reachable through its channel:
// there is no exported mint, deliberately, so a main-side caller cannot conjure a
// capability out of a path either.
surface.registerWorkbenchHandlers(undefined)

/** One shell, unless a test needs two. Ownership is decided by this object. */
let shell: FakeWebContents

beforeEach(async () => {
  // Module state is shared across this file; a leaked surface would make the
  // next test's "the last constructed view" the wrong one.
  await surface.closeAllSurfaces()
  surface.setDetachedAccessPredicate(null)
  surface.setHandoffExpiredSink(null)
  surface.setWorkbenchTerminalEnvSource(null)
  showOpenDialog.mockReset()
  acquireWorkbenchRuntime.mockClear()
  releaseWorkbenchRuntime.mockClear()
  releaseRemoteWorkbenchRuntime.mockClear()
  shell = new FakeWebContents()
  // The two halves of the trust waiver's condition, back to the shipped values.
  // Left set by a test that flipped them, every descriptor after it would be
  // asserting against the wrong profile — and the assertion that matters most
  // here is the *absence* of a field, which is exactly the kind that passes for
  // the wrong reason.
  appState.isPackaged = false
  delete process.env['CHORUS_WORKBENCH_E2E_ROOTS']
  /*
   * Focus, on the window and on its listener list.
   *
   * `closeAllSurfaces` above should already have torn every watcher down, and
   * this does not rely on it for two reasons. A test that flips `gone` leaves a
   * teardown that deliberately returns early, so its listeners survive it — and a
   * listener surviving into the next test fires a push into a surface that test
   * never created, which reads as an unexplained extra entry in `sent` rather
   * than as a leak.
   */
  fakeWindow.focused = true
  fakeWindow.gone = false
  fakeWindow.listeners.clear()
})

const lastView = (): FakeWebContentsView =>
  fakeWindow.contentView.children.at(-1) as FakeWebContentsView

interface Chosen {
  readonly chosen: { readonly grant: string; readonly projectRoot: string } | null
}

/**
 * A capability, obtained the only way anything can obtain one: the person picked
 * a folder in main's own dialog.
 *
 * The dialog is stubbed rather than the mint, which is the point — a test that
 * reached past the chooser would be asserting against a mint the app does not
 * have.
 */
async function chooseProject(owner: FakeWebContents, root: string): Promise<Chosen['chosen']> {
  showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] })
  const response = (await handlers.get('workbench:chooseProject')?.(
    { sender: owner },
    {}
  )) as Chosen
  return response.chosen
}

async function grantFor(owner: FakeWebContents, root: string): Promise<string> {
  const chosen = await chooseProject(owner, root)
  if (chosen === null) throw new Error('the chooser answered with nothing')
  return chosen.grant
}

/** Open a surface the way the app does: choose, then redeem. */
async function openAt(owner: FakeWebContents, root: string): Promise<string> {
  return surface.openSurface(owner as never, { grant: await grantFor(owner, root) }, undefined)
}

describe('the workbench session', () => {
  it('is not defaultSession, and carries its own CSP and permission handlers', () => {
    const created = surface.workbenchSession(
      false,
      RUNTIME.remoteAuthority,
      RUNTIME
    ) as unknown as {
      id: string
      webRequest: { onHeadersReceived: ReturnType<typeof vi.fn> }
      setPermissionRequestHandler: ReturnType<typeof vi.fn>
      setPermissionCheckHandler: ReturnType<typeof vi.fn>
    }

    expect(created).not.toBe(defaultSession)
    expect(fromPartition).toHaveBeenCalledWith(surface.workbenchPartition(RUNTIME.remoteAuthority))
    expect(created.webRequest.onHeadersReceived).toHaveBeenCalled()
    expect(created.setPermissionRequestHandler).toHaveBeenCalled()
    expect(created.setPermissionCheckHandler).toHaveBeenCalled()
  })

  it('is in-memory, so a connection secret cannot outlive a quit in a cookie', () => {
    expect(surface.WORKBENCH_PARTITION.startsWith('persist:')).toBe(false)
    expect(surface.workbenchPartition(RUNTIME.remoteAuthority).startsWith('persist:')).toBe(false)
  })

  it('is one partition per remote authority, not one per surface nor one for the app', async () => {
    const other = { ...RUNTIME, remoteAuthority: '127.0.0.1:51516' }
    acquireWorkbenchRuntime.mockImplementationOnce(() => Promise.resolve(other))
    const first = constructed.length
    await openAt(shell, ROOT_A)
    await openAt(new FakeWebContents(), ROOT_A)
    await openAt(shell, ROOT_B)
    const sessions = constructed.slice(first).map((view) => view.webPreferences['session'])
    expect(sessions[0]).not.toBe(sessions[1])
    expect(sessions[2]).toBe(sessions[1])
    expect(fromPartition).toHaveBeenCalledWith(surface.workbenchPartition(other.remoteAuthority))
    expect(fromPartition).toHaveBeenCalledWith(surface.workbenchPartition(RUNTIME.remoteAuthority))
  })
})

describe('the surface webPreferences', () => {
  it('names the workbench preload and never the shell one', async () => {
    await openAt(shell, ROOT_A)
    const named: unknown = constructed.at(-1)?.webPreferences['preload']
    const preload = typeof named === 'string' ? named : ''

    // The failure this is written against is a spread of the window's own
    // `webPreferences` — whose sandbox flags are identical, so the copy looks
    // harmless and brings `preload/index.js` and the whole ChorusApi with it.
    expect(preload.endsWith('preload/workbench.js')).toBe(true)
    expect(preload).not.toContain('preload/index.js')
  })

  it('keeps the sandbox on and sub-frame node integration off', async () => {
    await openAt(shell, ROOT_A)
    const preferences = constructed.at(-1)?.webPreferences ?? {}
    expect(preferences['sandbox']).toBe(true)
    expect(preferences['contextIsolation']).toBe(true)
    expect(preferences['nodeIntegration']).toBe(false)
    // On, "all your preloads will load for every iframe" — and a workbench's
    // iframes are extension webviews.
    expect(preferences['nodeIntegrationInSubFrames']).toBe(false)
  })

  it('puts the view on the workbench session object itself', async () => {
    await openAt(shell, ROOT_A)
    expect(constructed.at(-1)?.webPreferences['session']).toBe(
      surface.workbenchSession(false, RUNTIME.remoteAuthority, RUNTIME)
    )
    expect(constructed.at(-1)?.webPreferences['session']).not.toBe(defaultSession)
  })
})

/**
 * Item 4 of the sixth review, corrected by the seventh: the renderer does not
 * propose a project at all.
 *
 * The sixth round had main canonicalise the renderer's string and open whatever
 * existed there, which is the defect this block is now written against —
 * canonicalisation is not authorisation, and "it resolves to a real directory" is
 * a property of nearly every directory on the disk. What main opens is a
 * capability it minted itself, from a folder the person picked, bound to the
 * window that asked.
 */
describe('what main will open, and what it refuses', () => {
  it('refuses a forged path, however real the directory is', async () => {
    /*
     * The adversarial case, and the reason it has to be a *real* directory:
     * against a made-up path this passes with the capability removed, because
     * `approveProjectRoot` refuses it for a reason that has nothing to do with
     * authorisation. `ROOT_A` exists, is absolute, is canonical and is a
     * directory — every test the old code applied — and it is still refused,
     * because it is not a capability.
     */
    await expect(surface.openSurface(shell as never, { grant: ROOT_A }, undefined)).rejects.toThrow(
      /belongs to this window/
    )
    expect(fakeWindow.contentView.children).toHaveLength(0)

    // And one level out, at the boundary itself: the channel has no shape for a
    // path, so a renderer naming one is refused by the schema rather than by a
    // check someone has to remember to write.
    await expect(
      handlers.get('workbench:open')?.({ sender: shell }, { projectRoot: ROOT_A })
    ).rejects.toThrow(/Invalid request/)

    // The control, so this cannot pass by nothing working at all.
    await expect(openAt(shell, ROOT_A)).resolves.toEqual(expect.any(String))
  })

  it('refuses a capability minted for another window', async () => {
    const other = new FakeWebContents()
    const grant = await grantFor(shell, ROOT_A)

    /*
     * A grant is not a secret. It crosses IPC, sits in React state, and would sit
     * in the first log line anybody adds while debugging this — so a second
     * window holding one is the case to design against, not an unlikely one.
     */
    await expect(surface.openSurface(other as never, { grant }, undefined)).rejects.toThrow(
      /belongs to this window/
    )
    await expect(handlers.get('workbench:open')?.({ sender: other }, { grant })).rejects.toThrow(
      /belongs to this window/
    )
    expect(fakeWindow.contentView.children).toHaveLength(0)

    // The control: the window it was minted for still opens with it.
    await expect(surface.openSurface(shell as never, { grant }, undefined)).resolves.toEqual(
      expect.any(String)
    )
  })

  it('refuses a project id when no registry was wired', async () => {
    // Fail-closed rather than falling through to the grant branch, where
    // `target.grant` is not even present. A build that forgot to inject the
    // resolver must refuse, not misread the request as something else.
    await expect(
      handlers.get('workbench:open')?.({ sender: shell }, { projectId: 'anything' })
    ).rejects.toThrow(/No project registry is wired/)
  })

  /*
   * The wired half. Re-registering only reassigns the module-level resolver, and
   * the registration is restored in the `finally` so the surrounding file keeps
   * the unwired default every other test was written against.
   */
  it('opens a project id against the injected registry, and passes its refusal through', async () => {
    const adopted = new Map([['known', ROOT_A]])
    surface.registerWorkbenchHandlers(undefined, (projectId) => {
      const root = adopted.get(projectId)
      if (root === undefined) throw new Error(`No project with id ${projectId}`)
      return { host: LOCAL_HOST, root }
    })

    try {
      await expect(
        handlers.get('workbench:open')?.({ sender: shell }, { projectId: 'known' })
      ).resolves.toEqual({ viewId: expect.any(String) })

      // The renderer cannot invent one: an id nobody adopted resolves to nothing,
      // which is what bounds the openable set now that a grant is not required.
      await expect(
        handlers.get('workbench:open')?.({ sender: shell }, { projectId: 'invented' })
      ).rejects.toThrow(/No project with id invented/)
    } finally {
      surface.registerWorkbenchHandlers(undefined)
    }
  })

  it('lets a grant die with the document it was minted for', async () => {
    const grant = await grantFor(shell, ROOT_A)
    shell.emit('did-start-navigation', {
      url: 'file:///wherever/index.html',
      isMainFrame: true,
      isSameDocument: false,
    })

    // The authorisation was the person's, given to *this* document. Whatever
    // loads next in the same `WebContents` did not receive it.
    await expect(surface.openSurface(shell as never, { grant }, undefined)).rejects.toThrow(
      /belongs to this window/
    )
  })

  it('canonicalises what the chooser answered rather than storing the spelling', async () => {
    const link = join(scratch, 'link-to-a')
    rmSync(link, { force: true })
    symlinkSync(ROOT_A, link, 'dir')

    const chosen = await chooseProject(shell, link)
    expect(chosen?.projectRoot).toBe(ROOT_A)

    await surface.openSurface(shell as never, { grant: chosen?.grant ?? '' }, undefined)
    const view = lastView()
    view.webContents.emit('did-finish-load')

    // The descriptor is the resolved tree, not the second name for it. Two
    // spellings of one project would otherwise be two projects to every refcount,
    // cache key and storage path that comes after.
    expect(view.webContents.sent).toEqual([{ ...LOCAL_RUNTIME, projectRoot: ROOT_A }])
  })

  it('mints nothing from a cancelled dialog', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(handlers.get('workbench:chooseProject')?.({ sender: shell }, {})).resolves.toEqual(
      { chosen: null }
    )
  })

  it('still refuses a root that does not exist, a file, and a relative path', async () => {
    const file = join(scratch, 'not-a-directory.txt')
    writeFileSync(file, 'x')

    // Now applied to the *chooser's* answer rather than the renderer's request:
    // the dialog can return a path that has since gone, and a seeded root is a
    // string like any other.
    await expect(chooseProject(shell, join(scratch, 'absent'))).rejects.toThrow(
      /No such workbench project root/
    )
    await expect(chooseProject(shell, file)).rejects.toThrow(/must be a directory/)
    // Resolved against *main's* cwd, which is whatever launched the app.
    await expect(chooseProject(shell, 'relative/path')).rejects.toThrow(/must be an absolute path/)
  })

  it('is enforced wherever a string becomes a root', () => {
    // `approveProjectRoot` is exported for this assertion and for the handler's
    // error message; what matters is that the mint calls it whether or not the
    // caller did.
    expect(surface.approveProjectRoot(ROOT_B)).toBe(ROOT_B)
    expect(() => surface.approveProjectRoot(join(scratch, 'absent'))).toThrow()
  })
})

/**
 * Item 2 of the review. A view id is opaque but it is not a secret: it crosses
 * IPC, sits in the shell's React state and would sit in the first log line
 * anybody adds while debugging the layout. Authorising on it alone means any
 * window can move or destroy another window's workbench by naming it.
 */
describe('who may drive a surface', () => {
  it('refuses a window that does not own it, for bounds and for close alike', async () => {
    const other = new FakeWebContents()
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()
    const placed = { x: 1, y: 2, width: 3, height: 4 }
    surface.setSurfaceBounds(shell as never, viewId, placed)

    expect(() => {
      surface.setSurfaceBounds(other as never, viewId, { x: 9, y: 9, width: 9, height: 9 })
    }).toThrow(/belongs to this window/)
    expect(() => {
      void surface.closeSurface(other as never, viewId)
    }).toThrow(/belongs to this window/)

    // The refusal has to be a refusal, not a message: the view is where its owner
    // put it, and it is still alive.
    expect(view.bounds).toEqual(placed)
    expect(view.webContents.close).not.toHaveBeenCalled()

    // The control, so this cannot pass by nothing working: the owner still moves
    // it.
    const moved = { x: 5, y: 6, width: 7, height: 8 }
    surface.setSurfaceBounds(shell as never, viewId, moved)
    expect(view.bounds).toEqual(moved)
  })

  it('says the same thing about an id that never existed', () => {
    // Two different messages would answer "does this id exist?", which is the
    // only thing an id-guessing caller could learn here.
    expect(() => {
      void surface.closeSurface(shell as never, 'not-an-id')
    }).toThrow(/belongs to this window/)
  })

  it('lets the owner close its own surface', async () => {
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()
    await surface.closeSurface(shell as never, viewId)
    expect(view.webContents.close).toHaveBeenCalled()
    expect(fakeWindow.contentView.children).not.toContain(view)
  })
})

/**
 * Item 3 of the review. A surface is destroyed today by the renderer's own
 * unmount — the one path a reload does not take.
 */
describe('a shell that goes away without saying so', () => {
  it('takes its surfaces with it when it reloads', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()

    // The shape Electron passes: a cross-document main-frame navigation, which
    // is what `location.reload()` and a dev-server full reload both are.
    shell.emit('did-start-navigation', {
      url: 'file:///wherever/index.html',
      isMainFrame: true,
      isSameDocument: false,
    })

    await vi.waitFor(() => {
      expect(view.webContents.close).toHaveBeenCalled()
    })
    expect(fakeWindow.contentView.children).not.toContain(view)
  })

  it('takes them when it is destroyed', async () => {
    await openAt(shell, ROOT_B)
    const view = lastView()
    shell.emit('destroyed')
    await vi.waitFor(() => {
      expect(view.webContents.close).toHaveBeenCalled()
    })
  })

  it('leaves them alone for a same-document navigation', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()

    // The control, and it is not decorative: a `pushState` or a fragment is the
    // shell still running, and tearing four workbenches down because a route
    // changed would be a worse bug than the one this fixes.
    shell.emit('did-start-navigation', {
      url: 'file:///wherever/index.html#somewhere',
      isMainFrame: true,
      isSameDocument: true,
    })
    shell.emit('did-start-navigation', {
      url: 'file:///wherever/frame.html',
      isMainFrame: false,
      isSameDocument: false,
    })

    expect(view.webContents.close).not.toHaveBeenCalled()
  })

  it('does not touch another shell surfaces', async () => {
    const other = new FakeWebContents()
    await openAt(shell, ROOT_A)
    const mine = lastView()
    await openAt(other, ROOT_B)
    const theirs = lastView()

    other.emit('destroyed')

    await vi.waitFor(() => {
      expect(theirs.webContents.close).toHaveBeenCalled()
    })
    expect(mine.webContents.close).not.toHaveBeenCalled()
  })
})

describe('a surface changing hands', () => {
  const placed = { x: 1, y: 2, width: 3, height: 4 }

  async function withRegistry(run: () => Promise<void>): Promise<void> {
    surface.registerWorkbenchHandlers(undefined, (projectId) => {
      if (projectId === 'a') return { host: LOCAL_HOST, root: ROOT_A }
      throw new Error(`No project with id ${projectId}`)
    })
    try {
      await run()
    } finally {
      surface.registerWorkbenchHandlers(undefined)
    }
  }

  it('refuses a handoff when the caller owns no surface on that root', async () => {
    await openAt(shell, ROOT_B)

    expect(() =>
      surface.beginHandoff(shell as never, ROOT_A, new FakeWebContents() as never, 'detach')
    ).toThrow(/No single workbench surface/)
  })

  it('refuses a handoff when the caller owns two surfaces on that root', async () => {
    await openAt(shell, ROOT_A)
    await openAt(shell, ROOT_A)

    expect(() =>
      surface.beginHandoff(shell as never, ROOT_A, new FakeWebContents() as never, 'detach')
    ).toThrow(/No single workbench surface/)
  })

  it('stops the old owner driving the view once a handoff begins', async () => {
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()

    surface.beginHandoff(shell as never, ROOT_A, new FakeWebContents() as never, 'detach')

    expect(() => {
      surface.setSurfaceBounds(shell as never, viewId, placed)
    }).toThrow(/belongs to this window/)
    expect(() => {
      void surface.closeSurface(shell as never, viewId)
    }).toThrow(/belongs to this window/)
    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(fakeWindow.contentView.children).not.toContain(view)
  })

  it('lets only the destination claim the view', async () => {
    await withRegistry(async () => {
      await openAt(shell, ROOT_A)
      surface.beginHandoff(shell as never, ROOT_A, new FakeWebContents() as never, 'detach')

      await expect(
        surface.openSurface(new FakeWebContents() as never, { projectId: 'a' }, undefined)
      ).rejects.toThrow(/belongs to this window/)
    })
  })

  it('lets the source take back a detach nobody has claimed yet', async () => {
    await withRegistry(async () => {
      const viewId = await openAt(shell, ROOT_A)
      surface.beginHandoff(shell as never, ROOT_A, new FakeWebContents() as never, 'detach')

      await expect(
        surface.openSurface(shell as never, { projectId: 'a' }, undefined)
      ).resolves.toBe(viewId)
    })
  })

  it('hands the destination the same view rather than a new one', async () => {
    await withRegistry(async () => {
      const destination = new FakeWebContents()
      const viewId = await openAt(shell, ROOT_A)
      const view = lastView()
      const before = constructed.length

      surface.beginHandoff(shell as never, ROOT_A, destination as never, 'detach')

      await expect(
        surface.openSurface(destination as never, { projectId: 'a' }, undefined)
      ).resolves.toBe(viewId)
      expect(constructed.length).toBe(before)
      expect(fakeWindow.contentView.children).toContain(view)

      surface.setSurfaceBounds(destination as never, viewId, placed)
      expect(view.bounds).toEqual(placed)
    })
  })

  it('does not carry the old owner overlay onto the new one', async () => {
    await withRegistry(async () => {
      const destination = new FakeWebContents()
      await openAt(shell, ROOT_A)
      const view = lastView()

      await handlers.get('workbench:setVisible')?.(
        { sender: shell },
        { visible: false, heartbeat: true }
      )
      expect(view.visible).toBe(false)

      surface.beginHandoff(shell as never, ROOT_A, destination as never, 'detach')
      await surface.openSurface(destination as never, { projectId: 'a' }, undefined)
      expect(view.visible).toBe(true)

      await handlers.get('workbench:setVisible')?.({ sender: shell }, { visible: true })
    })
  })

  it('revokes the old owner grant for that root and keeps its others', async () => {
    const grantA = await grantFor(shell, ROOT_A)
    await surface.openSurface(shell as never, { grant: grantA }, undefined)
    const grantB = await grantFor(shell, ROOT_B)

    surface.beginHandoff(shell as never, ROOT_A, new FakeWebContents() as never, 'detach')

    await expect(surface.openSurface(shell as never, { grant: grantA }, undefined)).rejects.toThrow(
      /No workbench project grant/
    )
    await expect(
      surface.openSurface(shell as never, { grant: grantB }, undefined)
    ).resolves.toEqual(expect.any(String))
  })

  it('lets only the host a surface left claim its handoff, when roots match', async () => {
    surface.registerWorkbenchHandlers(undefined, (projectId) => ({
      host: projectId === 'remote' ? 'officepc' : LOCAL_HOST,
      root: ROOT_A,
    }))
    try {
      const destination = new FakeWebContents()
      const remote = await surface.openSurface(shell as never, { projectId: 'remote' }, undefined)
      surface.beginHandoff(shell as never, ROOT_A, destination as never, 'detach', 'officepc')

      const local = await surface.openSurface(
        destination as never,
        { projectId: 'local' },
        undefined
      )
      expect(local).not.toBe(remote)

      const claimed = await surface.openSurface(
        destination as never,
        { projectId: 'remote' },
        undefined
      )
      expect(claimed).toBe(remote)
    } finally {
      surface.registerWorkbenchHandlers(undefined)
    }
  })

  it('keeps a local grant when a remote surface at the same root is handed off', async () => {
    surface.registerWorkbenchHandlers(undefined, () => ({ host: 'officepc', root: ROOT_A }))
    try {
      const grant = await grantFor(shell, ROOT_A)
      await surface.openSurface(shell as never, { projectId: 'remote' }, undefined)
      surface.beginHandoff(
        shell as never,
        ROOT_A,
        new FakeWebContents() as never,
        'detach',
        'officepc'
      )
      await expect(surface.openSurface(shell as never, { grant }, undefined)).resolves.toEqual(
        expect.any(String)
      )
    } finally {
      surface.registerWorkbenchHandlers(undefined)
    }
  })

  it('refuses a project id the detached-window check turns away', async () => {
    await withRegistry(async () => {
      surface.setDetachedAccessPredicate(() => false)
      await expect(
        surface.openSurface(shell as never, { projectId: 'a' }, undefined)
      ).rejects.toThrow(/is open in this window/)

      surface.setDetachedAccessPredicate(() => true)
      await expect(
        surface.openSurface(shell as never, { projectId: 'a' }, undefined)
      ).resolves.toEqual(expect.any(String))
    })
  })

  it('turns an unclaimed detach into a return the source can claim', async () => {
    await withRegistry(async () => {
      const viewId = await openAt(shell, ROOT_A)
      const view = lastView()
      const expired = vi.fn()
      surface.setHandoffExpiredSink(expired)

      vi.useFakeTimers()
      try {
        surface.beginHandoff(shell as never, ROOT_A, new FakeWebContents() as never, 'detach')
        vi.advanceTimersByTime(10_000)

        expect(expired).toHaveBeenCalledWith(ROOT_A)
        expect(view.webContents.close).not.toHaveBeenCalled()
        expect(fakeWindow.contentView.children).not.toContain(view)

        await expect(
          surface.openSurface(shell as never, { projectId: 'a' }, undefined)
        ).resolves.toBe(viewId)
        expect(fakeWindow.contentView.children).toContain(view)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('destroys an unclaimed return when it expires', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()

    vi.useFakeTimers()
    try {
      surface.beginHandoff(shell as never, ROOT_A, new FakeWebContents() as never, 'return')
      vi.advanceTimersByTime(9_999)
      expect(view.webContents.close).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      await vi.waitFor(() => {
        expect(view.webContents.close).toHaveBeenCalled()
      })
      expect(fakeWindow.contentView.children).not.toContain(view)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * The Workspace Trust waiver, and the only test here worth writing is the one
 * that tries to get it in a packaged build.
 *
 * The waiver turns a real security control off. What makes that acceptable is not
 * that the gate needs it — everything needs something — but that a shipped Chorus
 * **cannot receive it**, and that safety rests entirely on one `&&`. So the happy
 * case is the cheap assertion and the packaged case is the load-bearing one: with
 * `app.isPackaged` dropped from the condition, an exported
 * `CHORUS_WORKBENCH_E2E_ROOTS` in a user's shell would be enough to silence the
 * trust prompt in an installed app, and nothing else in this file would notice.
 *
 * Proved against the defect reinstated, one experiment each: removing
 * `!app.isPackaged` from `isE2eProfile` turns the packaged case red, and removing
 * the environment check turns the no-seed case red.
 */
describe('the Workspace Trust waiver', () => {
  /** The descriptor this surface would be handed, straight from the pull. */
  const descriptorFrom = (view: FakeWebContentsView): Record<string, unknown> =>
    handlers.get('workbench:connection')?.({ sender: view.webContents }) as Record<string, unknown>

  it('is granted to an unpackaged app that carries the E2E root seed', async () => {
    process.env['CHORUS_WORKBENCH_E2E_ROOTS'] = ROOT_A
    await openAt(shell, ROOT_A)
    expect(descriptorFrom(lastView())['workspaceTrust']).toBe('waived')
  })

  it('is refused to a packaged app, however the environment is set', async () => {
    process.env['CHORUS_WORKBENCH_E2E_ROOTS'] = ROOT_A
    appState.isPackaged = true
    await openAt(shell, ROOT_A)

    const descriptor = descriptorFrom(lastView())
    // Absent, not false. `toHaveProperty` rather than a truthiness check, because
    // the schema's whole point is that there is no value meaning "enforced" — a
    // descriptor with the key present at all is the defect.
    expect(descriptor).not.toHaveProperty('workspaceTrust')
    expect(WorkbenchConnection.parse(descriptor).workspaceTrust).toBeUndefined()
  })

  it('is refused to an unpackaged app with no seed, which is every pnpm dev', async () => {
    await openAt(shell, ROOT_A)
    expect(descriptorFrom(lastView())).not.toHaveProperty('workspaceTrust')
  })
})

describe('the connection descriptor', () => {
  it('is pushed only after that view has finished loading', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()

    // Nothing before the document exists: Electron makes no promise that `send`
    // queues, and the preload's buffer covers only the window after load.
    expect(view.webContents.sent).toEqual([])
    view.webContents.emit('did-finish-load')
    expect(view.webContents.sent).toEqual([{ ...LOCAL_RUNTIME, projectRoot: ROOT_A }])
  })

  it('answers a pull with the sender own project, not the most recent one', async () => {
    await openAt(shell, ROOT_A)
    const a = lastView()
    await openAt(shell, ROOT_B)
    const b = lastView()

    const pull = handlers.get('workbench:connection')
    expect(pull).toBeDefined()

    /*
     * The adversarial direction, and the only one worth asserting: a lookup
     * keyed on "the most recently opened project" passes the friendly version of
     * this test. A is asked *after* B was opened.
     */
    expect(pull?.({ sender: a.webContents })).toEqual({ ...LOCAL_RUNTIME, projectRoot: ROOT_A })
    expect(pull?.({ sender: b.webContents })).toEqual({ ...LOCAL_RUNTIME, projectRoot: ROOT_B })
  })

  it('refuses a sender it never minted a surface for', () => {
    const pull = handlers.get('workbench:connection')
    expect(() => pull?.({ sender: new FakeWebContents() })).toThrow(/unknown workbench surface/)
  })

  it('refuses shell channels to a document that is not a Chorus window', async () => {
    const website = new FakeWebContents()
    shellSenders.delete(website)
    await expect(
      handlers.get('workbench:setVisible')?.({ sender: website }, { visible: false })
    ).rejects.toThrow(/only available to Chorus windows/)
  })

  it('refuses to let a surface open, close or choose', async () => {
    const grant = await grantFor(shell, ROOT_B)
    await openAt(shell, ROOT_A)
    const view = lastView()

    // Not "it has no method for this" — that is a property of one preload file,
    // where the sender check is a property of the boundary.
    await expect(
      handlers.get('workbench:open')?.({ sender: view.webContents }, { grant })
    ).rejects.toThrow(/not available to a workbench surface/)
    await expect(
      handlers.get('workbench:chooseProject')?.({ sender: view.webContents }, {})
    ).rejects.toThrow(/not available to a workbench surface/)
  })

  it('is answered for the sender of the request, never for a window it names', async () => {
    const other = new FakeWebContents()
    const grant = await grantFor(shell, ROOT_A)
    const { viewId } = (await handlers.get('workbench:open')?.({ sender: shell }, { grant })) as {
      viewId: string
    }

    // The handler passes `event.sender` through as the owner, so the foreign
    // window's request is refused at the same place a direct call would be.
    await expect(handlers.get('workbench:close')?.({ sender: other }, { viewId })).rejects.toThrow(
      /belongs to this window/
    )
    await expect(handlers.get('workbench:close')?.({ sender: shell }, { viewId })).resolves.toEqual(
      { ok: true }
    )
  })
})

/**
 * §5.4's lease, from the surface's side.
 *
 * The unit of the refcount is the **project**, and the whole reason is that a
 * count over visible views reaches zero while projects are still open — with a
 * four-pane cap and no cap on open projects, switching to a fifth project would
 * kill the build running in the first one's terminal. That is the bug the plan's
 * own sentence forbids, arrived at by counting the wrong thing.
 */
describe('the shared server lease', () => {
  it('is taken before the view exists, for the canonical root', async () => {
    const before = constructed.length
    await openAt(shell, ROOT_A)
    expect(acquireWorkbenchRuntime).toHaveBeenCalledWith(ROOT_A)
    /*
     * Ordering, measured rather than asserted about.
     *
     * `viewsAtAcquire` is sampled inside the mock, so this compares the number of
     * views that existed *when the lease was taken* against the number after the
     * open. Before, not after: a workbench document that exists with nothing to
     * connect to cannot tell that state apart from a server that died. An earlier
     * draft of this compared a call-order index against a constant and could
     * never have failed, which is C-027's shape one file over.
     */
    expect(viewsAtAcquire).toBe(before)
    expect(constructed.length).toBe(before + 1)
  })

  it('carries the descriptor to that surface and to no other', async () => {
    await openAt(shell, ROOT_A)
    const a = lastView()
    await openAt(shell, ROOT_B)
    const b = lastView()
    a.webContents.emit('did-finish-load')
    b.webContents.emit('did-finish-load')

    // One shared server, so both hold the same authority and token — and each
    // still reports its own project, which is what a lookup keyed on "most
    // recently opened" would get wrong.
    expect(a.webContents.sent).toEqual([{ ...LOCAL_RUNTIME, projectRoot: ROOT_A }])
    expect(b.webContents.sent).toEqual([{ ...LOCAL_RUNTIME, projectRoot: ROOT_B }])
  })

  it('opens a remote project through its tunnel, as a folder path the URI accepts', async () => {
    surface.registerWorkbenchHandlers(undefined, () => ({ host: 'officepc', root: 'C:/api' }))
    try {
      const viewId = await surface.openSurface(shell as never, { projectId: 'remote' }, undefined)
      const view = lastView()
      view.webContents.emit('did-finish-load')
      expect(acquireRemoteWorkbenchRuntime).toHaveBeenCalledWith('officepc', 'C:/api')
      expect(acquireWorkbenchRuntime).not.toHaveBeenCalled()
      expect(view.webContents.sent).toEqual([
        { ...RUNTIME, remoteAuthority: '127.0.0.1:48000', projectRoot: '/C:/api' },
      ])

      await surface.closeSurface(shell as never, viewId)
      view.webContents.destroyed = true
      expect(releaseRemoteWorkbenchRuntime).not.toHaveBeenCalled()

      const place = { host: 'officepc', root: 'C:/api' }
      await surface.closeWorkbenchProject(place)
      surface.reopenWorkbenchProject(place)
      expect(releaseRemoteWorkbenchRuntime).toHaveBeenCalledWith('officepc', 'C:/api')
      expect(releaseWorkbenchRuntime).not.toHaveBeenCalled()
    } finally {
      surface.registerWorkbenchHandlers(undefined)
    }
  })

  /*
   * What the test above could not catch, reported from a real Windows machine.
   *
   * The conversion used to read `host !== LOCAL_HOST && /^[A-Za-z]:\//`, so the
   * ordinary case on that platform — a project on this machine — reached
   * `URI.from` with no leading slash and the workbench threw `[UriError]` out
   * of `prepareWorkbench`. No editor appeared at all, and the remote test
   * passed the whole time because the remote arm was the only one written.
   *
   * The backslashes matter as much as the slash: the old pattern demanded a
   * forward slash after the drive letter, so a native `C:\...` path failed the
   * test even on a remote host, where the branch was meant to be working.
   */
  it('closes a project whose view Electron has already torn down', async () => {
    const place = { host: LOCAL_HOST, root: root(`torn-down-${randomUUID()}`) }
    const viewId = await openAt(shell, place.root)
    const view = lastView()
    await surface.closeSurface(shell as never, viewId)
    Object.defineProperty(view, 'webContents', { value: undefined })

    await surface.closeWorkbenchProject(place)
    surface.reopenWorkbenchProject(place)
    expect(releaseWorkbenchRuntime).toHaveBeenCalledWith(place.root)
  })

  it('fails a project close whose release failed, and releases again on retry', async () => {
    const place = { host: 'officepc', root: 'C:/retry' }
    surface.registerWorkbenchHandlers(undefined, () => place)
    try {
      const viewId = await surface.openSurface(shell as never, { projectId: 'remote' }, undefined)
      const view = lastView()
      await surface.closeSurface(shell as never, viewId)
      view.webContents.destroyed = true

      releaseRemoteWorkbenchRuntime.mockRejectedValueOnce(new Error('tunnel stuck'))
      await expect(surface.closeWorkbenchProject(place)).rejects.toThrow('tunnel stuck')
      await expect(
        surface.openSurface(shell as never, { projectId: 'remote' }, undefined)
      ).rejects.toThrow(/closed or still closing/)

      await surface.closeWorkbenchProject(place)
      surface.reopenWorkbenchProject(place)
      expect(releaseRemoteWorkbenchRuntime).toHaveBeenCalledTimes(2)
    } finally {
      surface.registerWorkbenchHandlers(undefined)
    }
  })

  it('gives a local Windows root the leading slash, not only a remote one', async () => {
    surface.registerWorkbenchHandlers(undefined, () => ({
      host: LOCAL_HOST,
      root: 'C:\\Users\\me\\project',
    }))
    try {
      await surface.openSurface(shell as never, { projectId: 'local-windows' }, undefined)
      const view = lastView()
      view.webContents.emit('did-finish-load')
      expect(view.webContents.sent).toEqual([
        { ...LOCAL_RUNTIME, projectRoot: '/C:/Users/me/project' },
      ])
    } finally {
      surface.registerWorkbenchHandlers(undefined)
    }
  })

  it('sends an agent edit to the editor on its host, and never to a local project at that root', async () => {
    surface.registerWorkbenchHandlers(undefined, () => ({ host: 'officepc', root: 'C:/api' }))
    try {
      const viewId = await surface.openSurface(shell as never, { projectId: 'remote' }, undefined)
      const view = lastView()
      const edit = {
        path: 'C:/api/src/Main.kt',
        baseVersion: 3,
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
        oldText: 'val',
        newText: 'var',
      }

      await expect(
        surface.requestWorkbenchEdit({ host: LOCAL_HOST, root: 'C:/api' }, edit)
      ).resolves.toMatchObject({ ok: false, refusal: 'no-editor' })
      expect(view.webContents.sent).toEqual([])

      const pending = surface.requestWorkbenchEdit({ host: 'officepc', root: 'C:/api' }, edit)
      expect(view.webContents.sent).toEqual([{ ...edit, requestId: expect.any(String) }])
      const [sent] = view.webContents.sent as { requestId: string }[]
      pushes.get(WORKBENCH_EDIT_RESULT_CHANNEL)?.(
        { sender: view.webContents },
        { requestId: sent?.requestId, ok: true, version: 4 }
      )
      await expect(pending).resolves.toEqual({ requestId: sent?.requestId, ok: true, version: 4 })

      await surface.closeSurface(shell as never, viewId)
    } finally {
      surface.registerWorkbenchHandlers(undefined)
    }
  })

  it('keeps the lease while surfaces close, and releases it with the project', async () => {
    const place = { host: LOCAL_HOST, root: root(`lease-${randomUUID()}`) }
    const first = await openAt(shell, place.root)
    const firstView = lastView()
    const second = await openAt(shell, place.root)
    const secondView = lastView()

    await surface.closeSurface(shell as never, first)
    firstView.webContents.destroyed = true
    // Still open elsewhere, so the project is still open. Releasing here would be
    // the refcount counting views again, one level in.
    expect(releaseWorkbenchRuntime).not.toHaveBeenCalled()

    await surface.closeSurface(shell as never, second)
    secondView.webContents.destroyed = true
    expect(releaseWorkbenchRuntime).not.toHaveBeenCalled()

    await surface.closeWorkbenchProject(place)
    surface.reopenWorkbenchProject(place)
    expect(releaseWorkbenchRuntime).toHaveBeenCalledWith(place.root)
  })

  it('does not leave a lease behind when the window went away mid-acquire', async () => {
    // A 76 MB fetch is long enough for a window to close underneath it, and a
    // lease for a project nobody opened would keep a server alive for nothing.
    const grant = await grantFor(shell, ROOT_B)
    /*
     * The *same* `WebContents`, marked destroyed — not a copy of it. A spread
     * produced a different object, which `redeem` refused as a foreign window
     * before the destroyed check was ever reached, so the test passed its
     * assertion for the wrong reason and proved nothing about the lease.
     */
    shell.destroyed = true
    await expect(surface.openSurface(shell as never, { grant }, undefined)).rejects.toThrow(
      /needs a window/
    )
    expect(releaseWorkbenchRuntime).toHaveBeenCalledWith(ROOT_B)
  })
})

describe('the window a surface reports on', () => {
  it('answers the pull with the owning window, and never with a claim', async () => {
    const grant = await grantFor(shell, ROOT_A)
    await surface.openSurface(shell as never, { grant }, undefined)
    const view = lastView()

    /*
     * The sender decides which surface is asked about, exactly as the connection
     * channel does — the request carries no view id, because a name a renderer
     * sends is a claim and a sender is a fact.
     */
    fakeWindow.focused = true
    expect(handlers.get(WORKBENCH_FOCUS_CHANNEL)?.({ sender: view.webContents })).toBe(true)

    fakeWindow.focused = false
    expect(handlers.get(WORKBENCH_FOCUS_CHANNEL)?.({ sender: view.webContents })).toBe(false)
  })

  it('pushes a change to that surface rather than leaving it to be asked', async () => {
    const grant = await grantFor(shell, ROOT_A)
    await surface.openSurface(shell as never, { grant }, undefined)
    const view = lastView()

    fakeWindow.focused = false
    fakeWindow.emit('blur')

    /*
     * The value, not the event: what the workbench does with this is recompute
     * whether to keep refreshing, and a push that carried "something changed"
     * would leave it to ask a question it is being told the answer to.
     */
    expect(view.webContents.sent).toEqual([false])
  })

  it('stops reporting on a window it no longer belongs to', async () => {
    const grant = await grantFor(shell, ROOT_A)
    await surface.openSurface(shell as never, { grant }, undefined)
    expect(fakeWindow.listeners.get('focus')).toHaveLength(1)

    surface.beginHandoff(shell as never, ROOT_A, new FakeWebContents() as never, 'detach')

    /*
     * A handoff leaves the surface owned by nobody until it lands in its new
     * window, and a subscription that survived the trip would go on reporting the
     * window the project was dragged *out of* — for the rest of the session,
     * silently, because the answer is a boolean and both values are legal.
     */
    expect(fakeWindow.listeners.get('focus')).toHaveLength(0)
    expect(fakeWindow.listeners.get('blur')).toHaveLength(0)
  })
})

/*
 * The renderer measures its placeholder in the shell's own CSS pixels, and a
 * zoomed shell's CSS pixel is not a device pixel. A rectangle sent through
 * unchanged put the native view wider and taller than its region — over the
 * Chorus column beside it — and because the zoom lasts the launch, nothing
 * reset it and resizing could not clear it.
 */
describe('a zoomed shell and a surface rectangle', () => {
  it('gives the view device pixels, and the factor to its own webContents', async () => {
    scale.stepScale(0)
    scale.stepScale(-1)
    scale.stepScale(-1)
    try {
      expect(scale.currentScale()).toBe(0.9)
      // Opened while the shell is already zoomed, so no change will fire for it.
      const viewId = await openAt(shell, ROOT_A)
      const view = lastView()
      expect(view.webContents.zoomFactor).toBe(0.9)

      surface.setSurfaceBounds(shell as never, viewId, { x: 100, y: 50, width: 400, height: 300 })
      expect(view.bounds).toEqual({ x: 90, y: 45, width: 360, height: 270 })

      // And the factor moving under a view that is already open.
      scale.stepScale(-1)
      expect(view.webContents.zoomFactor).toBe(0.85)
      scale.stepScale(1)
      expect(view.webContents.zoomFactor).toBe(0.9)
    } finally {
      scale.stepScale(0)
    }
  })
})

describe('the capture terminal env a surface is told', () => {
  const ENV = { name: 'EXPO_PUBLIC_API_BASE_URL', value: 'http://127.0.0.1:30100' }
  const pull = (sender: FakeWebContents, frame: unknown = sender.mainFrame): unknown =>
    handlers.get(WORKBENCH_TERMINAL_ENV_CHANNEL)?.({ sender, senderFrame: frame })

  const answering = (
    answer: (place: { readonly host: string; readonly root: string }) => typeof ENV | null
  ): WorkbenchTerminalEnvSource => ({
    current: answer,
    ensure: (place) => Promise.resolve(answer(place)),
  })

  it('answers each surface about its own project, decided by the sender', async () => {
    const asked: unknown[] = []
    surface.setWorkbenchTerminalEnvSource({
      current: () => null,
      ensure: (place) => {
        asked.push(place)
        return Promise.resolve(place.root === ROOT_A ? ENV : null)
      },
    })
    await openAt(shell, ROOT_A)
    const a = lastView()
    await openAt(shell, ROOT_B)
    const b = lastView()

    expect(await pull(a.webContents)).toEqual(ENV)
    expect(await pull(b.webContents)).toBeNull()
    expect(asked).toEqual([
      { host: LOCAL_HOST, root: ROOT_A },
      { host: LOCAL_HOST, root: ROOT_B },
    ])
  })

  it('waits for the listener before answering, and answers null when it cannot be had', async () => {
    let ready: (env: typeof ENV | null) => void = () => undefined
    let failing = false
    surface.setWorkbenchTerminalEnvSource({
      current: () => null,
      ensure: () =>
        failing
          ? Promise.reject(new Error('port in use'))
          : new Promise((resolve) => {
              ready = resolve
            }),
    })
    await openAt(shell, ROOT_A)
    const view = lastView()

    let answered: unknown = 'pending'
    const pulled = Promise.resolve(pull(view.webContents)).then((env) => {
      answered = env
    })
    await Promise.resolve()
    expect(answered).toBe('pending')
    ready(ENV)
    await pulled
    expect(answered).toEqual(ENV)

    failing = true
    expect(await pull(view.webContents)).toBeNull()
  })

  it('knows which local roots have an editor open', async () => {
    await openAt(shell, ROOT_A)

    expect(surface.hasWorkbenchSurface({ host: LOCAL_HOST, root: ROOT_A })).toBe(true)
    expect(surface.hasWorkbenchSurface({ host: LOCAL_HOST, root: ROOT_B })).toBe(false)
    expect(surface.hasWorkbenchSurface({ host: 'elsewhere', root: ROOT_A })).toBe(false)
  })

  it('refuses the shell, and any frame of a surface other than its main frame', async () => {
    surface.setWorkbenchTerminalEnvSource(answering(() => ENV))
    await openAt(shell, ROOT_A)
    const view = lastView()

    expect(() => pull(shell)).toThrow(/unknown workbench surface/)
    expect(() => pull(view.webContents, { processId: 1, frameToken: randomUUID() })).toThrow(
      /unknown workbench surface/
    )
    expect(() => pull(view.webContents, null)).toThrow(/unknown workbench surface/)
  })

  it('pushes every open surface its own current answer, without preparing anything', async () => {
    let capturing = false
    let ensured = 0
    surface.setWorkbenchTerminalEnvSource({
      current: (place) => (capturing && place.root === ROOT_A ? ENV : null),
      ensure: () => {
        ensured += 1
        return Promise.resolve(null)
      },
    })
    await openAt(shell, ROOT_A)
    const a = lastView()
    await openAt(shell, ROOT_B)
    const b = lastView()

    capturing = true
    surface.refreshWorkbenchTerminalEnv()
    capturing = false
    surface.refreshWorkbenchTerminalEnv()

    expect(a.webContents.sent).toEqual([ENV, null])
    expect(b.webContents.sent).toEqual([null, null])
    expect(ensured).toBe(0)
  })

  it('answers null, never a stale value, when no source is installed', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()

    surface.refreshWorkbenchTerminalEnv()
    expect(view.webContents.sent).toEqual([null])
    expect(await pull(view.webContents)).toBeNull()
  })
})

describe('the width a surface lays itself out at', () => {
  const placed = { x: 0, y: 0, width: 600, height: 400 }

  it('tells the surface once per change, and never for a repeat or an absence', async () => {
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()

    surface.setSurfaceBounds(shell as never, viewId, placed, 900)
    surface.setSurfaceBounds(shell as never, viewId, { ...placed, width: 300 }, 900)
    surface.setSurfaceBounds(shell as never, viewId, placed)
    surface.setSurfaceBounds(shell as never, viewId, placed, 1_100)

    expect(view.webContents.sentOn(WORKBENCH_LAYOUT_CHANNEL)).toEqual([900, 1_100])
    expect(view.bounds).toEqual(placed)
  })

  it('replays the last width to a document that loads after it was set', async () => {
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()

    view.webContents.emit('did-finish-load')
    surface.setSurfaceBounds(shell as never, viewId, placed, 900)
    view.webContents.emit('did-finish-load')

    expect(view.webContents.channels).toEqual([
      WORKBENCH_CONNECTION_CHANNEL,
      WORKBENCH_LAYOUT_CHANNEL,
      WORKBENCH_CONNECTION_CHANNEL,
      WORKBENCH_LAYOUT_CHANNEL,
    ])
    expect(view.webContents.sentOn(WORKBENCH_LAYOUT_CHANNEL)).toEqual([900, 900])
  })

  it('takes a width only from the window that owns the surface', async () => {
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()

    expect(() => {
      surface.setSurfaceBounds(new FakeWebContents() as never, viewId, placed, 900)
    }).toThrow(/belongs to this window/)
    expect(view.webContents.sentOn(WORKBENCH_LAYOUT_CHANNEL)).toEqual([])
  })

  it('refuses a width that is not a positive whole number at the boundary', async () => {
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()
    const setBounds = handlers.get('workbench:setBounds')

    for (const layoutWidth of [0, -10, 900.5, '900']) {
      await expect(
        Promise.resolve(setBounds?.({ sender: shell }, { viewId, rect: placed, layoutWidth }))
      ).rejects.toThrow(/Invalid request/)
    }
    await setBounds?.({ sender: shell }, { viewId, rect: placed, layoutWidth: 900 })

    expect(view.webContents.sentOn(WORKBENCH_LAYOUT_CHANNEL)).toEqual([900])
  })
})

describe('the activity bar a surface reports', () => {
  const report = (sender: FakeWebContents, width: unknown): void => {
    pushes.get(WORKBENCH_ACTIVITY_BAR_REPORT_CHANNEL)?.({ sender }, width)
  }
  const read = (sender: FakeWebContents, viewId: string): Promise<unknown> =>
    Promise.resolve(handlers.get('workbench:activityBar')?.({ sender }, { viewId }))

  it('tells only the owning window, and only when the width changes', async () => {
    const other = new FakeWebContents()
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()
    await openAt(other, ROOT_B)

    report(view.webContents, 48)
    report(view.webContents, 48)
    report(view.webContents, 36)

    expect(shell.sentOn(WORKBENCH_ACTIVITY_BAR_PUSH_CHANNEL)).toEqual([
      { viewId, width: 48 },
      { viewId, width: 36 },
    ])
    expect(other.sentOn(WORKBENCH_ACTIVITY_BAR_PUSH_CHANNEL)).toEqual([])
  })

  it('drops a malformed report and one from a sender that is no surface', async () => {
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()

    for (const wrong of [-1, 47.5, '48', Number.NaN, null]) report(view.webContents, wrong)
    report(new FakeWebContents(), 48)

    expect(shell.sentOn(WORKBENCH_ACTIVITY_BAR_PUSH_CHANNEL)).toEqual([])
    await expect(read(shell, viewId)).resolves.toEqual({ width: 0 })
  })

  it('answers the read for the owner, and for the window the surface is handed to', async () => {
    surface.registerWorkbenchHandlers(undefined, (projectId) => {
      if (projectId === 'a') return { host: LOCAL_HOST, root: ROOT_A }
      throw new Error(`No project with id ${projectId}`)
    })
    try {
      const destination = new FakeWebContents()
      const viewId = await openAt(shell, ROOT_A)
      const view = lastView()

      report(view.webContents, 48)
      await expect(read(shell, viewId)).resolves.toEqual({ width: 48 })
      await expect(read(new FakeWebContents(), viewId)).rejects.toThrow(/belongs to this window/)

      surface.beginHandoff(shell as never, ROOT_A, destination as never, 'detach')
      report(view.webContents, 36)

      expect(shell.sentOn(WORKBENCH_ACTIVITY_BAR_PUSH_CHANNEL)).toEqual([{ viewId, width: 48 }])
      await expect(read(shell, viewId)).rejects.toThrow(/belongs to this window/)

      await surface.openSurface(destination as never, { projectId: 'a' }, undefined)
      await expect(read(destination, viewId)).resolves.toEqual({ width: 36 })
    } finally {
      surface.registerWorkbenchHandlers(undefined)
    }
  })
})

describe('scrolling a row from its native editor', () => {
  it('forwards signed deltas only from a known surface to its owner', async () => {
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()
    const request = pushes.get(WORKBENCH_ROW_SCROLL_REQUEST_CHANNEL)

    request?.({ sender: view.webContents }, 120)
    request?.({ sender: view.webContents }, -40)
    request?.({ sender: new FakeWebContents() }, 600)
    for (const wrong of [0, '120', Number.NaN, Number.POSITIVE_INFINITY, null]) {
      request?.({ sender: view.webContents }, wrong)
    }

    expect(shell.sentOn(WORKBENCH_ROW_SCROLL_PUSH_CHANNEL)).toEqual([
      { viewId, delta: 120 },
      { viewId, delta: -40 },
    ])
  })

  it('does not scroll a source window during a handoff', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()
    surface.beginHandoff(shell as never, ROOT_A, new FakeWebContents() as never, 'detach')

    pushes.get(WORKBENCH_ROW_SCROLL_REQUEST_CHANNEL)?.({ sender: view.webContents }, 100)

    expect(shell.sentOn(WORKBENCH_ROW_SCROLL_PUSH_CHANNEL)).toEqual([])
  })
})

describe('bringing an editor back into view', () => {
  it('asks the owning window when the surface asks, and ignores a sender that is no surface', async () => {
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()

    pushes.get(WORKBENCH_ROW_REQUEST_CHANNEL)?.({ sender: view.webContents })
    pushes.get(WORKBENCH_ROW_REQUEST_CHANNEL)?.({ sender: new FakeWebContents() })

    expect(shell.sentOn(WORKBENCH_ROW_REVEAL_PUSH_CHANNEL)).toEqual([{ viewId }])
  })

  it('stays quiet while the surface is between windows', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()

    surface.beginHandoff(shell as never, ROOT_A, new FakeWebContents() as never, 'detach')
    pushes.get(WORKBENCH_ROW_REQUEST_CHANNEL)?.({ sender: view.webContents })

    expect(shell.sentOn(WORKBENCH_ROW_REVEAL_PUSH_CHANNEL)).toEqual([])
  })

  it('leaves the row where it is for a file the transcript opens', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()

    const pending = surface.requestWorkbenchReveal(ROOT_A, {
      path: join(ROOT_A, 'a.ts'),
      line: 3,
      column: null,
    })
    expect(shell.sentOn(WORKBENCH_ROW_REVEAL_PUSH_CHANNEL)).toEqual([])

    const [sent] = view.webContents.sent as { requestId: string }[]
    pushes.get(WORKBENCH_REVEAL_RESULT_CHANNEL)?.(
      { sender: view.webContents },
      { requestId: sent?.requestId, ok: true }
    )
    await expect(pending).resolves.toEqual({ requestId: sent?.requestId, ok: true })
  })

  it('leaves the row where it is for an agent applying an edit', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()
    const edit = {
      path: join(ROOT_A, 'a.ts'),
      baseVersion: 1,
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
      oldText: 'a',
      newText: 'b',
    }

    const pending = surface.requestWorkbenchEdit({ host: LOCAL_HOST, root: ROOT_A }, edit)
    expect(shell.sentOn(WORKBENCH_ROW_REVEAL_PUSH_CHANNEL)).toEqual([])

    const [sent] = view.webContents.sent as { requestId: string }[]
    pushes.get(WORKBENCH_EDIT_RESULT_CHANNEL)?.(
      { sender: view.webContents },
      { requestId: sent?.requestId, ok: true, version: 2 }
    )
    await expect(pending).resolves.toEqual({ requestId: sent?.requestId, ok: true, version: 2 })
    expect(shell.sentOn(WORKBENCH_ROW_REVEAL_PUSH_CHANNEL)).toEqual([])
  })

  it('leaves the row where it is for a proposed diff and for closing one', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()
    const diff = { approvalId: 'approval-1', path: 'a.ts', before: 'a', proposed: 'b' }

    const opened = surface.requestWorkbenchAskDiff(ROOT_A, diff)
    const closed = surface.requestWorkbenchAskDiff(ROOT_A, { ...diff, close: true })
    expect(shell.sentOn(WORKBENCH_ROW_REVEAL_PUSH_CHANNEL)).toEqual([])

    for (const sent of view.webContents.sent as { requestId: string }[]) {
      pushes.get(WORKBENCH_ASK_DIFF_RESULT_CHANNEL)?.(
        { sender: view.webContents },
        { requestId: sent.requestId, ok: true }
      )
    }
    await expect(opened).resolves.toMatchObject({ ok: true })
    await expect(closed).resolves.toMatchObject({ ok: true })
  })
})

describe('a native participant under an overlay', () => {
  it('conceals before an overlay capture and on a heartbeat, never on a show', async () => {
    const viewId = await openAt(shell, ROOT_A)
    const order: string[] = []
    const view = {
      webContents: {
        isDestroyed: () => false,
        capturePage: () => {
          order.push('capture')
          return Promise.resolve(captureStill())
        },
      },
      visible: true,
      setVisible(next: boolean): void {
        this.visible = next
      },
      getVisible(): boolean {
        return this.visible
      },
    }
    const unregister = surface.registerOverlayParticipant({
      id: 'browser-1',
      owner: shell as never,
      view: view as never,
      shown: () => true,
      conceal: () => {
        order.push('conceal')
      },
    })
    const setVisible = handlers.get('workbench:setVisible')
    try {
      await setVisible?.({ sender: shell }, { visible: false })
      expect(order).toEqual(['conceal', 'capture', 'conceal'])
      expect(view.visible).toBe(false)
      await setVisible?.({ sender: shell }, { visible: false, heartbeat: true })
      expect(order).toEqual(['conceal', 'capture', 'conceal', 'conceal', 'conceal'])
      await setVisible?.({ sender: shell }, { visible: true })
      expect(view.visible).toBe(true)
      await setVisible?.({ sender: shell }, { visible: false, viewId })
      await setVisible?.({ sender: shell }, { visible: true, viewId })
      expect(order).toEqual(['conceal', 'capture', 'conceal', 'conceal', 'conceal'])
    } finally {
      await setVisible?.({ sender: shell }, { visible: true })
      unregister()
    }
  })

  it('conceals a hold begun during the overlay capture before the view is hidden', async () => {
    await openAt(shell, ROOT_A)
    const order: string[] = []
    let holding = false
    let finish: () => void = () => undefined
    const view = {
      webContents: {
        isDestroyed: () => false,
        capturePage: () => {
          order.push('capture')
          return new Promise<ReturnType<typeof captureStill>>((resolve) => {
            finish = () => {
              resolve(captureStill())
            }
          })
        },
      },
      visible: true,
      setVisible(next: boolean): void {
        this.visible = next
        order.push(`visible:${String(next)}`)
      },
      getVisible(): boolean {
        return this.visible
      },
    }
    const unregister = surface.registerOverlayParticipant({
      id: 'browser-2',
      owner: shell as never,
      view: view as never,
      shown: () => true,
      conceal: () => {
        order.push(holding ? 'conceal:holding' : 'conceal')
        holding = false
      },
    })
    const setVisible = handlers.get('workbench:setVisible')
    try {
      order.length = 0
      const hiding = setVisible?.({ sender: shell }, { visible: false })
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
      expect(order).toEqual(['conceal', 'capture'])
      holding = true
      finish()
      await hiding
      expect(order).toEqual(['conceal', 'capture', 'conceal:holding', 'visible:false'])
      expect(holding).toBe(false)
    } finally {
      await setVisible?.({ sender: shell }, { visible: true })
      unregister()
    }
  })
})

describe('reopening a closed project from its editor', () => {
  const freshPlace = (): { host: string; root: string } => ({
    host: LOCAL_HOST,
    root: root(`closing-${randomUUID()}`),
  })

  async function withProjects(
    place: { host: string; root: string },
    openProject: ((projectId: string) => void) | undefined,
    run: () => Promise<void>
  ): Promise<void> {
    surface.registerWorkbenchHandlers(
      undefined,
      (projectId) => {
        if (projectId === 'a') return place
        throw new Error(`No project with id ${projectId}`)
      },
      openProject
    )
    try {
      await run()
    } finally {
      surface.registerWorkbenchHandlers(undefined)
      surface.reopenWorkbenchProject(place)
    }
  }

  it('still refuses a closed project when nothing reopens it', async () => {
    const place = freshPlace()
    await withProjects(place, undefined, async () => {
      await surface.closeWorkbenchProject(place)
      await expect(
        surface.openSurface(shell as never, { projectId: 'a' }, undefined)
      ).rejects.toThrow(/closed or still closing/)
      expect(acquireWorkbenchRuntime).not.toHaveBeenCalled()
    })
  })

  it('reopens a closed project through the open callback before the closed guard', async () => {
    const place = freshPlace()
    const opened: string[] = []
    await withProjects(
      place,
      (projectId) => {
        opened.push(projectId)
        surface.reopenWorkbenchProject(place)
      },
      async () => {
        await surface.closeWorkbenchProject(place)
        await expect(
          surface.openSurface(shell as never, { projectId: 'a' }, undefined)
        ).resolves.toEqual(expect.any(String))
        expect(opened).toEqual(['a'])
        expect(acquireWorkbenchRuntime).toHaveBeenCalledWith(place.root)
      }
    )
  })

  it('acquires nothing when the project refuses to reopen', async () => {
    const place = freshPlace()
    const views = constructed.length
    await withProjects(
      place,
      () => {
        throw new Error('This project is closing; retry its close action before reopening it')
      },
      async () => {
        await expect(
          surface.openSurface(shell as never, { projectId: 'a' }, undefined)
        ).rejects.toThrow(/retry its close action/)
        expect(acquireWorkbenchRuntime).not.toHaveBeenCalled()
        expect(constructed).toHaveLength(views)
      }
    )
  })

  it('runs no lifecycle transition for a window or a project it refuses', async () => {
    const place = freshPlace()
    const openProject = vi.fn((_projectId: string) => undefined)
    await withProjects(place, openProject, async () => {
      surface.setDetachedAccessPredicate(() => false)
      await expect(
        surface.openSurface(shell as never, { projectId: 'a' }, undefined)
      ).rejects.toThrow(/is open in this window/)
      surface.setDetachedAccessPredicate(null)
      await expect(
        surface.openSurface(shell as never, { projectId: 'missing' }, undefined)
      ).rejects.toThrow(/No project with id missing/)
      expect(openProject).not.toHaveBeenCalled()
    })
  })

  it('leaves a chooser grant to the closed guard without reopening the project', async () => {
    const place = freshPlace()
    const openProject = vi.fn((_projectId: string) => undefined)
    await withProjects(place, openProject, async () => {
      const grant = await grantFor(shell, place.root)
      await surface.closeWorkbenchProject(place)
      await expect(surface.openSurface(shell as never, { grant }, undefined)).rejects.toThrow(
        /closed or still closing/
      )
      expect(openProject).not.toHaveBeenCalled()
    })
  })
})
