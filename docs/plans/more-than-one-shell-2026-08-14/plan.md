# More than one shell, and one of them can be killed

**Date:** 2026-08-14

**Scope**, and the first revision of this plan under-declared it badly enough
that two blockers hid in the gap:

- **main** — `terminal.ts`, `runtime.ts`, `ipc.ts`, `open-sessions.test.ts`,
  `terminal.test.ts`
- **shared** — `ipc.ts`, `workspace-layout.ts`, `ipc.test.ts`
- **preload** — `index.ts`
- **renderer** — `TerminalPanel.tsx`, `TerminalView.tsx`, `Session.tsx`,
  **`App.tsx`**, **`terminal-stream.ts`** and its test, `focus.ts`,
  `workspace/{store,layout,hooks,Workspace}.tsx`, `i18n/en.json`, `styles.css`
- **e2e** — `specs.mjs`

Unit tests land **with** the phase that needs them, in each of Phases 0–4.
Phase 5 is the e2e phase and nothing else.

**Depends on:** `a-terminal-in-every-session-2026-08-12`, whose §7 parked exactly
this and said the shape did not foreclose it. This plan is the test of that claim.

---

## The problem

A session gets one shell and the global panel gets one shell, and that is the
whole allowance. Run `pnpm dev` in a session's terminal and there is nowhere to
run `git status` — you either kill the dev server or leave the app. The panel's
only control is **Hide**, which stops you looking at the shell and does nothing
to the shell, so there is no way to end a terminal at all short of typing `exit`
into it or closing the conversation.

Both halves were deliberate. The original plan's §7 reads:

> **One terminal per scope.** One global, one per session. VSCode's
> several-with-a-picker means each slot in §4.0 holding a list, and a strip
> inside each panel — contained, and nothing here forecloses it.

It is now foreclosing something, so it goes.

## What is already built, and it is more than it looks

Two things exist end to end and are called by nothing:

- **`terminal:describe`** returns `{ running, foreground, busy }` and is wired
  from `TerminalService.describe` (`terminal.ts:321`) through
  `runtime.describeTerminal` (`runtime.ts:2268`), `ipc.ts:168` and
  `preload/index.ts:76` to `window.chorus.describeTerminal`. **No renderer code
  calls it.** It was built in Phase 1 to answer the original plan's open question
  4 — "what happens to a shell with a live child when you end the session" — and
  has been dead since, because the answer needed a kill button and there was
  none.
- **`terminal:dispose` / `disposeIfCurrent`** (`terminal.ts:356`) is the
  epoch-guarded kill, written for "a stale click from a view that has already
  been replaced". Also called by nothing in the renderer.

So the kill path is not new work, it is unfinished work. What is genuinely new is
the roster: several shells per panel, and something on screen to choose between
them.

One piece of dead code goes the other way. `terminalKey(ref)` (`terminal.ts:171`)
is exported, flattens the union to a string, and is called by nothing. It is the
exact move §4.0 argued against. **Delete it** rather than reach for it when the
map gains a level.

## 1. Identity: the union gains an id, storage gains a level

`TerminalRef` is a discriminated union and §4.0 spent a page on why it must not
become a string key. That argument survives multiplicity unchanged — it only
needs one more field:

```ts
export type TerminalRef =
  | { readonly scope: 'global'; readonly id: string }
  | { readonly scope: 'session'; readonly conversationId: string; readonly id: string }
```

and storage gains a level rather than a parser:

```ts
private readonly globals = new Map<string, Session>()
private readonly bySession = new Map<string, Map<string, Session>>()
```

The tempting simplification — one `Map<string, Session>` keyed by
`terminalKey(ref)` — is the thing §4.0 refused, and it costs more now than it did
then, not less: `disposeSession(conversationId)` has to kill _every_ terminal of
one conversation, and with a flat map that is a scan that parses ids to decide
what it is holding, run on the path where getting it wrong kills the global
terminal. With two levels it is `this.bySession.get(conversationId)` and a loop
over an inner map that structurally cannot contain a global shell.

