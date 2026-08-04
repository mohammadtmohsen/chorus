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

  This reverses a decision made in M4 — Stop used to appear _alongside_ Send
  precisely because replacing it blocked addressing the other agent mid-turn. The
  keyboard is what makes the reversal safe now: ↵ sends whether or not anyone is
  working, so the button showing Stop closes nothing off. Confirmed live rather
  than assumed: a message typed and sent with ↵ during a turn reached the agent
  while the button read Stop.

  Verified live: Send disabled on an empty box, Stop while working, exactly one
  round button and no text Stop anywhere, and the button returning to Send once
  the turn ends. 365 tests.

- **2026-08-04 — the grid is responsive, up to four columns, down to a phone.**
  Column count is capped at four and steps down with the window: 4 above 1680px,
  3 above 1280, 2 above 820, and a single stack below that. Columns collapse
  rather than forcing a sideways scroll — a pane half off-screen is the same
  problem in a different direction.

  Once stacked, each pane takes a full screen and you scroll between them. Four
  sessions sharing a phone's height gives each a transcript three lines tall,
  which is a list of sessions rather than a set of usable ones.

  Panes shed detail by their **own** width, not the window's, using container
  queries: three panes on a wide display are each as cramped as one pane on a
  narrow one. Below 460px a pane drops its profile chip, below 360px its path and
  the keyboard hint.

  `minWidth` came down from 940 to 380. It was the only thing stopping a window
  that renders perfectly well at 390.

  Verified live with four sessions: 4 → 3 → 2 → 1 columns across 1900/1500/1100/
  700px, no horizontal overflow at 390px, composer on screen, profile chip shed.
  365 tests.

- **2026-08-04 — the app opens on a door, not a form.** With nothing open there
  is now one thing to press: **Start a session**, with **Settings** beneath it.
  The setup form used to _be_ the launch screen, which meant arriving at a wall
  of choices before there was any reason to make them — and every one of them
  now has a remembered answer. It became a sheet, reached from the empty screen
  and from **New session** in the masthead.

  `settings.json` in `userData` holds what a new session starts with: agents,
  directory, permission profile. Deliberately not in the event log — the log
  records what happened in a conversation, and a preference is neither an event
  nor something you would want replayed. Written via a temp file and a rename, so
  a crash mid-write cannot leave a half-written file where a valid one was; a
  corrupt one falls back to defaults rather than stopping the app opening.

  Every field is a _default_, never a constraint: a session still chooses its own
  agents, directory and profile as it opens, which is what makes it safe to put
  the permission profile in a settings sheet at all. Nothing there can widen what
  an agent may do in a session already running.

  Changes save as you make them. A settings sheet with a Save button is one you
  can leave without your change taking effect.

  Verified live: empty screen with exactly those two buttons and no form, Cancel
  returning to it, a session starting from it, Settings reachable from the
  masthead once panes exist, and a changed profile surviving a full relaunch.
  365 tests.

- **2026-08-04 — size, first in Settings and then only on the keyboard.** Five
  steps (85% to 150%) with ⌘+, ⌘− and ⌘0. The sheet control was dropped a moment
  later; the record of why the mechanism is a zoom factor is worth keeping.

  It is a **zoom factor, not a font size**. Scaling type alone would leave every
  border, gutter and control where it was, so larger text would arrive in a
  layout built for smaller text. Zoom moves all of it together — and the
  responsive breakpoints come along, so at 150% the window holds fewer columns,
  which is the truth.

  Applied in the main process: the renderer is sandboxed and `webFrame` is not
  reachable from it, and one call site means launch and change cannot disagree.
  Hooked to `did-finish-load` rather than window creation, because Electron
  resets the zoom factor on every navigation — set once at creation it would
  survive until the first reload and then silently revert.

  The keyboard shortcuts write the setting rather than only zooming, so they and
  the sheet always agree. The View menu's own zoom still changes the window
  without persisting; ours wins on the next launch.

  Verified live: 1.0 at launch, 1.3 after picking 130%, ⌘0 back to 1.0, ⌘− down
  to 0.85, and 0.85 still in force after a full relaunch. 365 tests.

