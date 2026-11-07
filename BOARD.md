# Board

Somewhere to drop a task so it is not lost, and somewhere to look when deciding
what is next.

**Not a plan.** Work of any size still goes through
`docs/plans/{slug}-{date}/plan.md`, and a plan's own progress belongs in its
`STATUS.md`. This file is for the things that sit outside any one plan: what needs
a person rather than a commit, what was noticed in passing and is worth doing, and
what is deliberately parked.

**An entry says three things** — what it is, why it matters, and what would make
it done. An entry that cannot answer the third is a thought, not a task, and
belongs in a plan's open questions instead.

**Every entry has an id**, `C-001` upward, so a commit or a PR can name the thing
it closes. Ids are permanent and never reused: when an entry ships it moves out
and its number retires with it, because a recycled id makes an old reference point
at the wrong work. The next id is the highest ever used plus one — including the
ones no longer on this page.

Move an entry out when it ships. A board that keeps its finished work stops being
read, which is how the status summary went stale a day after it was written.

---

## Needs you

Nothing here can be finished by me alone.

## Open

### C-069 · `traffic-drive.mjs` fails somewhere different every run, and one of those places may be the app

**Noticed 2026-09-25**, while proving a CSS change to the traffic inspector. Five
consecutive runs of `apps/desktop/e2e/traffic-drive.mjs` gave three distinct
outcomes, and only one of them was the defect under test:

| run | outcome                                                                          |
| --- | -------------------------------------------------------------------------------- |
| 1   | `.traffic-panel` mounted, then unmounted; the run crashed reading `details.open` |
| 2   | `ALL PASSED` — over 14 checks instead of 50 (see the guard below)                |
| 3   | 53 checks, 1 failure: the inspector truncated the forwarded URL                  |
| 4   | 51 checks, the inspector green, 2 failures in the tab strip                      |
| 5   | 6 checks — the capture never started, and `.traffic-panel` was gone again        |

**This is not C-029 and must not be folded into it.** C-029 is the e2e _spec
suite_'s pass rate under load and C-042 is nine specs failing deterministically;
this is a standalone driver launched by hand, with its own failure modes and its
own fix.

**Mode one — the panel unmounts after it has mounted. Unresolved, and it may be
the application.** Runs 1 and 5 each lost `.traffic-panel` mid-run, and that is
not a harness story to file away: `until` throws on a timeout and did not, so the
panel was genuinely there and then was not. An app that unmounts a live panel is a
real defect rather than noise. Run 1 is the one that matters — the only changes in
the tree were to the driver itself, so this predates the work these runs were made
for. It has not been diagnosed, and nothing here is a conclusion.

**Mode two — the seed is a live database. Not a flake, a property, and fixable.**
`seed()` copies `~/Library/Application Support/@chorus/desktop-dev/chorus.v2.db`
with `sqlite3 .backup`, which is the right way not to tear a WAL and the wrong way
to get a reproducible run: the app that owns that file is running and writing to
it. Run 3's tab strip read `tpa-web-1 | tpa-web-1 | Traffic`; run 4's read
`tpa-mobile | Traffic`. One conversation fewer and a different project showing,
which turned into two check failures that said nothing about the code. **The fix
is a deterministic seed** — build the fixture database from a fixed script, or pin
the rows the checks depend on — rather than measuring whatever the person's dev
app happened to be doing that afternoon.

**And the guard, which is the part worth remembering.** The whole inspector section
sat behind `if (/1 captured/.test(text))`. Adding one request to the fixture made
the panel say `5 captured`, the literal stopped matching, and the section was
skipped — so run 2 printed **`ALL PASSED` over fourteen checks instead of fifty**.
It is `/[0-9]+ captured/` now. A suite that reports success while silently skipping
its subject is the same class as this file's own note about an assertion that can
never fail, and it is worse than a red run, because nobody goes looking.

**A fourth shape, and the hardest of the four to notice: a fixture that excludes
the case rather than a check that misses it.** The row list stretched its rows
about seventy pixels apart whenever the content was shorter than the box — and
every run of this driver loads sixty-odd rows, so the list is _always_ taller than
its box and there is never leftover height to distribute. Nothing failed, because
the condition could not occur. A missing assertion is visible by reading the file;
a fixture that cannot reach a state is not, and it reads as coverage. **The tell is
a clause about the fixture rather than about the code** — this one is "it always
loads sixty rows" — and the fix is a check whose _precondition_ is asserted, so a
future fixture that stops producing the state fails loudly instead of passing by
having nothing to test. See the short-list check in `traffic-drive.mjs` for the
shape.

**The class bit again inside the change that renamed a button**, which is the
evidence that paragraph was missing. `listState` found the search Clear by the
text `'Clear'`; the rename made that lookup match nothing, and it reported
`clearDisabled: "no button"` — a wrong value rather than a failure, which is the
silent half and the reason it was not noticed. Two search checks failed and
neither of them said why.

**A `data-` hook on the control is the fix for the class, and exactly two controls
have one.** `data-traffic-clear="search"` and `data-traffic-clear="captured"` are
the buttons that bit. Every other lookup in this driver still finds controls by
their visible text and is still brittle in the same way — the hooks were applied
where the damage happened, not swept, so the rest is a known gap rather than an
oversight.

**Done when** a run either passes or fails in a way someone can act on: green
meaning every check ran, red naming the code rather than the seed. The
deterministic seed is the first half of that and is uncontroversial. The panel
unmounting is the second and needs a diagnosis before anyone can say whether the
fix belongs in the driver or in `TrafficPanel`.

### C-068 · The `src/main/` suite is flaky under vitest's file parallelism, and the failing tests differ every run

**Noticed 2026-09-24**, during the traffic-panel work, when `pnpm check` stopped
being green without anything in `src/main/` having changed. Three full runs of the
desktop project gave three different failure sets: `terminal` + `reap` + `aside` +
`session-defaults` (4 failed | 1789 passed); `reap` + `aside` + `session-defaults`
(3 failed | 1790 passed); and, with the new test file removed as a control,
**seven** files — `terminal`, `reap`, `aside`, `session-defaults`,
`workbench-host` (twice), `workbench-extract`, `traffic-ipc` — for 7 failed |
1782 passed. The same file fails in one run and passes in the next, so this is
not a broken test: it is a broken _schedule_.

**The isolating variable is vitest's own file parallelism.** The same seven files,
run alone and concurrently, gave **3 failed | 981.95 s**. Run with
`--no-file-parallelism` they gave **7 passed | 284 passed | exit 0 | 13.26 s**. So
the contention is between the test files vitest is running at the same time, and
it reproduces on demand in both directions. The affected files are exactly the
ones that spawn real processes — `reap` kills orphaned children, `terminal` opens
PTYs, `workbench-host` starts a REH — and each was sitting at 25–33 s, which reads
as a timeout rather than an assertion.

Two things are still unexplained and are part of the entry rather than noise. A
full parallel run of all 96 files takes ~40–60 s, while seven of them concurrently
took 982 s; that inversion is not accounted for. And a live Electron on
`@chorus/desktop-dev` with five REH node processes was up throughout, which the
concurrency result does not rule out as a **co-factor** — it is untested, not
cleared. The test that would settle it is quitting those and re-running, and it
was not run: the session doing the measuring was itself hosted by
`/Applications/Chorus.app`, so quitting its Electron would have ended the
conversation mid-answer. Anyone picking this up can run it from a plain terminal.

**Done when** one of two things is true. Either the seven files are green in a
full parallel run on a machine known to have no stray Electron or REH processes —
which settles the co-factor in the same experiment — or a specific test's timing
assumption is named and fixed, and the entry closes with the mechanism rather than
the workaround. Until then `pnpm check` cannot be trusted to mean what
`CLAUDE.md` says it means, which is the reason this is worth a board entry.

### C-067 · `agent-secrets.ts` says "agent" while holding a credential that is not an agent's

**Noticed 2026-09-17**, while widening that module for TypeSafe —
`docs/plans/a-tool-that-is-not-a-voice-2026-09-17/plan.md`, Phase 1. `SecretId` is
now `AgentId | 'typesafe'`, and the parameter was renamed with it, but six names
still claim more than they hold: `readAgentKey`, `writeAgentKey`,
`agentKeyIsSet` and `clearAgentKey`; the module's own filename; and the
`agent-secrets.json` the keys are written to.

**Why it matters, and why it was left.** This repo's own trap is that a wrong
name survives a re-key where a wrong type does not, so a name that quietly
widened its meaning is exactly the thing worth chasing. It was left out of Phase 1
because renaming the four functions reaches `ipc.ts`, `runtime.ts`,
`agent-probe.ts` and their tests, and the phase deliberately scoped itself to one
file. The risk here is lower than the classic case — passing `'typesafe'` to
`readAgentKey` does the right thing and nothing fails silently — which is why it is
a board entry and not a blocker.

**Done when** the four functions read as secrets rather than agent keys, or a
decision is written down that they should keep the old names. **The JSON file is
the harder half**: renaming it strands every key already stored, so it needs a
migration or a deliberate "leave it, the filename is historical".

### C-066 · A remote-installed browser-only extension is dropped before it is ever registered, and `.excalidraw` opens as raw JSON

**Reported 2026-09-01.** A `.excalidraw` file in a project pane opens as the JSON
text of the drawing. The same file in VS Code opens as a canvas. Both
`pomdtr.excalidraw-editor` and a second copy were installed, enabled, and listed
in the Extensions view the whole time.

**It is not the file, and the missing-cache fast path is not the reason.** That
was the first guess, because it is exactly how the PDF viewer failed — an
`editorOverrideService.cache` with no `*.pdf` sent the resolver straight to the
text editor. **Read while diagnosing on 2026-09-01, before the uninstall below, the
cache _did_ carry `*.excalidraw`**, which rules that path out; read again
afterwards it no longer does,
so this observation is time-scoped and is **not** a general claim that the cache is
never stale. In any case the cache holds glob patterns rather than provider
identities, and `editorResolverService.js:130` uses it for one thing only: deciding
whether to await `whenInstalledExtensionsRegistered()` before resolving.

**The stronger evidence is `memento/customEditors`**, which on a live profile holds
eleven entries — the built-ins, `hediet.vscode-drawio` and its text variant,
`pdfViewer.PDFEdit`, `docxreader.docxEditor` — and no Excalidraw. Every extension
in that list declares `main`. **Read it for exactly what it is**: the memento is
seeded from, and rewritten by, the `customEditors` _extension point_ handler
(`contributedCustomEditors.js:23`), so it records declarative manifest
contributions that were processed. It says nothing about whether an extension
activated or called `registerCustomEditorProvider`, which is a separate path
(`mainThreadCustomEditors.js:125`). Absence from it means the contribution was
never handled at all, which is the claim being made here.

**The cause is that Chorus starts no web-worker extension host, and a browser-only
extension installed into the REH's directory has nowhere else to go.**
`pomdtr.excalidraw-editor` declares `browser` and no `main`, so VS Code computes
its extension kind as `web`.

- `services.ts:379` calls `getExtensionServiceOverride()` with no options, so
  `enableWorkerExtensionHost` is `undefined` (`index.js:294`).
- Falsy, the allowed host kinds become `[LocalProcess, Remote]` (`index.js:219`)
  and `createExtensionHost` returns `null` outright for `LocalWebWorker`
  (`index.js:174`).
- The picker therefore rewrites the extension's `LocalWebWorker` to
  `allowedExtHostKinds[0]` — `LocalProcess` (`index.js:205`).
- **And that rewrite is where it vanishes.** `abstractExtensionService.js:511`
  assembles `allExtensions` from three buckets: _remote_ extensions assigned
  `Remote`, _local_ extensions assigned `LocalProcess`, and _local_ extensions
  assigned `LocalWebWorker`. A **remote** extension assigned `LocalProcess` is in
  none of them. It never reaches `_doHandleExtensionPoints`, so its
  `customEditors` contribution is never handled, so nothing claims
  `*.excalidraw`, so the resolver falls through to the text editor.

**Why this matters more than one file — and the qualifier is essential.** It is a
class, but a narrower one than first written: a browser-only extension **that ends
up in the REH's extensions directory**, which is what a sideloaded VSIX is. It is
installed, enabled, listed, and silently never runs, with nothing anywhere saying
so — the Extensions view shows it installed, because it is.

**Ordinary gallery installation does not land there**, so this is not "every
browser-only Open VSX extension". `deduceExtensionKind` returns `["web"]` for a
manifest with `browser` and no `main`
(`extensionManifestPropertiesService.js:171`), and
`getInstallableExtensionManagementServers` routes `web` to the
`webExtensionManagementServer` and only `workspace` to the remote one
(`extensionManagementService.js:752-767`). A gallery install is therefore local,
lands in the `localWebWorkerExtensions` bucket, and survives. Sideloading put these
two on the wrong side of that split.

**What would make it done — three prerequisites, and only the first is small.**

1. `enableWorkerExtensionHost: true` at `services.ts:379`. On its own this changes
   routing and nothing else.
2. Register the worker in `workers.ts`. The label is exactly
   `extensionHostWorkerMain` (`webWorkerExtensionHost.js:333`). **The import is
   extensionless**, because the package's `./*` export already appends `.js`
   (`monaco-vscode-api/package.json:44`) and writing the suffix resolves to
   `extensionHost.worker.js.js`:

   ```ts
   import ExtensionHostWorker from '@codingame/monaco-vscode-api/workers/extensionHost.worker?worker'
   ```

3. **A CSP branch for the extension-host iframe.** `isWebviewDocument()`
   (`security.ts:203`) matches only `/out/renderer/assets/(index|fake)-<hash>.html`,
   so the host iframe gets the workbench policy and its `frame-ancestors 'none'`
   (`security.ts:104`). The iframe also carries its own meta CSP
   (`webWorkerExtensionHostIframe.html:4`) and an inline bootstrap script from line
   11, which production's `script-src` rejects. `security.ts:218-227` already
   records paying for this exact mistake once, for the webview bootstrap.

**Host population is _not_ a fourth prerequisite** — that was the first draft's
error. `_startExtensionHostsIfNecessary(true, [])` does run before extensions
resolve (`abstractExtensionService.js:439`) with an initial snapshot of local web
extensions only (`extensionService.js:243`), but the worker host starts as
`EagerManualStart`, so `_startOnDemandExtensionHosts()` afterwards hands it the
completed registry snapshot (`abstractExtensionService.js:909`) and
`ExtensionHostManager.start()` sends `extensions.set(versionId, allExtensions,
myExtensions)` before starting it (`extensionHostManager.js:329`). The host is
explicitly told. **That call is not awaited**, so runtime ordering is still worth
watching — but it is a thing to verify, not a blocker to design around.

**The duplicate had to go before anything can be measured.** Two extensions were
sideloaded as VSIX and both claim viewType `editor.excalidraw` — `pomdtr@3.9.0`
and `lrstanley@3.7.4`. `contributedCustomEditors.js:65` discards the second with a
bare `console.error`, and if both ever activate `mainThreadCustomEditors.js:152`
throws `Provider for editor.excalidraw already registered`.

**`lrstanley@3.7.4` was staged for removal on 2026-09-01, not confirmed removed.**
Its directory was moved to `workbench-server/lrstanley.excalidraw-editor-3.7.4.removed`
and its `extensions.json` entry dropped, 33 → 32, with a backup at
`workbench-server/extensions.json.bak-2026-09-01`. This was done **while Chorus was
running**, at the user's instruction, so the live REH may rewrite the registry from
its in-memory copy on exit. Recheck after Chorus quits. Some inert profile metadata
for `lrstanley` also remains.

**Two wrong diagnoses are recorded here, because the error is the useful part.**
The first said the extension was dropped for having no host at all — but
`services.ts:237` registers `localExtensionHost`, so a `LocalProcess` host does
exist and the drop happens one step later, at bucket assembly. The second said it
was routed to a host that could not load its code, which is worse, because it was
reasoned from what the in-page host is _for_ rather than read. Codex's review
caught both. This is the same failure §4 made about Draw.io and the same one C-057
and C-063's trust hole were withdrawn for.

**Not the same bug as the PDF viewer, and this entry does not cover it.**
`adamraichu.pdf-viewer` declares `main` _and_ `browser`, so it is routed to the REH
rather than dropped, and its manifest contribution was processed — its editor is in
the memento. Whether it activates or registers a provider is a different question
this entry has not asked. It still renders blank; that is separate and still
undiagnosed.

### C-065 · Two extension hosts survive ten open/close cycles — cause found, bounded, race still open

**Measured 2026-08-29** by `pnpm --filter @chorus/desktop run gate:memory`, on
macOS arm64. R11 has two halves and they disagree: memory returns to within
**5.4%** of `M1`, comfortably inside the 15% the threshold allows, and the
process **inventory does not** — 12 processes where one project had 10.

