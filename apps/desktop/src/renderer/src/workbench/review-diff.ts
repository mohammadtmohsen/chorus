import { getService } from '@codingame/monaco-vscode-api'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { IFileService } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files.service'
import { ILanguageService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages/language.service'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import {
  RegisteredFileSystemProvider,
  RegisteredReadOnlyFile,
} from '@codingame/monaco-vscode-files-service-override'
import type {
  WorkbenchReviewDiffFile,
  WorkbenchReviewDiffResult,
} from '../../../shared/workbench-ipc.js'

const SCHEME = 'chorus-review'
const resources = new Set<string>()
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
    typeof file['after'] === 'string'
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
        files.registerProvider(SCHEME, next)
        provider = next
      }
      const registered = provider
      const languages = await getService(ILanguageService)
      const inputs = requested.map(({ path, oldPath, before, after }) => {
        const original = URI.from({
          scheme: SCHEME,
          authority: `original-${String(iid)}-${String(versionId)}`,
          path: `/${oldPath}`,
        })
        const modified = URI.from({
          scheme: SCHEME,
          authority: `modified-${String(iid)}-${String(versionId)}`,
          path: `/${path}`,
        })
        for (const [resource, text] of [
          [original, before],
          [modified, after],
        ] as const) {
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
                scheme: SCHEME,
                authority: `all-${String(iid)}-${String(versionId)}`,
                path: '/',
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
      return pane === undefined
        ? { requestId, ok: false, failure: 'open-failed' }
        : { requestId, ok: true }
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
