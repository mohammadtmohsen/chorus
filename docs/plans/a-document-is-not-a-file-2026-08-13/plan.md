# A document is not a file

## Status

| Phase                                              | State                                             |
| -------------------------------------------------- | ------------------------------------------------- |
| 0 — make the extension say why, and be installable | implemented — pending your check in a real window |
| 1 — stop forgetting the selection                  | implemented — five tests red on the old code      |
| 2 — one root list per Chorus process               | not started                                       |
| 3 — resolve a document, not a file                 | not started                                       |
| 4 — provenance on the wire (protocol v2)           | not started                                       |
| 5 — what the agent is told about a diff            | not started                                       |
| 6 — verification, including a real GitLab MR       | not started                                       |

Two complaints, one root: `apps/vscode-extension` decides what it may look at by
asking `uriScheme === 'file'`, and everything else is not merely ignored — it
**erases** the context that was there.

**This revision corrects five errors in the first draft**, all found by review
and all confirmed against the code and the shipped bundles. They are marked
**⚠ corrected** where they appear, because the wrong version was nearly
implemented.

## Why this is still broken

### The scheme test, and the erase that follows it

`editor-context.ts:49` is the whole policy:

```ts
export function isSupported(editor: EditorLike | null): editor is EditorLike {
  return editor !== null && editor.uriScheme === 'file'
}
```

and `SelectionCache.observe` (`editor-context.ts:140`) then does the damage:

```ts
const eligible = isSupported(editor) && roots.some((r) => isInside(r, editor.filePath))
this.#last = eligible ? editor : null
```

One rule serves two different situations. "The user is now looking at a file from
another project" and "the user is now looking at something that is not a file at
all" are collapsed into the same branch, and both throw away the last good
selection. `editor-context.test.ts:135` asserts the second case as _intended_
behaviour.

That is the "sometimes it does not detect the selected line". **The sharpest
instance is a diff.** Open a file's changes from the Source Control panel and VS
Code shows two real text editors side by side: the right one is the working tree
(`file:`, works today), the left one is `git:` (unsupported). Clicking the left
pane does not just fail to report — it clears the cache. Same for an `untitled:`
scratch buffer, a notebook cell, a search editor, the output pane. The behaviour
is click-order-dependent, which is what "not always" feels like.

**⚠ corrected — the erase is only half of it.** `resolve()` (`editor-context.ts:147`)
prefers _any_ non-null current editor before it consults the cache:

```ts
resolve(editor) {
  if (editor !== null) return { editor, source: 'current' }
  if (this.#last !== null) return { editor: this.#last, source: 'cached' }
```

So while the `git:` pane is still the active editor — which it is, because
`activeTextEditor` survives the window losing focus to Chorus — the report is
`unsupported` no matter what the cache holds. Retaining `#last` in `observe()`
alone fixes nothing the user would see, and a test written as `resolve(null)`
would pass over the top of the live defect. Both halves have to move together,
and the test has to hand `resolve()` the unsupported editor.

### What Claude Code does differently, read out of its bundle

`~/.vscode/extensions/anthropic.claude-code-2.1.229-darwin-arm64/extension.js:372`
filters by a **blocklist**, not an allowlist:

```js
gtr = new Set(['comment', 'output', B9, H9, q9, H0, q0])
function qv(e) {
  return gtr.has(e)
}
```

The named constants are its own proposed-diff virtual filesystems. Everything
else — `file`, `untitled`, `git`, `gl-review`, `vscode-remote` — is accepted, and
there is no special handling of diff tabs anywhere in its capture path. Its
retention rule (`extension.js:936`) is also narrower than ours:

```js
function WIe(e){return e===0?"clear":"retain"}
Fe.window.onDidChangeActiveTextEditor(async n=>{ if(!n){ if(WIe(Fe.window.visibleTextEditors.length)==="retain") return; ... } })
```

Cleared only when the **last visible editor closes**, or when the tracked
document itself closes. Becoming active in something ineligible never clears it.
It also subscribes `onDidCloseTextDocument`, which we do not.

