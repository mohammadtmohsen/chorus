# Status — Chorus becomes the development environment

## 2026-11-07 · Phase 8, in part — the companion removed

Plan 86 (`docs/plans/86-remove-the-old-vscode-companion.md`) deleted the external VS Code
descriptor, socket and installer code, the `chorus-vscode` companion, its bundled `.vsix`, the
Settings health box, and the unreachable "Open in VS Code". It kept the `code -g` fallback in
`ide:openFile` on purpose: it is what a transcript file link does when a project's Editor switch is
off. Phase 8's exit criterion "no requirement for the `code` CLI" is therefore unmet by choice.

## 2026-08-29 · Phase 6 built, and eleven rounds of finding out why it did not work

**Phase 6d and 6e are built for Claude, and the editor context they depend on took
eleven attempts.** The feature was written in three commits. The remaining
twenty-five were spent discovering why a selection never reached an agent, and the
record of _that_ is worth more than the feature.

### What was built

- **6d — an agent edits the live model, not the file.** `editor_edit` applies
  through `pushEditOperations` with `pushStackElement` either side, so the change
  is exactly one undo step and `⌘Z` reverses it precisely. The file goes dirty
  rather than saved. A `baseVersion` mismatch refuses as a conflict and returns the
  current version; `oldText` is compared against the range before anything moves,
  which catches the right-version-wrong-range edit a version alone cannot.
- **6e — offered as an in-process MCP tool.** `createSdkMcpServer`, so no server,
  no port, no credential. `strictMcpConfig` is never set: it would make the SDK
  ignore the user's own `.mcp.json`, settings and plugins in order to add one tool
  of ours. `mcpToolCall` is already never auto-decidable, so every edit is asked.
- **The approval shows the change.** `editorEdit` is its own kind carrying path,
  version, range and a unified diff rendered by the transcript's own `ToolPatch`.
  Widening `ApprovalKind` broke four exhaustive switches, which is the design
  working; the one that mattered was `subjectOf`, where returning no paths would
  have exempted this kind from every path-scoped deny in the profile.

### Six defects between the editor and the agent

The observation half of Phase 6 had shipped and never worked. In order of
discovery, with the ones found by **Codex** marked:

1. `getFocusedCodeEditor()` — the workbench is its own `WebContentsView`, so the
   editor is never focused at the moment a message is sent.
2. The reporter subscribed only to _changes_, so a restored editor reported nothing
   until the cursor moved.
3. **(Codex)** Two forwarders wrote to one channel. The external VS Code bridge
   pushes `unavailable` for every conversation on every runtime event, and `Session`
   folded both sources into one state — so a workbench `ready` was overwritten
   within milliseconds. **This was the cause the first five fixes sat downstream of.**
4. **(Codex)** The context was component state in a tab that unmounts. Only the
   active tab of each group is mounted, so switching away lost it and no replay put
   it back — `CLAUDE.md`'s own rule about `SessionCarry`, unapplied.
5. The snapshot returned the reference and no text for a clean worktree file — a
   rule written for the external bridge, where the agent can open the file itself,
   and wrong for the editor in the person's own window.
6. Diff editors were skipped, so a file opened from Source Control reported nothing.

**The pattern is the lesson.** Three fixes were shipped before any cause was
established, each aimed one link further downstream than the break. The probe
written to settle it spent three runs driving a **stale bundle**, because it never
called `ensureBuilt` — the port-9800 trap wearing different clothes. What ended the
guessing was logging: one line at the snapshot, one at the push.

### Phase 4 was not finished either, and the plan says otherwise

Chasing why an attached selection rendered as PLAINTEXT found that **the editor had
no language support at all**. Every file opened as Plain Text.

`services.ts` says the REH "ships the built-ins — Git, the language basics, the JS
debugger". Git and the debugger are there. **The language basics are not** — the
server carries `typescript-language-features`, the language _server_, while the
extension that declares `.tsx` as `typescriptreact` and carries its grammar is
client-side. That sentence is why nobody looked, and it is corrected in place.

Forty-five language packs and the Seti icon theme added, measured at each step:

| Bundle                       |    none |    nine |         all |
| ---------------------------- | ------: | ------: | ----------: |
| workbench frame (R2 ≤ 40 MB) | 31.4 MB | 32.9 MB | **35.1 MB** |
| shell chunk (R1, +0.5 MB)    |       — |       — |   unchanged |

R2 passes and is not re-registered. **Headroom is now 12% where it was 21%**, which
the next person adding to that bundle needs to know. Registering the icon theme was
not enough either — nothing selected it until `workbench.iconTheme` was seeded.

### Three security findings, one of them pre-existing

- **Connection-URL passwords were redacted by nothing.** `postgres://user:pw@host`,
  `mongodb+srv://`, `redis://`, an HTTPS remote with a token — all went into the
  append-only log intact. That module is the only thing between hook output,
  notices and diffs and a credential written down forever. Found by testing it
  against a real `.env.local`; it is not about editor context and predates it.
- **An installed theme could not load its own resources.** VS Code's server sends
  CORS headers only when the origin matches `product.webEndpointUrlTemplate`, and
  VSCodium's product defines none. The workbench session now adds one for exactly
  the origin Chorus spawned and the one resource path — and **(Codex)** that path
  carries a `${quality}-${commit}` prefix the first implementation missed, so the
  fix was correct and unreachable for a commit.
- **The Extensions view could install but not show.** Two public hosts added to the
  CSP, the second because every asset 302s to Eclipse's CDN — visible only by
  following the request.

### Guards left behind, because each class had none

`e2e/workbench-memory.mjs` pays R6/R7/R8/R11 — **R7 passes**, settling the
shared-REH topology §2.4 chose without it, and R11's inventory half fails
(`C-065`). A translation-key test that found a second key already shipping as its
own name. Ten exactness tests on the CORS predicate. Three on editor-context
precedence, proved failing without the fix. And `C-048` closed by reading:
`updateSessions` passes its argument to `setSessions` as an **updater**, which React
runs during render — so "it is inside a promise" did not mean "it is not inside
render".

### What none of this proves

No installer has been installed. Codex's three formal proofs are unmet: the probe
cannot select through a returned pane, cannot start a conversation without an
authenticated CLI, and the Composer composition is untested. Everything above was
confirmed by the person driving it, which is evidence and is not a gate.

---

## 2026-08-29 · Phase 7 opened, and the gate was red the whole time

**The first thing found was that `pnpm check` did not pass.** Ten lint errors and
nine test failures, on `main`, before anything of this session was written. The
release workflow's first job runs lint and test, so **no release could have been
cut at all** — Phase 7's goal was blocked at step zero and nothing said so. This
file's previous entry reported "18/18 including tests"; that is `turbo typecheck`
counting tasks, and it was read as the suite passing. Fixed in `3b484b9`.

Three of those failures were tests asserting the **opposite** of Phase 9's
architecture — `conversation:start` was required to carry a `cwd` and route
through the adopting entry point, with a comment calling the projectId route "the
bug this routing exists to prevent". And `workbench-surface.test.ts` was
reporting `(0 test)`: its electron mock had no `ipcMain.on`, so registration threw
at import and took the file with it. That file is 34 passing tests now; it had
been covering nothing while looking like a file that existed.

**Two product defects were found by driving the app, not by testing it.**

- **A missing project folder wedged the whole app.** The launch auto-start called
  `startConversation` on `projects[0]` unconditionally, which throws
  `ProjectRootMissingError` when the folder has gone, which set the boot error and
  replaced the app with `Stuck`. Restore already handled it correctly, so the two
  disagreed. `Stuck` also had no way out, and its own comment claimed otherwise.
  `ProjectRootMissingError` has always said "the product's answer to it is
  Relocate rather than an error dialog" and `ProjectService.relocate` has always
  existed — **nothing exposed it**. Now wired end to end.
- **Switching project tabs destroyed the editor.** One `WorkbenchFrame` keyed on
  `pane.activeTabId`, so changing tabs changed the key and React tore the surface
  down — a whole `WebContents` and a full workbench boot every switch.
  `WorkbenchFrame` documents this exact hazard and the Editor switch avoids it
  with `hidden`; tab switching had no such protection. One frame per project now,
  all mounted, only the active one visible.

**And one defect was introduced and then found the same way.** Moving a sizing
rule onto a new wrapper as `flex: 1 1 auto`, in a container that is not a flex
box, made the shorthand inert and the placeholder measure zero height. Main
positioned the workbench at zero height and did exactly as asked; the region was
black with a healthy server behind it. There is now a guard that reports a
visible surface with no area, requiring the region to measure nothing
_continuously_ — the instantaneous version broke two tests that had no quarrel
with geometry.

### Phase 7 · R3 measured, bundling wired, and three premises corrected

**R3 is evaluated and it cannot decide what the plan says it decides.** Installed
against installed, arm64: baseline `bf9c054` **316.5 MB**, runtime download
**339.9 MB** (1.07×), bundled **419.9 MB** (1.32×), ceiling **949.6 MB**. Both
clear it with 2.3× headroom, so the choice was made on product grounds —
bundled, so a first launch needs no network. The bundled figure is measured;
arithmetic said 412.6 MB and was 7.3 MB out.

**What the runners proved, and it is the point of having run them.** Every one of
these passed a local `pnpm check` and would have shipped broken:

