# The question deadline ignores the person it is waiting for

`C-013`. A question set the agent raises carries a five-minute wall-clock
deadline. The clock starts when the **agent asked**, nothing restarts it, and
answering is not an input to it. The card can be on screen, focused and
half-filled, and it still goes.

## What the log actually says

The board entry said this was hit twice and admitted the cause was inference —
`userinput.answered` carries a `cancel` outcome too, so the two instances might
have been dismissals. That inference is now settled by reading the real log
(`VACUUM INTO` snapshot of `chorus.db`, 2026-08-10):

|                      |              |
| -------------------- | ------------ |
| Question sets raised | **25**       |
| Answered             | 15           |
| **Timed out**        | **10 — 40%** |
| Cancelled            | **0**        |

Every one of the ten died at **exactly 300.0 seconds**. That is the TTL firing,
not a person dismissing: the entry's inference was correct, and it was
undercounted by a factor of five.

Three things the log says that the entry did not know:

**It is not rare and it is not over.** The ten span 2026-08-05 to 2026-08-10 —
the most recent was this morning, 07:28.

**The deadline is close to real answering times.** Successful answers took 17s to
**255s**. The slowest answer that made it came within **45 seconds** of dying. The
margin is not comfortable; a five-minute deadline is roughly the length of a
careful answer, which is why it keeps losing.

**It is worst exactly where the entry predicted.** Loss rate rises with the size
of the question:

| Questions in the set | Answered | Timed out | Lost     |
| -------------------- | -------- | --------- | -------- |
| 1                    | 9        | 2         | 18%      |
| 2                    | 6        | 7         | **54%**  |
| 3                    | 0        | 1         | **100%** |

Timed-out sets carried an average of 1,602 characters of question and option text
against 1,310 for answered ones. **A multi-part question is more likely to be lost
than answered.** Those are the questions most worth asking, and they are the ones
this reliably destroys.

## The mechanism, confirmed in code

The deadline is **entirely Chorus's own**. No provider imposes it:

- stamped in `adapter-claude/src/mapping.ts:1011` as `ctx.now + ctx.approvalTtlMs`
- defaulting to five minutes in `claude-adapter.ts:805`
- armed in `conversation-service.ts:622` with a **one-shot `setTimeout` per
  request**, held in `pendingUserInput` alongside the request

**Correction to an earlier draft of this plan**, which said questions are swept by
`policy/queue.ts:84`. They are not. `ApprovalQueue` is typed to `ApprovalRequest`
and the only `queue.add` is the approval path at `conversation-service.ts:596`;
questions never enter it. The distinction matters for Phase 2: the approval queue
owns a re-armable sweep over a collection, while a question's deadline is a single
timer captured when the request arrived and never touched again. There is no
existing "change this deadline" operation to extend — one has to be built.

So we may change the number freely. Nothing outside Chorus is counting **for
Claude**; whether that holds for Codex is an open question below, not an
assumption.

Two discoveries while reading:

**The data the UI needs is already there and unused.** `expiresAt` travels in
`userinput.requested` and is already reduced onto `PendingQuestion`
(`transcript.ts:94`, `:333`) — and **no component reads it**. There is no
countdown anywhere for questions or approvals. The first sign a deadline existed
is the card's absence.

**Codex's deadline fields are a mess, and an earlier draft of this plan believed
them.** That draft asserted `autoResolutionMs` is a provider-enforced cutoff we
must honour "whichever comes first". The generated protocol says otherwise:

```ts
questions: Array<ToolRequestUserInputQuestion>, isBlocking: boolean,
/** @deprecated Use `isBlocking` to decide whether the request should block. */
autoResolutionMs: number | null,
```

So the field this plan proposed to build a rule on is **deprecated**, and its
replacement answers a different question — `isBlocking` is about _whether the
request blocks the turn at all_, not _when the provider stops listening_. Those
are not interchangeable, and a deadline rule derived from the wrong one would be
confidently wrong.

