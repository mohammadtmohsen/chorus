import { getService } from '@codingame/monaco-vscode-api'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { IEditorGroupsService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService.service'
import { ITextEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/textfile/common/textEditorService.service'
import type { IEditorGroup } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService'
import {
  DEFAULT_EDITOR_ASSOCIATION,
  type IResourceDiffEditorInput,
} from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor'
import { DiffEditorInput } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor/diffEditorInput'
import { isDiffEditor } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorBrowser'
import { ILanguageService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages/language.service'
import { IWorkspaceContextService } from '@codingame/monaco-vscode-api/vscode/vs/platform/workspace/common/workspace.service'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { Disposable } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle'
import {
  createFileSystemProviderError,
  FilePermission,
  FileSystemProviderCapabilities,
  FileSystemProviderErrorCode,
  FileType,
  type IFileSystemProviderWithFileReadWriteCapability,
} from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files'
import type { IFileService } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files.service'
import type {
  WorkbenchReviewDiffFile,
  WorkbenchReviewDiffResult,
} from '../../../shared/workbench-ipc.js'

export const REVIEW_SCHEME = 'chorus-review'
const resources = new Map<string, Uint8Array>()
const restoring = new Map<string, Promise<Uint8Array>>()
const reviewCommits = new Map<string, { head: string; base: string }>()

export function recordReviewCommits(
  iid: number,
  versionId: number,
  head: string,
  base: string
): void {
  const key = `${String(iid)}:${String(versionId)}`
  reviewCommits.delete(key)
  reviewCommits.set(key, { head, base })
  if (reviewCommits.size > 16) {
    const oldest = reviewCommits.keys().next().value
    if (oldest !== undefined) reviewCommits.delete(oldest)
  }
}

export function resolveReviewResource(
  resource: Pick<URI, 'scheme' | 'authority' | 'path'>,
  root: string
): { relativePath: string; commit: string } | null {
  if (resource.scheme !== REVIEW_SCHEME) return null
  const authority = /^(original|modified)-(\d+)-(\d+)$/.exec(resource.authority)
  const side = authority?.[1]
  const iid = Number(authority?.[2])
  const versionId = Number(authority?.[3])
  if (
    (side !== 'original' && side !== 'modified') ||
    !Number.isSafeInteger(iid) ||
    iid <= 0 ||
    !Number.isSafeInteger(versionId) ||
    versionId <= 0
  ) {
    return null
  }
  const commits = reviewCommits.get(`${String(iid)}:${String(versionId)}`)
  if (commits === undefined) return null
  const prefix = root.replace(/\/+$/, '')
  const relativePath = (
    resource.path.startsWith(`${prefix}/`) ? resource.path.slice(prefix.length) : resource.path
  )
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (relativePath === '' || relativePath.split('/').includes('..')) return null
  return { relativePath, commit: side === 'original' ? commits.base : commits.head }
}

async function restoreReviewResource(
  resource: URI,
  root: string,
  failureMessage: string
): Promise<Uint8Array> {
  try {
    const authority = /^(original|modified)-(\d+)-(\d+)$/.exec(resource.authority)
    const side = authority?.[1]
    const iid = Number(authority?.[2])
    const versionId = Number(authority?.[3])
    if (
      (side !== 'original' && side !== 'modified') ||
      !Number.isSafeInteger(iid) ||
      iid <= 0 ||
      !Number.isSafeInteger(versionId) ||
      versionId <= 0
    ) {
      throw new Error(failureMessage)
    }
    const prefix = root.replace(/\/+$/, '')
    const path = (
      resource.path.startsWith(`${prefix}/`) ? resource.path.slice(prefix.length) : resource.path
    ).replace(/^\/+/, '')
    if (path === '') throw new Error(failureMessage)
    const result = await window.chorusWorkbench.reviewFile({ iid, versionId, side, path })
    if (!result.ok) throw new Error(result.message)
    const bytes = new TextEncoder().encode(result.text)
    resources.set(resource.toString(), bytes)
    return bytes
  } catch (error) {
    throw createFileSystemProviderError(
      error instanceof Error ? error.message : failureMessage,
      FileSystemProviderErrorCode.FileNotFound
    )
  }
}

export function prepareReviewFileProvider(
  files: IFileService,
  root: string,
  failureMessage: string
): () => void {
  const read = async (resource: URI): Promise<Uint8Array> => {
    const key = resource.toString()
    const cached = resources.get(key)
    if (cached !== undefined) return cached
    const running = restoring.get(key)
    if (running !== undefined) return running
    const pending = restoreReviewResource(resource, root, failureMessage)
    restoring.set(key, pending)
    try {
      return await pending
    } finally {
      if (restoring.get(key) === pending) restoring.delete(key)
    }
  }
  const denied = (): Promise<never> =>
    Promise.reject(
      createFileSystemProviderError(failureMessage, FileSystemProviderErrorCode.NoPermissions)
    )
  const provider: IFileSystemProviderWithFileReadWriteCapability = {
    capabilities:
      FileSystemProviderCapabilities.FileReadWrite |
      FileSystemProviderCapabilities.PathCaseSensitive |
      FileSystemProviderCapabilities.Readonly,
    onDidChangeCapabilities: () => Disposable.None,
    onDidChangeFile: () => Disposable.None,
    watch: () => Disposable.None,
    readFile: read,
    stat: async (resource) => {
      const bytes = await read(resource)
      return {
        type: FileType.File,
        ctime: 0,
        mtime: 0,
        size: bytes.byteLength,
        permissions: FilePermission.Readonly,
      }
    },
    readdir: () =>
      Promise.reject(
        createFileSystemProviderError(failureMessage, FileSystemProviderErrorCode.FileNotFound)
      ),
    writeFile: denied,
    mkdir: denied,
    delete: denied,
    rename: denied,
  }
  let registered = false
  const register = (): void => {
    if (registered) return
    files.registerProvider(REVIEW_SCHEME, provider)
    registered = true
  }
  const activation = files.onWillActivateFileSystemProvider((event) => {
    if (event.scheme === REVIEW_SCHEME) register()
  })
  window.addEventListener(
    'unload',
    () => {
      activation.dispose()
    },
    { once: true }
  )
  return register
}

export interface ReviewDiffOpenedFile {
  readonly path: string
  readonly original: string
  readonly modified: string
  readonly workspace: boolean
  readonly matches: boolean
}

export interface ReviewDiffOpened {
  readonly iid: number
  readonly versionId: number
  readonly files: readonly ReviewDiffOpenedFile[]
}

const openedListeners = new Set<(event: ReviewDiffOpened) => void>()

export function onReviewDiffOpened(listener: (event: ReviewDiffOpened) => void): () => void {
  openedListeners.add(listener)
  return () => {
    openedListeners.delete(listener)
  }
}

export function reviewAuthority(
  side: 'original' | 'modified' | 'all',
  iid: number,
  versionId: number
): string {
  return `${side}-${String(iid)}-${String(versionId)}`
}

function isReviewFile(value: unknown): value is WorkbenchReviewDiffFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Record<string, unknown>
  return (
    typeof file['path'] === 'string' &&
    file['path'] !== '' &&
    typeof file['oldPath'] === 'string' &&
    file['oldPath'] !== '' &&
    typeof file['before'] === 'string' &&
    typeof file['after'] === 'string' &&
    typeof file['workspace'] === 'boolean' &&
    typeof file['matches'] === 'boolean'
  )
}

function reviewFilesOf(
  request: Record<string, unknown>
): readonly WorkbenchReviewDiffFile[] | null {
  const files = request['files']
  if (files === undefined) return isReviewFile(request) ? [request] : null
  return Array.isArray(files) && files.length > 0 && files.every(isReviewFile) ? files : null
}

interface ReviewDiffReplacement {
  readonly iid: number
  readonly versionId: number
  readonly path: string
  readonly group: IEditorGroup
  readonly editor: DiffEditorInput
  readonly restore: IResourceDiffEditorInput
  readonly index: number
  readonly pinned: boolean
  readonly sticky: boolean
}

export function serveReviewDiff(log: (message: string) => void): void {
  const replacements = new Map<string, ReviewDiffReplacement>()
  window.chorusWorkbench.onReviewDiffRequest(async (raw): Promise<WorkbenchReviewDiffResult> => {
    const request = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const requestId = typeof request['requestId'] === 'string' ? request['requestId'] : ''
    const iid = request['iid']
    const versionId = request['versionId']
    const reopen = request['kind'] === 'reopenActive'
    const replace = request['replace']
    const requested = reviewFilesOf(request)
    const multiple = request['files'] !== undefined
    const title = request['title']
    let describeInput = (): string => 'unresolved'
    const failed = (reason: string, error?: unknown): WorkbenchReviewDiffResult => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      const message = error instanceof Error ? error.message : String(error)
      const target = multiple
        ? `all (${String(requested?.length ?? 0)} files)`
        : requested?.[0]?.path
      log(
        `review diff ${requestId}: ${reason}; iid=${String(iid)}; ` +
          `version=${String(versionId)}; target=${target ?? 'unknown'}; input=${describeInput()}` +
          (error === undefined ? '' : `\n${detail}`)
      )
      return {
        requestId,
        ok: false,
        failure: 'open-failed',
        ...(error === undefined ? {} : { message }),
      }
    }
    if (
      typeof iid !== 'number' ||
      !Number.isSafeInteger(iid) ||
      iid <= 0 ||
      typeof versionId !== 'number' ||
      !Number.isSafeInteger(versionId) ||
      versionId <= 0 ||
      (replace !== undefined && (typeof replace !== 'string' || replace === ''))
    ) {
      return failed('invalid review diff request')
    }

    try {
      const editors = await getService(IEditorService)
      const groups = await getService(IEditorGroupsService)
      if (reopen) {
        const group = groups.activeGroup
        const editor = group.activeEditor
        if (
          !(editor instanceof DiffEditorInput) ||
          !isDiffEditor(group.activeEditorPane?.getControl()) ||
          editor.original.resource?.scheme !== REVIEW_SCHEME ||
          editor.original.resource.authority !== reviewAuthority('original', iid, versionId) ||
          editor.modified.resource?.scheme !== REVIEW_SCHEME ||
          editor.modified.resource.authority !== reviewAuthority('modified', iid, versionId) ||
          editor.isDirty()
        ) {
          return { requestId, ok: true }
        }
        const restore = editor.toUntyped({ preserveViewState: group.id, preserveResource: true })
        if (restore === undefined) return failed('active review diff cannot be restored')
        const token = crypto.randomUUID()
        const path = editor.modified.resource.path.replace(/^\/+/, '')
        const target: ReviewDiffReplacement = {
          iid,
          versionId,
          path,
          group,
          editor,
          restore,
          index: group.getIndexOfEditor(editor),
          pinned: group.isPinned(editor),
          sticky: group.isSticky(editor),
        }
        replacements.set(token, target)
        const closed = group.onDidCloseEditor((event) => {
          if (event.editor === editor) replacements.delete(token)
        })
        try {
          const result = await window.chorusWorkbench.reviewAction({
            kind: 'openDiff',
            iid,
            versionId,
            path,
            replace: token,
          })
          return result.ok ? { requestId, ok: true } : failed('active review diff reopen failed')
        } finally {
          closed.dispose()
          replacements.delete(token)
        }
      }
      if (requested === null || (multiple && (typeof title !== 'string' || title === ''))) {
        return failed('invalid review diff request')
      }
      const target = typeof replace === 'string' ? replacements.get(replace) : undefined
      const current = (): boolean =>
        target !== undefined &&
        groups.getGroup(target.group.id) === target.group &&
        groups.activeGroup === target.group &&
        target.group.activeEditor === target.editor &&
        !target.editor.isDisposed() &&
        !target.editor.isDirty() &&
        target.group.getIndexOfEditor(target.editor) === target.index &&
        target.group.isPinned(target.editor) === target.pinned &&
        target.group.isSticky(target.editor) === target.sticky
      if (
        replace !== undefined &&
        (target?.iid !== iid ||
          target.versionId !== versionId ||
          multiple ||
          requested[0]?.path !== target.path ||
          !requested[0].workspace ||
          !current())
      ) {
        return failed('unknown or stale review diff replacement')
      }
      const languages = await getService(ILanguageService)
      const context = await getService(IWorkspaceContextService)
      const root = context.getWorkspace().folders[0]?.uri
      if (root === undefined && requested.some((file) => file.workspace)) {
        return failed('workspace file requested without a workspace folder')
      }
      const openedFiles: ReviewDiffOpenedFile[] = []
      const inputs = requested.map(({ path, oldPath, before, after, workspace, matches }) => {
        const original = URI.from({
          scheme: REVIEW_SCHEME,
          authority: reviewAuthority('original', iid, versionId),
          path: workspace && root !== undefined ? URI.joinPath(root, oldPath).path : `/${oldPath}`,
        })
        const modified =
          workspace && root !== undefined
            ? URI.joinPath(root, path)
            : URI.from({
                scheme: REVIEW_SCHEME,
                authority: reviewAuthority('modified', iid, versionId),
                path: `/${path}`,
              })
        const contents: readonly (readonly [URI, string])[] = workspace
          ? [[original, before]]
          : [
              [original, before],
              [modified, after],
            ]
        for (const [resource, text] of contents) {
          const key = resource.toString()
          if (resources.has(key)) continue
          const bytes = new TextEncoder().encode(text)
          resources.set(key, bytes)
        }
        const languageId =
          languages.guessLanguageIdByFilepathOrFirstLine(URI.file(path)) ?? 'plaintext'
        openedFiles.push({
          path,
          original: original.toString(),
          modified: modified.toString(),
          workspace,
          matches,
        })
        return {
          original: { resource: original, languageId },
          modified: { resource: modified, languageId },
        }
      })
      const first = inputs[0]
      const file = requested[0]
      if (first === undefined || file === undefined) {
        return failed('no review diff inputs were built')
      }
      describeInput = () => {
        const input = editors.activeEditor
        return `type=${input?.typeId ?? 'none'}, editor=${input?.editorId ?? 'none'}`
      }
      if (target !== undefined && typeof replace === 'string') {
        const textEditors = await getService(ITextEditorService)
        const replacement = await textEditors.resolveTextEditor({
          ...first,
          label: `${file.path} (!${String(iid)})`,
        })
        await replacement.resolve()
        if (replacements.get(replace) !== target || !current()) {
          replacement.dispose()
          return failed('stale review diff replacement')
        }
        const existing = target.group.editors.find((editor) => editor.matches(replacement))
        replacements.delete(replace)
        const event: ReviewDiffOpened = { iid, versionId, files: openedFiles }
        for (const listener of openedListeners) listener(event)
        try {
          await target.group.replaceEditors([
            {
              editor: target.editor,
              replacement,
              options: {
                index: target.index,
                pinned: target.pinned,
                sticky: target.sticky,
                preserveFocus: true,
              },
            },
          ])
          const control = target.group.activeEditorPane?.getControl()
          const model = isDiffEditor(control) ? control.getModel() : null
          if (
            model?.original.uri.toString() !== first.original.resource.toString() ||
            model.modified.uri.toString() !== first.modified.resource.toString()
          ) {
            throw new Error('editable review diff did not finish opening')
          }
          return { requestId, ok: true }
        } catch (error) {
          if (groups.getGroup(target.group.id) === target.group) {
            const restored = await editors.openEditor(
              {
                ...target.restore,
                options: {
                  ...target.restore.options,
                  index: target.index,
                  pinned: target.pinned,
                  sticky: target.sticky,
                  preserveFocus: true,
                  override: DEFAULT_EDITOR_ASSOCIATION.id,
                },
              },
              target.group
            )
            if (restored !== undefined && existing === undefined) {
              const failedInput = target.group.editors.find((editor) => editor.matches(replacement))
              if (failedInput !== undefined && !failedInput.isDirty()) {
                await target.group.closeEditor(failedInput, { preserveFocus: true })
              }
            }
          }
          throw error
        }
      }
      const event: ReviewDiffOpened = { iid, versionId, files: openedFiles }
      for (const listener of openedListeners) listener(event)
      const pane = await editors.openEditor(
        multiple
          ? {
              multiDiffSource: URI.from({
                scheme: REVIEW_SCHEME,
                authority: reviewAuthority('all', iid, versionId),
                path: '/',
                query: JSON.stringify(inputs.map(({ modified }) => modified.resource.toString())),
              }),
              label: typeof title === 'string' ? title : '',
              resources: inputs,
              isTransient: true,
              options: { pinned: true, preserveFocus: false, revealIfOpened: true },
            }
          : {
              ...first,
              label: `${file.path} (!${String(iid)})`,
              options: {
                pinned: false,
                preserveFocus: false,
                revealIfOpened: true,
                override: DEFAULT_EDITOR_ASSOCIATION.id,
              },
            }
      )
      if (pane === undefined) return failed('openEditor returned pane === undefined')
      return { requestId, ok: true }
    } catch (error) {
      return failed('exception while preparing or opening review diff', error)
    }
  })
}
