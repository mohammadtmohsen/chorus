# Say that it is working

Asked for as: _"always show below any response, in the middle, the working… — or
take the words from Claude, because we still have silent periods when a new
command appears in chat but no working indicator at all. Always add a line
indicating busy for any response until the last one. Also notice the Send button
becomes ready while the response is still coming. Fix all."_

Two screenshots came with it. In both, a long run of command rows scrolls past, a
`System · Allowed automatically` row lands, a fresh `Claude` header opens more
commands — and nothing anywhere says an agent is working. In both, the Send
button is the blue idle arrow while the turn is plainly still running. The second
shot is the tell: it is full of collapsed `Show thinking` rows.

## Three defects, not one

They present as one symptom and they are not the same bug. Only the first is
certain; the second is a strong hypothesis that has to be measured before it is
fixed; the third is a design gap.

### 1. A reasoning row suppresses the indicator for the rest of the session

`Session.tsx:455` builds the set of agents whose words are already on screen:

```ts
const streaming = new Set(view.messages.filter((m) => m.status === 'streaming').map((m) => m.actor))
```

and `Session.tsx:1228` drops those agents from the thinking rows — right, on its
own terms: an agent whose reply is arriving says more than a label would.

But it filters **every kind of row**, and a reasoning row is
`status: 'streaming'` **forever**. There is no `agent.reasoning.completed` event
anywhere in the protocol, and `transcript.test.ts:1091` pins that deliberately —
_"leaves a run of reasoning streaming forever, which is what the dot must not
follow"_. `Entry.tsx:571` already knows this and guards by passing `streaming`
only for `kind === 'message'`. `Session.tsx` does not.

**So the first `thinking_delta` Claude emits kills the working indicator for the
rest of the session, whatever `busy` says.** That is exactly the second
screenshot: `Show thinking`, then silence. This is a one-line fix and it is the
one that removes the reported symptom.

### 2. `busy` is probably false for every turn after the first

`view.busy` is derived — `transcript.ts:258`, `next.busy = next.working.length > 0`
— and `working` moves on exactly two events: `turn.started` adds the actor,
`turn.completed` removes it. Nothing else touches it, so inside a matched pair
`busy` is correctly true across tool calls, approvals, notices and subagent
steps. The reducer is not where this goes wrong.

**The pairing is the suspect.** Codex sends a real per-turn `turn/started`
(`adapter-codex/src/mapping.ts:68`). Claude has no such message, so the adapter
synthesises one from the SDK's `system` init frame — `adapter-claude/src/mapping.ts:265`:

```ts
if (subtype === 'init') {
  return [{ ...base, type: 'turn.started', turnRef: msg.uuid ?? msg.session_id ?? '' }]
}
```

while `turn.completed` comes from `result`, which fires per turn
(`mapping.ts:1078`). The adapter runs the SDK in **streaming-input mode with one
long-lived `query()`** (`claude-adapter.ts:657`), and an init frame belongs to the
query rather than to a turn. If it arrives once, then turn 2 gets a
`turn.completed` with no `turn.started`: `working` is already empty, `busy` is
false, and both symptoms follow at once — no thinking row **and** a Send button
that reads as idle.

Main is already carrying a scar from this. `runtime.ts:1939` `stillAnswering`
counts a **signed balance** rather than a set, and goes negative under exactly
this asymmetry.

**This must be measured before it is fixed**, because the two repairs are
different: if init really is once-per-query, `turn.started` has to be raised from
something that happens per turn; if it is per-turn and the pairing is fine, then
symptom (b) has another cause and this section is wrong. The adapter's mapping is
pure and takes recorded SDK messages, so the measurement is a recorded session,
not a guess. **Read the shapes out of `sdk.d.ts`; three bugs in M2 came from
inferred payloads.**

### 3. The indicator is in the wrong place, and says nothing during a silence

Even when it renders, the thinking row lives inside `.turn-head`
(`Session.tsx:1383`) — the sticky block pinned to the **top** of the scroller,
under the question. The reader is at the bottom watching commands arrive. The ask
is a line **under the newest output**, and no code path puts anything there:
`.turn-tail` is a zero-height `aria-hidden` spacer that exists to hold room open.

## Where Claude's own words are, and why they are not in the log

The request says _"take the words from Claude"_. The words the UI shows today are
Chorus's — `thinkingWords` in `i18n/en.json:73`, eight invented verbs rotated
every 2.6 seconds by `thinking-word.ts` on a timer that starts at **mount**, so
it is a clock rather than a report. It cannot say "compacting" because it does not
know.

Claude does send that, and the adapter throws it away on purpose
(`mapping.ts:213`, `QUIET_SUBTYPES`):

