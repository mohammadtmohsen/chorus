# A workbench that holds

## Status

| Phase                                 | Status                             | Commit                                                                                 | Notes                                                                                                                             |
| ------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Research                          | ✅ done                            | —                                                                                      | Three agents, read-only. Findings below.                                                                                          |
| 1 — The port in the name              | ✅ verified 2026-09-16             | `2cb9885`                                                                              | The branch appears on the second launch with no click. Revived the same day, once the SCM symptom proved the residual observable. |
| 2 — A workbench that is not throttled | ✅ verified 2026-09-16             | `1de72c0`                                                                              | Measured before and after. `detached` went from `hidden` to `visible`, and no `visibilitychange` fires at all.                    |
| 3 — Focus, honestly                   | ✅ verified 2026-09-16             | `1867518`, `2f07d03`                                                                   | Measured with the workaround disabled: SCM refreshed with focus in the chat. `scm-refresh.ts` removed.                            |
| 4 — Extensions per workspace          | ✅ answered 2026-09-17, no code    | —                                                                                      | The machinery was already in place and the toggle was proven by hand. Closes C-063 reframed: one install set, per-project enablement. |
| 5 — Remote over SSH                   | ✅ verified 2026-09-17 on `tpa-be` | `a47c9f4`, `f12fa2e`, `148fce1`, `62b3d75`, `e2d4018`, `e58c580`, `f165396`, `26e8c54`, `7a05e73` | The backend opened from Chorus on `tpa-be`, in the dev build and then in the installed app. An agent answered about the selected lines, and its edits reach the remote file. |
| 6 — `33.0.9` → `36.2.7`               | ⬜ not started                     | —                                                                                      | Table stakes, not a fix. Its own migration.                                                                                       |

Meta: written 2026-09-16, after a research round by `claude`, `codex` and `deepseek`.
Nothing was run and nothing was changed. Every claim below is either a citation or
is marked unverified.

## 0. Why, and what we were wrong about

The report was that the editor is not stable: source control fails in all four
ways at once — empty, stale, inert, and dying after a while — and the terminal,
extensions, explorer and search are unreliable too. Remote SSH does not work at
all.

Four symptoms across four surfaces is not four bugs. Every one of those surfaces
is remote, so the first question is what they share, and the answer is the
connection to the remote extension host.

**The first hypothesis was wrong and is recorded because the correction is the
useful part.** Restricted Mode was the obvious candidate: the authority carries
an ephemeral port, so workspace identity changes on every launch, so workspace
trust is re-asked, and `microsoft/vscode#184810` is titled "Git SCM is disabled
in restricted mode". It is a clean story and it is false here.
`services.ts:588` already sets `enableWorkspaceTrust: false`, which is the
embedder switch documented in `IWorkbenchConstructionOptions` and is stronger
than the `security.workspace.trust.enabled` setting. Trust cannot be the shared
cause because trust is already off.

What is true is narrower. The authority churn is real, and
`remote-authority.ts` already documents it: `--port 0` means a different
`vscode-remote://` authority every launch, so every launch mints a fresh
workspace identity and abandons the last one. Measured, not assumed — that file
records brute-forcing the port space and matching all 35 `workspace:*` scopes to
seven launches of five projects. The cost is storage identity, not trust.

The actual shared cause is one level down, and `workbench-host.ts:44` already
names it under the heading _What the lease cannot do, stated because it is the
load-bearing unknown_: the refcount lease keeps a **process** alive, but it does
not hold a **socket** open, because the client connections belong to the
surface's `WebContents` and go when it does.

Research since has made that much sharper. The reconnection token is
`generateUuid()`, minted per connection inside the renderer realm
(`remoteAgentConnection.js:370`), and the server keys both
`_managementConnections` and `_extHostConnections` on it
(`remoteExtensionHostAgentServer.ts:473-510`). Nothing in
`IWorkbenchConstructionOptions` can supply one. So a realm that dies presents a
new token, is treated as a fresh connection, and gets a new extension host.
**A reload is never a reconnection**, and `--reconnection-grace-time` only bounds
how long the abandoned host lingers.

## The shape of the answer

Three of the six phases are cheap and documented. One is architectural and needs
a decision. One is blocked on a measurement that already has a probe written for
it. One is a migration that fixes nothing and has to happen anyway.

The ordering below is by cost-to-benefit, not by severity.

## Phase 1 — The port in the name

**🔁 Revived on 2026-09-16, the same day, because the revival condition below was
met.** After relaunching with Phases 2 and 3 installed, Source Control showed one
change while the status bar showed **no branch**. That is this phase's residual,
and checking tabs was the wrong test for it.

**The chain, read in the shipped `33.0.9` code.** The status bar branch is one of
`provider.statusBarCommands`, drawn by `SCMActiveRepositoryController`, and
`_updateStatusBar` returns immediately when there is no active repository
(`activity.js:134-136`). The active repository is the latest of two sources —
the active editor's repository, or the focused one (`scmViewService.js:224`). The
SCM view remembers repositories by `getProviderStorageKey`, which is
`providerId:label:rootUri` (`:37-38`), and `rootUri` is
`vscode-remote://127.0.0.1:<port>/…`. After a relaunch the port differs, so the
stored key never matches, `index === -1` at `:277`, and that branch **returns at
`:293` — before the auto-focus at `:333-335`**. The repository is shown and never
focused. With the editor area empty, both sources are undefined and there is no
branch. Opening a file or the Source Control view sets one, which is why the
branch reappears the moment you do.

**Confirmed from the user's own storage, not only from the code.** `deepseek`
computed `workspaceIdFor` for the project and matched it against the stored
`scm:view:visibleRepositories`, which carries a previous launch's port (63821).

**And a fix is what exposed it.** Before `workspaceIdFor`, every launch minted a
new workspace bucket, so there was never a `previousState` to mismatch against —
`:276` was false and auto-focus always ran. Stabilising the bucket made the stored
state survive a relaunch, which is exactly what turned the port inside it from an
invisible churn into a missing branch.

**Do not clear the stale entries.** It would look like a fix and last exactly one
launch. A stable port fixes it on the next launch after it lands: the first one
still sees the old key, stores the new stable one, and every launch after matches.

**The design, reconciled.** The user's decision was "persisted first-free port".
Research since changes _how_ it is chosen, not that: not `bind(0)`, which returns
from 49152–65535, the range the kernel hands to outbound connections; instead a
free port probed from a sub-range below 49152 and outside `BROWSER_RESTRICTED_PORTS`,
persisted beside the token under `serverDataDir()`, and passed as
`--port <n>-<n>` so a taken port exits in seconds with the port named rather than
logging silently for the full 60-second wait. The stdout readback stays exactly as
it is, which is what keeps "never attach to a port Chorus did not open" true.

---

**⏸️ Parked on 2026-09-16, before a line was written, because the premise did not
survive being checked.** Kept below as the record of why it was parked, which was
wrong in one respect: it tested tabs and not the SCM view. Everything below is kept because the design work is
sound and the reasons it was parked are worth more than the phase was.

**Its stated motivation is obsolete, and the plan was quoting a measurement its
own later fix had already answered.** "Every launch mints a fresh workspace
identity" was true when `remote-authority.ts` recorded it. It is not true now:
`workspaceIdFor(root)` is wired at `services.ts:644`, which is exactly the fix
that measurement produced, and the session partition is the constant
`WORKBENCH_PARTITION` (`workbench-surface.ts:108`). Both mechanisms that could
churn identity are already port-independent.

**The one residual, and it is not observable.** `folderUri` on the same line is
a `vscode-remote://` URI and does carry the port, so anything stored _inside_
the now-stable bucket that names a resource — restored tabs, breakpoints,
recently-opened — points at last launch's authority. Checked with the user on
2026-09-16: **tabs restore correctly across launches.** So the mechanism is real
and produces no symptom.

**What would revive this phase.** A reported symptom that survives
`workspaceIdFor` — editor state that does not restore, a breakpoint that will
not rebind, an extension whose `workspaceState` resets. Without one, this is a
phase without a problem.

