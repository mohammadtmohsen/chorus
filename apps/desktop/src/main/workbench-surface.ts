import { LOCAL_HOST } from '@chorus/event-store'
import { ownProcessTree, type OwnedProcessTree } from '@chorus/shared/process-tree'
import {
  BrowserWindow,
  WebContentsView,
  app,
  clipboard,
  dialog,
  ipcMain,
  session,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type Session,
  type WebContents,
} from 'electron'
import { randomUUID } from 'node:crypto'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PreviewSelection,
  WORKBENCH_ACTIVITY_BAR_PUSH_CHANNEL,
  WORKBENCH_ACTIVITY_BAR_REPORT_CHANNEL,
  WORKBENCH_ASK_DIFF_CHANNEL,
  WORKBENCH_ASK_DIFF_RESULT_CHANNEL,
  WORKBENCH_BROWSER_EXTENSIONS_CHANGED_CHANNEL,
  WORKBENCH_BROWSER_EXTENSIONS_READ_CHANNEL,
  WORKBENCH_BROWSER_EXTENSIONS_WRITE_CHANNEL,
  WORKBENCH_CLIPBOARD_READ_CHANNEL,
  WORKBENCH_COMPLETION_CANCEL_CHANNEL,
  WORKBENCH_COMPLETION_CHANNEL,
  WORKBENCH_COMPLETION_PROBE_CHANNEL,
  WORKBENCH_CONNECTION_CHANNEL,
  WORKBENCH_CONTEXT_CHANNEL,
  WORKBENCH_EDITOR_REPORT_CHANNEL,
  WORKBENCH_EDIT_CHANNEL,
  WORKBENCH_EDIT_RESULT_CHANNEL,
  WORKBENCH_FOCUS_CHANNEL,
  WORKBENCH_LAYOUT_CHANNEL,
  WORKBENCH_PREVIEW_SELECTION_CHANNEL,
  WORKBENCH_PROCESS_CLOSE_CHANNEL,
  WORKBENCH_PROCESS_CLOSE_RESULT_CHANNEL,
  WORKBENCH_PROCESS_REPORT_CHANNEL,
  WORKBENCH_REVEAL_CHANNEL,
  WORKBENCH_REVEAL_RESULT_CHANNEL,
  WORKBENCH_REVIEW_DIFF_CHANNEL,
  WORKBENCH_REVIEW_DIFF_RESULT_CHANNEL,
  WORKBENCH_ROW_REQUEST_CHANNEL,
  WORKBENCH_ROW_REVEAL_PUSH_CHANNEL,
  WORKBENCH_ROW_SCROLL_PUSH_CHANNEL,
  WORKBENCH_ROW_SCROLL_REQUEST_CHANNEL,
  WORKBENCH_SECRET_DELETE_CHANNEL,
  WORKBENCH_SECRET_READ_CHANNEL,
  WORKBENCH_SECRET_WRITE_CHANNEL,
  WORKBENCH_SHELL_CHANNELS,
  WORKBENCH_SHELL_CONTRACT,
  WORKBENCH_SNAPSHOT_CHANNEL,
  WORKBENCH_SNAPSHOT_RESULT_CHANNEL,
  WORKBENCH_STORAGE_CHANGED_CHANNEL,
  WORKBENCH_STORAGE_FLUSH_CHANNEL,
  WORKBENCH_STORAGE_FLUSH_RESULT_CHANNEL,
  WORKBENCH_STORAGE_READ_CHANNEL,
  WORKBENCH_STORAGE_WRITE_CHANNEL,
  WORKBENCH_TERMINAL_ENV_CHANNEL,
  WORKBENCH_URL_CHANNEL,
  WORKBENCH_USER_SETTINGS_READ_CHANNEL,
  WORKBENCH_USER_SETTINGS_WRITE_CHANNEL,
  WorkbenchActivityBarWidth,
  WorkbenchContext,
  WORKBENCH_REVIEW_STATE_CHANNEL,
  WORKBENCH_REVIEW_CHANGED_CHANNEL,
  WORKBENCH_REVIEW_ACTION_CHANNEL,
  WORKBENCH_REVIEW_FILE_CHANNEL,
  WorkbenchReviewAction,
  WorkbenchReviewFileRequest,
  type WorkbenchReviewState,
  type WorkbenchReviewActionResult,
  type WorkbenchReviewFileResult,
  WorkbenchRowScrollDelta,
  remotePath,
  type CompletionReply,
  type WorkbenchActivityBarPush,
  type WorkbenchAskDiffRequest,
  type WorkbenchAskDiffResult,
  type WorkbenchConnection,
  type WorkbenchEditRequest,
  type WorkbenchEditResult,
  type WorkbenchRect,
  type WorkbenchRevealResult,
  type WorkbenchReviewDiffInput,
  type WorkbenchReviewDiffResult,
  type WorkbenchRowRevealPush,
  type WorkbenchRowScrollPush,
  type WorkbenchShellResponse,
  type WorkbenchSnapshotResult,
  type WorkbenchTarget,
  type WorkbenchTerminalEnv,
} from '../shared/workbench-ipc.js'
import {
  completionConfigured,
  isCompletionPayload,
  probeCompletionCache,
  recordEditorOutcome,
  requestCompletion,
} from './completion-client.js'
import { mainT } from './i18n.js'
import type { GitRequest, GitResponse, GitReviewEnvelope } from '../shared/git-ipc.js'
import { READ_PREVIEW_SELECTION } from './preview-selection.js'
import { acquireRemoteWorkbenchRuntime, releaseRemoteWorkbenchRuntime } from './remote-workbench.js'
import { currentScale, onScaleChange } from './scale.js'
import { applyWorkbenchContentSecurityPolicy, lockDownNavigation } from './security.js'
import { isShellSender } from './shell-windows.js'
import {
  readWorkbenchBrowserExtensions,
  writeWorkbenchBrowserExtensions,
} from './workbench-browser-extensions.js'
import {
  acquireWorkbenchRuntime,
  releaseWorkbenchRuntime,
  serverDataDir,
  stopIdleWorkbenchHost,
  workbenchHostLog,
  workbenchServerPid,
  type WorkbenchRuntime,
} from './workbench-host.js'
import {
  forgetWorkbenchProcessOwner,
  readWorkbenchProcessOwner,
} from './workbench-process-owner.js'
import {
  deleteWorkbenchSecret,
  readWorkbenchSecret,
  writeWorkbenchSecret,
} from './workbench-secrets.js'
import { applyWorkbenchStorageDelta, readWorkbenchStorage } from './workbench-storage.js'
import { readWorkbenchUserSettings, writeWorkbenchUserSettings } from './workbench-user-settings.js'

/**
 * The isolated workbench surfaces of preflight §4.1a.
 *
 * The shape is forced rather than chosen. A workbench has to be told things the
 * shell must never hold, and main can only address a context individually if it
 * *owns* that context — which an `<iframe>` the shell created is not. Two
 * independent defects killed the frame proposal: `frame-ancestors 'self'` and
 * "separate origin" cannot both be true, and delivering a secret to a subframe
 * needs `nodeIntegrationInSubFrames`, which is documented as loading *all* your
 * preloads into *every* iframe — extension webviews included. So the shell stops
 * being the workbench's parent and becomes a requester of a surface, holding an
 * opaque view id whose every operation main validates.
 *
 * The cost is real and accepted: nothing about this view is in the shell's DOM,
 * so layout is a two-process problem and bounds lag the shell's own reflow.
 */

/**
 * One partition for every workbench view, not one each.
 *
 * A partition is named by a string, so all surfaces naming this share one session
 * object: one `webRequest` filter, one CSP, one pair of permission handlers,
 * installed once and provably applied to every view. Per-view partitions would
 * multiply every control by the number of open projects and turn "is this one
 * configured?" into a runtime question — the dead-control failure again, once per
 * project. The isolation Chorus needs is between the workbench and the shell,
 * which one shared workbench partition gives; isolation *between* surfaces comes
 * from each being its own top-level `WebContents` in its own process.
 *
 * No `persist:` prefix, so the session is in-memory. The workbench's durable
 * state belongs to Chorus, not to a Chromium profile, and an in-memory session is
 * one fewer place for a connection cookie to survive a quit. Whether a
 * REH-backed workbench tolerates this is untested — it is unverified here because
 * this slice has no server to set a cookie.
 */
export const WORKBENCH_PARTITION = 'chorus-workbench'

import { approveProjectRoot, type WorkbenchPlace } from './project-root.js'
export { approveProjectRoot, type WorkbenchPlace } from './project-root.js'

interface Surface {
  readonly id: string
  projectId: string | null
  readonly host: string
  /** Canonical, and never the string the renderer proposed. See `approveProjectRoot`. */
  readonly projectRoot: string
  /**
   * The shared server's authority, token, commit and quality — the one thing in
   * this process that crosses into a renderer, and it goes to this surface only.
   */
  readonly runtime: WorkbenchRuntime
  readonly view: WebContentsView
  /**
   * The shell `WebContents` that asked for this surface, and the only one that
   * may move or close it.
   *
   * A view id is opaque but it is not a secret — it crosses the IPC boundary,
   * lands in the shell's React state and would land in a log line the first time
   * anyone debugs the layout. Authorising on the id alone therefore authorises
   * on a value the design already assumes can leak, which is the shape of the
   * bug §4.1b rule 4 names for the *pull* channel and which the shell-facing
   * channels had left open: any window could resize or destroy another window's
   * workbench by naming it. The owner is taken from `event.sender` and never
   * from the request, because a request argument is a claim rather than a fact.
   */
  owner: WebContents
  state: 'active' | 'handing-off'
  layoutWidth: number | null
  activityBarWidth: number
  context: WorkbenchContext | null
  readonly processNonce: string | null
  readonly processes: Map<number, OwnedProcessTree>
  readonly ownedPids: Set<number>
  processCapture: Promise<void>
  closePrepared: boolean
}

const HANDOFF_EXPIRY_MS = 10_000
const byId = new Map<string, Surface>()
const processSurfaces = new Map<string, Surface>()
const closingProjects = new Map<string, Promise<void>>()
const closedProjectPlaces = new Set<string>()
const placeKey = (place: WorkbenchPlace): string => `${place.host}\0${place.root}`

export function reopenWorkbenchProject(place: WorkbenchPlace): void {
  const key = placeKey(place)
  if (closingProjects.has(key)) throw new Error('This project is still closing.')
  closedProjectPlaces.delete(key)
}

/*
 * The view is a webContents of its own, so the shell's factor has to be given
 * to it as well or the editor draws at 100% inside a region sized for 90%.
 */
onScaleChange((scale) => {
  for (const surface of byId.values()) surface.view.webContents.setZoomFactor(scale)
})
/**
 * Keyed by the `WebContents` itself, which is what makes §4.1b rule 4 cheap.
 * `IpcMainEvent.senderFrame` may be null once a frame has navigated or been
 * destroyed, so validation keys on the sender's `WebContents` — the object the
 * map already uses — and treats an unknown sender as a refusal, never as a
 * default.
 */
const byContents = new Map<WebContents, Surface>()
const completions = new Map<string, AbortController>()
const cancelledCompletions = new Set<string>()
const CANCELLED_COMPLETIONS_LIMIT = 512
/**
 * Every shell whose lifecycle is being watched, with the surfaces it owns.
 *
 * A surface is destroyed today by the renderer's own unmount — which is exactly
 * the path a reload does not take. `location.reload()`, a dev-server full
 * reload or a crash-recovery load replaces the document without running a single
 * React cleanup, so the ids the shell was holding are gone while the
 * `WebContentsView`s they named are still parented, still painting, and now
 * unreachable by anything but a quit. Main owns these views, so main has to be
 * the one that notices.
 */
const byOwner = new Map<WebContents, Set<string>>()
const ownerDocuments = new WeakMap<WebContents, number>()

const handoffs = new Map<
  string,
  {
    projectRoot: string
    source: WebContents
    destination: WebContents
    kind: 'detach' | 'return'
    timer: ReturnType<typeof setTimeout>
  }
>()

/**
 * Every capability main has minted, and it is the whole of what `workbench:open`
 * will accept.
 *
 * Keyed by an unguessable id, valued by the canonical root **and the owner**. A
 * grant is not consumed on redemption: `StrictMode` mounts, unmounts and mounts
 * again, the probe reopens a pane it closed, and a single-use token would make
 * both of those a second trip through the chooser for an authorisation the person
 * already gave. What bounds it instead is the owner's document — `releaseOwner`
 * drops these alongside the surfaces, so a grant cannot outlive the window that
 * asked for it, and a reload starts from nothing.
 */
interface ProjectGrant {
  readonly projectRoot: string
  readonly owner: WebContents
}
const grants = new Map<string, ProjectGrant>()

const workbenchSessions = new Map<string, Session>()

export function workbenchPartition(remoteAuthority: string | null): string {
  return remoteAuthority === null
    ? WORKBENCH_PARTITION
    : `${WORKBENCH_PARTITION}:${remoteAuthority}`
}

