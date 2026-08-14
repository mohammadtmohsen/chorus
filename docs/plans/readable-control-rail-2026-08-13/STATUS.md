# Status — a readable control rail

Written after each phase shipped. Where the code contradicted the plan, the
correction and the reason are here rather than in a plan pretending it was right.

| Phase | What                                     | Status   | Notes                                                                       |
| ----- | ---------------------------------------- | -------- | --------------------------------------------------------------------------- |
| 0     | Baseline and perf harness                | shipped  | `perf-rail.mjs`, `render-count.ts`, `docs/research/…-baseline.md`           |
| 1     | Semantic palette and UI font             | shipped  | `--faint` gone; `theme.test.ts` reads the sheet, both themes                |
| 2     | Quick rail, drawer, row, preview         | shipped  | 6 new files; `ActivityBar.tsx` deleted; `Workspace.tsx` 1962 → 897 lines    |
| 3     | Intentional actions, Arrange, rail drag  | shipped  | `placeSession`/`splitWithSession`; menu; Arrange; Move Up/Down              |
| 4     | Render isolation and the typewriter tail | shipped  | Shell renders 0 times through a whole streaming turn; completion flushes    |
| 5     | Accessibility, regression, approval      | rejected | Behaviour passed, but the user rejected visual parity; correction is active |
| —     | Corrections after independent review     | shipped  | Seven gaps closed, no exceptions left; the section at the foot of this file |
| —     | Pixel-parity correction                  | active   | Match the supplied reference before visual approval is requested again      |

---

## What shipped

**The rail is the default state.** `EMPTY_WORKSPACE.sidebarHidden` is now `true`,
so a fresh install opens collapsed. That is a deviation from nothing in the plan
— the plan says the collapsed state is primary — but it is a behaviour change the
plan never spelled out, so it is called out here. An existing workspace keeps
whatever it had saved.

**One list, two representations.** `QuickRail` and `SessionList` render the same
sessions in the same persisted order from one projection (`session-row.ts`). The
rail keeps a fixed top (drawer toggle, new session), an independently scrolling
middle (one 44×44 shortcut per session), and a fixed foot (global terminal, four
account readings, settings).

**Four usage readings, not one worst case.** Codex 5-hour, Codex weekly, Claude
5-hour, Claude weekly, each with the provider's own window label and percentage,
in the same order every time. The reset countdown is in the popover that hover or
keyboard focus opens.

**The preview is one card and it is read-only.** Portalled, placed from a measured
box, opened by hover _or_ focus after a 200ms dwell, held while the pointer
travels into it, closed by Escape after a 120ms grace. Opening it does not reflow
either list — asserted, not assumed.

**Actions are intentional.** One `More` per row opens one portalled menu with
Rename, Session settings, Summary, Review, Open in Pane, four Splits, Move Up,
Move Down, and — behind a divider, last — Restart and End. End arms itself while
an agent is working. Nothing configures or ends a session from the row itself.

**Two drags, two destinations.** Outside Arrange, a rail or drawer drag runs
through the existing `useTabDrag` target resolver and can insert, move, or split;
inside Arrange it reorders and cannot reach the workspace. `Move Up`/`Move Down`
and the four `Split …` commands are the non-drag equivalents, and the result of a
move is announced through a live region.

---

## Deviations from the plan, and why

1. **No React Profiler build.** Phase 0 asks for commit counts from a profiling
   build. This repo ships none and adding one to answer one question is a larger
   change than the question. `render-count.ts` replaces it: a counter that does
   not exist unless `window.__chorusRenderCounts` has been installed from outside
   the app, which only `perf-rail.mjs` does. It counts component renders rather
   than React commits — coarser, and the right unit for the claim Phase 4 makes.

2. **Two palette values differ from the plan's table.** The plan requires every
   listed text colour to reach 4.5:1 on its documented surfaces, and two of its
   own proposed values do not:
   - dark `--border-strong` `#6e7681` reaches 2.83:1 on `--bg-control`, below the
     3:1 floor for a control boundary → `#7d8590` (3.49:1);
   - light `--accent-text` `#0969da` reaches 4.45:1 on `--bg-control` → `#0a58ca`
     (5.52:1). `--focus-ring` keeps `#0969da`, which only needs 3:1.

   `--danger` is documented on canvas, chrome and surface but **not** on
   `--bg-control`: dark `#f85149` reaches 3.88:1 there, and no rule may put a
   failure notice on a pressed control. That constraint is written into
   `theme.test.ts` rather than left to be rediscovered.