**What survives, by name.** Two REH `node` processes:

```
+2  …/workbench/1.121.03429-darwin-arm64/node
```

That is the second of the two candidates R11 names in its own rationale — "a
forked extension host the REH never reaps" — and it is exactly why R11 was
redefined to assert an inventory rather than a heap. A heap sampled in any one
renderer would have shown this as flat, and the memory half of the check passed
while it was happening.

**Why it matters.** The REH forks an extension host per connection, and a
connection belongs to a surface. If closing a project leaves its host behind,
then "switch projects while agents or terminals continue" — plan §3's promise —
costs a process every time, and the four-pane ceiling stops bounding anything. It
is also the shape of leak that is invisible until a machine is short of memory,
because each one is small.

**Cause, found 2026-08-29 by reading the server rather than measuring it.** The
entry used to offer two readings — a reaping bug, or a settle window that is
merely impatient — and say they had different fixes. They are the same fact.

A forked extension host is handed its socket and from then on decides for itself
when to die, and `remoteExtensionManagement.js` gives it two paths three hours
apart. A graceful protocol `Disconnect` disposes it at once: _"the client has
disconnected gracefully, so the connection will be disposed."_ A socket that
merely closes arms a timer instead — _"will wait for reconnection …"_ — because a
dropped connection is meant to be a flaky network. That timer defaults to
`ReconnectionGraceTime`, **`108e5` — three hours**.

So two of ten is not "most are reaped and some are not". It is the graceful frame
usually winning a race with the view being destroyed, and twice losing it. And
the check was never impatient: 60 s cannot see a three-hour timer, so a run that
waited longer would have "cleared" it while the leak was entirely real.

**Fixed by bounding, 2026-08-29** — `--reconnection-grace-time 30` on the server
spawn. The seconds→ms parse is the server's, and it re-exports the result as
`VSCODE_RECONNECTION_GRACE_TIME` into the forked host's environment, which is the
only reason a server flag reaches the process that leaks: the host reads it with
`108e5` as its own fallback. Three hours is sized for a laptop that slept on a
train; this client is a `WebContentsView` on a loopback socket main itself owns,
where the only real reconnect is a renderer crash-reload.

**What is still open.** The race itself. Closing a project usually reaps at once
and sometimes now takes 30 s, so the inventory is bounded rather than exact —
`gate:memory` should pass, and has **not been re-run**, so R11 is unverified
against this change. Removing the race means the workbench sending its disconnect
_before_ the view is destroyed and main waiting for the ack, with the 30 s as the
crash backstop; that was deliberately not built here.

**Done means**: `gate:memory` passes both halves of R11 on two independent runs.

**Where to start.** `workbench-host.ts` owns the server, its lease and now the
flag; `destroySurface` in `workbench-surface.ts` owns the teardown that loses the
race. `reap.ts` is orphan cleanup after a crash — a different path, and not this.

### C-064 · Linux installers do not build, and the job is red in every release run

**Live as of 2026-08-29**, the moment Phase 7 added a `linux:` target and a
release job. Two dispatched runs, two failures, both at `Package` and both
before anything was verified.

**What it is.** The Linux job on `ubuntu-latest` has never produced an artifact.
The first run failed on `executableName contains characters that cannot be
safely used in file paths: @chorusdesktop` — electron-builder derives the Linux
executable from the package name when none is set, and this package is scoped.
Fixed. The second failed on `Please specify project homepage`, which the `deb`
target requires for its control file. Not fixed: work stopped here deliberately
rather than iterating a red job one line at a time.

**Why it matters.** Every other platform now works — macOS arm64, macOS x64 and
Windows all build, verify and upload — so this is the single thing standing
between the pipeline and a green release. And a red job in the matrix is not
free: `fail-fast: false` means the others still finish, but the run is red, and
a red run is one nobody can distinguish from a real regression at a glance.

**The two things that are already known and must not be re-derived.** Linux
**must** be built on a Linux runner: `node-pty` publishes prebuilds for darwin
and win32 and none at all for Linux, so its install compiles from source and
`npmRebuild: false` means the binding that ships is the build host's.
Cross-building from macOS would package a bundle with no PTY and nothing saying
so. And **arm64 is out of scope** until an arm64 Linux runner is decided on —
the REH artifact exists, the native side would have to compile there, and a
cross-built one could not be launched by its own verifier.

**Done means**: a dispatched Release run produces `Chorus-<version>-linux-x64.AppImage`
and `.deb`, `verify:package:linux` passes under `xvfb-run` — including its check
that _a_ pty binding shipped, which is the one that matters — and the published
asset check finds all five files. Failing that, the honest alternative is
removing the Linux job from the matrix so the workflow can be green, keeping the
target config for whoever picks this up.

**Next cause to clear** is the `homepage` field. It is one line, and there is no
reason to believe it is the last one — each run so far has revealed exactly one
more.

### C-063 · ~~An extension installs into every project at once, and nothing says so~~ — **closed 2026-09-17, reframed**

**Live as of 2026-08-24**, the moment Phase 5 slice 5a made extensions
installable: Mohamad installed one from Open VSX and it worked.

**One server, one extensions directory.** `workbench-host.ts` spawns a single REH
with a single `--extensions-dir`, leased by a refcount over open projects. Every
project pane connects to that same server. So installing ESLint while working in
one project installs it for every project you will ever open — and disabling or
uninstalling it does the same, from whichever project you happened to be in.

**VS Code's Extensions view cannot say this**, and that is not a gap in the view.
In VS Code one window is one remote is one extensions directory, so the statement
"installed" is unambiguous. Here four panes share one server, and the same word
means something the person did not ask for.

**The sharp edge is trust.** Workspace trust is decided per project — the prompt
names one folder — but the extension it gates is global. So trusting project A
can activate an extension inside project B, which was never trusted, without
anything being shown in B.

**Predicted by the plan, and now real.** §2.4 lists it among the hazards created
by choosing a shared REH: _whether one REH serving two roots isolates them well
enough when its extensions directory and global storage are per-server_. It was
hypothetical while nothing could be installed.

**Decided 2026-08-24 — accept the shared scope, and say so.** The alternative was
real and cheaper than first assumed: `IRemoteUserDataProfilesService` is already
registered by the gallery override, so a profile per project would partition
extensions on the **same** server rather than needing one server each. It was
declined anyway — one machine, one person, and an extension set that follows you
between projects is the behaviour you would want; the cost was a mapping, a
profile service, and re-installing everything per project.

**The disclosure is the condition of accepting it**, and it is
`renderer/src/workbench/extension-scope.ts`: a notification on the first install
and the first uninstall of each surface, saying the change reaches every project.
At the moment of the action rather than in a document, because a README is read
once and months before it matters; once per kind per surface, because five
identical banners are noise by the second.

**Closed 2026-09-17 as one install set with per-project enablement.** The plan's
Phase 4 asked whether the install could be partitioned and found that it could not
— `--extensions-dir` is a server-level argument with no per-connection variant, and
one REH serves every project. What it found instead was already built: enablement
is registered by the gallery override, workspace storage is keyed per project as
`workspace:${workspace.id}`, and a folder is always open, so the Extensions view's
per-workspace disable persists per project. Proven by hand the same day — disabled
in one project, still enabled in the others after a reopen. No code was written for
this, and the entry closes as the smaller thing rather than the thing it asked for:
sharing the install, choosing where it runs.

**The "trust hole" this entry claimed does not exist — withdrawn 2026-08-24.**
It said trusting project A could activate an extension inside project B, which
was never trusted. That was reasoned from the architecture (one extensions
directory, per-project trust) without reading the mechanism, and the mechanism
disagrees.

`extensionEnablementService.js:566` — `_isDisabledByWorkspaceTrust` returns false
only when **that workbench's** workspace is trusted, and otherwise reports
`DisabledByTrustRequirement` for any extension whose manifest does not declare
`untrustedWorkspaces` support. Each project pane is its own workbench with its own
workspace and its own trust state, so an untrusted project disables the extension
for itself no matter what another project trusted.

**Global install with per-workspace activation gating is VS Code's own model**,
not something the shared REH broke — and Chorus inherits it. Sharing an extensions
directory shares what is _installed_; it does not share what is _activated_.

**Kept rather than deleted, because the error is the useful part.** This was a
defect asserted from a plausible shape without checking, which is the same failure
§4 made about Draw.io and the same one C-057 was withdrawn for. Three times now in
this plan.

**And 5d's ledger records results under a per-server scope**, which this decision
makes permanent rather than provisional — noted in its header.

### C-062 · ~~Git does not work — no SCM service override is registered~~ — **closed 2026-08-24**

**All three conditions met.** The override is in the service set at the pinned
`33.0.9`; a project pane opened on a real repository shows `main` and a sync
control in the status bar with the source-control icon in the activity bar; and
Mohamad has since driven the workbench repeatedly with no sign of the
`registerSCMProvider` refusal.

**The answer worth keeping is the one registration only made askable:** Git works
against a `vscode-remote://` root through the REH. The branch and the remote
indicator appeared in the same frame, so the server read it — not a local shim.

The detail below is the original entry, kept for the reasoning.

**Observed in the running workbench**, in the Window output channel, on an
ordinary project open:

```
[error] Unsupported: SCMService.registerSCMProvider is not supported.
You are using a feature without registering the corresponding service override.
```

**Confirmed in the source, not inferred from the log.** There is no `scm` service
override anywhere in `renderer/src/workbench/services.ts` — the file has no match
for `scm`, `Scm` or `SCM` at all. The message is the library saying exactly that.

**Why it matters.** Git is named in the plan's own acceptance criterion — "use
Git … without opening the separate VS Code application" — and in Phase 4's gate.
It is currently not merely unbuilt but unregistered, so the built-in Git extension
loads and then fails to register its provider. That is worth knowing before Phase 4
budgets for it as new work: the first step is a service override, not a feature.

**Done means**: `@codingame/monaco-vscode-scm-service-override` in the service set,
the source-control view populated for a real repository, and the error absent from
a clean launch. **Not a Phase 1 blocker** — Phase 1 never claimed Git.

**First of the three, done — 2026-08-24, Phase 4 slice 4a.** The package is
installed at `33.0.9`, matching the pin the rest of the set is on, and
`getScmServiceOverride()` is in `services.ts`.

**And the second condition is met — observed 2026-08-24, in the running app.**
A project pane opened on a real repository shows **`main` and a sync control in
the status bar**, with the source-control icon present in the activity bar. That
is the built-in Git extension having registered its provider successfully, which
is the thing this entry existed to make possible.

**It also answers the question the registration only made askable**: Git works
against a `vscode-remote://` root through the REH. The status bar reports the
remote as `127.0.0.1:50677` in the same frame, so the branch was read by the
server rather than by anything local.

**What is left is the smallest of the three**: nobody has confirmed the
`Unsupported: SCMService.registerSCMProvider` line is absent from a clean launch's
Window output. A provider that registers is strong evidence it is gone, but the
error was the symptom this entry was filed from and it should be read once.

### C-061 · ~~No web worker is configured~~ — **closed 2026-08-24, with one condition moved rather than met**

**Two of three conditions met.** `renderer/src/workbench/workers.ts` installs
`MonacoEnvironment.getWorker` before `initialize` for four labels —
`editorWorkerService`, `OutputLinkDetectionWorker`, `LocalFileSearchWorker`,
`TextMateWorker` — every one read out of the installed packages rather than
inferred. And the workbench has since been driven through editing, Git, a
terminal and a debug session with no worker failure.

**The third was never measured, and is being moved rather than quietly dropped.**
This entry asked for "a note saying whether it moved C-054's reproduction rate —
measured, not assumed", and nobody has counted anything. Keeping C-061 open on it
would be wrong: the worker gap is fixed and proven. But so would closing it
silently, because the question is real. **It belongs to C-054**, which is the
entry that owns a reproduction rate, and it is recorded there.

The detail below is the original entry, kept for the reasoning.

**Observed repeatedly in one session**, thrown three times inside two seconds:

```
[error] You must define a function MonacoEnvironment.getWorkerUrl or
MonacoEnvironment.getWorker for the worker label: OutputLinkDetectionWorker
```

**Confirmed in the source.** `renderer/src/workbench/` contains no
`MonacoEnvironment`, no `getWorkerUrl` and no `getWorker` — the configuration is
absent rather than wrong.

**Why it matters more than the feature it broke.** The label in the message is
`OutputLinkDetectionWorker`, so what a person notices is that Output-panel links
are dead — trivial. But the gap is global: **any** service that asks for a worker
gets the same throw. That includes the editor worker behind diff computation,
word-based suggestions and link detection in ordinary editors.

**A possible connection to C-054, and it is a hypothesis rather than a finding.**
C-054 is a file opening to a blank editor after `doCreateTextModel()` has already
completed — a failure downstream of model creation, which is where worker-backed
services sit. **This has not been tested and must not be written up as a cause.**
The board has already paid once for reasoning ahead of the evidence on C-054.

**Done means**: a `MonacoEnvironment` worker factory registered for the workbench,
the error absent from a clean launch, and a note saying whether it moved C-054's
reproduction rate — measured, not assumed.

**First of the three, done — 2026-08-24, Phase 4 slice 4a.**
`renderer/src/workbench/workers.ts` installs `MonacoEnvironment.getWorker` before
`initialize`, covering four labels: `editorWorkerService`,
`OutputLinkDetectionWorker`, `LocalFileSearchWorker` and `TextMateWorker`.

**Every label and module was read out of the installed packages.** The three
overrides that need a worker each ship their own `./worker` entry;
`editorWorkerService` has none and comes from the client's own VS Code source
through the `./vscode/*` export map. `getWorker` rather than `getWorkerUrl`
because `StandaloneWebWorkerService._createWorker` tries it first, and a URL would
mean resolving a bare package specifier at runtime, which
`new URL(…, import.meta.url)` cannot do.

**Still open, and it is the larger half**: nobody has launched the app since. The
error being gone is unobserved, and whether this moves C-054 at all is exactly the
kind of claim this entry already says must be measured rather than assumed.

### C-060 · A loopback REH connection reported 23.5 s latency and an unresponsive extension host

**Observed in one hand-driven session**, against a server on `127.0.0.1`:

```
11:36:48 [warning] Remote network connection appears to have high latency (23505.50ms last, 5877.88ms average)
11:36:55 [info] Extension host (Remote) is unresponsive.
11:37:45 [info] Extension host (Remote) is responsive.
11:37:52 [info] Extension host (Remote) is unresponsive.
11:37:54 [info] Extension host (Remote) is responsive.
```

**23.5 seconds on loopback is not a network number.** There is no network. Whatever
this measures — the extension host blocking, the server's event loop stalled, a
socket starved behind something else in the same process tree — it is a stall
inside Chorus's own machinery, and it recovered and recurred within a minute.

**Why it matters.** This is the closest thing C-054 has to a mechanism. C-054 is a
file that opens, completes every traced boundary inside 92 ms, and then shows
nothing for sixty seconds; an extension host that stops answering for tens of
seconds is the right order of magnitude and the right shape. **It is still a
hypothesis** — nobody has observed the two together in one session, and C-054's
own record says an explanation resting on a single observation gets withdrawn.

**Done means**: the latency reproduced with something recording what the server and
the extension host were doing during the stall, so the number is attributed rather
than noted. Then a decision on whether C-054 folds into it or stays separate.

### C-059 · An unsaved change is invisible, and reverting it does nothing

**An editing-safety defect, not cosmetic polish.** Found while proving E5, in the
running workbench, and deliberately **not fixed there** — E5 was a persistence
item and this is a data-safety signal that deserves its own change.

Four facts, all observed in one run of `e2e/workbench-settings-persistence.mjs`
with `files.autoSave` set to `off`:

- **The editor holds unsaved content.** A marker typed into `notes.md` is in the
  editor's own view lines.
- **The file on disk does not have it**, sampled twenty times over eight seconds —
  `samples 00000000000000000000` — and the same file, in the same run, minutes
  earlier, had taken an edit to disk in 1,206 ms while auto-save was on. So the
  editor and its save path both work; the change is simply pending.
- **Nothing says so.** All three indicators are absent at once: no `dirty` class
  on the active tab (`tab tab-actions-right sizing-fit active selected
tab-border-bottom tab-border-top`), no filled-circle close action
  (`.codicon-circle-filled`), and no bullet in the window title.
- **`File: Revert File` does not respond as expected.** The command was found and
  run from the palette; the marker stayed in the buffer for the full 20 s the gate
  waited. Consistent with the workbench believing there is nothing to revert.

**Why it matters.** With auto-save on — the default, and what a reviewer meets —
the window is about a second and the cost is low. Turn auto-save off, which E5 now
makes durable, and the editor becomes one where you cannot tell what is unsaved
and cannot discard it either. Closing a tab or quitting then has no visible
warning attached to it. That is the ordinary shape of losing somebody's work.

