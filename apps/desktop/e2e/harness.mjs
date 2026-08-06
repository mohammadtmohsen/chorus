import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
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

export async function launch({ userData, keepData = false } = {}) {
  const port = nextPort++
  const dataPath = userData ?? mkdtemp()
  const env = { ...process.env, CHORUS_USER_DATA: dataPath }
  // The VS Code extension host sets this, and it makes Electron boot as Node.
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn('npx', ['electron', '.', `--remote-debugging-port=${String(port)}`], {
    cwd: APP,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  let output = ''
  child.stdout.on('data', (d) => (output += d.toString()))
  child.stderr.on('data', (d) => (output += d.toString()))

  const socket = await connect(port)
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
    /** A frame plus a moment, so React has rendered before anything is measured. */
    settle: () =>
      evaluate('new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40, true))))'),
  }
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function ensureBuilt() {
  if (!existsSync(join(APP, 'out/main/index.js'))) {
    throw new Error('build first: pnpm --filter @chorus/desktop run build')
  }
}
