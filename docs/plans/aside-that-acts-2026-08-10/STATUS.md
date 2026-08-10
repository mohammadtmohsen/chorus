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
