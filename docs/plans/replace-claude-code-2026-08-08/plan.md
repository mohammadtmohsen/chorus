# Replacing Claude Code

Make Chorus the place this work happens, so the terminal is a thing you keep
installed rather than a thing you open.

## The honest version of the goal

"Replace Claude Code completely" is not achievable, and the reason is worth
stating before any phase list, because it decides what the phases are for.

The CLI registers about a hundred slash commands. Fifteen of them carry a
`thinClientDispatch` field, which is the CLI's own declaration of how a
non-terminal client may invoke them:

```
thinClientDispatch:"post-text"       clear, compact, autocompact, goal, mcp,
                                     recap, reload-skills, skill-doctor,
                                     pause-memory
thinClientDispatch:"control-request" btw, context, usage, reload-plugins
thinClientDispatch:"twin"            mcp, skill-doctor
```

Everything else — `/diff`, `/permissions`, `/config`, `/theme`, `/export`,
`/copy`, `/rewind`, `/tasks`, `/status`, `/plugin`, `/resume`, `/insights` — is
registered `type:"local-jsx"`: React components drawn by the terminal UI, with
no dispatch path of any kind. They are not hidden behind an undocumented method.
There is no method.

That is not the only ceiling. Searching 7,149 lines of `sdk.d.ts` for "todo"
returns exactly two hits, both the `todoFeatureEnabled` setting: no message
subtype, no method, no hook, no control request. The plugin lifecycle —
install, update, browse, add a marketplace — has no API at all; `Options.plugins`
accepts `{type:'local', path}` and nothing else. `/rewind` restores _files_ via
`rewindFiles()`; the conversation half has no equivalent. `file_suggestions`
sits on the wire at `sdk.d.ts:3041`, documented as returning "the same
fuzzy-matched results the TUI shows", and `Query` exposes no method for it.

So the target is not parity. The target is: **the things you do every day, done
well enough that opening the terminal stops being the reflex.** Where the SDK
gives us the mechanism we should use it exactly; where it gives us nothing we
should either rebuild the feature honestly or decide not to have it. What we
must not do is imply a feature exists when it is a shell.

Concretely, the terminal keeps: `/plugin`, `/rewind`'s conversation half,
`/config`, `/theme`, `/export`, `/status`, `/insights`, worktrees, voice, Chrome
and IDE integrations. Nothing in this plan closes those, and a phase claiming to
would be lying.

## Phase 0 — Things that are already wrong

Ahead of any new surface, because three of these are load-bearing and one makes
a shipped feature dead.

1. **`includeHookEvents` is never set**, so `hook_started` / `hook_progress` /
   `hook_response` never arrive. The whole conditional hook treatment in
   `mapping.ts:245-267` is unreachable except for SessionStart and Setup, which
   the SDK always emits. Hook notices shipped and do nothing. One option.
2. **`canUseTool` discards its third argument.** `claude-adapter.ts:727` is
   `(toolName, input) => …`; the options object carries `suggestions`
   (the always-allow set), `title` — the pre-rendered sentence "Claude wants to
   read foo.txt" — `displayName`, `description`, `blockedPath`,
   `decisionReason`, `matchedAskRule` and an abort `signal`. Without returning
   `suggestions` back as `updatedPermissions` there is no protocol-correct
   "always allow" at all; what Chorus has is a parallel mechanism that the CLI
   knows nothing about. This is the single highest-value line in the adapter.
3. **A resumed session re-emits history.** `SDKUserMessageReplay` carries
   `type:'user'` and `mapToolResults` cannot tell it from a live message, so
   resuming replays `command.*` and `tool.completed` for tool results that
   already happened.
4. **Every CLI dialog is silently cancelled.** `onUserDialog` is unset and the
   SDK's contract is that an unhandled dialog is answered `cancelled` and the
   CLI applies its default. Chorus is making choices on the user's behalf with
   no trace. Same for `onElicitation`: an MCP server asking for input gets
   nothing.
5. **`interrupt()`'s receipt is discarded**, so queued async messages that
   survive a stop are invisible and uncancellable.

## Phase 1 — The composer

The weakest part of the app and the reason the terminal still wins. Everything
here lives in one place today: `Session.tsx` is 1,653 lines and the `Session`
component is ~1,180 of them with about twenty-five pieces of state, composer
concerns interleaved with transcript concerns.

**1a. Extract `Composer.tsx` first.** Near-mechanical: the composer's only
inbound couplings to the rest of `Session` are `draft`/`setDraft` (used by
`quoteSelection`), `input.current?.focus()`, and `following.current`. Doing this
before adding anything is what keeps the next four items from landing in a
1,600-line file.

**1b. Slash commands.** `supportedCommands()` for the catalogue,
`commands_changed` for live updates, a `/` menu beside the existing `@` one.

Two things make this more than "the `@` menu with a different character":

- The trigger rule differs. `@` fires at any word start; `/` must fire at column
  zero only, or every `src/foo` opens the menu. That is a different rule, not a
  parameter.
- Dispatch differs per command. The fifteen with `thinClientDispatch` are
  invocable; the rest are not. The menu must show what it can actually run, or
  it becomes a list of things that quietly do nothing. Read the field, offer
  those, and say plainly that the others live in the terminal.

`local_command_output` already renders as a notice, so output has somewhere to
go the moment a command can be sent.

