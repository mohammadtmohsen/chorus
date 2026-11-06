import * as vscode from 'vscode'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import {
  ATTENTION_ROOMS_CHANNEL,
  AttentionRoom,
  WebviewMessage,
  SecretId,
  type Hello,
  type EngineActivity,
} from '../../engine/src/protocol.js'
import {
  ConversationNoteJournalRequest,
  ATTENTION_PUSH_CHANNEL,
  AttentionPush,
  EVENTS_PUSH_CHANNEL,
  REVEAL_PUSH_CHANNEL,
  IPC_CONTRACT,
} from '../../desktop/src/shared/ipc.js'
import { BROWSER_FRAME_CHANNEL } from '../../desktop/src/shared/browser-ipc.js'
import messages from '../../desktop/src/renderer/src/i18n/en.json'
import { EngineClient, type EngineState } from './engine-client.js'
import { AttentionCenter } from './attention.js'
import {
  SHELL_CHANNELS,
  ShellViewFocusMessage,
  type ShellHostMessage,
} from './shared/webview-protocol.js'
import { ShellMessageQueue } from './message-queue.js'
import { EditorIntegration, type EditorProject } from './editor/index.js'
import { containingProjects, deepestProject } from './editor/membership.js'
import {
  hostForAuthority,
  mapProjectRoot,
  normalizedPath,
  relativePath,
} from './editor/resources.js'
import { BrowserHost } from './browser/index.js'
import {
  EditorPlace,
  EditorEditRequest,
  EditorAskDiffRequest,
} from '../../engine/src/editor-protocol.js'
import { registerInlineCompletions } from './completion/index.js'
import { enableBrowserArguments } from './browser-arguments.js'

const TEXT = messages.extension
const SHELL_VIEW_ID = 'chorus.workspace'
const SHELL_FOCUS_CONTEXT = 'chorus.shellFocused'
const Adopted = IPC_CONTRACT['project:adopt'].response
const ObjectParams = z.record(z.string(), z.unknown())
const FileRequest = z.object({
  path: z.string(),
  line: z.number().nullable().optional(),
  column: z.number().nullable().optional(),
})

