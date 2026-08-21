# STATUS — the conversation that got too big

| Phase                         | State          | Notes                                                                                                    |
| ----------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| 1 — Cap hook output           | ✅ shipped     | 8 KiB cap, redacted _before_ truncating, UTF-8 safe                                                      |
| 2 — Stop transporting waste   | ✅ shipped     | New `conversation:transcript` channel; 91% smaller serialized payload; the reducer now enforces the map  |
| 3 — Weigh the carry           | ✅ shipped     | The large fields plus approvals and questions; errs low by design                                        |
| 4 — Profile                   | 🟡 **partial** | The CPU path is measured. **Commit, paint and retention are not.**                                       |
| Review ×2                     | ✅ done        | Codex twice. Round two found a redaction-ordering bug, a scope widening, and three overstated statistics |
| 5 — Paged transcript read     | ⬜ open        | **Ordering against Phase 6 is undecided** and stays that way until paint is measured                     |
| 6 — Virtualise the transcript | ⬜ open        | Cannot touch the reduction, but may own the larger share of the visible freeze                           |

Nothing here has been driven in a running app. **Phase 4 has not met its exit
criteria** — it recorded the CPU path and not the DOM — so the Phase 5/6 ordering
below is an argument, not a finding. `CHORUS_PROFILE_READONLY=1` now exists to
close that gap safely; see "The read-only profiling mode".

---

## Phase 1 — Cap hook output where it becomes a notice

**What shipped.** `MAX_DETAIL_BYTES = 8 * 1024` in
`packages/adapter-claude/src/mapping.ts`, applied inside the `notice()` helper so
every notice route is covered rather than the one that was noticed. A truncated
notice carries `detailOmittedBytes`, and `Entry.tsx` turns it into words —
the reducer has no translator, which is the same reason `noticeSource` is a key.

**Two things the plan did not anticipate.**

`clampDetail` cuts on **bytes and then walks back off a continuation byte**, so
the cap can never split a code point. Cutting at a character index would have
measured the wrong thing (the budget is bytes) and cutting at a byte index
naively would have emitted a lone `U+FFFD`. There is a test that fills the detail
with 4-byte emoji and asserts that removing them leaves the empty string — a
partial code point would survive as `U+FFFD` and fail it.

`detailOmittedBytes` is `.optional()`, **not `.default(0)`**. A default makes the
inferred output type _required_, which broke every existing construction in
`store.test.ts`. The orchestrator spreads it conditionally instead.

**Measured.** 259 notices in the live log averaged 191,907 B — 47.4 MiB of hook
output in one database, from 136 startup, 105 resume and 18 fork notices.

---

## Phase 2 — Stop transporting what the transcript ignores

**What shipped.** A second read channel, `conversation:transcript`, returning
`{ events, throughSeq }`. `Session.tsx` and `QuickQuestion.tsx` use it;
`conversation:history` is untouched.

**Why a second channel rather than a filter on the first.** `conversation:history`
has three consumers with different appetites. `SummaryPanel` counts failures from
`command.completed` and the e2e specs assert on `repo.changed.byUser` — both are
in the ignored set, and filtering the shared channel would have broken them
_silently_, which is the worst possible failure for a performance change.

**`TRANSCRIPT_DISPOSITION` is a total map, not a list.** A plain array of type
names would be a second thing to keep in step with the reducer, wrong the first
time somebody forgot, and the symptom would be an entry that quietly stops
appearing. `Record<ChorusEventType, 'render' | 'ignore'>` will not compile until
a new event type is _classified_ — the same discipline the five downstream
switches already enforce.

**The plan was wrong about one thing, and the plan has been corrected.** It said
the list could be "derived from the reducer's switch". It cannot:
`TranscriptEvent.type` is `z.string()` and `reduceEvents` ends in a `default:`
arm, so there is nothing exhaustive to derive from. The map is where
exhaustiveness has to live instead.

