import { app, clipboard, dialog, shell, type BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  EditorAskDiffRequest,
  EditorEditRequest,
  EditorPlace,
  EditorReviewDiffRequest,
} from '../../../engine/src/editor-protocol.js'
import {
  ConsoleDisposeHostParams,
  ConsoleReadHostParams,
  ConsoleRunHostParams,
  SecretHostParams,
} from '../../../engine/src/host.js'
import type { WindowRole } from '../shared/detached-window-ipc.js'
import messages from '../renderer/src/i18n/en.json'
import { clearAgentKey, writeAgentKey } from './agent-secrets.js'
import type { BrowserConsoles } from './browser-console.js'
import { invalidateCompletionCredential } from './completion-client.js'
import { showDesktopNotification } from './desktop-ipc-host.js'
import { raise } from './detached-windows.js'
import { defaultDeps, openFileInEditor } from './ide-extension.js'
import { applyTheme } from './theme.js'
import {
  GITLAB_WORKFLOW_SECRET,
  importableGitLabToken,
  readWorkbenchSecret,
} from './workbench-secrets.js'
import {
  closeWorkbenchProject,
  prepareWorkbenchProjectClose,
  refreshWorkbenchTerminalEnv,
  reopenWorkbenchProject,
  requestWorkbenchAskDiff,
  requestWorkbenchEdit,
  requestWorkbenchReveal,
  requestWorkbenchReviewDiff,
  requestWorkbenchSnapshot,
} from './workbench-surface.js'

interface DesktopHostCalls {
  readonly windowFor: (role: WindowRole) => BrowserWindow | null
  readonly consoles: () => BrowserConsoles | null
  readonly refreshTerminalEnv: () => Promise<void>
}

const ObjectParams = z.record(z.string(), z.unknown())
const FileRequest = z.object({
  path: z.string(),
  line: z.number().nullable().optional(),
  column: z.number().nullable().optional(),
  place: EditorPlace.optional(),
})
let configured: DesktopHostCalls | null = null

export function configureDesktopHostCalls(deps: DesktopHostCalls): void {
  configured = deps
}