The capability gap, stated precisely: **it is not that Claude Code understands
GitLab. It is that Claude Code does not refuse.**

### The GitLab MR diff, read out of its bundle

`gitlab.gitlab-workflow-6.86.0` registers `gl-review` as a read-only
`FileSystemProvider` and opens changes with the real `vscode.diff` command, so
`window.activeTextEditor` and `editor.selection` both work there. The URI is
built by `toReviewUri`:

```ts
export function toReviewUri({ path, exists, commit, repositoryRoot, projectId, mrId, changeType }) {
  const query = { commit, exists: exists ? '1' : '', repositoryRoot, projectId, mrId, changeType }
  return Uri.file(path).with({
    scheme: REVIEW_URI_SCHEME,
    query: jsonStringifyWithSortedKeys(query),
  })
}
```

and its only call site — `extension.js:9012121`, the changed-file tree item —
fixes what every field means:

```js
let a = { repositoryRoot: s, changeType: qZe(r), projectId: t.project_id, mrId: t.id },
  u = DIe({ ...a, path: r.old_path, exists: !r.new_file, commit: e.base_commit_sha }),
  d = DIe({ ...a, path: r.new_path, exists: !r.deleted_file, commit: e.head_commit_sha })
```

**Four facts decide the design, and three of them corrected the first draft.**

- `uri.path` is **repo-relative with a leading slash**, so `fsPath` is
  `/src/app.ts` — a real-looking absolute path pointing nowhere. Accepting the
  scheme without parsing the query hands Chorus a path outside every root, and
  main reports `unmatched`: a wrong answer wearing a missing one's clothes.
  Claude Code sends exactly this and gets away with it because nothing
  downstream checks.
- **⚠ corrected — `commit` is the only thing that distinguishes the two panes.**
  `base_commit_sha` on the left, `head_commit_sha` on the right; `path` differs
  only for a rename. The first draft dropped `commit` from the resolver and still
  promised a marker naming the version — it could not have.
- **⚠ corrected — `mrId` is `mr.id`, not `mr.iid`.** The number a human sees as
  `!456` is `iid`, and it is used for the tree label (`` `!${e} · ${r}` `` from
  `this.mr.iid`) but is **not in the URI**. A pill reading `MR !<mrId>` would
  print a different number from the one in the browser tab. It is not derivable
  without the API, so it is a non-goal.
- **⚠ corrected — `exists` is about the diff side, not the working tree.**
  `exists: !r.new_file` for base, `!r.deleted_file` for head: it says whether
  _this side of the diff_ has content, which is how `isEmptyFileUri`
  (`!exists || !commit`) detects the blank pane opposite an added or deleted
  file. It says nothing about whether the file is on disk. The first draft's open
  question conflated the two.

The document's content is a committed blob (`review_file_system.ts` reads it from
the local object store at `params.commit`, falling back to the GitLab API), so
`src/app.ts:120-134` as a bare reference is a **lie**: the agent will open the
file and read different lines.

The built-in Git extension's `git:` URIs carry the opposite convention —
absolute path in `query.path`, plus `ref` (`"HEAD"`, `"~"` for the index, `""`,
or a SHA).

### Two windows, one variable

**⚠ corrected — new.** `extension.ts:40` holds a single `roots` array for the
whole window, and every connection's `onRoots` overwrites it
(`extension.ts:132`). With two Chorus processes running, the last handshake wins
and both are then told about the other's roots. `publish()` sends every
connection the same `reportAll(roots, …)`. The first draft noted multiple pids
and never addressed this; any diagnostics built on top of it would report the
wrong thing.

### And nothing can tell you which of these happened

The output channel logs connection reasons only; no per-frame decision is
recorded. So `unsupported`, a root mismatch, and a handshake refused before the
socket opened (`connection.ts:71`, logging into a channel nobody opens while the
status bar reads "not running") are indistinguishable from the user's side. This
is C-029's lesson one repo over: the fix landed and the instrumentation did not.

### The update button that can never finish