**`throughSeq` is taken before the read, and it is the whole correctness story.**
The read excludes types the transcript has no case for, and `command.output` is
the commonest event in the log — so the newest rows are routinely ones that never
arrive in the renderer. Advancing `lastSeq` only past what was _drawn_ would
leave it behind them and re-query the same range on every push, forever. The
renderer advances to `max(lastSeq, throughSeq)`; the skipped events stay skipped.

---

## Phase 3 — Weigh the carry by what it actually holds

**What shipped.** `withinBudget` counted `message.text.length` — which is the
_one-line summary_, deliberately, because a row stays one line until asked
otherwise. So it measured the smallest field on the message and ignored every
large one. `weigh()` now counts `detail`, `patch`, `summary`, every `folded`
entry's text and detail, and every `changes` file's path, `oldPath` and `patch`.

**The trap the plan named, and how it was kept.** The budget's contract is that a
long transcript does not cost a long scan. Leaving the early exit in the caller
would have kept that at the _message_ level and lost it inside one — a single
`changes` card can carry hundreds of patches, and summing them all only to be
told the total was over turns a memory fix into a CPU one. `weigh` takes the
remaining budget and every loop checks it.

**Proved by removing the fix.** Reverted to `return message.text.length` and all
seven new tests fail; restored, fourteen pass. Two of them are the short-circuit,
asserted with getters that count reads and must never be read.

---

## Phase 4 — Profile, on two conversations, across the whole timeline

`apps/desktop/profile/transcript-timeline.profile.ts`, with its own
`vitest.profile.mts` so a 272 MB fixture can never join the fast suite:

```
pnpm --filter @chorus/desktop exec vitest run --config vitest.profile.mts
```

Against a **pristine copy** at `/tmp/chorus-profile/fixture` (`quick_check: ok`),
never the live store — opening a conversation restores sessions and appends
events, which would make the second measurement describe a different
conversation from the first.

### The methodology, because two drafts of it were wrong

**Draft one — order.** Timing every "before" mark and then every "after" mark
reported the entry-heavy **reduction as 15% slower on strictly fewer events**.
That is not a result, it is an artifact: the first run pays JIT warm-up against a
cold page cache, the second runs against a heap the first one filled. The same
run had SQL taking 33 ms for 6,403 rows and 19 ms for 15,528 — the first fixture
simply went first.

**Draft two — the statistics, and a review caught it.** Interleaving A and B
fixed the drift but always ran A _first within the pair_, so B inherited A's warm
cache on every single repetition. Worse, the comment claimed "paired medians" and
the code took `median(aRuns)` and `median(bRuns)` separately — a difference of
independently-taken medians, which is a different quantity that can come from
different repetitions. **The claim was false.**

`compare()` now flips the order on alternate repetitions so each side leads half
the runs, and returns a real paired figure: the median of the per-repetition
after/before ratio. That ratio is the `paired` column below and is the only
comparison worth reading; the two millisecond columns are per-side medians and
are printed as such.

### The recorded split

Every `paired` figure is the median of the per-repetition after/before for **one
timed operation**, with the leading side flipped on alternate repetitions across
six of them. A stage with no such pair prints `—` rather than borrowing one.

**byte-heavy — `019ff9c5`,** 6,403 events → 3,687 after the filter, 1,219 rows:

| mark                        | history  | transcript | paired    | note                            |
| --------------------------- | -------- | ---------- | --------- | ------------------------------- |
| sql fetch                   | 20.7 ms  | 3.8 ms     | ×0.23     | 6,403 → 3,687 rows              |
| parse + validate payload    | 38.2 ms  | 10.3 ms    | —         | derived: read − sql             |
| main validation             | 5.1 ms   | 2.6 ms     | ×0.51     | zod, rebuilds the array         |
| clone + transfer            | 22.3 ms  | 5.7 ms     | ×0.25     | 16.44 MB → 1.41 MB              |
| preload validation          | 4.7 ms   | 3.4 ms     | ×0.72     | the same schema, again          |
| reduce                      | 10.5 ms  | 9.6 ms     | ×0.93     | 1,219 rows to draw              |
| _(sum of the above)_        | 101.5 ms | 35.3 ms    | —         | a cost model, not a duration    |
| **whole chain, end to end** | **86.9** | **35.3**   | **×0.43** | one closure, stages fed forward |

