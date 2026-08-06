import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { Logger } from '@chorus/shared'
import {
  currentContextResult,
  decodeFrame,
  encodeFrame,
  extensionMessage,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type CurrentContextResult,
  type EditorMetadata,
  type IdeStatus,
} from '@chorus/ide-protocol'
import { canonicalRoot, chooseWindow, type CanonicalRoot } from '@chorus/workspace'

/**
 * The Chorus end of the VS Code bridge (plan §4).
 *
 * Chorus listens and the extension dials in, which is the opposite of what both
 * Claude Code and Copilot Chat do. Inverting the direction removes port
 * allocation, lock-file discovery, stale-socket reaping and the entire
 * browser-reachable attack class in one move: a Unix domain socket cannot be
 * dialled by a web page. Several VS Code windows become several inbound
 * connections, each reporting its own focus, instead of several lock files to
 * disambiguate from the outside.
 *
 * Nothing here is Electron-aware, so the whole thing is testable with real
 * sockets and fake clients rather than mocks of a broker.
 */

/** `initialize` must arrive this fast, or the connection is dropped. */
const HANDSHAKE_TIMEOUT_MS = 2_000

/** How long Send waits for a snapshot before giving up and keeping the draft. */
export const SNAPSHOT_TIMEOUT_MS = 750

interface RootReport {
  readonly status: IdeStatus
  readonly editor: EditorMetadata | null
}

interface WindowState {
  readonly windowId: string
  readonly socket: Socket
  focused: boolean
  lastFocusedAt: number
  readonly roots: Map<string, RootReport>
}

/** The result of handling one frame; see `#handleLine`. */
type LineOutcome =
  { readonly kind: 'open'; readonly windowId: string | null } | { readonly kind: 'closed' }

const CLOSED: LineOutcome = { kind: 'closed' }

/** What the broker can say about one conversation's project. */
export interface IdeContext {
  readonly status: IdeStatus
  readonly editor: EditorMetadata | null
  readonly windowId: string | null
}

export interface IdeBridgeOptions {
  /** Parent of the descriptor directory. Injected so tests never touch /tmp. */
  readonly runtimeDir: string
  readonly pid: number
  readonly chorusVersion: string
  readonly log: Logger
  /** Injected only by tests; production always generates a fresh one. */
  readonly token?: string
  readonly now?: () => number
}

const UNAVAILABLE: IdeContext = { status: 'unavailable', editor: null, windowId: null }

export class IdeBridge {
  readonly #server: Server
  readonly #windows = new Map<string, WindowState>()
  /** Sockets that have not completed a handshake yet. */
  readonly #pending = new Set<Socket>()
  readonly #timers = new Set<NodeJS.Timeout>()
  readonly #pendingRequests = new Map<string, (result: CurrentContextResult) => void>()
  readonly #listeners = new Set<() => void>()
  #roots: CanonicalRoot[] = []
  #nextRequestId = 0
  #closed = false

  readonly #token: string
  readonly #chorusVersion: string
  readonly #log: Logger
  readonly #now: () => number

  private constructor(
    server: Server,
    readonly socketPath: string,
    readonly descriptorPath: string,
    token: string,
    chorusVersion: string,
    log: Logger,
    now: () => number
  ) {
    this.#server = server
    this.#token = token
    this.#chorusVersion = chorusVersion
    this.#log = log
    this.#now = now
  }

