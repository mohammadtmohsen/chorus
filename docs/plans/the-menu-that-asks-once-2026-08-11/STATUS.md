# Status

**Phases 0–3 shipped in `58907f1`** on `fix/the-menu-that-asks-once`, off
`origin/main`. Typecheck, lint and format clean; **1,250 unit tests**; the full
e2e suite run three times (see Phase 0b — it is not a clean sweep, and that is
the finding).

## Phase 0 — the defect reproduced, deterministically

**Done.** The mechanism in the plan is real, and it is worse than the plan
described on the file side.

The real `Composer` was bundled with esbuild against a stubbed `window.chorus`:
`listCommands` answers empty until t=12s and then answers 49; `completeFiles`
rejects its first call with `spawn EAGAIN` and succeeds after. `react-i18next` is
shimmed; nothing else is faked. `/` is typed at t=2s, exactly as the e2e helper
types it — a programmatic value set plus one `input` event.

### The slash half

`.mention-menu` was absent at **3s, 14s and 30s**, though the commands became
available at 12s. Every call the component made:

| #   | at      | answer | what asked                                  |
| --- | ------- | ------ | ------------------------------------------- |
| 1   | 31ms    | empty  | background retry, attempt 0                 |
| 2   | 1,533ms | empty  | background retry, attempt 1                 |
| 3   | 2,955ms | empty  | **the on-demand ask** — `/` typed at 2s     |
| 4   | 4,534ms | empty  | background retry, attempt 2                 |
| 5   | 9,036ms | empty  | background retry, attempt 3, the last one   |
| —   | —       | —      | **nothing at all, for the next 22 seconds** |

Then one more keystroke — `/c` — and the menu opened instantly on `/cmd-0`.

**That last line is the proof.** The data had been available since 12s. Nothing
was slow, nothing was racing, nothing was empty. The component had simply stopped
asking, and no amount of waiting was ever going to change that.

### The file half

Starker, because there is only one mechanism rather than two:

|                             |                                     |
| --------------------------- | ----------------------------------- |
| file rows at 1s / 10s / 30s | **0 / 0 / 0**                       |
| calls to `completeFiles`    | **exactly one**, at 433ms, rejected |
| after one more keystroke    | **1 file row**                      |

One failed lookup, and the menu is empty until the user types again. The spec
types `@mention-menu` once and then waits thirty seconds for something nothing
will refresh.

### What this does and does not establish

**Established:** both menus can reach a state from which they never ask again,
and in that state waiting is useless. This is a product defect independent of any
test — under load, typing `@name` once can give you an empty menu that stays
empty.

**Not established:** that this is what happened in the recorded suite failures.
The stimulus here was chosen to trigger it. Phase 0b is what would close that gap,
and until it does the causal claim stays an inference.

### Harness

Temporary, in `/tmp`, not committed — it aliases a module and stubs the IPC
surface, which is the wrong shape for the repo's suite. Phase 2 turns the same
stimulus into something that lives in the tree.

## Phase 1 — the three states on the file path

**Done.** No behaviour change: the renderer still reads `result.files` and still
ignores everything else. `files:complete` now carries `state` beside the list,
and `completeFiles` returns which of the three it is.

**The classifier turns on a detail Node overloads.** `error.code` is an errno
**string** when the spawn failed and an exit **number** when git ran and
objected — so a string is about starting git, a number is about what git said.

| failure                             | state       | why                                       |
| ----------------------------------- | ----------- | ----------------------------------------- |
| `killed` (the 4s timeout)           | retryable   | under this load, a busy machine           |
| `EAGAIN` `ENOMEM` `EMFILE` `ENFILE` | retryable   | could not fork _right now_                |
| `ENOENT`                            | unavailable | no git on this machine                    |
| `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` | unavailable | the same size next time                   |
| exit + `not a git repository`       | unavailable | permanent for that directory              |
| exit + `cannot change to`           | unavailable | the directory is not there                |
| exit + `index.lock: File exists`    | retryable   | **two git processes at once — it clears** |
| any other non-zero exit             | retryable   | bounded, and the safer way to be wrong    |

**Both terminal wordings were read off the binary, not guessed** —
`git -C /no/such/dir ls-files` says `fatal: cannot change to '…': No such file
or directory`, which is not the `not a git repository` string.

**Two things the tests caught that review had not:**

