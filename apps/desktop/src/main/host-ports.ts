import type { OpenProjectsState } from './open-projects.js'
import type { AgentId } from '@chorus/shared'
import type {
  WorkbenchAskDiffRequest,
  WorkbenchAskDiffResult,
  WorkbenchEditRequest,
  WorkbenchEditResult,
  WorkbenchSnapshotResult,
} from '../shared/workbench-ipc.js'
import type { WorkbenchPlace } from './project-root.js'

export type SecretId =
  AgentId | 'gitlab' | 'typesafe' | 'completion-deepseek' | 'completion-codestral'

export interface EditorPort {
  hasSurface(place: WorkbenchPlace): boolean
  refreshTerminalEnv(): void
  reopenProject(place: WorkbenchPlace): void
  askDiff(
    projectRoot: string,
    request: Omit<WorkbenchAskDiffRequest, 'requestId'>
  ): Promise<WorkbenchAskDiffResult>
  edit(
    place: WorkbenchPlace,
    request: Omit<WorkbenchEditRequest, 'requestId'>
  ): Promise<WorkbenchEditResult>
  snapshot(place: WorkbenchPlace): Promise<WorkbenchSnapshotResult['snapshot'] | undefined>
  previewEdit?(
    place: WorkbenchPlace,
    request: Omit<WorkbenchEditRequest, 'requestId'> & { readonly approvalId: string }
  ): Promise<WorkbenchAskDiffResult>
}

export interface SecretsPort {
  read(id: SecretId): string | null
  isSet(id: SecretId): boolean
  write(id: SecretId, value: string): void
  clear(id: SecretId): void
}

export interface WindowPort {
  pickDirectory(options: { readonly title: string }): Promise<string | null>
  pickFiles(options: { readonly title: string }): Promise<readonly string[]>
  writeClipboard(text: string): void
  revealInFolder(path: string): void
  openExternal(url: string): Promise<void>
  notify(notice: { readonly title: string; readonly body: string }): void
  setAttentionCount(count: number): void
}

export interface HostPorts {
  readonly userDataPath: string
  readonly editor: EditorPort
  readonly secrets: SecretsPort
  readonly openProjects?: { read(): OpenProjectsState; write(state: OpenProjectsState): void }
  readonly windows: WindowPort
}
