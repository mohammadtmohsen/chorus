# Ask on the fly

Let someone ask a small question about one passage of an agent's response,
answered with everything that agent knows, without that aside becoming the next
turn of the main conversation.

Status: **built and driven in a real app.** Fork on the port and both adapters,
the store's first migration, hidden child conversations, the runtime lifecycle
with its refusals, the IPC, and the card. The golden path was verified end to end
against a real `claude`, not only by the suite.

Still undrawn: the badge on a reply that already has asides, and reopening one
view-only. The queries behind both exist and are tested.

Several things in this plan were corrected by measurement or by review rather
than by argument. `STATUS.md` is the record of which, and why.

---

## The problem

The selection action currently labelled **Ask about this** does not ask
anything. `Session.tsx:368` calls the composer's `quote` handle, and `withQuote`
(`quote.ts:38`) appends the passage as a Markdown blockquote to the existing
draft. That is useful behaviour, but the label promises a completed action where
the code only prepares a message.

The missing half is the one the label was borrowed for. A reply runs for pages,
one clause in it is unclear, and asking costs a full turn in a shared room: it
enters the log, both agents are told through catch-up, it moves the routing
state, and — the part that is easy to miss — it lands permanently in the
provider's own context window, which Chorus tracks closely enough to draw
(`context.usage`). A footnote should not cost that.

So the feature has two jobs: name the existing action honestly, and add a way to
ask that reads everything and costs the main thread nothing.

## Two corrections, recorded rather than quietly applied

This plan has been wrong twice, in opposite directions. Both are kept here
because the reasoning that produced each error is the useful part.

**Draft 1 was wrong about the providers.** It chose a fresh child session seeded
with a bounded snapshot of the parent log, reasoning that _"Claude has no
equivalent adapter path, so using it now would make the feature
provider-dependent."_ Read out of `sdk.d.ts`, as this repository's rule requires,
that is false:

|                           | Claude SDK                           | Codex app-server        |
| ------------------------- | ------------------------------------ | ----------------------- |
| fork rather than continue | `forkSession?: boolean` (`:1500`)    | `thread/fork`           |
| fork at a point           | `resumeSessionAt?: string` (`:1815`) | `lastTurnId`, inclusive |
| leave no stored session   | `persistSession?: boolean` (`:1586`) | `ephemeral: true`       |

This is the failure `CLAUDE.md` names outright — _"Read shapes out of `sdk.d.ts`,
never out of prose or memory."_

**Draft 2 over-corrected.** Having fixed the context source, it also threw out
draft 1's storage model, replacing the child conversation with four bespoke
`aside.*` events and a small dedicated service, on the claim that a read-only
aside emits "only text and failure". Codex's review showed that claim is wrong on
three counts, all verified:

- A read-only session still emits reasoning, tool calls, notices, usage and
  lifecycle. The read-only profile **asks** rather than denies — `SAFE_READS`
  allows `git status`, `ls`, `cat`, `grep` and friends outright
  (`rules.ts:125`), and the credential rule is `effect: 'ask'`. A service with no
  approval handling does not stay quiet; it wedges.
- Four flat events cannot express follow-ups, multiple turns, cancellation,
  retry, or which answer belongs to which question — all of which the same draft
  promised in its Phase 3.
- The projection no-op's stated reason was false. `store.read` filters on
  `conversation_id`, `seq`, `type` and `limit` only (`store.ts:169`);
  `sourceEventId` lives inside the JSON payload and is not queryable at all.

The conclusion is a synthesis rather than a reversal: **draft 1 was right about
where an aside is stored, draft 2 was right about where it gets its context.**
Each half is kept.

## The shape

**Fork for context. Child conversation for durability.**

A fork is a copy of the session as it stands, made by the CLI itself. It begins
knowing everything the agent knows — the whole conversation, every file read, its
own reasoning. The question is asked in the copy.

```
main session  ──●──●──●──●──   never hears the question; context untouched
                          └──○ the fork: inherits all of the above, and answers
```

The rejected alternative is worth stating because it looks equivalent and is not.
A fresh session handed a summary can answer _"what does this word mean"_ but not
_"why did you choose that over the other one"_, because the reasoning that
produced the choice is exactly what a summary drops. It also pays input tokens to
re-send that summary, so it is both more expensive and less able.

