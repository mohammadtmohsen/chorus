import { describe, expect, it } from 'vitest'
import {
  TerminalService,
  describeForeground,
  type Frame,
  type LaunchSpec,
  type ProjectTerminalRef,
  type Pty,
  type PtyOptions,
  type TerminalAttachment,
  type TerminalEvent,
  type TerminalPush,
  type TerminalRef,
  type TerminalServiceOptions,
} from './terminal.js'

/** A PTY that records what was asked of it and lets a test push output in. */
class FakePty implements Pty {
  readonly pid = 1234
  process = 'zsh'
  readonly written: string[] = []
  readonly sizes: [number, number][] = []
  killed = false
  paused = false
  resumes = 0
  private data: (d: string) => void = () => undefined
  private exit: (e: { exitCode: number }) => void = () => undefined

  constructor(readonly options: PtyOptions) {}

  write(d: string): void {
    this.written.push(d)
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows])
  }
  kill(): void {
    this.killed = true
  }
  pause(): void {
    this.paused = true
  }
  resume(): void {
    this.paused = false
    this.resumes += 1
  }
  onData(l: (d: string) => void): void {
    this.data = l
  }
  onExit(l: (e: { exitCode: number }) => void): void {
    this.exit = l
  }

  emit(d: string): void {
    this.data(d)
  }
  finish(code: number): void {
    this.exit({ exitCode: code })
  }
}

interface Harness {
  service: TerminalService
  spawned: FakePty[]
  pushes: TerminalPush[]
  /** Run every frame callback the service has queued. Coalescing is per frame. */
  tick: () => void
}

function build(overrides: Partial<TerminalServiceOptions> = {}): Harness {
  const spawned: FakePty[] = []
  const pushes: TerminalPush[] = []
  const queued: (() => void)[] = []
  const frame: Frame = (run) => {
    queued.push(run)
    return () => {
      const at = queued.indexOf(run)
      if (at >= 0) queued.splice(at, 1)
    }
  }
  const service = new TerminalService({
    /*
     * Named, not inherited. These tests assert unix shell selection and unix
     * busy/idle — `zsh` in the foreground, `ssh` on top of it — and without this
     * they asserted whichever host they happened to run on, which on the Windows
     * runner meant `cmd.exe` and a terminal that is never busy.
     */
    platform: 'darwin',
    // Named too, because resolveShell checks the disk and `/bin/zsh` is not on
    // a Windows runner — these tests assert a shell called `zsh`, not whichever
    // fallback the host happens to have.
    shell: { file: '/bin/zsh', args: ['-l'] },
    cwdFor: (ref) => {
      switch (ref.scope) {
        case 'global':
          return '/home/me'
        case 'session':
          return `/work/${ref.conversationId}`
        case 'project':
          return `/projects/${ref.projectId}`
        case 'shell':
          return `/shells/${ref.projectId}`
      }
    },
    ownProcess: () => ({
      capture: () => Promise.resolve(),
      stop: async (graceful) => {
        await graceful?.()
      },
    }),
    env: { SHELL: '/bin/zsh' },
    frame,
    spawn: (options) => {
      const pty = new FakePty(options)
      spawned.push(pty)
      return pty
    },
    ...overrides,
  })
  service.subscribe((p) => pushes.push(p))
  return {
    service,
    spawned,
    pushes,
    tick: () => {
      for (const run of queued.splice(0)) run()
    },
  }
}

const GLOBAL: TerminalRef = { scope: 'global', id: 't1' }
const SESSION: TerminalRef = { scope: 'session', conversationId: 'c1', id: 't1' }

/** SESSION's sibling: same conversation, second shell. */
const SESSION_B: TerminalRef = { scope: 'session', conversationId: 'c1', id: 't2' }
/** The global panel's second shell. */
const GLOBAL_B: TerminalRef = { scope: 'global', id: 't2' }

/** xterm's write callback lands on a later tick; nothing here is synchronous. */
const settled = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 20))
}

const data = (pushes: TerminalPush[]): Extract<TerminalPush, { kind: 'data' }>[] =>
  pushes.filter((p): p is Extract<TerminalPush, { kind: 'data' }> => p.kind === 'data')

async function attached(
  service: TerminalService,
  ref: TerminalRef,
  size?: { cols: number; rows: number }
): Promise<TerminalAttachment> {
  const opened = await service.attach(ref, size)
  if (opened === null) throw new Error('nothing to attach to')
  return opened
}

const PROJECT: ProjectTerminalRef = { scope: 'project', projectId: 'p1', id: 'run' }
const PROJECT_B: ProjectTerminalRef = { scope: 'project', projectId: 'p2', id: 'run' }

const RUN_ENV = { SHELL: '/bin/zsh', EXPO_PUBLIC_API_BASE_URL: 'http://127.0.0.1:30100' }

const launchSpec = (generation: number, cwd = '/repo/p1'): LaunchSpec => ({
  cwd,
  env: RUN_ENV,
  file: '/bin/zsh',
  args: ['-lc', 'npm run dev'],
  generation,
})

describe('opening', () => {
  it('spawns nothing until something attaches', () => {
    const { spawned } = build()
    expect(spawned).toHaveLength(0)
  })

  it('opens the global shell in the home directory', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    expect(spawned[0]?.options.cwd).toBe('/home/me')
  })

  it("opens a session shell in that conversation's directory", async () => {
    const { service, spawned } = build()
    await service.attach(SESSION)
    expect(spawned[0]?.options.cwd).toBe('/work/c1')
  })

  it('reuses the shell when a view remounts', async () => {
    const { service, spawned } = build()
    const first = await attached(service, GLOBAL)
    service.detach(GLOBAL, first.epoch)
    await service.attach(GLOBAL)
    expect(spawned).toHaveLength(1)
  })
})

describe('the tap', () => {
  it('sees output from a shell with no view attached', async () => {
    const { service, spawned, pushes } = build()
    const seen: [TerminalRef, TerminalEvent][] = []
    service.tap((ref, event) => seen.push([ref, event]))

    const opened = await attached(service, GLOBAL)
    service.detach(GLOBAL, opened.epoch)
    spawned[0]?.emit('metro is listening')

    expect(seen).toEqual([[GLOBAL, { kind: 'data', data: 'metro is listening' }]])
    expect(pushes).toHaveLength(0)
  })

  it('sees a shell exit, which a background shell reports to no view', async () => {
    const { service, spawned } = build()
    const seen: TerminalEvent[] = []
    service.tap((_ref, event) => seen.push(event))

    const opened = await attached(service, GLOBAL)
    service.detach(GLOBAL, opened.epoch)
    spawned[0]?.finish(7)

    expect(seen).toEqual([{ kind: 'exit', code: 7 }])
  })

  it('stops delivering once the tap is released', async () => {
    const { service, spawned } = build()
    const seen: string[] = []
    const stop = service.tap((_ref, event) => {
      if (event.kind === 'data') seen.push(event.data)
    })
    await service.attach(GLOBAL)

    spawned[0]?.emit('one')
    stop()
    spawned[0]?.emit('two')

    expect(seen).toEqual(['one'])
  })

  it('leaves the view protocol exactly as it was', async () => {
    const { service, spawned, pushes, tick } = build()
    service.tap(() => undefined)

    const opened = await attached(service, GLOBAL)
    spawned[0]?.emit('one')
    spawned[0]?.emit('two')
    tick()

    expect(data(pushes)).toHaveLength(1)
    expect(data(pushes)[0]?.seq).toBe(2)
    expect(data(pushes)[0]?.epoch).toBe(opened.epoch)
    expect(data(pushes)[0]?.data).toBe('onetwo')
  })
})

