# Chorus Build — Status

Plan: [plan.md](./plan.md)

| Milestone                          | State                                          |
| ---------------------------------- | ---------------------------------------------- |
| M0 Foundations & spikes            | **Complete** — infrastructure + all 5 spikes   |
| M1 Event store & orchestrator      | **Core complete** — read API deferred to M4    |
| M2 Codex adapter                   | **Complete** — all exit criteria verified live |
| M3 Claude adapter                  | Not started                                    |
| M4 Shared conversation UI          | Not started                                    |
| M5 Approvals & permission profiles | Not started                                    |
| M6 Handoffs                        | Not started                                    |
| M7 Workspace & review              | Not started                                    |
| M8 Hardening                       | Not started                                    |
| M9 Distribution                    | Deferred — decision point after M8 dogfooding  |

## Log

- **2026-08-03** — Plan drafted from live research (Codex app-server protocol reference,
  Claude Agent SDK 0.3.220 docs, Electron security/packaging guidance). Awaiting approval.
- **2026-08-03** — Scope decided: personal tool now / product later, macOS only for v1.0,
  reuse existing `codex` + `claude` CLI logins (Chorus stores no credentials). M9 deferred;
  the one-native-module budget stays enforced so it can be picked up cheaply later.
- **2026-08-03** — Partial S1/S2 completed early (plan §2.5). Live `codex app-server`
  handshake succeeded against the installed CLI using existing `~/.codex` auth. Claude SDK
  `sdk.d.ts@0.3.220` read directly: real `CanUseTool` signature captured (published prose
  docs are wrong), `pathToClaudeCodeExecutable` confirmed, and the 257 MB bundled-binary
  optional dependency identified. Decision: drive both installed CLIs, install the SDK with
  `--omit=optional`. New requirement found: neither provider times out an approval, so
  Chorus must own approval deadlines.
- **2026-08-03** — Version-drift mitigations cut to a single version field on
  `session.started`; the banner/onboarding/bundling-contingency work was product scope and
  §10 defers product. Config decided: **inherit full user config** (`settingSources`
  omitted) so agents behave as they do in a terminal. Consequence captured in plan §2.6 —
  inherited MCP servers make `mcpToolCall` a first-class approval kind that a permission
  profile may never auto-allow.
- **2026-08-03 — M0 infrastructure done.** pnpm + Turborepo monorepo, 7 packages per plan
  §3.2, hardened Electron shell, CI. All gates green (typecheck, lint, format, 23 tests);
  app verified booting in both dev and production, with a live IPC round-trip returning the
  real installed CLI versions. Toolchain pinned: TypeScript **6.0.3**, not 7.0.2 — no stable
  `typescript-eslint` supports TS 7 yet (peer range caps at `<6.1.0`), and dropping to TS 7
  would mean losing type-aware linting, which is what actually enforces the no-`any` rule.
  Revisit when typescript-eslint ships TS 7 support.

  Four things the build surfaced that the plan had not anticipated:
  1. **A sandboxed preload must be CJS**, and Electron's main cannot take named imports from
     the CJS `electron` module under ESM. `apps/desktop` is therefore deliberately not
     `"type": "module"`; only the renderer is ESM.
  2. **The strict production CSP breaks React Fast Refresh** — `script-src 'self'` rejects
     the inline preamble `@vitejs/plugin-react` injects. CSP is now split: the hard policy
     ships, a dev-only policy allows the inline preamble and the HMR websocket, selected by
     the presence of the dev-server URL rather than a build flag that could drift.
  3. **VS Code's extension host exports `ELECTRON_RUN_AS_NODE=1`**, which makes the Electron
     binary run as plain Node — `require('electron')` returns a path string and the app dies
     on `app.whenReady()`. The `dev` and `preview` scripts now run under
     `env -u ELECTRON_RUN_AS_NODE`.
  4. Typed linting needs test files inside a tsconfig, but the build must exclude them, so
     every package carries `tsconfig.json` (lint/editor, includes tests, emits nothing) plus
     `tsconfig.build.json` (emits, excludes tests).

