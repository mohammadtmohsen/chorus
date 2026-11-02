import { randomUUID } from 'node:crypto'
import { terminalRefKey, type TrafficSourceShape } from '../shared/ipc.js'
import {
  BODY_PAGE,
  TRAFFIC_ENV_NAME,
  isTrafficHost,
  type TrafficAccess,
  type TrafficDetail,
  type TrafficFailure,
  type TrafficReadResult,
} from '../shared/traffic-ipc.js'
import type { WorkbenchTerminalEnv } from '../shared/workbench-ipc.js'
import {
  TrafficService,
  type CaptureBudget,
  type RetentionRefusal,
  type TrafficRow,
} from './traffic.js'
import type { TerminalRef } from './terminal.js'

const ROWS_PER_PROJECT = 1_000
const ROWS_OVERALL = 4_000
const LOOPBACK = '127.0.0.1'
const EVERY_INTERFACE = '0.0.0.0'
/*
 * The same default the column carries and migration 18 gave every existing row,
 * stated once here so the two fallbacks below cannot drift from it.
 */
const DEFAULT_ACCESS: TrafficAccess = 'lan'

const BYTES_PER_PROJECT = 16 * 1_024 * 1_024
const BYTES_OVERALL = 64 * 1_024 * 1_024
const ADDRESS_REFRESH_MS = 5_000

export interface ProjectTrafficConfig {
  readonly origin: string | null
  readonly port: number | null
  readonly access: TrafficAccess
  readonly envVar: string | null
}

export interface ProjectTrafficState {
  readonly capturing: boolean
  readonly port: number | null
  readonly wantedPort: number | null
  readonly address: string | null
  readonly host?: string | null
  readonly hostOverridden?: boolean
  readonly origin: string | null
  readonly access: TrafficAccess
  readonly envVar: string | null
  readonly source: TrafficSourceShape
  readonly failure: TrafficFailure | null
  readonly forwardedDevices: number
}

export type ProjectTrafficPush =
  | {
      readonly kind: 'rows'
      readonly projectId: string
      readonly captureId: string
      readonly seq: number
      readonly rows: readonly TrafficRow[]
    }
  | { readonly kind: 'state'; readonly projectId: string; readonly state: ProjectTrafficState }
  | {
      readonly kind: 'reset'
      readonly projectId: string
      readonly captureId: string
      readonly seq: number
      readonly reason: 'cleared' | 'restarted'
    }

export interface ProjectTrafficDeps {
  readonly config: (projectId: string) => ProjectTrafficConfig | null
  readonly nextPort: (projectId: string) => number
  readonly remember: (projectId: string, config: ProjectTrafficConfig) => void
  readonly address: () => string | null
  readonly capture?: number
  readonly wantsReady?: (projectId: string) => boolean
  readonly localProject?: (projectId: string) => boolean
}

interface Entry {
  readonly projectId: string
  config: ProjectTrafficConfig | null
  hostOverride: string | null
  service: TrafficService | null
  unsubscribe: (() => void) | null
  journal: TrafficRow[]
  seq: number
  captureId: string
  state: ProjectTrafficState
  queue: Promise<unknown>
}

const isAddressInUse = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EADDRINUSE'

type ReadyConfig = ProjectTrafficConfig & { readonly origin: string; readonly envVar: string }

const readies = (config: ProjectTrafficConfig | null): config is ReadyConfig => {
  if (config === null) return false
  return config.origin !== null && config.envVar !== null && TRAFFIC_ENV_NAME.test(config.envVar)
}

const RELINQUISHED: Partial<ProjectTrafficState> = {
  capturing: false,
  port: null,
  address: null,
  forwardedDevices: 0,
}

export function terminalEnvOf(state: ProjectTrafficState | null): WorkbenchTerminalEnv | null {
  if (state === null) return null
  const { port, envVar, access, address } = state
  if (port === null || envVar === null || !TRAFFIC_ENV_NAME.test(envVar)) return null
  const reachable =
    access === 'lan' && address !== null && !address.startsWith(`${EVERY_INTERFACE}:`)
      ? address
      : `${LOOPBACK}:${String(port)}`
  return { name: envVar, value: `http://${reachable}` }
}

