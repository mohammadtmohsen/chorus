import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import { READ_PREVIEW_SELECTION } from '../../../desktop/src/main/preview-selection.js'
import { PreviewSelection } from '../../../desktop/src/shared/workbench-ipc.js'

export interface PreviewCapture {
  readonly document: vscode.TextDocument
  readonly selection: PreviewSelection
}

interface PreviewOptions {
  readonly accepts: (uri: vscode.Uri) => boolean
  readonly title: (path: string) => string
  readonly changed: (capture: PreviewCapture | null) => void
  readonly log: (message: string) => void
}

interface PreviewRecord {
  readonly document: vscode.TextDocument
  readonly panel: vscode.WebviewPanel
  readonly disposables: vscode.Disposable[]
  readonly pending: Map<string, (capture: PreviewCapture | null) => void>
  generation: number
  renderedVersion: number
  latest: PreviewCapture | null
  ready: Promise<void>
  disposed: boolean
}

const attribute = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&#39;'
      default:
        return character
    }
  })

const literal = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

export class MarkdownPreviews implements vscode.Disposable {
  private readonly records = new Map<string, PreviewRecord>()
  private last: PreviewRecord | null = null
  private readonly changes: vscode.Disposable

  constructor(private readonly options: PreviewOptions) {
    this.changes = vscode.workspace.onDidChangeTextDocument(({ document }) => {
      const record = this.records.get(document.uri.toString())
      if (record !== undefined)
        void this.refresh(record).catch(() => {
          this.options.log('editor.preview.render-failed')
        })
    })
  }

  active(): boolean {
    return this.last?.panel.active === true
  }

  current(): PreviewCapture | null {
    const held = this.last
    return held !== null &&
      !held.disposed &&
      held.renderedVersion === held.document.version &&
      this.options.accepts(held.document.uri)
      ? held.latest
      : null
  }