**⚠ corrected — new, and it blocks the protocol bump.** `ipc.ts:71` reports what
the bundled VSIX carries as **the app's own version**:

```ts
bundledVersion: () => (vsix() === null ? null : app.getVersion()),
```

The app is `0.12.0`; `apps/vscode-extension/package.json` is `0.6.0`, and that is
what actually installs (`code --list-extensions --show-versions` on this machine
says `chorus.chorus-vscode@0.6.0`). `ide-extension.ts:103` therefore computes
`isOlder('0.6.0', '0.12.0') === true` and Settings shows **update available
forever** — pressing it reinstalls 0.6.0 and the prompt returns.

This matters beyond tidiness. Phase 4 bumps `PROTOCOL_VERSION`, both ends refuse
a mismatch outright, and the _only_ way a user learns to reinstall is a Settings
prompt that currently cries wolf and an extension that says "not running". The
migration path has to work before the thing that needs it ships.

## Shape of the answer

**A pure `resolveDocument(uri)` that maps a document to a real path plus its
provenance**, replacing the scheme equality test. Provenance is the load-bearing
new idea: `worktree` for a file on disk, `ref` for `git:`, `review` for
`gl-review:` — the last carrying the **commit sha**, because that is the only
handle on which version the user is actually looking at, and because an agent
holding it can run `git show <sha>:<path>` and see exactly what is on screen.
That is a capability Claude Code does not have, and it costs one field.

An **allowlist of parsed shapes**, deliberately not Claude Code's blocklist. A
scheme we have not parsed yields no path, which the pill can explain; a scheme we
guess at yields a wrong path, which surfaces as a silent `unmatched` two
processes away. Same rule the adapters live under: read the real shape.

And the erase gets split from the refusal — in **both** `observe()` and
`resolve()`, because either alone leaves the visible bug standing.

## Phase 0 — make the extension say why, and be installable

Nothing about editor context changes here. This phase makes the next six
diagnosable and shippable.

Log one line per published frame behind a `chorus.trace` setting, carrying reason
codes only — scheme, status, root matched, trusted, cached vs current, connected
pid count. Never a path, never a token, never source text; a scheme name is
neither. Add **`Chorus: Diagnose editor context`**, dumping the current decision
for every root each connected Chorus asked about. Surface a protocol mismatch in
the status bar (`Chorus: update the extension`) instead of only in a channel.

Then fix the version truth: `bundledVersion` must describe the VSIX, not
`app.getVersion()`. Whether the extension's version tracks the app's is a
decision (see open questions) — but a number Chorus invents for a file it ships
is wrong either way.

**Corrected while implementing: read a sidecar, not the manifest inside the
zip.** A VSIX is an Open Packaging Convention archive, so reading
`extension/package.json` back out of it needs either a dependency or a
hand-rolled inflate, for one string — against a workspace policy that budgets
dependencies one native module at a time. `package.mjs` writes
`chorus-vscode.vsix.version` beside the archive in the same run, from the same
manifest, and main reads that. It is also the _more_ truthful of the two: the
number then describes the artifact rather than the tree, so a stale VSIX in a dev
checkout reports its own old version instead of whatever `package.json` says
today. A missing or malformed sidecar answers `null`, which already means "offer
nothing", so an app packaged before this existed loses the update button rather
than gaining a wrong one.

**This phase must be released and installed before Phase 4.** An extension
already on a user's machine cannot show a state it does not have code for, so the
"update the extension" surface has to be the _old_ build's behaviour by the time
v2 arrives. Phases 1–3 are wire-compatible and can ride along; Phase 4 cannot.

Exit criteria: reproducing "it did not detect my selection" produces a reason
code naming which cause it was; Settings stops claiming an update is available on
a machine that is up to date.

## Phase 1 — stop forgetting the selection

**⚠ corrected — two functions, not one.**

`observe()` splits its single branch in two: a **referenceable document from
another project** still clears (that guarantee is why the cache exists); a
document that is **not referenceable at all** leaves the cache standing.