- **2026-08-04 — zoom moved to the menu, out of Settings.** The size control is
  gone from the sheet; ⌘+, ⌘− and ⌘0 are the whole interface.

  This forced a real change rather than deleting a fieldset. **A menu accelerator
  is handled before the page ever sees the keystroke**, so the shortcut could not
  live in the renderer: Electron's default View menu would have taken ⌘+ first,
  zoomed the window itself, and remembered nothing. Chorus now sets its own
  application menu — which means also keeping what the default gave for free.
  Without `editMenu` there is no ⌘C in the app at all, so that is a test.

  ⌘= is bound as a hidden second item, because ⌘+ needs Shift on most layouts and
  a visible duplicate would read as two commands.

  `settings:write` became a **patch**. With zoom owned by the menu, the
  renderer's copy of `scale` goes stale the moment ⌘− is pressed, and a whole
  object write would have quietly reverted it. Verified: writing only
  `profileId` left a menu-set scale of 1.3 untouched.

  The accelerators themselves are covered by unit tests over the menu template
  and the stepping — a native menu keystroke cannot be driven through CDP, so
  that last inch is structure, not a synthetic keypress. 378 tests.

- **2026-08-04 — one typeface: the terminal's own.** Everything is monospace now
  — prose, chrome and machine output alike. The design's second idea was "type
  encodes kind": serif for what agents _say_, mono for what they _do_. That idea
  survives, but it is carried by weight, colour and case instead of by family:
  agents' words at full brightness, reasoning italic and dim, chrome small and
  upper-cased. Ligatures off, as in every terminal.

  Monospace runs wider at the same size, so prose went 16px serif → 14px mono to
  hold a comparable measure, with the leading opened to 1.7 because a wall of
  fixed-width text closes lines up.

  The drawn wordmark went with it. Six Didone letterforms as SVG paths read as a
  masthead, and a serif logo above a monospace transcript was the one element
  announcing it came from somewhere else. It is set in the app's own face now,
  with the O still carrying a gradient from Codex's hue to Claude's — three
  voices in one letter, in different clothes. The paths are in git history.

- **2026-08-04 — zoom in 5% steps, with a badge.** ⌘+ and ⌘− move 5% at a time
  between 80% and 150% rather than through five fixed sizes, and every step
  rounds to a whole percent: 0.85 + 0.05 is 0.8999999999999999 in binary floating
  point, and a badge reading 89% would be the arithmetic showing through.

  A badge shows the new size for 1.4s. Without it the only feedback is the whole
  window moving, which says something happened rather than what — and the menu
  item carries no visible state. Its timer restarts on each change, or holding
  ⌘− would hide the badge partway through the run of presses that needed it most.

  The renderer cannot read the zoom factor it is drawn at, so the main process
  pushes it on `settings:scale` whenever it applies one.

  Verified live: wordmark in mono, badge reading 105% then 110%, still up
  mid-run, gone after ~1.4s idle. 380 tests.

- **2026-08-04 — zoom lasts one launch; End is always offered.**

  Zoom left `settings.json` entirely. It is an adjustment rather than a
  preference: the app opens at 100% every time, and a size set to read one long
  diff should not be waiting for you tomorrow. The size is now module state in
  `scale.ts` with exactly the lifetime of the process, and **nothing reads it
  from disk**, so there is no path by which a previous session's zoom could come
  back. An older file carrying `scale` has the key dropped on the next read.

  `did-finish-load` still reapplies it, for a different reason than before:
  Electron resets the factor on every navigation, so a reload mid-session would
  drop silently back to 100% while the app still believed it was zoomed.

  **End** now appears on a single session too. It was hidden when there was only
  one because ending it had nowhere to land — that stopped being true when the
  start screen arrived, and the guard outlived its reason.

  Verified live: 100% at launch, End present with one pane, ending the last pane
  landing on the start screen, no `scale` key written, and 100% again after a
  full relaunch. 377 tests.

- **2026-08-04 — the setup modal is gone; permissions change from inside the
  room.** Start a session goes straight into a session on the settings you last
  used. The form asked three questions that all had remembered answers, and none
  of whose answers is final — the directory is a starting point the agent can be
  told to leave (§4.4, the filesystem is not scoped), and permissions now change
  mid-conversation. Settings still holds the defaults for anyone who wants to
  choose before starting.

  The pane's profile chip became the control. What agents may do without asking
  is the thing you most want to change once a session is under way: you start
  read-only, watch an agent get it right, and stop wanting to approve every
  command. Sending someone back to a start screen for that would mean ending the
  conversation that earned the trust.

  A new durable event, `policy.changed`, records it. "Human controlled" is only
  auditable if widening what agents may do leaves a mark next to what they then
  did — so it is appended **before** the change takes effect, and the transcript
  shows the widening above the actions it permitted. It is replayed in catch-up
  too: an agent addressed later works under rules that changed while it was not
  listening, and that is a fact about the room rather than about one turn.

  Every participant moves together — two agents in one room under different rules
  would make "what may happen here" unanswerable. Requests already on screen keep
  the rules they were evaluated under, and session grants survive: they were
  given deliberately, and a profile change is not a reason to re-ask.

  The exhaustive switch in `catchup.ts` caught the new event type, which is what
  it was written for.

  Verified live end to end: read-only stopped to ask before a write; switching to
  Trusted mid-conversation asked nothing; and the file was actually on disk
  afterwards. Also: straight into a session in ~1s with no modal, the chip
  reading Trusted, and "Permissions changed: read-only → trusted" in the
  transcript. 378 tests.

