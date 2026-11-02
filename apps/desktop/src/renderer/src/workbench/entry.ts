import { getService, IConfigurationService, initialize } from '@codingame/monaco-vscode-api'
import { registerServiceInitializePreParticipant } from '@codingame/monaco-vscode-api/lifecycle'
import { ConfigurationTarget } from '@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration'
import { IWorkspaceContextService } from '@codingame/monaco-vscode-api/vscode/vs/platform/workspace/common/workspace.service'
import { IURLService } from '@codingame/monaco-vscode-api/vscode/vs/platform/url/common/url.service'
import { ILogService } from '@codingame/monaco-vscode-api/vscode/vs/platform/log/common/log.service'
import { IStorageService } from '@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage.service'
import {
  StorageScope,
  StorageTarget,
  WillSaveStateReason,
} from '@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage'
import { RunOnceScheduler } from '@codingame/monaco-vscode-api/vscode/vs/base/common/async'
import { DisposableStore } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { IDialogService } from '@codingame/monaco-vscode-api/vscode/vs/platform/dialogs/common/dialogs.service'
import { IQuickInputService } from '@codingame/monaco-vscode-api/vscode/vs/platform/quickinput/common/quickInput.service'
import { Parts } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService'
import { IWorkbenchLayoutService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService.service'
import { DEFAULT_WORKSPACE_WINDOW_SIZE } from '@codingame/monaco-vscode-api/vscode/vs/platform/window/common/window'
import { IWebviewService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/webview/browser/webview.service'
import type { IWebview } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/webview/browser/webview'
import type { IMouseWheelEvent } from '@codingame/monaco-vscode-api/vscode/vs/base/browser/mouseEvent'
import { prepareWorkbench } from './services.js'
import { serveWorkbenchLifecycle } from './lifecycle.js'
import { reportEditorContext } from './context.js'
import { serveWorkbenchEdits, serveWorkbenchReveal, serveWorkbenchSnapshot } from './edit.js'
import { serveAskDiff } from './ask-diff.js'
import { registerInlineCompletions, startLanguageServiceSampling } from './completion.js'
import { installGateHandle } from './gate-handle.js'
import { announceSharedExtensionScope } from './extension-scope.js'
import { registerWorkbenchWorkers } from './workers.js'
import { persistUserSettings, restoreUserSettings } from './user-settings.js'
import { restoreBrowserExtensions, synchronizeBrowserExtensions } from './browser-extensions.js'
import { seedWindowFocus } from './window-focus.js'
import {
  parseSideBarLayout,
  ChorusStorageService,
  flushWorkbenchStorage,
  stopWorkbenchStorageRetries,
  SHARED_SIDE_BAR_LAYOUT_KEY,
  SIDE_BAR_DEFAULT_WIDTH,
  SIDE_BAR_SIZE_KEY,
} from './storage.js'
import { bindTerminalEnv, seedTerminalEnv, type TerminalEnvMemory } from './terminal-env.js'
import {
  addsIframe,
  horizontalRowWheel,
  isCropped,
  leftActivityBarWidth,
  trackModifiers,
  watchWheelSources,
  type WheelModifiers,
} from './viewport.js'

async function forwardWebviewWheels(
  container: HTMLElement,
  modifiers: () => WheelModifiers
): Promise<void> {
  const webviews = await getService(IWebviewService)
  const watch = watchWheelSources<IWebview, IMouseWheelEvent>((event) => {
    if (container.style.width === '') return
    const delta = horizontalRowWheel(
      { deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, ...modifiers() },
      container.clientWidth
    )
    if (delta !== 0) window.chorusWorkbench.requestRowScroll(delta)
  })
  const mounted = new MutationObserver((records) => {
    if (addsIframe(records)) watch(webviews.webviews)
  })
  mounted.observe(document.body, { childList: true, subtree: true })
  watch(webviews.webviews)
}

async function watchWorkbenchChrome(
  container: HTMLElement,
  revealIfCropped: () => void
): Promise<void> {
  const layout = await getService(IWorkbenchLayoutService)
  let reported: number | null = null
  const reportActivityBar = (): void => {
    const bar = layout.isVisible(Parts.ACTIVITYBAR_PART)
      ? layout.getContainer(window, Parts.ACTIVITYBAR_PART)
      : undefined
    const width = leftActivityBarWidth(
      bar?.getBoundingClientRect() ?? null,
      container.getBoundingClientRect().left
    )
    if (width === reported) return
    reported = width
    window.chorusWorkbench.reportActivityBar(width)
  }
  layout.onDidLayoutMainContainer(reportActivityBar)
  layout.onDidChangePartVisibility(reportActivityBar)
  const activityBar = layout.getContainer(window, Parts.ACTIVITYBAR_PART)
  activityBar?.addEventListener('pointerdown', revealIfCropped, true)
  if (activityBar !== undefined) {
    const resized = new ResizeObserver(reportActivityBar)
    resized.observe(activityBar)
  }
  reportActivityBar()

  const quickInput = await getService(IQuickInputService)
  quickInput.onShow(revealIfCropped)
  const dialogs = await getService(IDialogService)
  dialogs.onWillShowDialog(revealIfCropped)
}

async function saveWorkbenchLayout(logs: ILogService): Promise<void> {
  const layout = await getService(IWorkbenchLayoutService)
  const storage = await getService(IStorageService)
  const save = new RunOnceScheduler(() => {
    storage.flush().catch((error: unknown) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      logs.error(`Chorus: workbench layout could not be saved — ${detail}`)
    })
  }, 200)
  const settle = (): void => {
    save.schedule()
  }
  const panelPartId: string = Parts.PANEL_PART
  layout.onDidChangePartVisibility((event) => {
    if (event.partId === panelPartId) settle()
  })
  layout.onDidChangePanelPosition(settle)
  const panel = layout.getContainer(window, Parts.PANEL_PART)
  if (panel !== undefined) {
    const resized = new ResizeObserver(settle)
    resized.observe(panel)
  }

  const savedWidth = Number(storage.get(SIDE_BAR_SIZE_KEY, StorageScope.PROFILE))
  let sideBarLayout = parseSideBarLayout(
    storage.get(SHARED_SIDE_BAR_LAYOUT_KEY, StorageScope.PROFILE)
  ) ?? {
    width: Number.isFinite(savedWidth) && savedWidth > 0 ? savedWidth : SIDE_BAR_DEFAULT_WIDTH,
    hidden: !layout.isVisible(Parts.SIDEBAR_PART),
  }
  let observedWidth = layout.getSize(Parts.SIDEBAR_PART).width
  let containerWidth = layout.mainContainerDimension.width
  let applyingSideBarLayout = false
  const applySideBarLayout = (): void => {
    if (applyingSideBarLayout) return
    applyingSideBarLayout = true
    try {
      if (layout.isVisible(Parts.SIDEBAR_PART) === sideBarLayout.hidden) {
        layout.setPartHidden(sideBarLayout.hidden, Parts.SIDEBAR_PART)
      }
      if (!sideBarLayout.hidden) {
        const size = layout.getSize(Parts.SIDEBAR_PART)
        if (size.width !== sideBarLayout.width) {
          layout.setSize(Parts.SIDEBAR_PART, { ...size, width: sideBarLayout.width })
        }
      }
    } finally {
      observedWidth = layout.getSize(Parts.SIDEBAR_PART).width
      containerWidth = layout.mainContainerDimension.width
      applyingSideBarLayout = false
    }
  }
  const storeSideBarLayout = (): void => {
    storage.store(
      SHARED_SIDE_BAR_LAYOUT_KEY,
      JSON.stringify(sideBarLayout),
      StorageScope.PROFILE,
      StorageTarget.MACHINE
    )
    settle()
  }
  const sideBarPartId: string = Parts.SIDEBAR_PART
  layout.onDidChangePartVisibility((event) => {
    if (event.partId !== sideBarPartId || applyingSideBarLayout) return
    if (sideBarLayout.hidden === !event.visible) return
    sideBarLayout = { ...sideBarLayout, hidden: !event.visible }
    applySideBarLayout()
    storeSideBarLayout()
  })
  layout.onDidLayoutMainContainer(() => {
    if (applyingSideBarLayout || containerWidth === layout.mainContainerDimension.width) return
    applySideBarLayout()
  })
  const changes = new DisposableStore()
  changes.add(
    storage.onDidChangeValue(
      StorageScope.PROFILE,
      SHARED_SIDE_BAR_LAYOUT_KEY,
      changes
    )((event) => {
      if (!event.external) return
      const shared = parseSideBarLayout(
        storage.get(SHARED_SIDE_BAR_LAYOUT_KEY, StorageScope.PROFILE)
      )
      if (shared === undefined) return
      sideBarLayout = shared
      applySideBarLayout()
    })
  )
  applySideBarLayout()
  const sideBar = layout.getContainer(window, Parts.SIDEBAR_PART)
  if (sideBar !== undefined) {
    const resized = new ResizeObserver(() => {
      if (applyingSideBarLayout || !layout.isVisible(Parts.SIDEBAR_PART)) return
      const width = layout.getSize(Parts.SIDEBAR_PART).width
      if (!Number.isFinite(width) || width <= 0 || width === observedWidth) return
      observedWidth = width
      sideBarLayout = { ...sideBarLayout, width }
      storeSideBarLayout()
    })
    resized.observe(sideBar)
  }
}

function holdUsableRoot(container: HTMLElement): () => void {
  const usable = (size: number): boolean => Number.isFinite(size) && size > 0
  let width = usable(screen.availWidth) ? screen.availWidth : DEFAULT_WORKSPACE_WINDOW_SIZE.width
  let height = usable(screen.availHeight)
    ? screen.availHeight
    : DEFAULT_WORKSPACE_WINDOW_SIZE.height
  return () => {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    if (usable(viewportWidth)) width = viewportWidth
    if (usable(viewportHeight)) height = viewportHeight
    container.style.minWidth =
      container.style.width === '' && !usable(viewportWidth) ? `${String(width)}px` : ''
    container.style.minHeight = usable(viewportHeight) ? '' : `${String(height)}px`
  }
}

/**
 * One workbench, in one document, in one process.
 *
 * The library initialises once per JavaScript realm and cannot be unloaded —
 * `checkServicesNotInitialized` throws on a second `initialize` in the same
 * global. N surfaces work because N `WebContentsView`s are N realms in N
 * processes, so the module-level singleton cannot be shared even by accident.
 * This file must therefore never pretend it can re-initialise.
 *
 * `window.vscodeWindow` is deliberately never set. The library's patch reads
 * `export const mainWindow = (window.vscodeWindow ?? window)`, and setting it to
 * a parent is what makes VS Code append its `data-vscode` head elements into a
 * shared document — where the documented teardown,
 * `document.querySelectorAll('[data-vscode]').forEach(el => el.remove())`, genuinely
 * does reach a sibling. Left unset, `mainWindow` is this document's own window,
 * the tagged elements land in this document's own head, and a cleanup running in
 * this realm cannot see another surface's elements. That hazard is designed out
 * rather than mitigated, and the cost of designing it out is zero — Chorus has no
 * use for parent-DOM integration, because each surface is its own top-level
 * `webContents` in which `window.vscodeWindow` has nothing to point at.
 */
async function main(): Promise<void> {
  /*
   * The one thing this document is told, and it is told it by main.
   *
   * Never a query string: the shell would have to hold the descriptor to write
   * one, and a URL parameter is not a variable that stays in memory — it lands in
   * session history and in any devtools recording, permanently. There is no
   * secret in this slice's descriptor yet, and the mechanism is still the one
   * that will carry the connection token in step 2, so it is built now rather
   * than retrofitted around one.
   */
  const connection = await window.chorusWorkbench.connection()

  /*
   * Before the container, before the services, and before `initialize` — E5.
   *
   * User settings and the browser-extension registry have to exist in the
   * user-data provider by the time services read them inside `initialize`.
   * Their restore helpers enforce that ordering through `initFile`, so getting
   * this wrong is loud rather than a workbench that quietly starts empty.
   *
   * A profile that has never stored settings answers `null` and nothing is
   * seeded, which is what leaves Code-OSS's own defaults in place.
   */
  await restoreUserSettings(await window.chorusWorkbench.readUserSettings())
  await restoreBrowserExtensions(await window.chorusWorkbench.readBrowserExtensions())

  /*
   * And for the same reason, before `initialize` — Phase 3.
   *
   * The host service the overrides pass a focus getter to is constructed inside
   * `initialize`, so a value seeded afterwards would be a getter that had already
   * been read. Seeding first means the first read is the true one, and there is
   * no window in which the workbench believes a wrong answer.
   *
   * It does not throw into this path: see `window-focus.ts` for why a failed
   * focus read must not be able to stop a workbench from opening.
   */
  await seedWindowFocus()
  await seedTerminalEnv()

  const container = document.createElement('div')
  container.className = 'workbench-root'
  document.body.replaceChildren(container)
  const holdRoot = holdUsableRoot(container)
  holdRoot()
  window.addEventListener('resize', holdRoot)

  window.chorusWorkbench.onLayoutWidth((width) => {
    const next = `${String(width)}px`
    if (container.style.width === next) return
    container.style.width = next
    window.dispatchEvent(new Event('resize'))
  })
  const revealIfCropped = (): void => {
    if (isCropped(window.innerWidth, container.clientWidth)) {
      window.chorusWorkbench.requestRowReveal()
    }
  }
  const modifiers = trackModifiers()
  window.addEventListener(
    'keydown',
    (event) => {
      modifiers.update(event)
    },
    true
  )
  window.addEventListener(
    'keyup',
    (event) => {
      modifiers.update(event)
    },
    true
  )
  window.addEventListener('blur', modifiers.reset)
  window.addEventListener(
    'wheel',
    (event) => {
      if (container.style.width === '' || event.defaultPrevented) return
      const delta = horizontalRowWheel(event, container.clientWidth)
      if (delta === 0) return
      event.stopPropagation()
      window.chorusWorkbench.requestRowScroll(delta)
    },
    { capture: true, passive: false }
  )

  /*
   * Before `initialize`, because a service that resolves a worker during startup
   * reads `MonacoEnvironment` off `globalThis` at that moment — there is no
   * registry to add to afterwards, only a global to have set in time.
   */
  registerWorkbenchWorkers()

  registerServiceInitializePreParticipant(async (accessor) => {
    const configuration = accessor.get(IConfigurationService)
    const workspace = accessor.get(IWorkspaceContextService)
    const terminalLogs = accessor.get(ILogService)
    await workspace.getCompleteWorkspace()
    bindTerminalEnv({
      read: (key) => configuration.inspect<TerminalEnvMemory>(key).memoryValue,
      write: (key, memory) => configuration.updateValue(key, memory, ConfigurationTarget.MEMORY),
      watch: (listener) => {
        configuration.onDidChangeConfiguration((event) => {
          listener((key) => event.affectsConfiguration(key))
        })
      },
      fail: (error) => {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
        terminalLogs.error(`Chorus: capture terminal environment could not be applied — ${detail}`)
      },
    })
  })

  const { services, options, env } = prepareWorkbench(connection)
  window.addEventListener('pagehide', stopWorkbenchStorageRetries, { once: true })
  window.chorusWorkbench.onStorageFlushRequest(async () => {
    const storage = await getService(IStorageService)
    if (storage instanceof ChorusStorageService) {
      await storage.shutdownStorage()
      return
    }
    await storage.flush(WillSaveStateReason.SHUTDOWN).catch(() => undefined)
    await flushWorkbenchStorage()
  })
  await initialize(services, container, options, env)
  await serveWorkbenchLifecycle(connection)

  /*
   * After `initialize`, because the file service does not exist before it. Not
   * awaited into the startup path any further than resolving the service: a
   * failure to subscribe must not stop a workbench that is otherwise up, and it
   * reaches the same failure element as everything else through `main`'s catch.
   */
  await persistUserSettings((text) => window.chorusWorkbench.writeUserSettings(text))
  await synchronizeBrowserExtensions(
    (text) => window.chorusWorkbench.writeBrowserExtensions(text),
    (handler) => {
      window.chorusWorkbench.onBrowserExtensionsChanged(handler)
    }
  )

  /*
   * OAuth callbacks, handed in by main.
   *
   * After `initialize` for the same reason as everything else here — the service
   * does not exist before it. `IURLService.open` is what VS Code's own protocol
   * handler calls, so an extension that registered a URI handler receives this
   * exactly as it would in a desktop VS Code; nothing here knows or cares which
   * extension is waiting.
   */
  const urls = await getService(IURLService)
  window.chorusWorkbench.onUrl((url) => {
    void urls.open(URI.parse(url))
  })

  /*
   * C-063's disclosure, and the condition on which the shared scope was accepted.
   * Same placement rule as the line above: after `initialize`, because the
   * services do not exist before it.
   */
  await announceSharedExtensionScope()

  /*
   * Phase 6d. Registered after the workbench is initialized, because resolving a
   * model needs the services to exist — but before anything can ask, since main
   * has no way to know when this document became ready and a request that
   * arrives early would simply have no listener.
   *
   * **Before the reporting setup, and that ordering is defensive.** These two
   * were registered after it, so anything thrown while establishing the push —
   * a service that will not resolve, a Node global reached from a browser bundle,
   * which has happened — took the Send-time handlers down with it. The two
   * failures then compound: no context is pushed *and* no snapshot can be
   * requested, which reads as "the editor is not connected" rather than as one
   * thing being broken.
   */
  serveWorkbenchEdits(connection.projectRoot)
  serveWorkbenchSnapshot(connection.projectRoot)
  serveAskDiff(connection.remoteAuthority)
  serveWorkbenchReveal(connection.remoteAuthority)

  /*
   * Phase 6 slice 6a. After `initialize` like the two above, and given the root
   * from the descriptor so the relativising happens here — no path crosses back
   * to main.
   *
   * Not awaited into the startup path: a failure to establish the push must not
   * stop a workbench that is otherwise up, and — since the handlers above are
   * already registered — Send still works from the snapshot alone.
   */
  /*
   * **Caught so the surface survives it, logged so it is not invisible.**
   *
   * The catch is deliberate and stays: the handlers above are already
   * registered, so a failure here costs the live pill and leaves Send working
   * from the snapshot. What it must not do is cost the *evidence* — this was
   * `.catch(() => undefined)`, and a `ReferenceError` thrown while establishing
   * the push then looked exactly like an editor with nothing open. Two separate
   * investigations began by re-deriving from a symptom what one line would have
   * said outright.
   *
   * `ILogService`, not `console`: it is the workbench's own channel, it reaches
   * the Output view and the log file, and the renderer is not allowed `console`.
   * Stringified here rather than passed as an argument, so the stack survives
   * whichever logger is attached.
   */
  const logs = await getService(ILogService)
  await watchWorkbenchChrome(container, revealIfCropped).catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    logs.error(`Chorus: workbench viewport reporting failed to start — ${detail}`)
  })
  await saveWorkbenchLayout(logs).catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    logs.error(`Chorus: workbench layout saving failed to start — ${detail}`)
  })
  await forwardWebviewWheels(container, modifiers.current).catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    logs.error(`Chorus: webview swipe forwarding failed to start — ${detail}`)
  })
  await reportEditorContext(connection.projectRoot).catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    logs.error(`Chorus: editor context reporting failed to start — ${detail}`)
  })
  await registerInlineCompletions(connection.projectRoot).catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    logs.error(`Chorus: inline completions failed to register — ${detail}`)
  })

  /*
   * A driver's handle on this editor, and **only** under the gate's own
   * condition.
   *
   * `workspaceTrust: 'waived'` is set by main solely when the app is unpackaged
   * *and* the E2E root seed is in the environment — both, never either, and
   * neither reachable from a renderer. It is the flag the trust waiver already
   * rides on, so this adds no new way in; a packaged app has no `workspaceTrust`
   * field at all and this branch cannot run.
   *
   * It exists because the editor-context chain could not be proved end to end
   * without opening a file, and every other route into this document — clicking
   * a measured rectangle in the explorer, driving quick open by keystroke — is
   * either refused on review or so indirect that a failure says nothing about
   * the thing under test.
   */
  if (connection.workspaceTrust === 'waived') {
    await installGateHandle(connection.projectRoot)
    void startLanguageServiceSampling()
  }
}

/*
 * A failure goes into the document, not into the console.
 *
 * Partly because the renderer may not use `console`, and partly because the
 * console is the wrong channel for it: reading another target's console over the
 * debugger needs `Runtime.enable`, which this repository already records as
 * breaking sandboxed renderers created afterwards. An element the gate can query
 * is legible to a person looking at the surface *and* to the driver, and neither
 * has to be enabled first.
 */
void main().catch((error: unknown) => {
  const failure = document.createElement('pre')
  failure.className = 'workbench-failure'
  failure.textContent = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : 'failed'
  document.body.replaceChildren(failure)
})
