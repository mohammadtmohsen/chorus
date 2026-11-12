import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ChorusWorkbenchApi,
  EditorReport,
  CompletionPayload,
  PreviewSelection,
  WorkbenchConnection,
  WorkbenchReviewActionResult,
  WorkbenchReviewFileResult,
  WorkbenchTerminalEnv,
} from '../shared/workbench-ipc.js'

/**
 * The workbench surface's own preload, and the reason it exists is what it is
 * not (preflight §4.1b).
 *
 * The shell's preload ends with `contextBridge.exposeInMainWorld('chorus', api)`
 * over the whole `ChorusApi` — some seventy methods, among them `decideApproval`,
 * `writeProjectFile`, `runGitAction` and every `terminal:*` channel. A workbench
 * document runs third-party extension code by design, so handing it that object
 * would let extension code answer Chorus's own permission prompts. The failure
 * mode is quiet, too: copying the window's `webPreferences` to "keep the sandbox
 * settings consistent" brings `preload` along silently, which is why
 * `workbench-surface.ts` builds its own literal and never spreads.
 *
 * One method. No bounds, no commands, no `ipcRenderer` pass-through.
 *
 * What this does not buy, said plainly: once `connection()` resolves, whatever it
 * carries is in this document's JavaScript heap. The preload narrows who can ask
 * and what else is reachable; it does not make the answer unreadable by code
 * running here. What it removes is the shell's ability to ask at all, and this
 * document's ability to do anything else with Chorus.
 */

/**
 * Everything below is imported as a **type** and nothing as a value, and that is
 * a build constraint rather than a style.
 *
 * Two preload entries that share one runtime module make Rollup hoist it into
 * `out/preload/chunks/`, and a sandboxed preload cannot load it. Observed, from
 * the app's own console: `Unable to load preload script: …/out/preload/index.js`
 * / `Error: module not found: ./chunks/workbench-ipc-CCkEpa_4.js`, and with it a
 * shell whose `window.chorus` was `undefined` — the *shell's* preload broken by a
 * file added for the workbench. The config's existing note says a sandboxed
 * preload cannot resolve from `node_modules`; this is the same fact one step
 * further in, and it applies to our own emitted chunks.
 *
 * So this file shares no runtime module with `preload/index.ts`: the channel name
 * is written out, and the descriptor is checked by hand rather than with zod. A
 * test asserts the constant still equals the shared one, because two spellings of
 * one channel is precisely the drift that shows up as a dead control rather than
 * an error.
 */
export const CONNECTION_CHANNEL = 'workbench:connection'
export const PROCESS_REPORT_CHANNEL = 'workbench:process:report'
export const PROCESS_CLOSE_CHANNEL = 'workbench:process:close'
export const PROCESS_CLOSE_RESULT_CHANNEL = 'workbench:process:close:result'
/* The window-focus pair, push and pull on one name, under the same test. */
export const FOCUS_CHANNEL = 'workbench:focus'
export const TERMINAL_ENV_CHANNEL = 'workbench:terminalEnv'
/*
 * Persistence channels are spelled out for the same reason and carry the same
 * risk. A test asserts them against the shared constants, because a channel name
 * that drifts here fails as silence — an `invoke` nobody answers — rather than
 * as an error naming the channel.
 */
