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
