import { inspectProcessTable, signalOwnedProcess, type ProcessIdentity } from './process-table.js'

export type { ProcessIdentity } from './process-table.js'

export class ProcessCleanupError extends Error {
  constructor(
    message: string,
    private readonly cleanup: () => Promise<void>,
    cause?: unknown
  ) {
    super(message, { cause })
    this.name = 'ProcessCleanupError'
  }

  retry(): Promise<void> {
    return this.cleanup()
  }
}

export interface OwnedProcessTree {
  capture(): Promise<void>
  stop(graceful?: () => void | Promise<void>): Promise<void>
}

export interface OwnedProcessTreeOptions {
  readonly processGroup?: boolean
  readonly rootExited?: Promise<void>
  readonly expectedAncestorPid?: number
  readonly platform?: NodeJS.Platform
  readonly gracefulMs?: number
  readonly termMs?: number
  readonly killMs?: number
  readonly pollMs?: number
  readonly timeoutMs?: number
  readonly inspect?: () => Promise<readonly ProcessIdentity[]>
  readonly signal?: (
    pid: number,
    signal: NodeJS.Signals,
    identity?: ProcessIdentity
  ) => Promise<void>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

const watched = new Set<TrackedProcessTree>()
let sampler: ReturnType<typeof setInterval> | null = null
let reading: Promise<readonly ProcessIdentity[]> | null = null

function sharedSnapshot(): Promise<readonly ProcessIdentity[]> {
  reading ??= inspectProcessTable(process.platform).finally(() => {
    reading = null
  })
  return reading
}

function watch(tree: TrackedProcessTree): void {
  watched.add(tree)
  sampler ??= setInterval(() => {
    void sharedSnapshot().then(
      (rows) => {
        for (const entry of watched) entry.observeSafely(rows)
      },
      () => undefined
    )
  }, 1_000)
  sampler.unref()
}

function unwatch(tree: TrackedProcessTree): void {
  watched.delete(tree)
  if (watched.size !== 0 || sampler === null) return
  clearInterval(sampler)
  sampler = null
}

const same = (left: ProcessIdentity, right: ProcessIdentity): boolean =>
  left.pid === right.pid && left.startedAt !== null && left.startedAt === right.startedAt

const running = (entry: ProcessIdentity): boolean => !entry.state.startsWith('Z')

function birthAtOrAfter(child: ProcessIdentity, parent: ProcessIdentity): boolean {
  if (child.startedAt === null || parent.startedAt === null) {
    throw new Error('Cannot inspect owned process birth order.')
  }
  if (/^\d+$/.test(child.startedAt) && /^\d+$/.test(parent.startedAt)) {
    return BigInt(child.startedAt) >= BigInt(parent.startedAt)
  }
  const childBirth = Date.parse(child.startedAt)
  const parentBirth = Date.parse(parent.startedAt)
  if (!Number.isFinite(childBirth) || !Number.isFinite(parentBirth)) {
    throw new Error('Cannot inspect owned process birth order.')
  }
  return childBirth >= parentBirth
}

export function ownProcessTree(
  pid: number,
  options: OwnedProcessTreeOptions = {}
): OwnedProcessTree {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error('An owned process must have a valid child PID.')
  }
  return new TrackedProcessTree(pid, options)
}

class TrackedProcessTree implements OwnedProcessTree {
  private readonly tracked = new Map<number, ProcessIdentity>()
  private readonly inspect: () => Promise<readonly ProcessIdentity[]>
  private readonly signal: NonNullable<OwnedProcessTreeOptions['signal']>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly initialized: Promise<void>
  private readonly processGroup: boolean
  private root: ProcessIdentity | null = null
  private rootExited = false
  private stopped = false
  private gone = false
  private stopping: Promise<void> | null = null