describe('separate storage for global and session', () => {
  /*
   * The reason `TerminalRef` is a union and storage is two fields. With one map
   * keyed by a string, any loop that tears down "every session" reaches the
   * global terminal too, and it is gone the first time a conversation ends.
   */
  it('ending a conversation leaves the global shell running', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    await service.attach(SESSION)
    service.disposeSession('c1')
    const [globalPty, sessionPty] = spawned
    expect(sessionPty?.killed).toBe(true)
    expect(globalPty?.killed).toBe(false)
    /*
     * Not just unkilled — still *held*. Dropping it from storage without killing
     * it passes an `unkilled` assertion while leaking the process and losing the
     * user's terminal, which is the failure mode a shared keyed map produces.
     */
    expect(service.describe(GLOBAL)?.running).toBe(true)
  })

  it('ending every conversation still leaves the global shell running', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    await service.attach(SESSION)
    await service.attach({ scope: 'session', conversationId: 'c2', id: 't1' })
    service.disposeSession('c1')
    service.disposeSession('c2')
    expect(spawned[0]?.killed).toBe(false)
    expect(service.describe(GLOBAL)?.running).toBe(true)
  })

  it('quitting kills everything, global included', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    await service.attach(SESSION)
    service.close()
    expect(spawned.every((p) => p.killed)).toBe(true)
  })
})

describe('several terminals in one scope', () => {
  it('gives each id its own shell rather than reusing one', async () => {
    const { service, spawned } = build()
    await service.attach(SESSION)
    await service.attach(SESSION_B)
    expect(spawned).toHaveLength(2)
  })

  it('keeps the global panel’s shells separate from each other too', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    await service.attach(GLOBAL_B)
    expect(spawned).toHaveLength(2)
  })

  /*
   * Writing to one sibling must not reach the other. The whole reason `id` is
   * part of the lookup rather than decoration on the ref.
   */
  it('routes a write to the shell it names', async () => {
    const { service, spawned } = build()
    const first = await attached(service, SESSION)
    const second = await attached(service, SESSION_B)
    service.write(SESSION, first.epoch, 'one')
    service.write(SESSION_B, second.epoch, 'two')
    expect(spawned[0]?.written).toEqual(['one'])
    expect(spawned[1]?.written).toEqual(['two'])
  })

  /*
   * Three, not two, and not because of an iteration hazard — a Map iterator
   * visits every key even as each is deleted, which was checked rather than
   * assumed. Three because the old `disposeSession` was a single `dispose` call
   * with no loop at all, and a two-terminal fixture cannot tell "kills all of
   * them" from "kills the one it happened to look up first" as clearly.
   */
  it('ending a conversation kills every one of its terminals', async () => {
    const { service, spawned } = build()
    await service.attach(SESSION)
    await service.attach(SESSION_B)
    await service.attach({ scope: 'session', conversationId: 'c1', id: 't3' })
    service.disposeSession('c1')
    expect(spawned).toHaveLength(3)
    expect(spawned.every((p) => p.killed)).toBe(true)
    expect(service.describe(SESSION_B)).toBeNull()
  })

  it('and still leaves every global one running', async () => {
    const { service } = build()
    await service.attach(GLOBAL)
    await service.attach(GLOBAL_B)
    await service.attach(SESSION)
    service.disposeSession('c1')
    expect(service.describe(GLOBAL)?.running).toBe(true)
    expect(service.describe(GLOBAL_B)?.running).toBe(true)
  })

  it('quitting drains every shell in both scopes', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    await service.attach(GLOBAL_B)
    await service.attach(SESSION)
    await service.attach(SESSION_B)
    service.close()
    expect(spawned).toHaveLength(4)
    expect(spawned.every((p) => p.killed)).toBe(true)
  })

  /*
   * Killing one sibling leaves the other addressable. The failure this catches
   * is a `forget` that drops the conversation's whole inner map instead of one
   * entry — which passes "the killed one is gone" and loses the other.
   */
  it('killing one sibling leaves the other running and reachable', async () => {
    const { service, spawned } = build()
    await service.attach(SESSION)
    const second = await attached(service, SESSION_B)
    service.dispose(SESSION)
    expect(spawned[0]?.killed).toBe(true)
    expect(spawned[1]?.killed).toBe(false)
    expect(service.describe(SESSION_B)?.running).toBe(true)
    service.write(SESSION_B, second.epoch, 'still here')
    expect(spawned[1]?.written).toEqual(['still here'])
  })
})

describe('killing a shell nothing is attached to', () => {
  /*
   * `dispose` with no epoch is what `terminal:kill` runs, and its caller is a tab
   * strip rather than a mounted view — a background tab has no attachment to
   * quote an epoch from. The epoch guard stays on `disposeIfCurrent`, whose only
   * caller *is* a mounted view.
   */
  it('kills a detached terminal that no view could speak for', async () => {
    const { service, spawned } = build()
    const opened = await attached(service, SESSION)
    service.detach(SESSION, opened.epoch)
    service.dispose(SESSION)
    expect(spawned[0]?.killed).toBe(true)
    expect(service.describe(SESSION)).toBeNull()
  })

  /* A stale click on a tab whose shell already exited must not throw. */
  it('forgets a shell that had already exited, without killing twice', async () => {
    const { service, spawned } = build()
    await service.attach(SESSION)
    spawned[0]?.finish(0)
    service.dispose(SESSION)
    service.dispose(SESSION)
    expect(service.describe(SESSION)).toBeNull()
  })

  /*
   * The guarded path still refuses a superseded epoch, which is the whole reason
   * `kill` is a separate channel rather than `dispose` with the guard relaxed.
   */
  it('still ignores a dispose carrying a superseded epoch', async () => {
    const { service, spawned } = build()
    const first = await attached(service, SESSION)
    await service.attach(SESSION)
    service.disposeIfCurrent(SESSION, first.epoch)
    expect(spawned[0]?.killed).toBe(false)
    expect(service.describe(SESSION)?.running).toBe(true)
  })
})

