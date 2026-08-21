# Status

## Phase 1 — Git learns what a base ref is · shipped 2026-08-19

`packages/workspace` can now answer "what has this branch done since it left
`develop`", and the IPC boundary stopped dropping a field it was computing.

**What landed**

- `readMergeBase`, `readBranchDiff`, `readBranches`, `fetchRef`, `isSafeRef` in
  `packages/workspace/src/git.ts`.
- `DiffOptions` gained `from` / `to`; `readWorkspace` gained `base` /
  `committedOnly` and now returns `comparison: {base, mergeBase} | null`.
- `DiffFile.status` now crosses the IPC boundary — `shared/ipc.ts` schema and the
  `main/ipc.ts` mapping.
- `packages/workspace/src/git.test.ts`, the first test this file has ever had:
  22 cases against a real fixture repository.

**Three things differ from the plan, and the plan was wrong about them**

1. **The plan said `DiffOptions` gains `base?`.** It gained `from?`/`to?`
   instead, raw revisions passed straight through, with merge-base resolution
   living in `readBranchDiff` above it. `readDiff` is a thin wrapper over one git
   invocation; folding a second round-trip inside it would have made a function
   whose name promises one command quietly run two.

2. **`isSafeRef` is not in the plan at all.** Writing the ref plumbing surfaced
   that an argument array stops shell injection but not _argument_ injection:
   `git diff --output=/tmp/x` writes a file, so any unvalidated ref reaching git
   is a write primitive — in a package whose whole design claim is that it never
   writes. This was confirmed empirically, not reasoned about: deleting the guard
   makes the test fail because the file really is created. Refs are now validated
   against git's own refname grammar before every use.

3. **`readWorkspace` took its `base` parameter now rather than in Phase 2.** The
   plan put it in the IPC phase, but the package half is package work; doing it
   here means Phase 2 touches only the boundary.

Also unplanned: `git()` now surfaces git's own stderr rather than `execFile`'s
`Command failed: git diff …` preamble, so a bad base reads as
`fatal: bad revision 'origin/develop'` — the sentence that actually tells someone
to fetch.

**Verified**

- `pnpm check` green: 18 typecheck tasks, eslint, prettier, 1996 tests.
- **Mutation-proved, not just passing.** Swapping the merge base for the base tip
  (two-dot) fails 4 tests, including the one asserting that a commit `main` took
  after the branch was cut does not appear in the branch's diff. Removing the ref
  guard fails the injection test and leaves a real file on disk.
- Recorded as a known limit with a test: `git diff` never lists untracked files,
  so the panel must read those from status. Better a documented fact than a
  surprise in Phase 2.

**Not verified**

Nothing in the app exercises any of it. No UI, no IPC request carries `base`
yet, and no renderer reads the `status` field now being sent. Phase 1 was never
going to be visible — but that means "it works" currently rests on the unit
tests alone, and the app has not been driven.

_(Closed by Phase 2, which drives all of it against the real app.)_

## Phase 2 — The Changes panel exists · shipped 2026-08-19

A docked panel per session, `⌘⇧G`, with a base picker, and it stops going stale.

**What landed**

- `ChangesPanelState` + `changes` on `WorkspaceSnapshot`, every field defaulted;
  `normalizeChangesPanel`, pruning in `reconcileWorkspace`, five store actions,
  `useSessionChanges`.
- `ChangesPanel.tsx`, mounted in `Session` above the terminal, reusing
  `FileDiff` and the file-list shape from `ReviewPanel`.
- `workspace:read` gained `base`/`committedOnly` and returns `comparison`; new
  `workspace:branches` and `workspace:fetch`; new `workspace:changed` push.
- `workspace-watch.ts` — a debounced repository watcher in main, started on the
  first `workspace:read` for a conversation and released when it closes.
- `changes-panel.test.ts` (13 cases) and `e2e/changes-panel.mjs` (8 assertions).

**What differs from the plan**

1. **The push carries an id and nothing else.** The plan said "modelled on
   `agents:limits`", which carries data. This cannot: each panel chooses its own
   base, so main does not know what to recompute. "Something moved" lets every
   panel re-ask for what it is actually showing, and no diff runs when no panel
   is open.
2. **The watcher is lazy, not per-conversation-at-open.** Most sessions never
   have the panel opened, and a recursive watch on a tree with `node_modules` is
   not free. The first `workspace:read` is the evidence that someone wants one.
   On Linux it degrades to `.git` only — `fs.watch`'s `recursive` is macOS and
   Windows — which is stated in the file rather than discovered later.
