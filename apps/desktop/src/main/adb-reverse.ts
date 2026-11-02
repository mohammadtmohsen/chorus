import { execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ownProcessTree, type OwnedProcessTree } from '@chorus/shared/process-tree'

export interface TrackedDevice {
  readonly serial: string
  readonly state: string
}

export interface DeviceLists {
  readonly lists: readonly (readonly TrackedDevice[])[]
  readonly rest: string
}

export interface ReverseCommand {
  readonly serial: string
  readonly port: number
  readonly add: boolean
}

export type AppliedReverses = ReadonlyMap<string, ReadonlySet<number>>

export interface AdbTracker {
  kill(): void
  stop(): Promise<void>
  onData(listener: (chunk: string) => void): void
  onExit(listener: (missing: boolean) => void): void
}

type Warn = (message: string, fields?: Record<string, unknown>) => void

export interface AdbReverseOptions {
  readonly track?: () => AdbTracker
  readonly run?: (args: readonly string[]) => Promise<void>
  readonly connect?: (address: string) => Promise<void>
  readonly load?: () => readonly string[]
  readonly save?: (addresses: readonly string[]) => void
  readonly warn?: Warn
  readonly retryMs?: number
  readonly reconnectMs?: number
}

const FRAME_LENGTH = /^[0-9a-f]{4}$/i
const WIRELESS = /^[^\s:]+:\d{1,5}$/
const RETRY_MS = 2_000
const RECONNECT_MS = 10_000
const COMMAND_TIMEOUT_MS = 5_000
const REMEMBERED_LIMIT = 5
const REMEMBERED_FILE = 'adb-wireless.json'

export const isWireless = (serial: string): boolean => WIRELESS.test(serial)

export const rememberDevices = (
  previous: readonly string[],
  devices: readonly TrackedDevice[],
  limit = REMEMBERED_LIMIT
): string[] => {
  const seen = devices
    .filter((device) => device.state === 'device' && isWireless(device.serial))
    .map((device) => device.serial)
  return [...seen, ...previous.filter((address) => !seen.includes(address))].slice(0, limit)
}

export const readRememberedDevices = (userDataPath: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(userDataPath, REMEMBERED_FILE), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((each): each is string => typeof each === 'string' && isWireless(each))
      .slice(0, REMEMBERED_LIMIT)
  } catch {
    return []
  }
}

export const writeRememberedDevices = (
  userDataPath: string,
  addresses: readonly string[]
): void => {
  mkdirSync(userDataPath, { recursive: true })
  const target = join(userDataPath, REMEMBERED_FILE)
  const temp = `${target}.tmp`
  writeFileSync(temp, `${JSON.stringify(addresses, null, 2)}\n`, 'utf8')
  renameSync(temp, target)
}

export const parseDeviceLists = (buffer: string): DeviceLists => {
  const lists: TrackedDevice[][] = []
  let at = 0
  while (buffer.length - at >= 4) {
    const header = buffer.slice(at, at + 4)
    if (!FRAME_LENGTH.test(header)) return { lists, rest: '' }
    const length = Number.parseInt(header, 16)
    if (buffer.length - at - 4 < length) break
    const body = buffer.slice(at + 4, at + 4 + length)
    lists.push(
      body
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const [serial = '', state = ''] = line.split('\t')
          return { serial: serial.trim(), state: state.trim() }
        })
    )
    at += 4 + length
  }
  return { lists, rest: buffer.slice(at) }
}

export const reverseCommands = (
  applied: AppliedReverses,
  serials: readonly string[],
  ports: ReadonlySet<number>
): ReverseCommand[] => {
  const commands: ReverseCommand[] = []
  for (const serial of serials) {
    const has = applied.get(serial) ?? new Set<number>()
    for (const port of ports) {
      if (!has.has(port)) commands.push({ serial, port, add: true })
    }
    for (const port of has) {
      if (!ports.has(port)) commands.push({ serial, port, add: false })
    }
  }
  return commands
}

export const reverseArgs = (command: ReverseCommand): string[] => {
  const spec = `tcp:${String(command.port)}`
  return command.add
    ? ['-s', command.serial, 'reverse', spec, spec]
    : ['-s', command.serial, 'reverse', '--remove', spec]
}

const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean =>
  a.size === b.size && [...a].every((each) => b.has(each))

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((each, index) => each === b[index])

const execAdb = promisify(execFile)

const runAdb = async (args: readonly string[]): Promise<void> => {
  await execAdb('adb', [...args], { timeout: COMMAND_TIMEOUT_MS })
}

