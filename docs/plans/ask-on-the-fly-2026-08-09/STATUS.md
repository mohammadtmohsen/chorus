# Status

## Phase 0 done: forking is real on both providers, and it is slower than the interaction wants

Run against the installed CLIs — `claude` 2.1.226 and `codex-cli` 0.146.0 — with
throwaway spikes driving the Claude SDK and the raw `codex app-server` JSON-RPC
directly, deliberately not through Chorus's adapters, so the results describe the
providers rather than our wrappers. The spikes have been deleted; everything they
established is below.

### Q1 — can a live session be forked while its own turn is running? Yes, both.

Neither provider errors, and neither parent turn was disturbed. Claude's parent
completed normally afterwards (1008 output tokens); Codex's completed with 1334
characters of text after its fork had already answered. **The "hide Ask while the
agent is busy" fallback contract is not needed and is dropped from the plan.**

Codex accepted `ephemeral: true` and returned `forkedFromId` pointing at the
parent, exactly as `ThreadForkParams` describes.

### Q1a — but a Claude mid-turn fork cannot see the in-flight turn

The sharpest finding, and it was not on the list of things being asked.

Forking Claude mid-turn and asking about the reply then streaming produced:

> "I didn't describe any numbers — I was asked to count from 1 to 40 but
> returned no response, so there's nothing to continue from."

The fork inherits the session **as persisted**, and the in-flight turn has not
been written yet. So a mid-turn fork sees history up to the last _completed_
turn.

This is survivable rather than fatal, because the plan already refuses to offer
Ask on a streaming response — the source must be a completed message, and a
completed message is by definition visible to the fork. But it is now a load-
bearing reason for that rule rather than a UI nicety, and it must be stated as
such. It also kills any future idea of asking about a reply as it arrives.

Codex was verified the other way round and passed: a magic word planted in turn 1
("bananaphone") was correctly recalled by a fork taken during turn 2, proving the
fork genuinely inherits parent history rather than starting blank.

### Q2 — cost is negligible; latency is not

Claude, forking a session holding ~26k tokens of context and asking one short
question:

|                 | input | cache read | cache write | output |
| --------------- | ----- | ---------- | ----------- | ------ |
| mid-turn fork   | 2     | 15,214     | 10,683      | 44     |
| after-turn fork | 2     | 25,860     | 1,028       | 6      |

Prompt caching absorbs essentially the whole context — 2 uncached input tokens.
**The token cost of an aside is a rounding error, and open question 1 about using
a cheaper model is closed: it would buy nothing.**

Latency is the problem:

|                         | time to first token |
| ----------------------- | ------------------- |
| Claude, mid-turn fork   | 5,098 ms            |
| Claude, after-turn fork | 4,190 ms            |
| Codex, fork (run A)     | 4,494 ms            |
| Codex, fork (run B)     | 8,568 ms            |

**Four to eight and a half seconds.** The plan promises a card that opens and
dismisses "like a tooltip". Nothing that takes five seconds to say its first word
is a tooltip. This does not invalidate the feature, but it does invalidate the
framing, and the card's design has to carry the wait honestly rather than pretend
it away.

### Q3 — most of the wait is config, not thinking

Claude's `system/init` reported **151 tools, 51 slash commands and 5 MCP
servers** (`github`, `jira`, `slack`, `internal-api` connected; `mobile-mcp`
failed), and took ~2.6s from spawn before the turn could begin.

So roughly half the time-to-first-token is a fork loading the user's full
configuration to answer a question that cannot use any of it. `settingSources` is
omitted deliberately and that is right for a working session; for a read-only
aside it is pure cost. **Open question 2 is now the most valuable one in the
plan**, because suppressing MCP servers and hooks in a fork plausibly halves the
wait — and it would simultaneously turn "explanation only" from a policy into a
property, since a suppressed hook cannot have a side effect.

### Incidental findings

