import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import type {
  Comment,
  CommentThread,
  CommentingRangeProvider,
  FileDecoration,
  SourceControl,
  TextDocument,
  Uri,
} from 'vscode'
import { formatGitTime, type GitReviewFile, type GitReviewReady } from '../../../shared/git-ipc.js'
import {
  WorkbenchReviewAction,
  WorkbenchReviewState,
  type WorkbenchConnection,
  type WorkbenchReviewActionResult,
} from '../../../shared/workbench-ipc.js'
import {
  onReviewDiffOpened,
  reviewAuthority,
  type ReviewDiffOpened,
  type ReviewDiffOpenedFile,
} from './review-diff.js'

const SOURCE_CONTROL_ID = 'chorus.gitReview'
const ROW_SCHEME = 'chorus-merge-request'
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
      contributes: {
        commands: [
          { command: 'chorus.gitReview.comment', title: labels.comment },
          { command: 'chorus.gitReview.reply', title: labels.reply },
          { command: 'chorus.gitReview.resolve', title: labels.resolve },
          { command: 'chorus.gitReview.reopen', title: labels.reopen },
        ],
        menus: {
          'comments/commentThread/context': [
            {
              command: 'chorus.gitReview.comment',
              when: 'commentController == chorus.gitReview && commentThreadIsEmpty',
              group: 'inline',
            },
            {
              command: 'chorus.gitReview.reply',
              when: 'commentController == chorus.gitReview && !commentThreadIsEmpty',
              group: 'inline',
            },
          ],
          'comments/commentThread/title': [
            {
              command: 'chorus.gitReview.resolve',
              when: 'commentThread == chorus.gitReview.unresolved',
              group: 'inline',
            },
            {
              command: 'chorus.gitReview.reopen',
              when: 'commentThread == chorus.gitReview.resolved',
              group: 'inline',
            },
          ],
        },
      },
    },
    ExtensionHostKind.LocalProcess,
    { system: true }
  )
  const pendingOpened: ReviewDiffOpened[] = []
  let receiveOpened: ((event: ReviewDiffOpened) => boolean) | null = null
  const unsubscribeOpened = onReviewDiffOpened((event) => {
    if (receiveOpened?.(event) !== true) pendingOpened.push(event)
  })
  const api = await extension.getApi().catch((error: unknown) => {
    unsubscribeOpened()
    throw error
  })
  let commentController = api.comments.createCommentController(SOURCE_CONTROL_ID, labels.title)
  const commentThreads = new Map<string, CommentThread>()
  const threadIds = new Map<
    CommentThread,
    { iid: number; versionId: number; discussionId: string }
  >()
  const openedFiles = new Map<string, ReviewDiffOpenedFile>()
  let activeReview: GitReviewReady | null = null
  const decorationChanges = new api.EventEmitter<undefined>()
  let decorations = new Map<string, FileDecoration>()
  const decorationProvider = api.window.registerFileDecorationProvider({
    onDidChangeFileDecorations: decorationChanges.event,
    provideFileDecoration: (uri) => decorations.get(uri.toString()),
  })
  const resourceOf = (iid: number, versionId: number, path: string): Uri =>
    api.Uri.from({
      scheme: ROW_SCHEME,
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
  const clearComments = (): void => {
    for (const thread of commentThreads.values()) thread.dispose()
    commentThreads.clear()
    threadIds.clear()
  }
  const rememberOpened = (event: ReviewDiffOpened): boolean => {
    if (activeReview?.mr.iid !== event.iid || activeReview.version.id !== event.versionId) {
      return false
    }
    for (const file of event.files) {
      const dirty = api.workspace.textDocuments.some(
        (document) => document.uri.toString() === file.modified && document.isDirty
      )
      openedFiles.set(JSON.stringify([file.path, file.original, file.modified]), {
        ...file,
        matches: file.matches && !(file.workspace && dirty),
      })
    }
    return true
  }
  const renderComments = (): void => {
    const review = activeReview
    if (review === null) return
    const wanted = new Set<string>()
    for (const file of openedFiles.values()) {
      for (const discussion of review.threads) {
        if (discussion.path !== file.path) continue
        const line = discussion.newLine ?? discussion.oldLine
        if (line === null) continue
        const resource = discussion.newLine === null ? file.original : file.modified
        const key = JSON.stringify([discussion.id, resource])
        if (wanted.has(key)) continue
        wanted.add(key)
        const comments = discussion.notes.map<Comment>((note) => {
          const body = new api.MarkdownString(note.body)
          body.isTrusted = false
          body.supportHtml = false
          return {
            body,
            author: { name: note.author.name },
            mode: api.CommentMode.Preview,
            label: formatGitTime(note.createdAt),
          }
        })
        const state = discussion.resolved
          ? api.CommentThreadState.Resolved
          : api.CommentThreadState.Unresolved
        const collapsed = discussion.resolved
          ? api.CommentThreadCollapsibleState.Collapsed
          : api.CommentThreadCollapsibleState.Expanded
        const existing = commentThreads.get(key)
        if (existing === undefined) {
          const thread = commentController.createCommentThread(
            api.Uri.parse(resource),
            new api.Range(line - 1, 0, line - 1, 0),
            comments
          )
          thread.canReply = true
          thread.contextValue = discussion.resolved
            ? 'chorus.gitReview.resolved'
            : 'chorus.gitReview.unresolved'
          thread.state = state
          thread.collapsibleState = collapsed
          commentThreads.set(key, thread)
          threadIds.set(thread, {
            iid: review.mr.iid,
            versionId: review.version.id,
            discussionId: discussion.id,
          })
        } else {
          existing.comments = comments
          existing.contextValue = discussion.resolved
            ? 'chorus.gitReview.resolved'
            : 'chorus.gitReview.unresolved'
          if (existing.state !== state) {
            existing.state = state
            existing.collapsibleState = collapsed
          }
        }
      }
    }
    for (const [key, thread] of commentThreads) {
      if (wanted.has(key)) continue
      thread.dispose()
      threadIds.delete(thread)
      commentThreads.delete(key)
    }
  }
  const contextFor = (
    uri: Uri
  ): { file: ReviewDiffOpenedFile; side: 'original' | 'modified' } | null => {
    const key = uri.toString()
    for (const file of openedFiles.values()) {
      if (file.original === key) return { file, side: 'original' }
      if (file.modified === key) return { file, side: 'modified' }
    }
    return null
  }
  const canComment = (uri: Uri, document?: TextDocument): boolean => {
    const context = contextFor(uri)
    if (context === null || activeReview === null) return false
    const summary = activeReview.files.find((file) => file.path === context.file.path)
    if (summary === undefined) return false
    if (context.side === 'original') return summary.status !== 'added'
    if (summary.status === 'removed') return false
    if (!context.file.workspace) return true
    const held =
      document ?? api.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString())
    return context.file.matches && held?.isDirty === false
  }
  const commentingProvider: CommentingRangeProvider = {
    provideCommentingRanges: (document) =>
      canComment(document.uri, document)
        ? [new api.Range(0, 0, Math.max(0, document.lineCount - 1), 0)]
        : [],
  }
  commentController.commentingRangeProvider = commentingProvider
  const documentChanges = api.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.length === 0) return
    for (const [key, file] of openedFiles) {
      if (file.workspace && file.modified === event.document.uri.toString()) {
        openedFiles.set(key, { ...file, matches: false })
      }
    }
    commentController.commentingRangeProvider = commentingProvider
  })
  receiveOpened = (event) => {
    if (!rememberOpened(event)) return false
    try {
      renderComments()
      commentController.commentingRangeProvider = commentingProvider
    } catch {
      reportFailure()
    }
    return true
  }
  const apply = (raw: unknown): void => {
    const parsed = WorkbenchReviewState.safeParse(raw)
    if (!parsed.success || parsed.data.revision < latest) return
    const state = parsed.data
    latest = state.revision
    const review = state.review
    const identity = review === null ? '' : `${String(review.mr.iid)}:${String(review.version.id)}`
    activeReview = review
    if (identity !== shown) {
      clearComments()
      openedFiles.clear()
      commentController.dispose()
      commentController = api.comments.createCommentController(SOURCE_CONTROL_ID, labels.title)
      commentController.commentingRangeProvider = commentingProvider
      if (review === null) pendingOpened.length = 0
    }
    if (review !== null) {
      for (const event of pendingOpened.splice(0)) rememberOpened(event)
      try {
        renderComments()
      } catch {
        reportFailure()
      }
    }
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
    if (parsed.success && parsed.data.kind === 'openDiff') enqueue(parsed.data)
  })
  const asThread = (raw: unknown): CommentThread | null => {
    if (typeof raw !== 'object' || raw === null) return null
    const value = raw as Record<string, unknown>
    if (!(value['uri'] instanceof api.Uri) || typeof value['dispose'] !== 'function') return null
    return raw as CommentThread
  }
  const failWrite = async (message: string): Promise<never> => {
    await api.window.showErrorMessage(message)
    throw new Error(message)
  }
  const sendWrite = async (action: WorkbenchReviewAction): Promise<void> => {
    let result: WorkbenchReviewActionResult
    try {
      result = await window.chorusWorkbench.reviewAction(action)
    } catch {
      return failWrite(labels.actionFailed)
    }
    if (!result.ok) return failWrite(result.message)
  }
  const queueWrite = (work: () => Promise<void>): Promise<void> => {
    const next = actions.then(work)
    actions = next.catch(() => undefined)
    return next
  }
  const submit = (raw: unknown, reply: boolean): Promise<void> => {
    const identity = shown
    return queueWrite(async () => {
      if (identity === '' || shown !== identity) return failWrite(labels.actionFailed)
      if (typeof raw !== 'object' || raw === null) return failWrite(labels.actionFailed)
      const value = raw as Record<string, unknown>
      const thread = asThread(value['thread'])
      const body = value['text']
      if (thread === null || typeof body !== 'string' || body.trim() === '') {
        return failWrite(labels.actionFailed)
      }
      if (reply) {
        const id = threadIds.get(thread)
        if (
          id === undefined ||
          activeReview?.mr.iid !== id.iid ||
          activeReview.version.id !== id.versionId
        ) {
          return failWrite(labels.actionFailed)
        }
        await sendWrite({ kind: 'reply', iid: id.iid, discussionId: id.discussionId, body })
        return
      }
      const context = contextFor(thread.uri)
      const review = activeReview
      if (context === null || review === null || thread.range === undefined) {
        return failWrite(labels.actionFailed)
      }
      if (!canComment(thread.uri)) return failWrite(labels.commentingBlocked)
      await sendWrite({
        kind: 'comment',
        iid: review.mr.iid,
        versionId: review.version.id,
        path: context.file.path,
        side: context.side,
        line: thread.range.start.line + 1,
        body,
      })
      thread.dispose()
    })
  }
  const resolve = (raw: unknown, resolved: boolean): Promise<void> =>
    queueWrite(async () => {
      const thread = asThread(raw)
      const id = thread === null ? undefined : threadIds.get(thread)
      if (
        id === undefined ||
        activeReview?.mr.iid !== id.iid ||
        activeReview.version.id !== id.versionId
      ) {
        return failWrite(labels.actionFailed)
      }
      await sendWrite({ kind: 'resolve', iid: id.iid, discussionId: id.discussionId, resolved })
    })
  const writeCommands = [
    api.commands.registerCommand('chorus.gitReview.comment', (raw: unknown) => submit(raw, false)),
    api.commands.registerCommand('chorus.gitReview.reply', (raw: unknown) => submit(raw, true)),
    api.commands.registerCommand('chorus.gitReview.resolve', (raw: unknown) => resolve(raw, true)),
    api.commands.registerCommand('chorus.gitReview.reopen', (raw: unknown) => resolve(raw, false)),
  ]
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
    unsubscribeOpened()
    clearComments()
    commentController.dispose()
    documentChanges.dispose()
    for (const writeCommand of writeCommands) writeCommand.dispose()
    command.dispose()
    sourceControl?.dispose()
    decorationProvider.dispose()
    decorationChanges.dispose()
    void extension.dispose().catch(reportFailure)
  })
}