`resolve()` stops preferring a current editor unconditionally. It needs the same
eligibility question `observe()` asks, so the rule moves into one predicate both
call — the current editor wins when it is referenceable, and otherwise the cache
answers and the result is marked `cached`.

Also subscribe `onDidCloseTextDocument` and drop the cache when the cached
document is the one that closed, so "keep what we had" cannot outlive its buffer.

Tests: `editor-context.test.ts:135` inverts, and the new cases go through
`resolve(unsupportedEditor)` and `reportAll(roots, facts, unsupportedEditor,
cache)` — **not** `resolve(null)`, which cannot fail on this defect. A foreign
_file_ must still empty it.

Exit criteria: with a selection in an in-project file, `reportAll` called with a
`git:`/`output:` editor as the current one returns `ready` with
`source: 'cached'` and the original range; called with another project's file it
returns `unmatched` with no editor. The user-visible half of this lands in
Phase 4 — see below.

**What this phase deliberately cannot show you.** `toPushFile` (`ipc.ts:83`)
drops `source` on the way to the renderer, so the pill has no way to say
"cached". Adding a field to that payload belongs with the other renderer changes
in Phase 4; until then this phase is provable by test and by Phase 0's
diagnostics, and the pill simply stops going blank.

## Phase 2 — one root list per Chorus process

**⚠ corrected — new.** `roots` becomes per-connection state, and `publish()`
sends each connection the reports for the roots _that_ Chorus asked about. The
`ChorusConnection` already owns its descriptor and pid; the roots belong beside
them.

Exit criteria: two brokers, each asking for a different root, each receive
reports for only their own; the diagnostics command lists roots per pid.

## Phase 3 — resolve a document, not a file

`document-identity.ts`, pure, no `vscode` import — same reason `editor-context.ts`
has none. `resolveDocument({ scheme, path, query, fsPath })` returns
`{ filePath, provenance } | null`:

| scheme      | path                                                  | provenance                                              |
| ----------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `file`      | `fsPath`, canonicalized                               | `{ kind: 'worktree' }`                                  |
| `git`       | `JSON.parse(query).path`                              | `{ kind: 'ref', ref }` — `HEAD`, `~` (index), `''`, sha |
| `gl-review` | `join(query.repositoryRoot, stripLeadingSlash(path))` | `{ kind: 'review', commit, changeType, hasContent }`    |
| anything    | `null`                                                | —                                                       |

`commit`, `changeType` and `exists` (as `hasContent`) are all carried — the
corrections above are what they are for. Every parse is total: a malformed query,
a missing `repositoryRoot`, a path that escapes the root after joining, an empty
pane (`!exists || !commit`) — all return `null` rather than throwing or guessing.
`extension.ts` keeps its job of flattening `vscode.TextEditor` into a structural
shape and gains no rules.

The disclosure policy in `reportFor` is untouched: root open here, workspace
trusted, path inside the root. A resolved path is still a path and is still
checked, and Electron main still re-checks it, because the extension's filtering
is minimisation and main is the boundary.

Exit criteria: unit tests over **real captured URI strings** for all three
schemes plus a malformed one and an empty-pane one; `gl-review:/src/app.ts?…`
resolves to `<repositoryRoot>/src/app.ts` and never to `/src/app.ts`; the base
and head panes of the same file resolve to the same path with **different**
commits.

## Phase 4 — provenance on the wire

`editorMetadata` and `editorSnapshot` are `strictObject`s, so adding
`provenance` is a breaking wire change: `PROTOCOL_VERSION` goes to 2, and both
ends already refuse a mismatch outright. Phase 0 is the reason a user can act on
that; this phase is why Phase 0 had to ship first.

`toPushFile` gains `provenance` and `source`, and the pill gains both markers:
`src/app.ts:120-134 · MR a1b2c3d` for a review document, `· HEAD` for a git ref,
`· cached` when the selection is remembered rather than live. The MR marker is a
short sha and **not** `!456` — that number is not in the URI, and inventing one
from `mrId` would print a different merge request's number. New `ide.provenance.*`
keys in `en.json`; the reducers have no translator, so the wire carries ids and
the renderer makes words.

