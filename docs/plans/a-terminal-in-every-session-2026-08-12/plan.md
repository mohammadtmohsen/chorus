# A terminal in every session, and one that belongs to no session

Each session gets its own terminal, `⌘J` toggles it, and it behaves like
Terminal.app rather than like a log pane with an input box. Alongside them, one
**global** terminal that outlives every conversation, opened from the activity
bar.

This plan spends its first third on whether Chorus may have a PTY, because that
is the part that is a decision rather than a commit, and the part `CLAUDE.md`
currently answers with "no".

> **Revision 3.** Rewritten across three Codex reviews. Every correction is
> recorded inline where it applies, with what the earlier revision claimed,
> rather than quietly patched — because in almost every case the defect was this
> plan asserting something nobody had run, and a plan that hides its own
> corrections teaches the next reader to trust it more than it deserves.
>
> Revision 1 → 2: ten claims challenged, eight upheld; the ABI story (§3) and the
> `⌘W` double-binding (§4.6) were false and are struck.
> Revision 2 → 3: six blockers, all upheld. The load-bearing one is §3's
> rebuild inversion — packaging and `pnpm dev` load **different binaries**, and
> the phase that was supposed to de-risk this tested only one of them.

## The problem

There is nowhere to run a command. An agent can run one, and you can watch it
ask permission, but you cannot type `git log` yourself without leaving the app.
Every session already owns a working directory (`ActiveConversation.cwd`,
`runtime.ts:110`) and already shows you a git diff of it (`packages/workspace`),
so the app knows exactly where your shell should start and refuses to start one.

Two shapes, and they are not the same feature wearing different hats:

- **Per session** — `⌘J`, opens in that conversation's cwd, dies with the
  conversation. This is the one that was asked for.
- **Global** — belongs to no conversation, starts in `~`, and survives every
  session you open and end. This is where `brew install`, `git clone`, and
  "check something quickly" live, none of which belong to a conversation and all
  of which currently kill a session terminal when the session ends.

## 1. The wall, and why it is not actually in the way

`CLAUDE.md:7`:

> Both run headless over stdio; **there is no PTY anywhere.** Retiring the
> terminal here means retiring the _interface_, not the binary.

And the build plan is blunter still —
[`chorus-build-plan-2026-08-03/plan.md:507`](../chorus-build-plan-2026-08-03/plan.md):

> Budget: **`better-sqlite3` only.** Any additional native dependency needs an
> explicit justification.

**Both sentences are about how Chorus drives agents, and this feature does not
touch that.** Retiring the terminal as the _interface to an agent_ is a claim
about `claude` and `codex`: they stay headless over stdio, they keep their
JSON-RPC and their SDK, and nothing in `packages/adapter-*` changes. Refusing
_the person_ a shell is a different claim that was never argued, only inherited.

That distinction has to be written into `CLAUDE.md` as part of this work. Left
as-is, the next reader finds `node-pty` in the lockfile and reads it as a
violation — and they would be right to, because the sentence as written forbids
it.

## 2. What "same as VSCode" rules out

The tempting cheap version is `child_process.spawn` with pipes: no native
module, no packaging risk, ships in a day. It fails the requirement, and it fails
it on the things you would notice first.

| what you would do               | needs                                   | over a pipe                      |
| ------------------------------- | --------------------------------------- | -------------------------------- |
| `vim`, `nano`, `less`, `htop`   | termios, cursor addressing, `SIGWINCH`  | **does not run**                 |
| `ls`, `git`, `rg`               | `isatty(1)` — most tools check it       | colour silently off              |
| ↑ for the last command          | the shell's readline, which needs a tty | **no history, no line editing**  |
| `⌃C` on a runaway build         | a signal to a process group             | closes a pipe; child often lives |
| `pnpm build`'s progress bar     | `\r` against a known width              | thousands of lines               |
| `sudo`, `ssh`, a git passphrase | a controlling terminal for the prompt   | hangs with no prompt             |

A pipe-backed panel is a **command runner** — a legitimate product, just not the
one that was asked for.

## 3. What the second native module costs — **corrected**

> **Revision 1 was wrong here and the error was mine.** It claimed `node-pty`
> ships no prebuilds, is built against a specific ABI, and needs
> `@electron/rebuild` plus a rebuild on every Electron major. Codex challenged
> it; I checked the published package rather than argue, and Codex was right.

Verified against `node-pty@1.1.0`, the current `latest`:

