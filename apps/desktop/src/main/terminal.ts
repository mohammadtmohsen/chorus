import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { basename } from 'node:path'
import type * as NodePty from 'node-pty'
import { resolveShell } from './shell.js'

/**
 * The shells behind the terminal panels. One per conversation, plus one global.
 *
 * Two rules shape everything here.
 *
 * **The PTY outlives the view.** The renderer is sandboxed and cannot load a
 * native module, and only the active tab of each pane is mounted — so switching
 * tabs genuinely unmounts a `Session`. A `pnpm build` running in a terminal must
 * not die because someone clicked another tab, so the shell lives here and the
 * renderer is a view onto it. React effect cleanup calls `detach`, never
 * `dispose`. That sentence is the whole guard.
 *
 * **Terminal output is never a log event.** It is not conversation, the global
 * terminal has no `conversationId` to file it under, and a shell is the sharpest
 * possible instance of C-021's unsolved half — `cat .env`, `env`, a pasted
 * token. Scrollback lives in memory, bounded, and goes when the app does.
 *
 * See docs/plans/a-terminal-in-every-session-2026-08-12/plan.md.
 */

/**
 * Which terminal, as a union rather than a nullable id.
 *
 * The global terminal has no conversation. Flattening that to a nullable
 * `conversationId`, or to a `'global'` sentinel sharing a namespace with real
 * ids, is how it ends up deleted by a loop that walks conversations — which is
 * exactly why asides are held in their own map rather than tagged inside
 * `active` (`runtime.ts`, "so nothing that walks sessions finds it").
 */
export type TerminalRef =
  { readonly scope: 'global' } | { readonly scope: 'session'; readonly conversationId: string }

/** What a caller gets back for mounting a view. */
export interface TerminalAttachment {
  /** Supersedes any previous attachment. Everything after this carries it. */
  readonly epoch: number
  /** The screen, as escape sequences — not a suffix of raw output. */
  readonly snapshot: string
  /** The last sequence number the snapshot includes. */
  readonly seq: number
  readonly cols: number
  readonly rows: number
}

/** What the panel needs to decide whether killing this would lose work. */
export interface TerminalDescription {
  readonly running: boolean
  /** The foreground process name, e.g. `zsh` when idle, `ssh` when not. */
  readonly foreground: string
  /** Whether something other than the shell itself is in the foreground. */
  readonly busy: boolean
}

export type TerminalPush =
  | {
      readonly kind: 'data'
      readonly ref: TerminalRef
      readonly epoch: number
      readonly seq: number
      readonly data: string
    }
  | {
      readonly kind: 'exit'
      readonly ref: TerminalRef
      readonly epoch: number
      readonly code: number
    }

/**
 * The PTY, as an interface, so the service is testable without spawning a shell.
 *
 * Same move as `event-store`'s `port.ts`: one file knows which driver we use.
 * Every test below drives a fake; the real one is `nodePty` at the bottom.
 */
export interface Pty {
  readonly pid: number
  /** The foreground process name. node-pty derives this from the tty. */
  readonly process: string
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  pause(): void
  resume(): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
}

export interface PtyOptions {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly cols: number
  readonly rows: number
}

export type PtySpawner = (options: PtyOptions) => Pty

export interface TerminalServiceOptions {
  /** Where a terminal for this ref should open. */
  readonly cwdFor: (ref: TerminalRef) => string
  readonly spawn?: PtySpawner
  readonly env?: NodeJS.ProcessEnv
  readonly scrollback?: number
}

/** Lines of history the headless mirror keeps. The bound on memory per shell. */
const SCROLLBACK = 5_000

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/**
 * How far the headless mirror may fall behind before the PTY is paused.
 *
 * Counted in `write` calls outstanding, not bytes: what matters is that the
 * emulator is keeping up, and its callback is the only honest signal that it is.
 * Without this a `yes` loop outruns the mirror and corrupts the snapshot the
 * panel exists to restore — and it does so *worst* when the panel is hidden and
 * no renderer is attached to apply any backpressure of its own.
 */
const PENDING_HIGH = 64
const PENDING_LOW = 16

