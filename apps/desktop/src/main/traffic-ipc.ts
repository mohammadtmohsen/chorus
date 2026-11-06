import { randomUUID } from 'node:crypto'
import type { IpcRegistrar, ShellClient, ShellRequest } from './shell-client.js'
import type { TrafficSourceShape } from '../shared/ipc.js'
import {
  TRAFFIC_CHANNELS,
  TRAFFIC_CONTRACT,
  TRAFFIC_LIVE_PUSH_CHANNEL,
  TRAFFIC_PUSH_CHANNEL,
  type TrafficBodyReadRequest,
  type TrafficChannel,
  type TrafficDetailRequest,
  type TrafficDetailResult,
  type TrafficLegacy,
  type TrafficPush,
  type TrafficReadResult,
  type TrafficRequest,
} from '../shared/traffic-ipc.js'
import type {
  ProjectTrafficPush,
  ProjectTrafficRegistry,
  ProjectTrafficState,
} from './project-traffic.js'

const PENDING_LIMIT = 64
const PENDING_BYTES = 256 * 1_024
const DELIVERY_BYTES = 64 * 1_024

const bytesOf = (push: TrafficPush): number => Buffer.byteLength(JSON.stringify(push), 'utf8')

/**
 * Splits a rows delivery that is over the per-delivery cap.
 *
 * The count bound alone is not a byte bound: sixty-four deliveries of a
 * thousand rows each is a megabyte in flight to a renderer that may be busy
 * painting it. Halving a batch is honest — the second half is still queued, and
 * its rows carry the same sequence numbers, so the view ends up identical.
 */
const splitDelivery = (push: TrafficPush): { head: TrafficPush; rest: TrafficPush | null } => {
  if (push.kind !== 'rows' || bytesOf(push) <= DELIVERY_BYTES) return { head: push, rest: null }
  const half = Math.max(1, Math.floor(push.rows.length / 2))
  const head = push.rows.slice(0, half)
  return {
    head: { ...push, seq: Math.max(...head.map((row) => row.seq)), rows: head },
    rest: { ...push, rows: push.rows.slice(half) },
  }
}

export type ShellRole =
  { readonly kind: 'main' } | { readonly kind: 'detached'; readonly projectId: string }

/** The channels that act on a project, as opposed to the ones that read or subscribe. */
type TrafficAction =
  'traffic:start' | 'traffic:stop' | 'traffic:clear' | 'traffic:configure' | 'traffic:selectSource'

interface Subscription {
  readonly id: string
  readonly webContents: ShellClient
  readonly projectId: string
  pending: TrafficPush[]
  pendingBytes: number
  outstanding: boolean
}

interface Deps {
  readonly registry: ProjectTrafficRegistry
  readonly isAdopted: (projectId: string) => boolean
  readonly legacy: () => TrafficLegacy
  readonly decideLegacy: (keep: boolean) => void
  readonly capture?: (projectId: string, change: 'start' | 'stop') => Promise<ProjectTrafficState>
}

export class TrafficIpc {
  private readonly shells = new Map<
    string,
    { readonly webContents: ShellClient; readonly role: ShellRole }
  >()
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly byDocument = new Map<string, Map<string, string>>()
  private readonly live = new Set<string>()
  private readonly deps: Deps
  private readonly detach: () => void

  constructor(
    deps: Deps,
    private readonly registrar: IpcRegistrar
  ) {
    this.deps = deps
    for (const channel of TRAFFIC_CHANNELS) this.register(channel)
    this.detach = deps.registry.subscribe((push) => {
      this.deliver(push)
      if (push.kind === 'state') this.track(push.projectId, push.state.capturing)
    })
  }

  registerShell(webContents: ShellClient, role: ShellRole): void {
    this.shells.set(webContents.id, { webContents, role })
  }

  releaseShell(webContents: ShellClient): void {
    const id = webContents.id
    this.shells.delete(id)
    const projects = this.byDocument.get(id)
    if (projects === undefined) return
    this.byDocument.delete(id)
    for (const subscriptionId of projects.values()) this.subscriptions.delete(subscriptionId)
  }

  close(): void {
    this.detach()
    for (const channel of TRAFFIC_CHANNELS) this.registrar.removeHandler(channel)
    this.shells.clear()
    this.subscriptions.clear()
    this.byDocument.clear()
  }