**1c. File mentions.** The SDK expects the _host_ to answer a `file_suggestions`
control request, and gives no method to reach the CLI's own fuzzy matcher — so
this is ours to build: a `files:complete` IPC beside `files:stash`, since the
renderer has no filesystem access. `mentionOptions` becomes one provider among
several rather than a function hardcoded to agent ids, and `MentionOption.agents`
stops being required, since a file has none.

**1d. Images as content blocks.** Today a pasted screenshot is stashed to disk
and its _path_ is appended to the message text; the agent has to `Read` it back.
`AgentInput.attachments` has existed in the protocol since the beginning and is
never populated or read. Threading it properly touches six places — protocol,
IPC schema, `Session.send`, `runtime.send` and its `user.message` payload,
`ConversationService.deliver`, and both adapters — and `withCatchup` wraps
messages as strings, so it needs extending too.

**1e. History and drafts.** Up-arrow recall over sent messages, and drafts that
survive a quit. There is no SDK surface for prompt history — the CLI's
`~/.claude/history.jsonl` is its own — so this is a local ring buffer. Drafts
today live in an in-memory carry map and die with the process.

## Phase 2 — Permissions, properly

Phase 0 item 2 is the prerequisite; this is what it unlocks.

- Render the SDK's own prompt text (`title`, `description`, `blockedPath`,
  `matchedAskRule`) instead of the summary Chorus composes.
- Return `suggestions` as `updatedPermissions` so "always allow" writes a real
  rule at the scope the user picked — `PermissionUpdate` carries `destination`
  of user/project/local/session settings.
- Report `decisionClassification` so the CLI's telemetry is not wrong about
  what happened.
- Honour the abort `signal`, and use `deny.interrupt` where denying should stop
  the turn.
- **Plan mode.** Structurally unreachable today: `permissionMode` is pinned to
  `'default'` and `ProviderPermissionMode` admits only `'default' |
'acceptEdits'`. Add `'plan'`, render `ExitPlanMode` as a plan with an
  approve-to-execute gate rather than the generic grant card it falls into now.

## Phase 3 — Session control

- **Checkpoints.** `enableFileCheckpointing` is never set, which is why
  `rewindFiles()` can never succeed. Turn it on, offer rewind-to-message with
  the `dryRun` preview the API provides. Be explicit in the UI that this
  restores _files_, not the conversation — the conversation half does not exist
  for any client.
- **Background tasks.** `backgroundTasks()` and `stopTask()` are unused;
  `background_tasks_changed` currently renders as a notice reading literally
  "background_tasks_changed". There is no enumeration query, so state must be
  accumulated from turn zero — a client attaching mid-session cannot recover it.
- **Compaction.** No `compact()` exists; `/compact` is `post-text`, so manual
  compaction is a message. Cheap once Phase 1b can send one.
- **Resume picker.** The nine file-level session helpers (`listSessions`,
  `getSessionInfo`, `forkSession`, …) are richer than the history sheet built in
  #22, which reads Chorus's own log. Worth reconciling: two lists of
  conversations that disagree would be worse than one.

## Phase 4 — What the SDK does well

Cheap wins, all currently unused: `mcpServerStatus()` so a server stuck in
`needs-auth` is visible rather than mysteriously absent; `supportedAgents()` and
`AgentDefinition` for subagent selection; `reloadSkills()` / `reloadPlugins()`;
`accountInfo()` for the account panel that today is fed only by the experimental
usage call; the full `getContextUsage()` payload, of which Chorus shows one
number and which carries per-category tokens, MCP tool costs and the
auto-compact threshold.

## Phase 5 — Rebuild or decline

Features with no API, where the only options are reimplementation or an honest
absence.

- **Todo panel.** Reconstructable only by intercepting `TodoWrite` tool inputs
  and replaying them. Doable, and a commitment to a tool's private schema.
- **Plugin browser.** Requires parsing `~/.claude/plugins/*.json` or shelling
  out to `claude plugin`. The second is more honest and less likely to rot.
- **Status line, output-style picker, workspace diff, live rename.** Each is
  either settings-only or on the wire with no method.

Nothing here should start before Phases 0-2 are done.

## What we are not doing

- **Not reimplementing eighty-five TUI commands.** A menu of entries that
  silently do nothing is worse than not having the menu.
- **Not pretending about the conversation rewind.** Files only, said plainly.
- **Not building an editor.** That was considered and set aside earlier; it is a
  different product question and does not belong in a parity plan.
- **Not using the undocumented runtime methods** (`askSideQuestion`, `setCwd`,
  `cancelAsyncMessage`, `mcpAuthenticate`, `enableRemoteControl` …). They exist
  in `sdk.mjs` and are stripped from the types, which is the maintainers saying
  no. `cancelAsyncMessage` is the one worth revisiting if queued-message
  cancellation matters, and only with that risk stated.

## Open questions

1. Slash commands: show only the fifteen dispatchable ones, or show all hundred
   with the rest marked terminal-only? Leaning the former — a disabled row is
   still a promise the app cannot keep.
2. The history sheet from #22 reads Chorus's log; `listSessions()` reads the
   CLI's. Which is authoritative when a conversation exists in both?
3. Does plan mode belong per conversation, or as a composer toggle for the next
   message? The CLI treats it as a session mode; Chorus's per-conversation
   profiles suggest the former.
4. `includeHookEvents` will make hook activity visible for the first time. On a
   repo with a dozen hooks that may be a great deal of noise — do notices need
   a per-source filter before it goes on?
