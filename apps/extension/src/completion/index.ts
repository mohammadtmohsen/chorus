import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import type { CompletionEnvironment, CompletionPort, DefinitionLocation } from './contracts.js'
import { InlineCompletionProvider } from './provider.js'

export type { CompletionPort } from './contracts.js'

const EXCLUDED_MEMBER_KINDS = new Set<vscode.CompletionItemKind>([
  vscode.CompletionItemKind.Text,
  vscode.CompletionItemKind.Snippet,
  vscode.CompletionItemKind.Keyword,
  vscode.CompletionItemKind.File,
  vscode.CompletionItemKind.Folder,
])

export function registerInlineCompletions(port: CompletionPort): vscode.Disposable {
  const host: CompletionEnvironment = {
    position: (line, character) => new vscode.Position(line, character),
    range: (start, end) => new vscode.Range(start, end),
    insideProject: (uri) => port.insideProject(uri),
    relativePath: (uri) =>
      port.relativePath === undefined
        ? vscode.workspace.asRelativePath(uri, false)
        : port.relativePath(uri),
    definitions: async (uri, position) =>
      await vscode.commands.executeCommand<DefinitionLocation[] | undefined>(
        'vscode.executeDefinitionProvider',
        uri,
        position
      ),
    typeDefinitions: async (uri, position) =>
      await vscode.commands.executeCommand<DefinitionLocation[] | undefined>(
        'vscode.executeTypeDefinitionProvider',
        uri,
        position
      ),
    hovers: async (uri, position) =>
      await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
        'vscode.executeHoverProvider',
        uri,
        position
      ),
    members: async (uri, position) =>
      await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
        'vscode.executeCompletionItemProvider',
        uri,
        position
      ),
    memberAllowed: (item) => item.kind === undefined || !EXCLUDED_MEMBER_KINDS.has(item.kind),
    openDocument: async (uri) => await vscode.workspace.openTextDocument(uri),
    enabled: (document) =>
      vscode.workspace.isTrusted &&
      vscode.workspace
        .getConfiguration('editor', document.uri)
        .get<boolean>('inlineSuggest.enabled', true),
    activeEditor: () => {
      const editor = vscode.window.activeTextEditor
      return editor === undefined
        ? null
        : { uri: editor.document.uri, position: editor.selection.active }
    },
    requestId: randomUUID,
    now: () => performance.now(),
  }
  const provider = new InlineCompletionProvider(port, host)
  const registration = vscode.languages.registerInlineCompletionItemProvider(
    [{ scheme: 'file' }, { scheme: 'vscode-remote' }],
    provider
  )
  return vscode.Disposable.from(
    registration,
    provider,
    vscode.window.onDidChangeActiveTextEditor(() => {
      provider.invalidate()
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      provider.invalidate(event.textEditor.document.uri)
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      provider.invalidate(event.document.uri)
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      provider.invalidate(document.uri)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('editor.inlineSuggest')) provider.invalidate()
    })
  )
}