/**
 * The workbench session, with its controls installed before anything loads into
 * it.
 *
 * A `WebContentsView` gets no session automatically: absent both `session` and
 * `partition` in its `webPreferences` it uses the default one, and that would be
 * a silent security regression rather than a missed opportunity — the shell's
 * `default-src 'none'` is exactly what a workbench cannot run under, which is how
 * a relax-the-shell change gets proposed. The symmetric mistake is this one
 * uninstalled: a new partition inherits no CSP and no permission handler at all.
 */
export function workbenchSession(
  isDev: boolean,
  remoteAuthority: string | null,
  /**
   * The server's identity, because its resource path is prefixed with it.
   *
   * Carried here for the same reason the authority is: the policy and the server
   * must not be able to drift, and there is exactly one place either value is
   * known.
   */
  product: { readonly quality: string; readonly commit: string } | null
): Session {
  const key = remoteAuthority ?? ''
  const existing = workbenchSessions.get(key)
  if (existing !== undefined) return existing
  const created = session.fromPartition(workbenchPartition(remoteAuthority))
  applyWorkbenchContentSecurityPolicy(created, isDev, remoteAuthority, product)
  workbenchSessions.set(key, created)
  return created
}

/**
 * The workbench's entry document, as one value: what to load, and the exact URL
 * the navigation lock will admit.
 *
 * Two expressions of one address is how an allowlist quietly stops matching the
 * thing it is supposed to admit, so `href` is derived from `file` rather than
 * written beside it. `loadFile` produces exactly `pathToFileURL(file).href`,
 * which is why the pair is safe to derive rather than assert.
 */
interface WorkbenchEntry {
  readonly href: string
  readonly file: string | null
}

function workbenchEntry(devServerUrl: string | undefined): WorkbenchEntry {
  if (devServerUrl === undefined) {
    const file = join(__dirname, '../renderer/workbench.html')
    return { href: pathToFileURL(file).href, file }
  }
  return { href: `${devServerUrl}/workbench.html`, file: null }
}

/**
 * The containment gate's substitute for a hand on the mouse, and it substitutes
 * for exactly that and nothing else.
 *
 * A native dialog is drawn by the OS, so CDP cannot click it: driving the gate
 * through the chooser is not "hard", it is unreachable. The alternative shapes
 * are worse — a test-only IPC channel that takes a path is the defect back under
 * another name, and an unauthenticated debug mint is that with a nicer comment.
 * What this reads instead is the **process environment**, which no renderer can
 * write and no compromised surface can influence. So it replaces the person's
 * click, never main's decision: the roots still go through `approveProjectRoot`,
 * still become grants bound to one `WebContents`, and a forged path on
 * `workbench:open` is refused on precisely the same path it would be in a
 * shipped app. Off entirely when packaged, because the argument above is about
 * a harness and none of it applies to a user's machine.
 */
/**
 * Whether this process is the containment gate's isolated profile rather than
 * somebody's Chorus — and **both** halves have to be true.
 *
 * `app.isPackaged` is the one a packaged build cannot lie about: the environment
 * belongs to whoever launched the app, so a user tricked into exporting
 * `CHORUS_WORKBENCH_E2E_ROOTS` would otherwise be a user whose workbench silently
 * stopped asking about trust. The environment variable is the one a *developer's*
 * ordinary `pnpm dev` cannot trip over, since nothing sets it but the gate. Either
 * alone is a hole in the other's direction, which is why this is `&&` and why the
 * test for it asserts the packaged case rather than the happy one.
 */
function isE2eProfile(): boolean {
  return !app.isPackaged && (process.env['CHORUS_WORKBENCH_E2E_ROOTS'] ?? '') !== ''
}

let seededRoots: string[] | null = null
function nextSeededRoot(): string | null {
  seededRoots ??= isE2eProfile()
    ? (process.env['CHORUS_WORKBENCH_E2E_ROOTS'] ?? '')
        .split(delimiter)
        .filter((part) => part.length > 0)
    : []
  return seededRoots.shift() ?? null
}

/**
 * The person's answer, or null if they closed the dialog.
 *
 * Attached to the owner's own window rather than to the focused one: the owner is
 * who the grant will be bound to, and a sheet over a different window would be an
 * authorisation for a window the person was not looking at. No `buttonLabel` —
 * main has no translator, and the OS's own verb is a better string than a
 * hardcoded English one this file could not localise anyway.
 */
