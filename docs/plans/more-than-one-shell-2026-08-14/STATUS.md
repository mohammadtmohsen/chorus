# Status

| Phase                           | State       |
| ------------------------------- | ----------- |
| 0 — Make terminal state persist | **shipped** |
| 1 — The id, shipped inert       | **shipped** |
| 2 — The roster, still one tab   | **shipped** |
| 3 — The strip, and `+`          | **shipped** |
| 4 — Kill                        | **shipped** |
| 5 — Specs                       | not started |

---

## Phase 0 — shipped

Terminal panels now persist on their own, rather than whenever something else
happened to write the layout.

### What was wrong

`App`'s debounced persistence subscription compared a hand-written list of six
fields. `terminals` and `globalTerminal` were added to `workspaceSnapshot` in the
original plan's Phase 4 and never added to that list, so a change to either
compared **equal**, the listener never fired, and nothing reached disk.

The `equalityFn` has not been touched since `67a8522` — the commit that
introduced the sidenav and tabs, months before terminals existed. It was never
wrong when it was written; it stopped being right when the snapshot grew.

### Why nobody noticed, and why the existing probe did not catch it

This is the part worth keeping.

`build/terminal-persist-probe.mjs` was written for the original Phase 4 and
reported six green checks, including "at the height it was dragged to". It
passed with the bug fully present, because of what it does in between: it opens
the session panel, then opens **and drags the global one**, and the global
panel's height handler calls `props.onCommitLayout()` (`Workspace.tsx:380`),
which writes the **entire** snapshot through a different path. The session panel
it had opened a moment earlier was persisted as a side effect of that commit.

So the probe proved that terminal state can reach disk, and never touched the
mechanism that was supposed to put it there. It is C-027 in a different costume:
the assertion was real, the route to it was not the one under test.

Only one terminal action ever persisted on its own — a global height drag, via
that bypass. Opening or closing either panel, and resizing a **session** panel,
did not. `Session.tsx:1260` carries a comment reasoning carefully about why the
session panel does not need the `commitLayout` bypass, and it is describing a
debounce that never ran.

### The fix

`sameWorkspaceSnapshot` in `store.ts`, reading its keys off
`WorkspaceSnapshot.shape` rather than listing them. Derived, so the next field
added to the snapshot is compared without anyone remembering this exists — the
failure mode being fixed is precisely "someone added a field and did not
remember".

`hydrated` stays compared explicitly in `App.tsx`, because it is not part of the
snapshot: it is the guard that stops hydration echoing straight back to disk.

### Proved both ways

**Unit** — `store.test.ts` gained four cases. Three are ordinary; the fourth is
the one that holds the line, walking every key of the schema and asserting a
change to it is seen, with a distinct sentinel per key so it cannot pass by two
fields coinciding. Reinstating the old six-field list turns three of them red:

```
AssertionError: terminals is not compared, so a change to it would never be persisted
```

**Driven** — `build/session-terminal-persist-probe.mjs`, new, deliberately
touching the session terminal and **nothing else**: no pane drag, no sidebar
resize, no reorder, no global panel — nothing with its own write path.

| build                | result                                                        |
| -------------------- | ------------------------------------------------------------- |
| as shipped in 0.14.0 | `✗ the session panel is open again` · `✗ … 0px, wanted 332px` |
| with the fix         | `all 5 passed` — restored at 332px                            |

That is the plan's Phase 0 exit criterion, run against a real launch, quit and
relaunch on the same user data.

### Repaired on the way past

`build/terminal-persist-probe.mjs` had been dead since
`readable-control-rail-2026-08-13` replaced the activity bar with the QuickRail:
it looked for `.activity-bar button` and threw `Cannot read properties of
undefined (reading 'click')` rather than reporting anything. One selector,
now `[data-rail-terminal]`. It passes 6/6 with the fix, which is what confirms
the global panel's path still works.

### Files

- `apps/desktop/src/renderer/src/workspace/store.ts` — `sameWorkspaceSnapshot`,
  `SNAPSHOT_KEYS`, and `WorkspaceSnapshot` imported as a value