| claim               | verified how                | result                                                   |
| ------------------- | --------------------------- | -------------------------------------------------------- |
| ships prebuilds     | `tar tzf`                   | `prebuilds/darwin-arm64/{pty.node,spawn-helper}` present |
| loads by ABI        | `lib/utils.js:19`           | **No** — `prebuilds/${process.platform}-${process.arch}` |
| is N-API            | `nm -gU pty.node`           | **Yes** — exports N-API symbols, so ABI-stable           |
| compiles on install | `scripts/prebuild.js`       | **No** — it only checks the dir exists and exits 0       |
| handles asar itself | `lib/unixTerminal.js:31-32` | **Yes** — `.replace('app.asar','app.asar.unpacked')`     |

So: no `@electron/rebuild` wiring, no toolchain in CI, and an Electron major
does not inherently invalidate the binary. The `allowBuilds` entry is **not**
what produces the binding either — `install` is
`node scripts/prebuild.js || node-gyp rebuild`, and on a supported target
`prebuild.js` exits 0 before `node-gyp` is ever reached.

### The risk did not vanish, it moved

```
-rw-r--r--  50480  package/prebuilds/darwin-arm64/spawn-helper
```

**`spawn-helper` ships mode 0644, and nothing ever makes it executable.** There
is no `chmod` anywhere in `lib/` or `scripts/`; `post-install.js` on non-Windows
only cleans `build/Release` and prints `SKIPPED (not Windows)`. Yet
`lib/unixTerminal.js:29` resolves that path and the native code execs it.

Why this is not broken for everyone: `lib/utils.js:19` checks `build/Release`
**first**, and a project that compiles from source — VSCode does — gets the exec
bit from the linker. The prebuilds path has no equivalent step.

### Which path we are actually on — the inversion

Revision 2 assumed the packaged app would use the prebuilds. **It will not**, and
this was verified rather than reasoned:

| link                                  | verified                                                                      | result                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| electron-builder rebuilds by default  | `app-builder-lib/out/packager.js:454`                                         | skips only `if (config.npmRebuild === false)`; `electron-builder.yml` does not set it          |
| `@electron/rebuild` detects prebuilds | `lib/module-rebuilder.js:54`, `module-type/{prebuildify,prebuild-install}.js` | recognises **only** those two tools                                                            |
| node-pty declares either              | its `package.json`                                                            | **neither** — sole dep is `node-addon-api`; prebuilds come from a custom `scripts/prebuild.js` |

So packaging compiles node-pty from source into `build/Release`, which
`utils.js:19` prefers. The consequence is the reverse of the usual failure:

- **Packaged app** — compiled, exec bit from the linker. Works, but needs a
  native toolchain at package time.
- **`pnpm dev`** — no compile, so the 0644 prebuilt helper is what loads.
  **Likely broken.**

Revision 2's Phase 0 tested only the packaged app and would have passed while dev
was broken. **Phase 0 now tests both paths and must choose one of two strategies:**

|                                      | A — prebuilds, no toolchain                       | B — compile from source |
| ------------------------------------ | ------------------------------------------------- | ----------------------- |
| config                               | `npmRebuild: false`                               | leave the default       |
| toolchain at package time            | none                                              | required                |
| exec bit                             | **we own it** — a chmod in dev and in `afterPack` | free from the linker    |
| Electron major upgrade               | nothing (N-API)                                   | rebuild                 |
| matches the project's stated posture | yes — "no rebuild step is needed"                 | no                      |

A is recommended: it keeps the `better-sqlite3` posture the project chose
deliberately, and `npmRebuild: false` is safe for it because its prebuilds
already load unmodified (proven in the 2026-08-03 spike). The cost is a chmod we
maintain in two places, which is a known, testable thing rather than a toolchain.

What remains at risk either way: the exec bit surviving `electron-builder`'s copy
into `app.asar.unpacked`, and `spawn-helper` being a **second Mach-O binary to
sign** under the ad-hoc `afterPack` hook (`build/sign-adhoc.cjs`) — a third if
`pty.node` counts separately.

### The gaps that make a break quiet

- **`e2e/packaged.mjs:49` is the only test covering the asar arrangement at all.**
- **No CI job packages the app** — `ci.yml:16-18` sets
  `ELECTRON_SKIP_BINARY_DOWNLOAD: 1`, so `check` and `build` never download
  Electron.

Together: a break is invisible until a human runs `pnpm verify:package` on a Mac.
That is why Phase 0 exists and why it comes before any UI.

## 4. The shape of the answer

### 4.0 Terminal identity is explicit, and it is not a conversation id

The single most important decision in this revision. A terminal is keyed by a
**discriminated union**, never by a bare string:

```ts
export type TerminalRef =
  { readonly scope: 'global' } | { readonly scope: 'session'; readonly conversationId: string }
```

**Storage is two fields, not one keyed map.** Revision 2 proposed flattening the
union to a string key (`'global'` vs `session:${id}`), which throws away the
guarantee the union was introduced to provide — once it is a string, a loop over
the map is back to parsing ids to know what it is holding. Instead:

```ts
private global: TerminalSession | null = null
private readonly bySession = new Map<string, TerminalSession>()
```

and every stored entry carries its own `TerminalRef`, so nothing has to
reconstruct scope from a key. This is precisely the call the codebase already
made for asides — held in a **separate map** (`runtime.ts:357-366`) rather than
tagged inside `active`, _"so nothing that walks sessions finds it"_. Same hazard,
same answer, and revision 2 cited that precedent while quietly not following it.

The union crosses IPC as a zod discriminated union, so an unknown scope is a
parse failure at the boundary rather than a lookup miss three layers in.

### 4.1 The PTY lives in main and outlives the view

Two independent reasons, either sufficient:

- The renderer is `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false` (`main/index.ts:41-46`). It cannot load a native
  module at all.
- **Only the active tab of each pane is mounted.** `Workspace.tsx:473` reads
  `pane.activeTabId` and `:494` renders only that one; `App.tsx:770` keys
  `<Session>` by `conversationId`, so switching tabs genuinely unmounts.

A `pnpm build` must not die because you clicked another tab. So the PTY is a
main-process resource and the renderer is a **view onto it**.

**Attach and dispose are different operations, and revision 1 conflated them.**
`terminal:close` was listed in the IPC surface with no statement of which it
meant, while §4.1 promised the PTY outlives unmounting — a contradiction that
would have been resolved at the keyboard, badly, by whoever wired React's
cleanup. Explicitly:

| operation       | when                                                   | effect on the PTY                    |
| --------------- | ------------------------------------------------------ | ------------------------------------ |
| `attach`        | view mounts, panel opens                               | none — returns `{ epoch, snapshot }` |
| `detach(epoch)` | view unmounts, tab backgrounded, panel toggled shut    | none                                 |
| `dispose`       | conversation ends, global killed explicitly, app quits | **killed**                           |

React effect cleanup calls `detach`, never `dispose`. That sentence is the whole
guard, and it belongs in a comment at the call site.

**`TerminalRef` identifies a shell, not a consumer, so attach mints an epoch.**
Without one, a `detach` from a view that is unmounting races the `attach` from
the view replacing it, and tears down the new subscription; an ack from the old
view credits the new one's watermark. Every push, ack and detach carries the
epoch, and main drops anything stamped with a superseded one.

**The renderer subscribes before it attaches.** `{ epoch, snapshot }` alone does
not close the race — output arriving between the snapshot being taken and the
subscription being live is simply lost. Subscribe first, buffer what arrives,
then attach and discard anything at or below the snapshot's sequence number. The
alternative — main buffering per-attachment — puts an unbounded queue in the
process that must not stall, so it is the renderer that does the filtering.

### 4.2 Two lifetimes, and only one of them is tied to a conversation

**Session terminals follow the conversation, not the tab.** Closing a tab is a
pure view operation — `layout.ts:231`'s `closeTab` leaves the conversation
streaming into SQLite. The thing that actually ends one is `App.tsx:439`'s
`endNow` → `runtime.closeConversation` (`runtime.ts:1314`), and the terminal's
`dispose` splices in there, beside the existing per-aside cleanup at `:1319-1328`.

**The global terminal has no such hook, by construction.** It is disposed on
exactly two events: the user killing it explicitly, and `before-quit`
(`index.ts:167-183`, where `runtime.close()` is already awaited). It is not
disposed when the last conversation ends, or when the workspace empties.

> **Revision 2 also promised it survives the window being closed and reopened.
> That is impossible today**, and the code says so plainly — `index.ts:159-163`:
>
> ```ts
> app.on('window-all-closed', () => {
>   // Chorus supervises agent child processes; on macOS the app staying resident
>   // with no window would leave them running invisibly.
>   app.quit()
> })
> ```
>
> Closing the window quits, which fires `before-quit`, which disposes. The
> promise is narrowed to **"survives every conversation"**, which is the part
> that matters and is achievable. Making it survive a window close means making
> Chorus resident — and that comment's objection applies to a shell at least as
> strongly as to an agent, so it is a product decision, not a fix.

**"Explicit close" needs a control, and the toggle is not it.** The activity-bar
button toggles _visibility_, which per §4.1 detaches and leaves the shell
running — that is the whole point. So disposal needs its own affordance: a kill
control inside the panel, distinct from the toggle and confirmed if a child is
live (§8.4). Revision 2 asserted disposal-on-explicit-close without ever saying
what the user presses.

**A shell that exits is a defined state, not an absence.** Type `exit` and the
PTY is gone while the panel is still open. The protocol carries the exit status,
the panel says the shell exited and with what, and the next open **starts a new
one** rather than showing a dead pane or silently resurrecting. Session
terminals behave identically; a conversation whose shell exited is not a
conversation that ended.

