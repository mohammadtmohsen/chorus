import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { z } from 'zod'

const CANDIDATES: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    join(
      process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Chromium', 'Application', 'chrome.exe'),
    join(
      process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
}

export function findChrome(): string | null {
  return (CANDIDATES[process.platform] ?? []).find((path) => existsSync(path)) ?? null
}

const COMMAND_TIMEOUT_MS = 15_000
const CLOSE_TIMEOUT_MS = 5_000
const KILL_TIMEOUT_MS = 2_000
const STDERR_LINES = 40
const STDERR_LINE_MAX = 4096
const MESSAGE_MAX_BYTES = 64 * 1024 * 1024

const CdpMessage = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  sessionId: z.string().optional(),
})

export type CdpListener = (method: string, params: unknown, sessionId: string | undefined) => void

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class ChromeProcess {
  private child: ChildProcess | null = null
  private input: Writable | null = null
  private readonly parts: string[] = []
  private pendingBytes = 0
  private nextId = 0
  private starting: Promise<void> | null = null
  private closing: Promise<void> | null = null
  private exited: Promise<void> = Promise.resolve()
  private stopping = false
  private generation = 0
  private readonly stderr: string[] = []
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<CdpListener>()
  private readonly exits = new Set<(reason: string) => void>()

  constructor(
    private readonly profile: string,
    private readonly log: (message: string, fields: Record<string, unknown>) => void
  ) {}

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('browser-stopping'))
    if (this.starting !== null) return this.starting
    const starting = this.exited.then(async () => {
      if (this.stopping) throw new Error('browser-stopping')
      await this.launch()
    })
    this.starting = starting
    void starting.catch(() => {
      if (this.starting === starting) this.starting = null
    })
    return starting
  }

  private isStopping(): boolean {
    return this.stopping
  }

  private async launch(): Promise<void> {
    const executable = findChrome()
    if (executable === null) throw new Error('browser-missing')
    mkdirSync(this.profile, { recursive: true, mode: 0o700 })
    const child = spawn(
      executable,
      [
        '--headless=new',
        `--user-data-dir=${this.profile}`,
        '--remote-debugging-pipe',
        '--use-mock-keychain',
        '--password-store=basic',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
    )
    const generation = ++this.generation
    this.child = child
    this.parts.length = 0
    this.pendingBytes = 0
    this.stderr.length = 0
    const current = (): boolean => generation === this.generation && this.child === child
    const failed = (reason: string): void => {
      if (current()) this.fail(reason)
    }
    this.exited = new Promise((resolve) => {
      child.once('exit', () => {
        resolve()
      })
      child.once('error', () => {
        if (child.pid === undefined) resolve()
      })
    })
    child.once('exit', (code, signal) => {
      failed(`exit ${String(code)} ${String(signal)}`)
    })
    child.once('error', (error) => {
      failed(error.message)
    })
    const input = child.stdio[3]
    const output = child.stdio[4]
    if (!(input instanceof Writable) || !(output instanceof Readable)) {
      failed('browser-pipe')
      throw new Error('browser-pipe')
    }
    this.input = input
    input.on('error', (error) => {
      failed(error.message)
    })
    output.on('error', (error) => {
      failed(error.message)
    })
    output.on('end', () => {
      failed('browser-pipe-ended')
    })
    child.stderr?.on('error', (error) => {
      failed(error.message)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (!current()) return
      this.stderr.push(
        ...chunk
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => line.slice(0, STDERR_LINE_MAX))
      )
      this.stderr.splice(0, Math.max(0, this.stderr.length - STDERR_LINES))
    })
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => {
      if (current()) this.read(chunk)
    })
    try {
      await this.send('Browser.getVersion', {})
      if (!current() || this.isStopping()) throw new Error('browser-stopped')
      await this.send('Target.setDiscoverTargets', { discover: true })
      if (!current() || this.isStopping()) throw new Error('browser-stopped')
    } catch (error) {
      failed('startup-failed')
      throw error
    }
  }

  send(
    method: string,
    params: Readonly<Record<string, unknown>>,
    sessionId?: string,
    timeoutMs = COMMAND_TIMEOUT_MS
  ): Promise<unknown> {
    const input = this.input
    const child = this.child
    const generation = this.generation
    if (input === null || child === null) return Promise.reject(new Error('browser-stopped'))
    const failed = (reason: string): void => {
      if (generation === this.generation && this.child === child) this.fail(reason)
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('browser-timeout'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        const message = { id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }
        input.write(`${JSON.stringify(message)}\0`, (error) => {
          if (error !== null && error !== undefined) failed(error.message)
        })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error('browser-pipe'))
        failed('browser-pipe')
      }
    })
  }

  onEvent(listener: CdpListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onExit(listener: (reason: string) => void): () => void {
    this.exits.add(listener)
    return () => {
      this.exits.delete(listener)
    }
  }

  close(): Promise<void> {
    this.stopping = true
    this.closing ??= this.stop()
    return this.closing
  }

  private async stop(): Promise<void> {
    const child = this.child
    const exited = this.exited
    if (child !== null) void this.send('Browser.close', {}).catch(() => undefined)
    if (!(await within(exited, CLOSE_TIMEOUT_MS))) {
      if (child !== null && child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
      await within(exited, KILL_TIMEOUT_MS)
    }
    if (this.child === child && child !== null) this.fail('shutdown')
  }

  private read(chunk: string): void {
    let start = 0
    while (start < chunk.length) {
      const end = chunk.indexOf('\0', start)
      const part = end < 0 ? chunk.slice(start) : chunk.slice(start, end)
      this.pendingBytes += Buffer.byteLength(part)
      if (this.pendingBytes > MESSAGE_MAX_BYTES) {
        this.fail('message-too-large')
        return
      }
      if (part !== '') this.parts.push(part)
      if (end < 0) return
      const raw = this.parts.join('')
      this.parts.length = 0
      this.pendingBytes = 0
      const parsed = CdpMessage.safeParse(safeJson(raw))
      if (!parsed.success) {
        this.fail('malformed-message')
        return
      }
      this.dispatch(parsed.data)
      if (this.child === null) return
      start = end + 1
    }
  }

  private dispatch(message: z.infer<typeof CdpMessage>): void {
    if (message.id !== undefined) {
      const waiting = this.pending.get(message.id)
      if (waiting === undefined) return
      this.pending.delete(message.id)
      clearTimeout(waiting.timer)
      if (message.error !== undefined) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result)
      return
    }
    if (message.method === undefined) return
    for (const listener of this.listeners) {
      try {
        listener(message.method, message.params, message.sessionId)
      } catch (error) {
        this.log('browser listener failed', { method: message.method, error: String(error) })
      }
    }
  }

  private fail(reason: string): void {
    const child = this.child
    if (child === null) return
    this.child = null
    this.input = null
    this.starting = null
    this.parts.length = 0
    this.pendingBytes = 0
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('browser-stopped'))
    }
    this.pending.clear()
    if (!this.stopping) this.log('browser stopped', { reason, stderr: this.stderr.join('\n') })
    for (const listener of this.exits) {
      try {
        listener(reason)
      } catch (error) {
        this.log('browser exit listener failed', { error: String(error) })
      }
    }
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function within(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false)
    }, ms)
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
