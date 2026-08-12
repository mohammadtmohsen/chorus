/**
 * Phase 2 spike. Throwaway — delete when the panel lands and specs cover this.
 *
 * Drives the real app and exercises the terminal IPC path from the renderer,
 * which is the only place it can be exercised honestly: preload → main →
 * TerminalService → a real PTY → push back over the bridge. There is no UI yet,
 * so `window.chorus` is the surface under test.
 *
 * Usage: pnpm --filter @chorus/desktop run build && node build/terminal-ipc-probe.mjs
 */

import { launch } from '../e2e/harness.mjs'

const checks = []
const check = (ok, label, detail) => {
  checks.push(ok)
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const app = await launch({})
  try {
    await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })

    /*
     * Subscribe before attaching, which is the ordering the API doc insists on:
     * anything the shell writes between the snapshot being taken and a listener
     * going live would otherwise be lost.
     */
    await app.evaluate(`
      window.__probe = { pushes: [], stop: null }
      window.__probe.stop = window.chorus.onTerminalOutput((p) => window.__probe.pushes.push(p))
      'ok'
    `)

    const attached = await app.evaluate(`
      window.chorus.attachTerminal({ ref: { scope: 'global' }, cols: 80, rows: 24 })
        .then(a => { window.__probe.epoch = a.epoch; return JSON.stringify(a) })
    `)
    const info = JSON.parse(attached)
    check(typeof info.epoch === 'number' && info.epoch >= 1, 'attach mints an epoch', `epoch ${info.epoch}`)
    check(info.cols === 80 && info.rows === 24, 'the shell opened at the requested size')

    await app.evaluate(`
      window.chorus.writeTerminal({
        ref: { scope: 'global' },
        epoch: window.__probe.epoch,
        data: 'echo chorus-terminal-works\\r',
      })
    `)

    await app.until(
      `window.__probe.pushes.some(p => p.kind === 'data' && p.data.includes('chorus-terminal-works'))`,
      { timeout: 30_000 }
    )
    check(true, 'output comes back over the push channel')

    const shape = JSON.parse(
      await app.evaluate(`
        JSON.stringify(window.__probe.pushes.find(p => p.kind === 'data'))
      `)
    )
    check(shape.ref?.scope === 'global', 'the push carries its terminal reference')
    check(typeof shape.seq === 'number' && shape.seq >= 1, 'and a sequence number to align on', `seq ${shape.seq}`)
    check(shape.epoch === info.epoch, 'and the epoch of the view that asked')

    // A real tty, not a pipe: the shell echoes the typed line back with a CR.
    check(
      shape.data.includes('\r') || JSON.stringify(shape.data).includes('\\r'),
      'the stream is a tty, not a pipe'
    )

    const described = JSON.parse(
      await app.evaluate(
        `window.chorus.describeTerminal({ ref: { scope: 'global' } }).then(d => JSON.stringify(d))`
      )
    )
    check(described?.running === true, 'the shell is described as running', `foreground ${described?.foreground}`)

    // Detach must not kill it — the whole reason the PTY lives in main.
    await app.evaluate(`
      window.chorus.detachTerminal({ ref: { scope: 'global' }, epoch: window.__probe.epoch })
    `)
    const afterDetach = JSON.parse(
      await app.evaluate(
        `window.chorus.describeTerminal({ ref: { scope: 'global' } }).then(d => JSON.stringify(d))`
      )
    )
    check(afterDetach?.running === true, 'detaching leaves the shell running')

    // Re-attaching supersedes, and the snapshot carries what was missed.
    const again = JSON.parse(
      await app.evaluate(`
        window.chorus.attachTerminal({ ref: { scope: 'global' }, cols: 80, rows: 24 })
          .then(a => JSON.stringify(a))
      `)
    )
    check(again.epoch > info.epoch, 're-attaching supersedes the old epoch', `${info.epoch} → ${again.epoch}`)
    check(
      again.snapshot.includes('chorus-terminal-works'),
      'the snapshot restores what the previous view saw'
    )

    // A stale epoch is ignored rather than obeyed.
    const staleAccepted = await app.evaluate(`
      window.chorus.writeTerminal({
        ref: { scope: 'global' },
        epoch: ${String(info.epoch)},
        data: 'echo SHOULD-NOT-RUN\\r',
      }).then(() => 'sent')
    `)
    await new Promise((r) => setTimeout(r, 1_500))
    const ranStale = await app.evaluate(
      `window.__probe.pushes.some(p => p.kind === 'data' && p.data.includes('SHOULD-NOT-RUN'))`
    )
    check(staleAccepted === 'sent' && ranStale === false, 'a write on a superseded epoch is ignored')
  } finally {
    await app.quit()
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
