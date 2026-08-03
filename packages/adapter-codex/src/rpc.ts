import type { Transport } from './transport.js'

/**
 * JSON-RPC 2.0 over the app-server's newline-delimited stdio.
 *
 * Two things this has to get right that a naive client would not:
 *
 *  - **Server-initiated requests.** Approvals arrive as requests *from* the
 *    server and must be answered by id (plan §2.1). A client that only models
 *    request/response in one direction silently hangs every approval.
 *  - **Backpressure.** The server rejects with `-32001` "Server overloaded"
 *    under load, and expects retry with exponential backoff plus jitter.
 *
 * The `jsonrpc: "2.0"` member is omitted on the wire, matching the server.
 */

export const OVERLOADED = -32001

export interface JsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/** Answered by the caller and sent back as a JSON-RPC result. */
export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>

export interface JsonRpcClientOptions {
  readonly transport: Transport
  readonly requestTimeoutMs?: number
  readonly maxOverloadRetries?: number
  readonly baseBackoffMs?: number
  /** Injected so backoff is deterministic under test. */
  readonly random?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class JsonRpcClient {
  private readonly transport: Transport
  private readonly pending = new Map<number, Pending>()
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>()
  private readonly requestTimeoutMs: number
  private readonly maxOverloadRetries: number
  private readonly baseBackoffMs: number
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private serverRequestHandler: ServerRequestHandler | null = null
  private nextId = 0
  private closed = false
  private closeReason: Error | null = null

  constructor(options: JsonRpcClientOptions) {
    this.transport = options.transport
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000
    this.maxOverloadRetries = options.maxOverloadRetries ?? 5
    this.baseBackoffMs = options.baseBackoffMs ?? 100
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))

    this.transport.onLine((line) => {
      this.receive(line)
    })
    this.transport.onClose((info) => {
      this.failAll(
        new Error(
          `codex app-server exited (code=${String(info.code)} signal=${String(info.signal)})`
        )
      )
    })
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  /** Only one handler — approvals must have exactly one authority. */
  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler
  }

  notify(method: string, params?: unknown): void {
    this.transport.send(JSON.stringify({ method, params: params ?? {} }))
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendOnce(method, params)
      } catch (error) {
        const retryable = error instanceof RpcError && error.code === OVERLOADED
        if (!retryable || attempt >= this.maxOverloadRetries) throw error
        // Exponential with full jitter, as the server's own guidance asks for.
        // Without jitter, every queued request retries in lockstep and the
        // overload repeats.
        const ceiling = this.baseBackoffMs * 2 ** attempt
        await this.sleep(Math.floor(this.random() * ceiling))
      }
    }
  }

  close(reason = 'client closed'): void {
    this.failAll(new Error(reason))
    this.transport.close()
  }

  private sendOnce(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closeReason ?? new Error('client closed'))

    const id = ++this.nextId
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${String(this.requestTimeoutMs)}ms`))
      }, this.requestTimeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      this.transport.send(JSON.stringify({ method, id, params: params ?? {} }))
    })
  }

  private receive(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // The app-server interleaves nothing else on stdout, but a partial line
      // during shutdown is not worth crashing over.
      return
    }
    if (typeof message !== 'object' || message === null) return
    const msg = message as {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: JsonRpcError
    }

    // Response to something we sent.
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id)
      if (entry === undefined) return
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error !== undefined) {
        entry.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data))
      } else {
        entry.resolve(msg.result)
      }
      return
    }

    // Request from the server — an approval, or a tool asking for input.
    if (msg.id !== undefined && msg.method !== undefined) {
      void this.answerServerRequest(msg.id, msg.method, msg.params)
      return
    }

    if (msg.method !== undefined) {
      for (const handler of this.notificationHandlers) handler(msg.method, msg.params)
    }
  }

  private async answerServerRequest(id: number, method: string, params: unknown): Promise<void> {
    if (this.serverRequestHandler === null) {
      this.transport.send(
        JSON.stringify({ id, error: { code: -32601, message: `No handler for ${method}` } })
      )
      return
    }
    try {
      const result = await this.serverRequestHandler(method, params)
      this.transport.send(JSON.stringify({ id, result }))
    } catch (error) {
      this.transport.send(
        JSON.stringify({
          id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        })
      )
    }
  }

  private failAll(reason: Error): void {
    this.closed = true
    this.closeReason = reason
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(reason)
    }
    this.pending.clear()
  }
}
