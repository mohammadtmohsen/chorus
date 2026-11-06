import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal, type IBufferLine } from '@xterm/headless'
import { basename } from 'node:path'
import { ownProcessTree, type OwnedProcessTree } from '@chorus/shared/process-tree'
import type * as NodePty from 'node-pty'
import { resolveShell, type ShellChoice } from './shell.js'

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
 *
 * **`id` is added to the tuple, not a replacement for the rest of it.** A
 * session terminal is `(scope, conversationId, id)` and a global one is
 * `(scope, id)`; nothing may compare on `id` alone. Ids are minted by the
 * renderer, typed here as a bare string, and travel through a persisted file a
 * person can edit — so two conversations holding the same id is a thing that
 * happens, not a thing to assume away.
 */
export type TerminalRef =
  | { readonly scope: 'global'; readonly id: string }
  | { readonly scope: 'session'; readonly conversationId: string; readonly id: string }
  | { readonly scope: 'project'; readonly projectId: string; readonly id: 'run' }
  | { readonly scope: 'shell'; readonly projectId: string; readonly id: string }

export type ProjectTerminalRef = Extract<TerminalRef, { readonly scope: 'project' }>

export interface LaunchSpec {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly file: string
  readonly args: readonly string[]
  readonly generation: number
}

export type LaunchResult =
  | { readonly kind: 'launched'; readonly pid: number }
  | { readonly kind: 'refused'; readonly reason: 'live-run' }

/** What a caller gets back for mounting a view. */
export interface TerminalAttachment {
  /** Supersedes any previous attachment. Everything after this carries it. */
  readonly epoch: number
  readonly generation: number
  /** The screen, as escape sequences — not a suffix of raw output. */
  readonly snapshot: string
  /** The last sequence number the snapshot includes. */
  readonly seq: number
  readonly cols: number
  readonly rows: number
  /**
   * How the shell ended, or null while it is running.
   *
   * Here because `exit` is a **one-shot push** and only the active tab of a
   * panel is mounted: a shell that dies while its tab is in the background emits
   * to a view that does not exist, and without this there is no way to find out
   * afterwards. Reopening the tab would show a dead shell looking alive.
   */
  readonly exitCode: number | null
}

/** What the panel needs to decide whether killing this would lose work. */
export interface TerminalDescription {
  readonly running: boolean
  /** The foreground process name, e.g. `zsh` when idle, `ssh` when not. */
  readonly foreground: string
  /**
   * Whether something other than the shell itself is in the foreground.
   *
   * **Always false on Windows, and that is an admission rather than an answer.**
   * See `describeForeground`.
   */
  readonly busy: boolean
  /** How it ended, or null while it is running. See `TerminalAttachment`. */
  readonly exitCode: number | null
}

/**
 * What is in the foreground, and whether that counts as busy.
 *
 * Pure and exported so the Windows case can be asserted from macOS, because it
 * is the case that cannot be checked by running the app here.
 *
 * ## Why Windows gets `false` rather than a normalised comparison
 *
 * The plan called for normalising node-pty's process names before comparing
 * them. Reading what node-pty actually ships says the comparison has no
 * operands worth normalising. `UnixTerminal`'s `process` getter calls into the
 * native binding for the tty's live foreground process, which is what makes
 * "is something running in there" answerable at all. `WindowsTerminal`'s getter
 * is `get process() { return this._name }`, and `_name` is assigned once at
 * construction from the terminal-type option — `xterm-256color`, not a process.
 * It never changes for the life of the pty.
 *
 * So the old expression did not merely risk a wrong answer on Windows, it
 * guaranteed one: `foreground` was the terminfo string, `shellName` was
 * `cmd.exe`, they never matched, and every terminal reported permanently busy —
 * with the kill dialog naming `xterm-256color` as the process it was about to
 * end.
 *
 * Reporting `busy: false` makes the kill confirmation stop crying wolf. It is a
 * real loss: on Windows the dialog can no longer warn that a build is running.
 * Recovering that needs a foreground-process lookup Chorus does not have —
 * walking the console's process list via `conpty_console_list`, which node-pty
 * exposes but does not wire to this property — and that is a piece of work with
 * its own Windows verification, not a line in this function.
 */