**Not diagnosed.** Whether the working copy is genuinely not dirty or only its
decorations are missing has not been established, and the difference matters:
the first would mean the save path does not know there is anything to save, the
second would mean it does and says nothing. `getWorkingCopyServiceOverride` is in
the service set; nothing beyond that has been checked, and guessing further here
is what the trace work already showed to be expensive.

**Done means**: an unsaved editor shows a dirty indicator; `File: Revert File`
restores the file's contents on disk; and whichever of the two causes above it
turns out to be is named in the fix rather than papered over. Queued as the
**first stabilization fix after the UI review**.

**First diagnostic attempt, 2026-08-24 — inconclusive, and recorded so nobody
repeats it the same way.** The instrument is right and is worth keeping: Code-OSS
ships `Developer: Log Working Copies`, and `developerActions.js:377` prints
`${workingCopy.isDirty() ? "● " : ""}` before each URI, so one line of the Window
output channel separates "not registered" from "registered and clean" from
"registered and dirty" without adding a product-only debug API.

**What the run produced**, driven by hand:

```
11:38:10.771 [info]  [Working Copies] vscode-remote://127.0.0.1:56338/…/og.mobile.demo/.env.production (typeId: <no typeId>)  [Backups] <none>
```

**Registered, no `●`, no backup — which looks decisive and is not.** The file's
mtime on disk is **11:38:35**, twenty-five seconds _after_ the snapshot. So the
content reached disk, and the reading that fits every byte of this evidence is the
boring one: the log was taken before the edit, or auto-save was on. **The gate's
original observation is the one that cannot be explained away** — disk sampled
twenty times over eight seconds with `files.autoSave` off, unchanged
(`samples 00000000000000000000`), and no indicator anywhere. This run never
reproduced that state.

**What the next attempt must establish, in one session**: auto-save confirmed
`off`; the file's mtime recorded _before_ the edit; the edit typed and **no `⌘S`**;
`Developer: Log Working Copies` run within seconds; and the mtime re-read
afterwards and **still unchanged**. Only the `●`-or-not read against an mtime that
did not move answers the question. Two runs cannot substitute for one, because the
whole ambiguity is the ordering.

**Second finding, 2026-08-24, and it is about this entry's own evidence: "all three
indicators are absent at once" is one indicator and two checks that cannot come back
true.** The sentence was the strongest thing this entry said, because three
independent signals agreeing is hard to dismiss. Read against the source, two of the
three could not have been anything but absent — on a healthy dirty editor exactly as
much as on a broken one.

| Signal the gate reads                                  | Verdict            | Why                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tab.className.includes('dirty')`                      | **valid**          | `multiEditorTabsControl.js:1378` adds the `dirty` class. This one is a real negative.                                                                                                                                                                           |
| `tab.querySelector('.codicon-circle-filled') !== null` | **cannot succeed** | The dot is a `::before` pseudo-element — `multieditortabscontrol.css:462-467` sets `content: var(--vscode-icon-circle-filled-content)` on `.tab.dirty > .tab-actions .action-label`. **No element carries that class**, so `querySelector` returns null always. |
| `document.title.includes('●')`                         | **cannot succeed** | `services.ts:271` sets `window.title` to `${rootName}`. Chorus removed the `${dirty}` segment itself. No dirty state can put a bullet there.                                                                                                                    |

**And the second one is worse than merely broken — it was never independent.** Its
CSS selector is predicated on `.tab.dirty`, the very class the first check reads. Even
written correctly it would restate check 1 rather than corroborate it. The entry's
comment records that `dirty` "is read from three places, because the first one was
believed and was [wrong]" — both places added to shore it up are worthless, and one of
them is the first place again.

**What survives.** One valid indicator said not-dirty, and `File: Revert File` left the
marker in the buffer. That is a real pair of observations and this entry stays open on
them. What is withdrawn is the three-way agreement, which was the reason it read as
settled.

**Mohamad reports the workbench behaving correctly by hand across several sessions**,
which does not disprove a defect but does shift where the doubt should sit. **Do not fix
this until an ordered single-session observation confirms it** — a fix aimed at
decorations would now be aimed at two checks rather than at the product.

**And this is the seventh occurrence of the same pattern in this plan.** C-051 found six
checks that could only come back true; these are two that could only come back false.
The lesson has been paid for repeatedly and is worth stating as a rule: **a new
indicator is not evidence until it has been seen in its positive state at least once.**

**Id note**: this is C-059 and not C-058. C-058 was filed earlier in the same
session for the startup reaper missing a real orphan, and the board's rule is the
highest ever used plus one. C-057 stays retired — its withdrawn finding is cited
in C-054 — and nothing is renumbered.

### C-058 · The startup reaper missed a real orphan, and a person met the refusal

**Seen in ordinary use rather than in a gate**, which is what makes it worth its
own entry: Mohamad opened a project and got

```
Error invoking remote method 'workbench:open': A workbench server from an earlier
session is still running (pid 58942) and owns this profile's data directory.
```

**The fail-closed guard did exactly what it should.** It refused to spawn a second
server beside a survivor rather than starting one on a profile another process
owned. That is E4 working, and it is why the failure was legible instead of a
workbench that came up connected to nothing.

**The startup reaper should have removed 58942 and did not.** Every condition it
tests was satisfied: the process was **PPID 1**, it carried the same
`@chorus/desktop-dev` profile's `--server-data-dir`, and it **died instantly on a
plain `SIGTERM`** — so it was neither unkillable nor foreign, and neither of the
two reasons the reaper deliberately leaves something alone applied. Five such
orphans were killed by hand, **19–20 hours old**, left by old probe runs.

**Why it matters more than one refusal.** The reaper is the recovery path for
C-055 — a forced quit truncating shutdown — and E4 was closed on the strength of it
working. A reaper that passes its gate and misses in the field means that recovery
is weaker than the record says.

**What would make it done.** Reproduce the miss against a real orphan rather than a
faked process table: the unit tests drive a synthetic `ps` listing, so anything
about the real one — output width and truncation, a command line longer than the
buffer, a path that does not match the marker verbatim, a race between listing and
signalling — is untested. Then fix, and add a check that runs against a genuinely
orphaned server.

**Root cause, found by inspection on 2026-08-24 — the reaper can only kill a
process that is its own process-group leader, and it cannot tell that it failed.**

**Two lines do it, `workbench-host.ts:594` and the `catch` under it:**

```js
try {
  process.kill(-pid, 'SIGKILL') // negative pid = the process GROUP
  signalled.push(pid)
} catch {
  /* gone between the listing and the signal, which is the state we wanted */
}
```

**`kill(-pid)` addresses the group whose id equals `pid`, which exists only if that
process is the group leader.** An orphan that is _not_ a leader has no group by that
number, so the call throws `ESRCH` — and the `catch` asserts one interpretation of a
throw that has at least two. The process is recorded as "gone", never enters
`signalled`, is never waited on by the settle loop, and is still running.

**Then `survivors` finds it anyway** (`:641` maps every candidate and filters by
`processAlive`), so `start` refuses to spawn beside it. That is precisely the shape
Mohamad met: **a refusal naming a pid the reaper had just decided was gone.**

**Two facts in this entry corroborate it and are hard to explain otherwise.** The
orphan **died instantly on a plain `SIGTERM`** — `kill 58942`, a _positive_ pid,
which reaches the process regardless of group membership, while the reaper's
negative form could not. And the orphans were **19–20 hours old**, i.e. old enough
to predate E4's fix, when Chorus still spawned `bin/codium-server`: bash became the
group leader, node was a member, bash died, and node was left orphaned **with a PGID
pointing at a dead leader**. Whether 58942 was specifically such a process cannot be
recovered now, and the defect does not depend on it.

**It is not a legacy-only fault, which is the part that matters.** Chorus now spawns
the server directly and `detached`, so a healthy server _is_ a group leader. But the
server forks its own children — the remote extension host among them — and any of
them outliving the leader inherits exactly the same shape: alive, PPID 1, carrying
the marker, and unreachable by `kill(-pid)`. Codex's run on 2026-08-24 left **two
Electron helpers** that had to be killed by hand, which is the same family of
symptom.

**And this is the same pattern as C-059's indicators, one level down.** A `catch` that
names a single cause for a failure with several is a check that cannot report the case
it was written to catch. E4's record already lists six of these; this is one more, in
the machinery E4 built.

**Proposed fix, not applied.** Treat a throw as unknown rather than as success: after
`kill(-pid)` throws, ask `processAlive(pid)`, and if it is alive fall back to
`process.kill(pid, 'SIGKILL')` on the process itself before deciding anything. Push to
`signalled` in both paths so the settle loop actually waits. A `catch` here may record
that it could not signal — it may not conclude the process is gone.

**Done means**: the above, plus a unit test whose fake kernel throws `ESRCH` on the
group form and succeeds on the process form — a test the current implementation fails
— and a real-orphan check that does not use a synthetic `ps`.

**Id note**: C-057 is not reused. It was assigned to a numeric-`logLevel` defect
that turned out not to exist and was withdrawn before filing; ids never get reused,
including ones that never became entries.

### C-056 · A quick-open picker never focused its row, in a hidden surface

**Split out of C-054, because different stages cannot share one failure count.**
Observed once, in run 7 of the ten-run batch: surface A's quick open never offered
the file at all, so the open failed _before_ any editor existed.

```
timed out waiting for surface A: the focused row to be the one asked for
  (last: false) · offered: nothing
surface: {"visibility":"hidden","hasFocus":false,
          "activeElement":"DIV.editor-group-container.empty",
          "dialogs":0,"toasts":"","quickInputPresent":true}
```

**Three observations, and the third is the one that matters most: it happened with
exactly one workbench surface mounted.** One in the ten-run containment batch, one
in the Step 0 console control, and one in session 2 of the single-surface gate.

The second occurred in the first invocation of `workbench-console-control.mjs`: the
query reached the quick-input box — the wait on the box's value had already
passed — and no row with that label became focused within 60 s. That is this
entry's shape. It was first reported as "the agent's harness, not the product",
and **that is withdrawn**: no specific harness defect was identified, and asserting
one is assuming the instrument's innocence rather than checking it — the same error
this entry's original count made. Recorded as an observation until a defect is
named with evidence.

**One difference is worth stating and is not an excuse**: the control had
`Runtime.enable` attached to the surface, which no containment run did. Whether
that matters is unknown.

**The third, in the single-surface gate**, is the same shape again and removes the
two-surface confound: session 2 failed on the **first** open of the run, at
`A/a-first.md: the focused row`, after 60 s. The query had reached the quick-input
box — that wait passed — and no row with the file's label ever became focused. One
surface was mounted and its project root verified at the moment it failed, so
whatever this is, **it is not a consequence of two workbenches coexisting**.

**A gap in that gate, named rather than left**: unlike the containment gate, it does
not capture the picker's offered rows when this wait times out, so there is no
record of what the list actually held. That is a defect in the instrument and it is
why the third observation is thinner than it should be.

**The containment observation: exactly one picker timeout among 40 open attempts.
Only its _timeline_ is missing — not its detection.**

An earlier version of this entry said "one seen, unknown number missed", and that
overstated the uncertainty in the opposite direction from this project's usual
error. `openByPath` writes no trace when the picker throws, so there is no sampled
timeline — but it **returns a failure**, and the gate's claim for that open turns
red. A picker timeout in any of the ten runs would therefore have shown up as a
failed claim whether or not it produced a trace file. The reasoning that went wrong
was inferring _undetectable_ from _untraced_, without checking whether a different
mechanism already caught it. Same shape as the rest of this work: an unexamined
assumption about what an instrument can see.

So the count is firm. What is missing is the per-sample detail that would say
**where** in the pick it stalled — the offered rows over time, the focus state,
whether the list ever populated.

**Not attributed.** `visibility: "hidden"` and `hasFocus: false` are recorded
because they were in the snapshot, not because they explain anything — a surface
that is not visible is the ordinary state of a `WebContentsView` the harness has
not brought to front, and whether it is related is unknown. Nothing here says
whether this shares a cause with C-054.

**What would make it done.** A trace written for picker-stage failures too, so the
detail exists next time one occurs; then an explanation. The containment count
needs nothing — it is one in forty.

### C-055 · A forced quit truncates shutdown, and the next launch is the recovery

**Not a defect — a boundary, documented so nobody tries to close it again.** One
`SIGTERM` or `SIGINT` shuts Chorus down cleanly: every ordered stop exits `code=0`
with the workbench server's whole process tree reaped and its connection token
removed. A **second** termination signal arriving while that cleanup is still
running is a forced quit rather than a second polite request, and Chorus treats it
as one.

**What was observed, and only that.** With cleanup deliberately held open — the
gate `SIGSTOP`s the server's process group, so `waitForTreeToDie` spends its full
five-second grace — a second `SIGTERM` 200 ms in ended the Electron process with
`code=null signal=SIGTERM`, against `code=0` for every ordered stop, and the
server's group was left behind.

**No mechanism is claimed, and an earlier version of this entry claimed one.** It
said the termination happens "below the JS handler". That was an inference from
two failed attempts, not a measurement, and it sits badly with Node's documented
behaviour — a registered `SIGTERM` listener _removes_ the default exit
(https://nodejs.org/api/process.html#signal-events) — while Electron only promises
`preventDefault()` for its app-quit lifecycle
(https://www.electronjs.org/docs/latest/api/app#event-before-quit). Where the exit
actually comes from is **unestablished**. The observation stands; the explanation
was withdrawn.

**Two things were tried and neither helped**, recorded so they are not retried:
vetoing in `before-quit` (that guard is right and is in, but it governs the quit
lifecycle rather than the signal), and swallowing the repeat signal in the
`process.on('SIGTERM')` handler.

**The recovery is C-051's startup reaper**, and it is proved: the orphan is
reparented to init, carries this profile's `--server-data-dir`, and is killed on
the next launch — along with the token it left behind — before any project can
open. So a forced quit costs one idle server until Chorus is next started, not
forever.

**Not asserted in the shutdown gate**, deliberately: a claim that a signal cannot
kill a process is a claim that cannot be made. Repeated **in-app** quits are a
different question and are proved in `quit-gate.test.ts`.

### C-054 · A file can open to a blank editor — **critical tracked release defect**

**Two changes since the ten-run batch have moved the ground under this entry, and
neither has been measured against it.** Both arrived in Phase 4 and both are
plausible causes of a file opening to nothing, so the reproduction rate recorded
below describes a build that no longer exists.

- **C-061 — no worker was configured.** `MonacoEnvironment.getWorker` was never
  installed, so every worker-backed service threw, including the editor worker.
  Moved here from C-061, which asked for "a note saying whether it moved C-054's
  reproduction rate" and could not answer it: a rate belongs to this entry.
- **C-060 — 23.5 s latency on a loopback connection**, with the extension host
  going unresponsive twice inside a minute. A file that opens and shows nothing
  for sixty seconds is the right shape for an extension host that has stopped
  answering.

**So the next batch is not a re-run, it is a first run against a different
build.** Neither of the two above may be written up as the cause until that
happens — C-057 was withdrawn for exactly this, reasoning ahead of the evidence.

**Mohamad's decision, 2026-08-23: Chorus continues with `monaco-vscode-api` +
VSCodium REH. The fork pivot is cancelled.** C-054 stops being an architecture gate
and becomes a **critical tracked release defect**: it does not block building the
rest of the product, and it is revisited during stabilization before Chorus is
release-ready.

**It may not be presented as fixed.** It is live, unexplained, and reproducible at
roughly **two sightings in eleven single-surface sessions**. Anyone demonstrating
Chorus should expect a file to open to a blank editor occasionally, and should call
it this rather than a new defect.

**The title changed with the evidence.** It read "model resolution intermittently
does not complete within the observation window" until the boundary trace showed
model resolution completing promptly — see below.

**Phase 1 blocker. Ten containment runs, three reproduced** — runs 4 (21/24), 7
(17/24) and 9 (20/24); runs 1, 2, 3, 5, 6, 8 and 10 clean. Codex's decision rule
resolves without ambiguity: any failure keeps this a blocker.

**Seven model-stage timeouts among 39 traced opens, clustered in three runs:**

- **run 4** — 3 of 4 opens timed out
- **run 7** — **3 of 3 traced opens timed out**, alongside the picker failure now
  recorded as **C-056**; this is the worst-affected run
- **run 9** — 1 of 4 opens timed out

The picker-stage failure that used to be counted here is **C-056**; different
stages cannot share a failure count.

**Every `null` means "not resolved within 60 seconds" and nothing more.** That is
the whole of what a finite budget supports. An earlier version of this entry called
the defect _latency rather than a permanent stall_ on the strength of one 53-second
success — **that is withdrawn.** One open resolving slowly does not establish that
the seven timeouts would have resolved at all, and no window this gate could have
used would establish otherwise: a longer wait moves the number, not the kind of
claim.

**What was observed about slowness, kept separate from the timeouts.** Of the 32
successful traced opens, thirty resolved between 404 and 413 ms, one at 1 ms, and
**one at 52,999 ms**. So resolution _can_ take two orders of magnitude longer than
the healthy cluster. Whether that slow success and the seven timeouts are the same
phenomenon is unknown.

#### It reproduces with **one** surface mounted — the two-surface confound is gone

**The single-surface gate reproduced it.** That gate mounts exactly one workbench
at a time — A → destroy → B → destroy → A — and asserts the live surface count at
every step boundary **and on every poll inside every open**, so the property is
measured rather than arranged. The count is live CDP workbench targets, the same
counter the containment gate routinely sees read `2`, so it can disagree.

Session 3 of the batch, with `1 surface, root ok` asserted throughout:

```
A mounted, 1 surface, root ok
A opened a-first.md   in 38,829 ms   ← 4 lines, but two orders of magnitude slow
A opened a-second.txt in    434 ms
A destroyed, 0 surfaces
B mounted, 1 surface, root ok
B/b-first.md: the model to resolve — timed out after 60,000 ms
```

**Two anomalies in one session**: a success at **38.8 s** where every healthy open
in this gate took 316–434 ms, and then a 60-second timeout on the next project.
The 38.8 s figure joins run 9's 52,999 ms as a second measured instance of
resolution taking tens of seconds.

**What this settles.** C-054 was only ever seen with two workbenches mounted at
once, which the product-matched architecture does not do — so it was open whether
the ten-run evidence described a configuration the product would never be in. It
did not: **the defect survives the architecture change.** Nothing here says what
the defect is; it removes one explanation for it.

**Four valid single-surface sessions passed before it** — one clean session from
the pre-capture run, one fresh diagnostic session, and two of the batch.

**A gap in this gate, named**: it captures rich picker state on a picker timeout
but only a plain timeout string on a **model** timeout, so this sighting has less
detail than the containment batch's traces. The instrument was built for C-056's
boundary and met C-054's.

#### Step 7 — the resolve trace works, and the defect did not appear under it

**The trace is built, proved, and caught nothing, because C-054 did not reproduce
in the five instrumented sessions.**

**How the call site was reached.** Two attempts to patch a resolved service
instance recorded nothing. This one is a **build-time transform** in
`electron.vite.config.ts` that rewrites `TextFileEditorModel`'s own `readStream`
call site, armed only by `CHORUS_WORKBENCH_TRACE_RESOLVE=1` at build time. Chosen
over `pnpm patch` because a patch file and a lockfile entry outlive the round, and
a dependency patch nobody removes is worse than no patch. **Verified both ways: an
ordinary build contains 0 injected references, an armed build contains 6.**

Emitted fields are exhaustively: request id, resource, timestamp, boundary name,
and for a rejection the error `name` and `code`. **No content, no byte counts, no
error messages.**

**The healthy shape, from 25 instrumented opens across five sessions:**

```
resolveFromFile-entry +0ms → readStream-before +0ms → readStream-return +5..54ms
  → resolveFromContent-entry +0ms → doCreateTextModel +0ms
