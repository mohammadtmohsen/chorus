import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import type { WorkbenchPlace } from '../../../desktop/src/main/project-root.js'
import type {
  WorkbenchAskDiffRequest,
  WorkbenchAskDiffResult,
} from '../../../desktop/src/shared/workbench-ipc.js'
import { normalizedPath, samePlace } from './resources.js'

interface DiffOptions {
  readonly focused: (place: WorkbenchPlace) => boolean
  readonly available: (place: WorkbenchPlace) => boolean
  readonly resource: (place: WorkbenchPlace, path: string) => vscode.Uri | null
  readonly column: (place: WorkbenchPlace) => vscode.ViewColumn
  readonly failed: string
  readonly log: (message: string) => void
}

interface Proposal {
  readonly place: WorkbenchPlace
  readonly approvalId: string
  readonly original: vscode.Uri
  readonly proposed: vscode.Uri
  request: WorkbenchAskDiffRequest
  column: vscode.ViewColumn | undefined
  shown: boolean
}

export class AskDiffController implements vscode.Disposable {
  private readonly instance = randomUUID()
  private readonly contents = new Map<string, string>()
  private readonly proposals = new Map<string, Proposal>()
  private readonly settled = new Set<string>()
  private readonly reveals = new Map<
    string,
    { place: WorkbenchPlace; path: string; column: vscode.ViewColumn | undefined }
  >()
  private readonly changes = new vscode.EventEmitter<vscode.Uri>()
  private readonly provider: vscode.Disposable
  private sequence: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly options: DiffOptions) {
    this.provider = vscode.workspace.registerTextDocumentContentProvider('chorus-ask', {
      onDidChange: this.changes.event,
      provideTextDocumentContent: (uri) => this.contents.get(uri.toString()) ?? '',
    })
  }

  private key(place: WorkbenchPlace, approvalId = ''): string {
    return JSON.stringify([place.host, normalizedPath(place.root), approvalId])
  }

  private stopped(): boolean {
    return this.disposed
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sequence.then(operation)
    this.sequence = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  request(
    place: WorkbenchPlace,
    request: WorkbenchAskDiffRequest
  ): Promise<WorkbenchAskDiffResult> {
    return this.enqueue(async () => {
      if (this.disposed || !this.options.available(place))
        return { requestId: request.requestId, ok: false, message: this.options.failed }
      try {
        const key = this.key(place, request.approvalId)
        const held = this.proposals.get(key)
        if (request.close === true) {
          this.settled.add(key)
          if (this.settled.size > 4096) {
            const first = this.settled.values().next().value
            if (first !== undefined) this.settled.delete(first)
          }
          this.proposals.delete(key)
          if (held !== undefined) {
            const tabs = this.tabsFor(held)
            if (tabs.length > 0 && !(await vscode.window.tabGroups.close(tabs, true))) {
              this.proposals.set(key, held)
              return { requestId: request.requestId, ok: false, message: this.options.failed }
            }
            this.contents.delete(held.original.toString())
            this.contents.delete(held.proposed.toString())
          }
          if (request.revealPath !== undefined) {
            this.reveals.set(this.key(place), {
              place,
              path: request.revealPath,
              column: held?.column,
            })
          }
        } else {
          if (this.settled.has(key)) return { requestId: request.requestId, ok: true }
          let proposal = held
          if (proposal === undefined) {
            const id = randomUUID()
            const leaf = request.path.split(/[\\/]/).at(-1) ?? ''
            const uri = (side: string): vscode.Uri =>
              vscode.Uri.from({
                scheme: 'chorus-ask',
                authority: this.instance,
                path: `/${id}/${side}/${leaf}`,
              })
            proposal = {
              place,
              approvalId: request.approvalId,
              original: uri('original'),
              proposed: uri('proposed'),
              request,
              column: undefined,
              shown: false,
            }
            this.proposals.set(key, proposal)
          }
          proposal.request = request
          this.contents.set(proposal.original.toString(), request.before ?? '')
          this.contents.set(proposal.proposed.toString(), request.proposed)
          this.changes.fire(proposal.original)
          this.changes.fire(proposal.proposed)
        }
        await this.flush()
        return { requestId: request.requestId, ok: true }
      } catch {
        this.options.log('editor.diff.failed')
        return { requestId: request.requestId, ok: false, message: this.options.failed }
      }
    })
  }

  private tabsFor(proposal: Proposal): vscode.Tab[] {
    const original = proposal.original.toString()
    const proposed = proposal.proposed.toString()
    return vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter((tab) => {
        const input = tab.input
        if (input instanceof vscode.TabInputTextDiff)
          return input.original.toString() === original && input.modified.toString() === proposed
        return (
          input instanceof vscode.TabInputText &&
          (input.uri.toString() === original || input.uri.toString() === proposed)
        )
      })
    )
  }

  private async flush(): Promise<void> {
    if (this.disposed) return
    for (const [key, reveal] of this.reveals) {
      if (!this.options.focused(reveal.place)) continue
      const uri = this.options.resource(reveal.place, reveal.path)
      if (uri === null) {
        this.reveals.delete(key)
        continue
      }
      await vscode.window.showTextDocument(uri, {
        viewColumn: reveal.column ?? this.options.column(reveal.place),
        preserveFocus: true,
        preview: true,
      })
      this.reveals.delete(key)
    }
    const proposal = [...this.proposals.values()].find((item) => this.options.focused(item.place))
    if (proposal === undefined || proposal.shown || !this.options.available(proposal.place)) return
    proposal.column = this.options.column(proposal.place)
    await vscode.commands.executeCommand(
      'vscode.diff',
      proposal.original,
      proposal.proposed,
      `[claude] ${proposal.request.path}`,
      { viewColumn: proposal.column, preserveFocus: true, preview: true }
    )
    const tabs = this.tabsFor(proposal)
    if (
      this.stopped() ||
      !this.options.focused(proposal.place) ||
      this.proposals.get(this.key(proposal.place, proposal.approvalId)) !== proposal
    ) {
      if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true)
      return
    }
    proposal.column = tabs[0]?.group.viewColumn ?? proposal.column
    proposal.shown = true
  }

  focusChanged(): void {
    void this.enqueue(() => this.flush()).catch(() => {
      this.options.log('editor.diff.focus-failed')
    })
  }

  removeMissingProjects(places: readonly WorkbenchPlace[]): void {
    for (const proposal of this.proposals.values()) {
      if (places.some((place) => samePlace(place, proposal.place))) continue
      this.proposals.delete(this.key(proposal.place, proposal.approvalId))
      const tabs = this.tabsFor(proposal)
      if (tabs.length > 0)
        void vscode.window.tabGroups.close(tabs, true).then(undefined, () => {
          this.options.log('editor.diff.close-failed')
        })
      this.contents.delete(proposal.original.toString())
      this.contents.delete(proposal.proposed.toString())
    }
    for (const [key, reveal] of this.reveals) {
      if (!places.some((place) => samePlace(place, reveal.place))) this.reveals.delete(key)
    }
  }

  dispose(): void {
    this.disposed = true
    const tabs = [...this.proposals.values()].flatMap((proposal) => this.tabsFor(proposal))
    if (tabs.length > 0)
      void vscode.window.tabGroups.close(tabs, true).then(undefined, () => {
        this.options.log('editor.diff.close-failed')
      })
    this.proposals.clear()
    this.settled.clear()
    this.reveals.clear()
    this.contents.clear()
    this.provider.dispose()
    this.changes.dispose()
  }
}