| SDK message                    | Carries                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `system/session_state_changed` | `'idle' \| 'running' \| 'requires_action'` — the SDK's own docs call it the authoritative turn-over signal |
| `system/status`                | `'compacting' \| 'requesting' \| null`                                                                     |
| `system/thinking_tokens`       | approximate progress, "for spinners/pills"                                                                 |
| `tool_progress`                | `elapsed_time_seconds`, heartbeat                                                                          |

The stated reason for dropping them is right and stays right: _"`status` is the
spinner's heartbeat — left in, it would append to SQLite for as long as a turn
runs."_

**But that is an argument against the log, not against the signal**, and this
project already has the shape for it. `CLAUDE.md`'s _State is not history_ rule
covers `limits` and `context.usage`: they travel on their own push channels
(`agents:limits`, `agents:context`), are held in memory, and are never
`ChorusEventPayload`s. Apply the test — would reading back a week later that an
agent was "requesting" at 09:23 be worse than having nothing? It would be
meaningless. **So activity is state: a third push channel, no event type, no
projection, nothing durable.** That also answers the silence, because a heartbeat
arrives during a stretch where no log event does.

## Shape

Four phases, ordered so the visible bug goes first and the durable work follows.

**Phase 1 — the suppression.** `Session.tsx`'s `streaming` set filters on
`kind === 'message'`, as `Entry.tsx` already does. A reducer-level test that a
reasoning row does not suppress a thinking row; the existing
`transcript.test.ts:1091` stays exactly as it is, because the permanently
streaming reasoning row is not the thing being changed.

**Phase 2 — make `busy` honest.** Measure the init/result pairing against a
recorded session. Fix the pairing at its source rather than papering over it in
the reducer, and add the reducer tests nothing has: `busy` true across
`agent.message.completed`, across an approval, across a system notice, across a
subagent step; two agents independent; an unmatched `turn.completed` harmless.
`store.ts`'s `reducePulse` folds the same two events and gets the same tests —
the sidebar's working mark has been lying in the same way.

**Phase 3 — the line under the newest output.** A busy row rendered after the
last entry while `busy`, in addition to the pinned one under the question, and
carrying the elapsed time so a long silence reads as progress rather than as a
hang. `e2e/specs.mjs:2190` asserts exactly one `.turn-head` and that every
thinking row sits below the question — a tail row must not break that reading, so
it is a different class, not a second `.turn-head` tenant.

**Phase 4 — Claude's words.** An `agents:activity` push carrying
`{conversationId, agentId, state, status, elapsedMs}` out of the subtypes
`QUIET_SUBTYPES` currently drops, held in memory in main, merged into the busy
line: what Claude says it is doing when it says anything, the rotating word when
it does not. `session_state_changed` is also the authoritative end-of-turn
signal, so it doubles as a cross-check on Phase 2 rather than a replacement for
it — the log still records turn boundaries, because those genuinely are history.

## The Send button — needs a decision

The button is not missing a disabled state. `Composer.tsx:1625` has two branches:
`busy && !hasDraft` renders **Stop** (`.send--stop`), and anything else renders a
submit button labelled `Send` when idle and `conversation.steer` — _"Send — the
agent keeps working and takes this in"_ — when busy. Sending mid-turn steers by
design, and `e2e/specs.mjs:2526` pins it: _"a message sent mid-turn steers the
agent rather than stopping it"_.

So with `busy` false, both branches degrade at once: no Stop, and the steer
label reverts to "Send". **Phase 2 fixes most of what was reported here for
free.**

What is left is a genuine question. When busy with a draft typed, the button is
an ordinary enabled arrow that is indistinguishable from idle Send. Three
answers, and the choice is the user's:

- **leave it enabled but make it look like steering** — the arrow gets the busy
  treatment so it never reads as "the turn is over";
- **disable it while busy** — safest to look at, and it removes steering, which
  is a feature this app deliberately has and tests;
- **keep it exactly as it is** — Phase 2 restores the correct label and the Stop
  button, and nothing else was ever wrong.

## What this does not do

- It does not write a heartbeat to the event log. The log records the
  conversation; a spinner is not part of it, and the volume argument in
  `QUIET_SUBTYPES` stands.
- It does not replace the rotating word. Claude speaks in bursts and says
  nothing for most of a long turn; a line that went blank between bursts would be
  the silence being reported here.
- It does not touch steering, unless the decision above says to.

## Verification

Every claim here except Defect 1 is read rather than run. Defect 1 is provable in
a unit test. **Defect 2 is not confirmed** and Phase 2 begins by confirming or
killing it against a recorded session — if init turns out to be per-turn, that
phase is rewritten rather than implemented.

Then the app, on the case in the screenshots: a turn long enough to emit
thinking, tool calls and an auto-approval, watched from the bottom of the
transcript. The failure mode to look for is the opposite one — a busy line that
outlives its turn — which is what an unbalanced pair produces in the other
direction.
