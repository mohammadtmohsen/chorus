import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import type { FileDecoration, SourceControl, Uri } from 'vscode'
import type { GitReviewFile } from '../../../shared/git-ipc.js'
import {
  WorkbenchReviewAction,
  WorkbenchReviewState,
  type WorkbenchConnection,
} from '../../../shared/workbench-ipc.js'
import { REVIEW_SCHEME, reviewAuthority } from './review-diff.js'

const SOURCE_CONTROL_ID = 'chorus.gitReview'
const STATUS_COLORS: Record<GitReviewFile['status'], string> = {
  added: 'gitDecoration.addedResourceForeground',
  removed: 'gitDecoration.deletedResourceForeground',
  modified: 'gitDecoration.modifiedResourceForeground',
  renamed: 'gitDecoration.renamedResourceForeground',
}

export async function startGitReviewExtension(
  labels: WorkbenchConnection['reviewLabels']
): Promise<void> {
  const extension = registerExtension(
    {
      publisher: 'chorus',
      name: 'git-review',
      version: '0.0.1',
      engines: { vscode: '*' },
    },
    ExtensionHostKind.LocalProcess,
    { system: true }
  )
  const api = await extension.getApi()
  const decorationChanges = new api.EventEmitter<undefined>()
  let decorations = new Map<string, FileDecoration>()
  const decorationProvider = api.window.registerFileDecorationProvider({
    onDidChangeFileDecorations: decorationChanges.event,
    provideFileDecoration: (uri) => decorations.get(uri.toString()),
  })
  const resourceOf = (iid: number, versionId: number, path: string): Uri =>
    api.Uri.from({
      scheme: REVIEW_SCHEME,
      authority: reviewAuthority('modified', iid, versionId),
      path: `/${path}`,
    })
  let sourceControl: SourceControl | null = null
  let shown = ''
  let latest = -1
  let readGeneration = 0
  const reportFailure = (): void => {
    void api.window.showErrorMessage(labels.actionFailed)
  }
  const apply = (raw: unknown): void => {
    const parsed = WorkbenchReviewState.safeParse(raw)
    if (!parsed.success || parsed.data.revision < latest) return
    const state = parsed.data
    latest = state.revision
    const review = state.review
    const identity = review === null ? '' : `${String(review.mr.iid)}:${String(review.version.id)}`
    if (identity === shown) return
    shown = identity
    sourceControl?.dispose()
    sourceControl = null
    decorations = new Map(
      review === null
        ? []
        : review.files.map((file): [string, FileDecoration] => [
            resourceOf(review.mr.iid, review.version.id, file.path).toString(),
            new api.FileDecoration(
              labels.status[file.status],
              undefined,
              new api.ThemeColor(STATUS_COLORS[file.status])
            ),
          ])
    )
    decorationChanges.fire(undefined)
    if (review === null) return
    const iid = review.mr.iid
    const versionId = review.version.id
    const next = api.scm.createSourceControl(
      SOURCE_CONTROL_ID,
      `${labels.title} !${String(iid)}`,
      resourceOf(iid, versionId, '')
    )
    next.inputBox.visible = false
    next.count = 0
    const group = next.createResourceGroup('changes', review.mr.title)
    group.resourceStates = review.files.map((file) => ({
      resourceUri: resourceOf(iid, versionId, file.path),
      decorations: {
        strikeThrough: file.status === 'removed',
        tooltip: `${file.path}  +${String(file.added)} −${String(file.removed)}`,
      },
      command: {
        command: 'chorus.gitReview.openDiff',
        title: labels.title,
        arguments: [{ kind: 'openDiff', iid, versionId, path: file.path }],
      },
    }))
    sourceControl = next
  }
  const read = async (): Promise<void> => {
    const generation = ++readGeneration
    try {
      const state = await window.chorusWorkbench.reviewState()
      if (readGeneration === generation) apply(state)
    } catch {
      if (readGeneration === generation) reportFailure()
    }
  }
  const perform = async (action: WorkbenchReviewAction): Promise<void> => {
    try {
      const result = await window.chorusWorkbench.reviewAction(action)
      if (!result.ok) {
        await api.window.showErrorMessage(result.message)
        await read()
      }
    } catch {
      reportFailure()
      await read()
    }
  }
  let actions = Promise.resolve()
  const enqueue = (action: WorkbenchReviewAction): void => {
    actions = actions.then(() => perform(action)).catch(reportFailure)
  }
  const command = api.commands.registerCommand('chorus.gitReview.openDiff', (raw: unknown) => {
    const parsed = WorkbenchReviewAction.safeParse(raw)
    if (parsed.success) enqueue(parsed.data)
  })
  const unsubscribe = window.chorusWorkbench.onReviewChanged((raw) => {
    if (raw === null) {
      readGeneration++
      latest = -1
      apply({ revision: 0, review: null })
      void read()
      return
    }
    apply(raw)
  })
  void read()
  window.addEventListener('unload', () => {
    readGeneration++
    unsubscribe()
    command.dispose()
    sourceControl?.dispose()
    decorationProvider.dispose()
    decorationChanges.dispose()
    void extension.dispose().catch(reportFailure)
  })
}