- **2026-08-03 — M0 complete. All five spikes pass.** Full write-up in
  [docs/research/spikes-2026-08-03.md](../../research/spikes-2026-08-03.md). Five results
  changed the plan:
  1. **Codex discards partial assistant output; Claude preserves it.** After an interrupt
     or SIGKILL, `thread/read` returns the interrupted turn with only the `userMessage` —
     everything streamed is gone. So the transcript cannot be rebuilt from the providers.
     The event log is now load-bearing for crash recovery, not just audit, and M1 must
     persist `message.delta` as it arrives rather than waiting for `message.completed`.
  2. **Claude reports a user interrupt as `error_during_execution` / `is_error: true`**,
     with no distinct status; Codex reports `interrupted`. The adapter must track whether
     _we_ asked for the interrupt, or the UI shows an error card for pressing Stop.
  3. **The published Codex docs are wrong on the wire format** — `SandboxMode` (string
     enum) vs `SandboxPolicy` (tagged object) on adjacent methods, kebab-case
     `approvalPolicy` with an undocumented `granular` variant, a required snake_case
     `text_elements`, and `turn/interrupt` needing `turnId`. All corrected in plan §2.1
     from the generated bindings.
  4. **S4's premise was wrong in our favour**: `better-sqlite3` ships N-API prebuilds and
     loads in Electron 43 with no rebuild step. 10k rows insert in ~18 ms, so synchronous
     SQLite on the main thread is settled. Note `backup()` is the one async method.
  5. **rAF stops in hidden/occluded windows**, so coalescing cannot be built on it alone —
     it would stall and buffer unboundedly exactly when a long turn is running in the
     background. Needs a timed fallback flush and a bounded buffer. Frame budget also
     tightened to 8.3 ms (120 Hz), not the 16 ms the plan assumed.

- **2026-08-03 — M1 core complete.** Event store and orchestrator built and tested with
  zero Electron involved. 61 tests across the workspace, all gates green.

  Shipped:
  - `@chorus/event-store` — append-only log, numbered forward-only migrations (with a
    pre-migration snapshot hook, since `backup()` is async per S4), a `better-sqlite3`
    driver behind the `Database` port, and projections for conversations, messages,
    agent sessions, approvals and handoffs. Append and projection updates share one
    transaction, so a projection can never run ahead of the log.
  - `rebuildProjections()` — drops every projection and replays the log. Tested to
    reproduce byte-identical state after a wipe and to recover from a deliberately
    corrupted projection. `projectionDrift()` reports a projection left behind.
  - `@chorus/orchestrator` — `DeltaBuffer` (two-sided size/time bound plus a total-chars
    backstop) and `ConversationService`, which maps `AgentEvent` to durable
    `ChorusEvent`s.
  - `FakeAdapter` — an in-memory `AgentAdapter`. This is also the harness the shared
    adapter conformance suite will run against in M2/M3.

  Three S3 findings are now enforced by tests, not just documented:
  1. Streamed text is persisted as it arrives — 500 deltas coalesce into fewer than 10
     log rows while the message row still reconstructs in full.
  2. Pending deltas flush **before** any lifecycle event, so a command can never be logged
     ahead of the sentence that introduced it.
  3. A user-initiated stop is recorded as `interrupted` with `userInitiated: true`, while
     an unrequested failure stays `failed` — Claude reports both identically on the wire.

  Deferred out of M1 (not blocking M2/M3):
  - No typed read API over the projections yet; M4 needs one and should own its shape.
  - `projects` table exists but nothing manages projects yet.
  - Handoff and approval _events_ are modelled and projected, but the handoff engine (M6)
    and policy engine (M5) are not built.

