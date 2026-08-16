# Status

## Phase 1 done: a blocking card says when it is about to expire

The deadline existed and nothing mentioned it. Now a question or approval card
shows how long is left, but only once that is worth knowing.

**The threshold is one minute, and it comes from the data.** The median
successful answer in the log took **55 seconds**, so a minute is enough to finish
a typical answer from a standing start — which is the only useful test of the
number. A warning that arrives with less time than an answer takes is not a
warning, it is notice of a loss. Five minutes of visible counting was rejected
for the opposite reason: it applies pressure to the 60% who were never at risk,
and a timer that is always on is a timer nobody reads.

**The judgement is pure and the component is plumbing**, following the
convention the rest of this renderer uses. `deadline.ts` decides _whether_ to
warn, _what_ to show, and _when the display next becomes wrong_; `useDeadline`
only schedules. 13 tests.

`nextChangeInMs` is the part worth keeping. Without it the card would run a 1Hz
interval for the four minutes it has nothing to say — one re-render per second of
an unchanged card. Instead it sleeps once until the warning is due, then ticks
only inside the last minute, and stops entirely at zero.

**`ceil`, not `floor`.** Flooring reaches "0" a full second before the deadline
does, so the card would read `0:00` while still perfectly answerable — a lie told
at exactly the moment it is being read most carefully.

### The seam, which is the point of doing this first

Both cards take a `deadline` **prop** rather than reading `request.expiresAt`.
Today the caller passes exactly that, so nothing changes; when Phase 2 lets
engagement push the deadline out, only the expression filling that prop moves and
neither card is touched.

This was not tidiness. The renderer replays the _original_ `expiresAt` from
`userinput.requested`, so a card that read it directly would show a stale
deadline after the first extension — the countdown becoming wrong precisely
because the feature above it started working.

### Accessibility

Both cards are `aria-live="assertive"`. A number changing every second inside one
would be announced every second, which is not urgency but noise. The ticking
digits are `aria-hidden`; a static sentence beside them says the same thing once
and, because its text never changes, announces once.

### Verified on a real card

Driven end to end against a live Claude question set, not a fixture:

- silent for the first four minutes — `hasClock: false`
- appears at exactly `1:00`
- `aria-hidden="true"` on the digits, `"Less than a minute left to answer."` for
  a screen reader
- counts down rather than freezing: `1:00 → 0:57`

**One correction made during the work.** The first version coloured the countdown
with a `--warn` token that does not exist, behind a hex fallback. Every render
would have used the fallback, and carried a dark-theme colour into the light
theme where it has no contrast. It uses `--alert`, which is real and defined for
both.

**Not verified live: the approval card.** It is wired through the same component
and prop, but only the question path was driven. Approvals time out 4 times in
4,186 in this log, so the opportunity is rare.

**A weak assertion, recorded rather than hidden:** the driver's "under a minute
when it appears" check parsed the seconds field of `1:00` and so was trivially
true. The real evidence is that the element was absent at four minutes and
present at exactly sixty seconds.

## Probe: open question 1 is answered — Claude does not give up

**`askUserQuestionTimeout` defaults to `'never'`.** From `sdk.d.ts`, which is
where shapes are read from in this project:

```ts
/**
 * Idle time before Claude's questions auto-continue with any answers selected
 * so far. Defaults to never — auto-continue only runs when explicitly set to
 * 60s/5m/10m.
 */
askUserQuestionTimeout?: '60s' | '5m' | '10m' | 'never'
```

Chorus does not set it, so it is `'never'`. Confirmed live: a standalone SDK
probe stalled `canUseTool` and the query sat waiting rather than resolving
itself.

So **extending the deadline is safe from Claude's side**, and the five-minute
number is entirely ours to choose. Open question 1 is closed. Phase 2 remains
blocked on the Codex probe (1b) and the state-path decision.

