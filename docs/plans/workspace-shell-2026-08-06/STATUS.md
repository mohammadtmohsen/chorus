# Status

Phases 1–8 are in. The gates are green: `pnpm run typecheck`, `pnpm run lint`,
`pnpm run test` (736 unit, 3 skipped), and `node e2e/run.mjs` — **all 18 specs
passing**.

On `feat/workspace-shell`, not pushed. The suite grew from 14 to 18 as the work
went on: the sidenav's rename and reorder, its resize, mid-turn steering, and
the folding of steps each arrived with the spec that pins them.

## Phase 1 done: headless layout core

`renderer/src/workspace/layout.ts`, `shared/workspace-layout.ts`,
`workspace/layout.test.ts` — **14** tests green.

The recursive tree, normalisation, and every action as pure functions. Enforces
the two locked invariants: a session has at most one tab anywhere, and splitting
a pane whose active tab is its only tab is a defined no-op. `layout` and
`focusedPaneId` are nullable so "sessions running, nothing on screen" is a legal
resting state.

## Phase 2 done: store and persistence

`open-sessions.json` is a versioned envelope (`{ version: 2, sessions,
workspace }`) with a tested migration from the legacy bare array.
`conversation:layout { order, workspace }` end to end; `conversation:restore`
returns `{ sessions, workspace }`.

The zustand store is `workspace/store.ts` with `subscribeWithSelector`: hydrated
once from `restoreConversations`, then a 180ms debounced subscription in `App`
writes layout back through IPC. No `persist` middleware, as planned.

## Phases 3–7 done

Shell geometry (288px sidenav, sibling spacer, `transform` slide, `inert` +
`aria-hidden`, edge hot-zone with the 150ms close delay and a scrim); the
cwd-grouped session tree with 200ms debounced search, three leaf states,
auto-expand/scroll and per-row working / waiting status; panes with per-pane tab
strips, focused pane and close-pane; sashes with a 240px minimum, double-click
equalise and keyboard resize; and the pointer-event drag machine — 5px
threshold, geometry snapshotted at drag start, `setPointerCapture`,
`pointercancel` that cancels without committing, five zones, ghost, insertion
line, and a disabled overlay for refused gestures.

`MOVE_COOLDOWN_MS` and the HTML5 tab drag are gone, as the plan required. The
only HTML5 drag left is external file-drop onto a pane, which is unrelated.

## Phase 8 done: keyboard, a11y, verification

Every shortcut in the plan's table, plus the tab context menu, roving
`tabIndex`, `id`/`aria-controls` linking tabs to panels, and middle-click close.

e2e rewritten. The old `panes reorder by drag, and settle` spec is **deleted**,
not patched: it dragged `.pane-title` with HTML5 `DragEvent` and clicked a
"New session" button in `.masthead-actions`, and neither exists — panes do not
reorder by drag any more, tabs do. Three specs replace it:

- `a second session is a tab, and only its own tab` — two sessions share one
  group, only the active tab is mounted, the sidenav focuses rather than
  duplicating, `⌘W` closes the view and leaves the session listed as
  `offscreen`, and clicking it brings it back.
