import type { IpcRegistrar, ShellClient, ShellRequest } from './shell-client.js'
import {
  RUN_CHANNELS,
  RUN_CONTRACT,
  RUN_PUSH_CHANNEL,
  type RunChannel,
  type RunCommandsShape,
  type RunPush,
  type RunRequest,
  type RunState,
} from '../shared/run-ipc.js'
import { runAvailable, type ProjectRunner, type RunProject } from './project-run.js'
import type { DetectedScripts } from './project-scripts.js'
import type { ShellRole } from './traffic-ipc.js'

export interface RunIpcDeps {
  readonly runner: Pick<
    ProjectRunner,
    'run' | 'restart' | 'stop' | 'stopRecording' | 'snapshot' | 'subscribe'
  >
  readonly project: (projectId: string) => RunProject | null
  readonly isAdopted: (projectId: string) => boolean
  readonly setCommands: (projectId: string, commands: RunCommandsShape | null) => void
  readonly detect: (root: string) => Promise<DetectedScripts>
  readonly platform: NodeJS.Platform
}

export class RunIpc {
  private readonly shells = new Map<
    string,
    { readonly webContents: ShellClient; readonly role: ShellRole }
  >()
  private readonly deps: RunIpcDeps
  private readonly unsubscribe: () => void

  constructor(
    deps: RunIpcDeps,
    private readonly registrar: IpcRegistrar
  ) {
    this.deps = deps
    for (const channel of RUN_CHANNELS) this.register(channel)
    this.unsubscribe = deps.runner.subscribe((change) => {
      this.announce(change.projectId)
    })
  }

  registerShell(webContents: ShellClient, role: ShellRole): void {
    this.shells.set(webContents.id, { webContents, role })
  }

  releaseShell(webContents: ShellClient): void {
    this.shells.delete(webContents.id)
  }

  close(): void {
    this.unsubscribe()
    for (const channel of RUN_CHANNELS) this.registrar.removeHandler(channel)
    this.shells.clear()
  }

  private register(channel: RunChannel): void {
    this.registrar.handle(channel, async (event: ShellRequest, raw: unknown) => {
      const parsed = RUN_CONTRACT[channel].request.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Invalid request on "${channel}": ${parsed.error.message}`)
      }
      const result = await this.handle(channel, event, parsed.data)
      const checked = RUN_CONTRACT[channel].response.safeParse(result)
      if (!checked.success) {
        throw new Error(`Invalid response on "${channel}": ${checked.error.message}`)
      }
      return checked.data
    })
  }

  private handle(
    channel: RunChannel,
    event: ShellRequest,
    request: RunRequest<RunChannel>
  ): unknown {
    const role = this.role(event)
    if (role === null) throw new Error('Run is not available to this document')
    const projectId = request.projectId
    if (!this.mayInspect(role, projectId)) {
      throw new Error('That project is not this shell’s to run')
    }
    const runner = this.deps.runner

    switch (channel) {
      case 'run:state':
        return this.stateOf(projectId)
      case 'run:detect':
        return this.detect(projectId)
      case 'run:configure':
        this.deps.setCommands(projectId, (request as RunRequest<'run:configure'>).commands)
        this.announce(projectId)
        return this.stateOf(projectId)
      case 'run:start':
        return runner.run(projectId, (request as RunRequest<'run:start'>).commandId)
      case 'run:restart':
        return runner.restart(projectId)
      case 'run:stop':
        return runner.stop(projectId)
      case 'run:stopRecording':
        return runner.stopRecording(projectId)
    }
  }

  private detect(projectId: string): Promise<DetectedScripts> {
    const project = this.deps.project(projectId)
    if (project === null || !this.available(project)) {
      return Promise.reject(new Error('Run is for local projects on macOS and Linux'))
    }
    return this.deps.detect(project.canonicalRoot)
  }

  private available(project: RunProject): boolean {
    return runAvailable(project, this.deps.platform)
  }

  private stateOf(projectId: string): RunState {
    const project = this.deps.project(projectId)
    return {
      ...this.deps.runner.snapshot(projectId),
      commands: project?.runCommands ?? null,
      available: project !== null && this.available(project),
    }
  }

  private announce(projectId: string): void {
    const push: RunPush = { projectId, ...this.stateOf(projectId) }
    for (const shell of this.shells.values()) {
      if (shell.webContents.isGone() || !this.mayInspect(shell.role, projectId)) continue
      shell.webContents.send(RUN_PUSH_CHANNEL, push)
    }
  }

  private role(event: ShellRequest): ShellRole | null {
    if (!event.isMainFrame) return null
    return this.shells.get(event.sender.id)?.role ?? null
  }

  private mayInspect(role: ShellRole, projectId: string): boolean {
    if (role.kind === 'detached') return role.projectId === projectId
    return this.deps.isAdopted(projectId)
  }
}