The fork's output is recorded under a **hidden child conversation** with its own
`conversationId`, consumed by the ordinary `ConversationService`. That is what
makes the lifecycle work rather than merely be promised: follow-ups, multiple
turns, interruption, retry and reopen are all just ordinary conversation events,
already reduced by the existing transcript reducer, already made durable delta by
delta. Its events cannot leak into the parent's transcript or catch-up because
they carry a different conversation id — a stronger guarantee than a filter,
because it holds by construction.

It also fixes the access path. Reading an aside back is `store.read(childId)`,
which is precisely the filter the store supports.

## The interaction

Selecting text inside one completed agent response offers two actions:

- **Quote in message** — today's behaviour exactly. Append a Markdown quote to
  the main composer, preserve the existing draft, focus the composer.
- **Ask about this** — open a small non-modal card anchored to the passage.

The card shows the excerpt, names the agent it will ask, and takes a short
question. The answer streams inside it. The main composer, attachments, IDE
context, current turn, scroll-follow, busy state and routing do not change.

**It will not be instant, and the design has to say so.** Phase 0 measured 4–8.5
seconds to first token on both providers. So the card opens immediately with the
excerpt and a visible pending state rather than appearing when the answer is
ready, and it can be dismissed while the answer is still in flight — a wait you
cannot walk away from is worse than the turn this feature is avoiding. Phase 2's
tooling suppression is the attempt to shorten it; open question 1 is what to do
if that fails.

It has **three exits**:

1. **Dismiss** — Escape or a click away, immediately, no confirmation. The card
   behaves like a tooltip.
2. **Quote in message** — stage the exchange into the composer and keep typing.
3. **Take this and continue** — stage the conclusion into the composer,
   prefixed with an explicit `@author` mention, for the user to trim and send.

Exit 3 is staging, not a direct send, and the wording matters. `runtime.send`
routes by mentions and `lastAddressed` (`runtime.ts:400`), so in a two-agent room
an unmentioned send is **not guaranteed to reach the passage's author**. An
explicit `@author` is what makes the routing deterministic, and it costs the user
one keystroke rather than a new targeted-send path in the runtime. Because the
ordinary send path already steers a working agent (`adapter.ts:126`, both
adapters declare `steer: true`), "and continue" needs no new machinery.

One subtlety governs the prefill: **the main agent never saw the aside.** A
promotion of "yes, do that" is meaningless to it, so the staged text carries the
excerpt and the answer, quoted, and is sent as a plain `user.message`. A promoted
aside is an ordinary turn and the log should say so rather than inventing a
category.

Only what is promoted crosses. The aside's other turns, its false starts, the
question that turned out not to matter — those stay in the child conversation.
That asymmetry is the feature: the user decides what was worth the context.

### The promoted answer must say where it came from

The excerpt is the agent's own words and it remembers saying them. **The answer
is not.** It came from a fork the main session has no memory of, so pasting it
unlabelled hands the agent an explanation in its own voice that, as far as its
context is concerned, it never gave. The good outcome is "I don't recall saying
that". The likely one is quiet confusion about what it is supposed to have
concluded — and an agent acting confidently on a conclusion it cannot place is
the failure mode worth spending a sentence to avoid.

So the prefill labels the answer as reported rather than remembered: this came
from an aside on this passage, held outside this conversation. The precedent is
`catchup.ts`, which prefixes its block with `[Chorus]` and explains what the
reader is looking at instead of silently splicing another agent's words into the
turn. The same reasoning applies with more force here, because the words are the
agent's own and that is exactly what makes them misleading.

This is labelling, not machinery — it costs a line of prefill and no code
anywhere else.

**Dismissing is not deleting.** The card feels ephemeral; the exchange stays
recorded, reachable from a small badge on the source response. The test in
`CLAUDE.md` decides this: reading back _"why did we do X — because I asked and
was told"_ a week later is worth having, so it is history, and history is logged.

### When Ask is not offered

**Quote in message** stays available for any non-empty transcript selection.
**Ask about this** is offered only when the range lies inside one completed agent
message. Not for user, system, tool, command or reasoning rows; not for a range
crossing messages; not for a response still streaming; not above an explicit
excerpt size limit. Those have no single stable source response or author, and
guessing is worse than leaving the quote path. The excerpt is never silently
truncated — it is complete or refused.

