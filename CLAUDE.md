# Chorus

A local-first workspace where a developer collaborates with several coding
agents in one shared conversation. Electron + React, pnpm workspaces, Turbo.

Chorus **drives** the user's installed `claude` and `codex` CLIs — it does not
replace them. Both run headless over stdio; there is no PTY anywhere. Retiring
the terminal here means retiring the _interface_, not the binary.

## Commands

```bash
pnpm dev       # electron-vite dev — restarts the main process on its own sources
pnpm check     # typecheck + lint + format:check + test. Run this before saying done.
pnpm test      # vitest only
pnpm e2e       # builds the desktop app and drives it with Playwright
pnpm app:install   # packages and installs the local build
```

`pnpm check` is the gate. It is fast (~40s warm) and there is no reason to skip
it.

## The one rule everything else follows from

**The event log is the source of truth, and it is append-only.**

Codex discards partial assistant output when a turn is interrupted, so a
transcript cannot be rebuilt from the providers. Everything an agent streams is
made durable in SQLite as it arrives. An append and every projection it updates
land in **one transaction**, so a projection can never be ahead of the log and
can always be rebuilt from it.

### State is not history

The corollary that is easy to get wrong. Some facts are about the _agent right
now_ rather than about what happened in the conversation:

- `limits` — how full the account's plan windows are
- `context.usage` — how full the agent's context window is

These are **never written to the log**. They travel on their own push channels
(`agents:limits`, `agents:context`) and are held in memory. The test: would
reading this value back a week later be worse than having none? Account limits
would be stale; context fill _resets on compaction_, so a stored series would be
a history of a number that repeatedly went backwards for reasons the log does not
explain.

If you add something in this category, push it — do not add a `ChorusEventPayload`.

## Where things live

```
packages/agent-protocol   the normalized AgentEvent union both providers project onto
packages/adapter-claude   Claude SDK -> AgentEvent. Pure mapping in mapping.ts
packages/adapter-codex    codex app-server JSON-RPC -> AgentEvent
packages/orchestrator     conversation service, policy engine, catch-up, supervisor
packages/event-store      SQLite, migrations, projections
packages/workspace        read-only git status and diff
apps/desktop/src/main     Electron main: runtime, IPC, windows
apps/desktop/src/renderer transcript reduction and UI
```

Nothing provider-specific may leak past an adapter except `raw`, which exists
only for debugging.

## Adding an event type is a five-file change

`mapping.ts` is the chokepoint, and three switches downstream are **deliberately
exhaustive** so a new type has to be considered rather than silently vanishing.
The linter enforces it (`switch-exhaustiveness-check`), which is how you will
find out:

1. `packages/agent-protocol/src/events.ts` — the event, and `UNDROPPABLE` if
   losing one under backpressure would wedge a turn
2. `packages/event-store/src/events.ts` — the `ChorusEventPayload` schema
3. `packages/orchestrator/src/conversation-service.ts` — the case that appends it
4. `packages/event-store/src/projections.ts` — a projection, or an explicit no-op
5. `packages/orchestrator/src/catchup.ts` — whether the _other_ agent should be
   told, or an explicit no-op

Then the renderer: `transcript.ts` to reduce it, `Entry.tsx` to draw it.

A no-op case needs a comment saying why. "It is not interesting" is not a reason;
"no query asks for it" and "the other agent runs under its own harness and cannot
act on ours" are.

## Adapters

`packages/adapter-claude/src/mapping.ts` is pure — it maps recorded SDK messages
with no process, which is why the adapter is testable at all. Keep it that way.

**Read shapes out of `sdk.d.ts`, never out of prose or memory.** Three bugs in M2
came from inferred payloads, and two since: the rate-limit event is flat where the
types describe it nested, and `task_*` keys on `task_id` with `tool_use_id`
optional rather than threading `parent_tool_use_id`. When a response carries both
a raw figure and a pre-computed percentage, derive it yourself — the types do not
say whether it is a fraction or a percentage.

The default arm raises a low-level `notice` rather than returning `[]`, so a
subtype a future SDK adds degrades to a muted line instead of silence.
`QUIET_SUBTYPES` is the short exemption list for things that arrive on a timer;
notices are durable, and `system/status` is a heartbeat.

`settingSources` is deliberately omitted, so agents inherit the user's full
config — their hooks, skills, MCP servers and slash commands all load. That is
why `mcpToolCall` is a first-class approval kind.