export const adbTracker = (): AdbTracker => {
  const datas = new Set<(chunk: string) => void>()
  const exits = new Set<(missing: boolean) => void>()
  let settled = false
  let missing = false
  let cancelled = false
  let owned: OwnedProcessTree | null = null
  let stopping: Promise<void> | null = null

  const finish = (unavailable: boolean): void => {
    if (settled) return
    settled = true
    missing = unavailable
    for (const listener of exits) listener(unavailable)
  }
  const ready = runAdb(['start-server'])
    .then(async () => {
      if (cancelled) return
      const child = spawn('adb', ['track-devices'], { stdio: ['ignore', 'pipe', 'ignore'] })
      const exited = new Promise<void>((resolve) => {
        child.once('close', () => {
          resolve()
        })
        child.once('error', () => {
          resolve()
        })
      })
      if (child.pid !== undefined) {
        owned = ownProcessTree(child.pid, { rootExited: exited, expectedAncestorPid: process.pid })
      }
      child.stdout.setEncoding('latin1')
      child.stdout.on('data', (chunk: string) => {
        for (const listener of datas) listener(chunk)
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(error.code === 'ENOENT')
      })
      child.on('close', () => {
        finish(false)
      })
      await owned?.capture()
    })
    .catch((error: unknown) => {
      finish(error instanceof Error && 'code' in error && error.code === 'ENOENT')
    })
  const stop = (): Promise<void> => {
    if (stopping !== null) return stopping
    cancelled = true
    const work = ready
      .then(async () => {
        await owned?.stop()
      })
      .catch((error: unknown) => {
        stopping = null
        throw error
      })
    stopping = work
    return work
  }

  return {
    kill: () => {
      void stop().catch(() => undefined)
    },
    stop,
    onData: (listener) => {
      datas.add(listener)
    },
    onExit: (listener) => {
      exits.add(listener)
      if (settled) listener(missing)
    },
  }
}

export class AdbReverse {
  private readonly track: () => AdbTracker
  private readonly run: (args: readonly string[]) => Promise<void>
  private readonly connect: (address: string) => Promise<void>
  private readonly load: () => readonly string[]
  private readonly save: (addresses: readonly string[]) => void
  private readonly warn: Warn
  private readonly retryMs: number
  private readonly reconnectMs: number
  private readonly changes = new Set<() => void>()
  private readonly applied = new Map<string, Set<number>>()
  private readonly inFlight = new Map<string, { command: ReverseCommand; work: Promise<void> }>()
  private readonly ownedReverses = new Map<string, Set<number>>()
  private readonly retiredTrackers = new Set<AdbTracker>()
  private readonly connecting = new Map<string, Promise<void>>()

  private ports: ReadonlySet<number> = new Set()
  private serials: readonly string[] = []
  private tracker: AdbTracker | null = null
  private buffer = ''
  private retry: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setInterval> | null = null
  private remembered: readonly string[] | null = null
  private listed = false
  private missing = false

  constructor(options: AdbReverseOptions = {}) {
    this.track = options.track ?? adbTracker
    this.run = options.run ?? runAdb
    this.connect = options.connect ?? ((address) => runAdb(['connect', address]))
    this.load = options.load ?? (() => [])
    this.save = options.save ?? (() => undefined)
    this.warn = options.warn ?? (() => undefined)
    this.retryMs = options.retryMs ?? RETRY_MS
    this.reconnectMs = options.reconnectMs ?? RECONNECT_MS
  }

  onChange(listener: () => void): () => void {
    this.changes.add(listener)
    return () => {
      this.changes.delete(listener)
    }
  }

  forwarded(port: number): number {
    let count = 0
    for (const ports of this.applied.values()) {
      if (ports.has(port)) count += 1
    }
    return count
  }

  sync(ports: ReadonlySet<number>): void {
    if (sameSet(ports, this.ports)) return
    this.ports = new Set(ports)
    if (this.ports.size === 0) {
      this.reconcile()
      this.stopTracking()
      return
    }
    this.missing = false
    this.startTracking()
    this.reconcile()
  }

  async syncConfirmed(ports: ReadonlySet<number>): Promise<void> {
    this.sync(ports)
    const removals = async (): Promise<void> => {
      for (;;) {
        this.reconcile()
        const pending = [...this.inFlight.values()].filter(
          ({ command }) => !this.ports.has(command.port)
        )
        if (pending.length === 0) return
        const outcomes = await Promise.allSettled(pending.map(({ work }) => work))
        const failures = outcomes.flatMap((outcome, index): unknown[] =>
          outcome.status === 'rejected' && pending[index]?.command.add === false
            ? [outcome.reason]
            : []
        )
        if (failures.length !== 0)
          throw new AggregateError(failures, 'Android reverse removal could not be confirmed.')
      }
    }
    const outcomes = await Promise.allSettled([
      removals(),
      ...[...this.retiredTrackers].map((tracker) => this.stopTracker(tracker)),
      ...(this.ports.size === 0 ? this.connecting.values() : []),
    ])
    const failures = outcomes.flatMap((outcome): unknown[] =>
      outcome.status === 'rejected' ? [outcome.reason] : []
    )
    if (failures.length !== 0)
      throw new AggregateError(failures, 'Android forwarding shutdown could not be confirmed.')
  }

