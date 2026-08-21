# The conversation that got too big

Opening a long conversation freezes the app. Not one window — all of them.

## The problem

Reported as "slower, lag, a freeze, like a memory leak in big chatting, in
0.19.7". Measured on the live database rather than reasoned about:

|                         |                                             |
| ----------------------- | ------------------------------------------- |
| events                  | **247,800**                                 |
| stored payload          | **169,448,259 B — 161.6 MiB**               |
| database on disk        | 279,744,512 B                               |
| heaviest by **bytes**   | `019ff9c5` — 6,403 events, **8,723,939 B**  |
| heaviest by **entries** | `019fe5f6` — **15,528 events**, 5,514,050 B |

Those last two are different conversations, and the difference is the point —
see Phase 4.

**The unbounded mechanisms below all predate 0.19.7**; that release was the
usage bars and the hover panel, and nothing in it touches these paths. That is
_not_ the same as proving no regression landed in it. Nobody has profiled 0.19.6
against 0.19.7 or bisected, so "it got slow because it got big" is the leading
explanation and not an established one.

### Four unbounded paths

**1. History is read whole, synchronously, on the main thread.**
`conversation:history` takes `conversationId` and an optional `afterSeq` — no
limit. `runtime.history` calls `store.read(...)` without one, though `store.read`
accepts it. Opening a conversation reads every row, `JSON.parse` and
`ChorusEventPayload.parse` per row in `toStoredEvent`, validates _again_ crossing
the IPC boundary, and structured-clones the result. better-sqlite3 is synchronous
and on the main thread, so this blocks **every window** — which is why it reads
as an app-wide freeze rather than a slow tab.

**2. A third of what is transported is thrown away on arrival.**
`reduceEvents` has no case for `command.output`, `diff.updated` or
`command.completed`. They are read, parsed, validated twice, cloned, and
discarded:

| ignored by the reducer | events     | bytes                                 |
| ---------------------- | ---------- | ------------------------------------- |
| `command.output`       | 28,715     | 34,012,906                            |
| `diff.updated`         | 1,383      | 15,673,741                            |
| `command.completed`    | 20,936     | 1,784,068                             |
| others                 | 767        | 479,015                               |
| **total**              | **51,801** | **51,949,730 — 30.6% of all payload** |

**3. The transcript mounts every message.** `view.messages.map(...)` in
`Session.tsx`, with no virtualisation and no cap.

**4. A background tab keeps its transcript, and the budget cannot see it.**
`carry.ts`'s `withinBudget` counts `message.text.length` and nothing else — not
notice details, not folded command output, not patches, not changes. So a carry
holding tens of megabytes measures as "within budget" and is never trimmed. This
is the path that explains heap not returning after a tab switch; it is not an
unexplained second problem.

**And the hook that wrote 47 MiB.** 259 notices exceed 50 KB:
**49,703,893 B (47.4 MiB)**, mean 191,907, min 183,096, max 204,005 — 98.7% of
all `notice.raised` bytes. They are `SessionStart` hook output in three kinds:
**136 `startup`, 105 `resume`, 18 `fork`**. Nothing caps hook output where it
becomes a notice.

### Why the obvious fix is wrong

"Pass a limit" is not incomplete, it is incorrect, and three separate things make
it so. This section exists so nobody re-derives the cheap version and ships it.

- **`store.read({ limit })` returns the OLDEST events.** The SQL is
  `ORDER BY seq${limit}`, ascending — the beginning of the conversation, which is
  the opposite of what a transcript opens to.
- **There is no `beforeSeq`.** The read API walks forward from a point and does
  nothing else, so upward paging has no expression in it.
- **`reduceEvents` silently drops anything older.** `transcript.ts:271` is
  `if (event.seq <= next.lastSeq) continue`. A limit alone would not show less
  history; it would show **no older history, ever**, with no error.

And a fourth, about correctness rather than plumbing: **a tail of raw events
cannot reconstruct the view.** Approvals, questions, the active turn, usage
totals, tool state and change cards all begin before an arbitrary cutoff.

---

## Phase 1 — Cap hook output where it becomes a notice

**Goal.** No hook can write 200 KB into the log, and a truncated notice says so
in the reader's language.