**Two findings worth keeping if it ever does revive.** First, do not use a plain
`--port <n>`: `parsePort` (`src/server-main.ts:173-174`) returns the integer
verbatim, and on `EADDRINUSE` `handleServerError`
(`remoteExtensionHostAgentServer.ts:223-226`) only logs — no fallback and no
exit, so the child stays alive and silent and the failure costs the full 60s
timeout at `workbench-host.ts:1175`. Use **`--port <n>-<n>`**, a one-element
range: `findFreePort` (`server-main.ts:207-224`) then `console.warn` +
`process.exit(1)` (`:181-182`), which lands on the existing exit handler in
seconds with the port named. Second, do not persist a `bind(0)` port: this
machine's `net.inet.ip.portrange.first/last` are 49152/65535, the same range the
kernel hands to outbound connections. Pick below 49152 and outside
`BROWSER_RESTRICTED_PORTS` (`base/node/ports.ts:67`).

---

**Goal.** Give the REH a stable port, so the remote authority is stable, so the
workspace identity is stable.

**The invariant this phase must not break, in the file's own words.**
`workbench-host.ts:327-334` documents the readback as deliberate — "never
chosen, never scanned, never assumed" — because attaching to a stale REH,
possibly at a different commit, "presents as a workbench that works and is
wrong, which is exactly what attaching to whatever owned port 9800 produced.
**Never attach to a port Chorus did not open.**" That is `CLAUDE.md`'s
e2e-harness trap one level out, and it is not negotiable.

**The randomness was never what provided it — the readback is.** Chorus builds
an authority only when _its own child_ prints `Extension host agent listening on
<n>` (`readServerPort`, `:351`). Changing `--port 0` to `--port <n>` leaves that
gate exactly where it is: if something else holds the port, our child cannot
bind, prints nothing, and the existing wait fails closed. The port becomes
**requested** rather than **assigned**, and it is still **confirmed**. The
invariant survives because it never depended on the number being unpredictable.

**And there is a second guard already in place.** `:923` mints a `randomUUID()`,
writes it `0600`, and passes `--connection-token-file` at `:935`. A foreign
server on the chosen port holds its own token, so Chorus's client cannot
authenticate against it — a wrong server fails loudly rather than serving a
plausible empty tree.

**What the port stability buys downstream.** `:1009` records that "the
workbench session's CSP was built with the first authority in it", which is why
a silent re-spawn is refused today. A stable port makes that authority stable
across launches, so the storage identity `remote-authority.ts` pins by hand
stops being a workaround for a moving target.

**What changes, concretely.**

1. A `chosen-port` file beside the token under `serverDataDir()`. It is per
   profile, which is the same scope the reaper already keys on.
2. On first run only, pick one: bind a `net.Server` to `127.0.0.1:0`, read the
   port the OS assigned, close it, persist it. That is "first free", chosen by
   the OS rather than by a hardcoded number that may already be taken on
   somebody's machine.
3. `--port 0` becomes `--port <persisted>`.
4. **The readback is unchanged.** `readServerPort` still parses the child's own
   stdout, and the authority is still built from what the child reported — not
   from what was requested. If the two disagree, that is a fact worth logging
   rather than an assumption worth making.
5. A port in use fails closed with a message naming the port, rather than
   falling back. A silent fallback would restore exactly the churn this phase
   removes.

**The cost, stated.** One port per profile means one Chorus per profile owning
it. That is not a new restriction: `:909-914` already refuses to start when a
server from an earlier session owns the profile's data directory. A port
collision converts into the same "refuse and say why" path that already exists,
rather than a new failure mode.

**Two things nobody has checked, and they are the risk.** Whether the REH fails
to bind or silently falls back to another port when `--port <n>` is taken — the
readback covers either, but the error message depends on which. And the
persisted port is an ephemeral one, so the OS may hand it to something else
between launches; the answer is to fail closed and let the user reset, but the
frequency is unknown.

**Exit criteria.** Two consecutive launches produce the same
`vscode-remote://` authority for the same project, and `workspace:*` storage
scopes are reused rather than re-minted.

## Phase 2 — A workbench that is not throttled

**Goal.** Stop a detached or backgrounded workbench being marked `hidden`, so
its timers, its reconnection schedule and its rendering keep running.

**This phase was called "a socket that outlives its view" and that was the wrong
problem.** The name is kept in the history because the correction is the useful
part: the socket was never the thing at risk.

**The measurement was taken on 2026-09-16 and it changes this phase's premise.**
`apps/desktop/src/main/reparent-check.ts` was extended to read
`document.visibilityState`, a `visibilitychange` log and a
`requestAnimationFrame` counter alongside `isDestroyed()`, and to run itself
once a surface exists. Run with `CHORUS_REPARENT_CHECK=both-open`, on macOS,
Electron 43.2.0:

```
both-open     1  destroyed=false  before=visible  detached=hidden                    after=hidden   frames=0
both-open     2  destroyed=false  before=hidden   detached=hidden                    after=visible  frames=43
source-closes 1  destroyed=false  before=visible  detached=hidden                    after=hidden   frames=1
source-closes 2  destroyed=false  before=hidden   detached=hidden  afterClose=hidden  after=hidden   frames=1
```

**Verified after the fix, same probe, same machine, 2026-09-16:**

```
both-open 1  destroyed=false  before=visible  detached=visible  events=[]  after=visible  frames=6
both-open 2  destroyed=false  before=visible  detached=visible  events=[]  after=visible  frames=57
```

`detached` went from `hidden` to `visible`, and `events=[]` throughout — the
`visibilitychange` listener never fires, so the page is never told it is hidden.
That is the claim, measured on the real path rather than argued.

**One thing the fix does not do, stated so nobody reads more into it.** The frame
counter did not climb across step 2's detached window (6 before, 6 after 500 ms).
Frames come from the compositor and an unparented view has no surface to draw
into, so rAF stalling there is expected and was never the target. The target was
`visibilityState`, because that is what gates renderer timers — the client's
reconnection schedule and `scm-refresh.ts`'s own debounce.

**`source-closes` carries the case that matters.** Its `afterClose` reading is
taken with the view detached _and_ the window it came from closed, and it still
reads `destroyed=false`. That is exactly what `beginHandoff` was written to
survive, and it survives. Across all four moves in both modes nothing was ever
destroyed.

**The realm survives and the page is hidden.** `destroyed=false` on both moves,
so reparenting does not kill the `WebContents` — the reconnection token is not
lost to a dead realm by this path. But the page transitions to `hidden` while
unparented, `visibilitychange` fires, and `requestAnimationFrame` stops at
`frames=0`. It returned to `visible` only on step 2, when the view went back to
the real Chorus window, where `frames=43` shows rAF resuming.

**So this is throttling, not destruction, and that is the macOS residual the
source reading could not reach.** The Aura analysis below is correct for its
platform and wrong for this one: on macOS the renderer is an `NSView` and
detaching it from its superview does mark it hidden. Chromium throttles timers
in a hidden page, and `HANDOFF_EXPIRY_MS` is 10 seconds, so a handoff runs the
workbench's client — including its reconnection schedule — under a throttled
timer for that whole window.

**And nothing opts out.** `backgroundThrottling` is not set anywhere in
`apps/desktop/src/`, so the `WebContentsView` at `workbench-surface.ts:848`
takes the default `true`. Turning it off is the documented remedy, at the
documented cost of applying window-wide.

**`detached=hidden` is the unambiguous reading.** It is taken while the view has
no parent window at all, so there is nothing for it to be occluded by; `hidden`
there can only be the detach itself. It is identical in both modes.

**The two bare-window `after=hidden` readings are not evidence about re-attach.**
They were read first as "it did not recover", and that reading is wrong.
Electron documents occlusion as a visibility input on macOS — "if the window is
occluded (i.e. fully covered) by another window, the visibility state will be
`hidden`" — and a bare `new BrowserWindow({width, height})` created while Chorus
is in front of it is occluded by that definition. Re-attach does clear the flag:
`WasShown()`'s only guard is the flag itself, and `both-open` step 2 returning
`after=visible frames=43` is that path firing. Demote those two readings; keep
`detached=hidden`.

**What the run still does not settle.** Each run had a single surface
(`candidates 1`), so the ambiguous-`heldView` case was never exercised, and the
500ms settle was never stress-tested.

