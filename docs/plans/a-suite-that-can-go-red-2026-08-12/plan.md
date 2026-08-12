# A suite that can go red

Closing C-003, C-027 and C-029 — the three entries that together mean a full e2e
run is not currently evidence of anything.

Revised after a Codex review of the first draft. Five things it found are folded
in below; the two that changed the design are marked where they land, because a
plan that quietly absorbs a correction teaches nobody.

## The problem

`all 28 passed` is printed by `run.mjs:38`, and right now it is three different
kinds of lie at once.

**It can be wrong because a spec broke for a reason nobody can name** (C-029).
**It can be wrong because a spec skipped and said nothing** — `assert(true, …)`
followed by `return` is indistinguishable in the output and in the exit code from
a spec that did its job (C-027). That already happened: `an agent can ask a
question and get an answer back` waited on a class nothing had carried for
months, timed out after 60 seconds, caught its own failure as "claude is not
installed", and reported green on a machine with claude installed.

**And one of those failures has a named cause and no fix** — C-003, the blur.

A run that can go green while testing nothing, and red for reasons nobody can
name, cannot be used to judge a change. That is what made separating a genuine
C-003 failure from three innocent ones a hand job, run by run, during 0.11.0, and
it is why C-006 stays parked until this lands: putting this suite in CI would
move a false negative from a place someone occasionally reads to a place nobody
reads at all. C-006 has its own plan (`what-a-green-build-proves-2026-08-11`,
Phase 0 unstarted). This one is its prerequisite and stops short of it.

## What the first draft got wrong

Three corrections that change what gets built, not just how it is described.

### The C-029 premise was repeated from prose that contradicts its own table

The board says _"None of them is broken. Each passes in isolation"_ — and two
lines above, its own table says otherwise:

| spec                                                       | alone   | in a full run   |
| ---------------------------------------------------------- | ------- | --------------- |
| `the question stays at the top of the answer it asked for` | **2/3** | fails often     |
| `offers only the actions a passage can actually take`      | **3/4** | fails sometimes |
| `an @ offers the cast, then the project’s files`           | 3/3     | fails sometimes |
| `keeps the offer when the transcript scrolls under it`     | 3/3     | fails sometimes |

**Two of the four fail alone.** So "they only fail under cumulative load" is
false for half the population, and any diagnosis built on it starts from the
wrong question. The board's prose is wrong and gets corrected as part of this
work — leaving it would guarantee the next person re-derives the same mistake, in
exactly the way this file's opening argument says a stale record does.

### The question spec cannot be the blur, and the code already says so

The first draft asked "is the question spec also C-003?" as an open question. It
is not, and it never needed a run to find out: across its whole body
(`specs.mjs:1352`–`1616`) it never types `/` or `@`, so it never builds a mention
at all. What it asserts is horizontal overflow —
`score.scrollWidth - score.clientWidth`, twice, `nothing overflows sideways`.

A question answerable by reading the file should not have been filed as one.

### `settled()` gives up silently, and two of the four flakes depend on it

The find that matters most, because it is C-027's own defect living inside the
harness that C-029's measurements would be taken with:

```js
const settled = async (page, { timeout = 15_000 } = {}) => {
  …
  while (Date.now() < deadline) {
    …
    if (stable >= 3) return   // stabilised
  }
}                              // …and this returns exactly the same nothing
```

`specs.mjs:218`–`230`. When the deadline expires without the transcript ever
holding still, `settled()` returns `undefined` — identical to success. The caller
proceeds against a moving pane and fails somewhere downstream, with the real
cause fifteen seconds upstream and invisible. Both passage-selection specs
depend on it.

Spending many full-suite runs diagnosing downstream failures while the harness
hides its own give-up is the same error C-027 describes, one level down.

## The shape of the answer

### C-003 — the blur nulls a derived value, and that is the bug

The record is settled (`the-menu-that-asks-once-2026-08-11/STATUS.md`, Phase 0b
third pass). `onBlur` at `Composer.tsx:773` clears the mention unconditionally;
`refreshMention` runs on change, select and keydown, and focus returning is none
of those. `onFocus={refreshMention}` was tried and measured **worse than doing
nothing** — 2 of 5 menu specs against 5 of 5 — because a focus event can fire
with the caret still at 0, and `findCommandQuery` reads `text.slice(0, caret)`.

The board frames the fix as a scheduling problem: re-derive _after_ the caret is
restored. **This plan rejects that framing.** The last timing fix here measured
worse than nothing, and the file's own comment at `Composer.tsx:354` records the
better move — the re-ask effect was fixed by _removing_ the timing question
rather than tuning it.

