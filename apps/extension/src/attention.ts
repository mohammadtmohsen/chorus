import * as vscode from 'vscode'
import type { AttentionPush } from '../../desktop/src/shared/ipc.js'
import { attentionChoices, attentionHeadline, roomDescription } from './attention-text.js'
import messages from '../../desktop/src/renderer/src/i18n/en.json'
import type { AttentionRoom } from '../../engine/src/protocol.js'

const TEXT = messages.extension.attention

export interface AttentionOptions {
  readonly reveal: (room: { readonly projectId: string; readonly conversationId: string }) => void
  readonly decideApproval: (
    push: Extract<AttentionPush, { reason: 'approval' }>,
    outcome: 'allow' | 'deny',
    scope: 'once' | 'session'
  ) => Promise<void>
  readonly report: (message: string) => void
  readonly onCount: (count: number) => void
}

export class AttentionCenter implements vscode.Disposable, vscode.TreeDataProvider<AttentionRoom> {
  private rooms: readonly AttentionRoom[] = []
  private readonly changed = new vscode.EventEmitter<AttentionRoom | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  private readonly view: vscode.TreeView<AttentionRoom>

  constructor(private readonly options: AttentionOptions) {
    this.view = vscode.window.createTreeView('chorus.attention', { treeDataProvider: this })
  }

  update(rooms: readonly AttentionRoom[]): void {
    this.rooms = rooms
    this.changed.fire(undefined)
    this.view.badge =
      rooms.length === 0 ? undefined : { value: rooms.length, tooltip: TEXT.badgeTooltip }
    this.options.onCount(rooms.length)
  }

  getTreeItem(room: AttentionRoom): vscode.TreeItem {
    const item = new vscode.TreeItem(room.title, vscode.TreeItemCollapsibleState.None)
    item.description = roomDescription(room)
    item.iconPath = new vscode.ThemeIcon('comment-unresolved')
    item.command = {
      command: 'chorus.revealConversation',
      title: messages.notify.open,
      arguments: [{ projectId: room.projectId, conversationId: room.conversationId }],
    }
    return item
  }

  getChildren(element?: AttentionRoom): AttentionRoom[] {
    return element === undefined ? [...this.rooms] : []
  }

  async show(push: AttentionPush): Promise<void> {
    const picked = await vscode.window.showInformationMessage(
      attentionHeadline(push),
      ...attentionChoices(push)
    )
    if (picked === undefined) return
    if (picked === messages.notify.open || push.reason !== 'approval') {
      this.options.reveal(push)
      return
    }
    try {
      await this.options.decideApproval(
        push,
        picked === messages.approval.deny ? 'deny' : 'allow',
        picked === messages.approval.allowAlways ? 'session' : 'once'
      )
    } catch (error) {
      this.options.report(error instanceof Error ? error.message : String(error))
      this.options.reveal(push)
    }
  }

  dispose(): void {
    this.view.dispose()
    this.changed.dispose()
  }
}