**An unparented view does not stop on the Aura path, and this is settled from
Electron's source rather than its docs** — kept because the method is sound and
the platform split is the finding. Electron documents nothing about a view with
no parent;
`browser-window.md`'s "Page visibility" section is normative about _windows_
only. But `View::RemoveChildView` (`electron_api_view.cc:284-304`) erases the
child and calls the native remove and nothing else, and
`WebContentsView::OnViewRemovedFromWidget`
(`electron_api_web_contents_view.cc:132-141`) removes only the draggable-region
provider. Neither calls `WasHidden()`. The throttle is reachable only through
`WasHidden()` — Electron ships `patches/chromium/disable_hidden.patch` guarding
that early return with `disable_hidden_` — and the only route to it is window
hide, minimize or occlusion, which is an `aura::Window` concern a parentless
view does not have.

**The arithmetic rules out the timing story too.** `HANDOFF_EXPIRY_MS` is
10,000 against a 30-second grace window, so a handoff cannot outlive the
server's retention even at its worst. And the client runs its own reconnection
schedule — `[0, 5, 5, 10, 10, 10, 10, 10, 30]` — inside that window. **Socket
drops are already handled.** Only realm death is not, which is why the token
being minted in the realm is the whole of this phase.

**That residual is what the measurement closed.** On macOS the renderer is an
`NSView` and `removeChildView` detaches it from its superview, and the run shows
the page does go `hidden`. Who calls `WasHidden()` on that path is still
unidentified — see open questions — and it does not matter for the fix, because
the flag has exactly three writers and the guard sits above one of them.

**A sharper hazard found on the way, and it is not about reparenting at all.**
`~WebContentsView` calls `api_web_contents_->Destroy()`, so when the JavaScript
wrapper is garbage collected the page dies with it. Source-only; the docs say
nothing. Chorus's `byId` map is the sole thing preventing that, and it is a
plain JS reference. Any handle that escapes the map is one collection away from
killing a live workbench. Worth a test that asserts the map holds every surface
it created.

**`is_hidden_` has exactly three writers, and that is what makes this tractable.**
`WasHidden()` (`render_widget_host_impl.cc:885`), `WasShown()` (`:927`), and
`RendererExited()` (`:2398`). The third is a crash path — its own comment says
"after the renderer crashes... we assume such RenderWidgetHost to be invisible".
So every runtime transition in a live renderer goes through the pair, and
Electron's `disable_hidden_` guard sits at the top of `WasHidden()` **before**
the assignment. With it set, the flag can never become true; `WasShown()`'s only
guard is that same flag, so it returns early and harmlessly. `blink_widget_->
WasHidden()`, the viz visibility push and `UpdateClientPriority` are all
downstream of the guard and never run. **The fix closes both directions, not
half of one.**

**Use the setter, not only the preference.** `HandleNewRenderFrame`
(`electron_api_web_contents.cc:1918-1936`) applies
`disable_hidden_ = !background_throttling_` on every new render frame, so
`webPreferences: { backgroundThrottling: false }` is re-applied rather than
one-shot. But the runtime setter does one thing the preference cannot:
`if (rwh_impl->IsHidden()) rwh_impl->WasShown({})` — it **repairs a view that is
already hidden**. A surface that has been detached once needs that, so the two
are not interchangeable.

**Three names, and only one of them is fictional.** There is no
`setBackgroundThrottlingAllowed`. `electron.d.ts` at 43.2.0 does carry
`getBackgroundThrottling()` (`:17986`), `setBackgroundThrottling(allowed)`
(`:18374`) and the `backgroundThrottling` property (`:18523`). They are the same
thing: the property is defined in Electron's own JS layer at
`lib/browser/api/web-contents.ts:977-980` as
`set: (allowed) => this.setBackgroundThrottling(allowed)`, and the method binds
to `WebContents::SetBackgroundThrottling` at `electron_api_web_contents.cc:2581`
— the one carrying the `WasShown` repair.

**The runtime assignment does something the construction flag cannot, and the
reason is the explicit call rather than the guard.** `disable_hidden_` is a
guard on `WasHidden()` and on nothing else: `disable_hidden.patch` contains
**zero** occurrences of `WasShown`, and the symbol appears at exactly three
sites — the guard body, the member declaration, and
`RenderWidgetHostViewAura::HideImpl()`'s call site. `WasShown()`'s only
condition is `if (!is_hidden_) return;`, which the guard cannot influence.

What the runtime line has is the explicit call. `SetBackgroundThrottling` ends
with `if (rwh_impl->IsHidden()) rwh_impl->WasShown({})`
(`electron_api_web_contents.cc:2604-2606`), and that is the only public way to
clear an `is_hidden_` that was set **outside** the `WasHidden`/`WasShown` pair.
There is one such writer: `RendererExited()` (`:2398`), on a renderer crash.
`HandleNewRenderFrame` (`:1918-1940`) assigns `disable_hidden_` and calls
`SetSchedulerThrottling` and stops — it never calls `WasShown()`, so it cannot
clear the flag either.

So: `backgroundThrottling: false` in the `webPreferences` literal at
`workbench-surface.ts:848`, which is the mechanism, and
`surface.view.webContents.backgroundThrottling = false` in `attachSurface` after
`addChildView`, which is an explicit `WasShown()` for a state set outside the
pair.

**Whether that state is reachable is unobserved, so the line is useful rather
than load-bearing.** `RendererExited()`'s own comment says the flag is set so
the renderer "will have correct visibility set when respawned", which suggests
the respawn path clears it. Nobody has seen a surface stuck. And a crash does
not cause an attach, so if it ever does happen the repair fires on the _next_
handoff, which may never come — `render-process-gone` is where a real fix would
go. Not written, deliberately.

**The cost, and it is wider than it first looks.** Electron's docs say that once
one webContents in a window disables throttling, "frames will be drawn and
swapped for the whole window and other webContents displayed by it". So this
does not opt four surfaces out — it opts the **shell's** webContents out too,
and a minimised Chorus keeps painting. For Chorus the direction is right, a
background project's terminal and agents keep running, and the trade was taken
knowingly on 2026-09-16. It is not three free lines.

The flag itself is per-`WebContents` — `bool background_throttling_ = true` on
`WebContents` (`electron_api_web_contents.h:827`), read from
`options.Get("backgroundThrottling", …)` (`:880`) — so the shared
`workbenchSession` cannot leak it between surfaces, and `sandbox` is unrelated.

**What is already right, so it is not the bug.** `beginHandoff`
(`workbench-surface.ts:927`) removes the id from `byOwner` before detaching the
view, so a source window closing no longer destroys a surface that has moved.
That is the `finish the detach wiring the gate caught` commit, and the
`source-closes` run proves it: `destroyed=false` with the source window closed
under a detached view.

**What this phase no longer needs, and it is worth saying.** `webSocketFactory`
was going to be taken here, so that a socket owned by main survived a view. The
measurement removes the reason: the realm survives reparenting, the socket goes
with it, and the client's own reconnection schedule already covers a drop. So
the mutual exclusion with the resolver path — `expectsResolverExtension =
!!remoteAuthority?.includes('+') && !options.webSocketFactory`
(`environmentService.js:18`) — **no longer has to be decided at all**. It stays
recorded because Phase 5 may still want it, and because a later phase that
reaches for `webSocketFactory` needs to know what it costs.

**Exit criteria.** A project's terminal survives its view being reparented into
a detached window, with the build still running, and
`document.visibilityState` reads `visible` throughout.

## Phase 3 — Focus, honestly

**Goal.** Remove `scm-refresh.ts` by fixing the thing it works around.

**The cause is confirmed and is not fixed upstream.** The git extension's
`updateWhenIdleAndWait()` calls `whenIdleAndFocused()`, which parks while
`window.state.focused` is false — unchanged in `1.121.0`, `1.128.1` and current
`main`. `git.autorefresh` enables entry into that path and does not bypass the
gate; there is no setting that does. `BrowserHostService` computes focus from
`getActiveDocument().hasFocus()`, which in Chorus is a fact about _one
`WebContentsView`_, not about the Chorus window. Clicking into the chat tells an
editor that is fully on screen that nobody is watching it.

