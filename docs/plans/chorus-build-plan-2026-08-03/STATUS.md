# Chorus Build — Status

Plan: [plan.md](./plan.md)

| Milestone                          | State                                          |
| ---------------------------------- | ---------------------------------------------- |
| M0 Foundations & spikes            | **Complete** — infrastructure + all 5 spikes   |
| M1 Event store & orchestrator      | **Core complete** — read API deferred to M4    |
| M2 Codex adapter                   | **In progress** — supervisor + app wiring left |
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