describe('an exit that nobody was watching', () => {
  /*
   * `exit` is a one-shot push and only the active tab of a panel is mounted, so
   * a shell that dies in the background emits to no view at all. Without the
   * code being kept, reopening that tab shows a dead shell looking alive.
   */
  it('reports the code to a view that attaches afterwards', async () => {
    const { service, spawned } = build()
    const first = await attached(service, SESSION)
    service.detach(SESSION, first.epoch)
    spawned[0]?.finish(3)
    const second = await attached(service, SESSION)
    expect(second.exitCode).toBe(3)
  })

  it('says nothing about a shell that is still running', async () => {
    const { service } = build()
    const opened = await attached(service, SESSION)
    expect(opened.exitCode).toBeNull()
    expect(service.describe(SESSION)?.exitCode).toBeNull()
  })

  it('describes the code as well, for a tab that is not mounted', async () => {
    const { service, spawned } = build()
    await service.attach(SESSION)
    spawned[0]?.finish(130)
    expect(service.describe(SESSION)?.exitCode).toBe(130)
    expect(service.describe(SESSION)?.running).toBe(false)
  })

  /*
   * A dead pty has no foreground process to report, and on darwin node-pty
   * answers `undefined` through a getter its own types declare as `string` —
   * there is no `|| this._file` on that branch, unlike every other platform.
   * The `nodePty` adapter turns that into `''`; this is the other half, and
   * without it `terminal:describe` returns a `foreground` the response schema
   * rejects, throwing across IPC for any terminal that exited and was not
   * disposed. Which is precisely the state an exited tab sits in.
   */
  it('still names a shell after the process behind it is gone', async () => {
    const { service, spawned } = build()
    await service.attach(SESSION)
    const pty = spawned[0]
    if (pty === undefined) throw new Error('no pty')
    pty.finish(1)
    // What the adapter hands us once the child is gone.
    pty.process = ''
    const described = service.describe(SESSION)
    expect(typeof described?.foreground).toBe('string')
    expect(described?.foreground).toBe('zsh')
    expect(described?.busy).toBe(false)
  })

  /*
   * A zero is a real exit code and `?? null` on a falsy number is the classic way
   * to lose it — a clean `exit` would read as a shell still running.
   */
  it('keeps a zero exit rather than treating it as absent', async () => {
    const { service, spawned } = build()
    const first = await attached(service, SESSION)
    service.detach(SESSION, first.epoch)
    spawned[0]?.finish(0)
    expect((await attached(service, SESSION)).exitCode).toBe(0)
  })
})

describe('detach is not dispose', () => {
  /*
   * React effect cleanup calls `detach`. If that killed the shell, backgrounding
   * a tab would kill a running build — the exact thing main-process ownership
   * exists to prevent.
   */
  it('detaching leaves the shell alive', async () => {
    const { service, spawned } = build()
    const { epoch } = await attached(service, GLOBAL)
    service.detach(GLOBAL, epoch)
    expect(spawned[0]?.killed).toBe(false)
    expect(service.describe(GLOBAL)?.running).toBe(true)
  })

  it('output still reaches the mirror while detached, so the snapshot is current', async () => {
    const { service, spawned } = build()
    const first = await attached(service, GLOBAL)
    service.detach(GLOBAL, first.epoch)
    spawned[0]?.emit('while you were away')
    await settled()
    const again = await attached(service, GLOBAL)
    expect(again.snapshot).toContain('while you were away')
  })

  it('stops pushing to a detached view', async () => {
    const { service, spawned, pushes, tick } = build()
    const { epoch } = await attached(service, GLOBAL)
    service.detach(GLOBAL, epoch)
    spawned[0]?.emit('quiet')
    tick()
    await settled()
    expect(data(pushes)).toHaveLength(0)
  })
})

describe('epochs', () => {
  /*
   * `TerminalRef` names a shell, not a consumer. Without an epoch, the `detach`
   * from a view that is unmounting races the `attach` of the view replacing it
   * and tears down the wrong subscription.
   */
  it('a stale detach cannot unsubscribe the view that replaced it', async () => {
    const { service, spawned, pushes, tick } = build()
    const stale = await attached(service, GLOBAL)
    await service.attach(GLOBAL)
    service.detach(GLOBAL, stale.epoch)
    spawned[0]?.emit('still here')
    tick()
    expect(data(pushes)).toHaveLength(1)
  })

  it('ignores a write stamped with a superseded epoch', async () => {
    const { service, spawned } = build()
    const stale = await attached(service, GLOBAL)
    await service.attach(GLOBAL)
    service.write(GLOBAL, stale.epoch, 'ls\r')
    expect(spawned[0]?.written).toHaveLength(0)
  })

  it('accepts a write from the current epoch', async () => {
    const { service, spawned } = build()
    const now = await attached(service, GLOBAL)
    service.write(GLOBAL, now.epoch, 'ls\r')
    expect(spawned[0]?.written).toEqual(['ls\r'])
  })

  it('ignores a resize stamped with a superseded epoch', async () => {
    const { service, spawned } = build()
    const stale = await attached(service, GLOBAL, { cols: 80, rows: 24 })
    await service.attach(GLOBAL)
    service.resize(GLOBAL, stale.epoch, 200, 50)
    expect(spawned[0]?.sizes).toHaveLength(0)
  })

  it('ignores an ack stamped with a superseded epoch', async () => {
    const { service, spawned, tick } = build()
    const stale = await attached(service, GLOBAL)
    await service.attach(GLOBAL)
    for (let i = 0; i < 100; i += 1) spawned[0]?.emit('x')
    tick()
    await settled()
    service.ack(GLOBAL, stale.epoch, 100)
    expect(spawned[0]?.paused).toBe(true)
  })
})

describe('geometry', () => {
  it('passes the requested size to the shell', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL, { cols: 120, rows: 40 })
    expect(spawned[0]?.options.cols).toBe(120)
    expect(spawned[0]?.options.rows).toBe(40)
  })

  it('forwards a resize so SIGWINCH fires', async () => {
    const { service, spawned } = build()
    const { epoch } = await attached(service, GLOBAL, { cols: 80, rows: 24 })
    service.resize(GLOBAL, epoch, 100, 30)
    expect(spawned[0]?.sizes).toEqual([[100, 30]])
  })

  it('does not churn the shell when the size has not changed', async () => {
    const { service, spawned } = build()
    const { epoch } = await attached(service, GLOBAL, { cols: 80, rows: 24 })
    service.resize(GLOBAL, epoch, 80, 24)
    expect(spawned[0]?.sizes).toHaveLength(0)
  })
})