| Believed                                       | Actually                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm package --arm64` builds one architecture | A per-target `arch` list in the config beats the CLI flag; it built both          |
| `beforePack` gets `electronPlatformName`       | It does not — `afterPack` does. Read as `undefined`, the build failed             |
| Linux has native prebuilds                     | `node-pty` publishes none for Linux at all; it compiles, so Linux builds on Linux |
| `macos-13` is an Intel runner                  | Retired. The job queued 24 minutes, was never assigned one, and never failed      |

**Where it stands.** macOS arm64, macOS x64 and Windows build, verify at `bundle`
scope and upload — two dispatched runs, artifacts confirmed through the API. The
DMG is ~204 MB where it was 132.7 MB, which is the bundling cost a downloader
pays. **Linux has never built** and is `C-064`; work stopped there deliberately
rather than iterating a red job one line at a time.

### R6, R7, R8 and R11 measured — the plan's oldest debt, paid

`e2e/workbench-memory.mjs`, macOS arm64, 60 s idle per term, RSS summed across
every Chorus process. `M0` 556.0 MB / 6 processes, `M1` 1048.3 MB / 10, `M2`
1380.3 MB / 13.

**R7 passes and it is the one that mattered.** The second project costs 332.0 MB
where the first cost 492.3 MB — run three times, same direction every time, 26–37%
margin. §2.4 chose one shared REH over a server per project on architecture and
licence and said in as many words that "R7 still decides". It has now decided, in
favour of the shape that was already built. R6 passes at 1048.3 MB against a
1200 MB ceiling, though an earlier run of the same gate reached 1189.9 MB and that
margin is thin. R8 passes at 0.51% idle CPU against 3%.

**R11 fails on its inventory half, and that is a real defect.** Memory returns to
within 5.4% of `M1`; two REH extension hosts survive ten open/close cycles. It is
the second of the two candidates R11's own rationale names, and it is the reason
R11 was redefined from a renderer heap to a process inventory — a heap would have
shown this flat, and the memory half of the check did exactly that. Filed as
`C-065`, undiagnosed: ten cycles left two, which reads more like a race or an
impatient settle window than a missing teardown, and nobody has looked.

**Two things the gate is not.** It measures **two** projects because R7 defines
its terms that way; the product allows **four**, and four has never been measured.
And it is one machine on one platform.

**What none of this proves.** No installer has been installed. The product gates
— cold start, one versus four workbenches, sidecar crash, extensions, terminal,
debug, Git — are untouched, R7/R11 are still owed as numbers, and Phase 5's user
review gate is still unmet and still gates Phase 6.

## 2026-08-29 · Phase 9, and the plan corrected to match the code

**Nothing in this entry has been run.** Everything below typechecks — 18/18 including tests — and
`npm test` has not been executed once across roughly fifty slices. Read every claim here as "the
compiler agrees", not as "it works".

**Phases 5 and 6 were marked ⬜ Not started in the plan's table and were not.** 5a–5g and 6a, 6b, 6c
and 6f were built on 08-28. The table is corrected; it had been wrong for a day.

**Phase 9 is new and was not planned.** Driven as a product for the first time, the project-first
architecture had three problems no phase had named — settings asked one level too low, three doors
to one action, and Chorus re-implementing surfaces the workbench already owns. Mohamad called the
shape of the correction. The phase records what was built, what was deleted and what replaced it.

**Two things in the plan were corrected rather than left standing:**

- **Phase 3's changes list described a shell that never shipped.** The rail was re-keyed to projects
  without the conversation rows being removed, so for four days it showed both. The dock shipped as
  a strip of chips, not the tree it now is. And "preserve drag, reorder, split" was reported done
  while the drag still carried conversation ids through a project-keyed layout.
- **Phase 6's 6d and 6e leaned on surfaces that no longer exist.** They were written when Chorus had
  its own Changes and Review panels. Rewritten against the workbench's SCM view, with the split
  stated: the approval's diff stays in Chorus because it is a _decision_ surface answerable with the
  editor switched off; reviewing what happened moves to the editor.

**Two risks added to §8, both learned the hard way here.** A wrong _name_ survives a re-key where a
wrong type does not — five call sites went on compiling against `activeTabId` after it stopped
naming a conversation, and every one failed silently except the one that reached a validator. And
deleting a feature is not finished when the button is gone: nine deletions left store slices, schema
fields, channels, watchers, plural i18n keys and a thousand lines of CSS behind them.

**What is genuinely lost, and was accepted.** The merge-base diff. `@chorus/workspace` can diff
against a branch's merge base; the editor's SCM only compares against `HEAD`. The function survives
in the package with no caller.

**The gate that matters is unmet.** Phase 5's user review gate was never met and it explicitly gates
Phase 6; Phase 9 has no review at all. Three of Phase 9's own bugs — the drop shading, the escaping
send button, the doubled tab seam — were visible only on screen, which is the argument for driving
it rather than typechecking it again.

---

**As of 2026-08-24. Phase 0 ✅ approved by Codex. Phase 1 preflight ✅ accepted by Codex after five
review rounds. Phase 1's first authorised slice — the serverless containment probe — is built, run,
driven by hand, and hardened against a sixth and a seventh review. Phase 1's second authorised
slice — the matched-pair REH stage — is built and run: the artifact is downloaded, verified,
unpacked transactionally and spawned, the workbench reads a real filesystem through it, and the
coexistence gate has been re-run on the matched pair. **Mohamad has driven it by hand** — two real
repositories in two surfaces, one shared REH, one surface closed and the other still working — and
the plan's user UI review gate is met besides, on 2026-08-24.**

**Correction applied here rather than left for a reader to arbitrate.** This block used to end _"It
has NOT yet been reviewed by Mohamad"_, and the slice-3 correction seventy lines below it said the
opposite. The correction was the right one — he confirmed it — so the header is the sentence that
changes. The two stood contradicting each other for a day, which is exactly the failure a status file
is for preventing rather than demonstrating.

**Architecture decision, 2026-08-23 — Mohamad: Chorus continues with `monaco-vscode-api` + the
VSCodium REH. The fork pivot is cancelled.** Phase 1's architecture question is settled, and the
defect that had been holding it open is reclassified rather than resolved.

**C-054 is now a critical tracked release defect, not an architecture gate.** It does not block
building the rest of the product; it is revisited during stabilization before Chorus is
release-ready. **It may not be presented as fixed.** It is live and unexplained, at roughly **two
sightings in eleven single-surface sessions**, and it presents as a file opening to a blank editor.

**The evidence that reclassified it**, from session 1 of the final instrumented batch — one surface
mounted, root verified, every boundary recorded for `a-first.md`:

```
enter → first boundary        27 ms
resolveFromFile-entry     +0 ms   (t+0)
readStream-before         +0 ms   (t+0)
readStream-return        +65 ms   (t+65)
resolveFromContent-entry  +0 ms   (t+65)
doCreateTextModel         +0 ms   (t+65)
────────────────────────────────────────
harness waiting for rendered content:  timed out at 60,000 ms
```

**Every boundary completed inside 92 ms of the keystroke and the editor stayed blank for sixty
seconds.** The read was not slow (65 ms against a healthy 5–54 ms over 25 instrumented opens), model
resolution was not slow (0 ms after the read, exactly as in health), and **the text model was
created**. So the delay is downstream of `doCreateTextModel()` — neither the read nor model
resolution, which is where two rounds of investigation had been aimed.

**A relabel that must be visible rather than quietly applied.** The seven failures recorded in the
ten-run batch as **"model-stage timeouts"** are **timeouts with no rendered content**. They were
counted as model failures because `lineNumbers` was introduced as a "model-derived" signal; it is
produced by the **rendered editor**, so it cannot distinguish _no model_ from _a model the view never
painted_, and the trace shows at least one instance was the second. The count is unchanged; what it
means is weaker and different.

**The temporary C-054 diagnostics are removed**, verified in both directions: an ordinary build
contains **0** injected references and an **armed** build now also contains **0**, so the arming path
itself no longer works rather than merely being unused.

**Correction (2026-08-23, the deterministic-gate slice), and it is the sentence a reader most needs
first. The coexistence gate now passes — 24 of 24 claims on two independent runs — and it is a
different gate from the one described below.** The sentence above describes slice 2's gate, which opened files by clicking measured
rectangles in the explorer — the thing Codex refused, and the thing this slice replaced with quick
open. So "re-run on the matched pair" is true of a gate that no longer exists.

**So the matched-REH stage now rests on two things rather than one.** Mohamad drove the app by hand —
two real repositories in two surfaces, one shared REH, real files, one surface closed and the other
still working — and that remains the observation the product shape rests on. Beside it there is now a
repeatable measurement that says the same thing without a person in the loop, driven through commands
and observable state, with the run identity and process identity written down so the two passes can be
shown to be two. Slice 3 below is that gate, including the three of its own defects it had to be
corrected for and the one product blocker it found — **E4, the remote extension host outliving the
app**. E4 took three reopenings and is now closed, with a second gate driving every way of stopping
Chorus; the detail, including the six checks-that-could-not-fail found along the way, is in its own
section below. **E1 and E3 are now closed too** — the bounds observer that could not see position-only
movement measures the rectangle every frame instead of subscribing to the causes of its changing,
and the owner-lifecycle teardown that was only ever proved against a fake `WebContents` has been
driven in the running app by a third gate. The only exit item still open is the newly separated
**E5**, and it is now open at one check rather than at its whole claim — settings **do** survive a
quit, proved by hand and by a passing gate; what is unchecked is whether the connection token is
absent from disk after one. The remaining Phase 1 blocker is **C-054**, now measured: ten containment runs,
**three reproduced**, seven **timeouts with no rendered content** among 39 traced opens — not
"model-stage timeouts", which is a claim the instrument could not support and is withdrawn where it
appears. It is
described as _model resolution intermittently not completing within the observation window_, because
that is the whole of what a finite budget supports — an earlier framing calling it _latency rather
than a permanent stall_ rested on one 53-second success and is withdrawn. The picker-stage failure
that was counted alongside it is split out as **C-056**.

**Correction, and it is the same one this file keeps having to make.** The sentence above used to
end "The REH stage is not authorised: no REH artifact has been downloaded." That was true when it
was written and stopped being true the moment the stage was authorised, which is exactly the failure
the seventh round corrected once already. **What has been downloaded now**: one VSCodium REH tarball
(`vscodium-reh-darwin-arm64-1.121.03429.tar.gz`, 76,210,372 B, sha256
`e0b41d23…398c1b`, matching its published `.sha256` sibling), the five per-platform `.sha256`
siblings that the manifest is generated from, and 32 `@codingame/*` packages re-resolved at
`33.0.9`. **What still has not**: any third-party VSIX, any Microsoft-published artifact, anything
for Windows or Linux, and nothing has been committed.

**Correction (seventh round, 2026-08-22). This file said "nothing has been downloaded", and that is
not true — npm packages were.** `pnpm add` pulled the client under the authorisation Mohamad gave
for the first slice: **31 `@codingame/*` dependencies pinned at `36.1.1`** in
`apps/desktop/package.json`, 37 `@codingame/*` packages resolved into the store once transitive ones
are counted, plus their own dependencies. What has **not** been downloaded is the **REH artifact** —
no VSCodium server tarball, no VSIX, nothing fetched outside the package manager. The distinction is
not pedantry: the next authorisation Mohamad is being asked for is precisely _permission to download
an artifact_, and a status that says "nothing has been downloaded" invites him to grant it while
believing the branch has never fetched anything at all.

**Correction (Codex hardening review, 2026-08-22). This file said "no implementation has begun" and
"nothing has been run on this branch", and both were false by the time anyone read them.** They were
true when they were written and were left standing straight through the slice that made them untrue
— which is the precise failure this file exists to prevent, because a status a reader has to correct
from memory is worse than no status at all. What is true instead, stated as what was _observed_:

- **Packages were downloaded.** The client, at the pinned version, into `node_modules` and
  `pnpm-lock.yaml` — see the correction above for what that is and what it is not.
- **Code was written.** The serverless containment slice: `main/workbench-surface.ts`,
  `preload/workbench.ts`, `shared/workbench-ipc.ts`, the workbench renderer entry
  (`renderer/workbench.html`, `renderer/src/workbench/*`), a second preload and a second HTML entry
  in `electron.vite.config.ts`, the workbench half of `main/security.ts`, and the shell-side probe
  reached with `⌃⌥W`.
- **Tests were run and the gate is green.** `pnpm check` — typecheck, lint, format, the whole vitest
  suite — passes.
- **The app was launched, and the falsification experiment ran.** `node e2e/workbench-containment.mjs`
  against a real build: **11/11 claims held**, including the crux — destroying one surface leaves
  its sibling rendering, typing and running commands.
- **A person drove it.** Mohamad reviewed the UI by hand: **two real repositories opened in two
  surfaces, one closed, and the other still editable with quick-open working.** That is the review
  gate the plan asks for, and it is separate evidence from the gate rather than a restatement of it.

**What still has not happened, and the list matters as much:** no VSCodium REH artifact has been
downloaded, unpacked or run; no third-party VSIX has been installed; nothing on this branch has been
committed; no packaging has been attempted; and the §9 authorisations for all of that remain
unasked. Everything fetched so far came from the package manager, under the slice's own
authorisation.

**The three documents this file used to say did not exist:**

| File                                             | What it is                                                                                                                                      | State                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| [`plan.md`](./plan.md)                           | The approved plan — problem, architecture decision, eight phases                                                                                | Phase 0 ✅ approved           |
| [`phase-1-preflight.md`](./phase-1-preflight.md) | Read-only preflight brief for Phase 1: versions, artifacts, licensing, security model, proof set, pre-registered thresholds, authorisation list | ✅ accepted after five rounds |
| `STATUS.md`                                      | This file                                                                                                                                       | —                             |

---

## Phase 1 · Slice 1, the serverless containment probe — built, run, driven, hardened

**The slice exists because the plan's product shape has never been demonstrated.** Project tabs mean
several `monaco-vscode-api` workbenches alive at once; the library's own demo runs **one** and
reinitialises it. So the first thing built was not a tab strip but the falsification instrument, and
it was built with **no remote extension host at all** — preflight §2.5 step 1 — because the cheapest
possible "no" is the one that arrives before a 76 MB download.

**What it is.** A workbench surface is an Electron `WebContentsView` that **main** owns: the shell
holds only an opaque view id, the surface runs on its own `chorus-workbench` session with its own
CSP and permission handlers, and its own one-method preload (`connection()`) rather than the shell's
seventy-method `ChorusApi`. The shell reports a placeholder rectangle; main mirrors it onto the view.

**What the gate observed — `node e2e/workbench-containment.mjs`, 12/12 claims held.** In order:

1. the shell holds `ChorusApi` and no workbench bridge;
2. **a raw path on `workbench:open` is refused**, and the directory named is a real, absolute,
   canonical one that the very next step opens on a grant — so the only difference between the
   refused call and the accepted one is authorisation (added in the seventh round; the unit tests
   prove this against fakes, this proves it over the running boundary);
3. two surfaces each render a workbench in their own document;
4. no surface holds `ChorusApi`, and its bridge is exactly one method;
5. no surface sets `window.vscodeWindow` — parent-DOM integration is prohibited, which is what makes
   the library's global `[data-vscode]` teardown unable to reach a sibling;
6. each surface pulls **its own** project root while the other is open (the adversarial direction);
7. each surface opened its own workspace document, not the other one;
8. a reloaded surface is answered again, with the same project (§4.1b rule 3);
9. destroying a surface actually removes its `WebContents`;
10. the survivor's `[data-vscode]` head elements were not removed with its sibling;
11. **the surviving editor still accepts a keystroke** after its sibling is destroyed;
12. the surviving workbench still runs a command — `⌘P` opens quick input.

Claims 10–12 are the crux, and 11 is the one that matters: still in the DOM is not still working.

**How the gate opens a surface now, since it cannot click a native dialog.** `workbench:open` takes
a capability main mints from the folder chooser, and a native dialog is drawn by the OS — CDP has no
way to press a button on it. So the gate seeds the chooser's **answers** through the process
environment (`CHORUS_WORKBENCH_E2E_ROOTS`, ignored when the app is packaged), which is the one input
no renderer can write. Main still canonicalises those roots, still binds each grant to the window
that asked, and still refuses a path — claim 2 is asserted from the shell over the real channel.
What the seed replaces is the hand on the mouse, not the authorisation.

**What a person observed, which is separate evidence and not a restatement.** Mohamad drove the app
by hand at the review gate: **two real repositories opened in two surfaces, one closed, and the
other still editable, with quick-open working.** The gate proves the mechanism; this proves the
product shape is usable by the person it is for.

**`pnpm check` is green** — typecheck, lint, format check and the full vitest suite.

### The limitation Mohamad identified, and it bounds every sentence above

**The file tree is in memory and seeded from the project-root string.** Each surface registers a
`RegisteredFileSystemProvider` overlay holding two synthesised files under its own root; nothing in
this slice reads a byte from disk. So the explorer is evidence about **isolation between surfaces**
— two roots, two trees, two documents — and is **not** evidence that anything was read from the
filesystem. Real files need the remote extension host, which is step 2 and is not authorised.

Read every claim above with that clause attached. "Two real repositories" means two real _paths_,
canonicalised and approved by main; what the workbench then showed inside them was ours.

### The sixth review round — six corrections, all applied

Codex accepted the containment result and required six corrections before the REH stage is
authorised. All six are in, four of them with a regression test that was **proved to fail with the
defect reinstated**.

1. **The navigation lock admitted a prefix, not a boundary.** `will-navigate` was allowed if the URL
   started with `file://` or with the dev server's URL. Under `file://` that is _every document on
   the disk_, including the shell's own `index.html` — the one navigation a surface running
   third-party extension code must never make. And a prefix over an origin is not a same-origin
   test: `http://localhost:5173` is a prefix of `http://localhost:51739.evil.example/`. Replaced
   with an **exact allowlist** of entry URLs compared on protocol, host and path, built by the
   caller from the very value it loads. A query string is refused outright; a fragment is ignored,
   because `will-navigate` never fires for an in-page hash change.
2. **Every surface is now bound to its owning shell `WebContents`.** A view id is opaque but it is
   not a secret — it crosses IPC, sits in React state, and would sit in the first log line anyone
   adds while debugging the layout. Authorising `setBounds` and `close` on the id alone let any
   window drive another window's workbench by naming it. The owner is taken from `event.sender`,
   never from a request argument, and an unknown id and a foreign id get the **same** refusal so
   that nothing here answers "does this id exist?".
3. **A shell that reloads no longer orphans its surfaces.** Destruction ran on the renderer's own
   unmount, which is exactly the path a reload does not take: `location.reload()`, a dev-server full
   reload or a crash-recovery load replaces the document without running one React cleanup, leaving
   parented, painting `WebContentsView`s nothing but a quit could reach. Main now watches each owner
   for a cross-document main-frame `did-start-navigation` and for `destroyed`. Same-document
   navigation is explicitly _not_ a trigger — tearing four workbenches down because a route changed
   would be the worse bug.
4. **An arbitrary renderer string can no longer become a project root.** Main canonicalises with
   `realpathSync` and approves: absolute, existing, a directory — and the **canonical** path is what
   the surface is told and what a future REH would be pointed at. Two spellings of one tree (a
   symlink) would otherwise be two projects to every refcount, cache key and storage path in §5.4.
5. **This file, which claimed nothing had been built or run.** Above.
6. **Bounds tracking stays open as a Phase 1 exit item rather than being quietly fixed.** Below.

### The seventh review round — one blocker, and it was half of item 4

**Codex accepted the containment gate and blocked the REH stage on a single security requirement:
item 4 above canonicalised a path and called it approved.** That is the whole finding, and it is
worth stating in the reviewer's words: **`realpathSync` canonicalises a path; it does not authorise
it.** What the sixth round shipped answered "is this string well-formed and does it name a
directory?", which is true of nearly every directory on the machine — so `workbench:open` still
admitted **any existing directory the renderer named**, and in step 2 that string becomes the REH's
`--folder`. Three corrections are in; the first two carry regression tests **proved to fail with the
defect reinstated**, one experiment each.

1. **`workbench:open` no longer has a shape for a path.** Its request is now a union of two
   references main can resolve without trusting the sender: a **grant**, and a **project id**. A
   grant is minted in main and only as the result of a person picking a folder in the **native
   chooser** (`workbench:chooseProject`, a new channel); it is a `randomUUID` bound to the
   `WebContents` that asked for it, and it dies with that document — `releaseOwner` drops grants
   alongside surfaces, so a reload starts from nothing. **Two refusals, two tests, each proved
   against the defect reinstated**: a forged path — `ROOT_A`, a directory that is real, absolute,
   canonical and about to be opened legitimately — is refused because it is not a capability at all
   (with the old canonicalise-and-admit fallback put back, the test fails); and a grant minted for
   one window is refused in another (with the owner comparison removed, the test fails). Redemption
   does **not** consume the grant: `StrictMode` mounts twice and the probe reopens a pane it closed,
   and a single-use token would send the person back through a dialog for an authorisation they had
   already given. The `projectId` arm is admitted by the schema and **refused by main today**,
   because ProjectService owns the id → root table and does not exist yet — fail-closed, and in the
   schema now because closing this channel against paths is a security boundary where filling in a
   lookup later is not.
2. **A cleanup-time `closeWorkbench` can no longer become an unhandled rejection.** `closeSurface`
   throws for an id it does not hold — it used to be a silent no-op — and `WorkbenchFrame` called it
   from its effect cleanup with a bare `void`. The refusal is deliberately unreadable, since "no such
   id" and "not yours" are the same message on purpose, and the case the shell actually reaches is
   the first: main tears a shell's surfaces down itself on reload and on window destruction, which
   races the unmount that would close them from the renderer. Both call sites now swallow it, and
   neither reports it — `onFailed` is about a surface that would not open, and this one is closed.
3. **This file, on what has been downloaded.** At the top.

### The eighth round — one record correction, and it is about a uniformity that is not there

**Item 2 above says "both call sites now swallow it, and neither reports it", and that sentence is
true of `closeWorkbench` and of nothing else — but read forward it now sounds like the rule for
every refusal `WorkbenchFrame` can receive, bounds included. Bounds is deliberately the opposite,
and the record should not imply otherwise.** `setWorkbenchBounds` goes through the same
`ownedSurface` check and loses the same race with main's own teardown, so it fails with the same
unreadable message — which is exactly why the **lifecycle** decides there and never the error. A
report still in flight after the effect's cleanup has run is expected and says nothing; the
identical string arriving while the frame is still mounted is a defect and goes to `onFailed` like
any other, because a surface that is gone while this component believes it is there will never be
moved again and the symptom is an overlay that quietly stops tracking. A close that fails has
already got what it wanted; a bounds call that fails has not. So there are three call sites and two
policies, not three call sites and one.

## Phase 1 · Slice 2, the matched-pair REH stage — built and run, not yet reviewed

**Preflight §2.5 step 2 and step 3, taken together.** Step 1 answered the containment question with
no server attached; this answers what a server was needed for — real files — and then re-runs the
coexistence proof on the configuration Phase 1 is actually proposing, because neither the version
nor the topology carries over on its own.

**The pin moved down, and nothing broke.** `@codingame/monaco-vscode-api` and its 30 service
overrides went from `36.1.1` to **`33.0.9`**, plus
`@codingame/monaco-vscode-remote-agent-service-override@33.0.9` added — 32 packages at one version.
This was the risk flagged before the stage began: a downgrade of three minor releases could have
undone the last slice. **It did not.** The build succeeds, every service override in
`services.ts` resolves unchanged, and the containment claims that passed on `36.1.1` still pass.
The client's compiled product module reads `quality: 'stable'`, `version: '1.121.0'`,
`commit: '987c9597516278c9fcf10d963a0592ce1384ab93'` — the same commit VSCodium `1.121.03429` was
built from, which is the whole reason this pairing was chosen.

**The manifest is generated, not written.** `scripts/workbench-manifest.mjs` builds
`apps/desktop/build/workbench-runtime.json` from three sources, none of which is the tarball: the
installed client's **compiled product module** (never `package.json`, which has no `config` field at
all), the VSCodium release API plus each asset's published `.sha256` sibling, and
`upstream/stable.json` at the release tag — the only published join between a VSCodium release and a
VS Code commit. Every size it recorded matches preflight §2.2's table exactly.
**`win32-arm64` is absent, and the absence is the statement.**

**Extraction is transactional, in the order §3.5 makes normative.** Verify the archive against the
committed manifest before a single entry is extracted → extract into a `.tmp-<random>` sibling on
the same filesystem → reject absolute paths, `..` traversal and links whose **resolved target**
escapes the root → patch `product.json` there → write the receipt **last** → atomically rename into
the checksum-addressed final name → and publish over an invalid occupant by **quarantine**, never by
deletion. The publish path contains no recursive delete of a destination; `rm -rf` appears only
against Chorus's own temporary tree and in the restartable quarantine sweep.

**Containment is checked against the archive's own headers rather than delegated.** `tar -tvzf`
output was tried first and rejected on observation: it is `ls -l`-shaped, its date column changes
format with the file's age, and a filename containing `->` is indistinguishable from a symlink's
arrow. `main/workbench-archive.ts` reads the 512-byte headers instead — including the GNU
long-name, long-link and pax records that _rewrite the next entry's path_, which a reader looking
only at ustar blocks would judge a placeholder and let the real path through unexamined. That is
CVE-2026-23745's shape, and it is why the invariant is not handed to a library.
A test asserts the reader agrees with `tar` on **all 2,828 entries of the real artifact**, and that
none of them is refused.

**What the gate observed — `node e2e/workbench-containment.mjs`, 15/15 claims, with a live server.**
The nine claims from slice 1 still hold, and six are new or rewritten:

- **each surface lists the REAL contents of its own project root** — 26 of 27 entries for the repo
  root, 15 of 15 for `apps/desktop`, every visible row a name that is actually on disk. The rows
  include `.turbo` and `turbo-build.log`, which are gitignored: nothing could have synthesised them.
- **the two trees are different trees, not two views of one** — asserted on names that exist in
  exactly one root, because a row count would pass for two views of one workspace.
- **surface A's editor shows the bytes that are on disk** — `"name": "chorus"`, read through the
  REH.
- **surface B shows its OWN `package.json`** — same filename, `"name": "@chorus/desktop"`, and not
  A's. This is the sharpest form of the proof available: a synthesised tree could guess a _name_,
  and nothing short of reading the disk produces different bytes under one name in two surfaces.
- **the surviving editor still accepts a keystroke** and **still runs ⌘P**, after its sibling is
  destroyed, **with a server attached**. That is step 3, and it is the claim the phase cannot pass
  without.

**The limitation slice 1 carried is closed.** Mohamad's finding — "the file tree is in memory and
seeded from the project-root string" — is what this stage was for. The
`RegisteredFileSystemProvider` overlay and its two synthesised files are gone; the workspace folder
is a `vscode-remote://<authority><root>` URI and every file operation is answered by the server.

### Four things the preflight got wrong, found by running it

All four were read out of source or prose and are corrected here against what was observed.

1. **§5.4's port line does not exist in this artifact, and waiting for it would hang forever.** The
   brief says to parse `Web UI available at http://localhost:<port>?tkn=<token>`. That line belongs
   to the `reh-web` build, which bundles a web workbench; the plain `reh` — the one §2.1 correctly
   chose, because Chorus supplies its own workbench — prints `Server bound to 127.0.0.1:<port>
(IPv4)` and `Extension host agent listening on <port>` and never mentions a token at all. All
   three forms are accepted now so a future artifact printing the other still works.
2. **§5.3's "delete the token file as soon as the server reports ready" is wrong, and it fails
   silently.** The brief reasons that the file "is read once, synchronously, at startup". It is not:
   the server binds and prints its port _before_ it needs the token and reads the file again when a
   client connects. Implemented exactly as written, every handshake was refused with
   `Unable to read the connection token file at '<path>'` on the server's stdout — and **nothing
   surfaced in the workbench**, because `RemoteFileSystemProviderClient.register` only registers the
   `vscode-remote` provider once `getRawEnvironment()` resolves. A refused handshake therefore
   produces no provider, no error toast, and a project root that renders as a childless leaf. "The
   folder looks empty" and "the server refused us" are the same picture. The file now lives as long
   as the server does, `0600` inside a `0700` directory, and is removed by `stopWorkbenchHost`.
   The mitigations that were doing the real work — per-launch, never on the argv (CVE-2024-26165) —
   are unaffected.
3. **A4 is now an observation rather than a source-derived prediction, and it holds exactly.** The
   shipped `product.json` has **74 fields and not one of them names VS Code `1.121.0` or
   `987c9597…`**. `commit` is `824c4c46a288b839f13b24022655329c2aeb9f81`, which is
   `sha1("1.121.03429\\n")` — verified by computing it, newline included, since VSCodium's
   `version.sh` uses `echo`. `version` is `1.121.03429` and `quality` is already `stable`.
   `GET /version` returns that same sha1 unauthenticated, which confirms §7.2's corrected row from
   the other side: after the patch that field is Chorus's own value echoed back, so it can never
   prove which artifact is running.
4. **A5 and A3 are answered.** VSCodium's build kept every flag §5.3 named — `--host`, `--port`
   (documented as "If 0 is passed a random free port is picked"), `--connection-token-file`,
   `--without-connection-token`, `--server-data-dir`, `--extensions-dir`, `--user-data-dir`,
   `--telemetry-level`, `--log`, and `--reconnection-grace-time` with the 10800 s default the brief
   predicted, printed at startup. **Unpacked size is 257 MB** and the bundled `node` is **v22.22.1**.

### Three defects in the gate itself, and none of them was in the product

Recorded because each first appeared as a product failure, which is the expensive way round.

1. **An assertion that tested "nothing changed" where the claim was "nothing was removed."** The
   survivor's `[data-vscode]` count was compared with `===` and failed on `before=14 after=15`. A
   live workbench keeps appending style elements as it draws; the hazard is the count going _down_.
2. **A wait that could be satisfied by the state it was trying to change.** "Open this file" waited
   for `.view-line` to be non-empty, which is true of any editor already open — so it reported the
   contents of an unrelated file and called it a pass. It now waits on the **active tab's name**.
3. **A rectangle measured before a virtualised list had finished filling in.** Rows shifted under
   the coordinates between measuring and clicking, and the click walked into folders. Find and click
   now happen _inside_ the retry.

**And one flake that is real and is not fixed.** Surface B's file-open step failed once at a 90 s
timeout and passed on the runs either side of it, on the same build. The reloaded surface has to
reconnect to the REH and repopulate its tree before the row exists, and that is slower than the rest
of the gate by enough to matter. It is a **timing** flake in the harness rather than a product
defect as far as anything here shows — but "as far as anything here shows" is the honest bound, and
the run count is too small to put a rate on it.

### What this stage did not do, and none of it was authorised

No terminal, no debug session, no extension activation, no VSIX, no Open VSX. No Windows and no
Linux. **No R7/R11 resource measurement**, so the shared-REH topology is still chosen on
architecture and licence with the number owed. **A6 — the deliberate mismatch negative test — has
not been run**, so it remains true that no version check has been observed _refusing_ anything in
this client; what has been observed is a correct pairing connecting. The §5.4 retention and
grace-shortening probes have not been run. Nothing has been committed.

## Phase 1 · Slice 3, the deterministic coexistence gate — **24/24, twice, on independent runs**

**The slice exists because the previous run of the gate was measuring its own harness.** Slice 2's
gate opened files by measuring a rectangle in the explorer's virtualised list and clicking it, and
Codex refused that: a coordinate read from a tree that is still filling in is stale by the time it is
used, and it was observed opening an unrelated file and then walking into a folder. The requirement
was that the gate be driven **through commands and observable state**, which is what this is.

**What replaced the clicks.** Quick open, addressed by the file's own relative path, with three waits
that each replace something that used to be assumed: the widget is **open** before anything is typed
(`Input.insertText` goes to whatever has focus, and an early one lands in the editor as a silent edit
to a real file); the box **holds the query**, which is the one observation that separates "the search
found nothing" from "the keystrokes went somewhere else"; and the **focused row is the intended one**
before Enter is pressed, because Enter takes the focus and quick open scores fuzzily. `⌘A` carries
`commands: ['selectAll']`, since a synthesized key event does not run the browser's editing commands
unless it names them. **There is no `getBoundingClientRect` left in the gate.**

**The fixtures are chosen for two properties, not convenience.** Unique in their own tree, so that
"the focused row is the file I asked for" is not a question about ranking; and distinctive in their
first dozen lines, so the marker is evidence the _bytes_ came off the disk. No marker contains a
space, because VS Code renders runs of whitespace as `&nbsp;` and a marker with indentation compares
against a character that is not in the file.

**And the fixtures are two disposable projects the gate writes into `tmpdir()`, never the Chorus
checkout.** That is a correction rather than a preference: pointed at the repository, the edit step
typed into `apps/desktop/package.json` and the workbench — correctly, on Code-OSS's own web default —
**saved it**, so line 1 of a tracked file became `CHORUS-ALIVE{`. A harness may not write to the
repository it is checking. Writing the fixtures rather than finding them also sharpens every
assertion, because the gate knows the exact bytes: `alpha-manifest.yaml` and `beta-manifest.yaml`
carry this run's own id, so nothing an earlier run left behind can satisfy a claim in this one.

**Two consecutive runs, 24 of 24 claims each, and the runs are demonstrably independent.** An
earlier pair was reported here as having "identical output"; that phrasing is withdrawn, because the
output carries a random port and fresh PIDs and the word was doing work it had not earned. What is
claimed now is checkable instead of asserted — the gate prints its run id, data directory and
Electron pid, and **every one of them differs between the two runs**:

|              | run 1                                 | run 2                                 |
| ------------ | ------------------------------------- | ------------------------------------- |
| run id       | `chorus-workbench-gate-1787433512634` | `chorus-workbench-gate-1787433767901` |
| Electron pid | 20174                                 | 24829                                 |
| REH pids     | 23845, 23936                          | 28125, 28134                          |
| REH port     | 60819                                 | 62310                                 |

**And run one was dead before run two began** — its Electron pid and all eight process ids it had
touched were checked individually with `ps -p`, all dead, with no gate or fixture process left on the
machine. Two runs that share a process are one run.

**Every step the brief asked for passed.** Focus each surface; open a known real file by exact
relative path in each; assert distinctive content; close surface A; confirm the spawned REH PID is
still alive; confirm surface B retains the same dynamically discovered port; reopen a real file in B,
edit its buffer, run one command — and then, on a clean buffer, close and reopen it. The command is
`View: Toggle Primary Side Bar Visibility`, matched
on the focused row before Enter and judged by its **effect** — `sidebar 169px → 0px` — because "a
widget opened" is not "the workbench executed something". The title is matched on meaning rather than
on a string, since "Side Bar" became "Primary Side Bar" between VS Code versions.

### The launcher was a wrapper, and it invalidated a finding

**The gate spawned `npx electron .`**, so the handle it held was **npm's** process. `child.pid` was
npm's pid, `child.kill('SIGTERM')` signalled npm, and `child.exitCode` reported npm exiting. On that
footing this file reported "the server is still running after the app went" — a sentence about the
_wrapper_ going, describing a Chorus shutdown that had never been asked for. An orphan finding was
raised on it and relayed upward as established. **It is not established**, and `BOARD.md` C-051 has
been downgraded to say so.

**The gate now spawns Electron's own binary** (`createRequire(import.meta.url)('electron')`, whose
main export is the executable path when required from Node), so the handle is the main process, the
signal reaches it and `exit` is its own.

**The experiment has now been run, and the leak is real.** Electron is signalled, its `exit` is
awaited, and the recorded server PIDs are then polled for 15 seconds so that a slow shutdown cannot be
mistaken for a leak. Both runs agree: Electron exits **cleanly, `code=0`**, and a REH process is
**still alive fifteen seconds later** — `23936` on run one, `28134` on run two. Of the two PIDs
matching the run's `--server-data-dir`, the shell wrapper dies and the node process survives. `C-051`
is re-established on that evidence and **E4 below is a real exit blocker** rather than an open
question. No product reaping has been written: that is the next patch, not this one.

**Run independence is no longer owed.** Two runs whose output differs only in a random port and fresh
PIDs cannot be called identical, and had not been shown to be distinct either. The gate now prints its
**run id, data directory and Electron pid**; those all differ between the two passes, and run one's
Electron pid and every process id it touched were checked dead with `ps -p` before run two started.
The table is above.

**PID, port, exit status and sanitised server output are recorded on every run, and the port is never
hardcoded.** It is discovered twice from opposite ends and the two are compared: the surface's own
descriptor says which port it is talking to (`127.0.0.1:55101`) and the server's own log says which
port it bound (`55101`). The PIDs come from `ps -Awwo` matched against `--server-data-dir` under this
run's `mkdtemp` directory, so a stale server from an earlier run cannot be mistaken for this one —
`CLAUDE.md`'s port-9800 rule one level out. Liveness is asked of the kernel with signal 0. And the
gate asserts the server's log does **not** contain the connection token, checked against the real
token read from the descriptor rather than against a pattern; the token is never printed.

### The reload is **deliberately vetoed**, and that is a safeguard rather than a defect

**Classified rather than described, which took instrumenting one reload.** `location.reload()` in a
surface does not replace the document, and "it did not reload" has three causes that need completely
different answers. Electron's own events settle it: a temporary probe on the surface's `webContents`
recorded **`will-prevent-unload`**, and recorded **no `will-navigate` refusal at all** — so the
navigation lock did not stop it. An in-page listener registered last confirms the other half:
`beforeunload` fires once and cancels. The workbench vetoes the unload, and Electron honours a veto
**silently** — no dialog, no error, an epoch marker that simply survives.

**That is the same machinery that stops a reload throwing away an unsaved editor**, so the response
is to keep it, not to get around it. Clearing the buffer first, or reloading through the debugger,
would each have made the claim pass by removing the safeguard from the thing being measured. So the
self-reload claim is **replaced by a close/reopen recovery proof**: the surface is closed, the
**same grant is redeemed a second time** — main's documented rule, since a capability is bounded by
its owner's document rather than by a use count — and the new document must be answered with the same
project and must read a real file through the same server. That reaches the state §4.1b rule 3 is
about, by the route the product will actually take. What remains asserted about the reload itself is
one claim with three outcomes: **allowed or deliberately vetoed passes; silently refused fails**,
because a navigation stopped before unload would be ours.

### The edit claim became the write path, and it is a stronger proof than the one it replaced

**It began as one assertion — type, then check the tab is dirty — and it failed.** Separated into two
waits, per the correction, it still failed, and the cause was neither a race nor a selector:
`files.autoSave` defaults to `afterDelay` at 1,000 ms in the **web** workbench —
`"default": isWeb ? AutoSaveConfiguration.AFTER_DELAY : AutoSaveConfiguration.OFF`, read out of the
installed client — and `monaco-vscode-api` _is_ the web workbench. So "dirty" is a state that exists
for about a second and then correctly stops existing, and an assertion that only looked for it was
asking the system to be mid-flight at the moment it was measured.

**Auto-save is kept.** Mohamad's decision: it is Code-OSS's native web behaviour and Chorus does not
second-guess it. Nothing in the product forces `files.autoSave` either way, here or anywhere else.

**What the gate asserts instead is the end of the flight rather than a moment inside it**, and it is
four claims where there was one: the editor took the edit; the **fixture file changed on disk** within
a bounded wait; the editor went **clean**; and the **saved bytes are exactly the marker followed by
the original content**. Together those exercise the editor, the working-copy service, the save, and
the round trip out through the remote extension host to a real filesystem — none of which the dirty
check touched. The marker carries the run's own stamp, and the original content is asserted to still
be present, because a save that truncated the file would otherwise read as a pass.

**The defect the failure exposed was the harness's, and it was serious**: the buffer being typed into
was `apps/desktop/package.json`, so the workbench saved into the checkout. Repaired surgically, fixed
by giving the gate its own disposable projects, and recorded as `BOARD.md` **C-052** — which is filed
as _the gate editing the repository_, not as an auto-save bug, so that nobody reading it later
concludes the wrong thing.

**One related product fix followed from it.** `services.ts` called `initUserConfiguration` with a
fixed object on every start, which **replaces the user's settings file** rather than merging into it —
so any preference a person changed was discarded next time a surface opened, and `files.autoSave`
would have been un-turn-off-able while looking, from that file, like a setting nobody had touched.
Chorus's own preferences now sit in `configurationDefaults`, the layer a user's settings override in
the normal way. **Bounded honestly**: the workbench partition is in-memory, so a preference survives
within a run and not across a quit; what is closed is Chorus actively throwing the choice away.

### The reload is vetoed, so recovery is proved by closing and reopening

**Classified rather than described**, which took instrumenting one reload with Electron's own events.
A temporary probe on the surface's `webContents` recorded **`will-prevent-unload`** and **no
`will-navigate` refusal at all**, so the navigation lock did not stop it; an in-page listener
registered last confirms the other half, `beforeunload` firing once and cancelling. Electron honours a
veto **silently** — no dialog, no error, an epoch marker that simply survives — which is why this
looked for two rounds like a page that had frozen. The probe was removed once it had answered.

**That is the machinery that stops a reload discarding an unsaved editor, so it is kept.** Clearing
the buffer first, or reloading through the debugger, would each have made the old claim pass by
removing the safeguard from the thing being measured. §4.1b rule 3 is proved by **closing the surface
and reopening it** instead — a new document, on the same project, that must be told what it is,
reached the way the product will reach it. The grant is redeemed a **second time**, which is main's
own rule: a capability is bounded by its owner's document, not by a use count.

**Its position in the run is part of the claim.** The close happens _after_ the edit is saved and the
editor is clean, because closing runs the document's own unload path — attempted on a dirty buffer it
would meet the same veto, and the proof would be measuring the veto rather than recovery.

What remains asserted about reloading is one claim with three outcomes: **allowed or deliberately
vetoed passes; silently refused fails**, because a navigation stopped before unload would be ours.

### Three harness defects found by running it, and none was in the product

Recorded because each first presented as a product failure, which is the expensive way round.

1. **A count that was right in its old position.** The recovery proof's "surface B has gone" wait
   asked for one remaining workbench document — correct while it ran before the crux and A was still
   open, and wrong the moment it moved after it, where the answer is zero. It timed out on a surface
   that had closed immediately. A count is only a claim alongside what else is open.
2. **A wait satisfied by the wrong signal.** The reopened surface's readiness check returned on
   `workbench || failure || answered`, and `answered` is much the quickest of the three, because main
   pushes the descriptor on `did-finish-load` while the workbench's module graph is still evaluating.
   The assertion then read `workbench=false` off a surface three seconds from rendering and reported a
   working recovery as broken.
3. **The launcher, which is its own section below** — and the most expensive of the three, because it
   invalidated a finding that had already been relayed onward as fact.

### Workspace Trust is waived in the E2E profile, and the evidence that forced it

**The first two runs of the rewritten gate were blocked by a modal**, and the record is worth keeping
because the mechanism was invisible from the assertion that failed. With trust enforced, a fixture
root opens in Restricted Mode behind **"Do you trust the authors of the files in this folder?"** —
which takes DOM focus (`activeElement` was one of its buttons), and while it is up `⌘P` opens
nothing, a command runs nothing, and Electron silently cancels `location.reload()`. It is also
**timing-dependent**: one run had surface A finish its file open before the dialog arrived and
surface B caught by it, and the next had both caught. A gate that a dialog can win is a gate whose
passes mean nothing.

So the waiver, and **both halves of its condition are load-bearing**: `app.isPackaged === false`
**and** `CHORUS_WORKBENCH_E2E_ROOTS` present. The environment belongs to whoever launched the app, so
a packaged build that trusted it alone would let an exported variable silence the trust prompt in an
installed Chorus; the variable is what an ordinary `pnpm dev` cannot trip over. **A shipped
descriptor carries no trust field at all** — the schema is `z.literal('waived').optional()` and there
is no value meaning "enforced", so no ternary can be inverted into a disabled-trust flag and a
reader who forgets the field gets the safe behaviour.

**Three tests, and the load-bearing one is the packaged case**, because the waiver's safety _is_ the
packaging check. Both were proved against the defect reinstated, one experiment each: removing
`!app.isPackaged` from `isE2eProfile` turns "is refused to a packaged app" red and nothing else;
removing the environment check turns "is refused to an unpackaged app with no seed" red along with
four descriptor tests.

**And the waiver did not work the first time, for a reason worth recording.** Main spread the field
in, the schema admitted it, the renderer read it — and the dialog still appeared, because
`preload/workbench.ts`'s `asConnection` **rebuilds the descriptor from a hardcoded list of five
names** and silently dropped the sixth. That file explains at length why it hand-writes its check
instead of importing zod (two preload entries sharing a runtime module make Rollup emit a chunk a
sandboxed preload cannot load, and the file it broke was the _shell's_), and the cost of that
constraint is exactly this: **adding a descriptor field is a two-file change**. It is now written
there, and a test carries the waiver through `asConnection` in both directions — the dangerous one
being not "the waiver was lost" but "something that is not the waiver was let through", so anything
other than the exact string is dropped and every rejection lands on the safe side.

### `pnpm check` was red on three of its four legs — **defects of this phase, now fixed**

This file said twice that `pnpm check` was green. It was not, and the reason it was not is worth
separating from the rest of this round: **these were ordinary implementation defects in this revamp
phase.** They are not measurement problems and they are not somebody else's — only the launcher, the
run-independence question and the reload belong in that category. An earlier draft of this section
filed them under a tidy "it was all instrumentation" heading, which is exactly the narrative a phase
tells itself when it does not want to count its own bugs.

- **`typecheck`** — `workbench-surface.test.ts`, `Expected 0 arguments, but got 1`: the
  `workbench-host.js` mock forwards a root into a `vi.fn(() => …)` declared with no parameters. Fixed
  by declaring the parameter, which is also what the assertions reading `toHaveBeenCalledWith` need.
- **`lint`** — 12 errors: four unnecessary optional chains on `child.stdout`/`child.stderr` and three
  numbers interpolated into template literals in `workbench-host.ts`, one more in
  `workbench-extract.ts`, a deprecated `product` import in `services.ts`, and `fetch` undeclared for
  the build-scripts lint environment in `workbench-manifest.mjs`. All fixed. The deprecation is the
  only one answered with a disable rather than a change, and it carries its reason: the check exists
  to compare the client's **compiled build identity** against the server, and `IProductService`
  resolves the _effective_ configuration — which is precisely the value that must not be trusted,
  because a client told to claim a commit would then agree with itself.
- **`format:check`** — six unformatted files. Formatted.

**Why nobody saw it, stated accurately.** `check` runs `typecheck && lint && format:check && test`
and stops at the first failure, so the three legs behind `typecheck` were never reached. **Only
`typecheck` is a turbo task**, and turbo was replaying a cached green result from an earlier hash;
lint, format and test are direct commands and cannot be blamed on that cache. The cache explains why
the _first_ leg stayed quiet, and the sequencing explains the rest.

**`pnpm check` now exits 0**, with `typecheck` re-run uncached (`turbo run typecheck --force`, 18/18
executed, 0 cached).

## Phase 5 · Opened — three slices were already delivered, and the ledger corrected the plan

**5a is the only slice that needed code, and it is verified.** Registering
`extension-gallery-service-override` supplied the management half the workbench
lacked — gallery, workbench extensions service, enablement, recommendations, and
`IExtensionManagementServerService`, which is what installs a workspace extension
on the **server** rather than in the browser. Mohamad installed an extension from
Open VSX on 2026-08-24 and it worked.

**The Open VSX configuration was copied from the server, not composed.** The
unpacked REH already carries one, because VSCodium ships it — so "use Open VSX as
the default registry" was half-satisfied before the phase began, and what was
missing was the client agreeing. A first draft of the client config guessed
`resourceUrlTemplate` and `extensionUrlTemplate` from memory; the server sets
neither. `resourceUrlTemplate` is deliberately left **empty** rather than
asserted: it is the web host's asset path, and a wrong URL there fails as a
network error rather than as configuration.

**5b and 5c needed no code at all**, and the reason is the same for both:
registering a service brings its whole contribution with it. `Install from
VSIX…` is contributed by `extensions.contribution`, gated on having a local or
remote server — which 5a supplied — and backed by the dialogs override's
`IFileDialogService`. 5c's five requirements (source, version, host kind,
workspace trust, activation errors) are all native, the last two through the
extension editor's **Runtime Status** tab. Three slices in a row where the work
was to find out that the work was done.

### The ledger found a factual error in the approved plan

**§4 said the browser-capable class had "one third-party occupant, not six".
There are 24.** Reading `extensionKind` out of all 81 installed manifests gives
twenty-four whose first entry is `ui` — the exact `["ui","workspace"]` shape the
section attributed uniquely to Draw.io. The **rule** the preflight established was
never wrong; the **count** taken from it was, and §4 is now corrected with the
number and the method.

It matters because the class decides what evidence a row needs — web host plus
webview/storage/auth, versus the REH Node host plus process/filesystem/network. A
Phase 5 following the old table would have gathered the wrong proof for a third of
the estate and learned so only when it failed.

**16 of the 81 are absent from Open VSX**, a blocker discoverable without running
anything: the Microsoft-restricted ones §4 already names, plus several ordinary
extensions with no open-registry home.

**One caveat now applies to every row — `BOARD.md` C-063.** Chorus runs one REH
with one extensions directory shared by every open project, so every result is
proved under a per-server scope. Workspace trust is per project but the extension
it gates is global, so trusting one project can activate an extension inside
another that was never trusted.

**The four result columns are empty and that is the design.** §4 is explicit that
installation is not the gate — activation and one representative action are — so
those are for a person, and an empty cell means unproved rather than failed.

## Phase 4 · Six slices, the review gate passed, and the phase is **not finished**

**🟡 rather than ✅, and the distinction is the point.** Mohamad drove editing,
navigation, Git, a terminal and a debug session in the embedded workbench on
2026-08-24, which is exactly what the phase's user review gate asks for — so the
gate is met and Phase 5 is unblocked. The **exit criteria are not**: they ask for
steps 1–8 of the daily acceptance journey with no Chorus substitutes, and several
services in the phase's own list have never been registered.

**What landed, in six slices.**

| Slice | What it did                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------- |
| 4a    | `MonacoEnvironment.getWorker` for four labels (C-061) · SCM override (C-062)                                  |
| 4b    | The workbench moved into the project pane — `WorkbenchTarget` by project id, two regions, a resizable divider |
| 4c    | The custom file tree retired; the workbench Explorer is the file browser                                      |
| 4d    | Terminals through the REH; the per-session panel retired, **the global one kept as a PTY**                    |
| 4f    | Debug service registered; `js-debug` had been activating with nowhere to put its views                        |
| 4g    | Code-OSS's own chat and inline completions off by default — one agent product, not two                        |

**4e was re-scoped and parked, deliberately.** Half of it was already true: 4a
gave the workbench real Git, so the primary Git surface is the workbench's by
virtue of existing. What remained was deleting the panel's embedded diff viewers
— `FileDiff` and `MonacoDiff`, 650 lines and the 4.87 MB Monaco adds to the main
chunk — but clicking a changed file would then need to open in the workbench's
diff editor, and **there is no channel for that**. A surface's preload is three
methods on purpose, because a workbench document runs third-party extension code.
Widening that boundary to win a bundle size is a poor trade against what Phase 1
hardened it for, so the panel stays: it shows changes since the _conversation's
base_, which SCM structurally cannot.

**What the service set still lacks**, against the phase's own list: tasks,
testing, comments, timeline, snippets and outline, the extension gallery,
webviews, authentication.

### What the surface told us, twice, before anyone looked for it

**Two of these slices were diagnosed by the workbench's own Window output**, which
is worth recording because nothing was instrumented to find them. `js-debug`
logged that the `debug` view container did not exist and its views were being
dumped into the Explorer — that is 4f, stated by the thing that was broken. The
`SCMService.registerSCMProvider is not supported` line was 4c/4a in the same way.
A service that is absent says so; the cost was that nobody was reading the channel.

### Three defects in the layout, all mine, all invisible to the typechecker

Recorded because they are the same class as the four in Phases 2 and 3.

1. **`flex: 0 0 clamp(…)`** — a `flex-basis` the parser rejects invalidates the
   _whole_ declaration, so the Chorus column lost its grow and shrink too and
   sized on content. The editor came up wrapping at twenty characters.
2. **`.workspace-pane-content > *:not(.conversation-dock)`** — written when that
   container had one child, applied to three, and outranked the column's own
   `flex-grow: 0` on specificity. **The 9px sash inflated to hundreds of pixels**
   and read as the workbench failing to resize.
3. **A drag that hid the editor.** A `WebContentsView` is a native view above the
   document and pointer capture cannot span two `WebContents`, so a drag crossing
   the workbench died. The first fix reported a zero rectangle — the drag worked
   and the editor vanished. The second applied a gutter on pointerdown, which made
   the editor jump. The third is a permanent 8px inset: nothing moves, ever.

**And one that was not a defect in the product at all.** A greedy regex intended
to delete one function removed **259 lines of `Session.tsx`** — most of
`SessionInfo` and the whole opening of the component. It was recoverable only
because those particular lines existed in the Phase 1 commit. Everything written
since would have been gone. That is the sharpest argument in this file for
committing between slices, and it is an argument from an event rather than a
principle.

## Phases 2 and 3 · Built in seven slices, driven by hand, and **never once tested**

**Both phases are written and both were driven in the running app on 2026-08-24.** Phase 2 makes
Project the top-level domain; Phase 3 puts it on screen. What follows is the record, and the last
line of it is the one that matters most.

**Phase 2, four slices.** A `Project` domain and `ProjectStore` in `event-store` (migration 4
recreates the `projects` table, which had existed unused since migration 1 — no INSERT anywhere in
the repo, and not a projection). `ProjectService` in main, the only layer allowed to ask the
filesystem. A new database namespace, `chorus.v2.db`, with the old file left in place rather than
renamed. Then the re-key: `ActiveConversation.cwd` became **readonly**, `setProjectDirectory` was
deleted, `open-sessions.ts` became `open-projects.ts` recording ids and no paths, and
`conversation:setCwd` / `conversation:chooseCwd` were removed from the contract.

**Phase 3, three slices.** A projects group in the rail with a real Add Project. The layout algebra
re-keyed from `conversationId` to `projectId` — the algebra itself unchanged, because it was always
generic over an opaque tab id. Then the Chorus dock, a per-project conversation switcher with a
persisted pointer and a newest-conversation fallback.

**What closed on the way.** Phase 1's **E2** — `WorkbenchTarget`'s `projectId` arm had been failing
closed since it was written, and `ProjectService.resolveRoot` is what it now resolves against.

### Four defects found, and all four were invisible to the typechecker

Recorded because the pattern is the same each time and it is the argument for the tests that were
skipped.

1. **`cwd: row.cwd ?? row.projectId`** in `listConversations`. Honest while `project_id` held the
   directory a conversation was created in; it holds a real id now, so a history row with no agent
   session would have shown a **UUID where a path goes**.
2. **A blank first-run screen.** `App` returned a bare `aria-busy` div whenever there were no
   sessions, which was survivable only because auto-start immediately made one. Once a session
   required a project, the div became permanent — no rail, so no Add Project, so no way out. **It
   presented as a black window.**
3. **`reconcileWorkspace` filtered tabs against conversation ids.** Tabs are projects now, so every
   tab was discarded on every launch: a saved layout could not survive a restart.
4. **The same function seeded one tab per conversation**, so one project with three conversations
   opened as three identical tabs — and the dock, which only appears at two conversations in one
   project, could never appear at all.

**Each of these compiled. Two of them shipped a plausible-looking app that had quietly thrown
something away.** `npm run errors` went green over defect 1 four separate times.

### The bound on all of it

**Nothing here has been tested.** Not one of the seven slices has had `npm test` run against it, by
explicit decision each time it was raised. **64 tests in `layout.test.ts` and `store.test.ts` guard
exactly the behaviour Phase 3 re-keyed** — drag, reorder, split, focus, the four-pane cap — and they
now compile against the new signatures without having been executed. The close semantics, the
restart-no-longer-touches-layout decision, and the dock's fallback are each a judgement recorded in a
comment and confirmed by nothing.

**Nor is any of it committed.** Phases 2 and 3 sit in one working tree on top of Phase 1's commit,
with no intermediate state to bisect against.

## Phase 1 · The user UI review — passed, and the bound on what that proves

**The plan's user UI review gate is met.** Mohamad drove the workbench probe on **2026-08-24** and
reported it working with no issues, and separately confirmed **settings persistence** — a preference
set in one run still set after a quit. That is the gate the plan asks for and the one an automated
check is explicitly forbidden from standing in for: the person the product is for opened the screen
and found nothing wrong with it.

**What was reported is reported, not reconstructed.** "It works, no issues", and then "settings
persistence works fine" in answer to a direct question about that step. **Per-step detail was not
collected** — which repositories, which files, whether the command palette or the close-one-surface
step were exercised by hand — so this record claims no step-level coverage. What it does claim is
the thing a review gate exists to establish, and nothing beyond it.

**E5 is confirmed twice over — by hand and by its gate.** A preference set in one run survives a quit,
the behaviour an in-memory partition could not give, now carried by Chorus's own
`User/settings.json` under `userData` with the partition deliberately left in memory. Beside the
hands-on pass, **`e2e/workbench-settings-persistence.mjs` passed all three of its phases** — reported
by Mohamad, not observed here, and recorded as his report rather than as a run this file witnessed.
The third phase is the one that carries the weight: a clean profile Q still gets Code-OSS's
`afterDelay`, without which the gate would pass equally against a hardcoded value or a default that
had been `off` all along.

**Two of C-053's three "done means" are now met, and the third is what keeps E5 open.** Where
workbench state lives is decided, and a preference set in one run is proved still set in the next.
**Nobody has checked that the connection token is still absent from disk after a quit** — the property
the in-memory partition was protecting, and the whole reason this needed designing rather than one
word changed. **E5 closes when that check exists**, and not before. It is deliberately not being
written now: C-059 is the board's next fix and this is the smaller of the two.

**C-054 did not appear, and that is worth close to nothing.** At roughly two sightings in eleven
single-surface sessions, one clean session is the expected outcome whether the defect is there or
not. It remains a critical tracked release defect and may not be presented as fixed.

**C-059 was not exercised, and the reason is worth stating so nobody reads this pass as covering it.**
It needs `files.autoSave` turned off _and then_ an edit typed and left unsaved; persisting the setting
across a quit never touches the dirty state. The gate's observation therefore stands unchallenged — no
dirty class on the tab, no filled-circle close action, no bullet in the title, and `File: Revert File`
leaving the marker in the buffer for a full 20 s — and C-059 stays queued as the first stabilization
fix.

## Phase 1 exit items — open, and deliberately not fixed in this slice

**E1 · ~~The bounds observer misses position-only movement.~~ Closed — by measuring instead of
subscribing.** `WorkbenchFrame` used to report the placeholder's rectangle from a `ResizeObserver`
on that element plus a `window` `resize` listener. Neither fires when the element **moves without
changing size** — a sibling pane closing, a rail or panel opening, a scroll of an ancestor, a tab
strip reflowing, an animated layout settling. The view then painted at its old `x`/`y` over new
content: not a crash, and not a one-frame lag either, but a **permanently misplaced overlay** until
something else happened to resize it.

**What it is now**: one `requestAnimationFrame` loop that reads `getBoundingClientRect()` every
frame while the surface is mounted, and calls main **only when the rectangle differs from the one
last sent**. The choice is deliberately not a third subscription. Enumerating the causes of movement
fails _silently_ by construction — the case nobody thought of emits no event, and a missing event is
indistinguishable from a stationary element. Measuring never asks what moved the element, so it
cannot have missed a cause. The `IntersectionObserver` inset trick would be cheaper at idle and buys
the same silence at a higher price: root margins subtle enough that slightly wrong arithmetic yields
an observer that quietly never fires. The cost paid instead is one layout read per frame per mounted
surface, taken inside rAF — before style and layout, with nothing written back — and **no IPC at all
while the rectangle is unchanged**, which is what the control test asserts.

**What was proved, and what was not.** Four unit tests in `WorkbenchFrame.test.tsx`, driving the
frame queue by hand so that "nothing was sent" is a measurement rather than a race against a 16 ms
timer. The tracking test walks the four rectangles E1's criterion names — window resize, tab switch,
pane split, sibling close — and after each one asserts the reported rectangle **equals the rectangle
read back off the element**, never a literal. Two of those four change position and not size, which
is precisely what the old mechanism could not see. Three mutations were proved red on the right
test: dropping the re-arm (the loop measures once and never again) fails the tracking test at its
first step; dropping the dedupe fails the control with 6 sends where 1 is right; dropping
`cancelAnimationFrame` fails all four through the `afterEach` assertion that no frame outlives the
component — a loop that survives unmount would run for the life of the app. jsdom lays nothing out,
so the element is given a rectangle the test moves; without that, every assertion would have passed
on `0 === 0`.

**Honest limits.** The four operations are expressed as the rectangles they leave behind, not as the
DOM operations that would produce them — the probe has no tabs and no splits to perform, and the
tracking under test never sees an operation either. In the running app the static case was measured
across the process boundary: the surface's own `innerWidth`/`innerHeight` were **640 × 791**, exactly
the placeholder's rectangle. A live measurement _during_ a move was not taken. **Related and still
unfixed**: bounds are read in CSS pixels and sent as device-independent pixels, which agree only at
zoom factor 1, so `⌘+`/`⌘−` still mispositions the view. That is a unit conversion rather than a
tracking failure, and it is left where it was rather than folded into this fix.

**E2 · ~~Approval bounds no directory.~~ Closed by the seventh round, and what replaced it.** This
item used to say that any existing directory was approvable and that bounding the set was a product
decision for later. Codex read the same sentence as the blocker it was: the openable set was "every
directory that exists", and deferring it left canonicalisation standing in for authorisation. What
bounds the set now is the **native chooser** — one dialog per root, a capability per answer, bound to
the window that asked and gone when that document is. **What remains open is narrower and is
genuinely ProjectService's**: a _durable_ set of projects the person has adopted, so that opening one
across restarts does not mean picking it again, and so that a project id can be resolved to a root
without a dialog. **Done means**: an id → root table main owns, the second arm of `WorkbenchTarget`
resolving against it, and a test that an id nobody adopted is refused.

**E4 · ~~The remote extension host outlives the app~~ — closed, after three reopenings.**
`BOARD.md` C-051 carries the detail. The cause was two faults stacked: `bin/codium-server` is a bash
script that runs `"$ROOT/node" "$ROOT/out/server-main.js" "$@"` **without `exec`**, so Chorus's child
was a shell and killing it orphaned the real server — the same file being `.cmd` on Windows, which
`spawn` cannot execute without a shell — and Electron terminates on `SIGTERM` by default, so
`before-quit` never ran and nothing was ever asked to stop.

**Every reopening found one thing, and it is the finding worth carrying out of this item.** Six were
checks that could only come back true — a shutdown that signalled an `npx` wrapper and reported on
the app; a start-in-flight test that supplied the port by hand so cancellation was never exercised;
an exit emitted against a process group nobody re-examined; `reapTree` deleting its subject before
reading whether it had died; the startup reaper counting `SIGKILL`s _sent_ as `killed`; and a
`skipped` boolean that made "this platform has no strategy" and "the process table could not be read"
the same value, so `start` spawned on the strength of a sweep that had never run.

**The seventh was one step further along: a failure that could not be seen.** Shutdown carried four
bare `.catch(() => undefined)`s, so a workbench shutdown that _failed_ let Chorus exit with no
survivor result and no log line anywhere — the lifecycle failure this item exists to expose, hiding
inside the machinery built to expose it. Every step now reports its own failure and then resolves,
and the quit gate reports anything that escapes; the two paths are disjoint by construction, which is
what makes **exactly once** a property rather than a promise. It is asserted by count _and_ by
identity, against three quits arriving during one failing cleanup, so an implementation that reported
per quit rather than per cleanup fails it.

Each was invisible to the test written for it, and each was found by asking what would make that test
fail — including, on the last round, **a test of mine that could not fail**: the throwing-reporter
case asserted that the app still quits, which it does either way, and had to be rewritten to assert
what the guard actually buys (no unhandled rejection).

**The last round's three corrections.** The reaper now reports **survivors** rather than signals
sent, and `start` **refuses to spawn** when any survive **or when the sweep could not run at all** —
Windows exempt, because there the absence is a decision rather than a failure. The reaper's
invocation is rejection-handled and left rejected, so a failed sweep reaches the project open as a
refusal. And `before-quit`'s re-entrancy moved into `quit-gate.ts`, which exists to be testable:
`index.ts` bootstraps an application on import, and the guard was wrong in a way reading it did not
reveal.

**Repeated in-app quits are proved by unit test, not by signals**, and that is a correction to how
this was being verified. Driving it with repeated `SIGTERM`s measured the _signal_ rather than the
guard — it passed identically against the defect — because a second termination signal ends the
process regardless. What the guard governs is Electron's quit lifecycle: a second `app.quit()` from
`window-all-closed`, the menu, or a second `⌘Q`. Three cases: a quit arriving mid-cleanup is vetoed
and does not start a second shutdown; the gate steps aside once cleanup settles, so the app can
actually exit; and a cleanup that _throws_ still lets it exit, because an app that cannot be closed
because its shutdown failed is worse than the failure.

**Verified.** `e2e/workbench-shutdown.mjs` at **18/18** — window-close, `SIGTERM` and `SIGINT` each
exiting `code=0` with every descendant gone and the token removed, then the force-quit path in full,
including a project opened **immediately** on relaunch leaving exactly one server that is not the
orphan. Containment **24/24** — not re-run for the final logging-only change, on Codex's waiver.
Twenty-six unit tests; **seventeen defects reinstated one at a time**, each turning exactly the test
named for it red.

**The boundary, and it is documented rather than fixed.** A _second_ termination signal arriving
mid-cleanup is a forced quit rather than a second graceful request: it was observed ending the process
with `signal=SIGTERM` where every ordered stop exits `code=0`. **No mechanism is claimed** — an
earlier version of this record said the termination happens "below the JS handler", which was an
inference from two failed attempts and sits badly with Node's documented signal behaviour. The
observation stands and the explanation is withdrawn. Recovery is the next launch's reaper, which is
proved. That is **C-055**.

**Windows remains exempt and unverified**, including the one case `start` still proceeds on a sweep
that did not run.

**E4's first two rounds, kept for the record.**
`BOARD.md` C-051 carries the detail. The cause was two faults stacked:
`bin/codium-server` is a bash script that runs `"$ROOT/node" "$ROOT/out/server-main.js" "$@"`
**without `exec`**, so Chorus's child was a shell and killing it orphaned the real server — the same
file being `.cmd` on Windows, which `spawn` cannot execute without a shell — and Electron terminates
on `SIGTERM` by default, so `before-quit` never ran and nothing was ever asked to stop.

**Reopened twice, and both rounds found one class of defect: a check that could only ever come back
true.** The second round's four are recorded first because the pattern is the point — a reaper nobody
awaited, a token nobody removed, a `reapTree` that deleted its subject before reading the answer, and
a credential written before the thing that could refuse it:

- **The reaper was fire-and-forget.** Started at `whenReady` and not awaited, so a project opened in
  the same tick as the window could spawn a server **while the orphan still owned this profile's
  server-data directory and token file**. The SIGKILL gate only ever relaunched Chorus and never
  opened a project immediately, which is why it passed. Reaping is now a **readiness barrier** that
  `start` awaits, so the guarantee lives where the server is spawned.
- **Reaping left the stale token.** Removed now, but **only after confirming nothing for this profile
  is alive** — a candidate with a live parent belongs to a running session that reads that file on
  every connection.
- **`reapTree` reported success without proving it**, ignoring the final liveness result and dropping
  the child regardless. It now returns whether the tree is _confirmed_ dead, keeps survivors in
  `spawned`, and shutdown returns their pids for the log. A group can outlive `SIGKILL`.
- **The token was written before the launcher was validated**, so a missing Windows layout left a
  credential with no process to use it. Validation moved ahead of the write.

**And one the fix's own gate caught, which is the sharpest example of the pattern yet.** Stale-token
removal **passed as a unit test and failed end to end**: liveness was sampled in the statement after
`SIGKILL`, and a just-killed process still answers `kill(pid, 0)` until init reaps it — so the token
stayed on the very run that had just cleaned up. The fake kernel kills synchronously and cannot
produce a zombie, which is precisely why the unit test could not see it. The reap now waits for the
pids **it signalled** before deciding what remains, and `inspected` counts every candidate again
rather than only the killed ones, so `inspected > killed` stays something the log can say.

**The first round's four**, kept because three were tests asserting the wrong thing:

1. **No startup reaper**, while spawning the server detached — the property that lets shutdown signal
   the group is also what lets it survive a `SIGKILL`. The fix made the disordered case worse while
   fixing the ordered one.
2. **Shutdown was unbounded**: it awaited the in-flight start, so a stalled download or the 60-second
   port wait became the time Chorus took to quit — a new way to hang, created by handling `SIGTERM`
   at all. **The test supplied a port by hand and so never exercised cancellation.**
3. **An unexpected exit lost the descendants** — the child was dropped from tracking the moment the
   root died, leaving the extension hosts it forked. **The test emitted `exit` against a group that
   was still alive and never checked it.**
4. **Startup cleanup was incomplete**: no `spawn` `error` arm (ENOENT and EACCES emit `error` and
   never `exit`), the token survived failed starts, the port-read/host-assign window was open, and
   `awaitPort` never detached its listeners.

**What it is now.** The server's own `node` runs `out/server-main.js` — shell-free, identical on every
platform, direct child is the real server — spawned **detached** so shutdown signals the **group**.
Shutdown is **asynchronous, idempotent and shared** by quit, `SIGTERM` and `SIGINT` through one
`before-quit`. The start is **cancelled** by an `AbortController` reaching `fetch` and the port wait,
then given a two-second courtesy to unwind rather than waited out — the guarantee never depended on
that wait, since every child is tracked from `spawn` and a late-completing start reaps its own.
Force-kill after a bounded grace; the token removed only once the tree is **confirmed dead** and on
every failed start; an unasked-for exit **reaps the group** and fails **closed**. The boot-time reaper
identifies by this profile's `--server-data-dir` **and PPID 1, never by executable name** — the parent
check is what separates an orphan from a live Chorus's server, and Windows reports `skipped` rather
than a confident zero, exactly as `reap.ts` does.

**Verified in this order.** `e2e/workbench-shutdown.mjs` first — **18/18**. Three ordered stop modes
(window-close, `SIGTERM`, `SIGINT`), every identified descendant gone and the token removed in each;
then the disordered one, where the reaper stops resting on inference: a `SIGKILL`ed Chorus **does**
leave its detached server running, that orphan **is** reparented to init, the force-quit **does**
leave its token behind, the next launch **does** reap both — and a project opened **immediately** on
relaunch leaves exactly one server, which is not the orphan. The stale-token check runs before that
open, deliberately, since opening writes a fresh token to the same path and a check afterwards would
pass either way. The survival claim is allowed to fail informatively: a server that died with its
parent would make the whole reaper unnecessary.

Then the containment gate: **24/24**, `all 1 exited within 1ms of electron (code=0 signal=null)`,
`orphans killed by the gate: none`. **The run before it was 17/24**, on an intermittent failure with
no bearing on this work — every claim needing a file's _contents_ failed while quick open found each
file by path and the server's log showed both connections up and no token refusal. It is recorded as
`BOARD.md` **C-054** rather than folded away here, and one clean pass afterwards did not clear it —
a ten-run batch since has reproduced it three times (run 4: 3 of 4 opens; **run 7: 3 of 3 traced
opens**; run 9: 1 of 4), so it stands as a Phase 1 blocker with the raw per-open rows and a proposed
renderer-log diagnostic recorded there. That proposal is gated on a single healthy control first, and
the gate is specific: the renderer console must carry **read start/result and model-resolution
start/result, each correlated to a resource URI**. **That control has now been run and it failed** —
three start-up warnings across four healthy opens, zero messages naming a resource, all four
boundaries absent — so console capture is abandoned. A read-only source inspection since found that
**model-resolution records exist and are URI-correlated but sit at `trace`, below the configured
`Info`**, and that **read start/result is not logged at any layer, at any level**. The proposal is
therefore the smallest E2E-only diagnostic hook, gated by the same unpackaged-and-seeded condition as
the Workspace Trust waiver, with Step 0 repeated against it before any batch.

Seventeen unit tests, and **nine defects reinstated one at a time**, each turning exactly the test
named for it red.

**Not proven: Windows.** No `win32-x64` artifact has been downloaded, so `node.exe` at the tree root
is convention rather than observation; `taskkill /T /F` has never been run; the reaper is `skipped`
there. **Windows x64 is owed its own proof on a real machine** and nothing above claims it.

**E5 · ~~Workbench settings do not survive a quit~~ — narrowed to one remaining check, 2026-08-24.**
**They survive now**: a Chorus-owned `User/settings.json` under `userData` holds them, the partition
stays in memory, and the behaviour is proved twice — by Mohamad's hands-on pass and by
`e2e/workbench-settings-persistence.mjs` passing all three phases. **What is still open is the
narrower half of C-053's "done means"**: nobody has checked the connection token is absent from disk
after a quit, which is the property the in-memory partition existed to protect. Deliberately left for
after C-059. The original entry follows unchanged, because its reasoning is why the fix took the shape
it did.

**E5's original entry, kept for the record — `BOARD.md` C-053.** The workbench partition is
in-memory (`'chorus-workbench'`, no `persist:`), so every preference the storage service holds — the
theme, a resized panel, `files.autoSave` turned off — lasts for the life of the app and no longer.
This was first written down as the small open half of the auto-save entry, and that was the wrong
size: the plan's goal is that Chorus **replaces** the editor somebody already uses, and an editor that
forgets your settings each time you quit is not a replacement for one. It also undercuts the decision
beside it — auto-save is kept because it is Code-OSS's native behaviour, which only holds if a person
who wants it off can turn it off and have it stay off. **The partition is in-memory on purpose**
(`workbench-surface.ts`: the workbench's durable state belongs to Chorus, not to a Chromium profile,
and it is one fewer place for a connection token to survive a quit), so this needs designing rather
than flipping one word. **Done means**: a decision on where workbench state lives, a check that the
token is still absent from disk after a quit, and a test that a preference set in one run is still set
in the next.

**E3 · ~~The owner-lifecycle teardown is proven by unit test, not in the app.~~ Closed — observed
in a running Chorus, 13/13.** The listener wiring, the same-document control and the per-owner
isolation were asserted against a fake `WebContents`; that Electron emits `did-start-navigation` for
a real shell reload was read from its typings ("emitted when any frame (including main) starts
navigating") and had **not** been observed. The containment gate reloads a _surface_, not the shell.
The seventh round widened what rode on it: a grant is revoked by the same listener, so "a capability
cannot outlive the document it was minted for" was proven exactly as far as this item was.

**`e2e/workbench-owner-lifecycle.mjs`** is the gate, and **the typings are right**: a real
`location.reload()` in the shell reaches `watchOwner` and the surface is destroyed. The run records
`navigation.type=reload`, `surfaces=0`, and the grant refused with main's own sentence — _No
workbench project grant "…" belongs to this window_. That refusal is sharper than it looks, because
**a reload does not replace the `WebContents`**: the caller main compares against is the same object
it was, so `held?.owner !== caller` cannot be what refuses, and the only path to that message is the
grant having been deleted.

**Built so that "nothing happened" cannot pass for a result**, which is the failure mode a reload
probe invites. A marker is written onto `window` first and its absence afterwards is what makes the
run a statement about a reload at all; the bridge is proved to come back, so a shell that reloaded
into a broken document cannot satisfy "no surfaces" and "grant refused" for the wrong reason; both
effects are armed before the reload, so each is a transition rather than an initial state; the
same-document control runs first and twice — a `pushState` before the open (the successful redeem
_is_ the proof the grant survived) and a second one after it, with the surface count **sampled eight
times over two seconds** rather than read once. Recovery closes it: a fresh mint from the new
document opens a surface again, so the revocation is a revocation and not a wedge.

**A reload is not a teardown**, and one record keeps it that way — the REH pids observed before the
reload are asserted **alive, by pid identity**, sampled twelve times over three seconds afterwards. A
count would have been satisfied by a different server; identity is not. This follows the code rather
than an assumption: `destroySurface` releases the lease when the last surface on a root goes, and its
own comment says releasing does not stop the server, `stopWorkbenchHost` on quit being the only
unconditional kill.

**Four mutations, each rebuilt and each red on exactly one record**, because a lifecycle probe that
has never been seen to fail is a decoration. Removing the `did-start-navigation` listener — the
pre-E3 world — leaves `surfaces=1 after 20s` while the reload still proves itself, so the failure is
unambiguously the teardown and not the navigation. Removing only the grant-revocation loop passes
`surfaces=0` and fails on the grant being **accepted**, which is what shows the two claims are
independent rather than one riding on the other. Dropping `isSameDocument` fails the first control
at the first step. Stopping the host when the last surface goes fails the survival record with
`alive counts over 3s: [0,0,0,…]`.

**Unverified**: macOS only, and the gate has been run green **twice** — once before the mutations and
once after main was restored — which is a proof of the mechanism, not a measure of how often it
flakes. It is standalone like the other two workbench gates — `node
e2e/workbench-owner-lifecycle.mjs` from `apps/desktop`, after a build — and is not wired into
`pnpm e2e`.

---

## Phase 1 · Preflight — ✅ accepted after five rounds

**What exists.** A read-only brief establishing what is true before anything was fetched for it. It
fetched no tarball and started no process: every external claim is a URL, every claim about this
repository is a `file:line`, and everything that could only be answered by fetching or running
something is named in its §9 authorisation list rather than guessed.

**Its two headline findings**, both about the world rather than gaps in the research, and both
bearing on the plan's own kill gate:

- The client and the server Phase 1 wants to pin **do not exist at the same upstream commit
  today** — `monaco-vscode-api@36.1.1` is VS Code 1.128.1, the newest VSCodium is 1.126.0.
- **VSCodium has never published `vscodium-reh-win32-arm64`**, in the current release or any of
  the last thirty.

**Five rounds of review have been applied.** The brief carries a table at the top for each, most
recent first, so a reader can see which correction superseded which.

**Round five returned two corrections and named them the last items before approval; both are in.**
Neither touches the architecture. **Both are retractions of round four**, and both are the same
defect: a detail added to make a round-four correction concrete was itself unexecutable.

1. **The 60-second probe could not test what its third step named.** Round four replaced an
   unrunnable "wait past the three-hour grace period" with a single run at
   `--reconnection-grace-time 60`, and hung a cross-project shortening assertion off it. But the
   server computes `shortGraceTime = min(300 s, graceTime)`, so at 60 the short window **equals**
   the long one: opening project B schedules a second timer that is due later than the one already
   running, the original fires first, and the run is identical to one where B was never opened.
   **The step would have gone green while exercising nothing** — the worst outcome available,
   because a pass is evidence and this one would have been evidence about the flag rather than the
   server. **The proof is now two runs.** `60` proves terminal reattachment inside the window and
   expiry after it. Shortening moves to a grace **above the 300 s clamp** and is run at
   **`--reconnection-grace-time 900`** — 360 s is the arithmetic minimum and nothing more, because
   at 360 the observation point has to land inside a 50-second window in which both failure
   directions report the same null result, where 900 widens the margins to 110 s and 480 s. It is
   run as a **no-B control** against a
   **B-connect case**, compared at one observation point: the control must still be attachable
   while the case has expired. The observation point is derived, not chosen: shortening is visible
   only when B connects within `graceTime − 300 s` of the unmount.
2. **Invalid-destination recovery was unreachable.** Round four's step 7 said a final directory
   without a valid receipt is re-extracted; its step 6 said `rename` fails on a non-empty
   destination and forbade removing it. So the one case step 7 existed for had no exit —
   re-extraction runs the whole sequence again, including a 76 MB download, and arrives back at a
   rename that fails for the same reason, against a tree nothing is permitted to move. Step 6's
   `ENOTEMPTY` handling had silently assumed the occupant was **valid**. **The brief now specifies
   atomic quarantine**: rename the invalid destination to a unique quarantine sibling, rename the
   completed temporary tree into the final path, and if either rename loses a race, restart by
   validating whatever receipt is at the final path now. **The publish path never recursively
   deletes a destination**; quarantine cleanup is a separate restartable sweep. The reason is
   precise rather than stylistic: an interrupted `rm -rf` leaves a directory that exists, is
   missing an arbitrary subset of its files, and may still carry a parseable matching receipt —
   which is exactly the state the transactional order was written to make unreachable. A rename
   cannot produce it.

**Round five's first correction also turned up a distinction the review had not reported.** The
shortening loop walks `_managementConnections` and `_extHostConnections` and **never reaches a
persistent terminal** — a terminal's short timer is armed only by an explicit client
`ReduceConnectionGraceTime` request. So "opening B shortens A's window" is established at the
**connection** layer, and whether it reaches A's **terminals** is a separate cascade question that
is still UNVERIFIED. The two windows are the same length only because the same `min()` expression
is evaluated at both layers, which makes it easy to prove one and report the other.

**And the pattern is now the most reproducible finding in the brief, which is worth recording as a
result rather than an apology.** Round three introduced two claims while fixing others; round four
introduced two more, and round five is those two. In every case the argument being repaired was
right and the **number or step written to make it concrete** was not checked against the source it
came from — round four's `60` was chosen to make expiry reachable without re-reading the clamp the
same paragraph had quoted. The mitigation that has actually worked, and that found both of these,
is to evaluate every figure and sequence a correction introduces **as a separate act** from writing
the prose around it.

**Round four found the architecture coherent and returned two corrections; both are in, and both
changed a conclusion.** One of them retracts a table round three had itself written.

1. **The connection-set lifecycle table described a lifetime nothing could implement.** It had a
   project's connection set running from project-open to project-close "whether or not a surface
   is mounted" — but those are the management and extension-host WebSockets, they are opened and
   owned by the surface's `WebContents`, and unmounting it closes them. **The brief now states
   three honest lifetimes**: a **server lease** (project open → project close, the refcounted
   one), a **live client connection set** (surface mounted → unmounted), and **server-retained
   project and terminal state**, whose survival across a disconnect is **UNVERIFIED** and must
   pass the existing terminal-remount probe. The sentence that matters: **refcounting alone cannot
   preserve the promise** — the lease keeps a process running, it does not hold a socket open — so
   if retention fails the fallback must be chosen explicitly between retaining a hidden surface,
   adding a headless client connection in main, and revising the product promise.
2. **Extraction was not transactional.** The prose promised the receipt would carry the manifest's
   hash and the example omitted the field. `manifestSha256` is added, and the order is now
   normative: verify the archive against the committed manifest **before** extraction; extract
   into a new temporary sibling directory; reject absolute paths, `..` traversal and escaping
   symlinks; patch `product.json` there; write the receipt **last**; atomically rename the
   completed directory into its final checksum-addressed location; and treat **any directory
   without a valid matching receipt as unusable**. The property this buys is stated in the brief:
   **an interrupted or malicious extraction cannot become a valid-looking runtime.** _(Round five
   adds the missing half — how an unusable directory is actually replaced. See above.)_

**Both corrections turned up a further problem the review had not reported**, which is the part
worth carrying forward. Reading the REH's own source to settle the first found that **the server
shortens a disconnected connection's grace period when a new connection arrives** — so
opening a second project degrades an already-disconnected one's retention window. That is the same
bug round
three's refcount was written to prevent, one level down in the server where the refcount cannot
reach, and it exists only because the REH is shared. **Round five bounds that sentence in two
ways**: the shortening fires **once**, not on every subsequent connection, and it is established at
the **connection** layer, whether it reaches that project's terminals being **UNVERIFIED**. The
same source reading also found round three's probe instruction
— "wait past the grace period" — **unrunnable**, the default window being three hours. And the
second correction's rename step is not unconditionally atomic: POSIX `rename` fails on a non-empty
destination, so a populated final directory has to be read as "another extraction won the race"
rather than deleted and retried. **Round five then found that both of round four's replacements
were themselves unexecutable** — the 60-second probe cannot engage the shortening, and "read a
populated destination as a won race" has no answer when the occupant is invalid.

**Round three returned seven corrections; all seven are in, and six changed a conclusion.** Two of
them close gaps that existed because the earlier rounds each stopped one step short of the thing
that mattered, and two retract claims those rounds introduced.

1. **The workbench view had a specified session and no specified preload.** Round two established
   that a `WebContentsView` inherits none of the shell's controls and specified the session.
   `preload` is chosen in the same `webPreferences` object, and nothing named it — so the natural
   implementation, reusing the window's `webPreferences` "for consistency", hands the workbench
   Chorus's entire `ChorusApi`: approvals, settings, git actions, project writes, every
   conversation and terminal channel. To the one context that runs third-party extension code by
   design. **A dedicated `apps/desktop/src/preload/workbench.ts` is now specified**, exposing a
   single `connection()`, loaded into the main frame only, with its own build entry — and the
   existing preload has to be named in that entry, because declaring it replaces electron-vite's
   default rather than extending it.
2. **"Ordinary `ipcMain`" settles who may speak, not when.** An early send has nothing to receive
   it and Electron promises no queue; a reload leaves the surface waiting forever. **Main now
   pushes after the view's own load, the preload buffers so an early delivery cannot be lost, a
   pull answers a reload, and every descriptor is bound to one project by `event.sender`** —
   never by anything the renderer says about itself. Two tests: cross-view isolation, taken in the
   adversarial direction because the friendly one passes with the bug, and reload.
3. **The rewritten atomic-version test imported a path that cannot resolve.** Round two correctly
   replaced a test reading a `config` field that does not ship with one reading the compiled
   product module — and wrote the module's path **inside the tarball** where an export-map subpath
   belongs. The published map is `"./vscode/*" → "./vscode/src/*.js"`, so the specifier doubled
   both `src` and `.js`. The same defect twice: a test against a field that does not exist,
   replaced by a test against an address that does not resolve.
4. **Provenance was being read out of the unpacked server, which does not contain it.** The REH
   build writes only `{ commit, date, version }` into the `product.json` it ships; VSCodium sets
   the commit to a sha1 of its own version string and the version to its own release number, and
   its forty-odd other product edits are branding and endpoints. **No field in the artifact names
   an upstream VS Code tag or commit.** Worse, after the handshake patch the commit is Chorus's
   own value echoed back, so the check that was supposed to catch a stale server is exactly what
   makes one look right. **The manifest is now generated from the release's own
   `upstream/stable.json`, the download is verified against its published checksum, and unpacking
   writes a Chorus-owned extraction receipt** that main reads instead of interrogating the server.
5. **The file table still said "one project, one server, no multi-project pooling"**, contradicting
   round two's own shared-REH decision. One shared server, and the refcount defined over
   **projects requiring REH state rather than visible views** — because with a four-pane cap and
   no cap on open projects, counting views reaches zero while projects are still open, and
   switching to a fifth project would kill the first one's terminals. That is the thing the plan
   promises will not happen. Whether those terminals survive an unmount **at all** is now an open
   question with a check, not an assumption. **Round four superseded the "per-project connection
   sets" this item introduced** — see round four's item 1 above; the refcount is a server lease,
   and it holds no connection.
6. **The plan still made a Linux packaging target a Phase 1 prerequisite.** Round two corrected the
   brief's own copy of that sentence and missed the plan's. Phase 1 needs a Linux machine or dev
   environment; the `linux:` electron-builder target is Phase 7's.
7. **Three wordings claimed more than the evidence.** One dedicated workbench partition, not one
   per view. Shared REH is the chosen upstream-supported, lower-marginal-cost topology — **and the
   measurement still decides**, where the previous wording made it "the only topology under which
   the gate can pass". And the first download's approval line named `<pinned>` rather than the
   release it had already settled on, which is a blank where an approval needs a subject.

**Round two returned six blockers**; all six are in. **Five of the six changed a conclusion, two
forced decisions the brief had tried to defer, and one retracts a claim round one had itself
introduced.**

1. **The surface choice was not a choice.** The brief proposed comparing a separate-origin frame
   against an Electron `WebContentsView` in Phase 1. **The frame cannot be built as described**:
   `frame-ancestors 'self'` is incoherent with a genuinely separate origin — if the origins
   differ it blocks the embed, and if they do not there is no boundary and the shell can read the
   token out of the frame — and Electron only lets a child frame receive IPC when
   `nodeIntegrationInSubFrames` is on, which "load[s] all your preloads for every iframe",
   extension webviews included. **Decision taken: `WebContentsView`.** The accepted cost is
   bounds-driven layout under the four-pane shape, which Phase 1 now measures rather than assumes.
2. **A `WebContentsView` does not get its own session**, and the brief had asserted it does.
   Absent `session`/`partition` it uses `defaultSession` — which is exactly where Chorus's CSP,
   both permission handlers and the navigation lock live today. Both possible mistakes were
   silent: default session and no workbench can run; new partition and it arrives with **no
   protections at all**. A dedicated partition is now specified with every control installed on it
   deliberately, and a test asserts it is not the default session.
3. **The atomic-version test could not have run.** It re-read `config.vscode.commit` from the
   installed package; **the published package has no `config` field at all** — verified against
   the shipped `package.json`, whose complete key set does not contain it. The identity that does
   ship is the compiled product module, which carries `commit: '987c9597…'` and `quality:
'stable'` outright, so the test is rewritten against exported identity. **And reading that
   module retracts a round-one claim**: it hardcodes `commit` and merges any override _last_, so
   omitting `productConfiguration.commit` cannot leave it undefined. Omission is the safe case;
   _setting_ it is the dangerous one. Relatedly, an upgrade touches three files, not one — the
   atomicity lives in the assertion binding them, which is a better property than the one claimed.
4. **The prototype specified one REH and one hard-coded root** while the resource proofs claimed
   to test two projects. Two surfaces on one root share watchers, language servers and workspace
   storage, so the second project would have looked nearly free for a reason that vanishes the
   moment the roots differ. **Decision taken: one REH shared by all projects**, one connection and
   one forked extension host each, two distinct roots — which is upstream's own design, read out
   of the server source, and the arrangement with the lower marginal cost per project. _(Round
   three narrowed this: it read "the only topology under which the marginal-cost gate can pass on
   its merits", which is a prediction wearing a fact's clothes. The gate still decides.)_ The cost,
   a shared extensions directory and global-storage namespace, is recorded.
5. **A threshold was gating a phase that cannot produce its evidence.** R3 bounded installed size
   at ≤ 3× the baseline, but Phase 1 deliberately bundles nothing, so there is no installed
   candidate for the ratio's numerator. **R3 moves to packaging/Phase 7**, pre-registered now and
   evaluated there. The related urgency is withdrawn too: the baseline is a published release's
   installed size, recoverable whenever, so what it needs is not haste but the build's identity
   recorded beside the number.
6. **Four threshold contradictions.** A two-project memory ceiling could not test the marginal
   claim it was written for — 1,000 + 900 and 200 + 1,700 both pass, and the second is the
   failure — so it becomes three measurements and one inequality. A process count that called
   itself "observe more than enforce" while sitting in a table of mandatory failures is now an
   observation, replaced by a process inventory by role. A memory test still named after a hazard
   the previous round withdrew is redefined across all workbench processes, because under
   `WebContentsView` a heap sampled in one renderer cannot see the others. And a Linux prerequisite
   that added packaging configuration to a phase that defers packaging now provisions a machine.

**Round one, applied earlier.** Codex returned nine corrections against the first draft; all nine
are in. **Four changed a conclusion** and are argued in place rather than edited away, because a
brief that quietly changes its mind teaches the next reader nothing:

1. **A token contradiction.** The design routed the REH connection token to the outer renderer
   and into an iframe query string, while the same brief's security section forbade exactly
   that. Replaced with a **main-owned isolated surface**: the shell holds only an opaque view ID,
   and main delivers the token into the workbench context directly. _(The "explicit Phase 1
   comparison" this left open is **superseded by round-two blocker 1** — one of the two candidates
   turned out not to be buildable, so the comparison was never real.)_
2. **A wrong hazard premise.** The global `[data-vscode]` teardown threatens sibling workbenches
   only under parent-DOM integration, which Chorus can simply prohibit. R12 is kept — it is
   binary and nearly free — but it is **no longer a failure the brief expects**, which makes a
   pass weaker evidence than the first draft implied.
3. **Wrong extension-host routing.** A browser-capable extension preferring `ui` can run in the
   web host in a web+remote topology; it is not automatically forced into the REH. The web-host
   proof class is **restored** and the expected-host table corrected.
4. **The proof set started in the wrong place.** Proprietary Claude/ChatGPT extensions were the
   first executable proof; they are now last, as a control pair. Controlled Chorus fixture
   extensions prove views and sustained webview messaging first, then ESLint is the real
   third-party REH proof. Relatedly, upstream issue #804's views defect was reported against a
   **partial** setup, so it is **not proven** against the full `WorkbenchService` Chorus plans to
   use — the upstream serverful webview defect, however, remains real and open.

The remaining five: the "exactly one match" claim scoped to the versions actually enumerated
(and a pin on `33.0.0`, **a version never published**, corrected to `33.0.9`); an execution order
replacing the pin either/or; four decisions recorded as settled rather than open; two measurement
corrections; and a duplicated passage removed.

**Decisions now settled and recorded in the plan**, so they are not re-litigated at the gate:
Microsoft's REH remains forbidden; Windows arm64 is out of the initial target on the plan's own
pre-existing condition; **Linux x64 stays in the Phase 1 architecture proof and is not deferred**;
Phase 1 may use an approved, checksum-verified cache download, with bundle-versus-runtime-download
deferred to packaging; **the workbench surface is an Electron `WebContentsView` on the one
dedicated workbench session partition, behind its own one-method preload**; and **one REH is shared
by every open project**, with a connection and a forked extension host per project and its lifetime
refcounted by open project rather than by visible view.

**Two things the corrections did not settle and one they made worse-looking on purpose.** The
`WebContentsView` decision buys the security boundary by taking on a layout problem — four
bounds-driven overlays tracking a React tab layout is a well-known source of one-frame-late
rendering — so a risk moved rather than disappeared, and it is now a proof row instead of an
assumption. The shared-REH decision buys the marginal-cost gate by accepting a shared extensions
directory and global-storage namespace across projects, which Phase 5 has to revisit. And reading
the client's compiled product module left **no version check anyone has observed firing** in this
client: the manifest equality, not the handshake, is what enforces client/server atomicity until
the negative test in the authorisation list is run.

**Round three added a fourth of that kind, and it is the one worth watching.** Defining the REH's
lifetime over projects rather than views is what keeps Chorus from killing an inactive project's
terminals — but it says nothing about whether the **server** keeps them when the surface unmounts
and its connection is reaped. The plan promises retention in two places; nothing read for the brief
establishes it, and if it turns out not to hold, "close the surface, keep the terminals" needs a
mechanism the plan does not have. It is now a Phase 1 check rather than a Phase 4 discovery.

**Round four sharpened that one and made it worse.** Reading the server's source established that
the retention mechanism exists but is **time-bounded** — persistent terminals are shut down by a
grace timer, three hours by default on the REH — and that **a new connection shortens the window
for the already-disconnected connections**. So the promise as the plan words it,
that inactive projects keep their terminals, is not what upstream offers even in the good case;
what upstream offers is a window, whose length another project's arrival can shorten — **once**,
and at the **connection** layer, whether it cascades into the terminals being **UNVERIFIED**.
Whether the processes
are genuinely re-attachable from a remounted surface is still **UNVERIFIED** and is what the probe
is for. **Refcounting cannot close this**, which round four states in the brief in those words, so
the fallback is a Phase 1 exit decision.

**Round five made that sentence precise, and the imprecision mattered.** "Shortened to five
minutes" describes a reduction; what the server does is leave the original deadline running and
schedule a **second** timer for a full `min(300 s, graceTime)` from the moment the new connection
arrives, so the effective deadline is the **earlier of the two** and a late-arriving project
changes nothing. It also fires **once** — the third project to connect while one sits disconnected
adds no further pressure. Stated as "cut to five minutes", the behaviour looks worse than it is in
one direction and better in another, and neither version tells you when a probe would see it.

**And a note on how the last three corrections were found**, because it bears on what review is
for here. Two of round three's seven fix claims the earlier rounds introduced while fixing
something else: a test rewritten against a path that does not resolve, and a provenance check
inherited unexamined through both rounds because it read as obviously true. The pattern is that a
correction is written with the attention on the thing being corrected, and its own new detail —
an import specifier, a field name — goes in unchecked. Nothing here is verified by having survived
a review.

**What was owed before Phase 1 began, and what remains.** Codex approval of the revised brief is
**in**, and Mohamad authorised the first slice — the client `pnpm add`, the build, the app launch
and the containment gate. **Every §9 item beyond that is still unasked**: the first REH download,
unpacking it, running it, and any third-party VSIX are each their own approval and none has been
given.

---

## Phase 0 · The clean baseline — ✅ Codex approved

|              |                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Worktree     | `/Users/mohamadtaleb/code/chorus-workbench`                                                                                   |
| Branch       | `revamp/project-workbench`                                                                                                    |
| Base         | `c2847c4ef35451f245bff1c83c1a445766bb2d1c` — _fix(ci): stop a Windows-only watcher test failing the job_, tip of local `main` |
| `git status` | one untracked path: `docs/plans/chorus-project-workbench-2026-08-22/`                                                         |

**What was carried over:** the approved plan, and nothing else. No source, no `STATUS.md` from
the stopped attempt, no bridge implementation, no mixed-tree fixes.

**Why a fresh tree rather than a reduction.** The previous attempt left roughly 4,900
uncommitted lines across 51 files, with useful work and wrong-architecture work interleaved.
Separating them in place would have meant judging every hunk while that tree was simultaneously
the only copy of it — which is how a reduction becomes a loss. Cutting from `main` makes the
question disappear rather than answering it fifty-one times.

**Where the previous work went.** `/Users/mohamadtaleb/code/chorus` still holds it, uncommitted,
with its plan and `STATUS.md` marked superseded. It is reference, not an implementation base,
and it receives no further mutations from this work. `/tmp/chorus-recovery/` holds a snapshot
and is a temporary snapshot: `/tmp` clears on reboot. The old worktree itself survives a reboot
perfectly well. What it cannot survive is a destructive checkout, reset or clean — and because
nothing in it is committed, **Git cannot reconstruct it afterwards**. So the accurate statement
is narrower than "volatile": **one uncommitted working tree plus one temporary snapshot is not
durable, versioned recovery.** **Making the archive durable needs a WIP commit on a
throwaway branch there, which is Mohamad's to authorize and has not been done.**

**What may come back**, each as its own independently reviewed patch against this branch and
never by copying the old diff wholesale: the Codex `turn/steer` admission chain and the
`currentTurnId` trap beneath it (the obvious implementation silently disarms Stop for the rest
of a turn); the Claude turn-accounting fix, where several SDK results produced one `turn.started`
and several `turn.completed` and drove a signed balance negative; the provider-neutral ambient
contract, whose delivery path was proven live at gate G2 on both hook boundaries; the exclusion
matcher; the fail-closed settings path with content-addressed preservation; and the markdown
delimiter helpers.

**What does not come back at all:** descriptor discovery, protocol version negotiation, the
bundled VSIX and its installer, the external `setFollowing` channel, and every renderer surface
naming an external editor. Those existed only because VS Code was a separate process the user
had installed themselves.

---

## Corrections applied to the plan in Phase 0

Seven record defects, all found in Codex review rather than by the author. (Phase 1's own nine
corrections are listed under its section above.)

1. Status table renamed Phase 0 and marked it in review rather than not started.
2. The Phase 0 verification row described a reduced tree and adapter tests that do not exist;
   its proof is branch, base SHA, worktree status and archive inventory.
3. §5.1 said Phase 0 "separates" the reusable candidates; it does not — each returns later as its
   own reviewed patch.
4. **Three archive claims were overstated and are now accurate.** A git stash is
   repository-level, not the old worktree's, so `stash@{0}` is visible from here too and belongs
   to an unrelated branch. `/tmp` is a temporary snapshot rather than a backup — and the sharper
   point, which "volatile" obscured, is that the old worktree survives a reboot but can be erased
   by a destructive checkout, reset or clean, after which Git cannot reconstruct it because it
   has no commit. An ordinary checkout would refuse rather than destroy, so the earlier wording
   named the wrong hazard as well as overstating it. And "byte-for-byte unchanged"
   was unearned — nothing verifies it and nothing can promise it, so the commitment is
   forward-looking instead: no further mutations after the cutover.
5. §10 said implementation begins with reconciliation; it begins with Phase 1.
6. This file, which the project requires and which did not exist.
7. Governance recorded in §9, including routing: technical handoffs go directly to Codex in the
   shared conversation, which is Mohamad's coordination surface rather than a bypass of it. The
   earlier draft left this open as a conflict; it is settled.

---

## Next

**This section was the stale one, and the correction belongs at the top of it.** It used to open
_"The REH stage — preflight §2.5 step 2 — and it needs Mohamad's authorisation before an artifact is
fetched"_, and went on to say that what remained unanswered was "everything that needs a server".
That was true when it was written and stopped being true the moment the authorisation was given. It
then stayed there through the artifact being downloaded, verified, unpacked and spawned, through
three defects in its own gate, and through that gate being thrown away and rebuilt — so a reader who
scrolled to the bottom of this file, which is where a reader goes to find out what happens next, was
told the phase was waiting on a permission it had already spent. **This is the same failure the
sixth, seventh and eighth rounds each corrected somewhere else**, arriving finally at the one section
whose only job is to be current.

**All three of preflight §2.5's steps are done.** Step 1, serverless containment on `36.1.1` —
11/11. Step 2, the matched pair `33.0.9` + VSCodium `1.121.03429` with a live REH — real files off
the disk, two distinct roots, and different bytes under one filename in two surfaces. Step 3, the
coexistence proof re-run on that pair, rebuilt to drive through commands and observable state after
Codex refused the clicked rectangles, at **24/24 on two runs proved independent by run id, pid and
port**. Nothing below is waiting on an authorisation, and the question the phase existed to ask is
answered: **Mohamad settled it on 2026-08-23 — `monaco-vscode-api` + the VSCodium REH, fork pivot
cancelled.**

### The person's gate is passed, so what is next is the queue behind it

**The user UI review gate is met** — Mohamad drove it on 2026-08-24 and reported no issues, settings
persistence included. Its own section above records what that does and does not license, and the
short version is that it is a pass with no step-level detail behind it. **C-059 is therefore next by
the board's own scheduling**: it was filed as "the first stabilization fix **after the UI review**",
and the review has now happened. It was not exercised during it — persisting a setting across a quit
never touches the dirty state — so the gate's observation is what still stands.

**Then C-058**, because it is the sharper of the two. A reaper that passes its unit tests and misses a
real orphan in ordinary use means C-055's recovery — the thing E4 was closed on the strength of — is
weaker than this file says. Its "done means" is explicit that reproducing the miss against a **real**
orphan comes before any fix, since every existing test drives a synthetic `ps` listing.

**C-059's first diagnostic attempt ran on 2026-08-24 and did not settle it — recorded here because the
attempt looked conclusive and was not.** The instrument is sound and worth keeping: `Developer: Log
Working Copies` prints `● ` before a dirty working copy (`developerActions.js:377`), so one line
separates _not registered_ from _registered and clean_ from _registered and dirty_. The hand-driven run
returned the file registered, no `●`, `[Backups] <none>` — which reads as a settled answer until the
file's mtime is checked and turns out to be **twenty-five seconds after the snapshot**. The content
reached disk, so that session never held an unsaved edit at the moment it was measured, and the reading
that fits it is the dull one rather than the defect. **The gate's original observation still stands
unexplained** — disk unchanged across twenty samples in eight seconds with auto-save off — and it is
still the only evidence C-059 rests on. The next attempt has to hold auto-save off, the mtime, the
edit, the log and the mtime again inside one session; `BOARD.md` C-059 carries the procedure.

**Three findings came out of that session that are nothing to do with C-059**, and all three are now on
the board with their source-side confirmation rather than just a log line. **C-062 — Git does not
work**: `SCMService.registerSCMProvider is not supported`, and `services.ts` has no `scm` override at
all, so the built-in Git extension loads and cannot register. Named in the plan's acceptance criterion,
not a Phase 1 blocker. **C-061 — no worker is configured**: no `MonacoEnvironment` anywhere in the
workbench renderer, so every worker-backed service throws; what a person notices is dead Output-panel
links, but the gap is global. **C-060 — 23.5 s latency on a loopback connection**, with the remote
extension host going unresponsive twice inside a minute. There is no network, so that number is a stall
inside Chorus's own machinery. **C-060 and C-061 are the two most interesting leads C-054 has ever
had, and neither may be written up as its cause** — nobody has yet observed either one in the same
session as a blank editor.

**And the settings-persistence gate has been edited since its pass was recorded above.**
`e2e/workbench-settings-persistence.mjs` gained a working-copies diagnostic on 2026-08-24 at 11:11,
after the three-phase pass was reported. **The recorded pass therefore describes a file that no longer
exists**, which is the failure this document has corrected in four separate places already. Either
re-run it and record the new result, or say plainly that the pass belongs to the pre-diagnostic
version.

### What Phase 1 still has not proved, and none of it is authorised yet

**No terminal, no debug session, no extension activation, no VSIX, no Open VSX, no Git through the
workbench.** No Windows and no Linux. **R7/R11 are still owed as numbers** — the shared-REH topology
is chosen on architecture and licence with the memory figures and the process inventory unmeasured.
**A6, the deliberate client/server mismatch negative test, has not been run**, so no version check has
been observed _refusing_ anything; what has been observed is a correct pairing connecting. The §5.4
retention and grace-shortening probes have not been run.

### What is open against it

| Item      | What it is                                                                  | Where it sits                                          |
| --------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| **C-054** | A file can open to a blank editor — 3 reproductions in 10 runs, undiagnosed | **Critical tracked release defect**, not a phase gate  |
| **C-059** | An unsaved change is invisible and `File: Revert File` does nothing         | First stabilization fix after the UI review            |
| **C-058** | The startup reaper missed a real orphan, in ordinary use                    | Weakens the recovery E4 was closed on                  |
| **C-056** | A quick-open picker never focused its row, in a hidden surface              | Split out of C-054; one sighting                       |
| **C-055** | A forced quit truncates shutdown; the next launch's reaper is the recovery  | Documented boundary — and C-058 is about that recovery |

**C-054 is the one to keep in proportion.** It is live, unexplained, and running at roughly two
sightings in eleven single-surface sessions; it is **not** an architecture gate and does not block
building the rest of the product. It also may not be presented as fixed.

### The record debt this file owes

**E5 is built and this file does not say so.** `main/workbench-user-settings.ts` and
`e2e/workbench-settings-persistence.mjs` are in the working tree — a Chorus-owned `User/settings.json`
under `userData`, with the partition deliberately left in-memory rather than flipped to `persist:` —
and the exit-items section above still lists E5 as the only open one. **What that gate returned is
written down nowhere in this file**, so E5 is implemented rather than proved until it is. C-059 came
out of running it.

**The header of this file contradicts its own slice-3 correction.** The opening block says slice 2
"has NOT yet been reviewed by Mohamad"; the correction seventy lines below it says he drove it by
hand, two repositories in two surfaces. One of the two is wrong, and a reader should not have to pick.

**And `BOARD.md` is now the fresher document** — C-058 and C-059 were filed after this file was last
written. A status that has to be reconciled against the board is the thing this file exists to
prevent.

### Nothing is committed

**Forty paths are uncommitted and the branch is level with `origin/main`** — `revamp/project-workbench`
is 0 commits ahead, so every slice above lives in the working tree only, this plan directory included.
That is deliberate under the phase's own authorisations, and it is also the whole of Phase 1 sitting
on one machine's disk.

Phase 1 can fail; that is what it is for. If it does, the plan returns with evidence and a new
architecture decision rather than quietly falling back to Theia or a fork — and the archived
worktree is the fallback that failure would need, which is the reason nothing there was deleted.

**And the preflight twice moved where failure was likeliest to come from**, which is worth keeping
now that three of the six have been answered. The first draft expected the workbench frames to break
each other on teardown; corrected, that mechanism does not apply to the mode Chorus uses. Round two
then removed the frame itself: with each workbench in its own `WebContents` and its own process, the
shared-realm family of failures is designed out entirely.

**Three of the six are answered, and saying which is the point of keeping the list.**

- **Two of these workbenches alive at once** — nobody had publicly demonstrated it, the library's own
  demo reinitialises one, and the upstream sustained-webview defect was open with no fix in sight.
  **Answered**: two surfaces on two distinct roots, one destroyed, the other still rendering, typing
  and running commands — 11/11 serverless, then 24/24 twice with a live REH.
- **Four bounds-driven overlays kept in step with the shell's layout** — **answered for tracking**, by
  measuring the rectangle every frame rather than subscribing to the causes of its changing (E1). The
  residue is a unit conversion and not a tracking failure: bounds are read in CSS pixels and sent as
  device-independent pixels, so `⌘+`/`⌘−` still mispositions the view.
- **One REH serving two roots isolating them well enough**, when its extensions directory and global
  storage are per-server — **partly answered**. Two roots were listed, read and edited independently
  through one server. The workspace-storage isolation assertion and R7's numbers were never taken, and
  no extension has activated, so the half of the question that is about extensions is untouched.

**Three remain, and all three are about a server nobody has finished interrogating.**

- **Whether an inactive project's REH-side terminals survive its surface being unmounted** — the plan
  promises it twice and nothing establishes it. No terminal has been opened at all.
- **Whether one project's grace window shortens when another connects** — the server shortens a
  disconnected connection's grace once a new one arrives, so two projects are coupled through a timer
  Chorus does not own. Round five put this on a run of its own at `--reconnection-grace-time 900`,
  above the 300 s clamp, carrying a no-B control; that run has not happened.
- **Whether that shortening cascades into persistent terminals** — the loop walks management and
  extension-host connections and never touches a `PersistentTerminalProcess`, so the cascade is a
  separate step and still **UNVERIFIED**. It is what the terminal assertion in the B case exists to
  answer.

**Those three, plus C-054, are where the phase is still most likely to disappoint** — and C-054 is the
different kind, because it is not a question one more probe can answer.
