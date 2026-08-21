# A window on the whole change

## The problem

Chorus can tell you what an agent said it did. It can tell you, once, on mount,
which files in the working tree differ from the index. It cannot tell you what
your branch actually contains.

The three questions a person asks before they trust a session's work are:

- **What has this branch done, against `develop`?** Not "what is uncommitted" —
  the whole branch, the thing that becomes a merge request.
- **What is the shape of this project?** Which directories exist, what is where.
- **Can I fix this one line myself?** Not by describing it to an agent and
  waiting a turn, but by typing it.

Chorus answers none of them. `ReviewPanel` (`ReviewPanel.tsx:34`) answers a
fourth, narrower question — index versus worktree, right now, in a modal sheet
that closes when you look away. Everything else means leaving the app, which is
the one thing the app exists to stop.

The gap is sharpest on the second half of the workflow. An agent finishes, you
want to review before pushing, and the review happens in VS Code or in
`git diff` in a terminal — so the session's own record of the work and your
judgement of the work never occupy the same window. Chorus becomes the place the
work was _ordered_, and something else is the place it was _read_.

## What exists today, precisely

Worth stating, because three of the four capabilities have more foundation than
it looks and one has none.

**Git.** `packages/workspace/src/git.ts` is the only file in the repo that runs
the git binary for the app, and it runs exactly three argument vectors:

```
['rev-parse', '--is-inside-work-tree']        :56
['status', '--porcelain=v2', '--branch']      :61
['diff', '--no-color', '--no-ext-diff']       :73   (+ --cached, + -- <path>)
```

No `log`, no `show`, no `merge-base`, no `rev-list`, no `fetch`, no
`for-each-ref`. `readDiff` (`:72`) takes `DiffOptions {staged?, path?}` — there
is no field for a revision and no call site that could pass one. Branch
awareness exists only as _reporting_: `parseStatus` reads `# branch.ab` into
`ahead`/`behind` (`status.ts:53-68`), counts against the upstream, not a diff
against an arbitrary base.

The package is read-only by explicit design, and the header says why
(`git.ts:9-19`): _"A convenience `git add` here would be a mutation with no
approval behind it."_ That constraint is right and this plan does not relax it.

A fourth vector lives outside the package —
`['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard']`
(`main/files.ts:87`), powering the composer's `@` menu. Flat list, no structure.

**The IPC boundary.** One channel carries git: `'workspace:read'`
(`shared/ipc.ts:898-941`), request `{conversationId}`, response
`{status, diff, problem}`. Contract-driven — `registerIpcHandlers`
(`main/ipc.ts:732`) loops `IPC_CONTRACT` and validates both directions, and the
preload re-validates. Adding a channel is three edits, all mechanical.

One defect to fix in passing: `DiffFile.status` (`'added' | 'removed' |
'modified' | 'renamed'`, `diff.ts:49`) is computed and then **dropped** — it is
absent from the response schema (`shared/ipc.ts:918-937`) and from the mapping
(`main/ipc.ts:609-624`). The renderer cannot distinguish an added file from a
renamed one, and `diff.ts:41-46` explicitly warns against inferring it.

**Writes.** The renderer has never written a byte into a project tree. Every
`writeFileSync` in main targets `userData` or the desktop. `resolveWithinRoot`
(`path-safety.ts:42`) — documented as _"The ONLY supported way to turn an agent-
or user-supplied path into a real one"_ — exists, is tested, and has **no
write-side caller**. This plan gives it its first.

**Forge.** Nothing. Zero hits for `octokit`, `api.github.com`, `glab`, or any
HTTP client across `apps/` and `packages/`. No token storage — no `safeStorage`,
no `keytar`, nothing. The `gh` calls in `.github/workflows/release.yml` are CI,
not app code.

**The tree.** Nothing. No tree widget, no directory listing IPC, no editor
component. `@xterm/xterm` is the only third-party view widget in the app.

## The shape of the answer

One docked panel per session, the same shape as the terminal, holding three
views over one shared idea of "the change": a **tree**, a **diff**, and an
**editor**. Four decisions were taken before writing this; each is argued below
rather than recorded.

### The forge should be `gh` and `glab`, not an HTTP client

This is the one place where the obvious design is wrong, and the research is
what showed it.