**There is no documented API for this.** `@codingame/monaco-vscode-host-service-override`
advertises focus management and exposes only fullscreen parameters, in both
`33.0.9` and `36.2.7`. `microsoft/vscode#126817` records Git and Explorer using
window focus as a recovery trigger, and no issue covers the multi-view embedder
case.

**There is a third route, and it is the one being built.** Found by `codex` on
2026-09-16, after both of the routes below had been written down as the only
two. Do not fake focus, and do not reverse the architecture — instead give
`BrowserHostService` an honest focus provider. The provider answers "is the
`BrowserWindow` that currently contains this `WebContentsView` focused", which
is VS Code's ordinary meaning of window focus, correctly restored for a host
where one logical window holds several documents. Clicking the chat no longer
reads as nobody watching, because the window is still focused.

**What makes it bounded rather than open-ended.** The package already has the
exact shape: `CustomBrowserHostService extends BrowserHostService` takes
`_toggleFullScreen` and `_onDidChangeFullScreen` as leading static constructor
args before the DI params, and overrides `onDidChangeFullScreen` with a getter
that composes the injected event with `super`'s. Focus slots in the same way,
beside it.

**The wrinkle codex did not have, and it changes one sentence.** Chorus does not
import `@codingame/monaco-vscode-host-service-override`, and it is not a direct
dependency — `@codingame/monaco-vscode-api` depends on it
(`pnpm-lock.yaml:4061`), so the api registers `IHostService` itself with no
params. So this is not adding a registration, it is **overriding the api's own**,
and Chorus's spread has to win. `BrowserHostService` is confirmed live in the
built bundle — ten occurrences, plus `getActiveDocument().hasFocus` twice — so
`scm-refresh.ts`'s account of the cause is correct rather than inferred.

**The change, in five parts.**

1. Add `@codingame/monaco-vscode-host-service-override@33.0.9` as a direct
   dependency. It already resolves at that exact version transitively.
2. `pnpm patch` it: `hasFocus?: () => boolean` and `onDidChangeFocus?: Event<boolean>`
   on `BrowserHostServiceOverrideParams`, threaded as constructor args 2 and 3,
   `__param` indices shifted by two, and getters that fall through to `super`
   when the input is absent. Submit the identical change upstream.
3. Main tracks the owning `BrowserWindow`'s focus per surface and pushes it to
   the view. **The subscription has to follow the handoff**, because
   `attachSurface` changes which window owns a surface.
4. The preload exposes it and `services.ts` passes both into
   `getHostServiceOverride`, spread late enough to win.
5. `scm-refresh.ts` stays until the replacement is measured, then goes. Deleting
   it first would trade a known workaround for a known bug.

**The two routes this replaces, kept because they were the honest answer until
the third was found.** Compose
the chat and the workbench in one focus-bearing document, which trades away the
native-view isolation that Preflight §4.1a chose deliberately. Or contribute a
focus-provider parameter to the CodinGame host override upstream, and wait.

**What we are not doing, and it needs saying.** Replacing `IHostService`
privately, or hardcoding `hasFocus()` to `true`. That is a lie told at the
bottom of the stack, and `scm-refresh.ts`'s own comment already argues the case
against it: every other focus-gated behaviour — autosave, dimming, third-party
extensions — would read the lie as truth.

**Measured on 2026-09-16, and `scm-refresh.ts` is gone.**

The workaround was disabled locally first, so it could not be what refreshed
anything. With a project open and the cursor in **Chorus's own composer** — a
sibling document in the same window, which is the exact state that used to park
the git extension — a file created on disk from outside the app appeared in
Source Control without the editor being clicked. The count went from one change
to two while the workbench's own document was blurred.

Two false starts are worth recording, because both looked like failures and
neither was. The first attempt showed an empty Source Control, which was correct:
the repository had no changes. The second showed nothing because the git
extension had not activated yet — opening the view is what activates it, and a
branch appearing in the status bar is activation rather than a refresh. And a
third confound was the test setup itself: driving the test from a _different
window_ blurs the window under test, so the provider correctly answered `false`
and the extension correctly parked. That is the fix working, and it reads
identically to the fix failing unless you know to look.

Removed by ownership rather than by references: `scm-refresh.ts`, `scm-gate.ts`,
`scm-gate.test.ts` and the `entry.ts` call site. Nothing else named them.

## Phase 4 — Extensions per workspace (closes C-063)

**Goal.** Installing an extension in one project stops enabling it in all of
them.

**The gallery is already correct** — `services.ts:802` points at Open VSX with
`resourceUrlTemplate` filled, for the licence reason its comment gives. Nothing
to do there.

**Per-project extension _directories_ are not possible.** `--extensions-dir` is
a server-level argument (`argv.d.ts:65`) with no per-connection variant anywhere
in the server CLI. Upstream does not support several extension directories on
one server. Chasing this is chasing something that does not exist.

**Per-workspace _enablement_ is possible and is upstream machinery.**
`ExtensionEnablementService._enableExtensionInWorkspace` and
`_disableExtensionInWorkspace` persist at `StorageScope.WORKSPACE`
(`extensionEnablementService.js:654-735`), gated on `hasWorkspace` — and Chorus
always opens a folder, so the gate is satisfied.

This reframes C-063 rather than solving it as written. One shared install set,
per-project enablement. Say so on the board when it closes.

**Also noted:** `@codingame/monaco-vscode-user-data-profile-service-override@33.0.9`
exists and is not installed. The profiles seam is available and unused. It is
only worth taking if per-project extension _sets_ turn out to matter more than
enablement, which is not established.

**Answered 2026-09-17 by reading, then proven by hand — and it needed no code.**
The three things per-project enablement depends on were all already true: the
gallery override registers the enablement service (`services.ts:124`), workspace
storage is real and keyed per project as `workspace:${workspace.id}`
(`services.ts:401`) rather than served by an IndexedDB that dies with the app, and
Chorus always opens a folder, which is the `hasWorkspace` gate upstream checks.
Disabling an extension in one project from the Extensions view held there and left
it enabled elsewhere. So the phase closes with nothing written.

What stays as it was: an install is still shared, because one REH with one
`--extensions-dir` serves every project, and `extension-scope.ts` still says so at
the moment of the install. A fresh install is therefore enabled everywhere until
someone disables it per project — deliberate, and the smaller half of what C-063
asked for.

**One risk found while reading, carried rather than closed.** A workspace id comes
from the folder URI, and a remote folder's URI carries the tunnel port in its
authority — `vscode-remote://127.0.0.1:48000/C:/…`. If that port differs between
runs the id differs with it, and everything keyed on workspace scope resets:
enablement, workspace trust, view state. How the id is computed was not read, so
this is a thing to check before leaning on workspace scope for a remote project.

## Phase 5 — Remote over SSH

**Revised 2026-09-16, after an evidence round with `deepseek`. Awaiting the user's
approval; no code yet.**

**What the evidence settled.**

