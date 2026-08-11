# STATUS

## Phase 0 done: the divider is a property of the gaps

The selection bar's hairline was `border-left` on
`.quote-offer-action + .quote-offer-action`, under a comment promising the
divider would sit _above_ once the bar wrapped. It never did, and no edit to that
rule could have made it: **CSS cannot tell whether a flex item wrapped.** `+`
matches the second button whether or not it began a new row, so a left border is
wrong on a wrapped row and a top border would be wrong on every unwrapped one.
The rule was also duplicated verbatim twenty lines below itself.

Replaced with `gap: 1px` and the hairline colour on the container, showing
through the gaps — vertical between buttons in a row, horizontal between rows,
with no selector at all. Three things make it work rather than nearly work, and
each is a comment in the stylesheet: the buttons had to become **opaque** (they
were `transparent`, which let the hairline colour flood them), `:hover` had to mix
over `--raised` for the same reason, and `flex: 1 1 auto` stops a short wrapped
row from being centred and exposing hairline colour beside itself.

### What looking at it found, and measuring did not

Every measurement passed before this was caught. The screenshot showed
`Explain simply` **missing its E** on a 200px bar.

`border-radius: 999px` had been safe only by accident. A radius clamps to half the
box, so on a one-row bar it renders as a pill — but a three-row bar is tall, the
clamp lets the curve grow with it, and the pill becomes a blob whose corners eat
the ends of its own top and bottom rows. `flex: 1 1 auto` is what exposed it: rows
now fill the width and reach into the corners, where centred natural-width rows
used to sit clear of them.

Fixed by making the radius **half a row's height** (`14px`) rather than
effectively half the bar's. On a single row the two are identical — the clamp was
already producing this — so the common case is byte-for-byte unchanged, and only
a wrapped bar differs: a rounded rectangle instead of a blob. A stack of rows
wants a rectangle; only a single row wants a pill.

### Verified

Driven with the repo's CDP harness. The real offer, with a real agent reply and a
real selection: three buttons, one row, `gap: 1px/1px`, opaque buttons, no
`border-left` on any of them, the row filling the pill, measured at **348px** —
and it still looks like a pill.

The wrapped cases were measured and photographed on **injected bars** carrying the
app's own classes, at 900px, 300px and 200px, with three buttons and with four.
Two rows at 300px, three at 200px, every row filling its width, a one-pixel band
between rows, no clipped labels. A four-button bar measures **427px** unwrapped,
which is the number the plan estimated.

### Why injected, and what that does not prove

The real offer could not be held open at a narrow pane: **it disappears whenever
the pane narrows**, by window resize or by an inline width React never sees. So a
wrapped bar could not be produced through the real selection path at all.

That is a bug in its own right and is now **C-025** on the board — at a 460px
window the pane is 160px and selecting a reply offers nothing, though the
selection is live and every guard in `readSelection` passes on the facts. It
predates this change and is not fixed by it.

The consequence for this phase is worth stating plainly: what was verified is
**the stylesheet's wrap behaviour**, not the app's ability to show a wrapped bar
to a user. Those are the same question only once C-025 is fixed. The unwrapped
case was verified for real, end to end.

### Not done here

No test covers Phase 0, because there is no test of the selection toolbar at all
(Phase 4).

## Phases 1 and 2 done: a translation is a third purpose, and it routes

`pnpm check` green: typecheck, lint, format, **1222 tests** (up 23).

### Phase 1 — the purpose and the prompt

`purpose` gained `translation` across all eight type sites, and
`translatePrompt` was written against what a translation is rather than by
editing the explain prompt. The plan's four rules are all in it and all asserted:
the passage itself rather than an account of it, the **standard written form**
(asked for as "standard arabic translation", so the prompt says which it wants
instead of inheriting whatever qualifier was typed for explanations), register
taken from the source, and code separated from prose — identifiers, literals,
delimiters and indentation reproduced exactly, natural-language comments and
docstrings translated, so the code still runs.

It carries **`Do not continue the work or change anything`**, which the plan's
first draft omitted. That is not explanation-specific tuning: `asideQuestion`
(`runtime.ts:169`) and `explainPrompt` (`:249`) both carry it, because without it
a fork treats the request as the next turn of the work and starts doing things —
which no permission rule catches, since reading files is allowed. A translation
request looks more like a task than a question does, not less.

**The ternary became an exhaustive switch, in `aside.ts` rather than in the
component.** The shape it replaced read `purpose !== 'explanation' ? ask : …`,
which quietly meant "everything that is not an explanation is a question" — true
with two purposes, wrong with three, and it would have labelled a translation
"Ask claude about this". `asideHeading` and `opensWithATurn` are pure and
exported, so the judgement is tested and the component is plumbing, as the
renderer conventions ask. `asideHeading` returns a **key and its variables**, not
a sentence: the reducer has no translator.