export async function answerEngineHostCall(
  role: WindowRole,
  method: string,
  raw: unknown
): Promise<unknown> {
  const deps = configured
  if (deps === null) throw new Error(messages.extension.channelRefused)
  const params = ObjectParams.parse(raw)
  switch (method) {
    case 'pickDirectory':
    case 'pickFiles': {
      const { title, buttonLabel, createDirectory } = z
        .object({
          title: z.string(),
          buttonLabel: z.string().optional(),
          createDirectory: z.boolean().optional(),
        })
        .parse(params)
      const window = deps.windowFor(role)
      if (window === null || window.isDestroyed()) {
        throw new Error(messages.extension.channelRefused)
      }
      const picked = await dialog.showOpenDialog(window, {
        title,
        ...(buttonLabel === undefined ? {} : { buttonLabel }),
        properties:
          method === 'pickDirectory'
            ? createDirectory === true
              ? ['openDirectory', 'createDirectory']
              : ['openDirectory']
            : ['openFile', 'multiSelections'],
      })
      return method === 'pickDirectory'
        ? picked.canceled
          ? null
          : (picked.filePaths[0] ?? null)
        : picked.canceled
          ? []
          : picked.filePaths
    }
    case 'clipboard':
      clipboard.writeText(z.string().parse(params['text']))
      return true
    case 'revealInFolder':
      shell.showItemInFolder(z.string().parse(params['path']))
      return true
    case 'openExternal':
      await shell.openExternal(z.string().parse(params['url']))
      return true
    case 'notify': {
      const request = z.object({ title: z.string(), body: z.string() }).parse(params)
      showDesktopNotification(request, () => deps.windowFor(role))
      return true
    }
    case 'attention':
      app.setBadgeCount(z.number().int().nonnegative().parse(params['count']))
      return true
    case 'secret': {
      const { id, value, revision } = SecretHostParams.parse(params)
      const userData = app.getPath('userData')
      const acknowledged =
        value === null
          ? clearAgentKey(userData, id, revision)
          : writeAgentKey(userData, id, value, revision)
      invalidateCompletionCredential()
      return acknowledged
    }
    case 'gitlab.importWorkbenchToken':
      return importableGitLabToken(
        readWorkbenchSecret(app.getPath('userData'), GITLAB_WORKFLOW_SECRET),
        'https://gitlab.com'
      )
    case 'reveal':
      raise(deps.windowFor(role))
      return true
    case 'openFile': {
      const { path, line, column, place } = FileRequest.parse(params)
      if (place !== undefined) {
        const revealed = await requestWorkbenchReveal(place.root, {
          path,
          line: line ?? null,
          column: column ?? null,
        })
        if (revealed !== undefined) return revealed.ok
      }
      const location = column === null || column === undefined ? '' : `:${String(column)}`
      const goto = line === null || line === undefined ? path : `${path}:${String(line)}${location}`
      return (await openFileInEditor(goto, defaultDeps())).ok
    }
    case 'editor.askDiff': {
      const place = EditorPlace.parse(params['place'])
      const { close, revealPath, ...request } = EditorAskDiffRequest.parse(params['request'])
      return await requestWorkbenchAskDiff(place.root, {
        ...request,
        ...(close === undefined ? {} : { close }),
        ...(revealPath === undefined ? {} : { revealPath }),
      })
    }
    case 'editor.openReviewDiff': {
      const place = EditorPlace.parse(params['place'])
      return await requestWorkbenchReviewDiff(
        place.root,
        EditorReviewDiffRequest.parse(params['request'])
      )
    }
    case 'editor.edit':
      return await requestWorkbenchEdit(
        EditorPlace.parse(params['place']),
        EditorEditRequest.parse(params['request'])
      )
    case 'editor.snapshot':
      return await requestWorkbenchSnapshot(EditorPlace.parse(params['place']))
    case 'editor.previewEdit': {
      const request = EditorEditRequest.extend({ approvalId: z.string() }).parse(params['request'])
      return {
        requestId: request.requestId,
        ok: false,
        message: messages.extension.editorUnavailable,
      }
    }
    case 'editor.refreshTerminalEnv':
      await deps.refreshTerminalEnv()
      refreshWorkbenchTerminalEnv()
      return true
    case 'editor.reopenProject':
      reopenWorkbenchProject(EditorPlace.parse(params['place']))
      return true
    case 'editor.prepareProjectClose':
      await prepareWorkbenchProjectClose(EditorPlace.parse(params['place']))
      return true
    case 'editor.closeProject':
      await closeWorkbenchProject(EditorPlace.parse(params['place']))
      return true
    case 'applyTheme':
      applyTheme(z.enum(['system', 'light', 'dark']).parse(params['theme']))
      return true
    case 'console.read':
    case 'console.run':
    case 'console.dispose': {
      const request =
        method === 'console.read'
          ? ConsoleReadHostParams.parse(params)
          : method === 'console.run'
            ? ConsoleRunHostParams.parse(params)
            : ConsoleDisposeHostParams.parse(params)
      if (role.kind === 'detached' && role.projectId !== request.projectId) {
        throw new Error(messages.extension.channelRefused)
      }
      const consoles = deps.consoles()
      if (consoles === null) throw new Error(messages.extension.channelRefused)
      if (method === 'console.read') {
        const { projectId, request: read } = ConsoleReadHostParams.parse(request)
        return consoles.read(projectId, {
          count: read.count,
          skip: read.skip,
          ...(read.levels === undefined ? {} : { levels: read.levels }),
        })
      }
      if (method === 'console.run') {
        const { projectId, request: run } = ConsoleRunHostParams.parse(request)
        return await consoles.run(projectId, run)
      }
      consoles.dispose(request.projectId)
      return true
    }
    default:
      throw new Error(messages.extension.channelRefused)
  }
}