describe('the snapshot', () => {
  /*
   * Why this is a serialized emulator and not a ring of raw bytes: VT state is
   * cumulative. A suffix of output loses the alternate-screen entry and the
   * colour that came before it, and `vim` remounts blank or corrupted.
   */
  it('restores colour set before the retained output', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    spawned[0]?.emit('[31mred')
    await settled()
    const again = await attached(service, GLOBAL)
    expect(again.snapshot).toContain('31m')
  })

  it('restores the alternate screen, which a byte suffix would lose', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    spawned[0]?.emit('[?1049h')
    spawned[0]?.emit('inside vim')
    await settled()
    const { snapshot } = await attached(service, GLOBAL)
    expect(snapshot).toContain('1049')
    expect(snapshot).toContain('inside vim')
  })

  /*
   * The race `attach` awaits the mirror to close. Serializing with writes
   * outstanding returns a screen behind `seq`, and the view would then discard
   * the very pushes that would have filled the gap as already-seen.
   */
  it('includes output written immediately before it, with no sleep', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    spawned[0]?.emit('written just now')
    const again = await attached(service, GLOBAL)
    expect(again.snapshot).toContain('written just now')
    expect(again.seq).toBe(1)
  })

  it('does not replay what the snapshot already contains', async () => {
    const { service, spawned, pushes, tick } = build()
    await service.attach(GLOBAL)
    spawned[0]?.emit('once')
    await service.attach(GLOBAL)
    tick()
    expect(data(pushes)).toHaveLength(0)
  })
})

describe('coalescing', () => {
  it('sends one push per frame, not one per chunk', async () => {
    const { service, spawned, pushes, tick } = build()
    await service.attach(GLOBAL)
    spawned[0]?.emit('a')
    spawned[0]?.emit('b')
    spawned[0]?.emit('c')
    tick()
    expect(data(pushes)).toHaveLength(1)
    expect(data(pushes)[0]?.data).toBe('abc')
  })

  it('carries the sequence number of the last chunk it contains', async () => {
    const { service, spawned, pushes, tick } = build()
    await service.attach(GLOBAL)
    spawned[0]?.emit('a')
    spawned[0]?.emit('b')
    tick()
    expect(data(pushes)[0]?.seq).toBe(2)
  })

  it('loses nothing when the shell exits mid-frame', async () => {
    const { service, spawned, pushes } = build()
    await service.attach(GLOBAL)
    spawned[0]?.emit('last words')
    spawned[0]?.finish(1)
    expect(data(pushes)[0]?.data).toBe('last words')
    expect(pushes.at(-1)).toMatchObject({ kind: 'exit', code: 1 })
  })
})

describe('backpressure', () => {
  /*
   * Paced by the slower of two consumers. Waiting on the renderer alone leaves
   * the mirror unthrottled — and with the panel hidden there is no renderer at
   * all, so nothing would throttle anything and a firehose would corrupt the
   * very snapshot the panel exists to restore.
   */
  it('pauses the shell when the mirror falls behind, with nobody attached', async () => {
    const { service, spawned } = build()
    const { epoch } = await attached(service, GLOBAL)
    service.detach(GLOBAL, epoch)
    for (let i = 0; i < 100; i += 1) spawned[0]?.emit(`line ${String(i)}\r\n`)
    expect(spawned[0]?.paused).toBe(true)
  })

  it('resumes once the mirror has caught up', async () => {
    const { service, spawned } = build()
    const { epoch } = await attached(service, GLOBAL)
    service.detach(GLOBAL, epoch)
    for (let i = 0; i < 100; i += 1) spawned[0]?.emit(`line ${String(i)}\r\n`)
    expect(spawned[0]?.paused).toBe(true)
    await settled()
    expect(spawned[0]?.paused).toBe(false)
    expect(spawned[0]?.resumes).toBeGreaterThan(0)
  })

  /*
   * The half revision 2 was missing: a renderer that never acknowledges must
   * stop the shell even though the mirror is keeping up perfectly.
   */
  it('stays paused while an attached view never acknowledges', async () => {
    const { service, spawned, tick } = build()
    await service.attach(GLOBAL)
    for (let i = 0; i < 100; i += 1) spawned[0]?.emit(`line ${String(i)}\r\n`)
    tick()
    await settled()
    expect(spawned[0]?.paused).toBe(true)
  })

  it('resumes when the view acknowledges what it consumed', async () => {
    const { service, spawned, tick } = build()
    const { epoch } = await attached(service, GLOBAL)
    for (let i = 0; i < 100; i += 1) spawned[0]?.emit(`line ${String(i)}\r\n`)
    tick()
    await settled()
    expect(spawned[0]?.paused).toBe(true)
    service.ack(GLOBAL, epoch, 100)
    expect(spawned[0]?.paused).toBe(false)
  })

  it('does not pause a shell that is merely chatty', async () => {
    const { service, spawned, tick } = build()
    await service.attach(GLOBAL)
    spawned[0]?.emit('a line\r\n')
    tick()
    await settled()
    expect(spawned[0]?.paused).toBe(false)
  })

  /*
   * Transport completeness, which is what the plan's 50MB criterion should have
   * measured. Comparing against the terminal's *contents* cannot work: a bounded
   * scrollback discards old rows by design.
   */
  it('delivers every byte, in order, under a firehose', async () => {
    const { service, spawned, pushes, tick } = build()
    const { epoch } = await attached(service, GLOBAL)
    let sent = ''
    for (let i = 0; i < 2_000; i += 1) {
      const chunk = `chunk-${String(i)}\r\n`
      sent += chunk
      spawned[0]?.emit(chunk)
      if (i % 50 === 0) {
        tick()
        service.ack(GLOBAL, epoch, i + 1)
      }
    }
    tick()
    await settled()
    tick()
    const received = data(pushes)
      .map((p) => p.data)
      .join('')
    expect(received).toBe(sent)
    expect(data(pushes).map((p) => p.seq)).toEqual(
      [...data(pushes)].map((p) => p.seq).sort((a, b) => a - b)
    )
  })
})

describe('a shell that exits', () => {
  it('reports the exit code rather than going quiet', async () => {
    const { service, spawned, pushes } = build()
    await service.attach(GLOBAL)
    spawned[0]?.finish(3)
    expect(pushes.at(-1)).toMatchObject({ kind: 'exit', code: 3 })
  })

  it('is no longer running, but is still there to be looked at', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    spawned[0]?.finish(0)
    expect(service.describe(GLOBAL)).toMatchObject({ running: false, busy: false })
  })

  it('swallows a write instead of throwing', async () => {
    const { service, spawned } = build()
    const { epoch } = await attached(service, GLOBAL)
    spawned[0]?.finish(0)
    expect(() => {
      service.write(GLOBAL, epoch, 'ls\r')
    }).not.toThrow()
  })

  it('is not killed again when disposed', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    spawned[0]?.finish(0)
    service.dispose(GLOBAL)
    expect(spawned[0]?.killed).toBe(false)
  })
})

