import type { IpcRegistrar, ShellClient, ShellRequest } from './shell-client.js'
import type { z } from 'zod'
import {
  BROWSER_CHANNELS,
  BROWSER_CONTRACT,
  BROWSER_PUSH_CHANNEL,
  BrowserPush,
  type BrowserChannel,
} from '../shared/browser-ipc.js'
import type { BrowserSurfacePort, BrowserDownloadPort } from './browser-port.js'
import type { ShellRole } from './traffic-ipc.js'
import type { BrowserStreamPort } from './browser-stream-port.js'

interface Deps {
  readonly streams?: BrowserStreamPort
  readonly surfaces: BrowserSurfacePort
  readonly downloads: BrowserDownloadPort
  readonly isAdopted: (projectId: string) => boolean
}

interface Shell {
  readonly webContents: ShellClient
  readonly role: ShellRole
}

export class BrowserIpc {
  private readonly deps: Deps
  private readonly shells = new Map<string, Shell>()

  constructor(
    deps: Deps,
    private readonly registrar: IpcRegistrar
  ) {
    this.deps = deps
    const { surfaces, streams } = deps
    this.handle('browser:stream', BROWSER_CONTRACT['browser:stream'], (owner, request) => {
      if (streams === undefined) throw new Error('not-eligible')
      streams.stream(owner, request)
      return { ok: true as const }
    })
    this.handle('browser:input', BROWSER_CONTRACT['browser:input'], async (owner, request) => {
      if (streams === undefined) throw new Error('not-eligible')
      await streams.input(owner, request.browserId, request.event)
      return { ok: true as const }
    })
    this.handle('browser:frameAck', BROWSER_CONTRACT['browser:frameAck'], (owner, request) => {
      if (streams === undefined) throw new Error('not-eligible')
      streams.ack(owner, request.browserId, request.instance, request.generation, request.serial)
      return { ok: true as const }
    })
    this.handle(
      'browser:selectChoose',
      BROWSER_CONTRACT['browser:selectChoose'],
      async (owner, request) => {
        if (streams === undefined) throw new Error('not-eligible')
        await streams.chooseSelect(owner, request.browserId, request.token, request.index)
        return { ok: true as const }
      }
    )
    this.handle(
      'browser:dialogAnswer',
      BROWSER_CONTRACT['browser:dialogAnswer'],
      async (owner, request) => {
        if (streams === undefined) throw new Error('not-eligible')
        await streams.answerDialog(
          owner,
          request.browserId,
          request.token,
          request.accept,
          request.text
        )
        return { ok: true as const }
      }
    )
    this.handle(
      'browser:selection',
      BROWSER_CONTRACT['browser:selection'],
      async (owner, request) => {
        if (streams === undefined) throw new Error('not-eligible')
        return { text: await streams.selection(owner, request.browserId) }
      }
    )
    this.handle(
      'browser:webReady',
      BROWSER_CONTRACT['browser:webReady'],
      (owner, _request, role) => {
        if (role.kind !== 'main') throw new Error('Web tabs open only in the main window')
        return surfaces.webReady(owner)
      }
    )
    this.handle('browser:attach', BROWSER_CONTRACT['browser:attach'], (owner, request, role) => {
      if ('webTabId' in request) {
        if (role.kind !== 'main') throw new Error('Web tabs open only in the main window')
        return surfaces.attachWebTab(owner, request.webTabId)
      }
      if (!this.mayAttach(role, request.projectId)) {
        throw new Error('This window may not open a browser for that project')
      }
      return surfaces.attach(owner, request.projectId)
    })
    this.handle('browser:detach', BROWSER_CONTRACT['browser:detach'], (owner, request) =>
      surfaces.detach(owner, request.browserId)
    )
    this.handle('browser:restore', BROWSER_CONTRACT['browser:restore'], (owner, request) =>
      surfaces.restore(owner, request.browserId)
    )
    this.handle('browser:navigate', BROWSER_CONTRACT['browser:navigate'], (owner, request) =>
      surfaces.navigate(owner, request.browserId, request.address)
    )
    this.handle('browser:action', BROWSER_CONTRACT['browser:action'], (owner, request) =>
      surfaces.act(owner, request.browserId, request.action)
    )
    this.handle('browser:find', BROWSER_CONTRACT['browser:find'], (owner, request) =>
      surfaces.find(owner, request.browserId, request.text, request.forward, request.start)
    )
    this.handle('browser:close', BROWSER_CONTRACT['browser:close'], (owner, request) =>
      surfaces.close(owner, request.browserId, request.index)
    )
    this.handle('browser:reopen', BROWSER_CONTRACT['browser:reopen'], (owner, _request, role) => {
      if (role.kind !== 'main') throw new Error('Web tabs open only in the main window')
      return surfaces.reopen(owner)
    })
    this.handle('browser:downloads', BROWSER_CONTRACT['browser:downloads'], (owner) => ({
      downloads: this.deps.downloads.list(owner),
    }))
    this.handle('browser:download', BROWSER_CONTRACT['browser:download'], (owner, request) => {
      const failure = this.deps.downloads.act(owner, request.downloadId, request.action)
      return { downloads: this.deps.downloads.list(owner), failure }
    })
    this.handle('browser:geometry', BROWSER_CONTRACT['browser:geometry'], (owner, request) =>
      surfaces.geometry(owner, request)
    )
    this.handle(
      'browser:devtoolsGeometry',
      BROWSER_CONTRACT['browser:devtoolsGeometry'],
      (owner, request) => surfaces.devtoolsGeometry(owner, request)
    )
    this.handle('browser:favoriteAdd', BROWSER_CONTRACT['browser:favoriteAdd'], (owner, request) =>
      surfaces.addFavorite(owner, request.browserId)
    )
    this.handle(
      'browser:favoriteRemove',
      BROWSER_CONTRACT['browser:favoriteRemove'],
      (owner, request) => surfaces.removeFavorite(owner, request.browserId, request.favoriteId)
    )
    this.handle(
      'browser:favoriteOpen',
      BROWSER_CONTRACT['browser:favoriteOpen'],
      (owner, request) => surfaces.openFavorite(owner, request.browserId, request.favoriteId)
    )
    this.handle('browser:passwords', BROWSER_CONTRACT['browser:passwords'], (owner, request) =>
      surfaces.passwords(owner, request.browserId)
    )
    this.handle(
      'browser:passwordDecide',
      BROWSER_CONTRACT['browser:passwordDecide'],
      (owner, request) =>
        surfaces.decide(owner, request.browserId, request.candidateId, request.decision)
    )
    this.handle(
      'browser:passwordFill',
      BROWSER_CONTRACT['browser:passwordFill'],
      (owner, request) =>
        surfaces.fill(owner, request.browserId, request.accountId, request.documentId)
    )
    this.handle(
      'browser:passwordRemove',
      BROWSER_CONTRACT['browser:passwordRemove'],
      (owner, request) => surfaces.removePassword(owner, request.browserId, request.accountId)
    )
    this.handle(
      'browser:passwordAllow',
      BROWSER_CONTRACT['browser:passwordAllow'],
      (owner, request) => surfaces.allowPasswords(owner, request.browserId)
    )
  }