**Where.** `packages/adapter-claude/src/mapping.ts`, the hook arm.

**The contract, because "cap it" is not one.**

- A byte limit, not a character limit, since the concern is transport and
  storage. **8 KiB** of `detail`, which holds a stack trace or a short report
  and refuses a document.
- **Truncation must be UTF-8 safe** — cutting a byte array mid-sequence produces
  a replacement character or an invalid string, and this is a log that other
  software reads.
- **A typed `detailOmittedBytes: number`** on the payload, _not_ an English
  marker appended to the text. `mapping.ts` has no translator, and the project
  rule is explicit: events carry keys and the renderer turns them into words.
  Appending "…truncated" in the adapter would be a hardcoded user-facing string
  in the one place that must not have them.
- The renderer reads that number and says so, translated.

**This is not a one-file edit, and it is not five either.** Typed omission
metadata has to cross the protocol's `Notice`, the adapter mapping, the
orchestrator that propagates it, the stored-event schema, the transcript model
and reducer, `Entry`, and i18n — plus tests at both ends. The projection is the
one place that needs nothing: `notice.raised` is already an explicit no-op there,
and this changes no query's answer.

**~~Deliberately not doing: a generic cap on `notice.detail`.~~ Reversed — the
generic cap is what shipped.** The argument here was that size is a property of
where the text came from and the schema cannot see that. True of the _schema_,
and irrelevant to the fix: the cap went into the shared `notice()` helper in
`mapping.ts`, which sees exactly where the text came from and caps all of it
anyway. A review caught the widening, and it was approved deliberately rather
than narrowed — an unbounded `detail` is the bug, and a denial reason or an error
body can be every bit as large as a hook's. The measured case was hooks; nothing
about the failure is specific to them.

**Also not anticipated here:** `detail` was missing from `redactPayload`'s
`TEXT_FIELDS`, so hook output — arbitrary shell output — was never redacted, and
clamping _before_ redacting would have cut the 8 KiB boundary through the middle
of a credential and left an unrecognisable half. Redaction now runs first. See
STATUS.

**Exit criteria.** A hook emitting 200 KB yields a bounded event carrying the
omitted count; a normal notice is byte-identical to before; truncation at a
multi-byte boundary is covered by a test.

---

## Phase 2 — Stop transporting what the transcript ignores

**Goal.** The 30.6% the reducer discards never leaves the database.

**Why before paging.** It is a filter, not an architecture. It bounds bytes
without touching the boundary-state question, and it may move the number enough
to change what Phase 5 needs to be.

**It cannot narrow `conversation:history`.** That channel has three renderer
consumers — `Session.tsx:400`, `SummaryPanel.tsx:44`, `QuickQuestion.tsx:343` —
and the e2e specs read it to assert what was logged. `SummaryPanel` counts
failures from `command.completed`, which the transcript ignores; the log checks
read `repo.changed.byUser`, likewise. Filtering the shared channel would silently
break both. **So this is a new transcript-specific read**, for `Session` and
`QuickQuestion`, with raw history left exactly as it is.

**It must return a high-water sequence, not just events.** `Session` asks for
everything after `view.lastSeq`. If the newest events are ones the transcript
ignores — and `command.output` is the commonest event in the database — the
filtered response is empty, `lastSeq` never advances, and the same rows are
queried again on every push. The response is therefore `{ events, throughSeq }`,
and the view advances to `max(lastSeq, throughSeq)` **without** those events
reaching the reducer. A filter that forgets what it filtered is a loop.

**The allow-list cannot be derived from the reducer, and an earlier draft of
this plan said it could.** `TranscriptEvent.type` is `z.string()`, and
`reduceEvents` ends in a `default:` arm — so the switch is neither exhaustive nor
introspectable, and there is nothing to derive _from_. What this needs is **one
shared disposition map over every stored event type**, exhaustive by
construction, from which the SQL list is generated and to which the reducer is
narrowed. That is the same discipline the five-file rule already applies to
adding an event type: a new type must be _classified_, not silently dropped.

**Not a change to the log.** Every event is still appended and still stored.

**Exit criteria.** Opening `019ff9c5` transports none of the ignored payload,
with the **actual transport reduction recorded** — 84% describes its _stored_
payload, not the serialized IPC envelope, and the two are not the same number.
`SummaryPanel`'s failure counts and the e2e log assertions are unchanged.

