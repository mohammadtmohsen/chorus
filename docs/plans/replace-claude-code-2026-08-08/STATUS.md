# Status

## Where this stands

The entries below are a record, in the order things were learned, and several of
them correct an earlier one. This section is the summary they do not otherwise
have. Anything not listed as done is not done.

**Shipped.** Phases 0-3 complete. Phase 4 is the SDK surface worth reaching:
MCP server health, `accountInfo()`, background tasks with `stopTask()`. Phase 5
has begun with the todo detail line. The composer answers `/` and `@`, drafts and
history survive a quit, plan mode is per conversation, and hook output folds
instead of flooding.

**Declined, each with its reasoning in place rather than as a silent gap:**

|                          | why                                                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dialogs                  | The CLI fails _closed_ on an undeclared kind, so today's behaviour is a defined degradation. Declaring it promises Chorus can render an undocumented payload triggered by a refusal nobody can produce on demand — and being wrong parks the turn. |
| Checkpoints              | `rewindFiles()` needs a uuid the CLI never emits. It exists only in the CLI's private transcript, and reading that to revert files on disk risks the working tree on a format change.                                                              |
| `supportedAgents()`      | `@` means _who answers_. Those five cannot.                                                                                                                                                                                                        |
| Context breakdown        | `totalTokens` excludes deferred categories, so the obvious panel overstates usage by more than twice the total. Needs design, not plumbing.                                                                                                        |
| Images as content blocks | Would break the text log, catch-up, and provider parity to save one `Read`.                                                                                                                                                                        |

**Open.**

1. **Two menu failures.** A residual slash failure after its fix, and the `@`
   sibling that has never reproduced in isolation. Eight hypotheses are dead
   between them and written down; that list is the head start.
2. **Open question 2** — whether Chorus's log or the CLI's `listSessions()` is
   authoritative for the history sheet. The last unanswered question in the plan.
3. **Phase 5 remainder** — the todo panel (unbuildable blind: this machine's
   config replaces `TodoWrite` with `TaskCreate`/`TaskUpdate`), a plugin browser,
   and the settings-only group.

**How this is verified.** `pnpm check` is 947 tests; the e2e suite is 26 specs
driving the built app over CDP. **CI cannot run the e2e suite** — it has no
credentials for real CLIs — so a green PR is not evidence about the renderer, and
the suite has to be run locally before believing a UI change. Two of this
project's worst bugs were invisible to every gate and visible in a screenshot.

**The habit that found most of them.** Drive the built app and look at it; probe
the real CLI instead of trusting prose; and when a measurement produces a clean
result, check the mechanism before believing it. Twice a plausible clean result
was wrong and would have closed a real bug.

## Open work

Everything finished lives in [`DONE.md`](./DONE.md), unedited. What follows is
what is not.

### 1. Two menu failures — reframed, and the clock taken out of the fix

**The residual failures look like load, not a second bug.** They were measured
during a stretch when this machine was running suites, probes and real agent
turns back to back. Since then: 12 spec runs clean, 12 more with the app
instrumented, 16 reproducer rounds, and 8 runs under six busy CPU loops — all
passing. Pure CPU load does not reproduce it; the earlier condition was heavier
and different in kind, many concurrent Electron starts and CLI launches at once.

Not proven, and not claimed as fixed. What it does mean is that the open item is
no longer "the product misbehaves for reasons nobody can explain" but "the
retry window can be exceeded under load", which is a different and much smaller
thing.

**So the clock came out of the fix.** Retrying on a timer races the session's
start, and no window is right on every machine. A slash typed against an empty
command list now asks for one _right then_ — a person opening the menu is the
only signal that the answer matters yet. The background retry stays, because it
makes the common case instant; it is no longer what correctness depends on.

This is shipped on the strength of the mechanism, which is proven, rather than on
a demonstration that it fixes the residual failures, which are not reproducible.
That distinction is the point of this note.

### The investigation, kept for the half still open

The slash half is understood and fixed: an empty command list, needing a change
on both sides of the IPC boundary. A residual failure survives that fix, and the
`@` sibling has never reproduced in isolation at all.

The whole investigation stays here rather than in the archive, solved parts
included — eight dead hypotheses and the instrumentation that killed them are the
head start for the half still open, and splitting them would leave the open half
looking unexamined.

#### A second flake, still open — and three explanations it is not

`an @ offers the cast, then the project's files` failed once with
`never became true: a bare @ opened the menu`. Recorded here because the first
flake in this file turned out to be a real bug, so "probably nothing" is not a
conclusion this project gets to reach by assertion.