1. `askAgain(undefined)` **threw**, inside a `catch`. A rejection carrying
   nothing readable is still an unanswered question; it now returns retryable
   rather than throwing a second error out of the handler.
2. A directory that does not exist was classified **retryable**. Found by running
   the real thing against `/no/such/dir/here` rather than by reasoning about it.

**Verified against real git**, not only the pure function:

|                                           |                                                         |
| ----------------------------------------- | ------------------------------------------------------- |
| this repository, `mention-menu`           | `ready`, and the file is in the list                    |
| this repository, a query matching nothing | **`ready` with 0 files** — the distinction that matters |
| `/tmp`                                    | `unavailable`                                           |
| `/no/such/dir/here`                       | `unavailable`                                           |

Gate green: **1,270 tests**, typecheck, lint, format.

## Phase 2 — the re-ask

**Done.** The same harness, the same stimulus, the opposite result.

### The slash half

|                   | before                              | after                            |
| ----------------- | ----------------------------------- | -------------------------------- |
| menu at 30s       | **closed**                          | **open**, on `/cmd-0`            |
| asks              | 5, all inside 9s                    | 7, the last at 14.3s             |
| after the 9s mark | **nothing, for 22 seconds**         | four more asks                   |
| smallest gap      | 243ms (two loops racing, see below) | **801ms**, never under the floor |

Ask times after the fix: **10ms** (warm-up), then **2,307 · 3,108 · 4,710 ·
7,111 · 10,314 · 14,315** — gaps of 801, 1602, 2401, 3203, 4001. The widening is
what reaches a CLI that reports at twelve seconds; the floor is what stops the
open menu spawning work in a loop.

### The file half

|                                     | before                | after                 |
| ----------------------------------- | --------------------- | --------------------- |
| rows at 1s / 5s, first lookup fails | 0 / 0 (and 0 at 30s)  | **1 / 1**             |
| calls                               | exactly one, rejected | two — 382ms, 1,184ms  |
| gap                                 | —                     | 802ms                 |
| **`unavailable`: asks over 8s**     | —                     | **exactly 1**, 0 rows |

That last row is the one the three states were for. A directory with no git in it
is asked **once** and never again, where a `retryable` failure is asked again
802ms later and answered.

### What the measurement caught that the design had not

**Two retry loops were running against each other.** The first run after the fix
showed asks 243ms apart — under the 800ms floor the new loop was itself
enforcing — because the old mount-time retry was still looping independently.
The floor is only a floor if one thing is counting.

So the mount-time fetch went back to being **one warm-up ask**, which is what its
own comment always claimed it was: it exists so the first `/` shows a list
instead of a pause, and it is no longer what correctness depends on. Correctness
is now the open menu asking for itself, bounded by someone actually waiting.

**This is a real reduction in scope, not only a tidy-up:** the app used to have
two independent opinions about when a slow CLI should be re-asked, and neither
knew about the other.

Gate green: **1,270 tests**, typecheck, lint, format.

## Phase 3 — the menu says which state it is in

**Done.** The menu now opens for a _state_ as well as for rows, carrying one
quiet, unselectable line — and `.mention-status[data-lookup]` is what a failing
run can read.

| `data-lookup` | when                   | measured                                          |
| ------------- | ---------------------- | ------------------------------------------------- |
| `asking`      | a lookup is running    | shown 400ms after `/`, gone once 49 commands land |
| `unavailable` | git cannot search here | shown, and **1 ask**, never retried               |
| `exhausted`   | the ceiling ran out    | shown after **9 asks** — warm-up plus eight       |

### The trap this walked into, and the two things it broke

**Opening the menu with no rows is not a cosmetic change.** Two real regressions
came out of it, neither from a test:

1. **Enter stopped sending.** The keyboard block was gated on `menuOpen`, so an
   open-but-empty menu swallowed Enter through `preventDefault` and chose
   nothing — a message beginning with `/` could not be sent at all while the list
   was still arriving. The gate is now `options.length > 0`. `ArrowUp`/`Down`
   were worse than useless in the same state: `% options.length` is a division by
   zero.
2. **Escape stopped closing it.** Moving the whole block behind "there are rows"
   left a menu you could not dismiss. Escape is now handled on `menuOpen`,
   separately and deliberately.

Verified: **`enterStillSends: true`** with a status-only menu open.

### The specs