- **2026-08-03 — M2 in progress.** Codex adapter core built and tested; 100 tests
  workspace-wide, all gates green.

  Shipped:
  - **Generated protocol bindings committed** — 622 files from
    `codex app-server generate-ts`, pinned to codex-cli 0.146.0 via a
    `.codex-version` marker. Build cost measured at ~1.5s; they are type-only.
  - `JsonRpcClient` — bidirectional by design. Approvals arrive as requests _from_
    the server and must be answered by id; a client modelling only one direction
    hangs every approval. Also handles `-32001` overload with exponential backoff
    plus full jitter (lockstep retry just recreates the overload), request
    timeouts, and failing every in-flight promise when the process dies — the
    S3a scenario, which otherwise leaves promises pending forever.
  - `mapping.ts` — pure Codex-notification → `AgentEvent` translation, including
    all three approval request shapes onto the single `ApprovalRequest` card, and
    decision translation that fails closed (a timeout becomes `decline`, never
    `accept`).
  - `CodexAdapter` / `CodexSession` — handshake, `thread/start`, `turn/start`,
    `turn/interrupt`, resume, and approval round-trip. Both Codex sandbox types
    stay inside this file, per plan §4.1.
  - An opt-in integration test (`CHORUS_E2E=1`) against the real binary. It stops
    short of starting a turn, so it costs no tokens while still exercising the
    handshake and the sandbox/approval-policy encodings the docs got wrong.

  **The drift check is now two jobs, not one.** They answer different questions:
  `bindings-match-pin` regenerates against the _pinned_ CLI on every PR and must
  always pass — it catches hand-edited generated code. `protocol-drift` runs on a
  daily schedule against `@latest` and is allowed to go red, because upstream
  shipping is not a reason to block a pull request.

  One thing the linter caught that was worth fixing properly: the mapping used
  `String(unknown)` throughout, which yields `"[object Object]"` for an
  unexpected shape — verbatim into a transcript. Replaced with a narrowing
  helper, so a bad shape reads as absent rather than as garbage.

  Remaining before M2 closes:
  - **Supervisor** — crash detection, restart with backoff, automatic thread
    resume. `resume()` exists on the adapter but nothing drives it yet.
  - **Wiring into the desktop app** — the adapter is not yet reachable from the
    Electron main process.
  - The shared adapter conformance suite, which only becomes meaningful once the
    Claude adapter exists in M3 to run against the same tests.

- **2026-08-04 — M2 supervisor and app wiring.** 122 tests, all gates green.

  **A live Codex session now runs through the real app.** Driven over CDP against
  a temp git repo: typed a prompt, the agent replied, and the reply rendered as a
  `CODEX` message. That exercises the whole chain — renderer → contextBridge →
  IPC → runtime → supervisor → adapter → JSON-RPC → `codex app-server` → model,
  and back through the mapping, delta buffer, SQLite, commit notification, IPC
  push and renderer reducer.

  Shipped:
  - `AsyncQueue` in `@chorus/shared`. The queue-plus-waiter dance had been
    hand-rolled three times; lost-wakeup bugs live in exactly that code.
  - `SupervisedSession` — **implements `AgentSession` itself**, so
    `ConversationService` never learns that restarts happen. A crash is inferred
    from the event stream ending when we did not ask it to, since providers do
    not announce their own death. Restart budget within a window, full-jitter
    backoff, and a failed resume surfaces rather than looping. Sequence numbers
    stay monotonic across a restart, because a restarted provider resets its own.
  - `EventStore.subscribe` — fires only **after** commit. A listener running
    inside the transaction could act on state a rollback then erases.
  - Runtime, IPC (start/send/interrupt/history/approve + a push channel), and a
    deliberately plain renderer that M4 replaces.
  - `transcript.ts` — a pure reduction over the log, so a history replay and the
    live push produce the same view, deduplicated by `seq`.

  Sessions start **read-only** and stay there until the policy engine lands in
  M5. Starting permissive and tightening later is how permissive defaults ship by
  accident.

  Still unverified against the live app (unit-tested only): a command approval
  round-trip, interrupt, and recovery from a forced kill. The read-only sandbox
  means no approval has actually fired in anger yet. Worth doing before M3.

