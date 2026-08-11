# The pane that never settles

C-026. On a narrow pane the transcript resizes itself forever. Nothing is
growing, no agent is typing, and the `ResizeObserver` fires roughly every eight
milliseconds for as long as the pane is open.

## What was measured

Found while instrumenting C-025, so the numbers are a by-product rather than a
study. At a 460px window — a **138–159px pane** — with `clientHeight` and
`scrollHeight` reported constant at 730 and 903:

- the observer fired **fourteen times in the final 107ms of observation and was
  still firing when the run ended**;
- every callback found `scrollTop` had drifted down to **151–159** and wrote it
  back to **173**;
- the pane's own width read **138, then 141, then 159** across three calls in the
  same supposedly settled state.

That is a scroll write every few frames, indefinitely. Each one is what was
destroying the selection offer, which is how this was noticed at all.

## What is inference, and must not be built on

The logged `scrollHeight` of 903 is read _after_ `makeRoom()` and the follow
write, so it records the restored state rather than the state that caused the
drift. A draft of this plan then reasoned that a `scrollTop` of 151 against a
730 client height "implies" a scroll height of 881, and therefore a 22px shrink
each cycle.

**That does not follow.** It holds only if 151 was the _maximum_ scroll position
at that instant, and nothing measured established that. `scrollTop` can be 151
in a much taller box for the ordinary reason that nobody had scrolled further.
The 22px is an artefact of an assumption, not an observation, and Phase 0 has to
log `scrollHeight - clientHeight` before anything may be said about shrinking.

What is left after removing it: the observer keeps firing, and `scrollTop` keeps
being written back to 173 from somewhere lower. **Everything below is a
candidate, not a diagnosis.** Two mechanisms in this session have already turned
out to be something other than they looked, including the bug that led here.

### Candidate one: the spacer feeds itself

`makeRoom()` (`Session.tsx:285`) sizes a spacer so the current turn is a viewport
tall:

```js
const said = block.offsetHeight - spacer.offsetHeight
const spare = Math.max(0, el.clientHeight - below - said)
spacer.style.height = `${spare}px`
```

The subtraction is already a guard against exactly this, and its comment says so
— "measuring the block whole would feed the spacer its own size". The question is
whether the guard holds when the numbers are not stable: if `said` alternates
between two values a line apart, `spare` alternates with it, the content height
alternates, and the observer that watches the content wakes to do it again.

If the drift turns out to be about a line of this transcript's type, that is
suggestive — but the drift itself is not yet measured, so this is a candidate
resting on a number that does not exist yet.

### Candidate two: the scrollbar

Content grows past the viewport, a scrollbar appears, the content box narrows,
the text rewraps one line taller, and there is no fixed point. The classic
version of this loop, and the oscillating **pane width** is the evidence that
something horizontal is moving.

`grep` finds **no `scrollbar-gutter` anywhere in `styles.css`**, and eleven
`overflow-y: auto` scrollers that could each in principle do it. If this is the
mechanism, `scrollbar-gutter: stable` is a one-line fix and the loop was always
latent.

### Candidate three: the observer watches its own output

`follow.observe(content)` **and** `follow.observe(el)` (`Session.tsx:331`). The
callback writes to a child of `content` and to `el.scrollTop`. Only the first can
resize anything, but the pane width moving suggests something outside this
component is also changing size, and an observer that fires on the pane is
reachable from anywhere in the layout.

## Why it is worth fixing rather than tolerating

It is invisible. Nothing renders wrong, nothing is logged, and the only reason
anyone looked is that each scroll write destroyed a selection offer — a symptom
now fixed, which makes this **harder** to notice than it was last week.

What it costs is a layout, an observer callback and a scroll write every few
frames, for as long as a narrow pane is open.

A draft of this plan said that cost lands on the thread `better-sqlite3` runs on.
**It does not.** `ResizeObserver` and layout are the _renderer_ process; the store
is the _main_ process, and they do not share a thread. The cost is real — a
renderer that never idles burns CPU, delays paint, and competes with the streaming
this app does constantly — but the argument has to be made on rendering, not on
SQLite, and inventing contention that Electron's process model rules out is worse
than a weaker true claim.

And a layout that cannot settle is a layout whose measurements are never quite
true. C-025's instrumentation had to discard its first reading for exactly that
reason.

## The shape of the answer, so far as it can be stated

Whichever mechanism it is, two guards look right independently of the diagnosis
and would be cheap:

**Do not write what has not changed.** `spacer.style.height` and `--spare` are
set unconditionally on every callback. An identical style write is usually a
no-op, but "usually" is doing real work in a loop that is already suspect, and a
guard makes the intent explicit rather than relying on the browser to notice.

**Reserve the scrollbar.** `scrollbar-gutter: stable` on the scroller removes an
entire class of width oscillation whether or not it is this one.

Neither is a fix until the loop is understood — a loop with a second cause would
simply slow down and stay. They are named here so Phase 1 is not mistaken for
design work when it is mostly confirmation.

## What this is deliberately not doing

