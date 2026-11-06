import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  PERSON_PACED_CHANNELS,
  PROTOCOL_VERSION,
  ServerMessage,
  type ClientMessage,
  EngineActivity,
  type Hello,
} from '../../engine/src/protocol.js'
import { readDescriptor } from '../../engine/src/descriptor.js'
import { encodeFrame, FrameReader } from '../../engine/src/wire.js'

export type EngineState =
  'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'restart-required'
type Outgoing = Extract<Exclude<ClientMessage, { kind: 'hostAnswer' }>, { id: string }>
type RequestInput = {
  [K in Outgoing['kind']]: Omit<Extract<Outgoing, { kind: K }>, 'id'>
}[Outgoing['kind']]
type Welcome = Extract<ServerMessage, { kind: 'welcome' }>

export interface EngineClientOptions {
  readonly dataDirectory: string
  readonly engineMain: string
  readonly executable: string
  readonly clientId: string
  readonly workspaceKey: string
  readonly workspaceFolders: string[]
  readonly trusted: boolean
  readonly secrets: Hello['secrets']
}

export class EngineClient {
  readonly build: string
  private socket: Socket | null = null
  private closed = false
  private connecting: Promise<Welcome> | null = null
  private welcome: Welcome | null = null
  private readonly pushes = new Set<(channel: string, payload: unknown) => void>()
  private readonly states = new Set<(state: EngineState, activity?: EngineActivity) => void>()
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

  constructor(readonly options: EngineClientOptions) {
    this.build = createHash('sha256').update(readFileSync(options.engineMain)).digest('hex')
  }
  onPush(listener: (channel: string, payload: unknown) => void): () => void {
    this.pushes.add(listener)
    return () => {
      this.pushes.delete(listener)
    }
  }
  onState(listener: (state: EngineState, activity?: EngineActivity) => void): () => void {
    this.states.add(listener)
    return () => {
      this.states.delete(listener)
    }
  }
  setHostHandler(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.hostHandler = handler
  }
  private report(state: EngineState, activity?: EngineActivity): void {
    for (const listener of this.states) listener(state, activity)
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
  private start(): void {
    mkdirSync(this.options.dataDirectory, { recursive: true, mode: 0o700 })
    const log = openSync(join(this.options.dataDirectory, 'engine-launch.log'), 'a', 0o600)
    const child = spawn(
      this.options.executable,
      [this.options.engineMain, '--data', this.options.dataDirectory, '--build', this.build],
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
    const deadline = Date.now() + 40_000
    let started = false
    let nextStart = 0
    let lastError: unknown
    while (!this.closed && Date.now() < deadline) {
      const descriptor = readDescriptor(this.options.dataDirectory)
      if (descriptor !== null) {
        try {
          return await this.attach(descriptor.socketPath, descriptor.token)
        } catch (error) {
          lastError = error
          if (error instanceof Error && error.message === 'engine-restart-busy') throw error
          if (error instanceof Error && error.message === 'engine-replace-idle') started = false
        }
      }
      if (!started || Date.now() >= nextStart) {
        this.start()
        started = true
        nextStart = Date.now() + 1000
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw lastError instanceof Error ? lastError : new Error('engine-start-timeout')
  }
  private attach(path: string, token: string): Promise<Welcome> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path)
      let welcomed = false
      let replacing = false
      this.mismatch = false
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error('engine-handshake-timeout'))
      }, 10_000)
      const reader = new FrameReader((raw) => {
        const parsed = ServerMessage.safeParse(raw)
        if (!parsed.success) {
          socket.destroy()
          reject(new Error('engine-protocol-error'))
          return
        }
        const message = parsed.data
        if (message.kind === 'restartRequired') {
          this.mismatch = true
          this.report('restart-required', message.activity)
          if (!message.activity.busy) {
            replacing = true
            socket.write(encodeFrame({ kind: 'shutdown', id: randomUUID() }))
          } else if (message.descriptor.protocol !== PROTOCOL_VERSION) {
            clearTimeout(timeout)
            socket.destroy()
            reject(new Error('engine-restart-busy'))
          }
          return
        }
        if (message.kind === 'welcome') {
          clearTimeout(timeout)
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
          void this.hostHandler(message.method, message.params).then(
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
        }
      })
      socket.once('connect', () => {
        socket.write(
          encodeFrame({
            kind: 'hello',
            token,
            protocol: PROTOCOL_VERSION,
            build: this.build,
            runtimeVersion: process.versions.node,
            clientId: this.options.clientId,
            workspaceKey: this.options.workspaceKey,
            workspaceFolders: this.options.workspaceFolders,
            trusted: this.options.trusted,
            secrets: this.options.secrets,
            lastSeq: this.lastSeq,
            cold: !this.everConnected,
          })
        )
      })
      socket.on('data', (chunk) => {
        try {
          reader.push(chunk)
        } catch (error) {
          socket.destroy()
          reject(error instanceof Error ? error : new Error('engine-protocol-error'))
        }
      })
      socket.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      socket.once('close', () => {
        clearTimeout(timeout)
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
          reject(new Error(replacing ? 'engine-replace-idle' : 'engine-gone'))
          return
        }
        if (!this.closed) {
          this.report('reconnecting')
          this.mismatch = false
          setTimeout(() => {
            if (!this.closed)
              void this.connect().catch(() => {
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
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs
    if (deadline === null) await this.connect()
    else await this.beforeDeadline(this.connect(), deadline)
    if (deadline !== null && Date.now() >= deadline) throw new Error('engine-request-timeout')
    return await new Promise((resolve, reject) => {
      const request = { ...message, id }
      const timer =
        deadline === null && message.kind === 'invoke' && PERSON_PACED_CHANNELS.has(message.channel)
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id)
              reject(new Error('engine-request-timeout'))
            }, deadline === null ? 180_000 : Math.max(1, deadline - Date.now()))
      this.pending.set(id, { message: request, resolve, reject, timer })
      this.socket?.write(encodeFrame(request))
    })
  }
  invoke(channel: string, request: unknown, id?: string, timeoutMs?: number): Promise<unknown> {
    return this.request({ kind: 'invoke', channel, request }, id, timeoutMs)
  }
  private beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('engine-request-timeout'))
      }, Math.max(0, deadline - Date.now()))
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }
  notify(
    message: Extract<
      ClientMessage,
      { kind: 'editorContext' | 'browserEvent' | 'completionCancel' | 'secret' }
    >
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
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))))
    }
    return false
  }
  async restartWhenIdle(waitForConnection = false): Promise<boolean> {
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
        if (state === 'connected' && this.welcome !== null && this.welcome.generation !== generation)
          resolve()
      })
      timer = setTimeout(() => reject(new Error('engine-restart-timeout')), 60_000)
    })
    void connected.catch(() => undefined)
    try {
      try {
        await this.request({ kind: 'shutdown' }, undefined, Math.max(1, deadline - Date.now()))
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'engine-shutdown-disconnected') throw error
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
    this.socket?.destroy()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('engine-client-closed'))
    }
    this.pending.clear()
  }
}