export const USER_SETTINGS_READ_CHANNEL = 'workbench:userSettings:read'
export const USER_SETTINGS_WRITE_CHANNEL = 'workbench:userSettings:write'
export const BROWSER_EXTENSIONS_READ_CHANNEL = 'workbench:browserExtensions:read'
export const BROWSER_EXTENSIONS_WRITE_CHANNEL = 'workbench:browserExtensions:write'
export const BROWSER_EXTENSIONS_CHANGED_CHANNEL = 'workbench:browserExtensions:changed'
/* The storage pair, under the same test and drifting the same silent way. */
export const STORAGE_READ_CHANNEL = 'workbench:storage:read'
export const STORAGE_WRITE_CHANNEL = 'workbench:storage:write'
export const STORAGE_CHANGED_CHANNEL = 'workbench:storage:changed'
export const STORAGE_FLUSH_CHANNEL = 'workbench:storage:flush'
export const STORAGE_FLUSH_RESULT_CHANNEL = 'workbench:storage:flush:result'
/* The OAuth callback push, under the same test as every other name here. */
export const URL_CHANNEL = 'workbench:url'
/* Credentials. Separate from the storage pair because the stakes are. */
export const SECRET_READ_CHANNEL = 'workbench:secret:read'
export const SECRET_WRITE_CHANNEL = 'workbench:secret:write'
export const SECRET_DELETE_CHANNEL = 'workbench:secret:delete'
/* Clipboard *read* only — the partition denies the browser API for it. */
export const CLIPBOARD_READ_CHANNEL = 'workbench:clipboard:read'
/* Phase 6 slice 6a, spelled out here for the same reason and under the same test. */
export const CONTEXT_CHANNEL = 'workbench:context'
export const SNAPSHOT_CHANNEL = 'workbench:snapshot'
export const SNAPSHOT_RESULT_CHANNEL = 'workbench:snapshot:result'
export const PREVIEW_SELECTION_CHANNEL = 'workbench:preview-selection'
export const EDIT_CHANNEL = 'workbench:edit'
export const EDIT_RESULT_CHANNEL = 'workbench:edit:result'
/* The proposed-edit diff — open, replace or close. */
export const ASK_DIFF_CHANNEL = 'workbench:askDiff'
export const ASK_DIFF_RESULT_CHANNEL = 'workbench:askDiff:result'
export const REVIEW_DIFF_CHANNEL = 'workbench:reviewDiff'
export const REVIEW_DIFF_RESULT_CHANNEL = 'workbench:reviewDiff:result'
export const REVIEW_STATE_CHANNEL = 'workbench:review:state'
export const REVIEW_CHANGED_CHANNEL = 'workbench:review:changed'
export const REVIEW_ACTION_CHANNEL = 'workbench:review:action'
export const REVIEW_FILE_CHANNEL = 'workbench:review:file'
/* Opening a file a transcript row named, in this project's editor. */
export const REVEAL_CHANNEL = 'workbench:reveal'
export const REVEAL_RESULT_CHANNEL = 'workbench:reveal:result'
/* The completion request and its cancel. Spelled out here for the same reason. */
export const COMPLETION_CHANNEL = 'workbench:completion'
export const COMPLETION_CANCEL_CHANNEL = 'workbench:completion:cancel'
export const EDITOR_REPORT_CHANNEL = 'workbench:editor:report'
export const COMPLETION_PROBE_CHANNEL = 'workbench:completion:probe'
export const LAYOUT_CHANNEL = 'workbench:layout'
export const ACTIVITY_BAR_REPORT_CHANNEL = 'workbench:activityBar:report'
export const ROW_REQUEST_CHANNEL = 'workbench:row:request'
export const ROW_SCROLL_REQUEST_CHANNEL = 'workbench:row:scroll'

/**
 * A hand-written check instead of a schema, for the reason above — and it is now
 * five fields rather than one, which is exactly when the temptation to import zod
 * returns. It is still refused: a shared runtime module is a shared emitted
 * chunk, and a sandboxed preload cannot load one.
 *
 * Every field is required. A descriptor missing its token would otherwise reach
 * the workbench as a connection with no credential, and the failure would arrive
 * as an unauthorised WebSocket several layers in rather than at the boundary.
 *
 * **And this function rebuilds the object rather than passing it along, so a
 * field added to the shared schema and not added here is silently dropped.** That
 * is not a hypothetical: `workspaceTrust` was added in main, admitted by the zod
 * schema, spread into the descriptor, read by the renderer — and never arrived,
 * because this list still had five names in it. The gate reported a Workspace
 * Trust dialog it had been told would not appear, and every layer in between
 * looked correct. Adding a descriptor field is a two-file change, and this is the
 * second file.
 */
