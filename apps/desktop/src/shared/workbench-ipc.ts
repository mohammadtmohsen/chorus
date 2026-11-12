import { z } from 'zod'
import type { LanguageModelCancel, LanguageModelRequest } from './language-model-ipc.js'
import {
  GitCommentRequest,
  GitOpenDiffRequest,
  GitReplyRequest,
  GitResolveRequest,
  GitReviewEnvelope,
  GitReviewFileReadRequest,
} from './git-ipc.js'
/*
 * The `/protocol` subpath, never the package's barrel.
 *
 * This file is `shared/`, so it is compiled into main *and* into both renderer
 * bundles. The barrel used to re-export `endpoint.js`, which imported `node:path` — and
 * a bundler asked to resolve that for browser code substitutes an empty object
 * rather than failing, so the breakage surfaces as a `TypeError` at some later
 * call site instead of at build time. `paths.ts` records what that cost. The
 * subpaths are the Node-free half of the package, and the renderer build now
 * refuses Node built-ins outright so this cannot regress quietly.
 */
import { provenance } from '@chorus/ide-protocol/protocol'

/**
 * The workbench IPC surface — two audiences, deliberately separated.
 *
 * Preflight §4.1a settled that the shell must never hold the workbench's
 * connection secret, and §4.1b settled that the workbench must never hold the
 * shell's `ChorusApi`. Those are the same rule read from both ends, and the only
 * way to keep both true is for the two sides to be handed different things by
 * different preloads. The schemas are shared; the exposure is not.
 *
 * So this file is one module with two halves that never mix:
 *
 *  - `WORKBENCH_SHELL_CONTRACT` — what the shell may say. It names surfaces by
 *    an opaque view id and carries no secret on any channel, which is what makes
 *    a leaked id useless: every operation it names is mediated by main and
 *    validated against the project main opened it for. The grant it redeems on
 *    `workbench:open` is not a secret either in the sense §4.1a means — it is an
 *    *authorisation*, and leaking one buys nothing, because main refuses it in
 *    any window but the one it was minted for.
 *  - `WORKBENCH_CONNECTION_CHANNEL` — what main tells one surface about itself.
 *    Generated into the workbench preload only.
 *
 * These channels are deliberately *not* in `IPC_CONTRACT`. That map's registrar
 * discards `event` by design, and preflight §4.1b rule 4 requires every workbench
 * request to be resolved from `event.sender` rather than from anything the sender
 * says about itself. Sharing the registrar would have meant weakening it.
 */

/** A rectangle in the shell's own layout coordinates, which main mirrors onto the view. */
export const WorkbenchRect = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
})
export type WorkbenchRect = z.infer<typeof WorkbenchRect>

/**
 * What a surface is told about itself, and the whole of it.
 *
 * **Step 2 is what widened this**, and the three fields it added are the reason
 * the delivery mechanism was built the way it was rather than retrofitted around
 * a secret. Preflight §5.3: compromise of the connection token is compromise of
 * the machine — with it a caller can read and write any file the user can, spawn
 * processes, and install and activate an arbitrary extension. So the token
 * travels main → *this one surface* and nowhere else. It is never on a query
 * string, never in the shell's React state, and never in the event log, which is
 * `CLAUDE.md`'s "state is not history" applied exactly: a token read back a week
 * later is worse than having none.
 *
 * `commit` and `quality` are here because both must match the server and they
 * fail in two different ways. A `commit` mismatch is refused loudly in the
 * WebSocket handshake — `Client refused: version mismatch`. A `quality` mismatch
 * is never compared at all; it silently changes the `<quality>-<commit>` prefix
 * every resource URL is fetched under, so the socket opens and the workbench
 * 404-storms with nothing naming the cause.
 *
 * `projectRoot` is what distinguishes one surface from another, and the
 * adversarial test in §4.1b is that a pull from surface A returns A's root while
 * B is open.
 */
export const WorkbenchConnection = z.object({
  projectRoot: z.string().min(1),
  /** Host and port only, e.g. `127.0.0.1:50751` — never a scheme, never a path. */
  remoteAuthority: z.string().min(1),
  connectionToken: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  quality: z.string().min(1),
  reviewLabels: z.object({
    title: z.string().min(1),
    actionFailed: z.string().min(1),
    comment: z.string().min(1),
    reply: z.string().min(1),
    resolve: z.string().min(1),
    reopen: z.string().min(1),
    commentingBlocked: z.string().min(1),
    status: z.object({
      added: z.string(),
      removed: z.string(),
      modified: z.string(),
      renamed: z.string(),
    }),
  }),
  processNonce: z.uuid().optional(),
  /**
   * Present only when Workspace Trust is waived, and there is no value that says
   * "enforced" — the absence is what says it.
   *
   * Workspace Trust earned its keep here and the observation is on the record:
   * opening an unvouched-for root raises a **modal** prompt ("Do you trust the
   * authors of the files in this folder?") which takes DOM focus, and while it is
   * up `⌘P` opens nothing, a command runs nothing and Electron silently cancels
   * `location.reload()`. That is correct for a person and fatal for a driver, and
   * it is *timing*-dependent — one gate run had surface A finish its file open
   * before the dialog arrived and surface B caught by it, and the next had both
   * caught. So the waiver exists for the containment gate and for nothing else.
   *
   * A `z.literal('waived').optional()` rather than an enum with two arms, because
   * the two shapes are not symmetric and should not look it. A descriptor that
   * ships to a person **omits this field**; there is no `'enforced'` to write, so
   * no path through main can emit a disabled-trust flag by getting a ternary the
   * wrong way round, and a reader who forgets the field entirely gets the safe
   * behaviour. Main sets it only when the app is unpackaged **and** the E2E root
   * seed is in the environment — both, never either — and neither of those is
   * reachable from a renderer.
   */
  workspaceTrust: z.literal('waived').optional(),
})
export type WorkbenchConnection = z.infer<typeof WorkbenchConnection>

export const WORKBENCH_REVIEW_STATE_CHANNEL = 'workbench:review:state'
export const WORKBENCH_REVIEW_CHANGED_CHANNEL = 'workbench:review:changed'
export const WORKBENCH_REVIEW_ACTION_CHANNEL = 'workbench:review:action'
export const WORKBENCH_REVIEW_FILE_CHANNEL = 'workbench:review:file'

export const WorkbenchReviewState = GitReviewEnvelope.omit({ projectId: true })
export type WorkbenchReviewState = z.infer<typeof WorkbenchReviewState>

