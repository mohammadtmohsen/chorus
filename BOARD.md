# Board

Somewhere to drop a task so it is not lost, and somewhere to look when deciding
what is next.

**Not a plan.** Work of any size still goes through
`docs/plans/{slug}-{date}/plan.md`, and a plan's own progress belongs in its
`STATUS.md`. This file is for the things that sit outside any one plan: what needs
a person rather than a commit, what was noticed in passing and is worth doing, and
what is deliberately parked.

**An entry says three things** — what it is, why it matters, and what would make
it done. An entry that cannot answer the third is a thought, not a task, and
belongs in a plan's open questions instead.

**Every entry has an id**, `C-001` upward, so a commit or a PR can name the thing
it closes. Ids are permanent and never reused: when an entry ships it moves out
and its number retires with it, because a recycled id makes an old reference point
at the wrong work. The next id is the highest ever used plus one — including the
ones no longer on this page.

Move an entry out when it ships. A board that keeps its finished work stops being
read, which is how the status summary went stale a day after it was written.

---

## Needs you

Nothing here can be finished by me alone.

### C-001 · An application icon

`electron-builder.yml` sets `buildResources: build`, so the packager looks for
`apps/desktop/build/icon.icns`. That file does not exist, and the build says so
every time:

```
• default Electron icon is used  reason=application icon is not set
```

So `Chorus-0.7.0-arm64.dmg` ships the generic Electron icon — in the DMG window,
in the Dock, in the Applications folder, and in ⌘-Tab. It is the first thing
anyone sees of the product and currently says "an Electron app".

**Why it is here and not done:** wiring it is a one-line change once the artwork
exists. Inventing a logo and committing it as the product's identity is a design
decision, not a packaging one.

**Done when:** `apps/desktop/build/icon.icns` exists (1024×1024 source, macOS
iconset) and `pnpm package` no longer prints that line.

### C-002 · Whether to notarize

The build is ad-hoc signed and **not** notarized, which is a documented decision
rather than an oversight — `electron-builder.yml` explains it at length, and
`docs/install-macos.md` walks a user through the dialogs. Ad-hoc signing is what
keeps macOS calling the app _untrusted_ rather than _damaged_, which is the
difference between a warning you can click past and one you cannot.

That is fine for `pnpm app:install` on your own machine. It is a blocker the
moment you hand the DMG to someone else.

**Done when:** either a Developer ID is available and notarization is wired, or
this entry is closed with "personal builds only" written down so nobody
re-litigates it.

---

## Open

### C-003 · The residual menu failure

`typing a slash offers the commands this project actually has` still fails
occasionally after its fix. The mechanism behind the original bug is settled and
fixed on both sides of the IPC boundary; what remains is unexplained and looks
like load rather than a second bug.

Eight hypotheses are dead and written down in the plan's `STATUS.md`, along with
the instrumentation that killed them. That list is the head start.

**Done when:** either it is reproduced with a named cause, or it survives a long
quiet run often enough to call the earlier failures environmental — with the
number of runs stated rather than implied.

### C-004 · Measure what catch-up actually costs

In a shared room each agent is fed what the other said, up to 12,000 characters a
turn, with activity capped at 40% so it cannot crowd out speech. It is the one
input Chorus invents, and it is careful — labelled `[Chorus]`, truncation
disclosed, the user's real message fenced off.

Nobody has measured it in practice. It does not make answers worse directly, but
it brings **compaction** forward, and compaction is the one moment the transcript
and an agent's memory stop agreeing.

**Done when:** a real two-agent room reports the catch-up size per turn and what
share of the context window it accounts for, so 12,000 can be judged as generous,
tight, or irrelevant on evidence.

### C-005 · The composed catch-up is not recorded

`user.message` holds what you typed; the agent received that plus a preamble
composed at delivery. It is a pure function of the events, so it is
reconstructible in principle — but if an agent behaves oddly you cannot read back
the exact text it was given.

**Done when:** either the delivered text is recoverable for a past turn, or this
is closed with the reason the log deliberately records the conversation rather
than the prompts.

### C-006 · Should any of the e2e suite run in CI

CI runs typecheck, lint, format, tests and a build. It **cannot** run the 26 e2e
specs or `verify:package`, because both drive real `claude` and `codex` CLIs with
real credentials. So a green PR is not evidence about the renderer, and this
session shipped a transcript change that way before a local run caught an
unrelated defect.

