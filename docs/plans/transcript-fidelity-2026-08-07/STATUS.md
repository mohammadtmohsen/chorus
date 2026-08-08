# Status

## Phase 1 done: Honesty

Named the anonymous approval card, and corrected three capability flags that
claimed abilities the adapter does not have.

**Changed**

- `packages/agent-protocol/src/approval.ts` — `PermissionGrantApproval` gains
  optional `toolName` and `input`.
- `packages/adapter-claude/src/mapping.ts` — `mapToolPermission` populates both
  on the catch-all branch.
- `apps/desktop/src/renderer/src/transcript.ts` — `summarize` now branches on
  `kind === 'mcpToolCall'` before reading `toolName`, then falls back to the bare
  tool name. `detailOf` needed no change: it already renders a bare `input`, so
  the card gained its detail body for free once `input` was carried.
- `packages/adapter-claude/src/claude-adapter.ts` — `fork`, `planStream` and
  `modelSwitchMidSession` set to `false`, with a comment recording what each
  would need to become true again.

**Verification** — `pnpm run check` green: 18 typecheck tasks, eslint, prettier,
753 tests passing. Five new tests, confirmed running by name rather than by
suite total.

**Notes for the next phase**

- The `summarize` trap called out in the plan was real and is now covered by a
  regression test (`does not pass a named non-MCP tool off as an MCP call`).
- Capability flags have no consumers today — `packages/agent-protocol/src/conformance.ts:79`
  only asserts they are booleans. Nothing branched on them, so flipping them
  changed no behaviour. Worth knowing when Phase 4 flips
  `modelSwitchMidSession` back: the flag alone will not wire anything up.
- Not yet verified in the running app. Reaching a `permissionGrant` card needs a
  tool that is neither Bash nor an edit (`WebFetch` is the easiest trigger), and
  a profile that does not auto-allow it.

## Phase 2 done: Notices

Inverted the adapter's default. `mapSdkMessage` answered every unrecognised
message with `[]`; it now answers with a notice, and the `system` case grew from
a single `subtype === 'init'` guard into a mapping.

**Changed**

- `packages/agent-protocol/src/events.ts` — `Notice` and `NoticeSource`, added
  to `AgentEvent`. Left out of `UNDROPPABLE`: losing one under backpressure
  costs information but cannot wedge a turn.
- `packages/event-store/src/events.ts` — `notice.raised`, with `detail`
  nullable rather than optional, matching `userinput.answered.answers`.
- `packages/orchestrator/src/conversation-service.ts` — `case 'notice'`.
- `packages/adapter-claude/src/mapping.ts` — `mapSystem`, covering
  `hook_response`, `permission_denied`, `api_retry`, `local_command_output`,
  `informational` and both model-refusal subtypes; `SystemFields`; and
  `QUIET_SUBTYPES`.
- `apps/desktop/src/renderer/src/transcript.ts` — `notice.raised` reduces to a
  notice message carrying `level`, `noticeSource` and `detail`.
- `apps/desktop/src/renderer/src/Entry.tsx` + `styles.css` — translated source
  label, severity on the label rather than the row, folded `<details>` body.
- `apps/desktop/src/renderer/src/i18n/en.json` — `notice.*`.
- `projections.ts` and `catchup.ts` — explicit no-op cases (see below).

**Two design decisions worth carrying forward**

1. **`QUIET_SUBTYPES` exists because notices are durable.** `status` is the
   spinner's heartbeat; a naive catch-all would have appended a SQLite row per
   tick for as long as a turn ran. `compact_boundary` is quiet because the
   `PostCompact` hook already produces `context.compacted` — mapping it here
   too would double the row. Telemetry is the one thing silence is still right
   for, so the exemption is an explicit five-item list, not a default.
2. **A successful hook with no output produces nothing.** `hook_response` fires
   per matching tool call; a repo with a dozen hooks would otherwise put a dozen
   rows between every command and its output.

**Verification** — typecheck, eslint, prettier and all 263 tests across
`adapter-claude`, `event-store`, `orchestrator` and `transcript` green. Twelve
new tests.

One pre-existing test, `stays silent for message types it does not render`, was
asserting exactly the behaviour this phase reverses. It is now
`no longer stays silent…` and points at the new suite.