- **2026-08-04 — M2 complete.** All five exit criteria now verified against the
  live app, not just unit-tested. 131 tests, all gates green.

  Driving the real app end to end found **three bugs that every unit test had
  passed over**:

  1. **A file-change approval card rendered "Edit " with no path.**
     `FileChangeRequestApprovalParams` carries _no_ changes — only an `itemId`.
     The payload arrived earlier as a separate `item/started`. The session now
     keeps a bounded cache of recent items so the card can be composed by
     joining on that id. Also learned that several approvals can share one
     `itemId` (the zsh-exec-bridge case), so a distinct `approvalId` wins when
     the server sends one — keying on `itemId` alone would make them collide.
  2. **Approval decisions were never written to the log.** The runtime answered
     the session directly, which satisfied the agent but left no audit trail —
     violating §4.4's "every decision, including auto-allows, is recorded" — and
     left the approval card on screen forever, since the UI clears it on
     `approval.decided`. Decisions now route through `ConversationService`.
  3. **A killed app-server was never detected.** `JsonRpcClient` failed its
     in-flight promises but nothing ended the session's event stream, and the
     supervisor's crash detection keys on exactly that. The session appeared
     alive and silently stopped working. The client now exposes `onClose`.

  Verified live afterwards: an approval card showing the real path, cleared on
  decision, with the file actually written to disk; a Stop button producing
  "Stopped." rather than an error; and `kill -9` on the app-server producing
  "agent codex exited unexpectedly; restarting" followed by a working session.

  All three have regression tests now. The lesson worth keeping: the unit tests
  were not wrong, they were testing shapes I had inferred from prose docs rather
  than from the wire.