  constructor(
    private readonly pid: number,
    private readonly options: OwnedProcessTreeOptions
  ) {
    const platform = options.platform ?? process.platform
    this.processGroup = options.processGroup === true && platform !== 'win32'
    this.inspect =
      options.inspect ??
      (platform === process.platform ? sharedSnapshot : () => inspectProcessTable(platform))
    this.signal =
      options.signal ??
      ((target, signal, identity) => signalOwnedProcess(target, signal, platform, identity))
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
    void options.rootExited?.then(
      () => {
        this.rootExited = true
      },
      () => undefined
    )
    this.initialized = this.read().then(
      () => undefined,
      () => undefined
    )
    if (options.inspect === undefined && platform === process.platform) watch(this)
  }

  async capture(): Promise<void> {
    await this.initialized
    await this.read()
  }

  observeSafely(rows: readonly ProcessIdentity[]): void {
    if (this.stopped || this.gone) return
    try {
      this.observe(rows)
    } catch {
      return
    }
  }

  stop(graceful?: () => void | Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.stopping !== null) return this.stopping
    const stopping = this.finishStop(graceful).then(
      () => {
        this.stopped = true
        this.tracked.clear()
        this.root = null
        unwatch(this)
      },
      (error: unknown) => {
        this.stopping = null
        throw new ProcessCleanupError(
          error instanceof Error ? error.message : String(error),
          () => this.stop(graceful),
          error
        )
      }
    )
    this.stopping = stopping
    return stopping
  }

  private async finishStop(graceful?: () => void | Promise<void>): Promise<void> {
    const deadline = this.now() + (this.options.timeoutMs ?? 10_000)
    await this.initialized
    this.assertTime(deadline)
    await this.read()
    if (graceful !== undefined) {
      await Promise.race([
        Promise.resolve()
          .then(graceful)
          .catch(() => undefined),
        this.sleep(Math.max(0, Math.min(this.options.gracefulMs ?? 2_000, deadline - this.now()))),
      ])
      if (await this.wait(this.options.gracefulMs ?? 2_000, deadline)) return
    }
    await this.send('SIGTERM', deadline)
    if (await this.wait(this.options.termMs ?? 2_000, deadline)) return
    await this.send('SIGKILL', deadline)
    if (await this.wait(this.options.killMs ?? 2_000, deadline)) return
    const remaining = await this.read()
    throw new Error(
      `Owned processes did not exit: ${remaining.map((entry) => String(entry.pid)).join(', ')}.`
    )
  }

  private async wait(budget: number, overall: number): Promise<boolean> {
    const deadline = Math.min(this.now() + budget, overall)
    for (;;) {
      if ((await this.read()).length === 0) return true
      const left = deadline - this.now()
      if (left <= 0) return false
      await this.sleep(Math.min(left, this.options.pollMs ?? 100))
    }
  }

  private async send(signal: NodeJS.Signals, deadline: number): Promise<void> {
    this.assertTime(deadline)
    const live = await this.read()
    const group = this.processGroup && live.some((entry) => entry.groupId === this.pid)
    if (group) await this.signal(-this.pid, signal)
    for (const entry of live.toReversed()) {
      if (group && entry.groupId === this.pid) continue
      this.assertTime(deadline)
      const current = (await this.inspect()).find((row) => row.pid === entry.pid)
      if (current === undefined || !running(current)) continue
      if (current.startedAt === null)
        throw new Error(`Cannot inspect owned PID ${String(entry.pid)}.`)
      if (same(entry, current)) await this.signal(entry.pid, signal, entry)
    }
  }

  private assertTime(deadline: number): void {
    if (this.now() > deadline) {
      throw new Error('Owned process shutdown could not be confirmed before its deadline.')
    }
  }

  private isGone(): boolean {
    return this.gone
  }

  private async read(): Promise<ProcessIdentity[]> {
    if (this.gone) return []
    const rows = await this.inspect()
    if (this.isGone() || this.stopped) return []
    this.observe(rows)
    return this.live(rows)
  }

  private observe(rows: readonly ProcessIdentity[]): void {
    const byPid = new Map(rows.map((row) => [row.pid, row]))
    if (this.root === null) {
      const root = byPid.get(this.pid)
      if (root === undefined) {
        if (
          this.rootExited &&
          !rows.some((row) => row.parentPid === this.pid || row.groupId === this.pid)
        )
          return
        throw new Error(`Cannot establish ownership of PID ${String(this.pid)} before it exits.`)
      }
      if (this.rootExited)
        throw new Error(`Cannot adopt PID ${String(this.pid)} after its owner exited.`)
      if (root.startedAt === null) throw new Error(`Cannot inspect owned PID ${String(this.pid)}.`)
      this.validateAncestor(root, byPid)
      if (this.processGroup && root.groupId !== this.pid) {
        throw new Error(`PID ${String(this.pid)} does not own its process group.`)
      }
      this.root = root
      this.tracked.set(root.pid, root)
    }
    const disappeared = [...this.tracked.values()].filter((known) => {
      const current = byPid.get(known.pid)
      return (
        current === undefined ||
        !running(current) ||
        (current.startedAt !== null && !same(known, current))
      )
    })
    const owned = new Set(this.live(rows).map((row) => row.pid))
    if (this.processGroup && [...owned].some((pid) => byPid.get(pid)?.groupId === this.pid)) {
      for (const row of rows) {
        if (row.groupId === this.pid && running(row)) this.remember(row, owned)
      }
    }
    for (let changed = true; changed;) {
      changed = false
      for (const row of rows) {
        if (owned.has(row.pid) || !owned.has(row.parentPid) || !running(row)) continue
        const parent = byPid.get(row.parentPid)
        if (parent === undefined || !birthAtOrAfter(row, parent)) continue
        this.remember(row, owned)
        changed = true
      }
    }
    for (const row of rows) {
      if (owned.has(row.pid) || !running(row)) continue
      const parent = disappeared.find((known) => known.pid === row.parentPid)
      if (parent === undefined || !birthAtOrAfter(row, parent)) continue
      const replacement = byPid.get(parent.pid)
      if (
        replacement !== undefined &&
        !same(parent, replacement) &&
        birthAtOrAfter(row, replacement)
      )
        continue
      throw new Error(
        `Child PID ${String(row.pid)} outlived an owned parent before its identity could be captured.`
      )
    }
    for (const known of disappeared) {
      if (this.tracked.get(known.pid) === known) this.tracked.delete(known.pid)
    }
    const replacementRoot = byPid.get(this.pid)
    const groupReused = replacementRoot !== undefined && !same(this.root, replacementRoot)
    if (
      this.processGroup &&
      !groupReused &&
      owned.size === 0 &&
      rows.some((row) => row.groupId === this.pid && running(row))
    ) {
      throw new Error(
        `The process group for PID ${String(this.pid)} remains, but its ownership cannot be confirmed.`
      )
    }
    if (owned.size === 0) {
      this.gone = true
      unwatch(this)
    }
  }

  private remember(row: ProcessIdentity, owned: Set<number>): void {
    if (row.pid === process.pid || row.pid <= 1 || row.startedAt === null) {
      throw new Error('Cannot safely identify an owned child process.')
    }
    this.tracked.set(row.pid, row)
    owned.add(row.pid)
  }

  private live(rows: readonly ProcessIdentity[]): ProcessIdentity[] {
    return rows.filter((row) => {
      const owned = this.tracked.get(row.pid)
      if (owned === undefined || !running(row)) return false
      if (row.startedAt === null) throw new Error(`Cannot inspect owned PID ${String(row.pid)}.`)
      return same(owned, row)
    })
  }

  private validateAncestor(
    root: ProcessIdentity,
    byPid: ReadonlyMap<number, ProcessIdentity>
  ): void {
    const ancestor = this.options.expectedAncestorPid
    if (ancestor === undefined) return
    const visited = new Set<number>()
    let cursor = root
    while (!visited.has(cursor.pid)) {
      const parent = byPid.get(cursor.parentPid)
      if (parent === undefined || !birthAtOrAfter(cursor, parent)) break
      if (parent.pid === ancestor) return
      visited.add(cursor.pid)
      cursor = parent
    }
    throw new Error(`PID ${String(root.pid)} is not a child of its expected owner.`)
  }
}