---

## Phase 3 — Weigh the carry by what it actually holds

**Goal.** A background tab's budget reflects its memory.

`withinBudget` counts `message.text.length`. Everything else a message carries —
notice detail, folded output, patches, changes — is uncounted, so the trim never
fires on the conversations that most need it.

**The trap:** the budget's own comment says it stops counting at the budget so a
long transcript does not cost a long scan. A fuller weighing must keep that
property, or the fix for a memory problem becomes a CPU one.

**Exit criteria.** A carry holding a 200 KB notice detail is measured as over
budget and trimmed; the scan still short-circuits.

---

## Phase 4 — Profile, on two conversations, across the whole timeline

**Goal.** Know which path dominates before building Phase 5 or 6.

**Two fixtures, because one cannot tell the costs apart.**

- **Byte-heavy:** `019ff9c5` — 6,403 events, 8,723,939 B, of which
  `diff.updated` is **7,324,954 B (84%)**, every byte of it ignored by the
  reducer. This isolates database and transport.
- **Entry-heavy:** `019fe5f6` — **15,528 events**, 5,514,050 B, thousands of
  commands and tools that _do_ become entries. This isolates reduction and DOM.

Profiling only the first would attribute a DOM cost to SQLite, and only the
second would miss the transport cost entirely.

**Instrument the whole timeline, not two points.** An earlier draft of this plan
measured `runtime.history` and then resumed at IPC return — which hides
main-side response validation, structured cloning, the IPC hop itself, and
preload validation. Every one of those scales with the payload. The marks:

`invoke → db read → main validation → structured clone (CPU) → preload
validation → reduce → commit → paint`

**Renamed after the fact.** This said `clone+transfer`, and no transfer is
measured: `v8.serialize`/`deserialize` produce and read a local buffer in one
process. It is a fair proxy for the CPU Electron's hop spends on the same
algorithm and nothing more — the hop, IPC scheduling and context isolation are
outside every number this plan reports.

Clone and transfer are **one combined interval** rather than two: Electron
exposes no application-level mark between serialising a structured clone and
handing it across, so splitting them would be inventing a boundary the runtime
does not offer.

**Also measure retention**, since "memory leak" is the reported symptom: heap
after mount, after switching away, and after the carry is trimmed.

**Against a pristine copy of the production database**, never the live one.
Opening a conversation restores sessions and appends events, so profiling the
real file would mutate the fixture between runs and make the second measurement
describe a different conversation from the first.

**Exit criteria.** A recorded split across all of those marks, for both
fixtures, and an explicit statement of which of Phase 5 and Phase 6 runs first
and why.

---

## Phase 5 — A paged transcript read model

**Goal.** Open a long conversation without reading all of it, and stay correct
about state that started before the window.

Needs, at minimum: **`beforeSeq`** on the read API; **a prepend path** in the
reducer, as its own entry point rather than a relaxed guard, because the guard
is what makes live streaming safe; and **boundary state** — approvals,
questions, the active turn, usage totals, tool state — as either a projection
the store maintains or a checkpoint returned with the page. That choice is the
design and should be argued here before any code.

**What Phase 6 changed about this.** Virtualisation removed the _mounting_ cost
— 58,380 DOM nodes to 568, commit 751.7 ms to 28.2 ms — and left the rest
standing. What Phase 5 now targets is what the profile still shows: **199 ms of
reduction** on the entry-heavy fixture and the read beneath it (SQL, two Zod
validations, a structured clone), all of which still handle every event in the
conversation.

### The design

**A page is a suffix, and "earlier" is a second call.** The first read returns
the last `N` events; scrolling to the top of the history asks for the `N` before
`beforeSeq`. Not offsets — `seq` is monotonic and dense enough, and an offset
into a filtered set changes meaning as the filter changes.

**`N` is events, not rows.** The transcript filter already drops the types the
reducer has no case for, so a page of events is a page of _rows_ to within the
filter — and a page counted in rows would need the reducer to run before the
query could stop, which is the thing being avoided.