describe('describe', () => {
  it('knows nothing about a terminal that was never opened', () => {
    const { service } = build()
    expect(service.describe(GLOBAL)).toBeNull()
  })

  it('is idle when the shell itself is in the foreground', async () => {
    const { service } = build()
    await service.attach(GLOBAL)
    expect(service.describe(GLOBAL)?.busy).toBe(false)
  })

  /*
   * What a "this will lose work" confirmation would key on. Kept as data rather
   * than a policy so the product decision — never ask, ask when busy, ask only
   * on quit — can be made without changing this signature.
   */
  it('is busy when something else is', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    const pty = spawned[0]
    if (pty !== undefined) pty.process = 'ssh'
    expect(service.describe(GLOBAL)).toMatchObject({ busy: true, foreground: 'ssh' })
  })
})

describe('clearing', () => {
  /*
   * `⌘K` in Terminal.app throws away the scrollback. Here it has to throw away
   * *two* copies: the view's, and the headless mirror a remount restores from.
   * Clearing only the view puts every cleared line back on the next tab switch.
   */
  it('empties the snapshot a remount would restore', async () => {
    const { service, spawned } = build()
    const { epoch } = await attached(service, GLOBAL)
    spawned[0]?.emit('a line nobody wants to see again\r\n')
    await settled()
    expect((await attached(service, GLOBAL)).snapshot).toContain('nobody wants')

    const current = await attached(service, GLOBAL)
    service.clear(GLOBAL, current.epoch)
    await settled()
    expect((await attached(service, GLOBAL)).snapshot).not.toContain('nobody wants')
    expect(epoch).toBeLessThan(current.epoch)
  })

  /*
   * A display action, not an input one. Nothing is written to the shell, so a
   * half-typed command survives it — anything else would be a different feature
   * wearing this shortcut.
   */
  it('says nothing to the shell', async () => {
    const { service, spawned } = build()
    const { epoch } = await attached(service, GLOBAL)
    service.clear(GLOBAL, epoch)
    expect(spawned[0]?.written).toHaveLength(0)
  })

  it('does not kill anything', async () => {
    const { service, spawned } = build()
    const { epoch } = await attached(service, GLOBAL)
    service.clear(GLOBAL, epoch)
    expect(spawned[0]?.killed).toBe(false)
    expect(service.describe(GLOBAL)?.running).toBe(true)
  })

  it('ignores a clear stamped with a superseded epoch', async () => {
    const { service, spawned } = build()
    const stale = await attached(service, GLOBAL)
    await service.attach(GLOBAL)
    spawned[0]?.emit('still wanted')
    await settled()
    service.clear(GLOBAL, stale.epoch)
    await settled()
    expect((await attached(service, GLOBAL)).snapshot).toContain('still wanted')
  })
})

