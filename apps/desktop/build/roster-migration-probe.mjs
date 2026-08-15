/**
 * Phase 2 spike, for `more-than-one-shell-2026-08-14`. Throwaway.
 *
 * The unit tests prove the two halves separately and neither proves the app:
 * `open-sessions.test.ts` covers **parsing** in main (defaults applied, sessions
 * survive), `layout.test.ts` covers **repair** in the renderer (an open panel
 * with no roster gets one). Nothing joins them up, and the join is where a
 * migration actually fails.
 *
 * So this writes an `open-sessions.json` in the shape 0.14.0 wrote — a panel
 * with `open` and `height` and no roster at all — and launches against it. The
 * assertion that matters is that the session comes back, because the failure
 * mode of getting the schema wrong is not a missing panel, it is an empty app.
 *
 * Usage: pnpm --filter @chorus/desktop run build && node build/roster-migration-probe.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from '../e2e/harness.mjs'

const checks = []
const check = (ok, label, detail) => {
  checks.push(ok)
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const ready = async (app) => {
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
  await app.settle()
}

const userData = mkdtempSync(join(tmpdir(), 'chorus-roster-migration-'))

/*
 * Exactly what 0.14.0 wrote: no `tabs`, no `activeId`, anywhere.
 *
 * The conversation id is one that does not exist any more, which is realistic —
 * the shells are gone after a quit either way — and it exercises the pruning
 * path in `reconcileWorkspace` at the same time. The global panel is the one
 * that survives pruning by design, so it is what the assertions read.
 */
const legacy = {
  version: 2,
  sessions: [],
  workspace: {
    layout: { kind: 'leaf', paneId: 'pane-1' },
    panes: { 'pane-1': { id: 'pane-1', tabs: [], activeTabId: null } },
    focusedPaneId: 'pane-1',
    sidebarHidden: false,
    sidebarWidth: 300,
    terminals: { 'conversation-gone': { open: true, height: 310 } },
    globalTerminal: { open: true, height: 288 },
  },
}

mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'open-sessions.json'), JSON.stringify(legacy), 'utf8')

async function main() {
  const app = await launch({ userData, keepData: true })
  try {
    await ready(app)

    /*
     * The headline, and the panel itself is the proof.
     *
     * A required `tabs` sends `parseOpenSessions` down the legacy bare-array
     * parse, which also fails, and it returns `{ sessions: [] }` — the layout
     * *and* every conversation, gone, with no error anywhere. `EMPTY_WORKSPACE`
     * is what the app falls back to, and its global panel is **closed**. So a
     * panel that is open at all says the envelope parsed, and one open at 288
     * rather than the 212 default says its stored fields came through.
     *
     * An earlier revision of this probe measured the sidebar's width for that,
     * which was a worse test in both directions: `readable-control-rail` deleted
     * the drawer, so the selector matched nothing and reported 0px whether or not
     * the parse worked.
     */
    await app.until(`document.querySelector('.terminal-panel--global') !== null`, {
      timeout: 30_000,
      label: 'the global panel reopened',
    })
    check(true, 'a panel stored with no roster still opens')

    const height = Number(
      await app.evaluate(
        `String(Math.round(document.querySelector('.terminal-panel--global').getBoundingClientRect().height))`
      )
    )
    check(
      Math.abs(height - 288) <= 4,
      'at the height 0.14.0 left it, not the default',
      `${String(height)}px, default is 212px`
    )

    /*
     * And it is a live shell, not a restored picture of one. The backfilled tab
     * is what `TerminalView` attached with — so if the roster had come back empty
     * the panel would render against `id: ''` and never produce output.
     */
    await app.until(
      `(document.querySelector('.terminal-panel--global .xterm-rows')?.innerText ?? '').trim().length > 0`,
      { timeout: 30_000, label: 'the backfilled terminal is a working shell' }
    )
    check(true, 'and the backfilled tab is a working shell, not an empty ref')

    /*
     * The pruning path, checked because this fixture exercises it: the stored
     * session panel belongs to a conversation that no longer exists, and
     * `reconcileWorkspace` drops it. The global panel is its own field precisely
     * so that pruning cannot reach it — which the checks above just showed.
     */
    const sessionPanels = Number(
      await app.evaluate(`String(document.querySelectorAll('.terminal-panel--session').length)`)
    )
    check(
      sessionPanels === 0,
      'a panel for a conversation that is gone was pruned',
      `${String(sessionPanels)} session panels`
    )

    /*
     * The backfill itself, now that Phase 3 puts the active terminal's id in the
     * DOM. A panel stored with no roster must come back holding exactly one
     * terminal — not zero, which would render against `id: ''`, and not two.
     *
     * The strip only draws above one tab, so its absence is the assertion for
     * "exactly one": a second would show it.
     */
    const activeId = await app.evaluate(
      `document.querySelector('.terminal-panel--global').dataset.terminalId ?? ''`
    )
    check(
      activeId !== '' && activeId !== 'undefined',
      'the backfilled tab has a real id',
      activeId.slice(0, 8)
    )

    const strip = Number(
      await app.evaluate(`String(document.querySelectorAll('.terminal-panel--global .terminal-tab').length)`)
    )
    check(strip === 0, 'and there is exactly one of it, so no strip is drawn', `${String(strip)} tabs`)
  } finally {
    await app.quit()
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