3. **The legacy token names survive as aliases.** `--ground`, `--raised`,
   `--sunken`, `--line`, `--bone`, `--muted`, `--codex`, `--claude` and `--alert`
   now resolve to semantic tokens. The plan asks for migration by role rather
   than a global replace, and 5,800 lines of stylesheet is more than this feature
   should rewrite. `--faint` is the exception: it was deleted outright and its 68
   uses were migrated by role — 58 to `--text-muted`, and the rest to
   `--border-default`, `--border-strong`, `--text-disabled`, `--text-placeholder`
   or `--mark-decorative`. A test fails the build if it comes back.

   The 94 retired rules were removed by a script that matched selectors, and it
   took two things it should not have — both caught by diffing every selector in
   the sheet against `HEAD` afterwards, which is the check worth repeating if
   this is ever done again:
   - `.workspace-tab-title` shared its truncation rule with the sidenav card's
     title, so a long tab name lost its ellipsis;
   - `.workspace-pane-close` and `.workspace-tab-close` shared their base rule
     with the sidenav's icon buttons, so both × buttons were left as bare UA
     buttons with a border and a grey fill.

     Both now have their own rules, which is what they should have had.

4. **The drawer covers the editor below 700px.** The previous spec asserted the
   sidebar "never floats over the editor", and that was right when it was the only
   way to navigate. The rail is now that way, so covering costs nothing that
   closing the drawer does not immediately give back — which is what Apple's
   sidebar guidance recommends for a constrained window. The spec was rewritten to
   assert the new rule and the reason.

5. **Arrange and preview state live in a signal, not in `Workspace`.** The plan
   says to keep them local to the list. Both are needed by the rail _and_ the
   drawer, and `Workspace` renders every mounted pane — so a `useState` there
   would re-render four live transcripts on every pointer crossing a row.
   `signal.ts` is a value with subscribers, created once in a ref, so only the
   components that read it repaint.

6. **The typewriter drain is 80ms, chosen on the numbers rather than by a human
   read.** The plan asks to compare immediate chunks, 60–80ms and the current
   140ms "under the same trace". The trace comparison was not run with a person
   watching; 80ms is inside the plan's own range and the tail the plan actually
   objects to is gone for a different reason — `agent.message.completed` now
   flushes the whole authoritative text at once, so the drain only ever paces
   text that is still arriving. `typewriter.test.ts`'s "takes a readable moment"
   threshold moved from 100ms to 48ms, because asserting 100 against an 80ms
   window would only have been asserting the constant.

7. **One lint rule was narrowed.** `no-restricted-imports` forbids Node built-ins
   anywhere under `apps/desktop/src/renderer`, because an import that typechecks
   and then fails in a sandboxed window is the worst failure mode there is. It is
   now off for `*.test.{ts,tsx}` under that path: vitest runs those in Node and
   they are never in the bundle. `theme.test.ts` needs it, and the reason is the
   point — it reads `styles.css` off disk, so the contrast floors are checked
   against the sheet the app ships rather than against a copy of its values.

8. **`SIDEBAR_WIDTH` narrowed to 248 / 220 / 320** from 336 / 240 / 640, per the
   plan's decision 2. A width persisted from the old range clamps into the new one
   on the way in.

---

## Performance: before and after

Reproduce: `node apps/desktop/e2e/perf-rail.mjs --sessions 6 --out <file>`.
"Before" was measured from a clean `git worktree` at `cf29bc1` with the same
script copied in. Six sessions, one pane, Darwin 25.6.0 arm64, dev bundle.

`paintedMs` is interaction to second animation frame; `Task` is Chrome's own
counter across the same window.

