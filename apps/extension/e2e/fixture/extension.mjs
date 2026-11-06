import * as vscode from 'vscode'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function activate(context) {
  const directory = process.env.CHORUS_E2E_CONTROL
  if (directory === undefined) return
  const diagnostics = vscode.languages.createDiagnosticCollection('chorus-e2e')
  let current = ''
  let busy = false
  const state = () => ({
    documents: vscode.workspace.textDocuments.map((document) => ({
      path: document.uri.fsPath,
      uri: document.uri.toString(),
      version: document.version,
      dirty: document.isDirty,
      text: document.getText(),
    })),
    active: vscode.window.activeTextEditor?.document.uri.toString() ?? null,
    selection:
      vscode.window.activeTextEditor === undefined
        ? null
        : {
            line: vscode.window.activeTextEditor.selection.active.line,
            character: vscode.window.activeTextEditor.selection.active.character,
          },
    tabs: vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.map((tab) => ({
        label: tab.label,
        active: tab.isActive,
        group: group.viewColumn,
        input:
          tab.input instanceof vscode.TabInputText
            ? tab.input.uri.toString()
            : tab.input instanceof vscode.TabInputTextDiff
              ? { original: tab.input.original.toString(), modified: tab.input.modified.toString() }
              : null,
      }))
    ),
  })
  const run = async (request) => {
    if (request.action === 'state') return state()
    if (request.action === 'open') {
      const document = await vscode.workspace.openTextDocument(
        request.uri === undefined ? vscode.Uri.file(request.path) : vscode.Uri.parse(request.uri)
      )
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      })
      if (request.selection !== undefined)
        editor.selection = new vscode.Selection(...request.selection)
      return state()
    }
    if (request.action === 'replace') {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(request.path))
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        request.text
      )
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error('fixture edit refused')
      return state()
    }
    if (request.action === 'diagnostic') {
      const uri = vscode.Uri.file(request.path)
      const range = new vscode.Range(0, 0, 0, 5)
      diagnostics.set(uri, [
        new vscode.Diagnostic(range, request.message, vscode.DiagnosticSeverity.Error),
      ])
      return true
    }
    if (request.action === 'closeTab') {
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.label.includes(request.label))
      return await vscode.window.tabGroups.close(tabs, true)
    }
    if (request.action === 'command')
      return (
        (await vscode.commands.executeCommand(request.command, ...(request.args ?? []))) ?? null
      )
    if (request.action === 'commands') return await vscode.commands.getCommands(true)
    if (request.action === 'repositories') {
      const git = await vscode.extensions.getExtension('vscode.git')?.activate()
      return git?.getAPI(1).repositories.map((repository) => repository.rootUri.fsPath) ?? []
    }
    throw new Error(`Unknown fixture operation ${request.action}`)
  }
  const timer = setInterval(() => {
    const path = join(directory, 'request.json')
    if (busy || !existsSync(path)) return
    const request = JSON.parse(readFileSync(path, 'utf8'))
    if (request.id === current) return
    current = request.id
    busy = true
    run(request)
      .then(
        (value) => {
          writeFileSync(
            join(directory, 'answer.json'),
            JSON.stringify({ id: request.id, ok: true, value })
          )
        },
        (error) => {
          writeFileSync(
            join(directory, 'answer.json'),
            JSON.stringify({ id: request.id, ok: false, error: String(error) })
          )
        }
      )
      .finally(() => {
        busy = false
      })
  }, 75)
  context.subscriptions.push(diagnostics, {
    dispose: () => {
      clearInterval(timer)
    },
  })
}