async function pickDirectory(owner: WebContents): Promise<string | null> {
  const seeded = nextSeededRoot()
  if (seeded !== null) return seeded

  const options: OpenDialogOptions = { properties: ['openDirectory'] }
  const window = BrowserWindow.fromWebContents(owner)
  const result = await (window === null
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(window, options))
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/**
 * The mint, and the only one: a capability exists because a person picked a
 * folder in a dialog main put in front of them.
 *
 * Not exported, deliberately. An exported `mintFor(owner, path)` would be a way
 * to turn a path into an authorisation, and the next caller that wanted one would
 * find it — the point of a capability is that there is no such function.
 */
async function mintProjectGrant(
  owner: WebContents
): Promise<WorkbenchShellResponse<'workbench:chooseProject'>> {
  const picked = await pickDirectory(owner)
  if (picked === null) return { chosen: null }

  const projectRoot = approveProjectRoot(picked)
  const grant = randomUUID()
  grants.set(grant, { projectRoot, owner })
  // Watched from the mint rather than from the first `openSurface`: a grant must
  // not outlive the document it was minted for, and a shell can reload between
  // choosing a folder and opening it.
  watchOwner(owner)
  return { chosen: { grant, projectRoot } }
}

/**
 * Two independent reasons a surface can be invisible, and they must not clobber
 * each other.
 *
 * They arrive from different places and mean different things. An **overlay** is
 * window-wide and momentary — a dialog is up, so every surface in this window
 * steps aside until it closes. The **Editor switch** is per project and
 * durable — this one editor is off, and it stays off across a hover card, a
 * dialog, a relaunch.
 *
 * A single boolean could not hold both, and the bug was exactly that: the switch
 * hid one view, then the next hover card opened and closed and its restore said
 * "show everything this window owns", which turned the editor back on. Worse, it
 * came back at *stale bounds* — the region had left the layout, so nothing had
 * moved the view — and it was composited over the Chorus column that had grown
 * into its place. The chat was not hidden; it was behind the editor.
 *
 * So each reason gets its own set and a surface is visible only when it is in
 * neither. Neither caller has to know the other exists.
 */
/**
 * Keyed by **project root**, not by view id, and that is what makes it hold.
 *
 * One project is not guaranteed to be one surface. `StrictMode` mounts,
 * unmounts and mounts again while the open is in flight — the `live` flag in
 * `WorkbenchFrame` exists because that can leak a whole `WebContents` nobody
 * tracks any more — and a leaked surface sits at the same bounds painting the
 * same project. By id, hiding "the" surface leaves the other one on screen,
 * which is precisely the symptom this fixes: the region left the layout, Chorus
 * grew into it, and an editor that should have gone dark was still composited
 * over the top.
 *
 * By root it also survives a surface being *created* while the switch is off. A
 * new view for a hidden project is hidden the moment it is parented, rather than
 * flashing on until the shell gets around to telling it.
 */
const editorHidden = new Set<string>()
const overlayHidden = new Set<WebContents>()

/**
 * An overlay hide expires unless the shell keeps saying it is still up.
 *
 * **Because the shell's own bookkeeping cannot be trusted, and must not have to
 * be.** `overlay.ts` counts overlays in a module-level integer, incremented by an
 * effect and decremented by its cleanup; one cleanup that never runs leaves every
 * editor in the window hidden for the rest of the session, and there is no path
 * back — no timeout, no reconcile, nothing a person can press. It was reached by
 * hovering the rail's usage meter, whose restore hangs on a `pointerleave` that
 * browsers routinely skip when the pointer leaves fast or the window blurs. The
 * editor went black about a minute after launch and stayed black.
 *
 * Making the counter more careful was the alternative and it is not a fix: the
 * count is only ever as reliable as its least careful caller, including callers
 * nobody has written yet. A deadline is indifferent to who was careless.
 *
 * **Generous on purpose.** This is a safety net, not a scheduler: the cost of
 * firing late is a few extra seconds of a frozen-looking editor under a dialog,
 * and the cost of firing early is a dialog cut in half by a view that came back
 * underneath it. Only the second is a bug, so the interval is far longer than any
 * heartbeat gap a busy renderer could produce.
 */
const OVERLAY_HIDE_TTL_MS = 10_000
const overlayDeadlines = new Map<WebContents, ReturnType<typeof setTimeout>>()

function armOverlayExpiry(caller: WebContents): void {
  clearOverlayExpiry(caller)
  overlayDeadlines.set(
    caller,
    setTimeout(() => {
      overlayDeadlines.delete(caller)
      nextOverlayRevision(caller)
      if (!overlayHidden.delete(caller)) return
      /*
       * Restores only what this caller hid. `editorHidden` is a different reason
       * with a different lifetime — a project whose Editor switch is off must
       * stay off through this, which is the same clobbering `applyVisibility`
       * exists to prevent.
       */
      for (const id of byOwner.get(caller) ?? []) {
        const surface = byId.get(id)
        if (surface !== undefined) applyVisibility(surface)
      }
      applyParticipants(caller)
    }, OVERLAY_HIDE_TTL_MS)
  )
}

function clearOverlayExpiry(caller: WebContents): void {
  const timer = overlayDeadlines.get(caller)
  if (timer === undefined) return
  clearTimeout(timer)
  overlayDeadlines.delete(caller)
}

function applyVisibility(surface: Surface): void {
  surface.view.setVisible(
    !editorHidden.has(surface.projectRoot) && !overlayHidden.has(surface.owner)
  )
}

export interface OverlayParticipant {
  readonly id: string
  readonly owner: WebContents
  readonly view: WebContentsView
  readonly shown: () => boolean
  readonly conceal?: () => void
}

const participants = new Map<WebContents, Set<OverlayParticipant>>()
const overlayRevisions = new WeakMap<WebContents, number>()
let overlaySequence = 0

export function registerOverlayParticipant(participant: OverlayParticipant): () => void {
  watchOwner(participant.owner)
  const owned = participants.get(participant.owner) ?? new Set<OverlayParticipant>()
  participants.set(participant.owner, owned)
  owned.add(participant)
  applyParticipant(participant)
  return () => {
    owned.delete(participant)
    if (owned.size === 0 && participants.get(participant.owner) === owned) {
      participants.delete(participant.owner)
    }
  }
}

export function applyParticipant(participant: OverlayParticipant): void {
  if (participant.view.webContents.isDestroyed()) return
  if (overlayHidden.has(participant.owner)) participant.conceal?.()
  participant.view.setVisible(participant.shown() && !overlayHidden.has(participant.owner))
}

function applyParticipants(owner: WebContents): void {
  for (const participant of participants.get(owner) ?? []) applyParticipant(participant)
}

function concealParticipants(owner: WebContents): void {
  for (const participant of [...(participants.get(owner) ?? [])]) participant.conceal?.()
}

async function captureParticipants(
  owner: WebContents
): Promise<{ viewId: string; dataUrl: string }[]> {
  const stills: { viewId: string; dataUrl: string }[] = []
  for (const participant of [...(participants.get(owner) ?? [])]) {
    const contents = participant.view.webContents
    if (!participant.shown() || contents.isDestroyed() || !participant.view.getVisible()) continue
    try {
      const image = await contents.capturePage()
      if (!image.isEmpty()) {
        stills.push({
          viewId: participant.id,
          dataUrl: `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`,
        })
      }
    } catch {
      continue
    }
  }
  return stills
}

function nextOverlayRevision(owner: WebContents): number {
  overlaySequence += 1
  overlayRevisions.set(owner, overlaySequence)
  return overlaySequence
}

/**
 * Hide or show surfaces — one, or every one this window owns.
 *
 * **Scoped to the caller's own surfaces**, by the same `byOwner` set that tears
 * them down on reload: a window may not blank another window's workbench, for
 * the same reason it may not resize or close one. Naming a surface it does not
 * own is indistinguishable from naming one that does not exist — both are an
 * empty list and a silent success, because a view id reaches the shell's React
 * state and is therefore not a secret to authorise on.
 *
 * `setVisible` and not bounds: the surface keeps its rectangle, so nothing has
 * to be restored afterwards and the workbench inside is never told its window
 * changed size. An overlay that opens and closes leaves no trace in the editor's
 * own layout — and neither does the Editor switch.
 */
async function setSurfacesVisible(
  caller: WebContents,
  visible: boolean,
  only?: string,
  heartbeat = false
): Promise<{ viewId: string; dataUrl: string }[]> {
  const owned = [...(byOwner.get(caller) ?? [])]

  /*
   * The id names a surface only so main can read its project off it — **and only
   * if the caller owns it**. Resolving the root before that check would let a
   * window name someone else's surface and learn, by the effect, which project
   * it holds. Same rule `ownedSurface` applies to bounds and close: a view id is
   * not a secret, so it may never be the thing that authorises.
   */
  const root =
    only !== undefined && owned.includes(only) ? (byId.get(only)?.projectRoot ?? null) : null
  const ids = only === undefined ? owned : owned.filter((id) => byId.get(id)?.projectRoot === root)
  const revision = only === undefined ? nextOverlayRevision(caller) : null

  /*
   * Which reason is being set is decided by whether a surface was named, and
   * that is the whole of the distinction: the shell's overlay code names none
   * because it does not know which surfaces its dialog covers, and the Editor
   * switch always names one because it must not touch the three beside it.
   */
  const mark = (): void => {
    if (only === undefined) {
      if (visible) {
        overlayHidden.delete(caller)
        clearOverlayExpiry(caller)
      } else {
        overlayHidden.add(caller)
        // Every hide renews the deadline, so an overlay that keeps saying it is
        // up keeps the views down and one that stops saying so releases them.
        armOverlayExpiry(caller)
      }
      return
    }
    if (root === null) return
    if (visible) editorHidden.delete(root)
    else editorHidden.add(root)
  }

  if (visible) {
    mark()
    for (const id of owned) {
      const surface = byId.get(id)
      if (surface !== undefined) applyVisibility(surface)
    }
    if (only === undefined) applyParticipants(caller)
    return []
  }

  /*
   * Captured while still up, then hidden — the order is the whole point.
   *
   * A hidden view has no compositor surface to read, so capturing after the hide
   * yields either the last frame, a blank, or nothing depending on the platform.
   * Doing both here rather than in two channels also means the shell cannot get
   * them out of order: there is no window in which a caller has hidden the views
   * but not yet been handed what to draw instead.
   *
   * Only for the overlay, which is the caller that has somewhere to paint one.
   * The Editor switch removes the region from the layout entirely, so there is
   * no rectangle left to hold a still and capturing one would be pure cost.
   *
   * A capture that fails is not a failure of the hide. The still is a courtesy;
   * losing one costs an empty rectangle for the life of one overlay, and taking
   * the dialog down with it would cost the whole interaction. A surface already
   * dark for the other reason is skipped — it would capture a blank.
   */
  /*
   * A heartbeat does the marking and nothing else.
   *
   * It must still reach `mark()` — that is the whole renewal, and returning above
   * it would leave the deadline running down while the shell believed it was
   * saying "still up", so the watchdog would fire *during* a legitimate dialog
   * and restore the views underneath it. What it skips is the capture: the shell
   * already holds its stills, and re-encoding a JPEG per surface every few
   * seconds for a hover that is not moving is the one way this safety net could
   * cost more than the bug it prevents.
   *
   * Visibility is re-applied anyway, so a surface created since the last hide is
   * caught by the next beat rather than sitting bright under the overlay.
   */
  if (heartbeat) {
    if (only === undefined) concealParticipants(caller)
    mark()
    for (const id of owned) {
      const surface = byId.get(id)
      if (surface !== undefined) applyVisibility(surface)
    }
    if (only === undefined) applyParticipants(caller)
    return []
  }

  const stills: { viewId: string; dataUrl: string }[] = []
  if (only === undefined) {
    for (const id of ids) {
      const surface = byId.get(id)
      if (surface === undefined || editorHidden.has(surface.projectRoot)) continue
      try {
        const image = await surface.view.webContents.capturePage()
        if (!image.isEmpty()) {
          stills.push({
            viewId: id,
            dataUrl: `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`,
          })
        }
      } catch {
        /* no still for this one; the region will simply be empty */
      }
    }
    if (overlayRevisions.get(caller) === revision) concealParticipants(caller)
    stills.push(...(await captureParticipants(caller)))
  }
  if (revision !== null && overlayRevisions.get(caller) !== revision) return stills
  /*
   * Marked and applied after the await. Captures take tens of milliseconds and a
   * pane can close inside that, so `owned` may name a surface that is gone —
   * `byId.get` returning undefined is how that is handled rather than a held
   * reference that outlives it.
   */
  mark()
  for (const id of owned) {
    const surface = byId.get(id)
    if (surface !== undefined) applyVisibility(surface)
  }
  if (only === undefined) applyParticipants(caller)
  return stills
}

/**
 * The root `caller` is entitled to open, or a refusal.
 *
 * A forged path fails here for the reason that matters: it is not a capability
 * at all, so there is nothing to look up, and no amount of the path being real
 * changes that. A capability minted for another window fails on the owner check,
 * which is the same rule `ownedSurface` applies one object further along — and
 * for the same reason, since a grant reaches the shell's React state and would
 * reach the first log line anyone adds while debugging this.
 */
async function redeem(caller: WebContents, target: WorkbenchTarget): Promise<WorkbenchPlace> {
  if ('projectId' in target) {
    /*
     * **Authorised by adoption rather than by this document**, and that is a
     * deliberate widening rather than a hole.
     *
     * A grant answers "did somebody just pick this folder, in this window". An id
     * answers "is this one of the projects the person has adopted", which is a set
     * bounded by every dialog they ever accepted and is exactly what Phase 1's E2
     * asked for. The renderer still cannot name a *path*: an id it invents
     * resolves to nothing, which is what `resolveProjectPlace` refuses. Requiring
     * a per-window grant on top would mean re-choosing every project on every
     * launch, which is the product failure E2 was filed about.
     *
     * Still fail-closed when nothing was injected. A build that forgot to wire the
     * registry must refuse rather than fall through to the grant branch, where
     * `target.grant` is not even present.
     */
    if (resolveProjectPlace === null) {
      throw new Error(`No project registry is wired, so "${target.projectId}" cannot be opened`)
    }
    const place = await resolveProjectPlace(target.projectId)
    if (detachedAccess?.(caller, place.root) === false) {
      throw new Error(`No workbench project "${target.projectId}" is open in this window`)
    }
    return place
  }
  const held = grants.get(target.grant)
  if (held?.owner !== caller) {
    throw new Error(`No workbench project grant "${target.grant}" belongs to this window`)
  }
  return { host: LOCAL_HOST, root: held.projectRoot }
}

/** Everything a surface is told about itself. One project, one view, one server. */

function acquireRuntime(place: WorkbenchPlace): Promise<WorkbenchRuntime> {
  return place.host === LOCAL_HOST
    ? acquireWorkbenchRuntime(place.root)
    : acquireRemoteWorkbenchRuntime(place.host, place.root)
}

function releaseRuntime(place: WorkbenchPlace): void {
  if (place.host === LOCAL_HOST) {
    releaseWorkbenchRuntime(place.root)
    return
  }
  void releaseRemoteWorkbenchRuntime(place.host, place.root)
}

function describe(surface: Surface): WorkbenchConnection {
  return {
    /*
     * Converted here rather than where the URI is built, because this is the
     * one place the root crosses into the renderer and `workspaceIdFor` hashes
     * whatever arrives — so normalising later would key a project's storage off
     * a string that is not the one the workspace folder ends up on.
     *
     * It used to read `host !== LOCAL_HOST && /^[A-Za-z]:\//`, which is two
     * mistakes. The host condition meant a *local* Windows root — the ordinary
     * case on that platform — never got its leading slash, so the workbench
     * threw `[UriError]` out of `prepareWorkbench` and no editor appeared at
     * all. And the pattern demanded a forward slash after the drive letter, so
     * a native `C:\...` path failed the test even on a remote host, where the
     * branch was supposed to be doing its job.
     */
    projectRoot: remotePath(surface.projectRoot),
    ...(surface.processNonce === null ? {} : { processNonce: surface.processNonce }),
    remoteAuthority: surface.runtime.remoteAuthority,
    connectionToken: surface.runtime.connectionToken,
    commit: surface.runtime.commit,
    quality: surface.runtime.quality,
    reviewLabels: {
      title: mainT('git.review.editorTitle'),
      actionFailed: mainT('git.failure.git-failed'),
      comment: mainT('git.review.comment'),
      reply: mainT('git.review.reply'),
      resolve: mainT('git.review.resolve'),
      reopen: mainT('git.review.reopen'),
      commentingBlocked: mainT('git.review.commentingBlocked'),
      status: {
        added: mainT('git.review.status.added'),
        removed: mainT('git.review.status.removed'),
        modified: mainT('git.review.status.modified'),
        renamed: mainT('git.review.status.renamed'),
      },
    },
    /*
     * Spread in or not present at all, rather than set to a value meaning "no".
     *
     * A descriptor that ships to a person carries no trust field, so there is no
     * way to write the disabled state by accident — no ternary to invert, no
     * boolean to misread, and a renderer that never heard of the field enforces
     * trust. The condition is main's own, taken from the process environment and
     * from `isPackaged`, and never from anything the shell or the surface says.
     */
    ...(isE2eProfile() ? { workspaceTrust: 'waived' as const } : {}),
  }
}

/**
 * Watches one shell, once, for the two ways it can leave without telling us.
 *
 * `did-start-navigation` covers the reload: Electron's own typings describe it as
 * "emitted when any frame (including main) starts navigating", so a document
 * replacing itself arrives here before its successor exists. `isSameDocument` is
 * checked because a `pushState` or a fragment is the shell still running, and
 * closing four workbenches because a route changed would be a far worse bug than
 * the one being fixed. `destroyed` covers the window closing.
 *
 * Registered per owner rather than per surface, because these listeners outlive
 * any one view and Electron's emitter has no dedupe of its own.
 */
function watchOwner(owner: WebContents): Set<string> {
  const existing = byOwner.get(owner)
  if (existing !== undefined) return existing

  const owned = new Set<string>()
  byOwner.set(owner, owned)

  owner.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    releaseOwner(owner)
  })
  owner.on('destroyed', () => {
    releaseOwner(owner)
    byOwner.delete(owner)
  })
  return owned
}

/**
 * Whether the window holding this surface is the one the person is in.
 *
 * A question about a **window**, never about the document — and that distinction
 * is the whole of Phase 3. The workbench and the chat beside it are two documents
 * in one window, so `document.hasFocus()` inside the workbench is false whenever
 * the person is typing in Chorus's own composer, on an editor that is fully on
 * screen. VS Code's git extension reads exactly that and parks itself in
 * `whenIdleAndFocused()`, which is why a working-tree change made from the chat
 * never reached the SCM view.
 *
 * `owner.isDestroyed()` is checked before `fromWebContents`, not after: Electron
 * throws on a destroyed `WebContents` rather than answering `null`, and both
 * callers here can race a window that is going away — one of them is a window
 * event.
 */
function windowHasFocus(surface: Surface): boolean {
  if (surface.owner.isDestroyed()) return false
  const window = BrowserWindow.fromWebContents(surface.owner)
  return window !== null && !window.isDestroyed() && window.isFocused()
}

/**
 * Teardown for one surface's window-focus listeners, by view id.
 *
 * Keyed by surface rather than by window, because `attachSurface` changes which
 * window owns a surface. A subscription bound once at creation would keep
 * reporting the window a project was dragged *out of*, which is the "wrong name
 * survives a re-key" failure in `CLAUDE.md` with a listener in place of a field.
 */
const focusWatchers = new Map<string, () => void>()

function stopWatchingFocus(viewId: string): void {
  focusWatchers.get(viewId)?.()
  focusWatchers.delete(viewId)
}

/**
 * Binds this surface to its *current* owner's focus, replacing any earlier bind.
 *
 * Called from `attachSurface` as well as from creation, and that second call is
 * the one that matters: a handoff moves a surface between windows, and the
 * subscription has to move with it or the workbench spends the rest of its life
 * reporting on the window it came from.
 *
 * No initial `send`. The view may have no document yet — Electron makes no
 * promise that `send` queues for one — and `WORKBENCH_FOCUS_CHANNEL` carries a
 * pull for exactly that reason, the same shape as the connection channel beside
 * it. A push that lands too early is dropped and costs nothing, because the next
 * focus change supersedes it.
 */
function watchWindowFocus(surface: Surface): void {
  stopWatchingFocus(surface.id)
  const window = BrowserWindow.fromWebContents(surface.owner)
  if (window === null) return
  const push = (): void => {
    if (surface.view.webContents.isDestroyed()) return
    surface.view.webContents.send(WORKBENCH_FOCUS_CHANNEL, windowHasFocus(surface))
  }
  window.on('focus', push)
  window.on('blur', push)
  focusWatchers.set(surface.id, () => {
    /*
     * A destroyed window's emitter is dead, so there is nothing left to remove —
     * and `off` on one is not promised to be a no-op.
     */
    if (window.isDestroyed()) return
    window.off('focus', push)
    window.off('blur', push)
  })
}

/**
 * Which surface sent someone to a browser, and when.
 *
 * **The callback cannot address itself, so this is the address.** An OAuth
 * return arrives as `chorus://<extension>/…` with no project in it, and one REH
 * serves up to five surfaces. Delivering to all of them would hand one project's
 * access token to every open workbench, which is a credential leak dressed up as
 * a convenience; delivering to the focused one guesses, and the person is by
 * definition in a browser at that moment, so "focused" means whatever they
 * clicked on the way back.
 *
 * The surface that opened the browser is the only claimant with evidence behind
 * it, and `lockDownNavigation`'s external hook is where that evidence exists.
 */
let awaitingCallback: { viewId: string; at: number } | null = null

/**
 * How long an opened browser stays a plausible origin for a callback.
 *
 * Long enough for a real login — a password manager, a 2FA prompt, an account
 * chooser, a consent screen — and short enough that a `chorus://` URL arriving
 * an hour later, from a link in a mail or from another application, is not
 * silently handed to whichever project happened to open a browser that morning.
 */
const CALLBACK_ORIGIN_TTL_MS = 5 * 60 * 1000