**Boundary state comes from projections, not from the page — and most of it
already exists.** This is the choice the plan said had to be argued, and the
argument is that a _checkpoint returned with the page_ is a snapshot of derived
state, which is a second source of truth for something the log already
determines. Chorus has one rule and it is that the log decides. Projections are
how this codebase already reconciles the two: they update in the same
transaction as the append, so they can never be ahead of the log and can always
be rebuilt from it.

Taking the pieces of `TranscriptView` one at a time:

- **`approvals`** — the `approvals` table already exists, with `outcome` and
  `decided_at`. Pending ones for a conversation are `outcome IS NULL`. No new
  projection; a query.
- **`working` / `busy`** — `agent_sessions` already carries `status` per agent.
  The active _turn_ does not have a projection and would need one, or can be
  derived from the last `turn.started` without a matching `turn.completed` — one
  indexed query rather than a fold.
- **`spend` / `usageByActor`** — `usage.updated` carries totals rather than
  deltas, so the latest event per actor is the answer. A query, not a fold.
- **`questions`** — no projection today. This is the one genuine addition, and
  it is the same shape as `approvals`: requested, then answered or expired.
- **`openChanges`** — held between events _within_ a turn, and only meaningful
  while a turn is open. It comes back with the last page, because the last page
  is where the open turn is.
- **`lastSeq`** — already carried, as `throughSeq`.

So the read becomes `{ events, throughSeq, state }`, where `state` is queried
rather than folded, and the reducer's job on a page is rows only.

**The prepend path is a second entry point, not a relaxed guard.** `reduceEvents`
skips `seq <= lastSeq`, and that guard is what makes the live stream safe — the
same guard that, before Phase 2's buffering fix, silently discarded a hundred
backfilled rows when a push overtook the initial read. Prepending must therefore
be `prependEvents(view, older)`: it folds an _earlier_ range into `messages`
ahead of what is there, touches no state, and moves a separate `firstSeq` rather
than `lastSeq`. Two entry points with two guards, rather than one guard that has
to be right about direction.

**It composes with Phase 6 rather than duplicating it.** Virtualisation bounds
what is mounted from what is loaded; paging bounds what is loaded at all. A page
arriving at the top is a spacer growing, which is exactly the case the windower
already compensates for atomically.

### What Phase 5 is deliberately not doing

- **Not evicting pages once loaded.** Scrolling to the top of a long conversation
  will still end with everything in memory. Bounding _that_ needs a policy for
  what to drop and a way to put it back, and the measured problem is the first
  open, not the reader who deliberately walked the whole history.
- **Not changing what is stored.** `command.output` is still 34 MB in the log;
  Phase 2 stopped transporting it and this does not revisit that.
- **Not a new query for `messages`.** The `messages` projection exists and this
  does not use it — the transcript is built from events, and a second path to the
  same rows is a second thing to keep true.

### The open question this leaves

**What does the transcript show while an earlier page is loading?** A gap, a
spinner, or nothing until it arrives — and if the answer is "nothing", a fast
scroll to the top is a blank screen. This interacts with the windower's spacers,
which already reserve the right height for rows that are not mounted. The honest
answer is that it should be _measured_ before it is decided, on the same two
fixtures, and it is the first thing to settle when this phase starts.

---

## Phase 6 — Virtualise the transcript

**Goal.** A conversation with thousands of messages mounts a bounded number.

**Phases 5 and 6 are not alternatives**, and an earlier draft was wrong to call
this one "cosmetic if the read dominates". They bound different things: paging
bounds what the database, IPC and model carry; virtualisation bounds what the
DOM mounts. A paged transcript still mounts everything it has loaded. Phase 4
decides the order, not whether one is needed.

**The trap to name now:** sticking to the bottom, restoring a scroll position
and quoting a passage are all written against a fully-mounted list.

**Phase 4 measured that mounting is the larger cost. It did not measure that
this phase must come first.** The entry-heavy fixture spends **156 ms reducing
and 752 ms committing** 4,276 rows into 58,380 DOM nodes; commit plus paint is
946 ms of 1,102 ms of marked time. That establishes where the time goes and
nothing more — because **a tail page would remove the same 4,276-row initial
commit.** Phase 5 loading only the last N events mounts only the last N rows, so
it collects most of this phase's benefit on the way past.

So the order is an **engineering choice, recorded as one**:

