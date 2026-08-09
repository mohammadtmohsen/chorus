# Model and effort, per agent

Two agents, two providers, two model catalogues — and one pair of selects that
has been speaking for both.

Status: **not started, revised once after review.** Closes `C-012`.

The first draft had the direction right and the coverage wrong. What changed is
recorded in "What the review corrected" rather than quietly folded in.

---

## Two bugs, and the smaller one is the visible one

`C-012` describes a settings screen showing Claude's models unlabelled. True, and
the least of it. Reading the three paths that start a session turns up two
separate faults that happen to look like one.

**New conversations ignore the setting entirely.** `startConversation`
(`runtime.ts:431`) builds its own `SessionOpts` with a `cwd` and a `sandbox` and
**no model at all**. It never calls `sessionOptsFor`. So the sheet headed _"New
sessions start with"_ does not affect new sessions — which is the one path its
label promises.

**Reopen and add-participant apply one model to both agents.** Those two do call
`sessionOptsFor` (`runtime.ts:1553`), which takes a conversation and no agent,
reads one `model`, and hands the same object to whichever agent is starting. A
value chosen from **Claude's** list — the only list the sheet has ever shown — is
passed to Codex's `thread/start`.

So the first draft's "on every session" was wrong in both directions: the path
that should apply it does not, and the paths that do apply it apply it to the
wrong provider. Both are latent while the field is empty, which is probably why
neither has been reported.

## The board's premise is out of date

`C-012` says the work starts with "model discovery in the codex adapter first —
the CLI has `-m`, so the list exists somewhere", implying a parser over help
text.

It does not need one. `codex app-server` has **`model/list`**, and its `Model`
carries more than Chorus needs:

| field                                 | use                                      |
| ------------------------------------- | ---------------------------------------- |
| `model`, `displayName`, `description` | the value and its label                  |
| `supportedReasoningEfforts`           | `ModelChoice.effortLevels`, per model    |
| `hidden`, `isDefault`                 | which to offer, and which to offer first |
| `nextCursor` on the response          | pagination, which has to be followed     |

**`value` is `Model.model`**, not `Model.id`. The first draft left this open for
a live run to settle; that would not have settled it, because the catalogue
returns the two identically today. Codex's own model-override code uses `model`
as the slug, which is evidence a live run cannot produce.

`defaultReasoningEffort` is **not** used, and the first draft should not have
said it would: `ModelChoice` does not carry it and neither does the IPC response,
and extending both to express "the level in force when you have chosen nothing"
duplicates what an empty setting already means. The sheet offers _Provider
default_ as an explicit choice instead.

## Effort is not a setting Codex has

The sharpest thing the review found. `ModelChoice.effortLevels` exists, Codex
reports them per model, and none of that means Codex can be told to use one.

`CodexSession` has no `setEffort`. `SupervisedSession.setEffort` calls
`this.current.setEffort?.(level)` — optional, so it silently does nothing.
Building the sheet on what the catalogue reports would produce a control that
saves a value, displays it, and never sends it anywhere.

The two providers differ in kind here, not just in list:

- **Claude** takes effort as a session-level override, which is why
  `ClaudeSession.setEffort` exists and works.
- **Codex** takes `effort` on **`turn/start`** — per turn, not per session.

So `CodexSession.setEffort` has to hold the level and apply it to every
subsequent `turn/start`. That is a real piece of adapter work and it belongs in
this plan rather than being discovered when the row does nothing. Until it
exists, the sheet must not draw an effort control for Codex.

## The shape

**Codex learns to answer, and to be told.** `supportedModels()` over
`model/list`, following `nextCursor` and skipping `hidden`. `setEffort` holding a
level and applying it on each `turn/start`.

**All three session paths take an agent.** `sessionOptsFor(conversation,
agentId)`, and `startConversation` starts calling it — which is the fix for the
label that lies.

**Settings become per-agent**, and the write path has to change with them.
`settings:write` merges shallowly (`ipc.ts:351`): sending `{ model: { codex: 'x' } }`
would replace the whole map and lose Claude's. Either the nested maps merge in
main, or every write sends the complete map. Merging in main is the safer of the
two, because it does not depend on every future caller remembering.