Exit criteria: a review-scheme frame reaches the pill with its short-sha marker
and no absolute path; a Phase-1 cached selection reads `cached`; an old extension
against a new Chorus says "update the extension" rather than "not running".

## Phase 5 — what the agent is told about a diff

`renderer/src/editor-context.ts` formats a reference, plus the code when it is
worth quoting. `attach.ts` sets the rule it follows — Chorus hands agents
**paths**, not attachments, because a path can be opened and read around.

That rule inverts when the document is not the working tree. The path is still
worth having, but it is no longer where the selected lines live, so the reference
must be qualified and the **text stops being optional**: for a review document
the quoted selection may be the only true copy.

The shape to land, and the part that beats Claude Code: hand the agent the path,
the lines, the **commit**, and the text — because `git show <commit>:<path>` then
reproduces exactly what the user is looking at, and the blob is usually already
in the local object store (which is where the GitLab extension reads it from
first). When the commit is not local the quoted text is all there is, and the
message says so rather than pointing at a file that will read differently.

Exit criteria: a selection in an MR diff produces a message an agent can act on
without opening the wrong version, and the review case is covered by a reducer
test.

## Phase 6 — verification, including a real GitLab MR

Unit tests carry the resolver. `e2e/fake-ide.mjs` carries the protocol and the
pill, and gains a review-scheme frame — it is a VS Code window that is not VS
Code, so it proves the wire, not the editor.

**Neither proves `gl-review` behaves as this plan claims**, because both sides of
that claim are read out of a minified bundle. The last step is manual and has to
be: real VS Code, real Chorus, a real merge request, select lines on **both**
sides of the diff, and record what the pill showed and what was sent — the two
sides must differ by commit and agree on path. Same for the left pane of a git
diff and an untitled buffer. What was observed goes in STATUS, including anything
that did not work.

## What this deliberately does not do

- **No blocklist.** An unrecognised scheme stays unsupported. Claude Code's
  approach ships a wrong path for anything it has not thought about, and Chorus
  has a second validation layer that turns a wrong path into an unexplainable
  `unmatched`.
- **No `!iid` in the pill.** It is not in the URI and would need the GitLab API.
  A short sha is honest and more useful to an agent.
- **Notebooks are out.** `vscode-notebook-cell:` needs a cell index carried
  through the reference to mean anything. It is a real "does not detect" case and
  deserves a board entry of its own — **there is no C-035 today; the next free id
  is C-035 and filing it is part of shipping this**, not a reference to something
  that already exists.
- **No GitHub PR support yet.** The `pr:` scheme is the same shape; the resolver
  is designed so it is one more case, and it is not one this machine can test.
- **Root equality is unchanged.** VS Code opened at a _parent_ of the
  conversation cwd still reads `unmatched`, on purpose — see the open question.

## Open questions

**Is the parent-folder case part of "not always detects"?** `reportFor` requires
`workspaceFolders.includes(root)` exactly, so a window opened at `~/code` with
the project inside reports nothing for it. The equality is a deliberate
disclosure boundary — containment would widen the scope of everything reported
from that window. But "No file from this project is open" is a poor explanation
of "your VS Code is opened one level up". Phase 0 answers whether this is
actually biting before anything changes.

**Should the extension's version track the app's?** Phase 0 has to stop inventing
one. The choice is to read the manifest (two version numbers that drift but are
each true) or to stamp the manifest at package time from the app version (one
number, and `bundledVersion` becomes correct by construction). The second is
tempting and would have prevented this bug; it also means every app release
reinstalls the extension.

**Should a review selection whose file is absent from the working tree be
`ready`?** It has text, lines and a commit, but the path may not open. Proposal:
yes — refusing would make the feature useless on exactly the branch someone is
reviewing, and Phase 5's commit-plus-text form does not need the file to exist.
Note this is a different question from `exists`, which is about the diff side.
