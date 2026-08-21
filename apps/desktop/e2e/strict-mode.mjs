import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBuilt, launch, wait } from './harness.mjs'

/**
 * The renderer under React's DEVELOPMENT runtime, where StrictMode bites.
 *
 *   node apps/desktop/e2e/strict-mode.mjs
 *
 * **Why this file exists.** `pnpm dev` and every other spec run different React
 * builds, and only development double-invokes effects: mount, clean up, mount
 * again. A component that creates something expensive in an effect and
 * remembers it in a ref has to survive that, and `MonacoDiff` did not — it
 * rendered an empty editor in `pnpm dev` and a correct one in every automated
 * run, because the harness only ever drove the production bundle. Four probes
 * agreed it was fine while it was visibly broken on screen.
 *
 * So this is not "the same assertions again". It is the second invocation,
 * which nothing else here can reach.
 *
 * It costs a separate build. Run it deliberately, not on every change.
 */

const say = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

const project = mkdtempSync(join(tmpdir(), 'chorus-strict-'))
const config = join(project, 'gitconfig')
writeFileSync(config, '')
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_SYSTEM: config,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}
const repo = join(project, 'repo')
mkdirSync(join(repo, 'nested'), { recursive: true })
execFileSync('git', ['init', '-b', 'main', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] })
writeFileSync(join(repo, 'nested/quiet.ts'), 'const MARKER_ONE = 1\nconst MARKER_TWO = 2\n')
writeFileSync(join(repo, 'changed.ts'), 'const C = 1\n')
execFileSync('git', ['add', '.'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
execFileSync('git', ['commit', '-m', 'first'], {
  cwd: repo,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
writeFileSync(join(repo, 'changed.ts'), 'const C = 2\n')

ensureBuilt('development')

const setup = await launch({ keepData: true })
let dataPath
try {
  dataPath = setup.dataPath
  await setup.until(`document.querySelectorAll('.pane').length > 0`)
  const id = await setup.evaluate(
    `document.querySelector('[data-workspace-tab]').dataset.workspaceTab`
  )
  await setup.evaluate(
    `window.chorus.setProjectDirectory({ conversationId: ${JSON.stringify(id)}, cwd: ${JSON.stringify(repo)} }).then(() => true)`
  )
  await wait(2_000)
} finally {
  await setup.stop()
}

const app = await launch({ userData: dataPath, keepData: true })
try {
  await app.until(`document.querySelectorAll('.pane').length > 0`)
  await app.bringToFront()
  await app.viewport(1440, 900)
  await app.settle()

  /*
   * The control, and it is the whole point of the file.
   *
   * If this bundle is not actually React's development build then every
   * assertion below passes for the wrong reason — the effects only ran once,
   * so nothing was tested. React's development runtime carries warning
   * machinery its production build strips.
   */
  /*
   * There is no honest in-page check that this is React's development build —
   * the devtools hook is absent without devtools, and the vite preamble only
   * exists behind a dev *server*. The guarantee comes from outside instead:
   * `ensureBuilt('development')` above, and the mode stamp the harness writes.
   *
   * What proves this file is worth running is the mutation test, not a marker.
   * Delete `loaded.current = null` from `MonacoDiff`'s cleanup and the first
   * assertion below fails; put it back and it passes. That was run.
   */

  await app.evaluate(`(() => {
    const e = new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
    if (!document.querySelector('.changes-panel')) document.dispatchEvent(e);
    return true })()`)
  await app.until(`!!document.querySelector('.changes-panel')`, { timeout: 20_000, label: 'panel' })
  await app.until(`document.querySelectorAll('.changes-file').length > 0`, {
    timeout: 20_000,
    label: 'rows',
  })

  const contents = async () =>
    app.evaluate(`(() => {
      const h = document.querySelector('.monaco-diff-host');
      return h ? [...h.querySelectorAll('.view-line')].map(n => n.textContent || '') : []
    })()`)

  /*
   * A plain editor, which is the widget the bug lived in. `monaco.editor.create`
   * hands back an editor that already owns an empty model, so a second
   * StrictMode pass finds a live model and a `loaded` ref left over from the
   * first — and concluded nothing had changed.
   */
  await app.evaluate(
    `(() => { const b=[...document.querySelectorAll('.changes-activity [role="tab"]')].find(x=>x.getAttribute('aria-label')==='Explorer'); b?.click(); return true })()`
  )
  await wait(1_500)
  const opened = await app.evaluate(`(() => {
    const r=[...document.querySelectorAll('.changes-tree-row')].find(n => (n.textContent||'').includes('nested'));
    r?.click(); return { found: !!r, rows: [...document.querySelectorAll('.changes-tree-row')].map(n => (n.textContent||'').trim()).slice(0,8) } })()`)
  console.log('  tree before:', JSON.stringify(opened))
  await wait(2_500)
  const picked = await app.evaluate(`(() => {
    const r=[...document.querySelectorAll('.changes-tree-row')].find(n => (n.textContent||'').includes('quiet.ts'));
    r?.click(); return { found: !!r, rows: [...document.querySelectorAll('.changes-tree-row')].map(n => (n.textContent||'').trim()).slice(0,8) } })()`)
  console.log('  tree after:', JSON.stringify(picked))

  let rendered = true
  try {
    await app.until(
      `[...document.querySelectorAll('.monaco-diff-host .view-line')].some(n => (n.textContent||'').includes('MARKER_ONE'))`,
      { timeout: 25_000, label: 'file contents under StrictMode' }
    )
  } catch {
    rendered = false
  }
  const lines = await contents()
  say(
    'a file opened from the Explorer renders under StrictMode',
    rendered,
    JSON.stringify(lines.slice(0, 3))
  )

  /* And the diff widget, which survived the same double-invoke by accident. */
  await app.evaluate(
    `(() => { const b=[...document.querySelectorAll('.changes-activity [role="tab"]')].find(x=>x.getAttribute('aria-label')==='Source Control'); b?.click(); return true })()`
  )
  await wait(1_500)
  await app.evaluate(
    `(() => { const r=[...document.querySelectorAll('.changes-file')].find(n=>(n.textContent||'').includes('changed.ts')); (r?.querySelector('.changes-file-open')||r)?.click(); return true })()`
  )
  await wait(3_000)
  const diffLines = await contents()
  const hunk = await app.evaluate(`!!document.querySelector('.changes-diff .hunk')`)
  say(
    'and a diff renders under StrictMode too',
    hunk || diffLines.some((l) => l.includes('const C')),
    JSON.stringify({ hunk, first: diffLines.slice(0, 2) })
  )
} finally {
  await app.stop()
}