**Discovery gets a state, not a length.** Today an empty answer is discarded and
a failure is swallowed (`runtime.ts:1861`), so "not asked yet", "asked and got
none" and "asked and it failed" are one indistinguishable silence. The sheet
cannot be honest about an agent that reports nothing until those are four
distinct states.

**_Provider default_ is always offered**, even when discovery failed. A saved
model that the CLI no longer accepts can stop a session starting — which is
exactly when the catalogue cannot be fetched, and exactly when the user needs a
way back to "no model chosen".

### What happens to the setting already on disk

The `model` and `effortLevel` in `settings.json` today were chosen from Claude's
list, because that is the only list there has ever been. So the migration is not
"split one value into two" — it is "recognise whose it was". The scalar moves to
**Claude's** entry and Codex starts empty, in a `zod` transform, the same way
`explainLanguage` normalises.

### Defaults are for new sessions only

Reopen currently passes today's defaults into a **resumed** provider session, so
changing the sheet silently changes conversations that already exist. The sheet
says "new sessions"; reopen should resume with what the session had rather than
what the preference says now.

## Phases

**Phase 1 — Codex answers, and can be told.** `supportedModels()` over
`model/list` with pagination and `hidden` handled; `setEffort` holding a level
and applying it on every `turn/start`. Fake-transport tests for the mapping, the
cursor, and that a set effort reaches the next turn. One live run against a real
`codex app-server` to see what the catalogue actually returns for an account.

**Phase 2 — the value stops crossing providers.** `sessionOptsFor` takes an
agent; `startConversation` starts using it; reopen resolves per agent inside its
loop and stops applying today's defaults to a resumed session. Ships alone and is
worth it alone: it turns a wrong model into no model, and makes the new-session
path honour the setting it is named for.

**Phase 3 — per-agent settings, end to end.** The schema, the migration, the
merge semantics in `settings:write`, and the sheet, **together**. They cannot be
separated: changing the IPC fields from strings to maps breaks the existing
Claude-only component the moment it lands (`Settings.tsx:343` reads and writes
scalars). Discovery's four states surface here too, because the honest empty
state is what the sheet needs them for.

Verified in the running app with both agents present, with one absent, and with a
saved model the CLI rejects — the recovery case.

## What this deliberately does not do

- It does not add a per-conversation model picker. That card existed once and was
  removed; this is the defaults sheet.
- It does not invent a merged catalogue or a "same for both" convenience. The two
  providers share no model, and a control implying they do is how the current bug
  reads.
- It does not fall back to Claude's list for an agent that reports none.
- It does not draw an effort control for an agent that cannot be told one. That
  is why Phase 1 exists before Phase 3.
- It does not cache the catalogue to disk. A stale list would outlive the CLI
  upgrade that changed it.

## What the review corrected

1. **"On every session" was wrong twice over.** New conversations never call
   `sessionOptsFor` at all, so the setting is ignored exactly where its label
   promises it applies; reopen and add-participant are the paths that misapply
   it.
2. **Codex cannot be told an effort.** No `setEffort`, and the supervisor's call
   is optional-chained into silence. The plan would have shipped a control that
   saved and displayed a value nothing ever received.
3. **Per-agent maps would have been clobbered on write.** `settings:write` merges
   only the top level.
4. **Phase 2 could not have shipped alone** as originally split, because the IPC
   type change breaks the existing component immediately. The schema and the
   sheet are now one phase.
5. **The "honest empty state" was not representable.** Empty and failed are both
   silence today.
6. **Open question 1 could not have been settled by a live run**, because `id`
   and `model` are identical in the catalogue. Closed from Codex's own source
   instead.
7. **`defaultReasoningEffort` was claimed and unavailable.** Dropped rather than
   threaded through two contracts to express what an empty setting already says.

## Open questions

1. **Whether to offer an effort control for a model reporting one option.** A
   select with a single row is furniture.
2. **What an installed agent that is not in any conversation should show.** The
   sheet is about defaults for new sessions, so arguably every installed agent
   gets a row — but the catalogue comes from a live session, and there may not be
   one.
3. **Whether a saved model should be validated against the catalogue at startup**
   rather than only failing when a session tries to use it. Recovery is covered
   by always offering _Provider default_; catching it earlier is a separate
   nicety.
