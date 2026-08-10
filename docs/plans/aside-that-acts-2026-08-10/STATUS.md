# Status

## Part A is done, and it was done by C-020

No work was needed here beyond the permission fix. Planning Part A found nothing
left to plan: repairing the matcher (`77bb246`) also repaired the only aside
failure this plan had evidence for.

`sed` is now on the safe-read list — it was added from log evidence during C-020,
and it is the exact command the single logged aside refusal tripped on. Checked
against the real engine under `read-only`:

```
ALLOW <- sed -n '91,140p' …/BOARD.md      ← the command that was refused
ALLOW <- cat file | head -120
ALLOW <- cat a; echo "=== b ==="; sed -n 1,40p c
ALLOW <- rg needle src | head -20
ALLOW <- git diff | head -50
ASK   <- cat a; python3 -c "print(1)"
ASK   <- cat x | xargs touch y
```

The last two become denials inside an aside, because `neverAsks` converts an
`ask`. That is the right answer: both run something arbitrary, and neither is a
read.

### Verified in the running app

An aside was opened against a real reply and asked to run
`sed -n '1,1p' …/chorus/BOARD.md`. It answered `# Board` — the file's actual
first line, which it could only have obtained by reading the file. No approval
was raised and nothing was denied. Before C-020 the same request was refused by
policy with _"An aside may explain, not act."_

**A correction from the first attempt at this check.** It asserted on
`/# Board|Board/i` against a run using a relative path, which failed with
`sed: BOARD.md: No such file or directory` — and the assertion **passed on the
filename inside the error message**. The evidence above is the re-run with an
absolute path and an assertion on content the aside could not have invented.

## What this changes about the plan

Part A's difficulty was never aside-specific, which is why it ended up filed and
shipped as C-020. What remains of C-017 is Part B, unchanged and still carrying
the three contracts the review found: promotion needs a durable `aside.promoted`
event rather than a projection flip, the existing service cannot be moved because
`neverAsks` and `grants` are readonly and the branch is non-persistent, and the
trigger must be an explicit user action because the aside prompt stops a
compliant agent from ever attempting to act.

Nothing about Part B was validated by this work. It has no code and no plan
beyond the shape argued in `plan.md`.

## Phase 0 answered: the parent fork is necessary

Design (2) — fork the parent — is kept, and Phase 1 stays. Chorus's log **cannot**
reconstruct the provider's working context, because it does not hold tool output.

The discriminator was a fact the agent read but never said. A 60-line file with
`MAUVE-7741` on line 40; the parent was told to open it with the Read tool and
report only the line count. Then, in a promoted-style room built each way: _what
is the exact text of line 40?_

|                               |                          |
| ----------------------------- | ------------------------ |
| fork the parent               | **`row040  MAUVE-7741`** |
| reconstruct from Chorus's log | **`I DO NOT KNOW.`**     |

**Why the log cannot carry it.** `tool.completed` stores a `summary`, and for a
`Read` that summary is capped at `MAX_TOOL_DETAIL = 120` characters — measured
across the live log, 196 Reads with a **maximum of 120 and an average of 41**. The
file's contents are simply not in the log to replay.

### It took three runs to make the comparison fair, and the first two were wrong

Worth recording, because each was wrong in a way that would have produced a
confident and opposite conclusion:

1. **The agent never read the file.** Asked for a line count it ran `wc -l`, so
   the contents entered no context at all and _both_ designs answered "I do not
   know". Fixed by requiring the Read tool.
2. **Design 3 was starved.** The reconstruction carried only user and assistant
   messages, so it lost — but that ignored `tool.completed.summary`, which does
   hold output. Rigged against design 3.
3. **Design 3 was over-fed.** Giving it the _full_ tool result made it win — but
   Chorus never stores the full result, so that was rigged the other way. The
   summary's real 120-character cap is what settled it.

Even then the fixture was too small: a five-line file fits inside 120 characters,
so the truncation kept the secret and both designs knew it. Only with the fact
1,013 bytes into the file did the test measure what it claimed to.