`close()` (`terminal.ts:372`) drains both levels. Everything else in
`TerminalService` — `attach`, `ack`, `pace`, `absorb`, `drain` — is already
per-`Session` and does not change at all, which is the real evidence that §4.0
picked the right seam.

### 1.1 The id has to reach the renderer's router, and revision 1 missed this

Adding a field to the type is the easy half. The **renderer decides which pushes
are its own**, and it decides on scope and conversation alone:

```ts
// terminal-stream.ts:12 — today
export function sameTerminal(a: TerminalRefShape, b: TerminalRefShape): boolean {
  if (a.scope === 'global') return b.scope === 'global'
  return b.scope === 'session' && a.conversationId === b.conversationId
}
```

Two sibling tabs in one session are the _same terminal_ by this function. The
output channel is a broadcast — its own comment says so — so terminal 2's output
would print into terminal 1's screen, and terminal 2's `exit` push would mark
terminal 1 dead. `shouldApply` would filter on epoch and catch _some_ of it by
accident, which is worse than catching none: the bug would be intermittent.

`TerminalView` has the matching hole. It rebuilds the ref from two values and
depends on two values:

```ts
const scope = terminal.scope
const conversationId = terminal.scope === 'session' ? terminal.conversationId : null
// …
}, [scope, conversationId, onExit, onReady])
```

Switching between sibling tabs changes neither, so the effect does not re-run,
so the component keeps the shell it already had. The panel would show tab 2
selected and tab 1's shell underneath it.

Both fixes are small and both are **Phase 1, not Phase 3** — they are part of
what "the id joins the union" means, and shipping the id without them is shipping
a latent misrouting that only appears once there is a second tab to misroute to.
`TerminalView` takes `id` into the reconstruction and the dependency array,
**and** gets a `key={id}` from the panel, so a sibling switch is a remount rather
than a re-render that has to notice.

**Identity is the whole tuple, and `id` is added to it rather than replacing
it.** For a session terminal that is `(scope, conversationId, id)`; for a global
one, `(scope, id)`. An earlier draft of this section said the conversation
comparison becomes redundant once ids are UUIDs — **that is wrong, and it is
wrong in the phase that introduces it.** Phase 1 deliberately mints _one constant
id per scope_, so during Phase 1 every session's terminal carries the same id
string, and a `sameTerminal` that dropped `conversationId` would treat every
session's terminal as every other's. It would ship a cross-session misrouting to
fix a cross-tab one.

Nor does the UUID assumption hold afterwards. `TerminalRefShape` types `id` as
`z.string()`, the persisted roster is user-editable JSON, and a repaired
workspace (§4) can mint whatever it needs to. Identity is what the comparison
checks, not what we hope the generator produced. So: keep the existing scope and
conversation comparison exactly as it is, and add `id`.

The tests are the point of the phase: a push for `id: 'b'` applied to a view
attached to `id: 'a'` **in the same conversation**, and the same for `exit` —
because cross-conversation was already covered and is not the case that breaks.
`terminal-stream.test.ts` exists and is pure, so this costs nothing to prove.

## 2. Who owns the roster, and the answer is the renderer

Main has never known that a panel is open. `attach` is the first it hears of any
terminal and it spawns the shell then, lazily, "so a user who never opens the
global panel never pays for a shell". Nothing pushes a list of terminals in
either direction today.

The roster — which tabs exist, in what order, which one is active — is **view
state**, and the renderer already owns and persists exactly that kind of thing in
the workspace snapshot. So: **the renderer mints the ids and owns the list; main
stays lazy and is keyed by whatever ref it is handed.**

The alternative, main owning a roster and pushing it, would add a push channel, a
second source of truth for tab order, and a synchronisation problem in a
direction that currently has none. It buys nothing, because the thing it would
guarantee — that every tab has a live shell — is not true and should not be:

- A tab restored from a relaunched workspace names a shell that does not exist.
  `close()` kills everything on quit and always has.
- A tab whose conversation ended names a shell `disposeSession` already killed.