describe('the project run', () => {
  describe('before anything has run', () => {
    it('attaching spawns nothing and finds nothing', async () => {
      const { service, spawned } = build()
      expect(await service.attach(PROJECT)).toBeNull()
      expect(await service.attach(PROJECT, { cols: 100, rows: 30 })).toBeNull()
      expect(spawned).toHaveLength(0)
      expect(service.describe(PROJECT)).toBeNull()
    })

    it('has no text to read', () => {
      const { service } = build()
      expect(service.readText(PROJECT, 10, 1_000)).toBeNull()
    })

    it('has nothing to interrupt', () => {
      const { service, spawned } = build()
      expect(service.interrupt(PROJECT, 0)).toBe(false)
      expect(spawned).toHaveLength(0)
    })
  })

  describe('launching', () => {
    it('runs the command it was given, where and with the env it was given', () => {
      const { service, spawned } = build()
      expect(service.launch(PROJECT, launchSpec(1))).toEqual({ kind: 'launched', pid: 1234 })
      expect(spawned).toHaveLength(1)
      expect(spawned[0]?.options.file).toBe('/bin/zsh')
      expect(spawned[0]?.options.args).toEqual(['-lc', 'npm run dev'])
      expect(spawned[0]?.options.cwd).toBe('/repo/p1')
      expect(spawned[0]?.options.env).toEqual(RUN_ENV)
    })

    it('announces the replacement with the generation it was launched under', () => {
      const { service, pushes } = build()
      service.launch(PROJECT, launchSpec(4))
      expect(pushes).toEqual([{ kind: 'replaced', ref: PROJECT, generation: 4 }])
    })

    it('can be attached to once it exists, and says which generation it is', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(2))
      const opened = await attached(service, PROJECT)
      expect(opened.generation).toBe(2)
      expect(opened.exitCode).toBeNull()
      expect(spawned).toHaveLength(1)
    })

    it('refuses to start over a run that is still alive', () => {
      const { service, spawned, pushes } = build()
      service.launch(PROJECT, launchSpec(1))
      expect(service.launch(PROJECT, launchSpec(2))).toEqual({
        kind: 'refused',
        reason: 'live-run',
      })
      expect(spawned).toHaveLength(1)
      expect(spawned[0]?.killed).toBe(false)
      expect(pushes.filter((p) => p.kind === 'replaced')).toHaveLength(1)
    })

    it('replaces a run that has exited, at the size the old one had', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      await service.attach(PROJECT, { cols: 132, rows: 40 })
      spawned[0]?.finish(0)
      expect(service.launch(PROJECT, launchSpec(2))).toEqual({ kind: 'launched', pid: 1234 })
      expect(spawned).toHaveLength(2)
      expect(spawned[1]?.options.cols).toBe(132)
      expect(spawned[1]?.options.rows).toBe(40)
      expect((await attached(service, PROJECT)).generation).toBe(2)
    })
  })

  describe('a run that has finished', () => {
    it('keeps what it printed, and its code, until the next one starts', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      spawned[0]?.emit('build failed\r\n')
      spawned[0]?.finish(1)
      await settled()
      const opened = await attached(service, PROJECT)
      expect(opened.snapshot).toContain('build failed')
      expect(opened.exitCode).toBe(1)
      expect(service.readText(PROJECT, 10, 1_000)).toBe('build failed')
    })

    it('is gone once killed, and attaching does not open a shell in its place', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      service.dispose(PROJECT)
      expect(spawned[0]?.killed).toBe(true)
      expect(await service.attach(PROJECT)).toBeNull()
      expect(spawned).toHaveLength(1)
    })
  })

  describe('isolation', () => {
    it("one project's run cannot see or stop another's", async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      service.launch(PROJECT_B, launchSpec(1, '/repo/p2'))
      expect(spawned).toHaveLength(2)
      expect(spawned[1]?.options.cwd).toBe('/repo/p2')

      spawned[1]?.emit('only in p2\r\n')
      await settled()
      expect(service.readText(PROJECT, 10, 1_000)).toBe('')
      expect(service.readText(PROJECT_B, 10, 1_000)).toBe('only in p2')

      spawned[0]?.finish(0)
      expect(service.launch(PROJECT_B, launchSpec(2))).toEqual({
        kind: 'refused',
        reason: 'live-run',
      })
      service.dispose(PROJECT)
      expect(spawned[1]?.killed).toBe(false)
      expect(service.describe(PROJECT_B)?.running).toBe(true)
    })

    it('a conversation ending leaves the run alone', () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      service.disposeSession('c1')
      expect(spawned[0]?.killed).toBe(false)
      expect(service.describe(PROJECT)?.running).toBe(true)
    })

    it('a global or session shell never becomes the run', async () => {
      const { service, spawned } = build()
      await service.attach(GLOBAL)
      await service.attach(SESSION)
      expect(await service.attach(PROJECT)).toBeNull()
      expect(spawned).toHaveLength(2)
      expect(spawned.map((p) => p.options.cwd)).toEqual(['/home/me', '/work/c1'])
    })

    it('quitting kills the run with everything else', async () => {
      const { service, spawned } = build()
      await service.attach(GLOBAL)
      await service.attach(SESSION)
      service.launch(PROJECT, launchSpec(1))
      service.close()
      expect(spawned).toHaveLength(3)
      expect(spawned.every((p) => p.killed)).toBe(true)
      expect(service.describe(PROJECT)).toBeNull()
    })
  })

  describe('epochs across a replacement', () => {
    it('an epoch from the old run cannot drive the new one', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      const old = await attached(service, PROJECT)
      spawned[0]?.finish(0)
      service.launch(PROJECT, launchSpec(2))
      const fresh = await attached(service, PROJECT)
      expect(fresh.epoch).toBeGreaterThan(old.epoch)

      service.write(PROJECT, old.epoch, 'ls\r')
      service.resize(PROJECT, old.epoch, 200, 50)
      service.clear(PROJECT, old.epoch)
      service.disposeIfCurrent(PROJECT, old.epoch)
      expect(spawned[1]?.written).toHaveLength(0)
      expect(spawned[1]?.sizes).toHaveLength(0)
      expect(spawned[1]?.killed).toBe(false)

      service.write(PROJECT, fresh.epoch, 'ls\r')
      expect(spawned[1]?.written).toEqual(['ls\r'])
    })

    it('never hands two shells the same epoch', async () => {
      const { service } = build()
      const first = await attached(service, GLOBAL)
      const second = await attached(service, SESSION)
      service.launch(PROJECT, launchSpec(1))
      const third = await attached(service, PROJECT)
      expect(new Set([first.epoch, second.epoch, third.epoch]).size).toBe(3)
    })
  })

  describe('a run that has been let go', () => {
    it('drops a frame that was queued for the view when it was killed', async () => {
      const { service, spawned, pushes, tick } = build()
      service.launch(PROJECT, launchSpec(1))
      await service.attach(PROJECT)
      spawned[0]?.emit('queued for the view')
      service.dispose(PROJECT)
      tick()
      expect(data(pushes)).toHaveLength(0)
    })

    it('says nothing to views or taps when it writes or exits after being killed', async () => {
      const { service, spawned, pushes, tick } = build()
      const seen: TerminalEvent[] = []
      service.tap((_ref, event) => seen.push(event))
      service.launch(PROJECT, launchSpec(1))
      await service.attach(PROJECT)
      service.dispose(PROJECT)
      pushes.length = 0

      spawned[0]?.emit('hangup received')
      spawned[0]?.finish(129)
      tick()
      await settled()

      expect(pushes).toHaveLength(0)
      expect(seen).toHaveLength(0)
    })

    it('cannot speak for the run that replaced it', async () => {
      const { service, spawned, pushes, tick } = build()
      const seen: TerminalEvent[] = []
      service.tap((_ref, event) => seen.push(event))
      service.launch(PROJECT, launchSpec(1))
      await service.attach(PROJECT)
      spawned[0]?.finish(0)
      service.launch(PROJECT, launchSpec(2))
      await service.attach(PROJECT)
      pushes.length = 0
      seen.length = 0

      spawned[0]?.emit('late from the old run')
      spawned[0]?.finish(3)
      tick()
      await settled()

      expect(pushes).toHaveLength(0)
      expect(seen).toHaveLength(0)
      expect(service.describe(PROJECT)).toMatchObject({ running: true, exitCode: null })
    })

    it('an attach overtaken by a replacement gets nothing', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      spawned[0]?.emit('last line of the old run')
      spawned[0]?.finish(0)
      const racing = service.attach(PROJECT)
      service.launch(PROJECT, launchSpec(2))
      expect(await racing).toBeNull()
      expect((await attached(service, PROJECT)).generation).toBe(2)
    })
  })

  describe('generations', () => {
    it('ride on the data and the exit a view receives', async () => {
      const { service, spawned, pushes, tick } = build()
      service.launch(PROJECT, launchSpec(5))
      const opened = await attached(service, PROJECT)
      spawned[0]?.emit('ready')
      tick()
      expect(data(pushes)[0]).toMatchObject({ epoch: opened.epoch, generation: 5, data: 'ready' })
      spawned[0]?.finish(0)
      expect(pushes.at(-1)).toMatchObject({ kind: 'exit', generation: 5, code: 0 })
    })

    it('ride on what the tap sees', () => {
      const { service, spawned } = build()
      const seen: [TerminalRef, TerminalEvent, number][] = []
      service.tap((ref, event, generation) => seen.push([ref, event, generation]))
      service.launch(PROJECT, launchSpec(5))
      spawned[0]?.emit('ready')
      spawned[0]?.finish(0)
      expect(seen).toEqual([
        [PROJECT, { kind: 'data', data: 'ready' }, 5],
        [PROJECT, { kind: 'exit', code: 0 }, 5],
      ])
    })

    it('are zero for a shell nobody launched', async () => {
      const { service } = build()
      expect((await attached(service, GLOBAL)).generation).toBe(0)
      expect((await attached(service, SESSION)).generation).toBe(0)
    })
  })

  describe('interrupting', () => {
    it('sends ⌃C only to the generation it names, and only while it is alive', () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(3))
      expect(service.interrupt(PROJECT, 2)).toBe(false)
      expect(service.interrupt(PROJECT_B, 3)).toBe(false)
      expect(spawned[0]?.written).toHaveLength(0)

      expect(service.interrupt(PROJECT, 3)).toBe(true)
      expect(spawned[0]?.written).toEqual(['\x03'])

      spawned[0]?.finish(130)
      expect(service.interrupt(PROJECT, 3)).toBe(false)
      expect(spawned[0]?.written).toHaveLength(1)
    })
  })

  describe('reading the text back', () => {
    it('reads the last lines, not the first', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      for (let i = 1; i <= 5; i += 1) spawned[0]?.emit(`line ${String(i)}\r\n`)
      await settled()
      expect(service.readText(PROJECT, 2, 10_000)).toBe('line 4\nline 5')
      expect(service.readText(PROJECT, 0, 10_000)).toBe('')
    })

    it('cuts to the byte budget from the end', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      for (let i = 1; i <= 5; i += 1) spawned[0]?.emit(`line ${String(i)}\r\n`)
      await settled()
      expect(service.readText(PROJECT, 100, 6)).toBe('line 5')
      expect(service.readText(PROJECT, 100, 0)).toBe('')
    })

    it('never starts in the middle of a character', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      spawned[0]?.emit('héllo\r\n')
      await settled()
      expect(service.readText(PROJECT, 10, 4)).toBe('llo')
    })

    it('gives a line the terminal wrapped back as one line', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      spawned[0]?.emit(`${'x'.repeat(200)}\r\nnext\r\n`)
      await settled()
      expect(service.readText(PROJECT, 10, 10_000)).toBe(`${'x'.repeat(200)}\nnext`)
    })

    it('keeps the spaces that fall on a wrap', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      const text = `${'x'.repeat(78)}    tail`
      spawned[0]?.emit(`${text}\r\n`)
      await settled()
      expect(service.readText(PROJECT, 10, 10_000)).toBe(text)
    })

    it('does not invent a space where a wide character moved to the next row', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      const text = `${'x'.repeat(79)}界tail`
      spawned[0]?.emit(`${text}\r\n`)
      await settled()
      expect(service.readText(PROJECT, 10, 10_000)).toBe(text)
    })

    it('keeps a printed space before a wide character on the next row', async () => {
      const { service, spawned } = build()
      service.launch(PROJECT, launchSpec(1))
      const text = `${'x'.repeat(79)} 界tail`
      spawned[0]?.emit(`${text}\r\n`)
      await settled()
      expect(service.readText(PROJECT, 10, 10_000)).toBe(text)
    })
  })
})