`opensWithATurn` also names the distinction the old code kept spelling as
`=== 'explanation'` — whether the card opened with its first turn already sent.
That is what focus, the answer region and the hidden follow-up box actually turn
on, and three call sites now say so.

### Phase 2 — routing, which the prompt tests do not cover

Mirrors `describe('opening an explanation')`: refuses **before forking** when no
language is set (asserted as `adapter.forked` being empty, since a refusal past
the fork leaves a CLI nobody holds), sends **exactly one** turn and it is the
translation, logs `Translate this into Arabic.` rather than the prompt, persists
purpose and language and does not rewrite them when the setting later changes,
and echoes back the language main used.

Three of the eight are regression tests rather than feature tests, because the
language read and the turn dispatch are both shared chains: an explanation still
gets its own prompt, a question still gets `asideQuestion` and still reads as
`question` with no purpose, and a question does **not** read the language — it
must not start refusing because a preference is empty.

### Proved rather than assumed

- **The routing tests fail without the routing.** Disabling the translation arm
  failed exactly the two turn-dispatch tests and left the refusal and persistence
  ones green — well-targeted rather than merely passing.
- **The exhaustive switch really does refuse a fourth purpose.** Adding a
  `summary` member with no case produced both `TS2366` and
  `switch-exhaustiveness-check`. The comment claiming that is now a checked
  claim.
- One type error existed that **vitest could not see**: `created(asideId).purpose`
  needs bracket access under `noPropertyAccessFromIndexSignature`. Tests passed;
  `tsc` did not.

## Phase 3 done: the action exists, and it answers

`pnpm check` green. Driven in the real app: selecting a passage now offers
**Quote in message · Ask about this · Explain simply · Translate**, and clicking
Translate opens a card headed _Translating into Arabic_ that returns the passage
in Arabic, right-aligned and streaming.

The RTL claim in the plan held with no work, as predicted: `unicode-bidi:
plaintext` was already handling it, measured on the answer element.

It is a translation rather than an explanation on the evidence, not by
assertion — the answer contains Arabic script and none of the source's words,
which is the one distinction the two features could plausibly blur.

### The button is a word, and that was my call rather than yours

The request said "translate icon". The bar is text-only, and one icon among three
labels reads as an accident while an unlabelled icon is the least legible thing
on a bar people meet rarely — so it ships as `Translate`, with the reasoning at
the button.

**This was asked three times and never answered, and two `continue`s were taken
as leave to proceed.** It is a one-line change: swap the label for an icon, or
give all four icons, which is the defensible version of what was originally
wanted. Mixing is the only option that is not.

The Settings copy was reworded to describe two actions and, more importantly, to
say **how each reads the value** — an explanation follows what you wrote, a
translation uses the standard written form. That sentence is the user-visible
consequence of sharing one field, and without it the shared setting would be a
silent surprise. `explainHeading` became _Your language_; `Answer in` stayed,
since a translation is also an answer.

## Phase 4 done: the toolbar has a test

`offers only the actions a passage can actually take`, spec 27, eight assertions
in **12 seconds** — cheap enough that the cost argument against it did not
survive writing it. One agent turn, one short reply.

It drives a real `mouseup` on `.score` rather than calling into React, because
the offer is decided by `readSelection` and anything else would test a path no
user takes.

What it pins is the two gates, which are invisible until they are wrong:

- a passage of **your own** message offers only `Quote in message`, and
  `data-askable` is absent — the attribute exists so a wrong answer is
  assertable rather than only lookable-at, and this is the first thing to use it;
- a **finished agent reply** is askable, but explaining and translating stay away
  while no language is set;
- setting a language offers **all four**, and the spec re-selects rather than
  waiting, because the language is read per selection and that is the behaviour
  under test.

It also pins the Phase 0 mechanism: one row, `column-gap: 1px`, no `border-left`
on any button, and every button opaque. Those three together are what makes a
wrapped bar work, and none of them is visible on a wide pane — exactly the kind
of thing that gets "tidied" back.

### Proved rather than assumed

Reinstating the deleted `border-left` rule failed **only** `divided by gaps, not
by borders on the buttons`, and left the other seven green. The guard catches the
specific regression it was written for.

No existing spec touches `.quote-offer` — every reference in `specs.mjs` is this
one — so the CSS and `Session.tsx` changes cannot have moved another spec.

### Still not done

**C-025 still bites here.** The narrow-pane case cannot be exercised through the
UI at all, so a four-button bar has never been seen wrapping in the real app —
only as injected markup, and now asserted only in the one-row case. The spec is
written so that the wrapped assertions are a viewport change away once the offer
survives a narrow pane.

**The full e2e suite has not been run.** This spec was run in isolation, and the
reasoning for not running the other 26 is written above rather than assumed: they
do not touch the offer. That is an argument, not a green suite.