`runtime.setProjectDirectory` (`runtime.ts:2047`) remains a deliberate non-event
for both. Its own doc comment already draws the line:

> It does not move an agent's shell: those were started with a working directory
> and keep it.

**The global terminal starts in `homedir()`.** This matches Terminal.app, and it
matches something already in this codebase: `runtime.ts:524` resolves an empty
cwd as `options.cwd.trim() === '' ? homedir() : options.cwd`. Starting at `/`
would be novel behaviour with no precedent here and no precedent on the platform.
It is **lazy** — no PTY is spawned until the panel is first opened, so a user who
never opens it never pays for a shell.

### 4.3 Terminal output is not a log event

The tempting move is a `ChorusEventPayload`, because "the event log is the source
of truth" is the rule everything else follows from. It is wrong here, and the
honest version is worth writing down because **the codebase's own test does not
settle it**.

`CLAUDE.md`'s "State is not history" test is: _would reading this value back a
week later be worse than having none?_ For `limits` and `context.usage`, yes. For
terminal scrollback, plainly no — last week's build output would be useful.
Scrollback **passes** the test and is still excluded, for two different reasons:

1. **The log records the conversation.** A shell you typed into is a second
   stream that happens to share a pane, and folding it in makes every consumer
   (`catchup.ts`, the projections, the transcript reducer) answer "is this one
   mine?" forever. The global terminal makes this vivid: it has no
   `conversationId` to file an event under at all.
2. **This is C-021's hard half at its worst** — `cat .env`, `env`,
   `aws configure`, a pasted token, a password prompt that echoed. C-021 landed
   the `patch` field only because a string named `patch` is already scrubbed by
   `redactPayload`. Nothing scrubs a shell.

Goes into `CLAUDE.md` as a decision, so it is not rediscovered as a gap.

### 4.4 `@xterm/xterm` for the view, `@xterm/headless` for the snapshot

`CLAUDE.md:147-149` says the markdown parser and highlighter are hand-written on
purpose and _"adding a grammar engine is a decision, not a convenience."_ That
decision was right and does not transfer. Hand-written markdown is tractable and
its failures are cosmetic. **A conformant VT emulator is neither** — running
`vim` means alternate screen buffers, scroll regions, origin mode, cursor
save/restore, bracketed paste and several hundred escape sequences whose
behaviour is defined only by what `xterm` does. Hand-rolling it is the "guessed
shape" failure `CLAUDE.md` warns about under Adapters, one level up.

**Restoration cannot be a byte ring, and revision 1 got this wrong.** It proposed
replaying the retained suffix of a raw output buffer. VT state is cumulative:
alternate-screen entry, cursor mode, scroll region, colour and a half-written
escape sequence all live in bytes the trim discards. Remount into `vim` or
`htop` and you get a corrupted or blank screen. The correct structure is a
**`@xterm/headless` terminal per PTY in main**, fed the same stream and
serialized on attach — which is what VSCode's pty host does for exactly this
reason.

**That is two packages, not one.** `@xterm/headless` is the emulator core and
provides no serialization; the snapshot comes from **`@xterm/addon-serialize`**
loaded into it. Revision 2 named only the first and would have left the snapshot
with nothing to produce it.

Pushes carry monotonic sequence numbers so the view can align a snapshot against
the live stream; the subscribe-before-attach ordering in §4.1 is what makes that
alignment sound.

Two constraints on the view:

- **`CLAUDE.md:146` — no `dangerouslySetInnerHTML`, ever.** xterm builds its DOM
  through `document.createElement`. The letter holds; it gets a container ref and
  owns what is inside it. Worth a comment at the mount point, because the next
  reader will check.
- **Colours must be tokens.** `styles.css:98-116` re-declares every token under
  `@media (prefers-color-scheme: light)`, and nothing else in 5,646 lines is
  theme-aware. A hardcoded ANSI palette would be **the first thing in the
  codebase to break light mode.** The precedent is `--tok-*`: a dark set at
  `styles.css:38-57`, a light set at `:99-106`. So `--ansi-*` gets both, read via
  `getComputedStyle` and re-read on scheme change.

`--mono` comes free: it is not the terminal's font but **the app's only font**
(`styles.css:125-134`), chosen because it is _"what Terminal.app draws with"_,
ligatures off.

### 4.5 Flow control is not frame coalescing

Revision 1 proposed coalescing chunks on a frame boundary before crossing the
bridge, by analogy with `DeltaBuffer`. **That reduces call count and nothing
else** — same bytes, same parse cost in the renderer, same unbounded pending
memory. xterm documents that a fast producer can outrun it, become unresponsive,
and discard data at its hard buffer limit.