- `apps/desktop/src/renderer/src/App.tsx` — the `equalityFn`
- `apps/desktop/src/renderer/src/workspace/store.test.ts` — four cases
- `apps/desktop/build/session-terminal-persist-probe.mjs` — new
- `apps/desktop/build/terminal-persist-probe.mjs` — stale selector

### Not verified

- **Nothing else that persists was re-driven.** The comparison went from six
  fields to seven, so sidebar width, pane layout and focus are now compared by
  the same derived walk rather than by hand. `pnpm check` is green and the two
  probes pass, but no one drove a sidebar resize or a pane split specifically.
- **The e2e suite was not run.** ~5 minutes, 6-in-10 clean (C-029), and this
  change is covered by the two probes above.
- **Whether anything else writes more often now.** A terminal change that
  previously wrote nothing now schedules a 180ms-debounced write. That is the
  point, and it is one small JSON file, but no one measured it.

---

## Phase 1 — shipped

`TerminalRef` carries an `id`, `TerminalService` holds several shells per scope,
and the renderer routes on the whole tuple. Nothing on screen changed: both call
sites mint the constant id `'primary'`, so the app runs exactly one terminal per
session and one global, as before.

### What landed

- **The union gains `id`** — `(scope, conversationId, id)` for a session,
  `(scope, id)` for a global one — in `terminal.ts` and `TerminalRefShape`.
- **Storage gains a level**: `globals: Map<id, Session>` and
  `bySession: Map<conversationId, Map<id, Session>>`. `disposeSession` walks one
  conversation's inner map, which structurally cannot contain a global shell.
- **`terminalKey` deleted.** Exported, called by nothing, and the exact
  string-flattening §4.0 of the original plan argued against.
- **`exitCode` kept in main** and returned from both `attach` and `describe`.
- **`sameTerminal` compares the whole tuple**, and `TerminalView` takes `id` into
  its ref, its dependency array and a `key` from the panel.

### The claim that was wrong, and how it was caught

A comment said the ids had to be copied before `disposeSession`'s loop because
deleting from a Map during iteration **skips entries**. That is false — a Map
iterator visits every key even as each is deleted, which is what makes it
different from an Array. Checked with six lines of `node -e` rather than
reasoned about, and both the comment and the test comment that repeated it were
rewritten to say what is actually true. The copy stays, for the honest reason:
`forget` mutates two levels, and a loop whose safety depends on which one the
iterator is pointing at is one refactor from being quietly wrong.

### The bug the probe found, which unit tests could not

`build/terminal-siblings-probe.mjs` crashed with:

```
Invalid response on "terminal:describe": expected "string" at ["foreground"]
```

**`describe()` throws across IPC for any terminal that has exited and not been
disposed** — precisely the state Phase 4's "an exited tab stays" puts every dead
tab into. node-pty's getter is asymmetric and only the branch macOS runs is
missing its guard (`lib/unixTerminal.js:236`):

```js
if (process.platform === 'darwin') {
  const title = pty.process(this._fd)
  return title !== 'kernel_task' ? title : this._file // no fallback
}
return pty.process(this._fd, this._pty) || this._file // guarded everywhere else
```

With no fd left to read a title from, a dead shell answers `undefined` through a
`readonly process: string`. This is the Adapters rule one layer down — the
`.d.ts` is wrong about the binary — and it could not have been found against the
fake PTY, because the fake honours the declared type.

Fixed at the `nodePty` adapter, the one file that knows which driver we use, with
a cast that **widens to what it really returns** rather than an eslint
suppression: `no-unnecessary-condition` was correctly calling `?? ''` dead code
while reading the same wrong declaration. `describe()` falls back to the shell's
own name so the field is never empty, and `running: false` carries the truth.

### Verified

`pnpm check` could not be run clean — see below — so each part was run directly.

- **Unit**, 1624 passing. New: two `terminal-stream` cases for a sibling's `data`
  and `exit` within one conversation (the `exit` separately, because it returns
  before the sequence check and would fail differently); a case that two
  conversations minting the **same** id are still distinct, which is not
  hypothetical — Phase 1 mints `'primary'` for every session; seven
  `terminal.test.ts` cases for per-id shells, routing, disposal and `exitCode`;
  and one for a dead shell still naming a string.