  /**
   * Bind the socket and publish the descriptor.
   *
   * The directory is per-uid and the descriptor is per-pid, so a second Chorus
   * does not collide with the first and neither deletes the other's files. Mode
   * 0600 is not protection from code already running as this user — that code
   * can read the project too — it prevents cross-user and accidental access.
   */
  static async start(options: IdeBridgeOptions): Promise<IdeBridge> {
    const dir = join(options.runtimeDir, 'chorus-ide')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // `mkdirSync` honours the process umask, so an existing directory or a
    // permissive umask could leave this group-readable. Set it explicitly.
    chmodSync(dir, 0o700)
    assertPrivateDirectory(dir)

    const socketPath = join(dir, `${String(options.pid)}.sock`)
    const descriptorPath = join(dir, `${String(options.pid)}.json`)
    // A previous run that died without cleanup leaves the node behind, and
    // `listen` fails on an existing path.
    rmSync(socketPath, { force: true })

    const token = options.token ?? randomBytes(32).toString('hex')
    const server = createServer()

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    chmodSync(socketPath, 0o600)

    const bridge = new IdeBridge(
      server,
      socketPath,
      descriptorPath,
      token,
      options.chorusVersion,
      options.log,
      options.now ?? Date.now
    )

    writeFileSync(
      descriptorPath,
      JSON.stringify({
        pid: options.pid,
        socketPath,
        token,
        protocolVersion: PROTOCOL_VERSION,
        chorusVersion: options.chorusVersion,
      }),
      { mode: 0o600 }
    )

    server.on('connection', (socket) => {
      bridge.#accept(socket)
    })

    options.log.info('ide bridge listening', { protocolVersion: PROTOCOL_VERSION })
    return bridge
  }

