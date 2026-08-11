# STATUS

## Phase 0 done: the scroll is stale, and the pane never stops resizing

Instrumented both programmatic `scrollTop` writers, the scroll handler and
`readSelection`, then drove a 460px window — a **138–159px pane** — and took one
selection on it after letting the resize settle. Instrumentation reverted; the
worktree holds only this plan.

### The sequence that kills the offer

Five events, in order, with the times as recorded:

```
7152  resize-observer  targets=content,score  before=151  after=173
7155  readSelection    set=true
7160  scroll           scrollTop=173  dropping=TRUE
```

The scroll **write** happens at 7152, three milliseconds _before_ the selection
exists. Its **event** is delivered at 7160, five milliseconds _after_. The
handler cannot tell the two apart, so it drops an offer created after the scroll
it is reacting to.

`scrollTop` is **173 both before and after** that scroll event. Nothing moved.
The offer was destroyed by the delivery of a scroll that had already finished
happening.

That is a different bug from the one the plan described. The plan said a scroll
arrives after the selection; what actually arrives is the _echo_ of a scroll that
preceded it.

### The pane never settles

The reason there is always a scroll in flight: at this width the follow logic
does not converge. In the last 107ms of observation the `ResizeObserver` fired
**fourteen times, roughly every 8ms, and was still firing when the run ended** —
after the resize was supposedly complete, with `clientHeight` and `scrollHeight`
constant at 730 and 903.

Each callback shows the same shape: something has moved `scrollTop` down to
151–159, and `following` pushes it back to 173.

```
before=151    after=173
before=159    after=173
before=151.5  after=173.5
```

`makeRoom()` writes a spacer height, the content resizes, the observer wakes,
`makeRoom()` runs again. The pane width bears it out — measured at **138, then
141, then 159** across three calls in the same settled state. The layout is
oscillating, most likely around the scrollbar appearing and disappearing.

So a narrow pane produces a scroll write every few frames, indefinitely, and each
one drops whatever offer exists a few milliseconds later.

### The result that changes the plan

**The passage does not leave the viewport.** `passageInView: true` both
immediately after the mouse-up and after settling, with `passageTop` moving only
407 → 393.

That is the measurement the review demanded before Phase 1 could be approved, and
it comes back clean: the offer is destroyed while the passage it points at is
still on screen. So the constraint conflict — follow, no stickiness, clickable —
**does not arise**, and no product decision is needed. An offer that travelled
with its passage would have stayed visible and clickable throughout.

### What this means for Phase 1

Moving the offer into `.score-content` still works, and now for a sharper reason
than "the coordinate spaces disagree": with the offer inside the scrolling box,
**a stale scroll event has nothing to correct**, so the handler that drops it can
go entirely rather than being made cleverer about which scrolls are real.

The alternative — re-anchor on scroll — looks worse than it did. It would
recompute geometry on a pane that fires a scroll every 8ms forever, which is the
per-frame cost its own comment refused, in the one case where it never stops.

### What Phase 1 does not fix, and should not pretend to

**The oscillation is its own defect**, and a worse one than C-025 in every
respect except visibility: it burns a `ResizeObserver` callback, a layout and a
scroll write every few frames for as long as a narrow pane is open, and nobody
has been looking at it because it is invisible unless something else breaks.

Fixing the offer's coordinate space stops the _symptom_ — the offer surviving —
without touching the loop. That is still worth doing, because a stale scroll can
drop an offer at any width and this is only where it is constant. But the loop
needs its own board entry and its own measurement, and closing C-025 must not be
read as having dealt with it.

## Phases 1 and 2 done: C-025 is fixed

`pnpm check` green — **1231 tests**, up 9 — and the spec passes.

### What changed

`.quote-offer` now renders inside `.score-content`, so it travels with the
passage. The drop on scroll is gone: with the offer in the scrolling box there is
nothing for a scroll to correct, which is a better answer than teaching the
handler to tell a real scroll from a stale echo.

**Two anchor spaces now have two names.** `anchorOf` returns a `ContentAnchor`;
`QuickQuestion` takes a `PaneAnchor`; `inPane` converts, once, at the click. The
review predicted this exact bug — the same anchor is spread into `askingAbout`
and the card places itself against the pane — and **the compiler caught it the
moment the types were split**, at the predicted line:

```
Session.tsx(537): The types of 'anchor.space' are incompatible.
  Type '"content"' is not assignable to type '"pane"'.
```

That is the whole argument for the split rather than a comment: the failure is
invisible at rest and only appears once someone scrolls.

**`fitCard` takes a band, not a height.** `{ width, top, bottom }`, derived by
subtracting the content rect from the scroller rect — which absorbs both the
scroll and the scroller's 15px top padding without naming either. The card passes
`{ top: 0, bottom: pane.clientHeight }`, since it does not scroll.

### Verified

Driven on a **144–160px pane**: the offer appears, survives six frames, survives a
deliberate scroll, sits inside the scrollport, and **every action hit-tests where
it is drawn** — the acceptance bar the review asked for, since asserting mere
presence would pass with an offer parked outside the scrollport.

The screenshot shows the four-button bar **wrapped to four rows** as a rounded
rectangle with horizontal hairlines and no clipped labels. That is the
translate plan's Phase 0 verified in the real app for the first time; its STATUS
had to settle for injected markup, because this bug made the real thing
unobservable.

New coverage where it could not exist before: `fitCard` against a band starting
at 985 rather than 0, and `anchorOf`/`inPane` round-tripping a passage back to
the rectangle it came from — including a test that pins the double-counting
mistake an earlier draft made.

**The spec fails without the fix.** Reinstating the single deleted line
(`if (selected !== null) setSelected(null)`) failed `scrolling no longer destroys
it`, and only that.

### Still open

**C-026 is untouched.** The pane still resizes itself every 8ms at this width;
the offer simply no longer cares. Fixing the symptom has made the loop _less_
visible, which is exactly why it needed its own entry before this shipped.
