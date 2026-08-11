# The offer that scrolls away

C-025. On a narrow pane, selecting a passage offers nothing — no quoting, no
asking, no explaining, no translating. Three shipped features and one just built
are silently unreachable, and nothing on screen says why.

## What is actually happening

Not a broken guard. Every guard in `readSelection` (`Session.tsx:392`) passes on
the facts: the selection is live, not collapsed, inside the scroller, non-empty,
with a real rectangle. It sets `selected` and the offer renders.

Then something scrolls, and `Session.tsx:914` throws it away:

```js
// The offer is anchored to a rectangle that just moved. Re-reading it
// on every scroll frame would fight the scroll; dropping it is honest
// and the selection itself survives, so it can be re-made.
if (selected !== null) setSelected(null)
```

That is deliberate, and it explains the one observation that made this look
impossible: the offer is gone while `window.getSelection()` is still live and
non-collapsed. Those were never contradictory. They are the same line.

**Why a narrow pane turns an annoyance into a wall — hypothesis, not finding.**
The drop is survivable at a comfortable width because scrolling is something you
chose to do. Narrow the pane and the same message wraps to many times the
height, the transcript outgrows its scroller, and something scrolls it without
anyone asking.

What that something is has **not** been established, and an earlier draft of this
plan said "on every render", which is wrong. There are exactly two programmatic
writers of `scrollTop`, and neither runs per render:

- a `ResizeObserver` watching **both** `.score-content` and `.score` itself
  (`:308`–`:332`) — so a _pane_ resize scrolls, which is precisely what changing
  the viewport does in a test, and is a plausible reason the failure looked
  reproducible;
- an effect keyed on `turnKey` (`:370`–`:379`), deliberately once per question.

Setting `selected` does not resize `.score-content`, so nothing here obviously
explains a scroll arriving after a _selection_. Either a resize is still settling
— `makeRoom()` writes a spacer height, which resizes the content, which can wake
the observer again — or the trigger is something this plan has not found. That is
Phase 0's whole job, and the answer changes what the fix has to be.

What is not hypothesis: the offer is destroyed by that line, and the comment's
promise — "the selection itself survives, so it can be re-made" — is what stops
being true when the scroll is not yours.

## The shape of the answer

**The offer is positioned in the wrong coordinate space, and this codebase has
already fixed exactly that bug once.**

`.quote-offer` is rendered as a child of `.pane` (`position: relative`), outside
the `.score` scroller entirely, and placed by `fitCard` in pane coordinates. A
passage's rectangle is in viewport coordinates and moves when the scroller
scrolls; the offer's origin does not. So the two disagree the moment anything
scrolls, and dropping the offer is the cheapest way to hide the disagreement.

Six lines above the scroller, `.rail` carries this comment:

> Positioned against the scroller it was measured from the padding edge, while
> every dot is measured from its own entry — so the line sat 15px to the left of
> the dots it was supposed to run through… Sharing an origin with the entries
> fixes both.

**A precedent for the origin, and only that.** The rail spans the whole
transcript and is never clamped to what is visible, so it needed one coordinate
change and nothing else. The offer has to stay inside the viewport, which is the
part the rail says nothing about — calling this "the same fix" would smuggle the
hard half past the argument.

So: **move the offer inside `.score-content`, anchor it in content coordinates,
and convert explicitly when clamping.** Then it travels with the text because it
is part of the text's box, and `setSelected(null)` on scroll can go.

### The coordinate arithmetic, which an earlier draft got wrong

That draft said "the content box's origin, plus `scrollTop`". **That
double-counts the scroll.** `.score-content` moves with the scroller, so its
`getBoundingClientRect()` already falls by exactly the scroll amount:

```
anchorY = selectionRect.top - content.getBoundingClientRect().top
```

is a stable content coordinate on its own. Adding `scrollTop` would push the
offer down the page by however far you had scrolled. Either subtract the content
origin, or subtract the _scroller's_ origin and add `scrollTop` — never both.

`fitCard` then needs the second correction, because it assumes a box whose
visible area starts at zero (`aside.ts:88`). In content coordinates it does not.
A second draft said the band was `[scrollTop, scrollTop + clientHeight]`, which
**ignores the scroller's 15px top padding** — `.score` sets
`padding: var(--score-top) …` (`styles.css:1119`), so the content box does not
begin where the scrollport does.

Derive it from the two rectangles instead, which is shorter than the wrong
version and has nothing left to forget:

```
top    = scoreRect.top    - contentRect.top
bottom = scoreRect.bottom - contentRect.top
```

Both are viewport rects, so subtracting `contentRect.top` puts both edges in
content coordinates in one step — padding and scroll included by construction,
neither named. Clamping without this parks the offer near the top of the whole
transcript rather than near the passage.