1. **The server outlives its SSH session.** Win32-OpenSSH issue #1751, "Child
   processes is NOT killed on disconnect": deliberate, via
   `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, when there is no PTY (`ssh -t` kills them).
   _The source-level confirmation is unproven_ — the tracker is the evidence. So a
   remote server is not cleaned up by its session, and Phase 5 needs its own
   cleanup.
2. **Local and remote panes can coexist.** The one-authority limit is an
   assumption, not a law: `WORKBENCH_PARTITION` is used once
   (`workbench-surface.ts:216`), and the comment above the CSP call says "once" was
   fine only because there was one server. `applyWorkbenchContentSecurityPolicy`
   registers exactly three things, all on the `Session` it is passed —
   `onHeadersReceived` (`security.ts:425`), `setPermissionRequestHandler` (`:487`),
   `setPermissionCheckHandler` (`:494`). So the change is `configuredSession`
   becoming a map keyed by authority, each with its own in-memory partition.
3. **Identity comes from the token; the readback proves liveness.** The remote
   port is requested — persisted, passed as `--port <n>-<n>` — so it is not learned.
   The connection token is fresh per start, so a stale server on that port fails the
   handshake loudly. A stale server _blocking_ the port makes the child exit 1 with
   the range named, which is Phase 1's fail-closed path.
4. **The tunnel is documented and rides over short drops.** `ssh -N -L` with
   `ExitOnForwardFailure`, `ServerAliveInterval`/`ServerAliveCountMax` and
   `ConnectTimeout`. The client retries on `[0, 5, 5, 10, 10, 10, 10, 10, 30]` with
   the same `reconnectionToken`, and the server holds the session for
   `--reconnection-grace-time 30` — so a tunnel back within thirty seconds on the
   **same local port** is invisible. The tunnel's local port must therefore be
   stable too.
5. **Root paths: three sites fail loudly, the rest silently.** Loud:
   `approveProjectRoot` (`workbench-surface.ts:282-301`) and `directoryExists` at
   `project-service.ts:194,215`. Silent, and worse: `canonicalRoot`
   (`project-match.ts:34`) resolves `C:/…` against this Mac's cwd into a
   plausible wrong root, and `ide-bridge.ts:205,225`, `ipc.ts:119,926,1442`,
   `file-write.ts:102` and `edit-preview.ts:92` compare against it without
   complaint.
6. **Drive-letter casing is a platform argument, not a missing comparison.**
   VS Code lowercases the drive (`uri.js:344-346`), and `normalize`
   (`ide-protocol/src/paths.ts:95-97`) folds case only for `'win32'` — but the
   wrappers in `path-safety.ts:41-51` hardcode this Mac's platform. A remote root
   must pass `'win32'`.
7. **Upload the archive, extract on the host.** `tpa-be` is Windows 11
   (`10.0.26200.0`) with `tar.exe` present and 385 GB free. The local extraction
   patches the tree for _this_ platform (`platformKey()`, `workbench-host.ts:115`),
   so a pre-patched Windows tree does not exist here. Upload the pinned `win32-x64`
   `.tar.gz`, extract with the host's `tar.exe`, and patch `product.json` there.
8. **Auto-shutdown is a companion, not a reaper.** `--enable-remote-auto-shutdown`
   exits after a hardcoded five minutes with no clients
   (`serverLifetimeService.ts:12`), and a tunnel drop cannot start it. But it calls
   `process.exit(0)` without disposing the server (`:134-135`), so the forked
   extension hosts are orphaned — C-065's leak. Use it to bound a forgotten server,
   and still reap the tree properly.
9. **There is no seam to point Chorus at a server it did not start** — by design.
   `workbench-host.ts` reads one env var (`CHORUS_WORKBENCH_CACHE`), and
   `WorkbenchTarget` is `.strict()` on `{grant}` or `{projectId}`
   (`workbench-ipc.ts:560-564`). A hand proof needs a dev-only seam, built to be
   deleted.

**The slices, in order.**

- **5a — Prove the chain by hand.** A dev-only seam that skips the spawn and takes
  an authority and token; `configuredSession` keyed by authority; the server
  started on `tpa-be` by hand and tunnelled by hand. Proves points 1, 2, 4 and 6
  before any automation. **Needs a write on `tpa-be`**, which is Ahmad's machine.
- **5b — The agent sees the open file.** Pass `'win32'` for a remote root through
  the path wrappers so editor context is relativised correctly. This is the stated
  "done".
- **5c — A remote project identity.** `{ host, root }` in the registry, with remote
  arms in `approveProjectRoot` and `directoryExists`, and `CanonicalRoot` meaning a
  remote root where it is one.
- **5d — Chorus runs it.** Upload once per commit, extract with `tar.exe`, patch
  `product.json`, start with a persisted `--port <n>-<n>`, a fresh token and
  `--enable-remote-auto-shutdown`, and supervise the tunnel on a stable local port.
  **Correction, 2026-09-17:** the token is not fresh per start. It is persisted per
  host on this machine, mode 0600, and reused while the server it started lives, so
  a restarted Chorus reattaches instead of minting a second one. **The layout on the
  host is fixed here, because 5e matches on it:** everything lives under
  `%LOCALAPPDATA%\chorus-reh`. The tree is `<release>-<platform>`, with
  `chorus-receipt.txt` holding the installed archive's sha256. The token is
  `connection-token`, beside the trees and never inside one. The server's
  `--server-data-dir` is **`%LOCALAPPDATA%\chorus-reh\data\server`**, with
  `data\extensions` and `data\data` beside it, and its logs are `server.out.log` and
  `server.err.log`. The scheduled task is `Chorus Workbench Server`. **The remote
  server's arguments are the local set with exactly two deliberate differences:**
  `--enable-remote-auto-shutdown` is added, and `--reconnection-grace-time` is
  **120**, not 30. The local 30 is sized for a loopback `WebContentsView`, where
  only a renderer crash-reload reconnects. Over a tunnel a network drop is a real
  reconnect, and 120 covers every client retry (0, 5, 5, 10, 10, 10, 10, 10, 30 s)
  with margin while staying under auto-shutdown's five idle minutes, above which a
  longer grace buys nothing. Chosen by the user on 2026-09-17. **The tunnel's local
  port** is persisted per host on this machine, in its own range, 48000–48499, so a
  tunnel can never take the port the local server keeps in 47500–47999. Its
  stability is now a convenience, not the hard limit it was in 5a: the workbench
  session is keyed by authority since `148fce1`, so a changed port costs a fresh
  session, not a refused connection. The tunnel forwards loopback to loopback with
  `ExitOnForwardFailure` and 10 s keepalives, restarts with a backoff of 1, 2, 4, 8,
  then 15 s, which is eleven attempts inside the 120 s grace, and resets the backoff
  once it is up. It is leased per host, stops when the last remote project on that
  host closes, and `stopWorkbenchHost` stops every tunnel on quit. `rootPresent`
  answers true for a remote host by assumption, not by observation, until this slice
  replaces the assumption with the server's own answer.
- **5e — Clean up on the host.** A PowerShell reaper that kills the server's
  process tree by its `--server-data-dir` marker. **Before this is ever left
  running unattended on a colleague's machine**, not after.

**Where 5d left it, 2026-09-17.** 5d is code-complete and reviewed with a green
gate, and **not yet usable by a person.** `adoptRemote` has no caller, so no remote
project can enter the registry, and the "done" this phase states — open the project
from Chorus and have an agent answer about the open file — cannot be reached. The
5a dev seam that made a hand run possible was deleted in 5d-5, as planned, so there
is no hand path either. Closing that needs a slice not listed above: an IPC channel
for `adoptRemote`, a form for the host and the remote root, a folder chooser for the
agents' local folder, and a "check the host" step that runs the probe and shows the
platform it found. `REMOTE_SERVER_PORT` is a fixed 47500 on every host, and
officepc's 5a `ChorusREH-Proof` task may still hold it.

**The order from here, chosen by the user on 2026-09-17.** The add-remote-project
UI comes next, so the phase can be tried end to end on `officepc`, the user's own
machine. 5e comes after it and **before any server runs on `tpa-be`**, which is a
colleague's machine. `deepseek` recommended 5e first, on the grounds that the first
real use should have something to clean up after it; the user weighed that and
chose the UI, keeping 5e as the gate for `tpa-be` rather than for `officepc`.

**The add-remote-project UI, written and reviewed, 2026-09-17.** Four slices: the
`project:adoptRemote` channel, which checks the host and root before main opens the
agents'-folder dialog; `project:checkRemoteHost`, read-only on the far machine; the
form beside Add Project, two fields and a Check button; and host-aware handoffs and
grant cleanup, with `host` on the listed project. Committed as `e58c580`. The rail
carries each project's host without displaying it.

**The first real run, on `officepc`, 2026-09-17, fixed in `f165396`.** Download,
upload, `Get-FileHash` and `tar.exe` worked first time. Four faults then surfaced
and were fixed. The commit patch had to be `.cjs`, because the server tree's
`package.json` declares `"type": "module"`. Two opens of one project at once, which
React's `StrictMode` produces in dev, raced for the tunnel port, so the port is now
chosen once per host inside the shared preparation. The editor's selection never
reached a remote project's conversations, because both the context push
(`conversationsForRoot`) and the snapshot pull (`requestWorkbenchSnapshot`) looked
the project up as local, so both now go by host and root. And nothing on the remote
path was logged, so every step now logs with its host. **Verified by the user on
freshly started code:** the editor opened `C:/Users/user/chorus-reh` on officepc,
Chorus reattached to the running server, the tunnel came up in 275 ms, and an agent
saw the selected lines. One lesson from the run: `pnpm dev` did not restart main
after source edits, so a retry must be preceded by a manual restart and a start time
later than the last edit, or a stale run reads as a failed fix.

**Two folders, and what that means for writes.** An agent in a remote project runs
in its local folder on this machine. Its own `Write`, `Edit` and `Bash` act there,
never on the remote tree. What reaches the remote file is `editor_edit`, which
changes the editor's model. That tool still refuses in a remote project, because its
capability is looked up by the agent's folder; carrying `editorPlace` on the session
options is the next editor slice. Opening a file link from the conversation in a
remote project is also unsolved, because it resolves the path against the local
folder.

**Still keyed on the root alone:** `handOffExpired(deps, projectRoot)` and the
detached-access predicate `(caller, projectRoot)`. On macOS a Windows remote root
(`C:/…`) can never equal a local one (`/…`), so nothing collides today. On a
Windows build of Chorus, or once a POSIX host is allowed, a local and a remote
project with the same root string could be confused by those two, and they need the
same host-and-root treatment the handoff maps got.

**5e, reshaped in review, 2026-09-17.** Three rules decide it. **A healthy server is
never killed because a tab closed:** `releaseWorkbenchRuntime` deliberately keeps
the local server at zero leases, and remote has more reason to, since
`--enable-remote-auto-shutdown` already stops an idle server five minutes after its
last client and a remote terminal is a shell on someone else's machine. **The
unattended risk is cleaned up on the host, not from this Mac:** auto-shutdown's
`process.exit(0)` orphans extension hosts exactly when this Mac is asleep, off the
tailnet or gone, so the hidden launcher now starts the server with `-PassThru`,
waits for it to exit, then kills what descended from it and whatever still names
the server tree, sparing any server still live on our `--server-data-dir` and its
descendants, and appends one line to `server.reap.log`. The task is registered with
`-MultipleInstances Parallel`, so a new start is not ignored while an old supervisor
finishes. **Only our own is ours to kill:** a server holding a different token is
another machine, or another Chorus profile on this one, since the dev build and the
installed app keep separate `userData` and so separate tokens; the refusal says so,
and says that server stops itself five minutes after its last editor closes. The
slices: 5e-1 finds the tree read-only; 5e-2 is the supervising launcher; 5e-3 clears
the host before a start, as the local `start()` does with
`reapOrphanedWorkbenchServers()`. **Unproven, and the risk
worth naming:** only the transient launcher is proven on `officepc`. A task action
kept alive for hours is the shape the `0xC000013A` note records failing when Task
Scheduler closes its console. If it does not survive, the fallback is a host-side
task that runs the same reap every few minutes whenever no marked server is live,
at the cost of one more artefact on the host. The supervisor's read and reap run
inside a `try`, so the log always gets a line naming its outcome, `reaped …` or
`reap failed: …`. A launcher that fails outright exits non-zero, and Task Scheduler
keeps that in `LastTaskResult`, which the start's wait script already prints, so a
failure stays visible from this Mac even when no log line was written. 5e-3, as
written: before any start, when no server of ours is live, Chorus kills whatever
still names the server tree. A server of ours that is running but not listening is
treated as wedged and killed with its descendants first, instead of refusing the open.
A server under another token is still refused. If a server appears between the
status check and the clear, the start stops and asks for the project to be opened
again. A live server of ours is reattached only if it runs from this release's tree,
so a server left from before a Chorus update is replaced rather than adopted, which
would pair the new client's commit with an old server.

**5e has three slices, and quit deliberately stops tunnels only.** A fourth slice,
killing the remote server on quit, was planned and dropped in review. After a quit
the tunnel is gone, so the extension hosts end at the 120 s grace, auto-shutdown
stops the server five minutes after its last client, and the supervisor reaps what
is left. A kill on quit would only shorten that, and it would cost quit latency on
every slow or unreachable host and throw away the reattach that makes reopening
within five minutes take a fraction of a second. **Do not re-add it without a case
where a live server after quit does real harm.** The one harm found in that review,
reattaching to a previous release's server after an update, is closed by the tree
check above, which also covers a crash or an install that kills the app, where a
kill on quit never runs.

**Known gap: old server trees stay on the host.** The reaper kills processes, and
the install only ever touches its own `<release>-<platform>` directory, so each new
release leaves the previous tree behind, about 257 MB under
`%LOCALAPPDATA%\chorus-reh`. That is harmless on the hosts we know, with 847 GB free
on `officepc` and 385 GB on `tpa-be`, so this phase does not remove them. Whoever
does must hold one condition: a tree may only be removed when no server of any
Chorus profile is running from it, which is the same ownership question the token
answers for processes.

**5e proven on `officepc`, 2026-09-17, at `26e8c54`.** The old, unsupervised server
was stopped first, so the run could not reattach to it. A fresh open started server
43308 under a live `powershell.exe` launcher, with the task `Running`. After the tab
closed, the extension host exited cleanly at the 120 s grace, auto-shutdown stopped
the server at 10:50:29, and one second later the supervisor wrote
`server 43308 exited; reaped` to `server.reap.log`. It left no process referencing
the tree, the task `Ready` with `LastTaskResult` 0, and the port free. So the task
action survived about eight minutes, which was the named risk, and the fallback was
not needed. **Still unexercised:** the kill itself, because this run left no orphan
to kill.

**Phase 5's stated goal, met on `tpa-be`, 2026-09-17.** A read-only preflight found an
administrator account with an active console session, PowerShell 5.1 on AMD64, 393 GB
free and port 47500 free. From this Mac, through `ProxyJump officepc`, Chorus
installed the server under `%LOCALAPPDATA%\chorus-reh` on Ahmad's machine, started it
under the supervising task, and opened `C:/TPA-MEDEXA/MasterTPABackend` as the remote
project `MasterTPABackend`, with the agents' folder `~/code/tpa/tpa-be`. The status bar
showed branch `procedure-axes-info` and Source Control his four changes. An agent then
answered about `CreateRecordNoteCommand.kt` lines 4–11, quoting the selection
correctly. **The installed app ran it too**, the same day, from its own data
directory and therefore its own registry, token and server tree — so the packaged
build is no longer the untested half of this. Ahmad's machine now holds that server
tree and the `Chorus Workbench Server` task, and he should be told.

**The agent's edits reach a remote file, from `7a05e73`.** A session carries the
place its project is in — host and canonical root, read from the registry where the
session options are built — and `requestWorkbenchEdit` matches both, so an edit goes
to the surface on that host rather than to whichever pane held a matching path. A
local project is unchanged: with no place, the adapter falls back to the working
directory, which for a local project _is_ the root.

Three things it deliberately leaves standing. **Editor edits are Claude's only**,
because `editor_edit` is an in-process MCP tool of the Claude SDK and the Codex
app-server has no editor tool to mount — a Codex agent in a remote project writes
through its own sandbox, into the agents' folder on this Mac. **`requestWorkbenchAskDiff`
stays root-only**, so a diff card in a remote project finds no surface and shows
nothing; that is the designed degradation its own comment allows, not a defect, and
it is written down here because nothing else said it. **The local sentinel is spelled
twice** — `''` in `packages/adapter-claude/src/claude-adapter.ts` and `LOCAL_HOST` in
the store — and the two must stay equal; the adapter cannot import from the store
without inverting the layering, so a note is the whole fix.

**What this still does not cover:** file links in the conversation do not open remote
files.

**Still unproven, and carried as such.** The source-level Win32-OpenSSH behaviour.
How auto-shutdown's orphaned extension hosts behave on Windows specifically. Whether
`Register-ScheduledTask` works unelevated: it ran elevated on `officepc`, and
`tpa-be` may not grant that. Whether `-LogonType Interactive` can start at all on
`tpa-be`: it needs a logged-on session, `officepc` has auto-login and `tpa-be` may
be logged out, and that failure reads as a start timeout, not as a refusal.

---

**The draft this revision replaced — kept for what changed.**

**Draft, 2026-09-16 — to be attacked with evidence before any code.**

**Goal, in the user's words.** Open `tpa-be` → `C:/TPA-MEDEXA/MasterTPABackend`
as a Chorus project, with no VS Code, from home or the office. The editor runs on
that machine. The agents see what is open in it, as they do for a local project.
**Done** when that project opens from Chorus and an agent can answer about the
file in front of the user.

**Decided with the user.**

- First target is `tpa-be`: Windows, PowerShell 5.1, Ahmad's working tree.
- Reach is solved. `ssh tpa-be` jumps through `officepc`, verified end to end on
  2026-09-16. Nothing changed on Ahmad's machine.
- **No local copy of the backend.** When the connection is down, nothing can be
  edited. Accepted as the cost of keeping that rule.
- Chorus uploads the server itself, as VS Code does.
- A remote project is a host plus a path — the same two parts as
  `vscode-remote://ssh-remote+tpa-be/C:/TPA-MEDEXA/MasterTPABackend`.
