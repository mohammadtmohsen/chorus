import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBuilt, launch, wait } from './harness.mjs'

/**
 * `--packaged <path>` drives the built `.app` instead of `out/`.
 *
 * Not a nicety: `pnpm dev` and the bundle load different files, and Monaco's
 * worker is exactly the kind of asset whose URL resolves in one and not the
 * other. A phase that only proved it under electron-vite would have proved the
 * easy half.
 */
const packagedAt = process.argv.includes('--packaged')
  ? process.argv[process.argv.indexOf('--packaged') + 1]
  : undefined

/**
 * The Changes panel, driven against a repository that has genuinely diverged.
 *
 * Everything here is the half unit tests cannot reach. `git.test.ts` proves the
 * merge-base arithmetic against a fixture repo, and `changes-panel.test.ts`
 * proves the state survives a persist — but neither can say whether the chord
 * opens anything, whether the picker is wired to the read, or whether an edit
 * made *outside* Chorus reaches the panel without a click. Those are the three
 * things this asserts.
 *
 *   node apps/desktop/e2e/changes-panel.mjs
 *
 * No agent runs. The panel reads git, so a conversation pointed at a directory
 * is the whole fixture — which also makes this one of the few specs that does
 * not need an authenticated CLI.
 */

const say = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

/**
 * Wait for a condition **from Node**, never inside the page.
 *
 * This file used to poll with `await new Promise(r => setTimeout(r, 100))`
 * inside `Runtime.evaluate`, to avoid a fixed sleep losing a race. That traded
 * an occasional flake for a reproducible hang: Chromium throttles timers in a
 * window the compositor considers occluded, so a 15-second in-page loop can
 * take minutes and the evaluate never returns — the run then dies naming the
 * expression that was waiting rather than anything that broke. The harness's
 * own `settle` carries the same warning about `requestAnimationFrame`.
 *
 * `until` does its waiting on this side, where nothing is throttled. Returns a
 * boolean instead of throwing, so a timeout is a reported failure rather than a
 * dead run.
 */
const waitFor = async (app, expression, label, timeout = 30_000) => {
  try {
    await app.until(expression, { timeout, label })
    return true
  } catch {
    return false
  }
}

/* A repository whose branch left `main` before `main` moved on. */
const project = mkdtempSync(join(tmpdir(), 'chorus-changes-panel-'))
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
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

execFileSync('git', ['init', '-b', 'main', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] })
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(join(repo, 'src/shared.ts'), 'export const RATE = 1\n')

/*
 * For the tree: something ignored, something committed and never touched, and a
 * link out of the project.
 *
 * `docs/never-touched.md` is the one that matters — it appears in no diff at
 * any base, so the tree is the only way to reach it.
 */
mkdirSync(join(repo, 'docs'), { recursive: true })
mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true })
writeFileSync(join(repo, 'docs/never-touched.md'), '# notes\n\nnothing ever happens here\n')
writeFileSync(join(repo, 'README.md'), '# fixture\n')
writeFileSync(join(repo, '.gitignore'), 'node_modules/\n*.log\n')
writeFileSync(join(repo, 'noisy.log'), 'ignored\n')
writeFileSync(join(repo, 'node_modules/left-pad/index.js'), 'module.exports = 1\n')
const secrets = join(project, 'secrets')
mkdirSync(secrets, { recursive: true })
writeFileSync(join(secrets, 'creds.txt'), 'token')
symlinkSync(secrets, join(repo, 'escape-link'))

git('add', '.')
git('commit', '-m', 'first')
/*
 * A remote-tracking ref, without a network.
 *
 * The upstream config below points at this. Without the ref existing git still
 * reports `# branch.upstream`, but computes the divergence as `+0 -0` — which
 * looks exactly like a branch that is in sync, and is why this line is needed
 * for the ahead/behind assertion to mean anything.
 */
const firstSha = git('rev-parse', 'HEAD').trim()
/*
 * A real bare repository for `origin`.
 *
 * It was a path that did not exist while only ahead/behind needed it — git
 * reports divergence from the local tracking ref without ever contacting the
 * remote. Publishing has to actually arrive somewhere, so the assertion can
 * read the branch back out rather than trusting an exit code.
 */
