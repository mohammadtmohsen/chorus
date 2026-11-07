import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as vscode from 'vscode'
import { hasRoot } from '@chorus/ide-protocol/paths'
import type { DiagnosticSeverity } from '@chorus/ide-protocol/protocol'
import { SelectionCache } from './editor-context.js'
import type { WorkbenchPlace } from '../../../desktop/src/main/project-root.js'
import type {
  WorkbenchAskDiffRequest,
  WorkbenchAskDiffResult,
  WorkbenchEditRequest,
  WorkbenchEditResult,
  WorkbenchSnapshot,
} from '../../../desktop/src/shared/workbench-ipc.js'
import { AskDiffController } from './ask-diff.js'
import { editConflict } from './edit-conflict.js'
import { projectDiagnostic } from './diagnostics.js'
import {
  contextFor,
  deepestProject,
  containingProjects,
  snapshotFor,
  type LocatedEditor,
} from './membership.js'
import { MarkdownPreviews, type PreviewCapture } from './markdown-preview.js'
import {
  locateDocument,
  mapResource,
  normalizedPath,
  pathPlatform,
  projectPath,
  relativePath,
  samePlace,
  type DocumentLocation,
  type ResourceUri,
} from './resources.js'
import type { EditorIntegrationOptions, OpenFileRequest } from './types.js'

export type {
  EditorIntegrationOptions,
  EditorMessages,
  EditorProject,
  OpenFileRequest,
} from './types.js'

const severities: Record<vscode.DiagnosticSeverity, DiagnosticSeverity> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'information',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
}

function canonicalLocal(path: string): string {
  let head = normalizedPath(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync(head), ...tail)
    } catch {
      const parent = dirname(head)
      if (parent === head) return normalizedPath(path)
      tail.unshift(basename(head))
      head = parent
    }
  }
}

function editRange(range: WorkbenchEditRequest['range']): vscode.Range {
  return new vscode.Range(
    range.startLine - 1,
    range.startColumn - 1,
    range.endLine - 1,
    range.endColumn - 1
  )
}

