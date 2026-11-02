import { basename } from 'node:path'
import { LOCAL_HOST, type Project, type RunCommands } from '@chorus/event-store'
import type { Logger } from '@chorus/shared'
import { TRAFFIC_ENV_NAME } from '../shared/traffic-ipc.js'
import type { WorkbenchTerminalEnv } from '../shared/workbench-ipc.js'
import {
  terminalEnvOf,
  type ProjectTrafficRegistry,
  type ProjectTrafficState,
} from './project-traffic.js'
import type { ShellChoice } from './shell.js'
import type { ProjectTerminalRef, TerminalService } from './terminal.js'

export interface ActiveCommand {
  readonly id: string
  readonly label: string
  readonly command: string
}

export type RunFailure =
  | 'not-local'
  | 'unsupported-platform'
  | 'unsupported-shell'
  | 'no-command'
  | 'no-origin'
  | 'no-variable'
  | 'capture-failed'
  | 'no-redirect'
  | 'spawn-failed'
  | 'cancelled'
  | 'stop-incomplete'

export type RunProcess =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting'; readonly token: number; readonly active: ActiveCommand }
  | {
      readonly kind: 'running'
      readonly token: number
      readonly active: ActiveCommand
      readonly pgid: number
    }
  | { readonly kind: 'stopping'; readonly token: number; readonly active: ActiveCommand }
  | {
      readonly kind: 'exited'
      readonly token: number
      readonly active: ActiveCommand
      readonly code: number | null
    }
  | { readonly kind: 'failed'; readonly reason: RunFailure; readonly active: ActiveCommand | null }

export interface RunSnapshot {
  readonly process: RunProcess
  readonly cleanupPending: boolean
}

export interface RunChange extends RunSnapshot {
  readonly projectId: string
}

export type RunProject = Pick<
  Project,
  'host' | 'canonicalRoot' | 'runCommands' | 'trafficOrigin' | 'trafficEnvVar'
>

export interface ProjectRunnerDeps {
  readonly project: (projectId: string) => RunProject | null
  readonly traffic: Pick<ProjectTrafficRegistry, 'start' | 'stop' | 'state'>
  readonly terminals: Pick<TerminalService, 'launch' | 'interrupt' | 'tap' | 'dispose'>
  readonly shell: () => ShellChoice
  readonly env: () => NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void
  readonly log: Pick<Logger, 'warn'>
}

interface Escalation {
  readonly interrupt: number
  readonly term: number
  readonly kill: number
}

interface Prepared {
  readonly cwd: string
  readonly shell: string
  readonly active: ActiveCommand
  readonly captureTraffic: boolean
}

type Outcome = 'gone' | 'present' | 'superseded'

interface Cleanup {
  cancelled: boolean
  wake: (() => void) | null
}

interface Run {
  readonly projectId: string
  readonly token: number
  readonly active: ActiveCommand
  readonly captureTraffic: boolean
  readonly exit: Promise<void>
  readonly reportExit: () => void
  cancelled: boolean
  pgid: number | null
  exited: boolean
  code: number | null
  gone: boolean
  cleanup: Cleanup | null
}

interface Stopping {
  done: Promise<void>
  relaunch: ActiveCommand | null
  stopRecording: boolean
}

interface Entry {
  readonly projectId: string
  process: RunProcess
  run: Run | null
  launching: Promise<void> | null
  stopping: Stopping | null
  settling: ReturnType<typeof setTimeout> | null
  captures: Promise<void>
  ender: Cleanup | null
  disposed: boolean
}

const SHELLS = new Set(['zsh', 'bash', 'sh'])
const PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'linux'])
const STOP: Escalation = { interrupt: 5_000, term: 2_000, kill: 1_000 }
const QUIT: Escalation = { interrupt: 250, term: 750, kill: 2_000 }
const QUIT_DEADLINE_MS = 2_000
const REMOVAL_DEADLINE_MS = 10_000
const POLL_MS = 50
const EXIT_SETTLE_MS = 500
const EXIT_REPORT_MS = 250
const NO_DEADLINE = Number.POSITIVE_INFINITY
const IDLE: RunProcess = { kind: 'idle' }