**entry-heavy — `019fe5f6`,** 15,528 events → 11,470 after the filter, 4,280 rows:

| mark                        | history   | transcript | paired    | note                            |
| --------------------------- | --------- | ---------- | --------- | ------------------------------- |
| sql fetch                   | 10.3 ms   | 9.4 ms     | ×0.93     | 15,528 → 11,470 rows            |
| parse + validate payload    | 37.2 ms   | 23.9 ms    | —         | derived: read − sql             |
| main validation             | 13.9 ms   | 10.4 ms    | ×0.76     |                                 |
| clone + transfer            | 30.4 ms   | 18.8 ms    | ×0.64     | 10.00 MB → 6.98 MB              |
| preload validation          | 12.3 ms   | 9.5 ms     | ×0.78     |                                 |
| reduce                      | 158.9 ms  | 162.3 ms   | ×1.03     | 4,280 rows to draw              |
| _(sum of the above)_        | 263.0 ms  | 234.4 ms   | —         | a cost model, not a duration    |
| **whole chain, end to end** | **283.3** | **249.3**  | **×0.86** | one closure, stages fed forward |

### What these numbers are not

**No process is crossed.** `v8.serialize` is the serialization format Electron's
hop uses and a fair proxy for the _CPU_ of the clone, but it produces a local
buffer and hands it to nobody. The hop, IPC scheduling and context isolation are
absent, and so are `commit` and `paint` — those need a renderer.

**The sum row is a cost model, not a duration.** No single execution ever
produced it, and each stage above is timed on its own input rather than on the
previous stage's output. The chain row is the defensible total: one closure per
repetition with every stage fed the real output of the last.

**`parse + validate` has no ratio at all.** It is `read` minus `sql`, two medians
from different runs, so there is no per-repetition pair to take a ratio of. An
earlier version printed the whole read's ratio in that column and labelled it the
parse stage's, which it was not.

**The entry-heavy reduce at ×1.03 means the filter does not help the reducer** —
expected, since the dropped events have no reducer case. ±5% there is the
instrument's floor.

### What the two fixtures say, and they say different things

**Phase 2 essentially finished the byte-heavy conversation.** ×0.43 end to end,
91.4% off the serialized payload, and the reduction is 27% of what is left.

**The entry-heavy one moved much less (×0.86), and shows where the cost is:** the
reduction is **65% of the whole chain**. Transport was never its problem — its
payload is real transcript, not `diff.updated`.

One fixture would have concluded "transport" and the other "reduction", and both
would have been half right. That was the point of two.

### The renderer half, measured

`node apps/desktop/e2e/perf-transcript.mjs`, under `CHORUS_PROFILE_READONLY=1`,
against the copy. **Preconditions both clean: 0 events appended, 0 agent
processes.** Warm-up open first, so no fixture pays the one-time cost of being
the first transcript in the process, and each count is a _delta_ across mounted
panes.

|                      | byte-heavy   | entry-heavy  |
| -------------------- | ------------ | ------------ |
| rows mounted         | 1,216        | 4,276        |
| DOM nodes            | 15,263       | 58,380       |
| response → reduced   | 8.6 ms       | **156.1 ms** |
| reduced → committed  | **253.2 ms** | **751.7 ms** |
| committed → painted≈ | 121.9 ms     | 194.3 ms     |
| heap mounted         | 107.2 MB     | 146.1 MB     |
| heap backgrounded    | 93.7 MB      | 94.4 MB      |

The row counts are the validity check: 1,216 and 4,276 here against 1,219 and
4,280 from the reducer in the CPU profile. The renderer is drawing what the
reducer produced, so the two measurements are of the same thing.

**`painted≈` is an approximation and is named as one** — two animation frames
after commit, not a compositor timestamp. A `MutationObserver` firing would be
further still and must never be labelled paint.

