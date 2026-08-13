# Status — a document is not a file

Status: **Phase 0 implemented, not yet driven in a real VS Code window.** Plan
approved after one review round that corrected five things; those corrections are
marked in the plan itself rather than quietly folded in.

## Done

**Phase 0 done: the extension explains itself, and Chorus knows what it ships.**

`diagnostics.ts` is a new pure module beside `editor-context.ts`, and free of any
`vscode` import for the same reason: what matters is what it leaves out. A
diagnosis exists to be pasted into a bug report, so it emits reason codes, URI
schemes, booleans and counts, and names each root by its **index** in the list
Chorus published — enough to say which root failed without saying where it is on
disk. A test asserts that a full `ready` report, `filePath` and all, serializes
without the project path or the file name in it.

Two surfaces use it. `chorus.trace` (default off) logs one line per published
frame; **`Chorus: Diagnose editor context`** dumps the current decision on
demand. The command deliberately calls `cache.resolve` rather than `reportAll`,
because `reportAll` would `observe` — asking why something is wrong must not
change what the next frame says.

`EXPLANATION` is a `Record<IdeStatus, string>` rather than a lookup with a
fallback, so a status added later has to be explained here and the compiler is
what says so. It carries `ambiguous`, which this window can never produce — only
Chorus decides that — because a dump may be reading a status the extension did
not author.

`ChorusConnection.state` splits a protocol mismatch **by direction**. The two
have different fixes and only the user can apply either, and until now neither
was visible at all: `start()` refuses the handshake and returns, so an outdated
extension looked exactly like no Chorus running. The status bar now says which
of the two to update, and that is what makes Phase 4's protocol bump survivable
for anyone who already has the extension installed.

**And the update button that could never finish.** `ipc.ts` reported the bundled
VSIX's version as `app.getVersion()` — 0.12.0, while the extension it ships is
0.6.0. `extensionStatus` therefore computed `need: 'update'` on a machine that
was up to date; pressing it reinstalled 0.6.0 and the prompt came straight back.
`readBundledVersion` reads a sidecar `package.mjs` now writes beside the archive.

Gate: `pnpm check` green — 1397 tests (up from 1379), 3 skipped.

### Deviation from the plan, and why

The plan said `bundledVersion` should "read the VSIX manifest". It reads a
sidecar written at package time instead. A VSIX is a zip, so reading
`extension/package.json` back out needs a dependency or a hand-rolled inflate for
one string, against a workspace policy that admits dependencies one at a time.
The sidecar is also the more truthful of the two: written in the same run from
the same manifest, it describes **that archive** rather than the tree, so a stale
VSIX in a dev checkout reports its own old version. The plan now says this.

### What was actually observed

- `readBundledVersion(resolveVsix(...))` against the real repo returns `0.6.0`,
  matching `code --list-extensions --show-versions` → `need: 'none'`. The
  permanent "update available" is gone at the module level.
- The **built bundle** was smoke-loaded under a stubbed `vscode`: `activate`
  returns with 9 subscriptions, both `chorus.reconnect` and `chorus.diagnose`
  register, the status bar paints `$(debug-disconnect) Chorus: not running`, and
  the dump reads:

  ```
  Chorus editor context
    extension 0.6.0, protocol 1
    workspace trusted: yes
    workspace folders: 1
    active document: none — no active text editor
    Chorus processes: 1 found, 0 connected, 1 dialing
    roots published: 0
    selection reported: none
  ```

  That probe is throwaway and was not kept — see C-032 for why that is a habit
  worth breaking, not repeating.

### What is not verified

- **Nothing has been driven in a real VS Code window.** The trace setting, the
  command in the palette, the mismatch text in the status bar and the Settings
  panel no longer offering a phantom update are all unobserved in the app.
- The e2e suite was not run. `pnpm package` was not run, so the new
  `extraResources` entry is untested; the seal count should go from 77 to **78**
  when it is.
- Nothing is committed.

**Phase 1 done: the selection survives looking at something else.**

Both halves moved, because either alone is invisible. `observe` now returns
early for a document that is not referenceable at all — the `git:` side of a
diff, an `untitled:` scratch buffer, an output channel — instead of treating it
like another project's file. `resolve` prefers the current editor only when it
is one that can be referenced, which is the half the first draft of the plan
missed: `activeTextEditor` survives the window losing focus to Chorus, so the
unsupported pane is still _active_ while the user is clicking into the composer,
and a cache nobody consults is not a fix.

`SelectionCache.forget(fileUrl)` and a new `onDidCloseTextDocument`
subscription are the cost of keeping things longer: "keep what we had" must not
outlive the buffer it describes. Keyed on the URL, because that is what
identifies a document across schemes.

The rule that did **not** move: another project's file still empties the cache.
That is the guarantee the cache exists to make, and there is a control test
holding it — it passes with and without this change, which is the point of it.

Gate: `pnpm check` green — 1402 tests (up from 1397), 3 skipped.

**Proven against the unfixed code.** With `editor-context.ts` stashed back to
HEAD, five of the new tests fail:

```
× keeps the cache when the current editor is not referenceable
× prefers the cache over an active editor that cannot be referenced
× reports nothing when there is no cache and nothing referenceable
× forgets a cached document when that document closes
× keeps reporting the selection while the user looks at a diff pane
```

The last is the phase's exit criterion driven the way the extension drives it:
`reportAll` with a real selection, then `reportAll` with the `git:` pane active
— `ready`, `source: 'cached'`, and the original range at line 10.

### What is still not verified

Everything user-facing. The pill has no way to _show_ `cached` yet:
`toPushFile` drops `source`, which Phase 4 fixes. Until then this phase is
provable by test and by the Phase 0 diagnostics, and what the user should see is
that the pill stops going blank.

## Still to come

Phases 1–6 unchanged from the plan. Phase 0 has to be **released and installed**
before Phase 4 lands, or the migration surface it adds will not be present on the
machine that needs it.
