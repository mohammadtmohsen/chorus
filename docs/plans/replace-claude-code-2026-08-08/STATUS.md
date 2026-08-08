# Status

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

**Checkpoints are blocked on something the plan did not see.**
`enableFileCheckpointing` is indeed one option, but the option is not the
prerequisite. `rewindFiles(userMessageId)` wants **the CLI's own uuid for a user
message**, and Chorus has never recorded one: it logs its own `user.message`
event with its own id, and `mapping.ts` reads `uuid` only from `system/init` and
from assistant messages. Live `SDKUserMessage`s do carry one, so the path exists
— capture it, correlate it with our event, and only then can a "rewind to here"
affordance point at anything.

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

### A second flake, still open — and three explanations it is not

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

So it is none of the obvious three. The next person should reproduce it
**in-suite** rather than in isolation, since that is the only place it has ever
happened, and instrument `options`, `mention` and `participants` at the moment
of failure rather than reasoning about them.

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

## Phase 5

Not started. Should not start before its own prerequisites.