`mention` is two things wearing one name: **what is being typed**, derived from
text and caret; and **whether the menu is on screen**, which genuinely does
depend on focus. `onBlur` is right about the second and reaches for the first to
say it.

**Change 1 — split them.** Nothing then reads the caret on focus, so the
caret-at-0 race has nowhere to happen.

```
- onBlur={() => { setMention(null) }}
+ onFocus={() => { setFocused(true) }}
+ onBlur={() => { setFocused(false) }}

- const menuOpen = options.length > 0 || (mention !== null && lookup !== null)
+ const menuOpen = focused && (options.length > 0 || (active !== null && lookup !== null))
```

#### Change 2 — the stale-mention hole this opens, and how it is closed

**The blocker Codex found, and the first draft's reasoning was plainly wrong.**
That draft argued the mention survives a blur safely "because if the text had
changed, `onChange` fired". That is true only of user edits. A programmatic
`setDraft` fires no `onChange` at all, and three of them exist:

- **`quote`** — `setDraft(current => withQuote(current, passage))` then
  `input.current?.focus()` (`Composer.tsx:586`–`589`)
- **`insert`** — the same shape (`:590`–`595`)
- **`send`** — `setDraft('')`, asynchronously, inside a `.then()` (`:570`)

`quote` and `insert` are driven from `Session.tsx:607`'s `quoteSelection` — a
control **outside** the textarea, so using it blurs the box and then programmatically
refocuses it. That is precisely the sequence the change above makes survivable.
The failure is concrete and it is data loss in the draft:

1. type `@ali` — mention `@0:ali`, menu open
2. select a passage in the transcript — the box blurs, and under change 1 the
   mention is **kept**
3. click Quote — `setDraft` rewrites the draft, `focus()` fires, the menu reopens
   **against text the mention was never derived from**
4. choose a row — `applyMention(el.value, mention, …)` splices at a `start`
   offset belonging to the old text, **removing unrelated content**

Codex asked for "a rule for keeping mention state synchronized". **The rule
chosen here is not synchronization — it is invalidation, and that is a deliberate
choice worth arguing.** Re-deriving on every programmatic mutation is another
timing fix, and it would need to know the caret, which is the thing that cannot
be trusted at focus time. Making staleness _structurally unrepresentable_ needs
neither:

```
- const [mention, setMention] = useState<MentionQuery | null>(null)
+ const [mention, setMention] = useState<{ query: MentionQuery; from: string } | null>(null)

+ /** A mention is only ever valid against the exact text it was read from. */
+ const active = mention !== null && mention.from === draft ? mention.query : null
```

`refreshMention` stamps each query with the `el.value` it read. Every consumer —
`options`, `menuOpen`, `choose` — uses `active`, never `mention`. A draft that
changed by any route, from any caller, in any order, no longer matches its stamp,
so the mention is gone by construction rather than by anyone remembering to clear
it. `choose` additionally early-returns on `active === null`, so even a stale
range cannot be applied.

**The residual, stated rather than hidden:** identical text refocused at a
different caret leaves a mention whose `start` is stale relative to the caret.
Clicking into the box fires `onSelect` → `refreshMention`, which covers the
ordinary path; a Tab or programmatic focus that restores a different caret does
not. It cannot be closed by validating on focus, because a caret-0 read would
null a good mention — the original bug, re-entered from the other side. It gets a
test that documents the behaviour rather than a fix that reintroduces a race.

Four things checked rather than assumed, each of which would have sunk change 1:
Escape still nulls for real (`:840`); row clicks never blurred anyway
(`onMouseDown`/`preventDefault`, `:693`); keydown branches on `options.length`,
not `menuOpen` (`:817`); and `focused` may safely start `false`, since a mention
exists only because someone typed, and programmatic `.focus()` fires React's
`onFocus`. Second-order and worth recording: `wantsCommands` now stays true while
blurred, so a pending lookup keeps retrying with the box unfocused — bounded by
`ASK_CEILING`, and a warm list is the outcome we want, but it is a behaviour
change rather than a no-op.

### C-027 — the runner learns a third outcome, and is tested on fakes

A `skip(reason)` handed to specs alongside `assert`, throwing a sentinel the
runner catches separately. The summary stops claiming a count it has not earned.

**The two skip sites are one skip, not two.** `specs.mjs:424` and `:447` are
mutually exclusive branches of the same spec — the first `return`s — so at most
one fires and the first draft's expected `26 passed, 2 skipped` was arithmetic
that could never happen. On an API-key account the outcome is `27 passed, 1
skipped`; on an account with a plan window it is `28 passed, 0 skipped`.