class ChorusShell implements vscode.Disposable, vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null
  private opened = false
  private readonly viewDisposables: vscode.Disposable[] = []
  private ready = false
  private readonly queue = new ShellMessageQueue()
  private readonly disposables: vscode.Disposable[] = []
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30)
  private readonly output = vscode.window.createOutputChannel('Chorus')
  private readonly client: EngineClient
  private projectIds: string[] = []
  private focusedProjectId: string | null = null
  private receivedFocus = false
  private readonly editorProjectRequests: string[] = []
  private pendingExplorerProjectId: string | null = null
  private explorerRevealVersion = 0
  private revealingExplorer = false
  private restoreEditorFocus = false
  private lastSeq = 0
  private needsReplay = false
  private warningShown = false
  private readonly adopted: { id: string; created: boolean }[] = []
  private readonly images: vscode.Uri
  private readonly engineDirectory: string
  private projects: EditorProject[] = []
  private readonly editor: EditorIntegration
  private browserHost: BrowserHost | null = null
  private refreshing: Promise<void> | null = null
  private readonly attention: AttentionCenter
  private attentionCount = 0
  private engineConnected = true

  constructor(
    private readonly context: vscode.ExtensionContext,
    secrets: Hello['secrets']
  ) {
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
      folder.uri.toString()
    )
    const workspaceKey = createHash('sha256')
      .update(
        vscode.workspace.workspaceFile?.toString() ??
          (workspaceFolders.join('\n') || 'empty-window')
      )
      .digest('hex')
    const clientId = randomUUID()
    const directory = join(context.globalStorageUri.fsPath, 'engine')
    this.engineDirectory = directory
    this.images = vscode.Uri.file(join(directory, 'note-images'))
    this.client = new EngineClient({
      dataDirectory: directory,
      engineMain: context.asAbsolutePath('dist/engine.cjs'),
      executable: process.execPath,
      clientId,
      workspaceKey,
      workspaceFolders,
      trusted: vscode.workspace.isTrusted,
      secrets,
    })
    this.client.setHostHandler((method, params) => this.hostCall(method, params))
    this.editor = new EditorIntegration({
      projects: () => this.projects,
      focusedProject: () => this.focusedProjectId,
      activate: (projectId) => {
        if (!this.opened) return
        this.explorerRevealVersion += 1
        this.pendingExplorerProjectId = null
        this.restoreEditorFocus = this.revealingExplorer
        if (this.editorProjectRequests.at(-1) === projectId) return
        this.post({ kind: 'showProject', projectId })
      },
      report: (report) => {
        this.client.notify({ kind: 'editorContext', report })
      },
      diagnostic: async (projectId, params) => {
        await this.client.request({ kind: 'diagnostic', projectId, params })
      },
      log: (message) => {
        this.output.appendLine(message)
      },
      messages: {
        ...TEXT.editor,
        previewTitle: (path) => TEXT.editor.previewTitle.replace('{{path}}', path),
      },
    })
    this.disposables.push(
      this.editor,
      registerInlineCompletions({
        insideProject: (uri) => {
          const location = this.editor.documentLocation(uri)
          return location !== null && containingProjects(this.projects, location).length > 0
        },
        relativePath: (uri) => {
          const location = this.editor.documentLocation(uri)
          if (location === null) return null
          const project = deepestProject(this.projects, location)
          return project === null ? null : relativePath(project, location)
        },
        configured: async () =>
          z
            .object({ configured: z.boolean() })
            .parse(await this.client.request({ kind: 'completionConfigured' })).configured,
        request: async (requestId, payload, signal) => {
          const cancel = (): void => {
            this.client.notify({ kind: 'completionCancel', requestId })
          }
          signal.addEventListener('abort', cancel, { once: true })
          try {
            if (signal.aborted) return { configured: true, text: null }
            return z
              .object({ configured: z.boolean(), text: z.string().nullable() })
              .parse(await this.client.request({ kind: 'completion', requestId, payload }))
          } finally {
            signal.removeEventListener('abort', cancel)
          }
        },
      })
    )
    this.disposables.push(
      {
        dispose: this.client.onPush((channel, payload) => {
          if (channel === ATTENTION_ROOMS_CHANNEL) {
            const rooms = z.array(AttentionRoom).safeParse(payload)
            if (rooms.success) this.attention.update(rooms.data)
            return
          }
          if (channel === ATTENTION_PUSH_CHANNEL) {
            const push = AttentionPush.safeParse(payload)
            if (push.success && push.data.mode === 'banner') {
              void this.attention.show(push.data)
              return
            }
          }
          if (channel === 'conversations:changed') void this.refreshProjects()
          if (channel === EVENTS_PUSH_CHANNEL && this.view?.visible !== true) {
            this.needsReplay = true
            return
          }
          this.post({ kind: 'push', channel, payload })
        }),
      },
      {
        dispose: this.client.onState((state, activity) => {
          this.engineState(state, activity)
          if (state === 'connected' || state === 'restart-required') {
            void this.refreshProjects()
              .then(() => this.getBrowser().restore())
              .catch((error: unknown) => {
                this.output.appendLine(String(error))
              })
          }
        }),
      }
    )
    this.status.command = 'chorus.open'
    this.status.text = '$(comment-discussion) Chorus'
    this.status.tooltip = TEXT.open
    this.status.show()
    this.setShellFocus(false)
    this.attention = new AttentionCenter({
      reveal: (room) => {
        this.revealConversation(room)
      },
      decideApproval: async (push, outcome, scope) => {
        await this.client.invoke('approval:decide', {
          conversationId: push.conversationId,
          agentId: push.agentId,
          approvalId: push.approvalId,
          outcome,
          scope,
        })
      },
      report: (message) => {
        this.output.appendLine(message)
      },
      onCount: (count) => {
        this.attentionCount = count
        this.paintStatus()
      },
    })
    this.disposables.push(
      this.attention,
      vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused) this.setShellFocus(false)
        this.focus()
      }),
      context.secrets.onDidChange(({ key }) => {
        void this.secretChanged(key)
      })
    )
  }

  private async secretChanged(key: string): Promise<void> {
    const id = SecretId.safeParse(key.replace(/^chorus\./, ''))
    if (!key.startsWith('chorus.') || !id.success) return
    const value = (await this.context.secrets.get(key)) ?? null
    this.client.options.secrets[id.data] = value
    this.client.notify({ kind: 'secret', secretId: id.data, value })
  }

  revealConversation(room: { readonly projectId: string; readonly conversationId: string }): void {
    this.open()
    this.post({
      kind: 'push',
      channel: REVEAL_PUSH_CHANNEL,
      payload: { projectId: room.projectId, conversationId: room.conversationId },
    })
  }

  private paintStatus(): void {
    const waiting = this.attentionCount === 0 ? '' : ` (${String(this.attentionCount)})`
    this.status.text = `${this.engineConnected ? '$(comment-discussion)' : '$(sync~spin)'} Chorus${waiting}`
  }

  async startIfUsed(): Promise<void> {
    if (!existsSync(this.engineDirectory)) return
    try {
      await this.client.connect()
    } catch (error) {
      this.failure(error)
    }
  }
  private getBrowser(): BrowserHost {
    this.browserHost ??= new BrowserHost({
      workspaceState: this.context.workspaceState,
      focusedProject: () => this.focusedProjectId,
      emit: (event) => {
        this.client.notify({ kind: 'browserEvent', event })
      },
      log: (message) => {
        this.output.appendLine(message)
      },
    })
    return this.browserHost
  }
  private refreshProjects(): Promise<void> {
    this.refreshing ??= this.client
      .invoke('project:list', {})
      .then((value) => {
        this.projects = IPC_CONTRACT['project:list'].response.parse(value).projects
        this.editor.reportAll()
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }
  async sendDiagnostic(): Promise<boolean> {
    await this.client.connect()
    await this.refreshProjects()
    return await this.editor.sendDiagnostic()
  }
  async openMarkdownPreview(uri?: vscode.Uri): Promise<boolean> {
    await this.client.connect()
    await this.refreshProjects()
    return await this.editor.openMarkdownPreview(uri)
  }

  open(): void {
    this.opened = true
    if (this.view !== null) {
      this.view.show(false)
      return
    }
    void vscode.commands.executeCommand(`${SHELL_VIEW_ID}.focus`).then(
      undefined,
      (error: unknown) => {
        this.failure(error)
      }
    )
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    for (const disposable of this.viewDisposables.splice(0)) disposable.dispose()
    mkdirSync(this.images.fsPath, { recursive: true, mode: 0o700 })
    this.view = view
    this.opened = true
    this.ready = false
    this.resetExplorerFocus()
    this.editorProjectRequests.length = 0
    this.setShellFocus(false)
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
        this.images,
      ],
    }
    view.webview.onDidReceiveMessage(
      (raw: unknown) => {
        void this.receive(raw, view)
      },
      undefined,
      this.viewDisposables
    )
    view.onDidDispose(
      () => {
        if (this.view !== view) return
        this.view = null
        this.ready = false
        this.resetExplorerFocus()
        this.editorProjectRequests.length = 0
        this.setShellFocus(false)
        this.needsReplay = true
        this.projectIds = []
        this.focusedProjectId = null
        for (const disposable of this.viewDisposables.splice(0)) disposable.dispose()
        this.focus()
        this.editor.focusChanged()
      },
      undefined,
      this.viewDisposables
    )
    view.onDidChangeVisibility(
      () => this.viewVisibilityChanged(view),
      undefined,
      this.viewDisposables
    )
    view.webview.html = this.html(view.webview)
    this.focus()
  }

  private setShellFocus(focused: boolean): void {
    void vscode.commands
      .executeCommand(
        'setContext',
        SHELL_FOCUS_CONTEXT,
        focused && this.view?.visible === true && vscode.window.state.focused
      )
      .then(undefined, (error: unknown) => {
        this.output.appendLine(String(error))
      })
  }

  private viewVisibilityChanged(view: vscode.WebviewView): void {
    if (this.view !== view) return
    this.focus()
    if (!view.visible) {
      this.setShellFocus(false)
      this.needsReplay = true
      return
    }
    this.flush()
    if (!this.ready || !this.needsReplay) return
    this.needsReplay = false
    void this.client.replay(this.lastSeq).catch((error: unknown) => {
      this.failure(error)
    })
  }

  private html(webview: vscode.Webview): string {
    const manifest = z
      .record(
        z.string(),
        z.object({
          file: z.string(),
          isEntry: z.boolean().optional(),
          css: z.array(z.string()).optional(),
        })
      )
      .parse(
        JSON.parse(
          readFileSync(this.context.asAbsolutePath('dist/webview/.vite/manifest.json'), 'utf8')
        )
      )
    const entry = Object.values(manifest).find((item) => item.isEntry === true)
    if (entry === undefined) throw new Error(TEXT.engineFailed)
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
    const uri = (path: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(base, path)).toString()
    const nonce = randomBytes(24).toString('base64')
    const styles = [
      ...new Set([
        ...(entry.css ?? []),
        ...Object.values(manifest)
          .filter((item) => item.file.endsWith('.css'))
          .map((item) => item.file),
      ]),
    ]
    const csp = `default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: https: blob:; font-src ${webview.cspSource};`
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1.0">${styles.map((path) => `<link rel="stylesheet" href="${uri(path)}">`).join('')}<style>html,body,#root{height:100%;width:100%;padding:0;margin:0}body{font-family:var(--ui-font)}#root>.empty{display:flex;flex-direction:column;justify-content:center;gap:16px;box-sizing:border-box;text-align:center}#root>.empty h1{margin:0}#root>.empty .primary{font:inherit;color:var(--text-primary);background:var(--bg-control);border:1px solid var(--border-strong);border-radius:4px;padding:6px 16px;cursor:pointer}.chorus-host-status{position:fixed;bottom:12px;left:72px;z-index:10000;max-width:calc(100% - 90px);padding:10px 14px;background:var(--surface-raised,#252525);color:var(--text,#eee);border:1px solid var(--border,#555);border-radius:8px}.chorus-host-status[hidden]{display:none}.chorus-host-status button{margin-left:12px}</style></head><body><div id="root"></div><script nonce="${nonce}" type="module" src="${uri(entry.file)}"></script></body></html>`
  }

  private async receive(raw: unknown, view: vscode.WebviewView): Promise<void> {
    if (this.view !== view) return
    const viewFocus = ShellViewFocusMessage.safeParse(raw)
    if (viewFocus.success) {
      this.setShellFocus(viewFocus.data.focused)
      return
    }
    const parsed = WebviewMessage.safeParse(raw)
    if (!parsed.success) {
      const unread = z.object({ id: z.string() }).safeParse(raw)
      if (unread.success)
        this.post({ kind: 'answer', id: unread.data.id, ok: false, error: TEXT.requestInvalid })
      return
    }
    const message = parsed.data
    if (message.kind === 'enableBrowser') {
      await this.enableBrowserTools()
      return
    }
    if (message.kind === 'restart') {
      await this.restart()
      return
    }
    if (message.kind === 'ready') {
      this.resetExplorerFocus()
      try {
        const welcome = await this.client.connect()
        await this.refreshProjects()
        if (this.view !== view) return
        this.ready = true
        this.post({
          kind: 'boot',
          storage: welcome.storage,
          imageBase: view.webview.asWebviewUri(this.images).toString(),
        })
        this.viewVisibilityChanged(view)
        for (const project of this.adopted.splice(0)) this.post({ kind: 'projectAdopted', project })
      } catch (error) {
        this.failure(error)
      }
      return
    }
    if (message.kind === 'focus') {
      const previous = this.focusedProjectId
      const projectsChanged = JSON.stringify(this.projectIds) !== JSON.stringify(message.projectIds)
      this.projectIds = message.projectIds
      this.focusedProjectId =
        message.focusedProjectId !== null && message.projectIds.includes(message.focusedProjectId)
          ? message.focusedProjectId
          : null
      const initial = !this.receivedFocus
      this.receivedFocus = true
      const changed = previous !== this.focusedProjectId
      const editorRequest =
        this.focusedProjectId === null
          ? -1
          : this.editorProjectRequests.indexOf(this.focusedProjectId)
      if (editorRequest >= 0) this.editorProjectRequests.splice(0, editorRequest + 1)
      else if (changed && !initial) this.editorProjectRequests.length = 0
      if (changed) {
        if (editorRequest < 0 && !initial) this.restoreEditorFocus = false
        this.explorerRevealVersion += 1
        this.pendingExplorerProjectId = null
        if (!initial && editorRequest < 0 && this.focusedProjectId !== null) {
          this.pendingExplorerProjectId = this.focusedProjectId
          void this.revealExplorer().catch((error: unknown) => {
            this.output.appendLine(String(error))
          })
        }
      }
      if (projectsChanged || changed) this.editor.focusChanged()
      this.lastSeq = Math.max(this.lastSeq, message.lastSeq)
      this.focus()
      return
    }
    try {
      let value: unknown
      if (message.kind === 'dropFiles') {
        const paths: string[] = []
        for (const rawUri of message.uris) {
          const uri = vscode.Uri.parse(rawUri)
          if (uri.scheme === 'file') paths.push(uri.fsPath)
          else if (uri.scheme === 'vscode-remote') {
            const bytes = await vscode.workspace.fs.readFile(uri)
            const stashed = IPC_CONTRACT['files:stash'].response.parse(
              await this.client.invoke('files:stash', {
                name: uri.path.split('/').at(-1) ?? '',
                base64: Buffer.from(bytes).toString('base64'),
              })
            )
            paths.push(stashed.path)
          }
        }
        value = { paths }
      } else if (message.kind === 'invoke') {
        if (!SHELL_CHANNELS.has(message.channel)) throw new Error(TEXT.channelRefused)
        value =
          message.channel === 'project:adopt'
            ? await this.adoptFolder()
            : await this.client.invoke(message.channel, message.request, message.id)
        if (message.channel.startsWith('project:') || message.channel === 'conversation:restore')
          await this.refreshProjects()
      } else if (message.kind === 'journal') {
        value = await this.client.request(
          { kind: 'journal', request: ConversationNoteJournalRequest.parse(message.request) },
          message.id
        )
      } else value = await this.client.request(message, message.id)
      this.post({ kind: 'answer', id: message.id, ok: true, value })
    } catch (error) {
      this.post({
        kind: 'answer',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : TEXT.engineFailed,
      })
    }
  }

  private resetExplorerFocus(): void {
    this.receivedFocus = false
    this.restoreEditorFocus = false
    this.explorerRevealVersion += 1
    this.pendingExplorerProjectId = null
  }

  private async revealExplorer(): Promise<void> {
    if (this.revealingExplorer) return
    this.revealingExplorer = true
    try {
      while (this.pendingExplorerProjectId !== null) {
        const projectId = this.pendingExplorerProjectId
        const version = this.explorerRevealVersion
        const view = this.view
        this.pendingExplorerProjectId = null
        if (view === null) continue
        const project = this.projects.find((candidate) => candidate.id === projectId)
        if (project === undefined) continue
        const mapped = mapProjectRoot(
          project,
          (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)
        )
        if (mapped === null) continue
        const uri = vscode.Uri.from(mapped)
        if (vscode.workspace.getWorkspaceFolder(uri) === undefined) continue
        try {
          await vscode.commands.executeCommand('revealInExplorer', uri)
        } catch (error) {
          this.output.appendLine(String(error))
        }
        if (
          version === this.explorerRevealVersion &&
          this.view === view &&
          this.focusedProjectId === projectId
        )
          view.show(false)
        else if (this.restoreEditorFocus) {
          this.restoreEditorFocus = false
          const editor = vscode.window.activeTextEditor
          if (editor !== undefined) {
            try {
              await vscode.window.showTextDocument(editor.document, editor.viewColumn, false)
            } catch (error) {
              this.output.appendLine(String(error))
            }
          }
        }
      }
    } finally {
      this.revealingExplorer = false
    }
  }

  async enableBrowserTools(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments')
      const document = vscode.window.activeTextEditor?.document
      if (!document?.uri.path.endsWith('/argv.json')) throw new Error('runtime-arguments-not-open')
      const current = document.getText()
      const next = enableBrowserArguments(current)
      if (next !== current) {
        const edit = new vscode.WorkspaceEdit()
        edit.replace(
          document.uri,
          new vscode.Range(document.positionAt(0), document.positionAt(current.length)),
          next
        )
        if (!(await vscode.workspace.applyEdit(edit)) || !(await document.save()))
          throw new Error('runtime-arguments-not-saved')
      }
      void vscode.window.showInformationMessage(TEXT.browserEnabled)
    } catch (error) {
      this.output.appendLine(String(error))
      void vscode.window.showErrorMessage(TEXT.browserArgumentsFailed)
    }
  }

  private post(message: ShellHostMessage): void {
    if (!this.opened) return
    const view = this.view
    if (view === null || !this.ready || !view.visible) {
      if (message.kind === 'push' && message.channel === BROWSER_FRAME_CHANNEL) return
      this.queue.add(message)
      return
    }
    if (
      message.kind === 'showProject' &&
      this.editorProjectRequests.at(-1) !== message.projectId
    )
      this.editorProjectRequests.push(message.projectId)
    void view.webview.postMessage(message)
  }
  private flush(): void {
    if (!this.ready || this.view?.visible !== true) return
    if (this.queue.recover) {
      this.queue.clear()
      this.ready = false
      this.resetExplorerFocus()
      this.editorProjectRequests.length = 0
      this.setShellFocus(false)
      this.view.webview.html = this.html(this.view.webview)
      return
    }
    for (const message of this.queue.take()) this.post(message)
  }
  private focus(): void {
    this.client.focus(
      vscode.window.state.focused,
      this.projectIds,
      this.lastSeq,
      this.focusedProjectId,
      vscode.window.state.focused && this.view?.visible === true,
      this.view?.visible === true
    )
  }

  private engineState(state: EngineState, activity?: EngineActivity): void {
    this.post({ kind: 'state', state, ...(activity === undefined ? {} : { activity }) })
    this.engineConnected = state === 'connected'
    this.paintStatus()
    this.status.tooltip =
      state === 'restart-required'
        ? TEXT.engineRestartRequired
        : state === 'stopped'
          ? TEXT.engineStopped
          : TEXT.open
    if ((state === 'stopped' || state === 'reconnecting') && !this.warningShown) {
      this.warningShown = true
      void vscode.window.showWarningMessage(TEXT.engineStopped, TEXT.restart).then((choice) => {
        if (choice === TEXT.restart) void this.restart()
      })
    }
    if (state === 'connected') this.warningShown = false
  }
  private failure(error: unknown): void {
    this.output.appendLine(
      error instanceof Error ? (error.stack ?? error.message) : TEXT.engineFailed
    )
    this.post({ kind: 'state', state: 'stopped' })
    void vscode.window.showErrorMessage(TEXT.engineFailed, TEXT.retry).then((choice) => {
      if (choice === TEXT.retry)
        void this.client.connect().catch((next: unknown) => {
          this.output.appendLine(String(next))
        })
    })
  }
  async restart(): Promise<void> {
    try {
      if (!(await this.client.restartWhenIdle())) {
        void vscode.window.showInformationMessage(TEXT.engineRestartRequired)
        return
      }
      void vscode.window.showInformationMessage(TEXT.engineRestartReady)
    } catch (error) {
      this.failure(error)
    }
  }
  private async adoptFolder(uri?: vscode.Uri) {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage(TEXT.untrusted)
      return { project: null }
    }
    let folder = uri
    folder ??= (
      await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title: TEXT.chooseProject,
        openLabel: TEXT.addProject,
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()),
      })
    )?.[0]
    if (folder === undefined) return { project: null }
    let result: z.infer<typeof Adopted>
    if (folder.scheme === 'file')
      result = Adopted.parse(
        await this.client.request({ kind: 'adoptFolder', path: folder.fsPath })
      )
    else if (folder.scheme === 'vscode-remote') {
      const host = hostForAuthority(folder.authority)
      if (host === null) throw new Error(TEXT.editor.previewUnsupported)
      result = IPC_CONTRACT['project:adoptRemote'].response.parse(
        await this.client.invoke('project:adoptRemote', { host, root: normalizedPath(folder.path) })
      )
    } else throw new Error(TEXT.editor.previewUnsupported)
    await this.refreshProjects()
    if (result.project !== null) await this.openRepository(folder)
    return result
  }
  async addProject(uri?: vscode.Uri): Promise<void> {
    const result = await this.adoptFolder(uri)
    if (result.project === null) return
    this.open()
    const project = { id: result.project.id, created: result.project.created }
    if (this.ready) this.post({ kind: 'projectAdopted', project })
    else this.adopted.push(project)
  }
  private async openRepository(root: vscode.Uri): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        'git.openRepository',
        root.scheme === 'file' ? root.fsPath : normalizedPath(root.path)
      )
    } catch {
      return
    }
  }

  private async hostCall(method: string, raw: unknown): Promise<unknown> {
    const params = ObjectParams.parse(raw)
    if (method === 'editor.snapshot')
      return await this.editor.snapshot(EditorPlace.parse(params['place']))
    if (method === 'editor.edit')
      return await this.editor.edit(
        EditorPlace.parse(params['place']),
        EditorEditRequest.parse(params['request'])
      )
    if (method === 'editor.previewEdit')
      return await this.editor.previewEdit(
        EditorPlace.parse(params['place']),
        EditorEditRequest.extend({ approvalId: z.string() }).parse(params['request'])
      )
    if (method === 'editor.askDiff') {
      const { close, revealPath, ...request } = EditorAskDiffRequest.parse(params['request'])
      return await this.editor.askDiff(EditorPlace.parse(params['place']), {
        ...request,
        ...(close === undefined ? {} : { close }),
        ...(revealPath === undefined ? {} : { revealPath }),
      })
    }
    if (method === 'browser.available') return this.getBrowser().available
    if (method.startsWith('browser.')) {
      const browser = this.getBrowser()
      if (method === 'browser.open') {
        const request = z
          .object({
            projectId: z.string().nullable(),
            url: z.string(),
            browserId: z.string().optional(),
          })
          .parse(params)
        return await browser.open(request.projectId, request.url, request.browserId)
      }
      const tabId = z.string().parse(params['tabId'])
      if (method === 'browser.navigate')
        return await browser.navigate(tabId, z.string().parse(params['url']))
      if (method === 'browser.close') return await browser.close(tabId)
      if (method === 'browser.focus') return await browser.focus(tabId)
      if (method === 'browser.action')
        return await browser.action(
          tabId,
          z.enum(['back', 'forward', 'reload', 'stop']).parse(params['action'])
        )
      if (method === 'browser.cdp')
        return await browser.cdp(
          tabId,
          z.string().parse(params['method']),
          z.record(z.string(), z.unknown()).parse(params['params'])
        )
    }
    switch (method) {
      case 'secret': {
        const { id, value } = z.object({ id: SecretId, value: z.string().nullable() }).parse(params)
        if (value === null) await this.context.secrets.delete(`chorus.${id}`)
        else await this.context.secrets.store(`chorus.${id}`, value)
        this.client.options.secrets[id] = value
        return true
      }
      case 'pickDirectory': {
        const { title } = z.object({ title: z.string() }).parse(params)
        return (
          (
            await vscode.window.showOpenDialog({
              title,
              defaultUri:
                vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file')
                  ?.uri ?? vscode.Uri.file(homedir()),
              canSelectFolders: true,
              canSelectFiles: false,
              canSelectMany: false,
            })
          )?.find((uri) => uri.scheme === 'file')?.fsPath ?? null
        )
      }
      case 'pickFiles': {
        const { title } = z.object({ title: z.string() }).parse(params)
        return (
          (
            await vscode.window.showOpenDialog({
              title,
              canSelectFolders: false,
              defaultUri:
                vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file')
                  ?.uri ?? vscode.Uri.file(homedir()),
              canSelectFiles: true,
              canSelectMany: true,
            })
          )?.map((uri) => uri.fsPath) ?? []
        )
      }
      case 'clipboard':
        await vscode.env.clipboard.writeText(z.string().parse(params['text']))
        return true
      case 'openExternal':
        return await vscode.env.openExternal(vscode.Uri.parse(z.string().parse(params['url'])))
      case 'revealInFolder':
        await vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(z.string().parse(params['path']))
        )
        return true
      case 'reveal':
        this.open()
        return true
      case 'attention':
        return true
      case 'notify': {
        const notice = z.object({ title: z.string(), body: z.string() }).parse(params)
        void vscode.window.showInformationMessage(`${notice.title}: ${notice.body}`)
        return true
      }
      case 'openFile': {
        const { line, column, place, ...request } = FileRequest.extend({
          place: EditorPlace.optional(),
        }).parse(params)
        return await this.editor.openFile({
          ...request,
          ...(line === undefined ? {} : { line }),
          ...(column === undefined ? {} : { column }),
          ...(place === undefined ? {} : { place }),
        })
      }
      default:
        throw new Error(TEXT.channelRefused)
    }
  }

  dispose(): void {
    this.setShellFocus(false)
    this.opened = false
    this.view = null
    this.ready = false
    this.resetExplorerFocus()
    this.queue.clear()
    this.browserHost?.dispose()
    this.client.dispose()
    for (const disposable of this.viewDisposables.splice(0)) disposable.dispose()
    for (const disposable of this.disposables) disposable.dispose()
    this.status.dispose()
    this.output.dispose()
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const secrets = Object.fromEntries(
    await Promise.all(
      SecretId.options.map(
        async (id) => [id, (await context.secrets.get(`chorus.${id}`)) ?? null] as const
      )
    )
  ) as Hello['secrets']
  const shell = new ChorusShell(context, secrets)
  context.subscriptions.push(
    shell,
    vscode.window.registerWebviewViewProvider(SHELL_VIEW_ID, shell, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('chorus.open', () => {
      shell.open()
    }),
    vscode.commands.registerCommand('chorus.addProject', (uri?: vscode.Uri) =>
      shell.addProject(uri)
    ),
    vscode.commands.registerCommand('chorus.restart', () => shell.restart()),
    vscode.commands.registerCommand(
      'chorus.revealConversation',
      (room: { readonly projectId: string; readonly conversationId: string }) => {
        shell.revealConversation(room)
      }
    ),
    vscode.commands.registerCommand('chorus.enableBrowserTools', () => shell.enableBrowserTools()),
    vscode.commands.registerCommand('chorus.sendDiagnostic', () => shell.sendDiagnostic()),
    vscode.commands.registerCommand('chorus.markdownPreview', (uri?: vscode.Uri) =>
      shell.openMarkdownPreview(uri)
    ),
    vscode.languages.registerCodeActionsProvider(
      [{ scheme: 'file' }, { scheme: 'vscode-remote' }],
      {
        provideCodeActions(_document, _range, actionContext) {
          return actionContext.diagnostics.length === 0
            ? []
            : [{ title: TEXT.editor.sendDiagnostic, command: 'chorus.sendDiagnostic' }]
        },
      }
    ),
    vscode.commands.registerCommand('chorus.shellKey', () => undefined),
    vscode.window.registerWebviewPanelSerializer('chorus.shell', {
      deserializeWebviewPanel(panel) {
        panel.dispose()
        shell.open()
        return Promise.resolve()
      },
    })
  )
  void shell.startIfUsed()
}