Both are true **today**, for the single terminal, and both already behave
correctly: `attach` spawns on demand, `describe` returns `null`. Several
terminals does not create this problem, it only makes it plural.

**Ids are `crypto.randomUUID()`, not a counter.** The layout file outlives the
process, so a counter that resets on relaunch reuses ids, and a reused id makes a
restored tab attach to a shell a different tab is already attached to. The
_display_ number — "Terminal 2" — is a position in the roster, computed on render
and never stored, so killing the first tab renumbers the rest the way it does
everywhere else.

**A tab is `{ id }`, an object, not a bare string.** Not speculative generality:
every field added later is defaulted and therefore cheap (§4), but changing an
array's _element type_ from `string` to an object is the migration that is not.
One field now is the shape that extends.

## 3. Only the active tab mounts

**Revision 1 argued this from `epoch` and the argument was wrong.** It claimed
mounting every tab would put several attachments on one shell and that the second
would supersede the first. It would not: each tab has a **distinct ref** and
therefore its own `Session` in main, so mounting all of them is one attachment
per shell, which is exactly what `epoch` is written for. Nothing about
flow control breaks. Recorded rather than quietly deleted, because the plan being
wrong about the mechanism it is built on is the kind of thing worth leaving a
scar over.

The real reasons are smaller and sufficient:

- **A detached shell is paced by the mirror alone, and that is deliberate.**
  `absorb` only queues output when `session.attached` (`terminal.ts:484`), and
  `pace` counts unacked output "only while something is attached". Mounting eight
  tabs makes eight shells push over IPC continuously so that seven invisible
  xterms can render output nobody is looking at — on the thread where
  better-sqlite3 is synchronous and every agent delta already passes through.
  Backgrounding a terminal is what makes it cheap, and that property is worth
  keeping.
- **Eight xterm instances is eight canvases and eight 5,000-line buffers** in the
  renderer, for one visible terminal.
- **It is the pane rule one level in**, so there is one story about what
  "background tab" means rather than two.

Remounting is close to free by construction: the headless mirror in main is the
source of truth and `attach` returns the screen as escape sequences, which is the
entire point of §4.4. Switching tabs costs one `serialize()` and one `term.write`
of the result — the same thing that already happens on every pane tab switch.

## 4. The persisted shape, and the loudest trap in the file

`TerminalPanelState` (`workspace-layout.ts:60`) gains two fields:

```ts
export const TerminalTab = z.object({ id: z.string() })

export const TerminalPanelState = z.object({
  open: z.boolean().default(false),
  height: z.number().default(TERMINAL_HEIGHT.default),
  tabs: z.array(TerminalTab).default([]),
  activeId: z.string().nullable().default(null),
})
```

**Both new fields are defaulted, and this is the single highest-risk line in the
change.** The file's own comment says why, in terms that should be read again
before touching it:

> `parseOpenSessions` falls through to a legacy bare-array parse when this schema
> fails, and that fails too — so it returns `{ sessions: [] }` and **every open
> conversation is silently lost**, not merely the layout. A required field here
> would do that to everyone who upgraded, once, with no error anywhere.

A required `tabs` would do exactly that. There is no error surface anywhere on
that path; the symptom is that the app opens empty and the person's sessions are
gone.

**The invariant, enforced in one place.** An open panel has **at least one tab**,
every tab id is **non-empty and unique within its panel**, and **`activeId` names
one of them**. A workspace written before today has `{ open: true, height: 212 }`
and no tabs, which must mean "one terminal", not "an open panel showing nothing".

`normalizeWorkspace` (`layout.ts:83`) is where all of it goes, and it is already
doing three of these four things for _pane_ tabs a few lines down: it dedupes
with a `seenTabs` set, drops a leaf whose tabs all vanished, and repairs an
`activeTabId` that is not in the list by falling back to the nearest index. The
terminal roster gets the same treatment from the same function.

