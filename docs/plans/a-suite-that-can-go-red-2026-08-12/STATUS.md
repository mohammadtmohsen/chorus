# Status

| Phase                                       | State                           | Commit    |
| ------------------------------------------- | ------------------------------- | --------- |
| 1 — the instrument tells the truth          | **shipped**                     | `294d910` |
| 2 — the baseline                            | **measured, and under-powered** | `63c94ae` |
| 3 — C-003: split visibility from derivation | **shipped**                     | —         |
| 4 — re-measure, then diagnose what is left  | not started                     | —         |

Board correction shipped separately as `c0cf208`, because it is true regardless
of how the rest of this lands.

## Phase 1 — shipped

### What the plan said, and what changed on contact

Nothing changed in the shape. Two things changed in the arithmetic, and both came
from a Codex review of the first draft rather than from the code.

**The plan's own skip arithmetic was wrong, and then the code comment repeated
it.** The first draft expected `26 passed, 2 skipped` from spec 5's two
`assert(true, …)` sites. They are mutually exclusive branches of one spec — the
first `return`s — so at most one fires. Corrected to `28 passed` or `27 passed, 1
skipped`. Worth recording because the error survived being found once: after
fixing it in the plan, the first version of the comment in `specs.mjs` said "the
only two skips in the suite" and had to be corrected again on a diff read. A
grep-shaped reading of that code produces the wrong count twice.

**The verification moved off this machine's account entirely.** The plan's
original exit criterion — "reports the two plan-window skips by name" — is not
reachable on an account that has a plan window, and this one does. A criterion
that depends on the tester's billing plan is not a criterion. Four fixtures
replaced it.

### `settled()` was the find that reordered the plan

Not in the first draft at all. `specs.mjs`'s `settled()` returned the same
`undefined` whether the transcript stabilised or the deadline expired, so a
caller that waited fifteen seconds against a moving pane proceeded anyway and
failed downstream with the cause invisible. Both passage-selection specs depend
on it, and both are on C-029's list.

It is C-027's own defect one level down — a silent give-up inside the harness
that C-029's measurements would have been taken with. That is why the phases were
reordered: **honest runner → baseline → fix → re-measure**, rather than the
baseline first. Fixing `settled()` will move the pass rate, so taking a baseline
before it would have measured a different instrument from the re-measurement, and
the comparison would have meant nothing.

### Verified

- `pnpm check` green — 1279 passed, and the 9 new runner tests run in the fast
  suite without Electron.
- **Both new guards mutated.** `asserted === 0` disabled and `summarize`
  loosened to ignore skips: exactly 3 tests went red, and the right 3. A guard
  whose test passes without it is not a guard.
- `run.mjs` end to end against two real specs — `opens straight into a session`
  (4 assertions) and `account limits` (2 assertions, no skip).

### Not verified, and why

- **A real skip firing.** This account has a plan window, so neither branch of
  spec 5 is reachable here. That is the reason the fixtures exist rather than a
  gap they leave.
- **`settled()` returning `still: false`.** Needs a loaded machine to provoke,
  which is Phase 2. If it fires there it may turn the passage specs red — that
  is a defect surfacing, not a regression, and open question 2 says so in
  advance.

## Phase 2 — measured, and it does not reproduce

> **Superseded — read "Phase 2, corrected" below before trusting anything here.**
> The headline conclusion of this section is withdrawn: five runs could not see a
> flake that a later A/B measured at 30%. The section is kept rather than edited
> because the reasoning that led to a wrong confident answer is the useful part,
> and rewriting it would hide exactly the mistake worth remembering.

Five full-suite runs on an unmodified `Composer.tsx`, with Phase 1's runner.

| run | wall | result            |
| --- | ---- | ----------------- |
| 1   | 307s | **all 28 passed** |
| 2   | 289s | **all 28 passed** |
| 3   | 298s | **all 28 passed** |
| 4   | 282s | **all 28 passed** |
| 5   | 279s | **all 28 passed** |

**140 spec-executions, 0 failures, 0 skips, and 163 assertions in every single
run** — the same count five times, so no spec took a different path on any of
them. C-029 predicts 2–3 failures per run and a different subset each time. It
did not happen once.

### The suite was checked before the result was believed

A green run is the one result this plan exists to distrust, so: 28 `✓` lines per
run, 163 `  ✓` assertion lines per run, no `–` and no `✗`. The zero-assertion
guard shipped in Phase 1 fired on nothing, which it would have done had a spec
returned early. All five specs named by C-003 and C-029 ran and asserted.

### `settled()` never came close to giving up

The instrument added in Phase 1 to catch a silently-moving pane reports, across
all ten of its call sites over five runs:

```
the transcript stopped moving (731–732px, 4 samples, 457–461ms)
```

**Four samples, ~458ms, against a 15,000ms deadline** — every time, with 4px of
spread across five runs. The transcript is not struggling on this machine, so
"the pane had not settled" is eliminated as a mechanism rather than argued away.
That is worth having even though it found nothing: it is a hypothesis closed with
a number.

### What this does and does not establish

**It does not clear the four specs.** But the first explanation written here was
wrong and is worth keeping visible: this file said the runs were taken on "an
otherwise idle" machine, which was never measured and is false.

Sampled minutes after run 5: **load average 28.72 / 17.92 / 14.10 on 12 cores**,
with `mediaanalysisd` at 171% CPU, `WindowServer` at 53%, and the _installed_
Chorus.app open and busy alongside VS Code. The 15-minute figure overlaps the
runs. The machine was oversubscribed throughout.

