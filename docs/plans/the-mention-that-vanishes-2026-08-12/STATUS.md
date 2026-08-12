# Status

| Phase                                    | State       |
| ---------------------------------------- | ----------- |
| 1 — say which `none` it is               | **shipped** |
| 2 — reproduce with a real keyboard first | not started |
| 3 — fix the named cause, and the stamp   | not started |
| 4 — put it in front of a person          | not started |

Running in a worktree at `../chorus-c003` off `fix/a-suite-that-can-go-red`, so
the terminal branch and its uncommitted work are never touched.

## Phase 1 — shipped

### What changed

`data-mention` reports the **raw parsed mention** again, one string meaning one
thing. Four attributes join it, and none of them carries a character anyone
typed: `data-mention-live` (`none` / `stale` / `live`), `data-mention-why` (which
of the four writers last decided), `data-stamp-len` against the existing
`data-draft-len`, and `data-left-box`.

All four `setMention` writers are tagged — the parse, the `dismissed` branch,
`choose`, and Escape. The first draft of the plan listed three of six decision
points; the review found the rest.

### Proved by forcing, not by reasoning

| forced condition                       | `data-mention` | `live`    | `why`      |
| -------------------------------------- | -------------- | --------- | ---------- |
| a real mention                         | `@0:c`         | `live`    | `parsed`   |
| `liveMention` mutated to always reject | `@0:c`         | **stale** | `parsed`   |
| draft with no mention in it            | `none`         | **none**  | `no-parse` |

The middle row is the whole point: before this, a rejected stamp and an absent
mention both printed `data-mention: "none"`, and the two unexplained runs could
have been either. They are now different records.

`pnpm check` green — 1288 passed. The mutation was reverted and verified absent.

### What the phase found on its way past

**React's `onSelect` does not fire from a synthetic `select` event.** The first
attempt to force a stale stamp wrote the DOM without an input event and then
dispatched `new Event('select')` — and nothing happened: `data-stamp-len` stayed
at the old value, so `refreshMention` never ran. React implements `onSelect` as a
polyfill over `selectionchange`, focus and pointer events rather than by
listening for `select` directly.

That matters for Phase 2 beyond the inconvenience. The plan's hypothesised race
is "a programmatic DOM write, then `onSelect` runs before the render", and this
says the second half of that sentence is harder to reach than the plan assumed —
a synthetic event will not do it. Phase 2's real-keyboard requirement is
therefore not only about avoiding a harness artifact; it is the only route to the
`onSelect` path at all.

## Not done, and deliberately

The **stamp blocker** — text equality lets a stale mention reactivate when the
same text returns, and `choose` mixes a stamped offset with a live caret — is
untouched. It is a real defect and it is Phase 3's, because the plan's rule is
that no fix is written before the failing record is in hand. This work has
already produced two fixes that were obviously right and measured worse.

## The intra-app blur decision — kept, and one thing shipped with it

**Decided: an intra-app blur keeps closing the menu.** The menu floats over the
transcript and clicking into the transcript is usually to select a passage, so a
fifty-row list obstructs the thing that was clicked. More decisively, the menu is
an interactive listbox — arrows, Enter and Tab are intercepted, and those keys
only arrive when the box has the caret, so a menu drawn while focus is elsewhere
is a control that looks driveable and is not.

Closing was never the bug. The bug was that closing **destroyed the mention**.

Verified in the real app rather than argued, with the Phase 1 attributes:

| step                      | `leftBox` | rows | mention        |
| ------------------------- | --------- | ---- | -------------- |
| menu open                 | false     | 50   | `/0:` live     |
| focus moved elsewhere     | **true**  | 0    | `/0:` **live** |
| focus returned to the box | false     | 50   | `/0:` live     |

The middle row is the fix working: the menu is gone and the mention is not.

### The keyboard half, which the decision exposed

