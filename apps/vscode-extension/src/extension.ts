import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import {
  MAX_SELECTED_BYTES,
  PROTOCOL_VERSION,
  utf8ByteLength,
  type CurrentContextResult,
} from '@chorus/ide-protocol'
import { ChorusConnection } from './connection.js'
import {
  countStates,
  diagnosticLines,
  frameFields,
  type ConnectionCounts,
  type WindowDiagnostics,
} from './diagnostics.js'
import { resolveDocument } from './document-identity.js'
import { pidIsAlive, readDescriptors } from './discovery.js'
import {
  isInside,
  isSupported,
  metadataFor,
  reportAll,
  reportFor,
  SelectionCache,
  type EditorLike,
  type WindowFacts,
} from './editor-context.js'

/**
 * The only file that knows what a `vscode.TextEditor` is.
 *
 * Everything with a rule in it lives next door in `editor-context.ts`, free of
 * any editor import, so the disclosure policy can be tested directly rather
 * than through a mock of VS Code.
 */

/** Matches the broker's own debounce; see plan §4. */
const DEBOUNCE_MS = 200

/** How often to rescan for a Chorus that started after this window did. */
const RESCAN_MS = 5_000

let disposed = false

export function activate(context: vscode.ExtensionContext): void {
  disposed = false
  const windowId = randomUUID()
  const cache = new SelectionCache()
  const connections = new Map<number, ChorusConnection>()
  let debounce: NodeJS.Timeout | null = null

  const output = vscode.window.createOutputChannel('Chorus')
  const log = (message: string, fields?: Record<string, unknown>): void => {
    // Reason codes and counts only — never a path, a token, or source text.
    output.appendLine(fields === undefined ? message : `${message} ${JSON.stringify(fields)}`)
  }

  const counts = (): ConnectionCounts => countStates([...connections.values()].map((c) => c.state))

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0)
  const paint = (): void => {
    const live = counts()
    // Deliberately a different vocabulary from the per-conversation status in
    // Chorus: this window knows whether it reached a Chorus process, not which
    // conversation is asking or whether its root matched.
    //
    // A version mismatch outranks both, because it is the one state the user
    // has to act on and the one that used to be invisible: `start()` refuses
    // the handshake, so an outdated extension looked exactly like no Chorus
    // running at all. Phase 4 bumps the protocol, and this is what makes that
    // survivable for anyone who has the extension already installed.
    if (live.extensionOutdated > 0) {
      status.text = '$(warning) Chorus: update the extension'
      status.tooltip = 'This Chorus speaks a newer protocol. Update from Chorus → Settings.'
    } else if (live.chorusOutdated > 0) {
      status.text = '$(warning) Chorus: update Chorus'
      status.tooltip = 'This extension speaks a newer protocol than the running Chorus.'
    } else {
      status.text =
        live.connected > 0 ? '$(link) Chorus: linked' : '$(debug-disconnect) Chorus: not running'
      status.tooltip = undefined
    }
    status.show()
  }

  const facts = (): WindowFacts => ({
    workspaceFolders: (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => canonical(f.uri.fsPath)),
    isTrusted: vscode.workspace.isTrusted,
  })

  /** Read per use: a setting toggled while VS Code runs must take effect now. */
  const tracing = (): boolean =>
    vscode.workspace.getConfiguration('chorus').get<boolean>('trace') === true

  const windowDiagnostics = (
    editor: EditorLike | null,
    current: WindowFacts
  ): WindowDiagnostics => ({
    scheme: editor?.uriScheme ?? null,
    trusted: current.isTrusted,
    folderCount: current.workspaceFolders.length,
    connections: counts(),
    extensionVersion: extensionVersion(context),
    protocolVersion: PROTOCOL_VERSION,
  })

  const publish = (): void => {
    if (disposed) return
    // One `facts()` per frame: it calls `realpathSync` per workspace folder, and
    // this runs on every debounced selection change.
    const current = facts()
    const editor = currentEditor()
    // Each Chorus hears about its own roots and nobody else's. `reportAll`
    // observes the cache, which is idempotent for a given editor and set of
    // workspace folders — both fixed across this loop.
    const diagnostics = tracing() ? windowDiagnostics(editor, current) : null
    for (const connection of connections.values()) {
      const reports = reportAll(connection.roots, current, editor, cache)
      connection.send(reports)
      if (diagnostics !== null) {
        log('frame', { pid: connection.pid, ...frameFields(reports, diagnostics) })
      }
    }
    paint()
  }

  const schedule = (): void => {
    if (debounce !== null) clearTimeout(debounce)
    // Coalesced to the latest state: without this, holding an arrow key would
    // emit a frame per keypress.
    debounce = setTimeout(() => {
      debounce = null
      publish()
    }, DEBOUNCE_MS)
    debounce.unref()
  }

  const snapshot = (root: string): CurrentContextResult => {
    const editor = currentEditor()
    const resolved = cache.resolve(editor)
    const chosen = resolved.editor
    if (chosen === null || !isSupported(chosen)) {
      return { outcome: 'unavailable', reason: 'unsupported' }
    }
    if (!facts().workspaceFolders.includes(root) || !isInside(root, chosen.filePath)) {
      return { outcome: 'unavailable', reason: 'unmatched' }
    }
    const bytes = utf8ByteLength(chosen.selectedText)
    if (bytes > MAX_SELECTED_BYTES) return { outcome: 'tooLarge', selectedBytes: bytes }

    const metadata = metadataFor(chosen, resolved.source)
    return {
      outcome: 'ok',
      snapshot: {
        ...metadata,
        selection: { ...metadata.selection, selectedBytes: bytes, text: chosen.selectedText },
      },
    }
  }

  const rescan = (): void => {
    if (disposed) return
    const directory = join(tmpdir(), 'chorus-ide')
    const found = readDescriptors(directory, { isAlive: pidIsAlive })
    const live = new Set(found.map((d) => d.pid))

    for (const [pid, connection] of connections) {
      if (!live.has(pid)) {
        connection.dispose()
        connections.delete(pid)
      }
    }
    for (const descriptor of found) {
      if (connections.has(descriptor.pid)) continue
      const connection = new ChorusConnection(
        descriptor,
        {
          windowId,
          ideName: vscode.env.appName,
          clientVersion: extensionVersion(context),
          isTrusted: () => vscode.workspace.isTrusted,
          isFocused: () => vscode.window.state.focused,
        },
        {
          // The connection keeps what it was told; the window only republishes.
          onRoots: publish,
          onSnapshot: snapshot,
          onStateChange: publish,
          log,
        }
      )
      connections.set(descriptor.pid, connection)
      connection.start()
    }
    paint()
  }

  const rescanTimer = setInterval(rescan, RESCAN_MS)
  rescanTimer.unref()
  rescan()

  context.subscriptions.push(
    output,
    status,
    vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.window.onDidChangeActiveTextEditor(schedule),
    vscode.window.onDidChangeWindowState(schedule),
    vscode.workspace.onDidChangeWorkspaceFolders(schedule),
    /*
     * The cache now survives the user looking at something unreferenceable, so
     * it also has to notice when the document it holds goes away — otherwise a
     * tab closed an hour ago would still be offering its lines.
     */
    vscode.workspace.onDidCloseTextDocument((document) => {
      cache.forget(document.uri.toString())
      schedule()
    }),
    vscode.commands.registerCommand('chorus.reconnect', () => {
      for (const connection of connections.values()) connection.dispose()
      connections.clear()
      rescan()
    }),
    vscode.commands.registerCommand('chorus.diagnose', () => {
      /*
       * `cache.resolve` rather than `reportAll`, which would `observe` and so
       * change what the *next* frame says. Asking why something is wrong must
       * not alter it.
       */
      const current = facts()
      const editor = currentEditor()
      const resolved = cache.resolve(editor)
      const chorus = [...connections.values()].map((connection) => ({
        pid: connection.pid,
        state: connection.state,
        reports: connection.roots.map((root) =>
          reportFor(root, current, resolved.editor, resolved.source)
        ),
      }))
      for (const line of diagnosticLines(chorus, windowDiagnostics(editor, current))) {
        output.appendLine(line)
      }
      // `true` preserves focus: the answer is worth reading, not worth stealing
      // the caret from whatever the user was in the middle of.
      output.show(true)
    }),
    {
      dispose: () => {
        disposed = true
        clearInterval(rescanTimer)
        if (debounce !== null) clearTimeout(debounce)
        for (const connection of connections.values()) connection.dispose()
        connections.clear()
        cache.clear()
      },
    }
  )
}