- **2026-08-04 — the pane's bar moved into the composer.** Who is here, where
  they are, what they may do, Review and End all sit in the composer's own row
  now. The separate strip put them at the top of the pane while the thing you act
  with was at the bottom, so changing permissions meant crossing the whole
  transcript to get there and back.

  The keyboard hint went with it: ↵ sends is the convention, and saying so
  forever is a label for its first minute. The placeholder shortened to "Type @
  to choose who answers" — the picker makes the long explanation redundant, and
  it now teaches the affordance instead of describing the syntax.

  **The placeholder no longer wraps.** A wrapped one made an empty composer two
  lines tall — the box you have not typed in bigger than the one you have — and
  it changed height as the pane narrowed, which reads as the layout twitching.

  The row sheds detail by its pane's own width: below 620px Review becomes
  "Diff", below 520px the path goes (still on the title attribute), below 430px
  the agent names give way to their dots, below 340px the pane number goes. The
  send button stays inside the box at every width and the row never wraps to two
  lines.

  Two latent bugs surfaced doing it. `.voices--pane` was declared _before_
  `.voices`, so its `margin: 0` had never won against the base rule's
  `margin-left: auto` — invisible while voices lived in a strip of their own, and
  the reason the group sat centred the moment it moved. And `.composer-actions`
  carried `justify-content: flex-end` from when it held only a hint and a button.

  Verified live across 1400/900/620/480/390px panes. 378 tests.

- **2026-08-04 — compacted, and measured.** Spacing was tightened everywhere
  rather than by eye, and checked against a number: how many transcript entries
  fit on one screen.

  |                          | before | after  |
  | ------------------------ | ------ | ------ |
  | per entry                | 53px   | 47px   |
  | chrome (masthead + dock) | 186px  | 151px  |
  | entries visible at once  | 12     | **15** |

  Two tokens did most of it. `--step` went 4px → 3px: every padding and gap in
  the app is a multiple of it, so it is the one lever that decides how much of
  the screen is transcript and how much is air. `--gutter` went 88px → 60px —
  it was sized for a serif design with wide tracking, and the labels are short
  monospace words now. Checked rather than guessed: the longest of them,
  `CLAUDE`/`SYSTEM`, measures 47px.

  The rest: `.score`, `.masthead` and `.dock` padding down a step or two, entry
  padding 3 → 2 steps, column gap 6 → 4, and prose leading 1.7 → 1.55 — still
  open enough that fixed-width text does not close up, and worth most of a line
  per paragraph.

  Verified live after the change: no entry overlapping its neighbour, every
  speaker label clear of the text column, prose still 14px on a 21.7px line.

- **2026-08-04 — the project directory edits in place.** Click the path in the
  composer row and it becomes a field there; Enter commits, Escape cancels, and
  leaving the field cancels too — a half-typed path is exactly what a stray click
  produces, and leaving a field is not agreement.

  This matters because the path decides what "the diff" means. The review panel
  and any handoff brief follow it, so being able to correct it without ending the
  session is the difference between a panel pointed at the wrong tree and a right
  one. A bad path is refused with the reason rather than accepted quietly.

  It does **not** move an agent's shell — those were started with a working
  directory and keep it. What moves an agent's work is telling the agent, and the
  change is replayed in catch-up so the next one addressed is told. The new
  `project.changed` event carries it: recorded because a diff read later is only
  interpretable against the directory in force at the time.

  Verified live: click opens a field prefilled with the current path; Escape
  leaves it untouched; `/definitely/not/here` refused with "That directory does
  not exist"; a real path committing, appearing in the transcript as "Project
  directory: …", and the review panel then reading that repository's actual diff.
  378 tests.