- Agents keep editing with their own `ssh` commands for now. Reading editor
  context is in scope. Editing through the editor is undecided.

**Evidence already in hand.**

1. **The matching Windows server is already pinned.**
   `build/workbench-runtime.json` carries `win32-x64`, commit
   `987c9597516278c9fcf10d963a0592ce1384ab93`, quality `stable` — the same pair
   the client speaks. No new artifact is needed.
2. **The CSP accepts a tunnel.** `security.ts:133` admits any
   `^[A-Za-z0-9.\-[\]:]+:\d+$`, so a forward's local end, `127.0.0.1:<port>`, is a
   valid authority as it stands.
3. **A project is a local folder today.** `approveProjectRoot` canonicalises on
   this disk, `project-service.ts:77` requires `statSync(path).isDirectory()`, and
   the registry looks projects up by `canonicalRoot` (`:115`). A Windows path on
   another machine passes none of those.
4. **Agents are given a local `cwd`** (`runtime.ts:316`, `:339`, `:1361`, and both
   adapters). A remote project has none.
5. **One surface, one runtime.** `openSurface` calls
   `acquireWorkbenchRuntime(projectRoot)` at `workbench-surface.ts:894`, which is
   the single shared local server.

**The shape, as a draft.**

- A remote project identity, `{ host, root }`, stored beside local projects and
  never canonicalised against this disk.