**Uniqueness is repaired, never rejected**, and the distinction matters more here
than it looks. `z.string()` accepts `''` and accepts the same id twice, and two
tabs sharing an id both address **the same PTY** — so killing one kills the
other's shell while leaving its tab on screen, pointing at nothing. Tightening
the schema to reject that is the obvious move and it is the wrong one: a rejected
`WorkspaceSnapshot` takes the whole file down the legacy path and **loses every
open conversation** (§4's warning, which applies to a stricter schema exactly as
it applies to a required field). So the schema stays permissive and the
normalizer drops duplicates and empties, minting a fresh id if a panel is left
with none.

No component then has to handle the empty case, the duplicate case or the
dangling-`activeId` case, and the migration is one function rather than a null
check in four.

The conversation-pruning at `layout.ts:565` and `store.ts:423` is untouched: it
drops the whole panel entry for a conversation that no longer exists, and a panel
entry now happens to contain a list.

### 4.1 None of it persists today, and that is a bug in the shipped app

Found while reviewing this plan, and it invalidates Phase 4 of the original
terminal plan — the one titled "Persistence".

`workspaceSnapshot` includes `terminals` and `globalTerminal` (`store.ts:196`),
and the debounced subscription in `App.tsx:255` writes them. But the
subscription's `equalityFn` lists six fields and **neither terminal field is one
of them**:

```ts
equalityFn: (left, right) =>
  left.hydrated === right.hydrated &&
  left.layout === right.layout &&
  left.panes === right.panes &&
  left.focusedPaneId === right.focusedPaneId &&
  left.sidebarHidden === right.sidebarHidden &&
  left.sidebarWidth === right.sidebarWidth,
```

A change to terminal state alone compares **equal**, so the listener never fires
and nothing is written. Opening a panel, resizing it, and — after this plan —
adding or killing a terminal, all land in the store and stay there.

The reason nobody noticed is the reason it is nasty: the other two write paths
(`reorder` at `App.tsx:502`, `commitLayout` at `:717`) both send the _whole_
snapshot, so terminal state persists as a **side effect of the next unrelated
layout change**. Drag a pane, resize the sidebar, reorder a session, and the
terminal panel you opened an hour ago is saved along with it. So the behaviour is
"sometimes it works", which is why `Session.tsx:1260`'s comment reasons carefully
about which debounce applies to the terminal height and is describing a code path
that does not run.

This plan makes it much worse than a panel opening at the wrong height. A killed
terminal that comes back after a relaunch, or a new one that vanishes, is a
correctness bug in the feature being asked for. So it is **Phase 0**: it stands
alone, it is a one-line fix plus a test, and it is shippable before any of the
rest of this.

## 5. Kill and Hide are different buttons, in different places

This is the half that was actually asked for, and the failure mode is one glyph
meaning two things.

| control               | where                  | what it does                   |
| --------------------- | ---------------------- | ------------------------------ |
| `×` on a **tab**      | the strip              | **kills that shell**           |
| `×` in the **header** | top right, where it is | hides the panel; kills nothing |
| `⌘J` / `⌘⇧J`          | anywhere               | hides the panel; kills nothing |

The header `×` keeps `terminal.hide` as its accessible name and keeps the comment
explaining why it is a mark rather than the word. A tab's `×` needs its own
string, and "Kill" is the honest one — VS Code says "Kill Terminal" for the same
reason.

**Confirm only when busy**, using the thing built for it. `describe()` reports
`busy` as "something other than the shell itself is in the foreground", so an
idle `zsh` dies on the click and a `pnpm build` or an `ssh` asks first, naming the
process. `ConfirmSessionAction.tsx` is the precedent component and the voice to
match. The alternative — always ask — is the friction people learn to click
through, which makes the confirmation worthless on the one occasion it matters.

**The epoch problem, and it is real.** `disposeIfCurrent(ref, epoch)` needs the
epoch of the currently attached view, and a background tab has no attachment and
therefore no epoch to offer. Three ways out, and the third is right:

- Let `terminal:dispose` take a nullable epoch. Weakens a guard on the least
  recoverable operation in the app, for every caller, to serve one.
- Make a background tab's `×` activate it first. The tab you meant to kill
  becomes the tab you are looking at, briefly, and then dies. Ugly and racy.
