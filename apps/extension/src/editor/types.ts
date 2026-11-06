import type { IpcResponse } from '../../../desktop/src/shared/ipc.js'
import type { DiagnosticParams } from '@chorus/ide-protocol/protocol'
import type { WorkbenchContextReport } from '../../../desktop/src/main/ipc-host.js'
import type { WorkbenchPlace } from '../../../desktop/src/main/project-root.js'

export type EditorProject = IpcResponse<'project:list'>['projects'][number]

export interface EditorMessages {
  readonly outsideProject: string
  readonly untrusted: string
  readonly unavailable: string
  readonly editVersionConflict: string
  readonly editTextConflict: string
  readonly editInvalidRange: string
  readonly editFailed: string
  readonly diffFailed: string
  readonly openFailed: string
  readonly previewFailed: string
  readonly previewUnsupported: string
  readonly previewTitle: (path: string) => string
  readonly diagnosticNoEditor: string
  readonly diagnosticUnsupported: string
  readonly diagnosticNotFound: string
  readonly diagnosticSent: string
  readonly diagnosticFailed: string
}

export interface EditorIntegrationOptions {
  readonly projects: () => readonly EditorProject[]
  readonly focusedProject: () => string | null
  readonly activate: (projectId: string) => void
  readonly report: (report: WorkbenchContextReport) => void
  readonly diagnostic: (projectId: string, params: DiagnosticParams) => Promise<void>
  readonly log: (message: string) => void
  readonly messages: EditorMessages
}

export interface OpenFileRequest {
  readonly path: string
  readonly line?: number | null
  readonly column?: number | null
  readonly place?: WorkbenchPlace
}
