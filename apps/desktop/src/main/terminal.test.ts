import { describe, expect, it } from 'vitest'
import {
  TerminalService,
  describeForeground,
  type Frame,
  type Pty,
  type PtyOptions,
  type TerminalPush,
  type TerminalRef,
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

function build(): Harness {
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
    cwdFor: (ref) => (ref.scope === 'global' ? '/home/me' : `/work/${ref.conversationId}`),
    env: { SHELL: '/bin/zsh' },
    frame,
    spawn: (options) => {
      const pty = new FakePty(options)
      spawned.push(pty)
      return pty
    },
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
    const first = await service.attach(GLOBAL)
    service.detach(GLOBAL, first.epoch)
    await service.attach(GLOBAL)
    expect(spawned).toHaveLength(1)
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
    const first = await service.attach(SESSION)
    const second = await service.attach(SESSION_B)
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
    const second = await service.attach(SESSION_B)
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
    const opened = await service.attach(SESSION)
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
    const first = await service.attach(SESSION)
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
    const first = await service.attach(SESSION)
    service.detach(SESSION, first.epoch)
    spawned[0]?.finish(3)
    const second = await service.attach(SESSION)
    expect(second.exitCode).toBe(3)
  })

  it('says nothing about a shell that is still running', async () => {
    const { service } = build()
    const opened = await service.attach(SESSION)
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
    const first = await service.attach(SESSION)
    service.detach(SESSION, first.epoch)
    spawned[0]?.finish(0)
    expect((await service.attach(SESSION)).exitCode).toBe(0)
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
    const { epoch } = await service.attach(GLOBAL)
    service.detach(GLOBAL, epoch)
    expect(spawned[0]?.killed).toBe(false)
    expect(service.describe(GLOBAL)?.running).toBe(true)
  })

  it('output still reaches the mirror while detached, so the snapshot is current', async () => {
    const { service, spawned } = build()
    const first = await service.attach(GLOBAL)
    service.detach(GLOBAL, first.epoch)
    spawned[0]?.emit('while you were away')
    await settled()
    const again = await service.attach(GLOBAL)
    expect(again.snapshot).toContain('while you were away')
  })

  it('stops pushing to a detached view', async () => {
    const { service, spawned, pushes, tick } = build()
    const { epoch } = await service.attach(GLOBAL)
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
    const stale = await service.attach(GLOBAL)
    await service.attach(GLOBAL)
    service.detach(GLOBAL, stale.epoch)
    spawned[0]?.emit('still here')
    tick()
    expect(data(pushes)).toHaveLength(1)
  })

  it('ignores a write stamped with a superseded epoch', async () => {
    const { service, spawned } = build()
    const stale = await service.attach(GLOBAL)
    await service.attach(GLOBAL)
    service.write(GLOBAL, stale.epoch, 'ls\r')
    expect(spawned[0]?.written).toHaveLength(0)
  })

  it('accepts a write from the current epoch', async () => {
    const { service, spawned } = build()
    const now = await service.attach(GLOBAL)
    service.write(GLOBAL, now.epoch, 'ls\r')
    expect(spawned[0]?.written).toEqual(['ls\r'])
  })

  it('ignores a resize stamped with a superseded epoch', async () => {
    const { service, spawned } = build()
    const stale = await service.attach(GLOBAL, { cols: 80, rows: 24 })
    await service.attach(GLOBAL)
    service.resize(GLOBAL, stale.epoch, 200, 50)
    expect(spawned[0]?.sizes).toHaveLength(0)
  })

  it('ignores an ack stamped with a superseded epoch', async () => {
    const { service, spawned, tick } = build()
    const stale = await service.attach(GLOBAL)
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
    const { epoch } = await service.attach(GLOBAL, { cols: 80, rows: 24 })
    service.resize(GLOBAL, epoch, 100, 30)
    expect(spawned[0]?.sizes).toEqual([[100, 30]])
  })

  it('does not churn the shell when the size has not changed', async () => {
    const { service, spawned } = build()
    const { epoch } = await service.attach(GLOBAL, { cols: 80, rows: 24 })
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
    const again = await service.attach(GLOBAL)
    expect(again.snapshot).toContain('31m')
  })

  it('restores the alternate screen, which a byte suffix would lose', async () => {
    const { service, spawned } = build()
    await service.attach(GLOBAL)
    spawned[0]?.emit('[?1049h')
    spawned[0]?.emit('inside vim')
    await settled()
    const { snapshot } = await service.attach(GLOBAL)
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
    const again = await service.attach(GLOBAL)
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
    const { epoch } = await service.attach(GLOBAL)
    service.detach(GLOBAL, epoch)
    for (let i = 0; i < 100; i += 1) spawned[0]?.emit(`line ${String(i)}\r\n`)
    expect(spawned[0]?.paused).toBe(true)
  })

  it('resumes once the mirror has caught up', async () => {
    const { service, spawned } = build()
    const { epoch } = await service.attach(GLOBAL)
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
    const { epoch } = await service.attach(GLOBAL)
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
    const { epoch } = await service.attach(GLOBAL)
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
    const { epoch } = await service.attach(GLOBAL)
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
    const { epoch } = await service.attach(GLOBAL)
    spawned[0]?.emit('a line nobody wants to see again\r\n')
    await settled()
    expect((await service.attach(GLOBAL)).snapshot).toContain('nobody wants')

    const current = await service.attach(GLOBAL)
    service.clear(GLOBAL, current.epoch)
    await settled()
    expect((await service.attach(GLOBAL)).snapshot).not.toContain('nobody wants')
    expect(epoch).toBeLessThan(current.epoch)
  })

  /*
   * A display action, not an input one. Nothing is written to the shell, so a
   * half-typed command survives it — anything else would be a different feature
   * wearing this shortcut.
   */
  it('says nothing to the shell', async () => {
    const { service, spawned } = build()
    const { epoch } = await service.attach(GLOBAL)
    service.clear(GLOBAL, epoch)
    expect(spawned[0]?.written).toHaveLength(0)
  })

  it('does not kill anything', async () => {
    const { service, spawned } = build()
    const { epoch } = await service.attach(GLOBAL)
    service.clear(GLOBAL, epoch)
    expect(spawned[0]?.killed).toBe(false)
    expect(service.describe(GLOBAL)?.running).toBe(true)
  })

  it('ignores a clear stamped with a superseded epoch', async () => {
    const { service, spawned } = build()
    const stale = await service.attach(GLOBAL)
    await service.attach(GLOBAL)
    spawned[0]?.emit('still wanted')
    await settled()
    service.clear(GLOBAL, stale.epoch)
    await settled()
    expect((await service.attach(GLOBAL)).snapshot).toContain('still wanted')
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