- **Add `terminal:kill`, carrying a ref and no epoch**, whose contract says who
  may call it: a mounted tab strip acting on a user's click. The epoch guard
  exists to stop a _superseded `TerminalView`_ acting after it has been replaced;
  a tab strip is a different actor with a different lifetime, and it is mounted
  at the moment of the gesture. `disposeIfCurrent` stays for the attached case
  and its comment stays true.

**The kill lands before the tab goes, and the store action is not called
`killTerminal`.** Two halves of one mistake.

The store cannot kill anything — the PTY is in main, and a store action that
removes a row from a list is `removeTerminalTab`. Naming it `killTerminal` would
read, at the only call site that matters, as though it had done the killing, and
that is precisely the confusion that made `detach`-versus-`dispose` worth a
section of the original plan.

The ordering follows: **`await` a successful `terminal:kill`, then
`removeTerminalTab`.** Removing the row first and firing the IPC after leaves an
orphan on any failure — a shell still running, still holding its cwd and its
child processes, with nothing on screen that can reach it and no way to kill it
short of quitting Chorus. Awaiting means a failed kill leaves the tab where it
is, which is recoverable and legible. A shell that has _already_ exited is not a
failure case: `dispose` on a dead session is a no-op that still forgets it.

**Closing the last tab hides the panel**, because an open panel with no tabs
violates §4's invariant and there is nothing to show. `⌘J` then reopens it with a
fresh terminal.

**An exited shell keeps its tab** until dismissed, marked with its exit code. The
panel already prints `[process exited with code N]` and shows a label rather than
going blank; a tab that vanished on exit would take the last lines of a failed
build with it. The tab is then a dead slot whose `×` removes it, and whose `×`
does not need to confirm because there is nothing to lose.

### 5.1 Which needs an exit code main does not currently keep

"Marked with its exit code" is not implementable against today's main, and this
is the third thing revision 1 asserted without checking.

`exit` is a **one-shot push**. `Session` in main records `exited: boolean` and
throws the code away (`terminal.ts:455`); `TerminalAttachment` does not carry it;
`TerminalDescription` reports `running` but not why it stopped. So a shell that
exits **while its tab is in the background** — which is now the common case, since
only the active tab is mounted — emits its push to a view that is not there, and
there is no way to learn the code afterwards. Reopen the tab and it looks alive.

The renderer half has the mirror-image defect. `TerminalPanel` holds **one**
`exited` state for the whole panel (`TerminalPanel.tsx:44`), so with tabs it would
show terminal 1's exit code above terminal 2's live shell, and never clear.

So:

- Main keeps `exitCode: number | null` on the session and returns it from
  **both** `attach` and `describe`. A dead shell then explains itself to a view
  that arrives late, which is the same argument as the snapshot: the mirror
  outlives the view, and so should the reason it stopped.
- The renderer keeps exit status **keyed by terminal id**, in the panel beside
  the roster rather than in a single `useState`. The live push updates it; the
  `attach` response seeds it for a tab being opened for the first time since it
  died.

This is Phase 1 work for the main-side field and Phase 3 work for the keying,
and it is the reason `attach`'s response shape changes in Phase 1 rather than
later.

## 6. Chords

`⌘J` and `⌘⇧J` do not change. They toggle a panel; they have never killed
anything and must not start.