**The streaming exclusion is a provider constraint, not a UI nicety.** Phase 0
found that a Claude fork taken mid-turn sees the session only as far as the last
_completed_ turn: asked about the reply that was streaming as it forked, it
answered that no such reply existed. A completed source message is therefore the
only kind a fork is guaranteed to see. Codex's types say the same from the other
direction, of `lastTurnId` — _"The referenced turn cannot be in progress."_ This
also closes off any later idea of asking about a reply as it arrives.

## The isolation boundary, stated honestly

Draft 2 claimed an aside "reads everything and writes nothing". The second half
was an aspiration, not a property. `settingSources` is deliberately omitted so
agents inherit the user's full config, which means a fork loads their hooks, MCP
servers and skills — and a hook is arbitrary code that can have side effects
before any permission rule is consulted.

So the boundary is: **an aside inherits the parent's full context and is
constrained to explanation.** Concretely, the aside session must

- run under the read-only profile regardless of the parent's, and
- **auto-deny every approval it raises** rather than surfacing a card, and
- **auto-dismiss structured questions** rather than blocking, and
- say so in the card when it does, offering exit 3 instead.

Auto-denial is the part draft 2 missed and the part that stops a wedge. It is
also why the card cannot raise an approval: a question card that can raise an
approval card is a modal dialog wearing a tooltip's clothes.

### Decided: a fork inherits the user's configuration

`ForkOpts.inherits` is `'config'`. The alternative, `settingSources: []`, would
plausibly halve the 4–8 second wait by never starting the user's MCP servers, but
it also drops `CLAUDE.md` (`sdk.d.ts:1908`) — and an aside explaining a subtle
choice is exactly where the project's own conventions matter.

The decisive argument was not latency but consent: _"when I give you a permission
I want to keep it on the side chat."_ A fork that silently forgot what the user
had already allowed would be a different agent wearing the same name.

The `'nothing'` path stays implemented and tested rather than deleted, because
open question 1 may force a return to it — it is the measured escape hatch if a
4–8 second aside turns out to be unusable.

### Undecided, and opened by that same argument: which permissions

"Permission" names two different things here, and only one of them is settled by
the paragraph above.

- **The CLI's own** — `settings.json` allow and deny rules, hooks, MCP servers.
  These ride on `settingSources`, so `inherits: 'config'` already carries them.
- **Chorus's own** — `SessionGrants`, built per conversation
  (`runtime.ts:327`) and holding what the user clicked "always" on. A fork gets
  these only if the aside's service is handed the parent's grants object.

The plan as written gives an aside the read-only profile and auto-denies
everything, which for the second category means an aside **forgets** grants the
user has already given. That is the opposite of what was asked for.

The shape that satisfies both, and the recommendation:

- inherit the parent's grants, so nothing already permitted is asked again;
- still auto-deny anything needing a **new** decision, so the card never blocks
  and never has to host an approval;
- but refuse **mutations** regardless of grant — no edits, no state-changing
  commands — because "I asked what a sentence meant and it changed my repo" is a
  worse surprise than "it asked me again".

That last bullet is the one genuinely in tension with the request, and it is
deliberately not resolved here. It belongs to Phase 3, where the aside's service
is actually wired, and it should be decided in daylight rather than inherited
from whichever default was easier to implement.

What remains genuinely outside Chorus's control is inherited hooks — and
`inherits: 'config'` keeps them, so the residual risk is now a chosen one rather
than an unexamined one.

## Non-modal, and this needs saying

Every overlay here is a modal sheet — `ReviewPanel`, `SummaryPanel`,
`HandoffComposer`, `HistoryPanel`, `Settings`, `LogViewer` — all rendering
`.sheet-backdrop` at `z-index: 80` over the whole window, all using `useDialog`,
which focuses the first control and traps Tab. Reaching for that by reflex would
give a full-window modal for a footnote. The card follows the only non-modal
overlay that exists, `.quote-offer`: absolutely positioned inside the pane at
`z-index: 4`, anchored by `anchorFor`.

## The aside lifecycle

An ephemeral fork cannot be resumed once its process is released, which sits
awkwardly beside a durable, reopenable transcript. The resolution, chosen from
codex's four options:

- **Follow-ups while the fork is alive.** Ordinary turns on the child
  conversation.
