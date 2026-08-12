/**
 * Phase 0/1 spike. Throwaway — delete when the terminal panel lands.
 *
 * Answers the questions the unit tests cannot, because they are properties of a
 * real tty rather than of our code: does a PTY open with whichever `node-pty`
 * binary this environment resolves, does `⌃C` reach a foreground process as a
 * signal, and does a full-screen program draw and leave cleanly.
 *
 * Run under plain node for the dev path and under a packaged app's Electron for
 * the shipped one; the binary that loads differs between them, which is the
 * whole point of the exercise.
 *
 * Usage: node build/pty-smoke.cjs [path-to-node-pty]
 *
 * The optional argument is how the packaged app is tested: point it at the copy
 * **inside app.asar** — not app.asar.unpacked — and run it with the bundle's own
 * Electron binary. node-pty rewrites its own helper path from `app.asar` to
 * `app.asar.unpacked`, so handing it an already-unpacked path produces
 * `app.asar.unpacked.unpacked` and a spawn failure that looks like a signing
 * problem and is not.
 */

const os = require('os')
const fs = require('fs')
const path = require('path')

const results = []
function report(name, ok, detail) {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Wait until accumulated output satisfies a predicate, or give up loudly. */
function until(state, predicate, ms, why) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = setInterval(() => {
      if (predicate(state.text)) {
        clearInterval(tick)
        resolve({ ok: true })
      } else if (Date.now() - started > ms) {
        clearInterval(tick)
        resolve({ ok: false, why: `${why} — saw ${JSON.stringify(state.text.slice(-120))}` })
      }
    }, 25)
  })
}

function open(pty, shell, args) {
  const state = { text: '', exited: null }
  const child = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: process.env,
  })
  child.onData((d) => {
    state.text += d
  })
  child.onExit(({ exitCode }) => {
    state.exited = exitCode
  })
  return { child, state }
}

async function main() {
  const target = process.argv[2]
  let pty
  try {
    pty = target ? require(target) : require('node-pty')
  } catch (error) {
    report('require("node-pty")', false, error.message)
    process.exit(1)
  }

  const root = target
    ? path.dirname(require.resolve(`${target}/package.json`))
    : path.dirname(require.resolve('node-pty/package.json'))
  const compiled = path.join(root, 'build', 'Release', 'spawn-helper')
  const prebuilt = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  const unpacked = (p) => p.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
  const helper = unpacked(fs.existsSync(unpacked(compiled)) ? compiled : prebuilt)
  const mode = fs.existsSync(helper) ? (fs.statSync(helper).mode & 0o777).toString(8) : 'missing'

  console.log(`helper: ${helper}`)
  report(
    'spawn-helper is executable',
    fs.existsSync(helper) && (fs.statSync(helper).mode & 0o111) !== 0,
    `mode ${mode}`
  )

  const shell = process.env.SHELL || '/bin/zsh'

  // 1. A shell runs a command and the output comes back over a real tty.
  {
    const { child, state } = open(pty, shell, ['-lc', 'echo hi'])
    const got = await until(state, (t) => t.includes('hi'), 10_000, 'no output')
    // \r\n rather than \n is the tell: a pipe would not add the carriage return.
    report('a command runs, on a real tty', got.ok && state.text.includes('\r\n'), got.why ?? 'saw "hi\\r\\n"')
    child.kill()
  }

  // 2. ⌃C reaches the foreground process as a signal, not as a closed pipe.
  {
    const { child, state } = open(pty, shell, ['-l'])
    await until(state, (t) => t.length > 0, 10_000, 'no prompt')
    child.write('sleep 100\r')
    await new Promise((r) => setTimeout(r, 800))
    const before = child.process
    child.write('\x03')
    const back = await until(
      { get text() { return String(child.process) } },
      (p) => p !== 'sleep',
      8_000,
      'still in sleep after ⌃C'
    )
    report('⌃C interrupts a foreground process', back.ok, `was ${before}, now ${child.process}`)
    child.kill()
  }

  // 3. A full-screen program drives the alternate screen and leaves it.
  {
    const { child, state } = open(pty, shell, ['-l'])
    await until(state, (t) => t.length > 0, 10_000, 'no prompt')
    child.write('vi\r')
    const entered = await until(state, (t) => t.includes('[?1049h'), 10_000, 'vi never took the screen')
    child.write('\x1b:q!\r')
    const left = await until(state, (t) => t.includes('[?1049l'), 10_000, 'vi never gave it back')
    report('a full-screen program draws and exits cleanly', entered.ok && left.ok, entered.why ?? left.why ?? 'alt-screen entered and left')
    child.kill()
  }

  const failed = results.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nall ${results.length} passed` : `\n${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