**New terminal in the focused panel: ``⌃⇧` ``**, which is what VS Code binds and
what fingers already know. Four things about it, all cheap to get wrong:

- **Match `event.code === 'Backquote'`, not `event.key`.** Every existing chord
  in `Workspace.tsx` reads `event.key.toLowerCase()`, which is correct for a
  letter and wrong for this one: **with Shift held, `key` is `~`**, not a
  backquote. Copying the surrounding style produces a shortcut that silently
  never fires, and the keyboard layouts where the two diverge again are exactly
  the ones nobody tests on. `code` is the physical key and is what this needs.
  Modifiers stay exact — `ctrlKey && shiftKey && !metaKey && !altKey` — matching
  how the `⌘J` arms are written.
- **Reject `event.repeat`.** Holding the chord otherwise spawns shells at the OS
  key-repeat rate, and it is the only way a person reaches forty terminals by
  accident (Q1). No existing chord needs this guard because none of them creates
  a process.
- The handler in `Workspace.tsx:186` resolves "which panel" the way `⌘J` already
  does — the global panel if the caret is inside `.terminal-panel--global`,
  otherwise the focused pane's session. That branch exists at `:202` and is
  reused rather than rewritten.
- **xterm will eat it otherwise.** `attachCustomKeyEventHandler`
  (`TerminalView.tsx:170`) currently intercepts `⌘K` and returns `true` for
  everything else, which hands the keystroke to the shell. The chord typed inside
  a terminal — which is where you are standing when you want another one — would
  reach `zsh` instead of Chorus. The handler needs the second case, on `code`
  and with the same exact modifiers, and the reason belongs in a comment beside
  the `⌘K` one.

**No binding for kill.** VS Code has none either, and a chord that kills a
process is not a thing to discover by accident.

**No tab cycling chord**, deferred rather than invented — see open questions.

## 7. Phases

### Phase 0 — Make terminal state persist at all

§4.1. Add `terminals` and `globalTerminal` to the `equalityFn` at `App.tsx:281`.
Nothing else, and nothing about this plan's feature.

Separate because it is a bug in 0.14.0 that this plan happens to have found, it
is shippable on its own, and putting it inside a phase that also changes the
schema would make a regression in either indistinguishable from the other.

**Exit criteria.** Open a session terminal, resize it, quit **without touching
anything else**, relaunch: the panel is open at the height it was left. That
sequence fails on `main` today, which is what makes it a test rather than a
demonstration.

### Phase 1 — The id, shipped inert

`id` joins the union in `terminal.ts` and `TerminalRefShape`, storage gains its
second level, `terminalKey` is deleted, `disposeSession` and `close` loop,
`Session` keeps `exitCode` and `attach`/`describe` return it (§5.1). **And the
renderer's router learns about `id`** — `sameTerminal`, `TerminalView`'s
reconstruction, its dependency array, and its `key` (§1.1). The renderer mints
**one constant id per scope** so the app behaves bit-for-bit as it does today:
one terminal per session, one global, no strip, no new controls.

The ref shape crosses both process boundaries and eight files, and this is the
phase where that edit is the only thing happening. Shipping the mechanism inert
is the move `terminal-prompt`'s Phase 1 named, and it means a regression here is
attributable.

**Exit criteria.** `pnpm check` green. The existing terminal specs
(`specs.mjs:1744`) pass unmodified. A terminal opened, used, backgrounded by a tab
switch and returned to still holds its scrollback. New unit tests in
`terminal-stream.test.ts`: a `data` push for a sibling id is **not** applied, and
an `exit` push for a sibling id is **not** applied — both within one conversation,
because cross-conversation was already covered and is not the case that breaks.
A `terminal.test.ts` case that a shell exiting with no view attached still
reports its code from a later `attach`.

### Phase 2 — The roster, still one tab

Schema, store actions (`addTerminal`, `removeTerminalTab`, `activateTerminal`
alongside the existing toggles), and the repairs in `normalizeWorkspace`. Still
no strip on screen — but **the constant refs go**, which is what stops the roster
being decorative.

`Session.tsx:159` memoizes `{ scope: 'session', conversationId }` and
`Workspace.tsx:117` holds a module-level `GLOBAL_TERMINAL`. Both are Phase 1's
"one constant id per scope" made concrete, and if they survive this phase the
roster is a list nothing reads: adding a tab in Phase 3 would change the store
and not the screen. So Phase 2 replaces them with a ref built from the panel's
`activeId`, still resolving to exactly one terminal because there is still
exactly one tab. That makes the roster load-bearing while it is still trivially
correct, which is the cheapest place to find out it is wired wrong.

**Exit criteria**, and they are split because parsing and repair are two
different functions in two different processes — a distinction the previous
revision of this plan got wrong by asking one test to prove both:

- **A parse fixture in `open-sessions.test.ts` (main).** `parseOpenSessions`
  (`open-sessions.ts:84`) applies **schema defaults only** — it hands back
  `current.data.workspace` untouched — so what this can assert is that a v2
  envelope with a 0.14.0 panel (`{ open: true, height: 310 }`, no roster) still
  parses, still returns its session, keeps `height: 310`, and defaults to
  `tabs: []` / `activeId: null`. It **cannot** assert a backfilled tab, because
  nothing in main backfills. That file already carries three cases guarding the
  last two defaulted fields and a comment saying why — _"A fixture written before
  terminals existed is the only thing that catches it"_ — and this is the fourth.
- **A normalizer test in the renderer.** `normalizeWorkspace` (`layout.ts:83`) is
  where the backfill and the repairs live, so this is where they are proved:
  `tabs: []` with `open: true` gets one tab; a duplicate id is dropped; an empty
  id is dropped; an `activeId` naming a tab that is not in the list is repaired;
  a **closed** panel with no tabs is left alone rather than given one.
- **Driving a real 0.14.0 workspace file**, because neither unit test proves the
  app. Panels where they were, sessions intact, one tab in each open panel.

### Phase 3 — The strip, and `+`

The tab strip inside `TerminalPanel`, shared by both scopes — the panel is
already shared and "differ in where they are mounted and what they are titled,
not in how they behave" stays true. `+` mints a terminal, ``⌃⇧` `` does the same
from the keyboard and **rejects `event.repeat`** (Q1), xterm stops eating it,
only the active tab mounts, exit status is keyed by id (§5.1).