export function asConnection(value: unknown): WorkbenchConnection | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const fields = ['projectRoot', 'remoteAuthority', 'connectionToken', 'commit', 'quality'] as const
  for (const field of fields) {
    const held = record[field]
    if (typeof held !== 'string' || held === '') return null
  }
  const reviewLabels = record['reviewLabels']
  if (typeof reviewLabels !== 'object' || reviewLabels === null || !('title' in reviewLabels)) {
    return null
  }
  const title = reviewLabels.title
  if (typeof title !== 'string' || title === '') return null
  const labels = reviewLabels as Record<string, unknown>
  const actionFailed = labels['actionFailed']
  const comment = labels['comment']
  const reply = labels['reply']
  const resolve = labels['resolve']
  const reopen = labels['reopen']
  const commentingBlocked = labels['commentingBlocked']
  const status = labels['status']
  if (typeof actionFailed !== 'string' || actionFailed === '') return null
  if (
    typeof comment !== 'string' ||
    comment === '' ||
    typeof reply !== 'string' ||
    reply === '' ||
    typeof resolve !== 'string' ||
    resolve === '' ||
    typeof reopen !== 'string' ||
    reopen === '' ||
    typeof commentingBlocked !== 'string' ||
    commentingBlocked === ''
  ) {
    return null
  }
  if (typeof status !== 'object' || status === null) return null
  const statuses = status as Record<string, unknown>
  const added = statuses['added']
  const removed = statuses['removed']
  const modified = statuses['modified']
  const renamed = statuses['renamed']
  if (
    typeof added !== 'string' ||
    typeof removed !== 'string' ||
    typeof modified !== 'string' ||
    typeof renamed !== 'string'
  ) {
    return null
  }
  return {
    projectRoot: record['projectRoot'] as string,
    remoteAuthority: record['remoteAuthority'] as string,
    connectionToken: record['connectionToken'] as string,
    commit: record['commit'] as string,
    quality: record['quality'] as string,
    reviewLabels: {
      title,
      actionFailed,
      comment,
      reply,
      resolve,
      reopen,
      commentingBlocked,
      status: { added, removed, modified, renamed },
    },
    ...(typeof record['processNonce'] === 'string' &&
    /^[0-9a-f-]{36}$/i.test(record['processNonce'])
      ? { processNonce: record['processNonce'] }
      : {}),
    /*
     * Carried only when it is exactly the one string that means anything, and
     * dropped otherwise — a boolean, a typo, a future spelling, a value someone
     * hoped would mean the same thing. Every rejection lands on the safe side,
     * because the absence of this field is what enforces Workspace Trust.
     */
    ...(record['workspaceTrust'] === 'waived' ? { workspaceTrust: 'waived' as const } : {}),
  }
}

export function asTerminalEnv(value: unknown): WorkbenchTerminalEnv | null {
  if (typeof value !== 'object' || value === null) return null
  const { name, value: url } = value as { name?: unknown; value?: unknown }
  if (typeof name !== 'string' || name === '' || typeof url !== 'string' || url === '') return null
  return { name, value: url }
}