**The linter caught two things worth recording.** `switch-exhaustiveness-check`
flagged `projections.ts` and `catchup.ts` — both switches list every event type
deliberately so a new one has to be considered rather than silently vanishing.
Notices are a no-op in both: no query asks "which notices", and replaying our
harness's chatter into the _other_ agent's catch-up would spend a strictly
budgeted summary on something it cannot act on.

**Not verified in the running app.** The cheapest trigger is a repo with a
`PreToolUse` hook that exits non-zero — `example-app` has thirteen hooks.

## Phase 3 done: Tools and subagents

Every tool call is now visible, and a subagent's work nests under the call that
spawned it. `mapAssistant` reported only `Bash`; a turn that read six files and
searched twice rendered as a pause.

**Changed**

- `packages/agent-protocol/src/events.ts` — `ToolStarted` / `ToolProgress` /
  `ToolCompleted`. `tool.started` and `tool.completed` are undroppable (a lost
  start hides a row; a lost completion leaves one spinning); `tool.progress` is
  the only part that repeats, so it stays coalescable.
- `packages/event-store/src/events.ts` — the three payloads.
- `packages/orchestrator/src/conversation-service.ts` — three cases.
- `packages/adapter-claude/src/mapping.ts` — `mapAssistant` emits `tool.started`
  for every non-Bash tool; `mapToolResults` closes them; `mapSystem` handles
  `task_started` / `task_progress` / `task_notification`; `describeToolInput`.
- `apps/desktop/src/renderer/src/transcript.ts` — tool rows merged by `toolRef`.
- `Entry.tsx`, `styles.css`, `en.json` — one dense line per call, status dot,
  indent when nested.
- `projections.ts`, `catchup.ts` — explicit no-ops.

**Where the plan was wrong, and what the SDK actually says**

The plan assumed subagents thread through `parent_tool_use_id`. They do not:
`task_*` keys on `task_id`, with `tool_use_id` **optional**. Consequences:

- The ref is `tool_use_id ?? task_id`. With a `tool_use_id` it merges into the
  `Task` row `mapAssistant` already made; without one — workflow tasks — it gets
  a row of its own, which is right, because no tool call preceded it.
- `task_updated` is now in `QUIET_SUBTYPES`. It is a patch keyed on `task_id`
  alone, so there is nothing to correlate it with when the task began as a tool
  call, and attaching it to the wrong row is worse than not showing it.
  `task_notification` reports the same ending and does carry a `tool_use_id`.
- `skip_transcript` is honoured on `task_started` and `task_notification` — the
  SDK asking us not to show housekeeping tasks inline.

**Three judgement calls**

1. `AskUserQuestion` gets no tool row. It already has a surface, and a second
   row would sit a tool call next to the question it _is_.
2. On completion the summary only fills a subject that is still empty. For a
   subagent the summary is the point; for a `Read` it is the first line of the
   file, which says less than the path already shown.
3. Non-Bash results still do **not** become `command.output`. The content is the
   agent's own working and the agent narrates it; only the fact that the call
   ended is recorded.

**Verification** — full `pnpm run check` green: 18 typecheck tasks, eslint,
prettier, **842 tests**. Twenty-three new tests.

A second pre-existing test asserting the old silence,
`ignores results from tools that were not commands`, is now
`closes a non-command tool without reporting its output as output`.

**Open, and deliberately not built.** Plan question 2 — whether cheap reads
should hide behind a per-session "show tool calls" toggle — is unanswered. Rows
are compact one-liners rather than hidden, which is the cheap half of the
recommendation; the toggle would need state in `Session.tsx` and a home in the
workspace snapshot.

**Not verified in the running app.** A turn that greps and reads is the trigger;
a subagent needs a `Task` call.

## Phase 4a done: Context window

Split from model selection, which is untouched — the two share a phase in the
plan but nothing in the code, and context fill is the half that warns you before
a compaction.

**Changed**

- `packages/agent-protocol/src/events.ts` — `ContextUsage`.
- `packages/adapter-claude/src/mapping.ts` — `mapContextUsage`.
- `packages/adapter-claude/src/claude-adapter.ts` — `readContextUsage`, called on
  `result`.
- `packages/orchestrator/src/conversation-service.ts` — `onContextUsage` option
  and `ContextWindow`.