**Exit criteria.** Two terminals in one session; `pnpm dev` in the first still
running when you come back to it from the second. Holding ``⌃⇧` `` for two seconds
makes **one** terminal. A shell that exits while its tab is in the background is
marked exited when that tab is next selected, and its neighbour is not. Driven in
the real app.

### Phase 4 — Kill

Per-tab `×`, `terminal:kill`, `describe()` finally called, the busy
confirmation holding a **captured ref** rather than an index (Q3), the kill
awaited before `removeTerminalTab` (§5), closing the last tab hides the panel,
an exited tab stays.

**Exit criteria.** Killing an idle terminal does not ask. Killing one running
`sleep 60` asks and names it. Killing one of two leaves the other's shell
running — verified by the _shell_, not by the tab count. Killing the last tab
hides the panel and does not leave a panel with nothing in it. **A rejected
`terminal:kill` leaves the tab on screen** — provable in a unit test by making
the IPC stub reject, and the one case that separates awaiting from firing
and forgetting.

### Phase 5 — Specs

`specs.mjs:1744` asserts `.terminal-panel--session` is exactly 1. That stays
true and must keep being asserted: one **panel** per session, several **shells**
inside it.

The new spec has C-027's lesson written into it. Counting panels to prove a
terminal was killed can never fail — the panel count does not move — so it
measures the shells: two tabs, kill one, assert one tab remains **and** that the
survivor still answers a write. Carry a control proving the mechanism fires when
it should.

## 8. What this deliberately does not do

- **No split view.** Settled: tabs only. The seam, named so it is not
  rediscovered: the panel renders one `TerminalView` chosen from a list, and a
  split would make that a small layout tree inside `TerminalPanel`. It would not
  touch `TerminalRef`, the store shape, or anything in main — which is the test
  that this plan has not foreclosed it either.
- **No process-name tab titles.** VS Code shows `node`, `ssh`, `zsh`. That means
  polling `describe()`, and a foreground process name is _state, not history_ by
  `CLAUDE.md`'s own test — so it would need its own push channel. A whole
  mechanism for a cosmetic win. Positional names until someone asks.
- **No tab renaming or reordering.** The `{ id }` object is the shape that makes
  both a defaulted field later rather than a migration.
- **No shells surviving a relaunch.** The tabs come back; the shells do not, and
  they never did — `close()` kills everything on quit and `window-all-closed`
  still quits. Worth saying plainly because "my tabs came back but my `pnpm dev`
  did not" is the surprise this feature creates. A restored tab is an empty slot
  that spawns on first attach.
- **No per-terminal working directory.** Every terminal in a session opens where
  the conversation opens; the global ones open at `homedir()`. `cwdFor`
  (`runtime.ts:386`) takes a ref and would already answer per-id, so this is a
  choice rather than a limit.
- **No agent access to any terminal**, unchanged from the original §7 and
  stronger now: several shells is several surfaces, each of which the permission
  engine would have to reason about.
- **No terminal output in the event log**, unchanged. §4.3, and `CLAUDE.md`.

## 9. Open questions

**1. ~~Is there a cap?~~ No product cap, but the keyboard needs a guard.**
Settled far enough to build. Nothing here stops forty terminals in a session and
VS Code does not cap either, so no cap ships. **But ``⌃⇧` `` must reject repeated
keydowns** — holding the chord otherwise spawns shells at the OS key-repeat rate,
which is not a capacity question but an input-handling one, and it is the only
way a person reaches forty terminals by accident. `event.repeat` is the guard and
it belongs in Phase 3.