### What this does not settle

Claude only. Codex's fork was not exercised, and `ephemeral: false` remains
unverified — still Phase 1's job.

It also suggests something outside this plan: **the transcript's tool output is
lossy in a way nobody has decided on.** 120 characters is a display-oriented cap
sitting on the durable log, and it is why a conversation cannot be rebuilt from
Chorus's own record. That is worth its own entry rather than a footnote here.

## Phase 1 done: a persistent fork that knows its own name

`ForkOpts` gains `persist`, and the port's "always ephemeral, rather than a flag"
comment is replaced with the reason it is now a flag rather than deleted.

**Claude copies first and resumes the copy.** Not "omit `persistSession: false`"
on the existing path — `spawn` builds `new ClaudeSession(resume ?? '', …)`, so a
forked session reports the **parent's** id until the child announces itself. For
an aside that is harmless because nothing writes it down; for a branch that
becomes a conversation it is not, because the id is saved and a later relaunch
would resume the parent believing it was the child. The SDK's module-level
`forkSession(sessionId)` copies the transcript and returns the new id up front, so
what is handed back already knows its own name.

**Codex passes `ephemeral: !persist`.** One line, and previously unverified —
Codex had never forked in anger, and all 11 asides in the log are Claude's.

**`SupervisedSession.fork`** joins `start` and `resume`. `AgentAdapter.fork`
returns a raw session, which is right for an aside — it dies with its question —
and wrong for a room someone works in, where a provider crash should restart
rather than lose it. It refuses a session still carrying its parent's ref, since
the restart path resumes `sessionRef` and would otherwise put the user back in
the conversation they branched away from.

### Verified against both real CLIs

|                                        | claude        | codex         |
| -------------------------------------- | ------------- | ------------- |
| branch gets a distinct id              | yes           | yes           |
| told a codeword, closed, resumed by id | **remembers** | **remembers** |

That is the property a promoted room actually needs: not "a fork happened" but
"this branch can be rejoined after the process let it go". Both providers pass.

### The ephemeral contrast, which proves the flag is not decorative

A persistent branch resuming is only half the claim; the other half is that an
**ephemeral** one does not. Both providers refuse, and they refuse differently:

|        | ephemeral branch, closed then resumed by id            |
| ------ | ------------------------------------------------------ |
| claude | resumes, but carries none of the branch's conversation |
| codex  | refuses outright — `no rollout found for thread id …`  |

So `persist` changes real behaviour on both, and asides have not been quietly
leaving sessions on disk.

**A correction to my own write-up.** I first recorded this check as unfinished
and hanging, and reasoned it was probably the documented _"`thread/resume` on an
id the provider has forgotten can simply never answer"_. That was wrong: the run
had completed and its output was buffered, so silence read as a hang. The result
above is what actually happened. The inference was plausible, which is exactly
why it should not have been written down as though observed.

Claude's behaviour is still worth noting — resuming an unknown id **succeeds**
and yields an empty session rather than an error, so a lost branch would look
like a working one that has forgotten everything.

### Tests

Four on `SupervisedSession.fork`, and a conformance check —
`forkHasItsOwnRef` — which is checked against a session an adapter has really
returned, because the hazard lives in the returned object rather than in the
call. `FakeAdapter` gained `forkKeepsParentRef` to model it; nothing could reach
that path before. The guard was proved by removing it and watching the test fail.

## Phase 2 done: `aside.promoted`

The five-file change, on the `conversation.renamed` pattern: payload schema,
projection case, catch-up case, and the renderer's reduction. The runtime that
appends it is Phase 3.

**The projection clears `kind` and nothing else.** That single field does both
jobs — `listConversations` filters `kind IS NULL`, `listAsides` filters
`kind = 'aside'` — so nulling it reveals the room _and_ drops it out of its
parent's aside list. `parent_id` and `source_event_id` stay as provenance,
because where a room came from is worth keeping and nothing queries them for an
ordinary conversation.