**The waits moved from `.mention-menu` to `.mention-menu .mention-name`, and
that is the whole point.** The menu now opens to carry the status row, so the old
selector would have been satisfied by a menu that had found **nothing** — turning
the exact failure these specs exist to catch into a pass. The status improves the
message and changes no assertion:

```
never became true: typing a name found files — the menu reported: unavailable
```

### Against the real app

`node e2e/run.mjs "offers the"`, real Electron, real CLIs:

|                                                  |                                       |
| ------------------------------------------------ | ------------------------------------- |
| runs                                             | **6**, all passing                    |
| `typing a slash offers the commands…`            | 50 commands offered, narrowed 50 → 10 |
| `an @ offers the cast, then the project's files` | found `mention-menu.ts` and its test  |

Gate green: **1,250 tests** on this branch, typecheck, lint, format.

## Phase 0b — the evidence, and it does not say what this plan assumed

**Three full suite runs. The slash failure reproduced once — and the diagnostic
named a state that rules this plan's own mechanism out.**

| run | outcome       | menu specs                   |
| --- | ------------- | ---------------------------- |
| 1   | all 28 passed | both passed                  |
| 2   | **3 failed**  | **`typing a slash…` failed** |
| 3   | 1 failed      | both passed                  |

Run 2's failure, in full:

```
never became true: a leading slash opened the menu — the menu reported: no status row
```

### Why that sentence is the finding

**`no status row` means no lookup was in flight, and none had given up.** Had a
`/` menu been open against an empty command list, the effect would have set
`asking` and the row would have been there; had it run out of attempts,
`exhausted`. Neither was.

So at the moment of failure the composer was **not waiting for anything**. The
stalled-effect mechanism — real, reproduced in Phase 0, fixed in Phase 2 — is
**not what produced this failure**. Two candidates remain:

1. **`mention` was null** — the `/` never registered as a command query at all.
2. **`commands` was non-empty but `commandOptions` matched nothing**, which for an
   empty query should be impossible and would be its own bug.

**This is the outcome the plan was written to allow.** The causal claim was
demoted to an inference on review, and Phase 0b existed to test it. It tested it,
and the inference was wrong. A green harness does not make a mechanism the cause,
which is what the demotion was protecting against.

### What the next diagnostic has to capture

The status row says what the _menu_ was doing. The open question is what the
_composer_ was doing, so the failure path needs `el.value`, `el.selectionStart`,
`mention` and `commands.length` at the moment it gives up — the instrumentation
that solved the original bug, kept this time rather than removed.

### A second spec is flaky, and it is not from this branch

`the question stays at the top of the answer it asked for` failed in runs 2 and 3,
on `nothing overflows sideways` (28px, then 19px). Checked rather than assumed:

| tree                     | result                       |
| ------------------------ | ---------------------------- |
| this branch              | 1 passed / 2 failed of 3     |
| **`origin/main`, clean** | **2 passed / 1 failed of 3** |

It fails on `origin/main` too, so this branch did not cause it. At n=3 those are
the same number. It belongs on the board on its own.

## Still open

**C-003 is not closed by this branch.** Fixed: a real defect that produces an
identical symptom and can be reproduced on demand. Not fixed: whatever produced
run 2.

**The branch.** Off `origin/main` as `fix/the-menu-that-asks-once`. The focus and
card-sizing work stays on `fix/cards-that-stay-answerable`; the BOARD.md edit for
C-028 belongs to that branch and is stashed, not carried here.

## Phase 0b, second pass — the composer's own state, and the failure caught in it

**Seven full suite runs on this branch.** The slash spec failed **2 of 7**, and
**20 of 20 alone** — so it needs the suite's load rather than repetition, which
matches every note on the entry.

The second failure, with the record `9824e4d` added:

```json
{
  "lookup": "no status row",
  "mention": "none",
  "commands": "50",
  "value": "/",
  "caret": 1,
  "focused": true,
  "composers": 1,
  "rows": 0
}
```

| what it says             | reading                                     |
| ------------------------ | ------------------------------------------- |
| `value: "/"`, `caret: 1` | the slash is in the box, caret after it     |
| `focused: true`          | the textarea has the caret                  |
| **`commands: "50"`**     | **the list was fully loaded**               |
| `composers: 1`           | one composer, so no wrong-element confusion |
| **`mention: "none"`**    | **and the composer parsed no query at all** |

