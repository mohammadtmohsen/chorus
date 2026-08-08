# Transcript fidelity

Make the Chorus transcript say what the agent is actually doing, so a developer
supervising four projects can tell a working agent from a stuck one without
opening a terminal.

## The problem

`mapSdkMessage` handles six of the SDK's message discriminants and answers every
other one with `[]` (`packages/adapter-claude/src/mapping.ts:133-137`). Within
the cases it does handle, `system` keeps only `subtype === 'init'`
(`mapping.ts:111`), `assistant` keeps only `tool_use` blocks named `Bash`
(`mapping.ts:202-214`), and `user` keeps only `tool_result` blocks belonging to a
tracked Bash id (`mapping.ts:234-240`).

The comment says so plainly:

> Hooks, task progress, retries, rate-limit notices and the rest are not
> rendered. Silence here is a decision, not a gap.

That was the right decision when Chorus was a review surface reading a finished
diff. It is the wrong default now that Chorus is meant to be the only window on
several agents at once. The data already arrives, already costs nothing to
receive, and is thrown away one line before it could be shown.

What that silence covers today, worst first:

| Dropped                                                | What the user sees instead                     |
| ------------------------------------------------------ | ---------------------------------------------- |
| `task_started` / `task_progress` / `task_notification` | A subagent runs for four minutes as three dots |
| `hook_started` / `hook_progress` / `hook_response`     | A `PreToolUse` hook blocks a tool, silently    |
| `local_command_output`                                 | A slash command runs and prints nothing        |
| `permission_denied`                                    | A rule denies a tool with no trace             |
| `api_retry`, `status`                                  | A retry storm is indistinguishable from a hang |
| every non-Bash `tool_use`                              | Read, Grep, Glob, Task, TodoWrite: no entry    |

Two smaller things are outright wrong rather than merely quiet, and belong in the
same pass because they are the same kind of dishonesty:

- `CLAUDE_CAPABILITIES` claims `planStream: true`, `fork: true` and
  `modelSwitchMidSession: true` (`packages/adapter-claude/src/claude-adapter.ts:59-63`).
  None are backed. `plan.updated` is emitted only by the Codex adapter, there is
  no fork method on `AgentSession`, and `setModel` has no caller.
- An approval for any tool that is not Bash/Edit/Write/NotebookEdit/`mcp__*`
  becomes an anonymous `permissionGrant` (`mapping.ts:616-623`) carrying no tool
  name, so `summarize` falls through to `return kind`
  (`apps/desktop/src/renderer/src/transcript.ts:602`) and the card reads
  **"claude wants approval / permissionGrant"**. That is the card you get for
  `Task`, `WebFetch`, `TodoWrite` and `ExitPlanMode`.

## The shape

One new event family, one new catch-all event, and two corrections.

### `tool.*` — what the agent is doing, including subagents

`command.*` stays exactly as it is. It has stdout/stderr and an exit code, and
Bash is the only thing with those semantics. Everything else becomes:

```ts
export interface ToolStarted extends AgentEventBase {
  readonly type: 'tool.started'
  readonly itemRef: string
  readonly name: string
  /** The SDK's `parent_tool_use_id`. Set when this call is inside a subagent. */
  readonly parentRef?: string
  /** One line, already summarised — a path, a pattern, a subagent's brief. */
  readonly detail?: string
}

export interface ToolProgress extends AgentEventBase {
  readonly type: 'tool.progress'
  readonly itemRef: string
  readonly note?: string
  readonly elapsedMs?: number
}

export interface ToolCompleted extends AgentEventBase {
  readonly type: 'tool.completed'
  readonly itemRef: string
  readonly status: 'ok' | 'error'
  readonly summary?: string
}
```

The reason this one family covers subagents too: a `Task` call **is** a tool
call, and the SDK already threads `parent_tool_use_id` through every message a
subagent produces (`sdk.d.ts:4554`, declared on our own `SdkMessageLike` at
`mapping.ts:63` and never read). Nesting falls out of the data rather than
needing a parallel `task.*` family, and `system/task_progress` maps onto
`tool.progress` for the parent ref without a second code path.

### `notice` — everything the harness says about itself

```ts
export interface Notice extends AgentEventBase {
  readonly type: 'notice'
  readonly level: 'info' | 'warn' | 'error'
  readonly source: 'hook' | 'command' | 'retry' | 'denial' | 'system'
  readonly text: string
  readonly detail?: string
}
```

One event rather than five, because the renderer's job is identical for all of
them — a muted line, expandable when there is detail — and because the SDK adds
subtypes faster than we will add cases. A new `system` subtype we have not
mapped should degrade to a notice, not to silence. That inverts the current
default, which is the whole point of this plan.

`notice` is coalescable: unlike an approval, dropping one under backpressure
loses information but does not wedge a turn.

### Two corrections

**Name the anonymous card.** `PermissionGrantApproval` gains
`readonly toolName?: string`, populated at `mapping.ts:616-623`.