export const WorkbenchReviewAction = z.discriminatedUnion('kind', [
  GitOpenDiffRequest.omit({ projectId: true })
    .extend({ kind: z.literal('openDiff') })
    .strict(),
  GitCommentRequest.omit({ projectId: true })
    .extend({ kind: z.literal('comment') })
    .strict(),
  GitReplyRequest.omit({ projectId: true })
    .extend({ kind: z.literal('reply') })
    .strict(),
  GitResolveRequest.omit({ projectId: true })
    .extend({ kind: z.literal('resolve') })
    .strict(),
])
export type WorkbenchReviewAction = z.infer<typeof WorkbenchReviewAction>

export const WorkbenchReviewActionResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), message: z.string().min(1) }),
])
export type WorkbenchReviewActionResult = z.infer<typeof WorkbenchReviewActionResult>

export const WorkbenchReviewFileRequest = GitReviewFileReadRequest.omit({
  projectId: true,
}).strict()
export type WorkbenchReviewFileRequest = z.infer<typeof WorkbenchReviewFileRequest>

export const WorkbenchReviewFileResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string() }),
  z.object({ ok: z.literal(false), message: z.string().min(1) }),
])
export type WorkbenchReviewFileResult = z.infer<typeof WorkbenchReviewFileResult>

/**
 * An OS-absolute path, spelled the way a `vscode-remote` URI requires.
 *
 * **A URI with an authority may not have a path that fails to begin with a
 * slash**, and `_validateUri` throws rather than coercing. Every absolute path
 * on macOS already satisfies that, which is why this was invisible here for as
 * long as it was: `C:\Users\me\project` does not, and neither does `C:/Users/me`.
 * What the person saw on Windows was the workbench never starting, with
 * `[UriError]` and a stack ending in `prepareWorkbench`.
 *
 * **Lives in shared because four call sites build these URIs** — the workspace
 * folder in `workbench-surface.ts`, the file a reveal opens, the file an
 * answered edit reveals, and the edit request itself. Three of them take a path
 * main resolved against the project root, so each would otherwise have needed
 * its own copy of this rule, and a copy that drifts is how three of these four
 * end up disagreeing about the same directory.
 *
 * **Idempotent, deliberately.** The root arrives here already converted, and a
 * caller that cannot easily tell whether it has been should be able to ask
 * twice. A leading slash means the work is done.
 *
 * Only a drive-letter or UNC path is touched. A backslash is a legal character
 * in a POSIX filename, so converting them unconditionally would corrupt a
 * directory somebody has actually named `a\b`.
 */
export function remotePath(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path)) return `/${path.replace(/\\/g, '/')}`
  if (path.startsWith('\\\\')) return path.replace(/\\/g, '/')
  return path
}

export const WORKBENCH_CONNECTION_CHANNEL = 'workbench:connection'
export const WORKBENCH_PROCESS_REPORT_CHANNEL = 'workbench:process:report'
export const WORKBENCH_PROCESS_CLOSE_CHANNEL = 'workbench:process:close'
export const WORKBENCH_PROCESS_CLOSE_RESULT_CHANNEL = 'workbench:process:close:result'

export type WorkbenchProcessCloseResult = readonly number[] | { readonly refusal: 'unsaved' }

/**
 * Whether the window that currently holds this surface has focus.
 *
 * Push and pull on one channel, the same shape as `WORKBENCH_CONNECTION_CHANNEL`
 * beside it: `send` on every change, `invoke` for the value before the first one.
 *
 * It answers a question about a *window*, never about this document. A workbench
 * and the chat beside it are two documents in one window, so `document.hasFocus()`
 * says nobody is watching an editor that is fully on screen — which is what makes
 * the git extension park in `whenIdleAndFocused()`. This is the honest answer to
 * VS Code's own question rather than a way around it.
 */
export const WORKBENCH_FOCUS_CHANNEL = 'workbench:focus'

export const WORKBENCH_TERMINAL_ENV_CHANNEL = 'workbench:terminalEnv'

export const WORKBENCH_LAYOUT_CHANNEL = 'workbench:layout'
export const WORKBENCH_ACTIVITY_BAR_REPORT_CHANNEL = 'workbench:activityBar:report'
export const WORKBENCH_ROW_REQUEST_CHANNEL = 'workbench:row:request'
export const WORKBENCH_ACTIVITY_BAR_PUSH_CHANNEL = 'workbench:activityBar:changed'
export const WORKBENCH_ROW_REVEAL_PUSH_CHANNEL = 'workbench:row:reveal'
export const WORKBENCH_ROW_SCROLL_REQUEST_CHANNEL = 'workbench:row:scroll'
export const WORKBENCH_ROW_SCROLL_PUSH_CHANNEL = 'workbench:row:scrollRequested'

export const WorkbenchLayoutWidth = z.number().int().positive()
export const WorkbenchActivityBarWidth = z.number().int().nonnegative()

export const WorkbenchActivityBarPush = z
  .object({ viewId: z.string().min(1), width: WorkbenchActivityBarWidth })
  .strict()
export type WorkbenchActivityBarPush = z.infer<typeof WorkbenchActivityBarPush>

export const WorkbenchRowRevealPush = z.object({ viewId: z.string().min(1) }).strict()
export type WorkbenchRowRevealPush = z.infer<typeof WorkbenchRowRevealPush>

export const WorkbenchRowScrollDelta = z.number()
export const WorkbenchRowScrollPush = z
  .object({ viewId: z.string().min(1), delta: WorkbenchRowScrollDelta })
  .strict()
export type WorkbenchRowScrollPush = z.infer<typeof WorkbenchRowScrollPush>

export interface WorkbenchTerminalEnv {
  readonly name: string
  readonly value: string
}

/**
 * The two channels that make a preference outlive the app — E5.
 *
 * The workbench partition is in-memory (`'chorus-workbench'`, no `persist:`) and
 * stays that way, so everything the surface holds dies with the app. That was
 * deliberate: the workbench's durable state belongs to **Chorus**, not to a
 * Chromium profile, and an in-memory partition is one fewer place a connection
 * token can survive a quit. So durability is not bought by flipping that word; it
 * is bought here, by main holding the one file the user actually edits under the
 * Chorus profile.
 *
 * **No path ever crosses this boundary**, in either direction. The read takes no
 * argument and the write takes text, so a surface cannot name a file, and path
 * traversal is absent by construction rather than filtered for.
 */
