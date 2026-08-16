# The word you always type

Asked for as: _"when discussing with an agent a change request or fix there is
always a point to ask the agent to go, start implement, go next, go with
recommendation. Is there a way to know when to show a quick button — like a
spark — to do this, after the conversation is complete and it's time to
implement?"_

## Context

The loop ends the same way every time. The agent lays out what it would do, or
offers two options and names its preference, and then waits. You type `go`.

**Half of this is already solved and it is worth saying which half.** When Claude
is in plan mode, `ExitPlanMode` arrives as an ordinary permission request, and
`conversation-service.ts:349` recognises it: approving the plan also drops the
session out of plan mode, for the whole room rather than for one agent. Codex
has `plan.updated`. So when a provider tells Chorus that planning is over, there
is already a structured moment with a button on it.

The gap is everything else — the ordinary reply that ends _"shall I go ahead?"_.
No tool call, no event, no mode. Prose, and then a wait. That is where `go` gets
typed, and there is no signal for it at all.

**Outcome:** a `Go` action on the last finished reply, shown when that reply
reads as an offer to act, sending one carefully written instruction instead of
the word `go`.

## The detector, and why it is not "ends in a question"

Decided with the user: a text heuristic, not a model call. A model call would be
accurate and would cost a paid turn per reply, which is a much larger version of
the per-turn cost C-004 already has open.

A heuristic will be wrong. The question is which way, and the obvious rule is
wrong in the dangerous direction. "Ends in a question mark" fires on

> Which database should this target?

where `Go` means "choose for me" and produces confident work on a decision that
was never made. The discriminator is not the punctuation, it is **who can act
next**:

| Reads as   | Shape                                                                                                                                                                  | Chip   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| An offer   | the agent proposed something it can do unaided — _"shall I"_, _"want me to"_, _"I can implement"_, _"ready when you are"_, or options **with** a stated recommendation | shown  |
| A question | the choice is the user's and the agent cannot proceed — _"which"_, _"should this be X or Y"_, options **without** a recommendation                                     | hidden |

So options plus a recommendation is an offer; options without one is a question.
That single rule removes most of the damage the naive version would do.

**`offersToAct(text)` is pure and lives in the renderer**, beside `askableSource`
in `quote.ts`, which is the same shape of decision: a classification of what is
on screen that decides whether to offer an action. It is not prompt content, so
it does not belong in main.

## The prompt, and the line that makes the heuristic survivable

Built in **main**, beside `explainPrompt`, `translatePrompt` and `recapPrompt`.
Not passed from the renderer: `shared/ipc.ts:757` records that prompt content
from the renderer is the same class of problem as an unverified source event, and
that is why every aside prompt is built where the log is. **The IPC therefore
carries an intent, not a string.**

```
Go ahead with what you just proposed.

If you offered options, take the one you recommended, and say in one line
which you took. Do not restate the plan and do not re-plan it — you have
already done that part.

Work to the end of what you proposed. Stop before the end only if a decision
is genuinely blocking, and then ask that one question and nothing else.

If you were actually asking me something rather than offering to act, answer
the question instead. Do not guess at what I would have chosen.
```

The last paragraph is the load-bearing one. It costs a line and it converts the
detector's worst failure — firing on a question — from _confident wrong work_
into _it answers the question_, which is what typing nothing would have got. A
heuristic that cannot be perfect is made survivable by the prompt rather than by
more regex.

The middle paragraph is the same lesson `recapPrompt` learned: a model asked to
proceed will often re-explain the plan first. Naming that is cheaper than
regretting it.

## What lands in the transcript

`Go ahead.` — not the prompt.

`sendUserMessage(text, delivered)` already splits these for asides, with the
reason stated there: logging the wrapper puts words in the user's mouth in their
own transcript. `runtime.send` has no such split, so this adds one — and adds it
as an **intent** rather than as text, so the expansion stays in main:

- `conversation:send` gains `intent?: 'go'`.
- `runtime.send` routes and logs exactly as it does now — the raw typed text,
  mentions intact — and delivers `goPrompt()` in place of `route.text` when the
  intent is set.
- The other agent's catch-up replays the logged `Go ahead.`, which is honest:
  that is what happened.

The mention matters. `runtime.send` routes from the logged text, and
`lastAddressed` is not necessarily whoever spoke last — so the button sends
`@claude Go ahead.` the way `recapPromotion` does, and for the same reason.

## Where it goes, and what it does to the row

`.entry-actions`, as a third tenant beside Hand off and Recap, on the last
finished reply only — the same `final` gate Recap uses, and for the same reason:
it is the only reply an offer can belong to.

**Three buttons break the row we just set.** `space-between` was chosen an hour
ago for exactly two, and with three the middle one centres in an 1,100px row.
The fix is not to abandon it but to group by kind: **Hand off and Go are things
you do, Recap is a way of looking** — so the two act-buttons sit together at the
left and Recap keeps the right edge.

```
[Hand off →]  [⚡ Go]                                    [Where are we?]
```

One `<span>` around the first two, with `space-between` on the row unchanged.

## What this is deliberately not doing

- **Not three chips.** `Go`, `Your call` and `Next` were on the table and the
  single button won. One prompt to write, one to tune against real answers.
- **Not rebuilding plan mode.** `ExitPlanMode` already has its own approval and
  its own exit. This is for the replies that never enter a mode.
- **Not a model classifier.** Decided; see above.
- **Not auto-sending.** The chip fills nothing and sends on click. A button that
  fired on detection would be an agent that starts work because it phrased
  something as an offer.
- **Not touching the permission engine.** Every action `Go` leads to is gated
  exactly as it is today. This lowers the _typing_, not the consent.

## Phases

1. **`offersToAct` + its tests**, pure, in the renderer. Written against real
   replies out of the log rather than invented ones — the store has 6,733
   `agent.message.completed` rows to sample offers and questions from.
2. **`goPrompt` in main**, plus the `intent` on `conversation:send` and the
   delivery swap in `runtime.send`.
3. **The chip**, the row regrouping, the i18n keys.
4. **Tune against real answers**, the way `explainPrompt`'s "Leave out" list was
   earned: every phrase added to the detector names the reply that defeated it.

## Open questions

- **How wrong is the detector, actually?** Phase 1 can answer this before any UI
  exists: run `offersToAct` over every `agent.message.completed` in the real
  store and read a sample of both verdicts. That is a measurement, not an
  opinion, and it should happen before the chip is built rather than after.
- **Does `Go` belong on any reply, or only the last?** `final` is assumed here.
  A reply three turns back may still hold an unanswered offer, but acting on a
  stale one is the same class of mistake as a stale recap.
- **English only.** Every phrase in the detector is English. An agent answering
  in another language gets no chip. Acceptable for now; worth stating.