  async open(uri: vscode.Uri): Promise<boolean> {
    if (!this.options.accepts(uri)) return false
    const document = await vscode.workspace.openTextDocument(uri)
    if (document.languageId !== 'markdown') return false
    let record = this.records.get(uri.toString())
    if (record === undefined) {
      const panel = vscode.window.createWebviewPanel(
        'chorus.markdownPreview',
        this.options.title(uri.path.split('/').at(-1) ?? uri.path),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        {
          enableScripts: true,
          enableCommandUris: false,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(uri, '..')],
        }
      )
      record = {
        document,
        panel,
        disposables: [],
        pending: new Map(),
        generation: 0,
        renderedVersion: -1,
        latest: null,
        ready: Promise.resolve(),
        disposed: false,
      }
      const owned = record
      record.disposables.push(
        panel.webview.onDidReceiveMessage((message: unknown) => {
          this.receive(owned, message)
        }),
        panel.onDidChangeViewState(({ webviewPanel }) => {
          if (!webviewPanel.active) return
          this.last = owned
          this.options.changed(this.current())
        }),
        panel.onDidDispose(() => {
          this.release(owned)
        })
      )
      this.records.set(uri.toString(), record)
    } else {
      record.panel.reveal(undefined, false)
    }
    this.last = record
    await this.refresh(record)
    this.options.changed(this.current())
    return true
  }

  private refresh(record: PreviewRecord): Promise<void> {
    record.generation += 1
    record.latest = null
    const generation = record.generation
    const version = record.document.version
    for (const resolve of record.pending.values()) resolve(null)
    record.pending.clear()
    if (this.last === record) this.options.changed(null)
    record.ready = this.render(record, generation, version)
    return record.ready
  }

  private async render(record: PreviewRecord, generation: number, version: number): Promise<void> {
    const disposed = (): boolean => record.disposed
    if (disposed() || !this.options.accepts(record.document.uri)) return
    await vscode.extensions.getExtension('vscode.markdown-language-features')?.activate()
    const rendered = await vscode.commands.executeCommand('markdown.api.render', record.document)
    if (
      typeof rendered !== 'string' ||
      disposed() ||
      record.generation !== generation ||
      record.document.version !== version ||
      !this.options.accepts(record.document.uri)
    )
      return
    const nonce = randomUUID()
    const source = record.document.uri.toString()
    const webview = record.panel.webview
    const base =
      webview.asWebviewUri(vscode.Uri.joinPath(record.document.uri, '..')).toString() + '/'
    const child = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline' ${attribute(webview.cspSource)}; img-src https: data: ${attribute(webview.cspSource)}; font-src ${attribute(webview.cspSource)};"><base href="${attribute(base)}"><style nonce="${nonce}">body{font-family:var(--vscode-font-family,system-ui);color:var(--vscode-editor-foreground);padding:20px;line-height:1.6}a{color:var(--vscode-textLink-foreground)}code{font-family:var(--vscode-editor-font-family,monospace);background:var(--vscode-textCodeBlock-background);padding:1px 3px;border-radius:3px}pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:4px}pre code{background:none;padding:0}blockquote{margin:0;padding-left:12px;border-left:3px solid var(--vscode-textBlockQuote-border)}img{max-width:100%}table{border-collapse:collapse}td,th{padding:4px 8px;border:1px solid var(--vscode-panel-border,#888)}</style></head><body><div id="vscode-markdown-preview-data" data-settings="${attribute(JSON.stringify({ source }))}"></div>${rendered}<span class="code-line" data-line="${String(record.document.lineCount)}"></span></body></html>`
    webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src https: data: ${attribute(webview.cspSource)}; font-src ${attribute(webview.cspSource)}; frame-src 'self';"><style nonce="${nonce}">html,body,iframe{border:0;margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block}</style></head><body><iframe id="active-frame" sandbox="allow-same-origin"></iframe><script nonce="${nonce}">
const vscode = acquireVsCodeApi()
const generation = ${String(generation)}
const frame = document.getElementById('active-frame')
const read = () => ${READ_PREVIEW_SELECTION}
const send = (id) => vscode.postMessage({kind:'preview-selection',generation,id,selection:read()})
const copyTheme = () => {
  const doc = frame.contentDocument
  if (!doc || !doc.body) return
  doc.documentElement.style.cssText = document.documentElement.style.cssText
  doc.body.className = document.body.className
}
new MutationObserver(copyTheme).observe(document.documentElement,{attributes:true,attributeFilter:['style']})
new MutationObserver(copyTheme).observe(document.body,{attributes:true,attributeFilter:['class']})
frame.addEventListener('load', () => {
  const doc = frame.contentDocument
  if (!doc) return
  copyTheme()
  let scheduled = false
  const changed = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => { scheduled = false; send(null) })
  }
  doc.addEventListener('selectionchange', changed)
  doc.addEventListener('pointerup', changed)
  doc.addEventListener('keyup', changed)
  doc.addEventListener('scroll', changed, true)
  send(null)
})
window.addEventListener('message', ({data}) => {
  if (data?.kind === 'preview-snapshot' && data.generation === generation && typeof data.id === 'string') send(data.id)
})
window.addEventListener('blur', () => send(null))
frame.srcdoc = ${literal(child)}
</script></body></html>`
    record.renderedVersion = version
  }

  private receive(record: PreviewRecord, raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const value = raw as Record<string, unknown>
    if (
      record.disposed ||
      value['kind'] !== 'preview-selection' ||
      value['generation'] !== record.generation ||
      record.document.version !== record.renderedVersion ||
      !this.options.accepts(record.document.uri)
    )
      return
    const parsed = PreviewSelection.safeParse(value['selection'])
    if (
      !parsed.success ||
      parsed.data.source !== record.document.uri.toString() ||
      parsed.data.endLine < parsed.data.startLine ||
      parsed.data.endLine > record.document.lineCount
    )
      return
    const capture: PreviewCapture = { document: record.document, selection: parsed.data }
    record.latest = capture
    const id = value['id']
    if (typeof id === 'string') {
      record.pending.get(id)?.(capture)
      record.pending.delete(id)
    }
    if (this.last === record) this.options.changed(capture)
  }

  async read(): Promise<PreviewCapture | null> {
    const record = this.last
    const disposed = (): boolean => record?.disposed !== false
    if (record === null || disposed() || !this.options.accepts(record.document.uri)) return null
    await record.ready
    if (record !== this.last || disposed()) return null
    const generation = record.generation
    return await new Promise((resolve) => {
      const id = randomUUID()
      const finish = (capture: PreviewCapture | null): void => {
        clearTimeout(timer)
        record.pending.delete(id)
        resolve(record === this.last && record.generation === generation ? capture : null)
      }
      const timer = setTimeout(() => {
        finish(this.current())
      }, 750)
      record.pending.set(id, finish)
      void record.panel.webview.postMessage({ kind: 'preview-snapshot', id, generation }).then(
        (sent) => {
          if (!sent) finish(this.current())
        },
        () => {
          finish(this.current())
        }
      )
    })
  }

  private release(record: PreviewRecord): void {
    if (record.disposed) return
    record.disposed = true
    for (const resolve of record.pending.values()) resolve(null)
    record.pending.clear()
    this.records.delete(record.document.uri.toString())
    if (this.last === record) {
      this.last = null
      this.options.changed(null)
    }
    for (const disposable of record.disposables) disposable.dispose()
  }

  dispose(): void {
    this.changes.dispose()
    for (const record of this.records.values()) {
      this.release(record)
      record.panel.dispose()
    }
  }
}