export const WORKBENCH_USER_SETTINGS_READ_CHANNEL = 'workbench:userSettings:read'
export const WORKBENCH_USER_SETTINGS_WRITE_CHANNEL = 'workbench:userSettings:write'

/**
 * The browser extension registry uses the same pathless boundary as settings.
 * The changed channel keeps each workbench surface's in-memory user-data file in
 * step with the application-scoped registry held by main.
 */
export const WORKBENCH_BROWSER_EXTENSIONS_READ_CHANNEL = 'workbench:browserExtensions:read'
export const WORKBENCH_BROWSER_EXTENSIONS_WRITE_CHANNEL = 'workbench:browserExtensions:write'
export const WORKBENCH_BROWSER_EXTENSIONS_CHANGED_CHANNEL = 'workbench:browserExtensions:changed'

/**
 * What the workbench *remembers*, as opposed to what it is configured with.
 *
 * The same trade as the settings pair above and for the same reason — the
 * partition is in-memory, so the storage service starts empty every launch — but
 * a separate pair of channels because it is a different kind of state. Settings
 * are one document a person edits; this is a key-value store per scope that the
 * editor and its extensions write to constantly.
 *
 * **A scope key crosses, and it is never a path.** Unlike the settings channels,
 * this one has to carry an argument: the storage service keeps three scopes and
 * a workspace scope per folder, so main cannot derive which one is meant. The
 * key is used only as a property name inside a single JSON file — see
 * `workbench-storage.ts` — so a surface running third-party extension code
 * cannot turn it into a filename. That is the whole of why one file was chosen
 * over a file per scope.
 *
 * **This is where a workspace-trust decision is remembered.** Persisting it is
 * the point — being asked on every launch is how a person is trained to click
 * through a security prompt — but it also means this file records "this folder
 * may run code", which is why the write handler refuses any sender that is not a
 * live surface.
 */
export const WORKBENCH_STORAGE_READ_CHANNEL = 'workbench:storage:read'
/**
 * A **delta**, never a whole map — and the difference is a data-loss bug.
 *
 * Every project surface is its own document with its own cache of the shared
 * scopes. When the write carried a full map, surface A's write replaced the
 * scope with A's view of it, silently deleting everything surface B had stored
 * since A last read. Two projects open was enough; five made it constant, and
 * the symptom was a GitLab account or a trust decision that saved correctly and
 * vanished a moment later with nothing in any log.
 *
 * A surface can now only say what it changed. It has no way to express "delete
 * everything I have not heard about", which is what a full map said by accident.
 */
export const WORKBENCH_STORAGE_WRITE_CHANNEL = 'workbench:storage:write'
/**
 * Main telling the *other* surfaces what one of them just changed.
 *
 * The delta above fixes destruction; this fixes staleness. Without it every
 * surface still holds a cache that silently drifts from the file, and the editor
 * would render decisions that are no longer true until it was relaunched. It is
 * also what makes `IStorageDatabase.onDidChangeItemsExternal` honest — that
 * event exists precisely to say "someone else changed this", and it was
 * `Event.None` because, at the time, nothing could.
 */
export const WORKBENCH_STORAGE_CHANGED_CHANNEL = 'workbench:storage:changed'
export const WORKBENCH_STORAGE_FLUSH_CHANNEL = 'workbench:storage:flush'
export const WORKBENCH_STORAGE_FLUSH_RESULT_CHANNEL = 'workbench:storage:flush:result'

/**
 * An OAuth callback coming back into the app through its own URL scheme.
 *
 * Push, not request: the surface never asks for this, the OS delivers it to main
 * and main decides which surface it belongs to. That decision is the whole of
 * the security here — see `awaitingCallback` in `workbench-surface.ts`. A
 * surface cannot ask for a callback and cannot ask which callbacks exist; it is
 * told about exactly one, exactly once, and only if it is the surface that sent
 * the person to a browser in the last few minutes.
 */
export const WORKBENCH_URL_CHANNEL = 'workbench:url'

/**
 * Credentials, kept apart from `workbench:storage:*` on purpose.
 *
 * Same shape, different stakes. The storage channels carry which notifications
 * you dismissed; these carry an `api`-scoped access token. Separate channels
 * mean separate handlers, a separate file, and separate encryption — and mean a
 * future change to one cannot widen the other by accident.
 *
 * Needed at all because `BrowserSecretStorageService` is constructed with
 * `_useInMemoryStorage` hardcoded true, so secrets never reach `IStorageService`
 * and every sign-in was lost on quit. The client supplies these as
 * `options.secretStorageProvider`, which that same service prefers when present.
 */
export const WORKBENCH_SECRET_READ_CHANNEL = 'workbench:secret:read'
export const WORKBENCH_SECRET_WRITE_CHANNEL = 'workbench:secret:write'
export const WORKBENCH_SECRET_DELETE_CHANNEL = 'workbench:secret:delete'

/**
 * Reading the system clipboard, because the browser API for it is refused.
 *
 * The workbench partition answers every permission request with `false`
 * (`security.ts`), which is deliberate and stays — a surface runs third-party
 * extension code by design, and `clipboard-read` granted to the session is
 * granted to every iframe and extension webview in it. What that denial also
 * refused was the *terminal's* paste: `⌘V` there is not a native paste event, it
 * is `workbench.action.terminal.paste` calling `IClipboardService.readText()`,
 * which is `navigator.clipboard.readText()`. Chromium refused it and the browser
 * implementation swallows the rejection and returns `''`, so paste did nothing
 * and said nothing.
 *
 * Copy was unaffected and so was pasting into a file, which is what made this
 * look like a terminal bug rather than a permission one: writing is a different
 * permission, and pasting into an editor is a native `paste` event that arrives
 * carrying its own data.
 *
 * **Read only, and no argument.** A surface cannot name what to read and cannot
 * write, so this widens what a surface can *learn* by exactly one value and adds
 * nothing it can change. Write still goes through the browser API, which already
 * works — routing it here too would be a second way to do a working thing.
 */
export const WORKBENCH_CLIPBOARD_READ_CHANNEL = 'workbench:clipboard:read'