Which is why **the runner is verified against fake specs, not against this
machine's account.** A criterion that depends on the tester's billing plan is not
a criterion. Fixtures: one that passes, one that skips, one that fails, one that
asserts nothing at all — each checked for its line in the output, its bucket in
the summary, and its contribution to the exit code.

The `assert(true, …); return` shape is not banned — spec 5's use is legitimate.
It is made _visible_. One guard comes free: a spec finishing with **zero**
assertions is a failure, not a pass.

### C-029 — an honest instrument first, then a baseline, then causes

Order matters here and the first draft had it wrong. Codex asked for a baseline
before the Composer changes; this goes further, because a baseline taken with the
current runner would not be comparable with a re-measurement taken after it.
Fixing `settled()` **will change the pass rate** — that is its purpose — so it
has to land before the baseline, or before and after are different instruments
and the comparison means nothing.

Hence: honest runner → baseline → fix → re-measure.

## Phases

### Phase 1 — the instrument tells the truth

`skip()`, the summary, the zero-assertion guard, the fake-spec fixtures. And
`settled()` reports whether it stabilised, with callers asserting it rather than
proceeding into a moving pane.

**Exit:** the four fixtures produce four distinct outcomes in the output, the
summary and the exit code, with no dependence on any account; a `settled()` that
times out names itself as the failure. No Composer file is touched in this phase.

### Phase 2 — the baseline

Full runs on an unmodified Composer with Phase 1's runner — enough to state a
rate rather than an impression, per-spec rather than in aggregate.

**Exit:** a written full-suite pass rate and a per-spec failure count, with the
number of runs stated. This is the number Phase 4 is measured against, so it is
taken once and recorded, not recalled.

### Phase 3 — C-003: split visibility from derivation, and stamp the mention

Both changes above. `menuOpen` comes out as a pure exported predicate, per the
renderer convention. The lifecycle half cannot be tested that way — **the defect
_is_ the focus lifecycle**, the stated exception for mounting under
`@vitest-environment jsdom`.

Tests, and the list is Codex's rather than the first draft's single blur/refocus
case: blur and refocus with text unchanged (the menu returns); **`quote` and
`insert` while a mention is open** (the menu does not reopen against rewritten
text, and `choose` cannot splice); send-then-recall; and refocus at a different
caret (documents the residual). Each proved to fail without the fix.

**Exit:** the 5 menu specs back to back — the same comparison that killed
`onFocus={refreshMention}` at 2/5. Anything short of 5/5 means this shape is
wrong too and is reverted the same way, with the number written down.

### Phase 4 — re-measure, then diagnose what is left

Phase 2's runs repeated. Whatever still fails gets the treatment that worked on
C-003 — the spec reports its own state at the moment it gives up, the way
`data-mention` and friends are why C-003 has a cause at all.

**Exit:** a before/after rate over the same instrument and stated run counts, and
either a mechanism per surviving failure or a written decision that load is the
cause and what was done about it. C-029's table and its contradicting prose are
corrected on the board from these numbers.

## What this deliberately does not do

- **It does not touch CI.** That is C-006, it has a plan, and feeding it a suite
  that cannot be believed is the thing this prevents.
- **It does not make the suite parallel.** Serial is deliberate (`run.mjs:7`);
  competing for the same CLIs would make these timings meaningless.
- **It does not remove the instrumentation.** It was added once, taken out when
  the investigation ended, and C-003 is what that cost.
- **It does not make the flaky specs more patient.** A longer timeout makes a
  suite greener without making it truer, which is the trade C-027 exists because
  someone already took.
- **It does not re-derive the mention on programmatic draft changes.** That is
  synchronization where invalidation is available, and it would need the caret.

## Open questions

1. **Is "under load" one cause or several?** Now sharper than the first draft
   could ask it: two of the four fail alone at 2/3 and 3/4, so for those the
   question is not load at all. Phase 2 splits the population before Phase 4
   tries to explain it.
2. **Does `settled()` failing loudly turn silent passes into failures?**
   Expected, and the reason it precedes the baseline — but if it turns the
   passage specs permanently red, that is a real defect surfacing rather than a
   regression, and it becomes its own entry rather than being tuned away.
3. **Does the caret residual matter in practice?** Documented by test, not
   fixed. If a real report arrives it needs a mechanism that does not read the
   caret during a focus event, and nobody has one yet.