3. **`App.tsx`'s persistence write was rebuilt, not extended.** It typed out
   seven snapshot fields by hand, so `changes` would have been silently never
   persisted — the _exact_ defect the `SNAPSHOT_KEYS` comment records about
   `terminals`. It now calls `workspaceSnapshot`, so the next field cannot repeat
   it. Two other literals had the same shape and were caught by the typechecker.

**Verified — driven against the real app**

`node apps/desktop/e2e/changes-panel.mjs` builds a repository whose branch left
`main` before `main` moved on, then asserts, all passing:

- `⌘⇧G` is handled — measured as `defaultPrevented`, not by counting panels,
  because C-027 is exactly the test that cannot fail.
- The working tree shows only uncommitted work.
- Switching the picker to `main` lists what the branch did and **excludes what
  `main` did after the branch was cut** — the whole point, now proved through
  the UI as well as in `git.test.ts`.
- The footer names the baseline: `Against main, from where this branch left it
(8dc5e8a)`.
- **A `git add` from outside the app reaches the panel with nothing clicked.**
  The watcher works.
- The chosen base survives closing and reopening the panel.

Also mutation-proved: deleting `changes` from the store's hand-written
`snapshot()` fails the persistence test.

**Not verified**

- **Nothing has run on Windows or Linux.** The watcher is the part that differs
  by platform, and the Linux path — `.git` only, no recursive worktree watch —
  has never executed.
- **The watcher's cost is unmeasured**, which the plan asked for and this did not
  do. It has only run against a three-file repository; a recursive FSEvents watch
  on a large tree competing with `better-sqlite3` on the main thread is still a
  plausible stall, and remains an open question rather than a resolved one.
- No `ReviewPanel` removal, no light-mode check of the new CSS, and the panel has
  not been used at a real window size for a long session.

_(Light mode closed by Phase 3, which asserts both schemes against the rendered
colour.)_

## Phase 3 — Monaco renders the diff · shipped 2026-08-19

Whole files in a real editor, read-only, **proved in the packaged app**.

**What landed**

- `readFileAt` + `FileVersion` + `MAX_EDITOR_BYTES` in `packages/workspace`;
  five more cases in `git.test.ts`.
- `apps/desktop/src/main/file-versions.ts` — assembles both sides, working-tree
  copy read through `resolveWithinRoot`.
- `workspace:fileVersions` channel and `FileVersionShape`.
- `monaco-setup.ts` (worker, themes, language lookup), `MonacoDiff.tsx`,
  a `view: 'editor' | 'hunks'` toggle on the panel, `worker.d.ts`.
- Driver extended to 15 assertions and taught `--packaged`.

**The risk this phase existed to settle**

**Monaco's worker loads in the packaged bundle.** No `blob:` anywhere in the
output, no CDN, `sandbox: true` and `webSecurity: true` untouched. The full
driver passes against
`release/mac-arm64/Chorus.app/Contents/MacOS/Chorus`, not only against `out/`.
CodeMirror 6 is not needed and the fallback is not taken.

**What differs from the plan**

1. **Monaco needs whole files, and the plan did not account for it.** The panel
   had hunks; a `DiffEditor` aligns two complete texts. That is a git read
   (`git show <mergeBase>:<path>`) and an IPC channel that were not in the
   phase, and they are most of its weight. It is also a better view than
   planned: the diff scrolls through the rest of the file rather than stopping
   at three lines of context.
2. **The import path is not the documented one.** Monaco 0.56's `exports` map is
   `"./*": "./esm/vs/*.js"`, so the `monaco-editor/esm/vs/editor/…` form every
   recipe still shows resolves to `esm/vs/esm/vs/…` and fails. `editor.api` plus
   `basic-languages/monaco.contribution` — grammars, no language servers.
3. **`view` is a persisted toggle, not a replacement.** `FileDiff` stays
   reachable, so a future Monaco failure leaves the panel usable.

**One real bug, caught only by measuring**

The first packaged run had Monaco mounted, `monaco-diff-editor` in the DOM, the
theme correct — and **zero diff decorations**. The cause was not the worker: the
host element had `height: 0`, because no CSS rule ever gave it one. Monaco draws
nothing into a zero box and its own diff computation rejects with `no diff result
available`. Every check short of reading `getBoundingClientRect().height` passed,
including "the editor mounted" and "the theme applied". The assertion that caught
it counts insert/delete decorations, which is the only DOM evidence the worker
actually ran.