/**
 * Hands an incoming `chorus://` URL to the surface that started the flow.
 *
 * **Dropped rather than guessed when there is no claimant.** A callback with no
 * recent external open is either stale or was not started here, and there is no
 * safe default: every fallback available — the focused surface, the first, all
 * of them — routes somebody's credential to a project that did not ask for it.
 * Doing nothing leaves the extension waiting, which is the visible failure the
 * person can act on, rather than the invisible one they cannot.
 */
export function deliverUrl(url: string): boolean {
  const pending = awaitingCallback
  if (pending === null || Date.now() - pending.at > CALLBACK_ORIGIN_TTL_MS) return false
  const surface = byId.get(pending.viewId)
  if (surface === undefined || surface.view.webContents.isDestroyed()) {
    awaitingCallback = null
    return false
  }
  /*
   * Consumed on delivery. A callback is answered once; leaving the claim standing
   * would let a second, unrelated `chorus://` URL inside the same five minutes
   * ride in on the first one's evidence.
   */
  awaitingCallback = null
  surface.view.webContents.send(WORKBENCH_URL_CHANNEL, url)
  return true
}

function warnFailure(message: string, error: unknown): void {
  workbenchHostLog().warn(message, {
    error: error instanceof Error ? error.message : String(error),
  })
}

/** Every surface this shell owns, torn down without asking it — and every grant. */
function releaseOwner(owner: WebContents): void {
  ownerDocuments.set(owner, (ownerDocuments.get(owner) ?? 0) + 1)
  for (const id of [...(byOwner.get(owner) ?? [])]) {
    void destroySurface(id).catch((error: unknown) => {
      warnFailure('Workbench surface could not close', error)
    })
  }
  /* The overlay flag is keyed by the document, and this one is gone. */
  overlayHidden.delete(owner)
  nextOverlayRevision(owner)
  participants.delete(owner)
  /*
   * And its deadline with it. Deleting the flag without cancelling the timer
   * leaves a `setTimeout` holding a destroyed `WebContents` that fires up to
   * `OVERLAY_HIDE_TTL_MS` later and calls `applyVisibility` on surfaces this
   * function has just torn down — `Object has been destroyed`, out of a timer,
   * where there is no caller to blame and nothing to catch it.
   */
  clearOverlayExpiry(owner)
  /*
   * The grants go with them. A capability is an authorisation the person gave to
   * one document; the document that replaces it after a reload is not that
   * document, and letting it inherit the set would make "the user picked this"
   * survive an event the user never saw.
   */
  for (const [grant, held] of [...grants]) if (held.owner === owner) grants.delete(grant)
}

export async function openSurface(
  owner: WebContents,
  target: WorkbenchTarget,
  devServerUrl: string | undefined
): Promise<string> {
  if (owner.isDestroyed()) {
    throw new Error('A workbench surface needs a window to attach to')
  }
  watchOwner(owner)
  const document = ownerDocuments.get(owner) ?? 0
  const place = await redeem(owner, target)
  const validateOwner = (): BrowserWindow => {
    if (owner.isDestroyed() || (ownerDocuments.get(owner) ?? 0) !== document) {
      throw new Error('A workbench surface needs a window to attach to')
    }
    const parent = BrowserWindow.fromWebContents(owner)
    if (parent === null || parent.isDestroyed()) {
      throw new Error('A workbench surface needs a window to attach to')
    }
    if ('projectId' in target) {
      if (detachedAccess?.(owner, place.root) === false) {
        throw new Error(`No workbench project "${target.projectId}" is open in this window`)
      }
    } else if (grants.get(target.grant)?.owner !== owner) {
      throw new Error(`No workbench project grant "${target.grant}" belongs to this window`)
    }
    return parent
  }
  validateOwner()
  if ('projectId' in target) {
    await openRegisteredProject?.(target.projectId)
    validateOwner()
  }
  if (closedProjectPlaces.has(placeKey(place)))
    throw new Error('This project is closed or still closing.')
  const projectRoot = place.root
  const claimed = claimHandoff(owner, place)
  if (claimed !== null) {
    const surface = byId.get(claimed)
    if (surface !== undefined && 'projectId' in target && surface.projectId !== target.projectId) {
      surface.projectId = target.projectId
      liveContents(surface)?.send(WORKBENCH_REVIEW_CHANGED_CHANNEL, null)
    }
    return claimed
  }

  /*
   * The lease is taken **before** the view exists, and the await is why this
   * function became asynchronous.
   *
   * `acquire` on project open, `release` on project close, and unmounting a
   * surface calls neither — §5.4. The first caller pays for the download, the
   * checksum, the transactional extraction and the spawn; every caller after it
   * gets the same descriptor for the same shared server. Doing this after the
   * view were created would mean a workbench document existing with nothing to
   * connect to, which is the state its own error path cannot distinguish from a
   * server that died.
   */
  const runtime = await acquireRuntime(place)
  if (closedProjectPlaces.has(placeKey(place))) {
    releaseRuntime(place)
    if (place.host === LOCAL_HOST) await stopIdleWorkbenchHost()
    throw new Error('This project closed while its editor was opening.')
  }

  /*
   * The parent window is *derived from* the owner rather than passed beside it,
   * so the view cannot be parented to one window while being owned by another —
   * a pairing nothing downstream would ever check.
   *
   * Re-read after the await: a window can close while a 76 MB artifact is being
   * fetched, and parenting a view to a destroyed window is a crash rather than a
   * refusal.
   */
  let parent: BrowserWindow
  try {
    parent = validateOwner()
  } catch (error) {
    releaseRuntime(place)
    throw error
  }

  const id = randomUUID()

  /*
   * Its own `webPreferences` literal, and never a spread of the window's.
   *
   * The sandbox flags below are identical to the shell's, which is exactly what
   * makes the spread tempting — and `preload` would come along with it, handing
   * this document the whole `ChorusApi`. Written out, the preload is a decision
   * on its own line rather than a passenger.
   */
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/workbench.js'),
      session: workbenchSession(devServerUrl !== undefined, runtime.remoteAuthority, runtime),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      /*
       * Off, and it is the property that makes this surface possible at all.
       * On, "all your preloads will load for every iframe" — and the workbench's
       * iframes are extension webviews. Off, the bridge exists in this document
       * and in none of the content it hosts.
       */
      nodeIntegrationInSubFrames: false,
    },
  })

  /*
   * A surface opened while the shell is already zoomed never sees a change, so
   * the subscription above cannot be the only place this is applied.
   */
  view.webContents.setZoomFactor(currentScale())

  const surface: Surface = {
    id,
    projectId: 'projectId' in target ? target.projectId : null,
    host: place.host,
    projectRoot,
    runtime,
    view,
    owner,
    state: 'active',
    layoutWidth: null,
    activityBarWidth: 0,
    context: null,
    processNonce: place.host === LOCAL_HOST ? randomUUID() : null,
    processes: new Map(),
    ownedPids: new Set(),
    processCapture: Promise.resolve(),
    closePrepared: false,
  }
  byId.set(id, surface)
  processSurfaces.set(id, surface)
  byContents.set(view.webContents, surface)
  watchOwner(owner).add(id)

  const entry = workbenchEntry(devServerUrl)

  // Not inherited: `lockDownNavigation` binds listeners to one `webContents`, and
  // the window's is a different object. One entry, exactly — this document may
  // reload itself and may go nowhere else, least of all onto the shell's own
  // `index.html`, which a `file://` prefix rule admitted.
  lockDownNavigation(view.webContents, [entry.href], () => {
    awaitingCallback = { viewId: id, at: Date.now() }
  })

  /*
   * Zero-sized until the shell reports where its placeholder is. A view added at
   * its default bounds paints over the whole window for one frame, which reads as
   * the workbench having stolen the app.
   */
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  parent.contentView.addChildView(view)
  /*
   * Applied before the shell says anything, because a project whose Editor
   * switch is off must not flash on while the frame's effect is still queued.
   * The set is keyed by root, so a second surface for the same project — the
   * `StrictMode` remount this file already guards against — inherits the state
   * rather than arriving visible.
   */
  applyVisibility(surface)
  watchWindowFocus(surface)

  /*
   * Pushed on the view's own load, not on its creation. Electron makes no promise
   * that `send` queues for a document that does not exist yet, and designing on
   * the assumption that it does is the unread-shape failure CLAUDE.md warns
   * about. The preload's buffer is what covers the remaining window between the
   * document existing and the entry module subscribing.
   */
  view.webContents.on('did-finish-load', () => {
    view.webContents.send(WORKBENCH_CONNECTION_CHANNEL, describe(surface))
    if (surface.layoutWidth !== null) {
      view.webContents.send(WORKBENCH_LAYOUT_CHANNEL, surface.layoutWidth)
    }
  })

  if (entry.file !== null) void view.webContents.loadFile(entry.file)
  else void view.webContents.loadURL(entry.href)

  return id
}

function attachSurface(surface: Surface, owner: WebContents): void {
  const parent = BrowserWindow.fromWebContents(owner)
  if (parent === null || owner.isDestroyed()) {
    throw new Error('A workbench surface needs a window to attach to')
  }
  surface.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  parent.contentView.addChildView(surface.view)
  if (!surface.view.webContents.isDestroyed()) surface.view.webContents.backgroundThrottling = false
  surface.owner = owner
  watchOwner(owner).add(surface.id)
  watchWindowFocus(surface)
  surface.state = 'active'
  applyVisibility(surface)
  if (surface.context !== null) {
    onContext?.(
      { host: surface.host, projectRoot: surface.projectRoot, context: surface.context },
      surface.owner
    )
  }
}

export function beginHandoff(
  caller: WebContents,
  projectRoot: string,
  destination: WebContents,
  kind: 'detach' | 'return',
  host: string = LOCAL_HOST
): string {
  const matches = [...(byOwner.get(caller) ?? [])].filter((id) => {
    const candidate = byId.get(id)
    return candidate?.projectRoot === projectRoot && candidate.host === host
  })
  if (matches.length !== 1) {
    throw new Error(`No single workbench surface for "${projectRoot}" belongs to this window`)
  }
  const viewId = matches[0]
  const surface = viewId === undefined ? undefined : byId.get(viewId)
  if (viewId === undefined || surface === undefined) {
    throw new Error(`No single workbench surface for "${projectRoot}" belongs to this window`)
  }
  surface.state = 'handing-off'
  byOwner.get(caller)?.delete(viewId)
  if (
    ![...byId.values()].some(
      (other) =>
        other !== surface &&
        other.owner === surface.owner &&
        other.state === 'active' &&
        other.host === surface.host &&
        other.projectRoot === surface.projectRoot
    )
  ) {
    onSurfaceGone?.({ host: surface.host, root: surface.projectRoot }, surface.owner)
  }
  stopWatchingFocus(viewId)
  for (const [grant, held] of [...grants]) {
    if (host === LOCAL_HOST && held.owner === caller && held.projectRoot === projectRoot) {
      grants.delete(grant)
    }
  }
  BrowserWindow.getAllWindows()
    .find((window) => window.contentView.children.includes(surface.view))
    ?.contentView.removeChildView(surface.view)
  surface.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  handoffs.set(viewId, {
    projectRoot,
    source: caller,
    destination,
    kind,
    timer: setTimeout(() => {
      expireHandoff(viewId)
    }, HANDOFF_EXPIRY_MS),
  })
  return viewId
}

function expireHandoff(viewId: string): void {
  const pending = handoffs.get(viewId)
  const surface = byId.get(viewId)
  if (pending === undefined) return
  handoffs.delete(viewId)
  if (surface === undefined) return
  if (pending.kind === 'detach' && !pending.source.isDestroyed()) {
    handoffs.set(viewId, {
      projectRoot: pending.projectRoot,
      source: pending.destination,
      destination: pending.source,
      kind: 'return',
      timer: setTimeout(() => {
        expireHandoff(viewId)
      }, HANDOFF_EXPIRY_MS),
    })
    onHandoffExpired?.(pending.projectRoot)
    return
  }
  void destroySurface(viewId).catch((error: unknown) => {
    warnFailure('Workbench surface could not close', error)
  })
}

function claimHandoff(caller: WebContents, place: WorkbenchPlace): string | null {
  const entry = [...handoffs].find(
    ([viewId, pending]) =>
      pending.projectRoot === place.root && byId.get(viewId)?.host === place.host
  )
  if (entry === undefined) return null
  const [viewId, pending] = entry
  const surface = byId.get(viewId)
  if (
    surface === undefined ||
    (pending.destination !== caller && !(pending.kind === 'detach' && pending.source === caller))
  ) {
    throw new Error(`No workbench surface "${viewId}" belongs to this window`)
  }
  attachSurface(surface, caller)
  clearTimeout(pending.timer)
  handoffs.delete(viewId)
  return viewId
}

const closingSurfaces = new Map<string, { surface: Surface; promise: Promise<void> }>()
const storageFlushRequests = new Map<
  string,
  { contents: WebContents; finish: (error?: Error) => void }
>()

