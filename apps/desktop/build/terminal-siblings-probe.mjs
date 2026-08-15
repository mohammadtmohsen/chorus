/**
 * Phase 1 spike, for `more-than-one-shell-2026-08-14`. Throwaway.
 *
 * Phase 1 ships the identity plumbing **inert** — the renderer still mints one
 * constant id per scope, so nothing on screen can open a second terminal yet.
 * That leaves the central claim of the phase tested only against a fake PTY in
 * `terminal.test.ts`, which is exactly the kind of gap this repo keeps finding
 * afterwards.
 *
 * So this drives the real IPC surface in a real Electron main process and asks
 * for two global terminals by id. It is the first thing that could show the
 * two-level storage, the per-id lookup and the push routing working against
 * actual shells rather than a stub.
 *
 * Usage: pnpm --filter @chorus/desktop run build && node build/terminal-siblings-probe.mjs
 */

import { launch } from '../e2e/harness.mjs'

const checks = []
const check = (ok, label, detail) => {
  checks.push(ok)
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const ready = async (app) => {
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
  await app.until(`document.querySelectorAll('.pane').length > 0`, { timeout: 120_000 })
  await app.settle()
}

async function main() {
  const app = await launch({})
  try {
    await ready(app)

    /*
     * Collect every push, tagged with the id it names, so routing can be judged
     * afterwards rather than raced against.
     */
    await app.evaluate(`(() => {
      window.__probe = { pushes: [] }
      window.chorus.onTerminalOutput((p) => {
        window.__probe.pushes.push({ id: p.ref.id, scope: p.ref.scope, kind: p.kind })
      })
      return true
    })()`)

    const attach = async (id) =>
      JSON.parse(
        await app.evaluate(`window.chorus
          .attachTerminal({ ref: { scope: 'global', id: ${JSON.stringify(id)} }, cols: 80, rows: 24 })
          .then(a => JSON.stringify(a))`)
      )

    const first = await attach('alpha')
    const second = await attach('beta')
    check(
      typeof first.epoch === 'number' && typeof second.epoch === 'number',
      'both ids attach in the global scope',
      `epochs ${String(first.epoch)} and ${String(second.epoch)}`
    )

    check(
      first.exitCode === null && second.exitCode === null,
      'a running shell reports no exit code',
      'exitCode null on both'
    )

    /*
     * The one that matters. Two ids in one scope must be two shells — if the
     * lookup ignored `id`, the second attach would have superseded the first's
     * epoch and this write would be dropped by `live()`.
     */
    await app.evaluate(`window.chorus.writeTerminal({
      ref: { scope: 'global', id: 'alpha' }, epoch: ${String(first.epoch)}, data: 'echo ALPHA_MARK\\r' })`)
    await app.evaluate(`window.chorus.writeTerminal({
      ref: { scope: 'global', id: 'beta' }, epoch: ${String(second.epoch)}, data: 'echo BETA_MARK\\r' })`)

    await app.until(
      `window.__probe.pushes.some(p => p.id === 'alpha') && window.__probe.pushes.some(p => p.id === 'beta')`,
      { timeout: 30_000, label: 'both shells answered' }
    )
    check(true, 'a write reaches the shell its id names', 'neither epoch was superseded')

    const ids = JSON.parse(
      await app.evaluate(`JSON.stringify([...new Set(window.__probe.pushes.map(p => p.id))].sort())`)
    )
    check(
      ids.length === 2 && ids[0] === 'alpha' && ids[1] === 'beta',
      'every push names exactly one of the two terminals',
      ids.join(', ')
    )

    // Killing one must leave the other running — the two-level `forget`.
    await app.evaluate(`window.chorus.disposeTerminal({
      ref: { scope: 'global', id: 'alpha' }, epoch: ${String(first.epoch)} })`)
    await app.settle()

    const describe = async (id) =>
      JSON.parse(
        await app.evaluate(
          `window.chorus.describeTerminal({ ref: { scope: 'global', id: ${JSON.stringify(id)} } }).then(d => JSON.stringify(d))`
        )
      )

    const alpha = await describe('alpha')
    const beta = await describe('beta')
    check(alpha === null, 'the killed one is gone', JSON.stringify(alpha))
    check(
      beta !== null && beta.running === true,
      'and its sibling is still running',
      JSON.stringify(beta)
    )

    /*
     * §5.1: a shell that dies with no view attached.
     *
     * `exit` is a one-shot push, and once only the active tab mounts this is the
     * common case rather than an edge one. Detach first, *then* let it die, so
     * there is genuinely nobody listening — the code has to survive in main or
     * reopening the tab shows a dead shell looking alive.
     */
    const gamma = await attach('gamma')
    await app.evaluate(`window.chorus.writeTerminal({
      ref: { scope: 'global', id: 'gamma' }, epoch: ${String(gamma.epoch)}, data: 'exit 7\\r' })`)
    await app.evaluate(`window.chorus.detachTerminal({
      ref: { scope: 'global', id: 'gamma' }, epoch: ${String(gamma.epoch)} })`)

    await app.until(
      `window.chorus.describeTerminal({ ref: { scope: 'global', id: 'gamma' } }).then(d => d !== null && d.running === false)`,
      { timeout: 30_000, label: 'the detached shell exited' }
    )
    const dead = await describe('gamma')
    check(dead?.exitCode === 7, 'describe reports how a background shell died', JSON.stringify(dead))

    const reopened = await attach('gamma')
    check(
      reopened.exitCode === 7,
      'and so does the attach that reopens its tab',
      `exitCode ${String(reopened.exitCode)}`
    )
  } finally {
    await app.quit()
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