- **A reopened aside is view-only.** Its transcript is durable and readable
  forever; its session is not.
- **"Ask again" starts a fresh aside** from the same passage, which re-forks
  from the parent as it stands now.

This is honest about what a fork is, and it avoids the alternative of keeping
provider forks alive indefinitely, which would turn a footnote into a resource
leak. The cost is that a reopened aside cannot be continued in place, and the
card must say so plainly rather than presenting a dead input.

## Phases

### Phase 0 — The spike ✅ done

Ran against `claude` 2.1.226 and `codex-cli` 0.146.0, driving the SDK and the raw
`codex app-server` directly rather than through our adapters. Full findings in
`STATUS.md`. The three answers:

1. **Forking mid-turn is safe on both providers.** Neither errors, neither parent
   turn was disturbed. The "hide Ask while busy" fallback is dropped.
2. **Token cost is a rounding error** — prompt caching left 2 uncached input
   tokens against ~26k of context — but **time to first token is 4–8.5 seconds**.
3. **Roughly half that wait is configuration loading**: 151 tools, 51 slash
   commands and 5 MCP servers, for a question that can use none of them.

And one finding nobody asked for: **a Claude mid-turn fork cannot see the
in-flight turn.** It inherits the session as persisted, so it sees history up to
the last _completed_ turn. That is survivable only because this plan already
refuses to offer Ask on a streaming response.

### Phase 1 — Honest naming, and a selection that knows its source ✅ done

**Shipped without the two-action toolbar**, which moved to Phase 4 so that the
Ask button arrives with something to open. See `STATUS.md` for why, and for the
`anchorFor` width correction that came with the longer label.

Rename `conversation.askAboutThis` to **Quote in message** with `withQuote`,
composer focus and draft behaviour untouched. Expose the source entry's event id,
actor, kind and status to the selection reader. Extract a pure classifier
separating quoteable text from a valid ask source. Replace the single button with
a two-action toolbar; unsafe sources render only the quote action.

`anchorFor` defaults to `{ width: 96, ... }` and `quote.test.ts` asserts centring
and clamping against it, so a two-action toolbar moves that number and its tests
move with it.

This phase is independently shippable and does not depend on Phase 0.

Tests: draft preservation, multiline quoting, one complete response, streaming
and user and system rows, cross-entry ranges.

### Phase 2 — Fork on the port

Add `fork(sessionRef, opts)` to `AgentAdapter` and flip `CLAUDE_CAPABILITIES` and
`CODEX_CAPABILITIES` to describe it honestly — the Claude comment
(`claude-adapter.ts:62–79`) says each flag _"flips back to true in the phase that
gives it an implementation, not before"_, and this is that phase. Codex currently
declares `fork: true` while issuing `thread/fork` nowhere, which is the "wish,
not a promise" that same comment warns against; this phase makes the flag true.

Claude: `resume` + `forkSession: true` + `persistSession: false`. Codex:
`thread/fork` + `ephemeral: true`. `SessionOpts` gains what both need; today it
is only `{cwd, model?, sandbox}` (`adapter.ts:107`).

**Suppress inherited tooling in a fork, and measure the result.** Phase 0 found
roughly half of a fork's 4–8 second time-to-first-token is spent loading 151
tools, 51 slash commands and 5 MCP servers that an explanation-only aside cannot
use. Suppressing them buys latency and safety at once: a hook that never loads
cannot have a side effect, which turns "explanation only" from a policy into a
property and closes the one hole the isolation section admits to.

This was an open question before the spike. It is work now, and it is the highest
-value work in this phase — but it is measured rather than assumed, and if the
saving does not materialise the suppression still stands on the safety argument
alone.

Tests: fork isolation on both adapters — the parent's `sessionRef`, context and
transcript unchanged after a fork answers and dies. A recorded before/after on
time-to-first-token with tooling suppressed, written into `STATUS.md`.

### Phase 3 — Hidden child conversations

The store's **first ever schema migration.** `MIGRATIONS` currently holds only
`version: 1`, so the upgrade path itself has never run in anger; that is a risk
worth naming, and the migration test matters more here than the feature does.

`conversations` gains nullable `kind`, `parent_id` and `source_event_id`. Old
rows and old `conversation.created` events rebuild as ordinary conversations.
`listConversations` returns only ordinary ones; a focused query returns asides
for one parent and source event. Open-session restore skips asides.

