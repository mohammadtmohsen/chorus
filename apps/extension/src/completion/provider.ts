import type {
  CancellationToken,
  Disposable,
  InlineCompletionContext,
  InlineCompletionItem,
  InlineCompletionItemProvider,
  Position,
  TextDocument,
  Uri,
} from 'vscode'
import type { CompletionPayload, EditorReport } from '../../../desktop/src/shared/workbench-ipc.js'
import { abortable } from './async.js'
import { collectCompletionContext, completionPayload } from './context.js'
import type { CompletionEnvironment, CompletionPort } from './contracts.js'

type ContextFacts = Omit<EditorReport, 'requestId' | 'outcome'>

export class InlineCompletionProvider implements InlineCompletionItemProvider, Disposable {
  private readonly requests = new Map<string, AbortController>()
  private disposed = false

  constructor(
    private readonly port: CompletionPort,
    private readonly host: CompletionEnvironment
  ) {}

  private allowed(document: TextDocument): boolean {
    return (
      !this.disposed &&
      !document.isClosed &&
      (document.uri.scheme === 'file' || document.uri.scheme === 'vscode-remote') &&
      this.port.insideProject(document.uri) &&
      this.host.enabled(document)
    )
  }

  invalidate(uri?: Uri): void {
    if (uri === undefined) {
      for (const controller of this.requests.values()) controller.abort()
      this.requests.clear()
      return
    }
    const key = uri.toString()
    this.requests.get(key)?.abort()
    this.requests.delete(key)
  }

  async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
    token: CancellationToken
  ): Promise<InlineCompletionItem[] | undefined> {
    if (!this.allowed(document)) return undefined
    const requestId = this.host.requestId()
    if (this.port.snoozed?.() === true) {
      this.port.report?.({ requestId, outcome: 'snoozed' })
      return undefined
    }
    const cancelled = (): boolean => token.isCancellationRequested
    if (cancelled()) {
      this.port.report?.({ requestId, outcome: 'cancelled' })
      return undefined
    }

    const enteredAt = this.host.now()
    const version = document.version
    const key = document.uri.toString()
    this.invalidate(document.uri)
    const controller = new AbortController()
    this.requests.set(key, controller)
    const cancellation = token.onCancellationRequested(() => {
      controller.abort()
    })
    if (cancelled()) controller.abort()

    let facts: ContextFacts = {}
    const current = (): boolean => {
      const editor = this.host.activeEditor()
      return (
        !controller.signal.aborted &&
        this.requests.get(key) === controller &&
        this.allowed(document) &&
        this.port.snoozed?.() !== true &&
        document.version === version &&
        editor?.uri.toString() === key &&
        editor.position.isEqual(position)
      )
    }
    const cancel = (): undefined => {
      controller.abort()
      this.port.report?.({ requestId, outcome: 'cancelled', ...facts })
      return undefined
    }

    try {
      if (!current()) {
        cancel()
        return
      }
      const configured = await abortable(() => this.port.configured(), controller.signal)
      if (!current()) {
        cancel()
        return
      }
      if (configured !== true) {
        this.port.report?.({ requestId, outcome: 'not-configured' })
        return undefined
      }

      const collected = await collectCompletionContext(
        document,
        position,
        this.host,
        controller.signal
      )
      facts = collected.facts
      if (!current()) {
        cancel()
        return
      }
      const payload = completionPayload(document, position, collected.context, this.host)
      const reply = await abortable(
        () => this.port.request(requestId, payload, controller.signal),
        controller.signal
      )
      if (!current()) {
        cancel()
        return
      }
      if (reply?.text === null || reply === null || reply.text.trim() === '') {
        this.port.report?.({
          requestId,
          outcome: reply?.configured === false ? 'not-configured' : 'no-suggestion',
          ...facts,
        })
        return undefined
      }

      const item = this.item(document, position, context, payload, reply.text)
      if (item === null) {
        this.port.report?.({ requestId, outcome: 'no-suggestion', ...facts })
        return undefined
      }
      this.port.report?.({
        requestId,
        outcome: 'returned',
        providerReturnedMs: Math.round(this.host.now() - enteredAt),
        ...facts,
      })
      return [item]
    } finally {
      cancellation.dispose()
      if (this.requests.get(key) === controller) this.requests.delete(key)
    }
  }

  private item(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
    payload: CompletionPayload,
    text: string
  ): InlineCompletionItem | null {
    if (payload.suffix.startsWith(text)) return null
    const selected = context.selectedCompletionInfo
    if (selected === undefined) {
      return { insertText: text, range: this.host.range(position, position) }
    }
    if (!selected.range.isSingleLine || !selected.range.contains(position)) return null
    const prefix = document.getText(this.host.range(selected.range.start, position))
    const insertText = prefix + text
    if (!insertText.startsWith(selected.text) || insertText.length <= selected.text.length)
      return null
    return { insertText, range: selected.range }
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
  }
}