- **2026-08-04 — the cast is a set of switches.** The agent chips in the composer
  row toggle: take one out mid-conversation, bring one in later, and an agent
  that joins **reads the whole transcript on the first thing it is asked** —
  including what the agent it replaced said.

  The mechanism is the catch-up already built for the shared conversation. A
  joining participant's watermark starts at zero instead of at the current end of
  the log, so the backlog rides along with the first message rather than costing
  a turn on arrival: nothing is spent until the agent is actually used, and then
  exactly one turn. Its allowance is raised for that first delivery only — the
  per-turn budget is sized for "what you missed", not "everything", and an agent
  that has read half a conversation is worse than one that has read none, because
  it does not know which half it is missing.

  An agent leaving closes its session, which appends `session.ended`; the
  transcript now renders both, so a first message no longer appears from nowhere
  and a last one is not followed by an unexplained silence. Grants and the
  profile are the conversation's, so whoever joins arrives under the rules
  already in force.

  Removing everyone is allowed — the composer says so and Send is disabled rather
  than failing on submit.

  Verified live, which is the only way this claim means anything: both agents in,
  claude taken out, codex told a passphrase claude never saw, claude brought back
  and asked for it with commands and file reads forbidden. It answered
  `velvet-otter-41`. 378 tests.

- **2026-08-04 — syntax highlighting, written rather than installed.**
  `highlight.ts` turns code into typed tokens the renderer draws as elements —
  the same argument as the markdown parser beside it: agent output is untrusted
  input, so nothing emits an HTML string for anyone to inject into. Injection is
  impossible by construction rather than by filtering (§4.4).

  Not a dependency, deliberately. A full highlighter is a large grammar engine
  running over text an agent produced; this is a hundred lines readable in one
  sitting, and the failure mode of a missed token is a word in the wrong colour.
  It covers what agents actually emit — shell, TS/JS, JSON, Python, diffs — with
  a generic fallback that still finds strings, numbers and comments.

  Five hues, not a rainbow, drawn from the same violet family as the ground so a
  block still belongs to this app. They answer what you ask of code at a glance:
  what is literal, what is being called, what is commentary, what is a flag. The
  two voice hues are reused rather than inventing more.

  Two details worth their lines:
  - **The shell wrapper is unwrapped.** Both agents run everything through
    `/bin/zsh -lc '…'`, so taken literally the whole command is one quoted
    string, and the half worth reading would be flat. The wrapper is tokenised as
    itself and the body tokenised again as shell.
  - **Unterminated strings cannot hang it.** A half-typed line arrives mid-stream
    on every reply, so quote rules close optionally and a zero-length match is
    treated as no match.

  Every case round-trips: the tokens rejoin to exactly the input, because a
  highlighter that drops a byte shows something other than what the agent said.

  Verified live: a reply with ts/bash/json blocks rendering comment, keyword,
  meta, operator, property and string runs in five distinct colours, and a real
  command entry showing `--files`, `--max-count` and `1` coloured inside the
  wrapper. 391 tests.

- **2026-08-04 — the path opens Finder, and never wraps.** Clicking it opens the
  directory in Finder; a quiet ✎ beside it, appearing on hover, still opens the
  inline editor.

  Two controls rather than one, because clicking a path should do the obvious
  thing — show you the folder — and a control that either opens Finder or starts
  an edit depending on where you land is a control you have to aim at.

  `conversation:reveal` takes a **conversation id, not a path**. The renderer
  naming a directory for the main process to open is a hole, and it never needs
  to: main already knows where the conversation is. `shell.openPath` resolves
  with a message rather than rejecting, so an unopenable directory is turned into
  a thrown error — otherwise it would look like success.

  The path is `nowrap` with an ellipsis: it is one line of a single-line row, and
  a second line there changes the height of the whole composer.

  Verified live: Finder windows 0 → 1 on click, the editor still opening from ✎,
  and a 68-character path clipping to one 24px line with the composer row
  unchanged. 391 tests.

- **2026-08-04 — the path opens a folder chooser.** Corrected from the previous
  entry: clicking the path opens the system's directory picker, not Finder. The
  ✎ beside it still opens the inline field. Two ways in because they suit
  different hands — the chooser is how you find a directory you would otherwise
  have to remember to type, the field is how you paste one you already have.

  `conversation:chooseCwd` opens the panel **and applies the result** in one
  call. Splitting it into "pick" then "set" would send the chosen path back
  through the renderer for no reason, and would let a cancelled dialog leave the
  two halves disagreeing about where the conversation is. The picked path goes
  through `setProjectDirectory`, so it is validated and recorded exactly as a
  typed one is. The panel opens attached to the window, starting where the
  conversation already is, and can create a folder.

  **A native modal cannot be driven.** `osascript` has no assistive access here,
  so the panel itself is not automatable — which is precisely why `buildHandlers`
  is now exported and tested with `dialog` stubbed. That covers the paths a
  driver can never reach: cancelling changes nothing, an empty selection is a
  cancel rather than `undefined` reaching the runtime, and re-picking the same
  folder reports no change.

  Live, the part that can be observed: the call stays **pending** after 2.5s,
  which is a modal being up rather than a call that failed. `.pane` now carries
  `data-conversation` so anything outside React can address the right one.

  396 tests.

