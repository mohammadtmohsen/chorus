import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Driving the real app.
 *
 * These tests exist because the bugs that mattered were not the kind unit tests
 * find: a blank window, sessions multiplying across restarts, a drag axis taken
 * from the wrong box, a rail 15px from its own dots. Every one needed the actual
 * Electron app, actual agents, and an actual quit and relaunch.
 *
 * They talk to it over the Chrome DevTools protocol rather than through a test
 * framework, so what runs is exactly the app you ship — no test build, no mocked
 * main process, no injected renderer.
 *
 * Each spec gets its own `userData`, so a run cannot inherit yesterday's open
 * sessions or leave anything behind in yours.
 */

const APP = new URL('..', import.meta.url).pathname

/** Chosen per spec so specs can run without fighting over a port. */
let nextPort = 9800

/**
 * @param options.executable A built `.app` binary to drive instead of `out/`.
 *   What the specs assert is the same either way; what differs is whether the
 *   code came from `electron-vite` or from the bundle a user actually installs.
 */
export async function launch({ userData, keepData = false, executable } = {}) {
  const port = nextPort++
  const dataPath = userData ?? mkdtemp()
  const env = { ...process.env, CHORUS_USER_DATA: dataPath }
  // The VS Code extension host sets this, and it makes Electron boot as Node.
  delete env.ELECTRON_RUN_AS_NODE

  const [command, args] =
    executable === undefined
      ? ['npx', ['electron', '.', `--remote-debugging-port=${String(port)}`]]
      : [executable, [`--remote-debugging-port=${String(port)}`]]

  const child = spawn(command, args, {
    cwd: APP,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  let output = ''
  child.stdout.on('data', (d) => (output += d.toString()))
  child.stderr.on('data', (d) => (output += d.toString()))

  /*
   * A launch failure has to carry what the app said about it.
   *
   * `connect` can only report that no window ever appeared, which is the symptom
   * of everything from a missing native module to a syntax error in main. The
   * cause was already being captured here and thrown away — with a broken
   * bundle, "the app never opened a window" was the entire diagnosis.
   */
  let socket
  try {
    socket = await connect(port)
  } catch (error) {
    child.kill('SIGKILL')
    /*
     * Both ends, because the useful line is at whichever one you did not keep.
     * A native module that will not load prints its message first and twenty
     * stack frames after it, so a tail showed only frames; a late crash is the
     * other way round.
     */
    const lines = output.trim().split('\n')
    const said =
      lines.length <= 14
        ? lines.join('\n')
        : [
            ...lines.slice(0, 8),
            `  … ${String(lines.length - 14)} more lines …`,
            ...lines.slice(-6),
          ].join('\n')
    throw new Error(
      `${error.message}${said === '' ? ' (and said nothing)' : `\n\nthe app said:\n${said}`}`,
      { cause: error }
    )
  }
  const session = makeSession(socket)

  return {
    dataPath,
    ...session,
    output: () => output,
    async quit() {
      socket.close()
      child.kill('SIGTERM')
      await wait(2_500)
      if (!keepData) rmSync(dataPath, { recursive: true, force: true })
    },
    /** Quit without clearing the data, so the next launch can restore from it. */
    async stop() {
      socket.close()
      child.kill('SIGTERM')
      await wait(2_500)
    },
  }
}

function mkdtemp() {
  const path = join(
    tmpdir(),
    `chorus-e2e-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`
  )
  mkdirSync(path, { recursive: true })
  return path
}

async function connect(port) {
  for (let i = 0; i < 200; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
      const page = (await response.json()).find((t) => t.type === 'page')
      if (page !== undefined) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
        return socket
      }
    } catch {
      // Not up yet.
    }
    await wait(300)
  }
  throw new Error('the app never opened a window')
}

