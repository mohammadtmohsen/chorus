import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  PERSON_PACED_CHANNELS,
  PROTOCOL_VERSION,
  ServerMessage,
  type ClientMessage,
  EngineActivity,
  type Hello,
  type EngineDescriptor,
} from './protocol.js'
import {
  buildOf,
  readDescriptor,
  readRuntimeManifest,
  runtimeCopy,
  type EngineInstall,
} from './descriptor.js'
import { encodeFrame, FrameReader } from './wire.js'

export type EngineState =
  'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'restart-required'
type Outgoing = Extract<Exclude<ClientMessage, { kind: 'hostAnswer' }>, { id: string }>
type RequestInput = {
  [K in Outgoing['kind']]: Omit<Extract<Outgoing, { kind: K }>, 'id'>
}[Outgoing['kind']]
type Welcome = Extract<ServerMessage, { kind: 'welcome' }>
export type EngineClientErrorCode = 'not-installed'
type StateListener = (
  state: EngineState,
  activity?: EngineActivity,
  errorCode?: EngineClientErrorCode
) => void

export interface EngineClientOptions {
  readonly dataDirectory: string
  readonly install: () => EngineInstall | null
  readonly appVersion: string
  readonly client: Hello['client']
  readonly role: Hello['role']
  readonly clientId: string
  readonly workspaceKey: string
  readonly workspaceFolders: string[]
  readonly trusted: boolean
  readonly secrets: () => Hello['secrets']
}

export class EngineClient {
  private socket: Socket | null = null
  private attachingSocket: Socket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private readonly waits = new Set<() => void>()
  private closed = false
  private connecting: Promise<Welcome> | null = null
  private welcome: Welcome | null = null
  private readonly pushes = new Set<(channel: string, payload: unknown) => void>()
  private readonly states = new Set<StateListener>()
  private readonly pending = new Map<
    string,
    {
      message: Outgoing
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout> | undefined
    }
  >()
  private hostHandler: (method: string, params: unknown) => Promise<unknown> = () =>
    Promise.reject(new Error('host-not-ready'))
  private mismatch = false
  private lastSeq = 0
  private projectIds: string[] = []
  private focused = false
  private attentive = false
  private viewVisible = true
  private focusedProjectId: string | null = null
  private everConnected = false