- **Driven**, five probes against a real Electron main process:

  | probe                            | result        |
  | -------------------------------- | ------------- |
  | `terminal-siblings-probe` (new)  | all 8 passed  |
  | `terminal-ipc-probe`             | all 12 passed |
  | `terminal-clear-probe`           | all 4 passed  |
  | `terminal-survival-probe`        | all 4 passed  |
  | `session-terminal-persist-probe` | all 5 passed  |

The siblings probe is the one worth keeping. Phase 1 is inert by design, so
nothing on screen can open a second terminal — it drives the IPC surface
directly and asks for two global shells by id. `epochs 1 and 1` is the line that
proves it: two genuinely separate sessions, each at its own first attachment,
where a lookup ignoring `id` would have returned `1` then `2`. It also covers the
§5.1 case end to end — detach, let the shell die with nobody listening, and read
`exitCode 7` back from both `describe` and the reopening `attach`.

### Files

`terminal.ts`, `terminal.test.ts`, `shared/ipc.ts`, `shared/ipc.test.ts`,
`terminal-stream.ts`, `terminal-stream.test.ts`, `TerminalView.tsx`,
`TerminalPanel.tsx`, `Session.tsx`, `workspace/Workspace.tsx`, and the four
existing probes in `build/` whose refs needed an id.

### Not verified

- **`pnpm check` is red, for reasons that are not this phase's.** Someone is
  mid-edit on a session settings panel — `SessionSettings.tsx` (new, untracked),
  `SessionMenu.tsx`, `SessionPreview.tsx` — and it does not typecheck yet.
  Isolated by stashing those two files: typecheck then passes with no output, so
  every error belongs to that work. Lint and format are clean across every file
  this phase touched, and the full suite passes.
- **No sibling was driven through the UI**, because there is no second tab to
  open until Phase 3. The routing fix is covered by unit tests and the sibling
  shells by the probe, but "click tab 2, see tab 2's shell" is Phase 3's to
  prove.
- **The e2e suite was not run.** ~5 minutes, 6-in-10 clean (C-029).
- **Windows.** The node-pty asymmetry above is a darwin-only branch; the guarded
  path everywhere else means the fix is harmless there, but nothing was run.

---

## Phase 2 — shipped

`TerminalPanelState` carries a roster, one function repairs it, and both call
sites render the shell that `activeId` names. Still one tab per panel and no
strip on screen — but the roster is now load-bearing, which is the point of
doing it before the strip rather than with it.

### What landed

- **Schema**: `TerminalTab` (`{ id }`, an object, because changing an array's
  element type later is the migration that is not cheap), plus `tabs` and
  `activeId` on `TerminalPanelState`. **Both defaulted.**
- **`normalizeTerminalPanel`** in `layout.ts` — the one place the invariant is
  made true: an open panel has ≥1 tab, ids are non-empty and unique, `activeId`
  names one of them, height is clamped. A **closed** panel keeps its roster and
  is not given one, because hiding a panel does not kill its shells.
- **`normalizeWorkspace` runs it over every panel**, both scopes. It used to
  carry `terminals` through untouched while still clamping the global panel's
  height, which already half-contradicted its own comment; session panel heights
  are now clamped too, which they were not before.
- **Store actions** — `addGlobalTerminal` / `addSessionTerminal`,
  `removeGlobalTerminalTab` / `removeSessionTerminalTab`,
  `activateGlobalTerminal` / `activateSessionTerminal` — all routed through
  `editGlobal` / `editSession`, which apply the normalizer on every write. So
  "opening a panel mints its first terminal" is not a rule anyone has to
  remember: `toggleSessionTerminal` flips `open` and the normalizer supplies the
  tab.
- **The constants are gone.** `Session.tsx` and `Workspace.tsx` build their ref
  from `activeId`. `GLOBAL_TERMINAL` was a module constant to keep
  `TerminalView`'s effect from tearing down; that reason expired in Phase 1 when
  the effect started depending on the ref's _parts_ rather than the object.

### Naming, and why `removeTerminalTab` rather than `killTerminal`