describe('project shells', () => {
  const SHELL_A: TerminalRef = { scope: 'shell', projectId: 'p1', id: 'main' }
  const SHELL_B: TerminalRef = { scope: 'shell', projectId: 'p1', id: 's2' }
  const OTHER: TerminalRef = { scope: 'shell', projectId: 'p2', id: 'main' }
  const BASE_ENV = { SHELL: '/bin/zsh' }

  it('opens each shell lazily as a login shell at its project, with its own env', async () => {
    const { service, spawned } = build({
      envFor: (ref) =>
        ref.scope === 'shell' ? { ...BASE_ENV, REDIRECT: `for-${ref.projectId}` } : BASE_ENV,
    })
    expect(spawned).toHaveLength(0)

    await service.attach(SHELL_A)
    await service.attach(OTHER)
    await service.attach(GLOBAL)

    expect(spawned.map((pty) => pty.options.cwd)).toEqual(['/shells/p1', '/shells/p2', '/home/me'])
    expect(spawned[0]?.options.file).toBe('/bin/zsh')
    expect(spawned[0]?.options.args).toEqual(['-l'])
    expect(spawned[0]?.options.env).toEqual({ ...BASE_ENV, REDIRECT: 'for-p1' })
    expect(spawned[1]?.options.env).toEqual({ ...BASE_ENV, REDIRECT: 'for-p2' })
    expect(spawned[2]?.options.env).toEqual(BASE_ENV)
  })

  it('spawns nothing where the project has nowhere to open', async () => {
    const { service, spawned } = build({
      cwdFor: (ref) => (ref.scope === 'shell' ? null : '/home/me'),
    })
    expect(await service.attach(SHELL_A, { cols: 100, rows: 30 })).toBeNull()
    expect(spawned).toHaveLength(0)
    expect(service.describe(SHELL_A)).toBeNull()
    expect(await attached(service, GLOBAL)).not.toBeNull()
  })

  it('keeps several shells per project, and each project’s, apart', async () => {
    const { service, spawned, pushes, tick } = build()
    const a = await attached(service, SHELL_A)
    const b = await attached(service, SHELL_B)
    const other = await attached(service, OTHER)
    expect(spawned).toHaveLength(3)

    service.write(SHELL_B, b.epoch, 'npm run android\r')
    service.write(SHELL_A, b.epoch, 'wrong epoch\r')
    service.write(OTHER, a.epoch, 'wrong epoch\r')
    expect(spawned[0]?.written).toEqual([])
    expect(spawned[1]?.written).toEqual(['npm run android\r'])
    expect(spawned[2]?.written).toEqual([])

    spawned[2]?.emit('only in p2')
    tick()
    expect(data(pushes).map((push) => push.ref)).toEqual([OTHER])
    expect(data(pushes)[0]?.epoch).toBe(other.epoch)

    service.dispose(SHELL_A)
    expect(spawned[0]?.killed).toBe(true)
    expect(service.describe(SHELL_B)?.running).toBe(true)
    expect(service.describe(OTHER)?.running).toBe(true)
  })

  it('never reaches, reads or replaces the managed run of the same project', async () => {
    const { service, spawned, pushes } = build()
    await attached(service, SHELL_A)
    service.launch(PROJECT, launchSpec(1))
    expect(spawned).toHaveLength(2)

    spawned[0]?.emit('typed in the shell\r\n')
    await settled()
    expect(service.readText(PROJECT, 10, 1_000)).toBe('')
    expect(service.interrupt(PROJECT, 1)).toBe(true)
    expect(spawned[0]?.written).toEqual([])

    service.dispose(SHELL_A)
    expect(service.describe(PROJECT)?.running).toBe(true)
    expect(spawned[1]?.killed).toBe(false)

    await attached(service, SHELL_B)
    spawned[1]?.finish(0)
    service.launch(PROJECT, launchSpec(2))
    expect(spawned[2]?.killed).toBe(false)
    expect(service.describe(SHELL_B)?.running).toBe(true)
    expect(pushes.filter((push) => push.kind === 'replaced').map((push) => push.ref)).toEqual([
      PROJECT,
      PROJECT,
    ])
  })

  it('refuses a project’s shells once disposed, even a project that never had one', async () => {
    const { service, spawned } = build()
    service.disposeShells('p2')
    expect(await service.attach(OTHER)).toBeNull()
    expect(spawned).toHaveLength(0)

    await attached(service, SHELL_A)
    service.disposeShells('p1')
    expect(spawned[0]?.killed).toBe(true)
    expect(await service.attach(SHELL_A)).toBeNull()
    expect(await service.attach(SHELL_B)).toBeNull()
    expect(spawned).toHaveLength(1)

    expect(await attached(service, GLOBAL)).not.toBeNull()
    service.launch(PROJECT, launchSpec(1))
    expect(service.describe(PROJECT)?.running).toBe(true)
  })

  it('refuses new shells at once, leaving running ones for the later kill', async () => {
    const { service, spawned } = build()
    await attached(service, SHELL_A)
    service.refuseShells('p1')

    expect(await service.attach(SHELL_B)).toBeNull()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.killed).toBe(false)
    expect((await attached(service, SHELL_A)).exitCode).toBeNull()
    await attached(service, OTHER)
    expect(spawned).toHaveLength(2)

    service.disposeShells('p1')
    expect(spawned[0]?.killed).toBe(true)
    expect(spawned[1]?.killed).toBe(false)
  })

  it('releases an attach still waiting on the mirror when the shells are disposed', async () => {
    const { service, spawned } = build()
    await attached(service, SHELL_A)
    spawned[0]?.emit('building')
    const late = service.attach(SHELL_A)
    service.disposeShells('p1')
    expect(await late).toBeNull()
    expect(spawned).toHaveLength(1)
  })

  it('kills every shell on quit and opens none afterwards', async () => {
    const { service, spawned } = build()
    await attached(service, SHELL_A)
    await attached(service, OTHER)
    service.close()
    expect(spawned.map((pty) => pty.killed)).toEqual([true, true])
    expect(await service.attach(SHELL_B)).toBeNull()
    expect(spawned).toHaveLength(2)
  })

  it('keeps a shell whose kill failed reachable, and forgets it once a kill succeeds', async () => {
    const { service, spawned } = build()
    await attached(service, SHELL_A)
    const pty = spawned[0]
    if (pty === undefined) throw new Error('no shell was spawned')
    pty.kill = () => {
      throw new Error('kill failed')
    }

    expect(() => {
      service.dispose(SHELL_A)
    }).toThrow('kill failed')
    expect(service.describe(SHELL_A)?.running).toBe(true)
    expect((await attached(service, SHELL_A)).exitCode).toBeNull()
    expect(spawned).toHaveLength(1)

    pty.kill = () => {
      pty.killed = true
    }
    service.dispose(SHELL_A)
    expect(pty.killed).toBe(true)
    expect(service.describe(SHELL_A)).toBeNull()
  })

  it('stops the other shells when one kill fails, and still refuses new ones', async () => {
    const { service, spawned } = build()
    await attached(service, SHELL_A)
    await attached(service, SHELL_B)
    const failing = spawned[0]
    if (failing === undefined) throw new Error('no shell was spawned')
    failing.kill = () => {
      throw new Error('kill failed')
    }

    expect(() => {
      service.disposeShells('p1')
    }).toThrow('kill failed')
    expect(spawned[1]?.killed).toBe(true)
    expect(service.describe(SHELL_B)).toBeNull()
    expect(service.describe(SHELL_A)?.running).toBe(true)
    expect(await service.attach({ scope: 'shell', projectId: 'p1', id: 'new' })).toBeNull()
    expect(spawned).toHaveLength(2)
  })

  it('ignores a stale epoch per shell, and a dispose carrying one', async () => {
    const { service, spawned } = build()
    const first = await attached(service, SHELL_A)
    const second = await attached(service, SHELL_A)
    expect(second.epoch).toBeGreaterThan(first.epoch)

    service.write(SHELL_A, first.epoch, 'stale\r')
    service.disposeIfCurrent(SHELL_A, first.epoch)
    expect(spawned[0]?.written).toEqual([])
    expect(spawned[0]?.killed).toBe(false)

    service.disposeIfCurrent(SHELL_A, second.epoch)
    expect(spawned[0]?.killed).toBe(true)
  })
})

