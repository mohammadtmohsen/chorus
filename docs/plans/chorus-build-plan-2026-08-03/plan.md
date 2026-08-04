# Chorus — End-to-End Build Plan

**Date:** 2026-08-03
**Status:** Draft — awaiting approval
**Owner:** Claude (plan → implement → review)

---

## 1. What we are building

A local-first macOS desktop app where one developer collaborates with multiple coding
agents (Claude and Codex to start) inside **one shared conversation**, with every
consequential action gated behind a visible approval.

The differentiator is not "a chat UI with two models in it." It is:

1. **A shared transcript with separate agent contexts.** Agents do not see each other's
   history by default; Chorus forwards explicitly selected content. This is what makes
   handoffs meaningful instead of just a bigger prompt.
2. **A unified approval surface.** Two agents with two completely different permission
   protocols present _one_ consistent approval card, backed by one policy engine and one
   audit log.
3. **A durable, replayable record.** Everything is an append-only event. You can
   reconstruct exactly who proposed what, who approved it, and what changed on disk.

Anything that does not serve those three things is out of scope for v1.0.

### Definition of "mature product"

v1.0 ships only when all of these are true:

- [ ] Cold start to first token < 3s; no dropped or reordered stream chunks under load.
- [ ] Killing an agent process mid-turn loses zero transcript data and the UI self-heals.
- [ ] No command runs and no file is written without an approval event in the log.
- [ ] Packaged app runs from `/Applications` with the native module loading correctly.
      _(Signed + notarized + auto-update is the M9 gate, deferred per §10.)_
- [ ] Crash-free session rate ≥ 99.5% over a 2-week internal dogfood.
- [ ] Protocol-drift CI job green against latest `codex` and `@anthropic-ai/claude-agent-sdk`.
- [ ] A new user can install, add a project, and complete the Codex→Claude→Codex loop
      with no documentation beyond in-app affordances.

---

## 2. Research findings that shape the design

These were verified against live docs and the locally installed toolchain on 2026-08-03.

### 2.1 Codex — `codex app-server`

- JSON-RPC 2.0 over **newline-delimited JSON on stdio** (`--listen stdio://`, the default).
  WebSocket and Unix socket are also supported; stdio is the right choice for an embedded
  desktop client.
- Mandatory handshake: `initialize` request → `initialized` notification. The server
  rejects everything sent before the handshake completes.
- **Thread/turn model** maps almost 1:1 onto our domain: `thread/start`, `thread/resume`,
  `thread/fork`, `turn/start`, `turn/steer`, `turn/interrupt`.
- **Streaming** arrives as item events: `item/started`, `item/agentMessage/delta`,
  `item/reasoning/summaryTextDelta`, `item/commandExecution/outputDelta`,
  `turn/diff/updated`, `turn/plan/updated`, `item/completed`, `turn/completed`.
- **Approvals** are _server-initiated requests_, not notifications:
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and
  `item/permissions/requestApproval`. Responses are
  `accept | acceptForSession | decline | cancel`, followed by `serverRequest/resolved`.
- **Sandbox policy is first-class — but there are two different types with nearly the
  same name.** Corrected 2026-08-03 against the generated bindings; the published prose
  docs are wrong here and the values below are what the server actually accepts:
  - `thread/start` takes `sandbox: SandboxMode`, a **string enum**:
    `"read-only" | "workspace-write" | "danger-full-access"`.
  - `turn/start` takes `sandboxPolicy: SandboxPolicy`, a **tagged object** with
    camelCase tags: `{ type: "readOnly", networkAccess }`,
    `{ type: "workspaceWrite", writableRoots, networkAccess, … }`,
    `{ type: "dangerFullAccess" }`, `{ type: "externalSandbox", networkAccess }`.
  - `approvalPolicy: AskForApproval` is `"untrusted"`, `"on-request"`, `"never"`, or a
    `{ granular: … }` object with per-category toggles (`sandbox_approval`, `rules`,
    `skill_approval`, `request_permissions`, `mcp_elicitations`). The `granular` variant
    is undocumented and may map onto our permission profiles better than the presets —
    revisit in M5.
  - Text input requires `text_elements: TextElement[]` alongside `text` — snake_case in
    an otherwise camelCase API.
  - `turn/interrupt` needs **both** `threadId` and `turnId`.
  - `turn/start` **returns immediately** with `{ turn: { id, status: "inProgress" } }`;
    it is not a long-lived request. Streaming arrives as notifications.
- **Experimental methods require opt-in** via `capabilities.experimentalApi: true` in
  `initialize`, or the server rejects them.
- Backpressure is explicit: JSON-RPC error `-32001` "Server overloaded; retry later" →
  the client must retry with exponential backoff + jitter.
- **`codex app-server generate-ts --out <DIR>` emits TypeScript bindings for the whole
  protocol.** Verified present in `codex-cli 0.146.0` — **622 files, 2.5 MB**, current
  protocol under `v2/`. This is the single biggest de-risking lever available and the
  plan builds on it (§6.1). Every correction in the bullet above came from these
  bindings contradicting the prose docs, which is the case for committing them and
  diffing in CI.

### 2.2 Claude — Agent SDK

- Current: `@anthropic-ai/claude-agent-sdk@0.3.220`. It ships a native Claude Code binary
  as a per-platform `optionalDependency` — **`@anthropic-ai/claude-agent-sdk-darwin-arm64`
  unpacks to ~257 MB.** The SDK is a _client library over that binary_, not a
  reimplementation of it.
