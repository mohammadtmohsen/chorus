import { randomUUID } from 'node:crypto'
import type { IpcRegistrar, ShellClient, ShellRequest } from './shell-client.js'
import type { z } from 'zod'
import {
  CONSOLE_CHANNELS,
  CONSOLE_CONTRACT,
  CONSOLE_PUSH_CHANNEL,
  ConsolePush,
  type ConsoleChannel,
  type ConsoleResponse,
} from '../shared/console-ipc.js'
import {
  CONSOLE_HUMAN_TIMEOUT_MS,
  type BrowserConsoles,
  type ConsoleServiceEvent,
} from './browser-console.js'
import type { ShellRole } from './traffic-ipc.js'

const PENDING_LIMIT = 64
const PENDING_BYTES = 512 * 1_024
const SUBSCRIPTIONS_PER_DOCUMENT = 16

const bytesOf = (push: ConsolePush): number => Buffer.byteLength(JSON.stringify(push), 'utf8')

interface Deps {
  readonly consoles: BrowserConsoles
  readonly isAdopted: (projectId: string) => boolean
}

interface Shell {
  readonly webContents: ShellClient
  readonly role: ShellRole
}

interface Subscription {
  readonly id: string
  readonly webContents: ShellClient
  readonly projectId: string
  pending: ConsolePush[]
  pendingBytes: number
  outstanding: boolean
}

export class ConsoleIpc {
  private readonly deps: Deps
  private readonly shells = new Map<string, Shell>()
  private readonly watched = new WeakSet<ShellClient>()
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly byDocument = new Map<string, Map<string, string>>()
  private readonly stop: () => void

  constructor(
    deps: Deps,
    private readonly registrar: IpcRegistrar
  ) {
    this.deps = deps
    const contract = CONSOLE_CONTRACT
    this.handle('console:subscribe', contract['console:subscribe'], (event, request, role) =>
      this.subscribe(event, role, request.projectId)
    )
    this.handle('console:unsubscribe', contract['console:unsubscribe'], (event, request) =>
      this.unsubscribe(event, request.subscriptionId)
    )
    this.handle('console:ack', contract['console:ack'], (event, request) =>
      this.ack(event, request.subscriptionId)
    )
    this.handle('console:snapshot', contract['console:snapshot'], (event, request, role) =>
      this.resync(event, role, request.subscriptionId)
    )
    this.handle('console:evaluate', contract['console:evaluate'], (event, request, role) => {
      this.authorize(role, request.projectId)
      const launch = this.deps.consoles.evaluate({
        projectId: request.projectId,
        browserId: request.browserId,
        owner: event.sender,
        expression: request.expression,
        actor: 'user',
        timeoutMs: CONSOLE_HUMAN_TIMEOUT_MS,
      })
      return { commandId: launch.commandId, status: launch.status }
    })
    this.handle('console:expand', contract['console:expand'], (_event, request, role) => {
      this.authorize(role, request.projectId)
      return this.deps.consoles.expand(request.projectId, request.handle)
    })
    this.handle('console:clear', contract['console:clear'], (_event, request, role) => {
      this.authorize(role, request.projectId)
      this.deps.consoles.clear(request.projectId)
      return { ok: true as const }
    })
    this.stop = deps.consoles.subscribe((event) => {
      this.deliver(event)
    })
  }

  registerShell(webContents: ShellClient, role: ShellRole): void {
    this.shells.set(webContents.id, { webContents, role })
    if (this.watched.has(webContents)) return
    this.watched.add(webContents)
    webContents.onGone(() => {
      this.revoke(webContents.id)
    })
  }

  releaseShell(webContents: ShellClient): void {
    this.shells.delete(webContents.id)
    this.revoke(webContents.id)
  }

  close(): void {
    this.stop()
    for (const channel of CONSOLE_CHANNELS) this.registrar.removeHandler(channel)
    this.shells.clear()
    this.subscriptions.clear()
    this.byDocument.clear()
  }