  constructor(readonly options: EngineClientOptions) {}
  private isClosed(): boolean {
    return this.closed
  }
  onPush(listener: (channel: string, payload: unknown) => void): () => void {
    this.pushes.add(listener)
    return () => {
      this.pushes.delete(listener)
    }
  }
  onState(listener: StateListener): () => void {
    this.states.add(listener)
    return () => {
      this.states.delete(listener)
    }
  }
  setHostHandler(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.hostHandler = handler
  }
  private report(
    state: EngineState,
    activity?: EngineActivity,
    errorCode?: EngineClientErrorCode
  ): void {
    for (const listener of this.states) listener(state, activity, errorCode)
  }
  private installation(): EngineInstall {
    const install = this.options.install()
    if (install === null) {
      this.report('stopped', undefined, 'not-installed')
      throw new Error('not-installed')
    }
    return install
  }
  private currentInstall(): EngineInstall | null {
    const install = this.installation()
    if (install.version === this.options.appVersion) return install
    this.report('restart-required')
    return null
  }
  private installedBuild(install: EngineInstall): string {
    const manifest = readRuntimeManifest(install.shipped)
    if (manifest?.version !== install.version) throw new Error('engine-install-invalid')
    return buildOf(install.shipped)
  }
  private pause(milliseconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('engine-client-closed'))
        return
      }
      const cancel = (): void => {
        clearTimeout(timer)
        this.waits.delete(cancel)
        reject(new Error('engine-client-closed'))
      }
      const timer = setTimeout(() => {
        this.waits.delete(cancel)
        resolve()
      }, milliseconds)
      this.waits.add(cancel)
    })
  }
  connect(): Promise<Welcome> {
    if (this.closed) return Promise.reject(new Error('engine-client-closed'))
    if (this.welcome !== null && this.socket !== null && !this.socket.destroyed)
      return Promise.resolve(this.welcome)
    this.connecting ??= this.startOrAttach().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }
  private runtimeCommand(): { executable: string; main: string; build: string } {
    const install = this.currentInstall()
    if (install === null) throw new Error('engine-client-outdated')
    this.installedBuild(install)
    const runtime = runtimeCopy(this.options.dataDirectory, install.shipped)
    const latest = this.currentInstall()
    if (latest === null) throw new Error('engine-client-outdated')
    if (
      latest.executable !== install.executable ||
      latest.shipped !== install.shipped ||
      this.installedBuild(latest) !== runtime.build
    )
      throw new Error('engine-install-changed')
    return { ...runtime, executable: latest.executable }
  }
  private async lockHeld(): Promise<boolean> {
    const runtime = this.runtimeCommand()
    return await new Promise((resolve, reject) => {
      const child = spawn(
        runtime.executable,
        [
          runtime.main,
          '--data',
          this.options.dataDirectory,
          '--build',
          runtime.build,
          '--probe-lock',
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' }
      )
      const finish = (error: Error | null, held = false): void => {
        clearTimeout(timer)
        this.waits.delete(cancel)
        if (error === null) resolve(held)
        else reject(error)
      }
      const cancel = (): void => {
        child.kill()
        finish(new Error('engine-client-closed'))
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(new Error('engine-lock-probe-timeout'))
      }, 10_000)
      this.waits.add(cancel)
      child.once('error', (error) => {
        finish(error)
      })
      child.once('exit', (code) => {
        if (code === 0 || code === 2) finish(null, code === 2)
        else finish(new Error('engine-lock-probe-failed'))
      })
      if (this.closed) cancel()
    })
  }
  private start(): void {
    const runtime = this.runtimeCommand()
    mkdirSync(this.options.dataDirectory, { recursive: true, mode: 0o700 })
    const log = openSync(join(this.options.dataDirectory, 'engine-launch.log'), 'a', 0o600)
    const child = spawn(
      runtime.executable,
      [runtime.main, '--data', this.options.dataDirectory, '--build', runtime.build],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: true,
        stdio: ['ignore', log, log],
      }
    )
    child.on('error', () => {
      this.report('stopped')
    })
    child.unref()
    closeSync(log)
  }
  private async startOrAttach(): Promise<Welcome> {
    this.report(this.lastSeq === 0 ? 'connecting' : 'reconnecting')
    let deadline = Date.now() + 40_000
    let started = false
    let nextStart = 0
    let lockHeld = false
    let nextLockProbe = 0
    let lastError: unknown
    while (!this.closed) {
      const install = this.installation()
      const descriptor = readDescriptor(this.options.dataDirectory)
      if (
        install.version !== this.options.appVersion &&
        descriptor?.appVersion !== this.options.appVersion
      ) {
        this.report('restart-required')
        throw new Error('engine-client-outdated')
      }
      if (descriptor !== null) {
        try {
          return await this.attach(descriptor)
        } catch (error) {
          lastError = error
          if (
            error instanceof Error &&
            (error.message === 'not-installed' ||
              error.message === 'engine-client-outdated' ||
              error.message === 'engine-install-invalid')
          )
            throw error
          if (
            error instanceof Error &&
            (error.message === 'engine-replace-idle' || error.message === 'engine-restart-gone')
          ) {
            started = false
            deadline = Date.now() + 40_000
          }
        }
      }
      if (this.isClosed()) break
      if (Date.now() >= nextLockProbe) {
        try {
          lockHeld = await this.lockHeld()
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'engine-install-changed') throw error
          lastError = error
          continue
        }
        nextLockProbe = Date.now() + 1000
      }
      if (lockHeld) {
        const unreadableDescriptor =
          descriptor === null && existsSync(join(this.options.dataDirectory, 'engine.json'))
        if (unreadableDescriptor) this.report('restart-required')
        if (descriptor !== null || unreadableDescriptor) deadline = Date.now() + 40_000
        if (Date.now() >= deadline) break
        await this.pause(unreadableDescriptor ? 5000 : 150)
        continue
      }
      if (this.currentInstall() === null) throw new Error('engine-client-outdated')
      if (Date.now() >= deadline) break
      if (!started || Date.now() >= nextStart) {
        try {
          this.start()
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'engine-install-changed') throw error
          lastError = error
          continue
        }
        started = true
        nextStart = Date.now() + 1000
        lockHeld = true
        nextLockProbe = nextStart
      }
      await this.pause(150)
    }
    if (this.closed) throw new Error('engine-client-closed')
    throw lastError instanceof Error ? lastError : new Error('engine-start-timeout')
  }
  private attach(descriptor: EngineDescriptor): Promise<Welcome> {
    return new Promise((resolve, reject) => {
      const install = this.installation()
      const current = install.version === this.options.appVersion
      if (!current && descriptor.appVersion !== this.options.appVersion) {
        this.report('restart-required')
        reject(new Error('engine-client-outdated'))
        return
      }
      const build = current ? this.installedBuild(install) : descriptor.build
      const socket = createConnection(descriptor.socketPath)
      this.attachingSocket = socket
      let welcomed = false
      let replacing = false
      let restartWaiting = false
      let statusId: string | null = null
      let shutdownId: string | null = null
      let polling: ReturnType<typeof setInterval> | undefined
      this.mismatch = false
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error('engine-handshake-timeout'))
      }, 10_000)
      const clearTimers = (): void => {
        clearTimeout(timeout)
        clearInterval(polling)
      }
      const fail = (error: unknown): void => {
        clearTimers()
        socket.destroy()
        reject(error instanceof Error ? error : new Error('engine-protocol-error'))
      }
      const replaceIfIdle = (activity: EngineActivity): void => {
        if (activity.busy || replacing || this.closed || socket.destroyed) return
        try {
          const latest = this.currentInstall()
          if (latest === null) return
          if (this.installedBuild(latest) !== build) {
            fail(new Error('engine-install-changed'))
            return
          }
          replacing = true
          shutdownId = randomUUID()
          socket.write(encodeFrame({ kind: 'shutdown', id: shutdownId }))
        } catch (error) {
          fail(error)
        }
      }
      const poll = (): void => {
        if (this.closed || socket.destroyed || replacing) return
        statusId = randomUUID()
        socket.write(encodeFrame({ kind: 'status', id: statusId }))
      }
      const reader = new FrameReader((raw) => {
        const parsed = ServerMessage.safeParse(raw)
        if (!parsed.success) {
          fail(new Error('engine-protocol-error'))
          return
        }
        const message = parsed.data
        if (message.kind === 'restartRequired') {
          this.mismatch = true
          restartWaiting = true
          clearTimeout(timeout)
          this.report('restart-required', message.activity)
          if (polling === undefined) {
            polling = setInterval(poll, 5000)
            polling.unref()
          }
          replaceIfIdle(message.activity)
          return
        }
        if (message.kind === 'welcome') {
          if (
            restartWaiting &&
            (descriptor.protocol !== PROTOCOL_VERSION ||
              descriptor.appVersion !== this.options.appVersion ||
              replacing)
          )
            return
          clearTimers()
          welcomed = true
          this.everConnected = true
          this.socket = socket
          this.welcome = message
          this.report(this.mismatch ? 'restart-required' : 'connected', message.activity)
          for (const pending of this.pending.values()) socket.write(encodeFrame(pending.message))
          this.focus(
            this.focused,
            this.projectIds,
            this.lastSeq,
            this.focusedProjectId,
            this.attentive,
            this.viewVisible
          )
          resolve(message)
          return
        }
        if (message.kind === 'answer') {
          if (message.id === statusId) {
            statusId = null
            if (message.ok) {
              const activity = EngineActivity.safeParse(message.value)
              if (!activity.success) {
                fail(new Error('engine-protocol-error'))
                return
              }
              this.report('restart-required', activity.data)
              replaceIfIdle(activity.data)
            }
            return
          }
          if (message.id === shutdownId) {
            shutdownId = null
            if (!message.ok) replacing = false
            return
          }
          const pending = this.pending.get(message.id)
          if (pending !== undefined) {
            this.pending.delete(message.id)
            clearTimeout(pending.timer)
            if (message.ok) {
              if (pending.message.kind === 'storage' && this.welcome !== null) {
                const value = pending.message.value
                if (typeof value === 'string') this.welcome.storage[pending.message.key] = value
                else if (value === null)
                  Reflect.deleteProperty(this.welcome.storage, pending.message.key)
              }
              pending.resolve(message.value)
            } else pending.reject(new Error(message.error ?? 'engine-request-failed'))
          }
        } else if (message.kind === 'push') {
          for (const listener of this.pushes) listener(message.channel, message.payload)
        } else {
          void Promise.resolve()
            .then(() => this.hostHandler(message.method, message.params))
            .then(
              (value) => {
                if (!socket.destroyed)
                  socket.write(encodeFrame({ kind: 'hostAnswer', id: message.id, ok: true, value }))
              },
              (error: unknown) => {
                if (!socket.destroyed)
                  socket.write(
                    encodeFrame({
                      kind: 'hostAnswer',
                      id: message.id,
                      ok: false,
                      error: error instanceof Error ? error.message : 'host-request-failed',
                    })
                  )
              }
            )
            .catch(() => {
              socket.destroy()
            })
        }
      })
      socket.once('connect', () => {
        let latest: EngineInstall
        try {
          latest = this.installation()
          if (
            latest.version !== this.options.appVersion &&
            descriptor.appVersion !== this.options.appVersion
          ) {
            this.report('restart-required')
            fail(new Error('engine-client-outdated'))
            return
          }
          if (latest.version === this.options.appVersion && this.installedBuild(latest) !== build) {
            fail(new Error('engine-install-changed'))
            return
          }
          socket.write(
            encodeFrame({
              kind: 'hello',
              token: descriptor.token,
              protocol: PROTOCOL_VERSION,
              build,
              appVersion: this.options.appVersion,
              client: this.options.client,
              role: this.options.role,
              clientId: this.options.clientId,
              workspaceKey: this.options.workspaceKey,
              workspaceFolders: this.options.workspaceFolders,
              trusted: this.options.trusted,
              secrets: this.options.secrets(),
              lastSeq: this.lastSeq,
              cold: !this.everConnected,
            })
          )
        } catch (error) {
          fail(error)
        }
      })
      socket.on('data', (chunk) => {
        try {
          reader.push(chunk)
        } catch (error) {
          fail(error)
        }
      })
      socket.once('error', (error) => {
        clearTimers()
        reject(error)
      })
      socket.once('close', () => {
        clearTimers()
        if (this.attachingSocket === socket) this.attachingSocket = null
        if (this.socket === socket) {
          this.socket = null
          this.welcome = null
          for (const [id, pending] of this.pending) {
            if (pending.message.kind !== 'shutdown') continue
            this.pending.delete(id)
            clearTimeout(pending.timer)
            pending.reject(new Error('engine-shutdown-disconnected'))
          }
        }
        if (!welcomed) {
          reject(
            new Error(
              replacing
                ? 'engine-replace-idle'
                : restartWaiting
                  ? 'engine-restart-gone'
                  : 'engine-gone'
            )
          )
          return
        }
        if (!this.closed) {
          this.report('reconnecting')
          this.mismatch = false
          clearTimeout(this.reconnectTimer)
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined
            if (!this.closed)
              void this.connect().catch((error: unknown) => {
                if (
                  !this.closed &&
                  !(
                    error instanceof Error &&
                    (error.message === 'not-installed' ||
                      error.message === 'engine-client-outdated')
                  )
                )
                  this.report('stopped')
              })
          }, 250)
        }
      })
    })
  }
  async request(
    message: RequestInput,
    id: string = randomUUID(),
    timeoutMs?: number
  ): Promise<unknown> {
    if (message.kind === 'shutdown' && this.currentInstall() === null)
      throw new Error('engine-client-outdated')
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs
    if (deadline === null) await this.connect()
    else await this.beforeDeadline(this.connect(), deadline)
    if (message.kind === 'shutdown' && this.currentInstall() === null)
      throw new Error('engine-client-outdated')
    if (deadline !== null && Date.now() >= deadline) throw new Error('engine-request-timeout')
    return await new Promise((resolve, reject) => {
      const request = { ...message, id }
      const timer =
        deadline === null && message.kind === 'invoke' && PERSON_PACED_CHANNELS.has(message.channel)
          ? undefined
          : setTimeout(
              () => {
                this.pending.delete(id)
                reject(new Error('engine-request-timeout'))
              },
              deadline === null ? 180_000 : Math.max(1, deadline - Date.now())
            )
      this.pending.set(id, { message: request, resolve, reject, timer })
      this.socket?.write(encodeFrame(request))
    })
  }
  invoke(channel: string, request: unknown, id?: string, timeoutMs?: number): Promise<unknown> {
    return this.request({ kind: 'invoke', channel, request }, id, timeoutMs)
  }
  private beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          reject(new Error('engine-request-timeout'))
        },
        Math.max(0, deadline - Date.now())
      )
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      )
    })
  }
  notify(
    message: Extract<ClientMessage, { kind: 'editorContext' | 'completionCancel' | 'secret' }>
  ): void {
    if (this.socket !== null && !this.socket.destroyed) this.socket.write(encodeFrame(message))
  }
  async replay(afterSeq: number): Promise<void> {
    await this.request({ kind: 'replay', afterSeq })
  }
  focus(
    focused: boolean,
    projectIds: string[],
    lastSeq: number,
    focusedProjectId: string | null = null,
    attentive = false,
    viewVisible = true
  ): void {
    this.viewVisible = viewVisible
    this.focused = focused
    this.attentive = attentive
    this.projectIds = projectIds
    this.focusedProjectId = focusedProjectId
    this.lastSeq = Math.max(this.lastSeq, lastSeq)
    if (this.socket !== null && !this.socket.destroyed)
      this.socket.write(
        encodeFrame({
          kind: 'focus',
          focused,
          attentive,
          viewVisible,
          projectIds,
          focusedProjectId,
          lastSeq: this.lastSeq,
        })
      )
  }
  async activity(timeoutMs?: number): Promise<EngineActivity> {
    return EngineActivity.parse(await this.request({ kind: 'status' }, undefined, timeoutMs))
  }
  async waitUntilIdle(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (!(await this.activity(deadline - Date.now())).busy) return true
      } catch {
        return false
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now())))
      )
    }
    return false
  }
  async restartWhenIdle(waitForConnection = false): Promise<boolean> {
    if (this.currentInstall() === null) return false
    const activity = await this.activity(waitForConnection ? 15_000 : undefined)
    if (activity.busy) {
      this.report('restart-required', activity)
      return false
    }
    if (!waitForConnection) {
      await this.request({ kind: 'shutdown' })
      return true
    }
    const generation = this.welcome?.generation
    const deadline = Date.now() + 60_000
    let stop = (): void => undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const connected = new Promise<void>((resolve, reject) => {
      stop = this.onState((state) => {
        if (
          state === 'connected' &&
          this.welcome !== null &&
          this.welcome.generation !== generation
        )
          resolve()
      })
      timer = setTimeout(() => {
        reject(new Error('engine-restart-timeout'))
      }, 60_000)
    })
    void connected.catch(() => undefined)
    try {
      try {
        await this.request({ kind: 'shutdown' }, undefined, Math.max(1, deadline - Date.now()))
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'engine-shutdown-disconnected')
          throw error
      }
      await connected
      return true
    } finally {
      clearTimeout(timer)
      stop()
    }
  }
  dispose(): void {
    this.closed = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    for (const cancel of this.waits) cancel()
    this.attachingSocket?.destroy()
    this.attachingSocket = null
    this.socket?.destroy()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('engine-client-closed'))
    }
    this.pending.clear()
  }
}