describe('describeForeground', () => {
  it('reports a foreground process as busy on unix', () => {
    expect(describeForeground('ssh', 'zsh', 'darwin')).toEqual({ foreground: 'ssh', busy: true })
  })

  it('reports the shell itself as idle on unix', () => {
    expect(describeForeground('zsh', 'zsh', 'darwin')).toEqual({ foreground: 'zsh', busy: false })
  })

  it('names a dead shell rather than showing an empty string', () => {
    expect(describeForeground('', 'zsh', 'darwin')).toEqual({ foreground: 'zsh', busy: false })
  })

  /*
   * The bug this phase found. node-pty's WindowsTerminal returns the *terminal
   * type* from `.process` — assigned once at construction and never updated —
   * so the old comparison made every Windows terminal permanently busy and put
   * `xterm-256color` in the kill dialog as the name of the running process.
   */
  it('never reports busy on windows, where node-pty cannot answer the question', () => {
    expect(describeForeground('xterm-256color', 'cmd.exe', 'win32')).toEqual({
      foreground: 'cmd.exe',
      busy: false,
    })
  })

  it('does not leak the terminfo name into the kill dialog on windows', () => {
    expect(describeForeground('xterm-256color', 'powershell.exe', 'win32').foreground).toBe(
      'powershell.exe'
    )
  })
})

describe('confirmed terminal cleanup', () => {
  it('retains terminal ownership until process exit is confirmed', async () => {
    let release: () => void = () => undefined
    const exit = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, spawned } = build({
      ownProcess: () => ({
        capture: () => Promise.resolve(),
        stop: async (graceful) => {
          await graceful?.()
          await exit
        },
      }),
    })
    await service.attach(SESSION)
    const closing = service.stopSession('c1')
    expect(spawned[0]?.killed).toBe(true)
    expect(service.describe(SESSION)?.running).toBe(true)
    release()
    await closing
    expect(service.describe(SESSION)).toBeNull()
  })

  it('retries failed cleanup and leaves another chat and global terminal alone', async () => {
    let refuse = true
    const { service, spawned } = build({
      ownProcess: () => ({
        capture: () => Promise.resolve(),
        stop: async (graceful) => {
          await graceful?.()
          if (refuse) throw new Error('process still exists')
        },
      }),
    })
    await service.attach(SESSION)
    await service.attach(GLOBAL)
    await expect(service.stopSession('c1')).rejects.toThrow(/terminal processes/)
    expect(service.describe(SESSION)).not.toBeNull()
    expect(spawned[1]?.killed).toBe(false)
    refuse = false
    await service.stopSession('c1')
    expect(service.describe(SESSION)).toBeNull()
    expect(service.describe(GLOBAL)?.running).toBe(true)
  })
})

it('confirms descendants of an exited terminal after its replacement was launched', async () => {
  const stopped: number[] = []
  let serial = 0
  const { service, spawned } = build({
    ownProcess: () => {
      const owner = serial++
      return {
        capture: () => Promise.resolve(),
        stop: async (graceful) => {
          await graceful?.()
          stopped.push(owner)
        },
      }
    },
  })
  service.launch(PROJECT, launchSpec(1))
  spawned[0]?.finish(0)
  service.launch(PROJECT, launchSpec(2))
  await service.stopProject('p1')
  expect(stopped.sort()).toEqual([0, 1])
})
