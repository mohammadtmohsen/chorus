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

- **2026-08-04 — M4 complete. S5 re-measured, and it overturned both of its own
  earlier conclusions.** Full write-up in
  [docs/research/s5-remeasured-2026-08-04.md](../../research/s5-remeasured-2026-08-04.md).

  1. **Renderer-side coalescing makes things worse**, not better: 15 dropped
     frames versus 2, p95 nearly doubled. The original run measured plain text
     nodes, where the cost was React scheduling; against real markdown the cost
     is parsing, and a larger flush simply overruns the frame. Removed. Write-side
     coalescing in `DeltaBuffer` is untouched — it exists for durability and log
     size, not frame time.
  2. **The bottleneck was re-parsing a growing message, not entry count.** Every
     delta re-parsed the whole message — quadratic in length, 17% dropped frames
     on a 25k-character reply. Splitting settled-prefix from live-tail barely
     helped, because the prefix invalidates whenever a block completes. Splitting
     into blocks and memoising each on its own text worked: the same run carried
     46% more content with fewer dropped frames.
  3. **Virtualisation is deferred with evidence rather than skipped.** 201 entries
     render fine, and memoised entries do no work while another message streams —
     nothing measured is improved by windowing. It solves DOM size at thousands of
     messages, a real but different problem. Revisit on conversation size.

  Realistic streaming now sits at **0.3% dropped frames** (2/717) against the
  8.3 ms budget. The synthetic 20 s single-message run still drops 14%, but that
  is 5,000 tok/s sustained into one message — roughly two orders of magnitude
  past real agent output. Recorded as the honest ceiling.

- **2026-08-04 — M5 approvals and permission profiles.** 247 tests, all gates green.

  **The security claim is proven live, not asserted.** Asked Codex to run
  `rm -rf ./doomed` under the _Trusted_ profile — the most permissive one, where
  commands otherwise run without asking. The log shows it twice:

      approval.requested   command ["/bin/zsh -lc 'rm -rf ./doomed'"]
      approval.decided     deny by=policy rule=deny-recursive-delete

  The directory survived, and the transcript says
  `Denied automatically · deny-recursive-delete`.

  Shipped:
  - **Policy engine** with a deliberately rigid order: kinds that may never be
    auto-decided → deny rules → session grants → allow rules → ask. Denies are
    evaluated _before_ grants, so "allow for session" widens what a profile
    permits but can never reach past what it forbids.
  - **Three profiles** — read-only, workspace-write, trusted — each carrying the
    universal denies. Those are not "dangerous commands" in the abstract; they
    are the ones whose damage cannot be undone from inside Chorus. A bad edit is
    recoverable from git; a force-push over someone else's work is not.
  - **`ApprovalQueue` owns the deadline**, because neither provider does. Expiry
    always denies — auto-allowing something nobody looked at would turn a
    screensaver into a permission grant. Closing a session drains the queue, so
    an agent is never left blocked on a prompt nobody will see.
  - Session grants are keyed per agent and per action, and held in memory only:
    trusting Codex with something says nothing about Claude, and a grant that
    outlived its session would be a permission the user never knowingly gave.
  - The provider sandbox now mirrors the profile, so the gate is defence in depth
    rather than ours alone.

  Two things a live run caught that unit tests could not:
  1. **Automatic decisions were invisible.** The notice was skipped when a card
     had been showing — but the request is logged _before_ policy evaluates, so
     every auto-decision briefly shows as pending and therefore never announced
     itself. A policy that works silently is indistinguishable from no policy.
  2. **The auto-allow path never fires for reads under read-only**, because the
     provider does not ask permission for something its sandbox already permits.
     Correct behaviour, but worth knowing: policy only sees what an agent asks
     about.

  Deferred: the `granular` Codex approval variant found in the bindings. The
  preset `approvalPolicy` values cover the three profiles, and mapping per-category
  toggles has no user-visible payoff yet.

- **2026-08-04 — M6 handoffs. The README's core loop runs end to end.** 259 tests,
  all gates green.

  Verified live: Codex analysed a repo, a handoff composed a brief, the brief was
  **edited by hand**, and Claude acted on the edited version — the transcript shows
  `USER → CODEX ×5 → CLAUDE`, with a handoff card between them.

  The edit is the part that matters. Agents keep separate contexts, so the brief
  _is_ what the receiving agent will know. Composing it silently would make Chorus
  decide that on the user's behalf, which is exactly what "explicit context
  sharing" exists to prevent (plan §4.5). The composer proves the point: an
  instruction typed into the brief came out the other side in Claude's reply.

  Shipped:
  - `composeBrief` — pure, tested. Framing names the source agent, because an
    agent told "implement this" behaves differently from one told "implement this
    analysis from Codex". Intents are implement / review / discuss.
  - `prepareHandoff` builds without sending; `sendHandoff` records
    `handoff.created` and delivers what the user approved. The receiving agent
    becomes the one an unaddressed follow-up continues with.
  - Optional inclusion of the current aggregate diff.
  - A handoff card in the transcript, collapsed by default, showing exactly what
    crossed — the seam between two agents that otherwise cannot see each other.
  - Hand-off action revealed on hover but reachable by keyboard; an action you can
    only find with a mouse is not an action.

  Not built: multi-message selection. The composer takes a list of source events
  and the runtime already handles several, but the UI only offers one at a time.
  Worth adding once it is clear whether handing off a _run_ of messages is
  actually the common case.