```

Read gaps: 5, 6, 7×2, 8×4, 9×2, 11×4, 12×2, 13×2, 14×2, 27, 34, 46, 54 ms.
**After the read: 47 of 50 boundary gaps are 0 ms and the other three are 1 ms.**

So in health, **essentially the whole of model resolution is inside `readStream`**,
and everything after it is instantaneous. That is a real result about the healthy
path and it says where to look if the defect is ever caught: a stall _after_
boundary three would be a departure from every healthy open measured.

**What it does not show.** C-054 did not occur, so no failing trace exists and **no
causal correction is identified**. The instrument is not absent and not ambiguous —
it is crisp and it worked on every open — it simply never met the defect.

**The distinction that matters for the fork decision.** The rule "no bounded repair
⇒ recommend the fork" is triggered here **by exhaustion of the session budget, not
by diagnosis**. Nothing in this round points at Code-OSS; the round ended without
the defect appearing. Those are different grounds for the same recommendation and
should not be conflated when the decision is taken.

**Removal.** The Vite plugin, its anchors and the harness sink must go before
Phase 1 closes, with the rest of the diagnostic apparatus.

#### Caught with the trace armed — the delay is **after** model creation

**Session 1 of the final batch reproduced C-054 with every boundary recorded. The
complete timeline, for `a-first.md`, one surface mounted and root verified:**

```
enter → first boundary        27 ms
resolveFromFile-entry     +0 ms   (t+0)
readStream-before         +0 ms   (t+0)
readStream-return        +65 ms   (t+65)
resolveFromContent-entry  +0 ms   (t+65)
doCreateTextModel         +0 ms   (t+65)
--------------------------------------------------
harness waited for rendered content:  timed out at 60,000 ms
```

**Every boundary completed inside 92 ms of the keystroke, and the editor never
rendered the file for the next sixty seconds.**

- The **read is not slow**: 65 ms, against a healthy range of 5–54 ms across 25
  instrumented opens. Marginally above, nowhere near a stall.
- **Model resolution is not slow**: `resolveFromContent-entry` and
  `doCreateTextModel` both land 0 ms after the read returns, exactly as in health.
- **The text model was created.** `doCreateTextModel()` fired.

So the question Step 7 was built to answer — _is the delay inside `readStream` or
after it?_ — has a third answer neither option covered: **the delay is after
`doCreateTextModel()`, downstream of everything this trace covers.** The file is
read, the model exists, and the editor does not show it.

**A correction to this entry's own instrument, and it matters.** `lineNumbers`
(`.margin-view-overlays .line-numbers`) was introduced here as the _model-derived_
signal that could disagree with the tab, and every earlier reading of
`lineNumbers: 0` was written up as "no resolved model". That was wrong.
`.margin-view-overlays` is produced by the **rendered editor**, so it cannot
distinguish _no model_ from _a model the view never painted_ — and the trace now
shows at least one instance was the second. The ten-run batch's seven "model-stage
timeouts" should be read as **timeouts with no rendered content**, which is a
weaker and different claim than the one recorded against them.

**No repair is proposed.** The trace says where the defect is not; it does not
identify a bounded correction, and nothing downstream of `doCreateTextModel()` was
instrumented. No further hook was added and no code was changed.

#### The raw rows, preserved rather than summarised

`tabAt` / `linesAt` / `contentAt` in ms from the moment Enter was pressed in quick
open. `linesAt` is `.margin-view-overlays .line-numbers`, one element per model
line — the model-derived signal, which can disagree with the tab.

```
run   order surface                     resource              outcome  tabAt linesAt contentAt
run1  1     surface A                   alpha-manifest.yaml   opened       3     405       407
run1  2     surface B                   beta-manifest.yaml    opened       2     405       405
run1  3     surface B after the close   beta-notes.md         opened       1     404       404
run1  4     surface B after reopening   beta-manifest.yaml    opened       7     410       410
run2  1     surface A                   alpha-manifest.yaml   opened       3     406       409
run2  2     surface B                   beta-manifest.yaml    opened       1     404       412
run2  3     surface B after the close   beta-notes.md         opened       1     404       405
run2  4     surface B after reopening   beta-manifest.yaml    opened       1     404       404
run3  1     surface A                   alpha-manifest.yaml   opened       5     407       408
run3  2     surface B                   beta-manifest.yaml    opened       3     407       409
run3  3     surface B after the close   beta-notes.md         opened       1     405       406
run3  4     surface B after reopening   beta-manifest.yaml    opened       1     404       405
run4  1     surface A                   alpha-manifest.yaml   TIMEOUT      1    null      null
run4  2     surface B                   beta-manifest.yaml    TIMEOUT      1    null      null
run4  3     surface B after the close   beta-notes.md         opened       8     412       416
run4  4     surface B after reopening   beta-manifest.yaml    TIMEOUT      1    null      null
run5  1     surface A                   alpha-manifest.yaml   opened       4     407       409
run5  2     surface B                   beta-manifest.yaml    opened       2     407       408
run5  3     surface B after the close   beta-notes.md         opened       2     404       405
run5  4     surface B after reopening   beta-manifest.yaml    opened       2     406       407
run6  1     surface A                   alpha-manifest.yaml   opened       4     407       412
run6  2     surface B                   beta-manifest.yaml    opened       1     404       405
run6  3     surface B after the close   beta-notes.md         opened       2     406       407
run6  4     surface B after reopening   beta-manifest.yaml    opened       3     406       407
run7  —     surface A                   alpha-manifest.yaml   picker failure — no trace written → C-056
run7  1     surface B                   beta-manifest.yaml    TIMEOUT      1    null      null
run7  2     surface B after the close   beta-notes.md         TIMEOUT      1    null      null
run7  3     surface B after reopening   beta-manifest.yaml    TIMEOUT      1    null      null
run8  1     surface A                   alpha-manifest.yaml   opened       6     413       417
run8  2     surface B                   beta-manifest.yaml    opened       3     412       412
run8  3     surface B after the close   beta-notes.md         opened       1     405       406
run8  4     surface B after reopening   beta-manifest.yaml    opened       1       1         2
run9  1     surface A                   alpha-manifest.yaml   opened       8     411       412
run9  2     surface B                   beta-manifest.yaml    opened       2     405       405
run9  3     surface B after the close   beta-notes.md         TIMEOUT      0    null      null
run9  4     surface B after reopening   beta-manifest.yaml    opened       1   52999     53000
run10 1     surface A                   alpha-manifest.yaml   opened       3     408       409
run10 2     surface B                   beta-manifest.yaml    opened       7     409       410
run10 3     surface B after the close   beta-notes.md         opened       2     406       407
run10 4     surface B after reopening   beta-manifest.yaml    opened       2     405       406
```

#### What the timeouts looked like

Tab in 0–8 ms; no model lines by 60 s. Throughout: `breadcrumbs` and `aria-label`
set, `lineNumbers: 0`, `explorerRows: 3` — the `vscode-remote` provider answering
`readdir` the whole time — no placeholder, no error, no toast, and a status bar
carrying the remote authority but none of the language/EOL/encoding entries a
resolved model produces.

**No active progress indicator, in the failing opens or the healthy ones.** An
earlier reading — that healthy opens begin with an active infinite progress bar, so
the failure is that state stuck — came from a **global** selector matching
unrelated startup activity. Scoped to the editor part and re-run, the indicator is
empty in both. **Progress distinguishes nothing here**, and the harness comments
have been corrected to say so.

#### What is not supportable

- **The YAML hypothesis.** `beta-notes.md` timed out in runs 7 and 9, so this is
  not confined to YAML resources.
- **Any layer assignment.** Two localisations were withdrawn, one because "it
  survived a surface close and reopen" was treated as evidence about session
  state — it is not, since the workbench partition is shared across surfaces and
  the REH is leased per project, so a surface teardown resets neither. Still live
  and unseparated: a transient `readFile` failure, ordering, shared-session state,
  model-service state, a resolver race.
- **A rate.** Three reproductions **clustered in three runs** — 3 of 4 opens in run
  4, **3 of 3 traced opens in run 7**, 1 of 4 in run 9 — are not independent
  trials. An earlier version of this entry described the clustering as "3 of 4 in
  one run and 1 of 4 in another", which silently dropped the worst-affected run
  from the record. An earlier
  version of this entry quoted a binomial interval; that was the wrong instrument
  twice over and is removed. The observation is the observation.
- **Anything from the server or from Chorus.** Reproducing and clean runs show the
  same server log — connections established, extension hosts launched, no refusal,
  no error — and the server does not log file reads at `--log info`. `chorus.log`
  never mentions the workbench.

**No client-side log exists for any of the ten runs.** The workbench's log service
writes to the renderer console, which the gate does not read. That is where the
answer most likely is, and it is the whole point of the proposal below.

**Artefacts**: `/tmp/c054/run{1..10}/` — per-open timelines, `workbench-server.log`,
`chorus.log`, `app-output.log`, `run.json`. `/tmp` does not survive a reboot, which
is why the rows above are in this file rather than referenced from it.

#### Step 0 — the healthy control, run and failed

**Authorized and run once. Both boundaries are absent from the renderer console, so
the console-based batch is abandoned.** Not a containment pass and not reported as
one: it ran a reduced scenario and asserted no containment claim.

Constraints met as recorded — one fresh process; surfaces A and B created and
rendered before anything attached; `Runtime.enable` and `Log.enable` attached only
to surface B's already-mounted target; four unique, never-before-opened fixture
files opened exactly once each; and nothing below the attach point that could
create a renderer.

**All four opens were healthy**, which is what makes it a control:

```
probe-alpha.md      resolved in 346ms, lines=4
probe-bravo.yaml    resolved in 318ms, lines=3
probe-charlie.txt   resolved in 314ms, lines=3
probe-delta.json    resolved in 335ms, lines=5
```

**Three console messages in total, across four file opens** — the complete
inventory, preserved because it is the justification for whatever replaces console
capture:

```
1 × [warning] %cElectron Security Warning (Insecure Content-Security-Policy) …
1 × [warning] Could not create web worker(s). Falling back to loading web worker
              code in main thread…
1 × [warning] You must define a function MonacoEnvironment.getWorkerUrl or
              MonacoEnvironment.getWorker…
```

**Messages mentioning a resource — a `vscode-remote://` URI, a `file://` URI or any
probe filename: zero.** All three are start-up warnings emitted once; none is
per-open. Read start, read result, model-resolution start and model-resolution
result: **all four absent.** Not "partially present".

**What is _not_ established by this**, and an earlier report of mine claimed it: the
log service's destination. Console silence proves the console is silent. The
destination needed source evidence, which is below.

#### Source inspection of the pinned client — read-only

Answers to the four questions, with what would make each false.

**1 · Remote `readFile` start/result — not logged anywhere, at any level.**

- `DiskFileSystemProviderClient.readFile` (the `vscode-remote` provider) calls
  `this.channel.call("readFile", …)` and returns. **Zero `logService` references in
  the file.**
- `FileService.readFile` / `doReadFile` / `doReadFileStream` contain no start or
  result logging; the only `logService` calls in `fileService.js` are error traces.
- `TextFileService.read` / `readStream` contain no logging.
- `RemoteFileSystemProviderClient` logs two `error` cases, both during provider
  registration.

_False if_ any of those layers logged, or a decorator wrapped the file service. No
such decorator exists in the pinned build.

**2 · Model-resolution start/result — logged, URI-correlated, at `trace`.**
`textFileEditorModel.js` routes every record through
`trace(msg) → logService.trace('[text file model] ' + msg, this.resource.toString())`,
so the resource is attached to each. The relevant call sites:

```
resolve() - enter                    start
resolveFromFile()                    immediately before the read
resolveFromContent() - enter         content in hand
doCreateTextModel()                  model created — result
```

**3 · Logger, level and sink.**

- `ILogService` is a `LogService` over a logger created with `id: windowLogId`,
  `name: rendererLogLabel`, resource `environmentService.logFile`.
- `ILoggerService` is `FileLoggerService(logLevel ?? getLogLevel(environmentService), logsPath, fileService)`
  — the **sink is a file** written through `IFileService` under `logsPath`. Not the
  console, which is consistent with Step 0's silence without having been proved by
  it.
- Chorus calls `getLogServiceOverride()` with **no argument**, so the level is
  `getLogLevel(environmentService)`: `Trace` only if `environmentService.verbose`;
  otherwise a **string** `logLevel` is parsed; otherwise `DEFAULT_LOG_LEVEL = Info`.
  Chorus passes `developmentOptions: { logLevel: LogLevel.Info }` — a **number** —
  so the string branch never matches and the result is `Info` by the default path.
  **That setting is a no-op that happens to agree with the default**, which is worth
  knowing before anyone changes it expecting an effect.
- `canLog(Info = 3, Trace = 1)` is `3 <= 1` → **false**. Every record in (2) is
  suppressed.

**4 · Are those exact records in the rendered Output panel? No.**

The plumbing exists: `logs.contribution.js` registers every non-hidden logger as an
Output channel sourced from `logger.resource` with `log: true`, and the window
logger is not hidden. **But the records themselves are never emitted**, so there is
nothing for the panel to show. A channel that would carry them is not the same as
records that exist.

An action can raise the active channel to Trace —
`workbench.action.output.activeOutputLogLevel.1` — but it is declared with a
submenu entry and no `f1`, so it is **not in the command palette**; reaching it
means the Output view's title gear, which is a coordinate click and the technique
this project abandoned. **And even at Trace the read boundary would still be
absent**, because no read-layer record exists at any level.