- **`options.pathToClaudeCodeExecutable` points the SDK at an existing install** —
  verified in `sdk.d.ts`: _"Path to the Claude Code executable. Uses the built-in executable
  if not specified."_ This is what lets us keep the typed SDK API while reusing the user's
  already-installed `claude` (§2.5).
- **The V2 session API is removed.** `unstable_v2_createSession`, `unstable_v2_resumeSession`,
  `unstable_v2_prompt`, `SDKSession`, and `SDKSessionOptions` were deleted in 0.3.142.
  Do not build on them. The supported path is `query()` with an
  `AsyncIterable<SDKUserMessage>` prompt for multi-turn, plus `options.resume`.
- `query({ prompt, options })` returns a `Query` that extends
  `AsyncGenerator<SDKMessage, void>` and adds `interrupt()`, `setModel()`,
  `setPermissionMode()`, `supportedModels()`, `supportedCommands()`, `supportedAgents()`,
  and `close()`. Streaming-input mode is required for `interrupt`/`setModel`/`setPermissionMode`.
- Relevant options: `cwd`, `model`, `permissionMode`, `canUseTool`, `hooks`,
  `includePartialMessages`, `resume`, `forkSession`, `allowedTools`, `mcpServers`,
  `systemPrompt`, `agents`, `settingSources`.
- **`canUseTool` is our approval hook** — it fires when the permission flow falls through
  to a prompt, which is exactly where our approval card belongs.