- Virtualisation is bounded and local. It changes what `.score-content` holds and
  nothing about the log, the read, the IPC contract or the reducer.
- Paging changes the read model, and its hard part — what a page boundary does to
  state that accumulates across events, an approval requested on page 3 and
  decided on page 5 — is the open question this plan has flagged from the start.
- Doing the local one first means the harder one lands against a transcript that
  already mounts a bounded number of rows, rather than against one where a paging
  bug and a mounting cost look alike.

A reasonable person could take these in the other order, and the measurement does
not settle it.

**Exit criteria.** Only the visible window is mounted, and each of these still
works — they are the things a fully-mounted list gives away for free, so each has
to be re-established deliberately rather than assumed:

- **Tail-following.** A conversation that is at the bottom stays at the bottom as
  an agent streams into it, and one scrolled up stays where it is put.
- **Scroll position.** Where you were reading survives leaving the pane and
  coming back, which today rides in `SessionCarry` as a pixel offset — a number
  that means nothing once rows are not all mounted.
- **Selection and copy across the boundary.** Dragging a selection past the edge
  of the window, and copying it, must not stop at whatever happens to be
  mounted. This is the one most likely to be discovered by a user rather than by
  a test.
- **Interactive rows stay interactive.** Approvals and question sets are not
  text; an unmounted approval is a decision nobody can take, and one that
  remounts must not lose what was typed into it.

**Not exit criteria:** a smoother scroll, or a lower idle memory figure. Both are
likely and neither is what this is for.

### The design

**Hand-written windowing inside the existing scroller, not a library.**

This is the decision most worth arguing, because the xterm and Monaco entries in
`CLAUDE.md` say the opposite for their problems. The distinction is what the hard
part _is_. A VT emulator is a conformance problem — hundreds of escape sequences
whose behaviour is defined by what `xterm` does — and guessing it is the "inferred
shape" failure one level up. Virtualisation is not a conformance problem; it is a range-and-height
calculation, and that is the only part being written here.

**The reason is ownership of _this_ scroller, not a claim about libraries.** An
earlier draft said "every list library wants to own the scroll container", which
is too broad and is not true of all of them. The narrower and sufficient point:
`.score` already carries four behaviours that were each arrived at by fixing a
real bug — a `ResizeObserver` that pins a following transcript, an `onScroll`
that resumes following from position, gesture handlers that stop it on intent
rather than on position, and a restore that waits for the content to be tall
enough before it writes once. Chorus keeps that scroller and its handlers and
isolates only the range/height calculation behind a pure function. A library
adopted here would have to be one that accepts an externally-owned scroller and
supplies only that calculation — at which point it is supplying a function this
phase can write and test directly.

**Heights are measured, never estimated after first sight.** A `Map<key, number>`
filled by a `ResizeObserver` on each mounted row, seeded with a per-kind guess for
rows never yet seen. This matters more here than in a typical list because rows
_grow after mount_: markdown reflows, diff cards expand, `Entry` lazily renders
patches. The observer is already the mechanism the pane trusts for exactly that.

**Following is a mode, not a computation.** Today it is
`el.scrollTop = el.scrollHeight`. Rather than making that survive an estimated
bottom spacer, a following transcript renders **the tail window directly** — the
last N rows, no bottom spacer at all — so the bottom is a real bottom and the
existing pin is exact. Estimation error can then never move a pinned transcript,
which is the failure mode people notice fastest.

**Scroll position becomes an anchor, and `SessionCarry` changes shape.** Today it
carries `scrollTop: number`. A pixel offset is meaningless once heights above it
are estimates — the restore loop's whole "wait until `scrollHeight` is big
enough" dance is an approximation of an anchor. It becomes
`{ key, offsetWithinRow }`: the topmost visible row and how far into it the
viewport starts. That is stable under re-measurement, survives the pane being
dragged to another pane, and lets the restore write once instead of polling for
two seconds. **This is a breaking change to the carry**, so an old carry with a
number is treated as "no anchor" rather than misread.

**Selection is kept alive by keeping its rows mounted — not reconstructed.** An
earlier draft proposed rebuilding copied text from `view.messages`, and a review
was right to reject it. Once a row is unmounted the selection's anchor node is
gone, so there is nothing left to say _where_ the selection began; and
`view.messages` holds source text rather than rendered text, so it cannot supply
an exact character offset into a markdown-rendered paragraph, a highlighted code
block or a diff row. Reconstruction would quietly copy something adjacent to what
was highlighted, which is worse than failing.