What is _not_ settled is whether a cap is ever needed, and
`process.memoryUsage()` will not answer it: it measures this process, so it misses
every PTY child's RSS entirely, and an idle terminal's mirror holds nothing —
`scrollback: 5_000` is a ceiling, not an allocation. A measurement worth acting on
fills the scrollback first and counts the child processes too. Until someone has
that, a cap would be a number picked to look responsible.

**2. Does a tab strip want a cycling chord?** `⌃Tab` is claimed by the pane tabs;
`⌘1..9` would be a third meaning for a number key. Deferred deliberately: the
strip is clickable and `⌘J` reaches it, and a chord invented in a plan rather
than asked for after using the thing is how the global terminal nearly got the
wrong one.

**3. ~~`describe()` at click time versus kill time?~~ Settled: click time, once.**
`describe()` when the `×` is pressed, **capture the exact ref in the dialog's
state**, kill that ref on confirm, then remove that tab. No re-check.

The reason is not that a second `describe()` is expensive — it is that it would
not help. Describe-and-kill cannot be made atomic from the renderer at all; a
second call just narrows the window and leaves the same race, while suggesting in
the code that the race was handled. Atomicity would have to be **one main-process
operation** — a `kill(ref, { onlyIfIdle })` that inspects and signals under the
same tick — and that is not worth building for a dialog whose wrong answer is
"you killed an idle shell you had asked to kill".

Capturing the ref rather than the tab index is the part that actually matters: a
tab can be killed, or its panel re-ordered, while the dialog is open, and an index
would then point at a different shell.

**4. Vertical space, still.** The original plan's open question 5 — four panes,
four session terminals, plus a global one — is unresolved, and this is the first
change that argues about it rather than adding to it: N shells in one panel cost
one panel's height, which is the case for tabs over split. Still needs the thing
on screen.

**5. Does the focus rule want to know about the strip?** `focus.ts:122` reads
`inTerminal` as `closest('.terminal-panel')`, and a tab button is inside one. So
clicking a tab is treated as "the caret is in a terminal" and the composer is not
offered it. That is probably right and is currently untested.

## 10. Risks

- **The schema default is the whole risk.** §4. Everything else in this change
  fails loudly.
- **Misrouting is the second, and it is quiet.** §1.1. A push applied to the wrong
  sibling does not throw — it prints. If Phase 1's two stream tests are skipped,
  the bug ships and is first seen as "the terminal sometimes writes into the wrong
  tab", which is unattributable a month later.
- **The suite is not a safety net right now.** C-029 puts a full run at 6 clean in
  10, and `readable-control-rail-2026-08-13/STATUS.md` §10 records eight red
  specs. A new terminal spec lands beside failures that are not its own — say
  which are which, per that plan's own note.
- **Three of revision 1's claims were wrong, and two were about mechanisms it was
  building on** — the epoch argument in §3, the exit code in §5.1, and the scope
  list. All three were found by reading the code rather than the plan, which is
  this repo's own standing instruction and is worth re-reading before Phase 1
  rather than after it.