- `codex app-server` logs `ERROR ... failed to load models cache: missing field
'base_instructions'` on startup. Harmless here, unrelated to this work, but it
  is the kind of thing that looks like our bug when it is not.
- `agentMessage` items arrive **flat** — `{type, text, phase}` — while
  `userMessage` nests under `content[]`. Guessing the nested shape cost two spike
  runs. This is exactly the trap `CLAUDE.md` already records for the rate-limit
  event, met again in a second place.
- The Claude SDK cannot be driven without `pathToClaudeCodeExecutable`, because
  `pnpm-workspace.yaml` excludes its bundled binary. `claude-adapter.ts:800`
  documents this already; any future spike should start there rather than
  rediscovering it.

### What this changes in the plan

1. The busy-state fallback contract is **dropped** — forking mid-turn is safe.
2. "Source must be a completed message" is promoted from a UI rule to a
   **provider constraint**, with Q1a as its reason.
3. Open question 1 (cheaper model) is **closed**: cost is already negligible.
4. Open question 2 (suppressing hooks/MCP in a fork) is **promoted into Phase 2**
   as work rather than a question, because it buys both latency and safety.
5. The card must be designed for a **4–8 second wait**: it opens immediately with
   the excerpt and a visible pending state, and dismissing must be possible while
   the answer is still in flight.

Phases 1–4 remain unstarted at the time of writing.

---

## Phase 1 done: the button says what it does, and the classifier is real

`pnpm check` green — 972 tests, 12 of them new.

- `conversation.askAboutThis` → `conversation.quoteInMessage`, **"Quote in
  message"**. `withQuote`, composer focus and draft behaviour are untouched; only
  the label moved.
- `askableSource` in `quote.ts` — a pure classifier taking the entries at both
  ends of a selection and returning the source when an aside could be asked about
  it, `null` otherwise. Twelve tests: cross-entry ranges, streaming replies, user
  and system actors, all five non-message kinds, missing event ids, whitespace,
  and the excerpt limit at and past its boundary.
- `Entry` now writes `data-event-id`, `data-actor`, `data-kind` and `data-status`
  on every entry, so a DOM selection can be resolved to what it came out of.
- `Session.readSelection` resolves both ends of the range and stores the result.
  Both ends deliberately, not `commonAncestorContainer`: a range spanning two
  entries has the scroller as its common ancestor, which would read as "no
  source" rather than as the cross-entry selection it is.

### Departed from the plan: the two-action toolbar is deferred to Phase 4

The plan put the toolbar in Phase 1. It is not here, and the reason is that Ask
has nothing to open until Phase 4 — shipping a visible button that does nothing
is worse than shipping the rename alone.

What Phase 1 delivers instead is everything the toolbar will need: the decision,
pure and tested, plus the metadata it decides from. The classifier already runs
on every selection and reports through `data-askable` on the offer button, so a
wrong answer is visible in the running app and assertable in e2e before anything
is built on top of it. Phase 4 adds the card and the second button together, as
one change that can be looked at.

### `anchorFor`'s width estimate was already wrong, and is now less so

`width: 96` is used only for clamping the pill inside a narrow pane — CSS centres
it with `translate(-50%)`. Measured against the CSS rather than assumed: 11px
monospace, `--step: 3px` so 9px padding each side, 1px border. The old label
needed ~112px and the new one needs ~126, so 96 was letting the pill overhang
before this change and would have overhung further after it. Now 128, with the
derivation written next to the number so the next label change can redo it. The
two clamp tests moved with it.

### Verified in the running app

Driven through the project's own `e2e/harness.mjs` — the real Electron app over
CDP, a real `claude` session, a real reply — because `sourceEntryAt` reads the
DOM and no unit test can reach it. All eight checks passed:

- entries carry `data-event-id`, `data-kind` and `data-status`;
- selecting inside a completed agent message offers **"Quote in message"** with
  `data-askable="true"`;
- selecting the user's own message still offers to quote, with no `data-askable`;
- selecting across two entries still offers to quote, with no `data-askable`.