  private handle<Q extends z.ZodType, R extends z.ZodType>(
    channel: ConsoleChannel,
    contract: { readonly request: Q; readonly response: R },
    handler: (
      event: ShellRequest,
      request: z.output<Q>,
      role: ShellRole
    ) => Promise<z.output<R>> | z.output<R>
  ): void {
    this.registrar.handle(channel, async (event: ShellRequest, raw: unknown) => {
      const role = this.role(event)
      if (role === null) throw new Error('The console is not available to this document')
      const parsed = contract.request.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Invalid request on "${channel}": ${parsed.error.message}`)
      }
      const result: unknown = await handler(event, parsed.data, role)
      const checked = contract.response.safeParse(result)
      if (!checked.success) {
        throw new Error(`Invalid response on "${channel}": ${checked.error.message}`)
      }
      return checked.data
    })
  }

  private subscribe(
    event: ShellRequest,
    role: ShellRole,
    projectId: string
  ): ConsoleResponse<'console:subscribe'> {
    this.authorize(role, projectId)
    const document = event.sender.id
    const projects = this.byDocument.get(document) ?? new Map<string, string>()
    const previous = projects.get(projectId)
    if (previous === undefined && projects.size >= SUBSCRIPTIONS_PER_DOCUMENT) {
      throw new Error('Too many consoles are open in this window')
    }
    if (previous !== undefined) this.subscriptions.delete(previous)
    const snapshot = this.deps.consoles.snapshot(projectId)
    const id = randomUUID()
    this.subscriptions.set(id, {
      id,
      webContents: event.sender,
      projectId,
      pending: [],
      pendingBytes: 0,
      outstanding: true,
    })
    projects.set(projectId, id)
    this.byDocument.set(document, projects)
    return { subscriptionId: id, snapshot }
  }

  private unsubscribe(
    event: ShellRequest,
    subscriptionId: string
  ): ConsoleResponse<'console:unsubscribe'> {
    const subscription = this.own(event, subscriptionId)
    if (subscription !== null) this.drop(subscription)
    return { ok: true }
  }

  private ack(event: ShellRequest, subscriptionId: string): ConsoleResponse<'console:ack'> {
    const subscription = this.own(event, subscriptionId)
    if (subscription === null) return { ok: true }
    subscription.outstanding = false
    this.flush(subscription)
    return { ok: true }
  }

  private resync(
    event: ShellRequest,
    role: ShellRole,
    subscriptionId: string
  ): ConsoleResponse<'console:snapshot'> {
    const subscription = this.own(event, subscriptionId)
    if (subscription === null) throw new Error('That console subscription is not open')
    this.authorize(role, subscription.projectId)
    subscription.outstanding = true
    const snapshot = this.deps.consoles.snapshot(subscription.projectId)
    subscription.pending = []
    subscription.pendingBytes = 0
    return { snapshot }
  }

  private deliver(event: ConsoleServiceEvent): void {
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.projectId !== event.projectId) continue
      this.enqueue(subscription, this.toPush(event, subscription))
    }
  }

  private toPush(event: ConsoleServiceEvent, subscription: Subscription): ConsolePush {
    const subscriptionId = subscription.id
    switch (event.kind) {
      case 'entries':
        return {
          kind: 'entries',
          subscriptionId,
          projectId: event.projectId,
          epoch: event.epoch,
          entries: [...event.entries],
          dropped: event.dropped,
        }
      case 'state':
        return {
          kind: 'state',
          subscriptionId,
          projectId: event.projectId,
          sources: [...event.sources],
          dropped: event.dropped,
        }
      case 'cleared':
        return { kind: 'cleared', subscriptionId, projectId: event.projectId, epoch: event.epoch }
    }
  }

  private resyncOf(subscription: Subscription): ConsolePush {
    return { kind: 'resync', subscriptionId: subscription.id, projectId: subscription.projectId }
  }

  private enqueue(subscription: Subscription, push: ConsolePush): void {
    if (subscription.webContents.isGone()) {
      this.drop(subscription)
      return
    }
    const checked = ConsolePush.safeParse(push)
    const next = checked.success ? checked.data : this.resyncOf(subscription)
    const size = bytesOf(next)
    if (
      next.kind === 'resync' ||
      subscription.pending.length >= PENDING_LIMIT ||
      subscription.pendingBytes + size > PENDING_BYTES
    ) {
      if (subscription.pending[0]?.kind !== 'resync') {
        subscription.pending = [this.resyncOf(subscription)]
        subscription.pendingBytes = 0
      }
      this.flush(subscription)
      return
    }
    subscription.pending.push(next)
    subscription.pendingBytes += size
    this.flush(subscription)
  }

  private flush(subscription: Subscription): void {
    if (subscription.outstanding || subscription.pending.length === 0) return
    if (subscription.webContents.isGone()) {
      this.drop(subscription)
      return
    }
    const next = subscription.pending.shift()
    if (next === undefined) return
    subscription.pendingBytes = Math.max(0, subscription.pendingBytes - bytesOf(next))
    subscription.outstanding = true
    subscription.webContents.send(CONSOLE_PUSH_CHANNEL, next)
  }

  private drop(subscription: Subscription): void {
    this.subscriptions.delete(subscription.id)
    const document = subscription.webContents.id
    const projects = this.byDocument.get(document)
    if (projects?.get(subscription.projectId) === subscription.id) {
      projects.delete(subscription.projectId)
    }
    if (projects?.size === 0) this.byDocument.delete(document)
  }

  private revoke(document: string): void {
    const projects = this.byDocument.get(document)
    if (projects === undefined) return
    this.byDocument.delete(document)
    for (const subscriptionId of projects.values()) this.subscriptions.delete(subscriptionId)
  }

  private own(event: ShellRequest, subscriptionId: string): Subscription | null {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription?.webContents !== event.sender) return null
    return subscription
  }

  private role(event: ShellRequest): ShellRole | null {
    if (!event.isMainFrame) return null
    const shell = this.shells.get(event.sender.id)
    return shell?.webContents === event.sender ? shell.role : null
  }

  private authorize(role: ShellRole, projectId: string): void {
    const allowed =
      role.kind === 'detached' ? role.projectId === projectId : this.deps.isAdopted(projectId)
    if (!allowed) throw new Error('That project is not this shell’s to inspect')
  }
}
