/**
 * Phase 0 spike. Throwaway — delete when the real terminal service lands.
 *
 * Answers one question the plan cannot answer by reading: does a PTY actually
 * open, in this process, with whichever `node-pty` binary this environment
 * resolves. Run under plain node for the dev path and under Electron for the
 * packaged path; the binary that loads differs between them, which is the whole
 * point of the exercise.
 *
 * Usage: node build/pty-smoke.cjs [path-to-node-pty]
 *
 * The optional argument is how the packaged app is tested: point it at the copy
 * inside `app.asar.unpacked` and run it with the bundle's own Electron binary,
 * so the binary, the helper and the ABI under test are the shipped ones.
 */

const os = require('os')

function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
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

  // Which binary did it pick? `lib/utils.js` prefers build/Release over
  // prebuilds, so this is how we learn whether we are on the compiled path.
  const fs = require('fs')
  const path = require('path')
  const root = target
    ? path.dirname(require.resolve(`${target}/package.json`))
    : path.dirname(require.resolve('node-pty/package.json'))
  const compiled = path.join(root, 'build', 'Release', 'spawn-helper')
  const prebuilt = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  /*
   * The same asar rewrite node-pty does to itself (`lib/unixTerminal.js`).
   *
   * Without it this reads the mode recorded *in* the asar rather than the real
   * file beside it, and reports 644 for a helper that is actually 755 — which is
   * exactly the false negative that sent the first packaged run chasing a
   * signing problem that did not exist.
   */
  const unpacked = (p) => p.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
  const helper = unpacked(fs.existsSync(unpacked(compiled)) ? compiled : prebuilt)
  const mode = fs.existsSync(helper) ? (fs.statSync(helper).mode & 0o777).toString(8) : 'missing'
  const executable = fs.existsSync(helper) && (fs.statSync(helper).mode & 0o111) !== 0

  console.log(`helper: ${helper}`)
  console.log(`mode:   ${mode}`)
  report('spawn-helper is executable', executable, `mode ${mode}`)

  const shell = process.env.SHELL || '/bin/zsh'
  const out = []

  const result = await new Promise((resolve) => {
    let child
    const timer = setTimeout(() => resolve({ ok: false, why: 'timed out after 10s' }), 10_000)
    try {
      child = pty.spawn(shell, ['-lc', 'echo hi'], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: os.homedir(),
        env: process.env,
      })
    } catch (error) {
      clearTimeout(timer)
      resolve({ ok: false, why: error.message })
      return
    }
    child.onData((d) => out.push(d))
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)
      resolve({ ok: true, exitCode })
    })
  })

  if (!result.ok) {
    report('pty.spawn + echo hi', false, result.why)
    process.exit(1)
  }

  const text = out.join('')
  const saw = text.includes('hi')
  report('pty.spawn + echo hi', saw, `exit ${result.exitCode}, got ${JSON.stringify(text.slice(0, 60))}`)
  process.exit(saw && executable ? 0 : 1)
}

void main()