The driver was throwaway and has been deleted; Phase 4 owns the real spec, and
these four are what it should assert.

### Phase 2 part done: `fork` is on the port and implemented on both adapters

`pnpm check` green — 987 tests, 15 of them new.

- **`ForkOpts` and `AgentAdapter.fork?`** in `agent-protocol`. Optional, paired
  with `capabilities.fork`, the way `setModel` is paired with
  `modelSwitchMidSession`: the flag is the promise, the method is the
  implementation. Always ephemeral — nothing wants a fork that outlives its
  question, and a persisted one would litter the user's own session list.
- **Claude**: `resume` + `forkSession: true` + `persistSession: false`. Both
  flags together or neither, which is what the tests pin. Half of it is merely
  untidy — `forkSession` alone writes every throwaway branch to disk — and the
  other half is data loss: `persistSession: false` without `forkSession` stops
  the _original_ session recording.
- **Codex**: `thread/fork` + `ephemeral: true`, at the head, with no
  `lastTurnId`. A test asserts `thread/resume` is never sent, because resume and
  fork differ by one word at the call site and by everything in effect —
  resuming would put the aside in the transcript the user is watching.
- **Both capability flags now honest.** Claude's flips false→true in the phase
  that implemented it, as its own comment demanded. Codex's was _already_ true
  while the adapter issued `thread/fork` nowhere; it is now earned rather than
  claimed, and the comment says so.

### Still open in Phase 2: what a fork should inherit

The plan promoted "suppress inherited tooling" from question to work, on Phase
0's finding that ~half the 4–8s wait is 151 tools, 51 slash commands and 5 MCP
servers loading for a question that can use none of them.

Reading the SDK rather than assuming, there are two levers and they are not
equivalent:

|                               | effect                                                         | latency                               | keeps `CLAUDE.md`        |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------- | ------------------------ |
| `settingSources: []`          | no user/project/local settings, so no hooks and no MCP servers | servers never start — the real saving | **no** (`sdk.d.ts:1908`) |
| `disallowedTools: ['mcp__*']` | MCP tools filtered out                                         | servers still start                   | yes                      |

So the latency win and project instructions are in tension, and the tension is
about answer quality: an aside explaining a subtle choice may well need the
project's own conventions.

`ForkOpts.inherits` is therefore `'config' | 'nothing'` — an explicit choice at
the call site rather than a default buried in an adapter — and both paths are
implemented and tested.

**Decided: `'config'`.** Not on latency, which argued the other way, but on
consent — _"when I give you a permission I want to keep it on the side chat."_ A
fork that forgot what the user had already allowed would be a different agent
wearing the same name. `'nothing'` stays implemented as the escape hatch if a
4–8 second aside proves unusable.

Codex has no equivalent lever exposed on `ThreadForkParams` beyond
`baseInstructions`/`config`, so the two providers may not be able to match if
`'nothing'` is ever chosen; that is unexamined, and it does not block the
decision above.

**And it opened a question the plan had answered wrongly.** "Permission" means
two things: the CLI's own rules, which ride on `settingSources` and are now
carried; and Chorus's `SessionGrants` (`runtime.ts:327`), which are a separate
object an aside only receives if handed it. The plan gives asides the read-only
profile and auto-denies everything — which for the second kind means an aside
_forgets_ grants already given, exactly the opposite of what was asked for. The
plan now records the reconciliation and defers the sharp end of it — whether an
aside may mutate under an inherited grant — to Phase 3.

### Phase 3 done, except its delivery: the domain works end to end

`pnpm check` green — 1016 tests, 49 of them new since Phase 1.

**The store's first ever migration.** `conversations` gains nullable `kind`,
`parent_id` and `source_event_id`. Nullable is the design: every
`conversation.created` ever appended lacks them, so `kind IS NULL` means "an
ordinary conversation", which is what every existing row is. There is no
`kind: 'main'` to backfill — inventing one would make old rows wrong rather than
merely quiet. The test that matters builds a **v1 database with data in it** and
upgrades it, because "does a fresh database get the new columns" was never the
risk.