/**
 * What the editor is looking at — Phase 6 slice 6a.
 *
 * **The surface does not say which project this is**, and that is the same rule
 * `workbench:open` follows one direction out: main derives the project from the
 * sender, because a project named in a request is a claim and a project derived
 * from the `WebContents` is a fact. A compromised surface can misreport its own
 * cursor; it cannot attribute that cursor to somebody else's project.
 *
 * **Relative, never absolute.** The path is already project-relative when it
 * leaves here, so no root crosses the boundary and nothing downstream has to
 * decide whether a path is inside the project — the question does not arise.
 * `null` is a real value: an empty editor group, or an editor on something with
 * no file behind it.
 *
 * **This is state, not history.** `CLAUDE.md`'s rule: would reading it back a
 * week later be worse than having none? A cursor position from last Tuesday is
 * noise, so it travels on a push channel and is held in memory, and there is no
 * `ChorusEventPayload` for it. Approvals and edits are events; looking at a file
 * is not.
 */
export const WORKBENCH_CONTEXT_CHANNEL = 'workbench:context'

/**
 * Phase 6d — an agent asking to change a file *in the editor*, not on disk.
 *
 * **Two channels rather than an `invoke`, and the direction is why.** Every
 * other workbench channel is renderer→main: the surface asks and main answers,
 * so `ipcRenderer.invoke` fits. This one originates in main and has to be
 * answered by the surface, and Electron has no `webContents.invoke`. So main
 * sends a request carrying a `requestId` and the surface sends the result back
 * on a second channel; main correlates and times out.
 *
 * **Why an editor edit is not a file write.** The model in the editor may be
 * dirty — the person has unsaved changes — and writing the file underneath it
 * either loses their work or is silently overwritten when they next save.
 * Applying to the *model* means the edit joins their undo stack, shows in the
 * dirty indicator, and is theirs to reject with one keystroke.
 */
/**
 * What the editor is showing, asked for at the moment a message is sent.
 *
 * **A pull, not the retained push, and the composer already explains why**: the
 * push is debounced, so it can be a few hundred milliseconds old, and "sending
 * what the pill said would attach the wrong lines to the question, which is
 * worse than attaching none". The push drives the pill; this answers Send.
 *
 * It also carries the selected **text**, which the push deliberately does not —
 * the push fires per keystroke and reports a byte count instead. Here the text
 * is the point: for a dirty buffer, the file on disk no longer says what the
 * person is looking at, so a path and a line range name lines that do not exist.
 */
export const WORKBENCH_SNAPSHOT_CHANNEL = 'workbench:snapshot'
export const WORKBENCH_SNAPSHOT_RESULT_CHANNEL = 'workbench:snapshot:result'
export const WORKBENCH_PREVIEW_SELECTION_CHANNEL = 'workbench:preview-selection'

export const PreviewSelection = z
  .object({
    source: z.string().min(1),
    text: z.string(),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  })
  .strict()
export type PreviewSelection = z.infer<typeof PreviewSelection>

export type WorkbenchSnapshot = WorkbenchContext & {
  readonly text: string
  readonly preview?: true
}

export interface WorkbenchSnapshotResult {
  readonly requestId: string
  /** Null when the surface could not read an editor at all. */
  readonly snapshot: WorkbenchSnapshot | null
}

/**
 * Show a proposed edit as a diff, before it is applied — the ask flow.
 *
 * **Both sides travel as text.** The proposed content does not exist on disk and
 * must never be written there: the whole point is that it has not been applied.
 * The original travels too, rather than as a `file:` URI, because the workspace
 * is addressed `vscode-remote://<authority><root>` and a plain file URI is not
 * something this build resolves for a diff's original side — and because a live
 * resource would move under the reader while the card is open. One immutable
 * snapshot, both sides, proven in the Phase 2 spike.
 *
 * File content therefore crosses IPC. Acceptable here and not a precedent: it is
 * the file the person is being shown a diff of, going to the surface that is
 * about to show it.
 */
export const WORKBENCH_COMPLETION_CHANNEL = 'workbench:completion'
export const WORKBENCH_COMPLETION_CANCEL_CHANNEL = 'workbench:completion:cancel'
export const WORKBENCH_EDITOR_REPORT_CHANNEL = 'workbench:editor:report'
export const WORKBENCH_COMPLETION_PROBE_CHANNEL = 'workbench:completion:probe'

export type EditorReportKind =
  | 'snoozed'
  | 'cancelled'
  | 'no-suggestion'
  | 'not-configured'
  | 'returned'
  | 'shown'
  | 'returned-not-shown'
  | 'language-service'
  | 'context-collection'

export interface EditorReport {
  readonly requestId: string
  readonly outcome: EditorReportKind
  readonly providerReturnedMs?: number
  readonly itemShownAfterReturnMs?: number
  readonly languageServiceQuery?: 'definitions' | 'typeDefinitions'
  readonly queryMs?: number
  readonly providerMissing?: boolean
  readonly queryTimedOut?: boolean
  readonly emptyQueries?: number
  readonly totalQueries?: number
  readonly snippetResolveMs?: number
  readonly snippetExtents?: readonly number[]
  readonly snippetPaths?: readonly (string | null)[]
  readonly memberContext?: boolean
  readonly memberCount?: number
  readonly memberReceiverMatched?: boolean
  readonly typeContext?: boolean
  readonly typeAnchors?: number
  readonly typeExpanded?: boolean
  readonly typeResolved?: number
  readonly typeStale?: boolean
}

export const COMPLETION_PATH_LIMIT = 1024
export const COMPLETION_TOKENS_PER_SIDE = 600
export const COMPLETION_CHARACTERS_PER_SIDE = COMPLETION_TOKENS_PER_SIDE * 4
export const COMPLETION_PREFIX_FLOOR = 1600
export const COMPLETION_CONTEXT_CHARACTERS =
  COMPLETION_CHARACTERS_PER_SIDE - COMPLETION_PREFIX_FLOOR
export const COMPLETION_CONTEXT_SNIPPETS = 3
export const COMPLETION_SNIPPET_SOURCE_CHARACTERS = COMPLETION_CHARACTERS_PER_SIDE

export interface CompletionContextSnippet {
  readonly text: string
  readonly path: string | null
}

const HASH_COMMENT_LANGUAGES = new Set([
  'python',
  'ruby',
  'perl',
  'r',
  'shellscript',
  'yaml',
  'toml',
  'ini',
  'makefile',
  'dockerfile',
])

export function commentPrefix(languageId: string): string {
  return HASH_COMMENT_LANGUAGES.has(languageId) ? '#' : '//'
}

export interface AssembledContext {
  readonly text: string
  readonly whole: number
}

export function contextualise(languageId: string, snippet: CompletionContextSnippet): string {
  const marker = commentPrefix(languageId)
  const lines: string[] = []
  if (snippet.path !== null) lines.push(`${marker} ${snippet.path}`)
  for (const line of snippet.text.split('\n')) lines.push(`${marker} ${line}`)
  return lines.join('\n')
}