**Verified — packaged app, 15/15**

Beyond Phase 2's assertions: Monaco mounts; the worker computes a diff
(`+2` decorations); the editor paints on the app surface; **both colour schemes
correct on a live `prefers-color-scheme` switch**, read as rendered colour and
compared to each other rather than by checking a token resolved; a **5,000-line file lays out** (see the correction in Phase 5: the figure first recorded here was measuring the wrong file); the hunks fallback still renders.

**Not verified**

- **The bundle grew from 1.7MB to 6.6MB** for the main chunk (7.9MB of renderer
  assets total, 85 chunks — the grammars code-split and load per language). That
  is the cost the plan accepted, but nobody has measured its effect on cold
  start, and no budget is enforced anywhere.
- Still nothing on Windows or Linux.
- Read-only is untested against a file with mixed encodings or CRLF, and the
  `tooLarge` and `binary` paths have unit tests but have never been seen on
  screen.

## Phase 4 — The file map · shipped 2026-08-19

A lazy tree beside the changed-files list, sharing one selection.

**What landed**

- `packages/workspace/src/tree.ts` — `readDirectory`, one directory per call,
  `.gitignore` honoured by asking `git check-ignore`; `tree.test.ts`, 8 cases.
- `workspace:tree` channel; `column` and `expanded` on `ChangesPanelState`,
  both defaulted, `expanded` capped at `MAX_EXPANDED`.
- `FileTree.tsx` — flat rows with a depth indent rather than nested lists.
- The panel's left column became a switch over two lists; **selection is now a
  path rather than a diff entry**, so a file with no diff can be opened.

**What differs from the plan**

1. **Empty is a state of the column, not the panel.** The plan said "tree UI in
   the left column" and nothing more, but the existing code replaced the _whole
   body_ when the diff was empty — which would have hidden the tree exactly when
   a clean repository makes it most useful.
2. **`.gitignore` is asked per directory, not resolved once.** `check-ignore`
   with `--stdin` takes the whole listing in one call, so the cost is one git
   invocation per expansion rather than per entry.
3. **Expansion persists; the listings do not.** Which directories are open is a
   decision, and worth restoring. What is inside them is a cache of the disk,
   and restoring a months-old listing would be worse than re-reading.

**Three bugs, all mine, all found by running it**

1. **`execFile` has no `input` option** — that belongs to `execFileSync`. I
   passed one behind a type cast, so `git check-ignore` waited on a stdin nobody
   closed and every call hung to its timeout. The cast is what hid it; the fix
   writes to `child.stdin` through the promise's `child`.
2. **A poll that stopped at "any content"** read the _previous_ file, twice,
   reporting `big.ts` under an assertion about `never-touched.md`. Polling for
   the expected text is the only condition that means what the assertion says.
3. **Monaco renders spaces as U+00A0** inside a view line, so comparing against
   ordinary spaces never matched — and the two are indistinguishable in any log
   you print. The assertion normalises before comparing.

Two earlier "failures" in this phase were neither: the decoration and
colour-scheme reads were fixed sleeps that lost a race on a loaded machine. Both
now poll for the condition. A new assertion measures the editor's box directly,
so the zero-height failure Phase 3 hit reports itself by name instead of as
"no decorations".

**Verified — packaged app, 23/23**

`node apps/desktop/e2e/changes-panel.mjs --packaged <path>`: the tree lists the
root, hides `node_modules` and `*.log`, never lists `.git`, expands on demand,
**opens a committed file that appears in no diff at any base and reads its
contents**, marks it as unchanged rather than as a diff, and **refuses a symlink
pointing outside the project**.

**Not verified**

- **No keyboard navigation in the tree.** It is a list of buttons: Tab reaches
  them, arrows do not. The flat-row structure was chosen to make a roving
  `tabIndex` possible, and then it was not written.
- A directory with thousands of entries has never been opened — the listing is
  not virtualised, so one `readdir` of a large flat directory renders every row.
- Nothing on Windows or Linux, and the watcher does not notice a file created in
  a directory the tree has already listed unless git also sees it.

## Phase 5 — The edit lands · built, one decision outstanding

`⌘S` saves through the only write path this app has, and the room is told.

**What landed**

- `workspace:write` + `main/file-write.ts` (`resolveWithinRoot`, temp-file plus
  rename) and `file-write.test.ts`, 11 cases.
- `file.edited.byUser` through its five files: the store schema, an argued no-op
  projection, the `catchup.ts` arm, `transcript.ts`, and the recap ledger in
  `runtime.ts` — which the exhaustiveness linter caught and I had missed.