interface Session {
  readonly ref: TerminalRef
  readonly pty: Pty
  readonly mirror: Terminal
  readonly serializer: SerializeAddon
  readonly shellName: string
  epoch: number
  attached: boolean
  seq: number
  pending: number
  paused: boolean
  exited: boolean
  cols: number
  rows: number
}

export function terminalKey(ref: TerminalRef): string {
  return ref.scope === 'global' ? 'global' : `session:${ref.conversationId}`
}

export class TerminalService {
  /*
   * Two fields, not one map keyed by a string.
   *
   * Flattening the union to a key throws away the guarantee it exists to give:
   * once it is a string, anything iterating has to parse ids to know what it is
   * holding. Separate storage makes "walk every session's terminal" incapable of
   * reaching the global one.
   */
  private global: Session | null = null
  private readonly bySession = new Map<string, Session>()
  private readonly listeners = new Set<(push: TerminalPush) => void>()

  private readonly cwdFor: (ref: TerminalRef) => string
  private readonly spawner: PtySpawner
  private readonly env: NodeJS.ProcessEnv
  private readonly scrollback: number

  constructor(options: TerminalServiceOptions) {
    this.cwdFor = options.cwdFor
    this.spawner = options.spawn ?? nodePty
    this.env = options.env ?? process.env
    this.scrollback = options.scrollback ?? SCROLLBACK
  }