The width is a third correction. `.score` carries
`padding: … calc(var(--step) * 5) …` (`styles.css:1119`), so `.score-content` is
**30px narrower** than the scroller's client width. An earlier open question here
assumed no horizontal padding; that was simply false, and the clamp has to use
the content width or the offer will be allowed 30px it does not have.

What the move buys beyond C-025: scrolling a few lines while deciding whether to
ask about something stops destroying the offer, at every pane width. The narrow
pane is where it is fatal, not where it is wrong.

### It may not be sufficient on its own

If the unexplained scroll carries the passage out of the viewport, an offer that
correctly travels with it is clipped and still invisible — better than being
destroyed, because scrolling back brings it home, but not obviously enough to
close C-025.

**And the fallback does not rescue that case either.** Re-anchoring in pane
coordinates and running `fitCard` would clamp the offer into view while its
passage is somewhere off-screen — which is exactly the detached, sticky offer
this plan rejects two sections down. So in that world three of this plan's
commitments cannot all hold at once:

- the transcript keeps following on its own;
- an offer never floats free of the passage it names;
- the actions are reachable straight after selecting on a narrow pane.

**That is a product decision, not a fallback to be selected automatically**, and
Phase 0's second measurement is what triggers it. The options are: let the offer
leave with its passage and accept that C-025 becomes "scroll back to reach it";
suspend the follow while a selection is live, which contradicts a non-goal below
and is at least honest about the trade; or bring the passage back into view when
one is made, which nothing here currently does. Worth choosing deliberately if
the measurement demands it, rather than discovering the choice in a diff.

### The alternative, and why it is second choice

Keep the offer where it is and **re-anchor** on scroll instead of dropping —
recompute `anchorOf` from the live selection, throttled to a frame. It is a
smaller diff and keeps `fitCard`'s clamping exactly as it is.

It also does per-frame geometry during scrolling, which is the specific thing the
existing comment refused, and it leaves the offer in a coordinate space that does
not match what it points at — so every future question about placement has to be
answered twice. Worth keeping as the fallback if moving it turns out to fight the
sticky-turn layout.

## What this is deliberately not doing

**Not making the offer sticky.** Scrolling a passage out of view should take its
offer with it. An action pinned to the edge of the pane, still claiming to be
about something no longer on screen, is a worse lie than the current one.

**Not touching `readSelection`'s guards.** They were suspected and they are
innocent; the instrumentation in Phase 0 exists to keep that honest rather than
to change them.

**Not changing when the transcript follows.** The automatic scroll is doing its
job — a reply that types itself out should stay in view — and an offer that
cannot survive it is the thing that is wrong. Suppressing the follow while a
passage is selected would trade a broken offer for a transcript that stops
following mid-answer, which is worse and harder to notice.

**Not fixing the four-button bar's wrapped appearance.** That is the
translate plan's Phase 0, already shipped and verified against injected markup.
This is what will let it be verified for real, which is why it is worth doing
before that verification is claimed.

**Not changing what a scroll means for the card.** `QuickQuestion` is anchored
the same way and is _not_ dropped on scroll, which is already inconsistent with
the offer. Whether the card should also move into the scroller is a real
question and a separate one; this plan makes them no more inconsistent than they
already are.

## Phases

**Phase 0 — find the scroll, do not assume it.** This phase exists because the
diagnosis above is a hypothesis with a known-wrong first draft, and every later
phase is shaped by which writer actually fires.

Instrument **both** programmatic writers — the `ResizeObserver` and the `turnKey`
effect — not just the handler that reads the consequence. For each, record
`following.current`, the scroller's `clientHeight` and `scrollHeight`, the
`scrollTop` before and after, and which observer entry woke it. Then record the
`scroll` events themselves alongside, so a scroll with no writer behind it is
distinguishable from one with.

The window is **460px wide, which is where the pane measures 160px** — the two
numbers in the earlier draft were the same observation stated inconsistently, and
the pane is the one that matters.

Three things to come out with:

1. **which writer fires, and how many times**, for a single selection once the
   resize has settled — the difference between "the pane is still settling" and
   "selecting provokes a scroll", which are different bugs with different fixes;
2. **where the passage is before and after**, in viewport coordinates, because an
   offer that travels correctly is still invisible if the passage has been carried
   off-screen — the result that would send this plan back to its alternative;
3. **whether a scroll arrives with no writer behind it**, which would mean a third
   source nobody has found.

**Phase 1 — move the offer into the scroller.** Render `.quote-offer` inside
`.score-content` (already `position: relative`, for the rail) and anchor it in
content coordinates: `anchorOf` currently subtracts the pane's origin
(`quote.ts:135`) and would subtract the content box's instead — **and nothing
else**, per the arithmetic above. `fitCard` takes the visible band derived from
the two rectangles, and clamps width against `.score-content` rather than the
scroller. Then the drop on scroll goes.