export function asLayoutWidth(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/**
 * The earliest possible receiver.
 *
 * Preload scripts are injected before the page loads, so this listener is
 * registered before the entry module's graph has even begun to evaluate. Main
 * sequences its push on this view's own `did-finish-load`, but there is still a
 * window between the document existing and the entry subscribing — and under a
 * full workbench that graph is large. The buffer is what makes main's ordering
 * sufficient rather than merely likely.
 */
let buffered: WorkbenchConnection | null = null

ipcRenderer.on(CONNECTION_CHANNEL, (_event, payload: unknown) => {
  // Checked on this side too: main is trusted, but a shape mismatch is our bug
  // and should surface at the boundary rather than deep inside VS Code's startup.
  const parsed = asConnection(payload)
  if (parsed !== null) buffered = parsed
})

let layoutWidth: number | null = null
let layoutHandler: ((width: number) => void) | null = null

ipcRenderer.on(LAYOUT_CHANNEL, (_event, payload: unknown) => {
  const width = asLayoutWidth(payload)
  if (width === null) return
  layoutWidth = width
  layoutHandler?.(width)
})

const api: ChorusWorkbenchApi = {
  reviewFile: async (request): Promise<WorkbenchReviewFileResult> => {
    const raw: unknown = await ipcRenderer.invoke(REVIEW_FILE_CHANNEL, request)
    if (typeof raw === 'object' && raw !== null && 'ok' in raw) {
      if (raw.ok === true && 'text' in raw && typeof raw.text === 'string') {
        return { ok: true, text: raw.text }
      }
      if (
        raw.ok === false &&
        'message' in raw &&
        typeof raw.message === 'string' &&
        raw.message !== ''
      ) {
        return { ok: false, message: raw.message }
      }
    }
    throw new Error('Malformed workbench review file response')
  },
  reviewState: async (): Promise<unknown> => {
    const raw: unknown = await ipcRenderer.invoke(REVIEW_STATE_CHANNEL)
    return raw
  },
  onReviewChanged: (handler) => {
    const listener = (_event: IpcRendererEvent, state: unknown): void => {
      handler(state)
    }
    ipcRenderer.on(REVIEW_CHANGED_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(REVIEW_CHANGED_CHANNEL, listener)
    }
  },
  reviewAction: async (action): Promise<WorkbenchReviewActionResult> => {
    const raw: unknown = await ipcRenderer.invoke(REVIEW_ACTION_CHANNEL, action)
    if (typeof raw === 'object' && raw !== null && 'ok' in raw) {
      if (raw.ok === true) return { ok: true }
      if (
        raw.ok === false &&
        'message' in raw &&
        typeof raw.message === 'string' &&
        raw.message !== ''
      ) {
        return { ok: false, message: raw.message }
      }
    }
    throw new Error('Malformed workbench review action response')
  },
  connection: async () => {
    if (buffered !== null) return buffered

    /*
     * A pull answers a reload, because a buffer does not survive one.
     *
     * If this document reloads — a crash recovery, a dev-server full reload,
     * anything calling `location.reload()` — the preload re-executes with an
     * empty buffer and main's push has already happened. Push and pull are one
     * mechanism with two triggers, not two mechanisms; without this arm the
     * reload case hangs rather than throwing, which reads as a slow workbench
     * rather than a broken one.
     *
     * The request carries no arguments. A project id in the payload would be a
     * claim this renderer is not entitled to make: main answers by looking up
     * which view the sender is.
     */
    const raw: unknown = await ipcRenderer.invoke(CONNECTION_CHANNEL)
    const parsed = asConnection(raw)
    if (parsed === null) throw new Error('Malformed workbench connection descriptor')
    buffered = parsed
    return parsed
  },

  /*
   * Not buffered, unlike the connection above, and the difference is the point.
   *
   * A descriptor is a fact about this document that never changes, so caching it
   * is right. Focus changes constantly, and a cached answer would be a workbench
   * that believes a window is focused after the person has gone somewhere else.
   * Every ask goes to main, which is the only side that can see the window.
   */
  windowHasFocus: async () => {
    const raw: unknown = await ipcRenderer.invoke(FOCUS_CHANNEL)
    /*
     * Anything that is not `true` is `false`. The value drives whether VS Code's
     * git extension refreshes, and the safe direction for a malformed answer is
     * "nothing changed" — the state the workbench was already in — rather than a
     * claim of focus that nothing can corroborate.
     */
    return raw === true
  },

  onWindowFocusChanged: (handler: (hasFocus: boolean) => void) => {
    ipcRenderer.on(FOCUS_CHANNEL, (_event, hasFocus: unknown) => {
      if (typeof hasFocus === 'boolean') handler(hasFocus)
    })
  },

  terminalEnv: async () => asTerminalEnv(await ipcRenderer.invoke(TERMINAL_ENV_CHANNEL)),

  onTerminalEnvChanged: (handler: (env: WorkbenchTerminalEnv | null) => void) => {
    ipcRenderer.on(TERMINAL_ENV_CHANNEL, (_event, env: unknown) => {
      handler(asTerminalEnv(env))
    })
  },

  /*
   * Anything that is not a string becomes `null`, and that is the safe direction.
   *
   * `null` means "this profile has never stored settings", which makes the
   * workbench seed nothing and keep Code-OSS's defaults. A malformed reply
   * therefore degrades to a clean profile rather than to a seeded one — the
   * opposite choice would let a bad answer from main write over the defaults with
   * whatever it happened to be.
   */
  readUserSettings: async () => {
    const raw: unknown = await ipcRenderer.invoke(USER_SETTINGS_READ_CHANNEL)
    return typeof raw === 'string' ? raw : null
  },

  writeUserSettings: async (text: string) => {
    await ipcRenderer.invoke(USER_SETTINGS_WRITE_CHANNEL, text)
  },

  readBrowserExtensions: async () => {
    const raw: unknown = await ipcRenderer.invoke(BROWSER_EXTENSIONS_READ_CHANNEL)
    return typeof raw === 'string' ? raw : null
  },

  writeBrowserExtensions: async (text: string) => {
    await ipcRenderer.invoke(BROWSER_EXTENSIONS_WRITE_CHANNEL, text)
  },

  onBrowserExtensionsChanged: (handler: (text: string) => void) => {
    ipcRenderer.on(BROWSER_EXTENSIONS_CHANGED_CHANNEL, (_event, text: unknown) => {
      if (typeof text === 'string') handler(text)
    })
  },

  /*
   * Same narrowing as `readUserSettings` above, and the same reason: anything
   * that is not a string reads as "this scope has stored nothing", which the
   * storage service starts from anyway. A malformed reply must degrade to an
   * empty database rather than to a database of whatever arrived.
   */
  readStorage: async (scope: string) => {
    const raw: unknown = await ipcRenderer.invoke(STORAGE_READ_CHANNEL, scope)
    return typeof raw === 'string' ? raw : null
  },

  applyStorageDelta: async (
    scope: string,
    insert: Record<string, string>,
    remove: readonly string[]
  ) => {
    await ipcRenderer.invoke(STORAGE_WRITE_CHANNEL, scope, insert, remove)
  },

  /*
   * One listener for the life of the document. The payload is re-checked here
   * because it crossed a process boundary, and a malformed frame is dropped
   * rather than thrown: the alternative is taking down a workbench over another
   * surface's bad write.
   */
  onStorageChanged: (
    handler: (scope: string, insert: Record<string, string>, remove: readonly string[]) => void
  ) => {
    const wrapped = (
      _event: IpcRendererEvent,
      scope: unknown,
      insert: unknown,
      remove: unknown
    ): void => {
      if (typeof scope !== 'string') return
      if (typeof insert !== 'object' || insert === null || Array.isArray(insert)) return
      if (!Array.isArray(remove)) return
      const inserted: Record<string, string> = {}
      for (const [key, value] of Object.entries(insert as Record<string, unknown>)) {
        if (typeof value === 'string') inserted[key] = value
      }
      handler(
        scope,
        inserted,
        remove.filter((k): k is string => typeof k === 'string')
      )
    }
    ipcRenderer.on(STORAGE_CHANGED_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(STORAGE_CHANGED_CHANNEL, wrapped)
    }
  },

  reportProcesses: async (terminalPids) => {
    await ipcRenderer.invoke(PROCESS_REPORT_CHANNEL, terminalPids)
  },

  onProcessCloseRequest: (handler) => {
    ipcRenderer.on(PROCESS_CLOSE_CHANNEL, (_event, requestId: unknown, phase: unknown) => {
      if (typeof requestId !== 'string' || (phase !== 'prepare' && phase !== 'stop')) return
      void Promise.resolve()
        .then(() => handler(phase))
        .then(
          (result) => {
            ipcRenderer.send(
              PROCESS_CLOSE_RESULT_CHANNEL,
              requestId,
              'refusal' in result ? [] : result,
              null,
              'refusal' in result ? result.refusal : null
            )
          },
          (error: unknown) => {
            ipcRenderer.send(
              PROCESS_CLOSE_RESULT_CHANNEL,
              requestId,
              [],
              error instanceof Error ? error.message : String(error)
            )
          }
        )
    })
  },

  onStorageFlushRequest: (handler) => {
    ipcRenderer.on(STORAGE_FLUSH_CHANNEL, (_event, requestId: unknown) => {
      if (typeof requestId !== 'string') return
      void Promise.resolve()
        .then(handler)
        .then(
          () => {
            ipcRenderer.send(STORAGE_FLUSH_RESULT_CHANNEL, requestId, null)
          },
          (error: unknown) => {
            ipcRenderer.send(
              STORAGE_FLUSH_RESULT_CHANNEL,
              requestId,
              error instanceof Error ? error.message : String(error)
            )
          }
        )
    })
  },

  /*
   * One listener for the life of the document, and the payload is checked here
   * because it arrived from outside it. A non-string is dropped rather than
   * passed on: the handler parses it as a URI, and `URI.parse(undefined)` fails
   * somewhere far less obvious than this line.
   */
  /*
   * Same narrowing as the reads above: anything that is not a string means "no
   * secret", which is what an absent one means and what an undecryptable one
   * means. All three lead the extension to the same correct place — ask again.
   */
  readSecret: async (key: string) => {
    const raw: unknown = await ipcRenderer.invoke(SECRET_READ_CHANNEL, key)
    return typeof raw === 'string' ? raw : null
  },

  writeSecret: async (key: string, value: string) => {
    await ipcRenderer.invoke(SECRET_WRITE_CHANNEL, key, value)
  },

  deleteSecret: async (key: string) => {
    await ipcRenderer.invoke(SECRET_DELETE_CHANNEL, key)
  },

  /*
   * Narrowed the same way the secret reads are: anything that is not a string
   * means "nothing to paste", which is what an empty clipboard means and what an
   * image-only one means. Both lead the terminal to the same correct place —
   * insert nothing — and it already handles `''` because that is what the
   * browser implementation returns when the read is refused.
   */
  readClipboard: async () => {
    const raw: unknown = await ipcRenderer.invoke(CLIPBOARD_READ_CHANNEL)
    return typeof raw === 'string' ? raw : ''
  },

  readPreviewSelection: async (frameName): Promise<PreviewSelection | null> => {
    const raw: unknown = await ipcRenderer.invoke(PREVIEW_SELECTION_CHANNEL, frameName)
    if (typeof raw !== 'object' || raw === null) return null
    const { source, text, startLine, endLine } = raw as Record<string, unknown>
    if (
      typeof source !== 'string' ||
      source === '' ||
      typeof text !== 'string' ||
      typeof startLine !== 'number' ||
      !Number.isInteger(startLine) ||
      startLine < 1 ||
      typeof endLine !== 'number' ||
      !Number.isInteger(endLine) ||
      endLine < 1
    ) {
      return null
    }
    return { source, text, startLine, endLine }
  },

  requestCompletion: async (requestId: string, payload: CompletionPayload) => {
    const raw: unknown = await ipcRenderer.invoke(COMPLETION_CHANNEL, requestId, payload)
    if (typeof raw !== 'object' || raw === null) return { configured: false, text: null }
    const record = raw as Record<string, unknown>
    const text = record['text']
    return {
      configured: record['configured'] === true,
      text: typeof text === 'string' ? text : null,
    }
  },

  cancelCompletion: (requestId: string) => {
    ipcRenderer.send(COMPLETION_CANCEL_CHANNEL, requestId)
  },

  generateLanguageModel: async (request) => {
    const response: unknown = await ipcRenderer.invoke('lm:generate', request)
    return response
  },

  cancelLanguageModel: async (request) => {
    const response: unknown = await ipcRenderer.invoke('lm:cancel', request)
    return response
  },

  reportEditorOutcome: (report: EditorReport) => {
    ipcRenderer.send(EDITOR_REPORT_CHANNEL, report)
  },

  probeCompletionCache: async () => {
    await ipcRenderer.invoke(COMPLETION_PROBE_CHANNEL)
  },

  onUrl: (handler: (url: string) => void) => {
    ipcRenderer.on(URL_CHANNEL, (_event, url: unknown) => {
      if (typeof url === 'string') handler(url)
    })
  },

  /*
   * `send`, not `invoke`, and the difference is deliberate.
   *
   * This fires on cursor movement, so it is the highest-frequency thing crossing
   * this boundary by a wide margin. `invoke` would make every keystroke await a
   * round trip to main before the editor's own handler returned; `send` posts and
   * returns. A dropped report costs nothing — the next movement supersedes it,
   * because this channel carries **state and not history**.
   *
   * The payload is validated in main regardless. A surface runs third-party
   * extension code, so nothing arriving from one is trusted here, and `send`
   * removes the reply rather than the check.
   */
  reportContext: (context) => {
    ipcRenderer.send(CONTEXT_CHANNEL, context)
  },

  /*
   * The one channel that runs the other way — main asks, this document answers.
   *
   * Electron has no `webContents.invoke`, so the request/response pair is built
   * by hand: main sends with a `requestId` and the reply carries it back. The
   * correlation lives in main, which is the side that can time out; this side's
   * only job is to answer every request it is given, exactly once.
   *
   * A handler that throws still replies. An unanswered request is indisting-
   * uishable from a hung surface, and main would sit on it until its timeout —
   * so the failure is converted into a result here rather than escaping.
   */
  onSnapshotRequest: (handler) => {
    ipcRenderer.on(SNAPSHOT_CHANNEL, (_event, request: unknown) => {
      void (async () => {
        const requestId =
          typeof request === 'object' && request !== null && 'requestId' in request
            ? String(request.requestId)
            : ''
        try {
          ipcRenderer.send(SNAPSHOT_RESULT_CHANNEL, { requestId, snapshot: await handler() })
        } catch {
          // Answered regardless: main is waiting, and an unanswered request is
          // indistinguishable from a hung surface until its timeout.
          ipcRenderer.send(SNAPSHOT_RESULT_CHANNEL, { requestId, snapshot: null })
        }
      })()
    })
  },

  onAskDiffRequest: (handler) => {
    ipcRenderer.on(ASK_DIFF_CHANNEL, (_event, request: unknown) => {
      void (async () => {
        const requestId =
          typeof request === 'object' && request !== null && 'requestId' in request
            ? String(request.requestId)
            : ''
        try {
          ipcRenderer.send(ASK_DIFF_RESULT_CHANNEL, await handler(request))
        } catch (error) {
          ipcRenderer.send(ASK_DIFF_RESULT_CHANNEL, {
            requestId,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    })
  },

  onReviewDiffRequest: (handler) => {
    ipcRenderer.on(REVIEW_DIFF_CHANNEL, (_event, request: unknown) => {
      void (async () => {
        const requestId =
          typeof request === 'object' && request !== null && 'requestId' in request
            ? String(request.requestId)
            : ''
        try {
          ipcRenderer.send(REVIEW_DIFF_RESULT_CHANNEL, await handler(request))
        } catch (error) {
          ipcRenderer.send(REVIEW_DIFF_RESULT_CHANNEL, {
            requestId,
            ok: false,
            failure: 'open-failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    })
  },

  onRevealRequest: (handler) => {
    ipcRenderer.on(REVEAL_CHANNEL, (_event, request: unknown) => {
      void (async () => {
        const requestId =
          typeof request === 'object' && request !== null && 'requestId' in request
            ? String(request.requestId)
            : ''
        try {
          ipcRenderer.send(REVEAL_RESULT_CHANNEL, await handler(request))
        } catch (error) {
          ipcRenderer.send(REVEAL_RESULT_CHANNEL, {
            requestId,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    })
  },

  onEditRequest: (handler) => {
    ipcRenderer.on(EDIT_CHANNEL, (_event, request: unknown) => {
      void (async () => {
        const requestId =
          typeof request === 'object' && request !== null && 'requestId' in request
            ? String(request.requestId)
            : ''
        try {
          ipcRenderer.send(EDIT_RESULT_CHANNEL, await handler(request))
        } catch (error) {
          ipcRenderer.send(EDIT_RESULT_CHANNEL, {
            requestId,
            ok: false,
            refusal: 'failed',
            message: error instanceof Error ? error.message : String(error),
            version: null,
          })
        }
      })()
    })
  },

  onLayoutWidth: (handler) => {
    layoutHandler = handler
    if (layoutWidth !== null) handler(layoutWidth)
  },

  reportActivityBar: (width) => {
    ipcRenderer.send(ACTIVITY_BAR_REPORT_CHANNEL, width)
  },

  requestRowReveal: () => {
    ipcRenderer.send(ROW_REQUEST_CHANNEL)
  },
  requestRowScroll: (delta) => {
    ipcRenderer.send(ROW_SCROLL_REQUEST_CHANNEL, delta)
  },
}

contextBridge.exposeInMainWorld('chorusWorkbench', api)
