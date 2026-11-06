import type { IpcRequest, IpcResponse } from '../shared/ipc.js'
import type {
  WorkbenchContext,
  WorkbenchRevealRequest,
  WorkbenchRevealResult,
} from '../shared/workbench-ipc.js'
import type { HostPorts } from './host-ports.js'
import type { WorkbenchPlace } from './project-root.js'
import type { Settings } from './settings.js'
import type { ShellClient } from './shell-client.js'
import type { defaultDeps } from './ide-extension.js'
import type * as images from './note-images.js'
import type { probeAgents } from './agent-probe.js'
import type { checkTypesafeKey } from './typesafe.js'
import type { RemoteHostCheck } from './remote-workbench.js'

export interface WorkbenchContextReport {
  readonly host: string
  readonly projectRoot: string
  readonly context: WorkbenchContext
}

export interface ShellDelivery {
  clients(): readonly ShellClient[]
  focused(): ShellClient | null
}

export interface WorkbenchEvents {
  setContextSink(sink: ((report: WorkbenchContextReport) => void) | null): void
  setSurfaceGoneSink(sink: ((place: WorkbenchPlace) => void) | null): void
}

export interface IpcHost extends HostPorts, ShellDelivery, WorkbenchEvents {
  appInfo(): IpcResponse<'app:getInfo'>
  appVersion(): string
  getPath(name: 'userData' | 'desktop'): string
  pickDirectory(options: {
    readonly properties: ('openDirectory' | 'createDirectory')[]
    readonly buttonLabel: string
  }): Promise<{ canceled: boolean; filePaths: string[] }>
  target(projectId: string): ShellClient | null
  raise(client: ShellClient | null): void
  notify(request: IpcRequest<'app:notify'>): void
  probeAgents: typeof probeAgents
  checkTypesafeKey: typeof checkTypesafeKey
  checkRemoteHost(host: string): Promise<RemoteHostCheck>
  extensionDeps(): ReturnType<typeof defaultDeps>
  invalidateCompletionCredential(): void
  applyTheme(theme: Settings['theme']): void
  readonly images: Pick<
    typeof images,
    'copyNoteImageTo' | 'fetchNoteImage' | 'pickNoteImage' | 'saveNoteImage'
  >
  prepareProjectClose(place: WorkbenchPlace): Promise<void>
  closeProject(place: WorkbenchPlace): Promise<void>
  reveal(
    projectRoot: string,
    request: Omit<WorkbenchRevealRequest, 'requestId'>
  ): Promise<WorkbenchRevealResult | undefined>
}