## The permission engine

`packages/orchestrator/src/policy/engine.ts`. The ordering is the design and is
rigid:

1. Kinds that may never be auto-decided (`mcpToolCall`)
2. **Deny rules — absolute.** Nothing later can un-deny.
3. Explicit `ask` rules, which outrank a later allow
4. Session grants
5. Profile allows
6. Otherwise ask

**A universal deny must be an irreversible _action_, never a pattern match on a
name.** `rm -rf`, force-push, history-rewrite qualify. A rule that decides by
filename does not, because the user's answer is exactly what distinguishes a
secret from a fixture — expressed as a deny it becomes a wall with no door, and
switching to Trusted cannot help because universal rules apply there too. A test
enforces this (`UNIVERSAL_DENIES` may not carry a `pathPattern`).

## Renderer conventions

- **Pure reducers, exported for tests.** `transcript.ts`'s `reduceEvents`,
  `store.ts`'s `reducePulse`, `notify.ts`'s `noticesFrom`. The judgement lives in
  the pure function; the component is plumbing.
- **Unless the bug _is_ the lifecycle**, in which case mount it. `useDialog`
  re-ran its effect on every render of the caller, and there is no pure part to
  extract because the defect was the dependency array itself. Such a test opts
  into a DOM with `@vitest-environment jsdom` at the top of the file; `node`
  stays the project default, so this is an exception that has to be asked for
  rather than a second way of writing tests. Two traps, both hit while writing
  the first one: jsdom does no layout, so `offsetParent` is `null` and anything
  filtering on it finds nothing focusable; and a `.click()` that calls
  `setState` is not wrapped in `act`, so the re-render has not happened when the
  assertion runs — that one passed with the bug reinstated. Drive a re-render
  with `rerender`, and prove the test fails without the fix.
- **Only the active tab of each pane is mounted** (max 4). Everything a session
  needs to survive unmounting rides in `SessionCarry`; background conversations
  stay live in the main process and report through the pulse.
- **No `dangerouslySetInnerHTML`, ever.** Agent output is untrusted, and building
  from a typed tree makes injection impossible by construction.
- The markdown parser and syntax highlighter are hand-written on purpose. Adding
  a grammar engine is a decision, not a convenience.
- **No hardcoded user-facing strings** — `i18n/en.json`. The reducers have no
  translator, which is why events carry keys (`notice.source`) and the renderer
  turns them into words.

## Traps that have actually bitten

- **`useCallback` dependency arrays evaluate during render.** A callback declared
  above the thing it depends on throws a TDZ `ReferenceError` on first paint —
  a blank window, and typecheck does not catch it. Watch declaration order in
  `App.tsx`.
- **SQL in a template literal cannot contain backticks.** A comment quoting an
  identifier closes the string.
- **`summarize` in `transcript.ts` branches on approval kind before reading
  `toolName`.** Reordering makes every `Task` approval read "mcp: Task".
- **better-sqlite3 is synchronous** and lives on the main thread. Every delta
  from every conversation passes through it; `DeltaBuffer` coalescing is what
  makes that survivable.

## Plans

Work of any size goes through a plan first.

```
docs/plans/{slug}-{YYYY-MM-DD}/plan.md      problem -> shape -> phases -> open questions
docs/plans/{slug}-{YYYY-MM-DD}/STATUS.md    written after each phase ships
BOARD.md                                    what sits outside any one plan
```

`BOARD.md` is where a task goes when it belongs to no plan: something noticed in
passing, something that needs a person rather than a commit, something parked with
a reason. An entry says what it is, why it matters, and what would make it done —
if it cannot answer the third it is a thought, and belongs in a plan's open
questions.

Entries carry ids (`C-001` upward) so a commit can name what it closes. Ids never
get reused: the next one is the highest ever used plus one, including entries that
have already left the page.

Plans are prose that argues, not checklists. Say what the problem is, what the
shape of the answer is, and **what you are deliberately not doing**.

When the code contradicts the plan — and it does, often, because the plan was
written before reading the types — **correct the plan and say so in STATUS**.
Several phases here shipped differently from how they were planned, and the
record of why is worth more than a plan that pretends it was right.

Comments explain **why**, not what. Most of this codebase's comments record a
decision or a bug that was actually hit; match that.