export function deactivate(): void {
  // Everything is on `context.subscriptions`, which VS Code disposes for us
  // inside its shutdown budget. This exists so that contract is explicit.
  disposed = true
}

/**
 * The extension's own version, for the handshake.
 *
 * `packageJSON` is typed `any` by the VS Code API, and the global rule is that
 * `any` never enters this codebase. Narrowed here rather than cast, so a
 * manifest without a version string degrades to a value Chorus can still
 * compare instead of putting `undefined` on the wire.
 */
function extensionVersion(context: vscode.ExtensionContext): string {
  const manifest: unknown = context.extension.packageJSON
  if (typeof manifest !== 'object' || manifest === null) return '0.0.0'
  const version = (manifest as Record<string, unknown>)['version']
  return typeof version === 'string' && version !== '' ? version : '0.0.0'
}

/** Resolve symlinks so a workspace folder and a Chorus cwd can be compared. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The active editor, flattened into the shape the rules understand.
 *
 * `resolveDocument` is the whole of what changed in protocol 2: a diff pane is
 * an ordinary `TextEditor`, and what it needed was not permission but a way to
 * say which version of the file its lines are. A document it cannot name keeps
 * its scheme and carries `provenance: null`, so the diagnostics can still say
 * *what* was refused rather than reporting nothing at all.
 */
function currentEditor(): EditorLike | null {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined) return null
  const { document, selection } = editor
  const resolved = resolveDocument({
    scheme: document.uri.scheme,
    path: document.uri.path,
    query: document.uri.query,
    fsPath: document.uri.fsPath,
  })
  return {
    uriScheme: document.uri.scheme,
    // `canonical` resolves as far as the path exists, so a review document
    // naming a file that is not in this working tree keeps its literal path
    // rather than becoming something else.
    filePath: resolved === null ? document.uri.fsPath : canonical(resolved.filePath),
    provenance: resolved?.provenance ?? null,
    fileUrl: document.uri.toString(),
    languageId: document.languageId,
    documentVersion: document.version,
    isDirty: document.isDirty,
    selection: {
      start: { line: selection.start.line, character: selection.start.character },
      end: { line: selection.end.line, character: selection.end.character },
      isEmpty: selection.isEmpty,
    },
    selectedText: document.getText(selection),
  }
}
