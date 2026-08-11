# The menu that asks once

C-003. The residual menu failure. There is a real defect underneath it — an
effect that can reach a state from which it never asks again — and this plan is
about that, with the causal claim held to what has actually been shown.

## The problem

Two specs fail occasionally:

- `typing a slash offers the commands this project actually has`
- `an @ offers the cast, then the project's files`, on `typing a name found files`

Eight hypotheses are dead in
[`replace-claude-code-2026-08-08/STATUS.md`](../replace-claude-code-2026-08-08/STATUS.md),
which concluded the residual "looks like load, not a second bug".

### The defect: an effect that stops asking

Both menus gate on the same line, and it is the one that decides everything:

```ts
const menuOpen = options.length > 0
```

An empty list and a list that never arrived are the same thing to that line.

**The slash list is asked at most five times, then never again.**

|                                       | asks                         | over                                  |
| ------------------------------------- | ---------------------------- | ------------------------------------- |
| background retry (`Composer.tsx:188`) | 4                            | ~9s from mount — 0, +1.5s, +3s, +4.5s |
| on-demand ask (`Composer.tsx:321`)    | **1 per distinct `mention`** | instant                               |

The on-demand ask exists to take the clock out of the fix, and its guard is the
defect:

```ts
useEffect(() => {
  if (mention?.trigger !== '/' || commands.length > 0 || asking.current) return
  ...
}, [mention, commands.length, conversationId])
```

If that one request answers empty, `setCommands` is skipped — correctly, its
guard is `length > 0`. Then no dependency has changed: same `mention` object,
`commands.length` still `0`, same `conversationId`. **The effect cannot re-run.**
Type `/` once and stop, and every ask the composer has is spent. Waiting ninety
seconds cannot help, because nothing is waiting on anything.

**The file list is asked once per keystroke and every failure is silent.**
`files.ts:60` folds a timeout, a missing git, a spawn failure and "not a
repository" into one `return []`; the renderer turns any rejection into
`setFiles([])`. Nothing re-asks.

This much is read off the source and is not in question.

### What was wrong in the first draft of this plan

It claimed `listCommands` "already knows the difference and throws it away at the
call site". **It does not.** Five separate outcomes collapse to `[]` before the
renderer ever sees them:

| where                   | outcome                               | truthfully    |
| ----------------------- | ------------------------------------- | ------------- |
| `supervisor.ts:182`     | adapter has no `supportedCommands`    | terminal      |
| `claude-adapter.ts:287` | CLI too old for the capability        | terminal      |
| `claude-adapter.ts:304` | the request threw                     | **retryable** |
| `claude-adapter.ts:292` | response was not an array             | terminal      |
| —                       | the project genuinely has no commands | ready         |

So there is no distinction upstream to preserve, and any plan that assumes one
is solving the file half and declaring the slash half done. That was the error.

## The shape of the answer

**One result, three states, everywhere a menu is filled.**

| state           | means                                             | what the menu does     |
| --------------- | ------------------------------------------------- | ---------------------- |
| **ready**       | an answer arrived — _including a valid empty one_ | render it; stop asking |
| **retryable**   | the question could not be put                     | ask again, bounded     |
| **unavailable** | it can never be answered here                     | stop; never ask again  |

The third is why "retry on failure" is not enough on its own. A missing git and a
directory that is not a repository are **terminal** — asking again is a promise
that cannot come true, and on the file path it would spawn a process to learn
nothing, on every attempt.

### Which surface propagates, and which accepts ambiguity

**Files propagate all three.** The change is local to `files.ts` and one IPC
field, and the distinction is load-bearing there because retrying a missing git
has a real cost. `execFile` already carries what is needed: `err.code ===
'ENOENT'` is git missing, `err.killed` is the timeout, `EAGAIN`/`ENOMEM` are
spawn pressure under load, and exit 128 with `not a git repository` on stderr is
the terminal case.

**Commands accept the ambiguity, deliberately and in writing.** Propagating the
state would touch adapter → supervisor → runtime → IPC, which this repo treats
as a five-file change with three deliberately exhaustive switches — more than a
flake fix should carry. The cost of not doing it is bounded and small: a project
whose agents genuinely have no commands, or a CLI too old to have any, answers
empty to each of a handful of extra asks while a menu is open, and the two
terminal cases short-circuit inside the adapter without reaching a CLI at all.

**This is a stated trade, not an oversight.** Propagation is the successor, and
the successor is where the real answer lives.

### The retry policy, as a rate and not only a duration

"Bounded by the user's attention" bounds how long, not how often, and an
immediate re-ask loop could spawn git continuously. So:

- **one request in flight per surface** — the existing `asking` latch, kept
- **a floor between asks** — 800ms, so an open menu cannot busy-loop
- **a ceiling per open menu** — 8 asks, then it stops and says so
- **stop at once on `unavailable`**, and never resume for that cause
- **reset when the menu closes or the query changes**, because that is a new
  question rather than the same one continuing

## Phases

**Phase 0 — reproduce the defect deterministically.** Bundle the real `Composer`
with esbuild against a stubbed `window.chorus` whose `listCommands` answers empty
until t=12s then answers 49, and whose `completeFiles` fails its first call. Type
`/` at t=2s, wait 30s, assert the menu never opens. **This proves the effect
stalls. It does not prove it caused C-003** — see below.

**Phase 0b — the evidence C-003 actually asks for.** Instrument the two menus to
record which of the three states they were in, and run the full suite until a
real failure is caught with that record attached. Without this, the cause of the
_observed_ failures stays inferred.

**Phase 1 — the three states on the file path.** `files.ts` and its IPC shape
distinguish ready, retryable and unavailable. No behaviour change yet.

**Phase 2 — the re-ask,** under the policy above, on both menus. Phase 0's
harness turns green on the stimulus that made it red.

**Phase 3 — the specs.** They keep asserting the **real** results: the project's
actual commands, and a file named `mention-menu`. Status is diagnostics only — a
spec that ends on "loading" or "unavailable" **fails**, and says which, rather
than timing out with nothing to report. Then run the suite enough times to state
a number.

## On the causal claim

The mechanism is proven from source. That the mechanism produced the _recorded_
failures is **inferred**, and consistent with all of them — passing alone in six
seconds, failing inside a long suite, CPU loops not reproducing it — but it is
not demonstrated. Phase 0b is what would demonstrate it, and until it does, this
plan fixes a defect that can cause C-003 rather than one that is known to have.

## What this deliberately does not do

- **No retry constant is tuned.** STATUS.md already measured that road: three
  failures in twelve against one in twelve, the same number at that sample size.
- **No `agents:commands` push channel.** It would remove the race outright and is
  probably where this ends up, but it is a new event on a log-shaped boundary.
- **The `@` cast path is untouched** — it comes from the session record and has
  never been implicated.
- **The environmental reading is not called wrong.** Load is real and is what
  exposes this; the correction is only that it exposes a bug rather than being
  one.

## Base

Branch from `origin/main`. The focus and card-sizing work is already committed on
`fix/cards-that-stay-answerable`, five commits ahead — this must not be added to
that branch by accident.

## Status

**Not started.** Awaiting approval. Revised after review: the slash-side claim
about existing error information was false and is corrected above; the state
model gained a terminal case; the retry policy gained a rate; the causal claim
was demoted to inference with Phase 0b added to test it.
