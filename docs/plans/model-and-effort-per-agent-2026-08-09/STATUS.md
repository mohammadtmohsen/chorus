# Status

## Phase 1 done: Codex answers, and can be told

`pnpm check` green — 1088 tests, 12 of them new.

**`supportedModels()` over `model/list`.** Paginated, following `nextCursor`,
skipping models the provider hides from its own picker. `value` is
`Model.model`.

**`setEffort()` that actually reaches the provider.** Codex takes `effort` on
`turn/start` — per turn, where Claude takes it per session — so the only honest
implementation holds the level and repeats it on every turn. A test pins the
second turn as well as the first, because a session that applied it once would
silently revert to the model's default.

Without this method at all, `SupervisedSession.setEffort` optional-chains into
silence, and the sheet C-012 asks for would have saved an effort, displayed it,
and sent it nowhere. That was the review's sharpest catch.

### The live catalogue, and what it settled

Six models, `nextCursor: null`, run against a real `codex app-server`:

| model           | efforts                              |
| --------------- | ------------------------------------ |
| `gpt-5.6-sol`   | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna`  | low, medium, high, xhigh, max        |
| `gpt-5.5`       | low, medium, high, xhigh             |
| `gpt-5.4`       | low, medium, high, xhigh             |
| `gpt-5.4-mini`  | low, medium, high, xhigh             |

**`id` and `model` are identical for all six**, which confirms the review's point
that the live run the first draft planned could not have distinguished them. The
value question was closed from Codex's own source instead, and this run is only
evidence that it does not matter today — not that it never will.

**Three distinct effort lists across six models.** `ultra` exists on Sol and
Terra and not on Luna; `max` is absent from the 5.4 and 5.5 family entirely. So
`ModelChoice.effortLevels` being per model rather than global is not a
hypothetical nicety — a single global list would offer `ultra` on `gpt-5.4`,
which is exactly the control-that-lies the Claude adapter's comment warns about.

**Open question 1 is closed by the same run.** No model reports a single effort
option; the fewest is four. A one-row select is not a case that arises.

Verified end to end through the built adapter, not only against a fake transport:
six choices, correct labels, correct per-model efforts.

## Phase 2 done: the value stops crossing providers

`pnpm check` green — 1095 tests, 7 of them new. None of the three paths had a
test before, which is how two opposite bugs lived here at once.

- **New conversations** now honour the setting. `startConversation` built its own
  options with a cwd, a sandbox and no model, and never called `sessionOptsFor` —
  so the sheet headed "New sessions start with" did nothing for new sessions.
- **Reopen and add-participant** stop handing Claude's model to Codex.
  `sessionOptsFor` takes an agent, and reopen resolves inside its loop rather
  than once outside it.
- **Reopen passes no model at all.** A resumed thread already carries one in the
  provider's own record; passing today's preference would re-point a
  conversation that already exists, days after anyone chose it.
- **Effort follows the model** — Claude's, because that list has only ever been
  Claude's, and Codex's levels differ per model.

`sessionOptsFor` takes `{cwd, profile}` rather than a whole conversation.
`startConversation` has both before an `ActiveConversation` exists, and the cast
that would have papered over it is a lie the type system believes.

### One asymmetry, deliberate

The model is dropped on a reopen and the effort is not. A resumed thread carries
its own model, so passing one overrides it; effort is recorded nowhere, so _not_
passing it does not restore what the conversation had — it silently drops to the
provider default. Neither is "what it was", and losing the preference is the
worse of the two.

The real answer is recording effort per conversation, which is not this plan.

## What is left

Phase 3 — per-agent settings, the merge semantics in `settings:write`, discovery's
four states, and the sheet, together.