export function describeForeground(
  ptyProcess: string,
  shellName: string,
  platform: NodeJS.Platform = process.platform
): { readonly foreground: string; readonly busy: boolean } {
  if (platform === 'win32') {
    // `ptyProcess` is the terminal type here, never a process — so it is not
    // shown either. The shell's own name is the only true thing available.
    return { foreground: shellName, busy: false }
  }
  /*
   * A dead shell has no foreground process, so it describes as the shell it was
   * rather than as an empty string. `running: false` is what carries the truth;
   * this field only ever gets read to name a process in the kill confirmation,
   * which a dead terminal never reaches.
   */
  const foreground = ptyProcess || shellName
  return { foreground, busy: foreground !== shellName }
}

export type TerminalPush =
  | {
      readonly kind: 'data'
      readonly ref: TerminalRef
      readonly epoch: number
      readonly generation: number
      readonly seq: number
      readonly data: string
    }
  | {
      readonly kind: 'exit'
      readonly ref: TerminalRef
      readonly epoch: number
      readonly generation: number
      readonly code: number
    }
  | {
      readonly kind: 'replaced'
      readonly ref: TerminalRef
      readonly generation: number
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

export type TerminalEvent =
  | { readonly kind: 'data'; readonly data: string }
  | { readonly kind: 'exit'; readonly code: number }

export type TerminalTap = (ref: TerminalRef, event: TerminalEvent, generation: number) => void

export interface TerminalServiceOptions {
  /** Where a terminal for this ref should open. */
  readonly cwdFor: (ref: TerminalRef) => string | null
  readonly envFor?: (ref: TerminalRef) => NodeJS.ProcessEnv
  readonly spawn?: PtySpawner
  readonly ownProcess?: (pid: number, exited: Promise<void>) => OwnedProcessTree
  readonly env?: NodeJS.ProcessEnv
  readonly scrollback?: number
  readonly frame?: Frame
  /**
   * Injected, because the service reads the platform in two places and both
   * decide user-visible behaviour: which shell opens, and whether a terminal
   * reports busy. Left implicit, the tests asserted whichever host they ran on
   * — which is how the Windows CI run found them.
   */
  readonly platform?: NodeJS.Platform
  /**
   * The shell to open, when the caller already knows.
   *
   * Naming a platform is not enough for a test: `resolveShell` validates its
   * candidates against the real filesystem, so asking for darwin on a Windows
   * runner walks `/bin/zsh`, `/bin/bash`, `/bin/sh` — none of which exist —
   * and lands on the last fallback. The suite then asserted a shell named `sh`
   * where it meant `zsh`. Injecting the choice is the same move `spawn` already
   * gets, one layer up.
   */
  readonly shell?: ShellChoice
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

/**
 * Run something on the next frame, returning a cancel.
 *
 * Injected so coalescing is testable without waiting on real timers — and so a
 * test can flush deterministically rather than sleeping and hoping.
 */
export type Frame = (run: () => void) => () => void

const timerFrame: Frame = (run) => {
  const handle = setTimeout(run, 8)
  return () => {
    clearTimeout(handle)
  }
}

interface Session {
  readonly ref: TerminalRef
  readonly pty: Pty
  readonly owned: OwnedProcessTree
  stopping?: Promise<void>
  readonly mirror: Terminal
  readonly serializer: SerializeAddon
  readonly shellName: string
  readonly generation: number
  epoch: number
  attached: boolean
  seq: number
  /** The highest seq the attached view says it has consumed. */
  ackedSeq: number
  pending: number
  /** Output waiting for the next frame, so one push carries many chunks. */
  readonly outbox: string[]
  /** Cancels the pending flush, or null when none is scheduled. */
  flush: (() => void) | null
  /** Waiters for the mirror to have no writes outstanding. See `settled`. */
  readonly drained: (() => void)[]
  paused: boolean
  exited: boolean
  /** How it ended, or null while running. Kept because `exit` fires once. */
  exitCode: number | null
  cols: number
  rows: number
}

function usedColumns(line: IBufferLine, next: IBufferLine): number {
  const end = line.length - 1
  const tail = line.getCell(end)
  const padded = tail?.getCode() === 0 && tail.getWidth() === 1 && next.getCell(0)?.getWidth() === 2
  return padded ? end : line.length
}

export class TerminalService {
  /*
   * Two fields, not one map keyed by a string.
   *
   * Flattening the union to a key throws away the guarantee it exists to give:
   * once it is a string, anything iterating has to parse ids to know what it is
   * holding. Separate storage makes "walk every session's terminal" incapable of
   * reaching the global one.
   *
   * A `terminalKey(ref)` helper used to sit here, exported and called by
   * nothing — the flattening this comment argues against, written down and
   * waiting. It was deleted rather than reached for when the maps gained a
   * level: `disposeSession` now walks one conversation's **inner map**, which
   * structurally cannot contain a global shell, where a flat map would have made
   * it a scan that parses ids on the path where a mistake kills the wrong
   * terminal.
   */
  private readonly globals = new Map<string, Session>()
  private readonly bySession = new Map<string, Map<string, Session>>()
  private readonly byProject = new Map<string, Session>()
  private readonly byShell = new Map<string, Map<string, Session>>()
  private readonly shellsRemoved = new Set<string>()
  private readonly stoppingSessions = new Set<string>()
  private readonly stoppingProjects = new Set<string>()
  private readonly unconfirmed = new Set<Session>()
  private readonly ownProcess: (pid: number, exited: Promise<void>) => OwnedProcessTree
  private shellsClosed = false
  private epochs = 0
  private readonly listeners = new Set<(push: TerminalPush) => void>()
  private readonly taps = new Set<TerminalTap>()

  private readonly cwdFor: (ref: TerminalRef) => string | null
  private readonly envFor: ((ref: TerminalRef) => NodeJS.ProcessEnv) | undefined
  private readonly spawner: PtySpawner
  private readonly env: NodeJS.ProcessEnv
  private readonly scrollback: number
  private readonly frame: Frame
  private readonly platform: NodeJS.Platform
  private readonly shell: ShellChoice | undefined

  constructor(options: TerminalServiceOptions) {
    this.ownProcess =
      options.ownProcess ??
      ((pid, rootExited) => ownProcessTree(pid, { processGroup: true, rootExited }))
    this.cwdFor = options.cwdFor
    this.envFor = options.envFor
    this.platform = options.platform ?? process.platform
    this.shell = options.shell
    this.spawner = options.spawn ?? nodePty
    this.env = options.env ?? process.env
    this.scrollback = options.scrollback ?? SCROLLBACK
    this.frame = options.frame ?? timerFrame
  }

  subscribe(listener: (push: TerminalPush) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  tap(listener: TerminalTap): () => void {
    this.taps.add(listener)
    return () => {
      this.taps.delete(listener)
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
  async attach(
    ref: TerminalRef,
    size?: { cols: number; rows: number }
  ): Promise<TerminalAttachment | null> {
    const found = this.find(ref)
    if (found === null && ref.scope === 'project') return null
    if (found === null && ref.scope === 'shell' && !this.shellOpens(ref.projectId)) return null
    const session = found ?? this.open(ref, size)
    if (session === null) return null
    if (size !== undefined && !session.exited) this.applySize(session, size.cols, size.rows)

    /*
     * Wait for the mirror before serializing, or the snapshot is behind `seq`.
     *
     * `mirror.write` is asynchronous, so serializing with writes outstanding
     * returns a screen missing the most recent output while `seq` claims to
     * include it — and the view would then discard the pushes that would have
     * filled the gap, as being at or below a sequence number it had.
     *
     * Everything after the await runs in the same microtask, so no further
     * output can interleave between the drain and the two reads below: pty data
     * arrives as I/O, which is a later macrotask. That is what makes the pair
     * atomic without pausing the shell.
     */
    await this.settled(session)
    if (this.find(ref) !== session) return null

    /*
     * Anything queued for the previous view is already in the mirror, so it is
     * already in the snapshot. Sending it too would duplicate it.
     */
    session.outbox.length = 0
    if (session.flush !== null) {
      session.flush()
      session.flush = null
    }

    this.epochs += 1
    session.epoch = this.epochs
    session.attached = true
    session.ackedSeq = session.seq
    return {
      epoch: session.epoch,
      generation: session.generation,
      snapshot: session.serializer.serialize(),
      seq: session.seq,
      cols: session.cols,
      rows: session.rows,
      exitCode: session.exitCode,
    }
  }

  /**
   * The view has consumed everything up to `seq`.
   *
   * This is the other half of `pace`: without it the watermark can only see the
   * mirror, and a renderer that cannot keep up accumulates an unbounded queue in
   * a process that must not stall.
   */
  ack(ref: TerminalRef, epoch: number, seq: number): void {
    const session = this.live(ref, epoch)
    if (session === null) return
    session.ackedSeq = Math.min(Math.max(seq, session.ackedSeq), session.seq)
    this.pace(session)
  }

  /** Resolves when the mirror has no writes outstanding. */
  private settled(session: Session): Promise<void> {
    if (session.pending === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      session.drained.push(resolve)
    })
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

  /**
   * Throw away the scrollback, as `⌘K` does in Terminal.app.
   *
   * Both copies, and that is the whole reason this crosses the boundary at all.
   * The view could clear itself in one line — but the snapshot a remount restores
   * from is the headless mirror here, so clearing only the renderer would put
   * every cleared line back the next time the panel was reopened.
   *
   * The shell is not told. `⌘K` is a display action everywhere it exists: it does
   * not interrupt, it does not send a newline, and a half-typed command survives
   * it. Anything else would be a different feature wearing its shortcut.
   */
  clear(ref: TerminalRef, epoch: number): void {
    const session = this.live(ref, epoch)
    if (session === null) return
    session.mirror.clear()
  }

  /** What a confirmation dialog would need to say. */
  hasBusyShells(): boolean {
    return [...this.byShell.values()].some((shells) =>
      [...shells.values()].some(
        (session) =>
          !session.exited &&
          describeForeground(session.pty.process, session.shellName, this.platform).busy
      )
    )
  }

  describe(ref: TerminalRef): TerminalDescription | null {
    const session = this.find(ref)
    if (session === null) return null
    const { foreground, busy } = describeForeground(
      session.pty.process,
      session.shellName,
      this.platform
    )
    return {
      running: !session.exited,
      foreground,
      busy: !session.exited && busy,
      exitCode: session.exitCode,
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
    this.unconfirmed.add(session)
    if (ref.scope === 'shell') {
      if (!session.exited) session.pty.kill()
      this.retire(session)
      return
    }
    this.retire(session)
    if (!session.exited) session.pty.kill()
  }

  launch(ref: ProjectTerminalRef, spec: LaunchSpec): LaunchResult {
    const previous = this.find(ref)
    if (previous !== null && !previous.exited) return { kind: 'refused', reason: 'live-run' }
    if (previous !== null) this.retire(previous)
    const session = this.spawnSession(
      ref,
      { file: spec.file, args: spec.args, cwd: spec.cwd, env: spec.env },
      { cols: previous?.cols ?? DEFAULT_COLS, rows: previous?.rows ?? DEFAULT_ROWS },
      spec.generation
    )
    this.emit({ kind: 'replaced', ref, generation: spec.generation })
    return { kind: 'launched', pid: session.pty.pid }
  }

  interrupt(ref: ProjectTerminalRef, generation: number): boolean {
    const session = this.find(ref)
    if (session?.generation !== generation || session.exited) return false
    session.pty.write('\x03')
    return true
  }

  readText(ref: ProjectTerminalRef, maxLines: number, maxBytes: number): string | null {
    const session = this.find(ref)
    if (session === null) return null
    const buffer = session.mirror.buffer.active
    const lines: string[] = []
    for (let row = 0; row < buffer.length; row += 1) {
      const line = buffer.getLine(row)
      if (line === undefined) continue
      const next = buffer.getLine(row + 1)
      const text =
        next?.isWrapped === true
          ? line.translateToString(false, 0, usedColumns(line, next))
          : line.translateToString(true)
      const last = lines.length - 1
      if (line.isWrapped && last >= 0) lines[last] = `${lines[last] ?? ''}${text}`
      else lines.push(text)
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const count = Math.max(0, Math.floor(maxLines))
    const kept = lines.slice(Math.max(0, lines.length - count)).join('\n')
    const bytes = Buffer.from(kept, 'utf8')
    const limit = Math.max(0, Math.floor(maxBytes))
    if (bytes.length <= limit) return kept
    let start = bytes.length - limit
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1
    return bytes.subarray(start).toString('utf8')
  }

  /**
   * Kill, but only on behalf of the view that is currently mounted.
   *
   * A `dispose` carrying a superseded epoch is a stale click from a view that
   * has already been replaced, and killing a shell is the least recoverable
   * thing this surface does. The unguarded `dispose` above stays for the callers
   * that are not a user gesture — a conversation ending, and quitting.
   */
  disposeIfCurrent(ref: TerminalRef, epoch: number): void {
    if (this.live(ref, epoch) === null) return
    this.dispose(ref)
  }

  /**
   * Every terminal belonging to a conversation that is ending. **All of them.**
   *
   * Named rather than expressed as `dispose({scope:'session', …})` at the call
   * site so that `runtime.closeConversation` reads as what it means and cannot
   * accidentally be handed the global ref.
   *
   * The ids are copied before the loop, and the reason is **not** the one that
   * first went in this comment. That said a Map skips entries when you delete
   * during iteration; it does not — a Map iterator visits every key even as each
   * is deleted, which is what makes it different from an Array and was checked
   * rather than assumed. The copy stays because `dispose` → `forget` mutates
   * *two* levels — the inner map, and then `bySession` itself once the inner one
   * empties — and a loop whose safety depends on which of those the iterator is
   * pointing at is one refactor away from being wrong quietly.
   */
  disposeSession(conversationId: string): void {
    const inner = this.bySession.get(conversationId)
    if (inner === undefined) return
    for (const id of [...inner.keys()]) {
      this.dispose({ scope: 'session', conversationId, id })
    }
  }

  async stopSession(conversationId: string): Promise<void> {
    this.stoppingSessions.add(conversationId)
    await this.stopOwned((ref) => ref.scope === 'session' && ref.conversationId === conversationId)
  }

  async stopProject(projectId: string): Promise<void> {
    this.stoppingProjects.add(projectId)
    await this.stopOwned(
      (ref) => (ref.scope === 'project' || ref.scope === 'shell') && ref.projectId === projectId
    )
  }

  allowSession(conversationId: string): void {
    this.stoppingSessions.delete(conversationId)
  }

  allowProject(projectId: string): void {
    this.stoppingProjects.delete(projectId)
  }

  private async stopOwned(matches: (ref: TerminalRef) => boolean): Promise<void> {
    const sessions = new Set(
      [
        ...this.unconfirmed,
        ...this.globals.values(),
        ...[...this.bySession.values()].flatMap((inner) => [...inner.values()]),
        ...this.byProject.values(),
        ...[...this.byShell.values()].flatMap((inner) => [...inner.values()]),
      ].filter((session) => matches(session.ref))
    )
    const results = await Promise.allSettled(
      [...sessions].map((session) => this.stopOwnedSession(session))
    )
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (errors.length > 0)
      throw new AggregateError(
        errors.map((result): unknown => result.reason),
        'Some terminal processes could not be confirmed stopped'
      )
  }

  private stopOwnedSession(session: Session): Promise<void> {
    if (session.stopping !== undefined) return session.stopping
    const stopping = session.owned
      .stop(() => {
        if (!session.exited) session.pty.kill()
      })
      .then(() => {
        if (this.find(session.ref) === session) this.retire(session)
        this.unconfirmed.delete(session)
      })
      .finally(() => {
        delete session.stopping
      })
    session.stopping = stopping
    return stopping
  }

  refuseShells(projectId: string): void {
    this.shellsRemoved.add(projectId)
  }

  disposeShells(projectId: string): void {
    this.refuseShells(projectId)
    this.killShells([projectId])
  }

  /** Quit. Everything, including the global ones. */
  close(): void {
    this.shellsClosed = true
    for (const conversationId of [...this.bySession.keys()]) {
      this.disposeSession(conversationId)
    }
    for (const id of [...this.globals.keys()]) {
      this.dispose({ scope: 'global', id })
    }
    for (const projectId of [...this.byProject.keys()]) {
      this.dispose({ scope: 'project', projectId, id: 'run' })
    }
    this.killShells([...this.byShell.keys()])
  }

  private shellOpens(projectId: string): boolean {
    return (
      !this.shellsClosed &&
      !this.shellsRemoved.has(projectId) &&
      !this.stoppingProjects.has(projectId)
    )
  }

  private killShells(projectIds: readonly string[]): void {
    const failures: unknown[] = []
    for (const projectId of projectIds) {
      for (const id of [...(this.byShell.get(projectId)?.keys() ?? [])]) {
        try {
          this.dispose({ scope: 'shell', projectId, id })
        } catch (error) {
          failures.push(error)
        }
      }
    }
    if (failures.length > 0) throw failures[0]
  }

  private find(ref: TerminalRef): Session | null {
    switch (ref.scope) {
      case 'global':
        return this.globals.get(ref.id) ?? null
      case 'session':
        return this.bySession.get(ref.conversationId)?.get(ref.id) ?? null
      case 'project':
        return this.byProject.get(ref.projectId) ?? null
      case 'shell':
        return this.byShell.get(ref.projectId)?.get(ref.id) ?? null
    }
  }

  private retire(session: Session): void {
    this.unconfirmed.add(session)
    this.forget(session.ref)
    if (session.flush !== null) {
      session.flush()
      session.flush = null
    }
    session.outbox.length = 0
    for (const resolve of session.drained.splice(0)) resolve()
    if (session.pending === 0) {
      session.mirror.dispose()
      return
    }
    session.drained.push(() => {
      session.mirror.dispose()
    })
  }

  private forget(ref: TerminalRef): void {
    if (ref.scope === 'global') {
      this.globals.delete(ref.id)
      return
    }
    if (ref.scope === 'project') {
      this.byProject.delete(ref.projectId)
      return
    }
    if (ref.scope === 'shell') {
      const shells = this.byShell.get(ref.projectId)
      if (shells === undefined) return
      shells.delete(ref.id)
      if (shells.size === 0) this.byShell.delete(ref.projectId)
      return
    }
    const inner = this.bySession.get(ref.conversationId)
    if (inner === undefined) return
    inner.delete(ref.id)
    // The empty inner map goes too, or `bySession` keeps a key for every
    // conversation ever opened and `close()` walks a map of empty maps.
    if (inner.size === 0) this.bySession.delete(ref.conversationId)
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

  private open(ref: TerminalRef, size?: { cols: number; rows: number }): Session | null {
    const cwd = this.cwdFor(ref)
    if (cwd === null) return null
    const shell = this.shell ?? resolveShell(this.env, this.platform)
    return this.spawnSession(
      ref,
      { file: shell.file, args: shell.args, cwd, env: this.envFor?.(ref) ?? this.env },
      { cols: size?.cols ?? DEFAULT_COLS, rows: size?.rows ?? DEFAULT_ROWS },
      0
    )
  }

  private spawnSession(
    ref: TerminalRef,
    command: {
      readonly file: string
      readonly args: readonly string[]
      readonly cwd: string
      readonly env: NodeJS.ProcessEnv
    },
    size: { readonly cols: number; readonly rows: number },
    generation: number
  ): Session {
    const { cols, rows } = size
    if (ref.scope === 'session' && this.stoppingSessions.has(ref.conversationId))
      throw new Error('This chat is closing')
    if (
      (ref.scope === 'project' || ref.scope === 'shell') &&
      this.stoppingProjects.has(ref.projectId)
    )
      throw new Error('This project is closing')

    const pty = this.spawner({
      file: command.file,
      args: command.args,
      cwd: command.cwd,
      env: command.env,
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

    let reportExit: () => void = () => undefined
    const exited = new Promise<void>((resolve) => {
      reportExit = resolve
    })
    const owned = this.ownProcess(pty.pid, exited)
    void owned.capture().catch(() => undefined)
    const session: Session = {
      ref,
      pty,
      owned,
      mirror,
      serializer,
      shellName: basename(command.file),
      generation,
      epoch: 0,
      attached: false,
      seq: 0,
      ackedSeq: 0,
      pending: 0,
      outbox: [],
      flush: null,
      drained: [],
      paused: false,
      exited: false,
      exitCode: null,
      cols,
      rows,
    }

    pty.onData((data) => {
      if (this.find(ref) !== session) return
      this.absorb(session, data)
    })
    pty.onExit(({ exitCode }) => {
      session.exited = true
      reportExit()
      /*
       * Kept, not just flagged. This push fires once, and only the active tab of
       * a panel is mounted — so a shell that dies in the background emits to
       * nobody, and a later `attach` is the only chance to say it happened.
       */
      session.exitCode = exitCode
      if (this.find(ref) !== session) return
      // Whatever it wrote on the way out goes first, or the last line of a
      // failing command is lost behind the notice that it failed.
      this.drain(session)
      this.emit({ kind: 'exit', ref, epoch: session.epoch, generation, code: exitCode })
      for (const listener of this.taps) {
        listener(ref, { kind: 'exit', code: exitCode }, generation)
      }
    })

    switch (ref.scope) {
      case 'global':
        this.globals.set(ref.id, session)
        break
      case 'session': {
        const inner = this.bySession.get(ref.conversationId) ?? new Map<string, Session>()
        inner.set(ref.id, session)
        this.bySession.set(ref.conversationId, inner)
        break
      }
      case 'project':
        this.byProject.set(ref.projectId, session)
        break
      case 'shell': {
        const shells = this.byShell.get(ref.projectId) ?? new Map<string, Session>()
        shells.set(ref.id, session)
        this.byShell.set(ref.projectId, shells)
        break
      }
    }
    return session
  }

  /**
   * One chunk of output: into the mirror, and queued for whoever is attached.
   *
   * The mirror is written to unconditionally — that is what makes a snapshot
   * possible for a panel nobody is looking at.
   */
  private absorb(session: Session, data: string): void {
    session.seq += 1
    session.pending += 1
    session.mirror.write(data, () => {
      session.pending -= 1
      if (session.pending === 0) {
        const waiting = session.drained.splice(0)
        for (const resolve of waiting) resolve()
      }
      this.pace(session)
    })
    if (session.attached) {
      session.outbox.push(data)
      this.schedule(session)
    }
    this.pace(session)
    for (const listener of this.taps) {
      listener(session.ref, { kind: 'data', data }, session.generation)
    }
  }

  /**
   * Pause or resume the shell, on the **slower** of its two consumers.
   *
   * Two, and revision 2 of the plan counted only one. Waiting on the renderer
   * alone leaves the headless mirror unthrottled — and when the panel is hidden
   * there is no renderer attached at all, so nothing would throttle anything and
   * a firehose corrupts the snapshot the panel exists to restore. Waiting on the
   * mirror alone lets a renderer that cannot keep up accumulate an unbounded
   * queue in a process that must not stall.
   *
   * Unacked output only counts while something is attached; a detached terminal
   * is paced by the mirror alone, which is the point.
   */
  private pace(session: Session): void {
    const unacked = session.attached ? session.seq - session.ackedSeq : 0
    const behind = Math.max(session.pending, unacked)
    if (!session.paused && behind >= PENDING_HIGH) {
      session.paused = true
      session.pty.pause()
      return
    }
    if (session.paused && behind <= PENDING_LOW) {
      session.paused = false
      session.pty.resume()
    }
  }

  /**
   * Coalesce a frame's worth of output into one push.
   *
   * An optimisation on top of the pacing above, not a substitute for it: it
   * reduces call count across the bridge, which matters because better-sqlite3
   * is synchronous on this thread and every agent delta passes through it. It
   * does not reduce bytes, so it is not flow control — that is `pace`.
   */
  private schedule(session: Session): void {
    if (session.flush !== null) return
    session.flush = this.frame(() => {
      session.flush = null
      this.drain(session)
    })
  }

  /** Send whatever has accumulated, as one push carrying the latest seq. */
  private drain(session: Session): void {
    if (session.flush !== null) {
      session.flush()
      session.flush = null
    }
    if (session.outbox.length === 0) return
    const data = session.outbox.join('')
    session.outbox.length = 0
    this.emit({
      kind: 'data',
      ref: session.ref,
      epoch: session.epoch,
      generation: session.generation,
      seq: session.seq,
      data,
    })
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
      /*
       * `?? ''` because the types say `string` and darwin returns `undefined`.
       *
       * node-pty's getter is asymmetric, and only the branch we run on is
       * missing its guard (`lib/unixTerminal.js:236`):
       *
       *   if (process.platform === 'darwin') {
       *     const title = pty.process(this._fd)
       *     return title !== 'kernel_task' ? title : this._file   // no fallback
       *   }
       *   return pty.process(this._fd, this._pty) || this._file   // guarded
       *
       * Once the child is gone there is no fd to read a title from, so a dead
       * shell answers `undefined` through a `readonly process: string`. That
       * failed `terminal:describe`'s response schema and threw across IPC —
       * for *any* terminal that has exited and not been disposed, which is
       * exactly the state an exited tab sits in.
       *
       * Observed, not inferred: `build/terminal-siblings-probe.mjs` crashed on
       * it. This is the Adapters rule one layer down — read the shape the
       * binary actually returns, not the one its `.d.ts` claims.
       *
       * The cast widens to what it actually returns rather than suppressing the
       * checker: without it `no-unnecessary-condition` is correct that `??` is
       * dead code, because it is reading the same wrong declaration. This file
       * is the one place that knows which driver we use, so it is where the
       * correction belongs.
       */
      return (child.process as string | undefined) ?? ''
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