Real backpressure, end to end: `Terminal.write(data, callback)` acknowledges
consumption; the ack drives a high/low watermark; the watermark drives
`pty.pause()` / `pty.resume()`.

**It has two consumers, and revision 2 only counted one.** Waiting on the visible
renderer alone leaves the headless emulator in main unthrottled — and when the
panel is _hidden_ there is no renderer attached at all, so nothing would throttle
anything and a firehose corrupts the snapshot the panel exists to restore. The
watermark is the **slowest of**: main's headless `write(…, callback)`, and every
live attachment's ack. A terminal with zero attachments is still paced by the
headless write.

Coalescing is still worth doing on top — `better-sqlite3` is synchronous on the
main thread and every agent delta passes through it — but it is an optimisation,
not the mechanism.

**Both earlier exit criteria were invalid, in opposite directions.** Revision 1's
"a 50MB firehose does not stall the transcript" could pass while silently
dropping output. Revision 2 replaced it with byte-exact comparison against _the
terminal's contents_ — which **cannot hold**, because a bounded scrollback
discards old rows by design, and raising it to hold 50MB recreates the memory
problem the bound exists to prevent. Two tests, measuring two different things:

- **Transport completeness** — a rolling byte count and hash at a fake renderer
  sink, never at the emulator. Nothing dropped, nothing duplicated, order held.
- **VT fidelity** — a small stateful sequence (enter alternate screen, set a
  scroll region, colour, move the cursor) through headless serialization and a
  remount, asserting the restored screen matches.

### 4.6 `⌘J`, and the `⌘W` claim that was false

`⌘J` is **completely free** — exhaustive search for `KeyJ`, `Cmd+J`, `Ctrl+J`,
`CmdOrCtrl+J`, `⌘J`, `=== 'j'` across source, `out/` and the VS Code extension
returns zero. The only letters the workspace handler takes are `k` and `w`.

It belongs in the capture-phase listener at `Workspace.tsx:136-215`, and it stays
**scoped to the focused session's terminal**. The global terminal is opened from
the activity bar and has no keybinding in this plan — see §8.

**But "the focused session" is wrong when the global terminal has focus.** The
handler reads `state.focusedPaneId`, which keeps pointing at whatever pane was
focused last. Press `⌘J` while typing in the global terminal and it would toggle
a session panel somewhere else. So `⌘J` needs an explicit target rule: focus
inside the global terminal means `⌘J` is **inert** rather than acting at a
distance.

**The `⌘K` chord will eat the terminal's arrow keys, and guarding the arming is
not enough.** `Workspace.tsx:143-147` arms a 1.5-second window on `⌘K`, and
`:149-151` then `preventDefault`s any arrow inside it — **unconditionally, with
no check on `event.target`.** With focus in a terminal, ↑ is how you reach your
last command; the composer already suffers this (`Composer.tsx:964-976`).

Revision 2 said only that the chord must not _arm_ while focus is in a terminal.
That leaves the real case open: arm the chord from the composer, click into the
terminal, press ↑ — the window is still live and the arrow is still stolen.
**Both branches need the guard**: arming, and the arrow-handling branch that
consumes it.

> **Revision 1 claimed `⌘W` was already double-bound, with `{ role: 'windowMenu' }`
> supplying a native `⌘W` that beats `Workspace.tsx:192`. That is false**, and it
> was checked against the pinned binary rather than argued. Electron 43.2.0's own
> bundled menu code:
>
> ```
> role:"minimize"},{role:"zoom"},...n?[{type:"separator"},{role:"front"}]:[{role:"close"}]
> ```
>
> `close` is the **non-Mac** branch. On macOS the Window menu is minimize / zoom /
> separator / front, with no `⌘W`. `Workspace.tsx:192` is the only handler and it
> works. The claim is struck and no board entry is filed.

**`⌘J` will not work on Windows.** The handler tests `event.metaKey` with no
`ctrlKey` fallback anywhere, so no workspace shortcut fires there today. Not a
blocker — `electron-builder.yml:41-43` targets `dmg`/`arm64` only and
`pnpm-workspace.yaml:12` disables `electron-winstaller` — but stated rather than
discovered: **shell resolution is written cross-platform, only macOS is
verified.**

## 5. Where they go on screen

**Session terminal.** `.pane` is a flex column and `.score` is its only `flex: 1`
child (`styles.css:412`, `:1140`), which the stylesheet's comment at `:405-411`
says was rewritten to support exactly this. So it is a
`flex: 0 0 var(--terminal-height)` row inserted at `Session.tsx:1199`, immediately
before `<div className="dock">`. The four overlays above it are absolutely
positioned and not in flow, so nothing else moves.