The store cannot kill anything — the PTY is in main. A `killTerminal` here would
read at the call site as though it had done the killing, which is the same
confusion `detach`-versus-`dispose` cost a section of the original plan. Phase 4
awaits `terminal:kill` and _then_ calls this.

Removing the last tab closes the panel rather than leaving it open and empty —
and that is load-bearing rather than cosmetic, because `normalizeTerminalPanel`
would otherwise mint a replacement and killing the last terminal would silently
open a new one.

### One thing collapsed on the way past

`CLOSED_PANEL` existed three times — `workspace-layout.ts`, `store.ts`,
`hooks.ts` — and the roster had to be added to all three. Now one exported
`CLOSED_TERMINAL_PANEL` beside the schema it mirrors, frozen, because it is
handed out as the fallback for every conversation with no panel and a stray
write would give all of them the same object.

### Proved both ways, and the trap fires

**The schema guard.** Making `tabs` required turns three `open-sessions.test.ts`
cases red, and the headline one fails exactly as the warning in the file says it
will:

```
AssertionError: expected [] to have a length of 1 but got +0
```

That is not a missing panel. That is **every open conversation gone**, from one
field losing its `.default()`.

**Unit**, 1640 passing. Split across the two functions that actually do the work,
because the previous revision of the plan asked one test to prove both and
`parseOpenSessions` applies schema defaults only — it never backfills:

| where                   | proves                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-sessions.test.ts` | a 0.14.0 envelope parses, keeps its sessions and its heights, defaults to `tabs: []`; a duplicated/blank/dangling roster **parses rather than being refused** |
| `layout.test.ts`        | backfill, dedupe, blank-id drop, dangling `activeId`, closed panel left alone, height clamp, and `newTerminalId` not repeating over 500 draws                 |

**Driven** — `build/roster-migration-probe.mjs`, new, writes an
`open-sessions.json` in the shape 0.14.0 wrote (no `tabs`, no `activeId`
anywhere) and launches against it:

| build           | result                                                |
| --------------- | ----------------------------------------------------- |
| `tabs` required | `never became true: the global panel reopened`        |
| as shipped      | `all 4 passed` — open at its stored 288px, live shell |

The live-shell check is the one that ties the halves together: the backfilled tab
is what `TerminalView` attached with, so an empty roster would render against
`id: ''` and never produce output.

The four earlier probes still pass unchanged — siblings 8, ipc 12, global persist
6, session persist 5.

### A probe assertion that was wrong

The migration probe first measured the sidebar's width to prove the envelope had
parsed. `readable-control-rail-2026-08-13` deleted the drawer, so the selector
matched nothing and reported `0px` **whether or not the parse worked** — a check
that could only fail. Replaced with the panel's own height: `EMPTY_WORKSPACE`
opens the global panel closed, so a panel open at 288 rather than the 212 default
says both that the envelope parsed and that its stored fields came through.

### Files

`shared/workspace-layout.ts`, `workspace/layout.ts`, `workspace/store.ts`,
`workspace/hooks.ts`, `Session.tsx`, `workspace/Workspace.tsx`, and the tests in
`open-sessions.test.ts`, `layout.test.ts`, `store.test.ts`.

### Not verified

- **Nothing exercises a second tab**, because nothing can add one from the UI
  until Phase 3. The store actions that append and remove are covered by their
  own reducers' tests and by `normalizeTerminalPanel`, but no roster with two
  entries has been through a real launch.
- ~~**The roster is not readable from the probe.**~~ **Closed in Phase 3**, which
  puts `data-terminal-id` on the panel. `roster-migration-probe` now asserts the
  backfilled tab has a real id and that there is exactly one of it.
- **`crypto.randomUUID` is assumed available in the packaged renderer.** It works
  in this build — the migration probe's backfilled tab produced a live shell,
  which it could not have with a throwing id generator — but that is one build on
  one platform, not a statement about `file://` secure-context rules generally.
- **The e2e suite was not run.** ~5 minutes, 6-in-10 clean (C-029).

---

## Phase 3 — shipped

Two shells in one panel, a strip to switch between them, and the first one still
running when you come back. This is the phase the feature was asked for.

### What landed