#### The E2E-only hook — two interception points tried, both unobserved, investigation stopped

**Codex's hard stop applies: the hook investigation is over and the question
returns to the architecture decision. No third interception layer was tried and
none is proposed.**

**Attempt 1 — `IFileService.readFile` / `readFileStream`.** Installer ran, four
files opened, zero read records.

**Attempt 2 — `ITextFileService.read` / `readStream`**, the narrowest boundary the
source path guarantees, since `TextFileEditorModel.resolveFromFile()` calls that
injected service directly. The first hook was **removed rather than kept
alongside**, so a silent record could not be ambiguous between "not called" and
"shadowed". Installer ran — `[chorus-diag] text-read trace installed on
ITextFileService read and readStream` is in the capture — four healthy opens
(315–377 ms), 275 console messages, and **zero `[chorus-diag] read*` records for
any URI**.

Acceptance, against the actual lifecycle order:

```
1 resolveFromFile() entered      position 2   [text file model] resolveFromFile() vscode-remote://…/probe-alpha.md
2 text read started              ABSENT
3 text read returned/errored     ABSENT
4 resolveFromContent() entered   position 3   [text file model] resolveFromContent() - enter …
5 doCreateTextModel() occurred   position 4   [text file model] doCreateTextModel() …
6 expected bytes rendered        yes — 4 model lines, 377 ms
```

**Four of six. The text-read boundary is not obtainable by patching a resolved
service instance**, and why is not established. `resolveFromFile()` is recorded, so
the model did call its text file service; the patched object is not the one that
call reaches. That was true of both attempts, at two different layers, and chasing
a third was ruled out before it could be started.

**What this leaves.** C-054 keeps everything it had: three reproductions in ten
containment runs, seven model-stage timeouts among 39 traced opens clustered in
runs 4, 7 and 9, and the model boundary now demonstrably observable and
URI-correlated. What is still missing is the read boundary — the one that would
say whether the delay is in the read or after it.

**The hook is now purposeless and its removal is due.** It was already an exit
requirement; with the investigation stopped there is nothing waiting on it. It has
been left in place rather than deleted unilaterally, because removing it is a
decision about what happens next rather than tidying.

#### C-057 was not filed, because the defect does not exist

The numeric `logLevel` no-op I reported is **withdrawn**. `getLogLevel` parses only
a string, which is true — but the browser environment service's getter returns
`LogLevelToString(options.developmentOptions.logLevel)`, so a number becomes
`"trace"` before `getLogLevel` sees it and `parseLogLevel` resolves it. The number
works, and Chorus's existing `logLevel: LogLevel.Info` genuinely sets Info rather
than coinciding with a default. The claim was wrong because it read the function
that consumes the value and stopped, without checking the one that produces it —
and it is recorded here rather than filed as an entry so that nobody fixes a
defect that is not there.

#### Removal is an exit requirement, recorded now

**The `diagnostics` capability, `renderer/src/workbench/diagnostics.ts`, its
descriptor field, its preload projection and its `CHORUS_WORKBENCH_DIAGNOSTICS`
gate must all be removed before Phase 1 closes.** It is a diagnostic that exists
because a boundary is missing from the pinned client, not a feature, and it is
written down here now rather than left to be noticed.

### C-053 · Workbench settings do not survive a quit

**The workbench session partition is in-memory** — `WORKBENCH_PARTITION` is
`'chorus-workbench'` with no `persist:` prefix, so the storage service's
IndexedDB and every preference written through it lives for the life of the app
and no longer. Change the theme, turn `files.autoSave` off, resize a panel,
disable the minimap: it holds for the session and is gone next launch.

**Why this is not a footnote.** It was first recorded as the small open half of
C-052, and that was the wrong size. The plan's goal is that Chorus _replaces_ the
editor a person already uses; an editor that forgets your settings every time you
quit is not a replacement for one, whatever else it does. It also interacts badly
with the decision C-052 records — auto-save is kept because it is Code-OSS's
native behaviour, and a person who wants it off must be able to turn it off and
have it stay off.

**The partition is in-memory on purpose, so this is a trade rather than an
oversight.** `workbench-surface.ts` says why: the workbench's durable state
belongs to Chorus rather than to a Chromium profile, and an in-memory session is
one fewer place for a connection token to survive a quit. Making it `persist:`
would undo that in one word, which is exactly why this needs designing rather
than flipping.

**What would make it done.** A decision on where workbench state lives — a
persisted partition with the token kept out of it, or a Chorus-owned store the
configuration and storage service overrides are pointed at — plus a check that
the connection token is still absent from disk after a quit, and a test that a
preference set in one run is still set in the next. Recorded as Phase 1 exit item
**E5**.

### C-052 · ~~The workbench auto-saves~~ · **the gate was editing the repository** — closed

**Reclassified, and the reclassification is the entry.** This was filed as
"the workbench auto-saves to the person's real files, and nobody chose that". The
auto-save half is wrong: **`files.autoSave = afterDelay` is Code-OSS's own web
default and Chorus keeps it deliberately.** Mohamad decided it. Nobody reading
this later should conclude auto-save was a bug, or go looking for the commit that
turned it off — there is none, and forcing `off` in production configuration is
specifically not wanted.

**What the defect actually was: a test harness pointed a live editor at the
source tree it was testing from.** The containment gate typed a marker into an
open buffer to prove the surviving editor still took a keystroke, and the buffer
was `apps/desktop/package.json`. The workbench saved it, correctly, and line 1 of
a tracked file became `CHORUS-ALIVE{`. Repaired surgically — `git checkout` would
have destroyed the branch's uncommitted dependency work — and the repaired diff is
32 additions, 0 deletions.

**Fixed.** The gate now creates **two disposable fixture projects** under
`tmpdir()`, opens and edits only those, and removes them in its `finally`. Two
consecutive passes confirm the checkout is untouched: `git grep CHORUS-ALIVE`
finds nothing outside this file and the gate's own source, and
`apps/desktop/package.json` is byte-intact.

**And the fix made the proof stronger, which is the part worth carrying.** The
failed assertion had been "the tab is dirty after typing" — an intermediate state
that auto-save correctly ends about a second later, so the test was asking the
system to be mid-flight when it was measured. Against a fixture the gate owns, it
now asserts the whole write path: the editor took the edit, **the file changed on
disk** within a bounded wait, the editor went **clean**, and the **saved bytes are
exactly the marker followed by the original content**. That exercises the editor,
the working-copy service, the save and the round trip out through the remote
extension host to a real filesystem. The dirty check touched none of it.

**One product fix travelled with it.** `services.ts` called `initUserConfiguration`
with a fixed object on every start, which **overwrote the user's settings file** —
so any preference a person changed was discarded next time a surface opened, and
`files.autoSave` would have been un-turn-off-able while looking, from that file,
like a setting nobody had touched. Chorus's own preferences now sit in
`configurationDefaults`, the layer a user's settings override in the normal way.

**What is not closed here, and it is not small: settings do not survive a quit.**
That was written up in this entry as a footnote, which understated it — see
**C-053**, which is now its own item.

### C-051 · ~~The remote extension host outlives the app~~ — **closed**

**Two faults stacked, and reading the launcher explained both.**
`bin/codium-server` is a bash script whose last line runs
`"$ROOT/node" "$ROOT/out/server-main.js" "$@"` — **without `exec`** — so bash
stayed alive as the server's parent, Chorus's child was a _shell_, and
`child.kill()` killed the shell while the 257 MB Node process it had started
carried on holding the port. The same file is `.cmd` on Windows, which `spawn`
cannot execute without a shell at all. And separately, Electron terminates on
`SIGTERM` by default, so `before-quit` never ran and nothing was asked to stop.

**Reopened four times, and every reopening found the same family of defect.** The
first six were checks that could only come back true; the last was one step
further along — a failure that could not be _seen_. Worth listing, because the
pattern is more useful than any one fix:

- a shutdown that signalled an `npx` wrapper and reported on the app;
- a start-in-flight test that **supplied the port by hand**, so cancellation was
  never exercised;
- an exit emitted against a process group **nobody then re-examined**;
- `reapTree` deleting its subject **before reading** whether it had died;
- the startup reaper counting `SIGKILL`s **sent** as `killed`;
- a `skipped` boolean that made "the platform has no strategy" and "the process
  table could not be read" the same value, so `start` spawned on the strength of a
  sweep that had never run;
- and finally four bare `.catch(() => undefined)`s in shutdown itself, so a
  workbench shutdown that **failed** let Chorus exit with no survivor result and no
  log at all — the lifecycle failure this item exists to expose, hiding inside the
  machinery built to expose it.

**What it is now.** The server's own `node` runs `out/server-main.js` — shell-free,
identical on every platform, direct child is the real server — spawned **detached**
so shutdown signals the **group**. Shutdown is **asynchronous, idempotent and
shared** by quit, `SIGTERM` and `SIGINT`. The in-flight start is **cancelled** by an
`AbortController` reaching `fetch` and the port wait, then given a bounded moment to
unwind rather than waited out. Force-kill follows a bounded grace; the token is
removed only once the tree is **confirmed dead**; an unasked-for exit **reaps the
group** and fails **closed**. The startup reaper is a **readiness barrier** `start`
awaits, identifying by this profile's `--server-data-dir` **and PPID 1, never by
executable name**; it reports **survivors** rather than signals sent, and `start`
**refuses to spawn** when any survive or when the sweep could not run at all.

**Every shutdown step now reports its own failure and then resolves**, and the quit
gate reports anything that escapes. The two paths are disjoint by construction,
which is what makes "a cleanup failure is reported exactly once" a property rather
than a promise — asserted by count and by identity, against three quits arriving
during one failing cleanup, so an implementation reporting per _quit_ fails it.

**Verified — `e2e/workbench-shutdown.mjs`, 18/18.** Window-close, `SIGTERM` and
`SIGINT` each exit `code=0` with every descendant gone and the token removed; then
the force-quit path in full — the detached server survives `SIGKILL`, the orphan is
reparented to init, the token is left behind, the next launch reaps both, and a
project opened **immediately** on relaunch leaves exactly one server, which is not
the orphan. Containment: **24/24**. Twenty-six unit tests; **seventeen defects
reinstated one at a time**, each turning exactly the test named for it red — and
one of those reinstatements found a _test_ that could not fail, which was rewritten
to assert the consequence the guard actually buys.

**Where the boundary is**: a _second_ termination signal mid-cleanup is a forced
quit, not a second request — **C-055**, with the startup reaper as its recovery.

**Windows is exempt and unverified.** No `win32-x64` artifact has been downloaded,
so `node.exe` at the tree root is upstream's convention rather than an observation;
`taskkill /T /F` — the only tree-kill Windows offers, with no graceful equivalent —
has never been run; and the reaper reports `skipped: 'unsupported-platform'` there
rather than pretending to a clean machine, which is also the one case `start` still
proceeds on a sweep that did not happen. **Windows x64 needs its own proof on a
real machine** and nothing here claims it.

### C-050 · Two Windows-only test failures, one older than the other

`CI / Typecheck, lint, test (Windows)` is red on `main`. macOS and Linux are
green, and `pnpm check` is green locally.

**`real-path.test.ts:51` — predates this work.** It asserts a POSIX absolute
path and Windows resolves `D:\no\such\root\at\all` for it. Introduced with
`58d1677`, and the scheduled CI run the day before 0.20.0 was already failing on
it, so the Windows job has been red for a while and nobody noticed — which is
its own finding.

**`workspace-watch.test.ts` — introduced by 0.20.0**, now skipped on `win32`
with the reason in the file. Windows sees one watcher nudge where the other
platforms see none, after a read-only git command the watcher is supposed to
attribute to itself. The path handling is already separator-aware, so this is
`ReadDirectoryChangesW` coalescing differently from `FSEvents`, or git for
Windows touching a file the POSIX one does not. The consequence is one spurious
workspace re-read, not wrong data.

**Neither is diagnosable from a Mac**, which is the same gap
`docs/windows-test-brief.md` was written for: nothing here has ever run the
installer, or this suite, on a real Windows machine.

**What would make it done.** Run the suite on a clean Windows VM, decide whether
the watcher's extra event is worth suppressing or merely tolerating, and fix the
path assertion so the job can go green — because a permanently red job is a job
nobody reads, which is how the second failure got in behind the first.

### C-049 · ~~Scroll position is lost when you switch away and back~~ · **closed by reverting**

Reading at row 185 of a long transcript, switching away and back, and landing at
row 0 — every run, both fixtures.

**Closed because the cause was removed, not because it was fixed.** The row
anchor that replaced `SessionCarry`'s pixel offset only means something alongside
the measured heights that convert it, and those live in a `useRef` that a remount
starts empty. Carrying them too stopped one pane mounting at all, so Phase 6
transcript virtualisation was deferred out of 0.20.0 and the pixel carry came
back with the fully-mounted transcript.

Verified after the revert: byte-heavy leaves at 16,777 px and returns at
16,777 px. Entry-heavy returns at the bottom, because `trimCarry` drops a view
over the character budget and the replayed transcript is shorter than the saved
offset — the pre-0.19.7 behaviour of that carry, and its own separate question.

**If virtualisation is revisited**, this comes back with it, and the open
question is why seeding `heights` from the carry stops a pane mounting. The
suspect is a carry object holding thousands of entries crossing `onCarry` into
`App`'s ref map on a path that runs during a commit. `transcript-window.ts` is
parked in the tree with its tests for whoever picks it up.

### C-048 · ~~A setState-in-render warning at boot, unlocalised~~ — **closed 2026-08-29**

`Cannot update a component (EditorPane) while rendering a different component
(App)` — once, on the first render, in `pnpm dev`.

**What is established.** It fires exactly once at boot, not in a loop, so
whatever it is happens during the initial mount rather than on every update.
`EditorPane` has no state of its own; it subscribes to the workspace store via
`usePane`, so something writes to that store while `App` is rendering. The
obvious candidates were checked and are all inside callbacks or promises rather
than render: `openSession` in `openFromHistory` and the start path, `focusPane`
in `renderSession`'s `onActivate`, `hydrate` in the restore `.then`. `usePane`
itself is a plain selector and writes nothing.

**Why it is not localised.** Vite forwards the message and not the stack, so the
component trace React points at is only visible in the renderer's own console.
Someone has to open DevTools on a cold start and read it there.

**Why it is not urgent.** React recovers — it schedules the update rather than
dropping it — so the symptom is a warning, not a wrong screen. But it is the
class of bug that produces an extra render pass at exactly the moment the
transcript is being mounted, which is the path two phases of work just spent
effort making cheap.

**Not from the transcript phases.** It names `App` and `EditorPane`, both from
the control-rail and editor work; the paging and virtualisation changes are in
`Session` and below. Recorded here rather than fixed because finding it needs a
DevTools session, and guessing at it would mean editing render paths on a hunch.

**Found by reading, not by DevTools — and the entry's own reasoning is what hid
it.** "The obvious candidates were checked and are all inside callbacks or
promises rather than render" cleared `hydrate` because it sits in the restore
`.then`. It does. But the `.then` only _calls_ `updateSessions`, and
`updateSessions` passes its argument to `setSessions` as an **updater** — which
React invokes during the render phase, not when the promise settles. So the body
containing `hydrate` and `setPlanning` ran while `App` was rendering, and
`EditorPane` subscribes to that store.

That also explains the two facts the entry established and could not join: once,
and at boot. Restore happens once, at boot.

**Fixed** by deciding the merged session list from `sessionsRef.current` before
touching state, doing the store writes there, and ending with
`updateSessions(() => merged)` — an updater that computes nothing and so cannot
have a side effect. The ref is what the updater's `current` would have been;
`updateSessions` keeps it in step on every write, and nothing races restore.

**The general lesson is worth more than the fix**: "it is inside a promise" does
not mean "it is not inside render" when the promise's job is to hand React a
function. Any `setState(fn)` where `fn` does more than compute a value is this
bug waiting to be reported.

### C-047 · The control-rail redesign orphaned a drawer's worth of UI

`debaae0` replaced the drawer sidebar with `QuickRail` and left the old half
standing. Nothing renders it and nothing fails.

**What is dead.** `SessionRow.tsx` still exports the row component that draws
`data-sidebar-conversation`, `data-session-more` and `.session-row-main`, and no
file imports it — only `StateMark` and `useSessionRowState` survive.
`data-arrange-toggle` appears in no source file at all. `.session-drawer` and
`.session-drawer-toolbar` exist only in `styles.css`. `data-rail-drawer`, which
`e2e/specs.mjs` clicks to open the drawer, was never in this design.

**Why it matters rather than being untidy.** One feature went with it silently:
`onOpenHistory` was dropped in the same edit, so `HistoryPanel` rendered for
nobody and no conversation in the log could be reached from the UI. That is
repaired — a rail button, guarded by `workspace/quick-rail-history.test.tsx` —
but it was found by accident, weeks later, while trying to profile something
else. Whatever else that edit dropped is still dropped, and the same silence
applies.

