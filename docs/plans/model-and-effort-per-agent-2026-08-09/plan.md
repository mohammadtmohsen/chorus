# Model and effort, per agent

Two agents, two providers, two model catalogues — and one pair of selects that
has been speaking for both.

Status: **not started.** Closes `C-012`.

---

## The problem is not the settings screen

`C-012` says the pickers "are Claude's and unlabelled as such", which is true and
is the smaller half. The sharper problem is what happens to the value.

`sessionOptsFor` (`runtime.ts:1553`) takes a conversation and no agent. It reads
one `model` from settings and returns one `SessionOpts`, and
`startParticipant` hands that same object to whichever agent is starting. So a
model chosen from **Claude's** list — the only list the sheet has ever shown — is
passed to Codex's `thread/start` as its `model`.

That is not a cosmetic gap. It is a value from one provider's catalogue being
sent to another's API, on every session, whenever anyone has set a default at
all. Nobody has reported it, which most likely means the field is usually empty
and the bug is latent rather than absent.

So this is a correctness fix with a settings screen attached, rather than a
settings screen with a correctness footnote.

## The board's premise is out of date

`C-012` says the work is "model discovery in the codex adapter first — the CLI
has `-m`, so the list exists somewhere", implying something scraped out of help
text.

It does not need scraping. `codex app-server` has **`model/list`**, and its
`Model` carries more than Chorus needs:

| field                                 | use                                      |
| ------------------------------------- | ---------------------------------------- |
| `model`, `displayName`, `description` | the value and its label                  |
| `supportedReasoningEfforts`           | `ModelChoice.effortLevels`, per model    |
| `defaultReasoningEffort`              | which one is in force unasked            |
| `hidden`, `isDefault`                 | which to offer, and which to offer first |
| `nextCursor` on the response          | pagination, which has to be followed     |

Per-model effort levels are exactly the shape `ModelChoice` already has, and for
the same reason the Claude adapter documents: the levels a model supports are a
property of the model, and offering one it silently downgrades is a control that
lies.

That makes this much smaller than the board assumed, and worth recording before
anyone starts writing a parser.

## The shape

**Settings become per-agent.** `model: string` and `effortLevel: string` become
maps keyed by agent. The old scalars are read and migrated rather than dropped —
see below.

**Codex learns to answer.** `supportedModels()` on `CodexSession`, over
`model/list`, following `nextCursor` and skipping `hidden` models. Nothing else
in the pipeline changes: `knownModelsByAgent` already stores per agent,
`runtime.knownModels()` already returns per agent, and only the sheet and
`sessionOptsFor` have been collapsing that back down to one.

**`sessionOptsFor` takes an agent.** It is the actual fix, and it is small.

**The sheet grows a row per agent**, each labelled, each showing that agent's own
models and that model's own efforts. An agent that reports none says so rather
than drawing an empty control — which is the state Codex is in today and would
still be in on a machine where `model/list` fails.

### What happens to the setting already on disk

Someone has a `model` and an `effortLevel` in `settings.json` now. Both were
chosen from Claude's list, because that is the only list there has ever been.

So the migration is not "split one value into two" — it is "recognise whose it
was". The scalar moves to **Claude's** entry and Codex starts empty, which is
both the honest reading and the one that stops the latent bug on first launch
rather than carrying it forward under a new name.

`zod` does that in the schema with a `.transform`, the same way
`explainLanguage` normalises, so a file written by 0.8.1 opens correctly without
a migration step anyone has to remember.

## Phases

**Phase 1 — Codex reports its models.** `supportedModels()` over `model/list`,
with pagination and `hidden` handled, mapped to `ModelChoice`. Tested against a
fake transport for the mapping and the cursor, and driven once against a real
`codex app-server` to see what it actually returns — the shape is generated from
the protocol, but which models a given account is offered is not.

**Phase 2 — the value stops crossing providers.** `sessionOptsFor` takes an
agent; settings become per-agent with the migration above. This is the
correctness half and is worth shipping even if the sheet lands later, because it
turns a wrong model into no model.

**Phase 3 — the sheet.** A labelled row per agent, each with its own models and
efforts, and an honest empty state. Verified in the running app with both agents
present, and with one absent.

## What this deliberately does not do

- It does not add a per-conversation model picker. The card in the sidenav had
  one once and it was removed; this is the defaults sheet, and the plan does not
  reopen that.
- It does not invent a merged catalogue or a "same model for both" convenience.
  The two providers do not share a model, and a control implying they do is how
  the current bug reads.
- It does not fall back to Claude's list for an agent that reports none. An empty
  control that says why is better than a populated one that is wrong.
- It does not cache the catalogue to disk. `knownModelsByAgent` already survives
  as long as the process, and a stale list on disk would outlive a CLI upgrade
  that changed it.

## Open questions

1. **What `value` should be for Codex** — `Model.model` or `Model.id`. They are
   separate fields and only one is what `thread/start` accepts. Phase 1's live
   run answers it; guessing produces a picker whose every choice fails.
2. **Whether effort should be offered at all for a model that reports one
   option.** Claude's models all report the same five today, so the control is
   uniform there; if a Codex model reports a single effort, a select with one row
   is furniture.
3. **What an agent that is installed but not in the conversation should show.**
   The sheet is about defaults for _new_ sessions, so arguably every installed
   agent gets a row — but the model list comes from a live session, and there may
   not be one.