- **The tab strip**, in the panel header, shared by both scopes — and **only
  drawn above one tab**. VS Code hides its list in the same case, and it means a
  single-terminal panel looks exactly as it did before the roster existed, which
  is what most panels are.
- **`+`**, always visible, and **`⌃⇧\``** doing the same from the keyboard.
- **Only the active tab mounts.** `TerminalPanel` renders one `TerminalView`,
  keyed by `activeId`, so switching tabs is a genuine remount restoring from the
  headless mirror in main.
- **Exit status keyed by terminal id.** It was one `number | null` for the whole
  panel, which with a roster would show the dead shell's code above its live
  neighbour and never clear.
- **`TerminalView` reports an exit it learns from `attach`**, not just from the
  push — the only way a tab whose shell died in the background ever finds out,
  since `exit` fires once and background tabs are not mounted.
- **`data-terminal-id`** on the panel and on each tab. See below.

### The chord, and the two things about it

`event.code === 'Backquote'`, because **with Shift held, `key` is `~`**. Every
other chord in `Workspace.tsx` reads `event.key.toLowerCase()`, which is right
for a letter and would have produced a shortcut that silently never fires.

`event.repeat` is rejected. No other chord in that handler creates a _process_,
so none of them needs the guard; holding this one would otherwise spawn shells at
the OS key-repeat rate. Driven: twelve repeats add nothing.

xterm gets a matching arm in `attachCustomKeyEventHandler`, because this is the
chord you press _while standing in a terminal_ — without it, the one place you
most want another terminal is the one place it reaches `zsh` instead.

### The probe was wrong twice, and both were mine

Worth recording in full, because both failures looked like product bugs and
neither was.

**A missing virtual key code.** `Input.dispatchKeyEvent` without
`windowsVirtualKeyCode`/`nativeVirtualKeyCode` never delivers Enter. The typed
text sat at the prompt, unrun. `terminal-clear-probe` sets these; this did not.

**An assertion that could not fail.** The probe typed `echo FIRST_SHELL_MARK` and
then waited for `FIRST_SHELL_MARK` — which is on screen the moment the PTY echoes
the characters back, Enter or no Enter. So it reported a green `echo` against a
command that had never executed, and went on doing so for three runs. Markers are
now assembled by the shell (`echo NAME_$((1+1))` types one thing and prints
another), so the echo cannot satisfy the check.

The visible symptom of the pair was a probe that failed _intermittently and in
different places each run_, which read exactly like a flaky feature. It was a
driver that had never worked. This repo's own rule — suspect the driver before
the code — was the thing that found it.

### Two stale probes, and the affordance that fixed them

`terminal-clear-probe` and `terminal-survival-probe` hardcoded `id: 'primary'`,
the constant Phase 1 minted. They passed all through Phase 1 and **broke in
Phase 3's sweep** because Phase 2 replaced it with a real id — `describe()`
answered `null` for a shell that was plainly running.

Rather than teach each probe to guess, `TerminalPanel` now carries
`data-terminal-id`, the same shape as `data-workspace-pane`. One attribute is
cheaper than exposing a store handle, and it closed Phase 2's own "the roster is
not readable from the probe" gap on the way past. `terminal-survival-probe` has
to read it _before_ hiding the panel, since it asks `describe` precisely when
there is no panel on screen.

### Verified

`pnpm check` green, 1651 unit tests — eleven new store cases covering the roster
actions end to end through the store, so the normalizer integration is exercised
rather than the reducers in isolation.

**Driven**, `build/terminal-strip-probe.mjs`, new, **all 12 passed** on three
consecutive runs:

```
✓ one terminal shows no strip                    ✓ twelve repeats add nothing — 2 → 2
✓ the first shell runs a command                 ✓ switching back restores the first shell’s scrollback
✓ the chord adds a terminal, matched on event.code   ✓ and it is its own scrollback, not its neighbour’s
✓ the new tab is a different shell               ✓ and the first shell is still running, not a snapshot
✓ hiding the panel keeps its roster              ✓ and reopens on the terminal you were looking at
✓ the exit marks the tab that died, not its neighbour — tab 2
✓ a dead shell still says so after the panel is reopened — from attach, not the push
```