**So CPU load is eliminated, not confirmed.** The suite went 5/5 on a machine
carrying more than twice its core count, which is the opposite of what "they fail
under load" predicts, and it means the board's word "load" has been doing work it
cannot support.

What was absent is narrower and fits C-003's mechanism exactly. The blur needs
**something to take focus away from the Electron window and give it back** — and
a CPU hog does not do that. A person alt-tabbing, a notification, a Spotlight
window, an app activating: those do. C-029's failures were recorded while someone
was actively working the machine during a release; these runs had a busy machine
and **nobody touching it**.

The refined hypothesis, and it is testable rather than atmospheric: **the trigger
is focus-stealing, not CPU contention.**

**Nothing shipped in Phase 1 could have fixed them.** `settled()` returns a
record where it returned `undefined`; the runner counts three buckets where it
counted two. Neither changes a timing. The 5/5 is not this branch's doing and
must not be reported as it.

### The consequence the plan did not plan for

**Phase 3's exit criterion is now unusable.** It was "the 5 menu specs, 5/5" —
the comparison that caught `onFocus={refreshMention}` at 2/5. With the baseline
already at 5/5, that criterion cannot tell a good fix from a bad one, and the
guard that caught the last wrong fix is gone.

C-003's cause is still reproducible on demand — blur the box, refocus it, `rows`
49 → 0 — so the **fix** can be verified deterministically. What is lost is the
**regression check**, and that is the half that mattered last time.

## Phase 2, corrected — the baseline was under-powered, and its headline was wrong

**Withdrawn: "C-029 does not reproduce."** Five clean runs were taken as evidence
that the four specs no longer fail. They were not enough runs to say that. A
straight A/B afterwards put the pre-fix slash spec at **7 of 10** — roughly a 30%
failure rate, which has a better than one-in-three chance of showing nothing
across five runs. C-029 was right and the measurement was too small to see it.

What survives is narrower and still worth having:

- **CPU load is eliminated.** 5/5 while carrying 2.4x the machine's core count.
- **The mechanism was caught in the act.** A debug run watching a single window
  recorded `hasFocus` going from `true` to `false` **with nothing driving it**,
  ten seconds after the menu opened. The window blurs spontaneously on this
  machine, which is why a loaded-but-unattended run looks clean and a person
  working the machine sees failures.
- **`settled()` never came close to its deadline** — 4 samples, ~458ms against
  15,000ms, at all ten call sites.

The lesson for Phase 4 is a number, not a mood: **five runs cannot see a 30%
flake reliably.** Ten is the floor for a per-spec rate, and a straight A/B beats
a remembered baseline, because the machine drifts between measurements — these
same runs took 275-480s across the day for identical work.

## Phase 3 — shipped, on the third attempt

**The plan's exit criterion caught two wrong fixes before either could ship.**
That is the whole reason this phase is worth reading.

### Attempt 1 — `focused`, defaulting to false. 2 of 5 full runs.

The same score as `onFocus={refreshMention}`, the fix this plan was written to
avoid repeating. The record said why: `mention: "/0:"`, `commands: "50"`,
`rows: 0` — everything the menu needed was present and it was still shut, so the
gate was false.

**Chromium defers a focus event while the document itself is unfocused.** An
Electron launched behind another window takes `el.focus()`, sets
`document.activeElement`, and dispatches nothing until the window is focused. So
`focused` started `false` and had no way to become true. The shape was right and
the _initial value_ was wrong.

### Attempt 2 — `leftBox`, defaulting to false, cleared by typing. 9 of 10 alone.

Better: nothing has been left at mount, which is true without an event saying so.
And `refreshMention` clears it, because change, select and keydown all require
the box to be where input is going — better evidence than a focus event, and it
cannot fail to arrive.

Still not right. A spontaneous window blur set `leftBox` _after_ typing, and
while the window stayed unfocused no focus event ever came to clear it.

### Attempt 3 — a window blur is not the box being left. 10 of 10.

The question none of the first three passes asked: **alt-tabbing away is not
leaving the box.** The caret is still in it, and still in it on return. Only an
intra-app focus change means the user left. One line tells them apart:

```ts
onBlur={() => {
  if (!document.hasFocus()) return
  setLeftBox(true)
}}
```

### Measured, back to back on one machine

| slash spec  | rate        |
| ----------- | ----------- |
| without fix | **7 / 10**  |
| with fix    | **10 / 10** |

| full suite, final fix | result               |
| --------------------- | -------------------- |
| 5 runs                | **5x all 28 passed** |

And the OS-level probe — steal the window's focus with another application, give
it back — now shows `rows: 50` before, during _and_ after, where the unfixed
build showed `50 -> 0 -> 0` and never recovered.

### The probe lied three times before it told the truth

Kept because each would have produced a confident wrong answer, and two of them
did:

1. It read `document.activeElement === ta` as "focused". That stays true while
   the _window_ is away — which is why the board's original failure record
   showed `focused: true` beside a shut menu and looked impossible.
2. It restored focus with `Page.bringToFront`, which acts inside the browser and
   never touches an Electron window's OS focus. It reported "not fixed" about a
   thing it had not tested.
3. It assumed the window had focus to begin with. A freshly launched Electron
   often does not.

It now waits on `document.hasFocus()` transitions and prints `INVALID` rather
than a verdict when one did not happen. That refusal is what caught 2 and 3.