export function assembleContext(
  languageId: string,
  context: readonly CompletionContextSnippet[]
): AssembledContext {
  const blocks: string[] = []
  let whole = 0
  let total = 0

  for (const snippet of context.slice(0, COMPLETION_CONTEXT_SNIPPETS)) {
    const block = contextualise(languageId, snippet)
    const addition = block.length + (blocks.length === 0 ? 1 : 2)
    if (total + addition > COMPLETION_CONTEXT_CHARACTERS) continue
    total += addition
    blocks.push(block)
    whole += 1
  }

  return { text: blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`, whole }
}

export interface CompletionReply {
  readonly configured: boolean
  readonly text: string | null
}

export interface CompletionPayload {
  readonly prefix: string
  readonly suffix: string
  readonly languageId: string
  readonly path: string | null
  readonly context: readonly CompletionContextSnippet[]
}

export const WORKBENCH_ASK_DIFF_CHANNEL = 'workbench:askDiff'
export const WORKBENCH_ASK_DIFF_RESULT_CHANNEL = 'workbench:askDiff:result'

export interface WorkbenchAskDiffRequest {
  readonly requestId: string
  /** Which approval this is about, so a settled card closes the right tab. */
  readonly approvalId: string
  /** Project-relative, for the tab's label. */
  readonly path: string
  /** The file as it stood when the card was raised. `null` when it did not exist. */
  readonly before: string | null
  /** What the edit would leave. */
  readonly proposed: string
  /**
   * Close the tab instead of opening one. The card settled.
   *
   * The same channel rather than a second, because open and close are one
   * lifecycle and a surface that missed the close would keep a tab describing a
   * decision already made.
   */
  readonly close?: boolean
  /**
   * The real file to leave open once the diff goes, absolute.
   *
   * Sent with `close`, because answering a card is the moment the person stops
   * looking at a proposal and starts looking at the file — accepted, it is what
   * they just agreed to; refused, it is what stayed. Absolute because the
   * surface builds the URI and main is the only side that resolved the path
   * against the project root.
   */
  readonly revealPath?: string
}

export interface WorkbenchAskDiffResult {
  readonly requestId: string
  readonly ok: boolean
  readonly message?: string
}

export const WORKBENCH_REVIEW_DIFF_CHANNEL = 'workbench:reviewDiff'
export const WORKBENCH_REVIEW_DIFF_RESULT_CHANNEL = 'workbench:reviewDiff:result'

export interface WorkbenchReviewDiffFile {
  readonly path: string
  readonly oldPath: string
  readonly before: string
  readonly after: string
  readonly workspace: boolean
  readonly matches: boolean
}

export type WorkbenchReviewDiffInput = {
  readonly iid: number
  readonly versionId: number
} & (
  | (WorkbenchReviewDiffFile & { readonly replace?: string | undefined })
  | { readonly files: readonly WorkbenchReviewDiffFile[]; readonly title: string }
  | { readonly kind: 'reopenActive' }
)

export type WorkbenchReviewDiffRequest = WorkbenchReviewDiffInput & { readonly requestId: string }

export interface WorkbenchReviewDiffResult {
  readonly requestId: string
  readonly ok: boolean
  readonly failure?: 'no-editor' | 'open-failed'
  readonly message?: string
}

export const WORKBENCH_EDIT_CHANNEL = 'workbench:edit'
export const WORKBENCH_EDIT_RESULT_CHANNEL = 'workbench:edit:result'

/**
 * The edit, as the surface receives it.
 *
 * **Project-relative, never absolute.** The root lives in the surface and does
 * not cross this boundary in either direction — `context.ts` already relativises
 * on the way out for the same reason, and a request naming an absolute path
 * would be a claim about the filesystem that main would then have to re-check.
 * A path that escapes the project is refused rather than resolved.
 *
 * **`baseVersion` is the whole safety property.** It is the model version the
 * agent's view of the file was taken from. If the model has moved on — the
 * person typed, another edit landed — the versions disagree and the edit is
 * refused as a conflict. Without it, an agent working from a stale read silently
 * clobbers whatever happened in between.
 *
 * Lines and columns are 1-based, which is what the editor's own API uses; making
 * them 0-based here would put a conversion at every call site instead of none.
 */
export interface WorkbenchEditRequest {
  readonly requestId: string
  readonly path: string
  readonly baseVersion: number
  readonly range: {
    readonly startLine: number
    readonly startColumn: number
    readonly endLine: number
    readonly endColumn: number
  }
  /** What the agent believes is in that range. Checked before anything moves. */
  readonly oldText: string
  readonly newText: string
}

/**
 * Why an edit was refused, and each of these is a different thing to tell a
 * person.
 *
 * `conflict` is the interesting one: it means the file is open and fine and
 * somebody else changed it, so the agent should re-read rather than retry.
 */
export type WorkbenchEditRefusal =
  'conflict' | 'outside-project' | 'no-editor' | 'unopenable' | 'failed'

export type WorkbenchEditResult =
  | { readonly requestId: string; readonly ok: true; readonly version: number }
  | {
      readonly requestId: string
      readonly ok: false
      readonly refusal: WorkbenchEditRefusal
      readonly message: string
      /** The version the model is actually at, when there is one. Lets a caller re-read. */
      readonly version: number | null
    }

/**
 * Show a file the transcript named, in this project's own editor.
 *
 * **A sibling of `workbench:askDiff`'s `revealPath`, not a reuse of it.** That
 * one rides on a card settling and only exists as a tail on a close; this is a
 * person clicking a path in a reply, which happens with no approval in flight
 * and no diff to close. Folding the two together would mean the close path
 * grew a mode, and a click would then depend on an approval lifecycle it has
 * nothing to do with.
 *
 * **Absolute, and that is the same rule `revealPath` follows.** Main is the
 * only side that resolved the path against the project root and checked
 * containment, so what crosses is the answer rather than the question — the
 * surface builds a URI from it and does not re-decide whether it was allowed.
 *
 * `line` and `column` are 1-based, like everything else at this boundary, and
 * null where the click carried no position. They come off the text an agent
 * wrote (`src/foo.ts:42`), so they are a hint and not a guarantee: a line past
 * the end of the file reveals what there is rather than failing.
 */
export const WORKBENCH_REVEAL_CHANNEL = 'workbench:reveal'
export const WORKBENCH_REVEAL_RESULT_CHANNEL = 'workbench:reveal:result'

export interface WorkbenchRevealRequest {
  readonly requestId: string
  /** Absolute, already resolved and contained by main. */
  readonly path: string
  readonly line: number | null
  readonly column: number | null
}

export interface WorkbenchRevealResult {
  readonly requestId: string
  readonly ok: boolean
  readonly message?: string
}

export const WorkbenchContext = z
  .object({
    /** Project-relative, POSIX separators, or null when nothing is open. */
    relativePath: z.string().nullable(),
    /**
     * Where the content on screen came from — **not always the working tree.**
     *
     * Main used to assert `{ kind: 'worktree' }` for every embedded report, which
     * is true of an ordinary file and false of the panes people most want to ask
     * about. A GitLab merge-request pane shows one side of a diff at a specific
     * commit; telling an agent it is the worktree points it at a file whose
     * current contents are not what the person is looking at.
     *
     * Resolved by `resolveDocument` in `@chorus/ide-protocol`, the same resolver
     * the VS Code extension uses, so the two surfaces cannot disagree about what
     * a `gl-review:` or `git:` document means.
     */
    provenance,
    /*
     * **Diagnostics, and they exist because a null path had no explanation.**
     *
     * `relativePath: null` is reported for an unknown scheme, a review URI whose
     * query failed validation, and a real file outside this project — three
     * different bugs with three different fixes, indistinguishable in the log.
     * The file's own comment records three rounds lost to guessing between them.
     *
     * `scheme` is the document's URI scheme and nothing more; the rest of the
     * URI — a `gl-review` query carries `repositoryRoot` and merge-request
     * metadata — never crosses this boundary. `editorTypeId` is the editor
     * input's type, which is what distinguishes "no text editor was found" from
     * "there was no editor at all": `workbench.editors.diffEditorInput` with no
     * editor found inside it is the exact line that diagnosed the merge-request
     * case, and neither field is a path.
     */
    scheme: z.string(),
    editorTypeId: z.string(),
    reason: z.enum(['ok', 'no-editor', 'unresolved', 'outside-root']),
    /** 1-based and inclusive, matching what the editor shows. */
    startLine: z.number().int().min(1).nullable(),
    endLine: z.number().int().min(1).nullable(),
    /** True when the caret sits somewhere rather than covering a range. */
    isEmpty: z.boolean(),
    /** The model has unsaved changes — a fact about the buffer, not the disk. */
    isDirty: z.boolean(),
    languageId: z.string(),
    /**
     * The selected text's size in **bytes**, not characters.
     *
     * A byte cap is what the provider boundary is expressed in, and a selection
     * of emoji or CJK is several times its character count. Measured here where
     * the text is, so nothing downstream has to hold the text to size it.
     */
    selectedBytes: z.number().int().min(0),
    /**
     * The model version of the open file — Phase 6e.
     *
     * Reported so an agent can quote it as `base_version` without a round trip.
     * Without it `editor_edit` is close to unusable: the agent has no way to
     * learn a version except by attempting an edit and being refused, so every
     * first edit to a file costs a wasted turn.
     *
     * `null` when nothing is open, which is the same condition `relativePath`
     * reports — kept as its own nullable field rather than folded in, because a
     * version of `0` is a real value and a falsy check would drop it.
     */
    version: z.number().int().nullable(),
  })
  .strict()
export type WorkbenchContext = z.infer<typeof WorkbenchContext>

/**
 * What the shell may name when it asks for a surface, and the whole point is
 * that a path is not on the list.
 *
 * `realpathSync` canonicalises a path; it does not authorise one. Main used to
 * take the shell's string, resolve it and open whatever existed there — so the
 * admission rule was "the renderer named something that exists", which is every
 * directory on the disk. In step 2 that same string becomes the REH's `--folder`,
 * i.e. the root a server process is pointed at, so "well-formed" and "permitted"
 * have to stop being the same test.
 *
 * Both arms are **references main can resolve without trusting the sender**:
 *
 *  - `grant` — a capability minted in main as the result of a user action in the
 *    native chooser, bound to the `WebContents` that asked for it. Unguessable,
 *    single-owner, and it dies with the document it was minted for.
 *  - `projectId` — the same kind of value with a longer life: a name whose root
 *    only main's project registry knows. **ProjectService does not exist yet**,
 *    so nothing resolves an id today and every one of them is refused. The arm
 *    is in the schema now rather than later because closing this channel against
 *    paths is a security boundary; adding an admission form afterwards is a
 *    change to that boundary, where filling in a lookup is not.
 *
 * `.strict()` on both, so `{ projectRoot: '/real/directory' }` is refused by the
 * schema before any code has to decide what to do with it.
 */
export const WorkbenchTarget = z.union([
  z.object({ grant: z.string().min(1) }).strict(),
  z.object({ projectId: z.string().min(1) }).strict(),
])
export type WorkbenchTarget = z.infer<typeof WorkbenchTarget>

/**
 * The shell's half. No secret on any of it, and no generic command channel —
 * the moment one exists the allowlist is decorative.
 */
export const WORKBENCH_SHELL_CONTRACT = {
  /**
   * Asks main to put the native folder chooser in front of the person, and mint
   * a capability for whatever they pick.
   *
   * No arguments, deliberately: a `defaultPath` would be the renderer naming a
   * directory again, one indirection further out. `chosen` is null when the
   * dialog was cancelled — one nullable object rather than two nullable fields,
   * so "a grant with no root" is not a state anyone has to handle.
   */
  'workbench:chooseProject': {
    request: z.object({}).strict(),
    response: z.object({
      chosen: z.object({ grant: z.string().min(1), projectRoot: z.string().min(1) }).nullable(),
    }),
  },
  'workbench:open': {
    request: WorkbenchTarget,
    response: z.object({ viewId: z.string().min(1) }),
  },
  'workbench:setBounds': {
    request: z.object({
      viewId: z.string().min(1),
      rect: WorkbenchRect,
      layoutWidth: WorkbenchLayoutWidth.optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  'workbench:activityBar': {
    request: z.object({ viewId: z.string().min(1) }).strict(),
    response: z.object({ width: WorkbenchActivityBarWidth }),
  },
  /**
   * Stand every surface down, or bring them back.
   *
   * **A `WebContentsView` is composited above this window's DOM**, so anything
   * the shell draws over the workbench region is behind it: a hover card, a
   * context menu, the Settings sheet, and — the one that made this urgent — a
   * confirmation dialog rendered cut in half at the workbench's left edge.
   * There is no z-index that reaches a native view.
   *
   * So the shell says when it has an overlay up and main hides the views for the
   * duration. `setVisible(false)` rather than a zero rectangle: the surface keeps
   * its bounds, nothing re-lays-out, and the workbench is not told anything
   * happened — it is a compositing change, not a resize.
   *
   * All surfaces at once, deliberately. An overlay is a window-level moment and
   * the shell does not know which surfaces its dialog overlaps; hiding only the
   * focused pane's would leave a dialog clipped by a sibling.
   */
  'workbench:setVisible': {
    /*
     * `viewId` narrows it to one surface; absent means every surface this
     * window owns.
     *
     * Two callers with two different scopes. A **shell overlay** — a dialog, a
     * hover card — is a window-level moment: it does not know which surfaces it
     * covers, and hiding only the focused pane's would leave a dialog clipped by
     * a sibling. The **Editor switch** is the opposite: it turns off one
     * project's editor and must not touch the three beside it.
     */
    /*
     * `heartbeat` says "the overlay I told you about is still up".
     *
     * The shell's overlay count is a module-level integer incremented by an
     * effect and decremented by its cleanup, and a cleanup that never runs — a
     * `pointerleave` the browser skips when the pointer leaves fast or the window
     * loses focus — hides every editor in the window **permanently**, with
     * nothing in the system able to recover. Observed: about a minute after
     * launch the editor region went black and stayed black until an unrelated
     * dialog happened to run a clean cycle.
     *
     * So a hide now expires unless it is renewed, which moves the guarantee off
     * the most careless caller and onto a deadline. A heartbeat skips the capture
     * — the shell already has its stills and re-encoding a JPEG per surface every
     * few seconds to say "still here" would make an idle hover cost more than the
     * thing it is protecting.
     */
    request: z
      .object({
        visible: z.boolean(),
        viewId: z.string().min(1).optional(),
        heartbeat: z.boolean().optional(),
      })
      .strict(),
    /*
     * **A hide returns a still of what it hid**, one JPEG per surface, captured
     * while the view was up and in the same step that took it down. Hiding alone
     * left an empty rectangle where the editor had been, which for a modal is
     * tolerable and for a hover card is worse than the occlusion it fixed. The
     * shell paints the still into the placeholder the view was sitting over, so
     * the editor appears unchanged — frozen, for as long as the overlay is up.
     *
     * JPEG rather than PNG: the capture is at device scale, so a text-heavy
     * editor is several megabytes as PNG and this crosses an IPC boundary on
     * every hover. The `img` downsamples it back to CSS pixels, which is what
     * hides the artefacts.
     *
     * A show returns none — there is nothing to paint once the views are back.
     */
    response: z.object({
      ok: z.literal(true),
      /** Empty on a show, and on a hide by a window with no surfaces open. */
      stills: z.array(z.object({ viewId: z.string(), dataUrl: z.string() })),
    }),
  },
  'workbench:close': {
    request: z.object({ viewId: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
  },
} as const

export type WorkbenchShellContract = typeof WORKBENCH_SHELL_CONTRACT
export type WorkbenchShellChannel = keyof WorkbenchShellContract
export type WorkbenchShellRequest<C extends WorkbenchShellChannel> = z.infer<
  WorkbenchShellContract[C]['request']
>
export type WorkbenchShellResponse<C extends WorkbenchShellChannel> = z.infer<
  WorkbenchShellContract[C]['response']
>

export const WORKBENCH_SHELL_CHANNELS = Object.keys(
  WORKBENCH_SHELL_CONTRACT
) as WorkbenchShellChannel[]

/** The five methods the shell's preload adds to `window.chorus`. */
export interface WorkbenchShellApi {
  /**
   * Puts the native chooser in front of the person and returns what main minted
   * for their answer — the only way a shell can come to hold an openable project.
   */
  readonly chooseWorkbenchProject: () => Promise<WorkbenchShellResponse<'workbench:chooseProject'>>
  /**
   * Asks main for a surface on a project it already authorised. Resolves to an
   * opaque view id. The argument is a grant or a project id — never a path, and
   * the schema is what enforces that rather than a check in main.
   */
  readonly openWorkbench: (
    request: WorkbenchShellRequest<'workbench:open'>
  ) => Promise<WorkbenchShellResponse<'workbench:open'>>
  /** Reports where the placeholder element is, so main can composite the view over it. */
  readonly setWorkbenchBounds: (
    request: WorkbenchShellRequest<'workbench:setBounds'>
  ) => Promise<{ ok: true }>
  readonly closeWorkbench: (
    request: WorkbenchShellRequest<'workbench:close'>
  ) => Promise<{ ok: true }>
  /**
   * Hides every surface this window owns, for as long as a shell overlay is up.
   *
   * A `WebContentsView` composites *above* the renderer's DOM, so no z-index the
   * shell can write puts a dialog or a hover card in front of the workbench — the
   * confirm dialog was cut in half at the workbench's left edge. `setVisible`
   * rather than a zero rectangle: the bounds survive, nothing re-lays-out inside
   * the workbench, and it is never told anything happened.
   */
  readonly setWorkbenchVisible: (
    request: WorkbenchShellRequest<'workbench:setVisible'>
  ) => Promise<WorkbenchShellResponse<'workbench:setVisible'>>
  readonly readWorkbenchActivityBar: (
    request: WorkbenchShellRequest<'workbench:activityBar'>
  ) => Promise<WorkbenchShellResponse<'workbench:activityBar'>>
  readonly onWorkbenchActivityBar: (
    listener: (push: WorkbenchActivityBarPush) => void
  ) => () => void
  readonly onWorkbenchRowReveal: (listener: (push: WorkbenchRowRevealPush) => void) => () => void
  readonly onWorkbenchRowScroll: (listener: (push: WorkbenchRowScrollPush) => void) => () => void
}

/**
 * The deliberately narrow capability surface exposed by the workbench preload.
 * Persistence methods carry no path and no project: main derives their scope
 * from the sender, so the renderer cannot name another project's resources.
 */
export interface ChorusWorkbenchApi {
  readonly generateLanguageModel: (request: LanguageModelRequest) => Promise<unknown>
  readonly cancelLanguageModel: (request: LanguageModelCancel) => Promise<unknown>
  readonly reviewFile: (request: WorkbenchReviewFileRequest) => Promise<WorkbenchReviewFileResult>
  readonly reviewState: () => Promise<unknown>
  readonly onReviewChanged: (handler: (state: unknown) => void) => () => void
  readonly reviewAction: (action: WorkbenchReviewAction) => Promise<WorkbenchReviewActionResult>
  /**
   * Resolves with the descriptor for THIS view's project. No arguments: the
   * renderer cannot name a project, because main derives it from the sender.
   */
  readonly connection: () => Promise<WorkbenchConnection>
  /**
   * Whether the window holding this surface is the focused one.
   *
   * The pull half of `WORKBENCH_FOCUS_CHANNEL`, and it exists for the reason
   * every other pull here does: the view can be asked before any push has
   * arrived, and a reload re-executes this document with the push already gone
   * by. No arguments — main derives the surface from the sender.
   */
  readonly windowHasFocus: () => Promise<boolean>
  /**
   * Receives every later change of that answer.
   *
   * Registered once for the life of the document, like the other push
   * subscriptions: `ipcRenderer.on` accumulates listeners. A payload that is not
   * a boolean is dropped rather than coerced, because `false` and "not a
   * boolean" are different facts and only one of them is safe to guess.
   */
  readonly onWindowFocusChanged: (handler: (hasFocus: boolean) => void) => void
  readonly terminalEnv: () => Promise<WorkbenchTerminalEnv | null>
  readonly onTerminalEnvChanged: (handler: (env: WorkbenchTerminalEnv | null) => void) => void
  /**
   * The user's own `settings.json` as main last stored it, or `null` when this
   * profile has never had one — which is how a clean profile keeps Code-OSS's
   * defaults rather than inheriting somebody's.
   */
  readonly readUserSettings: () => Promise<string | null>
  /** The browser extension registry as Code-OSS last stored it, or `null` on a clean profile. */
  readonly readBrowserExtensions: () => Promise<string | null>
  /**
   * Reports what this surface's editor is looking at. Fire-and-forget: a lost
   * report is corrected by the next one, and blocking the editor on main would
   * be the wrong trade for a value that changes on every keystroke.
   */
  readonly reportContext: (context: WorkbenchContext) => void
  readonly readPreviewSelection: (frameName: string) => Promise<PreviewSelection | null>
  /**
   * Answers main's edit requests for the life of the document.
   *
   * Registered once, not per edit: `ipcRenderer.on` accumulates listeners, and a
   * subscription per request would answer the second edit twice and the tenth
   * ten times. The handler is given the raw payload because it arrived from
   * outside this document and validating it is the handler's job.
   */
  /** Answers main's request for what the editor is showing, with its text. */
  readonly onSnapshotRequest: (handler: () => Promise<WorkbenchSnapshot | null>) => void
  readonly onEditRequest: (handler: (request: unknown) => Promise<WorkbenchEditResult>) => void
  /** Shows, replaces or closes the proposed-edit diff. */
  readonly onAskDiffRequest: (
    handler: (request: unknown) => Promise<WorkbenchAskDiffResult>
  ) => void
  readonly onReviewDiffRequest: (
    handler: (request: unknown) => Promise<WorkbenchReviewDiffResult>
  ) => void
  /** Opens a file the transcript named, at a line when the click carried one. */
  readonly onRevealRequest: (handler: (request: unknown) => Promise<WorkbenchRevealResult>) => void
  /** Hands main the current text of the user's settings file, to store as-is. */
  readonly writeUserSettings: (text: string) => Promise<void>
  /** Hands main the current browser extension registry, without exposing a path. */
  readonly writeBrowserExtensions: (text: string) => Promise<void>
  /** Receives a registry written by another workbench surface. */
  readonly onBrowserExtensionsChanged: (handler: (text: string) => void) => void
  /**
   * One storage scope's items as JSON text, or `null` when nothing has been
   * stored for it — which the storage service reads as an empty database, i.e.
   * the state a fresh profile has anyway.
   */
  readonly readStorage: (scope: string) => Promise<string | null>
  /**
   * Applies a delta to one storage scope. **Never sends a whole map** — see
   * `WORKBENCH_STORAGE_WRITE_CHANNEL` for the data loss that caused.
   */
  readonly applyStorageDelta: (
    scope: string,
    insert: Record<string, string>,
    remove: readonly string[]
  ) => Promise<void>
  /**
   * Learns what another surface changed in a scope this one also holds.
   *
   * Registered once for the life of the document, like the other push
   * subscriptions: `ipcRenderer.on` accumulates listeners, and one per scope
   * would deliver the second change twice.
   */
  readonly onStorageChanged: (
    handler: (scope: string, insert: Record<string, string>, remove: readonly string[]) => void
  ) => () => void
  readonly onStorageFlushRequest: (handler: () => Promise<void>) => void
  readonly reportProcesses: (terminalPids: readonly number[]) => Promise<void>
  readonly onProcessCloseRequest: (
    handler: (phase: 'prepare' | 'stop') => Promise<WorkbenchProcessCloseResult>
  ) => void
  /**
   * Receives an OAuth callback main has decided belongs to this surface.
   *
   * Registered once for the life of the document, like `onEditRequest`:
   * `ipcRenderer.on` accumulates listeners, so a subscription per flow would
   * deliver the second callback twice.
   */
  readonly onUrl: (handler: (url: string) => void) => void
  /**
   * One credential, decrypted, or `null` when absent or undecryptable.
   *
   * The two cases are deliberately indistinguishable to the caller: a secret
   * written on another machine, or under a keychain since reset, means exactly
   * what an absent one means — ask the person to sign in again.
   */
  readonly readSecret: (key: string) => Promise<string | null>
  /** Stores one credential, encrypted. Rejects if no OS keychain is available. */
  readonly writeSecret: (key: string, value: string) => Promise<void>
  readonly deleteSecret: (key: string) => Promise<void>
  /**
   * The system clipboard's text, since the browser API for reading it is denied
   * to this partition — see `WORKBENCH_CLIPBOARD_READ_CHANNEL`.
   *
   * `''` for an empty or non-text clipboard, which is what the browser
   * implementation returns and what the terminal's paste already handles.
   */
  readonly readClipboard: () => Promise<string>
  readonly requestCompletion: (
    requestId: string,
    payload: CompletionPayload
  ) => Promise<CompletionReply>
  readonly cancelCompletion: (requestId: string) => void
  readonly reportEditorOutcome: (report: EditorReport) => void
  readonly probeCompletionCache: () => Promise<void>
  readonly onLayoutWidth: (handler: (width: number) => void) => void
  readonly reportActivityBar: (width: number) => void
  readonly requestRowReveal: () => void
  readonly requestRowScroll: (delta: number) => void
}
