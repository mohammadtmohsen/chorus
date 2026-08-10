# The read-only profile is not read-only

`C-020`. Found while planning C-017, and it is the more urgent of the two: the
profile whose summary reads _"Agents may look. Anything that changes the machine
needs a decision"_ decides `allow` on commands that change the machine.

## The problem

`SAFE_READS` matches with a regex anchored at the start of the **whole command
line**. Claude's `Bash` tool hands over one shell string
(`mapping.ts`, `command: [theWholeString]`) and `subjectOf` joins it back, so
`^cat\b` is tested against `cat evil > ~/.zshrc` and matches.

Verified against the real engine before any change, under `read-only`:

```
ALLOW <- find . -delete
ALLOW <- git branch -D scratch
ALLOW <- cat source > target
ALLOW <- rg needle . | xargs touch marker
ALLOW <- find . -exec rm {} ;
ALLOW <- cat evil > /Users/me/.zshrc
```

`UNIVERSAL_DENIES` catches none of them: it denies `rm -rf`, force-push and
history rewrites, and none of these is any of those. There is no card, and
`approval.decided` records an allow nobody chose.

**It is not aside-specific.** `read-only` is the default for every new
conversation. Asides make it sharper — `neverAsks` makes this allowlist the
entire gate, and Claude's sandbox is `emulated`, so nothing underneath enforces
anything — but the hole is in the ordinary path.

## The shape of the answer

The rule can only say what a line **starts with**. The fix is to make an `allow`
account for the whole line.

**An allow rule must cover every command on the line.** Substitution and file
redirection are refused outright — `$(…)` and backticks run something the rule
never sees, and `>` writes. What remains is split on the sequencing operators and
each part must satisfy the same rule. A pipeline of readers is still a read; one
whose second half is `curl` is not.

Only for `allow`. A deny must keep matching inside a composition, or `rm -rf`
becomes reachable by typing `&&`; and an `ask` that stopped matching would fall
through to a later allow.

**And an allowlisted reader needs argument-level exclusions.** `find` is a read
until `-delete` or `-exec`, `git branch` until `-D`, `sed` until `-i`. That is a
second field on the rule rather than more regex in the first, because the two
questions are different: what does this line start with, and what does it do.

### Why not simply reject any composed line

That was the first attempt, and measurement killed it. Over 490 inspection
commands in the real log it turned **419 into cards** — overwhelmingly
`cat … | head`, which is a read by any reading. A security fix that makes the
common case unusable gets turned off, so it is not a fix.

## What this is deliberately not doing

**Not parsing shell.** Splitting on operators without understanding quotes is
naive and it fails **closed**: `cat "a|b"` becomes two parts that do not both
match, so it asks. A card nobody needed is the acceptable error; a silent allow
is not.

**Not touching `UNIVERSAL_DENIES` or the `trusted` profile.** Trusted's allow has
no `commandPattern` at all — it is a blanket "any command" — so none of this
applies to it. That is correct: trusted means the user said so.

**Not adding `awk` or `xargs` to the safe list.** `awk` writes files from inside
its own program text, where no rule here can see it, and `xargs` runs whatever it
is handed. `sed`, `echo`, `sort` and `uniq` are added because the log shows them
in almost every inspection line and none of them writes without a redirect —
which is now refused.

## Open questions

**1. Is 60% too much friction?** After the refinement, 296 of 490 inspection
commands still ask. Sampled, they are genuinely mixed lines — `python3 -c "…"`
after a `cat`, or a quoted `|` inside a `grep` pattern — so asking is the right
answer. But it is a real change for anyone on `read-only`, and worth watching.

**2. Should `read-only` be the default at all?** It is, and this fix makes it
stricter. If the everyday experience becomes "approve a card to read a file", the
honest conclusion may be that the default profile is wrong rather than that the
rule is.

**3. Codex's own sandbox.** Its `sandboxPolicy` is `native`, so the OS is a second
line under it. None of this work leans on that, and it should stay that way while
Claude's is `emulated`.