- **2026-08-04 — M7 workspace and review.** 282 tests, all gates green. The exit
  criterion is met: an agent edited a file and the change was reviewed inside
  Chorus, without opening an editor.

  Verified live under the workspace-write profile: Codex changed a line in
  `README.md`, and the review view showed `main`, `+1 −1`, the file, and the hunk
  with line numbers on both sides.

  **The review reads git, not the event log.** The log records what agents
  _proposed_; git records what is on disk. After a denied approval, a crash, or a
  manual edit those differ — and the one worth reviewing is the disk. Everything
  in `@chorus/workspace` is read-only: a convenience `git add` here would be a
  mutation with no approval behind it.

  Shipped:
  - `parseStatus` over `--porcelain=v2 --branch` — the only format git promises
    not to change, and it carries branch and ahead/behind in the same call.
    Handles renames, conflicts, detached head, and paths containing spaces.
  - `parseDiff` producing per-file hunks with line numbers on **both** sides,
    because a reviewer has to be able to point at a line in the file they have
    open. Binary files are flagged rather than pretending to have hunks.
  - Working and staged diffs merged into one view: after a turn the question is
    "what did it do", and splitting that across two lists makes the reader
    reassemble it.
  - A review panel with per-file navigation, memoised so switching files does not
    re-render the previous one's hunks.

  One parser bug the tests caught: `split('\n')` leaves a trailing empty element,
  which was rendering as a context line for content that is not in the file.

  Deferred:
  - **Worktree isolation per conversation.** The plan lists it as optional. It
    adds real git complexity for a benefit that only appears once two agents write
    to the same repo concurrently, which has not happened yet.
  - **The terminal drawer**, cut as previously flagged. It duplicates what the
    transcript already shows.

- **2026-08-04 — M8 hardening.** 315 tests, all gates green.

  **Secret redaction, which §4.4 required and nothing did.** Agents read `.env`
  files, print environment variables and paste tokens into commands, and every
  one of those flowed through `command.output` or `agent.message.delta` straight
  into a durable file that gets backed up and attached to bug reports. Redaction
  now runs inside `EventStore.append` — the only write path, so a caller cannot
  opt out — and walks payloads structurally, so a field added later is covered
  rather than silently exempt.

  It is deliberately conservative. A false positive destroys content the user
  needed, so patterns are anchored to unambiguous shapes (`sk-ant-`, a PEM
  header, an AWS key prefix). The one rule keyed on a _name_ rather than a shape
  declines values that look like code: `const apiKey = config.apiKey` is a
  property access, and redacting it would eat source someone was reading. That
  false positive was caught by a test written specifically to look for it.

  **Crash recovery**, verified live:
  - Sessions the log still believes are running are closed at boot — as an
    _append_, not a projection edit, so a rebuild does not undo it. Confirmed:
    `[chorus] boot: 1 orphaned session(s) closed`.
  - An unreadable database is moved aside and a fresh one opened, rather than
    making the app unstartable. Confirmed: the app started and
    `chorus.unreadable-<ts>.db` was preserved. It is moved, never deleted — it is
    the user's history, and `sqlite3 .recover` may still get it back.

  **A correction worth recording.** I first measured "two orphaned app-servers
  survived a crash" and built PPID-based reaping to fix it. That measurement was
  wrong: the test killed the `npx` wrapper while Electron kept running, so the
  children still had a live parent. Killing Electron itself leaves **zero**
  survivors — stdio closure already cleans them up. The reaping stays as a
  backstop, and its comments now say so instead of claiming a fix.

  **Accessibility**: both sheets trap and restore focus and close on Escape, so a
  keyboard user is not stranded behind an overlay. Approval cards are
  `alertdialog` with `aria-live="assertive"` — an approval blocks an agent and
  expires, so hearing about it politely after the timeout tells you nothing.

  Remaining: the diagnostics export bundle and in-app log viewer. Structured
  logging is not in yet either — boot events currently write to stdout.