- **2026-08-04 — a new session takes the caret.** The composer focuses when a
  session opens, so the first thing you do is type rather than click.

  On mount rather than on render: `Session` is keyed by conversation, so the
  effect runs exactly once per session and a pane that already exists never
  steals the caret back from one you are using.

  Verified live: focus on `body` before starting, in pane 1's composer after,
  text typed with no click landing in it, focus moving to pane 2 when a second
  session opens, and pane 1's half-written draft still there.

- **2026-08-04 — sessions have names.** An editable title sits above each
  transcript, replacing the grid position in the composer row. The position was
  only ever a way to tell two identical panes apart; a name does that better and
  says something as well.

  It defaults to the **folder's last piece** — `chorus`, not
  `/Users/…/code/chorus` — which is what anyone calls a project. Click to edit,
  Enter commits, Escape cancels, and an empty field asks for the default back
  rather than for no name at all.

  A title nobody has touched **follows the folder**: change the directory and it
  renames itself. One that was chosen deliberately is left alone, compared
  against what the default _would_ have been rather than against a flag.
  `conversation.renamed` records it, and `setCwd`/`chooseCwd` return the title
  along with the path so the pane and the log cannot disagree.

  Catch-up ignores it: a name the user chose for the room is theirs, not context
  for a turn.

  One bug found by driving it. The runtime returned the new title correctly and
  `Session` passed it up, but `App`'s `onCwd` still took a single argument and
  dropped it — an edit that silently failed to match after a reformat. Caught by
  the last case in the live test rather than by the type checker, which was
  happy: passing a two-argument function where one is expected is legal
  TypeScript.

  Verified live: default `alex` for a session in the home folder, no
  number left in the composer row, the title above the transcript, renaming to
  "refactor the adapter", that name surviving a folder change, and a second
  untouched session renaming itself to `chorus-title-probe` when its folder
  moved. 396 tests.

- **2026-08-04 — Settings holds only what a session cannot answer.** The cast,
  the directory and the permission profile are gone from it. All three live in
  the pane that owns them, and two controls with the same name doing different
  things — one changing the conversation you are looking at, the other the next
  one you open — is worse than one.

  What remains is what no session can tell you: which agents this machine has and
  at what version, and the way into the log.

  The defaults did not disappear with the controls; they changed source. **A new
  session starts where the last one was** — a pane changing its profile, folder
  or cast writes that back as the starting point. That is the honest rule once
  the form is gone, and it beats snapping back to something set once and
  forgotten.

  One case is deliberately excluded: emptying a room writes nothing. Removing
  both agents is a step on the way to swapping them, not a statement about how
  the next session should open. Names are excluded too — a title belongs to one
  conversation.

  Verified live across a relaunch: Settings showing only versions and Logs, no
  checkboxes, radios or directory field in it; changing a pane to
  workspace-write, `/tmp/chorus-defaults-probe` and codex-only; and the next
  launch opening exactly there, titled `chorus-defaults-probe`. 396 tests.

- **2026-08-04 — the app reopens what was on screen.** Quit with sessions open
  and they come back: same panes, same names, same folders, same cast, same
  transcripts — and the agents still remember the conversation.

  `open-sessions.json` holds the list, next to the log and the database.
  Deliberately not derived from the event log, though it nearly could be: the log
  says a session started and never ended, which after a crash is
  indistinguishable from one that was open on purpose — and
  `reconcileOrphanedSessions` exists to close exactly those. This file answers a
  different question, and losing it costs a click.

  Agents are **resumed, not restarted**. Both adapters already had it — Codex
  `thread/resume`, Claude's SDK `resume` — and the supervisor used it for crash
  recovery, so the only new thing is the entry point and a persisted ref. A
  resumed agent keeps its own reasoning; one whose thread the provider has
  forgotten falls back to a fresh session and gets the transcript on the first
  thing it is asked, the same path an agent joining mid-conversation takes.

  **The bug worth recording**: the first working version restored everything and
  the agent still answered "this is the first message in our conversation".
  Claude's real session id arrives with its _first message_, not at `start`, so
  the ref written when the conversation opened was a placeholder — a resume that
  silently resumed nothing. Refs are now re-read on every send and again at quit,
  which is the last and most accurate moment.

  Verified live across a real quit and relaunch: a session renamed "the one to
  remember", Claude told to say `PINEAPPLE-77`, the app quit and reopened — pane,
  title, transcript and both agents back — and Claude asked what word it had
  said, answering `PINEAPPLE-77` from its own resumed thread. 396 tests.

