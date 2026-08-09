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

## Phase 3 done: the settings are per-agent, and the sheet draws one row each

Shipped as one change because it could not be split — turning the IPC's `model`
and `effortLevel` from strings into per-agent maps breaks the existing component
in the same commit.

- **`models` and `efforts` are maps keyed by agent.** A zod `.transform()` folds
  a legacy scalar onto **Claude** and clears it, because the only catalogue the
  sheet ever showed was Claude's — so whatever is on disk today was chosen from
  it. The clear is what makes the fold happen exactly once; left in place it
  would keep overwriting whatever Claude was later set to.
- **`settings:write` merges one level deeper.** A spread is shallow, so sending
  `{models: {codex: 'x'}}` replaced the whole map and dropped Claude's — one
  agent's model silently clearing the other's, with nothing on screen to show it.
- **Discovery has four states** (`unqueried` / `loading` / `ready` / `failed`)
  where it had one silence. An empty answer was discarded and a failure
  swallowed, so the sheet could not say which had happened. Rows are seeded from
  the adapters, not from what discovery recorded, so an agent that has never
  started still gets a row.
- **A saved model that is no longer in any catalogue stays selected and named.**
  Dropping it to the provider default would hide the value that is actually
  being sent, and leave no way to change it.

### Verified in the running app, not just in tests

The three cases the plan asked for, driven through CDP:

- **Both agents present** — a row each, Codex offering its own six models with
  the provider default first; picking a Codex model left Claude's `opus` intact
  on disk. This is the merge bug, caught end to end.
- **One agent never started** — Codex still gets a row, with the provider default
  and the note that its models are read from a running session.
- **A model the CLI would reject** — `sonnet-4-retired` stays selected and named
  on screen rather than silently reverting.

### A test that proved nothing, replaced

The first `settings:write` merge test asserted over a hand-built object and so
only demonstrated JS spread semantics. It passed against the shallow merge. The
replacement drives the real `buildHandlers` handler, and was checked by reverting
the fix and watching it fail.

## Phase 3 corrected after review: four defects, two of them real bugs

Codex reviewed the shipped phase and was right on all four. Two were
correctness, and both were in the half of the change nothing had driven.

**Reopen ignored the configured model on every path that starts fresh.**
`reopen()` asked for options "as a resume" — which deliberately strips the model,
because a rejoined thread already carries its own — but it asked _before_ knowing
whether there was a thread to rejoin. Three paths start fresh from there: an
agent with no saved ref, a past conversation whose refs are deliberately empty,
and a resume that failed and fell back. All three started with no model at all,
which is the same bug this phase existed to fix, surviving in the half nobody
tested. `startParticipant` now takes `(resuming: boolean) => SessionOpts` and
asks at the point it knows, and the options it actually used are what get
attached — not a second guess at which branch ran.

**The `failed` state was unreachable.** Runtime recorded a rejection, and neither
production adapter could produce one: both caught everything and returned `[]`.
So a request that broke drew as "It offers no model choice" — precisely the
ambiguity the four states were added to remove. Both adapters now reject, and the
protocol says they must. Nothing downstream fails, because the only caller
already catches. Codex keeps partial pages: a catalogue that died on page three
is a truer picker than an error.

The test that was supposed to cover this passed a _successful_ empty page. It
proved nothing, and it is why the defect shipped. The fake now injects a real
JSON-RPC error, and `FakeAdapter` can fail its catalogue at all — it could not
before, which is the deeper reason the state went unverified.

**Codex's declared default was dropped** while the renderer assumed `models[0]`
was it. Measured live: Codex declares `gpt-5.6-sol` and it is currently also the
first row, so the bug is latent rather than visible — which is the argument for
fixing it, since row order is the provider's to change and the effort levels
shown for "provider default" would then belong to another model. `ModelChoice`
carries `isDefault`; the renderer reads the declared default _or_ the first row,
because Claude's `ModelInfo` has no such field and instead puts its default first
and labels it.

**The copy promised a control that does not exist.** "Each conversation can
change its own from its card in the sidebar" — there is no per-conversation
picker, the plan excludes one, and `Settings.tsx` is the only file in the
renderer that mentions models at all. Pre-existing text I extended rather than
checked.

### What this says about the phase

The three cases I drove in the app were all _fresh-start_ cases. Reopen is the
path a user actually takes every launch, and it had no test and no live run. Both
correctness defects were there.