- A remote runtime per host. Over `ssh`: ensure the pinned `win32-x64` server is
  on the host, cached by commit so it uploads once; start it bound to
  `127.0.0.1` on the host, with `--port <n>-<n>` and a fresh connection token; read
  the port back from that server; then hold `ssh -N -L <local>:127.0.0.1:<remote>`
  open. The authority is `127.0.0.1:<local>`.
- `openSurface` picks the local lease or the remote runtime by project kind.
- Editor context reaches the agents with remote paths.

**Open questions — each needs proof, not reasoning.**

1. **Does a process started over OpenSSH on Windows survive the session ending?**
   If the session's job object takes it down, the server needs a documented way to
   outlive it — and that decides everything about lifetime and cleanup.
2. **How is "never attach to a port Chorus did not open" kept** when the server
   runs detached on another machine and its stdout is not Chorus's to read?
3. **The workbench partition is one constant, and its CSP is built with one
   authority** (`:1009` of `workbench-host.ts`). Would a remote pane's
   `127.0.0.1:<tunnel>` be refused by `connect-src` while a local pane is open?
   If so, local and remote panes cannot coexist, and that is a design constraint.
4. **How deep does "root is a local path" run?** The event store, the permission
   engine (`resolveWithinRoot`), `projectRelativePath`, agent `cwd`. Which break for
   a remote root, and which only need a different identity?
5. **Do editor-context paths survive a Windows root?** A `vscode-remote://` path
   for `C:/…` is `/c:/…`, and the relativising was written for POSIX roots.
6. **Tunnel supervision.** How main holds `ssh -N -L` through a `ProxyJump`,
   notices it dropping, and reconnects — and what the workbench sees meanwhile.
7. **Upload and unpack on the host.** Whether `tar.exe` is present under
   PowerShell 5.1 there, and whether the product-commit patch
   (`patchProductCommit`) is applied to the remote copy or shipped pre-patched.

**What this phase is not doing.** Microsoft's Remote-SSH, or `open-remote-ssh` as a
resolver — both ruled out below. A local copy, or file sync. Agents editing through
the editor. Linux or macOS hosts, until Windows works.

---

**Background: why this route.** Kept from the research round.

**The Microsoft extension will never work and is not the route.**
`ms-vscode-remote.remote-ssh` is proprietary and licensed to official VS Code
builds. Chorus embeds Code-OSS.

**Neither open alternative works as a resolver here, and the reasons differ.**
The browser `ExtensionService._doResolveExtensions` returns early unless
`expectsResolverExtension`, then filters `_scanWebExtensions()` for an
`onResolveRemoteAuthority:*` activation event and resolves on
`ExtensionHostKind.LocalWebWorker` (`extensionService.js:145-176`). A resolver
here must be a **web** extension. `xaberus/vscode-remote-oss` has `main` and no
`browser` entry, so it is structurally excluded. `jeanp413/open-remote-ssh` has
a `browser` entry and declares `onResolveRemoteAuthority:ssh-remote`, so it is
structurally eligible, but it depends on `ssh2`, `socks` and `simple-socks`,
which are Node-only. _That it therefore fails is inference from its dependency
list, not a documented statement_ — see open questions.

**The route that needs no resolver at all.** `_doResolveAuthority` builds
`new WebSocketRemoteConnection(host, port)` straight from the authority string
and takes the token from the construction options. So Chorus can point its one
authority at an REH running on the remote machine, reached through an `ssh -L`
tunnel. That is precisely the model `vscode-remote-oss`'s own README documents,
and it is the honest answer to the request.

**The cost, and it is real.** There is one authority, so a window is local or
remote, never both. And the remote REH's commit must match the client's, which
`assertMatchedPair` would have to be extended to cover — a remote box will not
happen to be running the artifact Chorus pinned.

## Phase 6 — `33.0.9` → `36.2.7`

**Goal.** Stop being three majors behind.

**This fixes none of the above, and that is the finding.** Across the tagged
comparison `v33.0.9...v36.2.7`, `remoteAgent.ts`, `scm.ts`, `extensions.ts`,
`host.ts` and `lifecycle.ts` are **unchanged**. Only `files.ts` changed, and its
changes are stream error handling, `readFileStream` delegation and an HTML
filesystem provider. No watcher fix, no authority fix, no focus fix, no
lifecycle fix.

`33.0.9` embeds VS Code `1.121.0` and Monaco `0.55.1`; `36.2.7` embeds VS Code
`1.128.1` and Monaco `0.56.0`. `34.0.0`, `35.0.0` and `36.0.0` each declare a
breaking jump.

**So do it last and do it alone.** Advance every `@codingame/monaco-vscode-*`
package together, rebuild against Monaco `0.56.0`, and repatch the VSCodium REH
to the matching client commit. Bundled with a behaviour change, a regression
would have two candidate causes.

**The finding above compares the wrong surface — corrected 2026-09-17.** It reads
VS Code's own sources across `v33.0.9...v36.2.7` and concludes the upgrade changes
nothing we depend on. The packages we actually call are the **overrides**, whose
APIs are written by CodinGame and are not in VS Code's tree at all, and diffing
those found two breaking changes the source comparison could not see. There is a
third surface the first pass missed as well — **our own patch of a dependency**,
which no comparison of published versions can show, because the thing it changes
exists only in this repository's `patches/` directory.

**What the enumeration found, 6-1, by reading the registry and the tarballs.** All
86 `@codingame/*` packages publish `36.2.7` — nothing renamed, merged or dropped —
and `36.2.7` is the highest version the whole set shares, since 43 of them are
already at `37.0.0` and 43 are not. The `./vscode/*` export map is identical at both
versions, all 23 deep import paths still resolve, and every named import survives.
`monaco-editor` needs no change: nothing in the API packages pins it, and the bump
in fact removes today's skew, because `33.0.9` embeds Monaco `0.55.1` against the
`0.56.0` the shell already ships.

The two that break:

- **`BrowserStorageService` gains `forcedValues` as its second positional
  parameter.** `services.ts` constructs `ChorusStorageService` positionally through
  a `SyncDescriptor`, whose argument array is untyped, so after the bump
  `STORAGE_DATABASES` lands in `forcedValues`, `databaseFactories` is `undefined`,
  and every scope silently falls back to the IndexedDB that dies with the app —
  the exact bug `storage.ts` was written to prevent, and typecheck cannot see it.
- **Phase 3's focus fix was a patched dependency, and the patch is pinned to
  `33.0.9`.** This was read wrong at first — as `36.2.7` deleting `hasFocus` and
  `onDidChangeFocus` from `BrowserHostServiceOverrideParams`. The published package
  never had them: `patches/@codingame__monaco-vscode-host-service-override@33.0.9.patch`
  added both, and `pnpm install` refuses the bump with `ERR_PNPM_UNUSED_PATCH`
  rather than carrying it forward, which is the loud failure that corrected the
  reading. So the upgrade had two routes — reproduce the patch against `36.2.7`, or
  retire it — and the second is taken: a `ChorusHostService` subclass on the
  `IHostService` key, the shape `clipboard.ts` already uses, with its "no
  constructor, DI metadata is inherited" note applying unchanged. The behaviour is
  the patch's own: both the window event and the base's event fire the value
  `hasFocus` computes at that moment, latched, because `hasFocus` is the single
  source and the two arms only differ in when they notice. The patch's hardest-won
  line survives too — `BrowserHostService`'s constructor calls `registerListeners()`,
  which reads `this.onDidChangeFocus` while `super()` is still running, so the
  composition cannot live in an instance field; the patch used a readiness flag and
  the subclass uses a module-level `WeakMap` keyed on the instance.

The other 31 overrides we import are called without arguments and their public
types are **identical** at `36.2.7`. Their runtime files moved, as seven VS Code
minors would predict — `terminal` moved its telemetry file into
`terminalContrib/` and gained a sandbox runtime, `extensions` gained three
`mainThread*` files — but nothing there is reachable through an API we call.

**Parked 2026-09-17 on `phase-6-vscode-36`, blocked outside this repository.** The
client is only half of a pair. `@codingame` and VSCodium publish against different
subsets of VS Code, and above `1.121` the two sets do not intersect at all:

| `@codingame` | VS Code  | VSCodium release for it |
| ------------ | -------- | ----------------------- |
| `33.0.9`     | `1.121.0`| `1.121.03429` — ours    |
| `34.x`       | `1.124.2`| none                    |
| `35.x`       | `1.128.0`/`1.128.1` | none         |
| `36.x`       | `1.128.1`| none                    |
| `37.0.0`     | `1.138.0`| none                    |

VSCodium's releases either side are `1.126.04524` and `1.135.06055`; all 272 were
checked and no `1.128` exists. `assertMatchedPair` refuses to patch a server whose
`upstreamCommit` is not the client's commit, and that check is not pedantry: the
commit patch exists to fix VSCodium's sha-of-its-own-version quirk, not to bridge
a version gap. So 6-3 cannot be written — not because the manifest is hard to
regenerate, but because there is no release to point it at.

The branch keeps `15fec11` and `20e90ac`, and `main` stays at `33.0.9`, which is
the one version where client and server actually agree. What would unblock it is
a VSCodium release whose upstream is `1.128.1`, or a `@codingame` release built on
`1.126` or `1.135`. Neither is ours to cause, so this waits rather than being
worked around — the alternative on the table was loosening the matched-pair check
and running a `1.128.1` client against a `1.126` server, which is the exact thing
that check was written to forbid.

## What we are deliberately not doing

- **Not rewriting canonical URIs.** Tried and reverted on 2026-08-30; it fixed
  trust and emptied the file explorer, because canonical URIs are consulted far
  beyond the trust service. Phase 1 removes the need.
- **Not calling `_setResolvedAuthority`.** The public name does not exist; the
  underscore method is an internal VS Code seam, and using it is the
  guessed-shape failure one level up.
- **Not lying about focus.** See Phase 3.
- **Not enabling workspace trust to "fix" anything.** It is already off, and the
  decision to keep it off is a security-model question about VS Code's own
  executors — tasks, debug, terminals — which Chorus's permission engine does
  not govern. That is worth revisiting on its own terms, not as a stability fix.
- **Not tuning the file watcher yet.** There is no documented "known-good large
  local REH" preset. The supported procedure is Trace logging on the remote
  `Server` output first, then exclusions. Tuning before measuring would be
  guessing.

## Needs a decision

**Port strategy — decided 2026-09-16: persisted first-free.** Pick a free port on
first run, save it, reuse it forever. Fails closed rather than falling back,
because a silent fallback restores the churn Phase 1 removes.

**A minimised Chorus may keep painting — decided 2026-09-16: yes.** Phase 2's
fix turns background throttling off for a workbench surface, and Electron's docs
say one webContents doing that draws frames for the whole window. The upside is
that a background project's terminal and agents keep running, which is the
behaviour Chorus already promises. The cost is battery while minimised, and it
is accepted deliberately rather than by omission.

**Phase 3's route: one document, or wait on upstream?** Same-document
composition is a large architectural reversal of Preflight §4.1a. Waiting means
`scm-refresh.ts` stays indefinitely. There is no third option that is not a lie.

## Open questions

- ~~**Does reparenting a `WebContentsView` between windows kill the renderer
  realm?**~~ **Answered 2026-09-16 by running the probe. No, but it hides it.**
  See Phase 2.
- **Who calls `WasHidden()` on the macOS detach path?** Electron's own handlers
  do not: `View::RemoveChildView` calls only the native remove, and both
  `OnViewAddedToWidget` / `OnViewRemovedFromWidget` do owner-window and
  draggable-region bookkeeping. `views::WebView` does not override
  `VisibilityChanged`. The caller is somewhere in Chromium's Views-to-content
  bridge and was not located. **It does not block Phase 2**, because the flag has
  only three writers and none of them can be reached without `WasHidden()` — but
  it is open, and it is written as open rather than filled with a guess.
- **Is a crashed-and-respawned surface ever left stuck page-hidden?**
  `RendererExited()` sets `is_hidden_` outside the `WasHidden`/`WasShown` pair,
  and `HandleNewRenderFrame` cannot clear it. But its own comment says the flag
  is set so the renderer has correct visibility "when respawned", which suggests
  the respawn path handles it, and nobody has observed a stuck surface. Phase 2's
  runtime assignment is an explicit `WasShown()` for this state, and it only runs
  on attach — a crash does not cause one. `render-process-gone` is where a real
  fix would go, if the state turns out to be reachable at all.
- ~~**Does `View::SetVisible(false)` reach `WasHidden()`?**~~ **Answered
  2026-09-16: yes, and the guard covers it.** The chain on macOS is
  `View::SetVisible` → `NativeViewHost::VisibilityChanged` →
  `native_wrapper_->HideWidget()` → `RenderWidgetHostViewMac::Hide()`
  (`render_widget_host_view_mac.mm:552-562`) → `WasOccluded()` (`:618-624`,
  literally `if (host()->IsHidden()) return; host()->WasHidden();`) →
  `RenderWidgetHostImpl::WasHidden()`, which is exactly the guarded function.
  Chromium's own comment in `NativeViewHost::ViewHierarchyChanged` names the
  mechanism, speaking of "spurious visibilitychange events for web contents of
  `WebView`" during reparenting. Aura is identical and Electron's patch guards
  its call site too. The run confirms it independently: `detached=hidden` means
  `is_hidden_` became true, its only live writer is `WasHidden()`, so the detach
  funnels into the guarded function. **So a surface hidden by `applyVisibility`
  is not drawn but is no longer page-hidden.** That is the trade in full, not a
  partial fix.
- **Would a reconnection token replayed from a fresh realm be accepted
  end-to-end**, given the protocol state the server would resume against?
  Unverified.
- **Does `open-remote-ssh`'s browser bundle actually load without Node?** The
  dependency list says no; nobody has loaded it.
- **Why do search results also go missing?** A remote text search is a fresh
  remote operation, not a watcher consumer, so watcher loss does not explain it.
  Either the connection was gone — which supports Phase 2 — or there is a second
  cause nobody has found.