  registerShell(webContents: ShellClient, role: ShellRole): void {
    this.shells.set(webContents.id, { webContents, role })
  }

  releaseShell(webContents: ShellClient): void {
    this.deps.streams?.release(webContents)
    this.shells.delete(webContents.id)
    void Promise.resolve(this.deps.surfaces.closeOwner(webContents)).catch(() => undefined)
  }

  deliver(owner: ShellClient, push: BrowserPush): void {
    if (owner.isGone() || this.shells.get(owner.id)?.webContents !== owner) return
    const parsed = BrowserPush.safeParse(push)
    if (parsed.success) owner.send(BROWSER_PUSH_CHANNEL, parsed.data)
  }

  async close(): Promise<void> {
    for (const channel of BROWSER_CHANNELS) this.registrar.removeHandler(channel)
    this.shells.clear()
    await this.deps.surfaces.shutdown()
  }

  private handle<Q extends z.ZodType, R extends z.ZodType>(
    channel: BrowserChannel,
    contract: { readonly request: Q; readonly response: R },
    handler: (
      owner: ShellClient,
      request: z.output<Q>,
      role: ShellRole
    ) => Promise<z.output<R>> | z.output<R>
  ): void {
    this.registrar.handle(channel, async (event: ShellRequest, raw: unknown) => {
      const role = this.role(event)
      if (role === null) throw new Error('The browser is not available to this document')
      const parsed = contract.request.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Invalid request on "${channel}": ${parsed.error.message}`)
      }
      const result: unknown = await handler(event.sender, parsed.data, role)
      const checked = contract.response.safeParse(result)
      if (!checked.success) {
        throw new Error(`Invalid response on "${channel}": ${checked.error.message}`)
      }
      return checked.data
    })
  }

  private role(event: ShellRequest): ShellRole | null {
    if (!event.isMainFrame) return null
    const shell = this.shells.get(event.sender.id)
    return shell?.webContents === event.sender ? shell.role : null
  }

  private mayAttach(role: ShellRole, projectId: string): boolean {
    if (role.kind === 'detached') return role.projectId === projectId
    return this.deps.isAdopted(projectId)
  }
}