function flushSurfaceStorage(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const destroyed = (): void => {
      finish(new Error('Workbench closed before storage was flushed'))
    }
    const timer = setTimeout(() => {
      finish(new Error('Workbench storage flush timed out'))
    }, 10_000)
    const finish = (error?: Error): void => {
      if (!storageFlushRequests.delete(requestId)) return
      clearTimeout(timer)
      contents.removeListener('destroyed', destroyed)
      if (error === undefined) resolve()
      else reject(error)
    }
    storageFlushRequests.set(requestId, { contents, finish })
    contents.once('destroyed', destroyed)
    try {
      contents.send(WORKBENCH_STORAGE_FLUSH_CHANNEL, requestId)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/**
 * Tears one surface down, with no question of who asked.
 *
 * The unchecked half, used by the owner's own lifecycle and by shutdown. Every
 * path a *renderer* can reach goes through `ownedSurface` first.
 */
function liveContents(surface: Surface): WebContents | null {
  const contents = surface.view.webContents as WebContents | undefined
  return contents === undefined || contents.isDestroyed() ? null : contents
}

function destroySurface(viewId: string, prepared = false): Promise<void> {
  const current = closingSurfaces.get(viewId)
  if (current !== undefined) return current.promise
  const surface = byId.get(viewId)
  if (surface === undefined) return Promise.resolve()
  byId.delete(viewId)
  for (const [requestId, pending] of pendingReviewDiffs) {
    if (pending.contents === surface.view.webContents) {
      pending.settle({ requestId, ok: false, failure: 'no-editor' })
    }
  }
  byOwner.get(surface.owner)?.delete(viewId)
  stopWatchingFocus(viewId)
  /*
   * Only when this was the project's *last* surface. Two panes on one project
   * share a root, and telling the shell the editor is gone while another is
   * still showing it would drop a context that is still true.
   */
  if (
    surface.state === 'active' &&
    ![...byId.values()].some(
      (other) =>
        other.owner === surface.owner &&
        other.state === 'active' &&
        other.host === surface.host &&
        other.projectRoot === surface.projectRoot
    )
  ) {
    onSurfaceGone?.({ host: surface.host, root: surface.projectRoot }, surface.owner)
  }
  /*
   * `editorHidden` is **not** pruned here, and that is deliberate: it is keyed by
   * project root, and a project whose editor is off should still be off when its
   * pane is reopened. It is bounded by the number of projects, and the shell
   * re-asserts the switch from `WorkbenchFrame`'s own effect on every mount.
   */

  const parent = BrowserWindow.getAllWindows().find((window) =>
    window.contentView.children.includes(surface.view)
  )
  parent?.contentView.removeChildView(surface.view)

  const flushable = prepared ? null : liveContents(surface)
  const closing = (flushable === null ? Promise.resolve() : flushSurfaceStorage(flushable))
    .catch((error: unknown) => {
      warnFailure('Workbench storage could not be flushed before closing', error)
    })
    .then(() => {
      const contents = surface.view.webContents as WebContents | undefined
      if (contents !== undefined) byContents.delete(contents)

      liveContents(surface)?.close()
    })
    .finally(() => {
      closingSurfaces.delete(viewId)
    })
  closingSurfaces.set(viewId, { surface, promise: closing })
  return closing
}

const processCloseRequests = new Map<
  string,
  {
    contents: WebContents
    phase: 'prepare' | 'stop'
    finish: (pids?: readonly number[], error?: Error) => void
  }
>()

class UnsavedWorkbenchFilesError extends Error {
  constructor() {
    super('Save unsaved editor files before closing this project.')
  }
}

function terminalProcessIds(value: unknown): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.length > 1024 ||
    value.some((pid: unknown) => typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1)
  ) {
    throw new Error('Invalid editor terminal process report.')
  }
  return value as number[]
}