**Retention works.** Backgrounding releases 13.5 MB and 51.7 MB; the entry-heavy
carry is far over the character budget, so its view is dropped and only the draft,
attachments and scroll position are kept. Both settle to ~94 MB.

### The order: Phase 6 then Phase 5 — a choice, not a measurement

The CPU profile argued for Phase 5, on the grounds that the reduction dominated
everything upstream of the DOM and virtualising could not touch it. **That
argument was sound and incomplete**, because it compared the reduction only
against the things it was bigger than. Against the renderer it is not the
dominant cost:

- entry-heavy spends **156 ms reducing and 752 ms committing** — 4.8×, and commit
  is React reconciling 4,276 rows into 58,380 DOM nodes.
- byte-heavy spends **8.6 ms reducing and 253 ms committing** — 29×.
- Commit plus paint is **946 ms of the 1,102 ms** of marked time on entry-heavy.

**What that establishes is where the time goes. It does not establish which phase
runs first**, and a review was right to press on the difference: **a tail page
would remove the same 4,276-row initial commit.** Phase 5 reading only the last N
events mounts only the last N rows, so it collects most of Phase 6's benefit on
the way past. Either order is defensible on this data.

The order is therefore recorded as an engineering choice: virtualisation is
bounded and local — it changes what `.score-content` holds and nothing about the
log, the read, the IPC contract or the reducer — while paging changes the read
model and carries the boundary-state question this plan has flagged from the
start. Doing the local one first means the harder one lands against a transcript
that already mounts a bounded number of rows, rather than one where a paging bug
and a mounting cost look alike.

### The history sheet had no door, and that is why this took three attempts

Profiling was blocked on something that turned out not to be a profiling
problem: **there was no way to open a past conversation in the app at all.**
`HistoryPanel` rendered, `.history-row` existed, `data-history-conversation` was
on every row — and `setShowingHistory(true)` was called from nowhere. The log
keeps every conversation forever and the UI had no route to any of them.

`git log -S` found it: **`debaae0`, the control-rail and transcript redesign**,
dropped `onOpenHistory` when it replaced the drawer's sidebar with `QuickRail`.
`onOpenSettings` survived the same edit; this one did not.

Restored minimally rather than redesigned — a rail button beside the gear, the
same `history.open` label the old one used, threaded `App → Workspace →
QuickRail`. **This closes C-047 rather than filing it**, since the repair landed.

**Why nobody noticed:** the e2e spec that covers it — "an ended conversation can
be found again and reopened" — reaches the sheet through `openDrawer` and
`.session-drawer-tool`, which the same redesign removed. That spec cannot be
passing, and the suite is not part of `pnpm check`.

**The guard therefore went in the fast suite instead**, as
`workspace/quick-rail-history.test.tsx`: the button exists, it is labelled, and
pressing it calls `onOpenHistory`. Removing the button fails all three. A
rendered test because the defect _is_ the rendered button; repairing the e2e spec
would have produced a guard that still never runs.

**Left standing, and not repaired here.** The same redesign orphaned more than
one feature: `SessionRow`'s row component is no longer rendered anywhere (only
`StateMark` is still imported), `data-arrange-toggle` exists in no source file,
and `.session-drawer` survives only in `styles.css`. Six `specs.mjs` cases drive
that removed UI through the dead `openDrawer` helper. That is a cleanup with its
own decisions in it — which of those features were meant to survive the rail —
and it is not part of this plan.

### The read-only profiling mode

`CHORUS_PROFILE_READONLY=1`. The app opens, reads the event store and renders
transcripts exactly as always, but **starts no session and launches no CLI**.

It exists because the missing marks could previously only be taken by opening a
real conversation, which restores sessions and spawns the user's `claude` and
`codex` against their actual repositories — a side effect nobody should trigger
to take a measurement.

**Two chokepoints, because one is not enough.** Suppressing restore stops the
conversations saved at quit from coming back, but the profiler has to _open_ one
and `conversation:reopen` starts agents by its own route. So command resolution
returns `null` as well, which is the app's existing "the CLI is not installed"
path — already handled everywhere and failing closed.