**Global terminal.** `.workspace-editor` is `flex: 1 1 auto` inside the flex row
`.workspace-shell` (`styles.css:4892`, `:4113`). Making it a flex **column** with
`LayoutView` as the `flex: 1` child puts the global terminal below every pane and
**beside** the sidebar rather than under it — which is where VSCode puts it, and
the only arrangement where the sidebar stays full height.

Its toggle is a button in the activity bar's top group
(`ActivityBar.tsx:51-95`), after `onNewSession` — the group that already holds
"toggle sidebar" and "new session", both of which are app-level rather than
conversation-level. `activity-group--foot` is for usage and settings and is the
wrong neighbourhood.

**Both resizers follow the sidebar, not the sash.** `Sash`
(`Workspace.tsx:360-466`) already does `orientation: 'column'`, but it is welded
to the layout tree — it takes a `path` and calls `setBranchSizes`. Terminals are
not layout nodes. `useSidebarResize` (`Workspace.tsx:751-822`) is the precedent,
and its comment at `:743-749` says why:

> Going through the store on every frame would re-render every mounted transcript
> sixty times a second to move one edge — and the three rules that read the width
> are CSS, so CSS is where the live value belongs.

> **This is not the C-026 mitigation revision 1 claimed.** It said driving height
> through a CSS variable would keep the transcript's settling burst to the toggle
> and the release. It does not. `Session.tsx:342` is `follow.observe(el)` where
> `el` **is** `.score` — a CSS height change fires that observer every pointer
> frame regardless of whether React re-renders. The technique is still right
> (it removes the re-render, which is the expensive half) but the observer cost
> is the same as a window resize, which is an already-accepted cost. Downgraded
> from "mitigation" to "no worse than resizing the window", and measured rather
> than asserted.

**Geometry has to travel.** Revision 1 listed `terminal:resize` in the IPC
surface and never said what drives it. A `ResizeObserver` on the terminal
container drives xterm's `FitAddon`; the resulting `{ cols, rows }` goes over
`terminal:resize` to `pty.resize()`. Without it, `vim` and line wrapping stay at
the geometry the shell started with and `SIGWINCH` never fires.

## 6. Phases

### Phase 0 — Prove it packages, before any UI

The riskiest thing first, because a failure changes the plan rather than delaying
it.

> **Revision 1's Phase 0 could not satisfy its own exit criteria** — it added
> dependency config only, while requiring a packaged app to open a PTY and run
> `echo hi`. The service, IPC and view all arrived in later phases. It gets a
> throwaway main-process smoke hook, deleted in Phase 1.

Add `node-pty`: `apps/desktop/package.json` dependencies · `allowBuilds` in
`pnpm-workspace.yaml:8-14` (belt and braces — §3 shows it is not load-bearing on
a prebuilt target, and it is one line) · `electron.vite.config.ts:57`
`rollupOptions.external` · `electron-builder.yml` **both** `files` (after the
`!node_modules/**` line — order matters) and `asarUnpack`. Plus the throwaway
main-process smoke hook, deleted in Phase 1.

**Then settle §3's A-or-B**, which is the actual output of this phase and cannot
be settled by reading.

**Exit criteria — both paths, because they load different binaries.**

- **`pnpm dev`**: a PTY opens and `echo hi` comes back. This is the one revision 2
  would have missed, and on strategy A it is the one that needs the chmod.
- **Packaged `.app`**: `spawn-helper` is present in `app.asar.unpacked`, **is
  executable**, and is signed; a PTY opens and `echo hi` comes back;
  `pnpm verify:package` covers it.
- Which of A or B was chosen, with the reason, and — if B — the toolchain a
  fresh machine needs. Stated with the Electron version and arch.

**If it fails**, stop and re-open §2 — the pipe fallback becomes the plan.

### Phase 1 — The terminal service in main

`apps/desktop/src/main/terminal.ts`. Not a `packages/*` package: the eslint
layering block (`eslint.config.mjs:73-96`) keeps domain packages Electron-free
and this is host plumbing. `IdeBridge` (`main/ide-bridge.ts`) is the shape — a
main-owned subsystem with a static start, a `subscribe()` returning an
unsubscriber, and a `close()` awaited during `before-quit`.

A `Terminal` **port interface** behind it, following
`packages/event-store/src/port.ts:1-25` — one file knows what a PTY is, and tests
drive a fake. That is what makes this testable without spawning a shell in CI.

Contents: the two-field storage of §4.0; a `@xterm/headless` + `addon-serialize`
pair per PTY for snapshots; attach/detach/dispose and epochs per §4.1; exit
status per §4.2; session cwd from `ActiveConversation.cwd` (`runtime.ts:110`),
global cwd from `homedir()`; session dispose spliced into `closeConversation`,
global dispose only on explicit kill and `before-quit`.