function requestProcessClose(
  surface: Surface,
  phase: 'prepare' | 'stop'
): Promise<readonly number[]> {
  const contents = liveContents(surface)
  if (contents === null)
    return Promise.reject(new Error('The editor closed before its processes could be verified.'))
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const destroyed = (): void => {
      finish(undefined, new Error('The editor closed before confirming shutdown.'))
    }
    const timer = setTimeout(() => {
      finish(
        undefined,
        new Error('The editor did not confirm shutdown; retry closing this project.')
      )
    }, 10_000)
    const finish = (pids?: readonly number[], error?: Error): void => {
      if (!processCloseRequests.delete(requestId)) return
      clearTimeout(timer)
      contents.removeListener('destroyed', destroyed)
      if (error === undefined) resolve(pids ?? [])
      else reject(error)
    }
    processCloseRequests.set(requestId, { contents, phase, finish })
    contents.once('destroyed', destroyed)
    try {
      contents.send(WORKBENCH_PROCESS_CLOSE_CHANNEL, requestId, phase)
    } catch (error) {
      finish(undefined, error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function captureSurfaceProcesses(surface: Surface, terminalPids: readonly number[]): Promise<void> {
  if (surface.host !== LOCAL_HOST) return Promise.resolve()
  const capture = surface.processCapture
    .catch(() => undefined)
    .then(async () => {
      if (surface.processNonce === null) {
        throw new Error('The editor process ownership nonce is unavailable.')
      }
      const ancestor = workbenchServerPid()
      if (ancestor === null)
        throw new Error('The editor server is unavailable; process ownership cannot be verified.')
      const report = readWorkbenchProcessOwner(serverDataDir(), surface.processNonce)
      if (report.nonce !== surface.processNonce || report.root !== surface.projectRoot) {
        throw new Error('The editor process report does not belong to this project.')
      }
      const failures: unknown[] = []
      for (const pid of new Set([report.pid, ...terminalPids])) {
        try {
          if (pid === ancestor) throw new Error('A project cannot own the shared editor server.')
          let owned = surface.processes.get(pid)
          if (owned === undefined) {
            owned = ownProcessTree(pid, { expectedAncestorPid: ancestor })
            surface.processes.set(pid, owned)
          }
          await owned.capture()
          surface.ownedPids.add(pid)
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Some editor processes could not be owned.')
      }
    })
  surface.processCapture = capture
  return capture
}

function awaitSurfaceDestroyed(surface: Surface): Promise<void> {
  const contents = liveContents(surface)
  if (contents === null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      contents.removeListener('destroyed', destroyed)
      reject(new Error('The editor view did not finish closing.'))
    }, 5_000)
    const destroyed = (): void => {
      clearTimeout(timer)
      resolve()
    }
    contents.once('destroyed', destroyed)
    contents.close()
  })
}

async function closeProjectSurface(surface: Surface): Promise<void> {
  const failures: unknown[] = []
  const contents = liveContents(surface)
  if (contents !== null) {
    try {
      await flushSurfaceStorage(contents)
    } catch (error) {
      warnFailure('Workbench storage could not be flushed before closing', error)
    }
  }
  if (liveContents(surface) !== null) {
    try {
      await requestProcessClose(surface, 'stop')
    } catch (error) {
      warnFailure('Workbench could not disconnect gracefully', error)
      if (surface.host !== LOCAL_HOST) failures.push(error)
    }
  }
  try {
    await surface.processCapture
  } catch (error) {
    warnFailure('Workbench process ownership could not be captured', error)
  }
  await Promise.all(
    [...surface.processes].map(async ([pid, tree]) => {
      try {
        await tree.stop()
      } catch (error) {
        warnFailure('Workbench process tree could not be stopped', error)
        if (surface.ownedPids.has(pid)) failures.push(error)
      }
    })
  )
  const destroyed = awaitSurfaceDestroyed(surface).catch((error: unknown) => {
    warnFailure('Workbench view did not finish closing', error)
    failures.push(error)
  })
  try {
    await destroySurface(surface.id, true)
  } catch (error) {
    warnFailure('Workbench surface could not close', error)
    failures.push(error)
  }
  await destroyed
  if (failures.length > 0) throw new AggregateError(failures, 'The editor did not finish closing.')
  processSurfaces.delete(surface.id)
  if (surface.processNonce !== null) {
    try {
      forgetWorkbenchProcessOwner(serverDataDir(), surface.processNonce)
    } catch (error) {
      warnFailure('Workbench process ownership report could not be removed', error)
    }
  }
}

export async function prepareWorkbenchProjectClose(place: WorkbenchPlace): Promise<void> {
  const surfaces = [...processSurfaces.values()].filter(
    (surface) => surface.host === place.host && surface.projectRoot === place.root
  )
  for (const surface of surfaces) surface.closePrepared = false
  const outcomes = await Promise.allSettled(
    surfaces.map(async (surface) => {
      let pids: readonly number[] = []
      if (liveContents(surface) !== null) {
        try {
          pids = await requestProcessClose(surface, 'prepare')
        } catch (error) {
          if (error instanceof UnsavedWorkbenchFilesError) throw error
          warnFailure('Workbench could not prepare for closing', error)
        }
      }
      try {
        await captureSurfaceProcesses(surface, pids)
      } catch (error) {
        warnFailure('Workbench process ownership could not be captured', error)
      }
    })
  )
  for (const outcome of outcomes) {
    if (outcome.status !== 'rejected') continue
    if (outcome.reason instanceof UnsavedWorkbenchFilesError) throw outcome.reason
    warnFailure('Workbench could not prepare for closing', outcome.reason)
  }
  for (const surface of surfaces) surface.closePrepared = true
}

export function closeWorkbenchProject(place: WorkbenchPlace): Promise<void> {
  const key = placeKey(place)
  const existing = closingProjects.get(key)
  if (existing !== undefined) return existing
  const closing = (async () => {
    if (
      [...processSurfaces.values()].some(
        (surface) =>
          surface.host === place.host &&
          surface.projectRoot === place.root &&
          !surface.closePrepared
      )
    ) {
      await prepareWorkbenchProjectClose(place)
    }
    closedProjectPlaces.add(key)
    const surfaces = [...processSurfaces.values()].filter(
      (surface) => surface.host === place.host && surface.projectRoot === place.root
    )
    const outcomes = await Promise.allSettled(
      surfaces.map((surface) => closeProjectSurface(surface))
    )
    const failures = outcomes.flatMap((outcome): unknown[] =>
      outcome.status === 'rejected' ? [outcome.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Editor shutdown could not be confirmed; retry closing this project.'
      )
    }
    try {
      if (place.host === LOCAL_HOST) {
        releaseWorkbenchRuntime(place.root)
        await stopIdleWorkbenchHost()
      } else {
        await releaseRemoteWorkbenchRuntime(place.host, place.root)
      }
    } catch (error) {
      warnFailure('Workbench runtime could not be released', error)
      throw error
    }
  })().finally(() => {
    closingProjects.delete(key)
  })
  closingProjects.set(key, closing)
  return closing
}

/**
 * The surface `caller` is entitled to name, or a refusal.
 *
 * One message for "there is no such surface" and for "that one is not yours",
 * deliberately: two messages would answer whether a given id exists, which is
 * the only thing a caller guessing ids could learn from here.
 */
function ownedSurface(caller: WebContents, viewId: string): Surface {
  const surface = byId.get(viewId)
  if (surface?.owner !== caller || surface.state === 'handing-off') {
    throw new Error(`No workbench surface "${viewId}" belongs to this window`)
  }
  return surface
}

export function closeSurface(caller: WebContents, viewId: string): Promise<void> {
  ownedSurface(caller, viewId)
  return destroySurface(viewId)
}

export function setSurfaceBounds(
  caller: WebContents,
  viewId: string,
  rect: WorkbenchRect,
  layoutWidth?: number
): void {
  /*
   * The renderer measures its placeholder in the shell's own CSS pixels, and a
   * zoomed shell's CSS pixel is not a device pixel. `setBounds` is in device
   * pixels, so the factor is applied here, where the rect is used, rather than
   * asked of every caller.
   */
  const scale = currentScale()
  const surface = ownedSurface(caller, viewId)
  surface.view.setBounds({
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  })
  if (layoutWidth === undefined || layoutWidth === surface.layoutWidth) return
  surface.layoutWidth = layoutWidth
  if (!surface.view.webContents.isDestroyed()) {
    surface.view.webContents.send(WORKBENCH_LAYOUT_CHANNEL, layoutWidth)
  }
}

function pushToOwner(
  surface: Surface,
  channel: string,
  payload: WorkbenchActivityBarPush | WorkbenchRowRevealPush | WorkbenchRowScrollPush
): void {
  if (surface.state !== 'active' || surface.owner.isDestroyed()) return
  surface.owner.send(channel, payload)
}

function revealRow(surface: Surface): void {
  pushToOwner(surface, WORKBENCH_ROW_REVEAL_PUSH_CHANNEL, { viewId: surface.id })
}

function surfaceActivityBar(caller: WebContents, viewId: string): number {
  return ownedSurface(caller, viewId).activityBarWidth
}

/** Every open surface, for shutdown. */
export function closeAllSurfaces(): Promise<void> {
  for (const pending of handoffs.values()) clearTimeout(pending.timer)
  handoffs.clear()
  for (const id of [...byId.keys()]) void destroySurface(id)
  return Promise.all([...closingSurfaces.values()].map((closing) => closing.promise)).then(
    () => undefined
  )
}

/**
 * Registers both halves of the surface IPC.
 *
 * Not folded into `registerIpcHandlers`: that registrar discards `event` by
 * design, and every channel here has to be answered from `event.sender`. The
 * request/response validation is the same discipline, deliberately repeated
 * rather than shared through a weaker registrar.
 */
/**
 * Turns an adopted project id into its root, or throws.
 *
 * Injected rather than imported. `project-service.ts` already imports
 * `approveProjectRoot` from this file, so importing the service back would close
 * a cycle — and a function is the whole of what this file needs, so taking the
 * service would be taking a registry in order to call one method on it.
 */
let resolveProjectPlace: ((projectId: string) => Promise<WorkbenchPlace>) | null = null
let openRegisteredProject: ((projectId: string) => void | Promise<void>) | null = null

interface WorkbenchReviewSource {
  reviewFile(
    owner: WebContents,
    request: GitRequest<'git:reviewFile'>
  ): Promise<GitResponse<'git:reviewFile'>>
  comment(
    owner: WebContents,
    request: GitRequest<'git:comment'>
  ): Promise<GitResponse<'git:comment'>>
  reply(owner: WebContents, request: GitRequest<'git:reply'>): Promise<GitResponse<'git:reply'>>
  resolve(
    owner: WebContents,
    request: GitRequest<'git:resolve'>
  ): Promise<GitResponse<'git:resolve'>>
  state(owner: WebContents, projectId: string): Promise<GitReviewEnvelope>
  openDiff(
    owner: WebContents,
    request: GitRequest<'git:openDiff'>
  ): Promise<GitResponse<'git:openDiff'>>
}

let reviewSource: WorkbenchReviewSource | null = null

export function setWorkbenchReviewSource(source: WorkbenchReviewSource): void {
  reviewSource = source
}

export function publishWorkbenchReview(owner: WebContents, state: GitReviewEnvelope): void {
  for (const surface of byId.values()) {
    if (surface.owner !== owner || surface.projectId !== state.projectId) continue
    const contents = liveContents(surface)
    contents?.send(WORKBENCH_REVIEW_CHANGED_CHANNEL, {
      revision: state.revision,
      review: state.review,
    })
  }
}

export function resetWorkbenchReviews(owner: WebContents): void {
  for (const surface of byId.values()) {
    if (surface.owner !== owner) continue
    liveContents(surface)?.send(WORKBENCH_REVIEW_CHANGED_CHANNEL, null)
  }
}

let detachedAccess: ((caller: WebContents, projectRoot: string) => boolean) | null = null

export function setDetachedAccessPredicate(
  predicate: ((caller: WebContents, projectRoot: string) => boolean) | null
): void {
  detachedAccess = predicate
}

export interface WorkbenchTerminalEnvSource {
  readonly current: (place: WorkbenchPlace) => WorkbenchTerminalEnv | null
  readonly ensure: (place: WorkbenchPlace) => Promise<WorkbenchTerminalEnv | null>
}

let terminalEnvSource: WorkbenchTerminalEnvSource | null = null

export function setWorkbenchTerminalEnvSource(source: WorkbenchTerminalEnvSource | null): void {
  terminalEnvSource = source
}

function terminalEnvForSurface(surface: Surface): WorkbenchTerminalEnv | null {
  return terminalEnvSource?.current({ host: surface.host, root: surface.projectRoot }) ?? null
}

async function ensuredTerminalEnvForSurface(
  surface: Surface
): Promise<WorkbenchTerminalEnv | null> {
  const source = terminalEnvSource
  if (source === null) return null
  try {
    return await source.ensure({ host: surface.host, root: surface.projectRoot })
  } catch {
    return null
  }
}

export function hasWorkbenchSurface(place: WorkbenchPlace): boolean {
  for (const surface of byId.values()) {
    if (surface.host === place.host && surface.projectRoot === place.root) return true
  }
  return false
}

export function refreshWorkbenchTerminalEnv(): void {
  for (const surface of byId.values()) {
    if (surface.view.webContents.isDestroyed()) continue
    surface.view.webContents.send(WORKBENCH_TERMINAL_ENV_CHANNEL, terminalEnvForSurface(surface))
  }
}

function fromMainFrame(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): boolean {
  const frame = event.senderFrame
  const main = event.sender.mainFrame
  return (
    frame !== null && frame.processId === main.processId && frame.frameToken === main.frameToken
  )
}

export function registerWorkbenchHandlers(
  devServerUrl: string | undefined,
  resolvePlace?: (projectId: string) => Promise<WorkbenchPlace>,
  openProject?: (projectId: string) => void | Promise<void>
): void {
  resolveProjectPlace = resolvePlace ?? null
  openRegisteredProject = openProject ?? null
  ipcMain.handle(WORKBENCH_REVIEW_STATE_CHANNEL, async (event): Promise<WorkbenchReviewState> => {
    const surface = byContents.get(event.sender)
    if (surface === undefined || !fromMainFrame(event)) throw new Error('unknown workbench surface')
    if (surface.projectId === null || reviewSource === null) return { revision: 0, review: null }
    const projectId = surface.projectId
    const state = await reviewSource.state(surface.owner, projectId)
    if (state.projectId !== projectId) throw new Error('workbench-review-project-mismatch')
    return { revision: state.revision, review: state.review }
  })
  ipcMain.handle(
    WORKBENCH_REVIEW_FILE_CHANNEL,
    async (event, raw: unknown): Promise<WorkbenchReviewFileResult> => {
      const surface = byContents.get(event.sender)
      if (surface === undefined || !fromMainFrame(event)) {
        throw new Error('unknown workbench surface')
      }
      if (surface.projectId === null || reviewSource === null) {
        return { ok: false, message: mainT('git.failure.refused-target') }
      }
      const parsed = WorkbenchReviewFileRequest.safeParse(raw)
      if (!parsed.success) return { ok: false, message: mainT('git.failure.refused-target') }
      try {
        const result = await reviewSource.reviewFile(surface.owner, {
          ...parsed.data,
          projectId: surface.projectId,
        })
        if (result.failure === null && result.text !== null) {
          return { ok: true, text: result.text }
        }
        return {
          ok: false,
          message: [mainT(`git.failure.${result.failure ?? 'git-failed'}`), result.error]
            .filter((part) => part !== null)
            .join('\n'),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const mismatch =
          message === 'channel-refused' || message.includes('Malformed response on "git:')
        return {
          ok: false,
          message: mainT(mismatch ? 'git.restartRequired' : 'git.failure.git-failed'),
        }
      }
    }
  )
  ipcMain.handle(
    WORKBENCH_REVIEW_ACTION_CHANNEL,
    async (event, raw: unknown): Promise<WorkbenchReviewActionResult> => {
      const surface = byContents.get(event.sender)
      if (surface === undefined || !fromMainFrame(event))
        throw new Error('unknown workbench surface')
      if (surface.projectId === null || reviewSource === null) {
        return { ok: false, message: mainT('git.failure.refused-target') }
      }
      const parsed = WorkbenchReviewAction.safeParse(raw)
      if (!parsed.success) return { ok: false, message: mainT('git.failure.refused-target') }
      const action = parsed.data
      const { kind, ...fields } = action
      const request = { ...fields, projectId: surface.projectId }
      try {
        let result: GitResponse<'git:openDiff'>
        switch (kind) {
          case 'openDiff':
            result = await reviewSource.openDiff(
              surface.owner,
              request as GitRequest<'git:openDiff'>
            )
            break
          case 'comment':
            result = await reviewSource.comment(surface.owner, request as GitRequest<'git:comment'>)
            break
          case 'reply':
            result = await reviewSource.reply(surface.owner, request as GitRequest<'git:reply'>)
            break
          case 'resolve':
            result = await reviewSource.resolve(surface.owner, request as GitRequest<'git:resolve'>)
            break
        }
        return result.failure === null
          ? { ok: true }
          : {
              ok: false,
              message: [mainT(`git.failure.${result.failure}`), result.error]
                .filter((part) => part !== null)
                .join('\n'),
            }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const mismatch =
          message === 'channel-refused' || message.includes('Malformed response on "git:')
        return {
          ok: false,
          message: mainT(mismatch ? 'git.restartRequired' : 'git.failure.git-failed'),
        }
      }
    }
  )
  ipcMain.on(
    WORKBENCH_STORAGE_FLUSH_RESULT_CHANNEL,
    (event, requestId: unknown, error: unknown) => {
      if (typeof requestId !== 'string') return
      const request = storageFlushRequests.get(requestId)
      if (request?.contents !== event.sender) return
      request.finish(
        error === null
          ? undefined
          : new Error(typeof error === 'string' ? error : 'Invalid workbench storage flush result')
      )
    }
  )
  ipcMain.handle(WORKBENCH_PROCESS_REPORT_CHANNEL, async (event, rawPids: unknown) => {
    const surface = byContents.get(event.sender)
    if (surface === undefined || !fromMainFrame(event)) {
      throw new Error('Editor process reports require an active workbench surface.')
    }
    await captureSurfaceProcesses(surface, terminalProcessIds(rawPids))
  })
  ipcMain.on(
    WORKBENCH_PROCESS_CLOSE_RESULT_CHANNEL,
    (event, requestId: unknown, rawPids: unknown, error: unknown, refusal: unknown) => {
      if (typeof requestId !== 'string') return
      const request = processCloseRequests.get(requestId)
      if (request?.contents !== event.sender || !fromMainFrame(event)) return
      if (refusal !== null && refusal !== undefined) {
        request.finish(
          undefined,
          refusal === 'unsaved' && request.phase === 'prepare' && error === null
            ? new UnsavedWorkbenchFilesError()
            : new Error('Invalid editor shutdown response.')
        )
        return
      }
      if (error !== null) {
        request.finish(
          undefined,
          new Error(typeof error === 'string' ? error : 'Invalid editor shutdown response.')
        )
        return
      }
      try {
        request.finish(terminalProcessIds(rawPids))
      } catch (failure) {
        request.finish(undefined, failure instanceof Error ? failure : new Error(String(failure)))
      }
    }
  )
  for (const channel of WORKBENCH_SHELL_CHANNELS) {
    ipcMain.handle(channel, async (event, rawRequest: unknown) => {
      /*
       * A surface may not drive surfaces.
       *
       * Its preload exposes no way to try, so this cannot be reached today — it
       * is here because "the renderer has no method for it" is a property of one
       * file, and the sender check is a property of the boundary.
       */
      if (byContents.has(event.sender)) {
        throw new Error(`"${channel}" is not available to a workbench surface`)
      }
      if (!isShellSender(event)) throw new Error(`"${channel}" is only available to Chorus windows`)

      const schema = WORKBENCH_SHELL_CONTRACT[channel]
      const parsedRequest = schema.request.safeParse(rawRequest)
      if (!parsedRequest.success) {
        throw new Error(`Invalid request on "${channel}": ${parsedRequest.error.message}`)
      }

      /*
       * Awaited before validation, and two arms need it now rather than one: a
       * native dialog is asynchronous, and so is opening a surface, which since
       * step 2 has to acquire the shared server's lease first — a download, a
       * checksum, an extraction and a spawn on the very first call. Validating
       * `result` without awaiting would hand the response schema a `Promise` and
       * fail at the boundary rather than at the thing that was slow.
       */
      const result = await (async (): Promise<unknown> => {
        switch (channel) {
          /*
           * `event.sender` on every arm, and never a window named in the payload.
           *
           * It is who the grant is minted for on `chooseProject`, the owner on
           * `open`, and the credential on the other two — the same object every
           * time, which is what makes ownership decidable at all rather than a
           * second thing to keep in step.
           */
          case 'workbench:chooseProject':
            return mintProjectGrant(event.sender)
          case 'workbench:open': {
            const target = parsedRequest.data as WorkbenchTarget
            return { viewId: await openSurface(event.sender, target, devServerUrl) }
          }
          case 'workbench:setBounds': {
            const { viewId, rect, layoutWidth } = parsedRequest.data as {
              viewId: string
              rect: WorkbenchRect
              layoutWidth?: number
            }
            setSurfaceBounds(event.sender, viewId, rect, layoutWidth)
            return { ok: true }
          }
          case 'workbench:activityBar': {
            const { viewId } = parsedRequest.data as { viewId: string }
            return { width: surfaceActivityBar(event.sender, viewId) }
          }
          case 'workbench:close': {
            const { viewId } = parsedRequest.data as { viewId: string }
            await closeSurface(event.sender, viewId)
            return { ok: true }
          }
          case 'workbench:setVisible': {
            const { visible, viewId, heartbeat } = parsedRequest.data as {
              visible: boolean
              viewId?: string
              heartbeat?: boolean
            }
            return {
              ok: true,
              stills: await setSurfacesVisible(event.sender, visible, viewId, heartbeat ?? false),
            }
          }
        }
      })()

      const parsedResponse = schema.response.safeParse(result)
      if (!parsedResponse.success) {
        throw new Error(`Invalid response on "${channel}": ${parsedResponse.error.message}`)
      }
      return parsedResponse.data
    })
  }

  /*
   * The pull half, and the whole of its authorisation is the sender.
   *
   * The request carries no arguments on purpose: a project id in the payload
   * would be a claim the sender is not entitled to make, and a lookup keyed on
   * "the most recently opened project" would pass every friendly version of the
   * cross-view test.
   */
  ipcMain.handle(WORKBENCH_CONNECTION_CHANNEL, (event) => {
    const surface = byContents.get(event.sender)
    if (surface === undefined) throw new Error('unknown workbench surface')
    return describe(surface)
  })

  /*
   * The same shape, for the value a surface needs before its first push. Argument-
   * free and resolved from the sender for the same reason: a view id in the
   * payload would be a claim rather than a fact.
   */
  ipcMain.handle(WORKBENCH_FOCUS_CHANNEL, (event) => {
    const surface = byContents.get(event.sender)
    if (surface === undefined) throw new Error('unknown workbench surface')
    return windowHasFocus(surface)
  })

  ipcMain.handle(WORKBENCH_TERMINAL_ENV_CHANNEL, (event) => {
    const surface = byContents.get(event.sender)
    if (surface === undefined || !fromMainFrame(event)) throw new Error('unknown workbench surface')
    return ensuredTerminalEnvForSurface(surface)
  })

  /*
   * E5's two channels, and they are the mirror image of the four above: those
   * refuse a *surface*, and these refuse everything else.
   *
   * The shell has no business reading the workbench's settings file — its preload
   * exposes no method for it, and this is the boundary saying so rather than one
   * file's export list. `byContents` is the same membership test used to answer
   * `connection`, so "is this a surface I own?" has one implementation.
   *
   * Neither handler is told a path. The read takes no argument at all and the
   * write takes a string, so the only thing a compromised surface can do here is
   * overwrite its own profile's settings file with text — which is exactly what
   * the person using the workbench can do anyway, through the settings editor.
   */
  ipcMain.handle(WORKBENCH_USER_SETTINGS_READ_CHANNEL, (event) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    return readWorkbenchUserSettings(app.getPath('userData'))
  })

  ipcMain.handle(WORKBENCH_USER_SETTINGS_WRITE_CHANNEL, (event, text: unknown) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    if (typeof text !== 'string') throw new Error('Workbench settings must be text')
    writeWorkbenchUserSettings(app.getPath('userData'), text)
  })

  /*
   * Browser extensions are application-scoped, but every workbench surface has
   * its own in-memory `vscode-userdata` provider. Main stores the one durable
   * registry and forwards a write to every other live surface so a later install
   * cannot replace it from a stale local copy.
   */
  ipcMain.handle(WORKBENCH_BROWSER_EXTENSIONS_READ_CHANNEL, (event) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    return readWorkbenchBrowserExtensions(app.getPath('userData'))
  })

  ipcMain.handle(WORKBENCH_BROWSER_EXTENSIONS_WRITE_CHANNEL, (event, text: unknown) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    if (typeof text !== 'string') throw new Error('Browser extension registry must be text')
    writeWorkbenchBrowserExtensions(app.getPath('userData'), text)

    for (const [id, surface] of byId) {
      if (surface.view.webContents === event.sender) continue
      if (surface.view.webContents.isDestroyed()) continue
      void id
      surface.view.webContents.send(WORKBENCH_BROWSER_EXTENSIONS_CHANGED_CHANNEL, text)
    }
  })

  /*
   * The storage pair, on the same authorisation as the settings pair: the sender
   * must be a live surface, and `byContents` is the one membership test.
   *
   * **These two do take an argument, and it is not a path.** The scope key names
   * one of the storage service's scopes, and main cannot derive which is meant —
   * unlike the settings file, there are several and one of them is per workspace.
   * It is used only as a property name inside a single JSON file, so a surface
   * running third-party extension code cannot steer it at the filesystem; the
   * shape of that file is the mitigation, not a filter here.
   *
   * A non-string scope is refused rather than coerced: `String(x)` on an object
   * would put `[object Object]` in the file as a real scope that a later honest
   * caller could collide with.
   */
  ipcMain.handle(WORKBENCH_STORAGE_READ_CHANNEL, (event, scope: unknown) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    if (typeof scope !== 'string' || scope === '') throw new Error('Storage scope must be text')
    return readWorkbenchStorage(app.getPath('userData'), scope)
  })

  ipcMain.handle(
    WORKBENCH_STORAGE_WRITE_CHANNEL,
    async (event, scope: unknown, insert: unknown, remove: unknown) => {
      if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
      if (typeof scope !== 'string' || scope === '') throw new Error('Storage scope must be text')
      if (typeof insert !== 'object' || insert === null || Array.isArray(insert)) {
        throw new Error('Storage insert must be an object')
      }
      if (!Array.isArray(remove)) throw new Error('Storage remove must be an array')

      const inserted: Record<string, string> = {}
      for (const [key, value] of Object.entries(insert as Record<string, unknown>)) {
        if (typeof value !== 'string') throw new Error('Storage values must be text')
        inserted[key] = value
      }
      const removed = remove.filter((key): key is string => typeof key === 'string')

      await applyWorkbenchStorageDelta(app.getPath('userData'), scope, inserted, removed)

      /*
       * Then tell every *other* surface, because they hold their own cache of
       * the shared scopes and would otherwise drift from the file until relaunch.
       *
       * Not the sender: it already applied this delta locally, and echoing it
       * back would fire `onDidChangeItemsExternal` for a change that was not
       * external — which is how a service concludes it has been raced and
       * re-reads state it already has.
       *
       * Every other surface rather than only those on the same scope: main does
       * not track which scopes a surface holds, and a surface that does not know
       * the scope ignores it. Broadcasting a name is cheaper than maintaining a
       * registry that can go stale.
       */
      for (const [id, surface] of byId) {
        if (surface.view.webContents === event.sender) continue
        if (surface.view.webContents.isDestroyed()) continue
        void id
        surface.view.webContents.send(WORKBENCH_STORAGE_CHANGED_CHANNEL, scope, inserted, removed)
      }
    }
  )

  /*
   * Credentials, on the same authorisation as everything else here and with one
   * extra property: **main never returns a secret it cannot decrypt, and never
   * stores one it cannot encrypt.** Both degrade to "no secret", which is the
   * state a fresh profile is in and which every caller already handles by asking
   * the person to sign in.
   *
   * The key is a string from the surface, exactly as with storage scopes, and it
   * is a property name in a JSON object rather than a path — the same mitigation,
   * for the same reason, in a file where the stakes are higher.
   */
  ipcMain.handle(WORKBENCH_SECRET_READ_CHANNEL, (event, key: unknown) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    if (typeof key !== 'string' || key === '') throw new Error('Secret key must be text')
    return readWorkbenchSecret(app.getPath('userData'), key)
  })

  ipcMain.handle(WORKBENCH_SECRET_WRITE_CHANNEL, (event, key: unknown, value: unknown) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    if (typeof key !== 'string' || key === '') throw new Error('Secret key must be text')
    if (typeof value !== 'string') throw new Error('Secret must be text')
    writeWorkbenchSecret(app.getPath('userData'), key, value)
  })

  ipcMain.handle(WORKBENCH_SECRET_DELETE_CHANNEL, (event, key: unknown) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    if (typeof key !== 'string' || key === '') throw new Error('Secret key must be text')
    deleteWorkbenchSecret(app.getPath('userData'), key)
  })

  /*
   * The system clipboard, read on a surface's behalf.
   *
   * The workbench partition denies every browser permission, `clipboard-read`
   * among them — deliberately, since that grant would reach every iframe and
   * extension webview in the partition. The terminal's paste is the one thing
   * that needed it: `⌘V` there is a command calling `IClipboardService.readText`,
   * not a native paste event, and the browser implementation swallows the
   * refusal and returns `''`.
   *
   * So the capability lives here instead, where it is one channel with one
   * sender check rather than a session-wide grant. **Read only and no argument**:
   * a surface cannot say what to read and cannot write, which is the same shape
   * as the user-settings channels and for the same reason.
   *
   * The sender check is the boundary. `byContents` holds only live surfaces this
   * process opened, so a `WebContents` that is not one of them — an extension
   * webview's own frame, anything else in the session — is refused rather than
   * defaulted, exactly as every other channel here treats an unknown sender.
   */
  ipcMain.handle(WORKBENCH_CLIPBOARD_READ_CHANNEL, (event) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    return clipboard.readText()
  })

  ipcMain.handle(
    WORKBENCH_COMPLETION_CHANNEL,
    async (event, requestId: unknown, payload: unknown): Promise<CompletionReply> => {
      if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
      if (typeof requestId !== 'string' || requestId === '')
        throw new Error('Completion id must be text')
      if (!isCompletionPayload(payload)) throw new Error('Invalid completion payload')

      if (cancelledCompletions.has(requestId)) {
        cancelledCompletions.delete(requestId)
        return { configured: completionConfigured(app.getPath('userData')), text: null }
      }

      const controller = new AbortController()
      completions.set(requestId, controller)

      try {
        if (cancelledCompletions.has(requestId)) {
          controller.abort()
          return { configured: completionConfigured(app.getPath('userData')), text: null }
        }
        return await requestCompletion(
          app.getPath('userData'),
          requestId,
          payload,
          controller.signal
        )
      } finally {
        completions.delete(requestId)
        cancelledCompletions.delete(requestId)
      }
    }
  )

  if (isE2eProfile()) {
    ipcMain.handle(WORKBENCH_COMPLETION_PROBE_CHANNEL, async (event) => {
      if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
      await probeCompletionCache(app.getPath('userData'))
    })
  }

  ipcMain.on(WORKBENCH_EDITOR_REPORT_CHANNEL, (event, raw: unknown) => {
    if (!byContents.has(event.sender)) return
    recordEditorOutcome(raw)
  })

  ipcMain.on(WORKBENCH_COMPLETION_CANCEL_CHANNEL, (event, requestId: unknown) => {
    if (!byContents.has(event.sender)) return
    if (typeof requestId !== 'string' || requestId === '') return

    const controller = completions.get(requestId)
    if (controller !== undefined) {
      controller.abort()
      completions.delete(requestId)
      return
    }

    if (cancelledCompletions.size >= CANCELLED_COMPLETIONS_LIMIT) {
      const oldest = cancelledCompletions.values().next().value
      if (oldest !== undefined) cancelledCompletions.delete(oldest)
    }
    cancelledCompletions.add(requestId)
  })

  /*
   * What the editor is looking at — Phase 6 slice 6a.
   *
   * `on` rather than `handle`, matching the preload's `send`: this fires on
   * cursor movement, and a reply would put a round trip inside every keystroke
   * for a value the next movement supersedes.
   *
   * **The project comes from `byContents`, never from the message.** The surface
   * reports a relative path and a position and nothing else; main attaches the
   * root it opened that surface for. That is the same rule `redeem` applies in
   * the other direction, and it is what stops a compromised surface — which runs
   * third-party extension code by design — attributing its cursor to a project
   * it was not opened for.
   *
   * **A bad frame is dropped, not thrown.** There is no reply for a throw to
   * reach, and an unparsed report is corrected by the next one; the failure this
   * must not have is a malformed payload reaching a listener.
   */
  ipcMain.on(WORKBENCH_CONTEXT_CHANNEL, (event, raw: unknown) => {
    const surface = byContents.get(event.sender)
    if (surface === undefined) return
    const parsed = WorkbenchContext.safeParse(raw)
    if (!parsed.success) return
    surface.context = parsed.data
    if (surface.state !== 'active') return
    onContext?.(
      { host: surface.host, projectRoot: surface.projectRoot, context: parsed.data },
      surface.owner
    )
  })

  ipcMain.handle(
    WORKBENCH_PREVIEW_SELECTION_CHANNEL,
    async (event, frameName: unknown): Promise<PreviewSelection | null> => {
      if (!byContents.has(event.sender) || !fromMainFrame(event)) {
        throw new Error('unknown workbench surface')
      }
      if (typeof frameName !== 'string' || frameName === '') {
        throw new Error('Frame name must be text')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const frame = event.sender.mainFrame.frames.find((child) => child.name === frameName)
        if (frame === undefined) return null
        const raw: unknown = await Promise.race([
          frame.executeJavaScript(READ_PREVIEW_SELECTION).catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => {
              resolve(null)
            }, 500)
          }),
        ])
        const parsed = PreviewSelection.safeParse(raw)
        return parsed.success ? parsed.data : null
      } catch {
        return null
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  )

  ipcMain.on(WORKBENCH_ACTIVITY_BAR_REPORT_CHANNEL, (event, raw: unknown) => {
    const surface = byContents.get(event.sender)
    if (surface === undefined) return
    const parsed = WorkbenchActivityBarWidth.safeParse(raw)
    if (!parsed.success || parsed.data === surface.activityBarWidth) return
    surface.activityBarWidth = parsed.data
    pushToOwner(surface, WORKBENCH_ACTIVITY_BAR_PUSH_CHANNEL, {
      viewId: surface.id,
      width: parsed.data,
    })
  })

  ipcMain.on(WORKBENCH_ROW_REQUEST_CHANNEL, (event) => {
    const surface = byContents.get(event.sender)
    if (surface === undefined) return
    revealRow(surface)
  })

  ipcMain.on(WORKBENCH_ROW_SCROLL_REQUEST_CHANNEL, (event, raw: unknown) => {
    const surface = byContents.get(event.sender)
    if (surface === undefined) return
    const parsed = WorkbenchRowScrollDelta.safeParse(raw)
    if (!parsed.success || parsed.data === 0) return
    pushToOwner(surface, WORKBENCH_ROW_SCROLL_PUSH_CHANNEL, {
      viewId: surface.id,
      delta: parsed.data,
    })
  })

  /*
   * The other half of `requestWorkbenchEdit` — Phase 6d.
   *
   * The sender is checked the same way everything else from a surface is: an
   * unknown `WebContents` is a refusal, never a default. That matters more here
   * than for context, because a forged reply would settle a real request with a
   * result the agent then believes.
   *
   * An id nobody is waiting for is dropped silently. It is what a late reply
   * after a timeout looks like, and there is nothing to do about it — the
   * request has already been answered.
   */
  ipcMain.on(WORKBENCH_SNAPSHOT_RESULT_CHANNEL, (event, raw: unknown) => {
    if (byContents.get(event.sender) === undefined) return
    if (typeof raw !== 'object' || raw === null) return
    const result = raw as WorkbenchSnapshotResult
    if (typeof result.requestId !== 'string') return
    pendingSnapshots.get(result.requestId)?.(result)
  })

  ipcMain.on(WORKBENCH_ASK_DIFF_RESULT_CHANNEL, (event, raw: unknown) => {
    if (byContents.get(event.sender) === undefined) return
    if (typeof raw !== 'object' || raw === null) return
    const result = raw as WorkbenchAskDiffResult
    if (typeof result.requestId !== 'string') return
    pendingAskDiffs.get(result.requestId)?.(result)
  })

  ipcMain.on(WORKBENCH_REVIEW_DIFF_RESULT_CHANNEL, (event, raw: unknown) => {
    if (byContents.get(event.sender) === undefined) return
    if (typeof raw !== 'object' || raw === null) return
    const result = raw as Record<string, unknown>
    const requestId = result['requestId']
    const ok = result['ok']
    const failure = result['failure']
    const message = result['message']
    if (typeof requestId !== 'string' || typeof ok !== 'boolean') return
    if (failure !== undefined && failure !== 'no-editor' && failure !== 'open-failed') return
    if (message !== undefined && typeof message !== 'string') return
    const pending = pendingReviewDiffs.get(requestId)
    if (pending?.contents !== event.sender) return
    pending.settle({
      requestId,
      ok,
      ...(failure === undefined ? {} : { failure }),
      ...(message === undefined ? {} : { message }),
    })
  })

  ipcMain.on(WORKBENCH_EDIT_RESULT_CHANNEL, (event, raw: unknown) => {
    if (byContents.get(event.sender) === undefined) return
    if (typeof raw !== 'object' || raw === null) return
    const result = raw as WorkbenchEditResult
    if (typeof result.requestId !== 'string') return
    pendingEdits.get(result.requestId)?.(result)
  })

  ipcMain.on(WORKBENCH_REVEAL_RESULT_CHANNEL, (event, raw: unknown) => {
    if (byContents.get(event.sender) === undefined) return
    if (typeof raw !== 'object' || raw === null) return
    const result = raw as WorkbenchRevealResult
    if (typeof result.requestId !== 'string') return
    pendingReveals.get(result.requestId)?.(result)
  })
}