There is a trap in `summarize` worth calling out before it is written: the
function checks `typeof r['toolName'] === 'string'` at `transcript.ts:598` and
defaults `serverName` to `'mcp'` at `:599`. Adding `toolName` to a
`permissionGrant` without touching that branch makes every `Task` approval read
**"mcp: Task"**, which is worse than the bug being fixed. The MCP branch must
require `serverName` before it claims the payload.

**Tell the truth in `CLAUDE_CAPABILITIES`.** `planStream: false`, `fork: false`.
`modelSwitchMidSession` becomes true only in the phase that gives it a caller.

## Phases

### Phase 1 — Honesty

No new events; the smallest change with a visible result.

- `claude-adapter.ts:59-63`: `planStream: false`, `fork: false`,
  `modelSwitchMidSession: false`.
- `PermissionGrantApproval.toolName` in `packages/agent-protocol/src/approval.ts`,
  populated in `mapToolPermission`.
- `summarize` (`transcript.ts:583-603`): require `serverName` on the MCP branch;
  add a `toolName`-only branch beneath it. `detailOf` (`:566-581`) already
  handles a bare `input`, so an unknown tool's arguments render with no change
  there — but `permissionGrant` does not carry `input` today and should start to.
- Unit tests in the existing `mapping` and `transcript` suites: an unknown tool
  produces a named card; an MCP tool is unchanged.

### Phase 2 — Notices

- `Notice` in `packages/agent-protocol/src/events.ts`, added to `AgentEvent`,
  left out of `UNDROPPABLE`.
- `mapSdkMessage`: replace the `subtype === 'init'` guard with a switch over the
  subtypes worth surfacing — `hook_response` (and `hook_started` only when it
  blocks), `local_command_output`, `informational`, `permission_denied`,
  `api_retry`, `model_refusal_fallback`, `model_refusal_no_fallback`. The
  `default` arm becomes a low-level `notice` carrying the subtype, not `[]`.
- Renderer: a `notice` row in `Entry.tsx`, muted, with the existing
  "Show thinking" disclosure pattern reused for `detail`.
- i18n keys under `transcript.notice.*`. No hardcoded strings.
- Event-store round-trip test, since `notice` is the first new payload type since
  the projections were written — confirm `applyToProjections` needs no change.

### Phase 3 — Tools and subagents

- The `tool.*` family in the protocol; `isCoalescable` false for
  `tool.started`/`tool.completed`, true for `tool.progress`.
- `mapAssistant` (`mapping.ts:202-214`): keep the Bash branch, emit `tool.started`
  for every other `tool_use` block, carrying `parent_tool_use_id` as `parentRef`.
- `mapToolResults` (`:229-262`): non-Bash results become `tool.completed`.
  `trackBashTools` stays; a second set is not needed if the result carries the id.
- `system/task_started|task_progress|task_updated|task_notification` map onto the
  same family against the parent ref.
- Renderer: nested rows under their parent, collapsed by default. A subagent
  shows name, brief, elapsed, and last tool.
- The reduction lives in `transcript.ts` and is unit-tested the way the existing
  reducers are — `mapping.ts` is pure by design (`mapping.ts:18`), so this is all
  replay-testable with no process.

### Phase 4 — Context and model

- `Query.getContextUsage()` on a timer and after each `result`; new
  `context.usage` event; render in `SummaryPanel` beside tokens and in the
  sidebar row. This is Claude Code's `/context`, and it is what tells you a
  session is about to compact.
- Wire `SessionOpts.model`: pass it from settings through `runtime.ts:240-248`
  and `:804-811`, add a model control to `Settings.tsx`, call `setModel`
  (`claude-adapter.ts:170-172`) for mid-session switching, then set
  `modelSwitchMidSession: true` honestly.
- `Query.supportedModels()` for the list rather than a hardcoded one.

## What we are not doing

- **Not rendering every dropped subtype individually.** The `default → notice`
  arm is deliberately the catch-all. Bespoke rendering for
  `worker_shutting_down` is not worth a case statement.
- **Not touching the approval flow's semantics.** Phase 1 renames a card; it does
  not change what is auto-allowed.
- **Not adding streaming stdout for Bash.** Real, but it is `input_json_delta`
  and background-task work, and it belongs with background tasks rather than
  here.
- **Not building the conversation history browser or OS notifications.** Those
  are the Tier 1 follow-up, tracked separately.

## Open questions for review

1. **`permissionMode: 'acceptEdits'` for every non-read-only profile**
   (`claude-adapter.ts:513`) means file edits are auto-accepted and no card ever
   appears. That is a defensible default for one focused session and a
   surprising one when four projects are running unattended. Leave it, make it a
   per-profile choice, or flip it? This plan does not change it either way.
2. Should `tool.started` for cheap reads (`Read`, `Glob`, `Grep`) be shown by
   default, or collapsed behind a per-session "show tool calls" toggle?
   Recommending collapsed — the noise is what makes people stop reading a
   transcript.
3. `notice` for `api_retry` will fire repeatedly during an overload. Coalesce to
   one row with a count, or one row per retry? Recommending a count.