Every check is written against the **shell**, not the tab count — a tab is a
button, and two buttons prove the store changed and nothing about whether either
addresses a live process.

The whole suite of probes, after the changes: strip 12, siblings 8, ipc 12, clear
4, survival 4, session-persist 5, global-persist 6, roster-migration 6.

### Review remediation

Five things came back from review; all five were real and all are fixed.

**The chord fired behind modal sheets — and it spawns a process.** `useDialog`
traps Tab and claims Escape; every other key still reaches the document handler.
Most chords there rearrange panes, which is only surprising behind an overlay —
this one started a **shell** in whichever session was last focused, out of sight,
with nothing on screen to say so. Guarded on `.sheet-backdrop`, before
`preventDefault` so a sheet that later wants the chord can still have it.

`⌘J` has the same shape and the same gap, and is **not** changed here: it is
pre-existing behaviour and toggling a panel is a product decision rather than a
bug. Flagged rather than fixed.

**Exit state was a plain object, so `constructor` read back truthy.** Ids are
`z.string()` and ride through a file a person can edit, and
`normalizeTerminalPanel` deliberately _keeps_ an id like `constructor` or
`__proto__` — rejecting one would cost every open conversation. So
`exited[tab.id]` found `Object.prototype`'s member before the shell had done
anything, and drew a live terminal as dead. Now a `Map`, which has no inherited
keys to find. A `layout.test.ts` case records that such an id really is reachable,
so the reason survives the fix.

**The tablist was incomplete**: every tab in the sequential order, no arrow keys,
no tab-to-panel relationship. `PaneTabStrip` already had the right pattern, so it
is copied rather than reinvented — roving `tabIndex`, Arrow/Home/End, and the
surface becomes a `tabpanel` with `aria-labelledby` **only while a strip is
drawn**. With one terminal it stays the plain labelled group it was.

**The active tab could sit off-screen**, which matters precisely because Q1 sets
no cap. Same three-line `scrollIntoView` effect as the pane strip.

**Two hardcoded strings**, one pre-existing and one I added beside it. Both now in
`en.json`. `t` is held in a ref rather than the dependency array: it changes
identity on a language change, and depending on it would tear down a PTY
attachment to redraw two lines of text.

### Driven after the fixes

`terminal-strip-probe` now **all 19 passed**, including the criterion the earlier
version missed:

```
✓ a background shell dying is not noticed while you are elsewhere
✓ and is marked exited the moment its tab is selected — attach carried the code
✓ and only the two that actually died are marked — 2 of 3
✓ the chord does nothing behind a sheet, rather than spawning a hidden shell — 3 → 3
✓ and works again the moment the sheet closes — a guard, not a break
✓ exactly one tab is in the Tab order, the rest are reachable by arrow — -1, -1, 0
✓ the selected tab and the surface it controls point at each other — tabpanel …
```

The background-exit case was the real gap: every earlier check killed the
terminal that was **on screen**, so the live push did the work and `attach`'s
`exitCode` — the whole reason main keeps it — was never the thing under test. Now
a third shell is told to die on a timer and the probe switches away before it
does.

### Not verified

- ~~**Kill is not wired.**~~ **Phase 4.**
- **No tab-count cap and no cycling chord**, both deliberate (Q1, Q2).
- **Tab labels are positional.** "Terminal 1", not the foreground process name —
  that would need a push channel, and is a stated non-goal.
- **The strip has not been driven at width.** Six tabs scroll horizontally by
  CSS; nobody has looked at it with more than two.
- **The e2e suite was not run.** ~5 minutes, 6-in-10 clean (C-029).

---

## Phase 4 — shipped

A terminal can be killed, and the panel finally tells Kill and Hide apart.

### What landed

- **`terminal:kill`**, a channel of its own carrying a ref and **no epoch**.
  `disposeIfCurrent` keeps its guard for the mounted view that is its only
  caller; a tab strip is a different actor and a background tab has no
  attachment to quote an epoch from. Weakening `dispose` would have taken the
  guard off every caller to serve this one.
- **A `×` per tab**, hidden until the tab is hovered, focused or selected — so
  the mark you can hit by accident is almost always the harmless one.