/**
 * Where a surface's editor state goes, injected rather than imported.
 *
 * The same shape as `resolveProjectPlace`: this file already sits below
 * `project-service.ts`, and reaching up to a consumer from here would close a
 * cycle. It also keeps this module's job unchanged — it owns surfaces, not what
 * anybody does with what they report.
 *
 * Held, never logged. `CLAUDE.md`'s rule is that a cursor position read back a
 * week later is worse than none, so there is no event type for this and there
 * must not be one.
 */
export interface WorkbenchContextReport {
  readonly host: string
  readonly projectRoot: string
  readonly context: WorkbenchContext
}

let onContext: ((report: WorkbenchContextReport, owner: WebContents) => void) | null = null

/**
 * Told when a project's last surface goes, so a held context can be dropped.
 *
 * Without it "the workbench wins once it has ever reported" outlives the
 * workbench: close the editor and the shell keeps preferring a context from a
 * surface that no longer exists, while the external bridge — which may now be
 * the only editor there is — stays suppressed behind it.
 */
let onSurfaceGone: ((place: WorkbenchPlace, owner: WebContents) => void) | null = null

export function setWorkbenchSurfaceGoneSink(
  sink: ((place: WorkbenchPlace, owner: WebContents) => void) | null
): void {
  onSurfaceGone = sink
}