export class ProjectTrafficRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<(push: ProjectTrafficPush) => void>()
  private readonly deps: ProjectTrafficDeps
  private readonly capture: number
  private readonly suspended = new Set<string>()
  private logcatOwner: string | null = null
  /*
   * What each capture is holding, and what every project holds together.
   *
   * Charged per capture rather than per project alone, because releasing has to
   * know how much that capture was actually granted — a release that guessed
   * from the body's own counter would drift from the ledger the moment a
   * retention was refused part-way.
   */
  private readonly charges = new Map<string, { readonly projectId: string; bytes: number }>()
  private readonly projectBytes = new Map<string, number>()
  private totalBytes = 0
  private addressRefresh: ReturnType<typeof setInterval> | null = null

  constructor(deps: ProjectTrafficDeps) {
    this.deps = deps
    this.capture = deps.capture ?? ROWS_PER_PROJECT
  }

  subscribe(listener: (push: ProjectTrafficPush) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  suspend(projectId: string): void {
    this.suspended.add(projectId)
  }

  allowProject(projectId: string): void {
    this.suspended.delete(projectId)
  }

  state(projectId: string): ProjectTrafficState | null {
    return this.entries.get(projectId)?.state ?? null
  }

  journal(projectId: string): {
    readonly captureId: string
    readonly seq: number
    readonly rows: readonly TrafficRow[]
  } | null {
    const entry = this.entries.get(projectId)
    if (entry === undefined) return null
    return { captureId: entry.captureId, seq: entry.seq, rows: [...entry.journal] }
  }

  /*
   * The journal for a project that may never have been configured.
   *
   * A view attaches the moment its panel mounts, which is before anybody has
   * given the project an address — so `journal` returning null there refused
   * the subscription outright. The panel swallowed that, kept its state from the
   * attach response, and then heard nothing for the rest of the session: main
   * was capturing rows and had no subscriber to deliver them to.
   */
  open(projectId: string): {
    readonly captureId: string
    readonly seq: number
    readonly rows: readonly TrafficRow[]
  } {
    const entry = this.entry(projectId)
    return { captureId: entry.captureId, seq: entry.seq, rows: [...entry.journal] }
  }

  configure(
    projectId: string,
    config: {
      readonly origin?: string | null | undefined
      readonly port?: number | null | undefined
      readonly access?: TrafficAccess | undefined
      readonly host?: string | null | undefined
      readonly envVar?: string | null | undefined
    }
  ): Promise<ProjectTrafficState> {
    const entry = this.entry(projectId)
    return this.serialize(entry, async () => {
      if (this.gone(entry)) return entry.state
      if (config.host !== undefined && config.host !== null && !isTrafficHost(config.host)) {
        return this.publish(entry, { failure: 'invalid-host' })
      }
      const movesOrigin = config.origin !== undefined && config.origin !== entry.config?.origin
      const movesPort = config.port !== undefined && config.port !== entry.config?.port
      /*
       * `access` is guarded with the other two even though it needs no teardown to
       * apply. It is read once, in `start`, to choose the bind host, and nothing
       * rebinds the socket afterwards — so accepting it mid-capture would leave the
       * panel showing "Anything on this network" beside a listener still bound to
       * `127.0.0.1`, and a person whose phone cannot reach it with no statement on
       * screen that the change waits for a restart. Refusing says the same thing
       * the other two say: stop, change it, start again.
       */
      const movesAccess = config.access !== undefined && config.access !== entry.config?.access
      const service = entry.service
      const recording = service?.isRecording() ?? false
      if (recording && (movesOrigin || movesPort || movesAccess)) {
        return this.publish(entry, { failure: 'capturing' })
      }
      const next: ProjectTrafficConfig = {
        origin: config.origin === undefined ? (entry.config?.origin ?? null) : config.origin,
        port: config.port === undefined ? (entry.config?.port ?? null) : config.port,
        access: config.access ?? entry.config?.access ?? DEFAULT_ACCESS,
        envVar: config.envVar === undefined ? (entry.config?.envVar ?? null) : config.envVar,
      }
      this.deps.remember(projectId, next)
      entry.config = next
      if (config.host !== undefined) entry.hostOverride = config.host
      if (service === null) {
        if (this.forwards(projectId, next) && this.wants(projectId)) {
          return this.listen(entry, next, next.origin, false)
        }
        return this.publish(entry, { failure: null })
      }
      if (recording) return this.publish(entry, { failure: null })
      if (!this.forwards(projectId, next) || movesPort || movesAccess) {
        await this.shut(entry, service)
        if (this.gone(entry)) return entry.state
        if (this.forwards(projectId, next)) return this.listen(entry, next, next.origin, false)
        return this.publish(entry, { ...RELINQUISHED, failure: null })
      }
      if (movesOrigin) service.setOrigin(next.origin)
      return this.publish(entry, { failure: null })
    })
  }

  prepare(projectId: string): Promise<ProjectTrafficState> {
    if (this.suspended.has(projectId)) return Promise.reject(new Error('This project is closed'))
    const entry = this.entry(projectId)
    return this.serialize(entry, async () => {
      if (this.gone(entry) || entry.service !== null) return entry.state
      const config = this.deps.config(projectId) ?? entry.config
      entry.config = config
      if (!this.forwards(projectId, config)) return entry.state
      return this.listen(entry, config, config.origin, false)
    })
  }

  start(projectId: string): Promise<ProjectTrafficState> {
    if (this.suspended.has(projectId)) return Promise.reject(new Error('This project is closed'))
    const entry = this.entry(projectId)
    return this.serialize(entry, async () => {
      if (this.gone(entry)) return entry.state
      const ready = entry.service
      if (ready !== null) {
        if (ready.isRecording()) return this.publish(entry, { failure: null })
        ready.reset(true)
        this.renew(entry)
        return this.publish(entry, { capturing: true, failure: null })
      }

      const config = this.deps.config(projectId) ?? entry.config
      entry.config = config
      if (config === null) return this.publish(entry, { failure: 'unknown-project' })
      if (config.origin === null) return this.publish(entry, { failure: 'no-origin' })
      return this.listen(entry, config, config.origin, true)
    })
  }

  stop(projectId: string): Promise<ProjectTrafficState> {
    const entry = this.entry(projectId)
    return this.serialize(entry, async () => {
      if (this.gone(entry)) return entry.state
      const forwarding = entry.service
      if (forwarding !== null && this.forwards(projectId, entry.config)) {
        forwarding.reset(false)
        this.dischargeProject(projectId)
        return this.publish(entry, { capturing: false, failure: null })
      }
      const service = entry.service
      entry.service = null
      entry.unsubscribe?.()
      entry.unsubscribe = null
      if (service !== null) await service.close()
      if (this.gone(entry)) return entry.state
      /*
       * The retained bytes go back, and they have to be given back here rather
       * than left to the service.
       *
       * This cleared the service and closed it and discharged nothing, so every
       * body that service had been charged for went on counting against the
       * project's ceiling. `reclaim` cannot free them either: it frees by
       * evicting from a *live* service, and by the next retention there is no
       * longer one — so a second start began against a full ledger and refused
       * bodies it had room for.
       *
       * Discharging the project rather than calling `clearCaptures` is the
       * choice `dispose` makes one function up, and it is the stronger of the
       * two: it is the registry's own ledger, so it holds even for a capture the
       * service's store had already forgotten without releasing — which is the
       * shape of the leak being fixed. Nothing is lost by it: `detail` and
       * `bodyPage` both answer null once `service === null`, so these bytes are
       * already unreachable when they are given back.
       */
      this.dischargeProject(projectId)
      return this.publish(entry, {
        capturing: false,
        port: null,
        address: null,
        failure: null,
        forwardedDevices: 0,
      })
    })
  }

  clear(projectId: string): { captureId: string; seq: number } {
    const entry = this.entry(projectId)
    // Forwarding keeps going; only what was retained is released. The service
    // survives the clear, so its socket and its tunnels are untouched.
    const service = entry.service
    service?.reset(service.isRecording())
    entry.journal = []
    entry.seq = 0
    entry.captureId = randomUUID()
    this.emit({
      kind: 'reset',
      projectId,
      captureId: entry.captureId,
      seq: 0,
      reason: 'cleared',
    })
    return { captureId: entry.captureId, seq: 0 }
  }

  selectSource(projectId: string, source: TrafficSourceShape): ProjectTrafficState {
    const entry = this.entry(projectId)
    if (source.kind === 'logcat') {
      if (this.logcatOwner !== null && this.logcatOwner !== projectId) {
        return this.publish(entry, { failure: 'source-busy' })
      }
      this.logcatOwner = projectId
    } else if (this.logcatOwner === projectId) {
      this.logcatOwner = null
    }
    entry.state = { ...entry.state, source }
    this.emitState(projectId, entry.state)
    return entry.state
  }

  /** The project holding the device logcat, whoever that is. */
  logcatHolder(): string | null {
    return this.logcatOwner
  }

  capturingPorts(): ReadonlySet<number> {
    const ports = new Set<number>()
    for (const entry of this.entries.values()) {
      if (entry.service !== null && entry.state.port !== null) ports.add(entry.state.port)
    }
    return ports
  }

  setForwarded(count: (port: number) => number): void {
    for (const entry of this.entries.values()) {
      const port = entry.service === null ? null : entry.state.port
      const devices = port === null ? 0 : count(port)
      if (devices === entry.state.forwardedDevices) continue
      this.publish(entry, { forwardedDevices: devices })
    }
  }

  /** One captured exchange's headers, bodies and timing. */
  detail(projectId: string, captureId: string, requestId: string): TrafficDetail | null {
    const entry = this.entries.get(projectId)
    if (entry === undefined) return null
    const service = entry.service
    if (service === null) return null
    if (entry.captureId !== captureId) return null
    const captured = service.captured(requestId)
    if (captured === null) return null
    return {
      key: { projectId, captureId, requestId },
      method: captured.input.method,
      url: captured.input.url,
      forwardedUrl: captured.input.forwardedUrl,
      requestHeaders: [...captured.input.requestHeaders],
      forwardedHeaders: [...captured.input.forwardedHeaders],
      responseHeaders: [...captured.responseHeaders],
      trailers: [...captured.trailers],
      status: captured.status,
      transport: captured.transport,
      timing: {
        startedAt: captured.startedAt,
        upstreamAt: captured.upstreamAt,
        upstreamDoneAt: captured.upstreamDoneAt,
        settledAt: captured.settledAt,
      },
      requestBody: captured.request.descriptor(),
      responseBody: captured.response.descriptor(),
    }
  }

  async decodedReady(
    projectId: string,
    captureId: string,
    requestId: string,
    side: 'request' | 'response'
  ): Promise<void> {
    const entry = this.entries.get(projectId)
    if (entry === undefined) return
    const service = entry.service
    if (service === null) return
    if (entry.captureId !== captureId) return
    const captured = service.captured(requestId)
    if (captured === null) return
    const body = side === 'request' ? captured.request : captured.response
    const settled =
      body.state === 'complete' || body.state === 'aborted' || body.state === 'unavailable'
    if (!settled) return
    await body.decode()
  }

  /**
   * A bounded page of one body, or why there is none.
   *
   * The offset and length are the caller's and are clamped here rather than
   * trusted, so a page can never be longer than the contract allows however it
   * was asked for.
   */
  bodyPage(
    projectId: string,
    captureId: string,
    requestId: string,
    side: 'request' | 'response',
    representation: 'encoded' | 'decoded',
    offset: number,
    length: number
  ): TrafficReadResult {
    const key = { projectId, captureId, requestId }
    const entry = this.entries.get(projectId)
    if (entry === undefined) return { kind: 'not-found', key }
    const service = entry.service
    if (service === null) return { kind: 'not-found', key }
    if (entry.captureId !== captureId) return { kind: 'cleared', key }
    const captured = service.captured(requestId)
    if (captured === null) {
      return { kind: service.wasEvicted(requestId) ? 'evicted' : 'not-found', key }
    }

    const body = side === 'request' ? captured.request : captured.response
    const page =
      representation === 'encoded'
        ? body.encodedPage(offset, Math.min(length, BODY_PAGE))
        : body.decodedPage(offset, Math.min(length, BODY_PAGE))
    if (page === null) return { kind: 'unsupported', key }

    return {
      kind: 'page',
      key,
      offset,
      dataBase64: page.toString('base64'),
      body: body.descriptor(),
    }
  }

  logLine(projectId: string, ref: TerminalRef, line: string, exit: number | null): void {
    const entry = this.entries.get(projectId)
    const service = entry?.service ?? null
    if (service === null) return
    const chosen = entry?.state.source
    if (chosen?.kind !== 'terminal' || terminalRefKey(chosen.ref) !== terminalRefKey(ref)) return
    service.logLine(ref, line, exit)
  }

  /** Where a terminal's lines go: whichever project chose that terminal, if any. */
  routeLogLine(ref: TerminalRef, line: string, exit: number | null): void {
    for (const entry of this.entries.values()) {
      const chosen = entry.state.source
      if (chosen.kind !== 'terminal') continue
      if (terminalRefKey(chosen.ref) !== terminalRefKey(ref)) continue
      this.logLine(entry.projectId, ref, line, exit)
      return
    }
  }

  routeLogcatLine(line: string): void {
    if (this.logcatOwner !== null) this.logcatLine(this.logcatOwner, line)
  }

  logcatLine(projectId: string, line: string): void {
    const entry = this.entries.get(projectId)
    const service = entry?.service ?? null
    if (service === null) return
    if (entry?.state.source.kind !== 'logcat') return
    service.logcatLine(line)
  }

  async dispose(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId)
    if (entry === undefined) return
    await this.serialize(entry, async () => {
      await entry.service?.close()
      if (this.entries.get(projectId) !== entry) return
      entry.service = null
      entry.unsubscribe?.()
      entry.unsubscribe = null
      this.entries.delete(projectId)
      this.watchAddresses()
      this.dischargeProject(projectId)
      if (this.logcatOwner === projectId) this.logcatOwner = null
    })
  }

  async shutdown(): Promise<void> {
    for (const projectId of [...this.entries.keys()]) await this.dispose(projectId)
  }

  /**
   * The address a person would type, never the wildcard the socket is bound to.
   *
   * `0.0.0.0` is a bind address and says nothing a client can use. When the LAN
   * address cannot be found the wildcard is still what is reported, because a
   * wrong-looking address is better than a blank one that hides a running
   * listener.
   *
   * Re-read when `lan` became the default and this stopped being hypothetical:
   * `lanAddress` answers null only when the machine has no non-internal IPv4
   * interface at all. That is also the machine on which nothing on a network
   * could reach this listener, so the uncopyable address is not the thing that
   * is wrong with it — and it is not a state a laptop on Wi-Fi reaches.
   */
  private hostFor(entry: Entry, access: TrafficAccess): string | null {
    return access === 'loopback' ? LOOPBACK : (entry.hostOverride ?? this.deps.address())
  }

  private addressFor(port: number, access: TrafficAccess, entry: Entry): string {
    return `${this.hostFor(entry, access) ?? EVERY_INTERFACE}:${String(port)}`
  }

  refreshAddresses(): void {
    for (const entry of this.entries.values()) {
      if (entry.service === null || entry.state.access !== 'lan' || entry.hostOverride !== null)
        continue
      const host = this.hostFor(entry, entry.state.access)
      const address =
        entry.state.port === null ? null : `${host ?? EVERY_INTERFACE}:${String(entry.state.port)}`
      if (entry.state.host !== host || entry.state.address !== address) this.publish(entry, {})
    }
  }

  private watchAddresses(): void {
    const needed = [...this.entries.values()].some(
      (entry) =>
        entry.service !== null && entry.config?.access === 'lan' && entry.hostOverride === null
    )
    if (!needed && this.addressRefresh !== null) {
      clearInterval(this.addressRefresh)
      this.addressRefresh = null
    } else if (needed && this.addressRefresh === null) {
      this.addressRefresh = setInterval(() => {
        this.refreshAddresses()
      }, ADDRESS_REFRESH_MS)
      this.addressRefresh.unref()
    }
  }

  private budgetFor(projectId: string): CaptureBudget {
    return {
      retain: (captureId, bytes) => this.charge(projectId, captureId, bytes),
      release: (captureId, bytes) => {
        this.discharge(captureId, bytes)
      },
    }
  }

  /**
   * Admits bytes, freeing what nobody has looked at before it refuses.
   *
   * **Refusing is the last resort, not the first.** A ledger that only says no
   * turns one project's growth into another project's silence; evicting the
   * least recently read detail answers the same question without losing
   * anything anybody was using. The project that is asking is drained first,
   * so the loss lands where the pressure is.
   */
  private charge(projectId: string, captureId: string, bytes: number): RetentionRefusal | null {
    if (this.admits(projectId, captureId, bytes)) {
      this.commit(projectId, captureId, bytes)
      return null
    }
    this.reclaim(projectId, bytes, captureId)
    if (this.admits(projectId, captureId, bytes)) {
      this.commit(projectId, captureId, bytes)
      return null
    }
    return (this.projectBytes.get(projectId) ?? 0) + bytes > BYTES_PER_PROJECT
      ? 'project-budget'
      : 'global-budget'
  }

  private admits(projectId: string, captureId: string, bytes: number): boolean {
    const held = this.charges.get(captureId)?.bytes ?? 0
    const mine = this.projectBytes.get(projectId) ?? 0
    return (
      held + bytes <= BYTES_PER_PROJECT &&
      mine + bytes <= BYTES_PER_PROJECT &&
      this.totalBytes + bytes <= BYTES_OVERALL
    )
  }

  private commit(projectId: string, captureId: string, bytes: number): void {
    const held = this.charges.get(captureId)?.bytes ?? 0
    this.charges.set(captureId, { projectId, bytes: held + bytes })
    this.projectBytes.set(projectId, (this.projectBytes.get(projectId) ?? 0) + bytes)
    this.totalBytes += bytes
  }

  private discharge(captureId: string, bytes: number): void {
    const charge = this.charges.get(captureId)
    if (charge === undefined) return
    const taken = Math.min(bytes, charge.bytes)
    charge.bytes -= taken
    this.totalBytes -= taken
    this.projectBytes.set(
      charge.projectId,
      Math.max(0, (this.projectBytes.get(charge.projectId) ?? 0) - taken)
    )
    if (charge.bytes === 0) this.charges.delete(captureId)
  }

  private reclaim(projectId: string, needed: number, keepId: string): void {
    const order = [
      ...(this.entries.has(projectId) ? [this.entries.get(projectId)] : []),
      ...[...this.entries.values()].filter((entry) => entry.projectId !== projectId),
    ]
    let freed = 0
    for (const entry of order) {
      if (freed >= needed) return
      freed += entry?.service?.evictLeastRecent(needed - freed, keepId) ?? 0
    }
  }

  private dischargeProject(projectId: string): void {
    for (const [captureId, charge] of [...this.charges]) {
      if (charge.projectId !== projectId) continue
      this.charges.delete(captureId)
      this.totalBytes -= charge.bytes
    }
    this.projectBytes.delete(projectId)
  }

  private entry(projectId: string): Entry {
    const existing = this.entries.get(projectId)
    if (existing !== undefined) return existing
    const entry: Entry = {
      projectId,
      config: this.deps.config(projectId),
      hostOverride: null,
      service: null,
      unsubscribe: null,
      journal: [],
      seq: 0,
      captureId: randomUUID(),
      state: {
        capturing: false,
        port: null,
        wantedPort: null,
        address: null,
        host: this.deps.config(projectId)?.access === 'loopback' ? LOOPBACK : this.deps.address(),
        hostOverridden: false,
        origin: this.deps.config(projectId)?.origin ?? null,
        access: this.deps.config(projectId)?.access ?? DEFAULT_ACCESS,
        envVar: this.deps.config(projectId)?.envVar ?? null,
        source: { kind: 'off' },
        failure: null,
        forwardedDevices: 0,
      },
      queue: Promise.resolve(),
    }
    this.entries.set(projectId, entry)
    return entry
  }

  private serialize<T>(entry: Entry, run: () => Promise<T>): Promise<T> {
    const next = entry.queue.then(run, run)
    entry.queue = next.catch(() => undefined)
    return next
  }

  private async listen(
    entry: Entry,
    config: ProjectTrafficConfig,
    origin: string,
    recording: boolean
  ): Promise<ProjectTrafficState> {
    const projectId = entry.projectId
    // The host is the access choice, not a probe: binding the real listener
    // where it will actually serve is the only availability test the plan
    // allows, and `0.0.0.0` is never offered to a person as an address.
    const host = config.access === 'lan' ? EVERY_INTERFACE : LOOPBACK

    const service = new TrafficService({
      origin,
      capture: this.capture,
      budget: this.budgetFor(projectId),
      recording,
    })
    let bound: number
    try {
      const wanted = config.port ?? this.deps.nextPort(projectId)
      bound = await service.listen(wanted, host)
    } catch (error) {
      await service.close()
      if (this.gone(entry)) return entry.state
      return this.publish(entry, {
        ...RELINQUISHED,
        failure: isAddressInUse(error) ? 'in-use' : 'failed',
      })
    }
    if (this.gone(entry)) {
      await service.close()
      return entry.state
    }

    if (config.port === null) {
      try {
        this.deps.remember(projectId, { ...config, port: bound })
        entry.config = { ...config, port: bound }
      } catch {
        await service.close()
        if (this.gone(entry)) return entry.state
        return this.publish(entry, { ...RELINQUISHED, failure: 'failed' })
      }
    }

    entry.service = service
    entry.unsubscribe = service.subscribe((push) => {
      this.append(entry, push.rows)
    })
    service.attach()
    if (recording) this.renew(entry)

    return this.publish(entry, {
      capturing: recording,
      port: bound,
      address: this.addressFor(bound, config.access, entry),
      failure: null,
    })
  }

  private renew(entry: Entry): void {
    entry.journal = []
    entry.seq = 0
    entry.captureId = randomUUID()
    this.emit({
      kind: 'reset',
      projectId: entry.projectId,
      captureId: entry.captureId,
      seq: 0,
      reason: 'restarted',
    })
  }

  private async shut(entry: Entry, service: TrafficService): Promise<void> {
    entry.service = null
    entry.unsubscribe?.()
    entry.unsubscribe = null
    entry.state = { ...entry.state, ...RELINQUISHED }
    const closing = service.close()
    this.dischargeProject(entry.projectId)
    await closing
  }

  private wants(projectId: string): boolean {
    return !this.suspended.has(projectId) && (this.deps.wantsReady?.(projectId) ?? false)
  }

  private forwards(projectId: string, config: ProjectTrafficConfig | null): config is ReadyConfig {
    return (this.deps.localProject?.(projectId) ?? false) && readies(config)
  }

  private gone(entry: Entry): boolean {
    return this.entries.get(entry.projectId) !== entry
  }

  /**
   * Upserts into the journal by the row's own sequence.
   *
   * The sequence is the engine's, not this counter's — a request writes row 7
   * when it starts and rewrites row 7 when it settles, and a journal that
   * appended both would show every request twice, once empty.
   */
  private append(entry: Entry, rows: readonly TrafficRow[]): void {
    if (rows.length === 0) return
    const stored: TrafficRow[] = []
    for (const row of rows) {
      const at = entry.journal.findIndex((each) => each.seq === row.seq)
      /*
       * **The same rule the service applies one layer down, and the renderer a
       * layer above: a settle for a row this journal has trimmed is dropped.**
       *
       * `entry.seq` is the highest sequence ever seen here, so a row at or below
       * it that is not in the journal is one the window has already let go —
       * it can only be a late settle. Appending it would carry the oldest
       * sequence into the newest position, which is the ordering the whole list
       * depends on.
       *
       * It is not emitted either. A push carrying a row the journal does not
       * hold would draw a row a later read of this same journal cannot find.
       */
      if (at === -1 && row.seq <= entry.seq) continue
      if (at === -1) entry.journal.push(row)
      else entry.journal[at] = row
      if (row.seq > entry.seq) entry.seq = row.seq
      stored.push(row)
    }
    if (stored.length === 0) return
    const overflow = entry.journal.length - this.capture
    if (overflow > 0) entry.journal.splice(0, overflow)
    this.trimOverall()
    this.emit({
      kind: 'rows',
      projectId: entry.projectId,
      captureId: entry.captureId,
      seq: entry.seq,
      rows: stored,
    })
  }

  private trimOverall(): void {
    let total = 0
    for (const entry of this.entries.values()) total += entry.journal.length
    const excess = total - ROWS_OVERALL
    if (excess <= 0) return
    const oldest = [...this.entries.values()].sort((a, b) => a.seq - b.seq)
    let left = excess
    for (const entry of oldest) {
      const drop = Math.min(left, entry.journal.length)
      entry.journal.splice(0, drop)
      left -= drop
      if (left === 0) return
    }
  }

  private publish(entry: Entry, patch: Partial<ProjectTrafficState>): ProjectTrafficState {
    const config = entry.config
    const access = config?.access ?? entry.state.access
    const host = this.hostFor(entry, access)
    const port = patch.port === undefined ? entry.state.port : patch.port
    entry.state =
      config === null
        ? { ...entry.state, ...patch }
        : {
            ...entry.state,
            ...patch,
            origin: config.origin,
            access: config.access,
            envVar: config.envVar,
            wantedPort: config.port,
          }
    entry.state = {
      ...entry.state,
      host,
      hostOverridden: entry.hostOverride !== null,
      address: port === null ? null : `${host ?? EVERY_INTERFACE}:${String(port)}`,
    }
    this.watchAddresses()
    this.emitState(entry.projectId, entry.state)
    return entry.state
  }

  private emitState(projectId: string, state: ProjectTrafficState): void {
    this.emit({ kind: 'state', projectId, state })
  }

  private emit(push: ProjectTrafficPush): void {
    for (const listener of this.listeners) listener(push)
  }
}