**The six e2e cases are the reason nobody was told.** `openDrawer` in
`specs.mjs` waits on `.session-drawer` and clicks `[data-rail-drawer]`; neither
exists, so every case behind it fails on the helper rather than on its
assertion — including "an ended conversation can be found again and reopened",
which is exactly the case that would have caught the missing history button.
The suite is not part of `pnpm check`, so nothing reported it.

**What would make it done.** A decision, per orphan, about whether it was meant
to survive the rail: the session context menu (`data-session-more` — rename,
restart, End), the Arrange toggle, and the sidebar rows themselves. Then either
a rail equivalent plus repaired specs, or deletion of the component, the CSS and
the specs together. Deleting the specs without deciding would remove the only
record that the features existed.

**Not a cleanup task.** It reads like one and is not: it is a list of features
that were removed without anyone saying they were being removed.

### C-045 · An outward symlink inside a project still opens

`ide:openFile` decides containment two ways since 0.19.6: the lexical
`isInside`, or the same check on both paths canonicalized. The second was added
because the first refused files that were genuinely inside — a project reached
as `/var/folders/…` against a path an agent printed as `/private/var/folders/…`
is one directory and its own realpath, and every absolute link into a symlinked
project failed.

The canonical check only ever _adds_ an acceptance, deliberately. Trusting it
alone would also close the reverse hole — a symlink **inside** the project
pointing outside passes today, so an agent that writes one and then links
through it reaches any file on the machine — but it would equally refuse a
symlinked `node_modules` and a linked package in a monorepo, which are ordinary
and which people rely on. That is a change to what the boundary _means_ rather
than a repair of it, so it was not made silently. `real-path.test.ts` has a test
asserting the hole, so nobody closes it by accident either.

Worth weighing against how little it buys an attacker: an agent that can create
a symlink in the project can already read and write the target directly. The
guard is about where `code -g` is pointed, not about what an agent can reach.

**Done when:** someone decides whether linked dependencies or the closed hole
matters more, and the test above is rewritten to assert the chosen behaviour.

### C-044 · Forking fails after a session's project folder changes

`spinOffTask` and `promoteAside` both branch from the agent's own `sessionRef`,
and a provider files that session under the directory it started in. Change a
conversation's folder with `setProjectDirectory` and the fork then looks for it
under the new one: `Session 069e00cb… not found in project directory for /var/…`.
The side task shows an error and no tab; promotion has always had this and
nobody noticed, because promoting after moving a folder is rarer than branching
after one.

Found by driving the app, not by reading — the first attempt at a side-task
verification set the folder first and failed for this reason rather than for
anything to do with the feature.

**Done when:** either the fork resolves the session against the directory it was
_started_ in (which the runtime knows), or the folder change ends the session so
the mismatch cannot arise. The first keeps more working; the second is honest
about what a folder change means.

### C-043 · A send can leave a pane waiting for a turn that never starts

Seen in the field on 0.17.2: a finished Claude reply with `getting started •••`
sitting under it, permanently, and a red mark on the tab. The waiting row is
`awaiting && view.working.length === 0`, and **every route out of it is
something that arrives** — an agent entering `working`, a system notice, or a
send that rejects and calls `onSendFailed`. A send that neither lands nor fails
clears none of them.

`Composer.send` is not the hole: it calls `onSending()` and then `onSendFailed()`
from a single `.catch` covering both the IDE snapshot and `sendMessage`. So the
suspect is a `sendMessage` that never settles — the conversation had codex in it,
and C-037 is a codex app-server wedging for seventeen minutes.

**A 90-second deadline bounds the row** (`AWAITING_MAX_MS`), so the transcript
stops asserting something false. That is a bound on the symptom and not the fix:
the message is still gone.

**The deadline used to go quiet, and that was worse.** This entry predicted it —
"the row disappears and no evidence is left" — and it came back as a second
report, _"still no thinking indicators when asking"_, with a screenshot of a
message alone above an empty pane. Nothing on screen said anything had ever been
expected. The row now stays and says the message may not have reached the agent;
`WaitingRow.test.tsx` pins both states, and has to, because with a healthy agent
the row is on screen for under a frame and the stalled state cannot be reached by
driving the app at all.

**`send` now logs a pair** — `message accepted` before delivery is awaited and
`message delivered` after it returns. `deliver` is awaited inside the IPC call,
so an adapter that hangs there hangs the call, which is invisible from every
side; accepted-without-delivered names that shape, and neither line means the
send never reached main. Both were the missing evidence: the first report's log
had nothing at all at the minute it happened.

Still not reproduced deliberately, and which half hangs is still unestablished.

**Done when:** an IPC send that hangs is impossible or observable — either
`sendMessage` cannot outlive a turn's start without settling, or a send that has
not landed reports itself as failed rather than as in progress — reproduced by
wedging the send on purpose and watching the pane say something true.

### C-042 · Nine e2e specs fail on `main`, and it is not flake

Measured on 2026-08-17 by running the suite in a clean worktree of `main` at
83db87f, to tell a branch's breakage from the suite's own: **22 passed, 10
failed.** The branch under test failed 9, a strict subset. Two runs on the same
tree produced 12 and 11 failures with a shifting membership, so there is flake on
top — but there is a floor of failures that is present every time.

C-029 describes this as _"passes about 6 runs in 10"_, which reads as a whole
suite that occasionally trips. What the baseline actually shows is a **cluster**:

```
the collapsed rail runs the day on its own
a session is one row, one preview and one menu
a rail drag places a session, and only Arrange reorders
the drawer docks, resizes within its range, and comes back that width
a terminal belongs to one session, and the global one is a different thing
```

Five of the ten are the workspace shell, which suggests one cause rather than
five, and the rest — reopening, usage, the pinned question, an agent's question —
have not been looked at at all.

**This is worse than the flake it is filed under**, because a suite with a known
failing floor cannot be read at a glance: "9 failed" means nothing until someone
re-derives which nine were expected. That is a manual baseline before every use,
which is exactly the cost a test suite exists to remove.

**Done when:** a run of the suite on `main` either passes or fails only specs
that are marked as known-failing in the runner's own output, so a number is
readable without a second run to compare against.

### C-041 · A selection is checked against a projection that cannot see the chrome

`openAside` refuses an excerpt it cannot find in the reply the log holds, and it
is right to: a caller that could name any event and any text could put words in
an agent's mouth. But the excerpt comes from `selection.toString()`, and the DOM
inside `.entry` contains more than what was said — a name, a time, a language
label, the buttons, the summary card's own heading. Each one is a way for a
genuine selection to be refused with _That passage is not part of that reply_.

`styles.css` fixes these one at a time with `user-select: none`, which is now
six selectors long: `.speaker`, `.entry-action`, `.md-lang` when this was first
hit, and `.entry-time` and `.summary-head` added on 2026-08-17 for the same
class of failure. **The list is the problem.** Nothing makes a seventh piece of
chrome opt in, so the next one is found by a user, and the failure it produces
says nothing about what went wrong.

Explain no longer goes through this path at all — it asks about the whole reply
from a button — so what is left is Translate and Ask about this, on a drag that
crosses chrome.

**Done when:** either the renderer sends what it selected in a form that cannot
include chrome — the source offsets it knows the range covers, rather than the
rendered text — or `.said` is the only selectable region of an entry by
construction, with a test that fails when a new element inside `.entry` is
selectable and not projected.

### C-040 · A failing turbo task on Windows CI reports no cause

`Typecheck, lint, test (Windows)` went red on the 0.16.0 merge. The whole of
what the log said was:

```
$ tsc -b tsconfig.build.json
[ELIFECYCLE] Command failed with exit code 1.
```

No diagnostic, no file, no line — `@chorus/workspace:build` failed in half a
second and turbo reported nothing about why. It took several minutes and four
log queries to establish that there was nothing to find, and the thing that
finally settled it was reasoning rather than evidence: the merge changed
`CHANGELOG.md` and two version numbers, the macOS typecheck passed on identical
code, and a re-run went green. Flaky.

**The flake matters less than the silence.** A red gate that cannot say what it
objects to is one nobody can act on, and the temptation is to re-run until it is
green — which is how a real failure gets waved through. `pnpm check` locally
prints the error; CI did not, because turbo buffers each task's output and the
failing task's was lost.

**Seen again on the 0.17.2 release, and this time the exit code said something.**
`@chorus/agent-protocol#typecheck` failed with `-1073741502` — `0xC0000142`,
`STATUS_DLL_INIT_FAILED`, which is Windows refusing to _start_ the process, not
`tsc` objecting to anything in it. So the silence above is not always total: the
number is the diagnostic when there is no diagnostic, and reading it settled in
one step what took four log queries the first time. The rest matched: a release
commit touching only the changelog and two version numbers, macOS green on the
same tree, a package neither commit had touched, and a re-run green. Worth
decoding the exit code before assuming turbo swallowed a real error.

**Done when:** a task that fails in CI names its own cause in the log —
`--output-logs=errors-only`, or whatever turbo now offers — verified by making a
task fail on purpose and reading the error out of the run.

### C-004 · Measure what catch-up actually costs

In a shared room each agent is fed what the other said, up to 12,000 characters a
turn, with activity capped at 40% so it cannot crowd out speech. It is the one
input Chorus invents, and it is careful — labelled `[Chorus]`, truncation
disclosed, the user's real message fenced off.

Nobody has measured it in practice. It does not make answers worse directly, but
it brings **compaction** forward, and compaction is the one moment the transcript
and an agent's memory stop agreeing.

**Done when:** a real two-agent room reports the catch-up size per turn and what
share of the context window it accounts for, so 12,000 can be judged as generous,
tight, or irrelevant on evidence.

### C-005 · The composed catch-up is not recorded

`user.message` holds what you typed; the agent received that plus a preamble
composed at delivery. It is a pure function of the events, so it is
reconstructible in principle — but if an agent behaves oddly you cannot read back
the exact text it was given.

**Done when:** either the delivered text is recoverable for a past turn, or this
is closed with the reason the log deliberately records the conversation rather
than the prompts.

### C-006 · Should any of the e2e suite run in CI

**Half unblocked, and the other half got worse when it was measured.** This
entry was briefly marked "unblocked for the first time" on the strength of five
clean suites. **That was withdrawn**: twenty runs put the suite at **6 of 10
clean** (C-029), so a green suite is what a full run says about 60% of the
time.

What genuinely improved is the _meaning_ of a green run rather than its
frequency. C-027 gave the runner a third outcome, so `all N passed` now means N
specs actually ran instead of possibly skipping in silence — which is what this
entry needed before CI could prove anything at all. And C-003's fix took the
worst offender to 0 failures in 560 spec-executions.

**But a 60% pass rate is not something to put in front of a pull request.** A
required check that fails four times in ten teaches everyone to ignore it, which
is worse than not having it — the same trade this entry already warns about in
its own last paragraph. **C-029 is now this entry's blocker, not C-027.**

The plan is written and unstarted at
`docs/plans/what-a-green-build-proves-2026-08-11/`. Its Phase 0 — does Electron
open a window on a GitHub runner at all — is still worth answering, because it is
independent of the flake rate and a failure there closes this entry a different
way.

Note C-031 before designing the job: the focus-dependent checks cannot run
alongside anything that takes the window server's attention.

**Do not write the spec count down anywhere.** This paragraph used to correct 26
to 28, `packaged.mjs` carried the 26, and by 2026-08-14 the real figure was 32 —
so the correction had itself gone stale, which is worse than the number it was
fixing. Both are now phrased without a total. `specs.mjs` is the count.

**Half of the fallback now exists.** The plan for this entry recorded that there
was no release checklist anywhere, and one of the two ways to close C-006 runs
through it. `CLAUDE.md` § Releasing is now that checklist, and it is explicit
that the e2e suite is **not** part of the release sequence and that a release
therefore proves launch, the native module, the composer and an agent joining —
nothing about the transcript, tabs, or a menu under load.

What it deliberately does **not** say is "run the suite before tagging", because
at 6 of 10 clean that would block two releases in five on a coin toss. Making it
a gate is exactly what fixing C-029 would buy.

CI runs typecheck, lint, format, tests and a build. It **cannot** run the e2e
specs or `verify:package`, because both drive real `claude` and `codex` CLIs with
real credentials. So a green PR is not evidence about the renderer, and this
session shipped a transcript change that way before a local run caught an
unrelated defect.

**Done when:** either a credential-free subset exists in CI (a launch, a window, a
store that opens — no agents), or the answer is written down as "run it locally
before tagging" and the release checklist says so.

### C-013 · A question card expires while you are answering it

`mapping.ts:1011` stamps every question set with `expiresAt: ctx.now +
ctx.approvalTtlMs`, and `approvalTtlMs` defaults to five minutes
(`claude-adapter.ts:788`). The deadline is wall-clock from the moment the agent
_raised_ the question, and nothing restarts it. Answering is not an input to it:
the card can be on screen, focused and half-filled, and it still goes. Approvals
carry the same stamp (`mapping.ts:1070`–`1126`).

Hit twice in one session. An agent asked a three-part question; both times the
card vanished mid-answer while the user was typing into it in another pane.

A question that runs out its deadline leaves a notice reading `A question went
unanswered in time.` (`transcript.ts:359`), and the agent is told nothing was
chosen and carries on. `transcript.ts:345` argues for that notice existing at
all, and the argument applies here exactly: _"without this the only trace is a
reply that quietly assumed something."_

**Confirmed from the log** (2026-08-10): 25 question sets raised, 15 answered,
**10 timed out, 0 cancelled** — and every one of the ten died at exactly 300.0s,
which is the TTL and not a dismissal. The inference was right and the count was
low by a factor of five. Planned in
`docs/plans/question-deadline-2026-08-10/plan.md`.

Why it matters beyond the annoyance: the deadline is hardest on the longest
answers, which are the ones attached to the questions most worth asking. Up to
four panes are mounted at once and attention is _expected_ to move between them,
so "typing in the other pane" is ordinary use rather than idling.

**The TTL is not the bug.** An approval nobody ever answers would wedge a turn
forever, and the timeout is what stops that. What is wrong is that the clock
ignores the person it is waiting for.

**In progress — phase 1 shipped** (`139bc41`). A card now shows a countdown in
its last minute, so a deadline is no longer invisible until the card is gone. The
threshold comes from the data: the median successful answer took 55 seconds.

Two of the three conditions below are met. What remains is the deadline itself
responding to the person.

**One of its two blockers has since cleared.** `askUserQuestionTimeout` defaults
to `'never'` in `sdk.d.ts`, confirmed with a stalled `canUseTool`, so **Claude
does not give up** and extending is safe from its side — the five minutes is
entirely ours to choose. Still open: the Codex probe, and how an extended
deadline reaches a card that has remounted, since the renderer replays only the
_original_ `expiresAt`.

One correction to the measurement above: those 15 `answered` outcomes record that
Chorus _sent_ an answer, not that Claude took it, and for part of that period it
did not (C-018). **10 of 25 is the optimistic reading**, and the figures are worth
re-taking now that answers land.

**"Holds focus" has since become a weaker signal than it was when this was
written, and the change came from the other direction.** A card no longer takes
the caret when someone is part-way through a sentence (C-028), because landing on
**Allow** mid-word meant the next Enter approved an unread command. The
consequence here is that a card can now be on screen, with a person plainly
working, and never hold focus at all — so a deadline keyed to focus would expire
on exactly the user it was meant to protect. A partial answer, or any input to
the card, survives that change; focus does not.

**Done when:** ~~the log has been read back to confirm which outcome actually
fired~~; a question the user is demonstrably engaged with cannot expire under
them — the deadline held while the card holds a partial answer, or reset on
input — and ~~a card genuinely about to expire says so while it can still be
answered~~.

### C-015 · An agent cannot address another agent

`parseMentions` runs in exactly one place: `runtime.send`, the path the **user's**
message takes. An agent's own output goes `ConversationService.consume` →
`handle` → `lifecycle` → `append`, and nothing on that path reads a mention. So
when one agent writes `@codex` in a reply, it is prose. It reaches the other
agent only as catch-up — trimmed to 1,500 characters per message inside a 12,000
character budget, with activity capped at 40% — and never as a turn addressed to
it.

Noticed by being unable to do it. Asked to have codex review 3,383 lines, the
only thing I could produce was a brief for the user to copy across by hand, or
to point at the hand-off button. `sendHandoff` does deliver in full and does
bypass catch-up, but it is driven from the UI by a person: `Entry`'s `onHandOff`
is a button, not something an agent can reach.