Worth noting for later: the option exists, which means a _host_ can ask the CLI
to auto-continue. That is a different design from ours and not obviously better —
"continue with whatever is selected so far" invents a partial answer, which the
orchestrator deliberately refuses to do — but it should be considered rather than
rediscovered.

## What the probe found by accident: answering may not reach Claude at all

**Fixed** — C-018, now retired. `mapping.ts` sent `answers` as an array of
arrays; the installed CLI wants a record keyed by the question's own text. Taken
from the CLI binary's own schema description rather than guessed:

> "The answers provided by the user (question text -> answer string;
> multi-select answers are comma-separated)"

Verified in the running app: the agent now repeats the choice back, for single
choice and for multi-select, and asks **once** rather than retrying after a
rejection.

This bears on the numbers this plan is built on. The log's 15 `answered`
outcomes record that **Chorus sent an answer**, not that Claude received one — so
"40% of question sets are lost" is the optimistic reading, and the true figure
over the affected period is worse. The logging weakness that hid it is now
**C-019**; the measurements in this plan should be re-taken once answers are
known to land.

## What is left

Phase 2 and Phase 3, both still blocked on the contracts in the plan — the Codex
probe and a state-path decision for Phase 2, the identity and secret-lifecycle
rules for Phase 3. Neither is schedulable yet.

## Phase 2, domain half: the deadline responds to the person

Both of Phase 2's blockers are settled, one by measurement and one by failing to
measure.

**Claude does not give up** — `askUserQuestionTimeout` defaults to `'never'`, so
extending is safe from its side and the five minutes is entirely ours.

**Codex cannot be measured, and that is the answer.** Probed against the
installed CLI with an explicit instruction to use its request-user-input tool:
_codex finished the turn without ever raising a question_. The protocol marks the
path `EXPERIMENTAL` and the live log agrees — 0 of 25 question sets are Codex's.
So rather than guess at `autoResolutionMs`, whose replacement `isBlocking`
answers a different question entirely, the ceiling simply **never extends past a
provider-declared deadline where one exists**. That costs nothing today because
none ever is, and is right on the day one appears.

### The numbers, and why

- **A gesture buys two minutes.** The median successful answer took 55 seconds
  and the slowest 255, so two minutes is comfortably more than a typical answer
  from a standing start. Someone still working keeps buying time; someone who
  walked away loses it once.
- **The ceiling is 30 minutes from the original ask.** Not a limit on the person
  — if gestures keep arriving they are there and nothing is wedged. It bounds the
  case the deadline exists for: a renderer reporting engagement it does not have.

### `extendUserInput(id, engaged)`

One call does both halves, which is why neither a logged event nor a push channel
was needed. `engaged: true` pushes the deadline out within the ceiling and
returns it; `engaged: false` reads it and changes nothing — which is what a
**remounting** card sends, so it comes back with the deadline in force instead of
replaying the stale original.

It never shortens: a gesture late in a long grace period must not pull back what
it already bought.

### The race, and a test that could not model it at first

A queued `setTimeout` cannot be un-queued, so an extension arriving in the same
tick as the expiry would resolve against a deadline that has already moved. The
timer now re-checks **the time it was armed for** against the deadline in force,
and re-arms rather than firing.

Compared against the armed-for time rather than the clock, for two reasons: it
states the actual question ("did this move since I was scheduled?"), and a
wall-clock check would depend on the scheduler advancing, which the fake one
deliberately does not — that version broke an existing test, which is how the
weakness was found.

The test needed the harness extended too. `manualScheduler.clearTimeout` really
removes the callback, so it cannot reproduce a real timer already dequeued for
execution. `peek()` holds the callback so it can be invoked _after_ the
extension, which is the only faithful model of the race. Proved by deleting the
guard and watching that test alone fail.

## Phase 2 done: proven in the app, after the first run failed