export const runRef = (projectId: string): ProjectTerminalRef => ({
  scope: 'project',
  projectId,
  id: 'run',
})

export const runAvailable = (
  project: Pick<RunProject, 'host'>,
  platform: NodeJS.Platform
): boolean => project.host === LOCAL_HOST && PLATFORMS.has(platform)

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const scriptOf = (redirect: WorkbenchTerminalEnv | null, command: string): string =>
  redirect === null
    ? `set +m; ${command}`
    : `set +m; export ${redirect.name}=${quote(redirect.value)}; ${command}`

const noop = (): void => undefined

const isCancelled = (cleanup: Cleanup): boolean => cleanup.cancelled

const cancel = (cleanup: Cleanup | null): void => {
  if (cleanup === null) return
  cleanup.cancelled = true
  cleanup.wake?.()
}

const pause = (cleanup: Cleanup, ms: number, early?: Promise<void>): Promise<void> =>
  new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (): void => {
      if (timer !== null) clearTimeout(timer)
      if (cleanup.wake === done) cleanup.wake = null
      resolve()
    }
    timer = setTimeout(done, Math.max(0, ms))
    cleanup.wake = done
    if (early !== undefined) void early.then(done)
  })

const within = (promise: Promise<void>, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void promise.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })

const errnoOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined

const isDisposed = (entry: Entry): boolean => entry.disposed

const ownedRun = (entry: Entry): Run | null => {
  const run = entry.run
  if (run === null) return null
  return run.pgid !== null && !run.gone ? run : null
}

function chosen(commands: RunCommands | null, commandId: string | undefined): ActiveCommand | null {
  if (commands === null) return null
  const wanted = commandId ?? commands.defaultId
  const found = commands.commands.find((each) => each.id === wanted)
  return found === undefined ? null : { id: found.id, label: found.label, command: found.command }
}

function newRun(
  projectId: string,
  token: number,
  active: ActiveCommand,
  captureTraffic: boolean
): Run {
  let reportExit: () => void = () => undefined
  const exit = new Promise<void>((resolve) => {
    reportExit = resolve
  })
  return {
    projectId,
    token,
    active,
    captureTraffic,
    exit,
    reportExit,
    cancelled: false,
    pgid: null,
    exited: false,
    code: null,
    gone: false,
    cleanup: null,
  }
}

export class ProjectRunner {
  private readonly deps: ProjectRunnerDeps
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<(change: RunChange) => void>()
  private readonly untap: () => void
  private readonly removed = new Set<string>()
  private readonly removals = new Map<string, Promise<void>>()
  private closing: Promise<void> | null = null
  private tokens = 0
  private closed = false

  constructor(deps: ProjectRunnerDeps) {
    this.deps = deps
    this.untap = deps.terminals.tap((ref, event, generation) => {
      if (ref.scope !== 'project' || event.kind !== 'exit') return
      this.leaderExited(ref.projectId, generation, event.code)
    })
  }