  private register(channel: TrafficChannel): void {
    this.registrar.handle(channel, async (event: ShellRequest, raw: unknown) => {
      const parsed = TRAFFIC_CONTRACT[channel].request.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`Invalid request on "${channel}": ${parsed.error.message}`)
      }
      const result = await this.run(channel, event, parsed.data)
      const checked = TRAFFIC_CONTRACT[channel].response.safeParse(result)
      if (!checked.success) {
        throw new Error(`Invalid response on "${channel}": ${checked.error.message}`)
      }
      return checked.data
    })
  }

  private run(
    channel: TrafficChannel,
    event: ShellRequest,
    request: TrafficRequest<TrafficChannel>
  ): unknown {
    const role = this.role(event)
    if (role === null) throw new Error('Traffic is not available to this document')

    switch (channel) {
      case 'traffic:legacy':
        return this.deps.legacy()
      case 'traffic:legacyDecide':
        this.deps.decideLegacy((request as { keep: boolean }).keep)
        return { ok: true, legacy: this.deps.legacy() }
      case 'traffic:live':
        return { projectIds: this.liveFor(role) }
      case 'traffic:attach':
        return this.attach(event, role, request as { projectId: string })
      case 'traffic:detach':
        return this.detachSubscription(event, request as { subscriptionId: string })
      case 'traffic:ack':
        return this.ack(event, request as { subscriptionId: string; seq: number })
      case 'traffic:snapshot':
        return this.snapshot(role, request as { projectId: string; subscriptionId: string })
      case 'traffic:detail':
        return this.detail(role, request as TrafficDetailRequest)
      case 'traffic:readBody':
        return this.readBody(event, role, request as TrafficBodyReadRequest)
      case 'traffic:start':
      case 'traffic:stop':
      case 'traffic:clear':
      case 'traffic:configure':
      case 'traffic:selectSource':
        return this.act(channel, role, request)
    }
  }

  private act(
    channel: TrafficAction,
    role: ShellRole,
    request: TrafficRequest<TrafficChannel>
  ): unknown {
    const projectId = (request as { projectId?: string }).projectId ?? null
    if (projectId === null || !this.mayInspect(role, projectId)) {
      throw new Error('That project is not this shell’s to inspect')
    }
    const registry = this.deps.registry

    switch (channel) {
      case 'traffic:start':
        return this.capture(projectId, 'start').then((next) => ({ state: next }))
      case 'traffic:stop':
        return this.capture(projectId, 'stop').then((next) => ({ state: next }))
      case 'traffic:clear':
        return registry.clear(projectId)
      case 'traffic:configure': {
        const config = (request as { config: Record<string, unknown> }).config
        return registry
          .configure(projectId, {
            origin: config['origin'] as string | null | undefined,
            port: config['port'] as number | null | undefined,
            access: config['access'] as 'loopback' | 'lan' | undefined,
            host: config['host'] as string | null | undefined,
            envVar: config['envVar'] as string | null | undefined,
          })
          .then((next) => ({ state: next, failure: next.failure }))
      }
      case 'traffic:selectSource':
        return {
          state: registry.selectSource(
            projectId,
            (request as { source: TrafficSourceShape }).source
          ),
        }
    }
  }

  private capture(projectId: string, change: 'start' | 'stop'): Promise<ProjectTrafficState> {
    const routed = this.deps.capture
    if (routed !== undefined) return routed(projectId, change)
    const registry = this.deps.registry
    return change === 'start' ? registry.start(projectId) : registry.stop(projectId)
  }

  private attach(event: ShellRequest, role: ShellRole, request: { projectId: string }): unknown {
    if (!this.mayInspect(role, request.projectId)) {
      throw new Error('That project is not this shell’s to inspect')
    }
    const journal = this.deps.registry.open(request.projectId)
    const current = this.deps.registry.state(request.projectId)
    if (current === null) {
      throw new Error('That project is not in the registry')
    }

    const projects = this.byDocument.get(event.sender.id) ?? new Map<string, string>()
    const previous = projects.get(request.projectId)
    if (previous !== undefined) this.subscriptions.delete(previous)

    const id = randomUUID()
    this.subscriptions.set(id, {
      id,
      webContents: event.sender,
      projectId: request.projectId,
      pending: [],
      pendingBytes: 0,
      outstanding: false,
    })
    projects.set(request.projectId, id)
    this.byDocument.set(event.sender.id, projects)

    return {
      subscriptionId: id,
      captureId: journal.captureId,
      rows: journal.rows,
      seq: journal.seq,
      state: current,
    }
  }

  private detachSubscription(event: ShellRequest, request: { subscriptionId: string }): unknown {
    const subscription = this.own(event, request.subscriptionId)
    if (subscription === null) return { ok: true }
    this.subscriptions.delete(subscription.id)
    const projects = this.byDocument.get(event.sender.id)
    if (projects?.get(subscription.projectId) === subscription.id) {
      projects.delete(subscription.projectId)
    }
    if (projects?.size === 0) this.byDocument.delete(event.sender.id)
    return { ok: true }
  }

  private ack(event: ShellRequest, request: { subscriptionId: string; seq: number }): unknown {
    const subscription = this.own(event, request.subscriptionId)
    if (subscription === null) return { ok: true }
    subscription.outstanding = false
    this.flush(subscription)
    return { ok: true }
  }

  private snapshot(
    role: ShellRole,
    request: { projectId: string; subscriptionId: string }
  ): unknown {
    if (!this.mayInspect(role, request.projectId)) {
      throw new Error('That project is not this shell’s to inspect')
    }
    const journal = this.deps.registry.journal(request.projectId)
    if (journal === null) throw new Error('That project has no traffic history yet')
    return { ...journal, complete: true }
  }

  /**
   * Authorize before lookup, and never let a refusal describe what it refused.
   *
   * The order is the security property rather than tidiness: a forged project
   * fails the role check before any capture is touched, and a forged
   * subscription fails before any byte is copied — so a caller cannot use the
   * difference between "not yours" and "not there" to learn that a request
   * exists.
   */
  private detail(role: ShellRole, request: TrafficDetailRequest): TrafficDetailResult {
    const key = {
      projectId: request.projectId,
      captureId: request.captureId,
      requestId: request.requestId,
    }
    if (!this.mayInspect(role, request.projectId)) {
      throw new Error('That project is not this shell’s to inspect')
    }
    const detail = this.deps.registry.detail(
      request.projectId,
      request.captureId,
      request.requestId
    )
    return detail === null ? { kind: 'not-found', key } : { kind: 'detail', detail }
  }

  private async readBody(
    event: ShellRequest,
    role: ShellRole,
    request: TrafficBodyReadRequest
  ): Promise<TrafficReadResult> {
    const key = {
      projectId: request.projectId,
      captureId: request.captureId,
      requestId: request.requestId,
    }
    if (!this.mayInspect(role, request.projectId)) {
      throw new Error('That project is not this shell’s to inspect')
    }
    if (this.own(event, request.subscriptionId) === null) return { kind: 'not-found', key }
    if (request.representation === 'decoded') {
      await this.deps.registry.decodedReady(
        request.projectId,
        request.captureId,
        request.requestId,
        request.side
      )
    }
    return this.deps.registry.bodyPage(
      request.projectId,
      request.captureId,
      request.requestId,
      request.side,
      request.representation,
      request.offset,
      request.length
    )
  }

  private deliver(push: ProjectTrafficPush): void {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.projectId !== push.projectId) continue
      const next = this.toIpcPush(push, subscription.id)
      const size = bytesOf(next)
      if (
        subscription.pending.length >= PENDING_LIMIT ||
        subscription.pendingBytes + size > PENDING_BYTES
      ) {
        // Past either bound a renderer has lost its place in the stream, so the
        // queue is replaced by one resync rather than allowed to grow: main
        // accumulating sends for a stalled view is the failure this bound
        // exists to prevent, and a delta the view never applied is worthless.
        if (subscription.pending[0]?.kind !== 'resync') {
          subscription.pending = [this.resyncFor(subscription)]
          subscription.pendingBytes = 0
        }
        this.flush(subscription)
        continue
      }
      subscription.pending.push(next)
      subscription.pendingBytes += size
      this.flush(subscription)
    }
  }

  private track(projectId: string, capturing: boolean): void {
    if (this.live.has(projectId) === capturing) return
    if (capturing) this.live.add(projectId)
    else this.live.delete(projectId)
    for (const shell of this.shells.values()) {
      if (shell.webContents.isGone()) continue
      shell.webContents.send(TRAFFIC_LIVE_PUSH_CHANNEL, { projectIds: this.liveFor(shell.role) })
    }
  }

  private liveFor(role: ShellRole): string[] {
    const all = [...this.live]
    return role.kind === 'detached' ? all.filter((id) => id === role.projectId) : all
  }

  private toIpcPush(push: ProjectTrafficPush, subscriptionId: string): TrafficPush {
    if (push.kind === 'rows') {
      return {
        kind: 'rows',
        projectId: push.projectId,
        subscriptionId,
        captureId: push.captureId,
        seq: push.seq,
        rows: [...push.rows],
      }
    }
    if (push.kind === 'state') {
      return { kind: 'state', projectId: push.projectId, subscriptionId, state: push.state }
    }
    return {
      kind: 'reset',
      projectId: push.projectId,
      subscriptionId,
      captureId: push.captureId,
      seq: push.seq,
      reason: push.reason,
    }
  }

  private resyncFor(subscription: Subscription): TrafficPush {
    return {
      kind: 'resync',
      projectId: subscription.projectId,
      subscriptionId: subscription.id,
    }
  }

  private flush(subscription: Subscription): void {
    if (subscription.outstanding || subscription.pending.length === 0) return
    if (subscription.webContents.isGone()) {
      this.subscriptions.delete(subscription.id)
      return
    }
    const next = subscription.pending.shift()
    if (next === undefined) return
    subscription.pendingBytes -= bytesOf(next)

    const { head, rest } = splitDelivery(next)
    if (rest !== null) {
      subscription.pending.unshift(rest)
      subscription.pendingBytes += bytesOf(rest)
    }
    subscription.outstanding = true
    subscription.webContents.send(TRAFFIC_PUSH_CHANNEL, head)
  }

  private own(event: ShellRequest, subscriptionId: string): Subscription | null {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription === undefined) return null
    if (subscription.webContents.id !== event.sender.id) return null
    return subscription
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
