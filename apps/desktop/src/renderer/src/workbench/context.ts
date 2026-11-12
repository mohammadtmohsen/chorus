import { getService } from '@codingame/monaco-vscode-api'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { ICodeEditorService } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/services/codeEditorService.service'
import type { ICodeEditor } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorBrowser'
import { IWorkingCopyService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopyService.service'
import { autorun } from '@codingame/monaco-vscode-api/vscode/vs/base/common/observableInternal/reactions/autorun'
import { DisposableStore } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import type { IOverlayWebview } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/webview/browser/webview'
import {
  activeInputChanged,
  addEditor,
  emptyTracker,
  hydrationTarget,
  promote,
  readable,
  removeEditor,
  type TrackerState,
} from './editor-tracking.js'
import { resolveReviewResource, REVIEW_SCHEME } from './review-diff.js'
/*
 * The two Node-free subpaths, never `@chorus/ide-protocol` itself.
 *
 * The barrel used to re-export `endpoint.js`, which imported `node:path`. This module is
 * browser code, and Vite answers an unresolvable built-in with an *empty object*
 * rather than an error — so the import succeeded, `posix` was `undefined`, and
 * every `git:` and `gl-review:` document threw `TypeError` from inside a VS Code
 * event listener where nothing surfaced it. Merge-request selections reached no
 * agent for days with not one line in any log. See `paths.ts` for the whole of
 * it; the renderer build now rejects Node built-ins so it cannot recur silently.
 */
import { resolveDocument, type Provenance } from '@chorus/ide-protocol/document-identity'
import { platformForRoot, relativeInside, type Platform } from '@chorus/ide-protocol/paths'
import type {
  PreviewSelection,
  WorkbenchContext,
  WorkbenchSnapshot,
} from '../../../shared/workbench-ipc.js'

/**
 * What this surface's editor is looking at, reported to main — Phase 6 slice 6a.
 *
 * **There is no bridge extension, and that is a correction to the plan rather
 * than a shortcut.** §1.1 says editor truth comes from "the workbench API and a
 * trusted built-in extension", and §5.2 schedules the external `.vsix` to be
 * reworked into a built-in one. That framing is inherited from the world where
 * Chorus had no code inside the editor and could only reach it through the
 * extension API. It has code inside the editor now: this module runs in the
 * surface's own document, calls the same services an extension would be a proxy
 * for, and already holds the preload that reaches main.
 *
 * An extension would be **weaker**, not stronger. It would run in the extension
 * host beside third-party code, it cannot reach `window.chorusWorkbench`, and it
 * would need a transport of its own — a socket main serves, with a token
 * delivered somehow — which is a new authenticated surface added to a boundary
 * Phase 1 spent review rounds narrowing. This needs none of that.
 *
 * **State, not history.** `CLAUDE.md`'s test: reading a cursor position back a
 * week later is worse than having none, so this travels on a push channel, is
 * held in memory by main, and has no `ChorusEventPayload`. Nothing here may ever
 * become an event.
 */

/**
 * Project-relative, POSIX separators, or null when the path is not inside the
 * project at all.
 *
 * The root never crosses the IPC boundary, so the relativising happens here
 * rather than in main. A file opened from outside the project — a global
 * settings file, a diff from another tree — reports `null` rather than a `../`
 * path: an agent cannot be told to look at something the project does not
 * contain, and a traversal is not a thing that can be expressed.
 *
 * **`relativeInside`, not a fourth copy of the arithmetic.** This used to be
 * written out here — `startsWith(root + '/')` and a `slice` — which is the same
 * rule `@chorus/ide-protocol` already owns and which main re-checks against.
 * Three implementations of one rule is how the extension and main came to
 * disagree on Windows in the first place, and this one understood only POSIX
 * separators: on Windows a project at `C:\repo` never matched a path the editor
 * reported as `c:/repo/...`, so every file in every project reported
 * `outside-root`.
 *
 * The result is normalised to `/` because the value is a *wire* path — it goes
 * into an agent mention and into `editor_edit` — and both ends have always
 * treated it as POSIX. `relativeInside` returns the platform's own separator,
 * which is `\` on Windows.
 */
export function relativeTo(root: string, filePath: string, platform: Platform): string | null {
  const relative = relativeInside(root, filePath, platform)
  /*
   * An empty string means the path *is* the root — a directory, not a file.
   * `relativeInside` reports that as containment, correctly; there is nothing
   * here an agent could open, so it is the same answer as being outside.
   */
  if (relative === null || relative === '') return null
  return relative.replace(/\\/g, '/')
}

/**
 * What document this editor is showing, and where its content came from.
 *
 * **Not `uri.path`, which is what this used to be.** That works for an ordinary
 * file and silently fails for every virtual one. A GitLab merge-request pane is
 * `gl-review:/src/app.ts?{…}` — a *repository*-relative path with a leading
 * slash — so `relativeTo` found it outside the project, reported `null`, and the
 * chain did the rest: the push went unmatched, `ideAttached` went false, and the
 * composer stopped asking for a snapshot at all. The agent was told nothing and
 * the log stayed silent, which is why this looked like two unrelated bugs.
 *
 * `resolveDocument` is the resolver the VS Code extension already used for
 * exactly this, moved into `@chorus/ide-protocol` rather than reimplemented. It
 * validates the query, refuses traversal, and reconstructs the real path — and
 * it returns **provenance**, which is the half that matters: a review pane shows
 * a specific commit, not the working tree, and reporting it as worktree would
 * point an agent at a file whose current contents are not what is on screen.
 */
function resolveActive(
  root: string,
  /** The active input's `typeId`, so a `no-editor` report says what the pane was. */
  editorTypeId: string,
  uri: Pick<URI, 'scheme' | 'authority' | 'path' | 'query' | 'fsPath'> | undefined
): {
  relativePath: string | null
  provenance: Provenance
  scheme: string
  editorTypeId: string
  reason: WorkbenchContext['reason']
} {
  const worktree: Provenance = { kind: 'worktree' }
  if (uri === undefined) {
    return {
      relativePath: null,
      provenance: worktree,
      scheme: '',
      editorTypeId,
      reason: 'no-editor',
    }
  }
  if (uri.scheme === REVIEW_SCHEME) {
    const review = resolveReviewResource(uri, root)
    if (review !== null) {
      return {
        relativePath: review.relativePath,
        provenance: { kind: 'review', commit: review.commit },
        scheme: uri.scheme,
        editorTypeId,
        reason: 'ok',
      }
    }
  }
  /*
   * **The platform is named, and there is no longer a default to fall back on.**
   *
   * `resolveDocument` used to default to `process.platform`, which is right in
   * the VS Code extension and fatal here: this bundle runs in a sandboxed
   * renderer with no Node integration, so `process` is undefined and evaluating
   * the default throws `ReferenceError` before the body runs. The default is
   * gone from the shared package now — a browser-safe module may not reach for a
   * Node global even in a branch nobody expects to take.
   *
   * The failure had no shape to it. The throw took out the whole context report,
   * so nothing was pushed, `ideAttached` stayed false, the composer never asked
   * for a snapshot, and an agent was told there was no selection — with nothing
   * in any log, because the log line lives past the point that threw.
   *
   * Inferred from the root rather than reported by the server: a POSIX root
   * begins with `/`, a Windows one does not. The value only decides what counts
   * as an absolute path and which separator a relative one is written with, and
   * the root is the very path being compared against.
   */
  const platform: Platform = platformForRoot(root, 'darwin')
  const resolved = resolveDocument(uri, platform)
  /*
   * An unresolvable scheme reports no path rather than guessing one. `untitled:`
   * and notebook cells land here by design — there is nothing an agent could
   * open — and so does any scheme nobody has taught this resolver yet, which is
   * the honest answer for those too.
   */
  if (resolved === null) {
    return {
      relativePath: null,
      provenance: worktree,
      scheme: uri.scheme,
      editorTypeId,
      reason: 'unresolved',
    }
  }
  const relativePath = relativeTo(root, resolved.filePath, platform)
  return {
    relativePath,
    provenance: resolved.provenance,
    scheme: uri.scheme,
    editorTypeId,
    /*
     * **`outside-root` is the distinction three rounds were spent guessing at.**
     *
     * A null path has two entirely different causes with two different fixes:
     * the resolver refused the document (`unresolved` — an unknown scheme, or a
     * review URI whose query did not validate), or it resolved to a real file
     * that simply is not under this project's root (`outside-root` — a
     * `repositoryRoot` naming a different checkout, a monorepo sibling, a global
     * settings file). The log said `path: null` for both.
     */
    reason: relativePath === null ? 'outside-root' : 'ok',
  }
}

const PREVIEW_VIEW_TYPES = new Set(['markdown.preview', 'vscode.markdown.preview.editor'])
let previewActivation = 0

function previewWebview(input: unknown): IOverlayWebview | null {
  const webview = (input as { webview?: IOverlayWebview } | null)?.webview
  return webview !== undefined && PREVIEW_VIEW_TYPES.has(webview.providedViewType ?? '')
    ? webview
    : null
}

function previewFrameName(webview: IOverlayWebview): string | null {
  try {
    return webview.container.querySelector('iframe')?.name ?? null
  } catch {
    return null
  }
}

async function readActivePreview(editors: IEditorService): Promise<PreviewSelection | null> {
  const input = editors.activeEditor ?? null
  const activation = previewActivation
  const webview = previewWebview(input)
  const frameName = webview === null ? null : previewFrameName(webview)
  if (webview === null || frameName === null) return null
  const read = await window.chorusWorkbench.readPreviewSelection(frameName).catch(() => null)
  return activation === previewActivation &&
    editors.activeEditor === input &&
    previewFrameName(webview) === frameName
    ? read
    : null
}

function previewContext(
  projectRoot: string,
  editorTypeId: string,
  read: PreviewSelection,
  workingCopies: IWorkingCopyService
): WorkbenchContext {
  const uri = URI.parse(read.source)
  const document = resolveActive(projectRoot, editorTypeId, uri)
  return {
    relativePath: document.relativePath,
    provenance: document.provenance,
    scheme: document.scheme,
    editorTypeId: document.editorTypeId,
    reason: document.reason,
    startLine: read.startLine,
    endLine: read.endLine,
    isEmpty: read.text === '',
    isDirty: workingCopies.dirtyWorkingCopies.some((copy) => copy.resource.path === uri.path),
    languageId: 'markdown',
    selectedBytes: new TextEncoder().encode(read.text).length,
    version: null,
  }
}

/**
 * Subscribes to the editor and reports on change.
 *
 * Two sources because they answer different questions and neither covers the
 * other: `IEditorService.onDidActiveEditorChange` fires when the *file* changes,
 * and the code editor's `onDidChangeCursorPosition` fires when the caret moves
 * within one. Watching only the first reports a stale position for the whole
 * time somebody is reading a file; watching only the second misses a file opened
 * and not yet touched.
 */

/**
 * The editor the person last worked in, remembered rather than looked up.
 *
 * **Looking it up is the bug.** `activeTextEditorControl` was asked at the
 * moment a report was needed, and for a diff it answers with neither child — so
 * a GitLab merge-request file, which is a standard diff over `gl-review:`
 * models, reported `no-editor`. The log named it exactly:
 * `scheme: "workbench.editors.diffEditorInput", reason: "no-editor"` — a real
 * diff input with no editor found inside it.
 *
 * Two earlier readings of this are worth keeping, because both were right about
 * their own symptom and neither was the cause.
 * `ICodeEditorService.getFocusedCodeEditor()` fails because the workbench holds
 * no focus at the instant a snapshot is taken — the person is typing in Chorus.
 * `activeTextEditorControl` fixed that and could not see inside a diff.
 * Unwrapping to `getModifiedEditor()` fixed *that* and silently reported the
 * wrong side whenever somebody selected on the original.
 *
 * A retained reference answers all three. It survives focus leaving, it is a
 * child editor rather than a parent control, and it is the child that was
 * actually interacted with — so the side is a fact instead of a guess. What it
 * costs is state, and `editor-tracking.ts` holds the transitions where they can
 * be tested.
 */

/**
 * The one tracker for this surface.
 *
 * Module-level because the two readers are separate entry points — the push
 * subscribes at startup, the snapshot is called when a message is sent — and
 * they must agree about which editor is meant. Two trackers would reproduce the
 * original defect in a subtler form: a pill describing one editor and a sent
 * message quoting another.
 *
 * One workbench is one surface is one JavaScript realm (`entry.ts` explains why
 * that is structural rather than incidental), so a module-level singleton is
 * exactly one surface's worth of state.
 */
let tracker: TrackerState<ICodeEditor, unknown> = emptyTracker()

/** Whatever the tracker will still vouch for, given what is on screen now. */
function trackedEditor(editors: { activeEditor?: unknown }): ICodeEditor | null {
  return readable(tracker, editors.activeEditor ?? null)
}

/**
 * What the editor is showing, right now, with the selected text.
 *
 * **Shared with the push rather than a second reader.** The push reports
 * everything here except `text`, and it fires on every keystroke — carrying the
 * selection with it would put a copy of whatever is highlighted across a process
 * boundary sixty times a second, which is why `selectedBytes` exists. The
 * *snapshot* is asked for once, when a message is sent, and there the text is the
 * whole point: for a dirty buffer the file on disk no longer says what the person
 * is looking at, so a path and a line range name lines that do not exist yet.
 *
 * Two readers of one editor would drift — the range from one and the text from
 * another is how a quote ends up describing different lines from its own header.
 */
export async function readEditorSnapshot(projectRoot: string): Promise<WorkbenchSnapshot> {
  const [editors, workingCopies] = await Promise.all([
    getService(IEditorService),
    getService(IWorkingCopyService),
  ])
  const input = editors.activeEditor
  const activation = previewActivation
  const preview = previewWebview(input) === null ? null : await readActivePreview(editors)
  if (preview !== null && editors.activeEditor === input && activation === previewActivation) {
    return {
      ...previewContext(projectRoot, input?.typeId ?? '', preview, workingCopies),
      text: preview.text,
      ...(preview.text === '' ? {} : { preview: true as const }),
    }
  }
  const editor = trackedEditor(editors)
  const model = editor?.getModel() ?? null
  /*
   * The path comes from the model we are reading, not from `activeEditor`.
   *
   * They can disagree, and a diff is where they do: the active editor's resource
   * describes the *pair*, while the selection belongs to one side of it. Taking
   * both from the same model is what stops a report naming one document and
   * quoting another.
   */
  const uri = model?.uri ?? editors.activeEditor?.resource
  const document = resolveActive(projectRoot, editors.activeEditor?.typeId ?? '', uri)
  const selection = editor?.getSelection() ?? null
  const text =
    selection === null || model === null || selection.isEmpty()
      ? ''
      : model.getValueInRange(selection)
  return {
    relativePath: document.relativePath,
    provenance: document.provenance,
    scheme: document.scheme,
    editorTypeId: document.editorTypeId,
    reason: document.reason,
    startLine: selection?.startLineNumber ?? null,
    endLine: selection?.endLineNumber ?? null,
    isEmpty: selection?.isEmpty() ?? true,
    isDirty: uri === undefined ? false : workingCopies.isDirty(uri),
    languageId: model?.getLanguageId() ?? '',
    selectedBytes: new TextEncoder().encode(text).length,
    version: model?.getVersionId() ?? null,
    text,
  }
}

export async function reportEditorContext(projectRoot: string): Promise<void> {
  const [editors, codeEditors, workingCopies] = await Promise.all([
    getService(IEditorService),
    getService(ICodeEditorService),
    getService(IWorkingCopyService),
  ])

  /*
   * The last frame sent, so an unchanged one is not sent again.
   *
   * Cursor events fire per keystroke and arrow key. Main coalesces too, but the
   * cheapest report is the one that never crosses a process boundary — the same
   * reasoning as `WorkbenchFrame`'s rectangle dedupe, one channel over.
   */
  let last = ''
  let lastPreview: PreviewSelection | null = null
  let previewRefresh = 0
  const previewEvents = new DisposableStore()

  /** Editors already subscribed, so no route can subscribe one twice. */
  const watched = new Set<ICodeEditor>()

  const report = (): void => {
    const editor = trackedEditor(editors)
    const model = editor?.getModel() ?? null
    // Same model for the path as for the selection — see `readEditorSnapshot`.
    const uri = model?.uri ?? editors.activeEditor?.resource
    const document = resolveActive(projectRoot, editors.activeEditor?.typeId ?? '', uri)
    const selection = editor?.getSelection() ?? null

    /*
     * Bytes rather than characters, and measured from the model rather than
     * carried as text. `TextEncoder` is the only thing here that counts what a
     * provider's cap is actually expressed in; `length` would under-report every
     * non-ASCII selection by up to a factor of four.
     *
     * An empty selection reads zero without asking the model for a range, which
     * is the common case — a caret sitting in a file, on every keystroke.
     */
    const selectedBytes =
      selection === null || model === null || selection.isEmpty()
        ? 0
        : new TextEncoder().encode(model.getValueInRange(selection)).length

    const context: WorkbenchContext =
      lastPreview === null
        ? {
            relativePath: document.relativePath,
            provenance: document.provenance,
            scheme: document.scheme,
            editorTypeId: document.editorTypeId,
            reason: document.reason,
            startLine: selection?.startLineNumber ?? null,
            endLine: selection?.endLineNumber ?? null,
            isEmpty: selection?.isEmpty() ?? true,
            /*
             * Asked of the working copy service, because that is where dirty lives.
             *
             * A first version of this read `model.isDirty()` on the reasoning that the
             * model is the thing being edited. `ITextModel` has no such method — the
             * typechecker said so — and the reasoning was wrong as well as the code:
             * a text model holds content and versions, and *dirtiness is a property of
             * the working copy wrapping it*, which is why `Developer: Log Working
             * Copies` is the tool C-059 ended up using to answer this same question.
             */
            isDirty: uri === undefined ? false : workingCopies.isDirty(uri),
            languageId: model?.getLanguageId() ?? '',
            selectedBytes,
            /*
             * The version an `editor_edit` must quote as `base_version`.
             *
             * Read from the same model the rest of this snapshot describes, so the
             * version and the lines cannot disagree — taken separately they could,
             * and an agent quoting a version that never went with those lines is the
             * conflict this field exists to avoid.
             */
            version: model?.getVersionId() ?? null,
          }
        : previewContext(
            projectRoot,
            editors.activeEditor?.typeId ?? '',
            lastPreview,
            workingCopies
          )

    const rendered = JSON.stringify(context)
    if (rendered === last) return
    last = rendered
    window.chorusWorkbench.reportContext(context)
  }

  const refreshPreview = (): void => {
    const refresh = ++previewRefresh
    void readActivePreview(editors).then((read) => {
      if (refresh !== previewRefresh) return
      lastPreview = read ?? lastPreview
      report()
    })
  }

  const watchPreview = (): void => {
    previewEvents.clear()
    previewRefresh += 1
    previewActivation += 1
    lastPreview = null
    const webview = previewWebview(editors.activeEditor ?? null)
    if (webview === null) return
    previewEvents.add(webview.onDidFocus(refreshPreview))
    previewEvents.add(webview.onDidBlur(refreshPreview))
    previewEvents.add(
      webview.onDidDispose(() => {
        previewRefresh += 1
        previewActivation += 1
        lastPreview = null
        report()
      })
    )
    previewEvents.add(
      autorun((reader) => {
        reader.readObservable(webview.intrinsicContentSize)
        if (lastPreview === null) refreshPreview()
      })
    )
  }

  /*
   * Once, now, before any subscription — and its absence was a real gap.
   *
   * Every source below is a *change*. A workbench that restores an editor from
   * the last session has already had its `onDidActiveEditorChange`, and it fired
   * before this function was reached, so nothing here would report until the
   * person happened to move the cursor. The pill therefore started blank on a
   * restored session, and `ideAttached` starts false with it — which means Send
   * asks for no snapshot at all.
   *
   * Reporting the current state first makes the subscriptions what they claim to
   * be: updates to a state that has already been established.
   */
  /**
   * Adopt whatever is already open, because every event above is a *change*.
   *
   * A restored session has had all of them before this ran: the editors were
   * created, focused and given their selections while this code did not exist.
   * Without this the tracker starts empty on exactly the case people hit most —
   * reopening onto the file they were last reading — and reports `no-editor`
   * while lines sit highlighted on screen. That is the original symptom
   * surviving its own fix.
   *
   * Focus first, because it is a fact rather than an inference. Only when
   * nothing holds focus does this fall back to matching open editors against the
   * active input, which is the restored case: the workbench has laid out the
   * editors but given focus to none of them.
   */
  const hydrate = (): void => {
    const input = editors.activeEditor ?? null
    if (input === null) return

    /*
     * **Only returns when the promotion actually took.** `promote` refuses an
     * editor the tracker has not been told about and says so by returning the
     * state unchanged — so `tracker = promote(...); return` adopted nothing and
     * then skipped the URI match that would have worked. `getFocusedCodeEditor`
     * answers from `ICodeEditorService`'s whole registry, which includes editors
     * this function has never seen: the settings editor's widgets, a peek view,
     * anything created between `listCodeEditors()` and now. One of those holding
     * focus would silently disable hydration for the diff the person is in.
     */
    const focused = codeEditors.getFocusedCodeEditor()
    if (focused !== null) {
      const promoted = promote(tracker, focused, input, 'focus', true)
      if (promoted.tracked?.editor === focused) {
        tracker = promoted
        return
      }
    }

    /*
     * A diff names both of its sides; an ordinary input names one. Reading them
     * off the input rather than the control is what makes this work for a diff
     * at all — the control is the thing that could not answer in the first place.
     */
    const wanted = [
      (input as { resource?: { toString(): string } }).resource?.toString() ?? null,
      (
        input as { original?: { resource?: { toString(): string } } }
      ).original?.resource?.toString() ?? null,
      (
        input as { modified?: { resource?: { toString(): string } } }
      ).modified?.resource?.toString() ?? null,
    ]

    const target = hydrationTarget(
      codeEditors.listCodeEditors().map((editor) => ({
        editor,
        uri: editor.getModel()?.uri.toString() ?? null,
        hasSelection: editor.getSelection()?.isEmpty() === false,
      })),
      wanted
    )
    if (target === null) return
    /*
     * Promoted as `focus` even though nothing is focused: this is a deliberate
     * adoption, not an inference from a selection event, and the `selection` arm
     * would refuse it for want of widget focus.
     */
    tracker = promote(tracker, target, input, 'focus', true)
  }

  editors.onDidActiveEditorChange(() => {
    watchPreview()
    /*
     * Clear before reporting. The retained editor may still be alive and still
     * hold its old selection, so without this, opening a second file would quote
     * the first — and nothing downstream could tell.
     */
    tracker = activeInputChanged(tracker, editors.activeEditor ?? null)
    /*
     * A microtask, because the input changes before its control and model are
     * ready — hydrating synchronously here finds an editor with no model and
     * adopts nothing. The following tick is the first moment the pair exists.
     */
    queueMicrotask(() => {
      hydrate()
      report()
    })
    report()
  })

  /*
   * **Each editor promotes itself, and the report never looks one up.**
   *
   * The previous version subscribed each editor to `report`, which then asked
   * the service which editor was active — discarding the one that had just
   * emitted. That is the whole defect: a diff's children emit, and the service
   * answers with neither of them, so a merge-request pane reported `no-editor`
   * while the person had lines selected in it.
   *
   * `hasWidgetFocus()` is what keeps the *side* honest. Both children of a diff
   * emit selection changes — synced scrolling, decorations, an extension's own
   * edits — so promoting on any selection would let the side nobody is in claim
   * the selection. Focus promotes unconditionally because focus is a statement
   * of intent; selection promotes only as evidence of where that focus is.
   */
  const watch = (editor: ICodeEditor): void => {
    /*
     * Subscribed once per editor, whatever route reached it.
     *
     * `onCodeEditorAdd` is registered before `listCodeEditors()` is walked, and
     * an editor created in between is in both — so its listeners would be
     * attached twice and every cursor move would run `report` twice. Harmless
     * today only because `report` dedupes; a guard is cheaper than depending on
     * that staying true.
     */
    if (watched.has(editor)) return
    watched.add(editor)
    tracker = addEditor(tracker, editor)
    const claim = (reason: 'focus' | 'selection') => (): void => {
      const promoted = promote(
        tracker,
        editor,
        editors.activeEditor ?? null,
        reason,
        editor.hasWidgetFocus()
      )
      if (promoted.tracked?.editor === editor) tracker = promoted
      /*
       * **A refused claim is the restored session's only remaining signal.**
       *
       * Restoring a session sets each editor's view state — including its
       * selection — while nothing holds focus, so these fire with
       * `hasWidgetFocus()` false and `promote` correctly refuses: a selection
       * without focus is not evidence of where the person is. But it *is* the
       * moment a diff first becomes distinguishable, because until the selection
       * is restored both sides look identical and `hydrationTarget` refuses them
       * both. Without this the tracker would sit empty until somebody clicked
       * into the editor, which is the workaround this whole change exists to
       * avoid asking for.
       *
       * Only when nothing is tracked, so a live claim can never be overridden by
       * a guess.
       */
      else if (trackedEditor(editors) === null) hydrate()
      report()
    }
    editor.onDidFocusEditorWidget(claim('focus'))
    editor.onDidChangeCursorPosition(claim('selection'))
    /*
     * Selection as well as position: a drag-select never moves the caret's line
     * and column on its final event, so watching position alone reports a range
     * of one character for a selection of five hundred.
     */
    editor.onDidChangeCursorSelection(claim('selection'))
    editor.onDidChangeModelContent(report)
    /*
     * **The moment hydration can actually succeed, and the one it kept missing.**
     *
     * A code editor is created by its pane before it has a model: the widget
     * exists as soon as the pane does, and `input.resolve()` attaches the model
     * afterwards. So `onCodeEditorAdd` fires with `getModel()` still null, the
     * `queueMicrotask` hydration below runs a microtask later — still null — and
     * the candidate is filtered out for having no URI. There is no second
     * attempt, so the tracker stays empty for the whole life of that editor.
     *
     * A microtask was never going to be enough. For a `gl-review:` document the
     * content is fetched from GitLab, and for an ordinary file it is a read on
     * the remote extension host: both are I/O, and no number of microtasks
     * arrives after I/O. This is the event that says the model is here.
     *
     * **Guarded on the tracker having nothing to say**, so this cannot steal.
     * Once an editor is adopted, a model arriving in some *other* editor — a
     * preview tab being reused, the far side of a diff resolving second — must
     * not re-run the guess and hand the person's selection to the wrong pane.
     */
    editor.onDidChangeModel(() => {
      if (trackedEditor(editors) === null) hydrate()
      report()
    })
    /*
     * Disposal both forgets the editor and, if it was the tracked one, forgets
     * the tracking. Leaving it in either place would let a read describe an
     * editor that no longer exists.
     */
    editor.onDidDispose(() => {
      // Also out of `watched`, or this set is a list of every editor the surface
      // has ever held open — and the whole point of it is that it holds editors.
      watched.delete(editor)
      tracker = removeEditor(tracker, editor)
      report()
    })
  }

  /*
   * Both arms, because neither covers the other: `onCodeEditorAdd` misses every
   * editor that existed before this ran — which on a restored session is all of
   * them — and the list alone misses every editor opened afterwards, including
   * the two a diff creates when a merge-request file is opened.
   */
  codeEditors.onCodeEditorAdd((editor) => {
    watch(editor)
    /*
     * The second half of the restored case: a diff's children are created after
     * the input becomes active, so the hydration above ran before they existed.
     * Same microtask reason — the model arrives after the editor does.
     */
    queueMicrotask(() => {
      hydrate()
      report()
    })
  })
  for (const editor of codeEditors.listCodeEditors()) watch(editor)

  /*
   * **After `watch`, never before.** `promote` refuses an editor the tracker has
   * not been told about, so hydrating first adopts nothing and silently
   * reproduces the very bug this exists to fix. The first version of this change
   * had exactly that ordering.
   */
  watchPreview()
  hydrate()
  report()

  codeEditors.onCodeEditorRemove((editor) => {
    watched.delete(editor)
    tracker = removeEditor(tracker, editor)
    report()
  })

  report()
}