| Interaction   | painted before → after | Task ms before → after |
| ------------- | ---------------------: | ---------------------: |
| rail switch   |             15 → **6** |       30.16 → **7.17** |
| rail scroll   |                15 → 11 |            1.21 → 1.98 |
| drawer toggle |                 6 → 10 |           6.49 → 10.19 |
| **search**    |            **322 → 8** |       11.74 → **3.54** |
| preview open  |                  5 → 6 |            5.73 → 6.12 |
| preview close |                 13 → 9 |            1.86 → 4.29 |
| split pane    |                27 → 17 |          32.28 → 18.84 |
| terminal open |                46 → 48 |          58.51 → 83.25 |

**The search reading is the one that matters.** At 322ms it was the only
interaction in the whole scenario that failed both the 100ms product target and
the 200ms INP ceiling — a keystroke in the session filter re-rendered six cards
carrying a folder editor, a profile picker, two agent switches, a Plan toggle and
four output controls each. It is 8ms now. Everything else already met the target
before this work, which is why no claim here is made about "making clicks faster".

Idle, three seconds, six sessions: task time 161.19ms → **7.59ms**, script
23.6 → 0.39, layout 8.73 → 0, style 31.29 → 0. Idle frames: 242 frames, 0
dropped, p95 9.2ms, unchanged.

### Render isolation, one full streaming turn

The Phase 4 exit criterion, measured over a whole ~20s agent reply:

```
after   QuickRail: 2   RailShortcut: 12   SessionRow: 2   SessionList: 0   Workspace: 0
```

`Workspace` and `SessionList` do not render at all while an agent streams. The
twelve `RailShortcut` renders are two per shortcut — the working state going on
and coming off — and the two `SessionRow` renders are the same for the one
session that was streaming. Before this change `Workspace` subscribed to
`useAllPulses()`, which returns the whole pulse map, so _every_ delta re-rendered
the shell and therefore every mounted transcript in it. That is a fact about the
old code rather than a measurement of it: the counter seam did not exist in the
baseline build, so these are after-only numbers and are reported as such.

### Streaming cost: no honest conclusion either way

Two samples per build, one 20s turn each:

| Build  | Task ms | Script ms | Layout ms | dropped |
| ------ | ------: | --------: | --------: | ------: |
| before | 1583.93 |    145.24 |     74.37 |   0.26% |
| before | 4459.37 |   1724.51 |     78.95 |   0.31% |
| after  | 2040.44 |    267.09 |    160.56 |   0.21% |
| after  | 1374.26 |    141.64 |     17.53 |   0.25% |

The spread within each build is larger than the difference between them — an
agent's reply is not the same length twice — so **these two samples cannot say
whether the streaming cost moved**, and the first after-sample looking like a
regression was noise. What they do support: dropped frames stayed between 0.21%
and 0.31% in both, comfortably inside the 1% budget.

### Budgets

- ordinary interaction painted within 100ms: **met** for every interaction after
  (max 48ms), and newly met for search, which was 322ms before;
- 200ms hard ceiling: met everywhere after;
- preview paint after its dwell: measured present within the 400ms wait, and the
  frame it lands in is 6ms;
- under 1% dropped frames during streaming: met (0.21–0.25%);
- no increase in background-stream cost: **not demonstrated either way** — see
  above. It is not shown to have regressed and it is not shown to have improved.
- p95 React commit under 8ms: **not measured.** That needs the profiling build
  Phase 0 did not add; render counts stand in for it.

---

## Checks run

- `pnpm check` — typecheck, eslint, prettier, **1481 tests passed, 3 skipped**.
- New/changed renderer tests: `theme.test.ts` (10), `session-row.test.ts` (20),
  `layout.test.ts` (+6 for `placeSession`/`splitWithSession`), `store.test.ts`
  (+3 for the failed state), `useTypewriter.test.tsx` (4, jsdom).
- Targeted Electron specs, each run on its own and each passing:
  - `the collapsed rail runs the day on its own` — 13 assertions
  - `a session is one row, one preview and one menu` — 31 assertions
  - `a rail drag places a session, and only Arrange reorders` — 12 assertions
  - `the drawer docks, resizes within its range, and comes back that width` — 7