- **2026-08-04 — panes drag to reorder, and the order is kept.** Grab a session's
  title bar and the **whole pane** follows the cursor, offset by where you took
  hold of it. Dropping it on another puts it there.

  The title bar is the handle, the way a window's is — not the whole pane, which
  holds a transcript you select text in and a field you type into, either of
  which would fight a drag. Dragging is off while the name is being edited, or a
  caret drag inside the field would pick the pane up instead.

  **The grid sorts live**, as the pane passes over another, rather than on drop —
  what you see while dragging is what you get, and a drop that only reveals the
  result at the end asks you to predict it. The carried pane is dimmed rather
  than the target outlined: you can already see where it will land, so the
  question left is which one you are holding.

  Removing then inserting at the target's original index lands the pane _after_
  the target when it came from the left and _before_ it when it came from the
  right — what "past it" means in each direction. It is also stable: once moved,
  the pane is at that index, so hovering the same target again does nothing
  instead of oscillating.

  Nothing is written while dragging: a drag across three panes would be three
  writes for one decision. The order is recorded once, on release.
  `conversation:reorder` rebuilds the runtime's map, and since that map's order
  is what `open-sessions.json` records, the grid you arranged comes back.

  Two bugs, both found by driving it:
  - **The dragged pane was tracked in state**, and `dragover` can fire in the
    same tick as `dragstart` — before React re-renders — so every pane answered
    "nothing is being dragged" and refused the drop. It is a ref now, readable
    the instant it is set.
  - **`ref={pane}` never landed**: a comment between the lines I edited meant the
    replacement silently missed, so `setDragImage` was skipped and only the title
    strip moved. The probe reported "never called", which is why it was found at
    all rather than assumed working.

  Two of the checks were also wrong before they were right — a marker read before
  React re-rendered, and a spy assigned over a prototype method that is not
  writable that way. Both were fixed to measure what they claimed.

  Verified live: alpha | beta | gamma → dragging gamma onto alpha gives
  gamma | alpha | beta, the drop target marked while hovering, the drag image
  being the pane itself, a pane dropped on itself changing nothing, the handle
  disabled while renaming, and the new order surviving a quit and relaunch.

- **2026-08-04 — reordering finished: keyboard, and motion.**

  **⌥← / ⌥→ move the focused pane.** A drag was the only way to rearrange the
  grid, which left it unreachable without a mouse. The handler sits on the
  session's name because that is already the focusable thing in the bar you grab
  — the same handle, reached the other way. Committed immediately: a keypress has
  no release to wait for, and it stops at each end rather than wrapping.

  **Panes slide from where they were to where they are.** Reordering is a layout
  change, so no CSS transition can touch it — panes simply appear somewhere else.
  Measuring before and after and animating the difference is what turns "two
  panes swapped" from a fact you have to re-read into a movement you watched. The
  carried pane is skipped, since it is already under the cursor and sliding it
  would fight the drag, and the whole thing is skipped when the system asks for
  less motion.

  Both checks were wrong before they were right, in the same way as the drag
  probes: read synchronously after dispatching an event, before React had
  re-rendered. `[0,0,0]` animations became `[1,1,0]` — the two that moved — once
  sampled on the next frame.

  Verified live: ⌥→ then ⌥← returning the grid to where it started, ⌥← at the
  left edge doing nothing, focus staying on the pane that moved, two panes
  animating and settling, and the order surviving a relaunch.

- **2026-08-04 — fixed: the window came up blank.** Reported live. Reproduced in
  a second: the root held nothing but the restore placeholder, and
  `restoreConversations()` never settled.

  **Root cause, from the user's own `open-sessions.json`: `"claude": ""`.**
  Claude's session id only arrives with its first message, so an agent that
  joined and never spoke was written down with an empty ref. Passing that to
  `resume` asks the provider to continue a conversation with no name — and it
  does not answer, ever. An empty ref is now treated as no thread, and none is
  written in the first place.

  Two things made a single stuck agent fatal rather than annoying, and both are
  fixed:
  - **Reopening had no deadline.** A provider that never answers held the whole
    app. Each agent now gets 20s and then gives up, costing that agent rather
    than the session or the window.
  - **The UI waited on restore with nothing on screen.** "A moment of nothing is
    better than the start screen flashing past" was right; it stopped being right
    when the wait could be unbounded. The placeholder now has a 1.5s deadline and
    restored sessions appear whenever they arrive.

  Restore is also idempotent now: called twice, it returns what is already open
  instead of starting a second set of agents for the same conversation — found by
  a probe that called it again while the app was running.

  Verified with the exact shape from the reported file — codex with a real
  thread, claude with `""` — the session reopens with both agents. Also verified:
  a clean first launch still shows the start screen, and refs land in the file
  on every send and again at quit.