const bare = join(project, 'origin.git')
execFileSync('git', ['init', '--bare', '-b', 'main', bare], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
git('update-ref', 'refs/remotes/origin/main', firstSha)

git('checkout', '-b', 'feature')
git('checkout', 'main')
writeFileSync(join(repo, 'moved-on-main.ts'), 'export const OTHER = true\n')
git('add', '.')
git('commit', '-m', 'main moved on')

git('checkout', 'feature')
writeFileSync(join(repo, 'src/added-on-branch.ts'), 'export const FEE = 0.3\n')
git('add', '.')
git('commit', '-m', 'branch work')
appendFileSync(join(repo, 'src/shared.ts'), 'export const NAME = "payments"\n')

if (packagedAt === undefined) ensureBuilt()

/*
 * Set up in one launch, drive in the next — `shots-changes.mjs` explains why: a
 * session keeps the cwd it opened with, so pointing it at the repo has to be
 * followed by a relaunch.
 */
const executable = packagedAt === undefined ? {} : { executable: packagedAt }
const setup = await launch({ keepData: true, ...executable })
try {
  await setup.until(`document.querySelectorAll('.pane').length > 0`)
  const conversationId = await setup.evaluate(
    `document.querySelector('[data-workspace-tab]').dataset.workspaceTab`
  )
  await setup.evaluate(
    `window.chorus.setProjectDirectory({ conversationId: ${JSON.stringify(conversationId)}, cwd: ${JSON.stringify(repo)} }).then(() => true)`
  )
  // The layout write is debounced; quitting inside that window loses the tab.
  await wait(2_000)
} finally {
  await setup.stop()
}

const app = await launch({ userData: setup.dataPath, ...executable })
try {
  await app.until(`document.querySelectorAll('.pane').length > 0`)
  await app.bringToFront()
  await app.viewport(1440, 900)
  await app.settle()

  /*
   * The chord, measured by `defaultPrevented` rather than by counting panels.
   *
   * C-027 from the inside: a test that asserts a panel appeared cannot tell
   * "the handler ran" from "something else opened it", and one that asserts a
   * count cannot fail when the count could not have moved anyway.
   */
  const chord = await app.evaluate(`(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'g', code: 'KeyG', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
    })
    document.dispatchEvent(event)
    return event.defaultPrevented
  })()`)
  say('⌘⇧G is handled', chord === true, `defaultPrevented=${String(chord)}`)

  await app.settle()
  await wait(1_500)

  const opened = await app.evaluate(`!!document.querySelector('.changes-panel')`)
  say('the panel opened', opened === true)

  const working = await app.evaluate(`(() => {
    const files = [...document.querySelectorAll('.changes-file-path')].map((n) => n.textContent)
    return { files, foot: document.querySelector('.changes-foot .hint')?.textContent ?? '' }
  })()`)
  say(
    'the working tree shows only uncommitted work',
    working.files.length === 1 && working.files[0].includes('shared.ts'),
    JSON.stringify(working.files)
  )

  /* Switch the base to `main` through the picker the user would use. */
  await app.evaluate(`(() => {
    const select = document.querySelector('.changes-base select')
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    set.call(select, 'main')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await wait(2_000)
  await app.settle()

  const branch = await app.evaluate(`(() => {
    const files = [...document.querySelectorAll('.changes-file-path')].map((n) => n.textContent)
    return { files, foot: document.querySelector('.changes-foot .hint')?.textContent ?? '' }
  })()`)
  say(
    'the branch diff lists what the branch did',
    branch.files.length === 2 &&
      branch.files.some((f) => f.includes('added-on-branch.ts')) &&
      branch.files.some((f) => f.includes('shared.ts')),
    JSON.stringify(branch.files)
  )
  say(
    'it excludes what main did after the branch was cut',
    !branch.files.some((f) => f.includes('moved-on-main')),
    JSON.stringify(branch.files)
  )
  say(
    'the footer names the baseline it compared against',
    /main/.test(branch.foot) && /[0-9a-f]{7}/.test(branch.foot),
    JSON.stringify(branch.foot)
  )

  /*
   * The watcher: an edit from outside the app, with nothing clicked.
   *
   * This is the assertion the whole push channel exists for, and the one that
   * would have quietly not worked — the modal Review sheet reads once on mount
   * and has looked slightly wrong ever since.
   */
  const before = branch.files.length
  writeFileSync(join(repo, 'src/from-outside.ts'), 'export const OUTSIDE = true\n')
  git('add', 'src/from-outside.ts')
  await wait(4_000)
  await app.settle()
  const after = await app.evaluate(
    `[...document.querySelectorAll('.changes-file-path')].map((n) => n.textContent)`
  )
  say(
    'an external edit reaches the panel with nothing clicked',
    after.length === before + 1 && after.some((f) => f.includes('from-outside.ts')),
    `${String(before)} → ${JSON.stringify(after)}`
  )

  /*
   * Monaco, and specifically its worker.
   *
   * The editor renders two panes whether or not the worker loaded — the diff
   * *alignment* is what it computes, so decorations are the only evidence that
   * a bundled, same-origin worker actually started under `sandbox: true`. A
   * test that only asserted `.monaco-editor` exists would pass with the worker
   * dead, which is the failure this phase was most likely to ship.
   *
   * The switch to Editor is explicit because `hunks` is now the default view —
   * it was `editor` when this was written, and the assertions below silently
   * relied on that. A spec that depends on a default is a spec that starts
   * testing something else the day the default moves.
   */
  await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.changes-head .btn')]
      .find((b) => b.textContent.trim() === 'Editor')
    button?.click()
    return true
  })()`)
  await wait(1_000)

  await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.changes-file')]
      .find((r) => r.textContent.includes('shared.ts'))
    row?.querySelector('.changes-file-open')?.click()
    return true
  })()`)
  await app.settle()

  /*
   * Waits for *this* file to be on screen and decorated, not for "any
   * decoration anywhere".
   *
   * This read was a fixed 3s sleep, which lost the race on a loaded machine.
   * Waiting fixed that and introduced a subtler fault: the previously-selected
   * file is an added file, so it carries decorations of its own, and the
   * condition was already true before shared.ts had rendered. The tell was the
   * count — `+4 −3` on three runs and `+2 −0` on a fourth, for a diff that
   * cannot change between runs.
   *
   * `payments` is the line this file appends, so it names the file rather than
   * the state.
   */
  await waitFor(
    app,
    `[...document.querySelectorAll('.monaco-diff-host .view-line')].some((n) =>
       (n.textContent ?? '').includes('payments'))
     && document.querySelectorAll('.line-insert, .char-insert').length > 0`,
    'this file decorated'
  )
  const editor = await app.evaluate(`(() => {
    const host = document.querySelector('.monaco-diff-host')
    return {
      mounted: !!host?.querySelector('.monaco-editor'),
      /*
       * Measured, and asserted by name below.
       *
       * Monaco draws nothing into a short box and every other check still
       * passes — it mounts, it themes, it reports a diff editor in the DOM.
       * The first packaged run of phase 3 was 0px and the symptom that surfaced
       * was "no decorations", which sent the investigation at the worker. Read
       * the height directly so the next time it says so.
       */
      hostHeight: host?.getBoundingClientRect().height ?? -1,
      bodyHeight: document.querySelector('.changes-diff')?.getBoundingClientRect().height ?? -1,
      inserts: document.querySelectorAll('.line-insert, .char-insert').length,
      deletes: document.querySelectorAll('.line-delete, .char-delete').length,
      // The pane draws on the app's own surface, not on Monaco's default — the
      // trap xterm hit, where the theme resolved and the paint did not.
      background: host === null ? '' : getComputedStyle(host.querySelector('.monaco-editor') ?? host).backgroundColor,
      appSurface: getComputedStyle(document.querySelector('.changes-panel')).backgroundColor,
    }
  })()`)
  say('Monaco mounted', editor.mounted === true)
  say(
    'the editor has a box to draw into',
    editor.hostHeight > 80,
    `host ${String(Math.round(editor.hostHeight))}px inside ${String(Math.round(editor.bodyHeight))}px`
  )
  say(
    'the worker computed a diff',
    editor.inserts > 0,
    `+${String(editor.inserts)} −${String(editor.deletes)} decorations`
  )
  say(
    'the editor paints on the app surface, not Monaco default',
    editor.background === editor.appSurface,
    `${editor.background} vs ${editor.appSurface}`
  )

  /*
   * Both colour schemes, on a live switch.
   *
   * Monaco holds resolved hex rather than reading CSS custom properties, so a
   * scheme change is invisible to it unless something re-pushes the theme. This
   * is the assertion that would have caught the xterm bug, where the tokens
   * resolved correctly and the surface still painted black in both schemes —
   * so it reads the *rendered* colour and compares the two schemes to each
   * other, rather than checking that a token exists.
   */
  const schemes = {}
  for (const scheme of ['dark', 'light']) {
    await app.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    })
    // The theme is re-pushed on a `matchMedia` change, so the read waits for
    // the repaint rather than guessing how long it takes — same reason the
    // decoration read above polls.
    await waitFor(
      app,
      `(() => {
        const node = document.querySelector('.monaco-diff-host .monaco-editor')
        const panel = document.querySelector('.changes-panel')
        if (node === null || panel === null) return false
        return getComputedStyle(node).backgroundColor === getComputedStyle(panel).backgroundColor
      })()`,
      `${scheme} repaint`,
      10_000
    )
    schemes[scheme] = await app.evaluate(`(() => {
      /*
       * .monaco-editor, not .monaco-scrollable-element. The scrollable element
       * is transparent in every theme, so reading it returns rgba(0,0,0,0)
       * whatever Monaco was told. (No backticks in here: this whole block is
       * inside a template literal, and one would end it — the trap CLAUDE.md
       * records about SQL, in a different file.)
       */
      const editor = document.querySelector('.monaco-diff-host .monaco-editor')
      const panel = document.querySelector('.changes-panel')
      return {
        editor: editor === null ? '' : getComputedStyle(editor).backgroundColor,
        panel: getComputedStyle(panel).backgroundColor,
      }
    })()`)
  }
  say(
    'the editor follows the app surface in both schemes',
    schemes.dark.editor === schemes.dark.panel && schemes.light.editor === schemes.light.panel,
    `dark ${schemes.dark.editor}/${schemes.dark.panel}, light ${schemes.light.editor}/${schemes.light.panel}`
  )
  say(
    'the two schemes actually differ',
    schemes.dark.panel !== schemes.light.panel,
    `${schemes.dark.panel} vs ${schemes.light.panel}`
  )
  await app.send('Emulation.setEmulatedMedia', { features: [] })
  await wait(500)

  /*
   * A large file, because "it works" on a two-line diff proves very little.
   *
   * 5,000 lines is the plan's own bar. What is measured is the time from
   * selecting the file to the editor having laid out its lines — if Monaco's
   * worker chokes, this is where it shows.
   */
  const bigLines = Array.from(
    { length: 5_000 },
    (_, i) => `export const N${String(i)} = ${String(i)}`
  )
  writeFileSync(join(repo, 'src/big.ts'), `${bigLines.join('\n')}\n`)
  git('add', 'src/big.ts')
  git('commit', '-m', 'big file')
  // Change a line in the middle, so the diff is real rather than an addition.
  bigLines[2_500] = 'export const N2500 = 999999'
  writeFileSync(join(repo, 'src/big.ts'), `${bigLines.join('\n')}\n`)
  await wait(3_000)

  const found = await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.changes-file')]
      .find((r) => r.textContent.includes('big.ts'))
    if (row === undefined) return false
    // The row is a div; the clickable part is the open button inside it.
    row.querySelector('.changes-file-open')?.click()
    return true
  })()`)
  /*
   * Timed from this side, in wall clock.
   *
   * Less precise than `performance.now()` in the page — `until` polls every
   * 200ms, so that is the granularity — but the in-page version had to sleep
   * in the page to measure, and that is the throttled loop this file no longer
   * has. The assertion is "it lays out promptly", not a benchmark, and a bound
   * measured honestly beats a figure measured in a way that can hang.
   */
  const startedAt = Date.now()
  /*
   * Waits for *this* file's content, not for "any view line".
   *
   * The previous file is still on screen while the next one loads, so
   * `view-line.length > 0` is already true the instant this is asked — the
   * measurement came back as 3-5ms for a 5,000-line file, which is the tell.
   * An assertion that passes because the thing it is about has not happened yet
   * is C-027's shape, and this is the second time in this file the same mistake
   * has been made with a different waiter — three times, in fact: 'export
   * const N' looked file-specific and is a prefix of shared.ts's own 'export
   * const NAME'. The marker has to be a string that cannot occur in any other
   * fixture file, so it is a line number from this one — and from the *top* of it, because Monaco virtualises and a marker at line 2500 is never in the DOM at all.
   */
  const laidOut = await waitFor(
    app,
    `[...document.querySelectorAll('.monaco-diff-host .view-line')].some((n) =>
       (n.textContent ?? '').includes('N0'))`,
    'big file lays out'
  )
  const elapsed = Date.now() - startedAt
  // On failure, say what was on screen instead — a bare timeout names the
  // expression that waited, never the state that was wrong.
  const bigState = laidOut
    ? ''
    : await app.evaluate(`JSON.stringify({
        selected: document.querySelector('.changes-file[data-on=\\'true\\'] .changes-file-path')?.textContent ?? null,
        monaco: !!document.querySelector('.monaco-diff-host'),
        editor: !!document.querySelector('.monaco-diff-host .monaco-editor'),
        lines: document.querySelectorAll('.monaco-diff-host .view-line').length,
        first: [...document.querySelectorAll('.monaco-diff-host .view-line')].slice(0, 2).map((n) => n.textContent),
      })`)
  say(
    'a 5,000-line file lays out',
    found === true && laidOut,
    laidOut ? `${String(elapsed)}ms to its own first line (±200ms)` : bigState
  )

  /* The fallback view is still reachable, which is the point of keeping it. */
  await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.changes-head .btn')]
      .find((b) => b.textContent.trim() === 'Hunks')
    button?.click()
    return true
  })()`)
  await wait(1_000)
  const hunks = await app.evaluate(`({
    table: !!document.querySelector('.changes-diff .hunk'),
    monaco: !!document.querySelector('.monaco-diff-host'),
    // Token spans from highlight.ts. The hunk renderer draws the transcript's
    // diffs too, and it was monochrome until it started using CodeRun — using
    // Monaco there instead would have cost 7.1x the DOM per patch, measured.
    tokens: document.querySelectorAll('.changes-diff .hunk .tok').length,
  })`)
  say('the hunks view still works', hunks.table === true && hunks.monaco === false)
  say(
    'the hunk view is syntax highlighted',
    hunks.tokens > 0,
    `${String(hunks.tokens)} token spans`
  )

  /*
   * Into the Editor view, because the sections below cannot work without it.
   *
   * This line's old comment said "back to the editor, so the reopen assertion
   * below sees the default view" — which was wrong about its own purpose and
   * nearly got it deleted when `hunks` became the default. The reopen assertion
   * at the end of this file checks the chosen *base*, not the view. What
   * actually needs Monaco is everything between here and there: the tree opens
   * `docs/never-touched.md`, a file that appears in no diff, and reads it out of
   * `.monaco-diff-host .view-line` — the hunks view has nothing to show for an
   * unchanged file — and the save assertions drive `⌘S` in the editor.
   *
   * So it is not "restore the default", it is "this view is a precondition".
   */
  await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('.changes-head .btn')]
      .find((b) => b.textContent.trim() === 'Editor')
    button?.click()
    return true
  })()`)
  await wait(1_000)

  /*
   * The file tree: reach a file git has never mentioned, and read it.
   *
   * `docs/never-touched.md` is committed and unchanged, so it appears in no
   * diff at any base — the only way to it is the tree, which is the whole
   * point of the phase.
   */
  await app.evaluate(`(() => {
    // The rail switches views by icon now, so match the accessible name
    // rather than the label text — there is no label text any more.
    const tab = [...document.querySelectorAll('.changes-activity [role="tab"]')]
      .find((b) => (b.getAttribute('aria-label') || '') === 'Explorer')
    tab?.click()
    return true
  })()`)
  await wait(2_500)
  await app.settle()

  const tree = await app.evaluate(
    `[...document.querySelectorAll('.changes-tree-name')].map((n) => n.textContent)`
  )
  say(
    'the tree lists the project root',
    tree.includes('src') && tree.includes('docs') && tree.includes('README.md'),
    JSON.stringify(tree)
  )
  say(
    'it hides what .gitignore covers',
    !tree.includes('node_modules') && !tree.includes('noisy.log'),
    JSON.stringify(tree)
  )
  say('it never lists .git', !tree.includes('.git'), JSON.stringify(tree))

  /* Expand a directory — one read, on demand. */
  await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.changes-tree-row')]
      .find((r) => r.textContent.includes('docs'))
    row?.click()
    return true
  })()`)
  await wait(2_000)
  await app.settle()
  const expanded = await app.evaluate(
    `[...document.querySelectorAll('.changes-tree-name')].map((n) => n.textContent)`
  )
  say(
    'expanding a directory loads its children',
    expanded.includes('never-touched.md'),
    JSON.stringify(expanded)
  )

  /* Open it: a file with no diff entry anywhere. */
  await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.changes-tree-row')]
      .find((r) => r.textContent.includes('never-touched.md'))
    row?.click()
    return true
  })()`)
  await app.settle()
  /*
   * Waits for *this file's* content, not for "any lines".
   *
   * The previous file is still rendered while the next one loads, so a wait
   * that stops at the first view-line reads the file you just left — which it
   * did, twice, reporting big.ts under an assertion about never-touched.md.
   *
   * The replace() is because Monaco renders a space as a non-breaking one
   * inside a view line, so comparing against ordinary spaces never matches —
   * and the two are indistinguishable in any log you print.
   */
  await waitFor(
    app,
    `[...document.querySelectorAll('.monaco-diff-host .view-line')].some((n) =>
       (n.textContent ?? '').replace(/\\u00a0/g, ' ').includes('nothing ever happens here'))`,
    'the unchanged file renders'
  )
  const unchanged = await app.evaluate(`(() => {
    const flat = (n) => (n.textContent ?? '').replace(/\\u00a0/g, ' ')
    const lines = [...document.querySelectorAll('.monaco-diff-host .view-line')].map(flat)
    return {
      lines,
      // Nothing changed, so nothing should be marked as changed.
      decorations: document.querySelectorAll('.line-insert, .line-delete').length,
      inChangedList: [...document.querySelectorAll('.changes-file-path')]
        .some((n) => n.textContent.includes('never-touched')),
    }
  })()`)
  say(
    'a file git never mentions opens and reads',
    unchanged.lines.some((l) => l.includes('nothing ever happens here')),
    JSON.stringify(unchanged.lines.slice(0, 3))
  )
  say(
    'and it is marked as unchanged, not as a diff',
    unchanged.decorations === 0 && unchanged.inChangedList === false,
    `${String(unchanged.decorations)} decorations`
  )

  /* A symlink out of the project must refuse rather than list what is there. */
  await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.changes-tree-row')]
      .find((r) => r.textContent.includes('escape-link'))
    row?.click()
    return true
  })()`)
  await wait(2_000)
  const escaped = await app.evaluate(
    `[...document.querySelectorAll('.changes-tree-name')].map((n) => n.textContent)`
  )
  say(
    'a symlink leaving the project is refused',
    !escaped.includes('creds.txt'),
    JSON.stringify(escaped.filter((n) => n.includes('creds')))
  )

  /* Back to the changed list, so the assertions below see it. */
  await app.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.changes-activity [role="tab"]')]
      .find((b) => (b.getAttribute('aria-label') || '') === 'Source Control')
    tab?.click()
    return true
  })()`)
  await wait(1_000)

  /*
   * The write path, end to end: type, save, and check the log was told.
   *
   * The two halves are asserted separately on purpose. A save that lands
   * without the event is the exact failure the event exists to prevent — an
   * agent mid-turn patching a version that no longer exists — so "the file
   * changed on disk" is not enough on its own.
   */
  await app.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.changes-activity [role="tab"]')]
      .find((b) => (b.getAttribute('aria-label') || '') === 'Source Control')
    tab?.click()
    return true
  })()`)
  await wait(1_000)
  await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.changes-file')]
      .find((r) => r.textContent.includes('shared.ts'))
    row?.querySelector('.changes-file-open')?.click()
    return true
  })()`)
  await wait(3_000)
  await app.settle()

  const saved = await app.evaluate(`(async () => {
    const id = document.querySelector('[data-workspace-tab]').dataset.workspaceTab
    const before = (await window.chorus.history({ conversationId: id }))
      .filter((e) => e.type === 'file.edited.byUser').length

    const written = await window.chorus.writeProjectFile({
      conversationId: id,
      path: 'src/shared.ts',
      content: 'export const RATE = 1\\nexport const NAME = "payments"\\nexport const SAVED = true\\n',
      expectedSha: (await window.chorus.readFileVersions({ conversationId: id, path: 'src/shared.ts' })).sha,
    })

    const after = (await window.chorus.history({ conversationId: id }))
      .filter((e) => e.type === 'file.edited.byUser')
    return { written, appended: after.length - before, last: after.at(-1)?.payload ?? null }
  })()`)
  say('the save reports no problem', saved.written.problem === null, JSON.stringify(saved.written))
  say(
    'it appended exactly one event to the log',
    saved.appended === 1,
    `${String(saved.appended)} appended`
  )
  say(
    'the event names the file and what moved, and carries no content',
    saved.last !== null &&
      saved.last.path === 'src/shared.ts' &&
      saved.last.added === 1 &&
      !('content' in saved.last) &&
      !('text' in saved.last),
    JSON.stringify(saved.last)
  )

  /* And the panel notices its own write through the watcher, not a special case. */
  await wait(3_000)
  await app.settle()
  const afterSave = await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.changes-file')]
      .find((b) => b.textContent.includes('shared.ts'))
    return row?.querySelector('.added')?.textContent ?? ''
  })()`)
  say(
    'the panel reflects the saved file without being told twice',
    afterSave === '+2',
    `counts read ${JSON.stringify(afterSave)}`
  )

  /*
   * A save that would overwrite work the editor never saw.
   *
   * The decision this implements: refusing is recoverable, a silent overwrite
   * is not. Driven through the real channel, because the digest has to survive
   * the round trip from `workspace:fileVersions` to `workspace:write` — a
   * conflict check that always passes looks identical to one that works.
   */
  const conflict = await app.evaluate(`(async () => {
    const id = document.querySelector('[data-workspace-tab]').dataset.workspaceTab
    const read = await window.chorus.readFileVersions({ conversationId: id, path: 'src/shared.ts' })

    const stale = await window.chorus.writeProjectFile({
      conversationId: id,
      path: 'src/shared.ts',
      content: 'written against a version that no longer exists\\n',
      // A digest of something the file has never contained.
      expectedSha: '0'.repeat(64),
    })

    const fresh = await window.chorus.writeProjectFile({
      conversationId: id,
      path: 'src/shared.ts',
      content: 'saved with the right digest\\n',
      expectedSha: read.sha,
    })

    const forced = await window.chorus.writeProjectFile({
      conversationId: id,
      path: 'src/shared.ts',
      content: 'forced over a stale digest\\n',
      expectedSha: '0'.repeat(64),
      force: true,
    })

    return { sha: read.sha, stale: stale.outcome, fresh: fresh.outcome, forced: forced.outcome }
  })()`)
  say(
    'the read hands back a digest to save against',
    typeof conflict.sha === 'string' && conflict.sha.length === 64,
    JSON.stringify(conflict.sha).slice(0, 20)
  )
  say('a stale save is refused', conflict.stale === 'conflict', conflict.stale)
  say('a save with the right digest goes through', conflict.fresh === 'written', conflict.fresh)
  say('an accepted conflict can be forced', conflict.forced === 'written', conflict.forced)

  /*
   * The branch the panel says you are on, and whether it notices a checkout.
   *
   * The watcher covers `.git`, and a checkout rewrites `HEAD` there, so this
   * *should* refresh with nothing clicked — but every watcher assertion until
   * now has been about file edits, so "should" was doing the work. Driving a
   * real `git checkout` underneath the open panel is the only way to know.
   */
  const onFeature = await app.evaluate(
    `document.querySelector('.changes-branch')?.textContent ?? ''`
  )
  say('the panel names the branch you are on', onFeature.includes('feature'), onFeature)

  // -f, because the driver's own saves left the tree dirty and a plain
  // checkout refuses rather than clobbering them. Discarding is fine here: the
  // fixture's committed state is what the assertions below read.
  git('checkout', '-f', 'main')
  const switched = await waitFor(
    app,
    `(document.querySelector('.changes-branch')?.textContent ?? '').includes('main')`,
    'the panel follows a checkout'
  )
  const afterCheckout = await app.evaluate(
    `document.querySelector('.changes-branch')?.textContent ?? ''`
  )
  say('it follows a checkout with nothing clicked', switched, afterCheckout)

  /*
   * Ahead of an upstream, drawn rather than merely parsed.
   *
   * `origin/main` is a local ref pointed at the first commit — no network, but
   * `# branch.ab` reports against it exactly as it would for a real remote.
   */
  /*
   * Set through config rather than `--set-upstream-to`.
   *
   * There is no remote configured — `refs/remotes/origin/main` was written
   * with `update-ref` so the fixture needs no network — and `--set-upstream-to`
   * validates against the remote list and refuses. Writing the two config keys
   * is what that flag does anyway.
   *
   * The remote *url* is needed too, and that was the surprise: with only the
   * branch keys set, git prints no `# branch.upstream` and no `# branch.ab` at
   * all. The path never has to exist — nothing here contacts it — but the
   * remote has to be configured for tracking to be reported.
   */
  git('config', 'remote.origin.url', bare)
  git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
  git('config', 'branch.main.remote', 'origin')
  git('config', 'branch.main.merge', 'refs/heads/main')
  const drift = await waitFor(
    app,
    `!!document.querySelector('.changes-ahead')`,
    'the ahead count appears'
  )
  const counts = await app.evaluate(`(async () => {
    const id = document.querySelector('[data-workspace-tab]').dataset.workspaceTab
    const read = await window.chorus.readWorkspace({ conversationId: id })
    return {
      ahead: document.querySelector('.changes-ahead')?.textContent ?? '',
      behind: document.querySelector('.changes-behind')?.textContent ?? '',
      // What git actually reported, so a failure says whether the count is
      // missing or merely undrawn.
      status: { branch: read.status.branch, upstream: read.status.upstream, ahead: read.status.ahead, behind: read.status.behind },
    }
  })()`)
  say(
    'it shows how far the branch has drifted from its upstream',
    drift && counts.ahead.startsWith('↑'),
    JSON.stringify(counts)
  )

  git('checkout', '-f', 'feature')
  await waitFor(
    app,
    `(document.querySelector('.changes-branch')?.textContent ?? '').includes('feature')`,
    'back on feature'
  )

  /*
   * Source control, driven through the controls rather than the channel.
   *
   * The IPC is already covered by unit tests in `git-write.test.ts`. What is
   * unproven is the wiring: that a checkbox reaches `stage`, that the commit
   * box commits what is staged and nothing else, that discard asks first, and
   * that each one tells the room. Every wait below names the state it expects
   * rather than "something changed" — three assertions in this file have
   * already passed vacuously by waiting for a condition the previous step had
   * already satisfied.
   */
  await app.evaluate(`(() => {
    const select = document.querySelector('.changes-base select')
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    set.call(select, '')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  writeFileSync(join(repo, 'src/to-stage.ts'), 'export const STAGED = true\n')
  await waitFor(
    app,
    `[...document.querySelectorAll('.changes-file-path')].some((n) => n.textContent === 'to-stage.ts')`,
    'the new file is listed'
  )

  /*
   * Waits for the event rather than sampling for it.
   *
   * The append happens in main and the panel refreshes afterwards, so reading
   * the log the instant the UI moves is a race — it failed exactly that way
   * once. Same lesson as the render polls: wait for the condition, from Node,
   * and report the count that was actually there when it never arrived.
   */
  const countOf = (action) =>
    `(async () => {
      const id = document.querySelector('[data-workspace-tab]').dataset.workspaceTab
      const log = await window.chorus.history({ conversationId: id })
      return log.filter((e) => e.type === 'repo.changed.byUser' && e.payload.action === '${action}').length
    })()`

  const loggedOnce = async (action) => {
    for (let i = 0; i < 50; i++) {
      if ((await app.evaluate(countOf(action))) === 1) return { ok: true, count: 1 }
      await wait(200)
    }
    return { ok: false, count: await app.evaluate(countOf(action)) }
  }

  /* Stage, through the row's `+` button. */
  await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.changes-file')]
      .find((r) => r.querySelector('.changes-file-path')?.textContent === 'to-stage.ts')
    row?.querySelector('.changes-stage')?.click()
    return true
  })()`)
  const stagedShown = await waitFor(
    app,
    `[...document.querySelectorAll('.changes-group-name')].some((n) => n.textContent === 'Staged')`,
    'the staged group appears'
  )
  say('the + button stages the file', stagedShown)
  const stagedEvent = await loggedOnce('staged')
  say('staging is recorded in the log', stagedEvent.ok, `count ${String(stagedEvent.count)}`)

  /* Commit what is staged, through the message box. */
  await app.evaluate(`(() => {
    const input = document.querySelector('.changes-commit input')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(input, 'add the staged file')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.changes-commit').requestSubmit()
    return true
  })()`)
  const committed = await waitFor(
    app,
    `![...document.querySelectorAll('.changes-file-path')].some((n) => n.textContent === 'to-stage.ts')`,
    'the committed file leaves the list'
  )
  say('the commit box commits what is staged', committed)
  say(
    'the commit really landed, with its message',
    git('log', '-1', '--pretty=%s').trim() === 'add the staged file',
    git('log', '-1', '--pretty=%s').trim()
  )
  const committedEvent = await loggedOnce('committed')
  say(
    'the commit is recorded in the log',
    committedEvent.ok,
    `count ${String(committedEvent.count)}`
  )

  /* Discard, which asks first. */
  writeFileSync(join(repo, 'src/shared.ts'), 'ruined by hand\n')
  await waitFor(
    app,
    `[...document.querySelectorAll('.changes-file-path')].some((n) => n.textContent === 'shared.ts')`,
    'the ruined file is listed'
  )
  await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.changes-file')]
      .find((r) => r.querySelector('.changes-file-path')?.textContent === 'shared.ts')
    row?.querySelector('.changes-discard')?.click()
    return true
  })()`)
  const asked = await waitFor(
    app,
    `(document.querySelector('.changes-conflict')?.textContent ?? '').includes('cannot be undone')`,
    'discard asks first'
  )
  say('discard asks before destroying work, and names the file', asked)

  await app.evaluate(`(() => {
    const confirm = [...document.querySelectorAll('.changes-conflict button')]
      .find((b) => b.textContent.trim() === 'Discard')
    confirm?.click()
    return true
  })()`)
  const restored = await waitFor(
    app,
    `![...document.querySelectorAll('.changes-file-path')].some((n) => n.textContent === 'shared.ts')`,
    'the discarded file leaves the list'
  )
  say('confirming discard puts the file back', restored)
  say(
    'the file on disk is what git had',
    readFileSync(join(repo, 'src/shared.ts'), 'utf8').includes('RATE'),
    JSON.stringify(readFileSync(join(repo, 'src/shared.ts'), 'utf8').slice(0, 40))
  )
  const discardedEvent = await loggedOnce('discarded')
  say(
    'the discard is recorded in the log',
    discardedEvent.ok,
    `count ${String(discardedEvent.count)}`
  )

  /* Publish the branch, and read it back out of the remote. */
  await app.evaluate(`(() => {
    document.querySelector('.changes-commit .btn--go')?.click()
    return true
  })()`)
  const published = await waitFor(
    app,
    `document.querySelector('.changes-commit .btn--go')?.disabled === false`,
    'the publish finishes'
  )
  await wait(1_500)
  let onRemote = ''
  try {
    onRemote = execFileSync('git', ['log', '-1', '--pretty=%s', 'feature'], {
      cwd: bare,
      env,
      encoding: 'utf8',
    }).trim()
  } catch {
    onRemote = '(branch not on the remote)'
  }
  say(
    'publishing sends the branch to the remote',
    published && onRemote === 'add the staged file',
    onRemote
  )
  const pushedEvent = await loggedOnce('pushed')
  say('the push is recorded in the log', pushedEvent.ok, `count ${String(pushedEvent.count)}`)

  /*
   * Base back to `main`, because the block above switched it to the working
   * tree to exercise staging against plain uncommitted work — and the
   * assertion below is about the panel *remembering* a chosen base.
   */
  await app.evaluate(`(() => {
    const select = document.querySelector('.changes-base select')
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    set.call(select, 'main')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await wait(1_500)

  /* And that the choice survives the panel being closed and reopened. */
  await app.evaluate(`(() => {
    document.querySelector('.changes-head button[aria-label]')?.click()
    return true
  })()`)
  await wait(500)
  await app.evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'g', code: 'KeyG', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }))
    return true
  })()`)
  await wait(2_000)
  const kept = await app.evaluate(
    `document.querySelector('.changes-base select')?.value ?? '(no panel)'`
  )
  say('the chosen base survives closing the panel', kept === 'main', JSON.stringify(kept))
} catch (error) {
  /*
   * The app's own output, on the way out.
   *
   * Without this a run that dies mid-assertion reports only "timed out:
   * (async () => { const host = doc…" — the expression that was waiting, which
   * is never the thing that broke. A stability run that cannot say *why* it
   * failed is a stability run you have to do again.
   */
  say('the run completed', false, String(error).slice(0, 200))
  const tail = app.output().split('\n').slice(-40).join('\n')
  console.log(`--- app output (last 40 lines) ---\n${tail}\n--- end ---`)
} finally {
  await app.quit()
}