Its test asserts the two doors rather than the switch, and calls the real
resolver closures: `codexOptions()` was lifted out of `defaultAdapters` for
exactly that reason, because the only way to reach an inline closure was to copy
its body, and a test that asserts a duplicate passes when the original breaks.

Removing either guard fails the test.

---

## The second review, and what it changed

Codex reviewed again and found six more. Five are fixed; one is the open question
above.

**1 — Hook details bypassed redaction, and the cap made it worse.** `detail` was
missing from `TEXT_FIELDS` in `redact.ts`, so the field that carries **arbitrary
hook output** — `env`, an echoed token, a file a script read — was never
redacted at the store. Worse, `clampDetail` ran first, so the 8 KiB boundary
could cut through the middle of a credential and the surviving leading half would
no longer match the pattern that recognises it: **a secret that would have been
caught whole became an unrecognisable partial secret, stored forever.**

Fixed in both places: `detail` joins `TEXT_FIELDS`, and `notice()` redacts the
complete string _before_ clamping. Proved by reversing the order — a
`ghp_AAAA…` fragment survives into the log, and the new test catches it. A second
test covers the marker for a secret that fits inside the cap, because the
straddle case alone cannot tell redaction from truncation.

**2 — Phase 1 had quietly widened its own scope.** The plan said "cap hook
output"; the cap sits in the shared `notice()` helper and therefore bounds every
Claude notice detail. **Approved deliberately rather than reverted**: an
unbounded `detail` is the bug, and a denial reason can be exactly as large as a
hook's. Now documented as a general notice-detail policy where it lives.

**3 — The drift test proved nothing.** It fed each ignored type an _empty_
payload, so a future reducer case reading real fields could return early and
leave it green. Two changes: `reduceEvents` now consults `TRANSCRIPT_DISPOSITION`
directly, immediately after advancing `lastSeq`, so ignored events are
unreachable in both the live and replay paths by construction; and the test feeds
a payload rich enough to render, with a control proving that same payload does
produce a row under a `render` type.

Proved by simulating the future: adding a `command.completed` case to the reducer
keeps the test green **with** the guard and fails it **without**.

**3b — The IPC handler and the Session wiring had no tests.** Four now cover the
handler, including the one that matters: `throughSeq` is taken _before_ the read,
asserted with a runtime whose log position moves during it. The `Session` rule
was extracted as the pure `reduceTranscriptRead` and has five, including the
empty-response case that is the loop this prevents, and the push-overtook-the-read
case where assigning rather than `max` would move `lastSeq` backwards.

**4 — Three of the profiler's statistics were mislabelled.** Fixed as described
above: clone+transfer is one timed closure instead of two averaged ratios,
parse+validate prints no ratio, `REPS` is even so the lead genuinely alternates,
and the headline total is a real end-to-end chain rather than a ratio of sums of
independent medians.

**5 — Phase 4 was marked complete while its exit criteria were unmet.** Now
marked partial, with the ordering explicitly open.

**Smaller** — `withinBudget` was described as counting "every string" and does
not. The comment now says what it skips, and states the direction of the error:
it undercounts, so the trim fires slightly _later_ than a perfect measure would,
never earlier.

---

## Phase 6 — Virtualise the transcript · **shipped**

`transcript-window.ts` holds the arithmetic and `Session.tsx` holds the
lifecycle. Only the **history** slice is windowed; the current turn stays whole
because it is the live region, it is what following pins to, and it is bounded by
one turn. A single pathological turn with thousands of tool rows is **not**
covered, deliberately.

### Measured, on the same two fixtures, the same way

|                         | byte-heavy before → after | entry-heavy before → after |
| ----------------------- | ------------------------- | -------------------------- |
| rows mounted            | 1,216 → **33**            | 4,276 → **34**             |
| DOM nodes               | 15,263 → **1,378**        | 58,380 → **568**           |
| response → reduced      | 8.6 → 9.2 ms              | 156.1 → 198.9 ms           |
| reduced → committed     | 253.2 → **60.4 ms**       | 751.7 → **28.2 ms**        |
| committed → painted≈    | 121.9 → **25.2 ms**       | 194.3 → **14.5 ms**        |
| click → painted≈ (wall) | 942 → **357 ms**          | 1,878 → **802 ms**         |
| heap mounted            | 107.2 → **26.2 MB**       | 146.1 → **29.3 MB**        |