- `runtime.writeUserFile` is the **only** method that writes a tree, and it
  appends the event beside the write, so nothing can land one without the other.
- Monaco's modified side is editable; the original never is.

**Mutation-proved**

Deleting the catch-up arm fails 2 tests. Removing `resolveWithinRoot` from the
write lets all three escapes through — `../`, a symlink, and an absolute path —
and really does overwrite the file outside the project.

**The stability run, and what it found**

Two consecutive clean runs, 27/27 each. Getting there took three fixes, and only
the first was a test problem:

1. **In-page polling hangs.** I had replaced fixed sleeps with
   `await new Promise(r => setTimeout(r, 100))` loops inside `Runtime.evaluate`.
   Chromium throttles timers in a window the compositor considers occluded, so a
   15-second loop took minutes and the evaluate never returned — the run died
   naming the expression that was waiting, which is never the thing that broke.
   All four polls now wait through the harness's `until`, from Node. The
   harness's own `settle` carries this warning about `requestAnimationFrame`; I
   walked into the same trap one API over.
2. **The driver threw away the app's output.** A run that dies mid-assertion now
   prints the last 40 lines of the app's own stderr, because a stability run
   that cannot say _why_ it failed is one you have to do again.
3. **Three assertions were passing vacuously**, and the stability run is what
   exposed them — not by failing, but by producing numbers that could not be
   true. `until` checks its condition immediately, so a wait for "any view line"
   or "any decoration" was already satisfied by the _previously selected file_
   still on screen. The tells were a 5,000-line file laying out in 3ms, and a
   decoration count that read `+4 −3` on three runs and `+2 −0` on a fourth for
   a diff that cannot change between runs.

   Fixing it took three attempts, each a version of the same mistake: `export
const N` is a prefix of shared.ts's own `export const NAME`; then `N2500` is
   never in the DOM at all, because Monaco virtualises and only the first
   screenful of lines exists. A marker has to be unique to the file **and**
   near its top. Both numbers are now stable across runs — `+2 −0`, and ~206ms.

   **This corrects Phase 3 above**, which claimed a 5,000-line file lays out in
   ~110ms. That figure measured the file already on screen. The real one is
   ~206ms, and it was not measured at all until now.

4. **My own guard was a real bug**, and the stability run is what caught it. The
   unsaved-edit guard added at the end of the build compared the _buffer_
   against what was loaded. That reads as "don't clobber typing" and is not: it
   also blocked the legitimate first update, so Monaco drew an editor with no
   decorations and sometimes no lines. Bisected by disabling the guard — 27/27
   clean with it off, 24/3 with it on. It now compares the _incoming text_
   against what was loaded, which skips the no-op re-reads the watcher causes
   without ever blocking a real change.

**Not verified, and one thing not decided**

- **The concurrency policy is unanswered, and the code currently does
  last-write-wins by omission** — the write reads nothing before overwriting.
  Whether a save should be refused when the file moved underneath it is the
  question the plan raised and it is still open. Nothing here should be read as
  having settled it.
- The catch-up arm is proved by unit test, not by driving two live agents: no
  run has shown a real agent receiving the line mid-turn.
- Nothing on Windows or Linux.

## Phase 6 — Source control · shipped 2026-08-19

Stage, unstage, commit, push, discard — from the panel, driven by the person.

**This reverses the plan's own "deliberately not doing".** That entry is struck
through and rewritten rather than deleted; the argument it made is still what
shapes the implementation.

**What landed**

- `packages/workspace/src/git-write.ts` — its own file, so `git.ts` stays
  honestly read-only and every mutation has to be imported by name. No adapter
  imports it, so **no agent can reach any of it**. 15 tests against real
  repositories.
- `repo.changed.byUser` through its five files, with the `catchup.ts` arm that
  tells the other agent when its work was discarded. Staging and unstaging are
  in the union but deliberately not replayed — they move nothing on disk.
- `workspace:git`, `runtime.runGitAction`, and the panel UI: per-file
  checkboxes, staged/unstaged groups, a commit box, Push/Publish, and discard
  behind a confirmation that names the file.
- `changed-files.ts` — reconciles the diff with status. Needed because `git
diff` never lists untracked files, so without it the panel could not stage a
  new file at all, which is most of what staging is for. 6 tests.
- `changes-tree.ts` — the changed files as a folder tree, single-child chains
  compacted. 8 tests.