**Shell resolution does not go through `which.ts`.** Revision 1 proposed reusing
`findExecutable`, which is wrong on inspection: `which.ts:82-96` filters
candidates through `versionOf(path)` and sorts by newest, because it exists to
pick between several installed copies of an agent CLI. A shell has no meaningful
`--version` ranking and `$SHELL` is already absolute.

Validate `$SHELL` **is an executable file** — not merely that the path exists,
which is what revision 2 said and is not the same check — falling back to
`/bin/zsh` on macOS and `COMSPEC` on Windows.

**Login shell, and it is a real choice.** Terminal.app launches `-l`, which is
why a shell opened there has the user's full `PATH` and rc files. Chorus already
carries the scar tissue for getting this wrong: `which.ts:57-78`'s
`adoptShellPath()` exists solely because the app's inherited `PATH` is not the
user's. A non-login shell would reintroduce that gap inside the terminal itself.
So: **login shell on Unix**, and it is stated here rather than discovered when
`brew` is not found.

**The live-child policy is settled in this phase, not deferred.** It shapes the
disposal API — whether `dispose` can refuse, whether it reports what is running,
whether the caller awaits a confirmation — and retrofitting a confirmation into
a signature that cannot express one is the expensive version. See §8.4.

**`reap.ts` is deliberately untouched, and the reason goes in a comment.** It
kills PPID-1 orphans matching `AGENT_PATTERNS = ['codex app-server', 'claude --']`
with `SIGKILL` (`reap.ts:30`, `:46`). Adding a user's shell would `SIGKILL` every
`zsh` they have open outside Chorus — the file's rationale at `:20-23` is that
identifying by pattern is what keeps it from killing something unrelated, and a
bare shell name defeats it. A PTY child dies when the master fd closes.

**Exit criteria.** A shell opens in the right cwd for both scopes; `⌃C`
interrupts a `sleep 100`; `vim` draws and exits cleanly; ending a conversation
kills its terminal and **leaves the global one running** (checked with `pgrep`,
stated); ending every conversation leaves the global one running.

### Phase 2 — IPC and flow control

`terminal:attach` / `detach` / `dispose` / `write` / `resize` / **`ack`** in
`IPC_CONTRACT` (`shared/ipc.ts:203-910`, before the `as const`), each taking a
`TerminalRef` and — for everything after `attach` — the **epoch** it minted, plus
a `TERMINAL_PUSH_CHANNEL` beside `:916-1002` carrying `{ epoch, seq, data }` and
the exit status. Push payloads deliberately do **not** go in the contract map,
since that map is iterated to register `ipcMain.handle`. Then `ChorusApi`,
`buildHandlers` (the mapped type at `main/ipc.ts:36` makes an omission a type
error), `forwardTerminalToRenderer` beside `:634`, the `index.ts` wiring, and the
preload block. `agents:limits` is the worked example end to end.

**`ack` is what revision 2 was missing.** §4.5 described watermark backpressure
driven by renderer acknowledgement while the IPC surface had no operation to
carry one — a mechanism with no wire. It is a channel, not an afterthought.

Watermark flow control per §4.5 — slowest of headless and every live attachment
— plus frame coalescing on top.

**Exit criteria.** Per §4.5, two separate tests: a rolling hash at a fake sink
proves nothing was dropped, duplicated or reordered under a 50MB firehose; a
small stateful VT sequence survives serialize-and-remount. Plus: `⌃C` stays
responsive while output floods; a hidden panel does not corrupt its snapshot
under the same firehose (the zero-attachment case); an agent streaming in another
pane is not stalled, with frame timings stated.

### Phase 3 — The two panels, `⌘J`, and the activity-bar button

The session panel at the `Session.tsx:1199` seam; the global panel at the
`.workspace-editor` seam per §5; the activity-bar button; both resizers driven by
a CSS custom property; xterm mounted against a container ref with the `--ansi-*`
token bridge and a `prefers-color-scheme` listener; the `ResizeObserver` →
`FitAddon` → `terminal:resize` path; a `terminal` namespace in `i18n/en.json`
(`workspace.*` at `:56-90` is the neighbour to match, and `i18n/en.test.ts`
enforces the plural rules); `⌘J` in the handler at `Workspace.tsx:136`; the `⌘K`
chord exemption covering **both** terminals.