**Commit fell 26× on the entry-heavy fixture** and DOM nodes fell 103×. The
reduction did not move, which is exactly right — virtualisation cannot touch it,
and that was the argument for doing Phase 5 at all.

**One number is not a like-for-like comparison.** Heap "at start" fell from
82.5 MB to 20.0 MB, but that is the _restored panes_ being windowed too, not this
fixture. It is a real improvement and it is not the one this table is measuring.

### Correctness, which is what the exit criteria actually asked for

Mounting 34 of 4,276 rows is only an improvement if the other 4,242 are still
reachable. Asserted in Chromium, in `e2e/perf-transcript.mjs`, because none of it
can be checked in jsdom:

- **The whole conversation still has height** — 92,340 px and 307,781 px of
  scroll, so the scrollbar describes the conversation rather than the window.
- **The beginning is reachable** — scrolling to the top mounts **row 0** on both.
- **The end is reachable** — and following resumes when it is reached.
- **A selection survives being scrolled away from** — 600 and 478 characters held
  across the window boundary. **Proved load-bearing:** with `setPinned` disabled
  both fixtures report `LOST WHEN SCROLLED AWAY`.

### Three things the measurement corrected

**The compensation was fighting the scroll.** Compensating for _every_ top-spacer
change also compensated for the ones scrolling causes, which is a feedback loop:
scroll up, the window moves, the spacer legitimately shrinks, and the
compensation pushes the scroller back down. Driven: `scrollTop = 0` on a
4,276-row transcript settled at **row 1,183** and would not reach the top. The
correction only applies when the window's `start` is unchanged — a spacer change
then means rows above were _re-measured_, which is the only case a reader must
not see.

**Following stops on a gesture, not on a position** — deliberately, since several
things move `scrollTop` that are not a reader. The first version of the
reachability check assigned `scrollTop` directly, left the pane following, and
reported the top as unreachable when it was the check that was wrong. It
dispatches a real wheel event now.

**The checks measured the wrong pane.** Up to four are mounted, each with its own
scroller, and querying the first `.score` reported an identical scroll height for
two different conversations — the same mistake the row counts made before they
became deltas. Scoped by `[data-conversation]`.

Also hit, and worth recording because `CLAUDE.md` documents it for SQL: **a
backtick inside a template literal ends the string.** A comment mentioning
`.score` inside a `Runtime.evaluate` block truncated the expression and the
failure named none of that.

### What is still unverified

- **Tail-following through a live stream.** `CHORUS_PROFILE_READONLY=1` starts no
  agent, so nothing streams. What is checked is that reaching the bottom resumes
  following and that a following pane renders the tail.
- **Scroll restore across a remount.** The anchor is unit-tested and round-trips
  through a re-measurement, but dragging a pane to another pane and checking
  where it lands has not been driven.
- **Momentum scrolling and selection under a real pointer.** Not driven.

---

## Phase 5 — A paged transcript read model · **shipped**

A cold open reads the newest **400 events**, not the conversation. Scrolling
within a screenful of the top fetches the 400 before them. Coming back to a pane
that still holds its transcript is unchanged — that is a catch-up, and asks
`afterSeq` as it always did.

### Measured

|                         | byte-heavy         | entry-heavy        |
| ----------------------- | ------------------ | ------------------ |
| response → reduced      | 9.2 → **0.6 ms**   | 198.9 → **0.7 ms** |
| reduced → committed     | 60.4 → 63.1 ms     | 15.7 → 15.7 ms     |
| click → painted≈ (wall) | 357 → 541 ms       | 802 → 508 ms       |
| heap mounted            | 26.2 → **17.7 MB** | 29.3 → **17.7 MB** |