  subscribe(listener: (push: TerminalPush) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Mount a view, spawning the shell if this is the first time.
   *
   * Lazy on purpose: a user who never opens the global panel never pays for a
   * shell. Attaching mints a new epoch, which supersedes any previous
   * attachment — so a `detach` from a view that is unmounting cannot tear down
   * the subscription of the view that replaced it.
   */
  attach(ref: TerminalRef, size?: { cols: number; rows: number }): TerminalAttachment {
    const session = this.find(ref) ?? this.open(ref, size)
    session.epoch += 1
    session.attached = true
    if (size !== undefined) this.applySize(session, size.cols, size.rows)
    return {
      epoch: session.epoch,
      snapshot: session.serializer.serialize(),
      seq: session.seq,
      cols: session.cols,
      rows: session.rows,
    }
  }

  /** Unmount a view. The shell keeps running; this is not a kill. */
  detach(ref: TerminalRef, epoch: number): void {
    const session = this.live(ref, epoch)
    if (session === null) return
    session.attached = false
  }

  write(ref: TerminalRef, epoch: number, data: string): void {
    const session = this.live(ref, epoch)
    if (session === null || session.exited) return
    session.pty.write(data)
  }

  resize(ref: TerminalRef, epoch: number, cols: number, rows: number): void {
    const session = this.live(ref, epoch)
    if (session === null || session.exited) return
    this.applySize(session, cols, rows)
  }

  /** What a confirmation dialog would need to say. */
  describe(ref: TerminalRef): TerminalDescription | null {
    const session = this.find(ref)
    if (session === null) return null
    const foreground = session.pty.process
    return {
      running: !session.exited,
      foreground,
      busy: !session.exited && foreground !== session.shellName,
    }
  }

  /**
   * Kill the shell.
   *
   * Separate from `detach` because they are genuinely different questions, and
   * conflating them is how React cleanup ends up killing a build. The only
   * callers are: a conversation ending, the user explicitly killing the global
   * one, and the app quitting.
   */
  dispose(ref: TerminalRef): void {
    const session = this.find(ref)
    if (session === null) return
    this.forget(ref)
    session.mirror.dispose()
    if (!session.exited) session.pty.kill()
  }

  /**
   * Every terminal belonging to a conversation that is ending.
   *
   * Named rather than expressed as `dispose({scope:'session', …})` at the call
   * site so that `runtime.closeConversation` reads as what it means and cannot
   * accidentally be handed the global ref.
   */
  disposeSession(conversationId: string): void {
    this.dispose({ scope: 'session', conversationId })
  }

  /** Quit. Everything, including the global one. */
  close(): void {
    for (const key of [...this.bySession.keys()]) {
      this.disposeSession(key)
    }
    if (this.global !== null) this.dispose({ scope: 'global' })
  }

  private find(ref: TerminalRef): Session | null {
    if (ref.scope === 'global') return this.global
    return this.bySession.get(ref.conversationId) ?? null
  }

  private forget(ref: TerminalRef): void {
    if (ref.scope === 'global') this.global = null
    else this.bySession.delete(ref.conversationId)
  }

  /** The one place a stale epoch is turned into "ignore this". */
  private live(ref: TerminalRef, epoch: number): Session | null {
    const session = this.find(ref)
    if (session === null) return null
    if (session.epoch !== epoch) return null
    return session
  }

  private applySize(session: Session, cols: number, rows: number): void {
    const safeCols = Math.max(1, Math.floor(cols))
    const safeRows = Math.max(1, Math.floor(rows))
    if (safeCols === session.cols && safeRows === session.rows) return
    session.cols = safeCols
    session.rows = safeRows
    session.mirror.resize(safeCols, safeRows)
    session.pty.resize(safeCols, safeRows)
  }

  private open(ref: TerminalRef, size?: { cols: number; rows: number }): Session {
    const shell = resolveShell(this.env)
    const cols = size?.cols ?? DEFAULT_COLS
    const rows = size?.rows ?? DEFAULT_ROWS

    const pty = this.spawner({
      file: shell.file,
      args: shell.args,
      cwd: this.cwdFor(ref),
      env: this.env,
      cols,
      rows,
    })

    const mirror = new Terminal({
      cols,
      rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
    })
    const serializer = new SerializeAddon()
    mirror.loadAddon(serializer)

    const session: Session = {
      ref,
      pty,
      mirror,
      serializer,
      shellName: basename(shell.file),
      epoch: 0,
      attached: false,
      seq: 0,
      pending: 0,
      paused: false,
      exited: false,
      cols,
      rows,
    }

    pty.onData((data) => {
      this.absorb(session, data)
    })
    pty.onExit(({ exitCode }) => {
      session.exited = true
      this.emit({ kind: 'exit', ref, epoch: session.epoch, code: exitCode })
    })

    if (ref.scope === 'global') this.global = session
    else this.bySession.set(ref.conversationId, session)
    return session
  }

  /**
   * One chunk of output: into the mirror, out to whoever is attached.
   *
   * The mirror is written to unconditionally — that is what makes a snapshot
   * possible for a panel nobody is looking at — and its callback is what paces
   * the PTY.
   */
  private absorb(session: Session, data: string): void {
    session.seq += 1
    session.pending += 1
    if (!session.paused && session.pending >= PENDING_HIGH) {
      session.paused = true
      session.pty.pause()
    }
    session.mirror.write(data, () => {
      session.pending -= 1
      if (session.paused && session.pending <= PENDING_LOW) {
        session.paused = false
        session.pty.resume()
      }
    })
    if (session.attached) {
      this.emit({ kind: 'data', ref: session.ref, epoch: session.epoch, seq: session.seq, data })
    }
  }

  private emit(push: TerminalPush): void {
    for (const listener of this.listeners) listener(push)
  }
}

/**
 * The real spawner.
 *
 * `require` rather than a static import because node-pty is external to the
 * bundle and native: keeping the load here means every test above runs without
 * it, and a machine where the binding is broken fails when a terminal is opened
 * rather than when the app starts.
 */
export const nodePty: PtySpawner = (options) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof NodePty
  const child = pty.spawn(options.file, [...options.args], {
    name: 'xterm-256color',
    cwd: options.cwd,
    env: options.env,
    cols: options.cols,
    rows: options.rows,
  })
  return {
    get pid() {
      return child.pid
    },
    get process() {
      return child.process
    },
    write: (data) => {
      child.write(data)
    },
    resize: (cols, rows) => {
      child.resize(cols, rows)
    },
    kill: () => {
      child.kill()
    },
    pause: () => {
      child.pause()
    },
    resume: () => {
      child.resume()
    },
    onData: (listener) => {
      child.onData(listener)
    },
    onExit: (listener) => {
      child.onExit(({ exitCode }) => {
        listener({ exitCode })
      })
    },
  }
}