**Queries.** `listConversations` excludes asides — an aside in the sidebar would
put "what did you mean by that" beside the work it was about. `listAsides(parent,
sourceEventId?)` finds them, which is the access path draft 2 got wrong: `read`
filters on conversation, seq and type only, so a projection row is what makes an
aside findable at all.

**`ConversationService.neverAsks`.** This is the reconciliation of the two things
that were asked for. `evaluate` runs first and unchanged, so the profile's allows
and the user's grants still go through — _"when I give you a permission I want to
keep it on the side chat"_. Only the `ask` outcome is replaced, by an immediate
deny rather than a queued card, because there is no room in a tooltip for an
approval and an unattended fork holding one open is a wedged turn.

A test found an overclaim in my own comment while writing it: the denial message
reaches the **provider** but is not recorded in `approval.decided`, which carries
a verdict, a scope and a rule and no text. So the agent learns why and can say so
in its answer; a card wanting to explain a refusal must supply its own words. The
comment now says that instead of the opposite.

**`ChorusRuntime.openAside`.** Forks the agent that said the passage, opens a
hidden child conversation, attaches an ordinary `ConversationService` to it, and
asks. It re-resolves the source event from the log and checks the excerpt is
genuinely part of that reply — the renderer is the least trustworthy thing in the
process tree, since it renders untrusted agent output, and a caller that could
name any event and any excerpt could put words in an agent's mouth and have them
quoted back as its own. Ten tests, most of them refusals.

It also carries a framing the plan had not thought to specify: the fork is told
_"answer it and nothing else: do not continue the work"_. Without that a fork
treats the question as the next turn and starts doing things — which no
permission rule would catch, because reading files is allowed.

**Conformance gained a check** that a declared capability has a method behind it,
in both directions. It immediately caught a third instance of the bug that
prompted it: `FakeAdapter` also said `fork: true` with nothing behind it.

### What is left, and why it stops here

**IPC and the card — Phase 4, together.** The domain is complete and tested;
nothing in the renderer can reach it yet. Adding the IPC channels alone would be
dead code, so they belong with the component that calls them.

That remainder is: `conversation:aside/*` channels and the preload bridge, a
non-modal `QuickQuestion` card following the `.quote-offer` lineage rather than
the modal-sheet one, the second toolbar action deferred from Phase 1, the badge
and view-only reopen, promotion staging `@author` into the composer, i18n, styles
and `SessionCarry`. It is the half whose value is entirely in how it feels, and
none of it is verifiable by `pnpm check` — so it wants a running app and an eye,
not another green suite.

### The verification found a harness bug worth more than the verification

The first run reported no agent reply at all. The reply had in fact arrived —
what was missing was every `data-*` attribute, because **the app under test was
running a renderer bundle two hours old**. `ensureBuilt()` had rebuilt `out/main`
and `out/preload` but left `out/renderer` untouched, and its own freshness check
then read those new `out/main` mtimes as proof the build was current.

Filed as **C-014**, and fixed before going further, because Phase 4 rests on e2e
and e2e could lie. `ensureBuilt` now takes the **oldest** of `out/main`,
`out/preload` and `out/renderer` rather than the newest file anywhere under
`out/` — one stale output is a stale app however fresh the other two are — and
re-checks after building, throwing rather than testing a stale app.

Verified by reproducing the exact state: renderer backdated an hour, main and
preload fresh, a source file in between. The old check reported it would _skip
the build_; the new one rebuilds. The fast path survives — 140ms on an
already-current tree against ~2s for a build. C-014 is off the board.

It is also a reminder for this work specifically — the first run's symptom looked
exactly like "the agent never replied", and the honest diagnosis only came from
dumping what was actually on screen rather than trusting the assertion that
failed.