- The branch's drift from its upstream (`↑1`) is drawn, not merely parsed.

**Three things worth keeping**

1. **`--force` is refused with no way to ask for it.** A force-push is the
   irreversible action the permission engine's own universal-deny rule names,
   and a button for it in a side panel is how someone loses a colleague's
   commits.
2. **Commit is never `-a`.** The panel shows a staging area; committing
   something it is not showing is the surprise that loses trust in the feature.
   A test pins it.
3. **Discard is two commands, not one.** `git restore` cannot touch an
   untracked file, so a discard that only restored would silently leave new
   files behind and read as "discard did not work". The tracked/untracked split
   is computed from status inside `discard`, so a renderer cannot get it wrong
   and delete something it meant to revert.

**Verified — 45/45, twice, identical assertion sets**

All eleven source-control assertions passed on their first run, driven through
the controls rather than the channel: a checkbox stages, the commit box commits
what is staged and the commit really lands with its message, discard asks first
and then puts the file back on disk, and **publishing sends the branch to a real
bare remote the assertion reads back out of**. Each one is recorded in the log.

**A regression the driver caught immediately**

Rewriting the panel's render to add the commit box put Monaco in a zero-height
box for the **third** time — the height rules reached `.changes-diff` as a
direct grid child of `.changes-body`, and the new `.changes-right` wrapper broke
that. The difference this time is that it was reported as _"the editor has a box
to draw into — host 0px"_ rather than as "no decorations", because Phase 4 added
that assertion for exactly this. It cost one run instead of an investigation.

Also caught: turning a file row from a button into a div broke three older
`.click()` calls, and the i18n test refused a half-plural — `discardConfirm`
with a `_other` and no `_one`.

**Not verified**

- Nothing on Windows or Linux, still.
- No packaged run since source control landed.
- Push is proved against a local bare repository. Nothing has been sent over a
  network, so authentication, a rejected non-fast-forward, and a protected
  branch are all untested.
- The recap ledger deliberately ignores `repo.changed.byUser`, including
  `discarded` — which _removes_ work and would need matching against what the
  ledger already claims. Left out rather than counted wrongly; see the comment.

**Packaged, twice**

`--packaged …/Chorus.app/Contents/MacOS/Chorus`, two consecutive runs, 27/27
each. The assertion-label hash is identical to the two `out/` runs, so the
bundle runs the same 27 checks to the same outcomes rather than a subset — which
is the thing worth knowing, since `pnpm dev` and the bundle load different files
and Monaco's worker is exactly the asset that can differ between them. The two
measurements that were unstable before the driver was corrected are steady
across all four runs: `+2 −0` decorations, and 204-209ms for the 5,000-line
file.

## Phase 7 — The transcript's diffs, coloured · shipped 2026-08-19

Asked whether the chat diffs could use the same component as the panel. The
answer is no, and the number is why.

**Measured before deciding.** One Monaco diff editor is **304 DOM nodes**
against the hunk renderer's **43** for the same one-line change — 7.1×.
`ToolPatch` is "open by default and with nothing to click", so the transcript
draws _every_ patch inline: a turn with fifteen edits would carry fifteen
editors, their model pairs and their observers, in a list that re-renders on
every streamed delta. One throwaway probe settled a question that reasoning
would have got wrong in either direction.

**What the request actually wanted was the colour.** The panel's diff is
highlighted and the transcript's was monochrome — that is the visible
difference, and it needs no editor. `FileDiff` now renders each line through
`CodeRun`, the same highlighter the transcript already uses for code blocks, and
takes an optional `path` to pick the grammar. Both call sites pass it; a caller
that does not know the path still renders, in `generic`.

The cost of that is measured too: 43 → **67 nodes**, a token span per run. Under
a quarter of Monaco's weight, and the driver asserts the tokens are really there
rather than trusting the change.

**Not verified, and one thing not resolved**

- **The driver flaked once in four runs** after this change: two Monaco
  assertions failed together — the 5,000-line file and the unchanged-file read —
  and three consecutive runs then passed. **Not root-caused.** Those assertions
  now report what was on screen (the selection, whether the editor mounted, the
  first view lines) instead of only naming the expression that timed out, so the
  next occurrence should say what is wrong rather than that something is.
- `FileDiff` does not window large hunks. A file entirely new relative to the
  base renders every line: `big.ts` against `main` draws 5,000 rows and ~20,000
  token spans. The rows were always there — this is pre-existing — but
  highlighting multiplies the nodes per row, so the ceiling is lower than it was.