So the mounted set is the union of two ranges: the viewport range, and — while a
selection is non-empty — the **selection range, pinned mounted from its anchor
row to its focus row**, however far that is from the viewport.

- `selectionchange` on the document widens the pinned range as a drag grows, so
  rows enter the DOM before the selection reaches them.
- The pin is released when the selection collapses, so the cost is bounded by
  what someone is actually holding highlighted, not by transcript length.
- **Select-all therefore mounts everything, deliberately.** That is a request for
  the whole transcript, and answering it with a truncated copy would be the same
  silent wrongness. Slow and correct; the one case where this phase's benefit is
  given back on purpose.

**Rejected alternative: an explicit key-and-offset selection model with defined
serialization.** It is the more general answer, and it means owning selection
semantics across every renderer `Entry` can produce — markdown, highlighted code,
diff hunks, terminals. That is a larger and more fragile surface than the problem
justifies, and getting it subtly wrong reproduces the silent-miscopy failure the
reconstruction approach was rejected for.

**Interactive rows are safer than the exit criterion assumes, and the criterion
should still stand.** `approval.requested` pushes only to `view.approvals`; it
never becomes a row. The card renders docked, outside the scroller, as
`view.approvals[0]` with a `waiting` count — so an approval can never be
unmounted by windowing. The same is true of question sets. What _is_ at risk is
narrower and must be handled:

- `Entry`'s own actions (`data-entry-action` — explain, recap, handoff, go) are
  fine unmounted, since they act on an event id rather than on DOM state.
- **An open aside card is anchored to a row.** `SessionCarry.card` holds an
  anchor rectangle from `fitCard`, and the row it points at can now scroll out of
  the window. The card is portalled and must stay open; its anchor has to
  degrade to a fixed position rather than follow a node that no longer exists.

**Changing the top spacer moves the viewport, and calling it invisible was
wrong.** An earlier draft claimed a top-spacer correction was invisible "by
construction". It is not: the spacer sits above the viewport, so growing it by
`delta` pushes everything below it down by `delta` and the reader sees the
content jump. What makes it invisible is the _compensation_, and that has to be
atomic with it:

- In one `useLayoutEffect`, before paint: write the new spacer height **and**
  `el.scrollTop += delta` together. Split across two commits, the intermediate
  state is painted and the jump is real.
- Both writes happen under a **programmatic-scroll guard**, because `onScroll` is
  what resumes following from position and the gesture handlers are what stop it.
  A synthetic `scrollTop` write reaching those handlers is indistinguishable from
  a reader arriving somewhere — exactly the class of bug that already cost a pane
  its following state once.
- The guard is a **counter of expected synthetic scroll events, not a boolean
  window**. `scroll` fires asynchronously, so a boolean cleared on a timer either
  swallows a real event or clears too early; counting down one expected event per
  programmatic write is the only version that cannot do either.

**Three writers to `scrollTop`, and that is the risk to hold in mind.** The
`ResizeObserver` pin, the restore effect, and now the windower. Two of them
already raced once — the restore landed while content was short, `onScroll` read
the growth as the reader scrolling up, and turned following off for good. The
windower never writes while following, because a following transcript renders the
tail and has no top spacer to correct.

### What Phase 6 is deliberately not doing

- **Not paging.** The read still fetches the whole transcript; Phase 5 is what
  bounds that. This phase bounds only what is mounted.
- **Not virtualising the changes panel or the terminal.** The panel is bounded by
  the number of changed files, and xterm already windows its own buffer.
- **Not a smoother scroll.** If windowing makes scrolling worse than it is now,
  that is a defect, not a trade.

### How this will be verified

**jsdom cannot check any of the hard parts, and saying so is the point.** It does
no layout: `offsetParent` is `null`, `ResizeObserver` never fires, scrolling is a
property assignment with no effect, and native selection across nodes is not
modelled. A jsdom test that "proved" following works would be asserting on
numbers it had assigned itself. This project has already shipped a test that could
not fail (C-027), so the split is explicit:

- **Pure, in the fast suite, no DOM at all.** Which rows a window contains for a
  given anchor, height cache and viewport; the spacer heights that follow; the
  union of viewport range and pinned selection range. Exported and tested the way
  `reduceEvents` is. Most of the logic goes here deliberately, because it is the
  part that can be tested honestly.
- **Chromium, through the existing CDP harness.** Following through a stream,
  restore after a remount, and a selection dragged past the window edge and
  copied. `e2e/perf-transcript.mjs` already drives a real Electron against a real
  transcript under `CHORUS_PROFILE_READONLY=1`, so the fixture exists; these
  become assertions beside its measurements.
- **By hand, and named as such.** Whatever is left — momentum scrolling on a
  trackpad, selection under a real pointer — is reported as observed, or not
  reported.

The numbers get re-run rather than asserted: `perf-transcript.mjs` reports rows,
DOM nodes, commit and paint, so "commit falls" is a measurement against **751.7 ms
and 58,380 nodes** rather than an impression. The row count doubles as the
correctness check — a window that drops rows shows up as a count that no longer
matches the reducer's 4,276.

---

## What we are deliberately not doing

- **Not rewriting existing log entries.** The log is append-only; that is the
  one rule everything else follows from. The 47.4 MiB of oversized notices are a
  fact about the past. Compacting them is a decision that contradicts the rule,
  not a patch, and belongs in its own argument.
- **Not capping `notice.detail` in the schema.** See Phase 1.
- **Not filtering the _log_.** Phase 2 narrows one read.
- **Not virtualising before profiling.** See Phase 4.

## Open questions and risks

1. ~~**Which path dominates is unmeasured.**~~ **Answered by Phase 4, in two
   halves that disagreed.** On the CPU path the reduction dominates everything
   upstream of the DOM — 156 ms against a 249 ms chain on the entry-heavy
   fixture. In the renderer it does not dominate at all: **752 ms committing**
   4,276 rows into 58,380 DOM nodes, against those same 156 ms. Mounting is the
   larger cost, and measuring only the first half would have concluded the
   opposite. What remains genuinely unmeasured is the IPC hop itself, which no
   number here crosses.
2. **"Not a 0.19.7 regression" is the leading explanation, not a finding.** No
   bisect, no before/after profile. It should not be stated as fact until one of
   those exists.
3. **Boundary state is the hard part**, and a wrong answer shows up as a
   transcript subtly missing an approval.
4. **The disposition map is the drift risk.** It only works if adding an event
   type forces a classification — the same way the five downstream switches
   already force one. Exhaustive by construction, or it rots into a hand-copied
   list that is wrong the first time somebody forgets it.
5. **`command.output` at 34 MB is not addressed by Phase 2** — only stopped from
   being transported. It is still stored whole, forever, and is the same shape of
   problem as the hook notices. Capping one invites the question for the other.

## Provenance

Every figure is from the live database at
`~/Library/Application Support/@chorus/desktop/chorus.db`, read-only, on
2026-08-21. Code claims are read from `store.ts`, `runtime.ts`, `ipc.ts`,
`transcript.ts`, `carry.ts` and `Session.tsx` at the current working tree.

**Six statements in earlier drafts were wrong, and the method that produced
them is the risk worth recording.** `259 notices × 204 KB each` came from
sorting by length and reading the top three — a maximum generalised into a mean,
when `avg()` was one query away; the true mean is 191,907. "All
`SessionStart:startup`" came from reading the truncated text of those same three
rows; they are 136 startup, 105 resume and 18 fork. "15,528 events, ~8 MB" and
later "largest by count: 15,144" both took a count and a size from _different
rows of the same result_, twice, in opposite directions. And "bisecting would
find nothing" asserted the outcome of a test nobody has run.

The sixth is a different failure and worth separating: "derive the allow-list
from the reducer's switch" described a mechanism that cannot exist —
`TranscriptEvent.type` is `z.string()` and the reducer ends in a `default:` arm,
so there is nothing exhaustive to derive from. That one was not a misread
number; it was a design asserted without checking whether the types supported
it.

Five of the six were caught in review rather than by the person who wrote them.
The common thread in the numeric ones is reading across a result set instead of
querying the thing being claimed.