The payload records what the conversation **was**, in the same spirit as
`conversation.renamed` carrying `previousTitle`: read back later, the log should
say where this room came from rather than merely that something changed.

**Catch-up is an explicit no-op with a reason.** Promotion changes how Chorus
files a conversation, not what was said in it, and an agent told "this used to be
an aside" could act on none of it.

**The renderer says it happened**, because the room's rules change at that line:
everything above was answered by a fork that could only look, everything below
can act under a profile someone chose. One continuous log would otherwise hide
the moment.

### Verified

Five tests, and the one that matters replays: promote an aside, rebuild
projections, and it is still an ordinary conversation — with an unpromoted
sibling still hidden, which guards the obvious way to get this wrong (clearing
`kind` for everything). Proved by deleting the projection case and watching three
of them fail.

That test is the entire justification for this being an event: `kind = 'aside'`
is re-derived from `conversation.created` on every rebuild, so a direct `UPDATE`
would be erased by the one operation the log guarantees.

### Filed while here

**C-022** — `transcript.ts` builds every system notice from an English literal,
which contradicts the stated convention that reducers carry keys and the renderer
turns them into words. `aside.promoted`'s line was written the same way rather
than inventing a second mechanism for one event, so this now has one more
instance and a reason to be fixed.

## Phase 3 done: `promoteAside`, atomically

The domain works with no UI. An aside becomes a conversation on **its own
`conversationId`**, so the log stays one thread rather than gaining a copy.

**The parent is forked, kept.** `startParticipant` gained a `forkFrom` path using
`SupervisedSession.fork(… persist: true)`, so a promoted room is supervised like
any other and reuses the existing wiring — service, pump, effort, catalogue.

**Promotion starts no turn.** The seed rides on `Participant.seedContext` and is
prepended to the _next_ real message, once. Sending it at promotion would have
produced an answer nobody asked for, possibly running tools under the profile
just chosen — "open as a conversation" behaving like "ask that again, now, with
permissions". A test asserts nothing is sent, and a second asserts the seed does
not arrive twice.

**Grants are `newGrants()`.** Fresh, not the parent's instance — but seeded with
the machine-wide remembered answers and carrying the `onRemember` callback. A
literally empty set would have silently forgotten permanent permissions and
failed to persist new ones.

### The transition, and where it commits

Ordered so one conversation can never have two live services: the ephemeral fork
is closed **first**, then the persistent one is opened. If the fork then fails,
the aside is gone — but its transcript is in the log, and losing the ability to
continue a side question is a smaller failure than two writers on one thread.

- **Single-flight** per aside, holding the _promise_ rather than a boolean, so a
  second click gets the first answer instead of a second permanent branch on
  disk. Proved by removing the guard and watching the test fail.
- **An idle precondition** — refuses while a turn is in flight, read off the log
  rather than asked of the service, since the log is the thing a second writer
  would corrupt.
- **Revalidation** at the moment of promotion: the parent still open, the agent
  still a participant, its session still started. None of it trusted from when
  the aside was opened.
- **The commit point is the `aside.promoted` append.** A failure there closes the
  branch just created rather than leaving it running with nothing pointing at it.

### Two things the service did not expose

`ConversationService` has no `isBusy()` and no `agentId`. Rather than widen its
API for one caller, busy is derived from the log (`turn.started` without a
matching `turn.completed`) and the agent id is carried on the aside entry, where
`openAside` already knew it.

### Tests

Ten, covering: it becomes a live conversation on its own id; it forks the parent
with `persist`; it starts no turn; the seed arrives once and not twice; the
identity change is logged; two concurrent promotions make one branch; a promoted
aside cannot be promoted again; promotion refuses when the parent is gone; and it
drops out of `listAsides`.

### Not done

No UI — that is Phase 4, and until it exists nobody can reach this. And the
promoted room has never been driven against a real CLI: the fork path is
exercised by `FakeAdapter`, while Phase 1's live run covered the adapter half
separately.