**Not removing `makeRoom`.** The room it makes is why a question asked at the
foot of a long history rises to the top instead of sitting where it landed. That
behaviour is deliberate, documented, and not what is wrong.

**Not stopping the transcript following.** Already a non-goal in the C-025 plan,
for the same reason: the automatic scroll is doing its job.

**Not fixing the eleven other scrollers.** If the scrollbar is the mechanism they
are all candidates, but a sweep would change ten things nobody has measured.

**Not treating C-025 as related.** It is fixed; the offer no longer cares whether
the pane scrolls. That fix is what makes this measurable in isolation, and this
plan must not be read as finishing it.

## Phases

**Phase 0a — record, both edges, for long enough to mean something.** The
existing instrumentation logs after the repair and ran for 107ms, which is not a
basis for saying "forever". Log on entry _and_ exit: `said`, `spare`,
`spacer.offsetHeight`, `block.offsetHeight`, `el.scrollTop`, **`maxScroll =
scrollHeight - clientHeight`**, and both `clientWidth` and `offsetWidth` for the
scroller and the content. Then leave it running for a **stated window of at least
ten seconds** after layout has stopped changing, and report the callback count.

`maxScroll` is what makes "the content shrank" a measurement instead of an
inference. `offsetWidth` beside `clientWidth` is what separates two candidates
that the width alone cannot: **outer stable while inner changes implicates a
scrollbar; both changing implicates the parent layout.**

**Phase 0b — one factor at a time.** Reading a passive log will not distinguish
the candidates, because they produce the same trace. Alternating `spare` could
be _caused_ by width-driven reflow rather than causing anything; a changing
client width could be the sidebar rather than a scrollbar. So three separate
runs, each disabling exactly one thing, each temporary:

1. **suppress the spacer write** — if the loop stops, the feedback is in
   `makeRoom`; if it continues, `makeRoom` is a passenger;
2. **observe only `content`, not `el`** — separates a loop the component drives
   from one the surrounding layout drives;
3. **`scrollbar-gutter: stable` on the scroller** — if the loop stops, the
   scrollbar is the pivot, and the fix is already written.

**Phase 0c — reach it the way a person would.** Every observation so far follows
a programmatic viewport override, which is not a user path. Reproduce by
**dragging the sidebar wider** and by **opening the app already narrow**, and
report whether either loops. If neither does, this is a robustness bug rather
than a user-facing one, and worth much less effort.

Also cheaply: does the loop persist with the offer never shown? It should — the
offer was the victim — and confirming it costs one run.

**Phase 1 — stop it, then prove it stopped.** Shaped by Phase 0. The acceptance
test is a number, not an adjective: **observer callbacks over a fixed window with
nothing on screen changing**, at both widths, before and after. "Settles" is the
exact claim that was wrong when this was first assumed to be fine.

**Phase 2 — a spec, if it can be made cheap.** A count of observer firings is
awkward to assert from outside the app without leaving instrumentation in it. It
may be that the honest answer is a documented manual measurement rather than a
permanent test, and that is worth deciding rather than defaulting to either.

## Open questions

**Is the pane width oscillation the same bug?** It was measured across separate
calls rather than within one callback, so it might be the viewport override still
settling rather than a real oscillation. Phase 0 measures it inside the callback,
where there is no ambiguity.

**Does it happen without a resize having preceded it?** Every observation so far
follows a programmatic viewport change, which is not how a user arrives at a
narrow pane. A pane narrowed by dragging a split, or opened narrow, may behave
differently — and if it does not loop, the bug is smaller than it looks.

**How narrow does it have to be?** A draft said 160px came from "a four-way split
of a small window". **It cannot have.** Below 820px every multi-pane grid is
forced to a single column (`styles.css:381`), so at a 460px viewport there is
exactly one pane. The width comes from the **sidebar**, which defaults to 336px
(`workspace-layout.ts:38`) and leaves ~124px of a 460px window for the pane
before the activity bar takes its share.

That makes the user path more plausible rather than less: a narrow window with
the sidebar open, which needs no split at all. Knowing the threshold still
decides how much this deserves — but it should be found by narrowing until the
loop starts, not asserted.

## Corrections after review

Six, from Codex, and four are errors of reasoning rather than gaps:

1. **`scrollTop = 151` does not imply `scrollHeight = 881`** — only if 151 was
   the maximum, which was never measured. The 22px shrink was an artefact of the
   assumption. `maxScroll` now has to be logged before it may be mentioned.
2. **The three questions did not isolate the three candidates.** They shared
   traces. Replaced with one-factor probes, plus `offsetWidth` beside
   `clientWidth` to separate a scrollbar from the parent resizing.
3. **The 160px pane could not have come from a four-way split** — the grid is one
   column below 820px. It is the 336px default sidebar.
4. **The performance argument named the wrong process.** `ResizeObserver` and
   layout are the renderer; `better-sqlite3` is main. They do not contend.
5. **The board stated the mechanism as fact** while the plan called it a
   candidate. The board now records what was observed.
6. **107ms is not "forever".** The measurement window is now stated and at least
   ten seconds after layout stops changing.
