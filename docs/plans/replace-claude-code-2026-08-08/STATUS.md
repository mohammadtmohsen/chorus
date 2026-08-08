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

## Phase 2 — Permissions, properly

Mostly unlocked by #35: the prompt text is through and "always" writes a real
rule. What remains is **plan mode**, and it needs a decision before it needs
code: `permissionMode` is pinned to `'default'` and `ProviderPermissionMode`
admits only `'default' | 'acceptEdits'`, so entering plan mode is a protocol
change — and where the toggle lives (per conversation, like the profile, or per
message, like the CLI treats it) is a product question rather than a technical
one.

## Phases 3-5

Not started. Phase 3 is checkpoints, background tasks and manual compaction —
the first blocked at the root by `enableFileCheckpointing`, which is one option.
Phase 4 is the unused SDK surface that is cheap to reach. Phase 5 should not
start before Phase 2.