- `apps/desktop/src/main/runtime.ts`, `ipc.ts`, `shared/ipc.ts`,
  `preload/index.ts` — a `agents:context` push channel beside `agents:limits`.
- `apps/desktop/src/renderer/src/App.tsx`, `workspace/store.ts`,
  `workspace/hooks.ts`, `workspace/Workspace.tsx`, `styles.css`, `en.json` —
  `contextByActor` on the pulse, shown on the sidebar card.

**The load-bearing decision: this is state, not history.**

It is never written to the event log, which puts it in the same category as
`LimitsUpdated` and for the same stated reason. Compaction resets it, so a stored
series would read as a history of a number that repeatedly went backwards for
reasons the log does not explain. That is why it needs its own push channel
rather than a `ChorusEventPayload`, and why `reducePulse` copies it forward
untouched — a reducer that rebuilds the pulse from an event must not be able to
erase something no event reports. That hazard is the one thing this phase has a
regression test for.

**Four smaller calls**

1. Read at turn boundaries, not on a timer. The figure cannot move until the
   agent has said something, and "should I start a fresh conversation" is a
   between-turns question anyway.
2. `percentage` is on the response and is ignored — the types do not say whether
   it is a fraction or a percentage, and the rate-limit shapes in this same file
   already cost a release to exactly that ambiguity. `totalTokens / maxTokens` is
   unambiguous.
3. `maxTokens`, not `rawMaxTokens`: the former is the ceiling the agent actually
   compacts against.
4. Per actor, and the card shows the **fullest** participant. Two agents in one
   conversation keep separate contexts; an average would hide the one about to
   compact behind the one that just joined. Hidden below 50% — a figure that
   reads 4% all day is one you stop seeing.

**Verification** — full `pnpm run check` green: 18 typecheck tasks, eslint,
prettier, **850 tests**. Seven new tests. `reducePulse` is now exported, as
`transcript.ts`'s reducer already was, so the erase hazard is covered.

**Not verified in the running app.** Needs a conversation past half its context
window, so it will not show on a fresh session.

## Phase 4b done: Model selection

You can now choose which model an agent answers as, mid-conversation. Before
this there was no way to pick a model anywhere in Chorus: `setModel` existed with
no caller, and `SessionOpts.model` was never set at either construction site.

**Changed**

- `packages/agent-protocol/src/adapter.ts` — `ModelChoice`, and
  `AgentSession.supportedModels?()`.
- `packages/adapter-claude/src/claude-adapter.ts` — `supportedModels()`;
  `modelSwitchMidSession` back to `true`.
- `packages/orchestrator/src/supervisor.ts` — forwards both, and **remembers the
  choice**.
- `apps/desktop/src/main/runtime.ts` — `listModels` (cached per participant) and
  `setModel`.
- `shared/ipc.ts`, `main/ipc.ts`, `preload/index.ts` — `conversation:models`,
  `conversation:setModel`.
- `renderer/src/workspace/Workspace.tsx`, `styles.css`, `en.json` —
  `ModelPicker` on the sidebar card.

**The correctness point: the supervisor remembers.** A supervised session is
replaced under the caller after a crash, and a model set before that would
silently revert — the control would still show the choice while the agent
answered as something else. `chosenModel` is held in `SupervisedSession` and
re-applied to whatever session comes back.

**Three smaller calls**

1. The list is **asked of the running CLI**, never hardcoded. The installed
   `claude` self-updates, so a list compiled into Chorus would be wrong the week
   after it shipped. A CLI too old to answer returns empty.
2. Empty means **the picker does not render**. An empty dropdown implies a
   choice that does not exist.
3. Cached per participant. Every sidebar card wants the list and asking is a
   control request to a live CLI; the list cannot change while a session runs.

A native `<select>`, not the portal listbox the profile chip uses — the options
come from the provider and there is nothing to draw beyond them, so the platform
control is smaller and better with a keyboard.

**Verification** — full `pnpm run check` green: 18 typecheck tasks, eslint,
prettier, **876 tests**.

**Not verified in the running app,** and this one is the least certain of the
recent phases: whether `supportedModels()` answers at all depends on the
installed CLI, and the whole control hides itself when it does not. If no picker
appears on a card, that is the thing to check first.
