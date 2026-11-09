import type { IpcRegistrar, ShellClient, ShellRequest } from './shell-client.js'
import { GIT_CHANNELS, GIT_CONTRACT, type GitChannel, type GitRequest } from '../shared/git-ipc.js'
import type { GitBoxService } from './git-box.js'
import type { ShellRole } from './traffic-ipc.js'

export interface GitIpcDeps {
  readonly service: Pick<
    GitBoxService,
    | 'state'
    | 'requests'
    | 'review'
    | 'viewed'
    | 'openDiff'
    | 'openAllDiffs'
    | 'fetch'
    | 'sync'
    | 'checkout'
  >
  readonly isAdopted: (projectId: string) => boolean
}

export class GitIpc {
  private readonly shells = new Map<
    string,
    { readonly webContents: ShellClient; readonly role: ShellRole }
  >()

  constructor(
    private readonly deps: GitIpcDeps,
    private readonly registrar: IpcRegistrar
  ) {
    for (const channel of GIT_CHANNELS) this.register(channel)
  }

  registerShell(webContents: ShellClient, role: ShellRole): void {
    this.shells.set(webContents.id, { webContents, role })
  }

  releaseShell(webContents: ShellClient): void {
    this.shells.delete(webContents.id)
  }

  close(): void {
    for (const channel of GIT_CHANNELS) this.registrar.removeHandler(channel)
    this.shells.clear()
  }

  private register(channel: GitChannel): void {
    this.registrar.handle(channel, async (event: ShellRequest, raw: unknown) => {
      const parsed = GIT_CONTRACT[channel].request.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Invalid request on "${channel}": ${parsed.error.message}`)
      }
      const result = await this.handle(channel, event, parsed.data)
      const checked = GIT_CONTRACT[channel].response.safeParse(result)
      if (!checked.success) {
        throw new Error(`Invalid response on "${channel}": ${checked.error.message}`)
      }
      return checked.data
    })
  }

  private handle(
    channel: GitChannel,
    event: ShellRequest,
    request: GitRequest<GitChannel>
  ): unknown {
    const role = this.role(event)
    if (role === null) throw new Error('Git is not available to this document')
    const projectId = request.projectId
    if (!this.mayInspect(role, projectId)) {
      throw new Error('That project is not this shell’s to inspect')
    }
    switch (channel) {
      case 'git:state':
        return this.deps.service.state(projectId)
      case 'git:requests':
        return this.deps.service.requests(projectId)
      case 'git:review':
        return this.deps.service.review(projectId, (request as GitRequest<'git:review'>).iid)
      case 'git:viewed':
        return this.deps.service.viewed(request as GitRequest<'git:viewed'>)
      case 'git:openDiff':
        return this.deps.service.openDiff(request as GitRequest<'git:openDiff'>)
      case 'git:openAllDiffs':
        return this.deps.service.openAllDiffs(request as GitRequest<'git:openAllDiffs'>)
      case 'git:fetch':
        return this.deps.service.fetch(projectId)
      case 'git:sync':
        return this.deps.service.sync(projectId)
      case 'git:checkout':
        return this.deps.service.checkout(projectId, (request as GitRequest<'git:checkout'>).target)
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