The reduction is gone — **284× on the entry-heavy fixture** — which is what this
phase was for. Commit is unchanged, correctly: Phase 6 already bounded it, and
these two now compose rather than overlap. Wall clock is noisy at this scale and
should not be read as a result either way.

### The boundary-state question, answered

The plan flagged this from the first draft: a page is a _suffix_, so anything
derived by accumulation cannot be rebuilt from it. The choice was a **checkpoint
shipped with the page** or **projections**, and projections win because a
checkpoint is a snapshot of derived state — a second source of truth for
something the log already determines. Projections commit in the same transaction
as the append, so they can never be ahead of the log and can always be rebuilt.

Most of it already existed:

- **approvals** — the `approvals` table has `outcome`; pending is `outcome IS
NULL`. A query, no new projection.
- **working** — the last `turn.started` per agent with no later
  `turn.completed`. An indexed query over events, not accumulated state.
- **spend / usageByActor** — `usage.updated` carries totals, not deltas, so the
  latest per agent is the answer.
- **questions** — the one genuine addition, migration 3. Shaped like `approvals`.

**A comment had to be retracted to add it.** `projections.ts` recorded that
questions deliberately had no table because "the only reader is the UI, which
rebuilds what is still pending by replaying the log". That reason expired the
moment the transcript stopped replaying the log, and the comment now says so.

### The prepend path

`prependEvents` is a **second entry point, not a relaxed guard**. `reduceEvents`
skips anything at or below `lastSeq`, and that guard is what silently discarded a
hundred backfilled rows earlier in this plan when a push overtook the initial
read. It folds rows in ahead, moves `firstSeq`, and **touches no accumulated
state** — an approval on an early page may well have been decided on a later one,
and folding it would resurrect a blocking card for a decision already taken.
There is a test for exactly that.

### Two bugs the measurement caught

**The scroll guard was suppressing the handler, not the inference.** A synthetic
scroll returned early, which also skipped the viewport update _and_ the
earlier-page fetch. The diff-heavy fixture fires a spacer compensation on nearly
every row it measures, so by the time a reader reached the top every scroll was
being swallowed — and since assigning `scrollTop = 0` when it is already 0 fires
no further event, the counter never drained. **The transcript would simply have
ended, with no error and a very fast number.** The guard now suppresses only the
decision about what the reader wants.

**The paging check measured after the thing it was checking.** Its baseline was
taken following the scroll that triggers the fetch, and a 400-event page can land
inside the three frames that follow — so the delta read zero and paging looked
broken when it worked.

### The migration blocker, found in review

**Migration 3 created the `questions` table and did not fill it**, and nothing
rebuilds projections on startup — `EventStore.open` runs `migrate()` and returns.
Since the paged transcript reads pending questions from that table rather than by
folding the log, **an upgraded database would have shown no question an agent was
already waiting on**: no card, no error. Every test passed, because a fresh
database has nothing to lose. Caught by review, not by running it.

Backfilled in SQL inside the migration's own transaction rather than by calling
`rebuildProjections()` afterwards — rebuilding replays every event into every
projection to populate one table, and it would run _outside_ the transaction that
created it, so a failure would leave the schema migrated and the table empty.

**Measured on the real database:** 249,099 events, **65 ms**, all 212 questions
backfilled and every one correctly marked answered. Seven upgrade tests build a
genuine pre-v3 database; removing the backfill fails four of them.

**And a second review found a consistency bug behind the first one.** The
backfill filled the table but never wrote the projection's high-water row.
`questions` is in `PROJECTION_NAMES`, so `projectionDrift()` asks for that row
and reads a missing one as sequence 0 — reporting a table that was in fact
completely up to date as **249,099 events behind**, until the next append bumped
every projection at once and the symptom disappeared on its own. A consistency
check that heals itself is the worst kind to leave broken.

Seeded in the same migration transaction, from `MAX(seq)` over the log, because
the backfill reads the whole log and the whole log is what the projection has
therefore seen.