Interception was gated on `options.length > 0`. That was sound while rows and
visibility could not disagree; C-003's fix made them able to, so a menu hidden by
an intra-app blur still had fifty rows behind it and **would still swallow an
arrow key** — caret unmoved, history recall skipped, nothing on screen to explain
it. Now `menuTakesKeys(visible, rows)`, needing both halves.

Proved by mutation: reverting the predicate to the old `rows > 0` fails exactly
the new off-screen test and nothing else.

### A limit found by the probe lying first

The first run of the blur-cycle probe reported `leftBox: false` with focus
plainly on another control — the intra-app blur had not closed the menu at all.

The probe was at fault, and the reason is worth keeping: it had launched Electron
**without OS focus**, so `document.hasFocus()` was `false`, and the `onBlur`
guard that exists to ignore window-level blurs swallowed an intra-app one too.

That is a real limit of the guard, not just a probe artifact: **while the window
lacks OS focus, moving focus between controls inside it does not close the
menu.** It is close to unreachable in use — clicking inside a window focuses it —
but it is the second time a measurement here was invalid because the window's
focus state was assumed rather than established. Establish it first, always.

## Phase 2 — the residual did not reproduce, and there is a good explanation for it

| mode                               | KEPT | LOST | SKIP | ERROR |
| ---------------------------------- | ---- | ---- | ---- | ----- |
| real key events (CDP)              | 8    | 0    | 0    | 0     |
| synthetic (the e2e helper's shape) | 8    | 0    | 0    | 0     |

Sixteen focus round-trips, every one with the mention intact — `live`, `parsed`,
`stampLen == draftLen`.

**That is strong against the residual still occurring at its original rate.** It
was seen 2 times in 6, about 33%. Sixteen consecutive survivals at that rate has
probability `(2/3)^16 ≈ 0.15%`. Whatever produced those two records is not
happening now at anything like that frequency.

### The leading explanation, and the first pass caught it in the act

The first Phase 2 batch scored one real-mode run as a failure carrying
`mention: "@0:ceten"`. Stray keystrokes had reached the composer while the probe
pulled the window to the front — these probes steal focus, so anything typed
during a run lands in the box under test.

Follow that through the build those two unexplained runs were taken on. Stray
input changes `draft`. The stamp still holds the old text, so `liveMention`
rejects it — **correctly**, that is the entire purpose of the stamp. And on
`838827f` the attribute reported `active`, so a correctly-invalidated mention
printed exactly `data-mention: "none"` — the same string as a mention that had
been destroyed.

So the most likely reading is that the residual was **the stamp working, reported
through an instrument that could not say so.** Not proven — it was not caught
directly — but it fits every fact: the symptom, the ambiguity Phase 1 found, and
a live observation of the contamination that produces it. Under Phase 1's
attributes the same event now reads `live: stale`, which is unmistakable.

### Three ways the first pass manufactured a false failure

Recorded because they are the same class of error as the withdrawn baseline, and
all three were mine:

- **The verdict asked about rows.** A run was scored LOST for `rows === 0`, but
  rows are downstream of what the query matches — `@ceten` matches no agent and
  no file, so zero rows was the right answer to a different question.
- **A contaminated draft was counted rather than flagged.** It is now reported
  as `SKIP` when the starting draft is not exactly `@0:c`.
- **A missing measurement was counted as a failure.** A run that produced no
  output at all — crash or timeout — was tallied as LOST rather than as absent.

The corrected probe judges the thing actually in question: did the mention
survive the round-trip, `after.mention === before.mention && live === 'live'`.

### What this does not establish

Sixteen runs cannot clear a rare flake, and this file has already had to withdraw
one conclusion drawn from too few runs. The claim here is bounded: **at the rate
originally observed, it would almost certainly have appeared, and it did not.**

## What Phase 3 is now

The residual no longer justifies a fix on its own. **The stamp blocker still
does, and it is a confirmed defect rather than an unexplained observation:** text
equality lets a stale mention reactivate whenever the same text returns, and
`choose` splices a stamped offset against a live caret. Neither needs a flaky
reproduction to be true — both are readable in the code.