- **2026-08-04 — M8 complete.** Structured logging, the in-app log viewer and a
  redacted diagnostics bundle. 326 tests, all gates green.

  **The plan named pino; this is deliberately not pino.** Volume here is a few
  hundred lines per session, so nothing pino is good at applies, and ~120 lines
  with no dependency is easier to audit — which matters, because the log file is
  the one artefact a user is asked to hand to someone else. `console` was never
  an option: it bypasses redaction, and in a packaged app nobody watches stdout.

  Redaction moved from `event-store` down to `shared`, because two things need
  it — the event log and the diagnostics bundle. A secret scrubbed from one and
  left in the other is not scrubbed. Errors log their message and name but never
  their stack: stacks carry absolute paths, which is exactly what a shared bundle
  should not.

  **A vacuous test, caught and replaced.** The first live check asked an agent to
  read a `.env` file and then confirmed no secret reached disk. It passed — but
  the agent never read the file, so redaction never ran and the result proved
  nothing. Replaced with a deterministic path: a user message containing a token
  goes through `store.append`, which is the only write path. The transcript then
  reads `here is my key [redacted:github-token] do not use it`, and the token is
  absent from the database, the log file and the exported bundle.

  Worth noting the consequence: because redaction happens on write, the user's own
  message is stored and displayed in its redacted form. That is what §4.4 chose,
  and showing the redacted text is honest about what was actually kept.

- **2026-08-04 — first real-use bug.** A conversation was started against a
  directory that does not exist. The Claude SDK reported it as _"the native
  binary at …/claude exists but failed to launch. This usually means the binary
  does not match this system's libc"_ — pointing at a nonexistent architecture
  problem — and the supervisor then retried six times, burying it.

  Root cause found by reproduction rather than reading: the binary launches fine
  from Electron, and the same adapter succeeds with a valid `cwd` and fails with
  exactly that message when the directory is missing. A spawn `ENOENT` from a bad
  working directory is indistinguishable, to the SDK, from a broken binary.

  Three fixes:
  1. **The runtime checks the directory before spawning anything**, and says
     "That directory does not exist: …".
  2. **The adapter checks too**, so the blame lands correctly even when it is
     called directly rather than through the runtime.
  3. **The supervisor no longer retries an unrecoverable failure.** An adapter
     reporting `recoverable: false` is saying retrying cannot help; restarting
     anyway produced six identical errors. It now stops on the first one.

  Also strips Electron's `Error invoking remote method '…':` wrapper from errors
  shown to the user — the useful half was at the end.

  The conformance suite earned its keep here: adding `cwd` validation broke four
  of its cases, because `CONFORMANCE_OPTS` hard-coded a path that never existed.
  A contract change was caught by the contract.

  328 tests.

- **2026-08-04 — the project directory is optional.** An empty field starts the
  session in the user's home folder, and the header shows where it actually
  landed rather than what was typed. Since the filesystem is not scoped to a
  project (§4.4), a directory is a starting point rather than a boundary, and
  demanding one before the conversation can begin was hard to justify. A
  non-empty path is still validated.

- **2026-08-04 — agents now follow the shared conversation.** Reported from a
  live session: the user asked Claude what MCP servers were available, then asked
  Codex "what i asked claude". Codex had never seen any of it, so it went and
  grepped `~/.claude/projects/*.jsonl` off disk to reconstruct the answer.

  The cause was routing working exactly as designed. `parseMentions` sends a
  message only to the agent it is addressed to, which is right for cost and for
  not having two agents answer at once — but agents keep separate contexts, so
  each one only ever knew its own half. The transcript was shared on screen and
  nowhere else.

  `catchup.ts` closes the gap. Before an agent is asked to answer, it is handed
  the part of the thread it has not seen — user messages and other agents'
  completed replies, oldest dropped first under a character budget, long messages
  trimmed from the middle. It rides along with the message being delivered, so
  there is no extra turn, nothing at all when nothing was missed, and no second
  agent woken up merely to listen. Each participant carries a `seenSeq`
  watermark over the shared log; a handoff advances it, because the brief is
  already the context.

  Only what was _said_ is replayed. Commands, reasoning and approvals belong to
  the agent that ran them.

  Verified live with both agents: Claude was asked for a specific sentence, then
  Codex was asked what the user had asked Claude and what Claude replied, with
  running commands and reading files explicitly forbidden. It answered both
  correctly from context.

  337 tests.