Listing merge requests means authenticating to GitLab. The obvious route is an
HTTP client and a token, which means: a settings screen for the token, a
`safeStorage` encrypted blob (the app's **first secret at rest**), a refresh
story, a rate-limit story, a self-hosted-instance URL field, and a second one
for GitHub. That is a new trust surface, on an app whose entire premise is that
it holds no credentials.

But Chorus's founding sentence is _"Chorus **drives** the user's installed
`claude` and `codex` CLIs — it does not replace them."_ The same person almost
certainly has `gh` or `glab` installed and already authenticated, and both speak
JSON:

```
gh pr list --json number,title,headRefName,baseRefName,url,isDraft
gh pr diff <n> --patch
glab mr list -F json
glab mr diff <n> --raw
```

So the forge integration is **a fifth and sixth argument vector next to the
three git ones** — `execFile`, argument arrays, no shell, timeout, `maxBuffer` —
and it inherits the user's existing login, their SSO, their self-hosted host
config, and their token rotation, for free. Chorus stores no secret, and the
degraded path is honest and cheap: `gh` missing or logged out produces a
`state: 'unavailable'` exactly like `files:complete` already does
(`shared/ipc.ts:556`).

If a forge feature later genuinely needs something no CLI exposes, that is the
moment to argue for a token — not before.

The diff for a PR/MR is then a _choice of base_, not a separate machine. `gh pr
list` gives `baseRefName`; the diff you render is the same
`origin/<base>...HEAD` we already compute locally. The forge supplies **titles,
numbers, review state and the base ref**; git supplies the bytes.

### A docked panel, not a new tab kind

The screenshot's shape — files as tabs beside the conversation — is the
expensive one. `WorkspacePane.tabs` is `z.array(z.string())` of conversation ids
(`workspace-layout.ts:28`), and that assumption is spread across thirteen
functions in `layout.ts`, the store's `ingestEvents` visibility check
(`store.ts:588`), `EditorPane`'s `sessions.get` lookup (`Workspace.tsx:700`),
`PaneTabStrip`'s `flatMap` that silently drops unknown ids (`:761`), the whole
keyboard handler, and `useTabDrag`. Worse, `reconcileWorkspace` (`layout.ts:606`)
**deletes any tab that is not a known conversation id on every launch** — a file
tab would vanish at startup until that is taught otherwise.

And `workspace-layout.ts:79-95` carries a warning written from a real incident:
a _required_ new field makes `parseOpenSessions` fall through to the legacy path,
which also fails, and every open conversation is silently lost.

The terminal already solved this problem. `TerminalPanelState` sits in
`WorkspaceSnapshot.terminals` keyed by conversation id
(`workspace-layout.ts:142`), the roster persists, `editSession` funnels every
edit through `normalizeTerminalPanel` so the invariant is repaired rather than
assumed, and `⌘J` toggles it from a document-level handler even when nothing is
mounted. A `changes` record beside `terminals` is the same shape, one file's
worth of schema, and no migration risk.

So: **`⌘⇧G` opens a Changes panel** docked in the session, siblings with the
terminal dock. If it earns a place in the pane grid later, that is a second plan
with the discriminant work done deliberately.

### Monaco, and the house rule it has to answer to

CLAUDE.md says the markdown parser and highlighter are hand-written on purpose,
and that `@xterm/xterm` is an exception _"whose reason does not generalise"_.
Monaco has to answer that, not sidestep it.

It answers it the same way xterm did. The stated test is whether the mistakes
are cosmetic or structural: a hand-rolled markdown parser gets a paragraph
slightly wrong, so it stays hand-rolled; a hand-rolled VT emulator gets `vim`
wrong, so it does not. A hand-rolled _text editor_ is squarely the second kind —
undo/redo across composed IME input, bidi text (this app ships RTL locales and
`MarkdownView` sets `dir="ltr"` on code for exactly that reason), selection
across folded regions, virtualised rendering of a 20k-line file. Those are not
cosmetic, and the failure mode is data loss in a buffer the user is editing.

Two costs are real and are accepted:

- **~5MB and a worker farm.** Monaco's language services run in web workers.
  `sandbox: true` and `webSecurity: true` are set (`main/index.ts:58-64`), so
  the workers must be bundled assets with real URLs, not `blob:` — an
  electron-vite configuration task with a known answer, and the first phase that
  touches it has to prove it in the packaged app, not just `pnpm dev`.
- **A second theme system.** Monaco does not read CSS custom properties. The app
  ground colour has to be pushed into `monaco.editor.defineTheme` and
  re-pushed on `prefers-color-scheme` change — precisely the trap
  `TerminalView.readTheme` (`TerminalView.tsx:28`) already handles for xterm,
  and precisely the bug CLAUDE.md records where the terminal drew on black in
  both schemes. Copy the xterm solution; do not invent a second one.

`highlight.ts` stays exactly as it is. It serves the transcript, where its
mistakes _are_ cosmetic. Monaco serves the editor. They do not merge.

### Human edits are conversation events

A file edited in Chorus by the person is not the same as a file edited by an
agent, and the difference matters to the _other_ agent. An agent that read
`src/auth.ts` at the start of a turn and is composing a patch against it needs
to know the human changed it underneath, or it will overwrite the fix with a
stale rewrite and neither party will know why.

That is the exact test CLAUDE.md sets for the log: not "is it interesting" but
"does a consumer act on it". `catchup.ts` acts on it. So this is a
`ChorusEventPayload` and takes the full five-file change — event union,
store schema, the `conversation-service` case, a projection (or an argued no-op),
and a `catchup` decision that is emphatically _not_ a no-op.

The approval engine, by contrast, does **not** gate it. The engine exists to
decide what an _agent_ may do on the user's behalf; a person editing their own
file on their own machine has already given the only consent that exists. What
the engine's containment primitive is for is the path: every write resolves
through `resolveWithinRoot` against the conversation `cwd`, so a `../../..` in a
path — however it got there — cannot escape.

## Phases

### Phase 1 — Git learns what a base ref is

`packages/workspace` only, no UI. `DiffOptions` gains `base?: string`.
`readDiff` gains a revision form, and it must be the **three-dot** form after an
explicit `merge-base` — two-dot against a moving `develop` shows you the base
branch's own advances as if they were yours, which is the review-noise failure
everyone has met. Note the symmetry with the trap CLAUDE.md already records:
three dots is wrong for `git diff main...HEAD -- <file>` as a "does this match
main" test, and right here, because here the merge base is genuinely what you
want to compare against.

New vectors: `['merge-base', base, 'HEAD']`, `['for-each-ref', ...]` for the
base picker (the UI cannot offer `develop` if nothing can enumerate branches),
and a deliberately separate `['fetch', '--quiet', remote, ref]` behind an
explicit user action — never on a timer, because a background fetch on someone
else's repo is a surprise.

Also in scope, because it is a two-line fix in the same files: stop dropping
`DiffFile.status` at the IPC boundary.

**Exit:** unit tests over a fixture repo prove base-diff, merge-base behaviour
on a moved base, branch enumeration, and that a bad ref returns a `GitError`
rather than throwing. Nothing renders yet.

### Phase 2 — The Changes panel exists

`WorkspaceSnapshot.changes: Record<conversationId, ChangesPanelState>` — every
field defaulted, per the `workspace-layout.ts:79-95` warning. Store actions via
the `editSession`/`normalizeTerminalPanel` pattern. `⌘⇧G`. Content is the
existing `FileDiff` (`FileDiff.tsx:39`, reusable as-is via `DiffFileView`) and a
file list lifted from `ReviewPanel.tsx:97-118`, plus the new base picker.

Two things to get right here rather than later:

- **`hooks.ts`'s `selectActions` destructures every action twice** (`:44`). A new
  action missing from the second list is silently dropped, with no type error.
- **Freshness.** `ReviewPanel` reads once on mount and never again, which is why
  it is always slightly wrong. Workspace status is the textbook _state, not
  history_ value — stale-on-read is worse than absent — so it gets a
  `'workspace:changed'` push channel modelled on `'agents:limits'`
  (`shared/ipc.ts:1253`), debounced, driven by a watcher on the repo. It is
  **never** appended to the log.

**Exit:** open the panel on a real branch, switch base between `develop` and
`main`, see the diff change; edit a file in an external editor and watch the
panel update without a click.

### Phase 3 — Monaco renders the diff

Read-only `DiffEditor` first, because it is the highest value and the lowest
risk. Bundle the workers, prove them in a **packaged** build (`pnpm
app:install`), and bridge the theme from the app's CSS tokens the way
`readTheme` does for xterm, including the `matchMedia` listener.

Keep `FileDiff` alive behind the panel's own toggle rather than deleting it —
it is still the right thing inside `Entry.tsx:184` for a per-turn patch, and
having both proves the Monaco path can be turned off if the packaged build
misbehaves.

**Exit:** a 5k-line file diffs without jank in the packaged app; both colour
schemes correct on a cold start and on a live scheme switch.

### Phase 4 — The file map

A `'workspace:tree'` channel: lazy, one directory per call, containment through
`resolveWithinRoot`, `.gitignore` respected by leaning on git rather than
reimplementing it. Tree UI in the panel's left column, selection shared with the
diff list so clicking a changed file in either place selects it in both.

**Exit:** navigate to a file `git status` does not mention, open it, read it. A
symlink pointing outside the root is refused.

### Phase 5 — The edit lands

`'workspace:write'`, `{conversationId, path, content}`, resolving through
`resolveWithinRoot`, temp-file-plus-rename like `settings.ts:161`. Monaco goes
editable, `⌘S` saves.

Then the five-file event change for `file.edited.byUser` — carrying path,
timestamp and a line-count delta, **not the content** (C-021's unsolved half is
exactly about storing what was read, and a file body in the log is that problem
with the volume turned up). Plus the `catchup.ts` arm that tells the other agent,
which is the entire reason the event exists.

**Exit:** prove the catch-up arm fires — edit a file mid-turn and show the other
agent is told. A test that only asserts the row landed in SQLite has not tested
the thing that matters.

### Phase 6 — The forge

`gh`/`glab` detection and a `'forge:list'` channel returning
`{state: 'ready' | 'unavailable' | 'unauthenticated', items}`. The panel's base
picker gains a PR/MR section; choosing one sets the base ref to its
`baseRefName` and shows title, number and review state. The diff still comes
from local git.

**Exit:** on a real MR, the panel shows the same file set as the GitLab web UI.
With `glab` uninstalled, the panel degrades to the local base picker with a
readable notice and no error dialog.

## What we are deliberately not doing

- **No forge tokens, no OAuth, no `safeStorage`.** Argued above. If this is ever
  revisited, it is a plan of its own with a threat model in it.
- ~~**No writing to the index, no commits, no push, no MR creation.**~~
  **Reversed on 2026-08-19, deliberately.** This said the panel was
  read-plus-edit-a-file, and that "Chorus committed something I did not review"
  is unrecoverable in a way a bad file save is not. The product decision went
  the other way: the panel now stages, commits, pushes and discards, because a
  window on the change that cannot act on it sends you back to a terminal for
  the last step.

  What the original argument bought is kept rather than discarded. `git.ts` is
  still read-only and still says so; every mutation lives in `git-write.ts` and
  has to be imported by name. No adapter imports it, so **an agent cannot reach
  any of it** — these are buttons a person presses. `--force` is refused with no
  way to ask for it, since a force-push is the irreversible action the
  permission engine's own rule names. Discard is the only operation that
  destroys work and the only one behind a confirmation that names the file.
  Every action appends `repo.changed.byUser`, so `catchup.ts` can tell the other
  agent when its work was thrown away.

  MR creation is still out: it needs the forge, which is Phase 6.

- **No file tabs in the pane grid.** The docked panel is the answer until it
  demonstrably is not.
- **No LSP, no IntelliSense, no go-to-definition.** Monaco can host a language
  server; hosting one means owning its lifecycle, its crashes and its indexing
  cost. Syntax and editing only.
- **No replacement of `ReviewPanel` in this plan.** It becomes redundant once
  Phase 2 lands and should probably go, but deleting a reachable surface is its
  own change with its own regression risk. Worth a BOARD entry rather than a
  quiet deletion. (`HistoryPanel` is separately already unreachable —
  `setShowingHistory(true)` is never called — which is a second BOARD entry, not
  this plan's business.)
- **No conflict resolution UI.** Merge conflicts are a different problem with a
  different interaction model.

## Open questions and risks

- **Monaco's workers under `sandbox: true`.** The stated cost of Phase 3, and
  the one that could invalidate the choice. If bundled workers cannot be made to
  load in the packaged app, the fallback is CodeMirror 6 — smaller, no worker
  requirement — and the phase should stop and re-argue rather than reach for
  `webSecurity: false`. That mitigation is prohibited, not merely discouraged.
- **What happens when the human edits a file an agent is mid-write on.** Phase 5
  tells the agent after the fact. It does not lock, and last-write-wins is
  probably right for a local-first tool, but "probably" is doing work in that
  sentence and it should be settled before the phase ships.
- **Whether the base ref should persist per conversation.** A session on a
  feature branch almost always wants `origin/develop`, but "almost always" is
  how a wrong default gets shipped. Cheap to persist in `ChangesPanelState`;
  the question is whether it should be _inferred_ from the forge's
  `baseRefName` once Phase 6 exists.
- **The watcher's cost.** A repo watcher on a large tree is not free, and
  `better-sqlite3` is synchronous on the main thread — a chatty watcher during a
  `pnpm install` competing with delta writes is a plausible stall. Debounce hard,
  and measure before assuming.
- **Panel state versus `SessionCarry`.** Only the active tab of each pane is
  mounted, so anything in a `useState` inside the panel dies on a tab switch —
  the same reason `reviewing`/`summarising` reset today. Scroll position and
  the selected file want to survive; selection likely belongs in the store next
  to the roster, but if any of it belongs in `SessionCarry` then `carry.ts`'s
  `trimCarry` budget has to be considered too.