**Exit criteria.** `⌘J` toggles the focused pane's session terminal and moves
focus into it; `⌘J` again returns focus to the composer; **`⌘J` with focus in the
global terminal does nothing at all** — it does not reach for the last focused
pane; the activity-bar button toggles the global one and spawns it lazily on
first open; the kill control disposes and the toggle does not; a shell that
`exit`s says so, and reopening starts a fresh one; `⌘K` then ↑ reaches shell
history, **including when the chord was armed from the composer before focus
moved into the terminal**; `vim` reflows when either panel is dragged; light mode
is looked at, not assumed; the C-026 cycle count is stated before and after over
the same stimulus.

### Phase 4 — Persistence

Both panels' visibility and height go into `WorkspaceSnapshot`
(`shared/workspace-layout.ts:41-53`), which already persists through
`open-sessions.json` v2 — **separately**, since the global panel's state is not
per-conversation:

```ts
terminals: z.record(z.string(), TerminalPanelState).default({}),   // by conversationId
globalTerminal: TerminalPanelState.default({ open: false, height: 240 }),
```

**Both must be `.default(...)`, and this is the sharpest trap in the plan.**
`open-sessions.ts:84-92`: if the v2 parse fails it falls through to a legacy
bare-array parse, which also fails, and returns `{ sessions: [], workspace: null }`
— so **a required new field silently loses every open session**, not just the
layout. `sidebarWidth: z.number().default(SIDEBAR_WIDTH.default)`
(`workspace-layout.ts:48`) is the existing precedent and it carries a comment
saying exactly why.

The per-conversation map also needs stale-id pruning (`reconcileWorkspace`,
`layout.ts:445`, is the hook), replacement on restart (`replaceSession`,
`layout.ts:418`), removal on close, and height clamping.

**Exit criteria.** Quit and relaunch: both panels are where you left them. A
snapshot written **before** this phase still parses and still restores its
sessions — tested with a fixture, since that is the failure that loses user data
silently. Switch tabs away and back mid-build: the output you missed is there,
the build is still running, and `vim` is not corrupted.

## 7. What this deliberately does not do

- **The agent cannot see or use either terminal.** Not reading output, not
  running its Bash tool there. That option has the largest blast radius in the
  product: every deny rule, every session grant and the whole fixed ordering of
  `policy/engine.ts` would apply to a surface you also type into. Separate plan.
- **No terminal output in the event log.** §4.3.
- **One terminal per scope.** One global, one per session. VSCode's
  several-with-a-picker means each slot in §4.0 holding a list, and a strip
  inside each panel — contained, and nothing here forecloses it.
- **No shell integration.** VSCode's command decorations and exit-code gutters
  need injected shell hooks in the user's rc files.
- **Windows is written for, not verified.** §4.6.
- **The global terminal gets no keybinding.** §8.
- **Chorus does not become a resident app.** `window-all-closed` keeps quitting
  (§4.2). Making the global terminal survive a window close would mean reversing
  a policy that exists to stop invisible child processes — and a background shell
  is exactly the thing that comment is about.

## 8. Open questions

**1. The three original decisions.** Put to the user, unanswered, so the plan
took the recommended branch of each and each is cheap to flip before Phase 0:
**node-pty over pipes** (§2), **no agent access** (§7), **one terminal per
scope** (§7).

**2. Does the global terminal need a keybinding?** Codex scoped `⌘J` to the
session terminal, which leaves the global one button-only — the one surface you
would reach for while _not_ focused on a session, and the one with no keyboard
route. `⌘⇧J` is free and is the obvious candidate, but inventing a binding is
outside what was asked for.

**3. Branch dependency on `fix/a-suite-that-can-go-red`.** C-027's fix is
**unmerged** — `git branch -a --contains 294d910` returns only that branch, and
`origin/main`'s `runner.mjs` has no `Skipped` at all. So the suite can tell a
skip from a pass _here_ and not on `main`. Terminal e2e specs are diagnosable
independently and need not be held back, **provided that branch lands first**;
if it does not, they land in a suite where `all N passed` is still a coin toss.
Stated rather than assumed.

**4. What happens to a shell with a live child when you end the session?**
`dispose` kills the PTY, and mid-`ssh` or mid-`psql` that is data loss with no
confirmation. The global terminal makes this worse on quit, where it is the
_expected_ home of long-running work. A confirmation on every session end is the
kind of friction that gets disabled.

**No longer deferred — this is settled at the top of Phase 1**, because it
decides the disposal signature: whether `dispose` can refuse, whether it reports
what is running, whether callers await a confirmation. Revision 2 deferred it
"to Phase 1, where the shape of `TerminalSession` will make it concrete", which
had it backwards — the shape follows the policy, not the other way round. The
open part is which policy, and that is a product call: never ask, ask only when a
foreground child is live, or ask only on quit.

**5. Four panes, four session terminals, plus a global one.** Vertical space is
finite and each session terminal competes with its own transcript. Unresolved;
probably needs the thing on screen.