Runtime lifecycle for an aside: fork the parent's session, attach an ordinary
`ConversationService` under the child id, force the read-only profile, and wire
approval auto-denial and question auto-dismissal. An aside must not mutate the
parent's `lastAddressed`, `seenSeq`, draft, busy state, `open-sessions.json`, or
context-usage push.

Validated IPC for open/ask/close/list/history. **Main re-resolves the source
event from the store and verifies actor, completed status and exact excerpt
rather than trusting anything the renderer sent.**

Tests: migration and rebuild determinism, list filtering, source validation,
author routing, read-only enforcement, approval auto-denial not wedging, parent
untouched under concurrent work, partial output durable across a crash.

### Phase 4 — The card, promotion, verification

A focused component and a pure reducer over the child conversation's events.
Anchored, non-modal, Escape restores prior focus. Streams the answer; supports
follow-ups while the fork lives, and says plainly when a reopened aside is
view-only. Carries its open aside id across the active-tab unmount path via
`SessionCarry`. Loading, empty, unavailable-agent, failed, interrupted, retry,
view-only and completed states, all translated.

The badge on the source response and reopen from the log. Exits 2 and 3 staging
into the composer, with exit 3 carrying the `@author` mention.

Electron coverage proving the parent transcript, draft, attachments, routing,
busy state and provider turn are unchanged by an aside — and that a promotion is
an ordinary, correctly-routed turn.

Then `pnpm check`, the focused e2e spec, and a live pass through idle, asking,
streaming, completed, failed, reopened, view-only and promoted.

Record each shipped phase in this folder's `STATUS.md`.

## What this deliberately does not do

- It does not hide ordinary parent messages and call them asides.
- It does not let an aside reach catch-up or the other agent's memory.
- It does not let an aside raise an approval card or a question card. Both are
  auto-decided, and the card says so.
- It does not add a targeted send path to the runtime. Promotion stages an
  `@author` mention into the composer and lets the existing routing work.
- It does not keep provider forks alive to make reopened asides continuable.
- It does not silently truncate the selection.
- It does not branch selections spanning several entries.
- It does not fork at an **older** reply. `mapping.ts:510` stores
  `itemRef: msg.message?.id ?? msg.uuid ?? ''`, so the `uuid` that
  `resumeSessionAt` needs is discarded whenever an API message id exists. Every
  aside forks at the parent's current head.
- It does not add an agent picker. The aside goes to the author of the passage.

## Open questions

_Closed by Phase 0:_ whether an aside should use a cheaper model — it should not,
because prompt caching already left 2 uncached input tokens against ~26k of
context, so there is nothing to save. And whether inherited hooks should be
suppressed — they should, which made it Phase 2 work rather than a question.

1. **Whether a 4–8 second answer can feel like an aside at all.** This is the
   real risk the spike exposed and it is a design question, not a technical one.
   The card opens instantly with the excerpt and a pending state, and can be
   dismissed while the answer is still in flight — but if suppressing tooling in
   Phase 2 does not bring the wait down, the honest options are to make the card
   quieter and more patient, or to admit the interaction is a small panel rather
   than a tooltip and name it accordingly.
2. **What a multi-turn aside promotes.** The prefill is specified as "the excerpt
   and the answer", which is right for the one-question case the feature is named
   for. Ask three follow-ups and the useful conclusion is spread across them, and
   that spec quietly picks one. The options are the whole aside transcript
   (faithful, verbose, and it re-imports the context the aside existed to keep
   out), the last answer only (clean, and lossy in exactly the case where the
   user worked hardest), or a choice at promotion time. The lean is the last
   answer plus the excerpt, because the staged text is editable before it is sent
   and a user who needs more can paste more — but that is a lean, not a decision,
   and it should be made against a real multi-turn aside rather than in advance.
3. **How long a dismissed aside stays reachable.** The badge is durable now; if
   asides turn out to be numerous and disposable, "forever" may be the wrong
   answer and a retention rule is a schema decision better made at migration time
   than after it.
4. **Whether asides should count toward the session summary and spend.** They
   are real tokens against the user's account, so leaving them out understates
   cost — but folding them into `summariseSession` would make an aside look like
   work done in the room.
