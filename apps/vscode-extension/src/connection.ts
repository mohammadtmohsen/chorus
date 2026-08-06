import { connect, type Socket } from 'node:net'
import {
  chorusMessage,
  decodeFrame,
  encodeFrame,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type CurrentContextResult,
} from '@chorus/ide-protocol'
import type { Descriptor } from './discovery.js'
import type { RootReport } from './editor-context.js'

/**
 * One window's connection to one Chorus process.
 *
 * The extension dials out, so there is no server here, no port to allocate and
 * nothing listening inside VS Code for a web page to reach. What that costs is
 * this: the connection has to survive Chorus not being up yet, and reconnect
 * without spinning.
 */

/** Backoff between reconnect attempts, capped so a long absence stays cheap. */
const BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000, 10_000] as const

export interface ConnectionHandlers {
  /** Chorus published a new set of roots to filter against. */
  readonly onRoots: (roots: readonly string[]) => void
  /** Chorus asked for the selected text of one root. */
  readonly onSnapshot: (root: string) => CurrentContextResult
  readonly onStateChange: () => void
  readonly log: (message: string, fields?: Record<string, unknown>) => void
}

export interface ConnectionIdentity {
  readonly windowId: string
  readonly ideName: string
  readonly clientVersion: string
  readonly isTrusted: () => boolean
  readonly isFocused: () => boolean
}

export class ChorusConnection {
  #socket: Socket | null = null
  #buffer = ''
  #attempt = 0
  #timer: NodeJS.Timeout | null = null
  #disposed = false
  #handshaken = false

  constructor(
    private readonly descriptor: Descriptor,
    private readonly identity: ConnectionIdentity,
    private readonly handlers: ConnectionHandlers
  ) {}

  get connected(): boolean {
    return this.#handshaken
  }

  get pid(): number {
    return this.descriptor.pid
  }

  start(): void {
    if (this.#disposed) return
    /*
     * Refuse a version we cannot speak rather than connecting and failing at
     * the first frame. The user gets one clear "update the extension" instead
     * of a socket that reconnects forever.
     */
    if (this.descriptor.protocolVersion !== PROTOCOL_VERSION) {
      this.handlers.log('protocol mismatch', {
        expected: PROTOCOL_VERSION,
        received: this.descriptor.protocolVersion,
      })
      this.#disposed = true
      return
    }
    this.#open()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#socket?.destroy()
    this.#socket = null
    this.#handshaken = false
  }

  /** Push the current per-root state. Ignored until the handshake completes. */
  send(roots: readonly RootReport[]): void {
    if (!this.#handshaken || this.#socket === null) return
    this.#socket.write(
      encodeFrame({
        jsonrpc: '2.0',
        method: 'stateChanged',
        params: {
          windowId: this.identity.windowId,
          focused: this.identity.isFocused(),
          roots,
        },
      })
    )
  }

  #open(): void {
    const socket = connect(this.descriptor.socketPath)
    this.#socket = socket
    this.#buffer = ''
    socket.setEncoding('utf8')

    socket.on('connect', () => {
      this.#attempt = 0
      socket.write(
        encodeFrame({
          jsonrpc: '2.0',
          id: `init-${this.identity.windowId}`,
          method: 'initialize',
          params: {
            token: this.descriptor.token,
            protocolVersion: PROTOCOL_VERSION,
            clientVersion: this.identity.clientVersion,
            windowId: this.identity.windowId,
            ideName: this.identity.ideName,
            isTrusted: this.identity.isTrusted(),
            focused: this.identity.isFocused(),
            // No workspace folders: Chorus has to name the roots first, so a
            // path outside them never crosses this socket at all.
          },
        })
      )
      this.#handshaken = true
      this.handlers.onStateChange()
    })

    socket.on('data', (chunk: string) => {
      this.#buffer += chunk
      if (this.#buffer.length > MAX_FRAME_BYTES) {
        this.handlers.log('frame exceeded the cap')
        socket.destroy()
        return
      }
      for (;;) {
        const nl = this.#buffer.indexOf('\n')
        if (nl === -1) break
        const line = this.#buffer.slice(0, nl)
        this.#buffer = this.#buffer.slice(nl + 1)
        if (line.trim() !== '') this.#handle(socket, line)
      }
    })

    const drop = (): void => {
      if (this.#socket !== socket) return
      this.#socket = null
      const wasConnected = this.#handshaken
      this.#handshaken = false
      if (wasConnected) this.handlers.onStateChange()
      this.#scheduleReconnect()
    }
    socket.on('close', drop)
    socket.on('error', drop)
  }

  #handle(socket: Socket, line: string): void {
    /*
     * The handshake response has no `method` and would fail the message
     * schema. It carries no instruction either — the versions were already
     * agreed from the descriptor — so it is simply acknowledged.
     */
    const decoded = decodeFrame(line, chorusMessage)
    if (!decoded.ok) return

    const frame = decoded.value
    if (frame.method === 'setRoots') {
      this.handlers.onRoots(frame.params.roots)
      return
    }

    // `currentContext`: answer with the text, now that the user has asked for
    // it by pressing Send.
    const result = this.handlers.onSnapshot(frame.params.root)
    socket.write(encodeFrame({ jsonrpc: '2.0', id: frame.id, result }))
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#timer !== null) return
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 10_000
    this.#attempt += 1
    this.#timer = setTimeout(() => {
      this.#timer = null
      if (!this.#disposed) this.#open()
    }, delay)
    // A pending reconnect must never hold VS Code open on shutdown.
    this.#timer.unref()
  }
}
