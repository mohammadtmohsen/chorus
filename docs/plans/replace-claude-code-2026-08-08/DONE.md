# Done

The finished half of the record for `replace-claude-code`, moved out of
`STATUS.md` so that file tracks what is still live. Nothing here is edited:
these entries are kept in the order they were written, corrections and all,
because the reasoning is the point and several of them exist to correct an
earlier one.

`STATUS.md` holds the summary, the open work, and the pointer back here.

## Phase 0 done: Things that were already wrong

Shipped as two PRs, because the fourth item is much larger than the other three.

**Three correctness bugs** (#34):

- `includeHookEvents` was never set, so `hook_started` / `hook_progress` /
  `hook_response` never arrived and the hook handling in `mapping.ts` had been
  dead since it shipped. Turning it on also brings the two events that carry no
  outcome, so both are quiet.
- `SDKUserMessageReplay` is byte-identical to a live user message apart from
  `isReplay`, so resuming appended a second copy of every command and tool result
  the log already held.
- `interrupt()`'s receipt was discarded, so queued messages that survive a stop
  were invisible.

**The `canUseTool` third argument** (#35). The adapter read two of three
parameters, dropping everything the CLI knows about a request it is blocked on:

- `title` — the sentence the bridge already rendered. Chorus was reconstructing
  one from a tool name and an argument bag; ours is now the fallback.
- `blockedPath` — the path that stopped a Bash command, which appears **nowhere
  in the command**. A card asking "may I run this" without naming it was asking
  the user to approve something they could not see.
- `suggestions` — the CLI's own always-allow rules. Not returning them meant
  "always" was answered by Chorus alone: its session grant stopped Chorus asking
  while the CLI carried on. Both now happen, and they are different answers to
  different questions.
- the abort `signal`, so a withdrawn request stops asking.

`decisionClassification` goes back too.

**Not done, deliberately:** dialogs. `onUserDialog` is unset and the SDK fails
_closed_ — an undeclared dialog kind is never emitted, so the CLI applies its own
default. Fixing it means declaring `supportedDialogKinds` and rendering a
blocking dialog, which is Phase 2 UI rather than a correctness fix.

## Phase 1: The composer

### 1a done: Extracted (#36)

`Session.tsx` 1,653 → 1,310, plus a 461-line `Composer.tsx`. The seam is three
imperative calls in, two notifications out, one ref written.

The draft used to live beside the transcript, so every keystroke re-rendered the
conversation. It does not now.

**What the e2e caught:** the first version read the draft back through the
imperative handle on unmount, and the backgrounded-tab spec failed immediately —
React detaches a child's ref before the parent's cleanup runs. The draft is now
written into a ref the _pane_ owns. Every unit test passed; only the running app
knew.

### 1b done: Slash commands (#37)

The question this whole effort opened with. Typing `/` lists what the
conversation accepts, `/pr-review` among them.

**The plan was wrong in a useful direction.** It budgeted for a menu that had to
hide most of its contents, because only fifteen of ~100 CLI commands carry a
`thinClientDispatch` field and `SlashCommand` does not expose it. Probing the
real CLI made that moot: `supportedCommands()` returns 51 for `example-app` and
they are exactly the useful ones — the project's own commands, its skills and
plugins, and the built-ins that take text. The TUI-only set is simply not in the
answer. The CLI had already done the filtering.

`/` is not `@` with a different character: a mention fires at any word start,
which for a slash would open a menu inside every `src/foo`. A command must lead
the message. Matching is substring rather than prefix, because there are fifty of
these and half the names are compound.

### 1c done: File mentions (#38)

`@` now offers the cast and then the project's files. Agents first — two against
thousands, so counting would bury what `@` originally meant.

The search is ours because `file_suggestions` is on the wire with no `Query`
method. Asked of `git ls-files --cached --others --exclude-standard`, which
already knows what belongs to the project and includes the file you created a
minute ago. Outside a repository it offers nothing rather than walking slowly to
the wrong answer.

Files insert **bare** — a plain quoted path, as a dropped file already does —
rather than `@path`, so the router needs no new concept.

### 1e done: Memory (#39)

Drafts survive quitting, through the same route the read watermark takes.
Up-arrow brings back what was said, read off the reduced transcript so there is
no second list to fall out of step.

Recall engages only from an empty box. In a draft being written the arrows have
to keep moving the caret.

### 1d NOT done: images as content blocks

The plan called for threading `AgentInput.attachments` so a pasted screenshot
crosses as an image content block instead of a path. On inspection the design it
would replace is better than the plan credited, and three things break if it
goes:

1. **The log stays text.** `user.message` is `{ text }`. An image block needs the
   log to carry bytes, or to carry a reference the transcript cannot draw.
2. **Catch-up stops working.** `withCatchup` composes a _string_ for the other
   agent. A path is legible to Codex, whose input shape is
   `{ type: 'text', text, text_elements }`; an inline image block is not.
3. **The providers diverge.** Both agents receive the same message today.

Against that, the gain is one `Read` call saved for Claude, on a filesystem that
is deliberately unscoped so that an agent can open a file the way a person would
— which is what `attach.ts` says it is for.

Worth revisiting only if a provider appears that cannot read a path. Recorded
here rather than left as an unexplained gap.

## Phase 2 done: Permissions, properly

The prompt text and the always-allow rules came with #35. Plan mode is #41, and
the open question is answered: **per conversation**. Chorus already models what a
room may do at that level — the permission profile sits on the same card — and a
mode scoped to one message resets every turn, which makes it a checkbox nobody
can rely on. All participants together, because a room where one agent plans and
another edits is not a mode but a disagreement.

Approving the plan is what ends the mode. `ExitPlanMode` arrives as an ordinary
permission request, so answering yes to the plan and separately leaving the mode
would be two decisions for one intention — and the second is the kind that gets
forgotten, leaving an approved plan that never runs. Rejecting it keeps planning.

Never restored on relaunch: a mode belongs to a running session.

**Dialogs: carried through three phases, now declined with a reason.**

Investigated properly rather than carried a fourth time. `refusal_fallback_prompt`
really is the only kind — the CLI binary contains exactly one
`tengu_repl_bridge_dialog_kinds_declared` value and that is it.

The reason not to build it is in the types, and it inverts the intuition that
wiring the callback is the safe half:

> The CLI treats ABSENCE as 'cannot display' and **fails closed**: without the
> kind declared here, a dialog-gated flow degrades to its no-dialog behavior
> (for 'refusal_fallback_prompt', the classic refusal error) **instead of
> parking a dialog the consumer may mishandle**.

So today's behaviour is a defined degradation, not a silent breakage — the user
gets the classic refusal error. Declaring the kind is a **promise that Chorus
can render it**, and breaking that promise parks the turn. Against which:
`payload` is typed `Record<string, unknown>` and documented as "defined per
dialogKind", so the shape is genuinely unknown; and the trigger is a model
refusal, which cannot be produced on demand to test against.

Building an untestable renderer for an undocumented payload, where being wrong
converts a defined error into a hung turn, is a worse trade than the error. If
a second dialog kind appears, or the payload is ever documented, this changes.

## Phase 3 — Session control

**Manual compaction is already done**, by Phase 1b rather than by this phase.
`/compact` carries `thinClientDispatch:"post-text"`, which means it is invoked by
sending the literal text — so it works through the slash menu, and there was
never anything else to build.

**Checkpoints are blocked, and the previous entry named the wrong obstacle.**

`rewindFiles(userMessageId)` wants **the CLI's own uuid for a user message**, and
Chorus has never recorded one. That much was right. What followed was not: this
file said "live `SDKUserMessage`s do carry one, so the path exists — capture it,
correlate it with our event". That path does not exist.

Probed rather than reasoned about. Sending a prompt and logging **every** message
the SDK yields gives, in full:

```
system/init      uuid=…
assistant        uuid=…
rate_limit_event uuid=…
result/success   uuid=…
```

**The CLI never echoes the user's own message back.** There is no live
`SDKUserMessage` for our prompt and therefore no uuid to capture. `user` messages
do arrive — that is how tool results come back, which is why `mapToolResults`
exists — but never for the thing the user typed. Repeating the probe with
`enableFileCheckpointing: true` changes nothing, which also disposes of the
hopeful theory that the option makes the CLI start announcing them.

The uuid does exist in exactly one place: the CLI's own transcript at
`~/.claude/projects/<slug>/<sessionId>.jsonl`, where each user line carries
`uuid`, `parentUuid` and `sessionId`. So a route is available, and it is the
wrong one to take. It is an undocumented private file format belonging to a
self-updating binary, read to drive an operation that **reverts files on disk** —
the blast radius is the user's working tree, and the failure mode of a format
change is rewinding to the wrong point rather than an error. This project already
refuses to infer payload shapes from prose; inferring them from someone else's
on-disk journal to do something destructive is the same bet with worse stakes.

**So: not blocked on plumbing, declined on the available route.** It reopens if
the SDK exposes the id — an echoed user message, or a `rewindFiles` that accepts
something a host can legitimately know.

Enabling checkpointing before that would buy disk snapshots nobody can reach,
which is the dead-code shape this project keeps deciding against.

**Background tasks: this entry was wrong twice, and the corrections make the
work easier rather than harder.**

1. **`backgroundTasks()` is not an enumeration query.** It is an action —
   "backgrounds all foreground tasks — equivalent to pressing Ctrl+B in the
   terminal", returning a boolean. The name reads like a getter and was taken as
   one. Nothing enumerates.
2. **Which does not matter, because the event carries everything.**
   `SDKBackgroundTasksChangedMessage.tasks` is documented as "every live
   background task after the change. REPLACE semantics: swap your set for this
   payload." So there is no accumulation from turn zero and no unrecoverable
   client: one event hands over the entire set, and a client attaching
   mid-session is whole again at the next change.

**And the snapshot is state, not history.** Applying this project's own test —
would reading it back a week later be worse than having none? — a list of
processes that stopped existing when the session did is exactly that. So it
belongs on a push channel beside `limits` and `context.usage`, and must never
become a `ChorusEventPayload`.

Which makes what was actually shipping a rule violation rather than a gap: the
default arm was turning each one into a **durable notice whose entire text was
the string `background_tasks_changed`** — a protocol identifier shown to a
person, and an append-only row nothing can act on or rebuild from. Now quiet,
with the reason recorded at the exemption rather than in the commit alone.

### Done: the push channel and a chip that says something is still going

Built on the `limits` / `context.usage` seam rather than the event seam, which
is the whole payoff of classifying it correctly first. Adding a _logged_ event
is the documented five-file change with three deliberately exhaustive switches;
state is an event the conversation service pushes instead of appending, so
`projections.ts` and `catchup.ts` are untouched **and the linter agreed** — no
exhaustiveness error appeared, because nothing new reaches those switches.

Passed on whole every time, including when the list is empty. Under replace
semantics an empty push is not "no news", it is the only way anyone learns the
last task finished; a falsy guard anywhere on the path would leave the chip on
forever. There is a guard against that at each hop and a test that states it.

Carried on the pulse beside `contextByActor`, with the same hazard and the same
answer: no event reports it, so `reducePulse` must copy it forward or every
message the agent sends would erase it. That is a test too, written by copying
the one that already existed for context fill.

The card shows a count and puts the descriptions in the title — "something of
yours is still going" is the answer, and a sidebar card is not where anyone
reads a command line. Absent rather than zero when nothing is running.

**Verified against a real agent**, not a fixture: asked Claude to run
`sleep 100` with `run_in_background`, and the card read `1 running` with a title
of `local_bash: Sleep for 100 seconds`.

### Done: and the chip can end one

`stopTask(taskId)`, routed by agent rather than broadcast — a task id comes from
one provider's snapshot and means nothing to the other, so asking both would be
asking a stranger to stop something it never started.

Nothing anywhere reports success. The adapter swallows the error, the runtime
returns no confirmation, and the button disables itself and is never re-enabled
by the code that disabled it. All three are the same decision: the id came from
a snapshot only as fresh as the last push, so stopping something that has
already finished is an ordinary race rather than an error worth showing — and
the provider's next snapshot is the only thing that actually knows. Saying "done"
from the click handler would be saying it without knowing.

The list is below the card body rather than in it, because the body is a
two-column grid and a description is a sentence rather than a cell, and it only
appears when the count is clicked. A card that permanently listed every
backgrounded command would be a log, and there is already one of those.

**Verified end to end against a real agent:** `sleep 300` backgrounded, card
reads `1 running`, the row reads `local_bash · Sleep for 300 seconds · Stop`,
and pressing Stop clears the chip. That last step is also the empty-list path
proving itself — the chip can only disappear because a snapshot arrived empty
and was passed on rather than discarded as "no news".

## Phase 4 — the unused SDK surface

### The first flake was a real bug, and not where it looked

The unidentified e2e failure from the previous entry turned out to be
`a message reaches an agent and comes back`, failing about one run in four
with `never became true: an agent answered`. Chased rather than retried,
because a dropped turn would contradict the one rule this project is built on.

It was not a dropped turn. Keeping the userData directory of a failing run and
reading the log out of SQLite showed **everything correct**: the deltas, and
`agent.message.completed` carrying `"PONG"`. Relaunching the app on that same
directory rendered the answer. So the log was right, the reducer was right, and
the transcript still showed an empty bubble.

Instrumenting the renderer ruled out the next two suspects in turn: every event
reached `reduceEvents` in order, with correct payloads and correct `lastSeq`
dedupe. The message was in the view. What the DOM actually held was
`<div class="said"></div>` — not a clamp, not empty markdown, nothing.

`useTypewriter` was the answer. `shown` starts at zero and only advances inside
`requestAnimationFrame`, so a window the compositor has stopped asking to paint
leaves the visible prefix at **zero characters** for as long as that lasts.
Minimised, on another Space, occluded — the reply is durable, projected, reduced
and in the component's own props, and the transcript draws nothing.

Fixed with a watchdog rather than a `document.hidden` check, because occlusion
starves the frame callback without ever marking the document hidden. A second
without a frame means nobody is watching the animation, so the animation's point
is gone and only its cost remains: show the whole thing.

Verified the way the harness comment says to — these are "bugs that unit tests
do not find: a blank window". Twenty-four consecutive reproducer runs passed,
against roughly six failures in forty attempts before. There is no React test
environment in this repo and adding one for this would be a decision, not a
convenience; the e2e spec that caught it is the regression test, and it is
deterministic now.

**The general shape, worth keeping:** the flake was blamed on the network, then
on a dropped turn, then on the reducer. It was in the last place anyone looks —
the code that draws the thing everyone had already confirmed was there.

### Started: MCP server health

`mcpServerStatus()` is read and shown in Settings, so a server stuck in
`needs-auth` says so instead of silently handing its agent no tools. On this
machine that is `slack`, which had been failing quietly.

### Done: which account each agent is signed in as

`accountInfo()`, probed first as the MCP work was. This machine answers an
email, an organisation, `Claude Max`, and `firstParty`. Off the first-party API
none of that exists — a Bedrock session authenticates with AWS credentials and
has no plan — so every field is optional and a row shows what it has.

Per agent rather than first-answer-wins, unlike the servers: those come from one
config file and every session inherits the same ones, but `claude` and `codex`
are separate logins and may be different people. That is the whole reason to
ask. The question it answers is one a room running several projects at once
eventually has: the usage window on the rail belongs to an account, and until
now nothing in Chorus could say which.

The retry that the MCP panel needed is now shared, because both questions go
through to a live session and both are asked by someone who has just opened the
app. One subtle thing, asked once, in one place.

### Not done: `supportedAgents()`

It answers — five subagents on this machine, `Explore`, `Plan`,
`general-purpose` and the rest, with descriptions and sometimes a model. There
is nowhere honest to put them.

They are the CLI's own dispatch targets, not participants: Chorus cannot address
one, cannot route to one, and cannot tell when one is running. The obvious
surface is the `@` menu, and that is exactly where it would do harm — `@` in
this app means _who answers_, and there are two of those. Listing five things
that cannot answer under the same character would make the menu's one meaning
into two.

Recorded as answered-and-declined rather than left looking unexplored.

**Still to do:** the rest of the `getContextUsage()` payload — see below.

### What `getContextUsage()` actually returns

The plan said "one number is currently shown", implying the rest was more of the
same. It is not, and one thing in it corrects a claim Chorus currently makes.

The payload carries a full breakdown. On this machine:

```
System prompt                253
System tools              12,725
MCP tools (deferred)      45,930   deferred
System tools (deferred)   13,608   deferred
Memory files               4,289
Skills                     2,110
Messages                   4,787
```

**`totalTokens` excludes the deferred categories.** 253 + 12,725 + 4,289 +
2,110 + 4,787 = 24,164, which is `totalTokens` exactly, while the two deferred
rows add another 59,538 that is not counted until something loads them. So the
number Chorus already shows is the right one, and a breakdown that presented
"MCP tools: 45,930" as consumed would be wrong by more than twice the total.

**`autoCompactThreshold` is 967,000 against a `maxTokens` of 1,000,000.**
Compaction fires at 96.7%, so a bar drawn against the maximum never fills before
it resets. Also in the payload and not yet used: `memoryFiles` with a path and a
token count each, `skills` (15 here, 2,110 tokens), `slashCommands` (15, 917),
and a `messageBreakdown` splitting the conversation into tool calls, results and
attachments.

Not built yet. The interesting surface is "what is filling this window" and it
needs the deferred distinction drawn correctly or it lies; that is a design
question, not a plumbing one, and it should not be started as an afterthought
to a plumbing commit.

### Four things only a screenshot could have found

The panel above shipped green — every gate passed, 934 unit tests — and four of
its surfaces were visibly wrong in the running app. Driving the built app over
CDP and _looking_ at it is what found them:

1. **The slash menu was unusable.** Forty-nine commands, each description
   allowed to wrap, one entry three lines tall and the list overflowing off the
   top of the window. Now bounded (`min(40vh, 22rem)`, scrolling) with each
   description on one ellipsised line: tallest row 172px → 28px.
2. **The MCP panel rendered nothing.** Servers connect _after_ a session opens;
   the panel asked once on mount and kept the empty answer forever. Now asked up
   to three times over eight seconds. The panel meant to end a silence was
   producing one.
3. **The effort picker never appeared.** `models.find(m => m.value === model)`
   found no row while `model` was `''`, which is the ordinary
   nothing-chosen-yet state, so the control looked absent rather than defaulted.
   Falls back to the first row — the provider's own default.
4. **The plan toggle spanned the whole card.** `align-self: flex-start` on a
   **grid** item, where the horizontal axis is `justify-self`. 321px → 43px.

**And one the screenshot found by accident:** the MCP panel read "16 tool".
`tools_plural` is the i18next **v3** suffix; this project is on v26, which wants
`_one`/`_other`. i18next does not warn — it misses the key and renders the
singular for every count. `messages_plural` was wrong the same way. Nothing
checked the catalogue, so `en.test.ts` now does: no v3 suffixes, every plural
paired, every plural interpolating its count, and both forms resolved through
the configured instance. All four assertions fail on the old catalogue.

**The process lesson, which cost a full cycle.** The first verification run
reported two fixes still broken — and was testing a stale bundle. `ensureBuilt()`
only _checks_ that a build exists; it never rebuilds. `pnpm e2e` composes the
build in ahead of it, so the real suite was never at risk; the throwaway script
that called the harness directly was. A test that silently exercises yesterday's
code is worse than no test, because it is believed.

## Phase 5 — Rebuild or decline

### Started: the todo row says what the agent is doing

Not the panel, the line. `describeToolInput` looks for a string field and a todo
write carries one array named `todos`, so it matched nothing and the row rendered
as the bare word `TodoWrite` — the least useful line in a window that is the only
view of an agent. It now reads `Fixing the parser · 1/3`.

**The schema came out of the CLI binary, not out of memory.** Its own tool
description says:

> Each todo has `content`, `status` ("pending" | "in_progress" | "completed"),
> and `activeForm` (present-tense label shown while in progress).
> Send the full list each call; it replaces the previous one.
> Keep one item `in_progress` at a time.

Which settles three things at once: the field names, `activeForm` being the one
written to be read while it happens, and "one `in_progress` at a time" — so
showing that item is not a heuristic, it is the tool's own invariant.

This is still the private-schema commitment the plan warned about, and the reason
it is acceptable here and was not for checkpoints is the blast radius. Being
wrong costs one line of detail and falls back to the bare name the row already
showed. Being wrong about a rewind costs the working tree.

**Not verified against a live agent, and here is why.** Asked to write todos, the
agent on this machine answered: "there's no TodoWrite tool in this session — the
todo list here is exposed as TaskCreate/TaskUpdate/TaskList". The user's own
config replaces the built-in, which is exactly the config inheritance
`settingSources` is omitted to preserve. Those rows already read well, because
`description` is one of the string keys. So the change is unit-tested against the
documented shape and unobservable on this machine — stated rather than implied.

**Still to do in this phase:** the panel itself, the plugin browser, and the
settings-only items.

## Open question 4, answered: hook noise is real, and the filter is half of one

The plan asked whether `includeHookEvents` — turned on in Phase 0, where it was
one of the three correctness bugs — would flood a transcript on a repo with a
dozen hooks, and whether notices needed a per-source filter before it shipped.
It shipped without one and nobody measured it. Measured now.

**The setup.** A throwaway repo with seven `Bash` hooks: three `PreToolUse` and
three `PostToolUse` that each print a line, plus one that succeeds silently.
Conservative against the plan's "a dozen".

**The measurement.** Real events from the installed CLI, pushed through the real
`mapSdkMessage`, for **one** Bash call:

```
14 hook events  { hook_started: 7, hook_response: 7 }
 6 transcript rows
```

So the existing filter does exactly what its comment claims — the silent hook
produces nothing, and `hook_started` is quiet — and it is still **one durable row
per printing hook per tool call**. A turn with five commands on that repo is
thirty notices, interleaved between each command and its output, in an
append-only log.

**The answer to the question as asked is yes**, and the answer to its second half
is that a per-source filter is the wrong shape. Muting a source loses the hook
that blocks a commit along with the one that prints "formatted 3 files"; the
problem is not which hook spoke but that the same hook speaks on every call. The
idiom this codebase already has is folding — `CommandEntry` folds a turn's
commands to a line — and the same move fits here: one row per tool call carrying
how many hooks spoke, opening to the individual lines. That keeps the failure
visible, keeps the output reachable, and costs one row instead of N.

### Built: the fold

One row per run of talkative hooks, opening to every line behind it. The
transcript now reads

```
CLAUDE   > $ echo one
CLAUDE   HOOK: 6 hooks spoke   ▶ Details
CLAUDE   Output: one
```

**Consecutive, not per turn.** The run _is_ the tool call — the hooks for one
call arrive together and the next thing logged is the command they gated — so
anything at all in between breaks the group. That is also what stops a hook
folding into one that fired before something else happened.

**Only `info` folds.** A hook that failed or was cancelled arrives as `warn`,
keeps its own row, and is never counted away. The whole reason the transcript
carries hooks is the one that blocked something, and a design that hides it to
save a line would have inverted the feature.

Reduced, not re-rendered: the fold happens in `reduceEvents`, so it is a pure
function with tests rather than a component that hides rows. Six of them, one per
way it could be wrong — including that a lone notice stays a sentence rather than
becoming a group of one, and that two agents in one room never fold into each
other.

Verified against real hooks: a session started **in** the hook repo, seven
firings on disk, one row on screen.

### A trap worth recording, met while measuring this

The first two attempts measured nothing and looked like a clean result: zero hook
notices, and zero hooks firing on disk. The cause is documented behaviour, in a
comment on the method itself — `setProjectDirectory` "does not move an agent's
shell: those were started with a working directory and keep it". The session had
been started at home and pointed at the hook repo afterwards, so the agent never
ran there and the repo's hooks were never its hooks.

The reason it is worth writing down is that it produced a **plausible** wrong
answer rather than an error: "no hook noise" is exactly what someone hoping to
close this question would want to read. Hooks were only proved to work at all by
running the raw SDK against the same directory and watching a file on disk grow.
