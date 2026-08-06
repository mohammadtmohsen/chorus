/**
 * The smallest `vscode` that lets `extension.ts` be imported under vitest.
 *
 * Deliberately thin. A faithful reimplementation of the editor API would be a
 * second thing to keep correct, and anything it proved would be about the
 * mock rather than about Chorus — which is why the disclosure rules live in
 * `editor-context.ts` with no VS Code import at all.
 */

type Listener = (...args: unknown[]) => void

interface Disposable {
  dispose: () => void
}

function event(): (listener: Listener) => Disposable {
  return () => ({ dispose: () => undefined })
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const

export const window = {
  activeTextEditor: undefined as unknown,
  state: { focused: true },
  createOutputChannel: () => ({
    appendLine: () => undefined,
    dispose: () => undefined,
  }),
  createStatusBarItem: () => ({
    text: '',
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  onDidChangeTextEditorSelection: event(),
  onDidChangeActiveTextEditor: event(),
  onDidChangeWindowState: event(),
}

export const workspace = {
  workspaceFolders: undefined as unknown,
  isTrusted: true,
  onDidChangeWorkspaceFolders: event(),
}

export const commands = {
  registerCommand: (): Disposable => ({ dispose: () => undefined }),
}

export const env = { appName: 'Visual Studio Code' }
