# Status

**All four phases and the composer are done and driven, 2026-08-17.** `pnpm
check` green: 1885 tests. **The app was driven against a live Claude** —
`node apps/desktop/e2e/verify-working-line.mjs`, 11/11 — so what follows is
observed rather than reasoned.

What was seen, on a real two-turn session:

- the working line drawn for the whole turn and **at the foot of it**, under the
  newest row;
- Stop offered in the composer throughout, on turn one **and turn two**, which is
  the pairing bug;
- the line reading `asking the model` — Claude's own `requesting` status, off the
  new channel — and falling back to `weighing it up` when the agent says nothing;
- the log holding exactly `turn.started, turn.completed` per turn, twice;
- `Explain simply` under both finished replies, opening a card headed _Explaining
  in Arabic_ with no copy of the reply inside it.

## Two false failures, both mine, both worth recording

**A stale bundle.** `launch` runs `out/`, not `src/`, and the driver did not call
`ensureBuilt()`. The first run reported the _old_ layout — thinking row above the
output — as a failure of the new one. That is C-014 exactly, and the harness
already had the guard; it just was not called.

**A probe that could not fail correctly.** "The turn is over" was written as _no
Stop button and some `.entry--claude .said`_ — and the **waiting row satisfies
both**: it is `.entry--claude.entry--thinking` and its line is a `.said`. So the
loop broke on its first pass and reported a missing Stop button that appeared two
seconds later. Suspect the driver before the code: it now asks for a finished
message row and refuses to call a turn finished before Stop has been seen at all.

## Phase 2's hypothesis was right, and `sdk.d.ts` is what settled it

The plan said the init/result asymmetry had to be measured before it was fixed.
It was, by reading the type rather than by guessing at frame ordering, and
`SDKSystemMessage` is unambiguous: `subtype: 'init'` carries `cwd`, `model`,
`tools`, `mcp_servers`, `slash_commands`, `skills`, `plugins`,
`claude_code_version`, `permissionMode`. **That is a session, not a turn.** With
one long-lived `query()` it arrives once, while `result` closes every turn — so
one `turn.started` covered a whole session's worth of completions and every
consumer that folds the pair believed the agent went idle after the first reply.

Fixed at the source: `ClaudeSession.send` raises `turn.started` when no turn is
open, `result` clears the flag, and `mapping.ts`'s init arm returns `[]`. Codex
was never affected — it sends a real `turn/started` per turn.

Two tests in `mapping.test.ts` asserted the old reading and now assert the
opposite, with the reason written down. `turn-boundaries.test.ts` is new and is
about the pairing, which nothing tested before.

## What the tests caught that reading did not

`turnOpen` is cleared by the **pump**, not by the send. A second message pushed
in the same tick as an unread `result` therefore folds into a turn still recorded
as open. It fails safe — one start, one completion, no stuck working line — and
it is the steering case arrived at by racing rather than by intent. Written down
in the test rather than smoothed over, because the opposite failure (a busy line
that outlives its turn) is the one worth watching for.

## Phase 1, and why it was the whole reported symptom

`Session.tsx` filtered **every** row for `status === 'streaming'` to decide who
was already writing, and a reasoning row streams forever — no event completes
one, and a test pins that. So the first `Show thinking` in a session put that
agent in the set permanently and the working line was never drawn again.
`Entry.tsx` already guarded the avatar pulse with `kind === 'message'`; this was
the missing copy.

## Phase 3

The thinking rows moved out of `.turn-head` — which is pinned to the top of the
scroller — to the foot of the turn, under the newest output, where the reader
actually is. `specs.mjs` looked for `.turn-head .entry--thinking` and now looks
inside `.turn`; the geometry assertions it makes (below the question, one head,
nobody both writes and waits) are unchanged and still meaningful.

## The composer

Steering stays: sending mid-turn hands the message to a working agent, which is
deliberate and pinned by e2e. What changed is that it no longer _looks_ like the
idle button — `data-steering` outlines it while a turn runs, so a filled send
button means idle-and-ready and nothing else. Most of what was reported here was
Phase 2 anyway: with `busy` false there was no Stop button and the label read
"Send".

## Phase 4 — the agent's own words, on a channel of their own

Done the same day, asked for as _"add all status coming from agent"_.

`activity.changed` is the **fourth member of the state family**, beside
`LimitsUpdated`, `ContextUsage` and `TasksChanged`, and it is the sharpest case
of the rule that made the family: `status` ticks for as long as a turn runs, so
written down it would append to SQLite for the length of every turn, and
_"claude was requesting at 09:23"_ read back a week later is worse than nothing.
It travels on `agents:activity`, is held in memory, and has no
`ChorusEventPayload`, no projection and no catch-up arm.

What the provider says, and what it becomes:

| SDK                                      | Activity        |
| ---------------------------------------- | --------------- |
| `status: 'requesting'`                   | `requesting`    |
| `status: 'compacting'`                   | `compacting`    |
| `status: null`                           | cleared         |
| `thinking_tokens`                        | `thinking`      |
| `session_state_changed: requires_action` | `awaitingInput` |

**`running` and `idle` are deliberately not read.** They are turn boundaries,
and those belong in the log where they can be replayed — a second opinion
arriving on a channel nothing persists is exactly how the two would drift apart.
Phase 2 is what makes the boundaries trustworthy; this only refines what an
already-visible line says.

`null` is forwarded rather than swallowed, all the way through the service, the
runtime and the store. It is the only thing that says a compaction finished, and
a falsy guard anywhere on that path would leave the line saying _compacting its
context_ for the rest of the turn. The rotating word takes over when it clears,
because an agent says nothing for most of a turn.

Deduplicated in the store: a thinking tick can arrive several times a second, and
an unguarded write would re-render every mounted pane on each one. `Session`
subscribes through a narrow hook returning a **string** rather than the record,
so a push that changes nothing compares equal.

## Still to do

- **`compacting` has not been seen.** It needs a context long enough to compact,
  which no short verification run reaches. `requesting` and the fallback word are
  both observed; the other two arms are read but unwatched.
- `awaitingInput` likewise: it needs a turn that stops for a permission the
  profile will not decide.
- The e2e suite has not been run since the working line moved. `specs.mjs` was
  updated from `.turn-head .entry--thinking` to `.turn .entry--thinking` and that
  edit is unverified — the suite is macOS-only and takes ~5 minutes (C-029).