**The anchor is shared with the card, so changing its meaning breaks the card.**
`openCard` spreads the selection wholesale — `setAskingAbout({ ...passage, … })`
(`Session.tsx:509`) — so the same object reaches `QuickQuestion`, which places
itself against `el.offsetParent`, the **pane** (`QuickQuestion.tsx:200`). Silently
handing it a content-space anchor displaces the card by the scroll offset, and
only after scrolling, which is the kind of bug that ships.

Two spaces now exist, so they get two names — `PaneAnchor` and `ContentAnchor`,
or the equivalent — and the compiler refuses to pass one where the other belongs.
The offer holds the content anchor; `openCard` converts once, at the click, into
the pane anchor the card wants. One conversion, at one site, named. Making it a
type error is worth more here than a comment, because the failure is invisible at
rest and only appears once someone scrolls.

`anchorOf` and `fitCard` are pure and already tested (`quote.test.ts`,
`aside.test.ts`), so both conversions get asserted at a **non-zero scroll offset**
— the case with no coverage today because it could not previously happen — and
the round trip content → pane is asserted to land where it started.

**Phase 2 — the spec.** `offers only the actions a passage can actually take`
already drives a real selection; this adds the case it cannot currently make:
scroll after selecting, and the offer is still there and still pointing at the
passage.

Then the narrow-pane case, and the acceptance bar is **clickable, not merely
present** — after the automatic scroll sequence has run and settled, the four
actions still hit-test where they are drawn. Asserting the element exists would
pass with an offer sitting outside the scrollport, which is the exact failure
mode Phase 0 is checking for. That case is also the verification the translate
plan's STATUS currently has to do without.

## Open questions

**Does the offer need to survive being scrolled fully out of view?** Inside the
scroller it is clipped, which is right. But a selection that leaves the viewport
and comes back should still have its offer, and whether React keeps it mounted
through that is a fact to check rather than assume.

**What does this do to `fitCard`'s "centre when wider than the pane" case?**
That branch (`aside.ts:88`) exists for a bar wider than its container and is
measured against pane width. An earlier draft guessed the scroller's client width
was the same number "because the pane has no horizontal padding" — it has 15px a
side (`styles.css:1119`), so the numbers differ by 30 and the branch fires 30px
later than it should once the offer lives in the content box. Which container the
centring is _about_ is the real question: the pane it floats over, or the column
of text it points into.

**Is the card wrong in the same way?** `QuickQuestion` uses the same `fitCard` and
is not dropped on scroll, so today it stays put while the passage moves away
beneath it. That may be deliberate — a card is a thing you are reading, not a
label on a passage — but nobody has written down which it is.

## Corrections after review

Four, from Codex reviewing the first draft, each checked against the code before
being written in. Recorded because three of them would have survived into the
implementation:

1. **The trigger was asserted, not observed.** "It scrolls on every render" is
   false: the follow runs from a `ResizeObserver` and a `turnKey` effect, and
   setting `selected` resizes nothing. Phase 0 rewritten to find the writer
   rather than confirm a story, and the 460px/160px muddle — one is the window,
   the other the pane — cleaned up.
2. **The coordinate math double-counted the scroll.** Content origin _and_
   `scrollTop` would offset the offer downward by the scroll amount, because
   `.score-content`'s rect already moves with the scroller.
3. **`fitCard` would have clamped in the wrong space**, against a zero-based
   viewport that does not exist in content coordinates, and against a width 30px
   wider than the content box actually is — an open question here had assumed
   away padding that `styles.css:1119` plainly sets.
4. **The move might not close C-025 by itself.** If the scroll carries the
   passage out of view, an offer that correctly follows it is clipped and still
   unusable. Phase 0 now measures the passage's position across the scroll, and
   Phase 2's bar is that the actions are _clickable_ rather than present.

The rail remains a precedent for sharing an origin. It is not a precedent for
clamping, which is the half of this that is actually hard.

### Corrections after the second review

Codex approved Phase 0 as written and blocked Phase 1 on two:

5. **The anchor is shared with `QuickQuestion`,** which reads it in pane
   coordinates. Redefining it without splitting the type would displace the card
   after any scroll. Two named types, one conversion at the click.
6. **The visible band still ignored the scroller's top padding.** Replaced with
   the two-rectangle derivation, which is both shorter and correct.

And one that was not a correctness bug but a contradiction: **the fallback cannot
save the passage-scrolled-away case**, because re-anchoring in pane space is the
sticky offer this plan forbids. Recorded as a decision Phase 0 triggers rather
than a branch it takes.