- **`describe()` finally has a caller.** Wired from `TerminalService` to
  `window.chorus` since the original plan's Phase 1 and called by nothing, it was
  built to answer exactly this and needed a kill button to have a use.
- **`ConfirmKillTerminal`**, shaped after `ConfirmSessionAction` down to Cancel
  being first in the DOM so a reflex on Enter is not the destructive one. It
  names the process, because "`sleep` is still running in it" is the sentence
  that decides the answer and "Are you sure?" is not information.
- **Kill, then forget.** The panel awaits `terminal:kill` and only then calls
  `removeTerminalTab`. Removing the row first would orphan a live shell behind a
  row nothing can reach on any failure.

### The gap the probe found, which review had not

Driving it killed terminals one at a time and then **ran out of things to
click**: with a single terminal there is no strip, so there is no per-tab `×`,
so a panel with one shell had no way to end it at all. Its only control was
Hide — which is precisely the complaint this whole plan opens with, surviving
into the phase meant to fix it.

The plan's own text says "closing the last tab hides the panel", so that action
has to be reachable. It now is: a kill control in the panel header, always
present, acting on the terminal you are looking at. A distinct glyph rather than
a second `×`, since two identical marks in one 38px header — one ending a
process, one hiding a panel — is the confusion this phase exists to remove.

Nothing in the unit tests could have caught this. It is a question about what is
on screen when, and only driving it asks that.

### The driver was wrong again, in a new way

Two runs failed at _different_ steps, which reads like a flaky feature and was
not. A shell spawned a moment earlier has not printed a prompt yet, and
characters sent before it is interactive are **gone — no error, no echo**. So
`run()` typed into the void, and separately `sleep 45` never started, which made
`describe()` report the terminal idle and sent the kill down the no-question
path: a confirmation that "never appeared" because there was nothing to confirm.

Both now wait for non-empty screen text first. Three consecutive clean runs
after. This is the third time in this plan that suspecting the driver before the
code was the thing that found it.

### Verified

`pnpm check` green, 1657 unit tests — new cases for the kill channel's contract
(`kill` takes no epoch, `dispose` still refuses one) and for main killing a
detached shell, double-killing safely, and still ignoring a superseded epoch.

**Driven**, `terminal-strip-probe` now **all 29 passed**, three runs in a row:

```
✓ killing an idle terminal does not ask — nothing to lose
✓ and its shell is gone in main, not just its row — null
✓ killing a busy terminal asks, and names the process — sleep is still running in it…
✓ cancelling leaves the shell running — still there
✓ and leaves its tab where it was — 4 tabs
✓ confirming kills the shell — gone in main
✓ and its tab goes with it, after the kill and not before
✓ killing the last terminal hides the panel — rather than minting one
✓ and ⌘J reopens it with a new shell, not an empty dock — a live prompt
```

Every kill is checked against `describe()` in main, not against the tab count: a
row leaving the strip proves the store changed and nothing about the process.

The whole sweep: strip 29, siblings 8, ipc 12, clear 4, survival 4,
session-persist 5, global-persist 6, roster-migration 6.

### Driven by hand

**2026-08-15 — the user drove the feature in the running app and reported it
working.** That is the one kind of verification the probes cannot stand in for:
they assert what a selector says, and a person notices the thing nobody thought
to assert.

Recorded without a list of what was exercised, because inventing one would be
worse than leaving it general — if something specific was checked, or something
looked off and was let go, it belongs here as a line of its own.

It does not replace the e2e suite: that covers regressions _elsewhere_ in the
app, which is a different question from whether terminals work.

### Not verified

- **A failing `terminal:kill` leaving the tab in place** is coded and reasoned
  about, but not driven — it would need main to reject, which nothing does. The
  `.catch` is a claim, not a demonstration.
- **`⌘J` still has the sheet gap** flagged in Phase 3: it opens a panel behind an
  overlay, which lazily spawns a PTY. Pre-existing, and a product decision rather
  than a bug, so it is still not changed.
- **No keybinding for kill**, deliberate — VS Code has none either, and a chord
  that ends a process is not a thing to discover by accident.
- **The e2e suite was not run.** ~5 minutes, 6-in-10 clean (C-029).