- **2026-08-04 — fixed: the grid thrashed while dragging.** Reported as "crazy
  swapping" between the cards. It was: reordering fired the instant the cursor
  touched any other pane, so the pane that shifted _under_ the cursor immediately
  triggered the next swap, and the grid flipped between two arrangements while
  the mouse sat still.

  A pane now has to be crossed **past its middle by a real margin** before it
  gives way — 12% of its extent, never less than 16px — and that margin is what
  the return trip has to re-cross. A cursor resting near a seam changes nothing,
  which is exactly the case that used to oscillate.

  The side is decided by the midpoint rather than by which pane was touched, so
  `reorder` now takes "before or after this one" and works out the index that
  means once the dragged pane is lifted out of the list. Measured on whichever
  axis the panes are actually laid out along — side by side in a wide grid,
  stacked in a narrow one.

  Verified live with three panes: 12 events at the exact middle change nothing,
  12 just past it stay inside the band and change nothing, one well past it moves
  the pane once, 20 more at the same place leave it alone, a twitch back toward
  the seam does nothing, and a real return trip moves it back.

- **2026-08-04 — fixed: diagonal drags still swapped in circles.** The spatial
  margin had not helped there, and the reason was that the geometry itself was
  lying: the panes **slide** to their new places, and while they slide
  `getBoundingClientRect` reports the animated box, not the resting one. A
  `dragover` arriving mid-flight is judged against a pane that is not where it
  will be — and diagonal moves travel furthest, so they were the worst for it.

  No margin in space can fix a measurement taken during motion, so there is now a
  matching margin in **time**: no further reorder until the last one has landed,
  held slightly longer than the slide. A move that turns out to be a no-op clears
  the hold immediately, so the next event still decides.

  Verified with a real diagonal sweep — a 2×2 grid, the top-left pane carried to
  the bottom-right over 60 events at ~60/s, recording the order after every one.
  It changed **exactly once** and settled: `A B C D` → `B C A D`. The horizontal
  dead-band cases all still behave as before.

- **2026-08-04 — the real cause of the erratic swapping: the wrong axis.**
  Reported again for diagonal cards. The dead band and the cooldown were both
  right, and both were being applied to the wrong dimension.

  The axis was chosen from the **pane's own shape** — `width >= height` meant
  "side by side". Two panes in a 1280×860 window are **640×799 each**: taller
  than wide, so the code decided them _vertically_ while they sat side by side.
  Left-to-right drags landed in a vertical dead band and did nothing at all;
  diagonal ones crossed the vertical midpoint on a whim and flipped about. It
  came from the grid's **column count** now, which is what actually says how the
  panes are arranged.

  Found by making the probe report what the handler computes rather than only
  what it produced: `boxWidth 640, boxHeight 799` was the whole answer, sitting
  in a line I had been ignoring.

  Verified after the fix: three runs of a two-pane swap, all three moving; the
  dead-band cases unchanged; and the diagonal sweep still changing the order
  exactly once across 60 events.

  One run in the middle failed to swap and then passed three times unchanged —
  a stale Electron holding the debug port, which has caught this project before.
  Worth remembering as a diagnosis before believing a one-off failure.

- **2026-08-04 — fixed: "The database connection is not open" on quit.** Reported
  from a real shutdown. Agents keep talking while the app is closing — a session
  being torn down still emits `turn.completed` — and those writes travel through
  an event pump that **nobody awaits**, so reaching a closed database surfaced as
  an unhandled rejection. A crash report for an app that was quitting anyway.

  Two changes, because either alone leaves a hole:

  - **The shutdown order was wrong.** Disposing an adapter emits a session's last
    events, and the database was closed before those pumps had finished. Services
    are now drained _after_ the adapters are disposed, so the log gets the end of
    the story instead of an exception.
  - **`append` refuses once closed** rather than throwing at a dead handle,
    returning `null` and counting what it dropped. A pump has nobody to catch a
    throw; there is no honest way to make it handle one. `send` treats a `null`
    as "Chorus is shutting down" and refuses, since delivering a message the log
    has no record of is worse than not delivering it.

  The count is logged on the way out, so "we lost some" is a number rather than a
  shrug. It was zero in every run since.

  Verified live: both agents set counting to 60, the app killed mid-turn — no
  "not open" errors, no unhandled rejections, and nothing dropped. 398 tests.