**The upgrade fixture could not have caught it**, and that was the other half of
the finding: it inserted events and left `projection_state` empty, so _every_
projection read as 0 and a missing row was invisible in the noise. It now seeds
the five projections that existed at v2 — deliberately not `PROJECTION_NAMES`,
which would seed the very row under test — and asserts `projectionDrift()` is
empty after the upgrade. Removing the seed fails it. On the real database: the
five v2 projections sat at 249,099, and drift after upgrade is `[]`.

That is the third time in this plan that **a backtick inside a template literal**
ended the string early — the trap `CLAUDE.md` records for SQL, hit in a SQL
comment this time. The comment now says so, in the file, without backticks.

### What is unverified

~~**The harness's paging assertion is unreliable on the byte-heavy fixture.**~~
**Fixed, and it was the harness.** The checks waited on frames and timers _inside_
a single `Runtime.evaluate`, and Chromium throttles both in a window it considers
occluded — so whenever another Electron had the foreground the block either timed
out or read a page that had not been given time to arrive. Driven from Node
instead, one short evaluate at a time, **both** fixtures now report paging:
+1,275 px on byte-heavy and +7,045 px on entry-heavy.

**What shows while an earlier page loads is still undecided** — the open question
the design named. Today it is nothing: the reader reaches the top and rows appear
when they appear. Nobody has watched that happen at a real scroll speed.

**Page eviction is deliberately absent.** Scrolling to the top of a long
conversation still ends with everything in memory.

---

## Phase 6 is deferred, not shipped

**Backed out of 0.20.0 deliberately.** It worked — 58,380 DOM nodes to 568,
commit 751.7 ms to 28.2 ms — and it cost the reader their scroll position every
time they switched tabs (C-049). The attempted fix, carrying the measured row
heights alongside the anchor so `scrollTopFor` could convert it, stopped one pane
mounting at all, nondeterministically. A control run with only that change
reverted had both fixtures mounting cleanly, so the carry was the cause rather
than the environment.

**What made deferring the right call rather than a retreat.** Phase 5 bounds the
first mount to **400 events** on its own, and 400 events is a few hundred rows,
not four thousand. The freeze this plan was written about is fixed without
virtualisation; what Phase 6 adds on top is an optimisation. Shipping a
transcript that forgets where you were reading, in order to make a transcript
that is already fast slightly faster, is a bad trade.

**Measured after the back-out**, same fixtures, same harness:

|                         | byte-heavy | entry-heavy |
| ----------------------- | ---------- | ----------- |
| rows mounted            | 130        | 159         |
| DOM nodes               | 4,716      | 2,210       |
| response → reduced      | **0.7 ms** | **0.6 ms**  |
| reduced → committed     | 71.1 ms    | 33.4 ms     |
| committed → painted≈    | 38.0 ms    | 11.2 ms     |
| click → painted≈ (wall) | 510 ms     | 312 ms      |

Against the numbers this plan opened with — 198.9 ms reducing and 751.7 ms
committing 4,276 rows — the paged read alone does the work. Commit is 33 ms on
the fixture that used to take 752, because there are 159 rows to commit instead
of 4,276.

`transcript-window.ts` is kept, parked, with its twenty tests and a note at the
top saying nothing imports it. It compiles into nothing while that stays true.

**What replaced the spacer compensation.** With rows fully mounted, a prepended
page adds real height above the viewport and pushes the reader down by exactly
that much. A layout effect subtracts it in the same commit, guarded on the
message count changing — `scrollHeight` also moves when a diff card expands or
markdown reflows, and correcting for those would fight the reader instead of
helping them.

**Scroll restore, as it now behaves.** byte-heavy leaves at 16,777 px and comes
back at 16,777 px. entry-heavy leaves at 14,622 px and lands at the bottom —
because `trimCarry` dropped its view for exceeding the character budget (rows
499 → 163 on return), so the replayed transcript is shorter than the offset that
was saved and the restore's own two-second wait gives up. That is the documented
pre-0.19.7 behaviour of the pixel carry, not something this work introduced.
