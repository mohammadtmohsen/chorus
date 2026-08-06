import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Smoke-test the packaged `.app`, not `electron .`.
 *
 * The e2e suite drives the built output through `npx electron`, which shares
 * almost everything with the shipped app but not the parts that only exist once
 * electron-builder has run: the asar, the unpacked native module, the bundled
 * VSIX in `Contents/Resources`, and the ad-hoc signature over all of it. This is
 * what a double-click actually gets.
 */

const APP = 'apps/desktop/release/mac-arm64/Chorus.app/Contents/MacOS/Chorus'
const PORT = 9333
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const dataPath = mkdtempSync(join(tmpdir(), 'chorus-smoke-'))
const child = spawn(APP, [`--remote-debugging-port=${PORT}`], {
  env: { ...process.env, CHORUS_USER_DATA: dataPath },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', (d) => (output += d))
child.stderr.on('data', (d) => (output += d))

let failures = 0
const check = (ok, note) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${note}`)
}

let targets = []
for (let i = 0; i < 60; i += 1) {
  await wait(500)
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    targets = (await res.json()).filter((t) => t.type === 'page')
    if (targets.length > 0) break
  } catch {
    // Not listening yet.
  }
}
if (targets.length === 0) {
  console.log('FAIL  the packaged app never exposed a page')
  child.kill('SIGTERM')
  process.exit(1)
}

const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
await new Promise((resolve) => ws.addEventListener('open', resolve))
let id = 0
const evaluate = (expression) =>
  new Promise((resolve, reject) => {
    const mine = (id += 1)
    const onMessage = (m) => {
      const reply = JSON.parse(m.data)
      if (reply.id !== mine) return
      ws.removeEventListener('message', onMessage)
      if (reply.result?.exceptionDetails !== undefined) {
        reject(new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 200)))
      } else resolve(reply.result?.result?.value)
    }
    ws.addEventListener('message', onMessage)
    ws.send(
      JSON.stringify({
        id: mine,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      })
    )
    setTimeout(() => reject(new Error('timed out')), 60_000)
  })

for (let i = 0; i < 60; i += 1) {
  if (await evaluate(`document.querySelectorAll('.pane').length > 0`)) break
  await wait(500)
}

check(
  await evaluate(`document.querySelectorAll('.pane').length === 1`),
  'opens straight into a session'
)

const info = await evaluate(`window.chorus.getAppInfo()`)
check(info.appVersion === '0.5.0', `reports version ${info.appVersion}`)

const answered = await evaluate(
  `window.chorus.history({ conversationId: document.querySelector('.pane').dataset.conversation }).then(() => true)`
)
check(answered === true, 'native sqlite loaded — the event log answers')

const probes = await evaluate(`window.chorus.probeAgents()`)
const found = probes.filter((p) => p.installed).map((p) => p.id)
check(found.length > 0, `agents were found: ${found.join(',')}`)

// The one thing only a packaged build can prove: the VSIX really is inside
// `Contents/Resources`, and main can find it there.
const ext = await evaluate(`window.chorus.ideExtensionStatus()`)
check(ext.bundledVersion === '0.5.0', `the bundled extension is present, at ${ext.bundledVersion}`)

const masthead = await evaluate(
  `Math.round(document.querySelector('.masthead')?.getBoundingClientRect().height ?? 0)`
)
check(masthead === 40, `masthead draws at ${masthead}px`)

check(
  !/database error|unhandled rejection/i.test(output),
  'no database or unhandled-rejection noise'
)

ws.close()
child.kill('SIGTERM')
await wait(2_000)
rmSync(dataPath, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