- **Full e2e suite: `all 30 passed`, exit 0.** The suite is known flaky (C-029,
  roughly 6 runs in 10), so a clean run is worth naming as a clean run rather
  than as proof it cannot fail. Two specs were corrected during the work and are
  reported honestly:
  - `an agent can ask a question` failed once on its own precondition, which
    looked for the cast switches on a sidenav card. Those moved into the session
    menu; it now reads the active tab's voice dots, which name a session's
    participants without anything having to be opened.
  - `a session is one row, one preview and one menu` failed once on
    "the preview opened from focus". `focus()` on the element that already holds
    focus fires no event, and whether it did depended on what the previous step
    left focused. The spec blurs first now. This was a test-sequencing fault, not
    a product one — the same path was driven by hand and works.

## Observed in the running app

Driven over the debugger protocol, not inferred from tests.

**Four sessions, collapsed and expanded:** rail 60px, drawer 248px, editor
starting at 308px open and 60px collapsed. Four shortcuts with monograms `MO`,
`MO2`, `MO3`, `MO4` — every session in that workspace was named after the same
folder, which is exactly the duplicate-monogram risk the plan flags, resolved by
suffix and not by colour. Accessible names read `alex — idle` and
`alex — idle — showing now`. One roving tab stop; ArrowDown moved focus.
Preview opened from both `pointerover` and `focus()` and closed on Escape. The
menu was portalled outside the drawer, inside the window, End last. A rail drag
to a pane's right edge showed `SPLIT RIGHT` and produced a second pane with four
unique tabs — no duplicate.

**Twenty sessions:** 20 shortcuts, the middle group scrolls, the foot group does
not move when it does, and both the terminal and the settings gear stay visible
with the foot inside the window. The drawer lists 20 rows, its list scrolls, its
bottom stays inside the drawer and the toolbar stays put. A 76-character title
truncates: neither the row nor the shortcut overflows by a pixel, and the
monogram falls back to `AR`.

**Light, dark, reduced motion, narrow.** Measured against the rendered colours
rather than the tokens, and read after the 120ms colour transition rather than
one frame into it — a reading taken too early is a blend of both themes and
reports a contrast the app never draws:

| Reading                   |  Dark | Light |
| ------------------------- | ----: | ----: |
| row title on the drawer   | 14.23 | 14.84 |
| rail monogram on the rail | 14.23 | 14.84 |
| rail icon on the rail     |  6.55 |  5.74 |

Under `prefers-reduced-motion: reduce`: the preview's animation resolves to
`none`, the state mark's breathing resolves to `none`, and the drawer has no
transition to cut. At 700×500 the rail keeps its 60px, the drawer overlays the
editor rather than squeezing it, the foot group stays inside the window and the
settings gear is still visible.

**The composer's VS Code context pill** is exercised by three e2e specs that all
passed in the clean run — the pill names `src/a.ts:12-14`, a merge-request
selection still says which version it is, and Send re-asks the editor rather than
trusting the pill. Nothing in this change edits `Composer.tsx` or
`editor-context.ts`.

## Not verified

- **The human visual pass.** The plan's final gate is a person walking the Phase 0
  state matrix and confirming they can tell active, working, waiting and unread
  apart without comparing neighbours. That has not happened, and it is the
  remaining gate. There are real screenshots of the built app now (see
  _Corrections_ below), which is evidence for that pass rather than a substitute
  for it.