**Done when:** either a credential-free subset exists in CI (a launch, a window, a
store that opens — no agents), or the answer is written down as "run it locally
before tagging" and the release checklist says so.

---

## Parked, with reasons

Not open questions and not oversights: judgements already made, written as tickets
so they can be cited and argued with rather than rediscovered as gaps. The third
line of each is **what would reopen it** — a parked ticket with no such condition
is not parked, it is forgotten.

Full reasoning, including the probes, is in the plan's `STATUS.md` and `DONE.md`.

### C-007 · The todo panel

The detail line shipped: a `TodoWrite` row reads `Fixing the parser · 1/3` instead
of the bare tool name, using the field names and the one-in-progress invariant read
out of the CLI binary's own tool description.

The panel did not. It cannot be built honestly on this machine, whose config
replaces `TodoWrite` with `TaskCreate`/`TaskUpdate` — asked to write todos, the
agent said so itself. Building a surface nobody here can see means shipping a
schema commitment on faith and calling it verified.

**Reopens if:** a machine has `TodoWrite`, so the panel can be driven and looked at
— or the `Task*` shape is worth handling as a second reduction on its own merits.

### C-008 · Dialogs

Carried unbuilt through three phases before being decided rather than carried a
fourth time. `refusal_fallback_prompt` is the only kind the CLI declares.

The reason not to build it inverts the intuition that wiring the callback is the
safe half: the CLI treats an **undeclared** kind as "cannot display" and fails
_closed_, so today's behaviour is a defined degradation — the classic refusal
error. Declaring the kind is a promise Chorus can render it, and breaking that
promise parks the turn instead. Against which `payload` is `Record<string,
unknown>` defined per kind, and the trigger is a model refusal that cannot be
produced on demand to test against.

**Reopens if:** a second dialog kind appears, or the payload shape is documented —
either makes the renderer testable, which is the whole objection.

### C-009 · Checkpoints

`rewindFiles(userMessageId)` wants the CLI's own uuid for a user message. Probing
every message the SDK yields for one prompt gives `system/init`, `assistant`,
`rate_limit_event`, `result` — and nothing else. **The CLI never echoes the user's
message back**, so there is no uuid to capture. Setting
`enableFileCheckpointing: true` changes nothing, which disposes of the hope that
the option makes it start announcing them.

The uuid exists in exactly one place: `~/.claude/projects/<slug>/<sessionId>.jsonl`.
That route is available and wrong — an undocumented private format belonging to a
self-updating binary, read to drive an operation that **reverts files on disk**,
where a format change rewinds to the wrong point rather than failing.

**Reopens if:** the SDK exposes the id — an echoed user message, or a `rewindFiles`
that accepts something a host can legitimately know.

### C-010 · The context breakdown

`getContextUsage()` carries a full inventory — system prompt, tools, memory files,
skills, messages — and the temptation is a panel showing where the window went.

Measured, the obvious version lies. `totalTokens` **excludes** the deferred
categories: 253 + 12,725 + 4,289 + 2,110 + 4,787 = 24,164, exactly `totalTokens`,
while two deferred rows carry another 59,538 that costs nothing until something
loads them. A panel presenting "MCP tools: 45,930" as consumed would be wrong by
more than twice the total.

Also unused and more interesting than the breakdown: `autoCompactThreshold` is
967,000 against a `maxTokens` of 1,000,000, so compaction fires at 96.7% and a bar
drawn against the maximum never fills before it resets.

**Reopens if:** someone designs it with the deferred distinction drawn honestly.
The blocker is design, not plumbing.

### C-011 · Terminal sessions in the history sheet

Chorus's log is authoritative, decided in open question 2. A CLI session is a
different unit: a Chorus conversation is a _room_ spanning several sessions, and
`listSessions()` is Claude-only, so codex does not appear at all.

Measured on this repository, `listSessions()` returns 21 sessions of which eight
are throwaway — three `Say OK`, two `hi` — five created by this project's own
probes in one afternoon. Merged rows would put `Say OK` in the history sheet
looking reopenable.

**Reopens if:** importing terminal work is wanted, as its own labelled surface
rather than merged rows. `sessionRef` is already recorded, so a room can name its
CLI session whenever the correlation is useful.