  close(): void {
    this.sync(new Set())
  }

  private startTracking(): void {
    if (this.tracker !== null || this.retry !== null || this.missing) return
    this.remembered ??= this.load()
    const tracker = this.track()
    this.tracker = tracker
    this.listed = false
    this.reconnectTimer ??= setInterval(() => {
      this.reconnect()
    }, this.reconnectMs)
    tracker.onData((chunk) => {
      if (this.tracker !== tracker) return
      const read = parseDeviceLists(this.buffer + chunk)
      this.buffer = read.rest
      const latest = read.lists[read.lists.length - 1]
      if (latest !== undefined) this.attached(latest)
    })
    tracker.onExit((missing) => {
      if (this.tracker !== tracker) return
      this.tracker = null
      this.retireTracker(tracker)
      this.buffer = ''
      this.attached([])
      if (missing) {
        this.missing = true
        this.stopReconnecting()
        this.warn('adb was not found, so Android devices are not forwarded')
        return
      }
      if (this.ports.size === 0) return
      this.retry = setTimeout(() => {
        this.retry = null
        if (this.ports.size > 0) this.startTracking()
      }, this.retryMs)
    })
  }

  private stopTracking(): void {
    if (this.retry !== null) {
      clearTimeout(this.retry)
      this.retry = null
    }
    this.stopReconnecting()
    const tracker = this.tracker
    this.tracker = null
    this.buffer = ''
    this.serials = []
    if (tracker !== null) this.retireTracker(tracker)
    if (this.applied.size === 0) return
    this.applied.clear()
    this.emit()
  }

  private retireTracker(tracker: AdbTracker): void {
    this.retiredTrackers.add(tracker)
    void this.stopTracker(tracker).catch((error: unknown) => {
      this.warn('adb tracker exit could not be confirmed', {
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private async stopTracker(tracker: AdbTracker): Promise<void> {
    await tracker.stop()
    this.retiredTrackers.delete(tracker)
  }

  private attached(devices: readonly TrackedDevice[]): void {
    this.serials = devices.filter((device) => device.state === 'device').map((d) => d.serial)
    let dropped = false
    for (const serial of [...this.applied.keys()]) {
      if (this.serials.includes(serial)) continue
      this.applied.delete(serial)
      dropped = true
    }
    if (dropped) this.emit()
    this.rememberWireless(devices)
    if (this.tracker !== null && !this.listed) {
      this.listed = true
      this.reconnect()
    }
    this.reconcile()
  }

  private stopReconnecting(): void {
    if (this.reconnectTimer === null) return
    clearInterval(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private rememberWireless(devices: readonly TrackedDevice[]): void {
    const previous = this.remembered ?? []
    const next = rememberDevices(previous, devices)
    if (sameOrder(next, previous)) return
    this.remembered = next
    try {
      this.save(next)
    } catch (error) {
      this.warn('the remembered Wi-Fi devices could not be saved', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private reconnect(): void {
    for (const address of this.remembered ?? []) {
      if (this.serials.includes(address) || this.connecting.has(address)) continue
      const work = this.connect(address).then(
        () => {
          this.connecting.delete(address)
        },
        () => {
          this.connecting.delete(address)
        }
      )
      this.connecting.set(address, work)
    }
  }

  private reconcile(): void {
    const commands = reverseCommands(this.applied, this.serials, this.ports)
    for (const [serial, ports] of this.ownedReverses) {
      for (const port of ports) {
        if (!this.ports.has(port)) commands.push({ serial, port, add: false })
      }
    }
    for (const command of commands) {
      const key = `${command.serial}\t${String(command.port)}`
      if (this.inFlight.has(key)) continue
      const work = Promise.resolve()
        .then(() => this.run(reverseArgs(command)))
        .then(
          () => {
            this.inFlight.delete(key)
            this.settled(command)
          },
          (error: unknown) => {
            this.inFlight.delete(key)
            this.warn('adb reverse failed', {
              serial: command.serial,
              port: command.port,
              add: command.add,
              message: error instanceof Error ? error.message : String(error),
            })
            throw error
          }
        )
      this.inFlight.set(key, { command, work })
      void work.catch(() => undefined)
    }
  }

  private settled(command: ReverseCommand): void {
    const owned = this.ownedReverses.get(command.serial) ?? new Set<number>()
    if (command.add) owned.add(command.port)
    else owned.delete(command.port)
    if (owned.size === 0) this.ownedReverses.delete(command.serial)
    else this.ownedReverses.set(command.serial, owned)
    if (this.serials.includes(command.serial)) {
      const ports = this.applied.get(command.serial) ?? new Set<number>()
      if (command.add) ports.add(command.port)
      else ports.delete(command.port)
      if (ports.size === 0) this.applied.delete(command.serial)
      else this.applied.set(command.serial, ports)
      this.emit()
    }
    this.reconcile()
  }

  private emit(): void {
    for (const listener of this.changes) listener()
  }
}