  subscribe(listener: (change: RunChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  state(projectId: string): RunProcess {
    return this.entries.get(projectId)?.process ?? IDLE
  }

  snapshot(projectId: string): RunSnapshot {
    const entry = this.entries.get(projectId)
    return entry === undefined ? { process: IDLE, cleanupPending: false } : this.snapshotOf(entry)
  }

  private readonly suspended = new Set<string>()

  async suspend(projectId: string): Promise<void> {
    this.suspended.add(projectId)
    const entry = this.entries.get(projectId)
    if (entry === undefined) return
    if (entry.run !== null) entry.run.cancelled = true
    if (entry.stopping !== null) entry.stopping.relaunch = null
    const results = await Promise.allSettled([
      entry.launching,
      entry.stopping?.done,
      entry.captures,
    ])
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (errors.length > 0)
      throw new AggregateError(
        errors.map((result): unknown => result.reason),
        'Project work could not finish stopping'
      )
  }

  releaseStopped(projectId: string): void {
    const entry = this.entries.get(projectId)
    if (entry === undefined) return
    this.cancelSettle(entry)
    if (entry.run !== null) {
      entry.run.gone = true
      this.supersede(entry.run)
    }
    entry.run = null
    this.publish(entry, IDLE)
    entry.disposed = true
    this.entries.delete(projectId)
  }

  allowProject(projectId: string): void {
    this.suspended.delete(projectId)
  }

  run(projectId: string, commandId?: string): Promise<RunSnapshot> {
    const entry = this.open(projectId)
    if (entry === null || this.blocked(entry)) return Promise.resolve(this.snapshot(projectId))
    const project = this.deps.project(projectId)
    return this.launchWith(entry, project, chosen(project?.runCommands ?? null, commandId))
  }

  restart(projectId: string): Promise<RunSnapshot> {
    const entry = this.live(projectId)
    if (entry === null) return Promise.resolve(this.snapshot(projectId))
    const current = entry.process
    if (current.kind === 'idle' || current.kind === 'starting' || current.kind === 'stopping') {
      return Promise.resolve(this.snapshotOf(entry))
    }
    const active = current.active
    if (active === null) return Promise.resolve(this.snapshotOf(entry))
    const run = ownedRun(entry)
    if (run !== null) return this.after(entry, this.beginStop(entry, run, active, false))
    return this.launchWith(entry, this.deps.project(projectId), active)
  }

  stop(projectId: string): Promise<RunSnapshot> {
    const entry = this.live(projectId)
    if (entry === null) return Promise.resolve(this.snapshot(projectId))
    if (entry.process.kind === 'starting') {
      if (entry.run !== null) entry.run.cancelled = true
      return this.after(entry, entry.launching)
    }
    if (entry.stopping !== null) {
      entry.stopping.relaunch = null
      entry.stopping.stopRecording = true
      return this.after(entry, entry.stopping.done)
    }
    const run = ownedRun(entry)
    if (run === null) return Promise.resolve(this.snapshotOf(entry))
    return this.after(entry, this.beginStop(entry, run, null, true))
  }

  async stopRecording(projectId: string): Promise<RunSnapshot> {
    const entry = this.open(projectId)
    if (entry === null) return this.snapshot(projectId)
    const kind = entry.process.kind
    if (kind === 'starting' || kind === 'running' || kind === 'stopping') {
      return this.snapshotOf(entry)
    }
    await this.capture(entry, async () => {
      if (this.recording(projectId)) await this.stopTraffic(projectId)
    })
    return this.snapshotOf(entry)
  }

  captureOnly(projectId: string, change: 'start' | 'stop'): Promise<ProjectTrafficState> {
    const entry = this.open(projectId)
    if (entry === null) return Promise.reject(new Error('That project is going away'))
    const kind = entry.process.kind
    if (kind === 'starting' || kind === 'running' || kind === 'stopping') {
      return Promise.reject(new Error('Capture belongs to the running command'))
    }
    return this.capture(entry, () => {
      if (entry.disposed || this.closed || this.entries.get(projectId) !== entry) {
        return Promise.reject(new Error('That project is going away'))
      }
      const traffic = this.deps.traffic
      return change === 'start' ? traffic.start(projectId) : traffic.stop(projectId)
    })
  }

  dispose(projectId: string): Promise<void> {
    const pending = this.removals.get(projectId)
    if (pending !== undefined) return pending
    this.removed.add(projectId)
    if (this.closing !== null) return this.closing
    const removal = this.remove(projectId)
    this.removals.set(projectId, removal)
    return removal
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async remove(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId)
    if (entry === undefined) {
      this.deps.terminals.dispose(runRef(projectId))
      return
    }
    const deadline = Date.now() + REMOVAL_DEADLINE_MS
    const won = await this.teardown(entry, STOP, deadline, 'removal')
    if (!won && this.closing !== null) await this.closing
  }

  private async shutdown(): Promise<void> {
    this.closed = true
    const deadline = Date.now() + QUIT_DEADLINE_MS
    const entries = [...this.entries.values()]
    await Promise.all(entries.map((entry) => this.teardown(entry, QUIT, deadline, 'quit')))
    this.untap()
  }

  private open(projectId: string): Entry | null {
    if (this.closed || this.removed.has(projectId) || this.suspended.has(projectId)) return null
    const existing = this.entries.get(projectId)
    if (existing !== undefined) return existing.disposed ? null : existing
    const entry: Entry = {
      projectId,
      process: IDLE,
      run: null,
      launching: null,
      stopping: null,
      settling: null,
      captures: Promise.resolve(),
      ender: null,
      disposed: false,
    }
    this.entries.set(projectId, entry)
    return entry
  }

  private live(projectId: string): Entry | null {
    if (this.closed || this.removed.has(projectId) || this.suspended.has(projectId)) return null
    const entry = this.entries.get(projectId)
    return entry === undefined || entry.disposed ? null : entry
  }

  private blocked(entry: Entry): boolean {
    const kind = entry.process.kind
    if (kind === 'starting' || kind === 'running' || kind === 'stopping') return true
    return ownedRun(entry) !== null
  }

  private recording(projectId: string): boolean {
    return this.deps.traffic.state(projectId)?.capturing === true
  }

  private validate(
    project: RunProject | null,
    active: ActiveCommand | null
  ): Prepared | RunFailure {
    if (project?.host !== LOCAL_HOST) return 'not-local'
    if (!PLATFORMS.has(this.deps.platform)) return 'unsupported-platform'
    if (active === null) return 'no-command'
    const variable = project.trafficEnvVar
    if (variable !== null && !TRAFFIC_ENV_NAME.test(variable)) return 'no-variable'
    const captureTraffic =
      project.trafficOrigin !== null && project.trafficOrigin !== '' && variable !== null
    const shell = this.deps.shell().file
    if (!SHELLS.has(basename(shell))) return 'unsupported-shell'
    return { cwd: project.canonicalRoot, shell, active, captureTraffic }
  }

  private launchWith(
    entry: Entry,
    project: RunProject | null,
    active: ActiveCommand | null
  ): Promise<RunSnapshot> {
    const prepared = this.validate(project, active)
    if (typeof prepared === 'string') {
      this.publish(entry, { kind: 'failed', reason: prepared, active })
      return Promise.resolve(this.snapshotOf(entry))
    }
    this.tokens += 1
    const run = newRun(entry.projectId, this.tokens, prepared.active, prepared.captureTraffic)
    entry.run = run
    this.publish(entry, { kind: 'starting', token: run.token, active: run.active })
    const launching: Promise<void> = this.launch(entry, run, prepared).finally(() => {
      if (entry.launching === launching) entry.launching = null
    })
    entry.launching = launching
    return this.after(entry, launching)
  }

  private async launch(entry: Entry, run: Run, prepared: Prepared): Promise<void> {
    const { recordingBefore, started } = prepared.captureTraffic
      ? await this.capture(entry, async () => {
          const before = this.recording(entry.projectId)
          if (entry.disposed || run.cancelled) return { recordingBefore: before, started: null }
          const state = await this.deps.traffic.start(entry.projectId).catch(() => null)
          return { recordingBefore: before, started: state }
        })
      : { recordingBefore: false, started: null }
    if (entry.disposed || run.cancelled || entry.run !== run) {
      await this.abandon(entry, run, recordingBefore, started, 'cancelled')
      return
    }
    if (
      prepared.captureTraffic &&
      (started === null || !started.capturing || started.port === null)
    ) {
      await this.abandon(entry, run, recordingBefore, started, 'capture-failed')
      return
    }
    const redirect = started === null ? null : terminalEnvOf(started)
    if (prepared.captureTraffic && redirect === null) {
      await this.abandon(entry, run, recordingBefore, started, 'no-redirect')
      return
    }
    const pid = this.spawn(run, prepared, redirect)
    if (pid === null) {
      await this.abandon(entry, run, recordingBefore, started, 'spawn-failed')
      return
    }
    run.pgid = pid
    if (run.exited) {
      this.leaderGone(entry, run)
      return
    }
    this.publish(entry, { kind: 'running', token: run.token, active: run.active, pgid: pid })
  }

  private spawn(
    run: Run,
    prepared: Prepared,
    redirect: WorkbenchTerminalEnv | null
  ): number | null {
    try {
      const result = this.deps.terminals.launch(runRef(run.projectId), {
        cwd: prepared.cwd,
        env:
          redirect === null
            ? this.deps.env()
            : { ...this.deps.env(), [redirect.name]: redirect.value },
        file: prepared.shell,
        args: ['-l', '-i', '-c', scriptOf(redirect, run.active.command)],
        generation: run.token,
      })
      return result.kind === 'launched' ? result.pid : null
    } catch {
      return null
    }
  }

  private async abandon(
    entry: Entry,
    run: Run,
    recordingBefore: boolean,
    started: ProjectTrafficState | null,
    reason: RunFailure
  ): Promise<void> {
    if (!recordingBefore && started?.capturing === true) {
      await this.capture(entry, () => this.stopTraffic(entry.projectId))
    }
    if (entry.run === run) entry.run = null
    const failure = run.cancelled ? 'cancelled' : reason
    this.publish(entry, { kind: 'failed', reason: failure, active: run.active })
  }

  private leaderExited(projectId: string, token: number, code: number): void {
    const entry = this.entries.get(projectId)
    if (entry === undefined) return
    const run = entry.run
    if (run?.token !== token || run.exited) return
    run.exited = true
    run.code = code
    run.reportExit()
    if (entry.disposed || run.pgid === null) return
    if (entry.process.kind !== 'running' || entry.process.token !== token) return
    this.leaderGone(entry, run)
  }

  private leaderGone(entry: Entry, run: Run): void {
    this.publish(entry, { kind: 'exited', token: run.token, active: run.active, code: run.code })
    this.cancelSettle(entry)
    entry.settling = setTimeout(() => {
      entry.settling = null
      if (entry.disposed || entry.stopping !== null || entry.run !== run) return
      if (!this.confirmGone(run)) return
      entry.run = null
      this.publish(entry, entry.process)
    }, EXIT_SETTLE_MS)
  }

  private cancelSettle(entry: Entry): void {
    if (entry.settling === null) return
    clearTimeout(entry.settling)
    entry.settling = null
  }

  private beginStop(
    entry: Entry,
    run: Run,
    relaunch: ActiveCommand | null,
    stopRecording: boolean
  ): Promise<void> {
    this.cancelSettle(entry)
    const stopping: Stopping = { done: Promise.resolve(), relaunch, stopRecording }
    entry.stopping = stopping
    this.publish(entry, { kind: 'stopping', token: run.token, active: run.active })
    stopping.done = this.finishStop(entry, run, stopping)
    return stopping.done
  }

  private async finishStop(entry: Entry, run: Run, stopping: Stopping): Promise<void> {
    const outcome = await this.escalate(run, STOP, NO_DEADLINE)
    if (outcome === 'superseded' || entry.disposed) return
    if (outcome === 'gone' && !run.exited) await within(run.exit, EXIT_REPORT_MS)
    if (isDisposed(entry)) return
    if (outcome === 'gone' && stopping.relaunch !== null) {
      entry.stopping = null
      if (entry.run === run) entry.run = null
      await this.launchWith(entry, this.deps.project(entry.projectId), stopping.relaunch)
      return
    }
    if (stopping.stopRecording && run.captureTraffic) {
      await this.capture(entry, () => this.stopTraffic(entry.projectId))
      if (isDisposed(entry)) return
    }
    entry.stopping = null
    if (outcome === 'present') {
      this.publish(entry, { kind: 'failed', reason: 'stop-incomplete', active: run.active })
      return
    }
    if (entry.run === run) entry.run = null
    this.publish(entry, { kind: 'exited', token: run.token, active: run.active, code: run.code })
  }

  private async escalate(run: Run, budget: Escalation, deadline: number): Promise<Outcome> {
    this.supersede(run)
    const cleanup: Cleanup = { cancelled: false, wake: null }
    run.cleanup = cleanup
    const outcome = await this.clean(run, cleanup, budget, deadline)
    if (run.cleanup === cleanup) run.cleanup = null
    return outcome
  }

  private async clean(
    run: Run,
    cleanup: Cleanup,
    budget: Escalation,
    deadline: number
  ): Promise<Outcome> {
    const left = (ms: number): number => Math.max(0, Math.min(ms, deadline - Date.now()))
    if (!run.exited && !run.gone) {
      this.deps.terminals.interrupt(runRef(run.projectId), run.token)
      await pause(cleanup, left(budget.interrupt), run.exit)
      if (cleanup.cancelled) return 'superseded'
    }
    if (this.confirmGone(run)) return 'gone'
    this.signal(run, 'SIGTERM')
    const termed = await this.poll(run, cleanup, Date.now() + left(budget.term))
    if (termed !== 'present') return termed
    this.signal(run, 'SIGKILL')
    return this.poll(run, cleanup, Date.now() + left(budget.kill))
  }

  private async poll(run: Run, cleanup: Cleanup, until: number): Promise<Outcome> {
    while (!this.confirmGone(run)) {
      const remaining = until - Date.now()
      if (remaining <= 0) return 'present'
      await pause(cleanup, Math.min(POLL_MS, remaining))
      if (cleanup.cancelled) return 'superseded'
    }
    return 'gone'
  }

  private supersede(run: Run): void {
    const active = run.cleanup
    run.cleanup = null
    cancel(active)
  }

  private confirmGone(run: Run): boolean {
    if (run.gone) return true
    if (run.pgid === null) return false
    try {
      this.deps.kill(-run.pgid, 0)
      return false
    } catch (error) {
      if (errnoOf(error) !== 'ESRCH') return false
      run.gone = true
      return true
    }
  }

  private signal(run: Run, signal: NodeJS.Signals): void {
    if (run.gone || run.pgid === null) return
    try {
      this.deps.kill(-run.pgid, signal)
    } catch (error) {
      if (errnoOf(error) === 'ESRCH') run.gone = true
    }
  }

  private async teardown(
    entry: Entry,
    budget: Escalation,
    deadline: number,
    cause: 'removal' | 'quit'
  ): Promise<boolean> {
    cancel(entry.ender)
    const ender: Cleanup = { cancelled: false, wake: null }
    entry.ender = ender
    entry.disposed = true
    this.cancelSettle(entry)
    if (entry.run !== null) {
      entry.run.cancelled = true
      this.supersede(entry.run)
    }
    if (entry.stopping !== null) entry.stopping.relaunch = null
    const pending: Promise<void>[] = []
    if (entry.launching !== null) pending.push(entry.launching)
    if (entry.stopping !== null) pending.push(entry.stopping.done)
    await pause(ender, deadline - Date.now(), Promise.all(pending).then(noop))
    if (ender.cancelled) return false
    const run = ownedRun(entry)
    if (run !== null) {
      const outcome = await this.escalate(run, budget, deadline)
      if (outcome === 'superseded' || isCancelled(ender)) return false
      if (outcome === 'present') {
        this.deps.log.warn('a run outlived its cleanup', {
          projectId: entry.projectId,
          cause,
          label: run.active.label,
          pgid: run.pgid,
        })
      }
    }
    entry.run = null
    if (this.entries.get(entry.projectId) === entry) this.entries.delete(entry.projectId)
    this.deps.terminals.dispose(runRef(entry.projectId))
    return true
  }

  private async stopTraffic(projectId: string): Promise<void> {
    await this.deps.traffic.stop(projectId).catch(() => null)
  }

  private capture<T>(entry: Entry, change: () => Promise<T>): Promise<T> {
    const next = entry.captures.then(change)
    entry.captures = next.then(noop, noop)
    return next
  }

  private after(entry: Entry, pending: Promise<unknown> | null): Promise<RunSnapshot> {
    return (pending ?? Promise.resolve()).then(() => this.snapshotOf(entry))
  }

  private snapshotOf(entry: Entry): RunSnapshot {
    const kind = entry.process.kind
    const settled = kind === 'exited' || kind === 'failed'
    return { process: entry.process, cleanupPending: settled && ownedRun(entry) !== null }
  }

  private publish(entry: Entry, next: RunProcess): void {
    if (entry.disposed) return
    entry.process = next
    const change: RunChange = { projectId: entry.projectId, ...this.snapshotOf(entry) }
    for (const listener of this.listeners) listener(change)
  }
}