- **2026-08-04 — M3 Claude adapter.** 160 tests, all gates green. A live Claude
  session runs through the real app, selected from an agent picker beside Codex.

  Shipped:
  - `ClaudeAdapter` over `query()` in streaming-input mode — which is also what
    makes `interrupt()` and `setModel()` available at all. `canUseTool` bridges
    into the same approval queue Codex uses, and a user-initiated stop is
    relabelled `interrupted` rather than surfacing as the failure the wire
    reports (S3b).
  - The SDK's ~257 MB per-platform binary is excluded via
    `ignoredOptionalDependencies`; the package installs at 4.1 MB and
    `pathToClaudeCodeExecutable` points at the user's installed `claude`.
  - **The shared conformance suite** (`@chorus/agent-protocol/conformance`),
    now run by both `FakeAdapter` and the real `ClaudeAdapter`. It lives in the
    port package rather than a test folder because it is part of the port's
    definition. One check exists purely to stop an M2 bug recurring: a dead
    provider must end its event stream, or the supervisor never restarts it.

  **A rendering bug the unit tests could not have caught.** The live transcript
  showed `P`, `ONG`, `PONG` as three separate messages. Every Claude
  `stream_event` carries its _own_ `uuid`, so keying deltas on it gave each
  token its own message row — and the final `assistant` message, keyed
  differently again, appeared beside the fragments instead of replacing them.
  Deltas are now keyed on the enclosing `message_start` id plus block index, and
  the final message reuses that key. Both are regression-tested.

  Also fixed: crashed E2E drivers were leaving Electron alive holding the CDP
  port, so the next run silently inspected a _stale_ app. Two debugging rounds
  went into that before I looked at the DOM instead of guessing.

  Remaining for M3: a live Claude approval round-trip (Codex's is verified), and
  running the conformance suite against `CodexAdapter` with an injected
  transport — currently only Fake and Claude run it.

- **2026-08-04 — M3 complete.** Both remaining gaps closed. 169 tests, all gates
  green.

  **All three adapters now run the shared conformance suite.** `CodexAdapter`
  joins `FakeAdapter` and `ClaudeAdapter` via a fake transport that answers the
  handshake and `thread/start` the way the real server does, so the adapter is
  exercised rather than stubbed. Two Codex-specific checks ride along: the
  handshake completes before any thread is started, and the sandbox goes over
  the wire as the kebab-case string enum the server actually accepts — the shape
  the published docs got wrong.

  **A live Claude approval round-trip is verified.** Card showed the real path,
  cleared on decision, and the file landed on disk. Claude's `canUseTool` and
  Codex's server-initiated request now both drive the same card and the same
  audit trail.

  What "agent independent" means at this point: one `AgentAdapter` port, one
  `AgentEvent` union, one approval card, one conformance suite — and two real
  providers whose wire protocols have almost nothing in common passing it.

- **2026-08-04 — M4 shared conversation.** Two agents in one room, verified live.
  202 tests, all gates green.

  **Multi-agent is a runtime change, not a UI one.** A conversation now holds
  several agents at once: each gets its own `ConversationService` writing into
  one conversation id, and the log's global sequence interleaves them. Agents
  start in parallel, a partial start is recorded in the transcript rather than
  silently dropping an agent, and `send` logs the user's message **once** before
  routing — logging per participant would show the user repeating themselves.

  `parseMentions` decides who answers: explicit `@codex`/`@claude` wins,
  otherwise the conversation continues with whoever was last addressed. Silently
  switching agents would send a follow-up to one that never saw what it follows.
  Mid-sentence mentions stay in the text, since "ask @codex to review this" reads
  differently without the name.

  **Markdown is parsed to a typed tree and rendered as React elements.** No HTML
  string exists anywhere in the pipeline, so injection is impossible by
  construction rather than filtered — a stronger guarantee than a sanitizer, and
  the reason there is no markdown dependency. `javascript:` and `data:` links
  degrade to inert text rather than being dropped, so the user can see what the
  model tried.

  **The design.** A voice rail runs the length of the transcript with a dot per
  message coloured by speaker — the shape of an exchange is legible before you
  read a word. Type encodes kind: serif for what agents _say_, mono for what they
  _do_. Violet-slate ground with complementary jade/amber voices, deliberately
  avoiding both dev-tool defaults.

  Two bugs the live run caught that no unit test would have:
  1. **Send was replaced by Stop while any agent worked**, so Codex being busy
     blocked you from addressing Claude — wrong in a shared room. They coexist now.
  2. **Claude's replies rendered twice.** Keying message blocks by index looked
     right and was not: the stream's `event.index` counts every content block
     including thinking, while the final message's array often omits them, so the
     same reply streamed as `msg:1` and completed as `msg:0`. Found by querying
     the event log rather than guessing. Text blocks now key on the message id
     alone and join into one entry, which removes the class of bug.

  Remaining for M4: transcript virtualisation, and the S5 re-measurement against
  real markdown rendering as the exit gate. The 8.3 ms budget was measured on
  plain text nodes and means little until it is re-run against this.

- **2026-08-04 — filesystem scoping dropped.** Plan §4.4 previously said "deny anything
  outside the project root". Removed: agents may read and reach wherever the user can,
  exactly as they do in a terminal. Same reasoning as §2.6 — Chorus drives the user's own
  CLIs and should not invent restrictions the terminal does not have. A `cwd` is a starting
  point, and the user points an agent at a directory by telling it, not by being fenced in.

  What still gates behaviour is the approval, not the path: writes, commands and
  outward-facing MCP calls need a decision wherever they land. `resolveWithinRoot` stays,
  but only for paths **Chorus itself** derives — a worktree we create, a diff we read —
  where an escape would be our bug rather than an agent's instruction.

- **2026-08-04 — one sentence, both agents.** Verified live: `@codex @claude In one short
sentence each, …` produced replies from both, with the user's message logged **once**
  rather than duplicated per recipient. The composer's Send/Stop coexistence proved itself
  in the same run — Codex was still mid-turn ("Stop codex") while Send stayed available.
  Placeholder copy reworded, since "pick who answers" read as choose-exactly-one.