let onHandoffExpired: ((projectRoot: string) => void) | null = null

export function setHandoffExpiredSink(sink: ((projectRoot: string) => void) | null): void {
  onHandoffExpired = sink
}

export function setWorkbenchContextSink(
  sink: ((report: WorkbenchContextReport, owner: WebContents) => void) | null
): void {
  onContext = sink
}

/**
 * Edits in flight, by request id — Phase 6d.
 *
 * A map rather than a single pending promise, because two agents in one project
 * can both be mid-edit and a turn can issue several. The id is what makes the
 * replies distinguishable; without it the second result would settle the first
 * request and one edit would be reported with another's outcome.
 */
const pendingEdits = new Map<string, (result: WorkbenchEditResult) => void>()

const pendingAskDiffs = new Map<string, (result: WorkbenchAskDiffResult) => void>()

const pendingReviewDiffs = new Map<
  string,
  { contents: WebContents; settle: (result: WorkbenchReviewDiffResult) => void }
>()

export async function requestWorkbenchReviewDiff(
  projectRoot: string,
  request: WorkbenchReviewDiffInput
): Promise<WorkbenchReviewDiffResult> {
  const surface = [...byId.values()].find(
    (entry) =>
      entry.host === LOCAL_HOST &&
      entry.projectRoot === projectRoot &&
      entry.state === 'active' &&
      !editorHidden.has(projectRoot) &&
      liveContents(entry) !== null
  )
  const contents = surface === undefined ? null : liveContents(surface)
  const requestId = randomUUID()
  if (contents === null) return { requestId, ok: false, failure: 'no-editor' }

  return new Promise<WorkbenchReviewDiffResult>((resolve) => {
    const gone = (): void => {
      settle({ requestId, ok: false, failure: 'no-editor' })
    }
    const reloading = (): void => {
      settle({ requestId, ok: false, failure: 'open-failed' })
    }
    const timer = setTimeout(() => {
      settle({ requestId, ok: false, failure: 'open-failed' })
    }, EDIT_TIMEOUT_MS)
    const settle = (result: WorkbenchReviewDiffResult): void => {
      if (!pendingReviewDiffs.delete(requestId)) return
      clearTimeout(timer)
      contents.removeListener('destroyed', gone)
      contents.removeListener('render-process-gone', gone)
      contents.removeListener('did-start-loading', reloading)
      resolve(result)
    }
    pendingReviewDiffs.set(requestId, { contents, settle })
    contents.once('destroyed', gone)
    contents.once('render-process-gone', gone)
    contents.once('did-start-loading', reloading)
    try {
      contents.send(WORKBENCH_REVIEW_DIFF_CHANNEL, { ...request, requestId })
    } catch (error) {
      settle({
        requestId,
        ok: false,
        failure: 'open-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

/**
 * Shows, replaces or closes the proposed-edit diff in a project's editor.
 *
 * **Refuses rather than opening a surface**, like `requestWorkbenchEdit`: an
 * editor that is not up is a deliberate state, and opening one because an agent
 * proposed an edit would rearrange the window on the person's behalf. The card
 * still asks; only the diff is missing, which is the degradation the plan chose.
 */
export async function requestWorkbenchAskDiff(
  projectRoot: string,
  request: Omit<WorkbenchAskDiffRequest, 'requestId'>
): Promise<WorkbenchAskDiffResult> {
  const surface = [...byId.values()].find((s) => s.projectRoot === projectRoot)
  const requestId = randomUUID()
  if (surface === undefined || surface.view.webContents.isDestroyed()) {
    return { requestId, ok: false, message: 'This project has no editor open.' }
  }

  return new Promise<WorkbenchAskDiffResult>((resolve) => {
    const settle = (result: WorkbenchAskDiffResult): void => {
      if (!pendingAskDiffs.delete(requestId)) return
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      settle({ requestId, ok: false, message: 'The editor did not answer.' })
    }, EDIT_TIMEOUT_MS)
    pendingAskDiffs.set(requestId, settle)
    surface.view.webContents.send(WORKBENCH_ASK_DIFF_CHANNEL, { ...request, requestId })
  })
}

/**
 * How long a surface has to answer before the edit is called a failure.
 *
 * Generous, because the far side may be resolving a model for a file that is not
 * open, and mean because an edit nobody answers must not hang a turn for ever.
 */
const EDIT_TIMEOUT_MS = 15_000

const pendingReveals = new Map<string, (result: WorkbenchRevealResult) => void>()

/**
 * Opens a file in the editor of the project it belongs to.
 *
 * **`undefined` means there is no surface, and that is the whole reason this
 * returns a union.** It is the same distinction `requestWorkbenchSnapshot`
 * draws, and for the same reason one level up: `ide:openFile` falls back to
 * external VS Code when the Editor switch is off, and must *not* fall back when
 * an editor is up and refused. Flattening both into a failure would spawn a
 * second editor every time a file was missing.
 *
 * Shorter budget than an edit, and longer than a snapshot. Nothing waits on
 * this — no turn, no message — but it sits under a click, and a click that
 * appears to do nothing for fifteen seconds is worse than one that falls back.
 */
export async function requestWorkbenchReveal(
  projectRoot: string,
  target: { readonly path: string; readonly line: number | null; readonly column: number | null }
): Promise<WorkbenchRevealResult | undefined> {
  const surface = [...byId.values()].find((s) => s.projectRoot === projectRoot)
  if (surface === undefined || surface.view.webContents.isDestroyed()) return undefined

  const requestId = randomUUID()
  return new Promise<WorkbenchRevealResult>((resolve) => {
    const settle = (result: WorkbenchRevealResult): void => {
      if (!pendingReveals.delete(requestId)) return
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      settle({ requestId, ok: false, message: 'The editor did not answer.' })
    }, 5_000)
    pendingReveals.set(requestId, settle)
    surface.view.webContents.send(WORKBENCH_REVEAL_CHANNEL, { ...target, requestId })
  })
}

/** Snapshot requests in flight, by id. Same correlation as the edits below. */
const pendingSnapshots = new Map<string, (result: WorkbenchSnapshotResult) => void>()

/**
 * Asks the surface showing this project what its editor is showing.
 *
 * `null` for "this project has no surface", which is what tells `ide:snapshot`
 * to fall back to the external bridge — distinct from a surface that answered
 * with no file open, which is a real answer and must not be retried elsewhere.
 */
export async function requestWorkbenchSnapshot(
  place: WorkbenchPlace
): Promise<WorkbenchSnapshotResult['snapshot'] | undefined> {
  const surface = [...byId.values()].find(
    (s) => s.host === place.host && s.projectRoot === place.root
  )
  if (surface === undefined || surface.view.webContents.isDestroyed()) return undefined

  const requestId = randomUUID()
  return new Promise((resolve) => {
    const settle = (result: WorkbenchSnapshotResult): void => {
      if (!pendingSnapshots.delete(requestId)) return
      clearTimeout(timer)
      resolve(result.snapshot)
    }
    /*
     * Shorter than an edit's budget on purpose: this one sits between pressing
     * Send and the message going, so a surface that is wedged must cost a moment
     * and not the turn. Timing out answers `null`, and the message is sent
     * without editor context rather than not at all.
     */
    const timer = setTimeout(() => {
      settle({ requestId, snapshot: null })
    }, 2_000)
    pendingSnapshots.set(requestId, settle)
    surface.view.webContents.send(WORKBENCH_SNAPSHOT_CHANNEL, { requestId })
  })
}

/**
 * Asks the surface showing this project to apply an edit, and waits.
 *
 * **Refuses rather than opening one.** If the project has no surface — the
 * Editor switch is off, or the project is not on screen — there is no model to
 * edit and no undo stack to join, and silently writing the file instead would
 * be exactly the behaviour Phase 6d exists to replace. The caller is told, and
 * can fall back to a filesystem write with the person's approval if that is
 * what it wants.
 */
export async function requestWorkbenchEdit(
  place: WorkbenchPlace,
  edit: Omit<WorkbenchEditRequest, 'requestId'>
): Promise<WorkbenchEditResult> {
  const surface = [...byId.values()].find(
    (s) => s.host === place.host && s.projectRoot === place.root
  )
  const requestId = randomUUID()
  if (surface === undefined || surface.view.webContents.isDestroyed()) {
    return {
      requestId,
      ok: false,
      refusal: 'no-editor',
      message: 'This project has no editor open, so there is no model to edit.',
      version: null,
    }
  }

  return new Promise<WorkbenchEditResult>((resolve) => {
    const settle = (result: WorkbenchEditResult): void => {
      if (!pendingEdits.delete(requestId)) return
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      settle({
        requestId,
        ok: false,
        refusal: 'failed',
        message: `The editor did not answer within ${String(EDIT_TIMEOUT_MS / 1000)}s.`,
        version: null,
      })
    }, EDIT_TIMEOUT_MS)
    pendingEdits.set(requestId, settle)
    surface.view.webContents.send(WORKBENCH_EDIT_CHANNEL, { ...edit, requestId })
  })
}