- **2026-08-04 — catch-up widened from speech to activity.** Replaying only what
  was _said_ was too thin: an agent's summary of a failing test run is not the
  failing test run, and "why did that fail" is exactly the question the other
  agent gets asked. Catch-up now also carries commands and how they exited, files
  changed, and errors that stuck — one line each, plus the tail of the output
  when a command failed, which is the only time anyone asks for it.

  Reasoning stays out (private working, and enormous), as do deltas, approvals
  and session bookkeeping. The switch over event types is exhaustive rather than
  defaulted, so a new event type has to be considered here instead of silently
  vanishing from the shared conversation. When the budget binds, activity is shed
  before speech: losing "claude ran the tests" costs less than losing what claude
  said about them.

  Verifying it live exposed a real gap underneath: **the Claude adapter never
  emitted command output or completion at all.** Tool results come back as a
  `user` message, and that case was being dropped, so every Claude command sat in
  the transcript with no result and there was nothing for catch-up to carry.
  `mapToolResults` now maps `tool_result` blocks for known Bash calls into
  `command.output` and `command.completed`. Claude reports success or failure and
  never an exit code, so `is_error` becomes 1 and anything else 0 — the number is
  not real, but "did it fail" is.

  Verified live: Claude ran `ls /definitely-not-a-real-directory-xyz`, and Codex,
  forbidden from running anything or reading any file, reported the command, exit
  code 1, and the literal `No such file or directory`.

  350 tests.

- **2026-08-04 — several sessions at once, in a grid.** Until now there was no
  way to end a session or start another: one conversation per launch, and
  quitting was the only exit. The runtime was already multi-conversation — an
  `active` map keyed by id, every method taking a `conversationId` — so this was
  a UI gap, not an architectural one.

  `conversation:close` ends one conversation and leaves the rest running. It
  removes the conversation from `active` _before_ closing its agents, so a
  message sent into the gap fails loudly rather than being handed to a session on
  its way out.

  The renderer split: `App` now holds only a list of sessions and the grid, while
  `Session` owns everything a conversation knows — transcript, approvals, draft,
  errors, handoff, review. Each pane keeps its own draft and its own scroll: a
  message half-typed in one has to survive reading another, and an error in one
  must not blank the rest. Events arrive for every conversation at once, so each
  pane filters the push stream to its own and returns early when nothing matched,
  which is what stops four panes re-rendering on every token of one reply.

  Two things only building it revealed:
  - `scrollIntoView` walks _every_ scrollable ancestor, so one agent's reply
    dragged the whole grid around while you read another pane. Setting
    `scrollTop` cannot reach past its own element.
  - Sessions on the same folder with the same agents are indistinguishable, so
    each pane carries its grid position. It is the only thing about a pane that
    is true at a glance, and "the second one" is how anyone refers to them.

  Ending is confirmed only while an agent is mid-turn — the one moment it costs
  something. The rest of the time the log is already durable.

  Verified live with two sessions: independent drafts, a message sent in one
  never appearing in the other, closing one leaving the other's transcript
  intact, and no console errors. 350 tests.

- **2026-08-04 — the composer became one field, and `@` opens a picker.** The
  border now belongs to the whole composer rather than the textarea inside it, so
  the text and its controls read as a single place you type; Send became a
  circular ↑ with its name on `aria-label`. The box starts one line and grows to
  28vh — height collapsed to `auto` before measuring, because `scrollHeight` is
  the content height _or_ the current box height, whichever is larger, so without
  the reset it would grow and never shrink.

  Typing `@` now opens a menu of the session's agents, filtered as you type, with
  arrows, Enter, Tab, Escape and click. It offers **both** as a last entry, which
  expands to `@codex @claude` — one sentence reaching both agents was an explicit
  requirement, and until now you had to know to type it. "Both" is last on
  purpose: a first entry that costs two agents a turn gets picked by accident.

  `mention-menu.ts` holds the caret arithmetic with no DOM in it, using the same
  word-boundary rule as the router — the menu must not suggest something routing
  would then ignore.

  Two bugs found by driving it, not by reading it:
  - **A swallowed arrow key.** The refresh runs on every selection change as well
    as every keystroke, and it reset the highlight, so one ArrowDown of two was
    undone. It now compares the query it last saw and only resets when the
    mention actually changed.
  - **Escape did not stick.** The menu closed and the next refresh reopened it.
    A dismissed query is remembered until a different one is typed.

  Verified live: filtering, Enter picking instead of sending, two arrows reaching
  "both", Escape staying shut, no menu inside `me@c`, and plain Enter still
  sending. 365 tests.

- **2026-08-04 — one round button, Stop while working.** The composer's button is
  Stop whenever an agent is mid-turn and Send otherwise, replacing the separate
  text Stop chip.

  This reverses a decision made in M4 — Stop used to appear *alongside* Send
  precisely because replacing it blocked addressing the other agent mid-turn. The
  keyboard is what makes the reversal safe now: ↵ sends whether or not anyone is
  working, so the button showing Stop closes nothing off. Confirmed live rather
  than assumed: a message typed and sent with ↵ during a turn reached the agent
  while the button read Stop.

  Verified live: Send disabled on an empty box, Stop while working, exactly one
  round button and no text Stop anywhere, and the button returning to Send once
  the turn ends. 365 tests.