**What is known.** One failure in roughly seven full-suite runs; five clean
suites since. Zero failures in thirty isolated runs of that spec. The wait
allows **90 seconds**, so slowness is ruled out the same way it was for the
typewriter — passing runs take five.

**Three hypotheses, each tested and each wrong.** Written down so nobody spends
the afternoon re-testing them:

1. _The drafted `@` is clobbered by the re-render that `setProjectDirectory`
   causes._ No: a draft typed before a folder change is still there ten seconds
   after it, character for character.
2. _The programmatic value-set leaves the caret at 0 when the window is not
   focused, so no mention query is found._ No: blurred, `selectionStart` is
   still 1 and the menu still opens.
3. _A bare `@` finds an empty cast because the agent has not joined yet, and
   `menuOpen` is `options.length > 0`._ No: typed the instant a textarea exists,
   before any agent joins, the menu opens immediately — the cast comes from the
   session record rather than from the join.

So it is none of the obvious three.

#### Narrowed sharply, still not solved

A later run failed the _sibling_ spec — `a leading slash opened the menu` — and
that one **does** reproduce in isolation, about two runs in eight. Same
component: both menus are gated by `menuOpen = options.length > 0`.

Caught with instrumentation at the moment of failure. Everything that could
plausibly be wrong is not:

| checked at failure  | value                |
| ------------------- | -------------------- |
| textarea value      | `"/"`                |
| caret               | `1`, after the slash |
| focus               | on the textarea      |
| disabled / readonly | no                   |
| composers / panes   | one each             |
| commands over IPC   | **49**               |

And dispatching the identical input event a second time opens the menu
immediately.

**Four more explanations tested and dead**, on top of the three above:

4. _The command list is empty because the fetch raced session start._ No: 49
   over IPC at the moment of failure, and 49 at every interval from 0ms after
   mount.
5. _React never heard the event._ No: the send button is enabled from React's
   own `hasDraft`, and it is enabled — so the change reached the component and
   `setDraft` ran.
6. _Focus was never established, and the composer clears its mention on blur._
   No: focusing before typing does not change the rate.
7. _A repeated dispatch is skipped because React's value tracker already holds
   the text._ True, and it matters for any retry — going through the empty
   string first is required — but it is not the cause.

So: React received the text, the data was there, and `mention` was still null.
The only paths that null it are a blur and `dismissed`. Neither is explained yet.

**What not to do:** a retry in the spec helper reduced eight-run failures from
about three to about two, which is not a fix and was reverted rather than
committed.

#### Solved: it was an empty command list, and it needed both halves

Instrumenting `refreshMention` itself ended it. At the moment of failure the
query is detected perfectly:

```json
{ "value": "/", "selectionStart": 1, "activeIsBox": true, "found": "/::0", "dismissed": null }
```

`found` is non-null, so `setMention` ran with a valid command query and the menu
still did not open — which leaves exactly one possibility, `options.length === 0`,
which for a slash means the component's `commands` were empty.

**Why the first attempt at this looked useless.** The renderer fetches the list
once on mount, and a pane mounts before its session has finished starting, so the
answer is often empty. Retrying from the renderer alone changes nothing, because
`runtime.listCommands` cached that empty answer with `??=` — an empty array is
not nullish — and every retry was answered from the cache with the same nothing.
**Neither half works without the other**, which is why the retry was tried,
measured as useless, and thrown away before the cache bug was known.

That also means this is a real defect independent of any test: open a pane, type
`/` within a second, and the menu is empty for the life of that pane.

**Honest about what the fix does and does not do.** The mechanism is proven and
the cache half is unarguable. The retry half reduced the spec's failures from
two in eight to one in twelve; widening it to eight tries over forty seconds gave
three in twelve. At that sample size those are the same number, so the constant
stays at the value the mechanism justifies rather than the one the last
measurement liked. A residual failure remains and is not explained.

**Still unexplained, and probably the same family:** the `@` sibling, which has
never reproduced in isolation at all.

### 2. Open question 2 — which log is authoritative

The history sheet reads Chorus's log; `listSessions()` reads the CLI's. Which
wins when a conversation exists in both? The last unanswered question in the
plan, and a design decision rather than a measurement.

### 3. Phase 5 remainder

- **The todo panel.** The detail line shipped; the panel did not. It cannot be
  built honestly on this machine — the user's own config replaces `TodoWrite`
  with `TaskCreate`/`TaskUpdate`, so there is nothing here to see it with.
- **A plugin browser**, which the plan judged is better shelled out to
  `claude plugin` than parsed from `~/.claude/plugins/*.json`.
- **Status line, output-style picker, live rename** — settings-only, or on the
  wire with no method.