`userinput:extend` through preload and main; the runtime asks each participant in
turn, because a `userInputId` belongs to whichever service raised it and a card
knows the question but not the queue. The card holds the deadline in force
itself, seeded from the Phase 1 seam, and moves it on a gesture — an option
chosen, text typed, a step taken. **Never focus**, which the card manufactures on
mount. Throttled to one call per 20 seconds, since a gesture buys two minutes.
`engaged: false` on arrival reads the deadline without claiming anyone is there.

### The live run

```
still alive at 330s — past the old deadline
still alive at 360s — past the old deadline
still alive at 390s — past the old deadline
  ok  the card survived 390s (old deadline: 300s)
  ok  the answer still reached the agent after the extension
  ok  logged as answered, not timeout
```

10 of 25 question sets in the real log died at exactly 300.0s. This one was still
answerable at 390 and its answer landed.

### The first run failed, and both reasons are worth keeping

**The driver typed into a box that did not exist.** The question rendered as
choice buttons — `inputs: []`, `textareas: []` — so the typing hit nothing, no
gesture was ever reported, and the card correctly died at 301s. The failure was
real and the cause was the test. It now clicks an option, which every question
set has, and reports `NO CONTROL` rather than silently succeeding when there is
nothing to click.

**`engaged: true` moving the deadline by 0s is correct.** A gesture buys
`now + 2 minutes`; a fresh question already has five, so early gestures are
no-ops and the extension only bites near the deadline. It never shortens, which
is what makes that safe. Reading "moved by 0s" in a debug run looked exactly like
the bug and was not.

That second one exposed a gap: **every unit test used a 60-second fixture**, where
`now + 2min` always exceeds the deadline, so the far-from-deadline case had no
coverage at all. It has a test now.

### Deliberately not extended: approvals

They keep Phase 1's countdown and nothing more. An approval is one click, not a
form, and the log agrees — **5 timeouts in 4,248 approvals (0.1%)** against 40%
of question sets.

### Not done

Phase 3: a half-filled answer still dies when you switch panes, with no timeout
involved.

## Reversed, 2026-08-16 — there is no deadline any more

Everything below this line describes a mechanism that no longer exists. It is
kept because the reasoning is still worth reading and because the reversal is
the more interesting record.

Asked for directly: _"for any ask or permission request make no expiry time at
all, never count the time and ignore it — if no response just wait until the
user responds no matter how long this takes."_

**The plan's premise was sound and its conclusion was not.** Neither provider
imposes a deadline — the Claude SDK's permission prompt blocks by design, and an
unanswered Codex `requestApproval` hangs the turn — so Chorus owned the timeout
and this plan made it responsive rather than fixed: a gesture bought two
minutes, up to a half-hour ceiling.

What none of that changed is what expiry _did_. It **answered**. `outcome:
'timeout'` told the provider nothing was chosen and the turn carried on, so
walking away for six minutes was a decision the person never made — and the
extension work made that decision harder to predict rather than removing it.

The timer's real job was never the clock. It was "never leave a session with no
way out", and that was already covered twice over: `drain` resolves everything
outstanding when a session ends or the app closes, and a turn you no longer want
is stopped by the interrupt control — a person deciding, rather than a clock
deciding for them.

**Removed:** the queue's expiry sweep and its one-second timer;
`armUserInputTimer`; `extendUserInput` and the `userinput:extend` channel with
its preload, handler and runtime half; `ENGAGED_GRACE_MS`, `MAX_EXTENSION_MS`
and the per-question `ceiling`; `deadline.ts`, its tests, the `DeadlineNote`
countdown, its i18n block and its CSS.

**Kept:** `expiresAt` on the request and in the log — it records what the
adapter proposed and nothing reads it back; and `neverAsks`, which still
resolves an aside's question at once, because a fork nobody is watching is the
one case waiting really would wedge.

**Driven:** a real approval left unanswered for 6.5 minutes — past the window
that used to deny it — stayed on screen with its three buttons and no countdown,
and the answer given at 6.5 minutes was accepted normally.