function makeSession(socket) {
  let id = 0

  /**
   * One command down the debugger protocol, whatever it is.
   *
   * Running code in the page is only the commonest thing to ask for, not the
   * only one — anything the app cannot do to itself has to come through here.
   * The label is carried separately so a timeout still names the expression
   * that hung rather than the channel it hung on.
   */
  const send = (method, params = {}, label = method) =>
    new Promise((resolve, reject) => {
      const mine = ++id
      const onMessage = (message) => {
        const reply = JSON.parse(message.data)
        if (reply.id !== mine) return
        socket.removeEventListener('message', onMessage)
        if (reply.error !== undefined) {
          reject(new Error(`${method}: ${JSON.stringify(reply.error).slice(0, 300)}`))
          return
        }
        resolve(reply.result)
      }
      socket.addEventListener('message', onMessage)
      socket.send(JSON.stringify({ id: mine, method, params }))
      setTimeout(() => {
        reject(new Error(`timed out: ${label}`))
      }, 120_000)
    })

  const evaluate = async (expression) => {
    const result = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      expression.slice(0, 60)
    )
    if (result.exceptionDetails !== undefined) {
      throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300))
    }
    return result.result?.value
  }

  return {
    evaluate,
    send,
    /**
     * Pretends the window is another size, and puts it back with no arguments.
     *
     * The layout sheds a column and moves its rail below certain widths, and
     * those rules answer to the viewport rather than to anything the app can be
     * told. Chromium's own emulation changes the CSS viewport for real, so the
     * media queries fire exactly as they would on a smaller screen — which is
     * the difference between asserting the narrow layout and eyeballing it.
     */
    async viewport(width, height) {
      if (width === undefined) {
        await send('Emulation.clearDeviceMetricsOverride')
        return
      }
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
    },
    /**
     * Waits for something to become true in the page.
     *
     * Every check here is written this way rather than with a fixed sleep: a
     * sleep long enough to be reliable makes the suite slow, and a short one
     * makes it lie.
     */
    async until(expression, { timeout = 90_000, label = expression } = {}) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if ((await evaluate(expression)) === true) return
        await wait(200)
      }
      throw new Error(`never became true: ${label}`)
    },
    /**
     * A frame plus a moment, so React has rendered before anything is measured.
     *
     * With a deadline, because `requestAnimationFrame` does not fire in a window
     * the compositor considers occluded — and a suite that launches this many
     * Electron windows cannot promise any of them is frontmost. Waiting on a
     * frame that will never come turned into a two-minute timeout and a failure
     * in whichever spec happened to be running behind another window.
     */
    settle: () =>
      evaluate(`new Promise((resolve) => {
        const done = () => { resolve(true) }
        /*
         * Generous, because this path only runs when no frame is coming: the
         * window is occluded and nothing is painting, so there is no cheap
         * signal that layout has caught up. Resolving too early measures a
         * scroll that has not finished — which showed up as a pinned header
         * reported 9px from where it settles.
         */
        const deadline = setTimeout(done, 700)
        requestAnimationFrame(() => {
          clearTimeout(deadline)
          setTimeout(done, 40)
        })
      })`),
  }
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The build these tests are about to drive, actually being the current one.
 *
 * This used to assert only that `out/` existed, which is a different and much
 * weaker claim. `pnpm e2e` composes the build in ahead of the run so the suite
 * was never wrong — but anything calling this directly got a silent pass on a
 * stale bundle, and once did: a verification script reported two fixes still
 * broken while driving a build compiled before either existed, which nearly
 * sent someone debugging working code. A test that quietly exercises
 * yesterday's source is worse than no test, because it is believed.
 *
 * So the check is now about freshness, and it repairs rather than complains.
 * Rebuilding costs a few seconds and only happens when something actually
 * changed; being told to go and run a command is the same wait plus a
 * round trip.
 */
/**
 * The three things `electron-vite build` emits, checked separately.
 *
 * Together rather than as one `out/` tree, because they can fall out of step: a
 * build that wrote main and preload and did not write renderer left the newest
 * mtime under `out/` looking current while the bundle the window actually loads
 * was two hours old. The suite then drove that old renderer and passed, which is
 * the worst possible outcome — a spec reporting on code that is not under review.
 *
 * The self-perpetuating part is what makes it dangerous rather than merely
 * wrong: those fresh `out/main` mtimes made the *next* run skip building too, so
 * the staleness survived until someone built by hand. Ticket C-014.
 */
const ENVIRONMENTS = ['main', 'preload', 'renderer']

export function ensureBuilt() {
  /*
   * The oldest environment decides, not the newest file anywhere under `out/`.
   * One stale output is a stale app however fresh the other two are.
   */
  const stamps = ENVIRONMENTS.map((name) => newest([join(APP, 'out', name)]))
  const built = stamps.includes(undefined) ? undefined : Math.min(...stamps)
  const source = newest([join(APP, 'src'), join(APP, '../../packages')], BUILT)

  if (built !== undefined && source !== undefined && built >= source) return

  execFileSync('pnpm', ['--filter', '@chorus/desktop', 'run', 'build'], {
    cwd: APP,
    stdio: 'inherit',
  })

  /*
   * Trust the build no further than its own output. `execFileSync` throwing is
   * not the only way to end up with a stale bundle, and this check is cheap
   * next to twenty-six Electron launches against the wrong code.
   */
  const after = ENVIRONMENTS.map((name) => newest([join(APP, 'out', name)]))
  const rebuilt = after.includes(undefined) ? undefined : Math.min(...after)
  if (rebuilt === undefined || (source !== undefined && rebuilt < source)) {
    const stale = ENVIRONMENTS.filter(
      (name, i) => after[i] === undefined || (source !== undefined && after[i] < source)
    )
    throw new Error(
      `the build left ${stale.join(' and ')} older than src — refusing to test a stale app (C-014)`
    )
  }
}

/**
 * Directories under a source root that hold output rather than source.
 *
 * A package's own `dist` is newer than the desktop bundle every time something
 * is compiled, so counting it would call the build stale on every run.
 */
const BUILT = new Set(['node_modules', 'dist', 'out', '.turbo'])

/** The most recent mtime under any of `roots`, or undefined if none exist. */
function newest(roots, skip = new Set()) {
  let latest
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) continue
      // Relative to the root, so a skip name cannot match part of the path
      // leading *to* the root — `out` is a source of truth when it is the root.
      const inside = entry.parentPath.slice(root.length).split('/')
      if (inside.some((part) => skip.has(part))) continue
      const { mtimeMs } = statSync(join(entry.parentPath, entry.name))
      if (latest === undefined || mtimeMs > latest) latest = mtimeMs
    }
  }
  return latest
}
