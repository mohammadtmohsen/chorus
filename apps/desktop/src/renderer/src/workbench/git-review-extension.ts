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
  recordReviewCommits,
  REVIEW_SCHEME,
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
  labels: WorkbenchConnection['reviewLabels'],
  log: (message: string) => void
): Promise<void> {
  const logError = (operation: string, error: unknown): void => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    log(`review extension ${operation}: ${detail}`)
  }
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
    logError('get API', error)
    unsubscribeOpened()
    throw error
  })
  let commentController = api.comments.createCommentController(SOURCE_CONTROL_ID, labels.title)
  const commentThreads = new Map<string, CommentThread>()
  const threadSignatures = new Map<string, { notes: string; resolved: boolean }>()
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
  const reportFailure = (operation: string, error: unknown): void => {
    logError(operation, error)
    void api.window.showErrorMessage(labels.actionFailed)
  }
  const clearComments = (): void => {
    for (const thread of commentThreads.values()) thread.dispose()
    commentThreads.clear()
    threadSignatures.clear()
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
  const renderComments = (files: readonly ReviewDiffOpenedFile[], prune: boolean): void => {
    const review = activeReview
    if (review === null) return
    const wanted = new Set<string>()
    for (const file of files) {
      for (const discussion of review.threads) {
        if (discussion.path !== file.path) continue
        const line = discussion.newLine ?? discussion.oldLine
        if (line === null) continue
        const resource = discussion.newLine === null ? file.original : file.modified
        const key = JSON.stringify([discussion.id, resource])
        if (wanted.has(key)) continue
        wanted.add(key)
        const existing = commentThreads.get(key)
        const previous = threadSignatures.get(key)
        const signature = JSON.stringify(discussion.notes.map((note) => [note.id, note.body]))
        const notesChanged = previous?.notes !== signature
        const stateChanged = previous?.resolved !== discussion.resolved
        if (existing !== undefined && !notesChanged && !stateChanged) continue
        const comments = (): Comment[] =>
          discussion.notes.map((note) => {
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
        if (existing === undefined) {
          const thread = commentController.createCommentThread(
            api.Uri.parse(resource),
            new api.Range(line - 1, 0, line - 1, 0),
            comments()
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
          if (notesChanged) existing.comments = comments()
          if (stateChanged) {
            existing.contextValue = discussion.resolved
              ? 'chorus.gitReview.resolved'
              : 'chorus.gitReview.unresolved'
            existing.state = state
            existing.collapsibleState = collapsed
          }
        }
        threadSignatures.set(key, { notes: signature, resolved: discussion.resolved })
      }
    }
    if (!prune) return
    for (const [key, thread] of commentThreads) {
      if (wanted.has(key)) continue
      thread.dispose()
      threadIds.delete(thread)
      threadSignatures.delete(key)
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
  const documentChanges = api.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.length === 0) return
    const uri = event.document.uri.toString()
    let flipped = false
    for (const [key, file] of openedFiles) {
      if (file.workspace && file.matches && file.modified === uri) {
        openedFiles.set(key, { ...file, matches: false })
        flipped = true
      }
    }
    if (flipped) commentController.commentingRangeProvider = commentingProvider
  })
  receiveOpened = (event) => {
    try {
      if (!rememberOpened(event)) return false
      renderComments(event.files, false)
    } catch (error) {
      reportFailure('receive opened files', error)
    }
    return true
  }
  const scanRestoredTabs = (): void => {
    try {
      const review = activeReview
      if (review === null) return
      const root = api.workspace.workspaceFolders?.[0]?.uri
      const authority = reviewAuthority('original', review.mr.iid, review.version.id)
      const paths = new Set(review.files.map((file) => file.path))
      const newFiles: ReviewDiffOpenedFile[] = []
      const found = new Set<string>()
      const include = (original: Uri, modified: Uri): void => {
        if (original.scheme !== REVIEW_SCHEME || original.authority !== authority) return
        const workspace = modified.scheme !== REVIEW_SCHEME
        let path = modified.path.replace(/^\/+/, '')
        if (workspace) {
          if (root?.scheme !== modified.scheme || root.authority !== modified.authority) {
            return
          }
          const prefix = `${root.path.replace(/\/+$/, '')}/`
          if (!modified.path.startsWith(prefix)) return
          path = modified.path.slice(prefix.length)
        }
        if (!paths.has(path)) return
        const file: ReviewDiffOpenedFile = {
          path,
          original: original.toString(),
          modified: modified.toString(),
          workspace,
          matches: !workspace,
        }
        const key = JSON.stringify([file.path, file.original, file.modified])
        if (openedFiles.has(key) || found.has(key)) return
        found.add(key)
        newFiles.push(file)
      }
      for (const group of api.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input
          if (input instanceof api.TabInputTextDiff) {
            include(input.original, input.modified)
          } else if (input instanceof api.TabInputTextMultiDiff) {
            for (const pair of input.textDiffs) include(pair.original, pair.modified)
          }
        }
      }
      if (newFiles.length === 0) return
      if (!rememberOpened({ iid: review.mr.iid, versionId: review.version.id, files: newFiles })) {
        return
      }
      renderComments(newFiles, false)
      commentController.commentingRangeProvider = commentingProvider
    } catch (error) {
      reportFailure('scan restored review tabs', error)
    }
  }
  const applyState = (raw: unknown): void => {
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
      recordReviewCommits(
        review.mr.iid,
        review.version.id,
        review.version.headSha,
        review.version.baseSha
      )
      for (const event of pendingOpened.splice(0)) rememberOpened(event)
      renderComments([...openedFiles.values()], true)
      scanRestoredTabs()
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
  const apply = (raw: unknown): void => {
    try {
      applyState(raw)
    } catch (error) {
      reportFailure('apply review state', error)
    }
  }
  const read = async (): Promise<void> => {
    const generation = ++readGeneration
    try {
      const state = await window.chorusWorkbench.reviewState()
      if (readGeneration === generation) apply(state)
    } catch (error) {
      if (readGeneration === generation) reportFailure('read review state', error)
      else logError('stale review state read', error)
    }
  }
  const perform = async (action: WorkbenchReviewAction): Promise<void> => {
    try {
      const result = await window.chorusWorkbench.reviewAction(action)
      if (!result.ok) {
        log(`review extension ${action.kind} refused: ${result.message}`)
        void api.window.showErrorMessage(result.message)
        await read()
      }
    } catch (error) {
      reportFailure(`perform ${action.kind}`, error)
      await read()
    }
  }
  let actions = Promise.resolve()
  const enqueue = (action: WorkbenchReviewAction): Promise<void> => {
    actions = actions
      .then(() => perform(action))
      .catch((error: unknown) => {
        reportFailure('open action queue', error)
      })
    return actions
  }
  const command = api.commands.registerCommand('chorus.gitReview.openDiff', (raw: unknown) => {
    const parsed = WorkbenchReviewAction.safeParse(raw)
    if (parsed.success && parsed.data.kind === 'openDiff') return enqueue(parsed.data)
    return Promise.resolve()
  })
  const asThread = (raw: unknown): CommentThread | null => {
    if (typeof raw !== 'object' || raw === null) return null
    const value = raw as Record<string, unknown>
    if (!(value['uri'] instanceof api.Uri) || typeof value['dispose'] !== 'function') return null
    return raw as CommentThread
  }
  const failWrite = (message: string): Promise<never> => {
    void api.window.showErrorMessage(message)
    return Promise.reject(new Error(message))
  }
  const sendWrite = async (action: WorkbenchReviewAction): Promise<void> => {
    let result: WorkbenchReviewActionResult
    try {
      result = await window.chorusWorkbench.reviewAction(action)
    } catch (error) {
      logError(`send ${action.kind}`, error)
      return failWrite(labels.actionFailed)
    }
    if (!result.ok) return failWrite(result.message)
  }
  const queueWrite = (work: () => Promise<void>): Promise<void> => {
    const next = actions.then(work)
    actions = next.catch((error: unknown) => {
      logError('write action queue', error)
    })
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
  const tabChanges = api.window.tabGroups.onDidChangeTabs(scanRestoredTabs)
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
    tabChanges.dispose()
    for (const writeCommand of writeCommands) writeCommand.dispose()
    command.dispose()
    sourceControl?.dispose()
    decorationProvider.dispose()
    decorationChanges.dispose()
    void extension.dispose().catch((error: unknown) => {
      reportFailure('dispose', error)
    })
  })
}