- `splitting moves the tab into its own group, and refuses to empty one` —
  `⌘\` splits sideways, the tab moves rather than copies, a one-tab group
  refuses to split, and a pointer-drag on the sash narrows the group for real
  (0.5 → 0.379).
- `a backgrounded session keeps its transcript and its unsent draft` — the
  background session leaves the DOM entirely, and coming back restores both the
  draft and the transcript, unduplicated and untruncated.

One of those three specs was itself wrong, and passed for four runs before
saying so. `a backgrounded session keeps its transcript` waited on
`.entry` containing "KEPT" — but the *prompt* contains "KEPT" too, so it
resolved the moment the user's own message rendered. The entry count it then
took was of a turn still in flight, and the reply landed while the tabs were
being switched, which surfaced at the end as a transcript that came back the
wrong size. It now waits for an `.entry--codex, .entry--claude` match and for
the turn to go idle, and additionally asserts the answer appears exactly
**once** — the failure mode `afterSeq` would actually produce is a doubled
transcript, not a short one, and nothing had been checking for it.

**`.pane` now means a *mounted session*, not an editor group.** Only a group's
active tab mounts, so two sessions in one group is two tabs and one `.pane`.
The specs keep `PANE` / `GROUP` / `TAB` separate for exactly that reason. The
launch and IDE specs still key off `.pane` and still pass unchanged.

## Open defects — all four closed

| # | Was | Now |
|---|---|---|
| 1 | `reconcileWorkspace` resurrected deliberately closed tabs | `layout.ts` force-opens only when `saved === null`; two tests pin both halves |
| 2 | `parseOpenSessions` returned `version` past its declared type | destructures to `{ sessions, workspace }` |
| 3 | typecheck red at `App.tsx:118` | green |
| 4 | `order` vs `workspace` tab order undefined | `conversation:layout` now says in the contract that `order` is the **sidebar's** order and pane tab orders live inside `workspace` |

## Cleanups taken since

- **Seam hooks.** `workspace/hooks.ts` — `useWorkspaceLayout`, `usePane`,
  `useWorkspaceActions`, `usePaneCount`, `useSidebarHidden`,
  `useActiveConversationId`, `useTabPaneId`, `useSessionPulse`. No component
  subscribes to the store directly during render any more. Imperative
  `getState()` reads inside event handlers stay: they subscribe to nothing.
  The unused `workspacePane` / `workspacePaneIds` selectors are gone, and
  `WorkspaceRuntime` is split out of `WorkspaceActions` so the actions type is
  callables only.
- **`conversation:reorder` deleted.** `conversation:layout` replaced it and no
  renderer called it. `Runtime.reorderConversations` stays — restart still uses
  it to keep a restarted conversation in place — and `setConversationLayout`
  now delegates to it instead of repeating the reordering, so one
  `rememberOpen()` writes order and layout together.
- **Harness bug fixed.** `harness.mjs`'s `settle()` had an unbalanced paren and
  threw `SyntaxError` in the page every time it was called. No existing spec
  used it, so it had been latent; the new specs are its first callers.
- **Two unit tests added** for gaps the plan named: split in all four
  directions (only `right` was exercised, and orientation and child order come
  from two separate expressions in `insertSplit`), and the close-fallback rule —
  the caret goes to the tab that slid into the closed one's index, clamped to
  the last, which is neither "previous" nor MRU.

## Defect the new specs caught: the unsplit pane had no height

Worth recording because it was the app's **default** state, not an edge case,
and nothing in the suite had been able to see it.

`.workspace-pane` set `width: 100%` but not `height: 100%`, unlike its siblings
`.split-branch` and `.workspace-empty`. A *split* pane is a flex item and gets
stretched by `.split-child`, so it looked right the moment you split — which is
what made this so easy to miss. An *unsplit* pane is a direct child of
`.workspace-editor`, which lays out as a block, so its height stayed auto, the
`minmax(0, 1fr)` row resolved against the content rather than the view, and the
pane grew as tall as the whole transcript.

Measured on a two-message conversation: `.score.clientHeight` was **116467px**.
`makeRoom` then held open a `--spare` of 116317px to match, `scrollHeight ===
clientHeight` so the transcript could not be scrolled at all, and `.turn-head`
never reached the top to pin — which is how it surfaced, as
`the question stays at the top of the answer it asked for` failing by 46px.

Fixed by adding `height: 100%`. After: `clientHeight` 627, `offTop` 0.

The 46px was a misleading symptom — it read like a sticky-offset regression in
the pinned-question work from `d8927cc`, and that code turned out to be
correct. The scroller it was measuring against was the broken thing.

## Second defect the specs caught: hydration was written back to disk

Surfaced as `reopens the same session, and only one of it` failing — the
session restored into the sidebar but no pane ever appeared.

`open-sessions.json` after a first run held a live session next to
`workspace: { layout: null, panes: {} }` — an **empty** snapshot rather than
`null`. `reconcileWorkspace` then did exactly what defect 1's fix asks of it and
left every tab closed, so the session came back running and off screen.

The cause was in `App`'s persistence subscription, not in the layout core.
`hydrate` flips `hydrated` false→true, the selector counts that as a change, and
the first emission is the store echoing back what it has just read. On a first
run that echo replaces the `null` that means *"this file predates the shell,
open everything"* with an empty snapshot meaning *"the user closed every tab"* —
and it lands before the auto-started session has opened its pane, so the
force-open path could never fire again on that profile.

Fixed by skipping the seed emission: only changes after hydration are the
user's. Verified both ways — with the debounced write landing, the real layout
round-trips; without it, `workspace` stays `null` and the next launch
force-opens.

**Mostly closed since.** Changes that *end* — a dropped row, a finished resize
— now write straight through `commitLayout` rather than waiting on the
debounce. The debounce exists to coalesce a stream of updates, and pointer-up
is not a stream; quitting inside that 180ms window was silently discarding the
change and reopening at the old value. The sidenav resize spec caught exactly
that, and only passed at first because an earlier manual probe happened to
sleep before quitting.

**Residual:** continuous changes still debounce — sash drags and tab moves — so
an abrupt quit within 180ms of one can still lose it. The fallback is the
harmless one (`null` → force-open) rather than the destructive one, and
`open-sessions.ts` already calls this file a note to ourselves that costs
nothing but a click.

## Sidenav redesign — supersedes parts of Phase 4

Asked for after the shell landed. What changed:

- **Flat, not grouped by `cwd`.** The folder rows are gone. They were doing
  little work — a session's title defaults to its folder's name, so the header
  usually repeated the only row beneath it — and grouping left nowhere for a
  dragged row to go. The `cwd` survives as the row's `title` tooltip and is
  still matched by search.
- **A card.** Inset 6px from the window, `--raised` on a full 1px border, and
  rounded on the token the rest of the app already uses.

  This was recorded here for a while as "an exception to decision 3", which was
  wrong twice over. The plan's line about Chorus being "a room drawn in 1px
  lines" reads as a ban on curvature, but `main` already carried 53
  `border-radius` rules — the composer, the user's own message, approval and
  question cards, the mention menu, every chip. What is square is the
  *structure*: panes, tabs, sashes, the grid. Content surfaces have always been
  rounded. A sidenav card is content, so it needed no exception at all.

  The real fault was the one not flagged: it shipped on 9px and 6px, beside an
  existing `--radius: 7px` and its derived `calc(--radius * 2)` and
  `calc(--radius - 2px)`. Two scales a pixel apart, indistinguishable on screen
  and therefore never noticed, with a later change to the token silently
  updating half of them. It now maps onto the scale — 14px for the card, the
  same as the composer, 7px for the search field and icon buttons, 5px for a
  session row — and the plan's wording says structure-versus-content rather than
  claiming nothing is round.
- **Full height.** `position: fixed`, 6px to 854px in an 860px window — 848px
  against the old 808px. It runs up behind the traffic lights, which is the
  usual macOS arrangement; `.workspace-sidebar-head` pads 26px down to clear
  them and takes over as the drag region for that corner. The masthead's
  `padding-left` moves 92px → 288px to stay clear, driven by `:has()` rather
  than a prop, so a sidebar toggle does not re-render every mounted transcript.
- **Rows set at the transcript's size, and the card widened to suit.** They
  were 11px, matching the tab strip and the rest of the chrome. But a session's
  name is *content* — it is the thing the sidenav exists to show — and it was
  being set three steps below the text it names. Rows are 14px now, the size of
  `.said .md-p`; row height 30px → 36px, search field 11px → 13px, and the
  unread badge, the voice dots and the state stub scaled with them.
- **`--sidebar: 336px`**, up from 288px and now a single custom property. Three
  rules had to agree on that number — the spacer that holds the editor clear,
  the card's own width, and the masthead's left padding — and they were three
  literal copies, which is exactly the kind of thing that gets changed in two
  places out of three.
- **Resizable.** A 7px handle centred on the card's right edge — same hit area
  as a pane sash, half of it living in the gap that was dead space anyway.
  Pointer drag, arrow keys at 16px a step, double-click to reset. Width is
  clamped to 240–640 and persisted as `sidebarWidth` on the workspace snapshot,
  defaulted in by zod so a workspace written before this still opens.

  **The stored width and the shown width are not the same number.** A width
  chosen in a maximised window and reopened at 640px wide covered the editor
  outright — the card is `fixed`, so it sits *on top* rather than pushing
  anything aside, and the workspace was simply gone until you found the
  collapse button. `fitSidebar` bounds the displayed width to half the window
  and re-runs on `resize`, but never writes back: the width the user chose is
  theirs and returns intact once there is room for it. The spec asserts both
  halves — fitted to 450 in a 900px window, still 640 after the relaunch.

  That also exposed a **pre-existing** `@media (max-width: 760px)` rule, where
  the sidebar stops pushing and starts overlaying. It hardcoded 288px, so it
  ignored the new variable; it dropped `z-index` to 40 while the base had moved
  to 60; and the masthead still reserved a sidebar's width for a sidebar that
  was no longer displacing anything. It now sizes from `--sidebar`, keeps the
  one z-index, gives the traffic-light inset back, and hides the resize handle —
  which was pointing at an edge the card no longer had once `100% - 36px` won
  the `min()`.

  The drag writes `--sidebar` **straight onto the document element** and only
  commits to the store on release. Going through the store per frame would
  re-render every mounted transcript sixty times a second to move one edge, and
  the three rules that read the width are CSS anyway. The store still owns what
  gets persisted.
- **Voice dots moved to the right.** Leading them made every row open with the
  same two marks, so the eye stepped over identical punctuation to reach the
  part that differs. On the right they form a column you can read down.
- **The left border became a stub.** A rounded row cannot carry a square
  full-height border without the two fighting at the corners; the stub says the
  same three states in less ink — nothing off screen, the voice's colour open
  elsewhere, bone when active.
- **Double-click renames inline.** Swaps the row for an input, the way the tab
  strip does — a text input inside a `<button>` is invalid and unusable, since
  the button swallows the click that would place a caret.
- **Drag to reorder.** Pointer events, 5px threshold, row midpoints snapshotted
  at drag start, gap-index commit with the same `from < slot` discount the tab
  strip uses. Refused while a search is running: the visible rows are a subset
  then, so a gap index between two of them does not describe a position in the
  real list.

A third bug surfaced while writing the spec for it, and it was not a test
artefact: the reorder read its target slot from React state at drop time, so
committing depended on a render having happened between the last `pointermove`
and the `pointerup`. True whenever a human drags; false for a flick fast enough
to land both in one frame, which then silently reordered nothing. The slot now
lives on the drag ref and the state is only what draws the line.

Two stacking bugs came with the fixed card and were fixed with it:
`.sheet-backdrop` was z-index 20 and would have been covered by the card (now
80), and the sidebar's own `[data-previewing]` rule *lowered* it to 40 (the
z-index is dropped; the base 60 already wins).

`onReorderSessions` writes through `conversation:layout` immediately rather
than via the debounced subscription — that one only fires on workspace *store*
changes, and the sidebar's order lives in React state beside it, so a dragged
row would have sat right until the next relaunch and then jumped back.

## The pane's tools bar is gone — Phase 5 finished

The plan's Phase 5 said to "move the session title bar out of `Session.tsx` into
the tab". That was done by halves: the name and close moved, but a slim
`.pane-title--tools` header stayed behind above every transcript. By the end it
held one chip and two buttons, and both buttons already existed on the tab's
context menu — so a full-width rule and 27px of every pane were being spent on
the spend chip alone.

The header is deleted. The chip moved into the composer footer, beside the path
and the profile, where the other session-level facts already sit and where it
costs no height. Restart and End were not replaced: right-clicking the tab has
offered both, with the same arming on End, since Phase 8.

Removed with it, all dead once the header went:

- `confirmingClose` and `restarting` state in `Session`
- the `onRestart`, `onClose` and `canClose` props, and the two arguments `App`
  was passing to them — `applyRestart` and `endNow` are still reached, through
  `Workspace`'s `onRestart` / `onEnd`
- **20 CSS rules**: every `.pane-title*` selector, and `.pane[data-lifted]`,
  which was left over from the HTML5 pane drag the pointer machine replaced.
  Most had been dead since Phase 5 and nothing had noticed.

`.spend` keeps its `margin-left: auto`, which now does a different job — it
splits the footer into a left group (voices, path, profile) and a right one
(spend, Review changes, Send) instead of pushing the chip past a session name.

**Removing the bar broke the pane's layout, and no spec caught it.** `.pane`
laid its children out on `grid-template-rows: auto 1fr auto` — a *positional*
template meaning title, transcript, dock. With the title gone the transcript
took `auto` and the composer took `1fr`, so the composer floated up under the
last message with the rest of the pane empty beneath it.

The same template was already wrong in a case that predates this: the error
notice is a conditional **first** child of `.pane`, so any pane showing an error
was handing `1fr` to the title bar and pinning the composer mid-pane.

`.pane` is a flex column now — `.score` is `flex: 1; min-height: 0`, `.dock` is
`flex: none`. Which child stretches is stated rather than inferred from
position, so neither a removed row nor an appearing notice can move the
composer off the bottom again. `opens straight into a session` now asserts
`pane.bottom - dock.bottom === 0`, which is the question that would have caught
it.

## Tab strip: a minimum width, and scrolling that can now happen

The strip already had `overflow-x: auto`, and it had never once engaged. Tabs
shrank to a **84px** minimum first, so a crowded pane showed a row of identical
truncated stubs — the strip stopped answering the only question it exists for —
and nothing overflowed, so the scroll it was configured for never triggered.

The minimum is 160px now. Past that the strip scrolls, which costs a gesture
instead of the information. The plan's 220px maximum is unchanged, so an
uncrowded pane looks exactly as before.

Scrolling made one thing newly necessary: **the active tab scrolls itself into
view**. Every way of changing tabs except clicking one can now select something
off screen — `⌘⇧[`/`]`, opening from the sidenav, a restart, the fallback after
a close — and without it the caret lands in a transcript whose tab is somewhere
off to the right.

Asserted in `a second session is a tab`, squeezed to a 340px viewport: both
tabs hold 160px and the strip overflows. That costs no extra session, and it is
the guarantee that actually regressed.

## Outside this plan, done in the same working tree

**Steering mid-turn is now discoverable.** It was never blocked: `onSubmit` has
no busy guard, both adapters declare `steer: true`, the Claude adapter runs in
streaming-input mode so `send()` pushes onto the live prompt iterable, and
`runtime.send` delivers into the running turn. `↵` had always worked. But the
only *visible* control became Stop the moment an agent started, so the way to
say "actually, do it this way instead" looked exactly like the way to abandon
the turn — and clicking it did abandon it. Stop sits beside Send now instead of
replacing it. Verified against a real agent: the new instruction landed, the
turn was never interrupted, both messages are in the transcript.

**The composer row sheds the spend chip.** Moving spend out of the tools bar
put the longest string in the app into a row with a container-query ladder it
was not part of — `8.6M · $17.64` pushed it 6px past a 380px pane. The cost
drops at 520 and the whole chip at 430, and `.pane-actions` takes over the
`margin-left: auto` the chip was carrying so the row does not collapse leftward
when it goes.

**Two harness bugs, both introduced here.** `settle()` waits on
`requestAnimationFrame`, which does not fire in an occluded window — so
whichever spec happened to run behind another window hung until its two-minute
timeout. It has a deadline now. The first deadline was 250ms, which was worse in
a quieter way: it resolved before a scroll finished and reported a pinned header
9px from where it settles. 700ms.

## The renderer CPU measurement — Phase 8's last line

Asked for as "six sessions streaming and two on screen, before and after". The
*before* cannot be run: the old grid capped at four columns, so six sessions
never fit in it — which was the reason for the shell in the first place. What
can be measured is the claim the mount policy rests on, which is the useful
half: **an unmounted session costs the renderer nothing while its agent
streams.** So hold the mounted count still and vary how many stream, then vary
the mounted count and watch the cost arrive.

Six sessions, all sent the same 4000-line count so every window lands
mid-stream. Renderer task time from `Performance.getMetrics`, sampled over 10
seconds, as a fraction of wall clock. Two runs:

| mounted | streaming | CPU | layout |
|---|---|---|---|
| 1 | 0 | 0.3% / 0.3% | 0% |
| 1 | 1 | 13.7% / 12.3% | 1.2% / 0.9% |
| 1 | **6** | **14.7% / 13.9%** | 1.6% / 1.7% |
| **4** | 6 | **35.6% / 36.7%** | 10.8% / 12% |

- **Five extra streams, none of them mounted: +0.9% and +1.5%.** An agent
  streaming into a session nobody is looking at is very close to free, which is
  exactly what unmount-on-background was for.
- **Three extra mounted, the same six streams: +21% and +22.8%** — about
  **7–7.6% per mounted streaming session**, and layout time is where it goes,
  1.6% → 12%.

Cost scales with what is *mounted*, not with what is *running*. That is the
whole of the divergence from the app this was modelled on, measured: their
policy keeps hidden tabs mounted because their storm is on reload, and ours is
continuous.

Extrapolating the *before* rather than pretending to have run it: the old grid
mounted every session it showed, so six of them would have been roughly six
times the per-session cost — order of 45%, against 14% now, and it could only
ever have shown four.

Two measurement mistakes, both mine, both worth the note. The first pass used a
300-line count that finished before the sampling window, so "6 streaming"
measured a renderer with nothing left to do and read *lower* than one stream.
The second used `⌘\` three times from a fresh split each time and got two
groups, not four — a split *moves* the tab, so the new group holds exactly one
and correctly refuses to split again. Focusing the crowded group with `⌘1`
before each split fixes it. Neither would have been visible in the numbers
alone; both were caught by asserting the state the sample was taken in.

## Known deviations from the plan

- The sidebar edge hot-zone is **3px, not 2px**. Kept: at 2px it competes with
  the OS window-resize edge.
- ~~`Session.tsx` still renders a `.pane-title` header~~ — resolved; see "The
  pane's tools bar is gone" above.

## Next

Nothing outstanding in this plan. The renderer CPU measurement was the last
open line and is recorded above.

Carried forward, none of it blocking:

- **The 180ms debounce still coalesces continuous changes** — sash drags and tab
  moves — so an abrupt quit inside that window can lose one. Discrete changes
  that end on pointer-up write straight through.
- **`@media (max-width: 760px)` overlays the sidebar rather than reserving space
  for it.** That predates the shell and now reads from `--sidebar`, but it is a
  second layout mode with no spec of its own; the suite only ever drives the
  docked one.
- **The `--radius` scale is documented in the plan and nowhere the CSS can
  enforce it.** The next surface that wants a corner is on its honour.
