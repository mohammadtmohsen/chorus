import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { MAX_SELECTED_BYTES, utf8ByteLength, type CurrentContextResult } from '@chorus/ide-protocol'
import { ChorusConnection } from './connection.js'
import { pidIsAlive, readDescriptors } from './discovery.js'
import {
  isInside,
  isSupported,
  metadataFor,
  reportAll,
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
  let roots: string[] = []
  let debounce: NodeJS.Timeout | null = null

  const output = vscode.window.createOutputChannel('Chorus')
  const log = (message: string, fields?: Record<string, unknown>): void => {
    // Reason codes and counts only — never a path, a token, or source text.
    output.appendLine(fields === undefined ? message : `${message} ${JSON.stringify(fields)}`)
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0)
  const paint = (): void => {
    const live = [...connections.values()].filter((c) => c.connected).length
    // Deliberately a different vocabulary from the per-conversation status in
    // Chorus: this window knows whether it reached a Chorus process, not which
    // conversation is asking or whether its root matched.
    status.text = live > 0 ? '$(link) Chorus: linked' : '$(debug-disconnect) Chorus: not running'
    status.show()
  }

  const facts = (): WindowFacts => ({
    workspaceFolders: (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => canonical(f.uri.fsPath)),
    isTrusted: vscode.workspace.isTrusted,
  })

  const publish = (): void => {
    if (disposed) return
    const reports = reportAll(roots, facts(), currentEditor(), cache)
    for (const connection of connections.values()) connection.send(reports)
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
          onRoots: (next) => {
            roots = [...next]
            publish()
          },
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
    vscode.commands.registerCommand('chorus.reconnect', () => {
      for (const connection of connections.values()) connection.dispose()
      connections.clear()
      rescan()
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

/** The active editor, flattened into the shape the rules understand. */
function currentEditor(): EditorLike | null {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined) return null
  const { document, selection } = editor
  return {
    uriScheme: document.uri.scheme,
    filePath: document.uri.scheme === 'file' ? canonical(document.uri.fsPath) : document.uri.fsPath,
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