Meanwhile `adapter-codex/src/mapping.ts:381`–`387` reads only the deprecated
field and **ignores `isBlocking` entirely**, and nothing anywhere consumes the
`autoResolvesAt` it produces. The protocol's own comment asserts a rule
("whichever comes first wins, and the answer we send after that point is ignored
by the provider") that no code implements and that no run has ever verified.

None of this has ever fired: Codex has asked **0 of the 25** question sets in this
log. So the whole area is unobserved, not merely unimplemented — which is exactly
the condition under which this project has previously shipped inferred payloads
and paid for them.

## The bug nobody filed

A half-filled answer is destroyed by **switching panes**, with no timeout
involved. `picked`, `typed` and `step` are local `useState` inside `QuestionCard`
(`Session.tsx:1242`–`1245`), and only the active tab of each pane is mounted
(`Workspace.tsx:494`). Leave the tab and the draft is gone; the pending set is
re-derived from the log on return, but what you typed is not.

This matters because it is the same injury from a second direction, and because
the entry's scenario — "typing into it in another pane" — means the user was
moving between panes, which is exactly the motion that also discards the draft.

## The shape of the answer

The clock measures the wrong thing. It measures time since the agent asked; it
should measure time since **a person was last plausibly engaged** — and where
there is no person, it must still fire.

Three changes, in increasing order of risk. Each is worth shipping alone, which is
why they are separate phases rather than one.

**Only Phase 1 is ready to build.** Phases 2 and 3 each carry contracts that are
not yet settled — two live probes and a state-path decision for Phase 2, an
identity and secret-lifecycle rule for Phase 3 — and they are written below as
requirements rather than as work that can start.

### Phase 1 — Say that a deadline exists

A card in its last stretch shows how long is left. Not a permanent ticking clock:
five minutes of counting on a seventeen-second answer is pressure and noise. It
appears only when the time remaining is short enough to matter, and it is worded
as an approximation.

Cheapest change here and the highest value per unit of risk: the field is already
reduced, nothing about the deadline moves, and it alone would have saved several
of the ten. Applies to approvals too, which share the stamp.

### Phase 2 — Let engagement hold the deadline off

**Blocked until the two probes in the open questions below have run.** Not
schedulable yet, and deliberately not estimated.

Interaction with the card extends the deadline. **Mere presence does not** — a
mounted card behind a closed laptop is the wedge the TTL exists to prevent, and
"the component is rendered" is not evidence of a person. The extension is capped
in total, so an abandoned half-filled card still resolves.

Three contracts have to be settled before any of this is written.

**Focus is not evidence, and an earlier draft of this plan said it was.** The card
focuses its own first control whenever it mounts or becomes active
(`Session.tsx:1252`–`1255`). So a focus event is generated _by the app_, and a
rule reading "a keystroke, a selection, a focus" extends the deadline the instant
the card appears with no person involved — the rule violating its own principle
on the first tick. What counts must be a gesture the app cannot manufacture: an
option chosen, text typed, a step navigated. If focus is used at all it has to be
distinguishable from the programmatic kind, which is more machinery than the
signal is worth.

**Extending needs a race-safe operation that does not exist.** The timer is a
single `setTimeout` captured per request. Extending means recording a new
effective expiry, cancelling and re-arming, and — because a callback already
queued cannot be un-queued — having the timeout re-check the current deadline
before it resolves rather than trusting that it was cancelled. Without that last
part an extension arriving in the same tick as the expiry loses the race
silently, which is this bug again with extra steps.

**The renderer must learn the new deadline, including after a remount.** Today
the countdown's input comes from replaying the original `userinput.requested`
(`transcript.ts:326`, `:333`); after one extension that value is stale, and
switching panes and back would show a deadline that already passed. Two routes,
and the plan must pick one:

- a **logged extension event**, which makes the deadline replayable but writes a
  history of a number that only ever mattered live; or
- a **push/query channel**, holding effective expiry in the main process the way
  `limits` and `context.usage` are held.

`CLAUDE.md`'s test decides it: _would reading this value back a week later be
worse than having none?_ A week-old deadline extension is noise. That points at
the push channel — with the requirement that a remounting card can **ask** for the
current deadline rather than only receiving future pushes, or it comes back
showing the stale one.

### Decided: one call, and it is not a push

Neither a logged event nor a push channel. Both are heavier than the problem.

Looking at what exists: there is no pending-state channel from main at all —
`questionIds` is derived in the renderer's _own_ store from the event stream
(`store.ts:162`). Building one for this would be new machinery for a number only
one card ever reads.

And the extension is **caused by the very card that needs to know about it**. So
a single request answers both halves:

```
userinput:extend { userInputId, engaged } -> { expiresAt }
```

- `engaged: true` — a real gesture happened; main pushes the deadline out, within
  the cap, and returns the new one.
- `engaged: false` — read it, change nothing. This is what a **remounting** card
  sends, so it comes back with the current deadline instead of replaying the
  stale original.

The distinction matters because mounting is not evidence of a person, and the
card mounts itself into focus. `engaged: false` is exactly the honest way for a
card to say "I am back, what is the deadline" without claiming attention it
cannot prove.

### Phase 3 — Let a half-filled answer survive unmounting

The draft rides in `SessionCarry`, the existing mechanism for exactly this
("everything a session needs to survive unmounting rides in `SessionCarry`").
Switching panes to read something is ordinary use, not abandonment.

Two contracts, both of which an earlier draft of this plan omitted.

**The draft is keyed by `userInputId`, and a mismatch is discarded rather than
shown.** `SessionCarry` lives in a long-lived map keyed by conversation
(`App.tsx:66`), while questions come and go within one conversation. Carrying
`picked`/`typed`/`step` without checking whose answer they are would hydrate a
_new_ question with an _old_ one's answers — pre-filled, plausible, and wrong, in
a card whose whole purpose is to capture the user's actual intent.

**A secret is never carried.** `typed` can hold one: the free-text input renders
as `type="password"` when `asked.isSecret` (`Session.tsx:1393`–`1399`), and the
orchestrator deliberately strips secrets from the log _before_ writing rather
than after. Putting that value into a long-lived renderer map would retain a
credential in memory past submission, past timeout, and past the conversation
being closed — quietly undoing a decision the write path already made. Secret
fields are excluded from the carry and retyped, which is how every password field
behaves and costs one field rather than the whole draft.

The rest of the draft is scrubbed on answer, cancel, timeout, or id mismatch, so
"survives a pane switch" does not become "survives forever".

## What this is deliberately not doing

**Not removing the TTL.** A question nobody ever answers would wedge the turn
forever. The timeout is the thing that stops that, and the entry is right that the
TTL is not the bug.

**Not making the deadline a setting.** A setting here is a way of not deciding,
and it pushes a number onto the user that they have no way to choose well.

**Not extending without a cap.** That is the same as removing it, arrived at
slowly.

**Not resurrecting an expired question.** Once it times out the provider has been
told nothing was chosen and has moved on; bringing the card back would collect an
answer with nowhere to go. If this turns out to matter, it is a different piece of
work — re-asking the agent, not un-expiring the card.

**Not touching approval drafts.** Approvals have no draft to lose. They get the
countdown from Phase 1 because it is free, and nothing else.

## Open questions

**1. Does Claude's SDK give up on its own?** _Blocker for Phase 2._ Nothing in
`sdk.d.ts` suggests a deadline on the question callback. But Phase 2 is only safe
if the provider still accepts an answer well past five minutes. **Measured with a
live probe, not read out of types** — hold a real question set unanswered past the
deadline and see whether a late answer is still taken.

**1b. ~~What does Codex actually enforce?~~ Cannot be measured, and that is the
answer.** Probed directly against the installed CLI with an explicit instruction
to use its request-user-input tool: **Codex finished the turn without ever
raising a question.** The protocol marks the path `EXPERIMENTAL`, and the live
log agrees — 0 of 25 question sets are Codex's.

So the semantics of `autoResolutionMs` and `isBlocking` stay unknown, and the
honest response is not to guess but to make the absence safe: **never extend past
a provider-declared deadline when one is present**, which costs nothing today
because none ever is, and is correct on the day Codex starts declaring one. What
must **not** happen is a rule built on the deprecated field's assumed meaning —
which is what an earlier draft of this plan proposed.

**2. What is the right cap?** The data bounds it from below: successful answers
ran to 255s, so any cap under about six minutes is still too tight. It does not
bound it from above. A first cut of "extend while engaged, to a hard ceiling" needs
that ceiling chosen with a reason rather than a round number.

**3. Should the base deadline change at all?** Arguably five minutes is simply
wrong given a 255s honest answer. But raising the constant treats the symptom —
the same 40% failure returns for a question that takes longer to think about.
Engagement-based extension is the fix; the constant is left alone unless Phase 2's
measurement says otherwise.

**4. Does the countdown itself need the extension machinery?** Phase 1 reads the
original `expiresAt` and is correct on its own, because nothing extends anything
yet. It stops being correct the moment Phase 2 lands. Phase 1 should therefore be
built so its input is _the effective deadline_ — one value that today happens to
come from the request — rather than reaching for `expiresAt` in a way that has to
be unpicked later.

**5. Why did the approval path barely suffer?** 4 timeouts in 4,186 approvals
against 10 in 25 questions. Almost certainly because an approval is one click and
a question set is a form — which supports the whole diagnosis, but it is worth a
glance to be sure there is no second mechanism at work.