- **2026-08-04 — Restart: the same room, with nothing said in it.** A button
  beside each session's name, quiet until the bar is under the cursor — a rare
  thing to press and a bad thing to press by accident, but it belongs next to
  what it acts on rather than among the controls at the far end of the pane.

  It starts a **new conversation** rather than clearing the old one. The previous
  transcript stays in the log, where it is still the record of what happened, and
  the agents get genuinely fresh sessions rather than a context they were asked
  to ignore — which is the difference between this and telling an agent to forget
  something. Same folder, same cast, same permissions, same name; only the id and
  the emptiness change.

  It keeps its place in the grid, because a pane that jumps to the end when you
  restart it is a pane you then have to find again.

  Verified live: the button in the title bar and to the right of the name, the
  conversation id changing while position, title, folder, permission profile and
  both agents survive, the transcript back to nothing, and a fresh Claude
  answering "there's no earlier message in it" when asked about a word the
  previous session had been told to remember.

- **2026-08-04 — Restart and End became a pair of round icons at the right of the
  title bar.** ↻ and ✕, the same circle the send button uses — the same shape for
  the same kind of thing. The name reads from the left; the things you do to it
  collect at the right, where every other control in a pane already sits. End
  left the composer row, which now holds only Review.

  Glyphs rather than words because they sit beside a name that can be long, in a
  bar that has to survive a pane a third of the window wide. The words live on
  `aria-label` and `title`, so a screen reader and a hover both still get
  "Restart" and "End this session".

  The two-button confirm became **one button that arms**. Pressed while an agent
  is working, ✕ turns the colour of a warning and says "press again to end"; it
  disarms itself after three seconds, so a stray click cannot lie in wait. When
  nothing is running it just ends, as it always did.

  Verified live: both icons right of the name and at the far end of the bar,
  `border-radius: 50%` matching the send button, restart still replacing the
  conversation in place with everything else intact, the first press while busy
  arming instead of ending, and the arm clearing on its own.

- **2026-08-04 — the start screen is gone; the app opens a session.** Restored
  sessions come back as before; with nothing saved, one is opened without being
  asked for. The screen was a door whose only answer was "yes" — every choice
  behind it was already remembered, and the app has nothing to show without a
  session anyway.

  What is left of it is where you land when starting **fails**: the wordmark, the
  reason, Try again, and Settings. That is the one moment the screen had anything
  to add. An error is also what stops the open-a-session effect retrying forever
  — the panel stays until you ask again.

  **End is hidden on the only pane again.** It was hidden originally, then shown
  once the start screen existed to land on; with the screen gone, ending the last
  session would leave nowhere to be. Restart is still there, which is the thing
  you actually want on a session that has gone wrong.

  Verified live: a first launch with nothing saved opening one pane in ~1s with
  no button pressed and no start screen; End absent with one pane and present on
  both with two; ending one bringing the count back to one and hiding End again;
  and a quit and relaunch coming back to **the same conversation** rather than a
  fresh one.

- **2026-08-04 — a session starts with Codex alone.** The default cast is one
  agent rather than two.

  It matters more now that the app opens a session the moment it launches: the
  cast is what you pay for without asking, and two agents is two provider
  processes and twice the wait before anything can be typed. Codex alone is the
  cheap start, and Claude is one click away on its chip — arriving with the whole
  conversation, which is what makes starting small safe rather than a decision
  you regret.

  The stored default follows the last session, as it has since Settings lost its
  copy of these controls, so open a session with both and both is what you get
  next time.

  Verified live: one pane in ~1s with `codex` in and `claude` out, and claude
  joining on a click.

- **2026-08-04 — fixed: one session became three across restarts.** Reported with
  a screenshot, and the saved file confirmed it: three entries, one with both
  agents and two codex-only — the shape of a session opened automatically rather
  than restored.

  My own two changes collided. The placeholder was given a 1.5s deadline so a
  stuck provider could not leave a blank window; the app was then made to open a
  session when none was restored. Reopening **starts agents**, so it routinely
  takes longer than the deadline — and "the placeholder gave up" was being read
  as "nothing was open". A second session opened on top of the one still coming
  back, both were saved, and every launch added another.

  Two changes, because the second is what stops it being lossy:
  - **Opening a session waits for restore to actually finish**, not for the
    placeholder's deadline. They were the same flag and are now two: one for how
    long to show nothing, one for whether the answer has arrived.
  - **Restore merges rather than assigns.** A session started while restore was
    in flight is a real session, and replacing the list dropped it from the grid
    while leaving it running in the background — which is how the extras stayed
    invisible until the next launch.

  Verified live: five launches in a row, each showing the same single pane with
  the same conversation id and one saved entry.
