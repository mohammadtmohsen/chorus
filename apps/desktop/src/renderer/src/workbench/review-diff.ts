import { getService } from '@codingame/monaco-vscode-api'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { IFileService } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files.service'
import { ILanguageService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages/language.service'
import { IWorkspaceContextService } from '@codingame/monaco-vscode-api/vscode/vs/platform/workspace/common/workspace.service'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import {
  RegisteredFileSystemProvider,
  RegisteredReadOnlyFile,
} from '@codingame/monaco-vscode-files-service-override'
import type {
  WorkbenchReviewDiffFile,
  WorkbenchReviewDiffResult,
} from '../../../shared/workbench-ipc.js'

export const REVIEW_SCHEME = 'chorus-review'
const resources = new Set<string>()

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
let provider: RegisteredFileSystemProvider | null = null

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

export function serveReviewDiff(): void {
  window.chorusWorkbench.onReviewDiffRequest(async (raw): Promise<WorkbenchReviewDiffResult> => {
    const request = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const requestId = typeof request['requestId'] === 'string' ? request['requestId'] : ''
    const iid = request['iid']
    const versionId = request['versionId']
    const requested = reviewFilesOf(request)
    const multiple = request['files'] !== undefined
    const title = request['title']
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
      return { requestId, ok: false, failure: 'open-failed' }
    }

    try {
      const files = await getService(IFileService)
      if (provider === null) {
        const next = new RegisteredFileSystemProvider(true)
        files.registerProvider(REVIEW_SCHEME, next)
        provider = next
      }
      const registered = provider
      const languages = await getService(ILanguageService)
      const context = await getService(IWorkspaceContextService)
      const root = context.getWorkspace().folders[0]?.uri
      if (root === undefined && requested.some((file) => file.workspace)) {
        return { requestId, ok: false, failure: 'open-failed' }
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
          registered.registerFile(
            new RegisteredReadOnlyFile(resource, () => Promise.resolve(bytes), bytes.byteLength)
          )
          resources.add(key)
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
        return { requestId, ok: false, failure: 'open-failed' }
      }
      const editors = await getService(IEditorService)
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
              options: { pinned: true, preserveFocus: false, revealIfOpened: true },
            }
      )
      if (pane === undefined) return { requestId, ok: false, failure: 'open-failed' }
      const event: ReviewDiffOpened = { iid, versionId, files: openedFiles }
      for (const listener of openedListeners) listener(event)
      return { requestId, ok: true }
    } catch (error) {
      return {
        requestId,
        ok: false,
        failure: 'open-failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })
}
