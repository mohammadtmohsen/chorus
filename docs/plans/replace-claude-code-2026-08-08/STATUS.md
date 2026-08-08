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

**Still not done:** dialogs, carried over from Phase 0. `onUserDialog` unset
means the CLI applies its own defaults silently. It needs `supportedDialogKinds`
and a blocking dialog surface, and the only documented kind is
`refusal_fallback_prompt`.

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

**Background tasks** remain: `backgroundTasks()` and `stopTask()` unused, and
`background_tasks_changed` still renders as a notice reading literally
"background_tasks_changed". Note there is no enumeration query — state has to be
accumulated from turn zero, so a client attaching mid-session cannot recover it.

## Phase 4 — the unused SDK surface

### Started: MCP server health

`mcpServerStatus()` is read and shown in Settings, so a server stuck in
`needs-auth` says so instead of silently handing its agent no tools. On this
machine that is `slack`, which had been failing quietly.

**Still to do:** `supportedAgents()`, `accountInfo()`, and the rest of the
`getContextUsage()` payload, of which one number is currently shown.

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