- **200% zoom specifically.** The narrow reflow was driven at 700×500; a true
  page zoom (`Emulation.setPageScaleFactor` beyond 1, or the app's own `⌘+`) was
  not.
- **Working, waiting and failed states under real load.** `idle` and `active`
  were driven; the other three are covered by unit tests over the projection and
  by the store's reducer, not by an agent actually failing a turn in front of the
  rail.
- ~~**The per-session terminal in a split pane** was not re-driven.~~ It has been
  now, in the real app, and it is a durable spec — see correction 4.

---

# Corrections after independent review

An independent review of the first pass found six acceptance gaps. A second review
rejected the one exception the first round had recorded as accepted, which is
number 7. Each is written up with what was actually wrong, what changed, and what
was run.

## 1. Four usage readings were not four, and not in that order

**What was wrong.** `useUsage` built its list from the pushes that had arrived
and sorted the accounts with `localeCompare`, then `RailUsage` returned `null`
while the list was empty. So the rail showed no usage control at launch, then one
account, then two — with **Claude above Codex**, because `claude` sorts before
`codex`. The plan's order is Codex 5-hour, Codex weekly, Claude 5-hour, Claude
weekly, and the reason it is an order rather than a set is that a figure in a
slot that moves means something different from one glance to the next.

This machine is the case that proves it: the Codex account here reports **no plan
window at all**, so what shipped drew two Claude readings and called that the
account column.

**What changed.** `usageReadings(pushes, now)` is pure, exported and tested. It
returns exactly four readings in a fixed order built from a constant, never from
the data. A slot with nothing in it carries `percent: null`, and the rail draws an
em dash — **never `0%`**, which claims an empty account rather than an unanswered
one. `activity.usageUnreported` says so in words in the control's accessible
name, and the popover keeps the same four rows with `not reported yet` where a
bar would be. Refresh and the reset countdown are unchanged for reported windows.
A window is placed in a slot by its reported duration, not by its position in the
push, so a provider that answers weekly-first still reads `5h` then `1w`.

**Run.** `useUsage.test.ts` — 11 tests covering no pushes, one provider, both in
either order, out-of-order windows, a window with no percentage, and a clamp.
Two e2e specs: `the collapsed rail runs the day on its own` now asserts four
slots, their exact order, and that an unreported one is an em dash; `account
limits read as limits` asserts the detail lists the same four in the same order.
Both observed on this machine at `codex:short —, codex:long —, claude:short 48%,
claude:long 79%`.

## 2. The working mark always spoke in Codex's voice

**What was wrong.** `.state-mark[data-state='working']` named `--voice-codex`
outright. `projectRow` had already worked out whose turn it was — `facts.voice`,
null when several agents are running — and nothing read it. A Claude-only session
breathed in Codex's colour.

**What changed.** `StateMark` takes the voice and sets `data-voice`, only while
the state is `working` and only when there is exactly one. The base rule is
`--text-primary`, which is what a turn with both agents in it draws: a mark
cannot name two, and naming one would be a lie rather than a simplification. The
shape and the accessible words are unchanged and remain the primary signal.

**Run.** `state-mark.test.tsx` — 4 jsdom tests over the rendered attribute, which
is where the defect was; `theme.test.ts` asserts the base rule names no voice and
that both per-voice rules exist. `session-row.test.ts` already covered the
projection.

## 3. A second agent's success erased the first one's failure

**What was wrong.** `reducePulse` did `failed = event.payload['status'] ===
'failed'` on every `turn.completed`. A conversation has two agents and they
finish separately, so Codex failing and Claude finishing normally a second later
left the row reading **idle** — in the one case where the state matters most.

**What changed.** The flag is set and never cleared there; only `turn.started`
clears it, which is what the field's own comment already promised. An
`interrupted` completion still never _sets_ it.

**Run.** Two tests in `store.test.ts`. Both were checked against the bug
reinstated — `2 failed | 7 passed` — before the fix went back in.

## 4. The per-session terminal was claimed rather than driven

**What was wrong.** The first pass said this path was untouched and left it at
that. The user's requirement was a terminal for **one session**, not a global
one, and nothing in the suite distinguished them.

**What changed.** A new durable spec, `a terminal belongs to one session, and the
global one is a different thing`. It splits into two panes, opens `⌘J` on the
focused one, and asserts against the real geometry. Observed in the run:

- one `.terminal-panel--session`, zero `.terminal-panel--global`;
- it is inside the owning pane (1) and not the neighbour (0);
- transcript ends 556, terminal 556–796, composer starts 806 — between the two;
- the other pane keeps its full height, 795 → 795, and the room came out of the
  owning transcript;
- `⌘⇧J` opens the global panel as a second, separate one and closes it again
  without touching the session's;
- the owning composer still reads `src/a.ts:12-14`, driven through the fake IDE
  over the real socket.

## 5. Concept mockups were the only pictures

**What was wrong.** `visuals/00-` … `05-` are **generated concept mockups** for
hierarchy review. They are not the app, and nothing in the folder said which was
which.

**What changed.** `apps/desktop/e2e/shots-rail.mjs` drives the built renderer in
a fresh `userData` and captures through `Page.captureScreenshot` — no Computer
Use permission involved. Three files, each 1440×900, verified by reading the
dimensions back out of the PNG header and by looking at every one of them:

| File                                                      | What is in it                                                                                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `impl-01-collapsed-rail-usage-split-session-terminal.png` | collapsed rail, four usage slots (`CODEX 5h — / 1w —`, `CLAUDE 5h 2% / 1w 79%`), two panes, terminal only in the left one, `src/payments.ts:42-48 Included` in its composer |
| `impl-02-expanded-drawer-preview.png`                     | the drawer open over the same workspace with the read-only preview anchored to a row                                                                                        |
| `impl-03-expanded-drawer-menu.png`                        | the same drawer with the menu open, `End Session` last, behind a divider, **and red**                                                                                       |

Two capture faults were found by looking rather than by trusting the exit code,
and both are fixed in the script:

- setting a folder and a title over IPC changes the store and not the window —
  there is no push — so the first attempt photographed `alex` and "No
  folder". The script now sets up in one launch and photographs in the next.
- the first capture after the preview's 120ms fade came out with the transcript
  legible **through** the card, while `getComputedStyle` in the same window
  reported `opacity: 1` on an opaque background. A discarded capture forces the
  frame; the second one matches what the app draws.

## 6. End was not actually red, and the More mark was under the floor

**What was wrong, and it is two things.**

`.session-menu-danger` is one class. `.session-menu button` above it is a class
_and_ a type, so it won. End rendered in `--text-primary` and read exactly like
Rename — the sheet said danger and the app drew something else, with nothing
failing anywhere.

`.session-row-more` rested at `opacity: 0.55` over `--text-muted`. Composited,
that is **2.87:1** on the dark drawer and **2.31:1** on the light one, under the
3:1 a control someone has to find is held to — while the token it names clears
4.5:1 on its own. Translucency is how a readable token becomes decorative with
nothing in the sheet saying so.

**What changed.** The danger rule is `.session-menu button.session-menu-danger`.
Its hover and focus states keep the item's own background rather than taking the
shared `--bg-control` fill, because `--danger` reaches only 3.88:1 there — the
constraint `theme.test.ts` already recorded — so hover takes a `--danger` edge and
focus takes the focus ring, and the text stays on `--bg-surface` at 4.57:1. The
More control drops the opacity and rests at `--text-muted`: **6.55:1** dark,
**5.74:1** light. The approved emphasis is unchanged — hover, focus and the
active row still go to `--text-primary` on a filled background, which is a
stronger step than the fade was.

**Run.** `theme.test.ts` composites any declared opacity before checking the 3:1
floor, so reinstating the fade fails the build; it also asserts the danger rule
carries `button.` and that the bare form is gone. In the real app, `End Session`
computes to `rgb(248, 81, 73)` — `--danger` `#f85149` — against Rename's
`--text-primary`, asserted in `a session is one row, one preview and one menu`
and visible in `impl-03`.

## One thing found on the way, and it was the driver

`a session is one row…` failed two runs in three, once on the rename step and
twice on "the preview opened from focus". Neither was the app. In a window
Chromium does not consider focused, `element.focus()` fires **no** focus event —
so the handler that opens the preview never runs — and `setTimeout` is throttled
past the preview's 200ms dwell and past an autofocused rename field's life. The
harness has `bringToFront()` now, which activates the window and waits for
`document.hasFocus()`, and the spec asserts it took. Three consecutive passes
after. This is the same lesson as C-027 from the other side: a spec that fails
for a reason outside the app must say so rather than read as a product defect.

## 7. The armed End confirmation was below AA, and now is not

This one was raised on review of the corrections above, where it had been written
down as an accepted exception. That was the wrong call: the product's central
requirement is a readable interface, and the label in question is the one that
asks whether you are sure.

**What was wrong.** Armed, the item filled with `color-mix(in srgb, var(--danger)
16%, transparent)` and kept its label in `--danger`. Composited over
`--bg-surface` that is **3.76:1** in dark — below the 4.5:1 floor for normal text.
It was not fixable by tuning the percentage: mixing a light colour into a surface
moves the surface _towards_ the foreground, so every value of that mix is worse
than none of it. 8% measures 4.16:1, 16% measures 3.76:1, and the ceiling is the
unfilled 4.57:1.

**What changed.** The armed state stops tinting and commits to the colour: a solid
`--danger` fill with `--bg-canvas` as the foreground. Read off the shipped sheet,
that is **4.92:1 dark** and **5.36:1 light** — the treatment the previous note
named as the option, now measured rather than predicted. In light mode it is white
on red, which is what a destructive confirmation looks like everywhere.

The state is still not carried by colour alone: the label itself changes from
`End Session` to the confirm string, so the fill is emphasis on top of words.

**Hover and focus cannot take the fill away**, and that is enforced twice.
`:not([data-armed='true'])` on the unarmed hover and focus rules stops them
applying at all, and the armed rules restate the pair at a specificity that beats
every other rule in the block. Two mechanisms rather than one because the defect
this whole section exists to fix was a rule silently losing the cascade.

**Focus stays visible on the fill** by sitting outside it —
`outline: 2px solid var(--focus-ring); outline-offset: 2px` — so the ring's
neighbour is `--bg-surface`, the surface `--focus-ring` is already documented
against at 3:1. Drawn inside, it would have had `--danger` on both sides.

**Run.** `theme.test.ts` reads the three armed rules out of `styles.css` — base,
hover and focus — and in each theme it refuses a `color-mix` fill outright,
requires a named token on both sides, and measures the pair against 4.5:1. Both
regressions were driven rather than assumed:

- the old `color-mix` fill reinstated → `2 failed | 20 passed`,
  _"the armed fill is a solid token, not a translucent mix"_;
- a solid fill with the label left readable-looking but wrong (`--text-primary`)
  → `2 failed | 20 passed`, _"--text-primary on --danger in dark: expected 2.69 to
  be greater than or equal to 4.5"_ and `2.95` in light.

Reading all three rules is what catches the second shape: a rule that kept the
fill and dropped the foreground would otherwise pass.

## Checks run for these corrections

- `pnpm check` — typecheck, eslint, prettier, **1502 passed, 3 skipped**.
- Targeted Electron specs, each on its own:
  - `a terminal belongs to one session, and the global one is a different thing`
    — 15 assertions, passed;
  - `the collapsed rail runs the day on its own` — 18 assertions, passed;
  - `account limits read as limits, if the account has any` — 6 assertions,
    passed (this machine reports Claude's windows and no Codex ones);
  - `a session is one row, one preview and one menu` — passed three times
    consecutively after the harness fix.
- **Full e2e suite after corrections 1–6: `all 31 passed`, exit 0, no skips.**
  Thirty-one rather than thirty because the session-terminal spec is new. No skip
  this time, which means the limits spec found reported windows and asserted on
  them rather than stepping aside. The suite is still known flaky (C-029), so
  this is one clean run and not a proof that it cannot fail.
- Correction 7 landed after that run and is **three rules in `styles.css` plus the
  static assertions that guard them** — no component, no reducer, no spec touched.
  `theme.test.ts` is 22 tests and `pnpm check` is **1510 passed, 3 skipped** (eight
  more than before: three armed rules and one focus check, in each of two themes).
  The 31-spec suite was deliberately not re-run, because nothing it drives changed
  and `specs.mjs` is byte-for-byte the file that passed it. The targeted real-app
  menu spec passed again after correction 7. An independent computed-style probe
  then confirmed the rendered base and hover states as `rgb(31, 31, 31)` on
  `rgb(248, 81, 73)`, and the focused state keeps that pair while adding a
  `rgb(88, 166, 255)` 2px ring at a 2px outward offset.

## Independent acceptance

- `pnpm check` was repeated independently outside the restricted sandbox so the
  existing Unix-socket tests could bind: typecheck, eslint and Prettier clean;
  **1510 passed, 3 skipped**.
- `a session is one row, one preview and one menu` was repeated against the real
  Electron app after correction 7 and passed.
- The armed End computed styles were read from the real app for rest, hover and
  focus; they match the contrast-tested stylesheet pair.
- All three implementation screenshots were inspected at their original
  1440×900 resolution. The session terminal stays inside the left pane, the
  neighbour keeps its full height, the VS Code selection remains in the owning
  composer, and the preview/menu are unclipped.
- `git diff --check` is clean. Nothing is staged, committed or pushed.

## 8. All of the above was accepted, and then rejected on sight

Everything above was built from the plan's prose. The user then supplied the
composition they had actually approved as an image, and the built app did not
look like it — not in a way a polish pass would close. Small labels where the
reference has readable tiles, empty space where it is dense, panes with almost no
edge. That is a failed implementation of an approved design, and calling it
anything softer would have wasted another pass.

**What that costs, recorded because it is the lesson.** The written brief was
detailed and the implementation followed it; the image was the thing being
judged, and it arrived after the work. The plan's own approval gate was reopened
and rewritten with fixed geometry — rail width, tile height, quota block, tab
header, terminal height, composer height — rather than another prose brief.

Two visual rounds followed. The first was closer but kept a split target hundreds
of pixels wide where the reference has a thin edge strip, and clipped the dragged
session tile off the right edge. The second is the accepted one:

- a compact Chorus + version header, which is an **explicit exception** to the
  reference — the user asked for it after seeing the golden, so `App.tsx` carries
  a 31px `.masthead` with the wordmark and `data-app-version` and no actions;
- a thin dashed right-edge split strip, a visible drag tile, a 212px
  session-only terminal, a 171px composer still showing the VS Code path;
- real transcript content in both panes and no red IDE error in the capture.

Captured at 1440×900 as `visuals/impl-parity-01..04`. The earlier `impl-01..03`
are the rejected build and are kept only so the difference is legible.

## 9. The flake that was not a flake

The full suite then failed 28/31, and the reflex — reruns, C-029, environment —
was half right. Two failures passed alone. One did not: `a merge request
selection says which version it is` failed twice more, waiting for a version
marker that never rendered.

**The cause is a race between two senders, and the harness picked the wrong one.**
`ide-bridge.ts:473` answers the handshake by immediately writing `setRoots` with
whatever the bridge holds at that instant. `ide-bridge.ts:183` sends the real
update later, when the runtime resyncs. `setProjectDirectory` having resolved does
not mean the bridge has the root yet — so the first frame can be empty. The fake
IDE's `awaitRoots()` returned on the first `setRoots` frame it saw, `const [root]
= await ide.awaitRoots()` yielded `undefined`, and `report(undefined, …)` was
filtered out by the bridge's own root check. The spec then sat waiting for a pill
that was never going to be drawn.

**The tell was in the passing specs.** Two other specs call `awaitRoots()` against
the same path and have never flaked — and both of them `find()` through the roots
array or assert its length instead of destructuring `[root]`. The two that
destructure were exactly the two that failed. A race that discriminates by call
shape is not an environment problem.

**Fix — `apps/desktop/e2e/fake-ide.mjs`, test harness only.** `awaitRoots(expect)`
takes the directory the spec just handed the conversation and waits for the frame
that actually carries it, comparing through `realpathSync` because the app
canonicalizes and macOS reaches a temp dir through `/var`, a symlink to
`/private/var`. A root that cannot be resolved compares unchanged rather than
throwing. The two destructuring call sites in `specs.mjs` pass their `project`.
No product code, no UI change.

**Run.** `a merge request selection says which version it is` passes in 6s with
all four assertions, twice consecutively. `Send asks the editor again rather than
trusting the pill`, which shares the call shape, passes with all seven. The full
suite is then **all 31 passed, exit 0, no skips** — the first clean run of the
session. `pnpm check` is **1510 passed, 3 skipped**, typecheck/eslint/Prettier
clean.

One clean run still does not disprove C-029. What is different is that this
failure has a named cause and a fix rather than a shrug.

## Interrupted, and by what

Partway through the diagnosis the codex session driving this work stopped
answering. Its Electron process held **26 children, 16 of them idle
`codex app-server` processes** spawned in a twenty-second burst seventeen minutes
earlier, none using CPU, all ignoring `SIGTERM`. Killing them un-wedged the app.
Six older ones under another parent showed it had happened twice before that day.
Filed as **C-037**; it is not part of this plan and does not affect the code here,
but it is most of why this plan's last hour looked like slow work rather than no
work.

## Still open

- **The user's visual approval of `impl-parity-01..04`.** That is the only gate
  left; nothing is staged, committed or pushed.
- True 200% zoom, and working/waiting/failed states under live agent load, remain
  documented follow-ups rather than things this plan verified.