**Why it matters:** the premise is several agents in one shared conversation, and
right now every exchange between them is relayed by hand. Review, second
opinions and hand-backs are exactly the collaboration the product is for, and
each one currently costs the user a copy and paste.

**Why it is not obviously a bug.** Agents addressing each other directly is a
real product decision with teeth: two agents that can each start the other's turn
can loop, and a loop here spends the user's money while they are not looking.
Whatever ships needs a bound — a depth limit, a visible cost, or the user
confirming the first hop — and choosing which is the actual work.

**Done when:** either an agent's mention routes like the user's, with that bound
written down and enforced; or this is closed with "agents talk through the user
on purpose" recorded as a decision, so it stops being rediscovered as a gap.

### C-016 · A delegation that comes back

Asked for directly: _"claude writes the plan and asks codex to review; after the
review let codex notify claude, fix the plan from the review, then start
implementing."_

**This is not C-015, and filing it as one would lose the hard half.** C-015 is the
outbound hop — a mention in an agent's reply routing like the user's. This is the
_return_, and the return is what makes it a workflow rather than a message:

- the delegating agent has to still be **waiting** — its turn suspended on an
  answer from another agent, not ended;
- the reviewer's reply has to arrive as something it must **act on**, not as
  catch-up prose it may summarise;
- and it has to **carry on with the original task** afterwards, which means the
  continuation is a turn nobody typed.

Every one of those is absent today. C-015 is a prerequisite, not a duplicate.

**Why it matters:** this is the product premise, and this session paid for its
absence repeatedly — every codex review was relayed by hand, in both directions,
because there was no other route.

**The teeth are in the failure modes**, and they are worse than C-015's. Two
agents that can each resume the other can loop; a suspended turn that is never
answered wedges rather than merely going quiet — the same clock problem C-013
describes, one level up; and a continuation nobody typed spends money while the
user is away from the screen.

**Done when:** the round trip above completes without the user relaying anything;
the delegating agent's resumption is in the log as its own turn, attributable to
the delegation rather than appearing from nowhere; and a reviewer that never
answers, or a pair that ping-pongs, is bounded — with the bound written down and
visible to the user rather than implicit.

### C-021 · The log cannot rebuild a conversation, because tool output is capped

Found by C-017's Phase 0. `tool.completed` stores a `summary`, and for a `Read`
it is capped at `MAX_TOOL_DETAIL = 120` characters — measured over the live log,
196 Reads with a **maximum of 120 and an average of 41**. `Edit` and `Write` sit
at the cap too.

120 is a sensible width for a **line in a transcript**. It is sitting on the
**durable log**, which is the thing this project says is the source of truth, and
the consequence was measured rather than argued: a room rebuilt from Chorus's own
record could not answer a question about a file the agent had read, while a
provider fork could.

**Why it matters:** "the event log is the source of truth" is the rule everything
else here follows from. For agent _speech_ it holds. For what an agent _saw_ it
does not — the log records that a tool ran and roughly what it was, not what came
back. Anything that needs to reconstruct an agent's working state from the log is
therefore built on sand, and C-017's Part B has to fork a provider session
precisely because of this.

**Why it is not a simple fix.** Storing full tool output means storing whatever a
tool read — including the contents of files the permission engine treats as
secret, which the answer-redaction path deliberately keeps out of the log. Size
is the lesser problem; deciding what may be written down is the real one.

**One slice has since landed.** `tool.completed` now carries a `patch` for file
edits, so what an agent _changed_ is in the log in full. That was tractable
because the secrets question had an existing answer — the field is a string named
`patch`, so `redactPayload` scrubs it on the way to disk. Nothing about what an
agent _read_ has changed, which is the harder half and the one this entry is
about.

**Done when:** either the log carries enough tool output that a conversation can
be reconstructed from it — with a stated rule about secrets — or it is written
down that the log records the conversation and not the agent's working set, so the
next person does not rediscover this as a bug.

### C-022 · The transcript reducer hardcodes English

`transcript.ts` builds every system notice from an English literal —
`'A question went unanswered in time.'`, `'Interrupted.'`,
`'Denied — nobody answered in time.'` and now
`'Opened as a conversation…'` — while `CLAUDE.md` says the opposite:

> **No hardcoded user-facing strings** — `i18n/en.json`. The reducers have no
> translator, which is why events carry keys (`notice.source`) and the renderer
> turns them into words.

The stated design exists and is used for some things; the notice path is not one
of them. Noticed while adding `aside.promoted`, whose line was written the same
way rather than inventing a second mechanism for one event.

**Why it matters more than it looks:** the app already ships an explain-in-your-
language feature and RTL support, so a user reading Arabic gets a transcript with
English system lines in it. And the workaround is not "translate in `Entry`" —
the reducer decides the _wording_, so the key has to come from the reduction.

**Done when:** the notices `transcript.ts` produces carry keys rather than
sentences, `en.json` holds the words, and a pure-reducer test can still assert
what was produced without a translator.

### C-019 · A rejected answer is still logged as answered

Split out of C-018, which it hid. `userinput.answered` is appended when _Chorus_
sends the answer, and nothing checks whether the provider took it — so for as
long as the answer shape was wrong, the transcript read `outcome: 'answered'`
while the agent behaved as though nobody had replied. The bug was invisible in
the one place anyone would look for it.

The same is true of approvals: `approval.decided` records our verdict, not the
provider's acceptance of it.

**Why it matters beyond the bug that is now fixed:** it will hide the next one.
It also means the log cannot be trusted for exactly the kind of measurement
C-013's plan is built on — "15 of 25 answered" counts answers sent, not answers
received.

**Why it is not trivial.** `canUseTool` returns a value; a rejection surfaces as
a later tool error or a retry, not as a failed promise, so there is no obvious
place to notice. Anything built here has to avoid claiming the opposite falsehood
— an answer that did land, recorded as failed — and must not add a round trip to
the common path.

**Partly addressed.** `answerUserInput` now refuses an `answered` response whose
answer ids do not exactly match the questions asked, before anything is written —
so the one case Chorus can detect for itself no longer produces a false record,
and the adapter denies rather than sending a partial set. What remains is the
case Chorus cannot see: an answer the _provider_ rejects for a reason of its own.

**Done when:** an answer the provider rejects is distinguishable in the log from
one it accepted, or this is closed with the reason the log deliberately records
what Chorus did rather than what the provider made of it.

### C-026 · A resize costs two seconds of settling — **measured, and much smaller than filed**

Filed as "a narrow pane never stops resizing itself", from an observation that
the `ResizeObserver` fired fourteen times in 107ms and was "still firing" when
the measurement ended.

**That was wrong.** Measured properly in
`docs/plans/the-pane-that-never-settles-2026-08-11`: a quiet narrow pane costs
**zero** callbacks over ten seconds, and so does a selection. The 107ms had
landed inside a settling burst that follows a _resize_, and the burst had simply
not finished yet. Extrapolating it to "forever" was the error.

The scrollbar and the spacer were both eliminated by measurement rather than
argument: `clientWidth` and `offsetWidth` never moved across any callback, and
`spare` converged monotonically instead of alternating.

**What is actually left:** a resize takes about **38 layout-and-observer cycles
over roughly two seconds** to converge, where a settle might reasonably take two
or three. It terminates on its own, nothing is visibly wrong, and it costs
nothing when the pane is not being resized.

**Why it stays on the board at all:** a resize is a user action, and two seconds
of churn behind it is perceptible on a slow machine. It is a performance nicety
now, not a defect.

**A second resize path now exists, and the obvious instrument does not work.**
The terminal panel resizes `.score` on every toggle and every drag, so this is
slightly more reachable than it was. Measuring it was attempted and abandoned:
counting frames until `.score`'s geometry stops moving is **not valid in a driven
window**, because Electron throttles `requestAnimationFrame` when the window is
not frontmost — it produced 0, then 1, then hung. That is C-031's problem wearing
different clothes.

The original 38 came from wrapping the app's own `ResizeObserver`, which has to be
installed **before the renderer's scripts run**. The harness attaches after load,
so re-measuring needs a harness change rather than another probe. That is the
next step, and it is the same change C-031 would want.

**Done when:** either a resize converges in materially fewer cycles — with the
count before and after stated, over the same stimulus — or this is closed as
acceptable, with the 38 written down so nobody re-derives the alarm from the
same observation.

### C-028 · The blocking cards are only ever tested away from the app

Three focus defects were fixed in one session and **not one of them can fail the
suite**. `e2e/specs.mjs` drives an agent, a transcript, tabs, the sidenav and the
composer; it never raises an approval or a question, because raising one means an
agent deciding to ask. So the two cards that stop a turn are the two surfaces
nothing exercises.

What was fixed, and what each was actually verified against:

- **A card took the caret mid-sentence.** An approval or question arriving while
  you typed moved focus to **Allow** — the rest of the words went nowhere and the
  next Enter approved a command nobody had read. Verified by a pure predicate
  (`focus.ts`) and a Chromium read of `document.activeElement` over real
  controls.
- **`useDialog` re-focused on every parent render.** Every caller passes an
  inline `onClose`, so a `Session` re-rendering on each streamed delta tore the
  effect down and set it up again, throwing the caret out of the handoff's brief
  box and back onto its `Ask them to` select. Verified by bundling the real hook
  with React 19 and driving re-renders: the old one jumped to the select after
  one, the new one held through five.
- **A long approval put its own buttons off the pane.** Measured against the real
  stylesheet in an 800px pane: the dock stood at **1529px** and Allow sat **684px
  below the bottom of the pane**, unreachable — at every pane height tried.

Every number there came from a harness holding the app's real stylesheet or its
real hook. The harnesses were temporary; the regressions they would catch are
not.

**Why it matters:** this is the most expensive place in the product to be wrong —
approving an unread command is the worst outcome it has — and two of the three
fixes are one careless dependency array from coming back. It is C-027 seen from
the other side: that entry is about a suite reporting green while testing
nothing, and this is a suite that cannot go red for these at all.

**Done when:** a spec provokes a real approval and asserts three things — the
caret stays in a half-typed composer, the buttons are inside the pane for a long
command, and a handoff sheet keeps focus across a parent re-render — or it is
written down that these are covered by unit and harness only, with the reason a
real approval cannot be provoked on demand.

### C-029 · A slow run fails, and load is not why — **measured over 20 runs**

Filed as "four specs fail under the suite that pass on their own". After twenty
full-suite runs the shape is different in every particular except the symptom.

**The rate: 6 of 10 clean**, in two separate ten-run batches that agreed exactly.

| batch                                  | clean | failing |
| -------------------------------------- | ----- | ------- |
| first (contended — other work running) | 6/10  | 4/10    |
| second (nothing else on the machine)   | 6/10  | 4/10    |

The second batch exists because the first was taken while a merge and a full
`pnpm check` ran alongside it, and that had to be ruled out rather than argued
about. It was not the cause.

**Duration predicts failure perfectly. Load does not predict duration.**

| run      | wall     | load before → after | result            |
| -------- | -------- | ------------------- | ----------------- |
| clean ×6 | 285–324s | —                   | 28/28             |
| slow ×4  | 400–665s | —                   | 2–3 failures each |

Every clean run finished in **285–324s**; every failing run took **400–665s**.
But the load average says the obvious explanation is wrong:

- run 3 started at load **12.19** and passed; run 8 started at **19.11**, the
  highest in the batch, and passed;
- run 5 failed while load **fell**, 7.22 → 4.23; run 9, the worst at 665s, sat at
  a mild 7.75 → 8.52.

**So "they fail under load" is dead**, and so is the focus-stealing story that
replaced it — that was inferred from a single unprompted window blur (now C-030)
and never survived a measurement. Something makes a run take twice as long, and
whatever that is, it is not CPU contention and it is not the machine being busy.

**Which specs, over the clean ten:**

| spec                                                       | rate |
| ---------------------------------------------------------- | ---- |
| `keeps the offer when the transcript scrolls under it`     | 4/10 |
| `offers only the actions a passage can actually take`      | 3/10 |
| `the question stays at the top of the answer it asked for` | 2/10 |

**The population is not stable and that is a finding, not noise.** The first
batch had two _sidenav_ specs failing 2/10 each — layout specs that were never on
this entry's list — and they did not fail once in the second. The worst offender
swapped places between batches. What survives across both is the quote-offer
family plus the question spec.

**Two of the original four are fixed and gone from this list.** `typing a slash
offers the commands this project actually has` and `an @ offers the cast` failed
**0 times in 20 runs — 560 spec-executions** — after C-003. That is the strongest
evidence available that the blur fix holds.

**What is known about the survivors.** All three wait on something that appears
after a selection or a turn completes. The quote offer is built synchronously on
mouse-up and then _cleared_ by a later `selectionchange` when the selection
collapses — and a selection is a Range over text nodes, so a re-render that
replaces them collapses it. That is a hypothesis with a mechanism, not a
diagnosis: it was never instrumented, because the fix for C-003 landed first and
this was left.

**Two cautions this entry paid for, worth keeping:**

- **Five runs cannot see a 30% flake.** A five-run baseline came back clean and
  was reported as "does not reproduce"; it was withdrawn. Ten is the floor for a
  per-spec rate.
- **A remembered baseline is worth less than a back-to-back A/B**, because the
  machine drifts between measurements — identical work took 274s and 665s in one
  day.

**Done when:** the three surviving specs have a named cause — the obvious next
move is to instrument _why_ `setSelected(null)` fires, the same "record the
decision, not the outcome" move that broke C-003 open — or the suite is made to
tolerate whatever doubles a run's wall clock, with the rate restated over ten
runs.

### C-030 · Something blurs this machine's windows unprompted

Found while diagnosing C-003 and never explained. A debug run watching a single
Electron window recorded `document.hasFocus()` going from `true` to `false`
**with nothing driving it** — no click, no app switch, no probe action — about
ten seconds after a menu opened.

**Why it matters:** it is the reason C-003 was reachable at all. A blur that
nobody asks for is what turns "the menu never comes back" from a theoretical bug
into one a user meets, and it means any measurement of window behaviour here has
a hidden variable in it.

**It is not the explanation for C-029, and this entry used to claim it was.**
That claim came from one observation and was never measured. Twenty full-suite
runs since then put every C-003 spec at 0 failures and leave three specs failing
that have nothing to do with focus — and the load evidence there kills the wider
"the machine was busy" story too. This stays open on its own merits, not as
another entry's cause.

Candidates never eliminated: `mediaanalysisd` (seen at 171% CPU), Spotlight
indexing, a notification, or something in the window server. Whether it happens
on other machines is unknown, and that is the first thing worth knowing.

**Done when:** the source is named, or it is shown not to happen on a second
machine — in which case it is this Mac's problem and gets recorded as such rather
than chased in the app.

### C-031 · The e2e probes take focus from whoever is using the machine

The harness drives a real window, and several diagnostics for C-003 had to steal
OS focus with `osascript` to test blur and refocus. Two costs, both paid:

- **Stray keystrokes land in the composer under test.** A probe run was scored as
  a failure carrying `mention: "@0:ceten"` — characters typed by the person at
  the keyboard, arriving in the test's own box while the probe held focus.
- **The probes stop working when the machine is in use.** Twelve consecutive runs
  failed at `never became true: window focus`, because macOS would not hand
  focus over while someone was working in another app.

**Why it matters:** it makes a class of measurement unrepeatable at exactly the
times someone is around to ask for it, and worse, it can produce a _confident
wrong result_ rather than an obvious failure — the `ceten` run looked like a
defect and was not.

**Done when:** either the focus-dependent checks can run without taking focus —
a second display, a headless window, or a `WebContents`-level blur that does not
touch the window server — or the suite states plainly that these specs need an
idle machine and skips with a reason when it cannot get one, which C-027's
mechanism now makes possible.

### C-032 · The terminal is covered by seven throwaway probes and no specs

`apps/desktop/build/*-probe.mjs` and `pty-smoke.cjs` drive the real app and cover
things nothing else does: a shell surviving its own view, `⌘K` clearing both the
screen and main's mirror, the caret staying in the terminal on a click, panels
returning at the right height after a relaunch, and the packaged bundle spawning
a PTY at all.

They are not run by anything. `pnpm e2e` does not know about them, CI cannot run
them, and each has to be remembered by name.

**Why they were not written as specs:** C-029. A suite whose result needs two
runs to interpret is a poor home for coverage of a feature nobody has used for
long, and the plan said so rather than adding to the pile.

**Why it matters anyway:** every one of them found something. Two found defects
that four earlier probes had missed, and one — the `⌘K` chord check — passed with
the guard removed until it was rewritten to measure `defaultPrevented`. That is
C-027's failure mode in new code, caught only because someone mutated the guard.

**Done when:** the coverage lives somewhere that runs on its own, or the files are
deleted with a note saying what was given up. Sitting in `build/` as neither is
the outcome to avoid.

