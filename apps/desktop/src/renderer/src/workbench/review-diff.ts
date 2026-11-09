import { getService } from '@codingame/monaco-vscode-api'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { DEFAULT_EDITOR_ASSOCIATION } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor'
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

export function serveReviewDiff(log: (message: string) => void): void {
  window.chorusWorkbench.onReviewDiffRequest(async (raw): Promise<WorkbenchReviewDiffResult> => {
    const request = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const requestId = typeof request['requestId'] === 'string' ? request['requestId'] : ''
    const iid = request['iid']
    const versionId = request['versionId']
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
      requested === null ||
      (multiple && (typeof title !== 'string' || title === ''))
    ) {
      return failed('invalid review diff request')
    }

    try {
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
      const editors = await getService(IEditorService)
      describeInput = () => {
        const input = editors.activeEditor
        return `type=${input?.typeId ?? 'none'}, editor=${input?.editorId ?? 'none'}`
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
                pinned: true,
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