- `hooks` (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`,
  `PermissionRequest`, `PreCompact`, …) give us lifecycle telemetry without parsing text.

> **Design change vs. the README.** The README proposes "streaming CLI for the private
> local version, Agent SDK for distributed products." Recommend using the **Agent SDK for
> both**. It bundles the binary, gives typed `SDKMessage` events instead of stdout parsing,
> and gives structured `canUseTool` approvals — which is precisely the "reliable
> integrations: use supported programmatic interfaces instead of parsing terminal graphics"
> principle. Maintaining two Claude transports doubles the surface area for zero gain.

**`canUseTool`, verified against `sdk.d.ts@0.3.220`** (the published prose docs are wrong
about this — they show a `request.tool` / `request.args` shape that does not exist):

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal
    suggestions?: PermissionUpdate[] // → feed our "always allow" button
    // + the file path that triggered the request, when applicable
  }
) => Promise<PermissionResult>

type PermissionResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
      toolUseID?: string
    }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string }
```

Two things fall out of this that change the design:

- **`suggestions` is a gift.** The SDK hands us the exact permission rules that would stop
  it asking again this session. Our "allow for session" button should return them as
  `updatedPermissions` rather than us inventing our own rule syntax.
- **There is no timeout.** The `.d.ts` says permission prompts are _"blocked indefinitely —
  permission prompts have no park deadline."_ Codex is the same: an unanswered
  `requestApproval` request just hangs. **Chorus must own approval timeouts on both sides**
  (§4.4), or a user who closes their laptop mid-approval wedges an agent session forever.

`permissionMode` values confirmed as `'default' | 'acceptEdits' | 'bypassPermissions' |
'plan' | 'dontAsk'`.

### 2.5 Can we use the already-installed CLIs? — Yes, and we should

Verified live on this machine on 2026-08-03 (`codex-cli 0.146.0`, `claude 2.1.220`):

|                                | Codex                                                            | Claude                                |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------------------- |
| Transport                      | `codex app-server` **is a subcommand of the installed CLI**      | SDK spawns a Claude Code binary       |
| Reuse installed binary?        | Inherent — there is nothing else to use                          | Yes, via `pathToClaudeCodeExecutable` |
| Auth                           | Uses `~/.codex` — probe returned `"codexHome":"/Users/…/.codex"` | Uses the CLI's own login              |
| Bundle cost if we ship our own | n/a                                                              | ~257 MB per platform                  |

A live handshake probe (`initialize` → `initialized` → `model/list`) against the installed
`codex app-server` succeeded on the first attempt, returning the model list and confirming
it picked up existing auth with no configuration.

**Decision: reuse both installed CLIs.** For Claude, that means using the SDK as the client
library but setting `pathToClaudeCodeExecutable` and installing it with
`--omit=optional` so the 257 MB binary never enters our bundle. We get the typed
`SDKMessage` stream, `canUseTool`, and hooks _without_ the payload — and it keeps the
one-native-module budget (§4.4) intact, since a 257 MB binary would dominate both app size
and notarization time.

This is consistent with the auth decision in §10: Chorus stores no credentials because it
is driving the user's own, already-authenticated CLIs.

**Version drift is a non-issue at personal scope.** Chorus has exactly one user, who is also
the person running `brew upgrade`. A breakage is noticed within one session and fixed. So no
supported-range banner, no graceful-absence onboarding flow, no bundling contingency — those
are product features and §10 defers product. What remains is one field: **record both CLI
versions in the `session.started` event**, so when something breaks the log shows
`claude 2.1.220 → 2.2.0` instead of requiring a guess. The `generate-ts` drift check
(§6.1) stays regardless — it is ~10 lines and it identifies _why_ a break happened. Note the
CLIs self-update, so the upgrade moment isn't fully under our control either way.

### 2.6 Config inheritance — the real consequence of reusing installed CLIs

Verified in `sdk.d.ts`: _"When omitted, all sources are loaded (matches CLI defaults)."_
Driving the installed CLIs means agents inside Chorus pick up `~/.claude/CLAUDE.md`,
`~/.claude/settings.json` (hooks, permissions, env), and the user's configured MCP servers.
Codex likewise reads `~/.codex/config.toml` — which is how the §2.5 probe found auth.

**Decided: inherit everything** (`settingSources` omitted). Agents behave identically to the
same agent in a terminal, which is the least surprising behavior and means the user's
existing global instructions keep applying. No parallel config system to maintain.

**This has one consequence the approval model must absorb.** Inherited MCP servers give
agents _outward-facing_ tools — posting to Slack, transitioning Jira issues, opening GitHub
PRs. Those are not local file edits, and several are irreversible in a way `rm` is not: you
cannot un-send a Slack message. Therefore:

- **`mcpToolCall` is a first-class approval kind**, not a fallthrough. The approval card
  names the server, the tool, and the target (channel, issue key, repo).
- **Outward-facing tools default to ask-every-time.** "Allow for session" is available but
  never the default, and never auto-allowed by a permission profile.
- Codex surfaces these as `mcpToolCall` items; Claude routes them through `canUseTool` with
  an `mcp__server__tool` name. Both map onto the same card.

Without this, "inherit everything" would mean an agent could message a colleague as part of
a turn the user approved for something else entirely.

### 2.3 Electron

- Non-negotiable renderer config: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `webSecurity: true` + strict CSP. Relaxing any one of these turns an
  XSS in a rendered agent message into full RCE — and we render untrusted model output.
- Expose IPC via `contextBridge.exposeInMainWorld` as **one narrow typed method per
  message**. Never expose `ipcRenderer` itself.
- `electron-vite` for dev/build; **Electron Forge 8+** for package/sign/publish.
- macOS distribution requires code signing **and** notarization with Hardened Runtime.
  Every shipped binary is signed individually — including native `.node` modules and
  bundled CLI binaries. One unsigned dylib in `node_modules/` fails notarization with an
  opaque error. This directly constrains our native-dependency budget (§4.4).

### 2.4 Persistence

- `better-sqlite3` remains the fastest and most complete option, with synchronous calls
  (microseconds for our workload), WAL, the backup API, and a mature ecosystem. It is a
  native module → must be rebuilt for Electron's ABI and signed for notarization.
- `node:sqlite` is built into Node 22.13+ and needs no native build, at the cost of a
  thinner API.
- **Decision: `better-sqlite3`**, with a thin `Database` port interface so swapping to
  `node:sqlite` is a one-file change if notarization pain outweighs the benefit.

---

## 3. Architecture

### 3.1 Process model

```
┌────────────────────────────────────────────────────────────────────┐
│ Renderer  (sandboxed, contextIsolation, no Node, strict CSP)       │
│   React 19 + TS · conversation, approval cards, diff view          │
│   State: TanStack Query over IPC + local UI store                  │
└───────────────▲────────────────────────────────────────────────────┘
                │ contextBridge — narrow typed API, zod-validated both sides
┌───────────────┴────────────────────────────────────────────────────┐
│ Main process — the Orchestrator                                    │
│   • Event store (SQLite, WAL, append-only + projections)           │
│   • Conversation router · handoff engine                           │
│   • Policy engine (permission profiles) → approval queue           │
│   • Workspace service (project roots, git, diffs, worktrees)       │
│   • Agent supervisor (spawn / health / restart / backoff)          │
└──────┬──────────────────────────────┬──────────────────────────────┘
       │ utilityProcess (Node)        │ utilityProcess (Node)
┌──────┴───────────────┐      ┌───────┴──────────────┐
│ Codex Adapter        │      │ Claude Adapter       │
│ codex app-server     │      │ @anthropic-ai/       │
│ stdio JSON-RPC 2.0   │      │ claude-agent-sdk     │
│ ↕ codex child proc   │      │ ↕ bundled binary     │
└──────────────────────┘      └──────────────────────┘
```

**Why `utilityProcess` per adapter, not in-main:** an adapter crash, a runaway JSON parse,
or an SDK memory leak must not take down the app or the event store. It also gives us a
clean kill/restart boundary for the supervisor and keeps main's event loop free for
SQLite's synchronous writes.

**Why the orchestrator is in main, not a service process:** it owns the SQLite handle.
SQLite is single-writer; centralizing writes in one process eliminates a whole class of
lock-contention bugs. Writes are small and synchronous — measured in microseconds.

### 3.2 Layering (dependency direction points inward)

```
apps/desktop/renderer   →  UI only, no domain logic
apps/desktop/main       →  wiring, IPC, lifecycle
packages/orchestrator   →  domain: conversation, handoff, policy, approvals  (pure, testable)
packages/event-store    →  append-only log + projections
packages/agent-protocol →  AgentAdapter interface + normalized AgentEvent union
packages/adapter-codex  →  implements AgentAdapter
packages/adapter-claude →  implements AgentAdapter
packages/workspace      →  git, diffs, worktrees, path safety
packages/shared         →  zod schemas, ids, result types, logging
```

`packages/orchestrator` must have **zero** Electron and zero adapter imports. It is where
the interesting logic lives and it must be unit-testable in milliseconds.

---

## 4. Core designs

### 4.1 The `AgentAdapter` port — the most important abstraction

Every provider difference is absorbed here. If this interface is right, adding a third
agent later is a package, not a refactor.

```ts
// packages/agent-protocol/src/adapter.ts
export interface AgentAdapter {
  readonly id: AgentId // 'codex' | 'claude' | …
  readonly capabilities: AgentCapabilities

  start(opts: SessionOpts): Promise<AgentSession>
  resume(sessionRef: string, opts: SessionOpts): Promise<AgentSession>
  health(): Promise<HealthStatus>
  dispose(): Promise<void>
}

export interface AgentSession {
  readonly sessionRef: string // provider-native id (threadId / sessionId)
  send(input: AgentInput): Promise<void> // start or steer a turn
  interrupt(): Promise<void>
  events: AsyncIterable<AgentEvent> // normalized, ordered, at-least-once
  respondToApproval(id: ApprovalId, d: ApprovalDecision): Promise<void>
  setModel?(model: string): Promise<void>
  close(): Promise<void>
}

export interface AgentCapabilities {
  interrupt: boolean
  steer: boolean
  fork: boolean
  reasoningStream: boolean
  planStream: boolean
  aggregateDiff: boolean
  modelSwitchMidSession: boolean
  sandboxPolicy: 'native' | 'emulated' | 'none'
}
```

Capabilities are declared, not assumed — the UI hides a Steer button for an agent that
can't steer instead of failing at runtime.

**Validated by S3 (2026-08-03) with two additions** — see
[spike findings](../../research/spikes-2026-08-03.md):

- Codex has **two similarly named, structurally different sandbox types**:
  `SandboxMode` (a kebab-case string enum) on `thread/start`, and `SandboxPolicy`
  (a tagged object, camelCase) on `turn/start`. Neither may escape the adapter;
  our own `SandboxPolicy` above is the only shape the rest of the app sees.
- `AgentSession` needs to record **whether an interrupt was user-initiated**,
  because Claude reports one as `error_during_execution` / `is_error: true` with
  no distinct status. Without that flag the adapter cannot tell "the user pressed
  Stop" from "the turn crashed", and the UI would show an error card for a normal
  action.

### 4.2 The normalized `AgentEvent` union

Both providers project onto this. Nothing provider-specific leaks past the adapter
boundary except an opaque `raw` field kept for debugging and replay.

| `AgentEvent`           | Codex source                                                 | Claude source                                         |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| `turn.started`         | `turn/started`                                               | first `system`/init message of a turn                 |
| `message.delta`        | `item/agentMessage/delta`                                    | `stream_event` text deltas (`includePartialMessages`) |
| `message.completed`    | `item/completed` (agentMessage)                              | `assistant` message                                   |
| `reasoning.delta`      | `item/reasoning/summaryTextDelta`                            | thinking blocks                                       |
| `plan.updated`         | `turn/plan/updated`                                          | `TodoWrite` tool use                                  |
| `command.started`      | `item/started` (commandExecution)                            | `tool_use` (Bash)                                     |
| `command.output`       | `item/commandExecution/outputDelta`                          | `tool_result`                                         |
| `file.change.proposed` | `item/started` (fileChange)                                  | `tool_use` (Edit/Write)                               |
| `diff.updated`         | `turn/diff/updated`                                          | _(derived — we compute it from the workspace)_        |
| `approval.requested`   | `item/*/requestApproval`, `item/permissions/requestApproval` | `canUseTool` callback                                 |
| `turn.completed`       | `turn/completed` (status)                                    | `result` message (+ cost/usage)                       |
| `usage.updated`        | `thread/tokenUsage/updated`                                  | `result.usage`                                        |
| `error`                | JSON-RPC error / `warning`                                   | thrown error / `result.subtype = error_*`             |

Note the asymmetries and plan for them explicitly:

- Codex gives an **aggregate turn diff** for free; Claude does not → the workspace service
  computes it from git for Claude. Same UI either way.
- Claude's approval is a **synchronous callback we must answer** (the SDK awaits us);
  Codex's is a **JSON-RPC request we must respond to by id**. Both become a promise in the
  approval queue keyed by `ApprovalId`. Both need timeouts.

### 4.3 Event store & data model

Append-only source of truth; everything else is a projection that can be rebuilt.

**S3 promoted this from "good for audit" to load-bearing.** Codex does not persist
partial assistant output: after an interrupt or a crash, `thread/read` returns the
interrupted turn containing only the `userMessage` — everything the agent had already
streamed is gone. Claude preserves it. So the transcript **cannot** be rebuilt from the
providers, and Chorus must persist `message.delta` events as they arrive rather than
waiting for `message.completed`. See [spike findings](../../research/spikes-2026-08-03.md).

S4 also settles the performance question: 10,000 rows insert in ~18 ms in one
transaction, so synchronous writes on the main thread are not a latency concern.

```sql
-- source of truth
CREATE TABLE events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- global total order
  id          TEXT NOT NULL UNIQUE,               -- uuidv7
  conversation_id TEXT NOT NULL,
  actor       TEXT NOT NULL,        -- 'user' | 'codex' | 'claude' | 'system'
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,        -- JSON, zod-validated on write
  created_at  INTEGER NOT NULL,     -- epoch ms
  schema_ver  INTEGER NOT NULL
);
CREATE INDEX events_conv_seq ON events(conversation_id, seq);

-- projections (rebuildable: DELETE + replay)
CREATE TABLE projects       (id, root_path, name, permission_profile_id, created_at);
CREATE TABLE conversations  (id, project_id, title, created_at, updated_at);
CREATE TABLE messages       (id, conversation_id, seq, actor, role, content, status, agent_session_ref);
CREATE TABLE agent_sessions (id, conversation_id, agent_id, session_ref, cwd, model, status, started_at);
CREATE TABLE approvals      (id, conversation_id, agent_id, kind, request, decision,
                             decided_by, decided_at, scope, policy_rule_id);
CREATE TABLE handoffs       (id, conversation_id, from_agent, to_agent, brief, source_event_ids, created_at);
CREATE TABLE projection_state (name, last_seq);
```

Rules:

- Writers append events; projections are updated in the **same transaction** as the append.
- Every projection records `last_seq` → we can detect drift and rebuild.
- Schema migrations are numbered, forward-only, and run at startup inside a transaction,
  with an automatic pre-migration backup via SQLite's backup API.
- **Retention:** raw provider payloads (`raw`) are large; store them in a sibling
  `event_raw` table with a configurable TTL so the main log stays fast.

### 4.4 Security & permission model

**Renderer hardening**

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
- CSP: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`.
  No remote origins. No `webview`. `will-navigate` and `setWindowOpenHandler` deny everything
  not `file://` from our own bundle; external links go to the OS browser.
- **Agent output is untrusted input.** Markdown is rendered through a sanitizing pipeline
  with an explicit allowlist; no raw HTML, no auto-executed links.

**IPC**

- One typed channel per operation, generated from a shared zod schema registry. Validate on
  the main side (always) and on the renderer side (to catch our own bugs). Reject unknown
  channels.

**Policy engine (evaluated before the UI ever sees a request)**

```
ApprovalRequest → PermissionProfile rules → { auto-allow | auto-deny | ask-user }
```

- Profiles are per-project and named: `read-only`, `workspace-write`, `trusted`.
- A profile maps to native provider policy where possible — Codex's `sandbox.type` +
  `approvalPolicy`, Claude's `permissionMode` + `allowedTools` — so we get defense in depth
  rather than relying only on our own gate.
- Rules are declarative and auditable: `{ match: {tool:'Bash', commandPattern:'^git (status|diff|log)'}, effect:'allow', scope:'session' }`.
- **Deny by default** for: `rm -rf`, `git push`, `--force`, credential file paths, and
  network-enabled sandboxes.
- ⚠ **The filesystem is not scoped to the project root.** Decided 2026-08-04, revising an
  earlier rule in this section. Agents may read and reach anywhere the user can, exactly as
  they do in a terminal — which is the same reasoning that settled §2.6: Chorus drives the
  user's own CLIs and should not invent restrictions the terminal does not have. The user
  points an agent at a directory by telling it, not by being fenced in. A `cwd` is a
  starting point, not a boundary.

  What still gates behaviour is the approval, not the path: a write, a command, or an
  outward-facing MCP call needs a decision regardless of where it lands. Scope was never
  what made this safe — the visible approval is.

- **Never auto-allow an outward-facing MCP tool** (§2.6). Local actions are recoverable via
  git; a sent Slack message is not. Profiles may not grant these, only the user, per call.
- Every decision — including auto-allows — writes an `approval.decided` event with the
  `policy_rule_id` that made it. "Human controlled" means auditable, not just clickable.
- **Chorus owns the timeout.** Neither provider imposes one — the Claude SDK blocks
  indefinitely by design, and an unanswered Codex `requestApproval` hangs the turn (§2.2).
  Every pending approval gets a deadline; on expiry we auto-**deny** (never auto-allow),
  write a `approval.timed_out` event, and tell the user which agent is now idle. Claude's
  `AbortSignal` and Codex's `cancel` response are the cancellation paths.
- **"Allow for session" uses the provider's own rules where offered.** Claude's `canUseTool`
  hands us `suggestions` — return them as `updatedPermissions` rather than maintaining a
  parallel rule syntax that can drift from what the agent actually enforces.

**Path safety**

- `resolveWithinRoot(root, candidate)` stays, but its job is narrower than originally
  written. It is **not** a sandbox for agent activity — see the filesystem note above.
- It guards paths **Chorus itself** derives: a project root the user picked, a worktree we
  create, a diff we read. Those must not escape via `..` or a symlink, because that is our
  bug rather than an agent's instruction. Unit-tested against a traversal fixture list.

**Secrets**

- API keys and tokens in the OS keychain via `safeStorage`; never in SQLite, never in logs.
- A redaction pass runs over all transcript text and command output before persistence,
  matching common key formats. Redaction is applied on write, not on read.

**Native module budget**

- Notarization cost scales with native binaries. Budget: **`better-sqlite3` only.** Any
  additional native dependency needs an explicit justification, because each one is another
  thing to rebuild per Electron ABI and sign per release.

### 4.5 Handoffs — the product's core interaction

A handoff is a first-class, persisted entity, not a copy-paste.

```ts
interface Handoff {
  id: HandoffId
  from: AgentId
  to: AgentId
  sourceEventIds: EventId[] // exactly what the user selected
  brief: string // composed packet actually sent to `to`
  includeDiff: boolean
  createdAt: number
}
```

Flow:

1. User selects one or more messages (or clicks **Hand off** on an agent's final message).
2. Chorus composes a brief: selected content + project context + optional current diff +
   an explicit instruction framing ("You are receiving analysis from Codex. Implement it.").
3. **The brief is shown to the user before it is sent.** Editable. This is the moment the
   user controls cross-agent context, and hiding it would break the "explicit context
   sharing" principle.
4. Sent as the next `turn/start` (Codex) or `SDKUserMessage` (Claude).
5. Rendered in the transcript as a distinct handoff card linking both sides.

### 4.6 Streaming & ordering

- Adapters emit events with a monotonically increasing per-session sequence number.
- The orchestrator assigns the global `events.seq` on append — the only total order.
- Renderer receives coalesced deltas (~30ms frames) to avoid re-render storms on fast
  token streams; the store keeps full fidelity.
- Backpressure: bounded queue per session. On overflow, coalesce text deltas (never drop
  lifecycle or approval events) and surface a "stream throttled" indicator.
- Codex `-32001` overload → exponential backoff with jitter in the adapter's RPC client.

**Revised by S5 (2026-08-03):**

- ⚠ **Coalescing may not be built on `requestAnimationFrame` alone.** rAF stops in
  hidden and occluded windows — which is precisely when a long agent turn is most
  likely to be running. A pure-rAF flush stalls and buffers without bound while
  Chorus is backgrounded. Use rAF when visible with a **time-based fallback flush
  and a hard buffer cap** as the floor.
- The frame budget is **8.3 ms, not 16 ms** — the test machine runs at 120 Hz, and
  the original target was written for 60 Hz.
- Coalescing's measured benefit is the tail, not the median: max frame time
  74.6 ms → 9.5 ms, and ~40% fewer React renders. React 19's automatic batching
  hides most of the median cost, so naive rendering looks fine right up until it
  isn't. The measurement used plain text nodes; re-run against the real transcript
  (markdown, highlighting, virtualization) as an M4 exit gate.

---

## 5. Tech stack

| Concern              | Choice                                       | Why                                                  |
| -------------------- | -------------------------------------------- | ---------------------------------------------------- |
| Shell                | Electron (latest stable)                     | Required for local process control + filesystem      |
| Build                | electron-vite                                | Fast HMR, first-class Electron multi-process         |
| Package/sign/publish | Electron Forge 8+                            | `@electron/osx-sign` + `@electron/notarize` built in |
| UI                   | React 19 + TypeScript (strict)               | Per README                                           |
| Styling              | Tailwind + Radix primitives                  | Accessible primitives; no design-system build cost   |
| Renderer state       | TanStack Query over IPC + Zustand            | Server-state vs UI-state split                       |
| DB                   | better-sqlite3 (WAL)                         | Fastest, backup API; behind a port interface         |
| Validation           | zod                                          | One schema registry for IPC + events + config        |
| Monorepo             | pnpm workspaces + Turborepo                  | Enforces the layering in §3.2                        |
| Unit/integration     | Vitest                                       | Speed                                                |
| E2E                  | Playwright (Electron driver)                 | Real app, real processes                             |
| Lint/format          | ESLint (typescript-eslint strict) + Prettier | `no-explicit-any` as an **error**                    |
| Logging              | pino → rotating file + in-app log viewer     | Structured, greppable, redacted                      |
| Errors               | Sentry (opt-in, off by default)              | Local-first: telemetry is a user choice              |
| i18n                 | i18next, wired from day 1                    | Global rule: no hardcoded user-facing strings        |

---

## 6. De-risking: what we prove before we commit

### 6.1 Codex protocol bindings (highest-leverage item)

`codex app-server generate-ts --out packages/adapter-codex/src/generated` produces typed
bindings for the entire protocol. The plan:

1. Generate at setup; **commit the output**.
2. Add a CI job that regenerates against the latest `codex` and **fails on diff**.
3. A failing diff is a real signal — the app-server is explicitly marked `[experimental]`
   and will move under us. This turns silent runtime breakage into a red build.

The same principle applies to Claude: a CI job that type-checks our adapter against the
latest `@anthropic-ai/claude-agent-sdk` and fails on incompatibility. We pin exact versions
in `package.json` and let CI tell us when it's safe to bump.

### 6.2 Spikes (M0) — throwaway code, hard questions

| Spike               | Question it answers                                                                                                                           | Done when                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| S1 Codex stdio      | **PASSED 2026-08-03.** Handshake, thread/turn lifecycle, streaming, interrupt all proven against the installed CLI                            | ✅ See [spike findings](../../research/spikes-2026-08-03.md)                                                           |
| S2 Claude SDK       | **PASSED 2026-08-03.** Real `CanUseTool` signature captured; `pathToClaudeCodeExecutable` + `--omit=optional` proven end to end               | ✅ Drives installed `claude`, 257 MB binary verifiably absent                                                          |
| S3 Interrupt/resume | **PASSED 2026-08-03 — with an asymmetry.** Both interrupt and resume cleanly; Codex survives SIGKILL mid-turn with context intact             | ⚠ Codex discards partial assistant output, Claude preserves it. Forces the event log to be the source of truth (§4.3)  |
| S4 Native module    | ~~Does `better-sqlite3` rebuild for Electron ABI?~~ **PASSED — premise was wrong.** It ships N-API prebuilds and loads with _no_ rebuild step | ✅ WAL on, 10k rows in ~18 ms, backup API works. Signing the `.node` still pending M9                                  |
| S5 Perf             | **PASSED 2026-08-03.** Target tightened from 16 ms to 8.3 ms (120 Hz display)                                                                 | ✅ p99 9.4 ms; coalescing removes a 74.6 ms tail spike. ⚠ rAF stalls when backgrounded — needs a timed fallback (§4.6) |

**On S4 and notarization:** full notarization requires a paid Apple Developer ID, which
"personal now, product later" (§10) defers. So S4 proves the _hard_ half — native rebuild
against Electron's ABI and loading from an `asar`-packaged bundle — and leaves the
notarization round-trip to M9. The mitigation for the deferred half is the
**one-native-module budget** (§4.4), enforced from M0: every additional native dependency
is another binary to sign and another opaque notarization failure later. If that budget
holds, M9 notarization is mechanical. If it erodes, M9 becomes a schedule risk — so treat
adding a second native module as a decision that needs an explicit trade-off, not a
convenience.

---

## 7. Milestones

Each milestone ends with a working, demoable app and a `STATUS.md` entry. Estimates assume
a single focused developer; they are sequencing guidance, not commitments.

### M0 — Foundations & spikes (~1 week)

- Monorepo, TS strict, ESLint/Prettier, Vitest, CI (typecheck + lint + test + build).
- Electron shell with hardened renderer config and CSP; typed contextBridge skeleton.
- Spikes S1–S5. Written findings committed to `docs/research/`.
- **Exit:** blank app boots from a packaged bundle with `better-sqlite3` loading; both
  protocols proven in throwaway scripts; spike findings written up.

### M1 — Event store & orchestrator core (~1 week)

- `packages/event-store`: append, read, projections, migrations, backup-on-migrate.
- `packages/orchestrator`: conversation aggregate, reducers, in-memory fake adapter.
- **Exit:** full conversation lifecycle driven by tests against the fake adapter, zero
  Electron involved. Rebuild-projections-from-log proven.

### M2 — Codex adapter (~1.5 weeks)

- Generated bindings + drift CI job. JSON-RPC client with correlation, timeouts, backoff.
- Supervisor: spawn, health, crash detection, restart with backoff, resume thread.
- Full event mapping (§4.2) + approval request/response round-trip.
- **Exit:** talk to Codex from the real app; stream, approve a command, interrupt, resume
  after a forced kill.

### M3 — Claude adapter (~1.5 weeks)

- `query()` with `AsyncIterable<SDKUserMessage>` streaming input; `includePartialMessages`.
- `canUseTool` → approval queue; hooks → lifecycle telemetry; `interrupt`/`setModel`/`resume`.
- **Exit:** same acceptance bar as M2, and the two adapters pass an identical shared
  conformance test suite.

### M4 — Shared conversation UI (~1.5 weeks)

- Transcript with per-agent identity, streaming text, reasoning/plan sections (collapsible),
  command output blocks, status indicators, token/cost display.
- `@claude` / `@codex` mention routing; composer with agent targeting.
- **Exit:** a real two-agent conversation, streaming smoothly, persisted across restart.

### M5 — Approvals & permission profiles (~1 week)

- Policy engine + three built-in profiles; per-project assignment.
- Unified approval card: command (with cwd + diff of intent), file change (with patch),
  permission grant, **MCP tool call (server + tool + target, never auto-allowed)**.
  Allow once / allow for session / deny / cancel.
- Timeout handling, queueing of concurrent requests, full audit trail view.
- **Exit:** no command or write is possible without a logged decision; auto-allows carry
  their rule id.

### M6 — Handoffs (~1 week)

- Handoff entity, brief composer with preview + edit, handoff cards in transcript.
- One-click **"Codex: review Claude's changes"** — the README's core loop as a single action.
- **Exit:** the full 5-step core workflow from the README runs end to end.

### M7 — Workspace & review (~1.5 weeks)

- Project roots, per-project cwd, git status/branch, staged/unstaged diff view.
- Diff viewer with per-file navigation; optional worktree isolation per conversation.
- Optional terminal drawer (xterm.js) attached to the agent's session for debugging.
- **Exit:** review Claude's changes inside Chorus without switching to an editor.

### M8 — Hardening (~1.5 weeks)

- Crash recovery: orphaned process reaping, session reconciliation on boot, corrupt-DB
  recovery path.
- Perf pass against S5 targets; memory profile over a 4-hour session.
- Structured logging + in-app log viewer + "export diagnostics" bundle (redacted).
- Accessibility pass: keyboard-only operation, focus management, screen-reader labels on
  approval cards (an approval you can't read is a security defect).
- Error taxonomy: every failure has a user-facing message, a recovery action, and a log id.
- **Exit:** the §1 maturity checklist items for stability and data safety are green.

### M9 — Distribution _(deferred — decision point, not a commitment)_

Per §10, Chorus starts as a personal tool. M9 is scoped now so nothing in M0–M8 blocks it,
but it only runs if you decide to distribute.

Runs regardless (M0/M8, not M9):

- Local packaged build with ad-hoc signing — needed to dogfood the real app, not `vite dev`.
- First-run flow: agent auth detection, project picker. This is product quality, not
  distribution.

Deferred until the productize decision (~1 week when triggered):

- Apple Developer ID ($99/yr), universal arm64 + x64 build, Hardened Runtime,
  notarization + stapling, every native binary signed individually.
- Auto-update with a signed feed and staged rollout; in-app "what's new".
- **Exit:** clean-Mac install → update → use, with no Gatekeeper prompts.

**Rough total: ~10–11 weeks** to a dogfoodable M8 build, plus ~1 week if and when M9 triggers.

---

## 8. Testing strategy

| Layer                                     | Approach                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain (`orchestrator`, policy, reducers) | Pure unit tests. Target ≥90% on the policy engine — it is the security boundary.                                                                                    |
| Adapter conformance                       | **One shared suite both adapters must pass.** Same test, two implementations. This is what keeps "agent independent" true rather than aspirational.                 |
| Protocol replay                           | Record real JSONL sessions from both providers as golden fixtures; replay them offline in CI. Fast, deterministic, no API cost, and catches mapping regressions.    |
| Protocol drift                            | Nightly CI: regenerate Codex TS bindings + install latest Claude SDK → fail on diff or type error.                                                                  |
| IPC                                       | Every channel fuzzed with invalid payloads; must reject, never crash.                                                                                               |
| Security                                  | Path-traversal fixture suite; CSP violation test; a test asserting the renderer cannot reach Node.                                                                  |
| E2E                                       | Playwright/Electron: golden path (Codex analyze → handoff → Claude implement → approve → Codex review), plus empty/error/loading states and mid-turn kill recovery. |
| Manual                                    | Pre-release checklist walked on a clean Mac VM.                                                                                                                     |

---

## 9. Risks

| Risk                                                                                                    | Impact                           | Mitigation                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex app-server` is `[experimental]` and will change                                                  | High                             | Generated bindings + nightly drift CI; adapter isolates all protocol knowledge; pin exact CLI version and bump deliberately                                                         |
| Claude SDK removes APIs (as it did with V2)                                                             | High                             | Pin exact version; conformance suite catches behavior change; nightly type-check against latest                                                                                     |
| Notarization blocked by native modules — and we won't find out until M9, since notarization is deferred | Medium→High if the budget erodes | One-native-module budget enforced from M0; S4 proves the ABI rebuild half early; `node:sqlite` escape hatch behind the DB port. Revisit if a second native module is ever proposed. |
| Approval fatigue makes the product annoying                                                             | High                             | Policy profiles with sensible auto-allows for read-only ops; batch related approvals; "allow for session" everywhere                                                                |
| Two agents editing the same files concurrently                                                          | Medium                           | Worktree isolation per conversation (M7); serialize write-capable turns per project by default                                                                                      |
| Renderer jank on fast streams                                                                           | Medium                           | Delta coalescing + virtualized transcript; S5 gate                                                                                                                                  |
| Agent auth complexity                                                                                   | Low                              | Decided: reuse existing `codex`/`claude` CLI logins; Chorus stores no credentials. Auth is a port so key management can be added later.                                             |
| User upgrades `codex`/`claude` and breaks us                                                            | Low at personal scale            | Record both CLI versions on `session.started`; `generate-ts` drift check explains protocol breaks. Revisit only if M9 triggers (§2.5)                                               |
| **Inherited MCP servers let an agent take irreversible outward-facing actions** (Slack, Jira, GitHub)   | Medium                           | `mcpToolCall` is a first-class approval kind; outward-facing tools are ask-every-time and cannot be auto-allowed by a profile (§2.6, §4.4)                                          |
| Approval hangs forever — neither provider times out                                                     | Medium                           | Chorus-owned deadlines on every pending approval, auto-**deny** on expiry (§4.4)                                                                                                    |
| Scope creep into "an IDE"                                                                               | Medium                           | The §1 three-point differentiator is the scope test; anything else is post-1.0                                                                                                      |

---

## 10. Decisions & assumptions

**Decided 2026-08-03:**

1. **Personal tool now, product later.** Build M0–M8 in full; M9 becomes a decision point
   after internal dogfooding rather than a committed milestone. The constraints that keep
   the door open — one-native-module budget, no unsigned binaries, no renderer shortcuts —
   stay in force from day one, because they are expensive to retrofit and free to maintain.
2. **macOS only for v1.0.** The architecture stays portable (no macOS APIs outside a thin
   platform module), but we don't test or ship Windows/Linux.
3. **Reuse existing CLI logins.** Chorus stores no credentials. It detects auth state via
   `account/read` (Codex) and the SDK's init response (Claude), and if either is missing,
   points the user at the CLI's own login flow. The auth layer is a port so key management
   can be added post-1.0 without touching the adapters.
4. **Drive the installed CLIs, don't bundle** (§2.5). Claude via the SDK with
   `pathToClaudeCodeExecutable` + `--omit=optional`; Codex via `codex app-server`.
5. **Inherit full user config** (§2.6) — agents behave the same inside Chorus as in a
   terminal. The cost is that inherited MCP servers make `mcpToolCall` a first-class,
   never-auto-allowed approval kind.

**Assumed unless you say otherwise:**

6. **Single user, single machine.** No accounts, no sync, no server component.
7. **Two agents at launch** (Codex, Claude), with the adapter interface proving extensibility.
8. **Telemetry off by default**, opt-in only. Local-first means local by default.

---

## 11. Open decisions — still need your input

| #   | Question                                                                        | Why it matters                                                                             |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 4   | Should Chorus support more than two agents at v1.0 (e.g. Gemini, local models)? | The adapter interface supports it, but each provider is ~1.5 weeks and its own drift risk. |
| 5   | Worktree isolation: default on or opt-in?                                       | On = safest for parallel agents, but adds git complexity most users won't expect.          |

Neither blocks M0–M2. Both can be answered by the time we reach M7.

---

## 12. Immediate next steps (on approval)

1. Scaffold the monorepo per §3.2 with strict TS, lint, and CI.
2. Run spikes S1–S5; commit findings to `docs/research/`.
3. Report back before writing any production adapter code — the spike results may change
   §4.1 and §4.2, and that is the point of running them first.