export class EditorIntegration implements vscode.Disposable {
  private readonly cache = new SelectionCache()
  private readonly previews: MarkdownPreviews
  private readonly diffs: AskDiffController
  private readonly disposables: vscode.Disposable[] = []
  private lastKind: 'text' | 'preview' | 'unsupported-preview' = 'text'
  private activation = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly options: EditorIntegrationOptions) {
    this.previews = new MarkdownPreviews({
      accepts: (uri) => {
        const location = this.location(uri)
        return (
          vscode.workspace.isTrusted &&
          location !== null &&
          containingProjects(this.options.projects(), location).length > 0
        )
      },
      title: options.messages.previewTitle,
      changed: () => {
        if (this.previews.active()) this.setKind('preview')
        this.schedule()
      },
      log: options.log,
    })
    this.diffs = new AskDiffController({
      focused: (place) =>
        this.options
          .projects()
          .some(
            (project) => project.id === this.options.focusedProject() && samePlace(project, place)
          ),
      available: (place) => vscode.workspace.isTrusted && this.available(place),
      resource: (place, path) => this.resource(place, path),
      column: (place) => this.column(place),
      failed: options.messages.diffFailed,
      log: options.log,
    })
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.observeFocus()
        this.schedule()
        this.activateProject(editor)
      }),
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.observeFocus()
        this.schedule()
      }),
      vscode.workspace.onDidChangeTextDocument(() => {
        this.schedule()
      }),
      vscode.workspace.onDidSaveTextDocument(() => {
        this.schedule()
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.schedule()
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.reportAll()
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.cache.forget(document.uri.toString())
        this.schedule()
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.observeFocus()
        this.schedule()
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => {
        this.observeFocus()
        this.schedule()
      })
    )
    this.observeFocus()
  }

  private resources(): ResourceUri[] {
    return [
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
      ...vscode.workspace.textDocuments.map((document) => document.uri),
    ]
  }

  private location(uri: vscode.Uri): DocumentLocation | null {
    const location = locateDocument(
      uri,
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
      process.platform
    )
    return location?.host !== ''
      ? location
      : { ...location, filePath: canonicalLocal(location.filePath) }
  }

  documentLocation(uri: vscode.Uri): DocumentLocation | null {
    return this.location(uri)
  }

  private trusted(): boolean {
    return vscode.workspace.isTrusted
  }

  private available(place: WorkbenchPlace): boolean {
    return !this.disposed && this.options.projects().some((project) => samePlace(project, place))
  }

  private resource(place: WorkbenchPlace, path: string): vscode.Uri | null {
    if (!vscode.workspace.isTrusted || !this.available(place)) return null
    const candidate = normalizedPath(path)
    let absolute = hasRoot(candidate, pathPlatform(place.root))
      ? candidate
      : projectPath(place, path)
    if (absolute === null) return null
    if (place.host === '') absolute = canonicalLocal(absolute)
    const mapped = mapResource(place, absolute, this.resources())
    return mapped === null ? null : vscode.Uri.from(mapped)
  }

  private column(place: WorkbenchPlace): vscode.ViewColumn {
    const visible = vscode.window.visibleTextEditors.find((editor) => {
      const location = this.location(editor.document.uri)
      return location !== null && relativePath(place, location) !== null
    })
    if (visible?.viewColumn !== undefined) return visible.viewColumn
    const group = vscode.window.tabGroups.all.find((candidate) =>
      candidate.tabs.some((tab) => tab.input instanceof vscode.TabInputText)
    )
    return group?.viewColumn ?? vscode.ViewColumn.Beside
  }

  private setKind(kind: 'text' | 'preview' | 'unsupported-preview'): void {
    if (this.lastKind === kind) return
    this.lastKind = kind
    this.activation += 1
  }

  private observeFocus(): void {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    if (input instanceof vscode.TabInputWebview) {
      if (
        input.viewType === 'markdown.preview' ||
        input.viewType === 'vscode.markdown.preview.editor'
      )
        this.setKind('unsupported-preview')
      return
    }
    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputTextDiff)
      this.setKind('text')
  }

  private activateProject(editor: vscode.TextEditor | undefined): void {
    if (this.disposed || editor === undefined || editor.document.isUntitled) return
    const location = this.location(editor.document.uri)
    if (location === null) return
    const projects = this.options.projects()
    if (
      containingProjects(projects, location).some(
        (project) => project.id === this.options.focusedProject()
      )
    )
      return
    const project = deepestProject(projects, location)
    if (project !== null) this.options.activate(project.id)
  }

  private readTextEditor(): LocatedEditor | null {
    const active = vscode.window.activeTextEditor
    if (active === undefined) return null
    const location = this.location(active.document.uri)
    const { document, selection } = active
    return {
      location,
      editor: {
        uriScheme: document.uri.scheme,
        filePath: location?.filePath ?? '',
        provenance: location?.provenance ?? null,
        fileUrl: document.uri.toString(),
        languageId: document.languageId,
        documentVersion: document.version,
        isDirty: document.isDirty,
        selection,
        selectedText: document.getText(selection),
      },
    }
  }

  private fromPreview(capture: PreviewCapture | null): LocatedEditor | null {
    if (capture === null) return null
    const { document, selection } = capture
    const location = this.location(document.uri)
    return {
      location,
      preview: true,
      editor: {
        uriScheme: document.uri.scheme,
        filePath: location?.filePath ?? '',
        provenance: location?.provenance ?? null,
        fileUrl: document.uri.toString(),
        languageId: document.languageId,
        documentVersion: document.version,
        isDirty: document.isDirty,
        selection: {
          start: { line: selection.startLine - 1, character: 0 },
          end: { line: selection.endLine - 1, character: 1 },
          isEmpty: selection.text === '',
        },
        selectedText: selection.text,
      },
    }
  }

  private chosen(): LocatedEditor | null {
    if (!vscode.workspace.isTrusted) {
      this.cache.clear()
      return null
    }
    if (this.lastKind === 'unsupported-preview') return null
    if (this.lastKind === 'preview') return this.fromPreview(this.previews.current())
    const current = this.readTextEditor()
    if (current !== null) {
      const eligible =
        current.location !== null &&
        containingProjects(this.options.projects(), current.location).length > 0
      this.cache.observe(current.editor, eligible ? [current.editor.filePath] : [])
    }
    const resolved = this.cache.resolve(current?.editor ?? null).editor
    if (resolved === null) return null
    const document = vscode.workspace.textDocuments.find(
      (entry) => entry.uri.toString() === resolved.fileUrl
    )
    const visible = vscode.window.visibleTextEditors.find((entry) => entry.document === document)
    const selection =
      visible?.selection ??
      new vscode.Selection(
        resolved.selection.start.line,
        resolved.selection.start.character,
        resolved.selection.end.line,
        resolved.selection.end.character
      )
    return {
      editor:
        document === undefined
          ? resolved
          : {
              ...resolved,
              documentVersion: document.version,
              isDirty: document.isDirty,
              languageId: document.languageId,
              selection,
              selectedText: document.getText(selection),
            },
      location: this.location(vscode.Uri.parse(resolved.fileUrl)),
    }
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.reportAll()
    }, 200)
  }

  reportAll(): void {
    if (this.disposed) return
    const projects = this.options.projects()
    this.diffs.removeMissingProjects(projects)
    const chosen = this.chosen()
    for (const project of projects)
      this.options.report({
        host: project.host,
        projectRoot: project.root,
        context: contextFor(project, vscode.workspace.isTrusted, chosen),
      })
  }

  async snapshot(place: WorkbenchPlace): Promise<WorkbenchSnapshot | null> {
    if (!this.available(place)) return null
    const activation = this.activation
    const chosen =
      this.lastKind === 'preview' ? this.fromPreview(await this.previews.read()) : this.chosen()
    if (this.disposed || this.activation !== activation || !this.available(place)) return null
    const snapshot = snapshotFor(place, vscode.workspace.isTrusted, chosen)
    this.reportAll()
    return snapshot
  }

  private async prepareEdit(
    place: WorkbenchPlace,
    request: WorkbenchEditRequest
  ): Promise<
    | { document: vscode.TextDocument; uri: vscode.Uri }
    | { result: Extract<WorkbenchEditResult, { ok: false }> }
  > {
    const refuse = (
      refusal: Extract<WorkbenchEditResult, { ok: false }>['refusal'],
      message: string,
      version: number | null = null
    ): { result: Extract<WorkbenchEditResult, { ok: false }> } => ({
      result: { requestId: request.requestId, ok: false, refusal, message, version },
    })
    if (!vscode.workspace.isTrusted) return refuse('no-editor', this.options.messages.untrusted)
    if (!this.available(place)) return refuse('no-editor', this.options.messages.unavailable)
    const path = projectPath(place, request.path)
    const uri = path === null ? null : this.resource(place, path)
    if (uri === null) return refuse('outside-project', this.options.messages.outsideProject)
    let document: vscode.TextDocument
    try {
      document = await vscode.workspace.openTextDocument(uri)
    } catch {
      return refuse('unopenable', this.options.messages.openFailed)
    }
    const conflict = editConflict(
      {
        version: document.version,
        lineCount: document.lineCount,
        lineText: (line) => document.lineAt(line).text,
        rangeText: (range) => document.getText(editRange(range)),
      },
      request
    )
    if (conflict !== null) {
      const message = {
        version: this.options.messages.editVersionConflict,
        range: this.options.messages.editInvalidRange,
        text: this.options.messages.editTextConflict,
      }[conflict]
      return refuse('conflict', message, document.version)
    }
    if (!this.trusted() || !this.available(place))
      return refuse('no-editor', this.options.messages.unavailable)
    return { document, uri }
  }

  async edit(place: WorkbenchPlace, request: WorkbenchEditRequest): Promise<WorkbenchEditResult> {
    const prepared = await this.prepareEdit(place, request)
    if ('result' in prepared) return prepared.result
    const { document, uri } = prepared
    if (document.version !== request.baseVersion)
      return {
        requestId: request.requestId,
        ok: false,
        refusal: 'conflict',
        message: this.options.messages.editVersionConflict,
        version: document.version,
      }
    try {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(uri, editRange(request.range), request.newText)
      if (await vscode.workspace.applyEdit(edit)) {
        this.reportAll()
        return { requestId: request.requestId, ok: true, version: document.version }
      }
    } catch {
      this.options.log('editor.edit.failed')
    }
    return {
      requestId: request.requestId,
      ok: false,
      refusal: 'failed',
      message: this.options.messages.editFailed,
      version: document.version,
    }
  }

  async previewEdit(
    place: WorkbenchPlace,
    request: WorkbenchEditRequest & { readonly approvalId: string }
  ): Promise<WorkbenchAskDiffResult> {
    const prepared = await this.prepareEdit(place, request)
    if ('result' in prepared) {
      return {
        requestId: request.requestId,
        ok: false,
        message: prepared.result.message,
      }
    }
    if (prepared.document.version !== request.baseVersion)
      return {
        requestId: request.requestId,
        ok: false,
        message: this.options.messages.editVersionConflict,
      }
    const before = prepared.document.getText()
    const range = editRange(request.range)
    const start = prepared.document.offsetAt(range.start)
    const end = prepared.document.offsetAt(range.end)
    return await this.askDiff(place, {
      requestId: request.requestId,
      approvalId: request.approvalId,
      path: request.path,
      before,
      proposed: before.slice(0, start) + request.newText + before.slice(end),
    })
  }

  askDiff(
    place: WorkbenchPlace,
    request: WorkbenchAskDiffRequest
  ): Promise<WorkbenchAskDiffResult> {
    if (request.close !== true && projectPath(place, request.path) === null)
      return Promise.resolve({
        requestId: request.requestId,
        ok: false,
        message: this.options.messages.outsideProject,
      })
    return this.diffs.request(place, request)
  }

  focusChanged(): void {
    this.diffs.focusChanged()
    this.reportAll()
  }

  async openFile(request: OpenFileRequest): Promise<boolean> {
    let place = request.place
    const projects = this.options.projects()
    if (place === undefined) {
      const focused = projects.find((project) => project.id === this.options.focusedProject())
      if (focused !== undefined && this.resource(focused, request.path) !== null) place = focused
      else if (hasRoot(normalizedPath(request.path), pathPlatform(request.path)))
        place =
          deepestProject(projects, {
            host: '',
            filePath: canonicalLocal(request.path),
            provenance: { kind: 'worktree' },
          }) ?? undefined
    }
    if (place === undefined) return false
    const uri = this.resource(place, request.path)
    if (uri === null) return false
    try {
      const document = await vscode.workspace.openTextDocument(uri)
      const line = request.line
      const character = request.column
      const position =
        typeof line === 'number' && Number.isInteger(line) && line >= 1
          ? new vscode.Position(
              Math.min(line - 1, document.lineCount - 1),
              typeof character === 'number' && Number.isInteger(character) && character >= 1
                ? character - 1
                : 0
            )
          : undefined
      await vscode.window.showTextDocument(document, {
        viewColumn: this.column(place),
        preserveFocus: false,
        preview: true,
        ...(position === undefined ? {} : { selection: new vscode.Range(position, position) }),
      })
      return true
    } catch {
      this.options.log('editor.open.failed')
      return false
    }
  }

  async sendDiagnostic(): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showInformationMessage(this.options.messages.untrusted)
      return false
    }
    const editor = vscode.window.activeTextEditor
    if (editor === undefined || this.lastKind !== 'text') {
      void vscode.window.showInformationMessage(this.options.messages.diagnosticNoEditor)
      return false
    }
    const location = this.location(editor.document.uri)
    const result = projectDiagnostic(
      this.options.projects(),
      vscode.workspace.isTrusted,
      location,
      {
        filePath: location?.filePath ?? '',
        languageId: editor.document.languageId,
        provenance: location?.provenance ?? null,
        cursor: editor.selection.active,
        diagnostics: vscode.languages.getDiagnostics(editor.document.uri).map((diagnostic) => ({
          severity: severities[diagnostic.severity],
          message: diagnostic.message,
          ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
          ...(diagnostic.code === undefined
            ? {}
            : {
                code: String(
                  typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code
                ),
              }),
          range: diagnostic.range,
        })),
        linesOf: (start, end) => {
          const first = Math.min(Math.max(0, start), editor.document.lineCount - 1)
          const last = Math.min(Math.max(first, end - 1), editor.document.lineCount - 1)
          return editor.document.getText(
            new vscode.Range(first, 0, last, editor.document.lineAt(last).text.length)
          )
        },
      }
    )
    if (!result.ok) {
      const message = {
        untrusted: this.options.messages.untrusted,
        'unsupported-document': this.options.messages.diagnosticUnsupported,
        'outside-roots': this.options.messages.outsideProject,
        'no-diagnostic': this.options.messages.diagnosticNotFound,
      }[result.reason]
      void vscode.window.showInformationMessage(message)
      return false
    }
    try {
      await this.options.diagnostic(result.projectId, result.params)
      void vscode.window.showInformationMessage(this.options.messages.diagnosticSent)
      return true
    } catch {
      this.options.log('editor.diagnostic.failed')
      void vscode.window.showInformationMessage(this.options.messages.diagnosticFailed)
      return false
    }
  }

  async openMarkdownPreview(uri?: vscode.Uri): Promise<boolean> {
    const isMarkdown = (editor: vscode.TextEditor): boolean =>
      editor.document.languageId === 'markdown'
    const active = vscode.window.activeTextEditor
    const resource =
      uri ??
      (active !== undefined && isMarkdown(active) ? active : undefined)?.document.uri ??
      vscode.window.visibleTextEditors.find(isMarkdown)?.document.uri ??
      active?.document.uri
    if (resource === undefined) {
      void vscode.window.showInformationMessage(this.options.messages.previewUnsupported)
      return false
    }
    try {
      const opened = await this.previews.open(resource)
      if (!opened)
        void vscode.window.showInformationMessage(this.options.messages.previewUnsupported)
      return opened
    } catch {
      this.options.log('editor.preview.failed')
      void vscode.window.showInformationMessage(this.options.messages.previewFailed)
      return false
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    for (const disposable of this.disposables) disposable.dispose()
    this.diffs.dispose()
    this.previews.dispose()
    this.cache.clear()
  }
}
