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

## What is left

Phase 2 — `sessionOptsFor` takes an agent, `startConversation` starts calling it,
and reopen stops pushing today's defaults into a resumed session.

Phase 3 — per-agent settings, the merge semantics in `settings:write`, discovery's
four states, and the sheet, together.