  /**
   * Publish the roots Chorus cares about.
   *
   * The extension filters against these before sending anything, so a path
   * outside them never crosses the socket. That is why the handshake carries no
   * workspace folders: the roots have to travel in this direction first.
   */
  setRoots(roots: readonly string[]): void {
    const next = roots.map(canonicalRoot)
    /*
     * Idempotent, because the caller resyncs on every runtime event batch and
     * most of those are streaming deltas that change nothing. Without this,
     * each token an agent emits would realpath every root and rebroadcast to
     * every window.
     */
    if (next.length === this.#roots.length && next.every((r, i) => r === this.#roots[i])) return

    this.#roots = next
    const frame = encodeFrame({
      jsonrpc: '2.0',
      method: 'setRoots',
      params: { roots: this.#roots.map(String) },
    })
    for (const window of this.#windows.values()) window.socket.write(frame)
  }

  /** The canonical form of a conversation's cwd, for callers holding a path. */
  rootFor(cwd: string): CanonicalRoot {
    return canonicalRoot(cwd)
  }

  /**
   * Resolve one project to the window that serves it.
   *
   * The order matters: "nothing is connected" and "something is connected but
   * this project is not open in it" are different problems with different
   * fixes, and collapsing them into one blank state was the failure mode the
   * plan set out to avoid.
   */
  contextFor(root: CanonicalRoot): IdeContext {
    if (this.#windows.size === 0) return UNAVAILABLE

    const eligible = [...this.#windows.values()].filter((w) => {
      const report = w.roots.get(root)
      return report !== undefined && report.status !== 'unmatched'
    })
    if (eligible.length === 0) return { status: 'unmatched', editor: null, windowId: null }

    const chosen = chooseWindow(eligible)
    if (chosen === null) return { status: 'ambiguous', editor: null, windowId: null }

    const report = chosen.roots.get(root)
    if (report === undefined) return { status: 'unmatched', editor: null, windowId: null }
    return { status: report.status, editor: report.editor, windowId: chosen.windowId }
  }

  /**
   * Ask the serving window for the selected text.
   *
   * Only `ready` and `tooLarge` name a file, so anything else is answered from
   * here without troubling the extension. A timeout resolves rather than
   * rejects: the caller's job is to keep the draft and explain, not to handle
   * an exception on a path the user takes constantly.
   */
  async requestSnapshot(
    root: CanonicalRoot,
    timeoutMs: number = SNAPSHOT_TIMEOUT_MS
  ): Promise<CurrentContextResult> {
    const context = this.contextFor(root)
    if (context.windowId === null || context.status !== 'ready') {
      return { outcome: 'unavailable', reason: context.status }
    }
    const window = this.#windows.get(context.windowId)
    if (window === undefined) return { outcome: 'unavailable', reason: 'unavailable' }

    this.#nextRequestId += 1
    const id = `s${String(this.#nextRequestId)}`

    return await new Promise<CurrentContextResult>((resolve) => {
      const finish = (result: CurrentContextResult): void => {
        if (!this.#pendingRequests.delete(id)) return
        clearTimeout(timer)
        this.#timers.delete(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        this.#log.warn('ide snapshot timed out', { timeoutMs })
        finish({ outcome: 'unavailable', reason: 'unavailable' })
      }, timeoutMs)
      this.#timers.add(timer)

      this.#pendingRequests.set(id, finish)
      window.socket.write(
        encodeFrame({
          jsonrpc: '2.0',
          id,
          method: 'currentContext',
          params: { root: String(root) },
        })
      )
    })
  }

  /**
   * Called whenever a window connects, disconnects, or reports new state.
   *
   * Coarse on purpose: it says "something moved", not what. The renderer needs
   * one push per conversation regardless, so a finer signal would only mean
   * recomputing the same answer more often.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }

  /** Connected windows, for diagnostics. Counts only — never paths. */
  connectionCount(): number {
    return this.#windows.size
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true

    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    /*
     * Anything still waiting is answered rather than left hanging, so a quit
     * during a pending Send does not deadlock the caller.
     *
     * The entry is deliberately not removed first: each waiter's callback
     * guards on its own `delete` returning true, so deleting here would make
     * every one of them bail out early and the promise would never settle —
     * which is precisely the hang this loop exists to prevent.
     */
    for (const resolve of [...this.#pendingRequests.values()]) {
      resolve({ outcome: 'unavailable', reason: 'unavailable' })
    }
    this.#pendingRequests.clear()
    for (const socket of this.#pending) socket.destroy()
    this.#pending.clear()
    for (const window of this.#windows.values()) window.socket.destroy()
    this.#windows.clear()
    this.#listeners.clear()

    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve()
      })
    })
    rmSync(this.socketPath, { force: true })
    rmSync(this.descriptorPath, { force: true })
    this.#log.info('ide bridge closed', {})
  }

  #accept(socket: Socket): void {
    if (this.#closed) {
      socket.destroy()
      return
    }
    this.#pending.add(socket)

    const handshakeTimer = setTimeout(() => {
      this.#log.warn('ide handshake timed out', {})
      socket.destroy()
    }, HANDSHAKE_TIMEOUT_MS)
    this.#timers.add(handshakeTimer)

    let windowId: string | null = null
    let buffer = ''

    const settle = (): void => {
      clearTimeout(handshakeTimer)
      this.#timers.delete(handshakeTimer)
    }

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      /*
       * A client that never sends a newline would otherwise grow this buffer
       * without bound. The frame cap is the same one the protocol declares, so
       * the limit is enforced before anything is parsed rather than after.
       */
      if (buffer.length > MAX_FRAME_BYTES) {
        this.#log.warn('ide frame exceeded the cap', {})
        socket.destroy()
        return
      }

      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() === '') continue

        const outcome = this.#handleLine(socket, line, windowId, settle)
        if (outcome.kind === 'closed') return
        windowId = outcome.windowId
      }
    })

    const drop = (): void => {
      settle()
      this.#pending.delete(socket)
      if (windowId !== null && this.#windows.get(windowId)?.socket === socket) {
        this.#windows.delete(windowId)
        this.#log.info('ide window disconnected', { connections: this.#windows.size })
        this.#notify()
      }
    }
    socket.on('close', drop)
    socket.on('error', drop)
  }

  /**
   * Handle one frame.
   *
   * The outcome is a discriminated object rather than a `'closed'` sentinel
   * string: a window id is also a string, so a sentinel would be
   * indistinguishable from a real id and a destroyed socket could be mistaken
   * for a live window.
   */
  #handleLine(
    socket: Socket,
    line: string,
    windowId: string | null,
    settle: () => void
  ): LineOutcome {
    /*
     * Responses share this channel and carry no `method`, so they would fail
     * the message schema and take the socket down with them. They are routed
     * first, and only for an id we are actually waiting on — an unsolicited
     * response is not a reason to trust a frame.
     */
    if (this.#routeResponse(line)) return { kind: 'open', windowId }

    const decoded = decodeFrame(line, extensionMessage)
    if (!decoded.ok) {
      // Reason codes only. The frame may contain a path or source text, and a
      // log is the one place neither is allowed to end up.
      this.#log.warn('ide frame rejected', { code: decoded.code, reason: decoded.reason })
      socket.destroy()
      return CLOSED
    }
    const frame = decoded.value

    if (frame.method === 'initialize') {
      if (windowId !== null) {
        this.#log.warn('ide sent a second handshake', {})
        socket.destroy()
        return CLOSED
      }
      const { params } = frame
      if (params.token !== this.#token) {
        this.#log.warn('ide handshake rejected', { reason: 'token' })
        socket.destroy()
        return CLOSED
      }
      if (params.protocolVersion !== PROTOCOL_VERSION) {
        this.#log.warn('ide handshake rejected', {
          reason: 'protocolVersion',
          expected: PROTOCOL_VERSION,
          received: params.protocolVersion,
        })
        socket.destroy()
        return CLOSED
      }

      settle()
      this.#pending.delete(socket)
      // A reconnect from the same window replaces the old connection rather
      // than adding a second: the extension host restarting must not leave a
      // phantom window competing in focus arbitration.
      this.#windows.get(params.windowId)?.socket.destroy()
      this.#windows.set(params.windowId, {
        windowId: params.windowId,
        socket,
        focused: params.focused,
        lastFocusedAt: params.focused ? this.#now() : 0,
        roots: new Map(),
      })

      socket.write(
        encodeFrame({
          jsonrpc: '2.0',
          id: frame.id,
          result: { protocolVersion: PROTOCOL_VERSION, chorusVersion: this.#chorusVersion },
        })
      )
      // The roots this window must filter against, so it can start reporting
      // without waiting for the next conversation change.
      socket.write(
        encodeFrame({
          jsonrpc: '2.0',
          method: 'setRoots',
          params: { roots: this.#roots.map(String) },
        })
      )
      this.#log.info('ide window connected', { connections: this.#windows.size })
      this.#notify()
      return { kind: 'open', windowId: params.windowId }
    }

    // Everything below requires a completed handshake.
    if (windowId === null) {
      this.#log.warn('ide frame before handshake', {})
      socket.destroy()
      return CLOSED
    }
    const window = this.#windows.get(windowId)
    if (window?.socket !== socket) {
      socket.destroy()
      return CLOSED
    }

    // `initialize` returned above, so this is the only remaining variant.
    if (frame.params.focused && !window.focused) window.lastFocusedAt = this.#now()
    window.focused = frame.params.focused
    window.roots.clear()
    for (const report of frame.params.roots) {
      /*
       * Re-checked here rather than trusted: the extension filters to minimize
       * disclosure, but Electron main is the security boundary. A report for a
       * root Chorus never asked about is dropped.
       */
      if (!this.#roots.some((r) => String(r) === report.root)) continue
      window.roots.set(report.root, { status: report.status, editor: report.editor })
    }
    this.#notify()
    return { kind: 'open', windowId }
  }

  /**
   * Deliver a response to whoever is waiting for it.
   *
   * Returns false for anything that is not a response to an outstanding
   * request, so the caller can fall through to normal message handling. A
   * malformed result still settles the waiter — with `unavailable` — because
   * the alternative is a Send that hangs until its timeout for a reason the
   * extension already knows.
   */
  #routeResponse(line: string): boolean {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return false
    }
    if (typeof parsed !== 'object' || parsed === null) return false
    const record = parsed as Record<string, unknown>
    const id = record['id']
    if (typeof id !== 'string') return false
    const waiting = this.#pendingRequests.get(id)
    if (waiting === undefined) return false

    const result = currentContextResult.safeParse(record['result'])
    if (!result.success) this.#log.warn('ide snapshot result rejected', {})
    waiting(result.success ? result.data : { outcome: 'unavailable', reason: 'unavailable' })
    return true
  }
}

/**
 * Refuse a descriptor directory anyone else can read.
 *
 * Checked rather than assumed, because the directory may already exist from a
 * previous run whose umask was different, and a world-readable token is the one
 * mistake the whole discovery scheme depends on not making.
 */
function assertPrivateDirectory(dir: string): void {
  const stats = statSync(dir)
  if (!stats.isDirectory()) throw new Error('ide runtime path is not a directory')
  if ((stats.mode & 0o077) !== 0) throw new Error('ide runtime directory is not private')
  if (stats.uid !== process.getuid?.()) throw new Error('ide runtime directory has another owner')
}