### C-033 · Nothing decides whether killing a terminal loses work

`TerminalService.describe()` reports `{ running, foreground, busy }`, and nothing
consumes it. Ending a conversation kills its shell without asking, and quitting
kills the global one — mid-`ssh`, mid-`psql`, mid-migration, with no confirmation.

The plan deliberately built the _answer_ without choosing the _policy_, so that
all three candidates — never ask, ask when busy, ask only on quit — sit on top
without changing a signature.

**One measurement that constrains the choice.** `busy` is an instantaneous
sample, not a claim about the next second. A probe asserting it stayed true
failed with foreground `zsh` while a `for … echo … sleep` loop was demonstrably
still running, because between sleeps the foreground _is_ the shell. **A
confirmation keyed on `busy` alone would say "nothing running" mid-loop and kill
the work it exists to protect.** Whatever ships needs either a window rather than
a sample, or a different signal.

**Done when:** a terminal with live work either cannot be killed silently, or it
can and that is written down as a decision with the reason — and if it asks, the
signal it asks on is not a single sample of `busy`.

### C-035 · A notebook cell is a document the editor context cannot name

`resolveDocument` (`packages/ide-protocol/src/document-identity.ts`) now parses
`file:`, `git:` and `gl-review:` and refuses everything else, on purpose: a
scheme nobody has read yields a wrong path rather than none, and main's
re-validation turns a wrong path into a silent `unmatched`.

`vscode-notebook-cell:` is the one refusal a user will actually hit. A cell is a
real `TextEditor` with a real selection, so the selection is there to be read —
but its URI names the `.ipynb` and carries the cell in a fragment, and a
reference of `notebook.ipynb:12-14` means nothing to an agent: line 12 of the
JSON file is not line 12 of the cell. Making it work means carrying a cell
identity through `EditorMetadata`, the pill and the reference format, which is a
protocol decision and not a parsing one.

Until then a notebook behaves as it did before this work: no context, and — since
"a document is not a file" landed — at least no longer wiping the selection you
already had.

**Done when:** either a cell selection produces a reference an agent can act on,
or the refusal is written down as permanent with the reason, so the next person
does not rediscover it as a gap.

### C-036 · ~~The extension speaks English, and the app's rule says it must not~~ — **closed 2026-11-07, moot**

**Closed:** plan 86 deleted `apps/vscode-extension`, so the strings below no longer
ship anywhere. `apps/extension` is a different extension and this entry does not
cover it.

"No hardcoded user-facing strings — `i18n/en.json`" is a renderer convention that
`apps/vscode-extension` has never followed. Its manifest strings go through
`package.nls.json` properly, but everything it writes at runtime is a literal in
`extension.ts`: the status bar's `Chorus: linked`, `Chorus: not running`, both
`update the extension` / `update Chorus` warnings with their tooltips, and every
line of the `Chorus: Diagnose editor context` dump.

Pre-existing — the first two shipped with the feature — but the protocol-2 work
added five more without deciding anything, which is how a convention quietly
becomes an exception.

**Why it matters:** these are the strings a user reads at the worst moment. The
mismatch warning exists precisely because editor context has gone silent, and it
is the one instruction that unblocks them. If Chorus is worth translating, the
sentence telling you the extension is out of date is not the place to stop.

**What makes it awkward rather than obvious:** the extension host has its own
mechanism, `vscode.l10n`, which is not the app's `t()` and wants bundle files
declared in the manifest and shipped inside the VSIX. So this is not "import the
translator" — it is a second localisation system, in a build that deliberately
writes its own VSIX by hand to avoid dependencies. The diagnostics dump is also
arguably not user-facing prose but a bug-report artifact, and translating it
would make pasted reports unreadable to whoever receives them.

**Done when:** either the runtime strings a user acts on go through `vscode.l10n`
with the VSIX carrying its bundle, or the extension is written down as English-only
with the reason — and in that case the diagnostics dump is named as the thing that
stays English on purpose.

### C-037 · A session spawns codex app-servers and reaps none

Observed 2026-08-13, 21:50. One `pnpm dev` Electron process (pid 41382) held **26
children, 16 of them `node codex.js app-server`**, spawned in a roughly
twenty-second burst and then idle at **0% CPU** for seventeen minutes. The codex
agent in that session stopped answering and never recovered; `SIGTERM` was
ignored by all sixteen and `SIGKILL` was needed. Six more, aged two to twelve
hours, were sitting under a different parent, so this had already happened at
least twice earlier the same day without anyone noticing.

Killing them was enough to un-wedge the app — codex then reported `codex
app-server exited (code=null signal=SIGKILL)` and could be restarted — which says
the pile-up is the failure rather than a symptom of one.

**Why it matters:** a wedged agent looks exactly like a slow one. There is no
surface anywhere in Chorus that shows how many provider processes a session owns,
so the only way this was found was `ps`. The user's read on it was "why does every
task take hours", and for the last seventeen minutes of that, the honest answer
was that nothing was running at all.

**What is not yet known:** which side leaks. It could be the supervisor spawning a
fresh app-server per turn or per reconnect and dropping the handle, or the adapter
failing to close one whose turn was interrupted, or a restart loop that races
itself. Sixteen in twenty seconds looks like a retry loop rather than one per
turn, but that is inference from a process table, not from a log — nobody has read
`packages/orchestrator`'s supervisor against this yet.

**Done when:** a session's provider processes are bounded and reaped — one live
app-server per agent, with the previous one killed before a replacement is
spawned — and something fails loudly when it is not. A count in the pulse would
be enough to make the next occurrence visible in a second instead of an hour.

### C-038 · The global terminal can be toggled into a state hydration throws away

`hydrate` applies its result with `set({ ...reconcileWorkspace(saved) })`, and
`shared/workspace-layout.ts:93` always produces a `globalTerminal` — closed, on a
profile with nothing saved. So a toggle that lands between the rail rendering and
hydration finishing is not merely early, it is **overwritten**, and the panel
never appears however long you wait.

Found while writing the terminal colour spec, which failed on it in roughly half
its runs before the cause was understood: the click reported success, the store
said open, and the next `set` reverted it with no error anywhere. The spec works
around it by clicking until it sticks.

**That workaround does outlive the fix, and has to be deleted by hand.** An
earlier draft of this entry claimed otherwise — that the loop would simply pass on
its first attempt and so cost nothing. It would, and it would also still be there,
a retry with no defect left to retry against, reading to the next person as though
the toggle were unreliable. Closing this means removing the loop in
`specs.mjs` and clicking once.

**Why it matters:** a person who clicks the terminal in the first moment after
launch gets nothing at all, and nothing tells them why. The window is short —
under a second on this machine — but launch is exactly when someone reaches for a
shell, and the second click always works, which is what makes it read as a
flaky button rather than a bug worth reporting.

**Not just the terminal.** `globalTerminal` is the instance that was caught; every
field `reconcileWorkspace` supplies has the same shape, so any pre-hydration
interaction with workspace state is discarded the same way.

**Done when:** either the store refuses interactions until `hydrated` is true —
it already carries the flag — or `hydrate` merges rather than replaces the fields
a user can have touched. A test that toggles before hydration and asserts the
state survives is what would hold it.

### C-039 · A reader who scrolled up is re-followed by a layout they did not cause

Reported as _"when i drag and split workspace or reorder the tabs it scroll to top
for the moved workspace"_. Half of that was a real restore bug and is fixed
(`c160be7`, corrected after). This is the half that is not, and it is a design
question rather than an oversight.

**Following stops on a gesture and resumes on position** — `9393281` made that
split deliberately, because inferring "the reader scrolled up" from `scrollTop`
moving backwards was wrong: anchoring and `makeRoom` both move it backwards, and
either one ended following permanently. Position was kept as the resume signal
on the grounds that _"arriving at the bottom is unambiguous however you got
there."_

**It is not unambiguous, because the bottom moves.** `makeRoom` sizes the spare
room against the view, so the scroll range changes without the reader touching
anything — measured here 209 → 141 across one remount, and `9393281` itself
records the spare room oscillating 686→663→686 during a turn. A reader parked
100px up is 100px up until the range shrinks under them; then they are inside the
32px resume band, and the next resize takes them to the bottom.

**Measured** (`e2e/split-scroll.mjs`, viewport 1000×360): wheel up, park at
`40 of 209`, switch tabs and back. The trace reads `141/141` from the _first_
frame — so the pane is re-following before the mount restore is even consulted,
which is why fixing this from the restore side does not work and should not be
attempted again.

**Why it matters:** it is the original report's remaining half, and it is the
failure mode `9393281` names as the worst one — _"a transcript that yanks you to
the bottom while you are reading something further up is worse than one that
never follows at all"_ — arriving by the other door.

**Done when:** a reader who has gestured away stays away until they return by
their own gesture or genuinely reach the end under their own steam — with the
range changing under them counting as neither. The obvious shape is to have the
resume test ignore range changes the app itself caused, but that is a decision
about which signals are trustworthy and belongs with whoever owns the follow
logic. `e2e/split-scroll.mjs` already fails on it and is the test that would hold
it.

## Parked, with reasons

Not open questions and not oversights: judgements already made, written as tickets
so they can be cited and argued with rather than rediscovered as gaps. The third
line of each is **what would reopen it** — a parked ticket with no such condition
is not parked, it is forgotten.

Full reasoning, including the probes, is in the plan's `STATUS.md` and `DONE.md`.

### C-046 · Chorus is not a VS Code fork

Asked directly on 2026-08-21, after a run of work that made the Changes panel
much more VS Code-like — file icons, its diff palette, its status letters, an
activity rail — and the fair question that followed: having gone this far, would
a VSCodium fork be less work than continuing?

**Decided: no. Keep this architecture and strengthen the bridge instead.**

**The reason is architectural ownership, not effort already spent.** How much has
been rebuilt is sunk cost and does not argue for anything. What argues is that
the two projects own different core abstractions. Chorus's is the
conversation/session/event model — an append-only log that is the source of
truth, projections written in the same transaction, a permission engine, a
supervisor. VS Code's is the workbench/editor/extension model. A fork puts
Chorus's _defining_ surface against the grain of its host: the shared transcript
becomes a sandboxed webview talking over message passing, the pane and tab layout
becomes negotiation with someone else's workbench, and main-process ownership of
the log and the policy engine moves into an extension host with different
lifecycle guarantees. It also takes on a permanent upstream-merge and
security-patch obligation that nothing here needs today.

**And the bridge already exists.** `apps/desktop/src/main/ide-bridge.ts` and the
`chorus-vscode` extension shipped as a `.vsix` in `extraResources` are what the
selection pills and "follows the editor for its own project" specs exercise. The
want behind the question — reach VS Code's power — is already partly answered
without becoming VS Code.

**Update 2026-11-07:** that bridge is gone. Plan 86 deleted `ide-bridge.ts`, the
`chorus-vscode` companion and its bundled `.vsix`, as Phase 8 of the workbench plan
asked. Chorus now reaches VS Code from the other side, as `apps/extension` running
inside it. The decision itself stands.

**Reopens if two or more of these become roadmap requirements**, rather than
individually:

- Native debugging, or orchestrating language servers
- Broad third-party extension compatibility
- Multi-root workspaces and IDE-grade navigation
- People spending more time editing here than coordinating agents
- The bridge itself becoming visibly restrictive or unreliable

Two, not one, on purpose: any single item has a cheaper answer than a fork, and
the trap this entry exists to prevent is re-litigating the question every time
Chorus adopts another familiar editor feature.

**One fact deliberately left unverified:** whether a fork may use Microsoft's
extension marketplace. That research was started and killed mid-session, and it
is the fact that most changes the "extensions come free" argument — so it needs
checking before any serious move. It does not change this decision on its own:
perfect marketplace access would remove none of the lifecycle, layout,
state-ownership or maintenance costs above.

### C-002 · Whether to notarize

Ad-hoc signed, not notarized, and that is a decision rather than an oversight.
`electron-builder.yml` sets `identity: null` and then ad-hoc signs in
`afterPack`, with a comment explaining why the two are not the same thing: an
ad-hoc build is called _untrusted_, which is a warning you can click past, while
an unsigned one is called _damaged_, which you cannot. `docs/install-macos.md`
walks through the dialogs, and every release's notes repeat the two ways round
them.

Notarizing means the Apple Developer Program, a Developer ID certificate, and
uploading each build to be scanned and stapled — an annual fee and an Apple
account, neither of which is a commit. Parked rather than deleted for the reason
this section exists: without a paragraph saying ad-hoc signing was chosen, the
next person to build a DMG meets Gatekeeper and re-opens the question from
nothing.

**Reopens if:** the DMG goes to anyone but the person who built it. A one-time
right-click → Open is friction on your own machine; it is a scary dialog and a
documentation link to a stranger.

### C-007 · The todo panel

The detail line shipped: a `TodoWrite` row reads `Fixing the parser · 1/3` instead
of the bare tool name, using the field names and the one-in-progress invariant read
out of the CLI binary's own tool description.

The panel did not. It cannot be built honestly on this machine, whose config
replaces `TodoWrite` with `TaskCreate`/`TaskUpdate` — asked to write todos, the
agent said so itself. Building a surface nobody here can see means shipping a
schema commitment on faith and calling it verified.

**Reopens if:** a machine has `TodoWrite`, so the panel can be driven and looked at
— or the `Task*` shape is worth handling as a second reduction on its own merits.

### C-008 · Dialogs

Carried unbuilt through three phases before being decided rather than carried a
fourth time. `refusal_fallback_prompt` is the only kind the CLI declares.

The reason not to build it inverts the intuition that wiring the callback is the
safe half: the CLI treats an **undeclared** kind as "cannot display" and fails
_closed_, so today's behaviour is a defined degradation — the classic refusal
error. Declaring the kind is a promise Chorus can render it, and breaking that
promise parks the turn instead. Against which `payload` is `Record<string,
unknown>` defined per kind, and the trigger is a model refusal that cannot be
produced on demand to test against.

**Reopens if:** a second dialog kind appears, or the payload shape is documented —
either makes the renderer testable, which is the whole objection.

### C-009 · Checkpoints

`rewindFiles(userMessageId)` wants the CLI's own uuid for a user message. Probing
every message the SDK yields for one prompt gives `system/init`, `assistant`,
`rate_limit_event`, `result` — and nothing else. **The CLI never echoes the user's
message back**, so there is no uuid to capture. Setting
`enableFileCheckpointing: true` changes nothing, which disposes of the hope that
the option makes it start announcing them.

The uuid exists in exactly one place: `~/.claude/projects/<slug>/<sessionId>.jsonl`.
That route is available and wrong — an undocumented private format belonging to a
self-updating binary, read to drive an operation that **reverts files on disk**,
where a format change rewinds to the wrong point rather than failing.

**Reopens if:** the SDK exposes the id — an echoed user message, or a `rewindFiles`
that accepts something a host can legitimately know.

### C-010 · The context breakdown

`getContextUsage()` carries a full inventory — system prompt, tools, memory files,
skills, messages — and the temptation is a panel showing where the window went.

Measured, the obvious version lies. `totalTokens` **excludes** the deferred
categories: 253 + 12,725 + 4,289 + 2,110 + 4,787 = 24,164, exactly `totalTokens`,
while two deferred rows carry another 59,538 that costs nothing until something
loads them. A panel presenting "MCP tools: 45,930" as consumed would be wrong by
more than twice the total.

**Corrected 2026-09-17.** The second half of that does not hold. Read out of the
shipped CLI at `~/.local/share/claude/versions/2.1.273`: `maxTokens` and
`rawMaxTokens` are set to the same value, and the CLI's own `percentage` is
`Math.round(totalTokens / maxTokens * 100)` — so the denominator is what the CLI
itself measures with, and a bar drawn against it does fill. The 967,000 against
1,000,000 above is the threshold measured against the raw window, which is a
different line from the one drawn.

`autoCompactThreshold` is also no longer unused: the adapter carries it through
and the project card marks it — `docs/plans/the-ceiling-you-can-see-2026-09-17/plan.md`.

**Reopens if:** someone designs it with the deferred distinction drawn honestly.
The blocker is design, not plumbing.

### C-011 · Terminal sessions in the history sheet

Chorus's log is authoritative, decided in open question 2. A CLI session is a
different unit: a Chorus conversation is a _room_ spanning several sessions, and
`listSessions()` is Claude-only, so codex does not appear at all.

Measured on this repository, `listSessions()` returns 21 sessions of which eight
are throwaway — three `Say OK`, two `hi` — five created by this project's own
probes in one afternoon. Merged rows would put `Say OK` in the history sheet
looking reopenable.

**Reopens if:** importing terminal work is wanted, as its own labelled surface
rather than merged rows. `sessionRef` is already recorded, so a room can name its
CLI session whenever the correlation is useful.