**This was never about the list arriving.** Every input to the decision was
correct, and the decision still came out null — which also retires the last
version of the "slow CLI" story that has framed this entry from the start.

### Two candidates, and no third

`refreshMention` runs **synchronously** in `onChange`, and
`findCommandQuery('/', 1)` cannot return null: its only rejections are a
non-whitespace prefix and a query outside `[a-z0-9:_-]*`, and `/` with an empty
query is neither. So:

1. **`onChange` never fired.** React's `draft` would still hold the previous
   text — the spec types `look at src/foo` first, so `draftLen` 15 rather than 1.
2. **`dismissed` held `/0:`** — the one branch that nulls a mention that _was_
   found. Nothing in the spec presses Escape, so that would be a defect in how
   `dismissed` is set or cleared.

`data-draft-len` and `data-dismissed` now separate them on the next occurrence.

**A caveat on `data-dismissed`:** it reads a ref during render, so it shows the
value as of the last render rather than live. That is sound here because the only
writer outside `refreshMention` is the Escape handler, which calls `setMention`
in the same breath — but it is a real limit and worth knowing before trusting it.

## Phase 0b, third pass — C-003 has a named, reproduced cause

**It is the blur.** Both candidates from the second pass were wrong, and the
answer was on the _original_ investigation's list of two — _"the only paths that
null it are a blur and `dismissed`"_ — never eliminated.

The failure that settled it:

```json
{
  "mention": "none",
  "draftLen": "1",
  "dismissed": "none",
  "commands": "50",
  "value": "/",
  "caret": 1,
  "focused": true,
  "rows": 0
}
```

| field               | what it kills                                                   |
| ------------------- | --------------------------------------------------------------- |
| `draftLen: "1"`     | React's `draft` is `/` — **`onChange` fired**, candidate 1 dead |
| `dismissed: "none"` | nothing was swallowed — candidate 2 dead                        |
| `commands: "50"`    | the list was loaded, so no lookup was pending                   |

`onBlur` cleared the mention **unconditionally**, and nothing undid it.
`refreshMention` runs on change, select and keydown; focus coming back is none of
those. So the box kept `/`, the menu stayed shut, and only another keystroke
could reopen it — the same never-recovers shape as the defect in `58907f1`, in a
different place.

### Reproduced, then fixed

Type `/`, blur the box, refocus it:

|                               | after `/`      | blurred + refocused | with `onFocus` |
| ----------------------------- | -------------- | ------------------- | -------------- |
| `mention`                     | `/0:`          | **`none`**          | `/0:`          |
| `rows`                        | 49             | **0**               | **49**         |
| `value` / `caret` / `focused` | `/` / 1 / true | `/` / 1 / true      | `/` / 1 / true |

The middle column is the real failure record, field for field.

**The fix is `onFocus={refreshMention}`** — not "stop clearing on blur", which is
right: a menu should not outlive the box being left. What was missing is that
returning re-reads what is there.

**Escape still wins.** Dismiss with Escape, blur, refocus: `rows` 0 and
`dismissed` `/0:`. That is exactly what `dismissed` exists for, and it is checked
on the path `onFocus` now runs.

**Rates:** 20 of 20 alone; **3 failures in 13 full suite runs**. Something must
take the caret and give it back, which a busy app does and an idle one does not.

### The fix was wrong, and the measurement is why that is known

`onFocus={refreshMention}` passed the harness — blur, refocus, menu returns — and
then failed the only test that matters:

|                | menu specs, same machine, back to back |
| -------------- | -------------------------------------- |
| with `onFocus` | **2 passed / 3 failed of 5**           |
| without it     | **5 passed / 0 failed of 5**           |

It is not a fix. It is a second way to produce the same record, and the failures
it caused carry the same fields — `mention: none`, `value: "/"`, `caret: 1`,
`dismissed: none`.

**Why, and what it means for the real fix:** a focus event can fire while the
caret is still at 0. `findCommandQuery` reads `text.slice(0, caret)`, so caret 0
is an empty string, no `/` is found, and a valid mention is nulled. The harness
missed it because `ta().focus()` there restores the caret synchronously; a real
window regaining focus does not.

**Reverted.** The instrumentation stays, the cause stands, the fix is open — and
it has a constraint it did not have this morning: it must re-derive the mention
_after_ the caret is restored, never during the event that restores it.
